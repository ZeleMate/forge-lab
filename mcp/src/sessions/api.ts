// The seam between the sessions tools and TrueForge (#54): the tools only see
// `SessionsApi`, so a test can hand them a fake that returns fixtures and
// records every call. `sdkSessionsApi` is the real one, a thin wrapper over the
// typed SDK (#21: `maxRetries: 0` on anything that writes, `stream: false` only,
// and no DELETE).

import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

// The SDK's types, re-exported under short names. `TrueForgeApi` is a namespace
// of types only; `import type` above means none of it reaches the runtime.
export type Session = TrueForgeApi.Session;
export type Turn = TrueForgeApi.Turn;
export type SessionEvent = TrueForgeApi.SessionEvent;
export type AgentSpec = TrueForgeApi.AgentSpec;
export type TurnInputItem = TrueForgeApi.TurnInputItem;
export type Metadata = Record<string, string>;

// One page of a list, with the token for the next one (absent on the last page).
export type Page<T> = { items: T[]; next?: string };

export interface SessionsApi {
  // reads
  listSessions(q: { agentId?: string; metadata?: Metadata; limit: number; cursor?: string }): Promise<Page<Session>>;
  getSession(sessionId: string): Promise<Session>;
  // Every Turn of a Session, oldest first (the server's only order, #21 section 9).
  listTurns(sessionId: string): Promise<Turn[]>;
  getTurn(sessionId: string, turnId: string): Promise<Turn>;
  listTurnEvents(
    sessionId: string,
    turnId: string,
    q: { limit: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<Page<SessionEvent>>;
  // The Turn id at the Session's tip, which is what cancel acts on, or undefined
  // for a Session with no Turns. The wire Session has no such field (#21 7.1).
  tipTurnId(sessionId: string): Promise<string | undefined>;
  findAgentId(name: string): Promise<string | undefined>;
  getAgentSpec(agentId: string): Promise<AgentSpec>;
  // writes: the only four calls that change anything
  createSession(body: { spec: AgentSpec; metadata: Metadata }): Promise<Session>;
  updateSession(sessionId: string, body: { spec?: AgentSpec; metadata?: Metadata }): Promise<Session>;
  createTurn(sessionId: string, body: { input: TurnInputItem[]; previousTurnId: string }): Promise<Turn>;
  cancel(sessionId: string): Promise<void>;
}

// The SDK caps a Session's Turns at 25 per page; this stops a runaway Session
// from turning one tool call into hundreds of requests.
const MAX_TURNS = 200;

export function sdkSessionsApi(baseUrl: string): SessionsApi {
  // Reads may retry (they change nothing); writes never do, because a retried
  // create could make a second Turn (#21 section 8).
  const read = new TrueForge({ baseUrl, maxRetries: 2 });
  const write = new TrueForge({ baseUrl, maxRetries: 0 });

  return {
    async listSessions(q) {
      const page = await read.sessions.list({
        limit: q.limit,
        order: "desc",
        ...(q.agentId ? { agentId: q.agentId } : {}),
        ...(q.metadata ? { metadata: q.metadata } : {}),
        ...(q.cursor ? { pageToken: q.cursor } : {}),
      });
      return { items: page.data, next: page.response.pagination.nextPageToken ?? undefined };
    },
    async getSession(sessionId) {
      return (await read.sessions.get(sessionId)).data;
    },
    async listTurns(sessionId) {
      const turns: Turn[] = [];
      // `for await` walks the SDK's Page across every page it fetches.
      for await (const turn of await read.sessions.listTurns(sessionId, { limit: 25 })) {
        turns.push(turn);
        if (turns.length >= MAX_TURNS) break;
      }
      return turns;
    },
    async getTurn(sessionId, turnId) {
      return (await read.sessions.getTurn(sessionId, turnId)).data;
    },
    async listTurnEvents(sessionId, turnId, q) {
      const page = await read.sessions.listTurnEvents(sessionId, turnId, {
        limit: q.limit,
        order: q.order ?? "asc",
        ...(q.cursor ? { pageToken: q.cursor } : {}),
      });
      return { items: page.data, next: page.response.pagination.nextPageToken ?? undefined };
    },
    async tipTurnId(sessionId) {
      // The branch-wide events list is newest first and anchored at the tip.
      const page = await read.sessions.listEvents(sessionId, { limit: 1 });
      return page.data[0]?.turnId;
    },
    async findAgentId(name) {
      // GET /agents has no name filter that works (#35), so match over every page.
      for await (const agent of await read.agents.list({ limit: 100 })) if (agent.name === name) return agent.id;
      return undefined;
    },
    async getAgentSpec(agentId) {
      return (await read.agents.get(agentId)).data.manifest;
    },
    async createSession(body) {
      return (await write.sessions.create({ agent: { spec: body.spec }, metadata: body.metadata })).data;
    },
    async updateSession(sessionId, body) {
      return (
        await write.sessions.update(sessionId, {
          ...(body.spec ? { agent: { spec: body.spec } } : {}),
          ...(body.metadata ? { metadata: body.metadata } : {}),
        })
      ).data;
    },
    async createTurn(sessionId, body) {
      // The SDK's `createTurn` always sends `stream: false`: it returns the
      // Turn while it's still running, and execution continues on the server.
      return (await write.sessions.createTurn(sessionId, { input: body.input, previousTurnId: body.previousTurnId }))
        .data;
    },
    async cancel(sessionId) {
      await write.sessions.cancel(sessionId);
    },
  };
}

// A fake TrueForge behind the `SessionsApi` seam (#54): in-memory Sessions,
// Turns and events, and a log of every call. `mutations()` is what the refusal
// tests assert on: a refused write must leave it empty.

import type {
  AgentSpec,
  Metadata,
  Page,
  Session,
  SessionEvent,
  SessionsApi,
  Turn,
  TurnInputItem,
} from "../src/sessions/api";

export const CARTOGRAPHER_ID = "agent-cartographer";
export const SPEC: AgentSpec = {
  model: { name: "openrouter/glm-5-3-flash", params: { maxTokens: 4096 } },
  instructions: "test instructions",
  config: {
    iterationLimit: 40,
    contextManagement: { compaction: { trigger: { type: "input_tokens", value: 64_000 } } },
  },
};

const WRITES = new Set(["createSession", "updateSession", "createTurn", "cancel"]);
const T0 = Date.parse("2026-11-01T10:00:00.000Z");

export type Call = { method: string; args: unknown[] };

type TurnOpts = {
  previous?: string | null;
  status?: "running" | "done" | "cancelled" | "error";
  requiredActions?: number;
  input?: TurnInputItem[];
  text?: string;
  costUsd?: number;
};

export class FakeSessionsApi implements SessionsApi {
  readonly calls: Call[] = [];
  private sessions = new Map<string, Session>();
  private turns = new Map<string, Turn[]>(); // by Session id, oldest first
  private events = new Map<string, SessionEvent[]>(); // by Turn id
  private clockTick = 0;
  // What a Turn created through `createTurn` turns into the next time it's read.
  finishCreatedTurnsAs: "running" | "done" | "error" = "done";

  mutations(): Call[] {
    return this.calls.filter((c) => WRITES.has(c.method));
  }

  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }

  private stamp(): string {
    this.clockTick += 1;
    return new Date(T0 + this.clockTick * 1000).toISOString();
  }

  // ---------- building the world ----------

  addSession(id: string, opts: { metadata?: Metadata; inline?: boolean } = {}): Session {
    const session: Session = {
      id,
      agent: opts.inline
        ? { type: "inline", spec: structuredClone(SPEC) }
        : { type: "reference", id: CARTOGRAPHER_ID, name: "cartographer" },
      createdAt: this.stamp(),
      createdBySubject: { subjectType: "user", subjectId: "trueforge-default", subjectDisplayName: "Local user" },
      metadata: opts.metadata ?? {},
      metrics: { totalTurns: 0, totalDurationMs: 0, totalCostInUsd: 0 },
      shared: false,
      source: null,
      title: null,
      updatedAt: this.stamp(),
    };
    this.sessions.set(id, session);
    this.turns.set(id, []);
    return session;
  }

  addTurn(sessionId: string, id: string, opts: TurnOpts = {}): Turn {
    const turns = this.turns.get(sessionId);
    if (!turns) throw new Error(`no session ${sessionId}`);
    const status = opts.status ?? "done";
    const completedAt = this.stamp();
    const metrics = { totalInputTokens: 1000, totalOutputTokens: 100, totalCostInUsd: opts.costUsd ?? 0.01 };
    const state: Turn["state"] =
      status === "running"
        ? { status }
        : status === "done"
          ? {
              status,
              completedAt,
              output: null,
              metrics,
              requiredActions: Array.from({ length: opts.requiredActions ?? 0 }, (_, i) => ({
                type: "tool.approval_required" as const,
                id: `${id}-approval-${i}`,
                createdAt: completedAt,
                threadId: "main",
                toolCalls: [{ id: `call-${i}`, sourceEventId: `${id}-mm` }],
              })),
            }
          : status === "cancelled"
            ? { status, completedAt, reason: "client-cancelled" }
            : { status, completedAt, message: "iteration limit reached" };
    const turn: Turn = {
      id,
      sessionId,
      previousTurnId: opts.previous === undefined ? (turns.at(-1)?.id ?? null) : opts.previous,
      createdAt: this.stamp(),
      input: opts.input ?? [{ type: "user.message", content: opts.text ?? `question for ${id}` }],
      state,
    };
    turns.push(turn);
    this.events.set(id, [{ type: "turn.created", id: `${id}-created`, createdAt: turn.createdAt } as SessionEvent]);
    return turn;
  }

  addEvent(turnId: string, event: SessionEvent) {
    this.events.get(turnId)?.push(event);
  }

  // The `mcp.initialize` event TrueForge persists when it connects to us.
  addMcpInitialize(turnId: string, mcpSessionId: string) {
    this.addEvent(turnId, {
      type: "mcp.initialize",
      id: `${turnId}-mcp`,
      createdAt: this.stamp(),
      threadId: "main",
      mcpServers: [
        { id: "srv-source", name: "source", sessionId: "other-connection" },
        { id: "srv-sessions", name: "sessions", sessionId: mcpSessionId },
      ],
    });
  }

  // Puts recorded payloads (from `fixtures:record`) into the fake as they are.
  loadRecorded(session: Session, turns: Turn[], events: Record<string, SessionEvent[]>) {
    this.sessions.set(session.id, structuredClone(session));
    this.turns.set(session.id, structuredClone(turns));
    for (const t of turns) this.events.set(t.id, structuredClone(events[t.id] ?? []));
  }

  session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw notFound(`session ${id}`);
    return s;
  }

  turnsOf(sessionId: string): Turn[] {
    return this.turns.get(sessionId) ?? [];
  }

  // ---------- SessionsApi ----------

  async listSessions(q: {
    agentId?: string;
    metadata?: Metadata;
    limit: number;
    cursor?: string;
  }): Promise<Page<Session>> {
    this.log("listSessions", q);
    const all = [...this.sessions.values()]
      .filter((s) => !q.agentId || (s.agent.type === "reference" && s.agent.id === q.agentId))
      .filter((s) => Object.entries(q.metadata ?? {}).every(([k, v]) => s.metadata[k] === v))
      .reverse(); // newest first, as the server orders by updated_at desc
    return { items: all.slice(0, q.limit) };
  }

  async getSession(sessionId: string): Promise<Session> {
    this.log("getSession", sessionId);
    return structuredClone(this.session(sessionId));
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    this.log("listTurns", sessionId);
    this.session(sessionId);
    return structuredClone(this.turnsOf(sessionId));
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    this.log("getTurn", sessionId, turnId);
    const turn = this.turnsOf(sessionId).find((t) => t.id === turnId);
    if (!turn) throw notFound(`turn ${turnId}`);
    return structuredClone(turn);
  }

  async listTurnEvents(
    sessionId: string,
    turnId: string,
    q: { limit: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<Page<SessionEvent>> {
    this.log("listTurnEvents", sessionId, turnId, q);
    const all = [...(this.events.get(turnId) ?? [])];
    if (q.order === "desc") all.reverse();
    const start = q.cursor ? Number(q.cursor) : 0;
    const items = all.slice(start, start + q.limit);
    const next = start + q.limit < all.length ? String(start + q.limit) : undefined;
    return { items, ...(next ? { next } : {}) };
  }

  async tipTurnId(sessionId: string): Promise<string | undefined> {
    this.log("tipTurnId", sessionId);
    return this.turnsOf(sessionId).at(-1)?.id;
  }

  async findAgentId(name: string): Promise<string | undefined> {
    this.log("findAgentId", name);
    return name === "cartographer" ? CARTOGRAPHER_ID : undefined;
  }

  async getAgentSpec(agentId: string): Promise<AgentSpec> {
    this.log("getAgentSpec", agentId);
    if (agentId !== CARTOGRAPHER_ID) throw notFound(`agent ${agentId}`);
    return structuredClone(SPEC);
  }

  async createSession(body: { spec: AgentSpec; metadata: Metadata }): Promise<Session> {
    this.log("createSession", body);
    const id = `new-${this.sessions.size}`;
    const s = this.addSession(id, { metadata: body.metadata, inline: true });
    if (s.agent.type === "inline") s.agent.spec = structuredClone(body.spec);
    return structuredClone(s);
  }

  async updateSession(sessionId: string, body: { spec?: AgentSpec; metadata?: Metadata }): Promise<Session> {
    this.log("updateSession", sessionId, body);
    const s = this.session(sessionId);
    if (body.metadata) s.metadata = body.metadata;
    if (body.spec && s.agent.type === "inline") s.agent.spec = structuredClone(body.spec);
    return structuredClone(s);
  }

  async createTurn(sessionId: string, body: { input: TurnInputItem[]; previousTurnId: string }): Promise<Turn> {
    this.log("createTurn", sessionId, body);
    const id = `${sessionId}-t${this.turnsOf(sessionId).length + 1}`;
    const previous = body.previousTurnId === "none" ? null : body.previousTurnId;
    const created = this.addTurn(sessionId, id, { previous, status: "running", input: body.input });
    const snapshot = structuredClone(created);
    // The next read sees it finished, the way a quick Turn would be.
    const finished = this.finishCreatedTurnsAs;
    if (finished !== "running") {
      const turns = this.turnsOf(sessionId);
      turns.pop();
      this.addTurn(sessionId, id, { previous, status: finished, input: body.input });
    }
    return snapshot;
  }

  async cancel(sessionId: string): Promise<void> {
    this.log("cancel", sessionId);
  }
}

// What the SDK throws for a 404: an Error with a status code.
function notFound(what: string) {
  return Object.assign(new Error(`${what} not found`), { statusCode: 404 });
}

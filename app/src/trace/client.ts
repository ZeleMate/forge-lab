// The trace panel's reads, through the typed SDK, which parses TrueForge's responses
// and walks its pages. Same-origin, so they go through Vite's /api proxy. Read-only:
// the app's own writes all go through the chat UI, never this panel.

import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { SessionEvent } from "./event-rows";

export type Turn = TrueForgeApi.Turn;

// No retries: the next poll is the retry.
const client = new TrueForge({ baseUrl: window.location.origin, maxRetries: 0, timeoutInSeconds: 10 });

// `for await` walks the SDK's Page across every page, so a long Turn isn't cut off.
async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of pages) items.push(item);
  return items;
}

// GET /agents has no name filter that works, so this matches across every page.
export async function findAgentId(name: string): Promise<string | undefined> {
  for await (const agent of await client.agents.list({ limit: 100 })) if (agent.name === name) return agent.id;
  return undefined;
}

export async function listTurns(sessionId: string, abortSignal: AbortSignal): Promise<Turn[]> {
  return collect(await client.sessions.listTurns(sessionId, { limit: 25 }, { abortSignal }));
}

export async function listTurnEvents(
  sessionId: string,
  turnId: string,
  abortSignal: AbortSignal,
): Promise<SessionEvent[]> {
  return collect(
    await client.sessions.listTurnEvents(sessionId, turnId, { limit: 100, order: "asc" }, { abortSignal }),
  );
}

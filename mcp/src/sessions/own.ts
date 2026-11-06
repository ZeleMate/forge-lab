// Which TrueForge Session is calling? (#24) No id arrives with a tool call, but
// TrueForge opens one MCP connection per Session and persists its
// `Mcp-Session-Id` in an `mcp.initialize` event. So the caller's Session is the
// one with a running Turn whose `mcp.initialize` names this connection's id.

import { type SessionsApi, TooManyTurnsError, type Turn } from "./api";

// `detected`: found by the scan. Otherwise it came only from the tool's
// `caller_session_id`, which nothing confirms, so the write checks distrust it.
export type OwnSession = { sessionId: string; runningTurnId: string | undefined; depth: number; detected: boolean };

// `mcp.initialize` comes right after `turn.created` on the Turn that connected,
// so the first few events of a Turn are enough to look at.
const EVENTS_SCANNED = 10;
// The caller's Session was updated when its Turn started, so it's near the top
// of the most-recently-updated list; 4 pages leave room for a long Turn while
// other Sessions keep updating.
const SESSION_PAGES = 4;

export function depthOf(metadata: Record<string, string>): number {
  // An untagged Session (the user's chat) is depth 0, like a script's root Experiment.
  const raw = metadata.depth;
  if (raw === undefined) return 0;
  // A tag that isn't a small integer counts as too deep, so writes refuse it.
  return /^\d$/.test(raw) ? Number(raw) : Number.POSITIVE_INFINITY;
}

const running = (turns: Turn[]) => turns.find((t) => t.state.status === "running")?.id;

export function ownSessionFinder(api: SessionsApi, mcpSessionId: string | undefined) {
  // The mapping never changes for a connection (one connection per Session),
  // so a found Session is kept. A miss is not: the live approvals check showed
  // the `mcp.initialize` event isn't always readable by the first tool call.
  // The running Turn is looked up again on every call.
  let cached: string | undefined;

  async function scan(): Promise<string | undefined> {
    if (!mcpSessionId) return undefined;
    let cursor: string | undefined;
    for (let page = 0; page < SESSION_PAGES; page++) {
      const res = await api.listSessions({ limit: 25, ...(cursor ? { cursor } : {}) });
      for (const session of res.items) if (await initializedHere(session.id)) return session.id;
      cursor = res.next;
      if (!cursor) break;
    }
    return undefined;
  }

  // Whether this Session is running a Turn and was connected to us.
  async function initializedHere(sessionId: string): Promise<boolean> {
    // One oversized Session mustn't fail every write: it's skipped here, and a
    // caller that really is that Session goes undetected, so it's treated strictly.
    const turns = await api.listTurns(sessionId).catch((error) => {
      if (error instanceof TooManyTurnsError) return [];
      throw error;
    });
    if (!running(turns)) return false;
    // Newest first: after an MCP server restart, the latest Turn re-initialized.
    for (const turn of [...turns].reverse()) {
      const { items: events } = await api.listTurnEvents(sessionId, turn.id, { limit: EVENTS_SCANNED });
      const match = events.some(
        (e) => e.type === "mcp.initialize" && e.mcpServers.some((s) => s.sessionId === mcpSessionId),
      );
      if (match) return true;
    }
    return false;
  }

  // `override` is the tool's explicit `caller_session_id`; it only counts when the
  // scan finds nothing, so a model can't name another Session to dodge the refusals.
  return async function findOwn(override?: string): Promise<OwnSession | undefined> {
    if (!cached) cached = await scan();
    const sessionId = cached ?? override;
    if (!sessionId) return undefined;
    const [session, turns] = await Promise.all([api.getSession(sessionId), api.listTurns(sessionId)]);
    // An override only counts for a Session that is mid-Turn, as the caller's is.
    if (!cached && !running(turns)) return undefined;
    return {
      sessionId,
      runningTurnId: running(turns),
      depth: depthOf(session.metadata),
      detected: cached !== undefined,
    };
  };
}

export type FindOwn = ReturnType<typeof ownSessionFinder>;

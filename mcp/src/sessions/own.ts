// Which TrueForge Session is calling? (#24) No id arrives with a tool call, but
// TrueForge opens one MCP connection per Session and persists its
// `Mcp-Session-Id` in an `mcp.initialize` event. So the caller's Session is the
// one with a running Turn whose `mcp.initialize` names this connection's id.

import type { SessionsApi, Turn } from "./api";

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
  // so the scan runs once, and so does a miss: TrueForge persists
  // `mcp.initialize` when it connects, before its first tool call, so a
  // connection that isn't found then never will be. The running Turn is looked
  // up again on every call.
  let scanned = false;
  let cached: string | undefined;

  async function scan(): Promise<string | undefined> {
    if (!mcpSessionId) return undefined;
    let cursor: string | undefined;
    for (let page = 0; page < SESSION_PAGES; page++) {
      const res = await api.listSessions({ limit: 25, ...(cursor ? { cursor } : {}) });
      // A page's Sessions are checked in parallel; `findIndex` then takes the
      // first match in the page's own (most recently updated) order.
      const hits = await Promise.all(res.items.map((s) => initializedHere(s.id)));
      const hit = res.items[hits.findIndex(Boolean)];
      if (hit) return hit.id;
      cursor = res.next;
      if (!cursor) break;
    }
    return undefined;
  }

  // Whether this Session is running a Turn and was connected to us.
  async function initializedHere(sessionId: string): Promise<boolean> {
    const turns = await api.listTurns(sessionId);
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
    if (!scanned) {
      cached = await scan();
      scanned = true;
    }
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

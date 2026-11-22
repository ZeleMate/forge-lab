// Reading Turns over the `SessionsApi` seam: paging a Turn's events, walking
// the Sessions list, and waiting for a Turn to finish. Each pager is capped
// per call, since each caller's cap has its own reason. It says when the cap
// cut it short (`cut`), instead of returning a short list as if it were whole.

import type { Clock } from "../clock";
import type { Session, SessionEvent, SessionsApi, Turn } from "./api";

// How often anything that waits on a Turn reads it again.
export const POLL_MS = 2_000;

export const EVENTS_PAGE_SIZE = 100;
// The server's largest page of Sessions.
const SESSIONS_PAGE_SIZE = 25;

// What a capped pager found. `cut` is true when it stopped at its page cap
// while the server still had another page.
export type Capped<T> = { items: T[]; cut: boolean };

// A Turn's events, oldest first, at most `maxPages` pages of 100. With `match`,
// only the events it accepts are kept; with `until`, reading stops once that
// many are kept, and no more than that come back. Stopping on `until` isn't a cut:
// the caller got what it asked for.
export async function allEvents(
  api: SessionsApi,
  sessionId: string,
  turnId: string,
  opts: { maxPages: number; match?: (e: SessionEvent) => boolean; until?: number },
): Promise<Capped<SessionEvent>> {
  // `Infinity` as the default makes "no `until`" the same as "never enough".
  const until = opts.until ?? Number.POSITIVE_INFINITY;
  const items: SessionEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < opts.maxPages && items.length < until; page++) {
    const res = await api.listTurnEvents(sessionId, turnId, {
      limit: EVENTS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    // `...` spreads the page into `push` as separate arguments. Without `match`, every event is kept.
    items.push(...(opts.match ? res.items.filter(opts.match) : res.items));
    cursor = res.next;
    if (!cursor) break;
  }
  const enough = items.length >= until;
  items.splice(until); // `splice(n)` cuts the array down to its first n items, in place
  return { items, cut: cursor !== undefined && !enough };
}

// The first Session, most recently updated first, that `match` accepts, looking
// at most `maxPages` pages of 25. It stops reading as soon as one matches.
export async function findSession(
  api: SessionsApi,
  match: (s: Session) => Promise<boolean>,
  opts: { maxPages: number },
): Promise<{ session: Session | undefined; cut: boolean }> {
  let cursor: string | undefined;
  for (let page = 0; page < opts.maxPages; page++) {
    const res = await api.listSessions({ limit: SESSIONS_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    // One at a time, in order: `match` may read the server, and the first hit ends the walk.
    for (const session of res.items) if (await match(session)) return { session, cut: false };
    cursor = res.next;
    if (!cursor) break;
  }
  return { session: undefined, cut: cursor !== undefined };
}

// Reads the Turn every POLL_MS until it's finished or `timeoutMs` has passed
// (on `clock`, so a test's fake clock jumps ahead instead of waiting). The
// last sleep is cut short to land on the deadline, so the final read is at it.
export async function waitForTurn(
  api: SessionsApi,
  clock: Clock,
  sessionId: string,
  turnId: string,
  timeoutMs: number,
): Promise<{ turn: Turn; finished: boolean; waitedMs: number }> {
  const started = clock.now();
  const deadline = started + timeoutMs;
  let turn = await api.getTurn(sessionId, turnId);
  while (isUnfinished(turn) && clock.now() < deadline) {
    await clock.sleep(Math.min(POLL_MS, deadline - clock.now()));
    turn = await api.getTurn(sessionId, turnId);
  }
  return { turn, finished: !isUnfinished(turn), waitedMs: clock.now() - started };
}

// ---------- Turn-state facts ----------

// Still going: running, or `paused` (which #24 never saw on the wire, since an
// Approval wait shows as `done` with required actions, but the type allows it).
// Its opposite is a finished Turn: done, cancelled or error.
export const isUnfinished = (t: Turn) => t.state.status === "running" || t.state.status === "paused";

// Executing right now, so it can be making tool calls. Narrower than
// unfinished: a paused Turn isn't running. The own-Session scan uses this.
export const isRunning = (t: Turn) => t.state.status === "running";

// How many Approvals or answers a finished Turn is waiting on (#24): a `done`
// Turn with any is waiting on the user. Every other Turn has none.
export function requiredActions(t: Turn): number {
  return t.state.status === "done" ? t.state.requiredActions.length : 0;
}

// The metrics TrueForge recorded when the Turn finished, or undefined while it
// runs (and for a Turn cancelled for the next one, #24).
export function recordedMetrics(t: Turn) {
  // `in` narrows the state union to the members that have a `metrics` field.
  return ("metrics" in t.state && t.state.metrics) || undefined;
}

// What the Turn cost, or 0 when it has no recorded cost.
export function costOf(t: Turn): number {
  return recordedMetrics(t)?.totalCostInUsd || 0;
}

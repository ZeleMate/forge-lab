// What a Turn's persisted state means to someone watching it. Pure, so it's tested
// without a browser or a server.

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

export type TurnState = TrueForgeApi.TurnState;
export type TurnPhase = "running" | "waiting" | "done" | "error" | "cancelled" | "unknown";

// How often the panel re-reads anything that can still change.
export const POLL_MS = 1500;

// Open actions on the Turn. An Approval wait is NOT `paused`: the Turn ends as `done`
// with `requiredActions`, and a new Turn carries the answer.
export function pendingActions(state: TurnState): number {
  if (state.status === "done") return state.requiredActions.length;
  if (state.status === "paused") return state.actionRequiredOnEvents.length;
  return 0;
}

// A Turn's `requiredActions` stay stored after they're answered, because the answer
// lives in the next Turn. So the only sign that a pause is over is a Turn continuing
// from it. (Our write tools refuse to fork from a pending Turn, so that's an answer.)
export function continuedTurnIds(turns: readonly { previousTurnId?: string | null }[]): Set<string> {
  return new Set(turns.flatMap((turn) => (turn.previousTurnId ? [turn.previousTurnId] : [])));
}

export function turnPhase(state: TurnState, continued = false): TurnPhase {
  // A `switch` on a discriminant narrows `state` to one member of the union per case.
  switch (state.status) {
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "done":
      return pendingActions(state) > 0 && !continued ? "waiting" : "done";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown"; // the SDK lets a status it doesn't know through
  }
}

// Can this Turn's persisted events still change? A Turn waiting on an Approval can't:
// the answer goes into the next Turn. So `waiting` isn't the same as live.
export function isLive(state: TurnState): boolean {
  return state.status === "running" || state.status === "paused";
}

// The events poll for one Turn: null means read once and stop.
export function eventsPollMs(state: TurnState): number | null {
  return isLive(state) ? POLL_MS : null;
}

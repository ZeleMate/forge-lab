// The background replay behind `fork_turn` from the user's chat (#9): the
// chat's user messages are sent again, one Turn at a time, into a new inline
// Experiment Session, and the Session's `replay` tag records how it ended.

import type { Clock } from "../clock";
import type { SessionsApi, Turn, TurnInputItem } from "./api";
import { requiredActions } from "./project";
import { isUnfinished, POLL_MS } from "./shared";

// A replayed Turn may take a while on Opus; TrueForge itself stops a Turn at 600 s.
const REPLAY_TURN_TIMEOUT_MS = 660_000;

export function replayRunner(api: SessionsApi, clock: Clock) {
  // Runs the replayed Turns one after another: each must finish before the next
  // chains on it, or creating the next would cancel it (#21 6.2).
  return async function replay(newSessionId: string, tags: Record<string, string>, inputs: TurnInputItem[][]) {
    const markFailed = (reason: string) =>
      api.updateSession(newSessionId, { metadata: { ...tags, replay: `failed:${reason}`.slice(0, 128) } });
    try {
      let previous = "none";
      for (const [index, input] of inputs.entries()) {
        const created = await api.createTurn(newSessionId, { input, previousTurnId: previous });
        const turn = await waitUntilDone(newSessionId, created.id);
        const failed =
          turn.state.status !== "done"
            ? `turn ${index + 1} ended ${turn.state.status}`
            : requiredActions(turn) > 0
              ? `turn ${index + 1} wants an Approval`
              : undefined;
        if (failed) {
          // A Turn that timed out is still running; stop it so it isn't left unattended.
          if (isUnfinished(turn)) await api.cancel(newSessionId).catch(() => undefined);
          await markFailed(failed);
          return;
        }
        previous = turn.id;
      }
      await api.updateSession(newSessionId, { metadata: { ...tags, replay: "done" } });
    } catch (error) {
      // Best effort: if TrueForge is unreachable the tag can't be written either.
      await markFailed(error instanceof Error ? error.message : String(error)).catch(() => undefined);
      throw error;
    }
  };

  async function waitUntilDone(id: string, turnId: string): Promise<Turn> {
    const deadline = clock.now() + REPLAY_TURN_TIMEOUT_MS;
    for (;;) {
      const turn = await api.getTurn(id, turnId);
      if (!isUnfinished(turn) || clock.now() >= deadline) return turn;
      await clock.sleep(POLL_MS);
    }
  }
}

// The Turns from the root down to `turnId`, following `previousTurnId`.
export function branchTo(turns: Turn[], turnId: string): Turn[] {
  const byId = new Map(turns.map((t) => [t.id, t]));
  const path: Turn[] = [];
  for (let t = byId.get(turnId); t; t = t.previousTurnId ? byId.get(t.previousTurnId) : undefined) path.unshift(t);
  return path;
}

// Only a Turn's user messages are replayed; Approval answers belong to the
// original Turn's pending calls, which the replay doesn't have.
export function userMessagesOf(t: Turn): TurnInputItem[] {
  return (t.input ?? []).filter((i) => i.type === "user.message");
}

export function costOf(t: Turn): number {
  return ("metrics" in t.state && t.state.metrics?.totalCostInUsd) || 0;
}

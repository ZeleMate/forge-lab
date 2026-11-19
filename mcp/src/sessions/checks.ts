// The write tools' safety checks (#8, #9, #24). Each returns a refusal, or
// undefined when the write may go on. The write tools run them in the order
// the header of tools.ts lists.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { refuse } from "../result";
import type { Session, Turn } from "./api";
import { depthOf, type FindOwn, type OwnSession } from "./own";
import { requiredActions } from "./project";
import { isExperiment, isUnfinished } from "./shared";

// `v is CallToolResult` is a type predicate: where isRefusal returns true,
// TypeScript narrows the value to a refusal.
export const isRefusal = (v: unknown): v is CallToolResult => typeof v === "object" && v !== null && "isError" in v;

// 1. The caller's own Session: the first thing every write needs.
export async function ownOrRefuse(findOwn: FindOwn, override?: string): Promise<OwnSession | CallToolResult> {
  const own = await findOwn(override);
  if (!own)
    return refuse(
      "can't tell which Session I'm running in, so I can't rule out acting on it",
      "pass caller_session_id (your Session's id)",
    );
  // The detected Session wins over the override (findOwn), so a different id
  // can only be a mistake or an attempt to dodge the own-Session refusals.
  if (override && override !== own.sessionId)
    return refuse(
      `caller_session_id ${override} isn't the Session I'm running in (${own.sessionId})`,
      "leave caller_session_id out; it's only for when I can't tell",
    );
  return own;
}

// 2. Every Turn is named explicitly; `auto` could chain onto the caller (#21 6.2).
export function checkTurnId(id: string): CallToolResult | undefined {
  if (id === "auto" || id === "none")
    return refuse(`\`${id}\` isn't allowed: every write names an explicit Turn id`, "get_turn to find the Turn's id");
  return undefined;
}

// 3. The source Turn must be finished, and not waiting on an Approval (#24).
export function checkSourceTurn(turn: Turn): CallToolResult | undefined {
  if (isUnfinished(turn))
    return refuse(`Turn ${turn.id} is still running`, "wait_turn until it finishes, or pick a finished Turn");
  if (requiredActions(turn) > 0)
    return refuse(
      `Turn ${turn.id} is waiting on an Approval or answer (${requiredActions(turn)} pending)`,
      "pick an earlier Turn, or resolve it in the UI first",
    );
  return undefined;
}

export function checkDepth(session: Session): CallToolResult | undefined {
  if (depthOf(session.metadata) >= 2)
    return refuse(
      `Session ${session.id} is at depth ${session.metadata.depth}; writes stop at depth 2`,
      "work in a shallower Experiment Session",
    );
  return undefined;
}

// 4. The target of an in-place write, in this order: only an Experiment
// Session, never the caller's own, never depth 2 or more, and never one with a
// running Turn. Keeping the order in one place is the point: it's what makes
// the writes safe.
export function checkInPlaceTarget(
  session: Session,
  own: OwnSession,
  action: "fork in place" | "re-run" | "cancel",
  targetRunning: boolean,
): CallToolResult | undefined {
  const cancel = action === "cancel";
  if (!isExperiment(session))
    return refuse(
      `Session ${session.id} is not an Experiment Session, so it's read-only`,
      cancel
        ? "the user can stop it in the UI"
        : "fork_turn from it instead, which replays into a new Experiment Session",
    );
  if (session.id === own.sessionId)
    return refuse(
      cancel
        ? "cancelling my own Session would end this Turn"
        : `a ${action} in my own Session would move its tip off this Turn`,
      cancel ? "the user can stop it in the UI" : "use another Experiment Session",
    );
  const deep = checkDepth(session);
  if (deep) return deep;
  if (!targetRunning) return undefined;
  // A caller named only by `caller_session_id` might really be any running
  // Session, so it may not touch one, not even to cancel it.
  if (!own.detected)
    return refuse(
      `I couldn't confirm which Session I'm in, and Session ${session.id} has a running Turn that could be mine`,
      cancel ? "the user can stop it in the UI" : "wait until it finishes, or ask the user to do this in the UI",
    );
  // A fork or re-run chains on a finished Turn, so the running one isn't
  // cancelled (#21 6.2), but the new Turn becomes the tip, and the running one
  // is left where cancel_session can't reach it.
  if (!cancel)
    return refuse(
      `Session ${session.id} has a running Turn; a ${action} would run alongside it and leave it where cancel_session can't reach`,
      "wait_turn until it finishes, or cancel_session it first",
    );
  return undefined;
}

// The write tools' checks on the caller and the source Turn (#8, #9, #24):
// steps 1 to 3 of the order tools.ts's header lists. Each returns a refusal, or
// undefined when the write may go on. Step 4, the target Session, is the
// access policy's (access.ts).

import type { CallToolResult } from "@modelcontextprotocol/server";
import { refuse } from "../result";
import type { Turn } from "./api";
import type { FindOwn, OwnSession } from "./own";
import { requiredActions } from "./project";
import { isUnfinished } from "./shared";

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

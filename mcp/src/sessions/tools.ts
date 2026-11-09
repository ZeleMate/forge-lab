// The sessions server's ten tools (#8, amended by #9 and #24): seven reads
// that inspect TrueForge's own Sessions (reads.ts; the two that read the user's
// other chats are Approval-gated by name), and three Approval-gated writes that
// act only on Experiment Sessions (writes.ts). Every result is
// labelled `observed` and cites `{session_id, turn_id, event_id}`.
//
// Write safety, in the order every write tool runs the checks (checks.ts):
// 1. the tool must know its own Session (auto-detected, or `caller_session_id`);
// 2. every Turn is named by an explicit id, never `auto` or `none`;
// 3. a source Turn must be finished and not waiting on an Approval (#24: the
//    server would accept it);
// 4. the target (`checkInPlaceTarget`): only Experiment Sessions are changed in
//    place, never the caller's own, never at depth 2 or more, and never a
//    running one when the caller is unverified. The user's chat is only ever
//    read; a fork from it replays into a new Experiment Session (replay.ts).
// Only after all of that does a mutating call go out.

import type { McpServer } from "@modelcontextprotocol/server";
import { ownSessionFinder } from "./own";
import { registerReadTools } from "./reads";
import type { SessionsDeps } from "./shared";
import { registerWriteTools } from "./writes";

export type { SessionsDeps } from "./shared";

export function registerSessionsTools(server: McpServer, deps: SessionsDeps, mcpSessionId: string): void {
  // One finder per connection, so the reads and writes share its cached answer.
  const findOwn = ownSessionFinder(deps.api, mcpSessionId);
  registerReadTools(server, deps, findOwn);
  registerWriteTools(server, deps, findOwn);
}

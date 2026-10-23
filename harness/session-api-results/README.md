# Session API live check (ticket #24)

What can an MCP tool see of its own Session, and do the session-tool assumptions from #8 and #9 hold on a live TrueForge 0.179.2?

Script: [`scripts/session-api-check.ts`](../scripts/session-api-check.ts) (`bun run session-api-check`). It starts a throwaway MCP server ([`scripts/lib/probe-mcp.ts`](../scripts/lib/probe-mcp.ts)) on `127.0.0.1:8791` (8799 since #33) inside the same process, registers it in TrueForge as `session-probe`, and drives `glm-5-3-flash` Sessions that call its tools. Every Session it creates is an Experiment Session (`metadata.experiment = "session-api-check"`). Raw results are the timestamped JSON files in this folder.

## Expected (written before the first run)

From [docs/research/session-api.md](../../docs/research/session-api.md) and the bundled 0.179.2 source.

| # | Check | Expected |
| - | - | - |
| E1 | Session or Turn id in the tool call (headers, `_meta`) | None. Local mode forwards neither (§6.3). |
| E2 | `Mcp-Session-Id` header vs the persisted `mcp.initialize` event | Same id; a tool can find its own Session by scanning `mcp.initialize` events (§6.3, workaround 1). Reused across Turns of one Session. |
| E3 | Own running Turn's events, read from inside the tool | Readable: `turn.created`, earlier steps and the `model.message` holding this tool call; no `tool.response` for the call in progress; `state` is `running` with no metrics (§5). |
| E4 | Tool creates a Turn on its own Session with `previous_turn_id: auto` | The caller's Turn ends `cancelled` (`cancelled-for-next-turn`), its `tool.response` is never persisted, the new Turn runs (§6.2). |
| E5 | Fork from a `paused` Turn with a `user.message` | 422 (§4.1). |
| E6 | Fork from a `cancelled` Turn | Works (unverified in research). |
| E7 | Fork from an `error` Turn | Works (unverified in research). |
| E8 | Payload sizes | Turn a few KB; `model.message` 1–10 KB; an events page well under 1 MB (§3.2, estimates). |
| E9 | `@truefoundry/trueforge-sdk` 0.179.0 under Bun, `maxRetries: 0` | Works; `Page` iteration works (§8, inferred). |
| E10 | `GET /healthz` | `{ status: "ok", version: "0.179.2" }`. |
| E11 | Inline Experiment Session replaying another Session's `user.message` inputs | Works; each replayed Turn chains on the previous one with an explicit `previous_turn_id`. |
| E12 | `PATCH` an inline Session's spec (low compaction trigger, then `iteration_limit: 1`) | Takes effect on the next Turn: compaction shrinks the next Turn's input; `iteration_limit: 1` makes a tool-calling Turn end in `error`. |
| E13 | `PATCH` with a partial spec (no `model`) | Rejected (the body is a whole `AgentSpec`, not a merge patch), so `config_patch` must be merged client-side. |
| E14 | `PATCH` agent on a named Session | Rejected ("Named sessions reject agent updates", route description). |
| E15 | Loopback MCP server URL with the default network policy | Blocked: the outbound SSRF guard denies `127.0.0.0/8` unless `OUTBOUND_URL_ALLOWED_HOSTS` lists it (`trueforge-core` `util/ssrfGuard`). |

## Observed (2026-10-20, TrueForge 0.179.2, `glm-5-3-flash`)

Runs: [`2026-10-20T13-08-34-789Z.json`](2026-10-20T13-08-34-789Z.json) (`guard`, default network policy) and [`2026-10-20T13-13-43-138Z.json`](2026-10-20T13-13-43-138Z.json) (full, with `127.0.0.1` allow-listed). A first full run gave the same results apart from a race in the script (fixed) that left E4's tool-side record empty.

| # | Matches? | Observed |
| - | - | - |
| E1 | yes | No Session or Turn id anywhere. `tools/call` carries no `params._meta`. Headers are only `accept`, `accept-encoding`, `accept-language`, `connection`, `content-length`, `content-type`, `host`, `mcp-protocol-version`, `mcp-session-id`, `sec-fetch-mode`, `user-agent: undici`. |
| E2 | yes | `Mcp-Session-Id` equals `mcp.initialize.mcp_servers[].session_id`. Each TrueForge Session gets its own MCP session (A and B differ), reused on later Turns, so `mcp.initialize` is persisted only on the Turn that initialized (A1, not A2). The tool found exactly its own Session in all 4 calls by scanning `GET /sessions/{id}/events` for that id; its own Turn is then the one `running` in that Session. |
| E3 | yes | From inside the call: `turn.created`, `mcp.initialize` (first Turn only), and the `model.message` holding this very tool call. No `tool.response`, `state.status: running`, no `metrics`. |
| E4 | yes | Caller Turn ended `cancelled` / `cancelled-for-next-turn` within ~1 s; its events are `turn.created`, `model.message`, `turn.done`, with **no `tool.response`**. The tool kept running and saw its own Turn already cancelled. The new Turn's `previous_turn_id` is the cancelled caller, and it ran to `done`. A `cancelled-for-next-turn` state carries **no `metrics`**. |
| E5 | **no** | An Approval wait is **not** `paused` on the wire: the Turn is `status: done` with a non-empty `required_actions` (`tool.approval_required`). Forking it with a `user.message` returned **200**, and the fork ran to `done`. No 422. |
| E6 | yes | Forks from `cancelled-for-next-turn` and from `client-cancelled` both ran to `done`. `POST /cancel` returned `200 {}`; a Turn cancelled before its first model call has zeroed metrics. |
| E7 | yes | Fork from an `error` Turn (iteration limit) ran to `done`. |
| E8 | yes, smaller | Bytes on the wire (max / mean): Session 1,293 / 661; Turns page 7,846 / 3,527; one Turn 1,987 / 1,110; one Turn's events page 3,940 / 2,232; Session events page 15,673 / 7,310. Per event (max / mean): `model.message` 1,478 / 702, `turn.done` 1,832 / 953, `turn.created` 345 / 324, `mcp.initialize` 267, `tool.approval_required` 227, `tool.response` 209 / 195. Small Turns; real Cartographer Turns with long tool output will be larger. |
| E9 | yes | SDK 0.179.0 under Bun 1.4.3 with `maxRetries: 0`: `sessions.get`, `listTurns` (Page iteration across pages with `limit: 2`, 5 Turns) and `listTurnEvents` work. Fields are camelCased (`previousTurnId`, `createdBySubject`). |
| E10 | yes | `{ "status": "ok", "version": "0.179.2" }`. |
| E11 | yes | `POST /sessions` with `agent: { spec }` → 201, `agent.type: inline`. The spec copied from `GET /agents/{id}` is the server's normalized spec (every config default filled in). Three replayed `user.message` Turns chained with explicit `previous_turn_id`, all `done`. |
| E12 | yes | After `PATCH` with a compaction trigger of 3,110 tokens, the next Turn's metrics show 4,199 input tokens but its only `model.message` used 2,583: a 1,616-token model call that is not an event, i.e. the compaction summary. Every other Turn's total equals its `model.message` sum. On this short history the compacted context was not smaller (messages 245 → 526 tokens), but the answer still named all three topics. After `PATCH` to `iteration_limit: 1`, the next tool-calling Turn ran the tool, then ended `error`: "You have reached iteration limit of 1". |
| E13 | yes | Partial spec → 400 "expected object, received undefined → at agent.spec.model"; the Session's config was unchanged. `PATCH` replaces the whole spec. |
| E14 | yes | 422 "Session … is named; agent cannot be updated". |
| E15 | yes | `PUT /settings/mcp-servers` with `http://127.0.0.1:8791/mcp` → 400 "Outbound URL blocked for host \"127.0.0.1\"", already at registration. With `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'` (now in the `start` script) it registers and works. |

### Notes

- **Compaction leaves no event.** It runs as `ContextCompaction.processPreLLM` and yields an internal `agent.context.overwrite`, which `TurnHandle` writes to the thread snapshot and does not persist as an event (`trueforge-core` `core/capabilities/builtins/ContextCompaction.mjs`, `agent-session/TurnHandle.mjs` around line 361). The only trace over REST is `state.metrics.total_input_tokens` exceeding the sum over `model.message` usage.
- **Why E5 got 200 is not fully traced.** `AgentThread.validateUserMessage` throws "user message cannot be sent while approvals or questions are pending" when an open tool call needs approval (`core/runtime/AgentThread.mjs:174`), but the fork was accepted. A lead: `RemoteMCP.toolCallInfo` returns `is_approval_required: false` (`core/mcp/RemoteMCP.mjs:200`), and the approval-gated MCP call may then count as closable, so `OpenToolCallCloser` answers it with "Tool call was not executed". Not confirmed.
- **The `paused` status exists in the schema** (`agent-session/schemas/turn.mjs:27`), but `TurnHandle` writes `done` + `required_actions` for an Approval wait (`agent-session/TurnHandle.mjs:262-266`).
- The approval check comes from annotations: a tool with `readOnlyHint: false` matched the default `["@write", "@destructive"]` (`core/mcp/toolSelectors.mjs`).

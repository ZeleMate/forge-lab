# How an MCP tool reads and drives TrueForge's own Sessions over REST

Research for forge-lab issue #21. Goal: decide how the Cartographer MCP server (TypeScript on Bun) calls the TrueForge server that is running the current Turn, so that issue #8 can design the session tools.

**Sources and method.**
- OpenAPI spec: `https://trueforge.dev/openapi.json` (cited `openapi:<path or schema>`). It is the docs-site build and is versioned `0.0.0`, so it is **not pinned** to 0.179.2. Every behaviour that matters below was re-checked in the source.
- Docs: `https://trueforge.dev/<page>.md` (cited `docs:<page>`): `sessions`, `api/use-agent`, `api/overview`, `api/quickstart`, `authentication/overview`.
- Server source: https://github.com/truefoundry/trueforge at commit `198a2ead7bcc32b00aef75d22eea6fa1569d1734`. This is the commit the npm provenance attestation for `@truefoundry/trueforge@0.179.2` names (workflow ref `refs/heads/release-v0.179.2`, `https://registry.npmjs.org/-/npm/v1/attestations/@truefoundry%2ftrueforge@0.179.2`). Paths below are relative to the repo root; `server/` = `packages/trueforge/src/`, `core/` = `packages/trueforge-core/src/`.
- SDK: `@truefoundry/trueforge-sdk@0.179.0` (npm `latest`; there is no 0.179.2), unpacked from the registry tarball and read as `.d.mts` types and compiled JS.
- Statements marked **(inferred)** are my reading of code or schemas. **Nothing here was run against a live server**, so payload sizes are bounds and estimates, not measurements. Where docs and source disagree, the source wins (section 9).

## 1. Short answers

| Question | Answer |
| - | - |
| Authentication in standalone mode | **None.** No header is needed on the public `/api/v1/*` routes. The `trueforge-standalone` key exists but only guards the *internal* schedule and sandbox-build routes, which Cartographer does not call. |
| Endpoints for the session tools | All exist except two verbs: **fork** and **re-run** are not endpoints, they are `POST /sessions/{id}/turns` with a chosen `previous_turn_id`. **Cancel** works per session (it cancels the session's tip turn), not per turn. |
| Reading the in-flight Turn | **Works.** Events are inserted into SQLite as they happen, and the events routes do not filter on status. The docs say the opposite (stale). The one gap: the model's partially streamed text is not persisted. |
| Deadlock or self-cancel | **No deadlock** if the tool uses `stream: false`. **Self-cancel is real** in two ways: `POST /sessions/{id}/cancel` on the caller's own session, and creating a Turn with the default `previous_turn_id: "auto"` while the caller's Turn is the tip. Both end the caller's Turn. Always pass an explicit terminal `previous_turn_id`, and block self-targeting in the tool. |
| SDK or raw REST | **The SDK**, with `maxRetries: 0` on mutating calls and a thin wrapper that returns compact projections. Details in section 8. |

## 2. Authentication in standalone mode

**Documented.**
- `docs:api/quickstart` ("Get a token and connect"): no-login mode needs no token, "Omit `token`. The SDK talks to the server as the shared local admin."
- `openapi:info.description`: "Standalone auth accepts requests without credentials, middleware stamps a local default user ... There is no built-in API-key scheme."
- `docs:sessions`: "In local mode there is a single shared identity, so all sessions belong to that one user."

**Source, which settles the `trueforge-standalone` question.**
- `server/auth/standaloneAuthenticator.ts` returns `STANDALONE_REQUEST_CONTEXT` for every request without looking at any header. That context (`server/auth/identity.ts`) is `tenant_id: 'default'`, subject `trueforge-default` (type `user`), roles `['admin']`.
- `server/config.ts:50-53` defines `STANDALONE_TRUEFORGE_API_KEY = 'trueforge-standalone'`, used as the default `TRUEFORGE_API_KEY` when `STANDALONE=true` (`config.ts:1202`).
- `server/app.ts:258` builds `createApiKeyAuthMiddleware(configuration.TRUEFORGE_API_KEY)` and uses it only for `/api/internal/schedules` (`app.ts:401`) and `/api/internal/sandbox-environments` (`app.ts:405-412`). It is a `Authorization: Bearer <key>` equality check (`server/auth/middleware.ts`, `createApiKeyAuthMiddleware`). The scheduler uses it to call the server back (`packages/trueforge/tests/unit/controller/scheduleDispatch.test.ts` asserts `Bearer ${STANDALONE_TRUEFORGE_API_KEY}`).
- Everything Cartographer needs is mounted behind `authMiddleware`, which in standalone mode just stamps the default user: `/api/v1/sessions` (`app.ts:491` and `app.ts:514`, session and turn routers), `/api/internal/sessions` (`app.ts:448`), `/api/internal/metrics` (`app.ts:466`).

So the ticket's guess was half right: the key exists, but it is not what authenticates the public API. **Send no auth header**, set no cookie. `baseUrl` is `http://localhost:8790` (`docs:api/quickstart`; `server/config.ts` `DEFAULT_PORT = 8790`, `DEFAULT_HOST = 'localhost'`).

**Authorization consequence.** Every session route compares the caller's subject id with `created_by_subject` (`server/apis/turns.ts` `isSessionOwner`; create-turn, cancel, subscribe and download are creator-only, reads are creator-or-shared-or-agent-manager). Since every caller is `trueforge-default`, the MCP server can touch **all** Sessions, including the ones the UI created and the ones a schedule created. That is what Cartographer wants, but it also means no Session is protected from its own tools. This reinforces the Approval gate on the write tools (issue #13 already recommends loopback only).

**Useful probes for the MCP server's startup check:**
- `GET /healthz` returns `{ "status": "ok", "version": "<PACKAGE_VERSION>" }` (`server/app.ts`, `app.get('/healthz', ...)`). Compare it with the pinned Source Snapshot version, which is the "code and live system describe the same thing" check from CONTEXT.md. **(documented in code, not in the OpenAPI spec)**
- `GET /api/v1/auth/me` returns `type: "default"` in standalone (`openapi:/api/v1/auth/me` description).

## 3. Endpoint inventory for the session tools

All paths are under `http://localhost:8790`. Wire format is `snake_case` JSON; the SDK camelCases it (`docs:api/use-agent`). Source of the schemas: `openapi:components.schemas.*`.

| Need | Endpoint | Paging | Notes |
| - | - | - | - |
| List Sessions | `GET /api/v1/sessions` | `limit` 1-25 (default 25), keyset `page_token`, `order` by `updated_at` (default `desc`) | Filters: `start_timestamp`, `end_timestamp` (on `created_at`), `agent_id`, `created_by_me`, `metadata[key]=value`, `source_type=schedule`, `source_id` |
| Read a Session | `GET /api/v1/sessions/{session_id}` | - | `Session`: `id`, `agent`, `title`, `shared`, `metadata`, `source`, `created_at`, `updated_at`, `metrics` |
| Tag a Session | `PATCH /api/v1/sessions/{session_id}` | - | `title`, `metadata` (values max 128 chars), `shared`; empty body just bumps `updated_at` |
| List Turns | `GET /api/v1/sessions/{session_id}/turns` | `limit` 1-25, `page_token` | **Oldest first** in practice (section 9) |
| Read a Turn | `GET /api/v1/sessions/{session_id}/turns/{turn_id}` | - | `Turn`: `id`, `session_id`, `previous_turn_id`, `input[]`, `state`, `created_at` |
| Events of one Turn | `GET /api/v1/sessions/{session_id}/turns/{turn_id}/events` | `limit` 1-100 (default 100), `page_token`, `order` `asc` (default) or `desc` | Persisted events only, deltas excluded; offset-based token |
| Events across the branch | `GET /api/v1/sessions/{session_id}/events` | `limit` 1-100, `page_token`, `last_turn_id` | Newest first across the active branch, each item `{turn_id, event}` |
| Live stream | `GET /api/v1/sessions/{session_id}/turns/{turn_id}/subscribe` | `after_sequence_number`, or `Last-Event-ID` header | SSE, 412 if the buffer is gone; includes deltas |
| Create Turn (fork, re-run, normal) | `POST /api/v1/sessions/{session_id}/turns` | - | Body `{input[], previous_turn_id, stream}`; `stream: false` returns the running Turn immediately |
| Cancel | `POST /api/v1/sessions/{session_id}/cancel` | - | Empty body, empty `{}` response, idempotent |
| Create Session | `POST /api/v1/sessions` | - | `{agent: {name} \| {spec}, metadata?}`; 201 |
| Aggregate stats | `GET /api/internal/metrics/meters`, `/charts`, `/charts-data` | - | Needs `agent_id` and a window of at most 30 days; marked `x-excluded` (internal) in the spec |

Not useful for Cartographer: `POST .../turns/{turn_id}/events` is a stub in 0.179.2. The handler mints ids and returns 201 but the persistence call is commented out (`server/apis/turns.ts`, `createTurnEventHandler`). Do not rely on it.

### 3.1 Token and timing stats

There is no dedicated per-session stats endpoint. The numbers come from three places:

1. **Session level** (`openapi:SessionMetrics`): `total_cost_in_usd`, `total_duration_ms`, `total_turns`. Folded in when a turn reaches a terminal state (`core/agent-session/store/ISessionStore.ts`, `updateTurnTerminalState` comment). `total_turns` is bumped on every `createTurn`, so forks count (`server/db/sqlite/session-store/queries/turns.ts:375` area).
2. **Turn level** (`openapi:TurnMetrics`, on `state.metrics` of `done`, `cancelled` and `error` states): `total_input_tokens`, `total_output_tokens`, `total_cache_read_tokens`, `total_cache_write_tokens`, `total_reasoning_tokens`, `total_tokens`, `total_cost_in_usd`. `completed_at` on the terminal state plus `Turn.created_at` give the wall-clock duration. A running Turn has `state: {status: "running"}` and **no metrics**.
3. **Model-call level**: each persisted `model.message` carries `usage` (`openapi:ModelMessageUsage`): `input_tokens`, `output_tokens`, optional cache tokens, and `input_tokens_breakdown` split into `harness`, `skills`, `instructions`, `tool_definitions`, `messages`. That breakdown is the best per-call view of what fills the context, and it is how Cartographer can show compaction pressure. For a running Turn this is the only token data available.

**Timing is only timestamps.** Every event has `created_at`. Per-step latency is a difference of `created_at` values: an LLM call is roughly `model.message.created_at` minus the previous event's `created_at`; a tool call is `tool.response.created_at` minus its `model.message.created_at`. **(inferred)** Parallel tool calls from one assistant message cannot be separated, and the persisted `model.message` is written after the whole call completes (section 5). The UI's Sessions page shows the same data (`docs:sessions`: turns, duration, tokens, context, tool calls, sub-agents, errors); these totals are computed client-side from events and are not an API field. **(inferred)**

The per-thread context usage (`current_context_usage`) lives in the turn snapshot (`core/agent-session/store/ISessionStore.ts`) and is **not** exposed on any public route; `toWireTurn` drops the snapshot (`server/apis/turns.ts:74`).

### 3.2 Pagination and payload sizes

| List | Max page | Token kind | Caveat |
| - | - | - | - |
| Sessions | 25 | keyset (`SessionListPageToken`) | stable under new writes |
| Turns | 25 | offset (`OffsetPageToken`) | SQL is `ORDER BY created_at ASC ... OFFSET` (`server/db/sqlite/session-store/queries/turns.ts:767-788`) |
| Turn events | 100 | offset | insertion order; asc or desc |
| Session events | 100 | `{last_turn_id, offset}` (`SessionEventPageToken`) | newest first, so a **running** branch grows at the front and an offset cursor can repeat events. Re-anchor with `last_turn_id` or read per Turn instead |

**Payload sizes (bounds and estimates, not measured):**
- A `Turn` is small apart from `input` (user text; file parts are base64 and can be large) and `state.output` (the full final `model.message`).
- A turn events page is at most 100 events. A `model.message` carries `content`, `reasoning_content`, `tool_calls` with JSON-string arguments, `usage` and breakdown; **(inferred)** typically 1-10 KB, more with long reasoning. A `tool.response.content` is a string of whatever the model saw. Without a sandbox, results over the large-response threshold are cut to a preview (issue #2: `LargeToolResponse.ts`), so **(inferred)** about 6,000 tokens (roughly 24 KB) is the practical ceiling per tool response, but an MCP server may return up to `MCP_TOOL_CALL_MAX_RESPONSE_BYTES` (50 MB, `server/config.ts:735`) before that cut.
- Worst case for one events page is therefore a few hundred KB to low MB. The request body limit is 30 MB (`MAX_REQUEST_BODY_BYTES`, `server/config.ts:30`) and applies to what we *send*.
- The tool must not hand a raw page to the model. Return projections: event `type`, `id`, `created_at`, `thread_id`, tool name, argument and result sizes, and a capped excerpt (a `max_chars` input). That also keeps results below the 6,000-token offload threshold.
- **Measure real sizes in the first prototype** (see section 10).

## 4. Fork, re-run and cancel

### 4.1 Fork from a Turn

`POST /api/v1/sessions/{session_id}/turns` with `previous_turn_id: "<turn id>"`.
- `core/agent-session/SessionHandle.ts:175-178`: "`previous_turn_id`: omitted/`'auto'` -> session tip; `'none'` -> new root (no parent, even on a non-empty session); string -> fork from that turn (must exist)". A missing id gives 404 (`openapi` 404 "Session, prior turn, or referenced agent not found").
- The new Turn rebuilds its threads from the chosen Turn's snapshot (`SessionHandle.createTurn`: `buildThreads({previous, ...})`), so the model's context is the context **as it ended** at that Turn. Turns record `previous_turn_id` and `ancestor_ids`, so the Session is a tree.
- **The fork becomes the new session tip** (`server/db/sqlite/session-store/queries/turns.ts:372-380` sets `session.last_turn_id`). That changes which branch `GET /sessions/{id}/events`, `/cancel` and `previous_turn_id: "auto"` refer to.
- The fork reuses the previous Turn's `sandbox_info` (`SessionHandle.createTurn`: `existing: previous?.snapshot.sandbox_info`), so branches **share one mutable sandbox** if the Agent has one. **(inferred)**
- Forking from a Turn that is `paused` (pending approvals or answers) with a `user.message` fails with 422 ("turn input conflicts with current state, e.g. unresolved tool calls or approvals", `openapi` POST turns 422; validation in issue #2 section 5). Resolve the approvals instead, or fork from an earlier `done` Turn.
- Unverified: forking from a Turn in `error` state. Mark as an open question.

### 4.2 Re-run a Turn

There is no re-run endpoint. A re-run is a new Turn whose input is the old Turn's input:

```
src = GET .../turns/{turn_id}                       // src.input, src.previous_turn_id
POST .../turns { input: src.input,
                 previous_turn_id: src.previous_turn_id ?? "none",
                 stream: false }
```

- `Turn.input` is returned by get and list (`openapi:Turn`), so the original input is recoverable. For the first Turn of a Session, `previous_turn_id` is `null` on the wire, which maps to `"none"` on a new request.
- A **named** Session stores the agent name and resolves the *live* agent spec on every Turn (`openapi` "Create a session"; `SessionHandle.createTurn`: `agent.type === 'inline' ? agent.spec : resolveAgentSpec`). So a re-run after editing the Agent (or its model) runs the **new configuration** against the **old context**. That is exactly the Experiment shape in CONTEXT.md (change one thing, replay). For an inline Session the spec can be swapped with `PATCH` (`openapi` "Update a session"); named Sessions reject agent updates.
- A re-run cannot reproduce non-determinism: it is a fresh model call.

### 4.3 Cancel

`POST /api/v1/sessions/{session_id}/cancel`, empty body.
- Semantics (`server/apis/sessions.ts`, `cancelSessionHandler`): it reads `session.record.last_turn_id` and cancels **that** Turn if its state is `running`; no tip means 200 with nothing done. It always returns `200 {}`, also when nothing was running. There is **no per-Turn cancel**, and a running Turn on a non-tip branch (a fork was created after it) cannot be cancelled through the API. **(inferred from the handler)**
- Mechanism: `cancelSessionTurn` -> `ActiveTurnRegistry.cancelIfRunning` calls `AbortController.abort(...)` and returns at once (`server/runtime/activeTurns.ts`), so the HTTP call does not wait for the Turn to wind down. If the Turn is owned by another replica or is not found in this process, the store freezes it instead.
- Final state is `cancelled` with reason `client-cancelled` (`openapi:TurnStateCancelledReason`). The docs add: abort the in-flight model request, wait for running MCP calls to finish, force-stop the sandbox (`docs:api/use-agent`, "Cancel a turn").
- Status 412 means the session is unusable or the owning executor is unreachable (`openapi`).

## 5. Reading the in-flight Turn

**Yes, it works, and the docs are wrong about it.**
- `docs:api/use-agent` ("Replay a finished turn") says listing events is "Only available for completed turns; a running turn has no stored log yet".
- The source says otherwise. `TurnHandle.stream()` appends `turn.created` to the store before yielding it, and every later persisted event (`tool.response`, `thread.created`, `thread.done`, `mcp.auth_required`, and the `output` of each context append, which carries the `model.message`) goes through `store.appendToEvents` first (`core/agent-session/TurnHandle.ts:225-250`, `persistExecutionEvent` at 408-520). `appendToEvents` only fences on the Turn being `running` (`server/db/sqlite/session-store/queries/events.ts:26-60`). `listTurnEvents` only checks that the Turn exists (`events.ts:66-110`); there is no status filter. `openapi:/sessions/{id}/events` itself says "including persisted events from a running tip".
- Detail that refines "events are persisted before they're sent": for `model.message` the streamed copy is yielded first as a stream-only event and the durable copy is written when the step's context append lands (`TurnHandle.persistExecutionEvent`, `MODEL_MESSAGE` case versus `AGENT_CONTEXT_APPEND`). Both happen within one loop step, but the *currently generating* message and all deltas are not readable over REST.

What the caller sees when it reads its **own** running Turn from inside a tool call **(inferred)**:
- `turn.created`, all earlier steps, and the `model.message` that contains the very tool call being executed (it was persisted at the end of that LLM step).
- **No** `tool.response` for the call in progress (it is appended after the tool returns), no metrics (`state` is `running`), no `turn.done`.
- So a self-inspection tool sees "everything up to now", and totals must come from summing `usage` across `model.message` events, not from `state.metrics`.

For live text (deltas) only the SSE routes work. A tool should not hold an SSE connection: `subscribe` has a server-side timeout of `TURN_SUBSCRIBE_TIMEOUT_MS` (default 600,000 ms, `server/config.ts:782`) and MCP requests time out at 2 minutes (`MCP_REQUEST_TIMEOUT_MS`, `server/config.ts:891`). Poll `GET .../turns/{id}` and the events routes instead.

## 6. Deadlock and self-cancellation

### 6.1 No deadlock, if the tool does not wait for the child Turn

- The server is one Node process, async (Hono), with `better-sqlite3` in WAL mode and `busy_timeout = 5000` (`server/db/sqlite/client.ts:111-119`). A tool call that arrives over HTTP while the same process is mid-Turn is an ordinary concurrent request; write transactions are short `BEGIN IMMEDIATE` blocks.
- `stream: false` returns once the first event has been written (`startTurnInProcess`, `server/apis/turns.ts:520-537`: "resolve once the first event is dual-written so immediate subscribe cannot 412"), and execution continues in the background. The calling tool returns in milliseconds.
- `stream: true` ties the response to the child Turn. The call would only end when the child ends or when the 2-minute MCP request timeout fires. It does not deadlock, but it ties up the parent. **Never use it from a tool.**
- A run longer than the limits is cut: `SERVER_EXECUTION_TIMEOUT_SECONDS` (default 600) aborts any Turn with `server-execution-timeout` (`server/apis/turns.ts`, `beginTurnExecution`).

### 6.2 Self-cancellation paths

| Action from inside a tool | Effect on the caller's own Turn |
| - | - |
| `POST /sessions/{own}/cancel` | Aborts the tip Turn, which is the caller. The caller ends `cancelled`. The cancel call returns before that. |
| `POST /sessions/{own}/turns` with `previous_turn_id: "auto"` (the **default**) or the id of the running Turn | `SessionHandle.createTurn` first calls `freezeTurn({turn_id: previous, reason: CancelledForNextTurn})`. That writes a terminal `cancelled` state for the running Turn in the store (`SessionHandle.ts:196-201`). The running Turn notices on its next persist (`TurnNotRunningError`, `TurnHandle.ts:350-372`), stops, and emits `turn.done`. **The tool's own result is then lost** because the loop never gets to append the `tool.response`. **(inferred)** |
| `POST /sessions/{own}/turns` with `previous_turn_id` set to an **earlier terminal** Turn | `freezeTurn` on an already-terminal Turn returns it unchanged (`SessionHandle.freezeTurn` doc comment: "Already-terminal turns are returned unchanged"). The running Turn is **not** cancelled. The fork becomes the session tip and runs concurrently with the caller. |
| Any call targeting a **different** Session | Independent. Safe. |

Consequences for the tools:
1. **Always send an explicit `previous_turn_id`** (never rely on `auto`), and refuse a source Turn whose state is `running` for fork and re-run.
2. `cancel_session` must refuse the caller's own Session unless the user asked for exactly that. To do so the tool needs to know "its own Session" (6.3).
3. After a fork in the caller's own Session, the tip no longer points at the caller's Turn, so a later `cancel` or `auto` hits the fork, not the caller. Prefer forking into the **same** Session only for Experiments the user asked for; otherwise create a new Session and replay the input (4.2) so the live conversation keeps its tip.
4. There is no guard against two running Turns in one Session (a code comment says "Concurrent `'auto'` forks both succeed", `SessionHandle.ts:177-178`). The idea that only one Turn runs per Session at a time (stated in the agent-loop research, section 2) holds only because a normal next Turn (`auto`) cancels the previous one; it is not enforced otherwise.
5. **Runaway recursion**: a Cartographer Turn that re-runs a Cartographer Turn that re-runs ... is possible. Cap with the Approval gate, the agent's `iteration_limit`, and a depth marker in Session `metadata` (for example `metadata.experiment_depth`, readable through the `metadata[key]=value` filter).

### 6.3 The tool does not know which Session it is in

Local mode does not forward the Session or Turn id to MCP servers. `TurnMetadata` (`server/db/turnMetadata.ts`: `sessionId`, `turnId`, `agent`, raw inbound `requestHeaders`) is used only by the TrueFoundry-gateway stores (`server/truefoundry/*`); the local `mcpServerStore` and `McpServerWithAuthStore` take it but only the headers they build are sent (`server/db/McpServerWithAuthStore.ts:63-90`). `core/core/mcp/` has no `_meta` or session header injection. **(inferred from grep; confirm in the prototype by logging the headers of a tool call.)**

Workarounds, best first:
1. **Correlate by MCP transport session id.** The persisted `mcp.initialize` event lists `mcp_servers[].session_id`, "Optional MCP session id from the transport" (`openapi:MCPServerInitInfo`), and `RemoteMCP` re-uses it across Turns (`core/core/mcp/RemoteMCP.ts:289-340`). A stateful Streamable-HTTP MCP server sees the same id in the `Mcp-Session-Id` header. The tool can find the Session whose latest `mcp.initialize` event has that id. **(inferred; needs a prototype)**
2. **Heuristic**: the caller's Session is the one whose tip Turn is `running`, bound to the Cartographer Agent, with the latest `updated_at` (`GET /sessions?agent_id=...&order=desc`). Ambiguous when an Experiment is running in parallel.
3. **Explicit**: Cartographer's instructions require the user (or the UI) to state the Session id. The Session id is also visible in the UI (`docs:sessions`: "copyable session ID").

## 7. Proposed REST calls for the session tools

Names are placeholders for issue #8. "Gate" is the proposed approval class (read tools ungated, write tools gated; annotations as in issue #2 section 4: `readOnlyHint` for reads, `destructiveHint` or `@write` for the rest). All calls: `baseUrl = http://localhost:8790`, no auth header, `Content-Type: application/json` on bodies. Shapes are taken from the OpenAPI schemas and are **not captured responses**.

### 7.1 Read tools (ungated)

**`list_sessions({agent_name?, since?, until?, metadata?, limit?, cursor?})`**
`GET /api/v1/sessions?limit=25&order=desc&agent_id=<id>&start_timestamp=<iso>&end_timestamp=<iso>&metadata[experiment]=compaction&page_token=<cursor>`
`agent_id` is the immutable id, so resolve a name with `GET /api/v1/agents?agent_name=<name>` first and cache it.
```json
{ "data": [ { "id": "...", "title": "…|null",
              "agent": { "type": "reference", "name": "cartographer", "id": "..." },
              "created_at": "…", "updated_at": "…", "shared": false,
              "metadata": {}, "source": null,
              "metrics": { "total_cost_in_usd": 0.01, "total_duration_ms": 42000, "total_turns": 3 } } ],
  "pagination": { "limit": 25, "next_page_token": "…" } }
```
Tool output: one line per Session (id, title, agent, turns, cost, duration, updated) plus `next_cursor`.

**`get_session({session_id})`**
`GET /api/v1/sessions/{id}` then, to build the tree, `GET /api/v1/sessions/{id}/turns?limit=25` repeated through `next_page_token`. Output: Session fields + a Turn tree `{id, previous_turn_id, status, created_at, completed_at, tokens, cost, input_preview}`. The Session wire object has **no `last_turn_id`**; the tip is the Turn with no children created last, or `items[0].turn_id` of `GET /sessions/{id}/events?limit=1`.

**`get_turn({session_id, turn_id})`**
`GET /api/v1/sessions/{id}/turns/{turn_id}`
```json
{ "data": { "id": "...", "session_id": "...", "previous_turn_id": "…|null",
            "input": [ { "type": "user.message", "content": "…" } ],
            "created_at": "…",
            "state": { "status": "done", "completed_at": "…", "required_actions": [],
                       "output": { "type": "model.message", "content": "…" },
                       "metrics": { "total_input_tokens": 0, "total_output_tokens": 0, "total_reasoning_tokens": 0,
                                    "total_cache_read_tokens": 0, "total_cache_write_tokens": 0,
                                    "total_tokens": 0, "total_cost_in_usd": 0 } } } }
```
`state.status` is one of `running`, `paused` (with `action_required_on_events`), `done`, `cancelled` (with `reason`), `error` (with `message`).

**`list_events({session_id, turn_id?, types?, thread_id?, max_chars?, cursor?})`**
Per Turn: `GET /api/v1/sessions/{id}/turns/{turn_id}/events?limit=100&order=asc&page_token=…`. Whole branch, newest first: `GET /api/v1/sessions/{id}/events?limit=100[&last_turn_id=…][&page_token=…]` returning `{ "data": [ { "turn_id": "…", "event": { ... } } ], "pagination": … }`.
Event union (`openapi:SessionEvent`): `turn.created`, `turn.update`, `turn.done`, `model.message`, `tool.response`, `thread.created`, `thread.done`, `mcp.initialize`, `mcp.auth_required`, `sandbox.created`, `tool.approval_required`, `tool.response_required`, `user.tool_approval`, `user.tool_response`, `user.tool_approval_policy`, `user.mcp_auth_continue`. Filter and project on the MCP server side (type, thread, truncated content) so the model never gets raw pages. Mind that `tool_calls[].function.arguments` is a JSON string.

**`session_stats({session_id, turn_id?})`**
No single call. Compose: `Session.metrics` (session totals), `Turn.state.metrics` for terminal Turns, and for running Turns the sum of `model.message.usage` over the events plus `created_at` deltas for timing. Optional aggregate across Sessions: `GET /api/internal/metrics/meters?agent_id=<id>&start_timestamp=<iso>&end_timestamp=<iso>` (window at most 30 days; `openapi` marks it internal and excluded from the SDK groups, so treat it as unstable). Output: per-Turn table (status, duration, in/out/reasoning/cache tokens, cost, model calls, tool calls, subagent threads, errors) and, for context pressure, the latest `usage.input_tokens_breakdown`.

**`wait_turn({session_id, turn_id, timeout_s<=90})`**
Poll `GET .../turns/{turn_id}` every 1-2 s until `state.status` is not `running`; return the status or `still_running`. Keep under the 2-minute MCP request timeout; the model calls it again if needed.

### 7.2 Write tools (Approval-gated)

**`fork_turn({session_id, from_turn_id, message})`**
`POST /api/v1/sessions/{id}/turns`
```json
{ "input": [ { "type": "user.message", "content": "<message>" } ],
  "previous_turn_id": "<from_turn_id>", "stream": false }
```
Response `200 { "data": Turn }` with `state.status: "running"`. Pre-checks in the tool: `from_turn_id` exists, is not `running`, is not `paused`; the target is not the caller's own Session unless explicitly allowed. Errors: 404 unknown Session or Turn, 422 conflicting state, 412 unusable Session, 413 body over 30 MB.

**`rerun_turn({session_id, turn_id, new_session?})`**
Steps in 4.2. Default: same Session, `previous_turn_id = src.previous_turn_id ?? "none"`, `input = src.input`. With `new_session: true`: `POST /api/v1/sessions` `{ "agent": { "name": "<same name>" }, "metadata": { "rerun_of": "<turn_id>" } }` then `POST .../turns` with `previous_turn_id: "none"`; that replays only a first Turn, since no history is carried over. Returns the new `session_id`, `turn_id`.

**`cancel_session({session_id})`**
`POST /api/v1/sessions/{id}/cancel` with `{}`; response `200 {}`. Then read `GET .../turns/{tip}` to confirm `cancelled` (the abort is asynchronous). The tool refuses when `session_id` is the caller's own Session (6.2) and when the tip is not `running` (report "nothing to cancel").

**Optional, for Experiments:** `start_session({agent_name, metadata, message})` = `POST /api/v1/sessions` + first `POST .../turns` (`previous_turn_id: "none"`, `stream: false`). Tag Sessions with `metadata` (for example `{"experiment": "compaction", "depth": "1"}`) so `list_sessions` can filter them. Approvals on someone else's paused Turn use the same create-Turn call with `input: [{"type": "user.tool_approval", "thread_id", "tool_call_id", "approval": {"status": "allow"}}]` (a batch must resolve every pending approval and cannot be mixed with a user message, issue #2 section 5); leave this out of v1 unless Experiments need it.

Do **not** expose `DELETE /sessions/{id}`: it removes the Session, Turns, events and snapshots permanently (`openapi` "Delete a session").

### 7.3 Error handling

Errors are `{ "error": { "message", "code?", "param?", "type?" } }` (`openapi:RequestErrorResponse`). Map 404/403/412/422 to short tool errors that tell the model what to do next; do not retry 4xx.

## 8. SDK or raw REST

**Recommendation: use `@truefoundry/trueforge-sdk`, wrapped.** It matches the map's decision that glue scripts use the SDK; the same typed client serves the MCP server.

Facts (`@truefoundry/trueforge-sdk@0.179.0`, `package.json` and `dist/esm/**`):
- Zero runtime dependencies, Node >= 22, dual ESM and CJS builds with `.d.ts`/`.d.mts`, 15 MB unpacked. **(Bun compatibility is inferred from standard `fetch` use; verify with a smoke test.)**
- `new TrueForge({ baseUrl, maxRetries?, timeoutInSeconds?, fetch? })`; no token in standalone.
- `client.sessions.{list, create, get, update, delete, cancel, listEvents, listTurns, createTurn, createTurnStream, getTurn, listTurnEvents, subscribeToTurn, createTurnEvent, downloadSandboxFile}`. `list*` return a `Page` that auto-paginates when iterated. `createTurn` takes `{ input, previousTurnId, stream: false }` and `getTurn` returns the camelCased `Turn`. Metrics live under `client.internal.metrics`.
- Types for all events and states are exported, so the projections in 7.1 are fully typed with a discriminated union on `type`.

Caveats that justify the wrapper:
1. **Retries.** The default is `maxRetries = 2` for 408, 429 and any 5xx, **including POST** (`dist/esm/core/fetcher/requestWithRetries.mjs`). A retried `createTurn` can create a duplicate Turn. Construct a second client with `maxRetries: 0` for `createTurn`, `create` and `cancel`.
2. **Version lag.** The SDK is 0.179.0 and the server 0.179.2. Patch releases may add fields; compare against `GET /healthz` and fail soft on unknown fields.
3. **Paged iteration hides cost.** `for await (const e of client.sessions.listTurnEvents(...))` walks every page. Take pages explicitly with a cap.
4. **Pagination quirks** from section 3.2 (offset tokens, a newest-first listing on a running branch) are server behaviour either way.

Raw REST would add little: about eight calls, plain JSON, and types can be generated from `openapi.json` (for example with `openapi-typescript`). It is a reasonable fallback if the SDK misbehaves under Bun. The spec at `trueforge.dev` is not pinned, so generated types would carry the same version-lag risk.

## 9. Docs versus source discrepancies found here

| Topic | Docs / spec say | Source says | Use |
| - | - | - | - |
| Events of a running Turn | `docs:api/use-agent`: completed turns only, "a running turn has no stored log yet" | Events are inserted as they happen; list route has no status filter (`events.ts`); `openapi` session events: "including persisted events from a running tip" | Readable |
| Turn list order | `openapi` GET turns: "newest first by default" | `ORDER BY created_at ASC, turn_id ASC ... OFFSET` in both SQLite and Postgres queries; no order parameter exists (`queries/turns.ts:767-788`; Postgres query at `server/db/postgres/session-store/queries/turns.ts:732`) | Oldest first; page to the end to find the newest |
| Standalone credential | Ticket guess: fixed key such as `trueforge-standalone` | Key exists but guards only internal schedule and sandbox-build routes | No header |
| One Turn at a time | `docs:api/use-agent`: a new Turn cancels any running Turn in the session | Only the *previous* Turn is frozen; a fork from an older Turn runs concurrently | See 6.2 |
| `tool.call` event | `openapi` session events description lists `tool.call` | Not in the `SessionEvent` union and no such event is emitted | Ignore |
| `POST .../events` | Spec: creates events for a Turn | Handler is a stub; the insert is commented out | Do not use |

## 10. Open questions and proposed follow-ups

1. **Prototype (small, recommended before #8 closes).** Against a running 0.179.2: (a) confirm no auth header is needed; (b) log the headers of an MCP tool call to settle whether any session or turn id arrives, and check the `Mcp-Session-Id` to `mcp.initialize.session_id` correlation (6.3); (c) call `list_events` from inside a running Turn and record exactly which events are visible (5); (d) measure real payload sizes of Turns, event pages and `tool.response` content for a typical Cartographer Session (3.2); (e) try `cancel` on the own Session and a `previous_turn_id: "auto"` create-Turn to confirm the self-cancel behaviour and what the model sees afterwards (6.2). This is the "session-inspection" slice of issue #7/#9.
2. Forking from a Turn in `error` or `cancelled` state, and whether the shared sandbox between branches causes trouble. Unverified.
3. Does the Bun runtime run the SDK correctly, including `Page` iteration? Smoke test in the same prototype.
4. How should Experiments tag and find their Sessions: `metadata` keys, or a naming convention in `title`? Feeds the Experiment catalogue ticket.
5. Whether to expose `/api/internal/metrics/*` at all: it is marked internal and `x-excluded`, so it could change between patch releases.
6. Upstream asks (optional, add to the map's list): forward the Session and Turn id to MCP servers (header or `_meta`), a per-Turn cancel endpoint, a documented `GET /sessions/{id}` field for the tip Turn id, and an `order` parameter on the Turns list.

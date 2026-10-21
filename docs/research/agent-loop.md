# How TrueForge's agent loop works end to end

Research for forge-lab issue #2. Goal: outline `docs/harness-notes.md` against a custom (Python) harness, and know which knobs the Paper Scout agent can set.

**Sources and method.**
- Docs: https://trueforge.dev (pages cited as `docs:<path>`, fetched as `.md`) and the OpenAPI spec `https://trueforge.dev/openapi.json`.
- Source: https://github.com/truefoundry/trueforge, cloned at commit `0a42995` (2026-10-18). Paths below are relative to the repo root (`core/` = `packages/trueforge-core/src/core/`, `server/` = `packages/trueforge/src/`).
- Where docs and source disagree, this file says so and the source wins, because it is the thing that runs.
- Statements marked **(inferred)** are my reading of code, not something the docs state. Nothing here was run against a live server.

## 1. Architecture in one paragraph

TrueForge is a TypeScript monorepo (pnpm, Node 22+). The loop runs **on the server**, not in a sandbox (`docs:key-features/overview`, "Sandbox as a tool"). The sandbox is only a tool for code, files and shell.

| Layer | Package | Role |
| - | - | - |
| Loop | `packages/trueforge-core/src/core` | `AgentThread` (one thread's loop), `AgentThreadOrchestrator` (root + subagents), capabilities, MCP, LLM client |
| Sessions | `packages/trueforge-core/src/agent-session` | `SessionHandle`, `TurnHandle`, store interface (`ISessionStore`), `AgentSpec` schema |
| HTTP | `packages/trueforge/src` | Hono routes, SQLite/Postgres stores, SSE, cancel, schedules, auth |
| Clients | `trueforge-sdk` (generated), `trueforge-ui`, `assistant-ui-runtime` | SDK and React UI |

Local mode (`npx @truefoundry/trueforge`) is one process with SQLite and no login. Hosted mode adds Postgres and Redis (`docs:introduction`).

## 2. The hierarchy: Agent, Session, Turn, Event, Delta

(`docs:api/overview`)

- **Agent** is a definition (an `AgentSpec`), not a process. It is either saved under a unique, immutable name or passed **inline** when creating a session.
- **Session** holds the conversation. Only one turn runs per session at a time. A named session stores the agent name and **resolves the live agent on each turn**, so editing the saved agent changes later turns (OpenAPI "Create a session").
- **Turn** is one request/response cycle. Turns chain through `previous_turn_id` (default `"auto"`, meaning the latest turn). Creating a new turn automatically cancels one still running (`docs:api/use-agent`, "Turns").
- **Event** is one JSON object on the stream.
- **Delta** is a streaming fragment of a `model.message`. Deltas exist only on the live stream and are never persisted.

## 3. The loop itself

The core is `AgentThread.execute()` in `core/runtime/AgentThread.ts`. It is a plain ReAct-style state machine over the **message context**, not a planner.

State is derived from the context on every iteration (`deriveAgentThreadState`):

| State | Condition | Step |
| - | - | - |
| `llm-call-required` | no open tool calls | `stepLLMCall`: run preLLM processors, stream the model, append the assistant message |
| `tool-response-required` | last assistant message has tool calls without results | `stepToolResponse`: execute tools in parallel, post-process, append tool messages |
| `user-input-required` | some open call needs approval or a client-side answer | emit `tool.approval_required` / `tool.response_required`, then **exit** |

Allowed transitions are asserted (`VALID_TRANSITIONS`). Because the state is a pure function of the context, **a turn can stop anywhere and resume later just by reloading the context**. That is the foundation of approvals, cancellation and restarts.

**There is no explicit planning step.** The docs say the server "plans the turn" (`docs:introduction`), but in code the loop is model call, tools, model call, until the model answers with no tool calls. The only planning-like pieces are prompt guidance and the model's own reasoning. Plan and ask-user-secret capabilities are "gateway-side" extras that are not part of the open-source builtins (`agent-session/builtinsFromSpec.ts`).

Per iteration, in order:

1. **Cancel check**, then **iteration check**. If `iterations >= iterationLimit`, the loop emits an error event ("You have reached iteration limit of N, please request again") and stops. The counter increments on LLM calls only.
2. **preLLM processors** (capabilities). Compaction runs here. They may emit `agent.context.overwrite`, which replaces the persisted context.
3. **LLM call**, streamed through the Vercel AI SDK adapter (`core/llm/VercelAILLM.ts`). The loop first emits an empty `model.message` shell, then `model.message.delta` events, then the assembled `model.message`.
4. **No tool calls** means the thread is done. `finish_reason: length` is treated as an error.
5. **Tool calls**: `executeToolCalls` runs **all calls from one assistant message concurrently** (`Promise.all` in `core/mcp/executeToolCalls.ts`). Unknown tool names and thrown errors become an error tool result, so the model sees them and can recover. Each tool call gets a result message, always, because the provider API rejects dangling calls.
6. **toolResponse processors** rewrite results (large-response offloading), then **postToolCall processors** run.
7. `OpenToolCallCloser` (a fixed preSend processor) repairs dangling regular tool calls on the next send by appending a dummy "Tool call was not executed. Please retry" result (`core/runtime/OpenToolCallCloser.ts`).

Other loop facts:
- The system prompt is built as an XML tree (`core/InstructionBuilder.ts`): `<system-prompt>`, `<agent-identity>`, capability sections, and the user's `instructions` inside `<user-instructions>` as CDATA. The user's text is **appended after the harness text**, and only on the root thread.
- Anthropic **prompt caching defaults on**: `cache_control: {type: "ephemeral"}` unless the request body overrides it (`VercelAILLM.ts` ~L391). This is the main reason the docs' cost claims are plausible.
- Reasoning content is display-only. It is dropped from the stored context, and replay uses the provider `thinking_blocks` (`toContextAssistantMessage`).
- Wall-clock limits: a turn is aborted after `SERVER_EXECUTION_TIMEOUT_SECONDS` (default **600 s**, `server/config.ts`). MCP requests time out at 2 min, MCP connects at 30 s.
- Iteration limit: see the doc discrepancy in section 11.

## 4. Tool routing

Tools come from three groups (`AgentThread.initTools`): harness-managed ("system") tool sets, the sandbox and deferred-tool meta-tools, and the user's MCP servers. They are flattened into one OpenAI-style tool list and a `toolMapping`.

- **MCP transport**: remote MCP only, streamable-HTTP or SSE (`mcp.initialize` reports `transport_type`). The server needs a URL. No stdio, so the custom MCP server for Paper Scout must be HTTP-reachable (`docs:mcp-servers`).
- **Per-server selectors** (`core/mcp/ToolSelectorPolicy.ts`, `toolSelectors.ts`):
  - `enable_tools` default `["@all"]`; tags are `@all`, `@read-only`, or literal names.
  - `disable_tools` is subtracted from that.
  - `preload` default `false`, and `preload_tools` eagerly loads specific tools.
  - `require_approval_for_tools` default `["@write","@destructive"]`; `@all` and literal names are also allowed.
  - A disallowed tool throws a 403-style error if called. Literal `enable_tools` names missing on the server fail with 422.
- **Annotation dependence.** `@read-only`, `@write` and `@destructive` match the MCP tool annotations the server sets (`readOnlyHint`, `destructiveHint`). Unlabeled tools match neither `@write` nor `@destructive`, so they **run without approval** (`docs:create-agent/overview`, "Tool approval"). For the custom MCP server: set annotations, or list tool names explicitly in `require_approval_for_tools`.
- **Deferred loading** (default, `preload: false`): the model sees only each server's name and description (truncated to 200 chars) plus four meta-tools: `list_tools`, `get_tool_info`, `get_tool_output_schema`, `call_tool` (`core/runtime/DeferredTool.ts`, `docs:key-features/deferred-tool-loading`). The model must discover a tool before it can call it. This costs 2 extra round trips on the first use of each tool, and it means **the quality of a tool's description and schema matters**, because the model reads it on demand.
- **Result handling**: `structuredContent` is JSON-stringified, text parts are joined, and errors become `{"error": ...}`. The model sees strings only.

## 5. Approvals (human-in-the-loop)

Mechanism (`core/mcp/ToolSet.ts#callTool`):
1. `callTool` runs without a decision. If the tool's policy says approval is required, it returns an `approvalRequired` marker **instead of calling the server**.
2. The loop derives `user-input-required`, emits `tool.approval_required` with `{id, source_event_id}` refs, and the turn ends with `turn.done` status `done` and `required_actions: [...]`. A `done` turn with `required_actions` is paused, not finished.
3. The client sends a **new turn** whose input is `user.tool_approval` items: `{thread_id, tool_call_id, approval: {status:"allow"} | {status:"deny", reason?}}`.
4. Validation: the batch must resolve **every** pending approval at once, and user messages cannot be mixed with approval items (`validateInputMessageTypesGivenContext`). A user message cannot be sent while approvals are pending.
5. On resume the tool executes, or a deny becomes an error tool result `User denied tool call: <reason>`, and the loop continues.

Notes:
- Approval state lives in the **context** as `AgentApprovalDecisionMessage`s, so it survives restarts.
- Approvals also apply to subagent tool calls and to tool calls made from Code Mode scripts (`docs:key-features/code-mode`).
- **"Approve once" is on the roadmap** (`docs:roadmap`), but the API already has a `user.tool_approval_policy` input with `allow_session` (optional `expire_at`) per `(server_name, tool)` (`core/events/schema.ts`, OpenAPI `ToolApprovalPolicyAllowSession`). The docs do not describe it. **(inferred)** it is a working session-scoped "always allow".
- Client-side tools use the same pause pattern: `ask_user_question` emits `tool.response_required`, and the client answers with `user.tool_response`.
- MCP OAuth uses a third pause, `mcp.auth_required`. The turn ends and the next turn retries.

## 6. Context management

Four layers, all on by default (`docs:key-features/overview`):

| Layer | Trigger | What it does | Source |
| - | - | - | - |
| Deferred tools | always (unless `preload`) | Keeps tool schemas out of context | `DeferredTool.ts` |
| Large-response offload | single result over 6,000 tokens, or parallel results over 10,000 total (largest first) | Writes full output to a sandbox file and leaves a 100+100 char preview and the path | `LargeToolResponse.ts` |
| Subagents | model decides | Fresh context per subtask, only the final message returns | section 7 |
| Compaction | preLLM, when last-known prompt+completion tokens + ~931 reach the threshold | Replaces the **entire** context with one summary message plus a continuation note | `ContextCompaction.ts` |

Details worth knowing:
- **Compaction threshold**: explicit `trigger.value`, else 80% of the model's context length (capped by `context_length - max_tokens` when `max_tokens` is set), else 50,000 tokens. The usage figure comes from the previous response, so compaction fires one step late.
- **Compaction is a whole-history rewrite, not a sliding window.** The same model summarizes everything using a Claude-Code-style 8-section prompt (`<analysis>` then `<summary>`) and nothing is kept verbatim. Images become placeholders. The summary and a "do not repeat completed work" system note become the new context. The events stay in the database (`docs:key-features/overview`, Note), but **the model can no longer see them**.
- **Offload needs a sandbox.** Without one, an oversized MCP result is **truncated to the preview and the rest is lost** (see `blockResult` in `LargeToolResponse.ts`: the `mcp` category only dumps to a file `if (sandbox)`). Failures are cut to 500 chars. The docs say offload "requires the sandbox", but not that the fallback loses data.
- Thresholds (6,000, 10,000, 100) are configurable in `RuntimeConfigSchema`'s settings but only `enabled` is exposed in the agent spec's `large_tool_response` (the spec picks only `enabled`), so **effectively fixed per agent**. **(inferred)**

## 7. Subagents

Mechanism (`core/capabilities/builtins/DynamicSubAgents.ts`, `AgentThreadOrchestrator.ts`, `SessionHandle.makeCreateDynamicSubAgentThread`):

1. Subagents are just a **tool**: `create_sub_agent({name, input})`. Its handler returns a `createSubAgent` marker rather than a result.
2. `executeToolCalls` turns that into `AGENT_CREATE_SUBAGENT`. The orchestrator creates a child `AgentThread` and emits `thread.created` with `parent: {thread_id, tool_call_id}`.
3. The parent thread's step returns `exit` while children exist. The orchestrator runs only **leaf** threads. Children are scheduled in batches of `MAX_PARALLEL_SUB_AGENTS = 5` and the first 5 run concurrently.
4. A child finishing (its model answers without tool calls) yields `thread.done`. Its final message is injected into the parent as the **tool result** for the original `create_sub_agent` call, and the parent resumes.
5. A child that errors or hits `length` returns the error text as that tool result, so the parent can react.

What a subagent gets:
- **Context**: empty. Only the delegated `input` string as the first user message. It has **no access to the user's message or history**, so the parent must write a self-contained brief.
- **System prompt**: `SUB_AGENT_IDENTITY`. **Your agent `instructions` are not given to subagents** (`instruction: undefined`). Root-only sections are absent too. **Correction ([#27](https://github.com/ZeleMate/forge-lab/issues/27)):** the skills list is probably *not* absent. The child gets the parent's `sandbox`, and `Sandbox.buildInstruction` renders the `<skills>` section for every thread (installed 0.179.2: `agent-session/SessionHandle.mjs` `makeCreateDynamicSubAgentThread`, `core/sandbox/Sandbox.mjs:201-262`). **(inferred; Experiment 8 checks it)**
- **Tools and sandbox**: the same MCP tool sets as the parent (`toolSets` inherited) and the same sandbox with shared files.
- **Capabilities**: compaction, large-response offload and web search (when enabled). **No** ask-user, generative UI or further subagents (`isChild`), so one level deep.
- **Model**: same as the parent. A per-call model override exists in code (`ModelSetConfig`) but `builtinsFromSpec` never passes one, so it is not reachable from an agent spec. **(inferred)**
- **Output**: no `response_format`, so free-form text back to the parent.
- **Persistence**: the child is a thread inside the turn snapshot and is removed from the active thread set when it finishes.

Interaction with approvals: a subagent's gated call pauses the **whole turn** (`shouldStopExecution`), and the user's approval carries the child's `thread_id`.

## 8. Code Mode and the sandbox

- Sandbox is **off by default** and provisioned lazily (`sandbox.created` is emitted once per session, and the sandbox is reused across turns via the turn snapshot's `sandbox_info`).
- Needed for: skills, Code Mode, large-response offload, file download, and file uploads in user messages.
- Code Mode is not a separate tool. With a sandbox on, the model gets a sandbox exec tool, and scripts import `mcp_client.call_tool(server, tool, body=...)`. Calls are **bridged back to the harness**, which applies stored credentials, so secrets never enter the sandbox. The transport is NATS in the hosted path and a unix socket for the local provider (`core/sandbox/codeMode/*`, `server/sandbox/local/core/CodeModeUdsTransport.ts`).
- Script tool calls honor `require_approval_for_tools` (docs).
- **Docs vs source on providers.** Docs say Daytona is "the only sandbox provider supported today" and list a local sandbox as roadmap (`docs:sandbox`, `docs:roadmap`). The source contains a **local SRT provider** built on `@anthropic-ai/sandbox-runtime` (seatbelt on macOS, bubblewrap-style on Linux), probed at standalone boot and enabled as a fallback when no sandbox provider row exists (`server/sandbox/localRuntime.ts`, `server/apis/capabilities.ts`, `server/runtime/sessionResources.ts`). `GET /api/v1/capabilities` reports whether a sandbox is available. Whether this is stable enough to rely on for Paper Scout is **unverified** (see open questions).

## 9. Persistence and resumability

(`agent-session/*`, `server/apis/turns.ts`)

- **Everything is in the context snapshot.** Each `TurnRecord` carries a `snapshot`: per-thread `context[]`, token usage, `parent`, `agent_info`, `completion` and `capability_state`, plus `mcp_servers` and `sandbox_info`. The next turn loads the previous turn's snapshot (`previous_turn_id`) and rebuilds `AgentThread`s from it. There is no long-lived agent process.
- **Persist before yield** (`TurnHandle.stream()`): events and context are written to the store first, and only then yielded to the consumer. Deltas are the only unpersisted events. The result: if the client drops, the server keeps running and the DB is already correct.
- **Turn terminal states**: `done` (`output`, `required_actions`, `metrics`), `cancelled` (`client-cancelled`, `server-execution-timeout`, `cancelled-for-next-turn`, `abandoned`) and `error`. The first terminal write wins.
- **Branching.** `previous_turn_id` is a parameter and turns record `ancestor_ids`, so the data model is a tree and not a list. The session event listing reads "the active turn branch" (OpenAPI "List session events"). **(inferred)** you can fork from an earlier turn.
- **Capability state**: a per-thread KV for stateful capabilities (`tfy.`-prefixed keys reserved for builtins). A hook for custom capabilities, but the open-source server exposes no way to register your own.
- **Metrics per turn**: input/output/cache-read/cache-write/reasoning tokens and `total_cost_in_usd`. These show up in the Sessions UI (`docs:sessions`). Traces are produced via OpenTelemetry (`core/tracing`).
- **Seed messages** (`messages` in the spec) are added to the start of every session.

## 10. Streaming protocol (SSE)

Wire facts (OpenAPI `POST /api/v1/sessions/{id}/turns`, `GET .../subscribe`, `docs:api/use-agent`, `docs:ui-sdk/reference/events`):

- `POST .../turns` with `{input: [...], previous_turn_id?, stream?: true}` returns an SSE stream. `stream:false` returns the running turn at once and you poll `GET .../turns/{id}`.
- Each SSE message has `id` = **sequence number** (per turn, from `turnEventSsePayload` in `server/apis/turns.ts`) and `data` = the event JSON. Order is `turn.created`, content events, `turn.done`.
- **Resume**: `GET .../turns/{turn_id}/subscribe?after_sequence_number=N` (or `Last-Event-ID`) replays from the per-turn stream buffer. That buffer is held in Redis (hosted) or in memory (local) with a TTL of execution timeout + 300 s, and 300 s after completion. After that, rebuild from `GET .../events` (persisted, deltas pre-merged).
- **Disconnect behavior**: if the SSE client disconnects, the turn **keeps running** (server logs "continuing drain without writing"). A hung SSE write is timed out and the connection dropped, while execution continues.
- Cancel: `POST /api/v1/sessions/{id}/cancel` aborts the model request, waits for in-flight MCP calls, force-stops the sandbox, and emits a terminal `turn.done` (`docs:api/use-agent`, "Cancel a turn").

Event vocabulary:

| Event | `thread_id` | Meaning |
| - | - | - |
| `turn.created`, `turn.done` | null | Lifecycle brackets |
| `mcp.initialize` | thread | MCP server connected |
| `sandbox.created` | null | Sandbox provisioned (once per session) |
| `model.message` | `"main"` or subagent id | Shell first, then final assembled message with `tool_calls`, `usage`, `reasoning_content`, `finish_reason`, `model` |
| `model.message.delta` | same | Text, reasoning and partial tool-call arguments (accumulate by `index`). Same `id` as its message |
| `tool.response` | thread | Result for `tool_call_id` (always a string) |
| `tool.approval_required`, `tool.response_required` | thread | Pause refs `{id, source_event_id}` |
| `mcp.auth_required` | null | OAuth needed (`auth_url`) |
| `thread.created`, `thread.done` | subagent id | Subagent lifecycle, `parent: {thread_id, tool_call_id}` |
| `agent.context.overwrite` (reason `compaction`) | thread | Context replaced. Check whether it reaches clients **(inferred: persisted, not streamed)** |

Quirks for client authors (the Paper Scout React app):
- **Casing**: HTTP/Python use `snake_case`. The TS SDK and UI SDK camelCase them (`turnId`, `threadId`, `sourceEventId`) (`docs:api/use-agent` Note).
- **Two envelopes**: streaming yields `{sequenceNumber, event}`, whereas `listEvents` returns `{turnId, event}` (`docs:ui-sdk/reference/events`).
- `tool_calls[].function.arguments` is a JSON **string**, not an object.
- `tool.response.content` is always a string.
- Reassemble by `id` and group by `thread_id` to render subagents in parallel.
- Deltas for tool calls are keyed by `index`, with `id` and name first and arguments in fragments.

## 11. Doc vs source discrepancies

| Topic | Docs say | Source says | Use |
| - | - | - | - |
| Iteration limit default | 100 in "What's in an agent", 512 in the spec table | `DEFAULT_AGENT_CONFIG_ITERATION_LIMIT = 512` in `agentSpec.ts`. `DEFAULT_ITERATION_LIMIT = 25` is only the fallback when the definition has no limit | **512**, set it explicitly |
| Local sandbox | Roadmap. Daytona only | Local SRT provider exists in standalone | Verify empirically |
| "Plans the turn" | Marketing wording | No planner. Plain ReAct loop | Treat as ReAct |
| Approve-once | Roadmap | `allow_session` policy in the API | Verify empirically |
| Subagent count | "run concurrently" | Batches of 5 | Keep fan-out at 5 or fewer |
| Large-response thresholds | Described as configurable | Only `enabled` is in the spec | Fixed per agent |

## 12. Knobs Paper Scout can set (`AgentSpec`)

From `agent-session/schemas/agentSpec.ts` and `docs:create-agent/overview`.

| Field | Default | Use for Paper Scout |
| - | - | - |
| `model.name`, `model.params` (`max_tokens`, `temperature`, `top_p`, `top_k`, `parallel_tool_calls`, `reasoning_effort`, extras passed through) | none | API only. Set `max_tokens` consciously (it also lowers the compaction threshold) |
| `instructions` | none | Role only. Long procedures belong in skills. **Not seen by subagents** |
| `messages` | none | Seed user messages for every new session |
| `mcp_servers[].name` | required | Refers to a server registered in Settings, not inline |
| `.enable_tools` / `.disable_tools` | `["@all"]` / `[]` | Expose only what the agent needs |
| `.require_approval_for_tools` | `["@write","@destructive"]` | E.g. gate `add_to_reading_list` by name. Needs annotations on the custom MCP tools |
| `.preload` / `.preload_tools` | `false` / `[]` | Preload the few hot tools (search, add) of the small custom server |
| `skills[]` (`name`, `preload`) | none | Max 50. Needs sandbox |
| `response_format` | text | `json_object` or `json_schema` for structured final output |
| `config.iteration_limit` | 512 (1 to 1024) | Lower it (for example 30 to 50) as a cost guard |
| `config.sandbox.enabled`, `file_downloads`, `environment_name` | false, true, none | Needed for code mode, skills and offload |
| `config.dynamic_sub_agents.enabled` | true | Needed to exercise subagents |
| `config.ask_user_questions.enabled` | true | Clarifying questions via `tool.response_required` |
| `config.generative_ui.enabled` | true | Renders charts and tables via OpenUI. Consider off for a custom UI **(inferred)** |
| `config.web_search.enabled` | false | Needs a web-search provider in settings |
| `config.context_management.compaction` (`enabled`, `trigger.value`) | true, 80% context | Set a low trigger when demonstrating compaction |
| `config.context_management.large_tool_response.enabled` | true | Only effective with sandbox |

Per-request controls: `previous_turn_id`, `stream`, and input item types `user.message` (text, file parts as base64 data URIs), `user.tool_approval`, `user.tool_response`, `user.tool_approval_policy`.

Not settable from an agent spec: the subagent model override, the cap of 5 concurrent subagents, offload thresholds, custom capabilities, the system prompt's harness part.

## 13. Comparison with a custom Python harness (for `harness-notes.md`)

| Axis | TrueForge | What to ask about your own harness |
| - | - | - |
| Loop | ReAct state machine derived from the context (`llm-call` / `tool-response` / `user-input`), with parallel tool calls | Is the state explicit or implicit in a Python call stack? Can it resume mid-step? |
| State location | Entirely in persisted message context + snapshot. No live process | In-memory objects, checkpoints, or events? |
| Planning | None. Prompt only | Do you have a plan or todo tool? |
| Tool discovery | Deferred by default through 4 meta-tools | Do you load all schemas up front? |
| Approvals | Policy on the tool, evaluated in the tool layer, pause by ending the turn, resume by a new turn carrying decisions | Callback/interrupt in-process vs stateless resume |
| Compaction | One whole-context LLM summary at a token threshold. Events are kept in the DB | Sliding window, partial summaries, memory files? |
| Big results | Offload to sandbox file + preview (or truncate when no sandbox) | Truncate, paginate, or store a reference? |
| Subagents | A tool that creates threads in the same turn. Clean context, shared tools and sandbox, depth 1, 5 parallel | Separate processes, shared state, depth? |
| Code execution | Sandbox as tool. Credentials stay in the harness through a bridge (NATS/UDS) | Agent-inside-sandbox, or exec tool? Where do secrets live? |
| Streaming | SSE with per-turn sequence numbers, a persisted event log, a replay buffer, and runs continue after disconnect | Websocket/SSE? Resume semantics? |
| Persistence | Persist-before-yield to SQLite/Postgres. Branching by `previous_turn_id` | Checkpointer granularity? |
| Cancel/limits | AbortSignal, 600 s wall clock, iteration cap, "new turn cancels running" | Equivalent budgets? |
| Cost levers | Prompt caching default, deferred tools, offload, compaction (benchmark: ~30% cheaper than Claude Managed Agents on the same model, vendor-run, n=3, 14 tasks, `docs:benchmarking`) | What do you measure? |

## 14. Open questions

1. Does the local SRT sandbox actually work with `npx @truefoundry/trueforge` on this Mac, and is it enough for Code Mode and skills? If not, Paper Scout needs a Daytona key. (Candidate ticket: sandbox and code mode research or prototype.)
2. Does `user.tool_approval_policy` / `allow_session` work end to end, and does the UI expose it?
3. Does the `agent.context.overwrite` event reach SSE clients, and what does the UI show after compaction?
4. How do the Anthropic prompt-cache breakpoints interact with deferred tools and compaction? Unverified, no cache hit metrics were inspected.
5. Does a named session picking up an edited agent mid-conversation behave well with an already-loaded snapshot (changed tools, changed instructions)?
6. What is the real behavior when 6 or more subagents are requested in one assistant message?
7. Do custom MCP tool annotations (`readOnlyHint`, `destructiveHint`) survive the pipeline (`ToolAnnotations` in `ToolSelectorPolicy`)? Needed for the approval design of the Reading List tools.

# turn-anatomy: expected

Experiment 1 of the catalogue ([What should the TrueForge deep-dive notes cover?](https://github.com/ZeleMate/forge-lab/issues/12)). Topics: the Turn loop, and the streaming event protocol.

Written on 2026-11-28, before the first run. Citations are `path:line@sha7` in the Source Snapshot (TrueForge 0.184.2, `235518c`). The `packages/` prefix is left out.

## Setup

- A fresh inline Experiment Session on a copy of the registered Cartographer (`metadata.experiment = turn-anatomy`). On `glm-5-3-flash` the copy drops `reasoning_effort`, as every mechanics script does.
- One user message, sent with `stream: true`: *"Use source_status to get the Source Snapshot's version, then search_text for VALID_TRANSITIONS, and tell me in two sentences which file defines it."* Both tools are preloaded and ungated, so the Turn shouldn't pause. Two calls are under the instructions' code-mode threshold of 3, so they should be direct calls.
- The script records every SSE message as it arrives (sequence number, arrival time, event), then reads the Turn and its persisted events back over REST.
- On `opus-5-5` only, two control Sessions get the same no-tools puzzle, one at `reasoning_effort: low` and one at `high`. That is the test for E8.

Run it with `--model glm-5-3-flash` (mechanics) and `--model opus-5-5` (E7 to E9 are about Opus).

## Expectations

- **E1** The persisted events run `turn.created`, then `mcp.initialize`, then one or more rounds of a `model.message` with `tool_calls` followed by one `tool.response` per call id, then a final `model.message` with `finish_reason: stop` and no tool calls, then `turn.done`. The loop has no planning step: it's model call, tools, model call (`docs/research/agent-loop.md` §3).
- **E2** There's exactly one `mcp.initialize`, before the first `model.message`, and it lists only `source`. `sessions` and `triage` are fully deferred, so nothing needs them yet. This was seen in the fixtures recording, not read in the source.
- **E3** The SSE `id`s are 1, 2, 3, …, N with no gaps or repeats. The in-memory stream numbers each event `events.length + 1` (`trueforge/src/runtime/event-subscription/inMemory.ts:42@235518c`), and the SSE `id` is that number (`trueforge/src/apis/turns.ts:387@235518c`).
- **E4** `model.message.delta` events appear on the stream but never in the persisted list. Deltas are stream-only (`trueforge-core/src/agent-session/TurnHandle.ts:457-460@235518c`).
- **E5** Every persisted event, matched by `id`, also arrived on the stream, in the same relative order. TrueForge persists each event before it yields it (`agent-loop.md` §9).
- **E6** On the stream, each model call shows two `model.message` events with the same `id`: an empty shell before its deltas (`trueforge-core/src/core/runtime/AgentThread.ts:1165-1172@235518c`) and the assembled message after them. The persisted list has one `model.message` per call, rebuilt from context to match "a folded stream" (`AgentThread.ts:272-286@235518c`).
- **E7** The first model call's `usage.input_tokens` (from [What goes into Cartographer's instructions, model params and skills?](https://github.com/ZeleMate/forge-lab/issues/27)). That ticket estimated about 3.4k tokens of system prompt plus about 1k of tool definitions. The breakdown is TrueForge's own estimate, independent of the model (`AgentThread.ts:935-957@235518c`). So `instructions` should be the same on both models, between 1,300 and 1,450, and `messages` (the remainder) absorbs any tokenizer difference. GLM's total should be between 4,500 and 5,800 (5,087 in the fixtures recording). Opus's should be between 4,500 and 7,500, and higher than GLM's.
- **E8** `reasoning_effort` reaches Opus 5.5 through OpenRouter. It travels as the AI SDK's `reasoning` setting (`trueforge-core/src/core/llm/VercelAILLM.ts:321-334@235518c`), which the OpenAI-compatible adapter sends as `reasoning_effort` (inferred). Expected: the main Turn at `medium` has `total_reasoning_tokens > 0`, and the `high` control uses more reasoning tokens than the `low` one. Opus only.
- **E9** Opus 5.5's progress updates (thinking on the API) are visible. Expected: `model.message.delta` events with a non-empty `reasoning_content` on the stream (`AgentThread.ts:410-437@235518c`, `VercelAILLM.ts:1290-1310@235518c`), and a `reasoning_content` on the persisted `model.message`. Opus only. The UI isn't checked by the script. If the Turns look silent, #27 says to add a "say what you'll look at first" sentence to the instructions.
- **E10** The Turn ends `done` with no Approval pause and no `required_actions`, in under 120 s.

## Approvals

None. Both tools are ungated, so any pause stops the run as a finding.

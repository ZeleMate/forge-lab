# Cheap open-weight OpenRouter models for TrueForge's agent loop

Research for forge-lab issue #14 (blocks #9). Question: which small, cheap open-weight models on OpenRouter can drive the Paper Scout through TrueForge's custom OpenAI-compatible provider, and which should be default and fallback?

**Sources and method.** All data was fetched on 2026-10-18. Nothing was run against a live OpenRouter or TrueForge instance, and no key was created.
- OpenRouter models API: `https://openrouter.ai/api/v1/models` and `/models/{id}/endpoints` (pricing, context, `supported_parameters`, per-endpoint quantization/uptime, and the `benchmarks.artificial_analysis` block that OpenRouter attaches to models). Cited as `or:models`.
- OpenRouter docs (cited as `or-docs:<page>`): tool-calling, provider-selection, zdr, prompt-caching, reasoning-tokens, api-reference/overview, management-api-keys, guardrails, privacy/logging.
- Model cards on Hugging Face (`zai-org/GLM-5.3-Flash`, `deepseek-ai/DeepSeek-V4-Flash`).
- TrueForge source, cloned at commit `0a42995` (same commit as the agent-loop research). Paths: `core/` = `packages/trueforge-core/src/core/`, `server/` = `packages/trueforge/src/`. Cited as `tf:<path>`.
- Statements marked **(inferred)** are my reading of code or docs, not something verified end to end.
- Prices are USD per million tokens. The models API shows the cheapest endpoint, which is often a heavily quantized (fp4) one. A realistic mid-market figure is given where it differs.

## 1. Answer in brief

- **Default: `z-ai/glm-5.3-flash`.** MIT licence, 320B total / 18B active, 1M context, tools + `tool_choice` + `parallel_tool_calls` + structured outputs. It has the highest agentic score of any cheap open-weight model on OpenRouter (Artificial Analysis agentic index 50.9, versus 26.3 for DeepSeek V4 Flash). Price: from $0.048 in / $0.20 out (fp4), typically $0.15 in / $0.50 out.
- **Fallback: `deepseek/deepseek-v4-flash-0731`** (agentic index 41.0, 1M context, MIT, about $0.06-0.14 in / $0.18-0.28 out on mainstream providers). A different model lineage and different providers from GLM, so an outage or a template bug in one family does not take down both. Use the older `deepseek/deepseek-v4-flash` (agentic 26.3) only if the 0731 snapshot misbehaves.
- **Ceiling model for hard runs:** `z-ai/glm-5.3` (agentic 53.1, $0.08-1.40 in / $2.50-4.40 out depending on provider).
- **Subagent model: no separate one.** TrueForge cannot route subagents to another model (section 4), so subagents run on the same model. That is a reason to pick a model that is cheap enough for everything.
- **Avoid for this loop:** `openai/gpt-oss-120b`/`-20b` (very cheap, but agentic index 3.7, and the Paper Scout's deferred-tool flow is multi-step), Llama 4 (agentic 0.6), small Gemma/Mistral/Nemotron (agentic 0.8 to 3.5). These numbers are a third-party benchmark, not a TrueForge test (see open questions).
- **Compatibility:** TrueForge's `custom` provider works with OpenRouter in principle. Three things to configure or know: set `context_length` and `max_output_tokens` on every model (otherwise compaction falls back to 50k tokens), the OpenRouter routing object (`provider: {...}`) cannot be sent from TrueForge so privacy and routing must be set on the OpenRouter account, and the URL guard does not block `openrouter.ai` by default.

## 2. Shortlist

Agentic = Artificial Analysis agentic index as served in `or:models` `benchmarks.artificial_analysis` (higher is better; third-party, not TrueForge-specific). "T / TC / PTC / SO / R" = `tools` / `tool_choice` / `parallel_tool_calls` / `structured_outputs` / `reasoning` in the model's `supported_parameters`. Note that `parallel_tool_calls` is advertised on the model-level union, but on the endpoints I inspected only one or two providers list it (section 3); the others ignore the parameter, which is harmless.

| Model id | $/M in | $/M out | Context | T / TC / PTC / SO / R | Agentic | Notes |
| - | - | - | - | - | - | - |
| `z-ai/glm-5.3-flash` | 0.048 (typ. 0.15) | 0.20 (typ. 0.50) | 1,048,576 | yes / yes / yes / yes / yes | 50.9 | **Default.** MIT, 320B/18B active, hybrid sparse+linear attention; reasoning is mandatory and defaults to effort `max` (efforts `max`/`high`/`low`). Card reports Terminal-Bench 2.1 84.3 and DeepSWE 63.4; it does not mention tool-call parsers or tau-bench/BFCL. Implicit caching on all endpoints. ~35 endpoints, 32 ZDR-listed. |
| `z-ai/glm-5.3` | 0.079 (typ. 0.5-1.4) | 2.5 (typ. 2.2-4.4) | 1,048,576 | yes / yes / yes / yes / yes | 53.1 | Bigger sibling; the price spread across providers is wide, so pin providers. Use only if Flash fails on Paper Scout tasks. |
| `deepseek/deepseek-v4-flash-0731` | 0.005 promo; 0.06 DeepInfra, 0.13-0.14 typical | 0.14 to 0.28 typical | 1,048,576 | yes / yes / yes / yes / yes | 41.0 | **Fallback.** Newer snapshot of V4 Flash. Only 2 of 27 endpoints list `parallel_tool_calls`. 21 ZDR-listed. The very low input prices come from Relace and OpenInference (fp4); do not pin to them blindly. |
| `deepseek/deepseek-v4-flash` | 0.091 | 0.182 | 1,048,576 | yes / yes / no / yes / yes | 26.3 | MIT, 284B/13B active. Card: SWE-bench Verified 79.0, MCPAtlas 69.0, Toolathlon 47.8 (Flash-Max). The card says it is slightly behind Pro on "the most complex agentic workflows", gives no tool-call template (uses a Python `encoding` folder) and nothing on reasoning handling across tool loops. |
| `qwen/qwen3.8-27b` | 0.24 (0.02-0.45) | 2.2 (0.5-3.0) | 262,144 (some 1M) | yes / yes / no / yes / yes | 45.8 | Dense 27B, good agentic score for its size but output price is 10x GLM Flash. Alternative if both GLM and DeepSeek fail. Wide price spread. |
| `z-ai/glm-5.2` | 0.62 | 2.42 | 1,048,576 | yes / yes / yes / yes / yes | 38.4 | Superseded by 5.3 on both price and score. Skip. |
| `minimax/minimax-m3` | 0.30 | 1.20 | 1,048,576 | yes / yes / no / yes / yes | 29.5 | Mid-pack; no reason to prefer over GLM/DeepSeek. |
| `moonshotai/kimi-k2.6` | 0.65 | 3.41 | 262,144 | yes / yes / yes / yes / yes | 20.5 | Kimi is the family with a first-class TrueForge preset (`moonshot`), but via OpenRouter it is 4x pricier and scores lower. Skip. |
| `openai/gpt-oss-120b` | 0.03-0.15 | 0.15-0.60 | 131,072 | yes / yes / yes / yes / yes | 3.7 | Cheapest viable by far, but poor on the agentic index. Not for the main loop; possible for a trivial, single-step helper if subagent routing is ever reachable. |
| `openai/gpt-oss-20b` | 0.018 | 0.09 | 131,072 | yes / yes / yes / yes / yes | n/a | Same caveat, smaller. |
| `meta-llama/llama-4-maverick` | 0.19 | 0.65 | 1,048,576 | yes / yes / yes / yes / n/a | 0.6 | Tool-capable on paper, very weak on agentic index. |
| `nvidia/nemotron-3-super-120b-a12b`, `google/gemma-4-26b-a4b-it`, `mistralai/mistral-small-2603` | 0.07-0.15 | 0.2-0.6 | 262k | yes / yes / no / yes / yes | 1.7 / 2.9 / 0.8 | Cheap, but agentic scores near zero. |

Notes:
- Models whose id ends `:free` exist for several of these. Do not use them for the Paper Scout; free endpoints are rate-limited and have separate, looser privacy settings (`or-docs:privacy/logging`, "separate account settings for paid and free models").
- `qwen/qwen3.7-flash` and `qwen/qwen3.7-plus` have no Hugging Face id in `or:models`, which I take to mean closed weights, so they are excluded. `qwen/qwen3.8-flash` does list a Hugging Face id (`Qwen/Qwen3.8-Flash-Next`) at $0.15/$0.47 and 1M context, but it has no `parallel_tool_calls` and I did not find an agentic score; it is an unevaluated candidate for the smoke test.
- The `~...-latest` aliases (for example `~deepseek/deepseek-v4-flash-latest`) float to new snapshots. Pin a dated id for reproducibility.
- Prices and scores move quickly. Re-pull before building anything cost-critical.

### What the benchmark numbers do and do not say

The agentic index is a general tool-use benchmark, not TrueForge's workload. The Paper Scout needs: discovering a tool through `list_tools`/`get_tool_info` then `call_tool` (two extra round trips per tool, `agent-loop.md` section 4), emitting valid JSON arguments inside `call_tool`, parallel calls, `create_sub_agent` with a self-contained brief, and surviving a whole-history compaction summary. I found no public benchmark on that exact pattern. The shortlist order is a prior, not a result; a smoke test (open question 1) should confirm it.

## 3. How well TrueForge's custom provider works with OpenRouter

### Client and request path

- A provider of type `custom` is built with `createOpenAICompatible` from `@ai-sdk/openai-compatible`, with `includeUsage: true` and `supportsStructuredOutputs: true` (`tf:core/llm/VercelAILLM.ts` `compatibleModel`, L130-146). Fireworks, Together and Z AI use the same adapter, so `custom` is a well-trodden path.
- All model HTTP goes through `modelSsrfFetch` (the outbound URL guard, section 6), with 2 min headers and body timeouts, 5 s connect timeout and 2 retries by default (`tf:core/util/outboundFetch.ts`). The Vercel `streamText` call itself uses `maxRetries: 0`.
- The `custom` provider manifest has `type`, `name`, `base_url`, an optional `auth.api_key` and a `models[]` list (`tf:server/schemas/modelProvider.ts`; docs: `trueforge.dev/models.md`). Each model has `model_id` (the OpenRouter slug, for example `z-ai/glm-5.3-flash`), `name`, and `properties.context_length`, `max_output_tokens`, `reasoning_efforts`. The schema is `.strict()`: **there is no field for custom headers**. The `headers` argument in the code is only filled from `store.resolveInvokeHeaders` (`tf:server/runtime/sessionResources.ts` L106). **(inferred)** that only TrueFoundry-gateway mode uses it. Consequence: `HTTP-Referer` and `X-OpenRouter-Title` cannot be set. Both are optional app-attribution headers (`or-docs:api-reference/overview`), so nothing breaks.

### Streaming tool-call deltas

- OpenRouter normalizes streaming to the OpenAI shape: tool calls arrive as `delta.tool_calls` chunks, `finish_reason` is normalized to `tool_calls`/`stop`/`length`/`content_filter`/`error`, and usage arrives once in a final chunk before `[DONE]` (`or-docs:api-reference/overview`, `or-docs:tool-calling`).
- TrueForge consumes the AI SDK's `tool-input-start` / `tool-input-delta` / `tool-input-end` parts and re-emits OpenAI-style deltas keyed by `index` (`tf:core/llm/VercelAILLM.ts` L1226-1324). That is the standard path the SDK exercises against OpenRouter, so I expect deltas, including parallel calls, to work. **(inferred; not run.)**
- OpenRouter says streams may carry SSE comment payloads (keep-alives) that clients must ignore (`or-docs:api-reference/overview`); the SDK's eventsource parser does so. **(inferred)**
- OpenRouter's final usage chunk has a non-empty `choices` array with an empty delta, which differs from the OpenAI spec. **(inferred)** harmless for the SDK, which reads usage from the chunk's `usage` field.
- Mid-stream provider errors arrive as an `error` object on a choice with `finish_reason: error` (docs). I did not check how TrueForge surfaces that; it should end the turn with an error event.
- OpenRouter docs require `tools` to be re-sent on every request, including the one carrying tool results, so the router can validate the schema (`or-docs:tool-calling`). TrueForge sends its tool list on every `streamText` call, so this holds.

### `tool_choice`, `parallel_tool_calls`

- TrueForge never sets `tool_choice` (no match in `tf:core`), so the default `auto` applies. All shortlisted models list `tool_choice` support.
- `parallel_tool_calls` from `model.params` is forwarded as a top-level body field (whitelisted in `COMPATIBLE_BODY_FIELDS`, `tf:core/llm/VercelAILLM.ts` L487-496). OpenRouter defaults to true for most models (`or-docs:tool-calling`) and silently ignores parameters a provider does not support unless `require_parameters` is set (`or-docs:provider-selection`). On the endpoint lists I pulled, `parallel_tool_calls` is advertised by only 2 of 27 endpoints for DeepSeek V4 Flash 0731 and 2 of ~35 for GLM-5.3-Flash. So the flag is mostly a no-op: whether parallel calls happen is up to the model and its chat template, and the loop already handles whatever comes back (`Promise.all` over the calls in one assistant message). Do not set `parallel_tool_calls: false` for cost reasons; it would only serialize the Paper Scout's fan-out.
- Tools are a "soft preference" in routing: if some providers support `tools`, OpenRouter routes only to those; if none do it still sends the request (`or-docs:provider-selection`). Every shortlisted model lists tools, so this is moot, but it means a provider that mangles tools can still be picked unless it is excluded on the account (section 5).

### Reasoning

- Stream side: the SDK's openai-compatible adapter reads `reasoning_content` or `reasoning` from both streamed deltas and full messages (`vercel/ai` `openai-compatible-chat-language-model.ts`: `delta.reasoning_content ?? delta.reasoning`). OpenRouter returns plaintext reasoning in `reasoning` and documents `reasoning_content` as an alias (`or-docs:reasoning-tokens`). TrueForge turns the SDK's `reasoning-delta` into `reasoning_content` on `model.message.delta` (display only, dropped from the stored context; `agent-loop.md` section 3). So reasoning text should display in the UI. **(inferred)**
- Request side: `reasoning_effort` in `model.params` becomes the SDK's top-level `reasoning` setting, which the adapter sends as `reasoning_effort` (`tf:core/llm/VercelAILLM.ts` L218-283, `toReasoningLevel`; `max` is forced through `maxEffortOption`). OpenRouter's documented control is the nested `reasoning: {effort}` object and its docs do not mention a top-level `reasoning_effort`; but the models API lists `reasoning_effort` in `supported_parameters` for the shortlist (`or:models`). **(inferred)** it works; verify it changes token usage. TrueForge cannot send the nested `reasoning` object (not whitelisted), and cannot send `reasoning: {exclude: true}`.
- **GLM-5.3-Flash reasoning is mandatory and defaults to `max`** (`or:models` `reasoning.mandatory = true`, `default_effort = max`). Left unset, every call spends a large thinking budget. Set `reasoning_effort` to `low` or `high` in the agent's `model.params`, and keep `max_tokens` large enough: reasoning counts against `max_tokens` and a small limit gives `finish_reason: length` with empty content (`or-docs:reasoning-tokens`), which TrueForge treats as an error (`agent-loop.md` section 3).
- Replay between turns: OpenRouter says that for models with `reasoning_details` you should pass them back unmodified in tool-calling follow-ups, and that raw-string reasoning may be passed as `reasoning` (`or-docs:reasoning-tokens`). TrueForge keeps reasoning only as display text; for `custom` it rebuilds assistant messages with reasoning text as a `reasoning` part and no provider token (`tf:core/llm/VercelAILLM.ts` `toAssistantModelMessage`, the comment says custom has "nowhere to go" for a signature), and the adapter writes it back as `reasoning_content` on the assistant message (`convert-to-openai-compatible-chat-messages.ts`). Whether GLM or DeepSeek on OpenRouter accept `reasoning_content` on input, and whether dropping `reasoning_details` degrades multi-step tool use, is **unverified**. It is the single most likely source of "model works in a chat but gets dumber in the loop" and belongs in the smoke test.

### Structured output

`response_format` (`json_schema`) is passed with `supportsStructuredOutputs: true`. All shortlisted models list `structured_outputs`. OpenRouter treats `response_format` as a soft routing preference like tools.

### Params TrueForge can and cannot forward on `custom`

Forwarded to the body: `service_tier`, `user`, `prompt_cache_key`, `parallel_tool_calls`, `thinking`, `thinking_budget`, `enable_thinking`, `reasoning_history`, plus normal sampling params and `max_tokens` (`tf:core/llm/VercelAILLM.ts` L487-520). Not forwarded: OpenRouter's `provider` routing object, `reasoning` object, `session_id`, `models` (fallback list), `plugins`, `usage`. Any key outside that list is dropped even though `ModelParams` is `.loose()`; the docs say extra keys are "forwarded as-is" (`tf:core/llm/model.ts`), but for the compatible adapter they are not.

### Context and output limits matter here

`context_length` and `max_output_tokens` come from the configured model's `properties` (`tf:server/runtime/sessionResources.ts` L108-109). The compaction trigger is 80% of context length (capped by `context_length - max_tokens`), else a flat 50,000 tokens when no context length is known (`agent-loop.md` section 6). `max_output_tokens` also becomes the default `max_tokens`. So for each OpenRouter model set both explicitly. Do not copy 1M as the context: the agent will rarely get there and long contexts raise cost; set a trigger deliberately (for example context_length 200000, or an explicit `compaction.trigger.value`). Quality at 1M context also degrades per vendor, which I did not check.

## 4. Can subagents use a cheaper model?

No. `DynamicSubAgents` accepts a `modelSetConfig` that would add a per-call model parameter to `create_sub_agent`, but nothing passes one: `modelSetConfig` is referenced only inside `tf:core/capabilities/builtins/DynamicSubAgents.ts` and nowhere else in `packages/trueforge-core/src` or `packages/trueforge/src` at `0a42995`. This confirms the agent-loop finding. Subagents therefore run on the parent's model, with the parent's `reasoning_effort` and `max_tokens`. If cheap fan-out matters, either choose one model cheap enough for all threads (GLM-5.3-Flash at low effort is the candidate), or see whether the upstream project exposes the model set later (candidate ticket).

## 5. Prompt caching

- TrueForge defaults `cache_control: {type: "ephemeral"}` only for the `anthropic` and `truefoundry` provider types. For `custom` no `cache_control` is sent (`tf:core/llm/VercelAILLM.ts` L394-401, L555-558). So the "Anthropic caching on by default" behaviour does not carry over.
- On OpenRouter, the open-weight families that matter cache implicitly, with no request change (`or-docs:prompt-caching`): DeepSeek caches automatically (cache reads 0.1x input, writes at input price); Z.ai caches automatically (reads about 0.2x, writes free); Moonshot caches automatically (reads 0.25x). Qwen's explicit-only caching needs `cache_control` and applies to a short list of Qwen models, none on the shortlist. gpt-oss is not covered by the page.
- Model-level `or:models` shows `input_cache_read` prices: GLM-5.3-Flash $0.006/M (about 8x cheaper than its $0.048 base), DeepSeek V4 Flash 0731 $0.0000049/M listed (the data looks like a promo, treat as unreliable), DeepSeek V4 Flash $0.0182/M. Every GLM-5.3-Flash and DeepSeek V4 Flash 0731 endpoint reports `supports_implicit_caching: true`.
- OpenRouter's sticky routing (keeps a conversation on the provider that served the cache hit) switches on after the first detected cache hit, or immediately when `session_id` is sent; sessions expire after 10 minutes idle; and it is not used when `provider.order` is set (`or-docs:prompt-caching`). TrueForge cannot send `session_id` (section 3), so it depends on the automatic mode. Setting a manual provider order (which TrueForge cannot do per request, but an account allow-list is not an order) would disable it.
- Cache behaviour here is shaped by TrueForge's prompt layout: harness text first, user instructions in the same system prompt, deferred tools keep the tool list stable. Prefix stability should favour automatic prefix caching. Compaction rewrites the entire context once, which resets the cache once per compaction. **(inferred)** Cached tokens come back as `usage.prompt_tokens_details.cached_tokens`, which the SDK exposes and TrueForge records as cache-read tokens in turn metrics (`agent-loop.md` section 9). Whether the number is non-zero on OpenRouter is a smoke-test item.
- `prompt_cache_key` can be forwarded (whitelisted) if a provider honours it. OpenRouter's page does not describe it, so I would not rely on it.

## 6. Outbound URL guard

**`openrouter.ai` is not blocked by default.**
- The guard (`tf:core/util/ssrfGuard.ts`) is on by default (`NETWORK_POLICY_ENABLED=true`) and is applied at two points: when a provider is created or updated (`assertSafeOutboundUrl(provider.base_url)` in `tf:server/apis/modelProviders.ts` L105, L137) and on every model request via `modelSsrfFetch`, whose socket-level DNS lookup rejects any hostname that resolves to a private address.
- It is a deny-list, not an allow-list. It blocks non-http(s) schemes, RFC1918, CGNAT (100.64/10), loopback, link-local, TEST-NETs, 198.18/15, multicast, the IPv6 equivalents, bare hostnames without a dot, and the suffixes `.local .localhost .localdomain .internal .svc .cluster .arpa .lan .intranet .corp .home .test .invalid .example`. A public name such as `openrouter.ai` that resolves to public addresses passes. `OUTBOUND_URL_ALLOWED_HOSTS` (JSON array, default empty) only adds exceptions that skip these checks; it is not required for OpenRouter.
- Where it can bite: a VPN, corporate proxy, DNS filter or "fake-IP" resolver (for example Clash/Surge/WARP-style, which hand out 198.18.0.0/15 or 100.64.0.0/10 addresses) that makes `openrouter.ai` resolve to a private range would be blocked, with the error `Outbound URL blocked for host "openrouter.ai"`. Fix: `OUTBOUND_URL_ALLOWED_HOSTS='["openrouter.ai"]'` (an allowed host also skips the DNS-result check). Do this only if the error appears. Redirects are re-checked and cross-origin redirects strip `Authorization` (`ssrfGuard.ts` `CROSS_ORIGIN_STRIPPED_HEADERS`).
- The guard also covers MCP URLs. For the Paper Scout's own MCP server on `localhost`/`127.0.0.1`, `OUTBOUND_URL_ALLOWED_HOSTS` (or `NETWORK_POLICY_ENABLED=false`) is required; that belongs to the MCP ticket, not this one, but it is the same setting and `.env.example` uses `["localhost","127.0.0.1",...]` as its example.

## 7. OpenRouter privacy, routing and spend controls

TrueForge cannot send the per-request `provider` object, so everything below is set on the OpenRouter account, a guardrail, or a key.

- **Prompt retention at OpenRouter.** Prompts and responses are not stored unless you opt in; metadata (token counts, latency) is stored. "Private Input & Output Logging" and the 1%-discount "OpenRouter Use of Inputs/Outputs" are both off by default (`or-docs:privacy/data-collection`).
- **Provider training / retention.** The account privacy setting controls whether requests may route to providers that train on or retain data; there are separate settings for paid and free models. The per-request `data_collection` field defaults to `allow`, and `deny` restricts to providers that do not collect data (`or-docs:provider-selection`, `or-docs:privacy/logging`). Providers have their own retention policies and OpenRouter does not reroute on them unless you ask (`or-docs:privacy/logging`).
- **Zero Data Retention.** Account-level toggle in privacy settings, enforceable per model group (Anthropic, OpenAI, Google, "all other models"), also available in guardrails; per-request `zdr: true` is OR-combined and cannot turn account enforcement off. Only endpoints with a recorded ZDR policy qualify, and unverifiable endpoints are treated as retaining. Implicit in-memory prompt caching is allowed under ZDR (`or-docs:zdr`). The public list is `https://openrouter.ai/api/v1/endpoints/zdr` (1,034 endpoints at fetch time). It includes 32 GLM-5.3-Flash endpoints (BaseTen, CoreWeave, Crusoe, DeepInfra, Fireworks, Novita, Parasail, Together and others) and 21 DeepSeek V4 Flash 0731 endpoints, so enforcing ZDR does not leave either shortlisted model without hosts. Web-search tools are excluded from ZDR.
- **Provider allow-lists.** Guardrails carry `allowed_providers` and `allowed_models` (empty means all), `limit_usd` with `reset_interval` (daily/weekly/monthly), and per-model-group `enforce_zdr_*`. A guardrail only applies once assigned to a key or member, or if it is the workspace default; allow-lists intersect across guardrails and account-wide privacy settings always apply (`or-docs:guardrails`). An account-wide `only` list is a ceiling: a request that cannot be satisfied by it fails with 404 (`or-docs:provider-selection`).
- **Per-key credit limits.** `limit` on key creation (`POST /api/v1/keys`) and `PATCH /api/v1/keys/{hash}` with `limit_reset`; responses report `limit`, `limit_remaining`, and daily/weekly/monthly usage; `include_byok_in_limit` controls BYOK (`or-docs:management-api-keys`). The management-keys page did not show the dashboard steps; the docs describe the API. A key limit is the main hard cost guard for a local agent, alongside TrueForge's `iteration_limit`.
- **Quantization and provider quality.** The same slug is served by many providers at different precision and price (GLM-5.3-Flash: about 35 endpoints from fp4 to fp8, $0.048-0.25 in / $0.20-1.60 out). Cheapest-first routing can land on fp4 or on thin hosts, which tends to hurt tool-call reliability. OpenRouter says it tracks a per-provider tool-call error rate that feeds "Auto Exacto" ordering for tool requests (`or-docs:tool-calling`), but this is not in the endpoints API. Account-level provider ignore/allow lists are the available knob; a sensible first allow-list is the larger fp8 hosts (for example DeepInfra, Novita, Parasail, Together, Fireworks, BaseTen, Z.AI itself for GLM). **(inferred; no measurement of provider quality was done.)**

## 8. Setup sketch (not executed)

1. In TrueForge Settings → Models, add a provider of type `custom`, name `openrouter`, base URL `https://openrouter.ai/api/v1`, API key from a **dedicated OpenRouter key with a `limit` and `limit_reset`** set.
2. Add models: `z-ai/glm-5.3-flash` and `deepseek/deepseek-v4-flash-0731`, each with `context_length`, `max_output_tokens` and `reasoning_efforts` set.
3. Agent spec: `model.name` = `openrouter/<configured name>`, `model.params` with `reasoning_effort: "low"` or `"high"`, `max_tokens` high enough for reasoning plus answer, and a lowered `config.iteration_limit` (30 to 50). Leave `parallel_tool_calls` unset.
4. On OpenRouter: privacy settings to deny training and, if wanted, enforce ZDR for "all other models"; a guardrail with an `allowed_providers` list assigned to the key.

## 9. Open questions

1. **Smoke test against the real loop.** Run one Paper Scout-shaped task (discover a tool through the meta-tools, call it with arguments, parallel calls, one `create_sub_agent`, one forced compaction) on GLM-5.3-Flash and DeepSeek V4 Flash 0731 via a short-lived limited key. Measure: valid JSON in `call_tool`, parallel-call rate, `cached_tokens` > 0, cost per turn, and behaviour with reasoning replay (section 3). Candidate ticket.
2. Do OpenRouter providers accept `reasoning_content` on replayed assistant messages, and does omitting `reasoning_details` degrade multi-step tool use on GLM and DeepSeek?
3. Does top-level `reasoning_effort` actually change reasoning spend on OpenRouter for these models? (Models API lists it; docs only document nested `reasoning.effort`.)
4. Which OpenRouter providers are reliable for tool calls at the cheap end? No public per-provider tool-error figure is exposed in the endpoints API.
5. Which price is realistic after provider pinning? The headline cheapest prices are fp4 hosts; budget with the mid-market figures.
6. Should upstream TrueForge be asked to (a) forward an OpenRouter `provider` object or arbitrary body fields for `custom`, (b) wire `modelSetConfig` into `builtinsFromSpec`, (c) allow custom provider headers? These would remove the need for account-level routing and allow a cheap subagent model. Candidate upstream-issue ticket.

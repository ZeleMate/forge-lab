# OpenAI Decisions API for the Paper Scout

Ticket: ZeleMate/forge-lab#15. Researched 2026-10-18 from primary sources only. Nothing was called live (no key, no paid calls), so latency and calibration are unmeasured.

## Answer in brief

- Use it, but as a small, optional triage tool in our MCP server, not as a foundation. It works as described: typed `predicate` / `choice` / `score` answers with probabilities, $0.10 per 1M input tokens, and no charge for output tokens.
- The shape is **one shared `input`, up to 200 `questions`**. So the natural unit is one paper, several questions (relevance score, topic choice, "is it about agent harnesses?" predicate). Many papers in one call is possible (put all abstracts in `input`, one question per paper id), but is untested for quality.
- A realistic day (300 abstracts) costs about **$0.024** (one call per paper) or about **$0.01** (two bulk calls). That is under $1 a month. A cheap OpenRouter model doing the same triage costs about **$0.006 to $0.11** a day, so Decisions is not clearly cheaper. The reasons to use it are probabilities, calibrated-by-design outputs, no JSON-parsing failures, and learning the API.
- Beta risk is real: the docs say GA is "in the coming weeks", the SDK already changed types three times in eight days, and the docs state no latency, rate-limit or batch numbers for Decisions.

## 1. Request limits

| Item | Value | Source |
|---|---|---|
| Endpoint | `POST /v1/decisions`, only model `gpt-6-luna` | [guide](https://developers.openai.com/api/docs/guides/decisions), SDK types |
| Questions per request | 1 to 200 ("Ask 1-200 questions about the input") | `DecisionCreateParams.questions` JSDoc, openai@7.38.0 |
| Choices per `choice` question | 2 to 255, unique | same |
| Input | One `input` shared by **all** questions in the request: a string, or user messages of `input_text` / `input_image` parts | guide, SDK types |
| Images | at most 128 per request; base64 data URLs (7.30.0 types say data URL only; 7.34+ types also allow public HTTP(S) URLs; the guide says inline base64 only) | SDK types, guide |
| Input size cap | **Not documented for Decisions.** The model page for `gpt-6-luna` gives a 1,050,000 token context and 922,000 max input, which is the best proxy. | [model page](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| Batch endpoint | Not documented for Decisions. The model page lists `v1/batch` for Responses and Chat Completions only; Decisions does not appear in the endpoint list at all. | model page |
| Dependent questions | Not supported in one request; "dependent decisions require separate requests" | guide |

Do many papers fit in one call? Mechanically yes: the 200-question cap is the limit, and 150 abstracts of ~300 tokens is ~45k tokens, well inside the context. But all questions see the *same* input, so a bulk call means every question must say which paper it is about (`name: "2510.01234"`, `instructions: "Relevance of paper 2510.01234 only"`). Risks we cannot rule out from docs: cross-paper anchoring, and a refusal or error on one question. Plan: one call per paper as the default, bulk calls as an experiment (see open questions).

**Rate limits.** The Decisions guide gives none. The rate-limits guide and the model page list `gpt-6-luna` limits by tier: Build 5,000 RPM / 2M TPM, Launch 10,000 RPM / 10M TPM, Grow 30,000 RPM / 180M TPM. Whether Decisions shares these is not stated. Tiers are set by total credit purchased: Build at $5, Launch at $100, Grow at $500 ([rate limits guide](https://developers.openai.com/api/docs/guides/rate-limits)). 300 papers a day is far below even Build, so limits do not matter for us.

## 2. Latency and beta stability

- **Latency:** the only statement is that Decisions is "about 10x faster than the Responses API" (guide). No numbers. We have not measured it. For a 300-call day at modest concurrency this is not a constraint either way; measure in the prototype.
- **Stability:** the guide says public beta, GA "in the coming weeks". Model page snapshot: `gpt-6-luna` only.
- **SDK churn (openai-node releases, github.com/openai/openai-node/releases):**
  - v7.30.0 (2026-10-06): "add standalone Decisions support" (first version with `client.decisions`).
  - v7.33.0 (10-14): organization Decisions usage reporting plus doc clarifications.
  - v7.34.0 (10-14): "clarify Decisions request and response fields".
  - v7.35.0 (10-16): Decisions prompt caching options (`prompt_cache_options`, `prompt_cache_key`), "support Decisions in Live sessions".
  - Type diff 7.30.0 to 7.38.0: additive only (image URL allowed, cache options, doc text). No breaking change seen so far, but the surface is moving weekly.
- **Mitigation:** pin an exact `openai` version in the MCP server's `package.json`, wrap the call behind one internal function (`decide()`), and keep the response mapping in one place.

## 3. `openai` npm SDK on Bun

- First version with `client.decisions.create`: **7.30.0** (published 2026-10-06; 7.29.0 does not exist on npm). The guide's stated JavaScript minimum is 7.30.0, which matches. Latest is **7.38.0** (2026-10-17). `engines.node` is `>=22.0.0`.
- Types ship in the package (`resources/decisions.d.ts`). `client.decisions` is `API.Decisions`; `create(body: DecisionCreateParams, options?: RequestOptions): APIPromise<Decision>`.
- Answers are a discriminated union on `type` (`predicate` | `choice` | `score` | `refusal`), so a `switch` on `type` narrows in TypeScript. Note `name` is `string | null`, and `refusal` carries no data.
- `usage` returns `input_tokens`, `output_tokens`, `reasoning_tokens`, and cache counters, which lets the tool log real cost.
- Bun: the SDK is `fetch`-based and the README documents Bun only in the proxy section. I found no Bun-specific caveat but did not run it; the prototype should confirm. Use `bun add openai@7.38.0` (exact pin).

## 4. Fit for Paper Scout jobs

Response shapes (SDK types):
- `predicate`: `{ type, name, probability }`
- `choice`: `{ type, name, choice, confidence, probabilities: [{ value, probability }] }`
- `score`: `{ type, name, score, confidence, probabilities: [{ value, label, probability }] }` where `score` is the probability-weighted level index (can land between levels).

| Job | Type | Fit |
|---|---|---|
| Relevance against the user's interests | `score` with 4 to 5 ordered levels ("Irrelevant", "Tangential", "Relevant", "Must read") | Best fit. Gives a sortable number plus distribution. Level descriptions are the real prompt, so put the user's interests there (long, but identical on every call). |
| Topic routing (agents, evals, RL, infra...) | `choice` | Good, `probabilities` give a ranking and `confidence` flags ambiguous papers. Max 255 choices. A paper that spans topics gets one winner; use several `predicate`s if multi-label matters. |
| Filter "is this about agent harnesses?" | `predicate` | Good, cheapest to reason about; threshold the probability. |
| Anything needing a summary, extraction or a rationale | none | Not supported. No free text comes back. Use the OpenRouter agent for that. |

**Calibration.** The guide says predicate outputs are estimates "you threshold", recommends setting thresholds from labelled examples in your own application, and publishes no accuracy or calibration metrics. So "calibrated" is unproven. Plan: hand-label ~50 papers once, compare, pick thresholds. Treat `confidence` on `choice`/`score` as a routing signal, not a guarantee. A recorded caveat: probabilities from small models are often overconfident; verify before trusting 0.9 as 90%.

Design note: because the questions share one input, ask the relevance score, the topic choice and two or three predicates in the **same** call per paper; the abstract tokens are paid once.

## 5. Cost model: 300 abstracts per day

Assumptions: abstract ~300 tokens; instructions plus level/choice descriptions for 3 to 4 questions ~500 tokens; so ~800 input tokens per paper-call, 300 calls, 240k input tokens a day.

Prices: Decisions from the [guide](https://developers.openai.com/api/docs/guides/decisions) and [pricing page](https://developers.openai.com/api/docs/pricing): $0.10 per 1M input, cached input $0.01, cache writes $0.125, no output charge. OpenRouter prices from `GET https://openrouter.ai/api/v1/models` on 2026-10-18 (all three support `tools` and `structured_outputs`).

| Option | Input $/M | Output $/M | Per day (short JSON out, 50 tok/paper) | Per day (reasoning-heavy, 400 tok/paper) |
|---|---|---|---|---|
| OpenAI Decisions, one call per paper | 0.10 | 0 | **$0.024** | $0.024 |
| Decisions, 2 bulk calls of 150 papers | 0.10 | 0 | **~$0.010** | ~$0.010 |
| `openai/gpt-oss-20b` | 0.018 | 0.09 | $0.006 | $0.015 |
| `google/gemma-4-26b-a4b-it` | 0.0675 | 0.225 | $0.020 | $0.043 |
| `openai/gpt-oss-120b` | 0.15 | 0.60 | $0.045 | $0.108 |

Month (30 days): Decisions $0.72 (or $0.31 bulk); OpenRouter $0.17 to $3.24. Decisions cache reads would cut the repeated question text, but the cached prefix must come first and our `input` (the abstract) comes before the questions, so I would not count on it; explicit `prompt_cache_breakpoint` on a shared leading `input_text` is the only route and is untested. Batch and Flex are 50% off on the pricing page, but nothing says they apply to `/v1/decisions`.

Reading: all of these are cents. A cheap open model with JSON output is as cheap or cheaper. The reason to choose Decisions is not price; it is probability outputs without writing parser/retry code, plus the learning goal. Another point: any in-MCP triage (either option) keeps the 300 abstracts out of the agent's context, which is the bigger saving. Discrepancy to verify: the pricing page lists an output rate ($0.50/M) for `gpt-6-luna` generally while the Decisions guide says no output charge; the first real response's `usage` and the billing dashboard will show which is true (at 50 output tokens a paper the difference is $0.0075 a day anyway).

## 6. Account and privacy

- Needs a separate OpenAI API account, a key and prepaid credit; the Build tier starts at $5 of credit purchases. Free tier listed ("account in an allowed geography").
- Key placement: environment of the MCP server process, loaded from a gitignored `.env` (`OPENAI_API_KEY`), never in the repo, never in the TrueForge agent spec or MCP registration. Create a dedicated project key with a low monthly budget limit (the usage tiers also cap monthly spend: $100 free, $500 Build). Consistent with the map's "capped dedicated key" decision in #13.
- Data ([your-data guide](https://developers.openai.com/api/docs/guides/your-data), `/v1/decisions` row): not used for training; abuse-monitoring logs kept up to 30 days by default; no application state apart from prompt-cache tensors (GPU-local, 24h); ZDR available to eligible customers (not us by default); HIPAA possible under an addendum; regional processing in the US and EEA/Switzerland, Europe needs ZDR or a similar control and regional endpoints carry a +10% uplift for models released after March 5, 2026 (unclear if `gpt-6-luna` is affected). Image CSAM scanning applies, irrelevant to us.
- What we send: public arXiv abstracts and titles plus our interest descriptions. Low sensitivity. Do not send private notes or the Reading List contents.

## 7. Sketch: `score_papers` MCP tool (not repo code)

Request shape for one paper (relevance score + topic choice + two predicates):

```json
{
  "model": "gpt-6-luna",
  "input": "Title: ...\nAbstract: ...",
  "questions": [
    { "type": "score", "name": "relevance",
      "instructions": "How useful is this paper to an AI engineer building custom agent harnesses and evals?",
      "levels": [
        { "label": "irrelevant", "description": "Unrelated to LLM agents, tooling or evaluation." },
        { "label": "tangential", "description": "General LLM work with no agent angle." },
        { "label": "relevant",   "description": "Concrete agent loop, tool use, memory or eval method." },
        { "label": "must_read",  "description": "Directly about harness design, with reusable ideas." } ] },
    { "type": "choice", "name": "topic", "instructions": "Primary topic.",
      "choices": [ { "value": "harness" }, { "value": "evals" }, { "value": "rl" }, { "value": "other" } ] },
    { "type": "predicate", "name": "is_harness",
      "instructions": "The paper's main contribution is about an agent harness or agent loop." }
  ]
}
```

TypeScript inside the Bun MCP server (illustrative, written against the 7.38.0 types):

```ts
import OpenAI from "openai";
import { z } from "zod";

const client = new OpenAI(); // OPENAI_API_KEY from the server's env

const PaperIn = z.object({ id: z.string(), title: z.string(), abstract: z.string() });

server.registerTool("score_papers", {
  description: "Cheaply triage papers; returns relevance, topic and flags. No summaries.",
  inputSchema: { papers: z.array(PaperIn).max(50), minRelevance: z.number().default(1.5) },
}, async ({ papers, minRelevance }) => {
  const rows = await mapLimit(papers, 8, async (p) => {
    const d = await client.decisions.create({
      model: "gpt-6-luna",
      input: `Title: ${p.title}\nAbstract: ${p.abstract}`,
      questions: QUESTIONS, // the array shown above, as a typed const
    });
    const by = Object.fromEntries(d.answers.map((a) => [a.name, a]));
    const rel = by.relevance, topic = by.topic, harness = by.is_harness;
    return {
      id: p.id,
      relevance: rel?.type === "score" ? rel.score : null,   // 0..3
      confidence: rel?.type === "score" ? rel.confidence : null,
      topic: topic?.type === "choice" ? topic.choice : null,
      isHarness: harness?.type === "predicate" ? harness.probability : null,
      inputTokens: d.usage.input_tokens,
    };
  });
  return { content: [{ type: "text", text: JSON.stringify(
    rows.filter((r) => (r.relevance ?? 0) >= minRelevance).sort((a, b) => b.relevance! - a.relevance!)) }] };
});
```

Notes: `mapLimit` is a small concurrency helper (not in stdlib); refusals map to `null`; errors from the SDK (429, 5xx) are retried by the SDK itself (default 2 retries), so the tool only needs a fallback that returns "unscored" rather than failing the whole batch. The agent then reads only the top few papers. A `classify_paper` single-paper tool would be the same call with fewer questions.

## 8. Recommendation

1. Build `score_papers` on Decisions, one call per paper, 3 to 4 questions, pinned `openai@7.38.0` (or the latest at build time), behind one `decide()` function so the backend can be swapped.
2. Keep a fallback plan: the same function signature could be implemented with `openai/gpt-oss-20b` on OpenRouter using structured outputs, at similar or lower cost, if the beta breaks or the key/billing friction is not worth it. This is also the control for judging Decisions quality.
3. Before depending on it, run a half-day prototype: 50 hand-labelled papers, measure latency, check `usage` for output billing, compare calibration of Decisions probabilities against gpt-oss-20b, and try one 150-paper bulk call.

## Open questions

- Latency per call and p95: unmeasured.
- Does Decisions share the `gpt-6-luna` rate limits, and does Batch or Flex apply? Not documented.
- Max input size for Decisions specifically.
- Is there an output-token charge despite the guide (pricing page vs guide mismatch)?
- Quality of bulk (many papers in one `input`) versus per-paper calls.
- Calibration against our own labels; whether `confidence` is useful.
- GA date and whether the request shape changes at GA.
- Bun: runtime check of the SDK (no known issue).
- I could not fetch an API-reference page for `/v1/decisions` (the URL guessed returned 404); the SDK type JSDoc was used as the reference for request limits.

## Sources

- https://developers.openai.com/api/docs/guides/decisions
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/guides/rate-limits
- https://developers.openai.com/api/docs/guides/your-data
- https://registry.npmjs.org/openai (versions and dates); tarballs `openai@7.30.0` and `openai@7.38.0`, `resources/decisions.d.ts`
- https://github.com/openai/openai-node (releases v7.30.0 to v7.35.0, `api.md`)
- https://openrouter.ai/api/v1/models (prices fetched 2026-10-18)

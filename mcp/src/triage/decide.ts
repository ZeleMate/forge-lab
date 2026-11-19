// The triage tools' judge (#15, #17): one `Decide` interface with two backends,
// chosen by config. OpenAI's Decisions API is the default. openai/gpt-oss-20b on
// OpenRouter runs only when no OpenAI key is set. A failed call is never retried
// on the other backend, so one result never mixes two models' judgements.

import OpenAI from "openai";

export type Question = { name: string; instructions: string };
export type Level = { label: string; description: string };

// `answers` maps each question's name to a number (a `score` level index, or a
// `predicate` probability), or null when the backend didn't answer it.
export type Judged = { answers: Record<string, number | null>; costUsd: number; ms: number };

export interface Decide {
  readonly backend: "decisions" | "gpt-oss-20b";
  // What a call with this much input text will cost at most, checked against
  // the budget before the call.
  estimateUsd(inputChars: number, questions: number): number;
  score(input: string, questions: Question[], levels: readonly Level[]): Promise<Judged>;
  predicate(input: string, questions: Question[]): Promise<Judged>;
}

// Code and JSON tokenize nearer 3 characters per token than 4, so this over-
// rather than under-estimates.
const tokensFor = (chars: number) => Math.ceil(chars / 3);

// ---------- Decisions ----------

export const DECISIONS_MODEL = "gpt-6-luna";
// $ per input token. Output tokens were 0 on every response #17 recorded.
export const DECISIONS_INPUT_PRICE = 0.1 / 1e6;

// The parts of a Decisions response the tools read, as the API returns them.
export type DecisionResponse = {
  answers: { name: string | null; type: string; score?: number; probability?: number }[];
  usage: { input_tokens: number; output_tokens: number };
};

// Each named answer as a number: `score` for a score question (never
// `confidence`, which #17 found isn't a relevance signal), `probability` for a
// predicate, and null for a refusal or anything else.
export function parseDecision(d: DecisionResponse): { answers: Record<string, number | null>; costUsd: number } {
  const answers: Record<string, number | null> = {};
  for (const a of d.answers) {
    if (!a.name) continue;
    answers[a.name] = a.type === "score" ? (a.score ?? null) : a.type === "predicate" ? (a.probability ?? null) : null;
  }
  return { answers, costUsd: d.usage.input_tokens * DECISIONS_INPUT_PRICE };
}

export function decisionsDecide(client: OpenAI): Decide {
  async function call(input: string, questions: OpenAI.DecisionCreateParams["questions"]): Promise<Judged> {
    const started = performance.now();
    const d = await client.decisions.create({ model: DECISIONS_MODEL, input, questions });
    return { ...parseDecision(d), ms: Math.round(performance.now() - started) };
  }
  return {
    backend: "decisions",
    estimateUsd: (chars) => tokensFor(chars) * DECISIONS_INPUT_PRICE,
    score: (input, questions, levels) =>
      call(
        input,
        // `as const` keeps the literal "score", which the API's union type needs.
        questions.map((q) => ({
          type: "score" as const,
          name: q.name,
          instructions: q.instructions,
          levels: [...levels],
        })),
      ),
    predicate: (input, questions) =>
      call(
        input,
        questions.map((q) => ({ type: "predicate" as const, name: q.name, instructions: q.instructions })),
      ),
  };
}

// ---------- gpt-oss-20b on OpenRouter ----------

export const GPT_OSS_MODEL = "openai/gpt-oss-20b";
// $ per token, used only when OpenRouter's `usage.cost` is missing.
const GPT_OSS_PRICES = { input: 0.018 / 1e6, output: 0.09 / 1e6 };
// Output allowance per question for the estimate: a short label or a boolean.
const GPT_OSS_OUTPUT_PER_QUESTION = 40;

export function gptOssDecide(client: OpenAI): Decide {
  // One structured-output call answers every question at once: a JSON object
  // with one property per question name. `values` is the JSON Schema each
  // answer must match (a level label, or a boolean).
  async function call(input: string, questions: Question[], values: object, toNumber: (v: unknown) => number | null) {
    const started = performance.now();
    const schema = {
      type: "object",
      properties: Object.fromEntries(questions.map((q) => [q.name, values])),
      required: questions.map((q) => q.name),
      additionalProperties: false,
    };
    const asked = questions.map((q) => `- ${q.name}: ${q.instructions}`).join("\n");
    const r = await client.chat.completions.create({
      model: GPT_OSS_MODEL,
      messages: [{ role: "user", content: `${input}\n\nAnswer each of these:\n${asked}` }],
      response_format: { type: "json_schema", json_schema: { name: "answers", strict: true, schema } },
      reasoning_effort: "low",
    });
    const content = r.choices[0]?.message.content;
    if (!content) throw new Error("gpt-oss-20b returned no content");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // OpenRouter adds `cost` (in $) to `usage`; the SDK's type doesn't declare it.
    const usage = r.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined;
    const costUsd =
      usage?.cost ??
      (usage?.prompt_tokens ?? 0) * GPT_OSS_PRICES.input + (usage?.completion_tokens ?? 0) * GPT_OSS_PRICES.output;
    const answers = Object.fromEntries(questions.map((q) => [q.name, toNumber(parsed[q.name])]));
    return { answers, costUsd, ms: Math.round(performance.now() - started) };
  }
  return {
    backend: "gpt-oss-20b",
    estimateUsd: (chars, questions) =>
      tokensFor(chars) * GPT_OSS_PRICES.input + questions * GPT_OSS_OUTPUT_PER_QUESTION * GPT_OSS_PRICES.output,
    score: (input, questions, levels) => {
      const labels = levels.map((l) => l.label);
      const guide = levels.map((l) => `${l.label}: ${l.description}`).join("\n");
      return call(`${input}\n\nLevels:\n${guide}`, questions, { type: "string", enum: labels }, (v) => {
        const i = labels.indexOf(String(v));
        return i >= 0 ? i : null;
      });
    },
    predicate: (input, questions) =>
      call(input, questions, { type: "boolean" }, (v) => (typeof v === "boolean" ? Number(v) : null)),
  };
}

// ---------- choosing one ----------

// Which backend the server runs, from mcp/.env (#57): Decisions when
// OPENAI_API_KEY is set, gpt-oss-20b when only OPENROUTER_API_KEY is, and none
// otherwise (the tools then return `unscored`). The keys are read, never logged.
export function decideFromEnv(env: Record<string, string | undefined>): Decide | undefined {
  // `timeout` is in milliseconds: a stuck call fails long before MCP's 2 minutes.
  if (env.OPENAI_API_KEY)
    return decisionsDecide(new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 20_000 }));
  if (env.OPENROUTER_API_KEY)
    return gptOssDecide(
      new OpenAI({
        apiKey: env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1",
        maxRetries: 0,
        timeout: 30_000,
      }),
    );
  return undefined;
}

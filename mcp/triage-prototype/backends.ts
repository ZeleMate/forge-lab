// PROTOTYPE (#17). The three ways of scoring a pool against a question:
//   decisions-file  one Decisions call per candidate (one `score` question)
//   decisions-bulk  one Decisions call per pool (one `score` question per candidate)
//   gpt-oss-file    openai/gpt-oss-20b on OpenRouter, structured output, one call per candidate
// Every result carries its latency and cost, so run.ts can compare them.

import OpenAI from "openai";

export const DECISIONS_MODEL = "gpt-6-luna";
export const BASELINE_MODEL = "openai/gpt-oss-20b";
// $ per input token. The Decisions guide says output is free; output tokens are
// still recorded, to settle the guide-versus-pricing-page mismatch (#15).
export const DECISIONS_INPUT_PRICE = 0.1 / 1e6;
export const BASELINE_PRICES = { input: 0.018 / 1e6, output: 0.09 / 1e6 }; // fallback if OpenRouter omits `cost`

// The levels are the real prompt for `score`; the baseline gets the same text.
export const LEVELS = [
  { label: "irrelevant", description: "Nothing in this file bears on the question." },
  {
    label: "mentions",
    description: "Touches the topic (imports it, passes it through, names it) but doesn't implement it.",
  },
  { label: "partial", description: "Implements part of the answer, or a closely related step." },
  {
    label: "answers",
    description: "A primary place to read: it implements or defines the mechanism the question asks about.",
  },
] as const;

export type Scored = { path: string; score: number | null; confidence: number | null };
export type Call = { mode: string; ms: number; inputTokens: number; outputTokens: number; cost: number };
export type Candidate = { path: string; text: string };

// `new OpenAI()` reads OPENAI_API_KEY from the environment; the key is never logged.
export const openai = () => new OpenAI({ maxRetries: 0 });
export const openrouter = () =>
  new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY, maxRetries: 0 });

export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = performance.now();
  const result = await fn();
  return { ms: Math.round(performance.now() - start), result };
}

export async function decisionsFile(question: string, c: Candidate): Promise<{ scored: Scored; call: Call }> {
  const { ms, result: d } = await timed(() =>
    openai().decisions.create({
      model: DECISIONS_MODEL,
      input: `Question about the TrueForge agent harness: ${question}\n\nCandidate file:\n${c.text}`,
      questions: [
        {
          type: "score",
          name: "relevance",
          instructions: "How much does this file help answer the question above?",
          levels: [...LEVELS], // spread: the API type wants a mutable array, LEVELS is `readonly`
        },
      ],
    }),
  );
  const a = d.answers[0];
  return {
    // A `switch` on `type` would narrow too; a ternary is enough for one case.
    scored: {
      path: c.path,
      score: a?.type === "score" ? a.score : null,
      confidence: a?.type === "score" ? a.confidence : null,
    },
    call: {
      mode: "decisions-file",
      ms,
      inputTokens: d.usage.input_tokens,
      outputTokens: d.usage.output_tokens,
      cost: d.usage.input_tokens * DECISIONS_INPUT_PRICE,
    },
  };
}

export async function decisionsBulk(question: string, cs: Candidate[]): Promise<{ scored: Scored[]; call: Call }> {
  const id = (i: number) => `C${String(i + 1).padStart(2, "0")}`;
  const listing = cs.map((c, i) => `### ${id(i)}\n${c.text}`).join("\n\n");
  const { ms, result: d } = await timed(() =>
    openai().decisions.create({
      model: DECISIONS_MODEL,
      input: `Question about the TrueForge agent harness: ${question}\n\nCandidate files:\n\n${listing}`,
      questions: cs.map((c, i) => ({
        type: "score" as const, // `as const` keeps the literal "score" instead of widening to string
        name: id(i),
        instructions: `How much does candidate ${id(i)} (${c.path}) help answer the question? Judge ${id(i)} only.`,
        levels: [...LEVELS],
      })),
    }),
  );
  const byName = new Map(d.answers.map((a) => [a.name, a]));
  return {
    scored: cs.map((c, i) => {
      const a = byName.get(id(i));
      return {
        path: c.path,
        score: a?.type === "score" ? a.score : null,
        confidence: a?.type === "score" ? a.confidence : null,
      };
    }),
    call: {
      mode: "decisions-bulk",
      ms,
      inputTokens: d.usage.input_tokens,
      outputTokens: d.usage.output_tokens,
      cost: d.usage.input_tokens * DECISIONS_INPUT_PRICE,
    },
  };
}

const LEVEL_SCHEMA = {
  type: "object",
  properties: { level: { type: "string", enum: LEVELS.map((l) => l.label) } },
  required: ["level"],
  additionalProperties: false,
};

export async function gptOssFile(question: string, c: Candidate): Promise<{ scored: Scored; call: Call }> {
  const levels = LEVELS.map((l) => `- ${l.label}: ${l.description}`).join("\n");
  const body = {
    model: BASELINE_MODEL,
    messages: [
      {
        role: "user" as const,
        content: `Question about the TrueForge agent harness: ${question}\n\nCandidate file:\n${c.text}\n\nHow much does this file help answer the question? Pick one level:\n${levels}`,
      },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "relevance", strict: true, schema: LEVEL_SCHEMA },
    },
    reasoning_effort: "low" as const,
    // OpenRouter-only field: route only to providers that honour response_format,
    // minus Darkbloom, which answered with reasoning and `content: null` (probe, 2026-10-27).
    provider: { require_parameters: true, ignore: ["Darkbloom"] },
  };
  const { ms, result: r } = await timed(() => openrouter().chat.completions.create(body));
  const content = r.choices[0]?.message.content;
  // Throwing makes run.ts log it and count the file as unscored, with the provider named.
  if (!content)
    throw new Error(`empty content from ${(r as unknown as { provider?: string }).provider ?? "unknown provider"}`);
  const label = (JSON.parse(content) as { level?: string }).level;
  const index = LEVELS.findIndex((l) => l.label === label);
  // OpenRouter adds `cost` (in $) to `usage`; the SDK's type doesn't know about it.
  const usage = r.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    scored: { path: c.path, score: index >= 0 ? index : null, confidence: null },
    call: {
      mode: "gpt-oss-file",
      ms,
      inputTokens,
      outputTokens,
      cost: usage?.cost ?? inputTokens * BASELINE_PRICES.input + outputTokens * BASELINE_PRICES.output,
    },
  };
}

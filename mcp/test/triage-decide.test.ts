// The two `decide()` backends, against fake OpenAI clients that return
// responses in each API's shape: Decisions answers are read by name, ranked by
// `score` (never `confidence`), and priced by input tokens; gpt-oss answers are
// mapped from labels and booleans to the same numbers.
import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import {
  DECISIONS_INPUT_PRICE,
  type DecisionResponse,
  decideFromEnv,
  decisionsDecide,
  gptOssDecide,
  parseDecision,
} from "../src/triage/decide";
import { LEVELS } from "../src/triage/tools";

// A Decisions response in the API's shape. `confidence` runs against `score`
// on purpose: a parser that read it would rank C02 first.
const RESPONSE: DecisionResponse = {
  answers: [
    { name: "C01", type: "score", score: 2.6, confidence: 0.4 } as DecisionResponse["answers"][number],
    { name: "C02", type: "score", score: 0.3, confidence: 0.95 } as DecisionResponse["answers"][number],
    { name: "C03", type: "refusal" },
    { name: "calls_exec", type: "predicate", probability: 0.91 },
  ],
  usage: { input_tokens: 4_000, output_tokens: 0 },
};

describe("parseDecision", () => {
  test("reads `score` and `probability` by name, never `confidence`, and null for a refusal", () => {
    const parsed = parseDecision(RESPONSE);
    expect(parsed.answers).toEqual({ C01: 2.6, C02: 0.3, C03: null, calls_exec: 0.91 });
    expect(parsed.costUsd).toBeCloseTo(4_000 * DECISIONS_INPUT_PRICE);
  });
});

// A stand-in for the OpenAI client with only the call a backend makes. The
// cast says "trust me": the backends touch nothing else on it.
function fakeClient(reply: unknown, seen: unknown[] = []) {
  const create = async (body: unknown) => {
    seen.push(body);
    return reply;
  };
  return { decisions: { create }, chat: { completions: { create } } } as unknown as OpenAI;
}

describe("decisionsDecide", () => {
  test("sends score questions with the levels and returns the parsed answers", async () => {
    const seen: unknown[] = [];
    const decide = decisionsDecide(fakeClient(RESPONSE, seen));
    const judged = await decide.score("input", [{ name: "C01", instructions: "How much?" }], LEVELS);
    expect(judged.answers.C01).toBe(2.6);
    expect(seen[0]).toMatchObject({
      model: "gpt-6-luna",
      questions: [{ type: "score", name: "C01", levels: LEVELS }],
    });
  });

  test("sends predicates without levels", async () => {
    const seen: unknown[] = [];
    await decisionsDecide(fakeClient(RESPONSE, seen)).predicate("input", [{ name: "calls_exec", instructions: "x" }]);
    expect(seen[0]).toMatchObject({ questions: [{ type: "predicate", name: "calls_exec" }] });
  });
});

describe("gptOssDecide", () => {
  const reply = (content: object, cost?: number) => ({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, ...(cost === undefined ? {} : { cost }) },
  });

  test("maps level labels to their index and uses OpenRouter's reported cost", async () => {
    const decide = gptOssDecide(fakeClient(reply({ C01: "partial", C02: "nonsense" }, 0.0002)));
    const judged = await decide.score(
      "input",
      [
        { name: "C01", instructions: "a" },
        { name: "C02", instructions: "b" },
      ],
      LEVELS,
    );
    expect(judged.answers).toEqual({ C01: 2, C02: null });
    expect(judged.costUsd).toBe(0.0002);
  });

  test("maps booleans to 1 and 0", async () => {
    const decide = gptOssDecide(fakeClient(reply({ yes: true, no: false })));
    const judged = await decide.predicate("input", [
      { name: "yes", instructions: "a" },
      { name: "no", instructions: "b" },
    ]);
    expect(judged.answers).toEqual({ yes: 1, no: 0 });
  });

  test("fails, rather than guessing, when the reply has no content", async () => {
    const decide = gptOssDecide(fakeClient({ choices: [{ message: { content: null } }] }));
    await expect(decide.predicate("input", [{ name: "x", instructions: "a" }])).rejects.toThrow(/no content/);
  });
});

describe("decideFromEnv", () => {
  test("Decisions when OPENAI_API_KEY is set, gpt-oss with only OPENROUTER_API_KEY, else none", () => {
    expect(decideFromEnv({ OPENAI_API_KEY: "test", OPENROUTER_API_KEY: "test" })?.backend).toBe("decisions");
    expect(decideFromEnv({ OPENROUTER_API_KEY: "test" })?.backend).toBe("gpt-oss-20b");
    expect(decideFromEnv({})).toBeUndefined();
  });
});

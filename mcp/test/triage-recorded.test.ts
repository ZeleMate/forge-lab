// The Decisions parser against real responses recorded by `triage:record`
// (#54, #57), so a change in the API's JSON shows up here, not in a live run.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type DecisionResponse, parseDecision } from "../src/triage/decide";

// `T[number]` is the type of one element of the array type T. The parser's own
// type leaves `confidence` out on purpose, so the test adds it back to look at it.
type ScoreAnswer = DecisionResponse["answers"][number] & { confidence?: number };

type Recorded = {
  score: { response: { answers: ScoreAnswer[]; usage: DecisionResponse["usage"] } };
  predicate: { response: DecisionResponse };
  overBudget: { result: { status: string }; judgeCalls: number };
};

const DIR = join(import.meta.dir, "..", "triage-results");
// The newest recording; file names are ISO timestamps, so they sort by time.
const newest = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .at(-1);
if (!newest) throw new Error("no recorded triage responses: run `bun run --filter @forge-lab/mcp triage:record`");
const rec = (await Bun.file(join(DIR, newest)).json()) as Recorded;

describe(`recorded Decisions responses (${newest})`, () => {
  test("every score answer parses to its `score`, named C01 to C05", () => {
    const { answers } = parseDecision(rec.score.response);
    expect(Object.keys(answers)).toEqual(["C01", "C02", "C03", "C04", "C05"]);
    for (const a of rec.score.response.answers) expect(answers[a.name ?? ""]).toBe(a.score ?? null);
  });

  test("the real response carries `confidence` too, and the parser ignores it", () => {
    expect(rec.score.response.answers.every((a) => typeof a.confidence === "number")).toBe(true);
  });

  test("the predicate parses to a probability", () => {
    const p = parseDecision(rec.predicate.response).answers.calls_source_status;
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  test("output tokens are 0, so the cost is input tokens only", () => {
    expect(rec.score.response.usage.output_tokens).toBe(0);
    expect(parseDecision(rec.score.response).costUsd).toBeGreaterThan(0);
  });

  test("the forced over-budget call was unscored without calling the judge", () => {
    expect(rec.overBudget).toEqual({ result: expect.objectContaining({ status: "unscored" }), judgeCalls: 0 });
  });
});

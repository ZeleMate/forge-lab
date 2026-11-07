// Records real Decisions responses for the triage tests (#54, #57), and forces
// an over-budget call. Needs OPENAI_API_KEY in mcp/.env, which the user enters;
// the key is read from the environment and never printed.
//
//   bun run --filter @forge-lab/mcp triage:record
//
// Expected, written before the first run:
//   score      one call with 5 candidate files: a `score` answer named C01..C05
//              for each, numbers between 0 and 3, and 0 output tokens
//   predicate  one call on one recorded event: a `predicate` answer with a
//              probability between 0 and 1
//   budget     with today's budget already spent, rank_relevance answers
//              `unscored` and the judge isn't called
// Costs about $0.001. Writes mcp/triage-results/<timestamp>.json and exits 1 if
// an expectation fails.

import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST, PORTS } from "@forge-lab/lib/ports";
import { saveResults } from "@forge-lab/lib/trueforge";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import OpenAI from "openai";
import { createApp } from "../src/app";
import { systemClock } from "../src/clock";
import type { SessionEvent } from "../src/sessions/api";
import { openSourceSnapshot } from "../src/source/snapshot";
import { Budget } from "../src/triage/budget";
import { candidateFor } from "../src/triage/candidates";
import { DECISIONS_MODEL, decisionsDecide, parseDecision } from "../src/triage/decide";
import { buildScoreRequest, eventInput, LEVELS } from "../src/triage/tools";

if (!process.env.OPENAI_API_KEY) {
  console.error("triage: OPENAI_API_KEY isn't set in mcp/.env");
  process.exit(1);
}
const client = new OpenAI({ maxRetries: 0, timeout: 20_000 });
const source = openSourceSnapshot();
const failures: string[] = [];

// ---------- score: one pool ----------

const PATHS = [
  "packages/trueforge-core/src/core/runtime/AgentThread.ts",
  "packages/trueforge-core/src/core/runtime/AgentThreadOrchestrator.ts",
  "packages/trueforge-core/src/core/capabilities/builtins/ContextCompaction.ts",
  "packages/trueforge/src/apis/turns.ts",
  "packages/trueforge/src/config.ts",
];
const candidates = PATHS.map((p) => candidateFor(source, p)).flatMap((c) => (c.ok ? [c.candidate] : []));
if (candidates.length !== PATHS.length) failures.push("score: a candidate path isn't in the snapshot");
const { input, questions, id } = buildScoreRequest(candidates, "Which method runs the agent loop?");
const scoreBody = {
  model: DECISIONS_MODEL,
  input,
  questions: questions.map((q) => ({ type: "score" as const, ...q, levels: [...LEVELS] })),
};
const scoreResponse = await client.decisions.create(scoreBody);
const scored = parseDecision(scoreResponse);
for (let i = 0; i < candidates.length; i++) {
  const s = scored.answers[id(i)];
  if (typeof s !== "number" || s < 0 || s > 3) failures.push(`score: ${id(i)} answered ${s}`);
}
if (scoreResponse.usage.output_tokens !== 0) failures.push(`score: ${scoreResponse.usage.output_tokens} output tokens`);

// ---------- predicate: one recorded event ----------

const fixturesDir = join(import.meta.dir, "..", "fixtures-results");
const recording = readdirSync(fixturesDir).sort().at(-1);
if (!recording) throw new Error("no recording in fixtures-results; run `bun run fixtures:record`");
const fixture = (await Bun.file(join(fixturesDir, recording)).json()) as {
  events: { pending: SessionEvent[] };
};
const event = fixture.events.pending.find((e) => e.type === "model.message");
if (!event) throw new Error("the fixtures recording has no model.message in its pending Turn");
const predicateBody = {
  model: DECISIONS_MODEL,
  input: eventInput(event),
  questions: [
    {
      type: "predicate" as const,
      name: "calls_source_status",
      instructions: "This event calls the tool source_status.",
    },
  ],
};
const predicateResponse = await client.decisions.create(predicateBody);
const probability = parseDecision(predicateResponse).answers.calls_source_status;
if (typeof probability !== "number" || probability < 0 || probability > 1)
  failures.push(`predicate: calls_source_status answered ${probability}`);

// ---------- budget: forced over the cap ----------

// A real Decisions backend, but today's budget already spent: the tool must
// answer `unscored` without calling it. Counted by wrapping the backend.
let judgeCalls = 0;
const real = decisionsDecide(client);
const counted = {
  ...real,
  // `Parameters<typeof f>` is f's argument list as a tuple type, so the wrapper
  // takes exactly what `score` takes.
  score: (...a: Parameters<typeof real.score>) => {
    judgeCalls++;
    return real.score(...a);
  },
};
const budget = new Budget({
  file: join(mkdtempSync(join(tmpdir(), "forge-lab-budget-")), "b.json"),
  capUsd: 0.5,
  clock: systemClock,
});
budget.spend(0.5);
const app = createApp({
  source,
  sessions: { api: undefined as never, clock: systemClock }, // rank_relevance never reads Sessions
  triage: { decide: counted, budget },
});
const mcp = new Client({ name: "triage-record", version: "0.0.0" });
await mcp.connect(
  new StreamableHTTPClientTransport(new URL(`http://${HOST}:${PORTS.mcp}/mcp/triage`), {
    fetch: (url, init) => {
      const req = new Request(url, init);
      req.headers.set("host", `${HOST}:${PORTS.mcp}`);
      return app.fetch(req);
    },
  }),
);
const over = await mcp.callTool({
  name: "rank_relevance",
  arguments: { question: "Which method runs the agent loop?", paths: PATHS },
});
const overResult = over.structuredContent as { status?: string; reason?: string };
if (overResult.status !== "unscored" || judgeCalls !== 0) failures.push(`budget: ${JSON.stringify(overResult)}`);
await mcp.close();

const file = await saveResults(`${import.meta.dir}/../triage-results`, {
  model: DECISIONS_MODEL,
  version: source.version,
  score: { request: scoreBody, response: scoreResponse },
  predicate: { request: predicateBody, response: predicateResponse },
  overBudget: { result: overResult, judgeCalls },
  costUsd: scored.costUsd + parseDecision(predicateResponse).costUsd,
  failures,
});
console.log({ scored: scored.answers, probability, overBudget: overResult.status, failures });
console.log(`Saved to ${file}`);
process.exit(failures.length ? 1 : 0);

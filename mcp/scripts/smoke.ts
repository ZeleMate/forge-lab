// Live smoke run of the MCP server (#54, #55): one question per server to a copy
// of Cartographer in an inline Experiment Session on glm-5-3-flash, on the stack
// `bun run dev` brings up. Not a test: it needs the server, the model and the key
// TrueForge holds, so it never runs in CI.
//
//   bun run --filter @forge-lab/mcp smoke            # every server with a question
//   bun run --filter @forge-lab/mcp smoke source     # just one
//
// Checks per question: a tool of that server ran, its result carries the
// provenance label and a citation, and the answer cites `file:line` with the sha.
// Writes mcp/smoke-results/<timestamp>.json and exits 1 if a check failed.

import { readPin } from "@forge-lab/lib/snapshot";
import {
  allEvents,
  type Event,
  findAgent,
  onSmokeModel,
  openInlineExperimentSession,
  runTurn,
  SMOKE_MODEL,
  saveResults,
  serverVersion,
  summarise,
} from "@forge-lab/lib/trueforge";
import type { Endpoint } from "../src/app";

type Question = { question: string; provenance: "source" | "observed" };
// `Partial<Record<...>>`: not every server has a question yet (#57 adds triage's).
const QUESTIONS: Partial<Record<Endpoint, Question>> = {
  source: {
    question:
      "Where is the AgentThread class declared in TrueForge, and which method runs the agent loop? Cite the lines.",
    provenance: "source",
  },
  sessions: {
    question:
      "Which Experiment Sessions ran most recently? List up to three, then give the status and token totals of the newest Turn in the first one. Cite the ids.",
    provenance: "observed",
  },
};

const pin = readPin();
const version = await serverVersion();
if (version !== pin.version) {
  console.error(`smoke: TrueForge is ${version}, the snapshot pins ${pin.version}; start it with \`bun run dev\``);
  process.exit(1);
}
const agent = await findAgent("cartographer");
if (!agent) {
  console.error("smoke: no cartographer Agent; `bun run dev` applies it");
  process.exit(1);
}

const manifest = onSmokeModel(agent.manifest);

const wanted = Bun.argv.slice(2) as Endpoint[];
// `Object.entries` types keys as plain strings, so the cast restores Endpoint.
const selected = (Object.entries(QUESTIONS) as [Endpoint, Question][]).filter(
  ([s]) => !wanted.length || wanted.includes(s),
);
const sha7 = pin.sha.slice(0, 7);
const results: Record<string, unknown> = { version, model: SMOKE_MODEL };
let failed = false;

for (const [server, { question, provenance }] of selected) {
  const session = await openInlineExperimentSession(manifest, `smoke-mcp-${server}`);
  const turn = await runTurn(session, question);
  const events = await allEvents(session, turn.id);
  const responses = events.filter((e) => e.type === "tool.response").map((e) => String(e.content ?? ""));
  const answer = lastAnswer(events);
  const checks = {
    turnDone: turn.state.status === "done",
    toolResultLabelled: responses.some((r) => r.includes(`"provenance":"${provenance}"`)),
    toolResultCited: responses.some((r) => r.includes('"citation"')),
    // The instructions ask for `path:line@sha7`; a smoke model may write the sha
    // once for the whole answer instead, which still pins every `file:line`.
    answerCites:
      provenance === "source"
        ? /\.\w+:\d+/.test(answer) && answer.includes(sha7)
        : /[\w-]+\/[\w-]+\/[\w-]+/.test(answer),
  };
  const ok = Object.values(checks).every(Boolean);
  failed ||= !ok; // `||=` assigns only when the left side is false
  results[server] = { session, question, checks, answer, summary: summarise(turn, events) };
  // A literal format string, so nothing in the data can act as a `%` specifier.
  console.log("== %s: %s %O", server, ok ? "ok" : "FAILED", checks);
}

console.log(`Saved to ${await saveResults(`${import.meta.dir}/../smoke-results`, results)}`);
process.exit(failed ? 1 : 0);

// The final answer: the last model message that calls no tool.
function lastAnswer(events: Event[]): string {
  const messages = events.filter((e) => e.type === "model.message" && !(e.tool_calls as unknown[] | undefined)?.length);
  return String(messages.at(-1)?.content ?? "");
}

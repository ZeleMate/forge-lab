// PROTOTYPE (#17). `predicate` checks over real Session events: how well do the
// Decisions API and gpt-oss-20b answer yes/no questions about one event, compared
// with labels derived mechanically from the event itself?
//
//   bun run events                 (needs `bun run dev`; reads Experiment Sessions only)
//
// One call per event asks every predicate at once (one shared input, five questions),
// the shape #15 recommends. The input drops ids, timestamps and usage. P5 also drops
// `type`, so it has to be judged from the content.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@forge-lab/lib/trueforge";
import {
  BASELINE_MODEL,
  BASELINE_PRICES,
  type Call,
  DECISIONS_INPUT_PRICE,
  DECISIONS_MODEL,
  openai,
  openrouter,
  timed,
} from "./backends";
import { experimentEvents } from "./events-inventory";

const BUDGET = 0.25;
const CONCURRENCY = 6;
const MAX_CHARS = 3000;
const OTHER_SAMPLE = 25; // events that are neither model messages nor pauses, as extra negatives

// Tool names a model message calls; tool calls appear as `{function: {name}}` or `{name}`.
function toolNames(e: Event): string[] {
  const calls = (e.tool_calls ?? []) as { function?: { name?: string }; name?: string }[];
  return calls.map((c) => c.function?.name ?? c.name ?? "");
}

type Predicate = { name: string; instructions: string; truth: (e: Event) => boolean; hideType?: boolean };

const PREDICATES: Predicate[] = [
  {
    name: "delegates",
    instructions: "In this event, the agent hands a subtask to a subagent (a child agent).",
    truth: (e) => e.type === "model.message" && toolNames(e).includes("create_sub_agent"),
  },
  {
    name: "runs_code",
    instructions: "In this event, the agent runs code or a shell command in a sandbox.",
    truth: (e) => e.type === "model.message" && toolNames(e).includes("exec"),
  },
  {
    name: "discovers_tools",
    instructions: "In this event, the agent looks up which tools exist or fetches a tool's definition before using it.",
    truth: (e) => e.type === "model.message" && toolNames(e).some((n) => n === "list_tools" || n === "get_tool_info"),
  },
  {
    name: "final_answer",
    instructions: "This event is the model's final reply for the turn: it answers without calling any tool.",
    truth: (e) => e.type === "model.message" && toolNames(e).length === 0,
  },
  {
    name: "waits_for_human",
    instructions: "This event pauses the run until a human approves a tool call or answers a question.",
    truth: (e) => e.type === "tool.approval_required" || e.type === "tool.response_required",
    hideType: true,
  },
];

function inputFor(e: Event, hideType: boolean): string {
  // Destructuring with a rest element: everything except the named keys ends up in `rest`.
  const { id: _id, created_at: _at, thread_id: _thread, usage: _usage, type, ...rest } = e;
  return JSON.stringify(hideType ? rest : { type, ...rest }).slice(0, MAX_CHARS);
}

type Answer = Record<string, number | null>; // predicate name -> probability (Decisions) or 0/1 (gpt-oss)

async function decisionsEvent(e: Event): Promise<{ answers: Answer; call: Call }> {
  // Two calls when one predicate needs the type hidden: inputs differ, so they can't share one request.
  const groups = [PREDICATES.filter((p) => !p.hideType), PREDICATES.filter((p) => p.hideType)].filter((g) => g.length);
  const answers: Answer = {};
  const call: Call = { mode: "decisions", ms: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  for (const group of groups) {
    const { ms, result: d } = await timed(() =>
      openai().decisions.create({
        model: DECISIONS_MODEL,
        input: `One persisted event from a TrueForge agent Session:\n${inputFor(e, group[0]?.hideType === true)}`,
        questions: group.map((p) => ({ type: "predicate" as const, name: p.name, instructions: p.instructions })),
      }),
    );
    for (const a of d.answers) if (a.name) answers[a.name] = a.type === "predicate" ? a.probability : null;
    call.ms += ms;
    call.inputTokens += d.usage.input_tokens;
    call.outputTokens += d.usage.output_tokens;
    call.cost += d.usage.input_tokens * DECISIONS_INPUT_PRICE;
  }
  return { answers, call };
}

async function gptOssEvent(e: Event): Promise<{ answers: Answer; call: Call }> {
  const answers: Answer = {};
  const call: Call = { mode: "gpt-oss", ms: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  const groups = [PREDICATES.filter((p) => !p.hideType), PREDICATES.filter((p) => p.hideType)].filter((g) => g.length);
  for (const group of groups) {
    const schema = {
      type: "object",
      properties: Object.fromEntries(group.map((p) => [p.name, { type: "boolean" }])),
      required: group.map((p) => p.name),
      additionalProperties: false,
    };
    const statements = group.map((p) => `- ${p.name}: ${p.instructions}`).join("\n");
    // Built as a separate object so the OpenRouter-only `provider` field passes the
    // SDK's excess-property check (see backends.ts for why Darkbloom is skipped).
    const body = {
      model: BASELINE_MODEL,
      messages: [
        {
          role: "user" as const,
          content: `One persisted event from a TrueForge agent Session:\n${inputFor(e, group[0]?.hideType === true)}\n\nFor each statement, answer true or false:\n${statements}`,
        },
      ],
      response_format: { type: "json_schema" as const, json_schema: { name: "checks", strict: true, schema } },
      reasoning_effort: "low" as const,
      provider: { require_parameters: true, ignore: ["Darkbloom"] },
    };
    const { ms, result: r } = await timed(() => openrouter().chat.completions.create(body));
    const content = r.choices[0]?.message.content;
    const parsed = content ? (JSON.parse(content) as Record<string, boolean>) : {};
    for (const p of group) answers[p.name] = typeof parsed[p.name] === "boolean" ? Number(parsed[p.name]) : null;
    const usage = r.usage as (typeof r.usage & { cost?: number }) | undefined;
    const inT = usage?.prompt_tokens ?? 0;
    const outT = usage?.completion_tokens ?? 0;
    call.ms += ms;
    call.inputTokens += inT;
    call.outputTokens += outT;
    call.cost += usage?.cost ?? inT * BASELINE_PRICES.input + outT * BASELINE_PRICES.output;
  }
  return { answers, call };
}

// Runs `fn` over `items` with at most `limit` in flight; results keep input order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- sample: every model message and pause, plus a fixed slice of everything else ---

const rows = await experimentEvents();
const isPause = (e: Event) => e.type === "tool.approval_required" || e.type === "tool.response_required";
const others = rows.filter((r) => r.event.type !== "model.message" && !isPause(r.event));
const step = Math.max(1, Math.floor(others.length / OTHER_SAMPLE));
const sample = [
  ...rows.filter((r) => r.event.type === "model.message" || isPause(r.event)),
  ...others.filter((_, i) => i % step === 0).slice(0, OTHER_SAMPLE),
].map((r) => r.event);

console.log(`${sample.length} events sampled`);
for (const p of PREDICATES) console.log(`  ${p.name.padEnd(16)} ${sample.filter(p.truth).length} true`);
if (process.argv.includes("--dry-run")) process.exit(0);

// Rough per-event estimates, so the budget check can stop before a mode starts.
if (sample.length * 0.0004 > BUDGET) throw new Error("budget: sample too large for BUDGET");

const results: Record<string, unknown> = {};
for (const [mode, fn] of [
  ["decisions", decisionsEvent],
  ["gpt-oss", gptOssEvent],
] as const) {
  const rs = await mapLimit(sample, CONCURRENCY, async (e) => {
    try {
      return await fn(e);
    } catch (err) {
      console.log(`  ${mode} ${e.type}: ${(err as Error).message}`);
      return { answers: {} as Answer, call: undefined };
    }
  });
  const calls = rs.flatMap((r) => (r.call ? [r.call] : []));
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  console.log(
    `\n${mode}: ${calls.length} events, p50 ${ms[Math.floor(ms.length / 2)]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms, ` +
      `${calls.reduce((n, c) => n + c.inputTokens, 0)} in / ${calls.reduce((n, c) => n + c.outputTokens, 0)} out, ` +
      `$${calls.reduce((n, c) => n + c.cost, 0).toFixed(4)}`,
  );
  const perPredicate: Record<string, unknown> = {};
  for (const p of PREDICATES) {
    const pairs = sample.map((e, i) => ({ truth: p.truth(e), prob: rs[i]?.answers[p.name] ?? null, type: e.type }));
    const scored = pairs.filter((x) => x.prob !== null) as { truth: boolean; prob: number; type: string }[];
    const tp = scored.filter((x) => x.truth && x.prob >= 0.5).length;
    const fp = scored.filter((x) => !x.truth && x.prob >= 0.5).length;
    const fn_ = scored.filter((x) => x.truth && x.prob < 0.5).length;
    // Brier score: mean squared gap between the probability and the 0/1 truth (0 is perfect).
    const brier = scored.reduce((n, x) => n + (x.prob - Number(x.truth)) ** 2, 0) / scored.length;
    const wrong = scored
      .filter((x) => x.truth !== x.prob >= 0.5)
      .map((x) => `${x.type}${x.truth ? "+" : "-"}@${x.prob.toFixed(2)}`);
    perPredicate[p.name] = { tp, fp, fn: fn_, unscored: pairs.length - scored.length, brier, wrong };
    console.log(
      `  ${p.name.padEnd(16)} tp ${tp}  fp ${fp}  fn ${fn_}  unscored ${pairs.length - scored.length}  brier ${brier.toFixed(3)}  ` +
        `wrong: ${wrong.slice(0, 6).join(", ")}${wrong.length > 6 ? " ..." : ""}`,
    );
  }
  results[mode] = { calls, perPredicate, answers: rs.map((r, i) => ({ type: sample[i]?.type, answers: r.answers })) };
}

const outDir = join(import.meta.dirname, "triage-results");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-events.json`);
writeFileSync(file, JSON.stringify({ predicates: PREDICATES.map(({ truth: _t, ...p }) => p), results }, null, 2));
console.log(`wrote ${file}`);

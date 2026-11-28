// Experiment 1, turn-anatomy (#12): one Cartographer Turn, recorded both as it
// streams and as it's persisted. The expectations, written before the first
// run, are in turn-anatomy.expected.md; each check below marks one of them.
//
//   bun run --filter @forge-lab/experiments turn-anatomy -- --model glm-5-3-flash
//   bun run --filter @forge-lab/experiments turn-anatomy -- --model opus-5-5

import type { WireSpec } from "@forge-lab/lib/trueforge";
import { type ExperimentModel, runExperiment, type TurnRun, type Verdict, type WireEvent } from "./lib/experiment";

const PROMPT =
  "Use source_status to get the Source Snapshot's version, then search_text for VALID_TRANSITIONS, and tell me in two sentences which file defines it.";
// Needs some thought, no tools: the answer is 34 (a Fibonacci number).
const PUZZLE =
  "Without using any tools: in how many ways can 8 be written as an ordered sum of 1s and 2s? Reply with the number only.";

type Observed = {
  main: TurnRun[];
  // Only on Opus: the same puzzle at two efforts (E8).
  controls?: { low: TurnRun[]; high: TurnRun[] };
};

// A copy of the spec with another reasoning effort.
const withEffort = (spec: WireSpec, effort: string): WireSpec => ({
  ...spec,
  model: { ...spec.model, params: { ...spec.model.params, reasoning_effort: effort } },
});

await runExperiment<Observed>({
  name: "turn-anatomy",
  dir: import.meta.dir,
  async drive(ctx) {
    const main = await ctx.turn(await ctx.openSession(), PROMPT);
    if (ctx.model !== "opus-5-5") return { main };
    const low = await ctx.turn(await ctx.openSession(withEffort(ctx.spec, "low")), PUZZLE);
    const high = await ctx.turn(await ctx.openSession(withEffort(ctx.spec, "high")), PUZZLE);
    return { main, controls: { low, high } };
  },
  checks: {
    E1: ({ main }) => {
      const types = persisted(main).map((e) => e.type);
      const ok =
        types[0] === "turn.created" &&
        types[1] === "mcp.initialize" &&
        types.at(-1) === "turn.done" &&
        roundsAreWellFormed(persisted(main));
      return verdict(ok, types);
    },
    E2: ({ main }) => {
      const events = persisted(main);
      const inits = events.filter((e) => e.type === "mcp.initialize");
      const firstModel = events.findIndex((e) => e.type === "model.message");
      const servers = inits.flatMap((e) => list(e.mcp_servers).map((s) => str(record(s).name)));
      const ok =
        inits.length === 1 && events.indexOf(inits[0] as WireEvent) < firstModel && servers.join() === "source";
      return verdict(ok, { count: inits.length, servers });
    },
    E3: ({ main }) => {
      // Numbering is per Turn, so each Turn of the run is checked on its own.
      const perTurn = main.map((run) => run.streamed.map((s) => s.seq));
      const ok = perTurn.every((seqs) => seqs.every((n, i) => n === i + 1));
      return verdict(
        ok,
        perTurn.map((seqs) => ({ count: seqs.length, first: seqs[0], last: seqs.at(-1) })),
      );
    },
    E4: ({ main }) => {
      const streamedDeltas = streamed(main).filter((e) => e.type === "model.message.delta").length;
      const persistedDeltas = persisted(main).filter((e) => e.type === "model.message.delta").length;
      return verdict(streamedDeltas > 0 && persistedDeltas === 0, { streamedDeltas, persistedDeltas });
    },
    E5: ({ main }) => {
      const streamIds = streamed(main).map((e) => e.id);
      const missing = persisted(main).filter((e) => !streamIds.includes(e.id));
      // Positions on the stream, in persisted order, must only ever go up.
      const positions = persisted(main).map((e) => streamIds.indexOf(e.id));
      const inOrder = positions.every((p, i) => i === 0 || p > (positions[i - 1] ?? -1));
      return verdict(missing.length === 0 && inOrder, {
        missing: missing.map((e) => `${e.type} ${e.id}`),
        inOrder,
      });
    },
    E6: ({ main }) => {
      const onStream = countBy(streamed(main).filter((e) => e.type === "model.message"));
      const onDisk = countBy(persisted(main).filter((e) => e.type === "model.message"));
      const ok =
        Object.keys(onDisk).length > 0 &&
        Object.entries(onDisk).every(([id, n]) => n === 1 && onStream[id] === 2) &&
        Object.keys(onStream).length === Object.keys(onDisk).length;
      return verdict(ok, { stream: onStream, persisted: onDisk });
    },
    E7: ({ main }, model) => {
      const usage = record(persisted(main).find((e) => e.type === "model.message")?.usage);
      const input = num(usage.input_tokens);
      const breakdown = record(usage.input_tokens_breakdown);
      const instructions = num(breakdown.instructions);
      const [min, max] = model === "opus-5-5" ? [4_500, 7_500] : [4_500, 5_800];
      const ok = input >= min && input <= max && instructions >= 1_300 && instructions <= 1_450;
      return verdict(ok, { input_tokens: input, breakdown, range: [min, max] });
    },
    E8: ({ main, controls }, model) => {
      if (model !== "opus-5-5" || !controls) return na(model);
      const medium = reasoningTokens(main);
      const low = reasoningTokens(controls.low);
      const high = reasoningTokens(controls.high);
      return verdict(medium > 0 && high > low, { medium, low, high });
    },
    E9: ({ main }, model) => {
      const deltas = streamed(main).filter((e) => e.type === "model.message.delta" && str(e.reasoning_content) !== "");
      const messages = persisted(main).filter((e) => e.type === "model.message" && str(e.reasoning_content) !== "");
      const observed = { reasoningDeltas: deltas.length, persistedWithReasoning: messages.length };
      if (model !== "opus-5-5") return { verdict: "n/a", observed };
      return verdict(deltas.length > 0 && messages.length > 0, observed);
    },
    E10: ({ main }) => {
      const last = main.at(-1);
      const ok =
        main.length === 1 &&
        last?.state.status === "done" &&
        (last.state.required_actions ?? []).length === 0 &&
        last.wallMs < 120_000;
      return verdict(ok, { turns: main.length, status: last?.state.status, wallMs: last?.wallMs });
    },
  },
});

// ---------- reading the record ----------

function persisted(runs: TurnRun[]): WireEvent[] {
  return runs.flatMap((r) => r.persisted);
}

function streamed(runs: TurnRun[]): WireEvent[] {
  return runs.flatMap((r) => r.streamed.map((s) => s.event));
}

// Every model.message with tool calls is followed by one tool.response per call
// id before the next model.message, and the last model.message has no calls.
function roundsAreWellFormed(events: WireEvent[]): boolean {
  const messages = events.filter((e) => e.type === "model.message");
  const last = messages.at(-1);
  if (!last || list(last.tool_calls).length > 0 || last.finish_reason !== "stop") return false;
  for (const m of messages.slice(0, -1)) {
    const ids = list(m.tool_calls).map((c) => str(record(c).id));
    const start = events.indexOf(m);
    const next = events.findIndex((e, i) => i > start && e.type === "model.message");
    const responses = events.slice(start + 1, next).filter((e) => e.type === "tool.response");
    const answered = responses.map((r) => str(r.tool_call_id)).sort();
    if (ids.length === 0 || answered.join() !== [...ids].sort().join()) return false;
  }
  return true;
}

function reasoningTokens(runs: TurnRun[]): number {
  return runs.reduce((sum, r) => sum + num(r.state.metrics?.total_reasoning_tokens), 0);
}

function countBy(events: WireEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[str(e.id)] = (out[str(e.id)] ?? 0) + 1;
  return out;
}

// The persisted events are typed only as far as `type` and `id`; these helpers
// narrow the other fields at the point of use instead of trusting a cast.
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function verdict(ok: boolean, observed: unknown): Verdict {
  return { verdict: ok ? "met" : "not met", observed };
}
function na(model: ExperimentModel): Verdict {
  return { verdict: "n/a", observed: `not checked on ${model}` };
}

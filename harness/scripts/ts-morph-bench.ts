// One benchmark pass for ticket #23: how long does ts-morph take to load the
// harness packages and answer the three type-aware source tools, and how much
// memory does it hold? Prints one JSON line. Runs under Bun or Node:
//
//   bun  scripts/ts-morph-bench.ts --snapshot <dir>
//   node scripts/ts-morph-bench.ts --snapshot <dir>
//
// `bun run ts-morph-bench` runs this several times on both and takes medians.

import { performance } from "node:perf_hooks";
// The `.ts` extension is spelled out because Node's ESM loader needs it; Bun accepts it too.
import { findDeclaration, findReferences, importHealth, openIndex, typeOf } from "./lib/source-index.ts";

// Representative symbols: the loop's core class, a capability, the subagent
// capability, a session handle, and a function in the server package whose
// types come from trueforge-core (so it crosses the package boundary).
export const SYMBOLS = [
  "AgentThread",
  "LargeToolResponseProcessor",
  "DynamicSubAgents",
  "SessionHandle",
  "buildTurnSandbox",
] as const;
const WARM_REPEATS = 5;

const flag = process.argv.indexOf("--snapshot");
const root = flag > 0 ? process.argv[flag + 1] : undefined;
if (!root) throw new Error("usage: ts-morph-bench.ts --snapshot <dir>");

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

// Times one call and returns its result alongside the elapsed milliseconds.
// `<T>` makes the helper generic: whatever `fn` returns, `result` has that type.
function timed<T>(fn: () => T): { ms: number; result: T } {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b); // copy first: `sort` mutates in place
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function warm(fn: () => unknown): number {
  return median(Array.from({ length: WARM_REPEATS }, () => timed(fn).ms));
}

const load = timed(() => openIndex(root));
const index = load.result;
const rssAfterLoad = mb();

type ToolTiming = { firstMs: number; warmMs: number; count: number };
const perSymbol: Record<string, Record<string, ToolTiming | string>> = {};
const order: string[] = []; // which call came first, so "first query" is unambiguous

for (const name of SYMBOLS) {
  const decl = timed(() => findDeclaration(index, name));
  const target = decl.result[0];
  perSymbol[name] = {
    find_declaration: { firstMs: decl.ms, warmMs: warm(() => findDeclaration(index, name)), count: decl.result.length },
  };
  order.push(`find_declaration:${name}`);
  if (!target) continue;

  const refs = timed(() => findReferences(index, target.path, target.line, target.column));
  perSymbol[name].find_references = {
    firstMs: refs.ms,
    warmMs: warm(() => findReferences(index, target.path, target.line, target.column)),
    count: refs.result.length,
  };
  order.push(`find_references:${name}`);

  // type_of at a usage in another file, which is what the agent will usually ask about.
  const usage = refs.result.find((r) => !r.isDefinition && r.path !== target.path) ?? target;
  const type = timed(() => typeOf(index, usage.path, usage.line, usage.column));
  perSymbol[name].type_of = {
    firstMs: type.ms,
    warmMs: warm(() => typeOf(index, usage.path, usage.line, usage.column)),
    count: 1,
  };
  perSymbol[name].type_of_sample =
    `${usage.path}:${usage.line} -> ${type.result.typeText}${type.result.isAny ? " (any)" : ""}`;
  order.push(`type_of:${name}`);
}

const rssAfterQueries = mb();

// Stress cases, run after the representative ones (so the Program already exists):
// references to the two most-used harness symbols, then a full semantic check of
// every file. No tool calls the full check; it's the upper bound on how long one
// synchronous call could ever block the event loop, and on memory.
const STRESS = ["Database", "RequestErrorResponseSchema"] as const;
const stress: Record<string, { ms: number; count: number }> = {};
for (const name of STRESS) {
  const target = findDeclaration(index, name)[0];
  if (!target) continue;
  const refs = timed(() => findReferences(index, target.path, target.line, target.column));
  stress[`find_references:${name}`] = { ms: refs.ms, count: refs.result.length };
}
const check = timed(() => index.project.getPreEmitDiagnostics());
stress.full_check = { ms: check.ms, count: check.result.length };
const rssAfterFullCheck = mb();

const health = importHealth(index); // outside all timings

console.log(
  JSON.stringify({
    runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
    files: index.project.getSourceFiles().length,
    loadMs: load.ms,
    rssAfterLoadMb: rssAfterLoad,
    rssAfterQueriesMb: rssAfterQueries,
    rssAfterFullCheckMb: rssAfterFullCheck,
    perSymbol,
    stress,
    order,
    importHealth: health,
  }),
);

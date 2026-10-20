// Ticket #23 driver: runs scripts/ts-morph-bench.ts several times under Bun and
// under Node, each run in a fresh process (cold start is per process), takes
// medians, prints a Markdown table and saves everything to ts-morph-results/.
//
//   bun run ts-morph-bench -- --snapshot <dir> [--runs 7]
//
// The snapshot is TrueForge's source at 198a2ead, fetched outside the repo with
// no dependency install (see ts-morph-results/README.md).

import { saveResults } from "./lib/trueforge";

function arg(name: string): string | undefined {
  const i = Bun.argv.indexOf(name);
  return i > 0 ? Bun.argv[i + 1] : undefined;
}

const snapshot = arg("--snapshot");
if (!snapshot) throw new Error("usage: bun run ts-morph-bench -- --snapshot <dir> [--runs N]");
const runs = Number(arg("--runs") ?? 7);
const bench = `${import.meta.dir}/ts-morph-bench.ts`;

// The shape of the JSON line one bench pass prints. `Record<K, V>` is an object
// type with keys K and values V.
type Timing = { firstMs: number; warmMs: number; count: number };
type Pass = {
  runtime: string;
  files: number;
  loadMs: number;
  rssAfterLoadMb: number;
  rssAfterQueriesMb: number;
  rssAfterFullCheckMb: number;
  perSymbol: Record<string, Record<string, Timing | string>>;
  stress: Record<string, { ms: number; count: number }>;
  order: string[];
  importHealth: Record<string, number>;
  // Added here from /usr/bin/time:
  wallMs: number;
  peakRssMb: number;
};

const RUNTIMES = { bun: [process.execPath], node: ["node", "--no-warnings"] } as const;
type RuntimeName = keyof typeof RUNTIMES; // "bun" | "node", derived from the object above

function runOnce(runtime: RuntimeName): Pass {
  // macOS `time -l` reports wall time and the process's peak RSS (in bytes) on stderr.
  const proc = Bun.spawnSync(["/usr/bin/time", "-l", ...RUNTIMES[runtime], bench, "--snapshot", snapshot as string]);
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) throw new Error(`${runtime} run failed:\n${stderr}`);
  const pass = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Pass;
  pass.wallMs = Number(/([\d.]+) real/.exec(stderr)?.[1]) * 1000;
  pass.peakRssMb = Math.round(Number(/(\d+)\s+maximum resident set size/.exec(stderr)?.[1]) / 1024 / 1024);
  return pass;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

// Alternate runtimes run by run, so background noise on the machine hits both alike.
const passes: Record<RuntimeName, Pass[]> = { bun: [], node: [] };
for (let i = 0; i < runs; i++) {
  for (const runtime of Object.keys(RUNTIMES) as RuntimeName[]) {
    passes[runtime].push(runOnce(runtime));
    process.stdout.write(".");
  }
}
console.log("\n");

const symbols = Object.keys(passes.bun[0]?.perSymbol ?? {});
const TOOLS = ["find_declaration", "find_references", "type_of"] as const;

// Median over runs of one number pulled out of each pass.
function med(runtime: RuntimeName, pick: (p: Pass) => number | undefined): number {
  return median(passes[runtime].map(pick).filter((x): x is number => x !== undefined));
}
const timing = (p: Pass, symbol: string, tool: string) => p.perSymbol[symbol]?.[tool] as Timing | undefined;

type Row = [label: string, bun: number, node: number, unit: string]; // a labelled tuple type
const rows: Row[] = [];
const row = (label: string, unit: string, pick: (p: Pass) => number | undefined) =>
  rows.push([label, med("bun", pick), med("node", pick), unit]);

row("Process wall time (import + load + all queries + full check)", "ms", (p) => p.wallMs);
row(`Cold load: add ${passes.bun[0]?.files} files`, "ms", (p) => p.loadMs);
const firstCall = passes.bun[0]?.order[1] ?? ""; // order[0] is find_declaration, which is AST only
const [firstTool = "", firstSymbol = ""] = firstCall.split(":");
row(`First type-aware query (${firstTool} ${firstSymbol}; builds the Program)`, "ms", (p) => timing(p, firstSymbol, firstTool)?.firstMs);
for (const tool of TOOLS) {
  row(`${tool}: first call, worst symbol`, "ms", (p) => Math.max(...symbols.map((s) => timing(p, s, tool)?.firstMs ?? 0)));
  row(`${tool}: warm, median symbol`, "ms", (p) => median(symbols.map((s) => timing(p, s, tool)?.warmMs ?? Number.NaN)));
}
for (const key of Object.keys(passes.bun[0]?.stress ?? {})) {
  row(`Stress ${key} (${passes.bun[0]?.stress[key]?.count} results)`, "ms", (p) => p.stress[key]?.ms);
}
row("RSS after load", "MB", (p) => p.rssAfterLoadMb);
row("RSS after the representative queries", "MB", (p) => p.rssAfterQueriesMb);
row("RSS after full check", "MB", (p) => p.rssAfterFullCheckMb);
row("Peak RSS (time -l)", "MB", (p) => p.peakRssMb);

const fmt = (n: number, unit: string) => (unit === "MB" ? `${Math.round(n)} MB` : n < 10 ? `${n.toFixed(2)} ms` : `${Math.round(n)} ms`);
const table = [
  `| Metric (median of ${runs} runs) | ${passes.bun[0]?.runtime} | ${passes.node[0]?.runtime} |`,
  "|---|---:|---:|",
  ...rows.map(([label, b, n, unit]) => `| ${label} | ${fmt(b, unit)} | ${fmt(n, unit)} |`),
].join("\n");

// Per-symbol detail (Bun / Node, first then warm), medians over runs.
const detail = [
  "| Symbol | Tool | First (Bun / Node) | Warm (Bun / Node) | Results |",
  "|---|---|---:|---:|---:|",
  ...symbols.flatMap((s) =>
    TOOLS.map(
      (t) =>
        `| \`${s}\` | ${t} | ${fmt(med("bun", (p) => timing(p, s, t)?.firstMs), "ms")} / ${fmt(med("node", (p) => timing(p, s, t)?.firstMs), "ms")} | ${fmt(med("bun", (p) => timing(p, s, t)?.warmMs), "ms")} / ${fmt(med("node", (p) => timing(p, s, t)?.warmMs), "ms")} | ${timing(passes.bun[0] as Pass, s, t)?.count} |`,
    ),
  ),
].join("\n");

console.log(`${table}\n\n${detail}\n`);
console.log("Import health:", JSON.stringify(passes.bun[0]?.importHealth));
console.log(`Saved to ${await saveResults("ts-morph-results", { snapshot, runs, table, detail, passes })}`);

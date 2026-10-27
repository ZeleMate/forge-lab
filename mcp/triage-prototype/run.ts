// PROTOTYPE (#17). Scores every question's pool with the three backends (and the
// free ripgrep ranking) and compares the rankings with the hand labels in questions.json.
//
//   bun run pools                        pools, outlines and the ripgrep baseline only, no API calls, no key
//   bun run triage                       all questions, all modes
//   bun run triage --only q1,q3 --modes decisions-file,gpt-oss-file
//
// Prints a table per question and writes everything to triage-results/<timestamp>.json.
// Stops before any call that would take the run past BUDGET dollars.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSnapshot } from "@forge-lab/lib/snapshot";
import { type Call, type Candidate, decisionsBulk, decisionsFile, gptOssFile, type Scored } from "./backends";
import { openProject, outline } from "./outline";
import { buildPool, type Question } from "./pool";

const BUDGET = 0.5; // the #8 triage cap, reused as this prototype's ceiling
const CONCURRENCY = 6;
const ALL_MODES = ["ripgrep", "decisions-file", "decisions-bulk", "gpt-oss-file"] as const;
type Mode = (typeof ALL_MODES)[number];

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = argv.includes("--dry-run");
const only = flag("--only")?.split(",");
const modes = dryRun ? ["ripgrep" as const] : ((flag("--modes")?.split(",") ?? ALL_MODES) as Mode[]);

const questions = (JSON.parse(readFileSync(join(import.meta.dirname, "questions.json"), "utf8")) as Question[]).filter(
  (q) => !only || only.includes(q.id),
);
if (!questions.length) throw new Error("questions.json has no (matching) questions yet");

const { dir: root, manifest } = openSnapshot();
const project = openProject(root);

let spent = 0;
const calls: (Call & { question: string })[] = [];
function charge(question: string, call: Call) {
  spent += call.cost;
  calls.push({ ...call, question });
}
function guard(estimate: number) {
  if (spent + estimate > BUDGET)
    throw new Error(`budget: $${spent.toFixed(4)} spent, next step ~$${estimate.toFixed(4)}`);
}

// Runs `fn` over `items` with at most `limit` in flight; results keep input order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++; // safe: JS runs one worker at a time between `await`s
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- metrics: binary relevance (labelled or not) against the scores ---

// Probability a random labelled file outscores a random unlabelled one (ties count half).
function auc(scored: Scored[], relevant: Set<string>): number | null {
  const pos = scored.filter((s) => relevant.has(s.path)).map((s) => s.score ?? -1);
  const neg = scored.filter((s) => !relevant.has(s.path)).map((s) => s.score ?? -1);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function ranked(scored: Scored[]): Scored[] {
  return [...scored].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

function recallAt(scored: Scored[], relevant: Set<string>, k: number): number {
  const top = ranked(scored).slice(0, k);
  return top.filter((s) => relevant.has(s.path)).length / relevant.size;
}

// 1 / rank of the first labelled file.
function mrr(scored: Scored[], relevant: Set<string>): number {
  const i = ranked(scored).findIndex((s) => relevant.has(s.path));
  return i < 0 ? 0 : 1 / (i + 1);
}

// --- run ---

const ESTIMATE_PER_CANDIDATE = {
  ripgrep: 0,
  "decisions-file": 0.00006,
  "decisions-bulk": 0.00005,
  "gpt-oss-file": 0.00004,
};
const results: Record<string, unknown>[] = [];

for (const q of questions) {
  const { paths, hits } = buildPool(root, q);
  const candidates: Candidate[] = paths.map((path) => ({ path, text: outline(project, root, path) }));
  const relevant = new Set(q.labels.map((l) => l.path));
  const chars = candidates.reduce((n, c) => n + c.text.length, 0);
  console.log(`\n## ${q.id}: ${q.question}`);
  console.log(
    `pool ${candidates.length} files (${relevant.size} labelled), ~${Math.round(chars / 4)} tokens of outlines`,
  );
  for (const c of candidates)
    console.log(`  ${relevant.has(c.path) ? "*" : " "} ${String(hits.get(c.path) ?? 0).padStart(3)} ${c.path}`);
  const byMode: Record<string, unknown> = {};
  for (const mode of modes) {
    guard(ESTIMATE_PER_CANDIDATE[mode] * candidates.length);
    let scored: Scored[];
    const before = calls.length;
    if (mode === "ripgrep") {
      // The free baseline: rank by how many lines matched the keywords.
      scored = candidates.map((c) => ({ path: c.path, score: hits.get(c.path) ?? 0, confidence: null }));
    } else if (mode === "decisions-bulk") {
      const r = await decisionsBulk(q.question, candidates);
      charge(q.id, r.call);
      scored = r.scored;
    } else {
      const fn = mode === "decisions-file" ? decisionsFile : gptOssFile;
      const rs = await mapLimit(candidates, CONCURRENCY, async (c) => {
        try {
          return await fn(q.question, c);
        } catch (e) {
          // One failed call becomes 'unscored', as the real tool will do.
          console.log(`  ${mode} ${c.path}: ${(e as Error).message}`);
          return { scored: { path: c.path, score: null, confidence: null }, call: undefined };
        }
      });
      for (const r of rs) if (r.call) charge(q.id, r.call);
      scored = rs.map((r) => r.scored);
    }
    const mine = calls.slice(before);
    const metrics = {
      auc: auc(scored, relevant),
      recallAt5: recallAt(scored, relevant, 5),
      mrr: mrr(scored, relevant),
      unscored: scored.filter((s) => s.score === null).length,
      calls: mine.length,
      msTotal: mine.reduce((n, c) => n + c.ms, 0),
      msMax: Math.max(0, ...mine.map((c) => c.ms)),
      inputTokens: mine.reduce((n, c) => n + c.inputTokens, 0),
      outputTokens: mine.reduce((n, c) => n + c.outputTokens, 0),
      cost: mine.reduce((n, c) => n + c.cost, 0),
    };
    byMode[mode] = { metrics, scored: ranked(scored) };
    const f = (x: number | null) => (x === null ? "  -  " : x.toFixed(2));
    console.log(
      `  ${mode.padEnd(15)} auc ${f(metrics.auc)}  r@5 ${f(metrics.recallAt5)}  mrr ${f(metrics.mrr)}  ` +
        `unscored ${metrics.unscored}  ${metrics.calls} calls  max ${metrics.msMax} ms  ` +
        `${metrics.inputTokens} in / ${metrics.outputTokens} out  $${metrics.cost.toFixed(5)}`,
    );
    console.log(
      `    top 5: ${ranked(scored)
        .slice(0, 5)
        .map((s) => `${relevant.has(s.path) ? "*" : ""}${s.path.split("/").pop()} ${f(s.score)}`)
        .join(", ")}`,
    );
  }
  results.push({ id: q.id, question: q.question, labels: q.labels, pool: dryRun ? candidates : paths, modes: byMode });
}

console.log(`\nspent ~$${spent.toFixed(4)} of $${BUDGET}`);
const outDir = join(import.meta.dirname, "triage-results");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}${dryRun ? "-pools" : ""}.json`);
writeFileSync(file, JSON.stringify({ snapshot: manifest.sha, modes, spent, calls, results }, null, 2));
console.log(`wrote ${file}`);

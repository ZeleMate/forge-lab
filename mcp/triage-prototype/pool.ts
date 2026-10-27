// PROTOTYPE (#17). The candidate pool for one question: its labelled files plus
// ripgrep hits for its keywords (hard negatives), most hits first, up to POOL_SIZE.

import { HARNESS_PACKAGES } from "./outline";

export const POOL_SIZE = 30;

export type Label = { path: string; symbols?: string[]; why: string };
export type Question = { id: string; question: string; keywords: string[]; labels: Label[] };

// Paths relative to the snapshot root, with how many lines matched any keyword.
function ripgrep(root: string, keywords: string[]): Map<string, number> {
  const args = ["rg", "--count", "--ignore-case", "--glob", "*.ts"];
  for (const k of keywords) args.push("-e", k);
  args.push(...HARNESS_PACKAGES.map((p) => `${p}/src`));
  // `Bun.spawnSync` runs a child process and waits; `cwd` makes rg print relative paths.
  const out = Bun.spawnSync(args, { cwd: root }).stdout.toString();
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const at = line.lastIndexOf(":");
    if (at > 0) counts.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return counts;
}

export function buildPool(root: string, q: Question): { paths: string[]; hits: Map<string, number> } {
  const hits = ripgrep(root, q.keywords);
  const labelled = q.labels.map((l) => l.path);
  const others = [...hits.entries()]
    .filter(([path]) => !labelled.includes(path))
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);
  // Ordered by hit count, as a search would rank them, so labels don't sit first
  // in the bulk listing (where position could bias the scores).
  const paths = [...labelled, ...others].slice(0, Math.max(POOL_SIZE, labelled.length));
  return { paths: paths.sort((a, b) => (hits.get(b) ?? 0) - (hits.get(a) ?? 0)), hits };
}

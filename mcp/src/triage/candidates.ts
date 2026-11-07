// One candidate file as the judge sees it (#17): its path, its header comment,
// and the first line of every exported declaration, capped at MAX_CHARS. #17
// measured about 140 tokens per file this way. Files outside the ts-morph index
// (docs, YAML, tests) fall back to their first lines.

import { readFileSync } from "node:fs";
import { Node, type SourceFile } from "ts-morph";
import { resolveInside } from "../source/paths";
import type { Snapshot } from "../source/snapshot";

export const MAX_CHARS = 2_000;
const HEADER_CHARS = 600;
const HEAD_CHARS = 200;

export type Candidate = { path: string; text: string };
export type CandidateResult = { ok: true; candidate: Candidate } | { ok: false; path: string; reason: string };

// A declaration up to its body, on one line: `export class Foo extends Bar`.
function head(node: Node): string {
  const text = node.getText();
  const brace = text.indexOf("{");
  const cut = brace > 0 ? text.slice(0, brace) : (text.split("\n")[0] ?? "");
  return cut.replace(/\s+/g, " ").trim().slice(0, HEAD_CHARS);
}

function outline(file: SourceFile): string {
  // The comments before the first statement are the file's header comment.
  const header = (file.getStatements()[0]?.getLeadingCommentRanges() ?? [])
    .map((r) => r.getText())
    .join("\n")
    .slice(0, HEADER_CHARS);
  const heads: string[] = [];
  // `getExportedDeclarations` maps each exported name to its declarations,
  // including ones re-exported from other files.
  for (const [, decls] of file.getExportedDeclarations())
    for (const d of decls) if (d.getSourceFile() === file && Node.isStatement(d)) heads.push(head(d));
  return [header, ...heads].filter(Boolean).join("\n");
}

export function candidateFor(snap: Snapshot, path: string): CandidateResult {
  const resolved = resolveInside(snap.root, path);
  if (!resolved.ok) return { ok: false, path, reason: resolved.reason };
  const indexed = snap.project.getSourceFile(resolved.path);
  let body: string;
  try {
    body = indexed ? outline(indexed) : readFileSync(resolved.path, "utf8").slice(0, MAX_CHARS);
  } catch {
    return { ok: false, path, reason: "not a readable file in the snapshot" };
  }
  return { ok: true, candidate: { path: resolved.rel, text: `${resolved.rel}\n${body}`.slice(0, MAX_CHARS) } };
}

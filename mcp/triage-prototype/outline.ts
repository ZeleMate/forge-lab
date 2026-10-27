// PROTOTYPE (#17). One candidate file as the triage backends see it: its path,
// its leading comment, and the first line of every exported declaration, capped
// at MAX_CHARS. Parse-only ts-morph: no type checker, so it's fast.

import { join, relative } from "node:path";
import { Node, Project, Scope, type SourceFile } from "ts-morph";

export const MAX_CHARS = 2000;

// The same two packages the #23 index loads.
export const HARNESS_PACKAGES = ["packages/trueforge", "packages/trueforge-core"] as const;

export function openProject(root: string): Project {
  // `useInMemoryFileSystem: false` is the default; files are read from disk lazily.
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  for (const pkg of HARNESS_PACKAGES) project.addSourceFilesAtPaths(join(root, pkg, "src/**/*.ts"));
  return project;
}

// The text of a declaration up to its body, on one line: `export class Foo extends Bar`.
function head(node: Node): string {
  if (Node.isFunctionDeclaration(node)) {
    const params = node.getParameters().map((p) => p.getName());
    const returns = node.getReturnTypeNode()?.getText();
    return `export function ${node.getName()}(${params.join(", ")})${returns ? `: ${returns}` : ""}`.slice(0, 200);
  }
  const text = node.getText();
  const brace = text.indexOf("{");
  const cut = brace > 0 ? text.slice(0, brace) : text.split("\n")[0];
  return (cut ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function leadingComment(file: SourceFile): string {
  // The comment ranges before the first statement are the file's header comment.
  const first = file.getStatements()[0];
  const ranges = first?.getLeadingCommentRanges() ?? [];
  return ranges
    .map((r) => r.getText())
    .join("\n")
    .slice(0, 600);
}

export function outline(project: Project, root: string, path: string): string {
  const file = project.getSourceFileOrThrow(join(root, path));
  const lines: string[] = [`File: ${relative(root, file.getFilePath())}`];
  const comment = leadingComment(file);
  if (comment) lines.push(comment);
  for (const statement of file.getStatements()) {
    // `Node.isExportable` is a type guard: inside the `if`, `statement` has `isExported()`.
    if (!Node.isExportable(statement) || !statement.isExported()) continue;
    lines.push(head(statement));
    if (Node.isClassDeclaration(statement)) {
      const methods = statement
        .getMethods()
        .filter((m) => m.getScope() !== Scope.Private && !m.getName().startsWith("#"))
        .map((m) => m.getName());
      if (methods.length) lines.push(`  methods: ${methods.join(", ")}`);
    }
  }
  return lines.join("\n").slice(0, MAX_CHARS);
}

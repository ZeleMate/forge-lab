// A small, read-only ts-morph index over the Source Snapshot's harness packages,
// plus first cuts of the three type-aware source tools (find_declaration,
// find_references, type_of). Written for ticket #23's benchmark.
//
// It uses only `node:` modules and ts-morph, no Bun APIs, so the same file runs
// under Bun and under Node (Node 22.18+ strips the TypeScript types itself).

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
// `type SourceFile` inside the braces is a type-only import: it vanishes when
// the types are stripped, so it costs nothing at runtime.
import { Node, Project, type SourceFile, ts } from "ts-morph";

// The two packages that hold the harness internals (about 412 files at 198a2ead).
export const HARNESS_PACKAGES = ["packages/trueforge", "packages/trueforge-core"] as const;

export type SourceIndex = { root: string; project: Project };

export type Declaration = {
  kind: string;
  name: string;
  path: string;
  line: number;
  column: number;
  exported: boolean;
  signature: string;
};

export type Reference = {
  path: string;
  line: number;
  column: number;
  isDefinition: boolean;
  enclosingSymbol: string | undefined;
  snippet: string;
};

export type TypeOf = { typeText: string; isAny: boolean };

// The snapshot has no node_modules, so `@truefoundry/trueforge-core/...` would
// resolve to nothing. Rebuild the workspace link from trueforge-core's
// package.json `exports` map instead: every entry with a `trueforge-dev`
// condition becomes a TypeScript `paths` entry pointing at the `src/*.ts` file.
function workspacePaths(root: string): Record<string, string[]> {
  const pkgDir = join(root, "packages/trueforge-core");
  // `as { ... }` is a type assertion: JSON.parse returns `any`, and this tells
  // the compiler which shape we expect. It's not checked at runtime.
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, unknown>;
  };
  const paths: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    // `typeof x === "object"` is also true for null, so null needs its own check.
    if (typeof target !== "object" || target === null) continue;
    const dev = (target as Record<string, { types?: string } | undefined>)["trueforge-dev"];
    if (!dev?.types) continue; // `?.` stops at undefined instead of throwing
    const key = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`; // "./core" -> ".../core"
    paths[key] = [join(pkgDir, dev.types)]; // "./*" keeps its "*", which `paths` understands
  }
  return paths;
}

// One long-lived Project over an explicit file list, as research/source-snapshot.md
// recommends: no tsconfig graph, no dependency walk, no diagnostics.
export function openIndex(root: string): SourceIndex {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      // ts-morph re-exports its bundled TypeScript as `ts`, so the enums come from TS 6.0.
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      customConditions: ["trueforge-dev"],
      lib: ["lib.esnext.d.ts"],
      types: [], // don't go looking for @types packages; there are none
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      noEmit: true,
      paths: workspacePaths(root),
    },
  });
  for (const pkg of HARNESS_PACKAGES) project.addSourceFilesAtPaths(join(root, pkg, "src/**/*.ts"));
  return { root, project };
}

function rel(index: SourceIndex, file: SourceFile): string {
  return relative(index.root, file.getFilePath());
}

function lineText(file: SourceFile, line: number): string {
  const starts = file.compilerNode.getLineStarts(); // cached by TypeScript per file
  return file
    .getFullText()
    .slice(starts[line - 1], starts[line])
    .trim()
    .slice(0, 160);
}

// AST only: walks top-level declarations by name, never asks the type checker.
export function findDeclaration(index: SourceIndex, name: string): Declaration[] {
  const out: Declaration[] = [];
  for (const file of index.project.getSourceFiles()) {
    const candidates = [
      file.getClass(name),
      file.getFunction(name),
      file.getInterface(name),
      file.getTypeAlias(name),
      file.getEnum(name),
      file.getVariableDeclaration(name),
    ];
    for (const decl of candidates) {
      if (!decl) continue;
      const start = file.getLineAndColumnAtPos(decl.getNameNode().getStart());
      out.push({
        kind: decl.getKindName(),
        name,
        path: rel(index, file),
        line: start.line,
        column: start.column,
        // `Node.isExportGetable` is a type guard: inside the `&&` the compiler
        // knows `decl` has an `isExported()` method.
        exported: Node.isExportGetable(decl) && decl.isExported(),
        signature: lineText(file, decl.getStartLineNumber()),
      });
    }
  }
  return out;
}

function identifierAt(index: SourceIndex, path: string, line: number, column: number) {
  const file = index.project.getSourceFileOrThrow(join(index.root, path));
  const pos = file.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1);
  const node = file.getDescendantAtPos(pos);
  if (!node || !Node.isIdentifier(node)) throw new Error(`no identifier at ${path}:${line}:${column}`);
  return node;
}

// Type-aware: TypeScript's language service builds the Program and checker on first use.
export function findReferences(index: SourceIndex, path: string, line: number, column: number): Reference[] {
  const out: Reference[] = [];
  for (const symbol of identifierAt(index, path, line, column).findReferences()) {
    for (const entry of symbol.getReferences()) {
      const node = entry.getNode();
      const file = node.getSourceFile();
      const at = file.getLineAndColumnAtPos(node.getStart());
      const enclosing = node
        .getAncestors()
        .find((a) => Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) || Node.isClassDeclaration(a));
      out.push({
        path: rel(index, file),
        line: at.line,
        column: at.column,
        isDefinition: entry.isDefinition() ?? false, // `??` falls back only on null/undefined
        enclosingSymbol: enclosing && Node.hasName(enclosing) ? enclosing.getName() : undefined,
        snippet: lineText(file, at.line),
      });
    }
  }
  return out;
}

export function typeOf(index: SourceIndex, path: string, line: number, column: number): TypeOf {
  const node = identifierAt(index, path, line, column);
  const type = node.getType();
  // Passing the node makes TypeScript print names as they read at that spot,
  // instead of fully qualified `import("...").Name` forms.
  return { typeText: type.getText(node).slice(0, 300), isAny: type.isAny() };
}

// How much of the import graph resolves. Workspace imports should all resolve
// (that's what `paths` is for); third-party ones can't, because the snapshot
// has no node_modules, so their types degrade to `any`.
export function importHealth(index: SourceIndex) {
  let workspaceUnresolved = 0;
  let externalUnresolved = 0;
  let resolved = 0;
  for (const file of index.project.getSourceFiles()) {
    for (const decl of file.getImportDeclarations()) {
      if (decl.getModuleSpecifierSourceFile()) resolved++;
      else if (
        decl.getModuleSpecifierValue().startsWith(".") ||
        decl.getModuleSpecifierValue().startsWith("@truefoundry/")
      )
        workspaceUnresolved++;
      else externalUnresolved++;
    }
  }
  return { resolved, workspaceUnresolved, externalUnresolved };
}

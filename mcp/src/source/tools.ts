// The source server's six tools (#8, build order from #22): status, ripgrep text
// search and file reads first, then the three ts-morph tools. All read-only; every
// result cites `{path, line, sha}` and is labelled `source`.

import { readFileSync, statSync } from "node:fs";
import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { type Identifier, Node, type Project, type SourceFile } from "ts-morph";
import { z } from "zod";
import { fitList, guarded, listCut, maxChars, ok, refuse, SourceCitation } from "../result";
import { checkGlob, resolveInside } from "./paths";
import { search } from "./ripgrep";
import { HARNESS_PACKAGES, type Snapshot } from "./snapshot";

// Annotations are hints the client reads; TrueForge's `@write` and `@destructive`
// Approval selectors match on them (#8), so read-only tools must say so.
export const SOURCE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false, // a closed world: only the pinned snapshot
};

const SNIPPET = 160;
// Input fields shared by the tools that point at one identifier.
const positionInput = {
  path: z.string().describe("File path relative to the snapshot root, as other source tools return it."),
  line: z.number().int().min(1).describe("1-based line."),
  column: z.number().int().min(1).describe("1-based column of the identifier, as find_declaration returns it."),
};

const Declaration = z.object({
  citation: SourceCitation,
  column: z.number().int(),
  kind: z.string(),
  name: z.string(),
  exported: z.boolean(),
  signature: z.string(),
});

export function registerSourceTools(server: McpServer, snap: Snapshot): void {
  const sha7 = snap.sha.slice(0, 7);
  const cite = (path: string, line: number): SourceCitation => ({ path, line, sha: sha7 });

  server.registerTool(
    "source_status",
    {
      title: "Source Snapshot status",
      description:
        "Which TrueForge version and commit the source tools read, and what the ts-morph index covers. Call it first.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        provenance: z.literal("source"),
        version: z.string(),
        sha: z.string(),
        tag_sha: z.string().nullable(),
        fetched_at: z.string(),
        indexed_packages: z.array(z.string()),
        files_indexed: z.number().int(),
        note: z.string(),
      }),
      annotations: SOURCE_ANNOTATIONS,
    },
    guarded(async () =>
      ok({
        provenance: "source",
        version: snap.version,
        sha: snap.sha,
        tag_sha: snap.tagSha,
        fetched_at: snap.fetchedAt,
        indexed_packages: [...HARNESS_PACKAGES],
        files_indexed: snap.project.getSourceFiles().length,
        note: "search_text and read_file cover the whole tree; find_declaration, find_references and type_of cover only the indexed packages' src/. Third-party types are unresolved (no node_modules), so they read as `any`.",
      }),
    ),
  );

  server.registerTool(
    "search_text",
    {
      title: "Search text (ripgrep)",
      description:
        "Search the whole snapshot (code, tests, docs, YAML, config) for text, sorted by path. Literal by default; set regex for a Rust-regex pattern.",
      inputSchema: z.object({
        pattern: z.string().min(1),
        regex: z.boolean().default(false),
        case_sensitive: z.boolean().default(true),
        globs: z
          .array(z.string())
          .default([])
          .describe('ripgrep globs relative to the root, e.g. "packages/trueforge-core/**" or "!**/*.test.ts".'),
        context: z.number().int().min(0).max(3).default(0).describe("Lines of context before and after each match."),
        limit: z.number().int().min(1).max(100).default(30),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("source"),
        matches: z.array(
          z.object({
            citation: SourceCitation,
            text: z.string(),
            before: z.array(z.string()).optional(),
            after: z.array(z.string()).optional(),
          }),
        ),
        limit_reached: z.boolean(),
        ...listCut,
      }),
      annotations: SOURCE_ANNOTATIONS,
    },
    guarded(async (args) => {
      for (const glob of args.globs) {
        const bad = checkGlob(glob.replace(/^!/, "")); // a leading `!` excludes; check what follows
        if (bad) return refuse(`${bad} (${glob})`, "a glob relative to the snapshot root");
      }
      const result = await search(
        snap.root,
        {
          pattern: args.pattern,
          regex: args.regex,
          caseSensitive: args.case_sensitive,
          globs: args.globs,
          context: args.context,
        },
        args.limit,
      );
      if (!result.ok)
        return refuse(result.reason, args.regex ? "check the regex, or set regex: false" : "a simpler pattern");
      const matches = result.hits.map((h) => ({
        citation: cite(h.path, h.line),
        text: h.text,
        // A spread of `{}` adds nothing, so the field is left out when empty.
        ...(h.before.length ? { before: h.before } : {}),
        ...(h.after.length ? { after: h.after } : {}),
      }));
      return ok(
        fitList(
          { provenance: "source" as const, limit_reached: result.limitReached },
          "matches",
          matches,
          args.max_chars,
        ),
      );
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description:
        "Read numbered lines from any file in the snapshot. Reads up to 200 lines unless end_line says otherwise.",
      inputSchema: z.object({
        path: positionInput.path,
        start_line: z.number().int().min(1).default(1),
        end_line: z.number().int().min(1).optional().describe("Inclusive. At most 400 lines after start_line."),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("source"),
        citation: SourceCitation,
        start_line: z.number().int(),
        end_line: z.number().int(),
        total_lines: z.number().int(),
        truncated: z.boolean(),
        text: z.string(),
      }),
      annotations: SOURCE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const file = resolveInside(snap.root, args.path);
      if (!file.ok)
        return refuse(file.reason, "a path relative to the snapshot root, from search_text or find_declaration");
      if (!statSync(file.path).isFile())
        return refuse(`${args.path} is a directory`, "search_text with a glob for that folder");
      const lines = readFileSync(file.path, "utf8").split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop(); // a trailing newline isn't another line
      if (args.start_line > lines.length)
        return refuse(`${args.path} has only ${lines.length} lines`, "a smaller start_line");
      const wanted = Math.min(args.end_line ?? args.start_line + 199, args.start_line + 399, lines.length);
      if (wanted < args.start_line) return refuse("end_line is before start_line", "end_line ≥ start_line");
      const build = (end: number) => ({
        provenance: "source" as const,
        citation: cite(file.rel, args.start_line),
        start_line: args.start_line,
        end_line: end,
        total_lines: lines.length,
        truncated: end < wanted,
        // padStart right-aligns the numbers so the code lines up.
        text: lines
          .slice(args.start_line - 1, end)
          // Cut each line so one minified line can't blow past max_chars.
          .map((l, i) => `${String(args.start_line + i).padStart(5)}| ${l.slice(0, 1000)}`)
          .join("\n"),
      });
      let end = wanted;
      while (end > args.start_line && JSON.stringify(build(end)).length > args.max_chars) end--;
      return ok(build(end));
    }),
  );

  server.registerTool(
    "find_declaration",
    {
      title: "Find a declaration (ts-morph)",
      description:
        'Where a class, function, interface, type, enum or variable is declared in the indexed packages. Use "Class.member" for a method or property.',
      inputSchema: z.object({
        name: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("source"),
        declarations: z.array(Declaration),
        ...listCut,
      }),
      annotations: SOURCE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const found = findDeclarations(snap.project, snap.root, args.name).slice(0, args.limit);
      if (!found.length)
        return refuse(
          `no declaration named ${args.name} in the indexed packages`,
          "search_text for the name, which covers the whole tree",
        );
      // Destructuring with `...rest` collects the remaining fields, so path and
      // line appear only inside the citation.
      const declarations = found.map(({ path, line, ...rest }) => ({ citation: cite(path, line), ...rest }));
      return ok(fitList({ provenance: "source" as const }, "declarations", declarations, args.max_chars));
    }),
  );

  server.registerTool(
    "find_references",
    {
      title: "Find references (ts-morph)",
      description:
        "Every reference to the identifier at path:line:column across the indexed packages, definition first. Type-aware, not text matching.",
      inputSchema: z.object({
        ...positionInput,
        limit: z.number().int().min(1).max(200).default(50),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("source"),
        total: z.number().int(),
        references: z.array(
          z.object({
            citation: SourceCitation,
            column: z.number().int(),
            is_definition: z.boolean(),
            enclosing_symbol: z.string().optional(),
            snippet: z.string(),
          }),
        ),
        ...listCut,
      }),
      annotations: SOURCE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const at = identifierAt(snap, args.path, args.line, args.column);
      if (!at.ok) return at.result;
      const refs = at.node
        .findReferences()
        // One referenced symbol per definition (more through re-exports); `flatMap`
        // maps each to its references and flattens the lists into one.
        .flatMap((symbol) => symbol.getReferences())
        .map((entry) => {
          const node = entry.getNode();
          const file = node.getSourceFile();
          const pos = file.getLineAndColumnAtPos(node.getStart());
          const enclosing = node
            .getAncestors()
            .find((a) => Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) || Node.isClassDeclaration(a));
          return {
            citation: cite(relPath(snap.root, file), pos.line),
            column: pos.column,
            is_definition: entry.isDefinition() ?? false, // `??` falls back only on null/undefined
            // Spreading `{}` adds nothing, so the field is present only when there's a name.
            ...(enclosing && Node.hasName(enclosing) ? { enclosing_symbol: enclosing.getName() } : {}),
            snippet: lineText(file, pos.line),
          };
        })
        // Definitions first, then by path and line, so a cut keeps the most useful.
        .sort(
          (a, b) =>
            Number(b.is_definition) - Number(a.is_definition) ||
            a.citation.path.localeCompare(b.citation.path) ||
            a.citation.line - b.citation.line,
        );
      return ok(
        fitList(
          { provenance: "source" as const, total: refs.length },
          "references",
          refs.slice(0, args.limit),
          args.max_chars,
        ),
      );
    }),
  );

  server.registerTool(
    "type_of",
    {
      title: "Type of an identifier (ts-morph)",
      description:
        "The TypeScript type of the identifier at path:line:column. Third-party types are unresolved in the snapshot, so they come back as `any`, and is_any flags it.",
      inputSchema: z.object(positionInput),
      outputSchema: z.object({
        provenance: z.literal("source"),
        citation: SourceCitation,
        type_text: z.string(),
        is_any: z.boolean(),
        note: z.string().optional(),
      }),
      annotations: SOURCE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const at = identifierAt(snap, args.path, args.line, args.column);
      if (!at.ok) return at.result;
      const type = at.node.getType();
      const isAny = type.isAny();
      return ok({
        provenance: "source",
        citation: cite(at.rel, args.line),
        // Passing the node prints names as they read at that spot, not `import("...").Name`.
        type_text: type.getText(at.node).slice(0, 300),
        is_any: isAny,
        ...(isAny
          ? { note: "`any` here usually means a third-party type the snapshot can't resolve, not an untyped value." }
          : {}),
      });
    }),
  );
}

// One declaration before it gets a citation: `Omit` drops a field from a type, `&` adds two.
type FoundDeclaration = Omit<z.infer<typeof Declaration>, "citation"> & { path: string; line: number };

// AST only: walks top-level declarations by name, never asks the type checker.
// "Class.member" looks inside a class or interface.
export function findDeclarations(project: Project, root: string, name: string): FoundDeclaration[] {
  const [outer, member] = name.split(".", 2);
  if (!outer) return [];
  const out: FoundDeclaration[] = [];
  for (const file of project.getSourceFiles()) {
    const iface = member ? file.getInterface(outer) : undefined;
    const candidates = member
      ? [
          file.getClass(outer)?.getMember(member),
          // Interfaces have no getMember: a member is a property or a method signature.
          iface?.getProperty(member) ?? iface?.getMethod(member),
        ]
      : [
          file.getClass(outer),
          file.getFunction(outer),
          file.getInterface(outer),
          file.getTypeAlias(outer),
          file.getEnum(outer),
          file.getVariableDeclaration(outer),
        ];
    for (const decl of candidates) {
      if (!decl) continue;
      // A class's name node is `Identifier | undefined` (for `export default class {}`);
      // these were found by name, so `?? decl` only satisfies the compiler.
      const nameNode = (Node.hasName(decl) ? decl.getNameNode() : undefined) ?? decl;
      const start = file.getLineAndColumnAtPos(nameNode.getStart());
      out.push({
        path: relPath(root, file),
        line: start.line,
        column: start.column,
        kind: decl.getKindName(),
        name,
        exported: member ? isExported(file, outer) : Node.isExportGetable(decl) && decl.isExported(),
        signature: lineText(file, decl.getStartLineNumber()),
      });
    }
  }
  return out;
}

function isExported(file: SourceFile, name: string): boolean {
  const owner = file.getClass(name) ?? file.getInterface(name);
  return owner?.isExported() ?? false;
}

type IdentifierAt = { ok: true; node: Identifier; rel: string } | { ok: false; result: CallToolResult };

function identifierAt(snap: Snapshot, path: string, line: number, column: number): IdentifierAt {
  const where = `${path}:${line}:${column}`;
  const fail = (reason: string, hint: string): IdentifierAt => ({ ok: false, result: refuse(reason, hint) });
  const file = resolveInside(snap.root, path);
  if (!file.ok) return fail(file.reason, "a path from find_declaration or search_text");
  const source = snap.project.getSourceFile(file.path);
  if (!source)
    return fail(
      `${file.rel} isn't in the ts-morph index`,
      "read_file or search_text; only the indexed packages' src/*.ts are indexed",
    );
  const starts = source.compilerNode.getLineStarts();
  if (line > starts.length) return fail(`${file.rel} has only ${starts.length} lines`, "a line from find_declaration");
  // TypeScript asserts (throws) on a column past the end of the line, so check first.
  const lineEnd = (starts[line] ?? source.getEnd() + 1) - (starts[line - 1] ?? 0);
  if (column > lineEnd)
    return fail(`line ${line} of ${file.rel} is shorter than column ${column}`, "a column from find_declaration");
  const pos = source.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1);
  const node = source.getDescendantAtPos(pos);
  if (!node || !Node.isIdentifier(node))
    return fail(`no identifier at ${where}`, "the column find_declaration returns for the name");
  return { ok: true, node, rel: file.rel };
}

function relPath(root: string, file: SourceFile): string {
  return file.getFilePath().slice(root.length + 1);
}

function lineText(file: SourceFile, line: number): string {
  const starts = file.compilerNode.getLineStarts(); // cached by TypeScript per file
  return file
    .getFullText()
    .slice(starts[line - 1], starts[line])
    .trim()
    .slice(0, SNIPPET);
}

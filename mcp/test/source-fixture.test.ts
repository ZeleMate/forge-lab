// The source tools on the tiny fixture tree: refusals, the `any` flag, and
// what a symlink out of the root can and can't reach.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { call, connect, FIXTURE_SHA, fixtureCopy, fixtureSnapshot, testDeps } from "./helpers";

const SHA7 = FIXTURE_SHA.slice(0, 7);
let client: Client;
let outside: string;
beforeAll(async () => {
  const copy = fixtureCopy();
  outside = copy.outside;
  ({ client } = await connect(testDeps(fixtureSnapshot(copy.root)), "source"));
});

describe("refusals", () => {
  test("read_file refuses `..` out of the root", async () => {
    const r = await call(client, "read_file", { path: "packages/../../outside.ts" });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: the path climbs out of the snapshot");
  });

  test("read_file refuses an absolute path", async () => {
    const r = await call(client, "read_file", { path: outside });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: absolute paths aren't allowed");
  });

  test("read_file refuses a symlink that leads out of the root", async () => {
    const r = await call(client, "read_file", { path: "packages/trueforge/src/escape.ts" });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: the path is a symlink that leads out of the snapshot");
  });

  test("read_file refuses a directory", async () => {
    const r = await call(client, "read_file", { path: "packages/trueforge/src" });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: packages/trueforge/src is a directory");
  });

  test("search_text refuses an absolute or climbing glob", async () => {
    for (const glob of ["/etc/*", "../*", "!../*"]) {
      const r = await call(client, "search_text", { pattern: "secret", globs: [glob] });
      expect(r.isError, glob).toBe(true);
    }
  });

  test("search_text doesn't follow the symlink out of the root", async () => {
    const r = await call(client, "search_text", { pattern: "outside the snapshot" });
    expect(r.isError).toBe(false);
    expect(r.data.matches).toEqual([]);
  });

  test("the symlinked file outside the root isn't in the ts-morph index", async () => {
    const r = await call(client, "find_declaration", { name: "secret" });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: no declaration named secret");
  });

  test("type_of refuses a file outside the ts-morph index", async () => {
    const r = await call(client, "type_of", { path: "README.md", line: 1, column: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: README.md isn't in the ts-morph index");
  });

  test("type_of refuses a position with no identifier", async () => {
    const r = await call(client, "type_of", { path: "packages/trueforge-core/src/core/loop.ts", line: 4, column: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: no identifier at");
  });

  test("type_of refuses a column past the end of the line", async () => {
    const r = await call(client, "type_of", { path: "packages/trueforge-core/src/core/loop.ts", line: 4, column: 200 });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: line 4 of");
  });

  test("a bad regex is a refusal, not a crash", async () => {
    const r = await call(client, "search_text", { pattern: "(unclosed", regex: true });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("refused: ripgrep failed");
  });

  test("an input outside its schema is rejected before the handler runs", async () => {
    const r = await call(client, "search_text", { pattern: "x", limit: 1000 });
    expect(r.isError).toBe(true);
  });
});

describe("results", () => {
  test("source_status describes the fixture snapshot", async () => {
    const r = await call(client, "source_status");
    expect(r.data).toMatchObject({ provenance: "source", sha: FIXTURE_SHA, files_indexed: 4 });
  });

  test("find_declaration finds a class member with its citation", async () => {
    const r = await call(client, "find_declaration", { name: "Loop.run" });
    expect(r.data.declarations).toEqual([
      {
        citation: { path: "packages/trueforge-core/src/core/loop.ts", line: 3, sha: SHA7 },
        column: 3,
        kind: "MethodDeclaration",
        name: "Loop.run",
        exported: true,
        signature: "run(turns: number): number {",
      },
    ]);
  });

  test("find_declaration finds interface members, properties and methods", async () => {
    for (const [name, line] of [
      ["LoopOptions.maxTurns", 13],
      ["LoopOptions.onTurn", 14],
    ] as const) {
      const r = await call(client, "find_declaration", { name });
      expect(r.data.declarations[0].citation.line, name).toBe(line);
    }
  });

  test("find_references follows the workspace import across packages", async () => {
    const r = await call(client, "find_references", {
      path: "packages/trueforge-core/src/core/loop.ts",
      line: 8, // `export function startLoop`
      column: 17,
    });
    const paths = r.data.references.map((x: { citation: { path: string } }) => x.citation.path);
    expect(paths).toContain("packages/trueforge/src/server.ts");
    expect(r.data.references[0].is_definition).toBe(true);
  });

  test("type_of flags an unresolved third-party type as any", async () => {
    const r = await call(client, "type_of", { path: "packages/trueforge/src/server.ts", line: 5, column: 14 });
    expect(r.data).toMatchObject({ provenance: "source", type_text: "any", is_any: true });
    expect(r.data.note).toBeString();
  });

  test("type_of resolves a workspace type", async () => {
    const r = await call(client, "type_of", { path: "packages/trueforge/src/server.ts", line: 4, column: 14 });
    // `server.ts` never imports the name Loop, so TypeScript qualifies it.
    expect(r.data).toMatchObject({ type_text: 'import("@truefoundry/trueforge-core/core").Loop', is_any: false });
  });

  test("search_text returns context lines around a match", async () => {
    const r = await call(client, "search_text", { pattern: "return turns + 1", context: 1 });
    expect(r.data.matches).toEqual([
      {
        citation: { path: "packages/trueforge-core/src/core/loop.ts", line: 4, sha: SHA7 },
        text: "    return turns + 1;",
        before: ["  run(turns: number): number {"],
        after: ["  }"],
      },
    ]);
  });

  test("read_file cuts lines to fit max_chars and says so", async () => {
    const path = "packages/trueforge-core/src/core/events.ts";
    const r = await call(client, "read_file", { path, start_line: 2, max_chars: 1000 });
    expect(r.data.truncated).toBe(true);
    expect(r.data.end_line).toBeLessThan(r.data.total_lines);
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.data.citation).toEqual({ path, line: 2, sha: SHA7 });
  });
});

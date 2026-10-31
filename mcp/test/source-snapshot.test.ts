// The source tools on the real pinned Source Snapshot (#54): facts Cartographer
// relies on, at 0.179.2 / 198a2ead. They change only when the pin moves, which
// is a deliberate event. A missing snapshot fails here ("run `bun run snapshot`")
// instead of skipping.
import { beforeAll, describe, expect, test } from "bun:test";
import { readPin } from "@forge-lab/lib/snapshot";
import type { Client } from "@modelcontextprotocol/client";
import { openSourceSnapshot } from "../src/source/snapshot";
import { call, connect } from "./helpers";

const pin = readPin();
const SHA7 = pin.sha.slice(0, 7);
const AGENT_THREAD = "packages/trueforge-core/src/core/runtime/AgentThread.ts";
let client: Client;

// Building the index takes about 0.3 s warm, a few seconds on a cold disk.
beforeAll(async () => {
  ({ client } = await connect({ source: openSourceSnapshot() }, "source"));
}, 30_000);

describe("the pinned snapshot", () => {
  test("source_status reports the pin and the 419 indexed files", async () => {
    const r = await call(client, "source_status");
    expect(r.data).toMatchObject({ version: pin.version, sha: pin.sha, tag_sha: pin.tagSha, files_indexed: 419 });
  });

  test("find_declaration locates AgentThread", async () => {
    const r = await call(client, "find_declaration", { name: "AgentThread" });
    expect(r.data.declarations).toContainEqual(
      expect.objectContaining({
        citation: { path: AGENT_THREAD, line: 496, sha: SHA7 },
        kind: "ClassDeclaration",
        exported: true,
      }),
    );
  });

  test("find_references reaches AgentThread's users in other folders", async () => {
    const r = await call(client, "find_references", { path: AGENT_THREAD, line: 496, column: 14, limit: 200 });
    expect(r.data.total).toBeGreaterThan(5);
    const folders = new Set(
      r.data.references.map((x: { citation: { path: string } }) => x.citation.path.split("/")[3]),
    );
    expect(folders.size).toBeGreaterThan(1);
  });

  test("search_text sees the generated files TrueForge's .gitignore lists", async () => {
    const r = await call(client, "search_text", { pattern: "sandboxScripts", globs: ["**/*.gen.ts"], limit: 5 });
    expect(r.data.matches.length).toBeGreaterThan(0);
  });

  test("read_file returns the declaration line, numbered", async () => {
    const r = await call(client, "read_file", { path: AGENT_THREAD, start_line: 496, end_line: 496 });
    expect(r.data.text).toBe("  496| export class AgentThread {");
  });

  test("a result stays under max_chars even for a common word", async () => {
    const r = await call(client, "search_text", { pattern: "const", limit: 100, max_chars: 2000 });
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.data.truncated).toBe(true);
  });
});

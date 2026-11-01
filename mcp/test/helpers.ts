// Shared test setup (#54): fixture trees, snapshots and an in-process MCP client.

import { cpSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST, PORTS } from "@forge-lab/lib/ports";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type AppDeps, createApp, type Endpoint } from "../src/app";
import { buildProject, type Snapshot } from "../src/source/snapshot";

export const FIXTURE_TREE = join(import.meta.dir, "fixture-tree");
export const FIXTURE_SHA = "f1x7ure0000000000000000000000000000000000";

// A fresh copy of the fixture tree, plus a file outside it and a symlink inside
// it that points there: git shouldn't hold a link out of the repo, so it's made here.
export function fixtureCopy(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "forge-lab-fixture-"));
  const root = join(base, "snapshot");
  cpSync(FIXTURE_TREE, root, { recursive: true });
  const outside = join(base, "outside.ts");
  writeFileSync(outside, "export const secret = 'outside the snapshot';\n");
  symlinkSync(outside, join(root, "packages/trueforge/src/escape.ts"));
  return { root, outside };
}

// A Snapshot over a fixture copy, built the way production builds one but
// without `openSnapshot()`'s pin and manifest check.
export function fixtureSnapshot(root: string): Snapshot {
  const real = realpathSync(root);
  return {
    root: real,
    version: "0.0.0-fixture",
    sha: FIXTURE_SHA,
    tagSha: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    project: buildProject(real),
  };
}

// An MCP client connected to the app in-process: the client's HTTP requests go
// straight to `app.fetch`, no port involved. The URL still says 127.0.0.1:8791,
// because the app's Host guard checks it.
export async function connect(deps: AppDeps, endpoint: Endpoint) {
  const app = createApp(deps);
  const client = new Client({ name: "forge-lab-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}:${PORTS.mcp}/mcp/${endpoint}`), {
    // `fetch` in the browser and Bun doesn't send a Host header for a plain
    // Request object, so it's set here the way a real socket would.
    fetch: (url, init) => {
      const req = new Request(url, init);
      req.headers.set("host", `${HOST}:${PORTS.mcp}`);
      return app.fetch(req);
    },
  });
  await client.connect(transport);
  return { app, client };
}

// The parsed JSON of a successful tool call, or the text of an isError one.
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary fields of the result JSON; a wrong field fails the assertion anyway
  type Json = Record<string, any>;
  return { isError: result.isError === true, text, data: result.structuredContent as Json };
}

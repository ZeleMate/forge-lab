// Every tool on every endpoint, with the annotations TrueForge's Approval
// selectors read (#8): `@write` matches readOnlyHint false, `@destructive`
// matches destructiveHint true. Adding a tool means adding it here.
import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { ENDPOINTS, type Endpoint } from "../src/app";
import type { Snapshot } from "../src/source/snapshot";
import { connect, fixtureCopy, fixtureSnapshot } from "./helpers";

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const EXPECTED: Record<Endpoint, Record<string, ToolAnnotations>> = {
  source: {
    source_status: READ,
    search_text: READ,
    read_file: READ,
    find_declaration: READ,
    find_references: READ,
    type_of: READ,
  },
  sessions: {}, // #56
  triage: {}, // #57
};

let source: Snapshot;
beforeAll(() => {
  source = fixtureSnapshot(fixtureCopy().root);
});

describe.each([...ENDPOINTS])("/mcp/%s", (endpoint) => {
  test("lists exactly the expected tools, with their annotations and an outputSchema", async () => {
    const { client } = await connect({ source }, endpoint);
    const { tools } = await client.listTools();
    const actual = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(actual).toEqual(EXPECTED[endpoint]);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
  });
});

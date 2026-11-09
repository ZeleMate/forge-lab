// Every tool on every endpoint, with the annotations TrueForge's Approval
// selectors read (#8): `@write` matches readOnlyHint false, `@destructive`
// matches destructiveHint true. Adding a tool means adding it here.
import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { ENDPOINTS, type Endpoint } from "../src/app";
import { CHAT_READ_TOOLS } from "../src/sessions/shared";
import type { Snapshot } from "../src/source/snapshot";
import { connect, fixtureCopy, fixtureSnapshot, testDeps } from "./helpers";

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// `@write` and `@destructive` match these (#8).
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE: ToolAnnotations = { ...WRITE, destructiveHint: true };
// Read-only, so ungated, but it calls an outside API and its answers vary.
const TRIAGE: ToolAnnotations = { ...READ, idempotentHint: false, openWorldHint: true };

const EXPECTED: Record<Endpoint, Record<string, ToolAnnotations>> = {
  source: {
    source_status: READ,
    search_text: READ,
    read_file: READ,
    find_declaration: READ,
    find_references: READ,
    type_of: READ,
  },
  sessions: {
    list_sessions: READ,
    get_turn: READ,
    list_events: READ,
    session_stats: READ,
    wait_turn: READ,
    // Read-only too: Cartographer's spec gates them by name instead (agents/cartographer.ts).
    get_chat_turn: READ,
    list_chat_events: READ,
    fork_turn: WRITE,
    rerun_turn: WRITE,
    cancel_session: DESTRUCTIVE,
  },
  triage: {
    rank_relevance: TRIAGE,
    check_events: TRIAGE,
  },
};

let source: Snapshot;
beforeAll(() => {
  source = fixtureSnapshot(fixtureCopy().root);
});

describe.each([...ENDPOINTS])("/mcp/%s", (endpoint) => {
  test("lists exactly the expected tools, with their annotations and an outputSchema", async () => {
    const { client } = await connect(testDeps(source), endpoint);
    const { tools } = await client.listTools();
    const actual = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(actual).toEqual(EXPECTED[endpoint]);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
  });
});

// The chat-reading tools are read-only, so only their names gate them. A rename
// on either side would quietly drop the Approval, so the spec names exactly these,
// and the server serves them (EXPECTED is checked against its tool list above).
test("Cartographer's spec gates every chat-reading tool by name", async () => {
  // A relative import: the agents package isn't one of mcp's dependencies.
  const { cartographer } = await import("../../agents/cartographer");
  const sessions = cartographer.manifest.mcpServers.find((s) => s.name === "sessions");
  // Literal names only; `@write` and `@destructive` are tags that match annotations.
  const named = (sessions?.requireApprovalForTools ?? []).filter((t) => !t.startsWith("@"));
  expect([...named].sort()).toEqual([...CHAT_READ_TOOLS].sort());
  // And the server really serves each of them under that name.
  for (const tool of CHAT_READ_TOOLS) expect(Object.keys(EXPECTED.sessions)).toContain(tool);
});

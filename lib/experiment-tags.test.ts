// The Experiment Session tags are the contract between the scripts and the MCP
// server, so these tests pin the exact strings on the wire, not just round-trips.
import { describe, expect, test } from "bun:test";
import {
  decodeExperimentTags,
  type ExperimentTags,
  encodeExperimentTags,
  type ReplayState,
  withReplay,
} from "./experiment-tags";

describe("encodeExperimentTags", () => {
  test("a script's root Experiment Session is its name and depth 0", () => {
    // JSON.stringify keeps key order, so this is the body's bytes on the wire.
    expect(JSON.stringify(encodeExperimentTags({ experiment: "smoke-mcp-source", depth: 0 }))).toBe(
      '{"experiment":"smoke-mcp-source","depth":"0"}',
    );
  });

  test("a fork of the user's chat carries its origin and a running replay", () => {
    const tags = encodeExperimentTags({
      experiment: "compaction-trigger",
      depth: 1,
      origin: { sessionId: "chat", turnId: "c2" },
      replay: { status: "running" },
    });
    expect(JSON.stringify(tags)).toBe(
      '{"experiment":"compaction-trigger","depth":"1","origin":"chat:c2","replay":"running"}',
    );
  });

  test.each([10, -1, 1.5, Number.NaN])("refuses depth %p, which a reader would misread", (depth) => {
    expect(() => encodeExperimentTags({ experiment: "x", depth })).toThrow(RangeError);
  });

  test("refuses an empty Experiment name", () => {
    expect(() => encodeExperimentTags({ experiment: "", depth: 0 })).toThrow(RangeError);
  });

  test.each([
    { sessionId: "", turnId: "t1" },
    { sessionId: "s1", turnId: "" },
    { sessionId: "s:1", turnId: "t1" },
    { sessionId: "s1", turnId: "t:1" },
    // TrueForge's placeholders for "a new root" and "the tip" name no Turn.
    { sessionId: "s1", turnId: "none" },
    { sessionId: "s1", turnId: "auto" },
  ])("refuses an origin that wouldn't read back: %p", (origin) => {
    expect(() => encodeExperimentTags({ experiment: "x", depth: 1, origin })).toThrow(RangeError);
  });
});

describe("decodeExperimentTags", () => {
  test("reads back what encoding wrote", () => {
    // Ids in the shape TrueForge records them (from mcp/fixtures-results).
    const origin = { sessionId: "01m6hemt8dkseems6s7t5jrnfj", turnId: "01m6hemw8jchwj35738rh6462j" };
    const tags: ExperimentTags = {
      experiment: "compaction-trigger",
      depth: 1,
      origin,
      replay: { status: "failed", reason: "turn 1 ended error" },
    };
    expect(decodeExperimentTags(encodeExperimentTags(tags))).toEqual({
      experiment: "compaction-trigger",
      depth: { kind: "valid", value: 1 },
      origin: { kind: "valid", value: origin },
      replay: { kind: "valid", value: { status: "failed", reason: "turn 1 ended error" } },
    });
  });

  test("the user's chat has no tags: every one is absent, and other keys are ignored", () => {
    expect(decodeExperimentTags({ probe: "approvals" })).toEqual({
      experiment: undefined,
      depth: { kind: "absent" },
      origin: { kind: "absent" },
      replay: { kind: "absent" },
    });
  });

  test("any present experiment name counts, even an empty one", () => {
    expect(decodeExperimentTags({ experiment: "" }).experiment).toBe("");
  });

  test.each(["0", "2", "9"])("depth %p is one digit", (raw) => {
    expect(decodeExperimentTags({ depth: raw }).depth).toEqual({ kind: "valid", value: Number(raw) });
  });

  test.each(["10", "-1", "1.0", " 1", "", "one"])("depth %p is malformed", (raw) => {
    expect(decodeExperimentTags({ depth: raw }).depth).toMatchObject({ kind: "malformed", raw });
  });

  test.each(["abc", ":t1", "s1:", "s1:t1:x", ":", "", "s1:none", "s1:auto"])("origin %p is malformed", (raw) => {
    expect(decodeExperimentTags({ origin: raw }).origin).toMatchObject({ kind: "malformed", raw });
  });

  // A typed table: without it TypeScript widens each `status` to `string`.
  const states: [string, ReplayState][] = [
    ["running", { status: "running" }],
    ["done", { status: "done" }],
    ["failed:turn 2 wants an Approval", { status: "failed", reason: "turn 2 wants an Approval" }],
    ["failed:", { status: "failed", reason: "" }],
    // Only the first colon splits: a reason may hold colons of its own.
    ["failed:HTTP 500: boom", { status: "failed", reason: "HTTP 500: boom" }],
  ];
  test.each(states)("replay %p reads as a state", (raw, value) => {
    expect(decodeExperimentTags({ replay: raw }).replay).toEqual({ kind: "valid", value });
  });

  test.each(["failed", "Done", "pending", ""])("replay %p is malformed", (raw) => {
    expect(decodeExperimentTags({ replay: raw }).replay).toMatchObject({ kind: "malformed", raw });
  });

  test("a malformed tag says what's wrong, for a refusal message", () => {
    const depth = decodeExperimentTags({ depth: "10" }).depth;
    expect(depth.kind === "malformed" && depth.problem).toContain("one digit");
  });
});

describe("withReplay", () => {
  const tags = { experiment: "x", depth: "1", origin: "chat:c2", replay: "running" };

  test("rewrites only the replay tag, on a copy", () => {
    expect(withReplay(tags, { status: "done" })).toEqual({ ...tags, replay: "done" });
    expect(tags.replay).toBe("running");
  });

  test("a failure's whole tag is cut to 128 characters", () => {
    const replay = withReplay(tags, { status: "failed", reason: "e".repeat(200) }).replay;
    expect(replay).toBe(`failed:${"e".repeat(121)}`);
    expect(replay?.length).toBe(128);
  });

  // "😀" is one code point but two UTF-16 units (a surrogate pair). "failed:"
  // is 7 units, so after 120 more the first emoji straddles the 128-unit limit.
  test("the cut never splits a character in two", () => {
    const reason = `${"e".repeat(120)}😀😀`;
    expect(withReplay(tags, { status: "failed", reason }).replay).toBe(`failed:${"e".repeat(120)}`);
  });

  test("a character that ends exactly at the limit is kept", () => {
    const reason = `${"e".repeat(119)}😀😀`;
    expect(withReplay(tags, { status: "failed", reason }).replay).toBe(`failed:${"e".repeat(119)}😀`);
  });
});

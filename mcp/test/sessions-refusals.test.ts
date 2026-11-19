// Every refusal of the three write tools (#56), one named test each, written
// before the tools (#54). Each asserts the refusal's reason and that TrueForge
// saw no mutating call at all: a refused write must change nothing.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import type { Metadata } from "../src/sessions/api";
import type { Snapshot } from "../src/source/snapshot";
import { call, connect, fixtureCopy, fixtureSnapshot, testDeps } from "./helpers";
import { FakeSessionsApi } from "./sessions-fake";

let source: Snapshot;
beforeAll(() => {
  source = fixtureSnapshot(fixtureCopy().root);
});

// The world every test starts from:
// - `own`: the Session Cartographer is running in (untagged chat unless `ownTags`),
//   whose first Turn holds the `mcp.initialize` naming this connection;
// - `chat`: the user's chat (untagged), one Turn waiting on an Approval;
// - `long`: a chat with 7 Turns, too many to replay;
// - `exp`: an inline Experiment Session at depth 1, with a pending and a running Turn;
// - `deep`: an Experiment Session at depth 2;
// - `named-exp`: an Experiment Session bound to the named Agent, not an inline copy.
async function world(ownTags: Metadata = {}) {
  const fake = new FakeSessionsApi();
  const { client, mcpSessionId } = await connect(testDeps(source, { api: fake }), "sessions");
  if (!mcpSessionId) throw new Error("no Mcp-Session-Id issued");

  fake.addSession("chat");
  fake.addTurn("chat", "c1", { costUsd: 0.02 });
  fake.addTurn("chat", "c2", { costUsd: 0.03 });
  fake.addTurn("chat", "c3", { requiredActions: 1 });

  fake.addSession("long");
  for (let i = 1; i <= 7; i++) fake.addTurn("long", `l${i}`);

  fake.addSession("exp", { metadata: { experiment: "compaction", depth: "1" }, inline: true });
  fake.addTurn("exp", "e1");
  fake.addTurn("exp", "e2", { requiredActions: 2 });
  fake.addTurn("exp", "e3", { status: "running" });

  fake.addSession("deep", { metadata: { experiment: "deep", depth: "2" }, inline: true });
  fake.addTurn("deep", "d1");

  fake.addSession("named-exp", { metadata: { experiment: "named", depth: "0" } });
  fake.addTurn("named-exp", "n1");

  // Added last, so it's the most recently updated Session, as the caller's is.
  fake.addSession("own", { metadata: ownTags, inline: Object.keys(ownTags).length > 0 });
  fake.addTurn("own", "o1");
  fake.addMcpInitialize("o1", mcpSessionId);
  fake.addTurn("own", "o2", { status: "running" });

  return { fake, client };
}

async function expectRefused(
  w: { fake: FakeSessionsApi; client: Client },
  tool: string,
  args: Record<string, unknown>,
  reason: RegExp,
) {
  const r = await call(w.client, tool, args);
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(reason);
  expect(w.fake.mutations()).toEqual([]);
}

describe("fork_turn refuses", () => {
  test("a source Turn that's waiting on an Approval", async () => {
    const w = await world();
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "exp", from_turn_id: "e2", message: "again" },
      /waiting on an Approval/,
    );
  });

  test("a source Turn that's still running", async () => {
    const w = await world();
    await expectRefused(w, "fork_turn", { session_id: "exp", from_turn_id: "e3", message: "again" }, /still running/);
  });

  test("`auto` or `none` instead of a Turn id", async () => {
    const w = await world();
    for (const from_turn_id of ["auto", "none"])
      await expectRefused(w, "fork_turn", { session_id: "exp", from_turn_id, message: "again" }, /explicit Turn id/);
  });

  test("a Session at depth 2", async () => {
    const w = await world();
    await expectRefused(w, "fork_turn", { session_id: "deep", from_turn_id: "d1", message: "again" }, /depth/);
  });

  test("an in-place fork of its own Session", async () => {
    const w = await world({ experiment: "self", depth: "0" });
    await expectRefused(w, "fork_turn", { session_id: "own", from_turn_id: "o1", message: "again" }, /own Session/);
  });

  test("a replay that would be depth 2 (the caller is already depth 1)", async () => {
    const w = await world({ experiment: "nested", depth: "1" });
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "chat", from_turn_id: "c2", message: "again", experiment: "nested-fork", estimated_cost_usd: 1 },
      /depth/,
    );
  });

  test("a replay of more than 5 user Turns", async () => {
    const w = await world();
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "long", from_turn_id: "l7", message: "again", experiment: "too-long", estimated_cost_usd: 1 },
      /more than 5/,
    );
  });

  test("a replay without an experiment name", async () => {
    const w = await world();
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "chat", from_turn_id: "c2", message: "again", estimated_cost_usd: 1 },
      /experiment name/,
    );
  });

  test("a replay without an estimated cost, or one far below the source's", async () => {
    const w = await world();
    const args = { session_id: "chat", from_turn_id: "c2", message: "again", experiment: "cheap" };
    await expectRefused(w, "fork_turn", args, /estimated_cost_usd/);
    // c1 and c2 cost $0.05 together; claiming $0.001 hides that from the Approval.
    await expectRefused(w, "fork_turn", { ...args, estimated_cost_usd: 0.001 }, /estimated_cost_usd/);
  });

  test("any write when it can't tell which Session it's in", async () => {
    const fake = new FakeSessionsApi();
    const { client } = await connect(testDeps(source, { api: fake }), "sessions");
    fake.addSession("exp", { metadata: { experiment: "x", depth: "0" }, inline: true });
    fake.addTurn("exp", "e1");
    await expectRefused(
      { fake, client },
      "fork_turn",
      { session_id: "exp", from_turn_id: "e1", message: "again" },
      /can't tell which Session/,
    );
  });

  test("a caller_session_id that contradicts the detected Session", async () => {
    const w = await world();
    // Claiming to be `exp` would let an in-place fork of `own` through.
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "own", from_turn_id: "o1", message: "again", caller_session_id: "exp" },
      /isn't the Session I'm running in/,
    );
  });

  test("a caller_session_id naming a Session that isn't mid-Turn", async () => {
    const fake = new FakeSessionsApi();
    const { client } = await connect(testDeps(source, { api: fake }), "sessions");
    fake.addSession("exp", { metadata: { experiment: "x", depth: "0" }, inline: true });
    fake.addTurn("exp", "e1");
    fake.addSession("idle");
    fake.addTurn("idle", "i1");
    await expectRefused(
      { fake, client },
      "fork_turn",
      { session_id: "exp", from_turn_id: "e1", message: "again", caller_session_id: "idle" },
      /can't tell which Session/,
    );
  });

  test("an in-place write on a running Session when the caller is unverified", async () => {
    const fake = new FakeSessionsApi();
    const { client } = await connect(testDeps(source, { api: fake }), "sessions");
    // No `mcp.initialize` names this connection: `caller` is only a claim, and
    // `busy`'s running Turn could be the real caller.
    fake.addSession("busy", { metadata: { experiment: "x", depth: "0" }, inline: true });
    fake.addTurn("busy", "b1");
    fake.addTurn("busy", "b2", { status: "running" });
    fake.addSession("caller");
    fake.addTurn("caller", "k1", { status: "running" });
    const w = { fake, client };
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "busy", from_turn_id: "b1", message: "x", caller_session_id: "caller" },
      /could be mine/,
    );
    await expectRefused(w, "cancel_session", { session_id: "busy", caller_session_id: "caller" }, /could be mine/);
  });

  test("a replay when the caller is unverified (it counts as depth 1)", async () => {
    const fake = new FakeSessionsApi();
    const { client } = await connect(testDeps(source, { api: fake }), "sessions");
    fake.addSession("chat");
    fake.addTurn("chat", "c1");
    fake.addSession("caller");
    fake.addTurn("caller", "k1", { status: "running" });
    await expectRefused(
      { fake, client },
      "fork_turn",
      {
        session_id: "chat",
        from_turn_id: "c1",
        message: "x",
        experiment: "unverified",
        estimated_cost_usd: 1,
        caller_session_id: "caller",
      },
      /depth 1 \(assumed/,
    );
  });

  test("a config_patch key outside the allowlist", async () => {
    const w = await world();
    const r = await call(w.client, "fork_turn", {
      session_id: "exp",
      from_turn_id: "e1",
      message: "again",
      config_patch: { instructions: "be someone else" },
    });
    expect(r.isError).toBe(true);
    expect(w.fake.mutations()).toEqual([]);
  });

  test("a config_patch value the spec schema rejects", async () => {
    const w = await world();
    // An Experiment Session with nothing running, so only the patch is wrong.
    w.fake.addSession("idle-exp", { metadata: { experiment: "idle", depth: "0" }, inline: true });
    w.fake.addTurn("idle-exp", "i1");
    await expectRefused(
      w,
      "fork_turn",
      {
        session_id: "idle-exp",
        from_turn_id: "i1",
        message: "again",
        config_patch: { context_management: { compaction: { trigger: { type: "never-heard-of-it" } } } },
      },
      /config_patch/,
    );
  });

  test("a config_patch on an Experiment Session bound to the named Agent", async () => {
    const w = await world();
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "named-exp", from_turn_id: "n1", message: "again", config_patch: { iteration_limit: 5 } },
      /named Agent/,
    );
  });
});

describe("in-place writes refuse a Session with a running Turn", () => {
  test("fork_turn in place", async () => {
    const w = await world();
    // `exp` has e3 running; forking from the finished e1 would leave e3 off the tip.
    await expectRefused(
      w,
      "fork_turn",
      { session_id: "exp", from_turn_id: "e1", message: "again" },
      /running Turn; a fork in place/,
    );
  });

  test("rerun_turn", async () => {
    const w = await world();
    await expectRefused(w, "rerun_turn", { session_id: "exp", turn_id: "e1" }, /running Turn; a re-run/);
  });
});

describe("rerun_turn refuses", () => {
  test("the user's chat (not an Experiment Session)", async () => {
    const w = await world();
    await expectRefused(w, "rerun_turn", { session_id: "chat", turn_id: "c1" }, /not an Experiment Session/);
  });

  test("a Turn that's waiting on an Approval", async () => {
    const w = await world();
    await expectRefused(w, "rerun_turn", { session_id: "exp", turn_id: "e2" }, /waiting on an Approval/);
  });

  test("a Turn that's still running", async () => {
    const w = await world();
    await expectRefused(w, "rerun_turn", { session_id: "exp", turn_id: "e3" }, /still running/);
  });

  test("`auto` or `none` instead of a Turn id", async () => {
    const w = await world();
    await expectRefused(w, "rerun_turn", { session_id: "exp", turn_id: "auto" }, /explicit Turn id/);
  });

  test("its own Session", async () => {
    const w = await world({ experiment: "self", depth: "0" });
    await expectRefused(w, "rerun_turn", { session_id: "own", turn_id: "o1" }, /own Session/);
  });

  test("a Session at depth 2", async () => {
    const w = await world();
    await expectRefused(w, "rerun_turn", { session_id: "deep", turn_id: "d1" }, /depth/);
  });
});

describe("source Turn refusals", () => {
  test("fork_turn from a Turn that doesn't exist", async () => {
    const w = await world();
    await expectRefused(w, "fork_turn", { session_id: "exp", from_turn_id: "nope", message: "x" }, /no Turn nope/);
  });

  test("rerun_turn of a Turn that answered an Approval instead of a user message", async () => {
    const w = await world();
    // An idle Experiment Session, so the input is the only thing wrong.
    w.fake.addSession("idle-exp", { metadata: { experiment: "idle", depth: "0" }, inline: true });
    w.fake.addTurn("idle-exp", "i1");
    w.fake.addTurn("idle-exp", "i2", {
      input: [{ type: "user.tool_approval", threadId: "main", toolCallId: "call-0", approval: { status: "allow" } }],
    });
    await expectRefused(w, "rerun_turn", { session_id: "idle-exp", turn_id: "i2" }, /wasn't started by a user message/);
  });
});

describe("cancel_session refuses", () => {
  test("the user's chat (not an Experiment Session)", async () => {
    const w = await world();
    await expectRefused(w, "cancel_session", { session_id: "chat" }, /not an Experiment Session/);
  });

  test("its own Session", async () => {
    const w = await world({ experiment: "self", depth: "0" });
    await expectRefused(w, "cancel_session", { session_id: "own" }, /own Session/);
  });

  test("a Session whose tip isn't running", async () => {
    const w = await world();
    await expectRefused(w, "cancel_session", { session_id: "named-exp" }, /nothing to cancel/);
  });

  test("a Session at depth 2", async () => {
    const w = await world();
    await expectRefused(w, "cancel_session", { session_id: "deep" }, /depth/);
  });
});

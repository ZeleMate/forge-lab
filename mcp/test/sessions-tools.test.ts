// The sessions tools' working paths (#56), against the fake TrueForge: the
// reads' projections, wait_turn on the fake clock, and what each write sends.
import { beforeAll, describe, expect, test } from "bun:test";
import { serialization } from "@truefoundry/trueforge-sdk";
import { collectTurns, MAX_TURNS, TooManyTurnsError, type Turn } from "../src/sessions/api";
import { branchTo } from "../src/sessions/replay";
import { applyConfigPatch, deepMerge } from "../src/sessions/spec";
import type { Snapshot } from "../src/source/snapshot";
import { call, connect, fakeClock, fixtureCopy, fixtureSnapshot, testDeps } from "./helpers";
import { FakeSessionsApi, SPEC } from "./sessions-fake";

let source: Snapshot;
beforeAll(() => {
  source = fixtureSnapshot(fixtureCopy().root);
});

async function setup() {
  const fake = new FakeSessionsApi();
  const clock = fakeClock();
  const tasks: Promise<void>[] = [];
  const { client, mcpSessionId } = await connect(
    testDeps(source, { api: fake, clock, spawn: (t) => tasks.push(t) }),
    "sessions",
  );
  fake.addSession("chat");
  fake.addTurn("chat", "c1", { text: "how does compaction fire?", costUsd: 0.02 });
  fake.addTurn("chat", "c2", { text: "show me the trigger", costUsd: 0.03 });
  fake.addSession("exp", { metadata: { experiment: "compaction", depth: "0" }, inline: true });
  fake.addTurn("exp", "e1");
  fake.addTurn("exp", "e2", { previous: "e1" });
  fake.addSession("own");
  fake.addTurn("own", "o1");
  fake.addMcpInitialize("o1", mcpSessionId ?? "");
  fake.addTurn("own", "o2", { status: "running" });
  return { fake, clock, client, tasks };
}

describe("reads", () => {
  test("list_sessions filters by experiment tag and labels Experiment Sessions", async () => {
    const { client } = await setup();
    const r = await call(client, "list_sessions", { experiment: "compaction" });
    expect(r.isError).toBe(false);
    expect(r.data.provenance).toBe("observed");
    expect(r.data.sessions.map((s: { citation: { session_id: string } }) => s.citation.session_id)).toEqual(["exp"]);
    expect(r.data.sessions[0]).toMatchObject({ agent: "inline", experiment: true });
  });

  test("list_sessions refuses an unknown Agent name", async () => {
    const { client } = await setup();
    const r = await call(client, "list_sessions", { agent_name: "nobody" });
    expect(r.isError).toBe(true);
  });

  test("get_chat_turn shows the newest Turn by default, and every Turn newest first", async () => {
    const { client } = await setup();
    const r = await call(client, "get_chat_turn", { session_id: "chat" });
    expect(r.data.turn.citation).toEqual({ session_id: "chat", turn_id: "c2" });
    expect(r.data.turn.input).toBe("show me the trigger");
    expect(r.data.turns.map((t: { citation: { turn_id: string } }) => t.citation.turn_id)).toEqual(["c2", "c1"]);
  });

  test("list_events cites every event and filters by type", async () => {
    const { client } = await setup();
    const r = await call(client, "list_events", { session_id: "own", turn_id: "o1", types: ["mcp.initialize"] });
    expect(r.data.events).toEqual([
      expect.objectContaining({
        type: "mcp.initialize",
        citation: { session_id: "own", turn_id: "o1", event_id: "o1-mcp" },
        servers: ["source", "sessions"],
      }),
    ]);
  });

  test("get_turn reads an Experiment Session without asking", async () => {
    const { client } = await setup();
    const r = await call(client, "get_turn", { session_id: "exp" });
    expect(r.isError).toBe(false);
    expect(r.data.turn.citation).toEqual({ session_id: "exp", turn_id: "e2" });
  });

  // The user's other chats need an Approval; the Session the tools run in is
  // already in the model's context, so reading it reveals nothing new.
  for (const [tool, args] of [
    ["get_turn", { session_id: "chat" }],
    ["list_events", { session_id: "chat", turn_id: "c1" }],
    ["wait_turn", { session_id: "chat", turn_id: "c1", timeout_s: 1 }],
  ] as const) {
    test(`${tool} refuses the user's chat and points to the Approval-gated tools`, async () => {
      const { client } = await setup();
      const r = await call(client, tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/the user's chat/);
      expect(r.text).toMatch(/get_chat_turn/);
    });
  }

  test("an Experiment Session that replays a chat is still read without asking", async () => {
    const { fake, client } = await setup();
    fake.addSession("replay", { metadata: { experiment: "x", depth: "1", origin: "chat:c1" }, inline: true });
    fake.addTurn("replay", "r1");
    const r = await call(client, "get_turn", { session_id: "replay" });
    expect(r.isError).toBe(false);
  });

  test("list_chat_events reads the user's chat", async () => {
    const { client } = await setup();
    const r = await call(client, "list_chat_events", { session_id: "chat", turn_id: "c1" });
    expect(r.isError).toBe(false);
    expect(r.data.provenance).toBe("observed");
  });

  test("session_stats takes a running Turn's figures from its events", async () => {
    const { client } = await setup();
    const r = await call(client, "session_stats", { session_id: "own" });
    const [running, done] = r.data.turns;
    expect(running).toMatchObject({ status: "running", metrics_from: "events" });
    expect(done).toMatchObject({ status: "done", metrics_from: "turn" });
  });
});

describe("wait_turn", () => {
  test("polls every 2 s until the Turn finishes", async () => {
    const { fake, clock, client } = await setup();
    // `own`'s Turn o2 stays running; make the fake finish it on the third read.
    let reads = 0;
    const getTurn = fake.getTurn.bind(fake);
    fake.getTurn = async (s, t) => {
      const turn = await getTurn(s, t);
      reads += 1;
      return reads >= 3
        ? { ...turn, state: { status: "cancelled", completedAt: "x", reason: "client-cancelled" } }
        : turn;
    };
    const r = await call(client, "wait_turn", { session_id: "own", turn_id: "o2", timeout_s: 30 });
    expect(r.data).toMatchObject({ still_running: false, waited_ms: 4_000 });
    expect(clock.slept).toEqual([2_000, 2_000]);
  });

  test("gives up at timeout_s and says still_running", async () => {
    const { clock, client } = await setup();
    const r = await call(client, "wait_turn", { session_id: "own", turn_id: "o2", timeout_s: 5 });
    expect(r.data).toMatchObject({ still_running: true, waited_ms: 5_000 });
    expect(clock.slept).toEqual([2_000, 2_000, 1_000]);
  });
});

describe("writes", () => {
  test("fork_turn in an Experiment Session forks in place from the named Turn", async () => {
    const { fake, client } = await setup();
    const r = await call(client, "fork_turn", { session_id: "exp", from_turn_id: "e1", message: "try again" });
    expect(r.data).toMatchObject({ mode: "in-place", context: "kept" });
    expect(fake.mutations()).toEqual([
      {
        method: "createTurn",
        args: ["exp", { input: [{ type: "user.message", content: "try again" }], previousTurnId: "e1" }],
      },
    ]);
  });

  test("fork_turn from the user's chat replays into a new tagged inline Session", async () => {
    const { fake, client, tasks } = await setup();
    const r = await call(client, "fork_turn", {
      session_id: "chat",
      from_turn_id: "c2",
      message: "and with a lower trigger?",
      experiment: "compaction-trigger",
      estimated_cost_usd: 0.05,
      config_patch: { iteration_limit: 5 },
    });
    expect(r.data).toMatchObject({ mode: "replay", context: "replayed", status: "replaying" });
    const id: string = r.data.citation.session_id;
    await Promise.all(tasks);

    const [created, ...rest] = fake.mutations();
    expect(created?.method).toBe("createSession");
    const body = created?.args[0] as { spec: typeof SPEC; metadata: Record<string, string> };
    expect(body.metadata).toEqual({
      experiment: "compaction-trigger",
      depth: "1",
      origin: "chat:c2",
      replay: "running",
    });
    expect(body.spec.config?.iterationLimit).toBe(5);
    // The chat itself is never written to.
    expect(fake.mutations().some((c) => c.args[0] === "chat")).toBe(false);

    // c1, c2, then the new message, each chained on the one before.
    const turns = rest.filter((c) => c.method === "createTurn").map((c) => c.args[1]);
    expect(turns).toEqual([
      { input: [{ type: "user.message", content: "how does compaction fire?" }], previousTurnId: "none" },
      { input: [{ type: "user.message", content: "show me the trigger" }], previousTurnId: `${id}-t1` },
      { input: [{ type: "user.message", content: "and with a lower trigger?" }], previousTurnId: `${id}-t2` },
    ]);
    expect(fake.session(id).metadata.replay).toBe("done");
  });

  test("a replay stops and says so when a replayed Turn fails", async () => {
    const { fake, client, tasks } = await setup();
    fake.finishCreatedTurnsAs = "error";
    const r = await call(client, "fork_turn", {
      session_id: "chat",
      from_turn_id: "c2",
      message: "again",
      experiment: "fails",
      estimated_cost_usd: 0.05,
    });
    await Promise.all(tasks);
    expect(fake.session(r.data.citation.session_id).metadata.replay).toBe("failed:turn 1 ended error");
    expect(fake.mutations().filter((c) => c.method === "createTurn")).toHaveLength(1);
  });

  test("rerun_turn patches the inline spec, then re-runs the input from the same parent", async () => {
    const { fake, client } = await setup();
    const r = await call(client, "rerun_turn", {
      session_id: "exp",
      turn_id: "e2",
      config_patch: { context_management: { compaction: { trigger: { value: 2_000 } } } },
    });
    expect(r.data).toMatchObject({ mode: "in-place" });
    const [update, create] = fake.mutations();
    expect(update?.method).toBe("updateSession");
    const spec = (update?.args[1] as { spec: typeof SPEC } | undefined)?.spec;
    // Merged, not replaced: the trigger's type survives next to the new value.
    expect(spec?.config?.contextManagement).toEqual({
      compaction: { trigger: { type: "input_tokens", value: 2_000 } },
    });
    expect(spec?.instructions).toBe(SPEC.instructions);
    expect(create?.args[1]).toEqual({
      input: [{ type: "user.message", content: "question for e2" }],
      previousTurnId: "e1",
    });
  });

  test("cancel_session cancels an Experiment Session whose tip is running", async () => {
    const { fake, client } = await setup();
    fake.addTurn("exp", "e3", { status: "running" });
    const r = await call(client, "cancel_session", { session_id: "exp" });
    expect(r.data).toMatchObject({ mode: "cancel", citation: { session_id: "exp", turn_id: "e3" } });
    expect(fake.mutations()).toEqual([{ method: "cancel", args: ["exp"] }]);
  });

  test("caller_session_id counts only when the Session can't be detected", async () => {
    const fake = new FakeSessionsApi();
    const { client } = await connect(testDeps(source, { api: fake }), "sessions");
    // No `mcp.initialize` names this connection, so the override is used.
    fake.addSession("exp", { metadata: { experiment: "x", depth: "0" }, inline: true });
    fake.addTurn("exp", "e1");
    fake.addSession("caller");
    fake.addTurn("caller", "k1", { status: "running" }); // the caller is mid-Turn
    const r = await call(client, "fork_turn", {
      session_id: "exp",
      from_turn_id: "e1",
      message: "x",
      caller_session_id: "caller",
    });
    expect(r.data).toMatchObject({ mode: "in-place" });
  });

  test("a failed create after config_patch says the spec already changed", async () => {
    const { fake, client } = await setup();
    fake.createTurn = async () => {
      throw new Error("HTTP 412");
    };
    const r = await call(client, "rerun_turn", {
      session_id: "exp",
      turn_id: "e2",
      config_patch: { iteration_limit: 5 },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 412.*already patched/);
  });
});

describe("config_patch merge", () => {
  test("objects merge key by key; other values are replaced", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] })).toEqual({ a: { b: 1, c: 3 }, d: [2] });
  });

  test("model.params lands on the model, the rest under config", () => {
    const patched = applyConfigPatch(SPEC, { model: { params: { max_tokens: 1_024 } }, sandbox: { enabled: false } });
    if (!patched.ok) throw new Error(patched.reason);
    expect(patched.spec.model).toEqual({ name: SPEC.model.name, params: { maxTokens: 1_024 } });
    expect(patched.spec.config?.sandbox?.enabled).toBe(false);
    expect(patched.spec.config?.iterationLimit).toBe(40);
    // Still a spec the SDK can send.
    expect(() => serialization.AgentSpec.jsonOrThrow(patched.spec)).not.toThrow();
  });

  test("an unknown key inside an allowed object is refused, not dropped", () => {
    const patched = applyConfigPatch(SPEC, { dynamic_sub_agents: { enabeld: true } });
    expect(patched.ok).toBe(false);
  });
});

describe("the Turn cap", () => {
  // An `async function*` is an async generator, like the SDK's auto-paging Page.
  async function* pages(n: number) {
    for (let i = 0; i < n; i++) yield { id: `t${i}` } as Turn;
  }

  test("every Turn comes back at the cap", async () => {
    expect(await collectTurns("s", pages(MAX_TURNS))).toHaveLength(MAX_TURNS);
  });

  test("past the cap it throws instead of losing the newest Turns", async () => {
    await expect(collectTurns("s", pages(MAX_TURNS + 1))).rejects.toBeInstanceOf(TooManyTurnsError);
  });

  test("get_turn reports it as an error, not an older Turn as the newest", async () => {
    const { fake, client } = await setup();
    fake.listTurns = async () => {
      throw new TooManyTurnsError("exp");
    };
    const r = await call(client, "get_turn", { session_id: "exp" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/more than 200 Turns/);
  });

  test("an oversized Session doesn't stop the own-Session scan", async () => {
    const { fake, client } = await setup();
    fake.addSession("huge"); // the most recently updated, so it's scanned first
    const listTurns = fake.listTurns.bind(fake);
    fake.listTurns = async (id) => {
      if (id === "huge") throw new TooManyTurnsError(id);
      return listTurns(id);
    };
    // The scan still detects `own`, so the fork goes ahead instead of "can't tell".
    const r = await call(client, "fork_turn", { session_id: "exp", from_turn_id: "e1", message: "x" });
    expect(r.data).toMatchObject({ mode: "in-place" });
  });
});

describe("branchTo", () => {
  test("follows previous_turn_id from the root, ignoring other branches", async () => {
    const fake = new FakeSessionsApi();
    fake.addSession("s");
    fake.addTurn("s", "a", { previous: null });
    fake.addTurn("s", "b", { previous: "a" });
    fake.addTurn("s", "fork", { previous: "a" });
    fake.addTurn("s", "c", { previous: "b" });
    expect(branchTo(fake.turnsOf("s"), "c").map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

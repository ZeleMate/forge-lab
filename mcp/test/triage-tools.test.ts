// The triage tools (#57) against a fake `decide()` with hand-written answers:
// ranking by `score` (never `confidence`), `unscored` with a reason when there's
// no backend, the budget is spent or a call fails, and check_events reading
// only Experiment Sessions with each event's type in the input.
import { beforeAll, describe, expect, test } from "bun:test";
import type { SessionEvent } from "../src/sessions/api";
import type { Snapshot } from "../src/source/snapshot";
import type { Decide, Judged, Question } from "../src/triage/decide";
import { CONCURRENCY, mapLimit } from "../src/triage/tools";
import { call, connect, fakeClock, fixtureCopy, fixtureSnapshot, testDeps, tmpBudget } from "./helpers";
import { FakeSessionsApi } from "./sessions-fake";

let source: Snapshot;
beforeAll(() => {
  source = fixtureSnapshot(fixtureCopy().root);
});

// Paths in the fixture tree; loop.ts is the one the fake judge likes best.
const LOOP = "packages/trueforge-core/src/core/loop.ts";
const EVENTS = "packages/trueforge-core/src/core/events.ts";
const SERVER = "packages/trueforge/src/server.ts";

type Calls = { input: string; questions: Question[] }[];

// A fake judge that records every call. `scores` maps a path to its score;
// `probability` answers every predicate. It costs $0.001 per call.
function fakeDecide(opts: { scores?: Record<string, number | null>; probability?: number; fail?: string } = {}) {
  const calls: Calls = [];
  const judged = (answers: Judged["answers"]): Judged => ({ answers, costUsd: 0.001, ms: 1 });
  const decide: Decide = {
    backend: "decisions",
    estimateUsd: () => 0.001,
    async score(input, questions) {
      calls.push({ input, questions });
      if (opts.fail) throw new Error(opts.fail);
      // Each question names its candidate's path in its instructions.
      return judged(
        Object.fromEntries(
          questions.map((q) => {
            const path = Object.keys(opts.scores ?? {}).find((p) => q.instructions.includes(p));
            return [q.name, path ? (opts.scores?.[path] ?? null) : 0];
          }),
        ),
      );
    },
    async predicate(input, questions) {
      calls.push({ input, questions });
      if (opts.fail) throw new Error(opts.fail);
      return judged(Object.fromEntries(questions.map((q) => [q.name, opts.probability ?? 0.5])));
    },
  };
  return { decide, calls };
}

describe("rank_relevance", () => {
  test("ranks by score, best first, in one call, and shows its cost", async () => {
    const { decide, calls } = fakeDecide({ scores: { [LOOP]: 2.9, [EVENTS]: 0.4, [SERVER]: 1.6 } });
    const { client } = await connect(testDeps(source, {}, { decide }), "triage");
    const r = await call(client, "rank_relevance", {
      question: "Where does the agent loop run?",
      paths: [EVENTS, SERVER, LOOP],
    });
    expect(r.data.status).toBe("judged");
    expect(r.data.ranked.map((x: { citation: { path: string } }) => x.citation.path)).toEqual([LOOP, SERVER, EVENTS]);
    expect(r.data.ranked[0]).toMatchObject({ score: 2.9, level: "answers", citation: { line: 1 } });
    expect(calls).toHaveLength(1);
    expect(r.data.cost_usd).toBe(0.001);
    expect(r.data.budget.spent_today_usd).toBeCloseTo(0.001);
  });

  test("candidate text is the path plus its outline, not the whole file", async () => {
    const { decide, calls } = fakeDecide();
    const { client } = await connect(testDeps(source, {}, { decide }), "triage");
    await call(client, "rank_relevance", { question: "Where does the agent loop run?", paths: [LOOP] });
    expect(calls[0]?.input).toContain(`### C01\n${LOOP}`);
    expect(calls[0]?.questions[0]?.instructions).toContain(LOOP);
  });

  test("paths outside the snapshot are listed as unscored, not sent", async () => {
    const { decide, calls } = fakeDecide({ scores: { [LOOP]: 2 } });
    const { client } = await connect(testDeps(source, {}, { decide }), "triage");
    const r = await call(client, "rank_relevance", {
      question: "Where does the agent loop run?",
      paths: [LOOP, "../../etc/passwd"],
    });
    expect(r.data.unscored).toEqual([{ path: "../../etc/passwd", reason: "the path climbs out of the snapshot" }]);
    expect(calls[0]?.input).not.toContain("passwd");
  });

  test("refuses when no path is a snapshot file", async () => {
    const { decide } = fakeDecide();
    const { client } = await connect(testDeps(source, {}, { decide }), "triage");
    const r = await call(client, "rank_relevance", { question: "Where does the agent loop run?", paths: ["nope.ts"] });
    expect(r.isError).toBe(true);
  });

  test("is unscored with a reason when no backend is set", async () => {
    const { client } = await connect(testDeps(source), "triage");
    const r = await call(client, "rank_relevance", { question: "Where does the agent loop run?", paths: [LOOP] });
    expect(r.data).toMatchObject({ status: "unscored", ranked: [], cost_usd: 0 });
    expect(r.data.reason).toMatch(/OPENAI_API_KEY/);
  });

  test("is unscored, without calling the judge, once the budget is spent", async () => {
    const { decide, calls } = fakeDecide();
    const budget = tmpBudget();
    budget.spend(0.5);
    const { client } = await connect(testDeps(source, {}, { decide, budget }), "triage");
    const r = await call(client, "rank_relevance", { question: "Where does the agent loop run?", paths: [LOOP] });
    expect(r.data.status).toBe("unscored");
    expect(r.data.reason).toMatch(/budget is spent/);
    expect(calls).toHaveLength(0);
  });

  test("is unscored with the error when the call fails, and spends nothing", async () => {
    const { decide } = fakeDecide({ fail: "HTTP 500" });
    const budget = tmpBudget();
    const { client } = await connect(testDeps(source, {}, { decide, budget }), "triage");
    const r = await call(client, "rank_relevance", { question: "Where does the agent loop run?", paths: [LOOP] });
    expect(r.data.reason).toMatch(/decisions call failed: HTTP 500/);
    expect(budget.status().spentUsd).toBe(0);
  });

  test("keeps a paid answer when recording its spend fails", async () => {
    const { decide } = fakeDecide({ scores: { [LOOP]: 2.5 } });
    const budget = tmpBudget();
    budget.spend = () => {
      throw new Error("disk full");
    };
    const { client } = await connect(testDeps(source, {}, { decide, budget }), "triage");
    const r = await call(client, "rank_relevance", { question: "Where does the agent loop run?", paths: [LOOP] });
    expect(r.data.status).toBe("judged");
    expect(r.data.ranked[0]).toMatchObject({ score: 2.5 });
  });
});

describe("check_events", () => {
  async function withSessions(decide?: Decide) {
    const fake = new FakeSessionsApi();
    fake.addSession("exp", { metadata: { experiment: "x", depth: "0" }, inline: true });
    fake.addTurn("exp", "e1");
    fake.addMcpInitialize("e1", "conn");
    fake.addSession("chat");
    fake.addTurn("chat", "c1");
    const { client } = await connect(testDeps(source, { api: fake }, { decide }), "triage");
    return { client };
  }
  const predicates = [{ name: "calls_exec", instructions: "This event calls the tool exec." }];

  test("asks every predicate once per event, with the event's type in the input", async () => {
    const { decide, calls } = fakeDecide({ probability: 0.8 });
    const { client } = await withSessions(decide);
    const r = await call(client, "check_events", { session_id: "exp", turn_id: "e1", predicates });
    expect(r.data.status).toBe("judged");
    expect(r.data.events.map((e: { type: string }) => e.type)).toEqual(["turn.created", "mcp.initialize"]);
    expect(r.data.events[0]).toMatchObject({
      citation: { session_id: "exp", turn_id: "e1", event_id: "e1-created" },
      answers: { calls_exec: 0.8 },
    });
    expect(calls.map((c) => c.input.split("\n")[1])).toEqual([
      "Event type: turn.created",
      "Event type: mcp.initialize",
    ]);
    expect(r.data.cost_usd).toBeCloseTo(0.002);
  });

  test("the type filter sees past the first page of 100 events", async () => {
    const { decide, calls } = fakeDecide();
    const fake = new FakeSessionsApi();
    fake.addSession("exp", { metadata: { experiment: "x", depth: "0" }, inline: true });
    fake.addTurn("exp", "e1");
    // 120 other events first, so the one that matches is on the second page.
    for (let i = 0; i < 120; i++)
      fake.addEvent("e1", {
        type: "thread.done",
        id: `done-${i}`,
        createdAt: "2026-11-07T00:00:00.000Z",
      } as SessionEvent);
    fake.addMcpInitialize("e1", "conn");
    const { client } = await connect(testDeps(source, { api: fake }, { decide }), "triage");
    const r = await call(client, "check_events", {
      session_id: "exp",
      turn_id: "e1",
      predicates,
      types: ["mcp.initialize"],
    });
    expect(r.data.events.map((e: { type: string }) => e.type)).toEqual(["mcp.initialize"]);
    expect(calls).toHaveLength(1);
  });

  test("refuses the user's chat: its events never reach the judge", async () => {
    const { decide, calls } = fakeDecide();
    const { client } = await withSessions(decide);
    const r = await call(client, "check_events", { session_id: "chat", turn_id: "c1", predicates });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not an Experiment Session/);
    expect(calls).toHaveLength(0);
  });

  test("filters by type before judging", async () => {
    const { decide, calls } = fakeDecide();
    const { client } = await withSessions(decide);
    await call(client, "check_events", { session_id: "exp", turn_id: "e1", predicates, types: ["mcp.initialize"] });
    expect(calls).toHaveLength(1);
  });

  test("is unscored with a reason when no backend is set", async () => {
    const { client } = await withSessions();
    const r = await call(client, "check_events", { session_id: "exp", turn_id: "e1", predicates });
    expect(r.data.status).toBe("unscored");
    expect(r.data.events[0].answers).toEqual({ calls_exec: null });
  });

  test("refuses two predicates with the same name", async () => {
    const { decide } = fakeDecide();
    const { client } = await withSessions(decide);
    const r = await call(client, "check_events", {
      session_id: "exp",
      turn_id: "e1",
      predicates: [...predicates, ...predicates],
    });
    expect(r.isError).toBe(true);
  });
});

describe("mapLimit", () => {
  test("keeps the input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const clock = fakeClock();
    const out = await mapLimit([5, 1, 4, 2, 3, 6], CONCURRENCY, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await clock.sleep(n); // yields, so the workers interleave
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60]);
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
  });
});

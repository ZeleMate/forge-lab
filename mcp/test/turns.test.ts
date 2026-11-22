// The Turn reader (turns.ts) against the fake TrueForge: second pages, caps and
// the `cut` flag, waiting on the fake clock, and the Turn-state facts.
import { describe, expect, test } from "bun:test";
import type { SessionEvent, Turn } from "../src/sessions/api";
import { ownSessionFinder } from "../src/sessions/own";
import {
  allEvents,
  costOf,
  findSession,
  isRunning,
  isUnfinished,
  recordedMetrics,
  requiredActions,
  waitForTurn,
} from "../src/sessions/turns";
import { fakeClock } from "./helpers";
import { FakeSessionsApi } from "./sessions-fake";

// A Session `exp` with Turn `t1`: its `turn.created` event, then `extra` more.
function turnWithEvents(extra: number, type = "thread.done") {
  const fake = new FakeSessionsApi();
  fake.addSession("exp", { metadata: { experiment: "x" } });
  fake.addTurn("exp", "t1");
  for (let i = 0; i < extra; i++)
    fake.addEvent("t1", { type, id: `ev-${i}`, createdAt: "2026-11-07T00:00:00.000Z" } as SessionEvent);
  return fake;
}

const eventReads = (fake: FakeSessionsApi) => fake.calls.filter((c) => c.method === "listTurnEvents").length;

describe("allEvents", () => {
  test("reads every page of 100, oldest first", async () => {
    const fake = turnWithEvents(249);
    const r = await allEvents(fake, "exp", "t1", { maxPages: 5 });
    expect(r.items).toHaveLength(250);
    expect(r.items[0]?.type).toBe("turn.created");
    expect(r.items.at(-1)?.id).toBe("ev-248");
    expect(r.cut).toBe(false);
    expect(eventReads(fake)).toBe(3);
  });

  test("stops at maxPages and says the list was cut", async () => {
    const fake = turnWithEvents(599); // 600 events: 6 pages
    const r = await allEvents(fake, "exp", "t1", { maxPages: 5 });
    expect(r.items).toHaveLength(500);
    expect(r.cut).toBe(true);
    expect(eventReads(fake)).toBe(5);
  });

  test("a Turn that fills its last page exactly isn't cut", async () => {
    const fake = turnWithEvents(199); // 200 events: exactly 2 full pages
    const r = await allEvents(fake, "exp", "t1", { maxPages: 2 });
    expect(r.items).toHaveLength(200);
    expect(r.cut).toBe(false);
  });

  test("keeps only matching events, and stops reading once it has `until` of them", async () => {
    const fake = turnWithEvents(120);
    // Three matches on the second page, then more pages the read never needs.
    for (let i = 0; i < 3; i++)
      fake.addEvent("t1", { type: "mcp.initialize", id: `m-${i}`, createdAt: "x" } as SessionEvent);
    for (let i = 0; i < 300; i++)
      fake.addEvent("t1", { type: "thread.done", id: `z-${i}`, createdAt: "x" } as SessionEvent);
    const r = await allEvents(fake, "exp", "t1", {
      maxPages: 20,
      match: (e) => e.type === "mcp.initialize",
      until: 2,
    });
    expect(r.items.map((e) => e.id)).toEqual(["m-0", "m-1"]);
    expect(r.cut).toBe(false);
    expect(eventReads(fake)).toBe(2);
  });

  test("a filtered read that hits maxPages first is cut", async () => {
    const fake = turnWithEvents(250);
    const r = await allEvents(fake, "exp", "t1", { maxPages: 2, match: (e) => e.type === "mcp.initialize", until: 5 });
    expect(r.items).toEqual([]);
    expect(r.cut).toBe(true);
  });
});

// `count` Sessions s0..s(count-1); the list shows the newest (highest number) first.
function manySessions(count: number) {
  const fake = new FakeSessionsApi();
  for (let i = 0; i < count; i++) fake.addSession(`s${i}`);
  return fake;
}

const sessionReads = (fake: FakeSessionsApi) => fake.calls.filter((c) => c.method === "listSessions").length;

describe("findSession", () => {
  test("finds a Session on a later page, and reads no page after it", async () => {
    const fake = manySessions(80); // pages of 25: s79..s55, s54..s30, s29..s5, s4..s0
    const r = await findSession(fake, async (s) => s.id === "s40", { maxPages: 4 });
    expect(r).toEqual({ session: expect.objectContaining({ id: "s40" }), cut: false });
    expect(sessionReads(fake)).toBe(2);
  });

  test("says it was cut when it gave up at maxPages with Sessions left", async () => {
    const fake = manySessions(80);
    const r = await findSession(fake, async (s) => s.id === "s0", { maxPages: 3 });
    expect(r).toEqual({ session: undefined, cut: true });
    expect(sessionReads(fake)).toBe(3);
  });

  test("the own-Session scan finds its caller on the second page", async () => {
    const fake = new FakeSessionsApi();
    fake.addSession("own");
    fake.addTurn("own", "o1", { status: "running" });
    fake.addMcpInitialize("o1", "conn");
    // 30 Sessions updated since, so `own` is on the second page of 25.
    for (let i = 0; i < 30; i++) fake.addSession(`later-${i}`);
    const own = await ownSessionFinder(fake, "conn")();
    expect(own).toMatchObject({ sessionId: "own", runningTurnId: "o1", detected: true });
    expect(sessionReads(fake)).toBe(2);
  });

  test("a miss over the whole list isn't cut", async () => {
    const fake = manySessions(30);
    const r = await findSession(fake, async () => false, { maxPages: 4 });
    expect(r).toEqual({ session: undefined, cut: false });
    expect(sessionReads(fake)).toBe(2);
  });
});

describe("the fake pages honestly", () => {
  test("listSessions hands out a cursor to the next page, newest first", async () => {
    const fake = new FakeSessionsApi();
    for (const id of ["s1", "s2", "s3"]) fake.addSession(id);
    const first = await fake.listSessions({ limit: 2 });
    expect(first.items.map((s) => s.id)).toEqual(["s3", "s2"]);
    expect(first.next).toBeDefined();
    const second = await fake.listSessions({ limit: 2, ...(first.next ? { cursor: first.next } : {}) });
    expect(second.items.map((s) => s.id)).toEqual(["s1"]);
    expect(second.next).toBeUndefined();
  });
});

// A running Turn `r1` that the fake reports finished from its `finishOnRead`th read on.
function turnFinishingOnRead(finishOnRead: number) {
  const fake = new FakeSessionsApi();
  fake.addSession("exp", { metadata: { experiment: "x" } });
  fake.addTurn("exp", "r1", { status: "running" });
  let reads = 0;
  const getTurn = fake.getTurn.bind(fake); // `bind` keeps `this` pointing at the fake
  fake.getTurn = async (s, t) => {
    const turn = await getTurn(s, t);
    reads += 1;
    return reads >= finishOnRead
      ? { ...turn, state: { status: "cancelled", completedAt: "x", reason: "client-cancelled" } }
      : turn;
  };
  return fake;
}

describe("waitForTurn", () => {
  test("polls every 2 s until the Turn finishes", async () => {
    const fake = turnFinishingOnRead(3);
    const clock = fakeClock();
    const r = await waitForTurn(fake, clock, "exp", "r1", 30_000);
    expect(r).toMatchObject({ finished: true, waitedMs: 4_000, turn: { state: { status: "cancelled" } } });
    expect(clock.slept).toEqual([2_000, 2_000]);
  });

  test("a Turn that has already finished is read once, with no wait", async () => {
    const fake = turnFinishingOnRead(1);
    const clock = fakeClock();
    const r = await waitForTurn(fake, clock, "exp", "r1", 30_000);
    expect(r).toMatchObject({ finished: true, waitedMs: 0 });
    expect(clock.slept).toEqual([]);
  });

  test("gives up at the deadline, with the last sleep cut to land on it", async () => {
    const fake = turnFinishingOnRead(Number.POSITIVE_INFINITY);
    const clock = fakeClock();
    const r = await waitForTurn(fake, clock, "exp", "r1", 5_000);
    expect(r).toMatchObject({ finished: false, waitedMs: 5_000, turn: { state: { status: "running" } } });
    expect(clock.slept).toEqual([2_000, 2_000, 1_000]);
  });
});

describe("Turn-state facts", () => {
  const fake = new FakeSessionsApi();
  fake.addSession("exp", { metadata: { experiment: "x" } });
  const done = fake.addTurn("exp", "done", { costUsd: 0.25 });
  const waiting = fake.addTurn("exp", "waiting", { requiredActions: 2 });
  const running = fake.addTurn("exp", "running", { status: "running" });
  const cancelled = fake.addTurn("exp", "cancelled", { status: "cancelled" });
  const failed = fake.addTurn("exp", "failed", { status: "error" });
  // No fixture has caught `paused` on the wire (#24), but the SDK's type allows it.
  const paused: Turn = { ...running, id: "paused", state: { status: "paused", actionRequiredOnEvents: [] } };

  test("a Turn is unfinished while running or paused, and finished however it ended", () => {
    expect([running, paused].map(isUnfinished)).toEqual([true, true]);
    expect([done, waiting, cancelled, failed].map(isUnfinished)).toEqual([false, false, false, false]);
  });

  test("only a running Turn counts as running: a paused one makes no tool calls", () => {
    expect([running, paused, done].map(isRunning)).toEqual([true, false, false]);
  });

  test("a finished Turn waiting on an Approval has required actions; no other Turn has", () => {
    expect([waiting, done, running, paused, cancelled].map(requiredActions)).toEqual([2, 0, 0, 0, 0]);
  });

  test("cost and metrics come from a Turn that recorded them, and are absent otherwise", () => {
    expect(costOf(done)).toBe(0.25);
    expect(recordedMetrics(done)).toMatchObject({ totalInputTokens: 1000, totalCostInUsd: 0.25 });
    expect([running, cancelled].map(costOf)).toEqual([0, 0]);
    expect([running, cancelled].map(recordedMetrics)).toEqual([undefined, undefined]);
  });
});

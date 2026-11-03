// The sessions tools against payloads recorded from a live TrueForge
// (`bun run --filter @forge-lab/mcp fixtures:record`, #54): the projections must
// accept every real shape, and a refusal must hold on a real pending Turn.

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionEvent, Turn } from "../src/sessions/api";
import { eventView, sessionSummary, turnSummary } from "../src/sessions/project";
import type { Snapshot } from "../src/source/snapshot";
import { call, connect, fixtureCopy, fixtureSnapshot, testDeps } from "./helpers";
import { FakeSessionsApi } from "./sessions-fake";

type Recorded = {
  version: string;
  sessions: { main: Session; fork: Session };
  turns: Record<string, Turn>;
  events: Record<string, SessionEvent[]>;
};

const DIR = join(import.meta.dir, "..", "fixtures-results");
// The newest recording; file names are ISO timestamps, so they sort by time.
const newest = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .at(-1);
if (!newest) throw new Error("no recorded fixtures: run `bun run --filter @forge-lab/mcp fixtures:record`");
const rec = (await Bun.file(join(DIR, newest)).json()) as Recorded;

let source: Snapshot;
beforeAll(() => {
  source = fixtureSnapshot(fixtureCopy().root);
});

describe(`recorded fixtures (${newest}, TrueForge ${rec.version})`, () => {
  test("every Turn state projects, with the detail that explains it", () => {
    const view = Object.fromEntries(Object.entries(rec.turns).map(([k, t]) => [k, turnSummary(t, 100)]));
    expect(view.pending).toMatchObject({ status: "done", required_actions: 1 });
    expect(view.running).toMatchObject({ status: "running", required_actions: 0 });
    expect(view["next-turn"]).toMatchObject({ status: "cancelled", detail: "cancelled-for-next-turn" });
    expect(view["client-cancel"]).toMatchObject({ status: "cancelled", detail: "client-cancelled" });
    expect(view["iteration-limit"]?.status).toBe("error");
    expect(view["iteration-limit"]?.detail).toBeTruthy();
  });

  test("every recorded event projects with a full citation", () => {
    for (const [label, events] of Object.entries(rec.events)) {
      const turn = rec.turns[label];
      if (!turn) continue;
      for (const e of events) {
        const v = eventView(turn.sessionId, turn.id, e, 100);
        expect(v.citation).toEqual({ session_id: turn.sessionId, turn_id: turn.id, event_id: e.id });
      }
    }
    expect(
      Object.values(rec.events)
        .flat()
        .some((e) => e.type === "mcp.initialize"),
    ).toBe(true);
  });

  test("the fork carries its depth and origin tags", () => {
    expect(sessionSummary(rec.sessions.fork)).toMatchObject({ experiment: true, agent: "inline" });
    expect(rec.sessions.fork.metadata).toMatchObject({ depth: "1", origin: expect.stringContaining(":") });
  });

  test("fork_turn refuses the real pending Turn and sends nothing", async () => {
    const fake = new FakeSessionsApi();
    const { client } = await connect(testDeps(source, { api: fake }), "sessions");
    const main = rec.sessions.main;
    const turns = Object.values(rec.turns).filter((t) => t.sessionId === main.id);
    const events = Object.fromEntries(Object.entries(rec.turns).map(([k, t]) => [t.id, rec.events[k] ?? []]));
    fake.loadRecorded(main, turns, events);
    fake.addSession("caller"); // the Session the tool claims to run in, mid-Turn
    fake.addTurn("caller", "k1", { status: "running" });
    const pending = rec.turns.pending as Turn;
    const r = await call(client, "fork_turn", {
      session_id: main.id,
      from_turn_id: pending.id,
      message: "again",
      caller_session_id: "caller",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/waiting on an Approval/);
    expect(fake.mutations()).toEqual([]);
  });
});

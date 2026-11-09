// The trace panel's pure logic, against hand-written cases and payloads recorded from
// a live TrueForge (`bun run --filter @forge-lab/mcp fixtures:record`).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type SessionEvent, traceRows } from "./event-rows";
import { sessionIdFromPath } from "./session-url";
import { continuedTurnIds, eventsPollMs, isLive, pendingActions, type TurnState, turnPhase } from "./turn-view";

type Recorded = {
  turns: Record<string, { state: TurnState }>;
  events: Record<string, SessionEvent[]>;
};

const DIR = join(import.meta.dir, "../../../mcp/fixtures-results");
// File names are ISO timestamps, so the last one sorted is the newest recording.
const newest = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .at(-1);
if (!newest) throw new Error(`no fixtures in ${DIR}`);
const recorded = JSON.parse(readFileSync(join(DIR, newest), "utf8")) as Recorded;

// Looks a recording up by key and fails loudly, since indexing gives `T | undefined`.
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

const CREATED_AT = "2026-11-08T10:00:00.000Z";

function modelMessage(id: string, inputTokens: number, threadId = "main"): SessionEvent {
  return {
    type: "model.message",
    id,
    createdAt: CREATED_AT,
    threadId,
    usage: { inputTokens, outputTokens: 10, inputTokensBreakdown: {} },
  } as SessionEvent;
}

describe("turnPhase", () => {
  test("a recorded Approval wait is `done` on the wire but waiting to a reader", () => {
    const { state } = must(recorded.turns.pending, "pending Turn");
    expect(state.status).toBe("done");
    expect(turnPhase(state)).toBe("waiting");
    expect(pendingActions(state)).toBe(1);
  });

  test("a done Turn with nothing pending is done", () => {
    const state = { status: "done", output: null, requiredActions: [], completedAt: CREATED_AT } as TurnState;
    expect(turnPhase(state)).toBe("done");
    expect(pendingActions(state)).toBe(0);
  });

  test("a status the SDK doesn't know isn't reported as finished", () => {
    expect(turnPhase({ status: "brand-new" } as unknown as TurnState)).toBe("unknown");
  });
});

describe("an answered Approval (found live: requiredActions stays on the Turn forever)", () => {
  test("a Turn that another Turn continues from is no longer waiting", () => {
    const { state } = must(recorded.turns.pending, "pending Turn");
    expect(pendingActions(state)).toBe(1); // still stored...
    expect(turnPhase(state, true)).toBe("done"); // ...but nobody's waiting on it
  });

  test("continuedTurnIds collects every Turn something continues from", () => {
    const turns = [
      { id: "t1", previousTurnId: null },
      { id: "t2", previousTurnId: "t1" },
    ];
    expect([...continuedTurnIds(turns)]).toEqual(["t1"]);
  });
});

function toolCall(id: string, name: string, args: string) {
  return { id, type: "function", function: { name, arguments: args }, toolInfo: { type: "truefoundry-system", name } };
}

function callingModel(id: string, calls: ReturnType<typeof toolCall>[]): SessionEvent {
  return { type: "model.message", id, createdAt: CREATED_AT, threadId: "main", toolCalls: calls } as SessionEvent;
}

describe("tool names", () => {
  const FORK_ARGS = '{"mcp_server":"sessions","tool_name":"fork_turn","input":{}}';

  test("a deferred call shows the tool it runs, not just the call_tool meta-tool", () => {
    const events = [
      callingModel("m1", [toolCall("c1", "call_tool", FORK_ARGS)]),
      {
        type: "tool.approval_required",
        id: "a1",
        createdAt: CREATED_AT,
        threadId: "main",
        toolCalls: [{ id: "c1", sourceEventId: "m1" }],
      } as SessionEvent,
    ];
    const rows = traceRows(events);
    expect(rows[0]?.label).toBe("Model calls fork_turn via call_tool");
    expect(rows[1]?.label).toBe("Approval needed: fork_turn via call_tool");
  });

  test.each(["not json", "null", "[]", '{"tool_name":7}', '{"other":"x"}'])(
    "model-written call_tool arguments that don't parse fall back to the plain name: %s",
    (args) => {
      const [row] = traceRows([callingModel("m1", [toolCall("c1", "call_tool", args)])]);
      expect(row?.label).toBe("Model calls call_tool");
    },
  );

  test("an answer in a new Turn is named from the previous Turn's events", () => {
    const previous = [callingModel("m1", [toolCall("c1", "call_tool", FORK_ARGS)])];
    const events = [
      {
        type: "turn.created",
        id: "e1",
        createdAt: CREATED_AT,
        turnId: "t2",
        previousTurnId: "t1",
        threadId: null,
        state: { status: "running" },
        input: [{ type: "user.tool_approval", threadId: "main", toolCallId: "c1", approval: { status: "allow" } }],
      } as SessionEvent,
      {
        type: "tool.response",
        id: "e2",
        createdAt: CREATED_AT,
        threadId: "main",
        toolCallId: "c1",
        content: "{}",
      } as SessionEvent,
    ];
    const rows = traceRows(events, previous);
    expect(rows.map((row) => row.id)).toEqual(["e1", "e2"]); // the previous Turn adds names, not rows
    expect(rows[0]?.detail).toBe("fork_turn via call_tool: allowed");
    expect(rows[1]?.label).toBe("Tool response: fork_turn via call_tool");
  });
});

describe("which Turns get polled", () => {
  test("a running Turn is polled", () => {
    const state = { status: "running" } as TurnState;
    expect(isLive(state)).toBe(true);
    expect(eventsPollMs(state)).toBe(1500);
  });

  test("an Approval wait isn't polled: its events can't change, the answer starts a new Turn", () => {
    const { state } = must(recorded.turns.pending, "pending Turn");
    expect(isLive(state)).toBe(false);
    expect(eventsPollMs(state)).toBeNull();
  });

  test.each(["error", "cancelled"])("a %s Turn isn't polled", (status) => {
    expect(eventsPollMs({ status } as TurnState)).toBeNull();
  });
});

describe("traceRows", () => {
  test("an Approval pause names the tool, even though the event only carries its call id", () => {
    const rows = traceRows(must(recorded.events.pending, "pending events"));
    const pause = rows.find((row) => row.label.startsWith("Approval needed"));
    expect(pause?.kind).toBe("approval");
    expect(pause?.label).toBe("Approval needed: source_status");
  });

  test("a model call lists its tools, and tool responses are named from it", () => {
    const rows = traceRows(must(recorded.events["iteration-limit"], "iteration-limit events"));
    expect(rows.some((row) => row.kind === "model" && row.label.startsWith("Model calls source_status"))).toBe(true);
    expect(rows.some((row) => row.kind === "tool" && row.label === "Tool response: source_status")).toBe(true);
  });

  test("every recorded event becomes a row, in order", () => {
    for (const events of Object.values(recorded.events)) {
      const rows = traceRows(events);
      expect(rows.map((row) => row.id)).toEqual(events.map((event) => event.id));
    }
  });

  test("a Turn that carries an Approval answer shows the decision", () => {
    const created = {
      type: "turn.created",
      id: "e1",
      createdAt: CREATED_AT,
      turnId: "t2",
      previousTurnId: "t1",
      threadId: null,
      state: { status: "running" },
      input: [
        { type: "user.tool_approval", threadId: "main", toolCallId: "call-12345678", approval: { status: "allow" } },
        {
          type: "user.tool_approval",
          threadId: "main",
          toolCallId: "call-87654321",
          approval: { status: "deny", reason: "not now" },
        },
      ],
    } as SessionEvent;
    const [row] = traceRows([created]);
    expect(row?.kind).toBe("approval");
    expect(row?.detail).toBe("12345678: allowed; 87654321: denied: not now");
  });

  test("Subagent events are highlighted and name their thread", () => {
    const events = [
      {
        type: "thread.created",
        id: "e1",
        createdAt: CREATED_AT,
        threadId: "sub-1",
        title: "Trace SSE",
        parent: {},
        agentInfo: {},
      },
      {
        type: "thread.done",
        id: "e2",
        createdAt: CREATED_AT,
        threadId: "sub-1",
        title: "Trace SSE",
        state: { status: "done" },
      },
    ] as unknown as SessionEvent[];
    expect(traceRows(events).map(({ kind, label, thread }) => ({ kind, label, thread }))).toEqual([
      { kind: "subagent", label: "Subagent started: Trace SSE", thread: "sub-1" },
      { kind: "subagent", label: "Subagent done: Trace SSE", thread: "sub-1" },
    ]);
  });

  test("an event type the panel doesn't know still shows, by its type", () => {
    const [row] = traceRows([{ type: "something.new", id: "e1", createdAt: CREATED_AT } as unknown as SessionEvent]);
    expect(row).toMatchObject({ kind: "other", label: "something.new" });
  });
});

describe("inferred context shrink", () => {
  test("input falling below half the previous call shows a row before that call", () => {
    const rows = traceRows([modelMessage("a", 64_000), modelMessage("b", 4_000)]);
    expect(rows.map((row) => row.kind)).toEqual(["model", "context", "model"]);
    expect(rows[1]?.label).toBe("Context shrank (inferred)");
    expect(rows[1]?.detail).toBe("64,000 tokens to 4,000 tokens, probably compaction");
  });

  test("normal growth, and a smaller drop, show nothing", () => {
    const rows = traceRows([modelMessage("a", 10_000), modelMessage("b", 12_000), modelMessage("c", 7_000)]);
    expect(rows.some((row) => row.kind === "context")).toBe(false);
  });

  test("threads are compared separately: a small Subagent isn't a shrink of the main thread", () => {
    const rows = traceRows([modelMessage("a", 64_000), modelMessage("b", 3_000, "sub-1")]);
    expect(rows.some((row) => row.kind === "context")).toBe(false);
  });
});

describe("sessionIdFromPath", () => {
  test("reads the Session id from the SDK's route", () => {
    expect(sessionIdFromPath("/sessions/01m6ra7cpk853g5rqq1h6gafvv")).toBe("01m6ra7cpk853g5rqq1h6gafvv");
    expect(sessionIdFromPath("/sessions/01m6ra7cpk853g5rqq1h6gafvv/")).toBe("01m6ra7cpk853g5rqq1h6gafvv");
  });

  test.each(["/", "/sessions", "/sessions/", "/sessions/a/b", "/sessions/..%2Fagents", "/agents/x"])(
    "%s has no open Session",
    (path) => {
      expect(sessionIdFromPath(path)).toBeNull();
    },
  );
});

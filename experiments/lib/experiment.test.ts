import { describe, expect, test } from "bun:test";
import type { Decision } from "./expected";
import { answerPause, toolName } from "./experiment";

const call = (name: string, args: string, id = "c1") => ({ id, function: { name, arguments: args } });

describe("toolName", () => {
  test("a direct call names its tool", () => {
    expect(toolName(call("fork_turn", "{}"))).toBe("fork_turn");
  });

  test("a deferred call through call_tool names the real tool", () => {
    expect(toolName(call("call_tool", '{"mcp_server":"sessions","tool_name":"cancel_session"}'))).toBe(
      "cancel_session",
    );
  });

  // A name that matches no decision makes the run stop, which is the safe outcome.
  test("unreadable call_tool arguments stay call_tool", () => {
    expect(toolName(call("call_tool", "not json"))).toBe("call_tool");
    expect(toolName(call("call_tool", '{"tool_name":7}'))).toBe("call_tool");
    expect(toolName(undefined)).toBe("<unknown call>");
  });
});

describe("answerPause", () => {
  // A Turn paused on two calls in one model message: one direct, one deferred.
  const paused = {
    turnId: "t1",
    state: {
      status: "done",
      required_actions: [{ thread_id: "main", tool_calls: [{ id: "a" }, { id: "b" }] }],
    },
    persisted: [
      { type: "turn.created", id: "e0" },
      {
        type: "model.message",
        id: "e1",
        tool_calls: [
          call("fork_turn", "{}", "a"),
          call("call_tool", '{"mcp_server":"sessions","tool_name":"cancel_session"}', "b"),
        ],
      },
    ],
  };
  const decisions = new Map<string, Decision>([
    ["fork_turn", "allow"],
    ["cancel_session", "deny"],
  ]);

  test("answers each paused call from the decision list, deferred ones by their real name", () => {
    const answers = answerPause(paused, decisions);
    expect(answers.map((a) => a.input)).toEqual([
      { type: "user.tool_approval", thread_id: "main", tool_call_id: "a", approval: { status: "allow" } },
      { type: "user.tool_approval", thread_id: "main", tool_call_id: "b", approval: { status: "deny" } },
    ]);
    expect(answers.map((a) => a.record.tool)).toEqual(["fork_turn", "cancel_session"]);
  });

  test("a pause on a tool with no decision throws instead of guessing", () => {
    expect(() => answerPause(paused, new Map([["fork_turn", "allow"]]))).toThrow(/cancel_session/);
  });

  test("a Turn that didn't pause, or didn't end done, needs no answers", () => {
    expect(answerPause({ ...paused, state: { status: "done" } }, decisions)).toEqual([]);
    expect(answerPause({ ...paused, state: { ...paused.state, status: "error" } }, decisions)).toEqual([]);
  });
});

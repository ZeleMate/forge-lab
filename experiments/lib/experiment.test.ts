import { describe, expect, test } from "bun:test";
import { toolName } from "./experiment";

const call = (name: string, args: string) => ({ id: "c1", function: { name, arguments: args } });

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

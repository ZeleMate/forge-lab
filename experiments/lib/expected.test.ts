import { describe, expect, test } from "bun:test";
import { parseExpected } from "./expected";

const file = (approvals: string) => `# x: expected

## Expectations
- **E1** First thing.
  More prose about it.
- **E2** Second thing.

## Approvals
${approvals}
`;

describe("parseExpected", () => {
  test("reads expectation ids in order and the decision list", () => {
    const parsed = parseExpected(file("- `fork_turn`: allow\n- `cancel_session`: deny"));
    expect(parsed.expectationIds).toEqual(["E1", "E2"]);
    expect([...parsed.approvals]).toEqual([
      ["fork_turn", "allow"],
      ["cancel_session", "deny"],
    ]);
  });

  test("an Approvals section with prose only means no decisions", () => {
    expect(parseExpected(file("None: no Turn should pause.")).approvals.size).toBe(0);
  });

  test("a malformed Approval item throws instead of being skipped", () => {
    expect(() => parseExpected(file("- fork_turn: allow"))).toThrow(/line 9/);
    expect(() => parseExpected(file("- `fork_turn`: maybe"))).toThrow(/allow/);
  });

  test("a tool with two decisions throws", () => {
    expect(() => parseExpected(file("- `fork_turn`: allow\n- `fork_turn`: deny"))).toThrow(/two decisions/);
  });

  test("a missing Approvals section or a repeated id throws", () => {
    expect(() => parseExpected("## Expectations\n- **E1** a\n")).toThrow(/Approvals/);
    expect(() => parseExpected("## Expectations\n- **E1** a\n- **E1** b\n## Approvals\n")).toThrow(/twice/);
  });
});

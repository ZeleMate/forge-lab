import { describe, expect, test } from "bun:test";
import { fitList, guarded, refuse } from "../src/result";

describe("fitList", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ path: `packages/a/file${i}.ts`, line: i + 1 }));

  test("keeps every item when the result fits", () => {
    const out = fitList({ sha: "abc" }, "matches", items, 100_000);
    expect(out.matches).toHaveLength(50);
    expect(out.truncated).toBe(false);
    expect(out.omitted).toBe(0);
  });

  test("drops items from the end until the JSON fits max_chars", () => {
    const out = fitList({ sha: "abc" }, "matches", items, 600);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(600);
    expect(out.truncated).toBe(true);
    expect(out.matches.length + out.omitted).toBe(50);
    expect(out.matches[0]).toEqual(items[0]); // the first (best) items survive
  });

  test("returns an empty list rather than overflowing", () => {
    const out = fitList({ sha: "abc" }, "matches", items, 10);
    expect(out.matches).toHaveLength(0);
    expect(out.omitted).toBe(50);
  });
});

describe("refuse", () => {
  test("is an isError result with the reason and a recovery hint", () => {
    const r = refuse("path escapes the snapshot", "pass a path relative to the snapshot root");
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([
      { type: "text", text: "refused: path escapes the snapshot. Try: pass a path relative to the snapshot root" },
    ]);
  });
});

describe("guarded", () => {
  test("turns a thrown error into an isError result instead of throwing", async () => {
    const handler = guarded(async () => {
      throw new Error("boom");
    });
    const r = await handler({});
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "error: boom" }]);
  });
});

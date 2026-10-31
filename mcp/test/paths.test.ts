import { beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { checkGlob, resolveInside } from "../src/source/paths";
import { fixtureCopy } from "./helpers";

let root: string;
beforeAll(() => {
  root = realpathSync(fixtureCopy().root);
});

describe("resolveInside", () => {
  test("resolves a relative path inside the root", () => {
    expect(resolveInside(root, "packages/trueforge/src/server.ts")).toEqual({
      ok: true,
      path: join(root, "packages/trueforge/src/server.ts"),
      rel: "packages/trueforge/src/server.ts",
    });
  });

  test("refuses `..` that climbs out of the root", () => {
    expect(resolveInside(root, "packages/../../outside.ts").ok).toBe(false);
  });

  test("refuses an absolute path", () => {
    expect(resolveInside(root, "/etc/passwd").ok).toBe(false);
  });

  test("refuses a symlink whose target is outside the root", () => {
    expect(resolveInside(root, "packages/trueforge/src/escape.ts").ok).toBe(false);
  });

  test("refuses a path that doesn't exist", () => {
    expect(resolveInside(root, "packages/nope.ts").ok).toBe(false);
  });
});

describe("checkGlob", () => {
  test("accepts a relative glob", () => {
    expect(checkGlob("packages/trueforge-core/**/*.ts")).toBeUndefined();
  });

  test("refuses absolute globs and `..` segments", () => {
    expect(checkGlob("/etc/*")).toBeString();
    expect(checkGlob("../*")).toBeString();
    expect(checkGlob("packages/../../x")).toBeString();
  });
});

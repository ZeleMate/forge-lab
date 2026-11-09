// `hooks.ts no-home-paths` against throwaway git repos, so a broken pattern
// fails here instead of quietly passing every commit.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "hooks.ts");
const repos: string[] = [];
afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

// A new repo with these files staged; returns the hook's exit code and stderr.
function runHook(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "forge-lab-hooks-"));
  repos.push(dir);
  const env = { PATH: "/usr/bin:/bin", HOME: dir };
  Bun.spawnSync(["/usr/bin/git", "init", "-q"], { cwd: dir, env });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  Bun.spawnSync(["/usr/bin/git", "add", "-A"], { cwd: dir, env });
  const run = Bun.spawnSync([process.execPath, HOOKS, "no-home-paths"], { cwd: dir, env, stderr: "pipe" });
  return { code: run.exitCode, stderr: run.stderr.toString() };
}

describe("no-home-paths", () => {
  test("passes the placeholder and an index without home paths", () => {
    expect(runHook({ "r.json": '{"p": "/Users/<user>/x"}\n', "a.md": "nothing here\n" }).code).toBe(0);
  });

  test("refuses a real home path, naming file and line but not the username", () => {
    // Joined at runtime: written out, the path would trip this same check on the test file.
    const home = ["", "Users", "someone", "x"].join("/");
    const { code, stderr } = runHook({ "a:b.json": `first\n{"p": "${home}"}\n` });
    expect(code).toBe(1);
    expect(stderr).toContain("a:b.json:2");
    expect(stderr).not.toContain("someone");
  });
});

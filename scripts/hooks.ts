// The checks behind lefthook.yml that need more than one command (#30).
//
//   bun scripts/hooks.ts no-env <file>...   refuse staged .env files (pre-commit)
//   bun scripts/hooks.ts pre-push           refuse pushes to main, scan pushed commits (pre-push)
//
// The hooks are the only gate on this repo: GitHub Free can't protect `main`
// on a private repo, so CI reports but can't block (SECURITY.md).

import { basename } from "node:path";

// Spawn tools by absolute path, never by a name looked up in whatever PATH is set.
// Homebrew's prefix on Apple silicon; #30 installs gitleaks from homebrew/core.
const GITLEAKS = "/opt/homebrew/bin/gitleaks";
const MAIN = "refs/heads/main";
// Git sends forty zeros for "no commit": a new branch's remote side, or a deletion's local side.
const NO_COMMIT = /^0{40}$/;

function fail(message: string): never {
  console.error(`hooks: ${message}`);
  process.exit(1);
}

function noEnv(files: string[]): void {
  // `.env.example` holds variable names only; every other `.env*` may hold a live key.
  const staged = files.filter((file) => basename(file).startsWith(".env") && basename(file) !== ".env.example");
  if (staged.length > 0) {
    fail(`refusing to commit ${staged.join(", ")}; unstage with \`git restore --staged <file>\``);
  }
}

// Git runs pre-push with one stdin line per ref being pushed:
// "<local ref> <local sha> <remote ref> <remote sha>".
async function prePush(): Promise<void> {
  // `Bun.stdin.text()` reads all of stdin; `await` waits for it to finish.
  const lines = (await Bun.stdin.text()).split("\n").filter((line) => line.trim() !== "");
  for (const line of lines) {
    // Array destructuring with holes: `[, a]` skips the first element.
    const [, localSha, remoteRef, remoteSha] = line.split(" ");
    if (!localSha || !remoteRef || !remoteSha) fail(`unexpected pre-push line: ${line}`);
    if (remoteRef === MAIN) fail("refusing to push to main; push a branch and open a PR so CI runs first");
    if (NO_COMMIT.test(localSha)) continue; // deleting a remote branch pushes no commits

    // Only the commits this push adds: all of a new branch that no remote has
    // yet, or what's past the remote's tip for an existing one.
    const range = NO_COMMIT.test(remoteSha) ? `${localSha} --not --remotes` : `${remoteSha}..${localSha}`;
    const scan = Bun.spawnSync(
      [GITLEAKS, "git", "--no-banner", "--redact", `--log-opts=${range}`, "--exit-code", "1", "."],
      // gitleaks calls `git log` itself, so its PATH only needs /usr/bin (macOS's git).
      { stdout: "inherit", stderr: "inherit", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" } },
    );
    if (scan.exitCode !== 0) fail(`gitleaks flagged commits pushed to ${remoteRef}; see its report above`);
  }
}

// `process.argv` is [bun, script, ...args]; `slice(2)` keeps the args.
const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "no-env":
    noEnv(rest);
    break;
  case "pre-push":
    await prePush();
    break;
  default:
    fail(`unknown command ${command}; use no-env or pre-push`);
}

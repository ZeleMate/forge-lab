// The 7-day release age, checked for versions a change writes into bun.lock:
//
//   bun scripts/check-release-age.ts [--base <rev>] [--now <ISO time>]
//
// bunfig.toml's minimumReleaseAge only applies when Bun resolves a version.
// `bun install` and `bun install --frozen-lockfile` accept whatever bun.lock
// already names, however young, so a lockfile edited by hand, by a bot, or
// written while an exception existed would pass. This compares bun.lock with
// the one at `--base` (default: the merge base with origin/main), looks up each
// added version's publish time on the npm registry, and fails if any is younger
// than minimumReleaseAge and not accepted below, or if its registry integrity
// differs from bun.lock's. `--now` pretends it's another time, for dry runs.
//
// Network: one registry request per package name the change adds or bumps,
// none when bun.lock is unchanged. No token is sent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@forge-lab/lib/snapshot";

// A version let in before it's old enough, after reviewing that exact tarball.
// It covers one package, one version and one integrity hash, and stops applying
// after `reviewBy` (inclusive), so a re-published or later version is never
// covered. This replaces bunfig.toml's name-wide `minimumReleaseAgeExcludes`.
export type AcceptedYoung = { pkg: string; version: string; integrity: string; reviewBy: string; reason: string };

// Empty: nothing in bun.lock is younger than 7 days without a review. To add one,
// copy the integrity from bun.lock (`sha512-…`) and set reviewBy to the day it
// clears the age; installing it still needs a one-off `--minimum-release-age=0`.
const ACCEPTED: AcceptedYoung[] = [];

const DEFAULT_BASE_BRANCH = "origin/main";
const REGISTRY = "https://registry.npmjs.org";
// Spawn git by absolute path, as hooks.ts does: /usr/bin/git on macOS and the Ubuntu runner.
const GIT = "/usr/bin/git";
const DAY_MS = 24 * 60 * 60 * 1000;

// One `packages` entry of bun.lock that came from the npm registry.
export type Locked = { id: string; name: string; version: string; integrity: string };

// The parts of a registry packument (`GET /<name>`) this check reads.
export type Packument = {
  time?: Record<string, string>;
  versions?: Record<string, { dist?: { integrity?: string } }>;
};

export type Result = { problems: string[]; notes: string[]; added: Locked[] };

// A registry version in bun.lock is `[id, tarball URL or "", metadata, integrity]`,
// with `id` = `name@version`; a workspace is `[name@workspace:path]`. Anything
// else (git, tarball URL, `file:`, another registry) can't be checked here.
// Returns the registry entries keyed by id, and the ids of the ones that aren't.
export function parseLock(text: string): { registry: Map<string, Locked>; other: Set<string> } {
  // bun.lock is JSON with trailing commas, which `JSON.parse` rejects; Bun.JSONC accepts it.
  const lock = Bun.JSONC.parse(text) as { packages?: Record<string, unknown[]> };
  const registry = new Map<string, Locked>();
  const other = new Set<string>();
  // `Object.values` drops the keys: nested keys like "axios/follow-redirects" only say where it's installed.
  for (const entry of Object.values(lock.packages ?? {})) {
    const [id, url, , integrity] = entry;
    if (typeof id !== "string") continue;
    if (id.includes("@workspace:")) continue; // our own packages
    // `lastIndexOf` skips the `@` that starts a scope like `@truefoundry/…`.
    const at = id.lastIndexOf("@");
    const name = id.slice(0, at);
    const version = id.slice(at + 1);
    // `typeof … === "string"` narrows `unknown` to `string` for the rest of the condition.
    if (entry.length === 4 && url === "" && typeof integrity === "string" && at > 0 && /^\d/.test(version)) {
      registry.set(id, { id, name, version, integrity });
    } else {
      other.add(id);
    }
  }
  return { registry, other };
}

// Checks every registry version `head` names that `base` doesn't. Also fails on
// an id whose integrity changed (a registry version never changes, so that's a
// tampered lock) and on any new non-registry entry.
export async function checkLock(options: {
  base: string;
  head: string;
  now: Date;
  minAgeSeconds: number;
  accepted: AcceptedYoung[];
  lookup: (name: string) => Promise<Packument>;
}): Promise<Result> {
  const { now, minAgeSeconds, accepted, lookup } = options;
  const base = parseLock(options.base);
  const head = parseLock(options.head);
  const problems: string[] = [];
  const notes: string[] = [];

  const added: Locked[] = [];
  for (const [id, locked] of head.registry) {
    const before = base.registry.get(id);
    if (!before) added.push(locked);
    else if (before.integrity !== locked.integrity) problems.push(`${id}: integrity changed in bun.lock`);
  }
  for (const id of head.other) {
    if (!base.other.has(id)) problems.push(`${id}: not from the npm registry, so its release age can't be checked`);
  }

  // One request per package name, all at once: `Promise.all` waits for every lookup.
  const names = [...new Set(added.map((a) => a.name))];
  const packuments = new Map(await Promise.all(names.map(async (name) => [name, await lookup(name)] as const)));

  // ISO dates compare correctly as strings: "2026-11-03" < "2026-11-04".
  const today = now.toISOString().slice(0, 10);
  for (const locked of added) {
    const { id, name, version, integrity } = locked;
    const packument = packuments.get(name);
    const published = packument?.time?.[version];
    const registryIntegrity = packument?.versions?.[version]?.dist?.integrity;
    if (!published) {
      problems.push(`${id}: the registry has no publish time for it (unpublished?)`);
      continue;
    }
    if (registryIntegrity !== integrity) {
      problems.push(`${id}: bun.lock's integrity doesn't match the registry's`);
      continue;
    }
    const exception = accepted.find((a) => a.pkg === name && a.version === version);
    const clears = new Date(Date.parse(published) + minAgeSeconds * 1000);
    if (clears <= now) {
      if (exception) notes.push(`${id}: old enough now; remove its exception`);
      continue;
    }

    // Rounded down, so a version a minute short of 7 days never reads "7.0 days old".
    const ageDays = (Math.floor(((now.getTime() - Date.parse(published)) / DAY_MS) * 10) / 10).toFixed(1);
    const young = `${id}: published ${published}, ${ageDays} days old; allowed from ${clears.toISOString()}`;
    if (!exception) problems.push(`${young} (not accepted)`);
    else if (exception.integrity !== integrity) problems.push(`${young} (accepted for a different tarball)`);
    else if (exception.reviewBy < today) problems.push(`${young} (accepted until ${exception.reviewBy}; expired)`);
    else notes.push(`${young} (accepted until ${exception.reviewBy}: ${exception.reason})`);
  }

  for (const exception of accepted) {
    if (exception.reviewBy < today) {
      notes.push(`${exception.pkg}@${exception.version}: accepted until ${exception.reviewBy}, expired; remove it`);
    }
  }
  return { problems, notes, added };
}

function fail(message: string): never {
  console.error(`check-release-age: ${message}`);
  process.exit(1);
}

function git(...args: string[]): string {
  const proc = Bun.spawnSync([GIT, "-C", REPO_ROOT, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) fail(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString();
}

async function fetchPackument(name: string): Promise<Packument> {
  // A scoped name keeps its `@` but encodes the slash: `@scope%2fname`.
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  let response: Response;
  try {
    // `AbortSignal.timeout` cancels the request if the registry hangs.
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    // Fail closed: no answer from the registry means the age is unknown.
    fail(`${url}: ${String(error)}`);
  }
  if (!response.ok) fail(`${url} answered ${response.status}`);
  return (await response.json()) as Packument;
}

// Reads `--flag value` pairs; returns undefined for a flag that wasn't given.
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1] ?? fail(`${name} needs a value`);
}

// `import.meta.main` is true only when this file is run, not when a test imports it.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const base = flag(args, "--base") ?? git("merge-base", "HEAD", DEFAULT_BASE_BRANCH).trim();
  const nowFlag = flag(args, "--now");
  const now = nowFlag ? new Date(nowFlag) : new Date();
  if (Number.isNaN(now.getTime())) fail(`--now ${nowFlag} is not a date`);

  // One source for the age: bunfig.toml, which check-pins.ts keeps at 7 days or more.
  const bunfig = Bun.TOML.parse(readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8")) as {
    install?: { minimumReleaseAge?: unknown };
  };
  const minAgeSeconds = bunfig.install?.minimumReleaseAge;
  if (typeof minAgeSeconds !== "number") fail("bunfig.toml has no [install] minimumReleaseAge");

  const result = await checkLock({
    base: git("show", `${base}:bun.lock`),
    head: readFileSync(join(REPO_ROOT, "bun.lock"), "utf8"),
    now,
    minAgeSeconds,
    accepted: ACCEPTED,
    lookup: fetchPackument,
  });
  for (const note of result.notes) console.warn(`check-release-age: ${note}`);
  const where = `since ${base.slice(0, 12)}`;
  if (result.problems.length > 0) {
    fail(`${result.problems.length} problem(s) ${where}\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  console.log(`check-release-age: ${result.added.length} version(s) added ${where}, all old enough or accepted`);
}

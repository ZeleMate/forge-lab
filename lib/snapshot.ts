// The Source Snapshot pin (the committed root `snapshot.json`) and where its
// fetched tree lives (#32). `scripts/snapshot.ts` writes both; the MCP server and
// `bun run dev` only read them: `import { openSnapshot } from "@forge-lab/lib/snapshot"`.
//
// Only `node:` modules here, no Bun APIs, so the MCP server could also run on Node.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { serverVersion } from "./trueforge";

// `import.meta.dirname` is the folder of this file (Bun and Node 20.11+), so the
// paths below don't depend on the directory a command was started in.
export const REPO_ROOT = join(import.meta.dirname, "..");
export const PIN_FILE = join(REPO_ROOT, "snapshot.json");
// Written inside the fetched tree last, so a tree without it is an interrupted fetch.
export const MANIFEST_NAME = ".source-snapshot.json";

export const PACKAGE = "@truefoundry/trueforge";
export const DEFAULT_CACHE_ROOT = join(homedir(), "Library/Caches/forge-lab/trueforge-src");

export type SnapshotPin = {
  version: string; // the npm version, as /healthz reports it
  sha: string; // the commit the npm provenance attestation names
  tagSha: string | null; // what the `v<version>` git tag points at (a later commit, kept as an alias)
  repo: string; // the git remote, from the attestation's workflow repository
  subjectDigest: string | null; // the attested tarball sha512 (hex); null when pinned by hand with --sha
};

// `&` combines two object types: everything a pin has, plus two more fields.
export type SnapshotManifest = SnapshotPin & { fetchedAt: string; generated: string[] };

const SHA = /^[0-9a-f]{40}$/;
export function isSha(value: string): boolean {
  return SHA.test(value);
}

// A type guard: when it returns true, the compiler treats `value` as a SnapshotPin.
function isPin(value: unknown): value is SnapshotPin {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const nullableString = (x: unknown) => x === null || typeof x === "string";
  return (
    typeof v.version === "string" &&
    typeof v.sha === "string" &&
    isSha(v.sha) &&
    nullableString(v.tagSha) &&
    typeof v.repo === "string" &&
    nullableString(v.subjectDigest)
  );
}

export function readPin(): SnapshotPin {
  if (!existsSync(PIN_FILE)) throw new Error(`${PIN_FILE} is missing; run \`bun run snapshot:pin\``);
  const pin: unknown = JSON.parse(readFileSync(PIN_FILE, "utf8"));
  if (!isPin(pin)) throw new Error(`${PIN_FILE} is not a valid pin {version, sha, tagSha, repo, subjectDigest}`);
  return pin;
}

// The TrueForge version harness/package.json pins (the one `bun install` installs).
export function harnessPinVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "harness/package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const version = pkg.devDependencies?.[PACKAGE];
  if (!version) throw new Error(`harness/package.json does not pin ${PACKAGE}`);
  return version;
}

// The folder that holds one `<sha>/` per fetched snapshot. SOURCE_SNAPSHOT_DIR
// replaces it (not the `<sha>` folder itself), e.g. for a throwaway Experiment.
export function cacheRoot(): string {
  const root = process.env.SOURCE_SNAPSHOT_DIR || DEFAULT_CACHE_ROOT;
  if (!isAbsolute(root)) throw new Error(`SOURCE_SNAPSHOT_DIR must be an absolute path, got ${root}`);
  return root;
}

export function snapshotDir(sha: string): string {
  return join(cacheRoot(), sha);
}

export function readManifest(dir: string): SnapshotManifest | undefined {
  const file = join(dir, MANIFEST_NAME);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as SnapshotManifest;
}

// True when the tree at `dir` is a complete fetch of exactly this pin.
export function isComplete(manifest: SnapshotManifest | undefined, pin: SnapshotPin): boolean {
  return manifest?.sha === pin.sha && manifest.version === pin.version;
}

// For the MCP server: the pinned snapshot's folder, or an error (#32: no degraded mode).
export function openSnapshot(): { dir: string; manifest: SnapshotManifest } {
  const pin = readPin();
  const dir = snapshotDir(pin.sha);
  const manifest = readManifest(dir);
  // After `isComplete` returns true, `manifest` is still typed `| undefined`;
  // checking it again here lets the compiler narrow it.
  if (!manifest || !isComplete(manifest, pin)) {
    throw new Error(`no complete Source Snapshot for ${pin.version} at ${dir}; run \`bun run snapshot\``);
  }
  return { dir, manifest };
}

// For `bun run dev` (#35): the running server must be the version the snapshot pins.
export async function checkServerVersion(): Promise<{ ok: boolean; server: string; pinned: string }> {
  const [server, pinned] = [await serverVersion(), readPin().version];
  return { ok: server === pinned, server, pinned };
}

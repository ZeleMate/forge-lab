// The install rules from SECURITY.md, checked (#30, reused by CI in #31):
//
//   bun scripts/check-pins.ts
//
// Fails when any workspace package.json has a version that isn't exact (`^`, `~`,
// `*`, `latest`, ranges, tags, URLs), sets `trustedDependencies`, or when the root
// bunfig.toml stops enforcing `ignoreScripts`, `env = false`, `exact` or the 7-day
// minimum release age. Reads files only: no network, safe on every commit.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@forge-lab/lib/snapshot";

// `X.Y.Z`, optionally with a prerelease like `-rc.1`. Nothing else counts as exact.
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const WORKSPACE_LINK = "workspace:*";
const OWN_SCOPE = "@forge-lab/";
// `as const` keeps each entry's literal type ("dependencies", ...) instead of widening to `string`.
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
] as const;
const MIN_RELEASE_AGE = 7 * 24 * 60 * 60;

// `Record<string, unknown>` is "an object with string keys whose values we haven't checked yet".
type Manifest = Record<string, unknown> & { workspaces?: string[] };

const problems: string[] = [];

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as Manifest;
}

function checkManifest(path: string, manifest: Manifest): void {
  if ("trustedDependencies" in manifest) problems.push(`${path}: remove trustedDependencies (no install scripts run)`);
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (typeof deps !== "object" || deps === null) {
      problems.push(`${path}: ${field} is not an object`);
      continue;
    }
    // `Object.entries` turns `{ a: "1" }` into `[["a", "1"]]`, so the loop can destructure each pair.
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string") {
        problems.push(`${path}: ${field}.${name} is not a string`);
      } else if (version === WORKSPACE_LINK && name.startsWith(OWN_SCOPE)) {
        // A link to one of our own workspaces, not a registry range.
      } else if (!EXACT.test(version)) {
        problems.push(`${path}: ${field}.${name} is "${version}"; pin an exact version like 1.2.3`);
      }
    }
  }
}

function checkBunfig(): void {
  // Bun ships a TOML parser, so there's no dependency for this.
  const config = Bun.TOML.parse(readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8")) as {
    env?: unknown;
    install?: { ignoreScripts?: unknown; exact?: unknown; minimumReleaseAge?: unknown };
  };
  // `?.` stops at a missing `install` table instead of throwing.
  if (config.env !== false) problems.push("bunfig.toml: keep `env = false` (no implicit .env loading)");
  if (config.install?.ignoreScripts !== true) problems.push("bunfig.toml: keep `ignoreScripts = true` under [install]");
  if (config.install?.exact !== true) problems.push("bunfig.toml: keep `exact = true` under [install]");
  const age = config.install?.minimumReleaseAge;
  if (typeof age !== "number" || age < MIN_RELEASE_AGE) {
    problems.push(`bunfig.toml: keep minimumReleaseAge at ${MIN_RELEASE_AGE} (7 days) or more`);
  }
}

const root = readJson("package.json");
checkManifest("package.json", root);
for (const workspace of root.workspaces ?? []) {
  const path = `${workspace}/package.json`;
  checkManifest(path, readJson(path));
}
checkBunfig();

if (problems.length > 0) {
  console.error(`check-pins: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("check-pins: all versions exact, install rules intact");

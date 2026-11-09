// The SDK loops forever on mount unless @assistant-ui/store and tap stay at the versions
// TrueForge itself was built with. This fails at a TrueForge bump that moves them, so
// the root `overrides` get re-checked rather than forgotten.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSnapshot, REPO_ROOT } from "@forge-lab/lib/snapshot";

type RootManifest = { overrides: Record<string, string> };

const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as RootManifest;
const lockfile = readFileSync(join(openSnapshot().dir, "pnpm-lock.yaml"), "utf8");

test.each(["@assistant-ui/store", "@assistant-ui/tap"])("%s is pinned to the Source Snapshot's version", (name) => {
  const version = root.overrides[name];
  expect(version).toBeDefined();
  // A package key in pnpm's lockfile looks like `  '@assistant-ui/store@0.2.21':`.
  expect(lockfile).toContain(`'${name}@${version}':`);
});

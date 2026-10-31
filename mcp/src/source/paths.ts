// Keeps every path the model sends inside the Source Snapshot. The snapshot is
// untrusted data and the arguments come from a model that reads it, so a path
// like `../../.ssh/id_ed25519`, or a symlink planted in the tree, must not reach
// a file outside the root.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// A discriminated union: check `ok` and the compiler knows which other fields exist.
export type Resolved = { ok: true; path: string; rel: string } | { ok: false; reason: string };

// `root` must already be a real path (no symlinks in it), as Snapshot.root is.
export function resolveInside(root: string, rel: string): Resolved {
  if (rel.includes("\0")) return { ok: false, reason: "the path contains a NUL byte" };
  if (isAbsolute(rel)) return { ok: false, reason: "absolute paths aren't allowed" };
  const full = resolve(root, rel);
  if (!within(root, full)) return { ok: false, reason: "the path climbs out of the snapshot" };
  if (!existsSync(full)) return { ok: false, reason: `${rel} doesn't exist in the snapshot` };
  // The lexical check above can't see symlinks; the real path can.
  const real = realpathSync(full);
  if (!within(root, real)) return { ok: false, reason: "the path is a symlink that leads out of the snapshot" };
  return { ok: true, path: real, rel: relative(root, real) };
}

export function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

// ripgrep globs only filter what it finds under the search root, so they can't
// widen the search; refusing these still keeps the model's intent obvious.
// Returns the reason it's refused, or undefined when it's fine.
export function checkGlob(glob: string): string | undefined {
  if (glob.includes("\0")) return "the glob contains a NUL byte";
  if (isAbsolute(glob)) return "absolute globs aren't allowed";
  if (glob.split("/").includes("..")) return "globs can't contain `..`";
  return undefined;
}

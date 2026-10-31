// The Source Snapshot as the source tools see it: the pinned tree on disk plus one
// long-lived, read-only ts-morph Project over its harness packages (#22, #23).
// The Project is built once, before the server listens, so no call ever waits on
// a half-built index. Started from #23's benchmark index (harness/scripts/lib/source-index.ts).

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { openSnapshot } from "@forge-lab/lib/snapshot";
import { Project, ts } from "ts-morph";
import { within } from "./paths";

// The two packages that hold the harness internals (419 files at 198a2ead,
// counting the 7 generated `.gen.ts` files).
export const HARNESS_PACKAGES = ["packages/trueforge", "packages/trueforge-core"] as const;

export type Snapshot = {
  root: string; // a real path, so `within()` comparisons hold
  version: string;
  sha: string;
  tagSha: string | null;
  fetchedAt: string;
  project: Project;
};

// The pinned snapshot from `bun run snapshot`. Throws when it's missing: the
// server has no degraded mode (#32), and tests fail rather than skip (#54).
export function openSourceSnapshot(): Snapshot {
  const { dir, manifest } = openSnapshot();
  const root = realpathSync(dir);
  return {
    root,
    version: manifest.version,
    sha: manifest.sha,
    tagSha: manifest.tagSha,
    fetchedAt: manifest.fetchedAt,
    project: buildProject(root),
  };
}

// The snapshot has no node_modules, so `@truefoundry/trueforge-core/...` would
// resolve to nothing. Rebuild the workspace link from trueforge-core's
// package.json `exports` map instead: every entry with a `trueforge-dev`
// condition becomes a TypeScript `paths` entry pointing at the `src/*.ts` file.
function workspacePaths(root: string): Record<string, string[]> {
  const pkgDir = join(root, "packages/trueforge-core");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, unknown>;
  };
  const paths: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (typeof target !== "object" || target === null) continue;
    const dev = (target as Record<string, { types?: string } | undefined>)["trueforge-dev"];
    if (!dev?.types) continue;
    const key = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`; // "./core" -> ".../core"
    paths[key] = [join(pkgDir, dev.types)];
  }
  return paths;
}

// One Project over an explicit file list: no tsconfig graph, no dependency walk,
// and no diagnostics (`getPreEmitDiagnostics` would type-check all of it).
export function buildProject(root: string): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      // ts-morph re-exports its bundled TypeScript (6.0) as `ts`.
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      customConditions: ["trueforge-dev"],
      lib: ["lib.esnext.d.ts"],
      types: [],
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      noEmit: true,
      paths: workspacePaths(root),
    },
  });
  for (const pkg of HARNESS_PACKAGES) project.addSourceFilesAtPaths(join(root, pkg, "src/**/*.ts"));
  // The glob follows symlinks; a file that really lives outside the root is dropped.
  for (const file of project.getSourceFiles()) {
    if (!within(root, realpathSync(file.getFilePath()))) project.removeSourceFile(file);
  }
  return project;
}

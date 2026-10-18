# Source Snapshot: pinning TrueForge's source and indexing it with ts-morph on Bun

Resolves ZeleMate/forge-lab#22. Researched 2026-10-18. Facts below are measured from primary sources unless marked **ESTIMATE**. Nothing was run under Bun or ts-morph (neither is installed on the research machine), so all timing and memory numbers are estimates to be replaced by a real measurement (see "Open questions").

## Short answer

1. **Version to commit**: the npm SLSA provenance attestation for `@truefoundry/trueforge@0.179.2` names git commit `198a2ead7bcc32b00aef75d22eea6fa1569d1734`. Pin the Source Snapshot to that SHA. Caveat: the git tag `v0.179.2` is a different commit (`d482f8ae`, two commits later) that only touches release metadata, no `.ts` files.
2. **Repo**: a pnpm monorepo with six packages, 2,250 `.ts`/`.tsx` files (about 242k lines) at the pinned commit. The harness internals live in two packages, `trueforge-core` and `trueforge`, about 59k lines of `src` across 412 files.
3. **ts-morph on Bun**: no known incompatibility. ts-morph 28.0.0 bundles its own copy of TypeScript 6.0 as plain JS, so it does not depend on the repo's own TypeScript 7. One long-lived read-only `Project`, loaded from an explicit list of source files (not the tsconfig graph), is the right shape. **ESTIMATE**: a few seconds to parse, 5 to 20 s for the first type-aware query, under 1.5 GB RSS.
4. **Division of labour**: ts-morph for declaration, references, implementations, type of expression, call sites; ripgrep for text, config keys, strings, docs, YAML, tests and anything outside the program. Details and the starter tool list are at the end.

## 1. Mapping an npm version to a git commit

### What the registry says

- `npm view @truefoundry/trueforge` metadata (`https://registry.npmjs.org/@truefoundry%2ftrueforge`): dist-tag `latest` is `0.179.2`; `repository` is `git+https://github.com/truefoundry/trueforge.git` with `directory: packages/trueforge`. The version manifest has **no `gitHead` field**, so metadata alone does not name the commit.
- `dist.attestations.provenance.predicateType` is `https://slsa.dev/provenance/v1`, fetched from `https://registry.npmjs.org/-/npm/v1/attestations/@truefoundry%2ftrueforge@0.179.2`.
- That endpoint returns two attestations: an npm publish attestation and a SLSA provenance one. The SLSA statement (base64 DSSE payload at `attestations[1].bundle.dsseEnvelope.payload`) contains:
  - `subject`: `pkg:npm/%40truefoundry/trueforge@0.179.2`, sha512 `6f31a536...ec0ae9`
  - `buildDefinition.externalParameters.workflow`: repository `https://github.com/truefoundry/trueforge`, path `.github/workflows/release.yml`, ref `refs/heads/release-v0.179.2`
  - `buildDefinition.internalParameters.github.event_name`: `workflow_dispatch`
  - `buildDefinition.resolvedDependencies[0]`: `git+https://github.com/truefoundry/trueforge@refs/heads/release-v0.179.2`, **`gitCommit: 198a2ead7bcc32b00aef75d22eea6fa1569d1734`**
  - `runDetails.metadata.invocationId`: `https://github.com/truefoundry/trueforge/actions/runs/38887805069/attempts/1`
- Caveat: I decoded the payload but did **not** verify the Sigstore signature chain. For the Cartographer, decoding is enough to locate the commit; verification (for example `npm audit signatures` or `gh attestation verify`) would be an extra hardening step, not done here.

### Trap: the branch and tag moved past the attested commit

| Ref | SHA | Note |
|---|---|---|
| attested build commit | `198a2ead` | "Expose Prometheus metrics for inbound HTTP requests (#1053) (#1083)", 2026-10-16. `packages/trueforge/package.json` says version `0.179.1` here. |
| `c3c3eddb` | | "Version Packages for 0.179.2" (changesets bump) |
| `release-v0.179.2` branch head, and tag `v0.179.2` | `d482f8ae` | "release(chart): 0.179.2" |

The `compare` API shows `198a2ead...d482f8ae` is 2 commits ahead, and the changed files are only `.changeset/config.json`, `.changeset/prometheus-http-metrics.md` (removed), `charts/trueforge/Chart.yaml`, `charts/trueforge/values.yaml`, `packages/trueforge/CHANGELOG.md` and `packages/trueforge/package.json`. No source files differ.

Consequences:
- The release workflow ran at `198a2ead`, before the version bump landed on the branch. Resolving "version X" via `git checkout v0.179.2` gives different bytes (though identical TypeScript) from the attested commit.
- Recommendation: **the attested SHA is the source of truth**. Record the tag SHA as an alias in the snapshot manifest, and do not rely on the branch name (it is a mutable ref; it already moved after the build).
- Do not trust `package.json#version` inside the snapshot to equal the running version; it reads `0.179.1` at the attested commit.

### Cheap fetch recipe (measured)

```
git init snapshot && cd snapshot
git remote add origin https://github.com/truefoundry/trueforge.git
git fetch --depth 1 origin 198a2ead7bcc32b00aef75d22eea6fa1569d1734   # allowed by GitHub; ~26 s here
git checkout FETCH_HEAD
```
Measured result: `.git` 23 MB, working tree 68 MB, 3,000 tracked files. GitHub reports the whole repo as about 47 MB (`gh api repos/truefoundry/trueforge` `size: 47418` KB, includes history). A tarball via `https://github.com/truefoundry/trueforge/archive/<sha>.tar.gz` would avoid `.git` but loses `git blame`/`git log` tools; keep the shallow clone and add `git fetch --deepen`/`--unshallow` lazily if history tools are added.

How the Cartographer learns the running version: the server exposes its version via `packages/trueforge/src/packageVersion.ts` (file exists; I did not read how it is surfaced). Whether the running server exposes this over its API (for example a health or version route) is an open question for the ticket about connecting to the server. Mapping flow: running version -> registry attestation -> SHA -> fetch -> write `.source-snapshot.json` (`{version, sha, tagSha, attestationSubjectDigest, fetchedAt}`).

## 2. Repo layout, size and what matters

Monorepo root (`pnpm-workspace.yaml`: `packages/*`), Node >= 22.14, pnpm 11. Also present: `charts/` (Helm), `docs/`, `python/`, `benchmark/`, `scripts/`, `AGENTS.md`/`CLAUDE.md` at root and in four packages (useful, human-written architecture rules; read them with ripgrep or file read, not ts-morph).

Counts at `198a2ead` (measured with `git ls-files` and `wc -l`; LOC includes blank lines and comments):

| Package | `src` files | `src` LOC | tests files / LOC | Role |
|---|---|---|---|---|
| `trueforge-core` (`@truefoundry/trueforge-core`) | 105 | 18,054 | 60 / 13,013 | **Harness engine**: `src/core/` (73 files, 13,252 LOC), `src/agent-session/` (23, 4,247), `src/request-reply/` (8, 549) |
| `trueforge` (`@truefoundry/trueforge`, the server) | 307 | 41,263 | 116 / 22,297 | **Server**: Hono routes, DB stores (Kysely, Postgres/SQLite), sandbox providers, MCP, auth, controller |
| `trueforge-sdk` | 913 | 25,484 | 85 / 16,579 | Fern-generated API client. Generated; do not hand-edit (per `trueforge/AGENTS.md`) |
| `trueforge-ui` | 348 | 45,906 | | React UI library |
| `assistant-ui-runtime` | 43 | 9,377 | | UI runtime adapter |
| `frontend` | 11 | 684 | 4 / 217 | Vite app shell |
| **All** | | | | **2,250 `.ts`/`.tsx` files, 242,315 lines, 8.76 MB of text** (all tracked, tests included); 2 tracked `.d.ts` |

Packages that matter for harness internals, in priority order:

1. `packages/trueforge-core/src/core/runtime` (11 files, 3.3k LOC: `AgentThread.ts` 1,543 lines, `AgentThreadOrchestrator.ts`), `core/llm` (`VercelAILLM.ts` 1,498 lines), `core/capabilities`, `core/mcp`, `core/sandbox`, `core/events`, plus `agent-session` (`Sessions.ts`, `SessionHandle.ts`, `TurnHandle.ts`, `TurnResourceResolver.ts`, a package-level `README.md`). This is plans/turns/tools/context/approvals.
2. `packages/trueforge/src`: `routes/` (agent, session, turn, schedule, ...), `apis/`, `runtime/`, `controller/`, `db/` (146 files, 17.6k LOC, mostly stores and migrations), `sandbox/`, `mcp/`, `schemas/` (zod + OpenAPI), `config.ts` (1,522 lines, env/config surface).
3. `packages/trueforge/catalog/*.yaml` (model, MCP, skill, sandbox, web-search catalogs): data, ripgrep territory.
4. Lower priority for the Cartographer: `trueforge-sdk` (generated), `trueforge-ui`, `assistant-ui-runtime`, `frontend`, `charts/`, `python/`.

Harness-relevant subset (core + server `src`, no tests): **412 files, about 59k LOC**. Adding their tests: 588 files, about 95k LOC.

### Compiler configuration (matters a lot for ts-morph)

- `tsconfig.base.json` (root): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `target/module: ESNext`, **`moduleResolution: bundler`**, `skipLibCheck: true`, `lib: ["ESNext"]`.
- **No project references and no `composite`**: each package has its own `tsconfig.json` extending the base; there is no `references` graph to follow. Packages are linked by pnpm `workspace:*` dependencies and the `package.json` `exports` map.
- `packages/trueforge/tsconfig.json` sets **`customConditions: ["trueforge-dev"]`**. In `trueforge-core/package.json`, `exports` entries (`.`, `./core`, `./agent-session`, ...) map the `trueforge-dev` condition to `./src/*.ts` and the default to `./dist/*`. `trueforge-core/AGENTS.md` says that condition name must stay `trueforge-dev`. So without `customConditions` and without built `dist/`, a cross-package import resolves to nothing.
- Cross-package resolution normally goes through `node_modules/@truefoundry/*` symlinks created by `pnpm install`. The Source Snapshot will not have these (we never install the repo's dependencies).
- `paths` override in both `trueforge` and `trueforge-core` tsconfigs: `openai/resources/chat` -> `node_modules/openai/resources/chat/index.d.ts` (needs install; ignore).
- `devDependencies` has `typescript: ^7.0.2` (the native Go compiler). That is the repo's own build tool and is irrelevant to ts-morph, which brings its own TS (section 3).
- **Generated files are gitignored and absent from a clean checkout**: `packages/trueforge-core/src/core/sandbox/sandboxScripts.gen.ts` and `packages/trueforge/src/catalog/{model,mcp,skill,sandbox,webSearch}Catalog.gen.ts`. They are produced by `build:gen` scripts (`generate-sandbox-scripts.mjs`, `generate-catalog.mjs`, `generate-local-sandbox-scripts.mjs`) that import only `node:fs`, `node:path`, `node:url`, so they are dependency-free and could be run by Bun in the snapshot step. I did not run them (instruction: no repo scripts). Without them, a few imports are unresolved (indexing still works; those symbols are `any`/missing).
- Third-party types (`hono`, `@hono/zod-openapi`, `zod` v4, `kysely`, `@modelcontextprotocol/sdk`, `@types/node`) are not available without `node_modules`. Declarations, references and call sites inside the repo's own code still work; types that flow through third-party generics (route handler `c` context, zod inferred shapes, Kysely query builders) degrade to `any`. This is the main fidelity cost of not installing.

## 3. ts-morph on Bun

### Version and compatibility facts

- Latest ts-morph is **28.0.0** (2026-04-12), "feat(BREAKING): TypeScript 6.0" (release notes, `github.com/dsherret/ts-morph/releases`). Dependencies: `@ts-morph/common ~0.29.0`, `code-block-writer ^13.0.3`. No `engines` field. `@ts-morph/common@0.29.0` depends on `minimatch`, `path-browserify`, `tinyglobby`. (Note: npm's `rc` tag is `2.0.4-rc`, an old stale tag; ignore.)
- `@ts-morph/common@0.29.0` ships **its own bundled `dist/typescript.js` (about 9 MB, `versionMajorMinor = "6.0"`)** plus `dist/ts-morph-common.js`; the lib `.d.ts` files are embedded. It does not resolve `typescript` from the project's `node_modules`. Therefore the repo's TypeScript 7 does not matter, and TS 6.0 handles TrueForge's syntax (checked config options above are all supported in TS 5/6).
- **TypeScript 7 (native Go) status in ts-morph**: ts-morph issue #1621 "ts-morph and Go based native tsc": maintainer says he is working on a TS7 backend (`tsgo-wasm` branch, then a native backend; edit dated 6 Sep 2026: "There's now a native backend and it's faster than ts-morph on ts 6"). Nothing is released to npm as of this research (latest remains 28.0.0). Issue #1685 (Sep 2026, closed) reports a mutation-heavy tool running slower on a TS7 backend through RPC than TS5 in-process (158 s vs 199 s) and advises waiting for official support. Takeaway: **pin ts-morph 28.0.0 (TS 6.0)**; do not chase TS 7 for this project; revisit later.
- **Bun**: Bun's Node-compat page (`bun.com/docs/runtime/nodejs-compat`) states a goal of full Node.js API compatibility and lists `node:fs` and `node:vm` as fully implemented; it says nothing specific about the TypeScript compiler API or ts-morph. Searching `oven-sh/bun` issues for "ts-morph" and "typescript compiler API" returned no open ts-morph compatibility bug (the hit "Crash with Typescript Compiler API" #18960 was an auto-install/dangling-pointer crash, fixed and closed). Searching `dsherret/ts-morph` issues for "bun" returned one relevant item: #1613 (open): `sourceFile.move` is very slow, "Bun and Deno took 10+ minutes" vs `tsx` 3 minutes. That is a **mutation** workload (moving files); the Cartographer's index is read-only and does not hit that path. Latest Bun release observed: v1.4.3 (2026-10-10).
- Conclusion: expected to work, with no documented blockers. But "expected" is not "verified": the first implementation task should run a smoke script (below) on Bun; JavaScriptCore vs V8 performance on a compiler workload is unknown to me.

### Cold start and memory: estimates (ESTIMATE, not measured)

Reference points from primary sources (TypeScript team's native-port announcement, `devblogs.microsoft.com/typescript/typescript-native-port/`, for tsc 5.8 full type-check, JS implementation): tRPC 18k LOC 5.5 s; date-fns 104k LOC 6.5 s; TypeORM 270k LOC 17.5 s; Playwright 356k LOC 11.1 s; VS Code 1.5M LOC 77.8 s. The same article says the native version uses about half of the JS compiler's memory (so the JS compiler is heavy; no absolute numbers given).

Applying that to TrueForge (ts-morph adds object-wrapper overhead on top of the compiler; ts-morph does not type-check unless asked):

| Step | Scope | ESTIMATE | Reasoning |
|---|---|---|---|
| Create `Project` + add ~412 source files (parse + bind, no check) | harness subset, 59k LOC | 1 to 4 s | Parsing is a small fraction of tsc time; embedded libs (about 9 MB TS bundle) add load time; ts-morph also parses lib files lazily |
| Same, all 2,250 files | 242k LOC | 3 to 12 s | roughly linear |
| First type-aware query (builds `Program` + checker, resolves imports/lib) | harness subset | 3 to 15 s | tsc full check of 18k to 100k LOC is 5 to 7 s even with mostly small code; we do not check everything, only what the query touches, but module resolution and lib loading are paid once |
| Warm queries: `getDefinitions`, `findReferences` | harness subset | 10 ms to 2 s | find-references scans all files in the program for the symbol name; the first call after edits is the slow one (not relevant, snapshot is read-only) |
| RSS after indexing | harness subset | 400 to 900 MB | JS compiler programs commonly use 5 to 10 KB of heap per source line once checked, plus ts-morph wrappers (wrappers are created lazily and cached) |
| RSS, all packages | 242k LOC | 1 to 2 GB | |

These are order-of-magnitude figures to size the design, not benchmarks. The decision they support (one long-lived program, lazy wrapper creation, scoped file set) holds across the plausible range; only the "is it too slow to be interactive" question could flip, and it is cheap to measure (below).

### One long-lived `Project` or per-package lazy indexing?

**Recommendation: a single long-lived, read-only `Project`, created once at server start (or lazily on the first source-tool call), over an explicit file set, with no per-package projects.**

Why:
- Cross-package questions are the Cartographer's core use ("who calls `AgentThread.run`", "where is this core type used in a route"). Per-package projects cannot see across the boundary, and rebuilding is more expensive than holding one program.
- TypeScript already defers the expensive work: parsing/binding up front, type checking only per queried node. ts-morph additionally creates its AST wrapper objects lazily. Do not call `getPreEmitDiagnostics` or `emit`; it forces a full check.
- The snapshot never changes within a pinned version, so there is no invalidation problem; the long-lived cache stays valid until the version changes (then rebuild the process or the `Project`).
- MCP servers are long-running processes already (the Cartographer MCP server is TypeScript on Bun), so holding about 0.5 to 1.5 GB is acceptable on a developer machine; if it is not, the fallback is to lazy-create a second `Project` for the less-used packages.

How to build it (design, not run):
- `new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true, useInMemoryFileSystem: false, compilerOptions: {...} })`. Do **not** use `tsConfigFilePath` of each package: it drags in `tests`, scripts, `tsup.config.ts`, jest configs and `types: ["node","jest"]` that do not resolve without install.
- `compilerOptions`: copy from `tsconfig.base.json` (`moduleResolution: bundler`, `module/target: ESNext`, `strict`, `skipLibCheck`) plus `customConditions: ["trueforge-dev"]` and `noEmit`.
- Replace the missing `node_modules` workspace symlinks with explicit `paths`: `@truefoundry/trueforge-core` -> `packages/trueforge-core/src/index.ts`, `@truefoundry/trueforge-core/core` -> `.../src/core/index.ts`, `/agent-session` -> `.../src/agent-session/index.ts`, and so on from the `exports` map (generate this mapping by reading `trueforge-core/package.json` `exports` entries with the `trueforge-dev` condition). Likewise for `@truefoundry/trueforge-sdk` if it is included.
- File set, tiered: **tier 1** (index at start): `packages/trueforge-core/src/**/*.ts` and `packages/trueforge/src/**/*.ts`. **Tier 2** (add on first use of a "tests" or "sdk/ui" tool, or when a query names it): `packages/*/tests`, `packages/trueforge-sdk/src`, `assistant-ui-runtime`, `trueforge-ui`, `frontend`. Adding source files later is cheap in ts-morph (`project.addSourceFilesAtPaths`), though it invalidates the program once.
- Run the three generators (dependency-free `.mjs`) in the snapshot-preparation step so `*.gen.ts` exist. Mark that as an explicit, auditable step rather than "running repo scripts"; it is the one exception worth making. Alternatively accept the gaps.
- Return source positions as `path:line:col` relative to the snapshot root plus the pinned SHA, so every answer is anchored to the commit.

Cheap spike to run first on Bun (when it is installed; this is the measurement that replaces the estimates): create the Project over tier 1, log `process.memoryUsage()` and elapsed times for (a) add files, (b) first `getTypeChecker()`/`findReferences` on `AgentThread`, (c) a warm repeat. Run the same script under Node if available to separate "Bun slower" from "ts-morph slow".

## 4. What ts-morph answers well vs what ripgrep should do

ts-morph (backed by the TS language service and type checker) is strong where meaning, not text, matters:

| Question | ts-morph API | Quality here |
|---|---|---|
| Find declaration of a symbol by name/kind/export | `sourceFile.getClass/getFunction/getInterface/getTypeAlias/getVariableDeclaration`, `getExportedDeclarations()`, or walk `project.getSourceFiles()` | Good, purely syntactic + symbol table. Works without installed deps |
| Go to definition from a usage | `identifier.getDefinitionNodes()` / `languageService.getDefinitions` | Good for repo-internal symbols (needs `paths` for cross-package) |
| Find references / usages | `node.findReferencesAsNodes()` (rename-aware, includes re-exports and destructuring) | Good, but a full-program scan; the precise tool ripgrep cannot emulate (distinguishes shadowed names, re-exports, type-only usage) |
| Implementations of an interface or abstract class | `findImplementations()`, `getDerivedClasses()` | Good; ripgrep `implements X` misses `extends`/structural satisfaction |
| Outline / signatures / JSDoc of a file or class | `getMethods()`, `getParameters()`, `getJsDocs()`, `getText()` of signature | Good |
| Type of an expression / return type / inferred type | `node.getType().getText(node)`, `getReturnType()` | Good for repo-internal types; degrades to `any` where a type flows through uninstalled third-party generics (Hono context, zod inference, Kysely) |
| Call hierarchy | **No built-in call-hierarchy API in ts-morph.** Incoming calls: `findReferencesAsNodes()` on the function/method, then for each reference take `getFirstAncestor(isFunctionLike)` and `parent` CallExpression. Outgoing calls: `getDescendantsOfKind(SyntaxKind.CallExpression)` then `getExpression().getSymbol()`/`getDefinitionNodes()`. (The underlying language service has `prepareCallHierarchy`, reachable via `project.getLanguageService().compilerObject`.) | Workable; incoming is more reliable than outgoing; dynamic dispatch, callbacks, DI and event emitters will be missed |
| Imports/exports graph, who imports module X | `getImportDeclarations()`, `getModuleSpecifierSourceFile()`, `getReferencingSourceFiles()` | Good and cheap |

Leave to ripgrep (fast, no program, covers non-TS):
- Raw string and literal search: error messages, log lines, event type names, env var names, route paths, SQL, `TODO`/`FIXME`.
- Config and data: YAML catalogs, `package.json`, Helm values, `docs/`, `AGENTS.md`/`CLAUDE.md`/READMEs, Markdown, Python.
- Tests and fixtures (by default not in the ts-morph tier 1).
- "Is X mentioned anywhere" with an unknown symbol kind, regex patterns, and any file the program excludes.
- Anything that must work while the ts-morph index is still warming up.

Measured sanity check: ripgrep 15.2.0 scanned the whole repo for `AgentThread` in about 30 ms wall (45 matching files), so ripgrep needs no index and should be the default first step for exploration; use ts-morph to confirm meaning.

## 5. Recommended indexing strategy

1. **Snapshot step** (one-time per server version): resolve version -> SHA via the attestation; shallow-fetch that SHA; write `.source-snapshot.json`; run the three dependency-free generators; do not install dependencies.
2. **Index step** (process start or first call): single long-lived read-only ts-morph `Project`, tier 1 files only, `paths` + `customConditions` as above, no diagnostics. Expose `index_status` so the agent can see "warming / ready / degraded (any-typed imports N)".
3. **Query step**: ripgrep first for discovery, ts-morph to resolve and relate. Cap results (for example 50 hits) and return snippets with `path:line` plus the SHA.
4. **Version change**: dispose the `Project`, rebuild snapshot; keep the old snapshot directory for sessions recorded against the old version.

## 6. Starter source tools for the Cartographer MCP server

All outputs include `{path, line, column}` relative to the snapshot root and the snapshot SHA; all are read-only; paths are validated to stay inside the snapshot.

| Tool | Input | Output | Engine |
|---|---|---|---|
| `source_status` | none | `{version, sha, tagSha, packages, indexState, filesIndexed, anyTypedImports, warmedAtMs}` | snapshot manifest + ts-morph |
| `search_text` | `pattern`, `regex?`, `paths?` (package or glob), `fileTypes?`, `limit?`, `context?` | list of `{path, line, snippet}` | ripgrep |
| `read_file` | `path`, `startLine?`, `endLine?` | text slice, with line numbers | filesystem |
| `list_directory` | `path`, `depth?` | tree of names, with file sizes | filesystem |
| `find_declaration` | `name`, `kind?` (class, function, interface, type, const, enum), `package?` | list of `{kind, name, path, line, signature, jsdoc, exported}` | ts-morph |
| `get_symbol` | `path`, `line`, `column` (or `name` + `path`) | declaration text, signature, JSDoc, base types, members summary | ts-morph |
| `find_references` | `path`, `line`, `column` (or `symbol` name + `path`), `includeTests?`, `limit?` | list of `{path, line, enclosingSymbol, usageKind (call/type/import/assign), snippet}` | ts-morph |
| `find_implementations` | symbol (as above) | implementers/subclasses with locations | ts-morph |
| `type_of` | `path`, `line`, `column` | `{typeText, isAny, note}` where `note` flags degraded third-party types | ts-morph |
| `file_outline` | `path` | top-level and class-level declarations with signatures, lines | ts-morph |
| `module_graph` | `path`, `direction` (imports/importedBy), `depth?` | adjacency list | ts-morph |
| `call_hierarchy` | symbol, `direction` (incoming/outgoing), `depth?` (default 1) | tree of `{symbol, path, line}`; with `confidence` and a "may miss dynamic dispatch" note | ts-morph (composed from references + call-expression walk) |
| `find_docs` | `query` | matches in `AGENTS.md`, `CLAUDE.md`, READMEs, `docs/` | ripgrep |
| `catalog_lookup` (later) | `catalog` (model/mcp/skill/sandbox/web-search), `key?` | YAML entries | ripgrep/YAML read |

Suggested build order: `source_status`, `search_text`, `read_file`, `find_declaration`, `find_references`, `type_of` (these answer most "how does X work" questions), then `file_outline`, `module_graph`, `find_implementations`, `call_hierarchy`.

## Open questions

1. **Measured performance on Bun**: run the spike (cold start, first type query, RSS) on Bun, and on Node for comparison. Decide whether tier 1 fits comfortably and whether a Worker/subprocess is needed to keep the MCP event loop responsive during the first query (ts-morph is synchronous and will block while the program is built).
2. **How the running server reports its version**: confirm the exact route or field that exposes `0.179.2` (probably a health/version endpoint or `packageVersion.ts`), since the whole pinning flow starts from it. Belongs with the server-connection ticket.
3. **Attestation verification**: whether to verify the Sigstore signature (`npm audit signatures` / `gh attestation verify`) or trust the decoded commit. Decoded commit is enough for a learning project; verification is optional.
4. **Generators and fidelity**: whether to run the three dependency-free generator scripts in the snapshot step (recommended) and whether to accept `any`-typed third-party flow, or install dependencies in a sandbox to get exact types (large, executes install scripts; not recommended).
5. **Self-hosted servers on a different build**: if the running server is a locally built or patched image rather than the npm package, there is no attestation; fall back to the Docker image label or the Helm chart appVersion (`charts/trueforge/Chart.yaml`) mapped to tag `v<version>`, which is a slightly different commit as shown above.
6. **ts-morph and TypeScript 7**: re-check when ts-morph ships its native backend; no action needed now.

## Sources

- npm registry metadata: `https://registry.npmjs.org/@truefoundry%2ftrueforge`, attestations `https://registry.npmjs.org/-/npm/v1/attestations/@truefoundry%2ftrueforge@0.179.2`
- GitHub repo `truefoundry/trueforge` at `198a2ead7bcc32b00aef75d22eea6fa1569d1734` and `d482f8aed78e2882a78d7164c000554ca0e9be03` (tree, compare API, `tsconfig.base.json`, `pnpm-workspace.yaml`, per-package `tsconfig.json`/`package.json`/`AGENTS.md`, `.gitignore`, generator scripts); shallow clone used for counting, removed afterwards
- ts-morph: releases page and npm metadata (28.0.0, deps), `@ts-morph/common@0.29.0` tarball (bundled TS 6.0), issues #1621, #1685, #1613, #1679 on `github.com/dsherret/ts-morph`
- Bun: `https://bun.com/docs/runtime/nodejs-compat`; issues on `github.com/oven-sh/bun` (#18960 and search results for ts-morph / compiler API); release v1.4.3
- TypeScript team, native port announcement `https://devblogs.microsoft.com/typescript/typescript-native-port/` (build-time table, memory statement)

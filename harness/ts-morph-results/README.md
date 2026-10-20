# ts-morph on Bun and Node (ticket #23)

Does indexing TrueForge's source with ts-morph block the MCP server's event loop for long enough to need a worker thread, or lazy per-package loading?

Scripts:

- [`scripts/lib/source-index.ts`](../scripts/lib/source-index.ts): the index (one long-lived, read-only ts-morph `Project` over the two harness packages, with `paths` built from trueforge-core's `exports` map) and first cuts of `find_declaration`, `find_references` and `type_of`. It uses no Bun APIs, so it runs on both runtimes.
- [`scripts/ts-morph-bench.ts`](../scripts/ts-morph-bench.ts): one benchmark pass in one process; prints one JSON line.
- [`scripts/ts-morph-bench-run.ts`](../scripts/ts-morph-bench-run.ts): `bun run ts-morph-bench -- --snapshot <dir> --runs 7`. Runs the pass 7 times on each runtime, alternating, each in a fresh process under `/usr/bin/time -l` (for wall time and peak RSS), takes medians, and saves the raw passes as timestamped JSON in this folder.

## Setup

- **Source Snapshot:** `truefoundry/trueforge` at the attested commit `198a2ead7bcc32b00aef75d22eea6fa1569d1734` (0.179.2), shallow-fetched with the recipe in [docs/research/source-snapshot.md](../../docs/research/source-snapshot.md) into a scratch folder outside the repo. No dependency install, no repo scripts, no generators run.
- **File set:** `packages/trueforge/src/**/*.ts` and `packages/trueforge-core/src/**/*.ts`: 412 files, as the research counted.
- **ts-morph 28.0.0** (bundled TypeScript 6.0), exact pin in `package.json`. New packages: `ts-morph`, `@ts-morph/common`, `code-block-writer`, `minimatch`, `path-browserify`, `tinyglobby` (+ `fdir`, `picomatch` 4, `brace-expansion`, `balanced-match`). None has an install script; `minimatch` has a `prepare` script, which runs only for git installs, and Bun runs no dependency scripts anyway (nothing is in `trustedDependencies`).
- **Runtimes:** Bun 1.4.3 and Node v26.12.0 (strips types natively), on the user's Mac.
- **Symbols:** `AgentThread` (the loop's core class), `LargeToolResponseProcessor` (a capability), `DynamicSubAgents` (the subagent capability; there is no `createSubAgent` in this source), `SessionHandle`, and `buildTurnSandbox` (in the server package, typed from trueforge-core, so it crosses the package boundary).
- **Per symbol:** `find_declaration` by name, `find_references` from the declaration, then `type_of` at the first usage in another file. "First" is the first call; "warm" is the median of 5 repeats.
- **Stress:** `find_references` on the two most-used harness symbols (`Database`, 210 references; `RequestErrorResponseSchema`, 201), then `getPreEmitDiagnostics()` over the whole program. No tool calls the full check; it's the upper bound on one synchronous call and on memory.

## Expected (the research's estimates)

From [docs/research/source-snapshot.md](../../docs/research/source-snapshot.md), "Cold start and memory": 1–4 s to add the 412 files, 3–15 s for the first type-aware query, 10 ms–2 s for warm queries, 400–900 MB RSS.

## Observed (2026-10-20, median of 7 runs per runtime)

| Metric | Bun 1.4.3 | Node v26.12.0 |
|---|---:|---:|
| Process wall time (import + load + all queries + full check) | 1580 ms | 1450 ms |
| Cold load: add 412 files | 188 ms | 191 ms |
| First type-aware query (`find_references AgentThread`; builds the Program) | 140 ms | 127 ms |
| `find_declaration`: first call, worst symbol | 23 ms | 16 ms |
| `find_declaration`: warm, median symbol | 4.94 ms | 3.69 ms |
| `find_references`: first call, worst symbol | 140 ms | 127 ms |
| `find_references`: warm, median symbol | 3.66 ms | 2.50 ms |
| `type_of`: first call, worst symbol | 34 ms | 45 ms |
| `type_of`: warm, median symbol | 0.02 ms | 0.03 ms |
| Stress `find_references Database` (210 results) | 13 ms | 14 ms |
| Stress `find_references RequestErrorResponseSchema` (201 results) | 20 ms | 20 ms |
| Stress full semantic check, all 412 files | 776 ms | 619 ms |
| RSS after load | 178 MB | 225 MB |
| RSS after the representative queries | 437 MB | 291 MB |
| RSS after full check | 513 MB | 350 MB |
| Peak RSS (`time -l`) | 561 MB | 371 MB |

Per symbol (medians; Bun / Node):

| Symbol | Tool | First | Warm | Results |
|---|---|---:|---:|---:|
| `AgentThread` | find_declaration | 23 / 16 ms | 5.89 / 4.34 ms | 1 |
| `AgentThread` | find_references | 140 / 127 ms | 4.24 / 2.75 ms | 24 |
| `AgentThread` | type_of | 34 / 45 ms | 0.02 / 0.04 ms | 1 |
| `LargeToolResponseProcessor` | find_declaration | 6.11 / 6.00 ms | 4.54 / 3.83 ms | 1 |
| `LargeToolResponseProcessor` | find_references | 6.16 / 2.87 ms | 2.38 / 1.48 ms | 2 |
| `LargeToolResponseProcessor` | type_of | 0.48 / 0.32 ms | 0.02 / 0.03 ms | 1 |
| `DynamicSubAgents` | find_declaration | 5.06 / 4.42 ms | 4.07 / 3.60 ms | 1 |
| `DynamicSubAgents` | find_references | 5.87 / 3.95 ms | 1.95 / 1.50 ms | 2 |
| `DynamicSubAgents` | type_of | 0.28 / 0.27 ms | 0.02 / 0.01 ms | 1 |
| `SessionHandle` | find_declaration | 5.01 / 4.26 ms | 4.94 / 3.63 ms | 1 |
| `SessionHandle` | find_references | 13 / 9.06 ms | 4.36 / 2.68 ms | 20 |
| `SessionHandle` | type_of | 0.66 / 0.38 ms | 0.03 / 0.03 ms | 1 |
| `buildTurnSandbox` | find_declaration | 5.39 / 4.44 ms | 4.74 / 3.63 ms | 1 |
| `buildTurnSandbox` | find_references | 12 / 7.83 ms | 3.66 / 2.53 ms | 4 |
| `buildTurnSandbox` | type_of | 0.81 / 0.65 ms | 0.02 / 0.02 ms | 1 |

Other observations:

- **The very first run after the fetch was much slower on Bun:** 3.95 s to add the files, against about 190 ms on every later run (Node's first run, straight after, took 200 ms). That points at a cold disk cache for the freshly checked-out files, not at Bun; it can't be repeated without `sudo purge`, so treat "a few seconds, once, after a new snapshot" as the true cold start.
- **The research overestimated by one to two orders of magnitude.** TypeScript's find-references only binds and checks the files whose text contains the name, so the first type-aware query doesn't type-check the program. Even a full check of all 412 files stays under 1 s.
- **Bun and Node are close on time; Bun holds more memory** (about 1.5× peak RSS: 561 vs 371 MB), still inside the research's 400–900 MB range.
- **Import health:** 1,448 imports resolve. 10 workspace imports don't: 8 are the un-generated `*.gen.ts` files (catalogs and sandbox scripts) and 2 are `@truefoundry/trueforge-sdk`, which isn't in this file set. All 521 third-party imports (zod, hono, kysely, ...) are unresolved, because the snapshot has no `node_modules` and never will; their types are `any`. That makes queries cheaper than they would be with installed dependencies, but it is exactly the setup the MCP server will run, so the numbers hold for it. It also means `type_of` will often answer `any` for values that come from a library; the tool must say so (the research's `isAny` / `note` field).
- **`find_declaration` is AST-only** in this cut (no checker), so its cost is a walk over 412 files: about 4–5 ms, regardless of symbol.

## Verdict: neither a worker nor lazy per-package loading

The longest synchronous stretch a real tool call causes is about 140 ms (the first `find_references`, which builds the Program); warm calls take single-digit milliseconds. Loading takes about 0.2 s (plus about 85 ms to import ts-morph), or a few seconds once on a cold disk cache. Against MCP's 2-minute request timeout, and against the sessions and triage servers that share the process, that's an invisible delay. A worker would add message passing, serialisation of every result and a second copy of the runtime for no benefit, and per-package loading would break the cross-package questions that are the point of the index.

So the source server keeps the design from #22 and #8: one long-lived, read-only `Project` in the shared Bun process, built at server start (before the listener accepts requests, so no call ever waits on a half-built index), no `index_status` "warming" state needed. Guardrails:

- Never call `getPreEmitDiagnostics`, `emit` or anything that type-checks the whole program from a tool (it's the 0.6–0.8 s upper bound measured above).
- Cap result counts (the research's `limit`): the 210-result stress case is cheap to compute, but its projection is what costs tokens.
- Re-run this benchmark if tier 2 (tests, SDK, UI, about 2,250 files in all) is added, or when ts-morph moves to its TypeScript 7 backend.

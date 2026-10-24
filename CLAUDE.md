# forge-lab

A personal learning project. The user builds **Cartographer**, an agent on the TrueForge harness, to learn deeply how TrueForge works inside and the TypeScript it's written in. Building it is the point; edge cases are triggered on purpose.

## Start here

- **The map** is GitHub issue #1 (`gh issue view 1 -R ZeleMate/forge-lab`): destination, standing notes, every decision so far, and what's still fog. Read it before any work. It's the source of truth; this file only points at it.
- **Tickets** are the map's sub-issues, labelled `wayfinder:research|grilling|prototype|task`, with GitHub's native blocked-by links. The frontier is open, unblocked, unassigned tickets. Work them with the `wayfinder` skill: claim by assigning `ZeleMate`, resolve one ticket per session, then post a resolution comment, close it, and add one line to the map's "Decisions so far".
- **Vocabulary**: `CONTEXT.md`. Use its terms exactly (Agent, Session, Turn, Approval, Subagent, Source Snapshot, Experiment, Experiment Session).
- **Research**: `docs/research/`. Its README marks which docs are superseded.

## Rules

- **The user enters every live key.** The OpenRouter key lives in the git-ignored root `.env`; the user registers it by running `bun run apply:provider` in `harness/`. Read variable names, never values, and keep keys out of chat, files and logs.
- **The user writes the Harness Notes prose** (`docs/harness-notes/`). Your part: find code, trace calls, run Experiments, supply citations.
- **Teach while writing TypeScript**: one-sentence comments on idioms the user may not know. Explain TrueForge's internals on their own terms, never by comparison with other harnesses or the user's job.
- **Models** (all via OpenRouter): Opus 5.5 (`opus-5-5`) for Cartographer itself; `glm-5-3-flash` for smoke tests and mechanics Experiments.
- **Security**: every change follows `docs/research/security-review.md`: exact version pins, loopback only, no trusted dependency scripts.
- **Write tools act only on Experiment Sessions** (`metadata.experiment` set). Never on the user's own chat sessions.
- **Run the server only while working** (`cd harness && bun run start`, in a terminal tab the user can see), and stop it afterwards.

## Gotchas

- The local sandbox needs `python3` ≥ 3.10 at `/opt/homebrew/bin`. TrueForge searches a fixed path and ignores `$PATH`; macOS's 3.9 passes the startup check but breaks the sandbox bootstrap. See `harness/README.md`.
- Inside the sandbox, `$HOME` is remapped to a private `.home`. Isolation probes need absolute paths.
- TrueForge API responses are wrapped in `{ data }` (plus `pagination` on lists). Agent updates (`PUT /agents/{id}`) must omit `name`. `reasoning_effort` is rejected unless the model declares `reasoning_efforts`.
- Opus via OpenRouter gets no prompt caching (TrueForge sends no `cache_control` on custom providers). The user accepted this.
- Shared API helpers and port constants live in the `@forge-lab/lib` package (`lib/trueforge.ts`, `lib/ports.ts`). Extend them rather than copying.
- **Bun workspaces**: one `bun.lock`, `bunfig.toml` and `tsconfig.base.json` at the root; run `bun install` there. `bunfig.toml` sets `env = false` (no implicit `.env`; scripts that need a key pass `--env-file`) and `ignoreScripts = true` (no install scripts at all). A new package must be added to the root `workspaces` list: Bun errors on listed folders that don't exist.
- **Checks**: `bun run check` at the root (Biome with `--error-on-warnings`, then `tsc` in every package); `bun run format` applies Biome's fixes. A new package needs a `typecheck` script and a `tsconfig.json` extending `tsconfig.base.json`. The `*-results/` folders are recorded output: Biome skips them, never reformat them.

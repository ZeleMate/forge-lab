# forge-lab

A personal learning project: **Cartographer**, an agent built on the [TrueForge](https://trueforge.dev) agent harness. It explains how TrueForge works by mapping two territories: TrueForge's TypeScript source at the running version, and its own live sessions. The goal is to learn TrueForge's internals, and TypeScript along the way, by building on it and deliberately triggering its edge cases.

## Status

The local harness runs and is verified, and the design is mostly decided. Cartographer itself isn't built yet. The way forward is charted on the [wayfinder map](https://github.com/ZeleMate/forge-lab/issues/1): each decision is a sub-issue, and closed ones are indexed under "Decisions so far".

Done so far:
- TrueForge 0.180.0 pinned and hardened in [`harness/`](harness/), with OpenRouter models.
- A smoke test on four models: tool discovery, caching, parallel subagents.
- The local sandbox verified: exec, code mode, and the isolation boundaries.

## Stack

- **Harness:** TrueForge 0.180.0, local standalone mode, bound to `127.0.0.1`.
- **Models (via OpenRouter):** Opus 5.5 as the main model; GLM-5.3-Flash, DeepSeek-V4-Flash and the Auto Router as cheaper alternatives.
- **Cheap triage:** the OpenAI Decisions API, called from Cartographer's MCP server.
- **Code:** TypeScript on Bun. Planned: our own MCP server (source, session and triage tools), a React 19 + Vite chat app, and Experiment scripts.

## Where things are

| Path | What |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | Domain glossary |
| [`AGENTS.md`](AGENTS.md) | Orientation and rules for coding agents ([`CLAUDE.md`](CLAUDE.md) imports it for Claude Code) |
| [`package.json`](package.json), [`bunfig.toml`](bunfig.toml), [`bun.lock`](bun.lock) | Bun workspaces root: one lockfile, install rules, and the checks (`bun run check` = `lint` + `typecheck`; `bun run format` rewrites) |
| [`biome.jsonc`](biome.jsonc), [`tsconfig.base.json`](tsconfig.base.json) | Biome lint and format rules; the shared strict TypeScript options |
| [`SECURITY.md`](SECURITY.md) | The security rules in one page, pointing at the full review |
| [`.claude/settings.json`](.claude/settings.json) | Project settings for Claude Code: agents may not read `.env` files |
| [`harness/`](harness/) | The pinned local TrueForge server and its scripts (`start`, `apply:provider`, `smoke`, `sandbox-check`, `session-api-check`, `ts-morph-bench`) |
| [`lib/`](lib/) | `@forge-lab/lib`: shared TrueForge API helpers the local ports and the Source Snapshot pin reader |
| [`agents/`](agents/) | `@forge-lab/agents`: the Cartographer Agent spec and its instructions, plus the MCP servers it attaches |
| [`scripts/dev.ts`](scripts/dev.ts), [`scripts/apply.ts`](scripts/apply.ts) | `bun run dev` starts the whole local stack in one terminal tab (snapshot check, TrueForge, MCP server, apply, Vite) and stops it with Ctrl-C; `bun run apply` registers the specs on a running TrueForge (repo wins, diff shown; `-- --dry-run` writes nothing) |
| [`snapshot.json`](snapshot.json), [`scripts/snapshot.ts`](scripts/snapshot.ts) | The Source Snapshot pin (0.180.0 → attested commit `d15fbad7`) and its lifecycle: `bun run snapshot` fetches and generates it read-only in `~/Library/Caches/forge-lab/trueforge-src/<sha>/`; `bun run snapshot:pin` re-pins after a TrueForge bump |
| [`docs/research/`](docs/research/) | Findings behind each research ticket, with superseded ones marked |
| [`lefthook.yml`](lefthook.yml), [`scripts/hooks.ts`](scripts/hooks.ts), [`scripts/check-pins.ts`](scripts/check-pins.ts) | The git hooks and the checks they run (see below) |
| [`.github/`](.github/) | CI (`workflows/ci.yml`), its verified-download actions, Dependabot and zizmor config; [`scripts/audit.ts`](scripts/audit.ts) is the `bun audit` accept list |

## Git hooks

The hooks in [`lefthook.yml`](lefthook.yml) are the first gate on this repo; CI and the ruleset on `main` come after (see [`SECURITY.md`](SECURITY.md)). Set them up once per clone:

```bash
brew install lefthook gitleaks actionlint zizmor
```

```bash
lefthook install
```

- **pre-commit** (staged files only): Gitleaks, no `.env` files except `.env.example`, Biome with fixes re-staged, exact pins and install rules (`bun run check:pins`), the Source Snapshot pin, and `actionlint` plus `zizmor` on `.github/` files.
- **pre-push:** no pushes to `main` (push a branch and open a PR), Gitleaks on the pushed commits, the pin, Source Snapshot and workflow checks again over the whole tree (so a `--no-verify` commit can't skip them), `bun install --frozen-lockfile`, `bun run check` and `bun test`.

**CI** ([`ci.yml`](.github/workflows/ci.yml)) runs on every PR, on pushes to `main`, and weekly: `lint`, `typecheck`, `test`, `deps` (frozen install, exact pins, Source Snapshot pin, `bun run audit`), `secrets` (Gitleaks over the full history) and `workflows` (`actionlint`, `zizmor`). Until the ruleset on `main` requires it, it can't block a merge, so don't merge a PR with a red run.

Never skip the hooks with `--no-verify`. If a hook is wrong, fix the hook in its own PR. The one exception is a documented reason in the commit or PR description.

## Repo baseline

The CI, security and agent setup comes from [`ZeleMate/repo-template`](https://github.com/ZeleMate/repo-template), adopted at v0.3.0 and adapted to Bun, Biome and Lefthook ([`.copier-answers.yml`](.copier-answers.yml); `uvx copier update --trust` pulls later versions). See the [setup checklist](docs/SETUP.md), [architecture decisions](docs/decisions/), [threat model](docs/THREAT_MODEL.md), [agent policy](docs/agent-policy.md) and [contributing guide](CONTRIBUTING.md).

## Licence

MIT. See [LICENSE](LICENSE).

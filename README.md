# forge-lab

A personal learning project: **Cartographer**, an agent built on the [TrueForge](https://trueforge.dev) agent harness. It explains how TrueForge works by mapping two territories: TrueForge's TypeScript source at the running version, and its own live sessions. The goal is to learn TrueForge's internals, and TypeScript along the way, by building on it and deliberately triggering its edge cases.

## Status

The local harness runs and is verified, and the design is mostly decided. Cartographer itself isn't built yet. The way forward is charted on the [wayfinder map](https://github.com/ZeleMate/forge-lab/issues/1): each decision is a sub-issue, and closed ones are indexed under "Decisions so far".

Done so far:
- TrueForge 0.179.2 pinned and hardened in [`harness/`](harness/), with OpenRouter models.
- A smoke test on four models: tool discovery, caching, parallel subagents.
- The local sandbox verified: exec, code mode, and the isolation boundaries.

## Stack

- **Harness:** TrueForge 0.179.2, local standalone mode, bound to `127.0.0.1`.
- **Models (via OpenRouter):** Opus 5.5 as the main model; GLM-5.3-Flash, DeepSeek-V4-Flash and the Auto Router as cheaper alternatives.
- **Cheap triage:** the OpenAI Decisions API, called from Cartographer's MCP server.
- **Code:** TypeScript on Bun. Planned: our own MCP server (source, session and triage tools), a React 19 + Vite chat app, and Experiment scripts.

## Where things are

| Path | What |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | Domain glossary |
| [`CLAUDE.md`](CLAUDE.md) | Orientation and rules for coding agents |
| [`package.json`](package.json), [`bunfig.toml`](bunfig.toml), [`bun.lock`](bun.lock) | Bun workspaces root: one lockfile, install rules, `bun run typecheck` across packages |
| [`harness/`](harness/) | The pinned local TrueForge server and its scripts (`start`, `apply:provider`, `smoke`, `sandbox-check`, `session-api-check`, `ts-morph-bench`) |
| [`lib/`](lib/) | `@forge-lab/lib`: shared TrueForge API helpers and the local ports |
| [`docs/research/`](docs/research/) | Findings behind each research ticket, with superseded ones marked |
| [`.github/copilot-instructions.md`](.github/copilot-instructions.md) | Review rules (automatic PR review is currently off) |

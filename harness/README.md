# harness

A pinned, local TrueForge server for forge-lab. It follows the hardening rules in [docs/research/security-review.md](../docs/research/security-review.md).

## Machine prerequisites (macOS)

```bash
brew install node bun python@3.13
```

```bash
ln -s /opt/homebrew/opt/python@3.13/libexec/bin/python3 /opt/homebrew/bin/python3
```

The link matters. TrueForge's local sandbox looks for `python3` on a **fixed** path (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:…`) and ignores your `$PATH`. Without the link it finds macOS's Python 3.9, which passes TrueForge's startup check but crashes the sandbox bootstrap (`TypeError: unsupported operand type(s) for |`). The link also makes 3.13 your shell's default `python3`. To undo it: `rm /opt/homebrew/bin/python3`.

At startup the server logs which Python it picked: `Local sandbox fallback is available {… "python": "…3.13…"}`.

## OpenRouter account setup (done once, on openrouter.ai)

This lives in your OpenRouter account, not in the repo:

1. **API key** named `forge-lab`, with a **credit limit** ($5 so far).
2. **Privacy**: training on prompts off; zero-data-retention endpoints only, where offered.
3. **Routing defaults** for the Auto Router (`openrouter/auto`): open-weight model families, low cost tier. They're set at account level because TrueForge drops the per-request `plugins` field.

Put the key in the repo-root `.env`, which is git-ignored:

```
OPENROUTER_API_KEY=sk-or-v1-…
```

## Run

```bash
cd harness
bun install --frozen-lockfile
bun run start
```

Then, with the server up, register the models. You run this yourself, because it sends the key:

```bash
bun run apply:provider
```

The UI is at http://127.0.0.1:8790. Stop the server with Ctrl-C when you're done: it has no login and no Host/Origin checks, so it should only run while you're using it.

## Scripts

| Script | What it does |
|---|---|
| `start` | Starts TrueForge on `127.0.0.1:8790` with telemetry off |
| `apply:provider` | Upserts the `openrouter` provider: `opus-5-5` (main), `glm-5-3-flash`, `deepseek-v4-flash`, `openrouter-auto` |
| `smoke [model…]` | Tool discovery, cache reads, and (on GLM) parallel subagents, via DeepWiki. Results go to `smoke-results/` |
| `sandbox-check` | Local sandbox exec, code mode, and isolation probes (network, real home, repo `.env`, writes). Results go to `sandbox-results/` |
| `session-api-check [guard]` | What an MCP tool sees of its own Session, self-cancel, forks from paused/cancelled/error Turns, inline replay and `PATCH`. Runs a throwaway MCP server on `127.0.0.1:8791`. Expected vs observed in `session-api-results/README.md` |
| `ts-morph-bench -- --snapshot <dir> [--runs N]` | ts-morph cold start, first and warm latency of `find_declaration` / `find_references` / `type_of`, and RSS, on Bun and Node, over a Source Snapshot fetched outside the repo. Needs no server. Expected vs observed in `ts-morph-results/README.md` |

Shared API helpers are in `scripts/lib/trueforge.ts`; a minimal hand-rolled MCP server for Experiments is in `scripts/lib/probe-mcp.ts`.

## What's pinned and why

- `@truefoundry/trueforge` **0.179.2**, exact, with `bun.lock` committed. Its tarball sha512 (`bzGlNqIo…K6Q==`) matches the one reviewed in the security research; npm provenance names source commit `198a2ead`.
- `bunfig.toml` refuses packages published less than 7 days ago. The three first-party TrueForge packages are excluded from that rule on purpose: 0.179.2 was reviewed by hand while it was 2 days old.
- No dependency is trusted to run install scripts. `bun pm untrusted` shows one blocked script, `protobufjs`'s version-warning `postinstall`, which isn't needed.

## Runtime settings (in the `start` script)

| Variable | Value | Why |
|---|---|---|
| `HOST` | `127.0.0.1` | Loopback only, never the network |
| `PORT` | `8790` | TrueForge's default |
| `DO_NOT_TRACK` | `1` | Disables OpenUI's install telemetry, as a second safeguard |
| `SENTRY_ENABLED` | `false` | Already the default; set explicitly |
| `OUTBOUND_URL_ALLOWED_HOSTS` | `["127.0.0.1"]` | TrueForge's outbound URL guard blocks loopback, so without this it refuses to register our own MCP servers on `127.0.0.1`. It allows the whole host (every port), not one URL |

TrueForge keeps its data (including the OpenRouter key, unencrypted) in `~/Library/Application Support/trueforge/db/db.sqlite`, and sandboxes under `…/trueforge/sandboxes/`.

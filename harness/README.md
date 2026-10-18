# harness

A pinned, local TrueForge server for forge-lab. It follows the hardening rules in [research/security-review.md](https://github.com/ZeleMate/forge-lab/blob/research/security-review/research/security-review.md).

## Run

```bash
cd harness
bun install --frozen-lockfile
bun run start
```

Then open http://127.0.0.1:8790. Stop it with Ctrl-C when you're done: the server has no login and no Host/Origin checks, so it should only run while you're using it.

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

## Keys

The OpenRouter key goes into TrueForge's UI (Settings → Models), never into this repo or a chat. TrueForge stores it unencrypted in SQLite in its app data directory, so use a dedicated key with a low credit limit.

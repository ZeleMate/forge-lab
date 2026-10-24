# Security

forge-lab is a private personal learning repo. The full reasoning is in [docs/research/security-review.md](docs/research/security-review.md); this page lists the rules that follow from it.

## Nothing on GitHub enforces anything

The repo stays **private on GitHub Free** (decided in [#28](https://github.com/ZeleMate/forge-lab/issues/28)), so there are no rulesets, no branch protection and no secret scanning. The local Lefthook hooks are the only gate (Gitleaks, Biome, `tsc`, an exact-pin check, no direct pushes to `main`). CI reports but cannot block. Setup is in the [README](README.md#git-hooks); never skip the hooks with `--no-verify` without a documented reason.

## Rules

- **Dependencies:** exact versions only, published at least 7 days ago (`bunfig.toml`). No `trustedDependencies`, and `ignoreScripts = true` stops every install script, including those for packages on Bun's built-in trust list. To check, run `bun install --verbose | grep Scripts`; it should print nothing. Under the isolated linker `bun pm untrusted` reports nothing even when scripts were skipped, so it is no check.
- **Keys:** the user enters every live key. `.env` files stay git-ignored, Bun never loads them implicitly (`env = false`), and [`.claude/settings.json`](.claude/settings.json) denies agents reading them. `.env.example` files hold variable names only.
- **Servers:** bind to `127.0.0.1` only, never `0.0.0.0`, and run TrueForge only while working (it has no login and no DNS-rebinding defence).
- **Write tools** act only on Experiment Sessions and sit behind an Approval.

## Reporting

This is a single-person repo with no users. Open an issue, or tell the owner directly.

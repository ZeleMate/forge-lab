# Security

forge-lab is a private personal learning repo. The full reasoning is in [docs/research/security-review.md](docs/research/security-review.md); this page lists the rules that follow from it.

## Nothing on GitHub enforces anything

The repo stays **private on GitHub Free** (decided in [#28](https://github.com/ZeleMate/forge-lab/issues/28)), so there are no rulesets, no branch protection and no secret scanning. The local Lefthook hooks are the only gate (Gitleaks, Biome, `tsc`, an exact-pin check, no direct pushes to `main`). CI reports but cannot block. Setup is in the [README](README.md#git-hooks); never skip the hooks with `--no-verify` without a documented reason.

## Rules

- **Dependencies:** exact versions only, published at least 7 days ago (`bunfig.toml`). No `trustedDependencies`, and `ignoreScripts = true` stops every install script, including those for packages on Bun's built-in trust list. To check, run `bun install --verbose | grep Scripts`; it should print nothing. Under the isolated linker `bun pm untrusted` reports nothing even when scripts were skipped, so it is no check.
- **Keys:** the user enters every live key. `.env` files stay git-ignored, Bun never loads them implicitly (`env = false`), and [`.claude/settings.json`](.claude/settings.json) denies agents reading them. `.env.example` files hold variable names only.
- **Servers:** bind to `127.0.0.1` only, never `0.0.0.0`, and run TrueForge only while working (it has no login and no DNS-rebinding defence).
- **CI:** no secrets, read-only token, every action pinned to a full commit SHA, and tools downloaded with pinned SHA-256 digests rather than through third-party actions. The one exception is the [Claude review](.github/workflows/claude-review.yml): a code review and a security review through Anthropic's `claude-code-action` (with `oven-sh/setup-bun`, which it uses, the only entries on the Actions allowlist). It reads the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (the owner's Claude subscription) and may comment on PRs. It runs only on PRs from this repo (not forks or Dependabot). `bun run audit` fails on any high or critical advisory not in its accept list ([`scripts/audit.ts`](scripts/audit.ts)), and each acceptance has a reason and a review-by date.
- **Write tools** act only on Experiment Sessions and sit behind an Approval.

## Reporting

This is a single-person repo with no users. Open an issue, or tell the owner directly.

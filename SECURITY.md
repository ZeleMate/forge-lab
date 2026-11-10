# Security

forge-lab is a public personal learning repo with one owner ([@ZeleMate](https://github.com/ZeleMate)) and no users. The full reasoning is in [docs/research/security-review.md](docs/research/security-review.md); this page lists the rules that follow from it.

## Reporting a vulnerability

Report it privately through **GitHub's private vulnerability reporting**: the repo's **Security** tab, then **Report a vulnerability**. Never in a public issue, discussion, PR or comment.

Include what you found, how to reproduce it, and the impact you expect. A vulnerability in TrueForge itself belongs upstream: follow [TrueForge's security policy](https://github.com/truefoundry/trueforge/blob/main/SECURITY.md).

### What to expect

- Acknowledgement within **14 days** (usually much sooner; this is a one-person project).
- A fix or mitigation plan once the report is confirmed.
- Credit in the fix's PR, unless you prefer otherwise.
- Coordinated disclosure: please give a chance to fix it before going public.

### Scope

This repository's code, its CI, and the MCP server and agents it runs locally. Cartographer is an LLM agent, so reports about prompt injection, tool misuse, data leakage through model output, or unsafe model-driven actions are in scope, even when the root cause is model behaviour rather than a code bug.

## Who gives instructions

Anyone can open issues and comment on a public repo, and the agents working here read GitHub. So for local agents only text authored by `ZeleMate` counts as instructions ([AGENTS.md](AGENTS.md)); everything else is untrusted data. CI treats all GitHub text as data, never as instructions, and also limits what it reads: the [Claude review](.github/workflows/claude-review.yml) fetches the issues a PR references in a plain `run:` step and keeps only text whose author is the owner or a collaborator. Collaborators can push to the repo anyway, and today the owner is the only one. Claude itself may run one exact `gh pr view` and cannot read issues or comments.

## What GitHub enforces

The local Lefthook hooks stay the first gate (Gitleaks, Biome, `tsc`, an exact-pin check, no direct pushes to `main`). Setup is in the [README](README.md#git-hooks); never skip them with `--no-verify` without a documented reason. Behind them, these GitHub protections are active on this public repo. [`scripts/bootstrap-github.sh`](scripts/bootstrap-github.sh) (from the repo template; run `--dry-run` first) reapplies the settings, and [docs/SETUP.md](docs/SETUP.md) lists the manual steps:

- **A ruleset on `main`** ([.github/rulesets/main.json](.github/rulesets/main.json)): changes land through squash-merged PRs, with no force-pushes or deletions, review threads resolved, and the `ci-ok` check (every CI job) passing.
- **Secret scanning with push protection**, as a second layer behind Gitleaks.
- **Dependabot alerts and security updates** next to OSV-Scanner and the Dependabot version updates.
- **CodeQL default setup** for GitHub Actions and JavaScript/TypeScript.
- **Private vulnerability reporting**, as described above.
- **Approval before workflows run on any outside contributor's fork PR.** Fork PRs never get the Claude review anyway; see CI below.
- **[CODEOWNERS](.github/CODEOWNERS)** names the owner for every path.

## Third-party GitHub Apps

Each installed GitHub App holds a standing credential for the repos it can reach, so each one is listed here with what it can do. Review the list at **Settings → Applications → Installed GitHub Apps**.

- **Socket** (`socket-security`, free plan), installed on this repo only ([trial](https://github.com/ZeleMate/forge-lab/issues/42)). It flags malicious packages on dependency PRs, which CVE feeds miss until an advisory exists. It reads text `bun.lock` across the workspaces and comments a per-package score table on PRs, Dependabot's included, with two checks that aren't required. Permissions: read and **write** on code, checks and pull requests (write so it can open "Socket Patch" PRs), and read on issues, merge queues and metadata. The `main` ruleset still stops it changing `main` except through a PR. It keeps a dependency list (SBOM) for each scanned commit on its dashboard. Its default policy doesn't alert on install scripts; `ignoreScripts` covers those. Remove it if it gets broader permissions or stops reporting on Bun.
- **SonarQube Cloud**: see CI below.

## Rules

- **Dependencies:** exact versions only, published at least 7 days ago (`bunfig.toml`). No `trustedDependencies`, and `ignoreScripts = true` stops every install script, including those for packages on Bun's built-in trust list. To check, run `bun install --verbose | grep Scripts`; it should print nothing. Under the isolated linker `bun pm untrusted` reports nothing even when scripts were skipped, so it is no check.
- **Keys:** the user enters every live key. `.env` files stay git-ignored, Bun never loads them implicitly (`env = false`), and [`.claude/settings.json`](.claude/settings.json) denies agents reading them. `.env.example` files hold variable names only.
- **Servers:** bind to `127.0.0.1` only, never `0.0.0.0`, and run TrueForge only while working (it has no login and no DNS-rebinding defence).
- **CI:** no secrets, read-only token, every action pinned to a full commit SHA, and tools downloaded with pinned SHA-256 digests rather than through third-party actions. CI also runs OSV-Scanner ([security.yml](.github/workflows/security.yml)); OSV-Scanner's accepted advisories are in [`osv-scanner.toml`](osv-scanner.toml), each with a reason and a review date. The one exception is the [Claude review](.github/workflows/claude-review.yml): an advisory code review and security review through Anthropic's `claude-code-action` (with `oven-sh/setup-bun`, which it uses, the only third-party entries on the Actions allowlist). It reads the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (the owner's Claude subscription) and may comment on PRs, but no job can write to the repo. It runs once per PR, or on demand, and only on PRs from this repo (not forks or Dependabot). SonarQube Cloud analyses PRs through its GitHub app (Automatic Analysis), outside CI.
- **Write tools** act only on Experiment Sessions and sit behind an Approval.

---
status: accepted
---

# Adopt the repo template, keep the Bun toolchain

Partly superseded by [0004](0004-advisory-review-and-fewer-ci-gates.md): the CI SonarQube job, Claude's fix commit, `bun run audit` and Semgrep are gone.

## Context and problem statement

forge-lab adopted `ZeleMate/repo-template` v0.3.0 (TypeScript, public, agentic) before going public, to get its security baseline and to receive later template updates with `copier update`. The template assumes pnpm, ESLint, Prettier, Vitest, pre-commit and release-please. forge-lab already had a stricter, Bun-based setup: exact pins, a 7-day release age, no install scripts, Lefthook hooks, tools fetched with pinned digests, and a hardened Claude review with an author filter.

## Decision outcome

Take the template's baseline around forge-lab's own toolchain, and keep forge-lab's choice wherever it is stricter or already in place:

- **Taken:** `ci-ok` and the `main` ruleset, OSV-Scanner (`security.yml`), SonarQube Cloud (through its GitHub app, see 0004), the template update check, Dependabot for the CI tools, MIT licence with REUSE, `REVIEW.md`, the `code-reviewer` agent and `spec-review` skill, issue and PR templates, the threat model, agent policy, ADRs, setup checklist and bootstrap script.
- **Kept:** Bun (not pnpm), Biome (not ESLint or Prettier), `bun test` (not Vitest), Lefthook (not pre-commit), forge-lab's CI jobs and `claude-review.yml`, and tools fetched through `.github/actions/fetch-binary` (uv too) instead of setup actions.
- **Changed from the template:** the bootstrap script keeps the Actions allowlist (`selected`, not `all`), Gitleaks runs once (ci.yml), and OSV-Scanner has an accept list with review dates.
- **Added on the owner's decision:** the SonarQube MCP server for local coding agents (`.mcp.json`), on Sonar's hosted endpoint in read-only mode, with only its read tools allowed.
- **Accepted exceptions to the security review's rules:** that MCP endpoint is a third-party service, not loopback, and is reachable only by coding agents, not by Cartographer (threat model T7).
- **Left out:** release-please, `CHANGELOG.md` and SBOM (nothing is versioned or released), the Inspect AI eval suite (placeholder cases, an Anthropic key and unpinned Python dependencies; Cartographer runs on OpenRouter), `docs/slo.md` (nothing is deployed), and the diff-cover changed-line coverage gate (a new habit worth its own decision).

### Consequences

- Good: the security baseline and future template updates, with no step back from forge-lab's rules.
- Bad: every `copier update` will offer the left-out and replaced files again; reject them in review, against this ADR. The same goes for the answers `ts_linter: eslint` and `node_version: '26'` in `.copier-answers.yml`: the template has no Biome or Bun option, and those answers only drive files forge-lab skips.

---
status: accepted
---

# Advisory Claude review, and one tool for each CI job

## Context and problem statement

CI had grown overlapping checks. The Claude review ran on every push and fixed its own findings with a model-written commit, which needed a write token and a long list of protections. SonarQube ran twice over (the SonarCloud app and a CI job), and known vulnerabilities were gated by both `bun audit` and OSV-Scanner. The owner approved consolidating them.

## Decision outcome

- **The Claude review is advisory.** It runs once per PR (`opened`, `ready_for_review`, `reopened`) or on demand (`workflow_dispatch`), and it only comments. The `claude-fix`, `claude-push` and `claude-leftovers` jobs are gone, so no job has `contents: write`. The #74 rules stay: exact `gh` commands, and only owner and collaborator text from referenced issues.
- **SonarQube Cloud runs only through its GitHub app** (Automatic Analysis). The CI job, its coverage artifact and `sonar-project.properties` are gone. `.mcp.json` stays.
- **OSV-Scanner is the one vulnerability gate.** On 2026-11-08 it reported both advisories `bun audit` did (zod, minimatch), and it gates every severity, not just high and critical. `scripts/audit.ts` is gone; its accepted zod entry was already in `osv-scanner.toml`. The stale entries for body-parser, qs and fast-uri went too, since `overrides` fixed those in #78.
- **Only `security.yml` runs weekly** (OSV-Scanner). `ci.yml` has no schedule.
- **CodeQL replaces Semgrep.** The repo is public, so CodeQL default setup is free; it covers JavaScript/TypeScript and Actions as a repo setting. Semgrep and its CI job are gone, and with them its Python dependencies in `.github/tools/uv.lock` and their accepted advisories.

### Consequences

- Good: fewer moving parts, no CI job that can change the repo, and `ci-ok` stays the single required check.
- Good: fewer runs on the owner's Claude subscription. To review a PR's later state, run the workflow by hand.
- Bad: findings are no longer fixed automatically, and later pushes aren't reviewed unless someone asks.
- Bad: Gitleaks no longer re-scans history weekly, so new rules only reach old commits on the next PR or push to `main`.
- Bad: `bun audit` and OSV-Scanner read different advisory sources, so an advisory in only the first now reaches us through Dependabot alerts instead.
- `.copier-answers.yml` still says `quality_platform: sonarqube-cloud`, which is true of the project; the next `copier update` may offer the CI job again, so reject it against this ADR unless the template has dropped it.

@AGENTS.md

## Claude Code specifics

- Before opening a PR, run the `spec-review` skill (diff vs. the linked issue or ADR) and `/code-review`; the `code-reviewer` subagent applies `REVIEW.md`.
- Hard limits are enforced in `.claude/settings.json` (deny rules) and hooks, not in this file. A PostToolUse hook formats files you edit with Biome.
- Path-specific rules live in `.claude/rules/`.
- Put personal preferences in `CLAUDE.local.md` only if you also keep the `@AGENTS.md` import here; Claude Code otherwise skips AGENTS.md.

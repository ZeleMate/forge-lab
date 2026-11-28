# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This is a single-context repo: the Bun workspaces (`agents`, `app`, `harness`, `lib`, `mcp`) share one glossary.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary (Agent, Session, Turn, Approval, Subagent, Source Snapshot, Experiment, Experiment Session, Chat Session, Replay, …).
- **`docs/decisions/`**: the repo's ADRs, in MADR format (`0001-…md`, `0002-…md`). Read the ones that touch the area you're about to work in. This repo uses `docs/decisions/`, not `docs/adr/`; write new ADRs there.
- **GitHub issue #1** (the map) holds "Decisions so far" that may not have an ADR yet. Read it with the author-filtered command in `docs/agents/issue-tracker.md`.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/decisions/
│   ├── 0001-record-architecture-decisions.md
│   └── …
├── agents/  app/  harness/  lib/  mcp/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term exactly as defined in `CONTEXT.md`. Don't drift to synonyms the glossary lists under _Avoid_.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0004 (advisory review and fewer CI gates), but worth reopening because…_

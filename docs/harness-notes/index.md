# Harness Notes

Progress of the two tracks against the Experiment catalogue, as decided in [What should the TrueForge deep-dive notes cover?](https://github.com/ZeleMate/forge-lab/issues/12). The topic files and their prose are the user's own.

## Track A topics

| # | Topic | Experiments | Notes |
|---|---|---|---|
| 1 | Turn loop as a state machine | 1, 14 | not started |
| 2 | Persistence and the session tree | 11, 12 | not started |
| 3 | Streaming event protocol | 1, 10 | not started |
| 4 | Tool routing and deferred meta-tools | 2 | not started |
| 5 | MCP client | 3 | not started |
| 6 | Approvals | 3, 4, 15 | not started |
| 7 | Compaction | 5 | not started |
| 8 | Large-result offload and truncation | 6 | not started |
| 9 | Subagents | 7, 8 | not started |
| 10 | Sandbox and code mode | 9 | not started |
| 11 | Model provider layer | 13 | not started |
| 12 | Agent spec and configuration | 11 | not started |

Track B, TypeScript as TrueForge uses it (`typescript.md`): not started.

## Experiments

Each one is `experiments/<name>.ts` with `<name>.expected.md`, written before the first run, and its record in `experiments/<name>-results/<model>/observed.json`.

| # | Experiment | Topics | Status |
|---|---|---|---|
| 1 | [`turn-anatomy`](../../experiments/turn-anatomy.expected.md) | 1, 3 | Run on 2026-11-28. GLM: 7 met, E6 not met, 2 n/a. Opus: 8 met, E6 and E7 not met. |
| 2 | `deferred-vs-preloaded` | 4 | not run |
| 3 | `annotation-gates` | 5, 6 | not run |
| 4 | `approval-pause-resume` | 6 | not run |
| 5 | `forced-compaction` | 7 | not run |
| 6 | `offload-vs-truncate` | 8 | not run |
| 7 | `subagent-cap` | 9 | not run |
| 8 | `subagent-blindness` | 9 | not run |
| 9 | `code-mode-chain` | 10 | not run |
| 10 | `sse-drop-resume` | 3 | not run |
| 11 | `rerun-with-new-spec` | 2, 12 | not run |
| 12 | `self-cancel` | 2 | not run |
| 13 | `cache-hits` | 11 | not run |
| 14 | `limits` | 1 | not run |
| 15 | `approve-once` | 6 | not run |

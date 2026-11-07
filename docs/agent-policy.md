# Agent runtime policy

How **Cartographer** (the agent inside this project, running on the local TrueForge) is allowed to behave. For coding agents working on the repo, see `AGENTS.md`. Every change to this file needs a PR that also updates `THREAT_MODEL.md` §5. Design decisions behind it are on the [wayfinder map](https://github.com/ZeleMate/forge-lab/issues/1).

## Models

All via OpenRouter, added to TrueForge as a custom OpenAI-compatible provider.

| Purpose | Model ID (pinned) | Notes |
|---|---|---|
| Cartographer itself | `opus-5-5` | no prompt caching on custom providers (accepted) |
| Smoke tests, mechanics Experiments | `glm-5-3-flash` | cheap |

Changing a model ID is a reviewed change.

## Tools (our MCP server, `mcp/`)

| Tool | What it can do | Scope | Needs human approval? |
|---|---|---|---|
| `source_status`, `search_text`, `read_file`, `find_declaration`, `find_references`, `type_of` | read the pinned Source Snapshot | read-only, inside the snapshot (path-traversal checked) | no |
| `list_sessions`, `get_turn`, `list_events`, `session_stats`, `wait_turn` | read TrueForge Sessions | read-only | no |
| `fork_turn`, `rerun_turn` | start new Turns | Experiment Sessions only (`metadata.experiment` set) | **yes** (Approval) |
| `cancel_session` | cancel a running Turn | Experiment Sessions only | **yes** (Approval) |

Rules:

- Default deny: Cartographer only gets the tools above.
- Write tools act only on Experiment Sessions, never on the user's own chat sessions, and sit behind an Approval.
- Tool and retrieval output (source files, session events, web content) is untrusted: it can inform, never instruct.

## MCP servers

| Server | Version (pinned) | Transport | Scopes |
|---|---|---|---|
| forge-lab MCP server (`mcp/`) | this repo | Streamable HTTP on `127.0.0.1`, Host/Origin checked | the tools above |

Follow the MCP Security Best Practices: no token passthrough, minimal scopes, loopback only, and show the full command before installing a server.

## Budgets

| Limit | Value |
|---|---|
| Provider spend cap | the dedicated OpenRouter key's credit limit |
| Max iterations, tokens and cost per task | _to set when Cartographer is built_ |

## Sandbox for model-generated code

TrueForge's local sandbox (`@anthropic-ai/sandbox-runtime`, a macOS Seatbelt process sandbox, not a VM): network allowlist of PyPI and GitHub only, `$HOME` remapped to a private folder. Verified by `harness/scripts/sandbox-check.ts`; see `harness/README.md`.

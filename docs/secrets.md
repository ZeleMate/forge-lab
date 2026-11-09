# Secrets

The user enters every live key ([AGENTS.md](../AGENTS.md)). Agents read variable names, never values.

## Where secrets live

| Secret | Store | Used by | Rotation |
|---|---|---|---|
| OpenRouter API key (dedicated, low credit limit) | git-ignored root `.env`, registered with `bun run apply:provider`; TrueForge then keeps it in its local SQLite, unencrypted | the local TrueForge server | when the project ends, or on leak |
| `OPENAI_API_KEY` (the triage judge; `OPENROUTER_API_KEY` works instead, for `gpt-oss-20b`) | git-ignored `mcp/.env` | the MCP server only, never TrueForge | when the project ends, or on leak |
| The owner's `gh` token | macOS keychain, through `gh auth login` | the owner and local agents | keep only the scopes this repo needs: `repo`, `read:org`, `workflow` |
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Actions secret | `claude-review.yml` | yearly (the token expires after 1 year) or on leak |
| `SONARQUBE_TOKEN` (SonarQube Cloud user token) | the owner's keychain, passed only to the Claude Code process (`docs/SETUP.md`); never in a file | `.mcp.json` (SonarQube MCP server, read through `${SONARQUBE_TOKEN:-}`, so a shell or CI job without the token still parses the config) | yearly, or on leak |
| `TEMPLATE_READ_TOKEN` (only if the template repo is private) | GitHub Actions secret | `template-update.yml` | ≤ 1 year |

## Rules

- `.env` files stay git-ignored, Bun never loads them implicitly (`env = false`), and `.claude/settings.json` denies agents reading them. `.env.example` files hold variable names only.
- `.env` files are readable only by the owner: `chmod 600 .env mcp/.env`.
- Never put secrets in prompts, logs, commits or chat.

## If a secret leaks

1. Revoke or rotate it at the provider first.
2. Check the provider's logs for use since the leak.
3. Remove it from the code; history rewriting is optional once the secret is dead.

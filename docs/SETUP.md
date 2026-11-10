# Setup checklist — forge-lab

From the repo template (v0.3.0), for a **public** repo on GitHub **Free**. forge-lab is public and these settings are applied. The script skips creating the repo, so it's only needed to reapply them.

## Automated

`./scripts/bootstrap-github.sh` (run with `--dry-run` first) does:

- Initial commit; create `ZeleMate/forge-lab` and push
- Squash-only merges, PR title as commit message, auto-delete branches
- Read-only default `GITHUB_TOKEN`; Actions must be pinned to full SHAs; the Actions allowlist stays on ("selected")
- Dependabot alerts and security updates
- Secret scanning + push protection, private vulnerability reporting, CodeQL default setup, approval before fork PR workflows run for every outside contributor
- Ruleset `main`: PR required, `ci-ok` required, review threads resolved, no force-push/delete, linear history

## Manual steps

1. **Account security (once per account):** passkey or security key on GitHub.
1. **Hooks:** `brew install lefthook gitleaks actionlint zizmor`, then `lefthook install` (see the README).
1. **Dependabot malware alerts:** Settings → Advanced Security → enable "Malware alerts" (UI only).
1. **Claude review:** run `claude setup-token` and copy the token. No Claude GitHub App is needed: the workflow posts with its own `GITHUB_TOKEN`. The token often wraps onto two lines, and a copied line break breaks it, so check the length (about 108) and store it without whitespace:
   `pbpaste | tr -d '[:space:]' | wc -c`, then `pbpaste | tr -d '[:space:]' | gh secret set CLAUDE_CODE_OAUTH_TOKEN`. Copy something else afterwards to clear the clipboard.
1. **SonarQube Cloud:** import the repo in organization `zelemate` and keep Automatic Analysis on. It needs no CI job and no secret; the SonarCloud app reports on each PR.
1. **SonarQube MCP server (local agents):** `.mcp.json` points Claude Code at SonarQube Cloud's hosted MCP endpoint (`https://api.sonarcloud.io/mcp`, org `zelemate`, `SONARQUBE_READ_ONLY: true`), so nothing runs locally. Create a SonarQube Cloud **user** token (My Account → Security; project and organization tokens don't work) and pass it as `SONARQUBE_TOKEN` to Claude Code alone, e.g. from the keychain: `security add-generic-password -a "$USER" -s SONARQUBE_TOKEN -w` once, then start it with `SONARQUBE_TOKEN=$(security find-generic-password -a "$USER" -s SONARQUBE_TOKEN -w) claude`. Don't export it from your shell profile: every process that shell starts, the TrueForge server and test runs included, would inherit it. Never put the value in a tracked file. Approve the `sonarqube` server when Claude Code first asks, then check that read-only mode took effect: in `/mcp`, the server's tools must not include `change_sonar_issue_status` or `change_security_hotspot_status`. If they do, the header is being ignored and only the deny rules protect you. `.claude/settings.json` allows only its read-only tools and denies the ones that change state. If the org is ever moved to the US region, the URL becomes `https://api.sonarqube.us/mcp`.
1. **Template updates:** if the template repo (`_src_path` in `.copier-answers.yml`) is private, create a fine-grained PAT with contents:read on that repo only and `gh secret set TEMPLATE_READ_TOKEN`. Without it the weekly "Template update check" workflow fails. Give it an expiry and rotate it.
1. **Model API key:** a dedicated OpenRouter key with a low credit limit, entered by the owner (`bun run apply:provider` in `harness/`). Keep the key files private: `chmod 600 .env mcp/.env`.
1. **Fill in** the open rows of `docs/THREAT_MODEL.md` §5 and the budgets in `docs/agent-policy.md` before Cartographer ships.
1. **Optional:** register at bestpractices.dev for the OpenSSF Best Practices Badge (passing level is reachable).

# Dependency policy

The full reasoning is in [research/security-review.md](research/security-review.md); [SECURITY.md](../SECURITY.md) lists the rules.

- **Exact pins, one lockfile.** Every version in every `package.json` is exact (`scripts/check-pins.ts`), `bun.lock` is committed, and CI installs with `bun install --frozen-lockfile --ignore-scripts`. Never edit `bun.lock` by hand.
- **Cooldown before adopting new releases.** Bun ignores releases newer than 7 days (`minimumReleaseAge` in `bunfig.toml`); Dependabot waits 7 days. No install scripts run (`ignoreScripts = true`, no `trustedDependencies`).
- **Scanning:** `bun run audit` (high/critical gate, accept list in `scripts/audit.ts`) and OSV-Scanner (every severity, accept list in `osv-scanner.toml`) on every PR and weekly; Dependabot alerts.
- **CI-only tools** (Semgrep, Copier) are locked with hashes in `.github/tools/uv.lock`, apart from the app, with the same 7-day cooldown (`exclude-newer`).
- **Adding a dependency:** confirm it exists on the official registry, is maintained, has a compatible licence, and is worth its weight. Prefer the standard library and Bun's built-ins.
- **Allowed licences:** MIT, Apache-2.0, BSD-2/3-Clause, ISC, Unicode-3.0, MPL-2.0 (file-level). Anything else needs an ADR.

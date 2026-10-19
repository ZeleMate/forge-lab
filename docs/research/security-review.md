# Is it safe to install TrueForge and its dependencies?

Ticket: [#13](https://github.com/ZeleMate/forge-lab/issues/13) · Checked 2026-10-18 · Nothing was installed or executed; all findings come from registry metadata, the published tarball, deps.dev and OSV.dev.

## Verdict

**Install, with the hardening below.** The supply chain is clean: npm provenance on every first-party package, no known-malicious dependencies, no telemetry by default. The real risks are runtime ones of an unauthenticated local server, and they're manageable for a learning setup.

## Scope

| Package | Version checked | Resolved deps |
|---|---|---|
| `@truefoundry/trueforge` (server, run via npx) | 0.179.2 | 377 |
| `@truefoundry/trueforge-ui` | 0.179.0 | 309 |
| `@truefoundry/trueforge-sdk` | 0.179.0 | 0 |
| `@modelcontextprotocol/server` | 2.3.1 | 2 |
| Node, Bun | Homebrew `node` 26.12.0, `bun` 1.4.3 | — |

669 unique packages across the four npm roots (deps.dev resolution).

## Supply chain

- **Provenance:** all four roots are published by GitHub Actions with npm provenance attestations and registry signatures, from `github.com/truefoundry/trueforge` and `github.com/modelcontextprotocol/typescript-sdk`. The downloaded server tarball's sha512 matches the registry `integrity`.
- **Licenses:** MIT (TrueForge), Apache-2.0 (MCP SDK).
- **Install scripts on the roots:** none.
- **Install scripts in the tree:** two of 669; one is install-time telemetry (see [Install scripts](#install-scripts)).
- **Maturity:** TrueForge is 0.x, first published 2026-08-13, 48 server releases in ~2 months. Expect breaking changes; pin exact versions.
- **Release age:** the server's latest (0.179.2) was 2 days old at check time. Freshly published versions are where most npm supply-chain attacks land, so impose a minimum release age.
- **Homebrew:** `node` and `bun` are both in `homebrew/core` with prebuilt bottles; no third-party tap needed.

### Known vulnerabilities (OSV.dev, all transitive)

| Package | Via | Advisory | Severity | Exposure here |
|---|---|---|---|---|
| `node-forge@1.4.0` | `@anthropic-ai/sandbox-runtime` | GHSA-86w9-cpqp-85rv (RSA PKCS#1 v1.5 signature verification) | High | Low: used for the sandbox's local proxy certificates, not for verifying third-party signatures we rely on. |
| `braces@3.0.3` | `@daytona/sdk` → fast-glob → micromatch | GHSA-vfj7-8cjw-p6xm (stack-exhaustion DoS) | High | Low: needs attacker-controlled glob patterns; only reachable if the Daytona provider is used. |
| `dompurify@3.4.15` | `monaco-editor` (UI) | GHSA-6688-9rhm-gjv2, GHSA-p98j-92pf-mc4p | Low | Low: specific `IN_PLACE` mode and hook usage. |
| `katex@0.16.47` | remark-math (UI) | GHSA-238p-pmpm-9mq7 | Low | Low: requires an existing prototype-pollution gadget. |

No `MAL-*` (malicious package) entries.

### Install scripts

Scanned every resolved version of all 669 packages in the npm registry for `preinstall`, `install` and `postinstall`. Two have one:

| Package | Via | Script | Assessment |
|---|---|---|---|
| `protobufjs@7.6.6` | gRPC / OpenTelemetry deps of the server | `node scripts/postinstall` | Benign: reads the parent `package.json` and prints a version-scheme warning. No network. |
| `@openuidev/lang-core@0.2.18` | `@openuidev/react-lang` ← `@truefoundry/trueforge-ui` | `node ./postinstall.cjs` | **Install-time telemetry** to PostHog (via a CloudFront proxy): random install ID, salted SHA-256 of the project's git origin, lang-core/Node/OS/package-manager versions, CI and Docker flags. Disclosed in the script; no paths, code or credentials. Opt-out: `OPENUI_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`. Runtime (browser) code doesn't call PostHog. |

`better-sqlite3@13.0.3` (server) has no install script in this version.

With Bun, neither script runs unless the package is added to `trustedDependencies`, so **don't trust `@openuidev/lang-core`**, and also export `DO_NOT_TRACK=1` in the project's environment as a second layer (it also covers anyone installing with npm).

## Runtime behaviour of the server (from the bundled source)

- **Bind address:** `HOST` defaults to `localhost`, `PORT` to 8790. Not exposed to the network by default.
- **Auth:** standalone mode (no OIDC configured) has **no login**; the server uses a fixed internal key `trueforge-standalone`.
- **CORS / Origin / Host checks:** none found. Browsers will block cross-origin JSON calls (preflight fails), but **DNS rebinding** is not defended: a malicious web page you visit while the server runs could, in principle, rebind its hostname to 127.0.0.1 and drive the API (run turns on your Anthropic key, read sessions, start sandbox work).
- **Telemetry:** `@sentry/node` is bundled but `SENTRY_ENABLED` defaults to `false` and there's no built-in DSN. The only TrueFoundry-owned host in the bundle is `assets.production.truefoundry.com`, used for two code-snippet icons. Other hosts are model-provider APIs and MCP catalog presets, contacted only if you configure them. There is no OpenRouter preset; it's added as a custom OpenAI-compatible provider, so prompts go to `openrouter.ai` and on to whichever inference provider OpenRouter routes to.
- **Outbound SSRF guard:** `NETWORK_POLICY_ENABLED` defaults to `true` (outbound URL allow/block lists).
- **Secrets at rest:** no encryption code in the bundle. Provider API keys are stored in plain SQLite at `<app data dir>/db/db.sqlite` (overridable with `SQLITE_PATH`); API responses redact them.
- **Local sandbox:** built on `@anthropic-ai/sandbox-runtime` (macOS Seatbelt process sandbox, not a VM). Network allowlist: PyPI and GitHub domains only. Sandbox roots live under `<app data dir>/sandboxes`.

## Hardening for the install task

1. **Install runtimes from homebrew/core:** `brew install node bun`.
2. **Don't run bare `npx @truefoundry/trueforge`.** It resolves "latest" at every launch. Instead add the server as an exact-pinned dev dependency in the repo, commit `bun.lock`, and start it via a script. Bun doesn't run dependency lifecycle scripts unless the package is listed in `trustedDependencies`; trust nothing by default and add packages only if something actually breaks.
3. **Minimum release age:** set `minimumReleaseAge` in `bunfig.toml` (e.g. 7 days) so freshly published versions aren't picked up.
4. **Bind explicitly to loopback:** `HOST=127.0.0.1`. Never set `0.0.0.0`; never port-forward or tunnel it.
5. **Run it only while working on it.** Stop the server when done; that closes the DNS-rebinding window.
6. **Use a dedicated OpenRouter API key with a low credit limit**, used only for this project, since it sits unencrypted on disk. Paste it in the TrueForge UI, never in chat or the repo; revoke it when the project ends. In OpenRouter's privacy settings, turn off providers that train on prompts and prefer zero-data-retention endpoints: OpenRouter forwards prompts to third-party inference providers whose data policies differ.
7. **Leave `SENTRY_ENABLED` unset, and set `DO_NOT_TRACK=1`** (disables OpenUI's install telemetry).
8. **Our own MCP server:** bind to 127.0.0.1 and use the SDK's Host/Origin validation helpers (see [research/paper-sources-mcp.md](https://github.com/ZeleMate/forge-lab/blob/research/paper-sources-mcp/research/paper-sources-mcp.md)).
9. **Prompt injection:** paper abstracts and web content are untrusted input to an agent that has tools. Gate every write or destructive tool behind an Approval, and keep the sandbox's network allowlist at its default.

## Not verified

- Behaviour at runtime (nothing was run). Claims above come from reading the bundled source of 0.179.2.
- Exact `<app data dir>` path (resolved by `env-paths` at runtime; under `~/Library/Application Support/` on macOS).

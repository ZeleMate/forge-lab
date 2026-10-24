# Supply-chain, secrets and CI hardening tools for a solo dev's private GitHub Free repos (Oct 2026)

Context: TypeScript/Bun monorepo, text `bun.lock`, private repos on GitHub Free (personal account), exact pins, install scripts off. Local Lefthook already runs gitleaks, zizmor, actionlint. Research date 2026-10-24. Wherever a source is older than 2026 or comes from an aggregator, the bullet says so.

## Dependency / supply-chain risk tools (Socket, OSV-Scanner, Dependabot, Renovate, bun audit, Snyk, GuardDog, Phylum/Veracode)

### Takeaway
The best free stack for a private Bun repo on GitHub Free is **Dependabot alerts** (free on all plans), **OSV-Scanner** (CLI, supports `bun.lock`) or `bun audit` for known CVEs, and the **Socket free plan**, which now covers unlimited private repos for 1 dev seat and 1,000 scans/month and catches malicious packages rather than only known CVEs. Snyk's free tier (200 OSS tests/month) mostly duplicates OSV. Phylum is no longer a standalone free product.

### Cited Findings
**Socket.dev**
- Free plan: $0, 1 dev seat, 1,000 scans/mo, API quota 500/hour, 1 repository label, **unlimited public and private repositories**. Team is $25/dev seat/mo from 5 seats (5,000 scans), Business $50/dev seat/mo from 20 seats (unlimited scans), Enterprise is custom. Yearly billing saves up to 20%. — [Socket pricing](https://socket.dev/pricing)
- The GitHub integration (GitHub App) and "block/warn on PRs" are included on every plan, Free too. Monorepo support is on all plans. **Scanning GitHub Actions** needs Business or above. Pre-commit and pre-receive hooks and webhooks are Enterprise-only. — [Socket pricing](https://socket.dev/pricing)
- The pricing page itself is inconsistent: the plan cards list API requests as 500 / 2,500 / 10,000 / unlimited, while the comparison table says 500/h, 500/h, 1,000/h, unlimited. — [Socket pricing](https://socket.dev/pricing)
- An aggregator tracker logs the private-repo free tier growing from 1 repo to unlimited repos (1,000 scans/mo, up to 5 members) on 2026-04-12. The official page now says 1 dev seat, which conflicts with "5 members". — [agentdeals.dev](https://agentdeals.dev/vendor/socket-dev); conflicts with [Socket pricing](https://socket.dev/pricing)
- The pricing page doesn't mention bun or `bun.lock` support. — [Socket pricing](https://socket.dev/pricing)
- Socket was among the early investigators of Shai-Hulud (Sept 2025). It identified at least 40 packages in the first wave and reported that the attack compromised at least 25 CrowdStrike-managed packages. — [security-insider.de](https://www.security-insider.de/npm-pakete-supply-chain-angriff-malware-infektion-a-7058d3a07ba5184bbd66002da6001877/); [Harvard tagteam / Krebs mirror](https://tagteam.harvard.edu/hub_feeds/4281/feed_items/15925827/content)

**OSV-Scanner (Google)**
- OSV-Scanner V2 (March 2025) added `bun.lock` as a supported JavaScript lockfile through its OSV-SCALIBR integration. — [Google Security Blog](https://security.googleblog.com/2025/03/announcing-osv-scanner-v2-vulnerability.html?hl=ja&m=1)
- The v2.3.2 changelog has "Include bun.lock as a supported lockfile" (#2447). — [osv-scanner releases](https://github.com/google/osv-scanner/releases)
- `osv-scanner -r` finds lockfiles recursively, and `-L bun.lock` pins the scope for CI. Since early v2 releases had gaps in default discovery, pin the scanner version. (Third-party guide, July 2026.) — [oneuptime](https://oneuptime.com/blog/post/2026-07-23-osv-scanner-dependency-discovery/markdown)

**Dependabot (GitHub-native)**
- "Some of these are included in all plans, such as dependency graph and Dependabot alerts". Only "premium Dependabot features" fall under the paid Code Security. — [GitHub Docs: About GitHub Advanced Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security)
- On private repos, alerts and the dependency graph must be turned on manually under Security & analysis. — [Microsoft Learn](https://learn.microsoft.com/en-us/training/modules/software-composition-analysis/4-implement-github-dependabot-alerts-security-updates)
- Security updates open a PR that bumps a vulnerable dependency to the minimum secure version. — [U. Michigan KB](https://teamdynamix.umich.edu/TDClient/47/LSAPortal/KB/ArticleDet?ID=13191)
- Dependabot can also update SHA-pinned Actions: it parses the trailing `# vX.Y.Z` comment and bumps both the SHA and the comment. — [pydevtools](https://pydevtools.com/handbook/how-to/how-to-pin-github-actions-by-sha-for-python-projects/)

**Renovate (Mend)**
- `minimumReleaseAge` holds an update until a set time after release, explicitly as a supply-chain defence, and it needs the registry to provide a timestamp. — [Renovate docs](https://docs.renovatebot.com/key-concepts/minimum-release-age/)
- Known gap: `minimumReleaseAge` hasn't covered transitive deps during `lockFileMaintenance`. Workaround: `minimumReleaseAgeBehaviour: timestamp-optional`. — [renovate discussion #38115](https://github.com/renovatebot/renovate/discussions/38115)
- CVE-2026-88884: before Renovate 44.3.1, digest updates bypassed `minimumReleaseAge`. Affected range is >=19.34.0 <44.3.1. — [OpenCVE](https://app.opencve.io/cve/CVE-2026-88884); [Mend VDB](https://mend.io/vulnerability-database/CVE-2026-88884/)

**bun audit**
- `bun audit` checks the packages in `bun.lock` against npm's advisory endpoint (it sends package names and versions to npm). It supports `--audit-level`, `--prod`, `--ignore <CVE>` and `--json`. It exits 1 on any finding, even with `--json`, and skips packages from non-default registries. — [Bun docs](https://bun.com/docs/pm/cli/audit)
- An OWASP CVE-Lite case study (2026-06-14, bun 1.3.13) found that bun audit counts each advisory separately (no per-version dedup), doesn't list skipped findings with reasons, and shows only partial workspace paths. — [OWASP cve-lite-cli case study](https://owasp.org/cve-lite-cli/docs/case-studies/cline)

**Snyk Open Source**
- Free plan: $0, unlimited contributing developers, **200 Snyk Open Source tests/month** and 100 Snyk Code tests/month. The snippet's column mapping was ambiguous, so check it on the live page. — [Snyk plans](https://www.snyk.io/plans)
- Paid plans have unlimited tests on private repos. — [Snyk CLI](https://github.com/snyk/cli)

**GuardDog (Datadog)**
- An open-source CLI that flags malicious PyPI, npm and Go packages with Semgrep heuristics over source plus metadata. v1.0 added npm and `guarddog verify` for package.json. It outputs SARIF for GitHub code scanning. — [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/guarddog-1-0-release)

**Phylum → Veracode**
- On 2025-01-06 Veracode bought Phylum's malicious-package analysis tech, its package firewall and its malicious-package DB, to fold into Veracode SCA (enterprise). — [Veracode press release](https://www.veracode.com/press-release/veracode-acquires-phylum-inc-technology-to-transform-software-supply-chain-security); [Dark Reading](https://www.darkreading.com/application-security/veracode-buys-package-analysis-technology-phylum)

### Inferences
- Known-CVE scanning (Dependabot alerts, OSV-Scanner, bun audit, Snyk) largely overlaps. For a solo dev, Dependabot alerts plus one CI scanner (OSV-Scanner, offline-capable and free, or `bun audit`, with zero extra install) is enough. Snyk adds a quota and an account for little gain.
- Malicious-package detection is a separate category, and only Socket (free, GitHub App) and GuardDog (OSS CLI) cover it here. Disabled install scripts plus exact pins already blunt worms like Shai-Hulud that run on install. Socket's PR comments add value mainly when a pin is *bumped*.
- Socket's free plan probably fits one person (1 dev seat). Its GitHub-Actions scanning is paid, so zizmor and poutine stay necessary.
- Renovate's `minimumReleaseAge` (a cooldown on new releases) is a real supply-chain control that Dependabot's security updates lack. Fresh-malware windows are typically hours (see incidents).

### Gaps
- Whether Socket's GitHub App parses `bun.lock` (text) natively wasn't confirmed in an official source.
- Renovate's `bun.lock` (text lockfile) support and Mend's hosted-app pricing weren't found in this pass.
- Whether Dependabot *version/security updates* support `bun.lock` wasn't confirmed.
- No current free tier for Veracode/Phylum found.
- GuardDog's maintenance cadence in 2026 and its handling of bun-specific lockfiles are unknown.

## Secrets scanning (GitHub secret scanning / push protection, gitleaks-action, TruffleHog, Betterleaks)

### Takeaway
On GitHub Free, **private repos get neither secret scanning nor push protection**: both need GitHub Secret Protection ($19/active committer/mo), which only Team or Enterprise plans can buy. Local gitleaks in a pre-commit hook therefore stays the main gate. In CI, gitleaks-action is free for personal-account repos (a license key is needed only for orgs). Betterleaks, a drop-in successor from the gitleaks author (March 2026), is worth noting because the original author no longer fully controls the gitleaks project.

### Cited Findings
- Secret scanning on private repos needs GitHub Secret Protection, and push protection does too. "You must be on a GitHub Team or GitHub Enterprise plan in order to purchase" these products, so personal Free accounts can't buy them. — [GitHub Docs: About GitHub Advanced Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security)
- On github.com, user-owned repos are listed as "Available on GitHub Enterprise Cloud with Enterprise Managed Users", and public repos are scanned automatically for free. — [GitHub Docs: About secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning)
- Secret Protection costs $19/mo per active committer (launched 2025-03, unbundled from GHAS) and can be bought by Team-plan orgs. — [GitHub changelog 2025-03-04](https://github.blog/changelog/2025-03-04-introducing-github-secret-protection-and-github-code-security/); [Pricing estimate docs](https://docs.github.com/en/code-security/how-tos/secure-at-scale/configure-organization-security/configure-specific-tools/estimating-the-price-of-secret-protection)
- Push protection is free and on by default for public repos. (Older info, 2024.) — [GitHub blog](https://github.blog/news-insights/product-news/push-protection-is-generally-available-and-free-for-all-public-repositories/)
- **gitleaks-action**: `GITLEAKS_LICENSE` is required for organization repos only. "If you are scanning repos that belong to a personal account, then no license key is required." Org keys are free via a Google form. — [gitleaks-action README v2.3.9](https://raw.githubusercontent.com/gitleaks/gitleaks-action/v2.3.9/README.md)
- gitleaks-action runs under its own EULA, not MIT, and checks for the license key automatically. — [gitleaks-action EULA](https://open.windriver.com/info/uni-license-list/licenses/gitleaks-action-eula.html)
- According to a secondary summary, license validation sends repo metadata and the key to Keygen.sh. — [DeepWiki](https://deepwiki.com/gitleaks/gitleaks-action)
- **Betterleaks**: launched 2026-03-15 by Zach Rice, gitleaks' creator, who said he no longer fully controls the gitleaks repo or name. MIT-licensed, sponsored by Aikido but community-governed. It's a drop-in replacement: same CLI commands, same configs. It uses CEL-based validation and BPE "token efficiency" scoring, with a project-reported 98.6% vs 70.4% recall on CredData (vendor benchmark, unverified). — [BleepingComputer](https://bleepingcomputer.com/news/security/betterleaks-a-new-open-source-secrets-scanner-to-replace-gitleaks); [The New Stack](https://thenewstack.io/betterleaks-open-source-secret-scanner/)
- **TruffleHog**: the `trufflesecurity/trufflehog@v3` action with `--only-verified` reports only secrets it has checked are live (secondary blog). — [gocodeo](https://www.gocodeo.com/post/trufflehog-for-devsecops-finding-secrets-in-code-before-they-leak)
- The Shai-Hulud worm itself used TruffleHog to harvest secrets from victims' machines. A detector action looks for "TruffleHog activity". — [StepSecurity Action Advisor: shai-hulud-2.0-detector](https://app.stepsecurity.io/action-advisor/gensecaihq/shai-hulud-2.0-detector)
- An older GitGuardian post says GitHub push protection covers only a limited set of prefixed secret types and has no historical scan. — [GitGuardian blog](https://blog.gitguardian.com/github-push-protection-enhancing-open-source-security-with-limitations-to-consider)

### Inferences
- A private Free repo has no server-side secret gate. Lefthook hooks can be bypassed (`--no-verify`), so a CI secrets job is the only backstop, and it's advisory, since branch protection isn't enforced on private Free repos (consistent with the user's memory note).
- Running the gitleaks **CLI** (pinned binary) in CI avoids the action's EULA and its Keygen license call entirely. For a personal repo the action needs no key anyway.
- TruffleHog's verification complements gitleaks rather than duplicating it: it confirms which secrets are live, which helps triage history scans. Verification makes outbound calls to the providers.
- Given the gitleaks governance change, consider watching or migrating to Betterleaks (config-compatible). Either way, pin by version and checksum.

### Gaps
- TruffleHog OSS's license and exact current action inputs weren't checked against primary docs.
- Whether GitHub's "push protection for users" (account-level) applies to pushes into one's *own* private repos wasn't confirmed. Available docs say no for private repos without Secret Protection.
- Who controls gitleaks now, and its release cadence after March 2026, wasn't found.

## GitHub Actions hardening (zizmor in CI, Harden-Runner, Scorecard, pinact/ratchet, actionlint, poutine)

### Takeaway
On a private Free repo, SARIF upload to code scanning is unavailable (HTTP 403 without Code Security). So zizmor, poutine, Scorecard and GuardDog must report via logs, `--format=github` annotations or exit codes, not the Security tab. StepSecurity Harden-Runner's free Community tier is **public repos only**. Scorecard's action supports private repos only with GHAS. pinact (check mode) plus GitHub's native "require SHA pinning" setting cover pinning.

### Cited Findings
- **zizmor-action** integrates with Advanced Security (SARIF to the Security tab) by default, which needs `security-events: write`. With Advanced Security off, it can run with `permissions: {}`. — [zizmor-action Marketplace](https://github.com/marketplace/actions/zizmor-action)
- The SARIF/Security-tab path works for public repos and GHEC orgs with Advanced Security. Otherwise the docs suggest `--format=github` or plain/JSON output. — [zizmor docs: integrations](https://docs.zizmor.sh/integrations/)
- Uploading SARIF to a private repo without Code Security/GHAS fails with 403. — [GitHub Docs: ghas-required](https://docs.github.com/en/code-security/how-tos/scan-code-for-vulnerabilities/troubleshooting/troubleshooting-sarif-uploads/ghas-required)
- With SARIF output, zizmor exits 0 even when it has findings, so blocking requires rulesets. — [zizmor integrations.md mirror](https://git.joshthomas.dev/mirrors/zizmor/raw/branch/main/docs/integrations.md)
- **Harden-Runner**: "The Community Tier does not support private repositories." Private repos need Enterprise. The trial is 14 days per the docs and 7 days per the pricing page (conflict). The free tier is "best for open source", unlimited repos, with a weekly run cap of 10,000 or 13,000 depending on the docs version. Past the cap it runs but doesn't enforce. — [StepSecurity docs: Community quickstart](https://docs.stepsecurity.io/getting-started/quickstart-community-tier); [StepSecurity pricing](https://www.stepsecurity.io/pricing)
- The community tier works only on GitHub-hosted runners (RunsOn integration page). — [StepSecurity docs: RunsOn](https://docs.stepsecurity.io/resources/partnerships/runson)
- CVE-2025-32955: a bypass of Harden-Runner's security mechanism (Sysdig). — [Sysdig](https://www.sysdig.com/blog/security-mechanism-bypass-in-harden-runner-github-action)
- **OpenSSF Scorecard action**: "private repositories are supported if they have GitHub Advanced Security". Otherwise run the CLI. For private repos, `publish_results` is forced to false, and Branch-Protection checks need a fine-grained PAT. — [Scorecard action Marketplace](https://github.com/marketplace/actions/ossf-scorecard-action)
- **pinact** rewrites `uses:` tags to full SHAs with trailing version comments. Its check mode fails CI on unpinned refs. — [Semgrep blog 2026](https://semgrep.dev/blog/2026/sha-pinning-for-github-actions-org-wide)
- **GitHub native**: a repo or org setting enforces full-length SHA pinning at run time. It doesn't fix refs, so pinact or Renovate is still needed. — [Semgrep blog 2026](https://semgrep.dev/blog/2026/sha-pinning-for-github-actions-org-wide); [zenn.dev (shunsuke_suzuki)](https://zenn.dev/shunsuke_suzuki/articles/github-actions-enforce-sha-pinning)
- **poutine** (BoostSecurity): Apache-2.0 CLI for misconfigurations in GitHub Actions, GitLab, Azure DevOps and Tekton pipelines. It inventories build-time deps for CVEs and has an official `poutine-action`, a Docker image at ghcr.io/boostsecurityio/poutine, and an MCP server. — [poutine repo](https://github.com/boostsecurityio/poutine); [BoostSecurity launch post](https://boostsecurity.io/blog/unveiling-poutine-an-open-source-build-pipelines-security-scanner)

### Inferences
- zizmor and actionlint in CI are partly redundant with Lefthook, but CI is the only place that catches `--no-verify` pushes or web-UI edits. Run them as cheap, pinned, `permissions: {}` jobs with `--format=github`.
- poutine overlaps heavily with zizmor (injection, dangerous triggers). Its extra value is build-dependency inventory and multi-platform support. For a single GitHub-only repo it's optional.
- Harden-Runner, the tool that first caught tj-actions, isn't available free for private repos. Egress monitoring for a solo private repo means paying, or keeping jobs secret-free and `permissions: {}` so that exfiltration has nothing to steal.
- Scorecard on private Free repos is CLI-only and largely duplicates what zizmor and pinact enforce. Low value.

### Gaps
- StepSecurity Enterprise per-developer price wasn't captured.
- ratchet (sethvargo) wasn't covered by any source in this pass, so its current status is unknown.
- I didn't check whether the GitHub native SHA-pinning enforcement is available for personal-account repos on Free, or only for orgs.

## Artifact provenance / SBOM (npm provenance, Syft/Grype, Trivy) and what the Trivy compromise implies

### Takeaway
npm trusted publishing (OIDC, CLI ≥ 11.5.1) generates provenance automatically, but it matters only if packages get published. The March 2026 Trivy compromise shows that a *security scanner's* own action can be the attack vector. Prefer pinned binaries verified by checksum, or SHA-pinned actions with minimal permissions, and don't hand scanners secrets.

### Cited Findings
- Trusted publishing uses short-lived, workflow-specific OIDC credentials, and the npm CLI generates provenance attestations automatically for these publishes. — [The Hacker News, Sept 2025](https://thehackernews.com/2025/09/github-mandates-2fa-and-short-lived.html)
- Trusted publishing needs npm CLI ≥ 11.5.1. One author still had to pass `--provenance` (Jan 2026, single anecdote). — [philna.sh](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/)
- After Shai-Hulud, GitHub announced required 2FA for local publishes, a 7-day limit on granular tokens, retirement of classic tokens, token publishing blocked by default, and TOTP dropped in favour of FIDO keys. — [The Hacker News](https://thehackernews.com/2025/09/github-mandates-2fa-and-short-lived.html)
- **Trivy compromise (2026-03-19/20)**: attackers force-pushed malicious code to 75 of 76 tags of `aquasecurity/trivy-action`, compromised `setup-trivy`, and published a malicious Trivy v0.69.4 binary. The exposure window was about 12 hours (03-19 17:43 UTC to roughly 03-20 05:40 UTC). The payload stole CI secrets (SSH keys, cloud creds, wallets on self-hosted runners) and then ran the real scan, so pipelines looked normal. Safe versions: trivy v0.69.3, trivy-action v0.35.0, setup-trivy v0.2.6. — [Snyk](https://snyk.io/articles/trivy-github-actions-supply-chain-compromise/)
- The Trivy attack was attributed to TeamPCP, using access retained after incomplete containment of an earlier breach. Malicious binaries went to GitHub Releases, Docker Hub, GHCR and ECR. A parallel compromise hit `kics-github-action` on 03-23. — [Wiz](https://www.wiz.io/fr-fr/blog/trivy-compromised-teampcp-supply-chain-attack)

### Inferences
- Tag-pinned scanner actions (`@v0.x`) were compromised wholesale. SHA pinning protects against tag rewrites but not against a malicious *new* release you bump to, which is why a release cooldown (Renovate `minimumReleaseAge`) and not passing secrets to scan jobs both matter.
- For a private, unpublished monorepo, SBOM and provenance are low priority. OSV-Scanner already covers lockfile CVE scanning, so Trivy and Grype are redundant for a Bun-only repo.

### Gaps
- Syft/Grype (Anchore) current versions, `bun.lock` support and incident history weren't researched in this pass.
- No official Aqua Security advisory or CVE ID was confirmed. Snyk says a CVE was requested.

## Notable npm / Actions supply-chain incidents 2025-2026 and who caught them first

### Takeaway
tj-actions/changed-files (March 2025) was first detected by StepSecurity Harden-Runner's egress anomaly detection. Shai-Hulud (September 2025, with waves 2.0 in November and a later 3.0) was surfaced by Aikido, Socket and the community. Trivy-action (March 2026) shows scanners themselves being targeted.

### Cited Findings
- **tj-actions/changed-files (CVE-2025-30066)**: tags v1 through v45.0.7 were repointed to malicious commit 0e58ed8 on 2025-03-14/15. The payload dumped Runner.Worker memory secrets into build logs. Over 23,000 repos used the action. Harden-Runner flagged an outbound call never seen in the job's baseline and "was the first to detect this attack". GitHub removed the action on 2025-03-15. — [Phoenix Security](https://phoenix.security/tj-actions-compromise/); [Hackread](https://hackread.com/malicious-code-in-tj-actions-changed-files-github-repos/); [SentinelOne CVE DB](https://www.sentinelone.com/vulnerability-database/cve-2025-30066)
- **Shai-Hulud**: the first package was altered on 2025-09-14 around 17:58 UTC, per Aikido's Charlie Eriksen. A developer raised the alarm on 09-15 over @ctrl/tinycolor. Krebs counted at least 187 packages by 09-16, and CISA later counted 500+. — [Harvard tagteam / Krebs mirror](https://tagteam.harvard.edu/hub_feeds/4281/feed_items/15925827/content); [security-insider.de](https://www.security-insider.de/npm-pakete-supply-chain-angriff-malware-infektion-a-7058d3a07ba5184bbd66002da6001877/); [Techzine](https://www.techzine.eu/news/security/144866/shai-hulud-worm-burrows-into-ai-platform-tensorlakes-npm-sdk/)
- **Shai-Hulud 2.0** (about November 2025) hit more than 1,000 package versions. **3.0** was first documented by Aikido's Eriksen in @vietmoney/react-big-calendar. — [Techzine](https://www.techzine.eu/news/security/144866/shai-hulud-worm-burrows-into-ai-platform-tensorlakes-npm-sdk/); [Sweet Security](https://www.sweet.security/blog/shai-hulud-3-0-when-a-supply-chain-worm-evolves---and-makes-mistakes)
- A "wormy boy" variant was reported slipping past npm's malware scanning. — [ITPro](https://www.itpro.com/security/malware/is-shai-hulud-back-researchers-spot-wormy-boy-slipping-past-npm-malware-scanning-features)
- **Trivy / kics actions** (March 2026): see the previous section. — [Snyk](https://snyk.io/articles/trivy-github-actions-supply-chain-compromise/); [Wiz](https://www.wiz.io/fr-fr/blog/trivy-compromised-teampcp-supply-chain-attack)

### Inferences
- Behavioural or malicious-package detectors (Socket, Aikido, Harden-Runner) caught these first. CVE databases (OSV, Dependabot, bun audit) lag by hours to days, because advisories follow the detection.
- Shai-Hulud spreads through install-time scripts and stolen npm tokens. This repo's `ignoreScripts = true` and exact pins remove the main infection path, so what's left is bumping to a freshly compromised version. A cooldown plus Socket PR alerts address that.

### Gaps
- No authoritative "first detector" statement for the Trivy compromise was found.
- Exact dates and package counts for Shai-Hulud 3.0 weren't confirmed from a primary source.

# All-in-one static application security platforms (SAST + SCA + secrets + IaC) as SonarQube replacements for a solo developer, October 2026

Scope: one developer, private repos on a personal GitHub Free account, TypeScript/Bun monorepo (`bun.lock` text format), GitHub Actions CI, no enterprise budget. Research done 2026-10-24. All pricing comes from vendor pages fetched on that date unless flagged otherwise. Fetches went through a summarising tool, so check exact figures on the linked page before relying on them.

## Free tier limits, cheapest paid tier and what's included, per vendor

### Takeaway
Two free tiers cover a solo developer with private repos in one product: Semgrep Free Edition (Code + Supply Chain, up to 10 contributors and 10 private repos, cross-file analysis and reachability included) and Aikido Developer (2 users, 10 repos; SAST, SCA with reachability, secrets and IaC). GitHub Code Security / Secret Protection can't be bought by a personal account at all. Snyk Free works but has tight monthly test caps. DeepSource has no free private-repo tier. Endor Labs and Checkmarx/Veracode are sales-led, with no solo-viable self-serve paid tier found.

### Cited Findings

**Semgrep**
- Free Edition costs $0. It includes Semgrep Code and Supply Chain, with a maximum of 10 contributors, up to 10 repos scanned (10 private max), cross-file analysis "Yes", reachability "Yes" and 60 AI credits. Secrets is not listed in Free. — [semgrep.dev/pricing](https://semgrep.dev/pricing)
- Teams is "starting at" $30/month per contributor for Code, $30/month per contributor for Supply Chain and $15/month per contributor for Secrets, with 500 private repos max and 20 AI credits per developer per month. Enterprise has custom pricing, unlimited private repos and 50 AI credits per developer per month. — [semgrep.dev/pricing](https://semgrep.dev/pricing)
- A contributor is someone with at least one commit to a private repo scanned by Semgrep in the last 90 days. All plans list AI-powered detection, AI Memories, remediation guidance, auto-triage and autofix. Free SSO is GitHub/GitLab login only, and RBAC requires Teams. — [semgrep.dev/pricing](https://semgrep.dev/pricing)
- Solo cost if Secrets were needed: Teams Secrets is $15/month for 1 contributor. Whether Secrets can be bought alone on top of Free wasn't verified. — [semgrep.dev/pricing](https://semgrep.dev/pricing)

**Opengrep (LGPL fork of Semgrep CE)**
- Sources conflict on what it restores. One review says it brings back taint analysis and inter-procedural scanning that Semgrep removed from CE. Another says it restores cross-function (not cross-file) taint and that cross-file analysis stays a Semgrep platform feature. — [appsecsanta: Opengrep vs Semgrep](https://appsecsanta.com/opengrep-vs-semgrep); [appsecsanta: Semgrep alternatives](https://appsecsanta.com/sast-tools/semgrep-alternatives)
- Aikido's first-year retrospective (May 2026) reports 25–74% faster scans and up to 2x faster taint analysis. It frames interfile coverage as something users have to enable. — [NHI Mgmt Group / Aikido, 2026-05-12](https://nhimg.org/articles/opengreps-first-year-shows-why-deterministic-sast-still-matters/)
- Sources disagree on the latest version (1.16.4 in March 2026 vs v1.28.0 on 2026-08-25). Not verified against GitHub releases. — [appsecsanta: Opengrep](https://appsecsanta.com/opengrep); [everydev.ai](https://www.everydev.ai/tools/opengrep)
- Opengrep is SAST only. It has no SCA or bundled secrets, and no hosted dashboard was found.

**Snyk**
- Free is $0. It covers SCA (Open Source), SAST (Code), IaC and Container, with IDE, CLI and SCM integrations. Monthly limits: Open Source 200 tests, Code 100 tests, IaC 300 tests, Container 100 tests, and 5 projects. — [snyk.io/plans](https://snyk.io/plans/)
- Team is "from $25/month", billed monthly. It raises Code to 1,000 tests/month and projects to 100, adds Jira and next-business-day support, and targets teams of up to 10 developers. The page says $25 is a "starting at" plan price and doesn't give a per-developer figure. — [snyk.io/plans](https://snyk.io/plans/)
- Enterprise uses prepaid credits at $1 each, for example Code and Open Source at 1.0 credit per active contributor per day. Snyk's newer AI features are Enterprise only. Open source maintainers can apply for free use. — [snyk.io/plans](https://snyk.io/plans/)
- Secrets appears only on the Enterprise rate card (0.66 credits per contributor per day). Free and Team don't list secrets scanning. — [snyk.io/plans](https://snyk.io/plans/)

**Aikido Security**
- Developer is $0 ("free forever"), with 2 users, 10 repos, 2 container images, 1 domain, 1 cloud account, 10 AI AutoFixes per month and rescans every 3 days. It includes SCA with reachability, license scanning and autofix; SAST and "AI SAST" with AI-based false-positive reduction; secrets detection; IaC, container and CSPM checks; outdated-software checks; and IDE plugins. — [aikido.dev/pricing](https://www.aikido.dev/pricing)
- Basic is 300/month including 10 users (currency shown as page default, tax excluded), with 100 repos, unlimited AutoFix, PR security review, PR code-quality checks, Jira/Linear sync and reports. Pro is 600/month including 10 users. Annual billing is 10% off. — [aikido.dev/pricing](https://www.aikido.dev/pricing)
- FLAG: the fetch listed Advanced at the same 600/month as Pro. That is probably a parsing error, so verify on the page. Also note that **PR security review (PR comments/gating) is a Basic feature, not Free**, per the fetched feature list. — [aikido.dev/pricing](https://www.aikido.dev/pricing)

**GitHub Advanced Security (Secret Protection / Code Security)**
- "You must be on a GitHub Team or GitHub Enterprise plan in order to purchase GitHub Code Security or GitHub Secret Protection." **A personal Free or Pro account cannot buy them.** — [docs.github.com: About GitHub Advanced Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security)
- Secret Protection costs $19/month per active committer and Code Security $30/month per active committer, with metered pay-as-you-go billing. Team-plan organizations have been able to buy them since 2025-04-01. — [GitHub changelog 2025-03-04](https://github.blog/changelog/2025-03-04-introducing-github-secret-protection-and-github-code-security/); [GitHub changelog 2025-04-01](https://github.blog/changelog/2025-04-01-github-advanced-security-is-here-for-github-team-organizations). FLAG: these are 2025 announcements. github.com/pricing (fetched October 2026) lists both as Team add-ons, but the fetch didn't return prices on the page itself.
- GitHub Team is $4/user/month. — [github.com/pricing](https://github.com/pricing)
- Public repos get code scanning, the CodeQL CLI, Copilot Autofix, secret scanning and push protection without the paid products. Dependency graph and Dependabot alerts are on all plans. — [docs.github.com: About GHAS](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security)

**Endor Labs**
- No prices are published. Paid products Core and Pro show only "Get pricing" and "Contact sales", with seat-based pricing that counts contributors with a commit in the last 90 days. A free trial exists. — [endorlabs.com/pricing](https://www.endorlabs.com/pricing)
- The free Developer tier uses the AURI tool to scan for vulnerabilities and secrets locally, with no account and read-only access to Endor's vulnerability data. It has no UI, policies or scan history. — [endorlabs.com/pricing](https://www.endorlabs.com/pricing)

**DeepSource**
- The free Open Source plan covers unlimited public repos only. **Private repos are not included.** It has no SCA. — [deepsource.com/pricing](https://deepsource.com/pricing)
- Team is $24/user/month billed yearly (no monthly price listed). It includes a $100/year AI Review credit, unlimited repos, 3 SCA targets (extra targets $8/month each) and, by the feature table, secrets. There's a 14-day trial. — [deepsource.com/pricing](https://deepsource.com/pricing)

**Codacy**
- Developer is free forever. It includes "Security Scans (SAST, SCA, Secrets)" **in the IDE** plus AI guardrails in the editor. The page gives no repo or user caps for it. — [codacy.com/pricing](https://www.codacy.com/pricing)
- Team is $18/dev/month billed yearly or $21/dev/month billed monthly. It supports up to 30 devs and 100 private repos, unlimited LOC, and an AI Reviewer with merge gates for PRs. It's free for open-source projects. — [codacy.com/pricing](https://www.codacy.com/pricing)

**SonarQube Cloud (baseline)**
- Free covers private projects up to 50k LOC, with no card and no expiry. — [sonarsource.com/plans-and-pricing](https://www.sonarsource.com/plans-and-pricing/)
- Team starts at $34/month for up to 100k LOC. The page is inconsistent on whether "SonarQube Advanced Security" (SCA) is in Team or Enterprise only, and no secrets product is listed by plan. — [sonarsource.com/plans-and-pricing](https://www.sonarsource.com/plans-and-pricing/)

### Inferences
- Cheapest full coverage of SAST, SCA, secrets and IaC at $0 for private repos: **Aikido Developer** (all four in one, 2 users and 10 repos is enough for a solo dev), or **Semgrep Free** (SAST + SCA) plus a separate free secrets scanner such as Gitleaks, which the repo already uses per commit 710c808. IaC matters little for this repo.
- GHAS is not an option without moving the repos into an organization on GitHub Team ($4) and adding Code Security ($30) and/or Secret Protection ($19), which comes to roughly $34–53/month for one committer.
- Snyk Free's 100 Code tests/month could run out with per-push CI scans on an active repo.
- DeepSource is out at $0 because it has no free private repos. Codacy's free tier is IDE-only, so it doesn't cover CI or PRs.

### Gaps
- Exact Aikido Advanced price and whether the prices are USD. The page fetch looked inconsistent.
- Whether Semgrep Secrets can be added alone to the Free Edition.
- Whether the Codacy Developer tier includes any repo/CI scanning, and its limits.
- Checkmarx One and Veracode: no solo-viable self-serve tier was looked into beyond noting both are sales-led. Not researched for lack of time; I found no evidence of a solo tier.
- GHAS prices were not shown directly on github.com/pricing in the October 2026 fetch. The $19/$30 figures come from 2025 changelogs.

## Language and ecosystem support: TypeScript and `bun.lock`

### Takeaway
Aikido's docs list `bun.lock`. Semgrep Supply Chain added text-format `bun.lock` parsing in v1.179.0 (2026-10-01). Snyk's JS docs list only npm, pnpm and Yarn, so `bun.lock` isn't supported. TypeScript is first-class in Semgrep, with GA cross-file dataflow and reachability.

### Cited Findings
- Semgrep Code: TypeScript is GA with "Cross-file dataflow analysis" and 230+ Pro rules. JS and TS are GA in Supply Chain with reachability. — [docs.semgrep.dev/supported-languages](https://docs.semgrep.dev/supported-languages)
- Semgrep v1.179.0 release notes: Supply Chain now parses Bun `bun.lock` (text, lockfileVersion 1) paired with `package.json`, including dependency relationships. Binary `bun.lockb` is still unsupported. — [newreleases.io: semgrep 1.179.0](https://newreleases.io/project/pypi/semgrep/release/1.179.0); [releases.sh/semgrep](https://releases.sh/semgrep/overview.md). FLAG: the official feature-support docs don't mention Bun yet ([docs.semgrep.dev requirements](https://docs.semgrep.dev/semgrep-supply-chain/requirements-and-feature-support)), and the release is only three weeks old.
- Aikido JS/TS lockfiles: "npm-shrinkwrap.json, package-lock.json, yarn.lock, pnpm-lock.yaml, pnpm-lock.yml, bun.lock, deno.lock, libman.json". `bun.lockb` is not listed. Lockfiles are scanned in the root and all subfolders. — [help.aikido.dev: dependency scanning by language](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language)
- Snyk Open Source JS supports npm 5–10+ (`package-lock.json` v1–v3), pnpm 7–10 (`pnpm-lock.yaml` 5.4/6.x/9.x) and Yarn 1–4 (`yarn.lock`). Bun is not mentioned. — [docs.snyk.io JavaScript](https://docs.snyk.io/supported-languages/supported-languages-list/javascript.md)
- Socket ships a Bun install-time security scanner (configured in `bunfig.toml`) that flags malicious and typosquatted packages. It is not a lockfile SCA platform. — [GitHub: SocketDev/bun-security-scanner](https://github.com/SocketDev/bun-security-scanner)

### Inferences
- For Snyk, a workaround would be generating a `package-lock.json` for scanning. That's extra CI work and a drift risk.
- Endor Labs, DeepSource, Codacy and SonarQube SCA: `bun.lock` support was not confirmed. Treat them as unsupported until shown otherwise.

### Gaps
- Endor Labs and Codacy lockfile lists were not checked. Whether Semgrep handles `bun.lock` workspaces (monorepo `workspaces` entries) correctly is unverified.

## Quality signals: false positives, cross-file taint, reachability, AI triage and autofix

### Takeaway
No rigorous, vendor-neutral, same-conditions false-positive benchmark covering these tools on TypeScript was found. The feature split is clearer. Semgrep Free includes cross-file analysis and reachability (previously paid-only features). Aikido Free includes reachability and AI false-positive reduction. Opengrep's cross-file taint support is disputed.

### Cited Findings
- Academic benchmark (arXiv 2508.04448, LLMs vs static analysers): SonarQube and CodeQL had the lowest false-positive ratios among the static tools tested. — [arXiv 2508.04448](https://arxiv.org/pdf/2508.04448)
- Vendor-published OWASP Benchmark (Java) figures from a competitor blog: Snyk Code TPR 97.18% / FPR 34.55%, Semgrep TPR 87.06% / FPR 42.09%. Treat with caution: it's a competitor source and Java, not TS. — [xygeni.io: Top SAST tools](https://xygeni.io/blog/top-sast-tools/)
- Doyensec's Semgrep vs CodeQL comparison stresses that results depend on language, rules, repo structure and configuration. CodeQL is deeper on dataflow, Semgrep faster and easier to write rules for. — [Doyensec 2022](https://blog.doyensec.com/2022/10/06/semgrep-codeql.html) (FLAG: 2022)
- Semgrep Free: cross-file analysis and reachability are both "Yes", and AI auto-triage and autofix are listed on all plans (60 AI credits on Free). — [semgrep.dev/pricing](https://semgrep.dev/pricing)
- Semgrep's interfile engine was redesigned in v1.158.0 (est. 20–40% faster). — [releases.sh/semgrep](https://releases.sh/semgrep.md)
- Aikido Free: SCA reachability, "AI SAST" with AI-based false-positive reduction, and 10 AI AutoFixes per month. — [aikido.dev/pricing](https://www.aikido.dev/pricing)
- Snyk: Free and Team include SAST and SCA. The JS docs don't mention reachability for JavaScript. — [docs.snyk.io JavaScript](https://docs.snyk.io/supported-languages/supported-languages-list/javascript.md)
- Endor Labs: reachability-based SCA is the core of its paid Core tier. — [endorlabs.com/pricing](https://www.endorlabs.com/pricing)

### Inferences
- Comparing on this codebase means running the free tiers (Semgrep, Aikido, Opengrep) side by side, perhaps on a seeded vulnerable file. Published numbers don't transfer to TS/Bun.

### Gaps
- No practitioner (HN, Reddit) sentiment was collected because of the tool-call budget.
- No TypeScript-specific false-positive benchmark was found.

## Integration: GitHub App vs Action, PR comments and SARIF on private repos without GHAS

### Takeaway
**SARIF upload to GitHub code scanning does not work on private repos without GitHub Code Security.** A personal Free account can't buy that, so findings won't appear in GitHub's Security tab. Feedback has to come through the vendor's own dashboard, a GitHub App posting PR comments or checks, or CI logs and artifacts.

### Cited Findings
- "For private and internal repositories, code scanning is available when GitHub Code Security features are enabled for the repository." The documented error reads: "GitHub Code Security or GitHub Advanced Security must be enabled for this repository to use code scanning." — [docs.github.com: Uploading a SARIF file](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github)
- The GHAS docs list code scanning and the CodeQL CLI as unavailable for private repos without Code Security. — [docs.github.com: About GHAS](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security)
- Aikido: PR security review is listed under Basic (paid). Free gets scanning on push and PR in the Aikido dashboard plus IDE plugins. — [aikido.dev/pricing](https://www.aikido.dev/pricing); [help.aikido.dev](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language)
- Codacy: AI Reviewer and PR merge gates are Team (paid). — [codacy.com/pricing](https://www.codacy.com/pricing)

### Inferences
- Semgrep Free plus the `semgrep ci` Action can fail the CI job, which gives a gate without code scanning. Whether Semgrep Free posts PR comments wasn't verified.
- Any tool's SARIF can still be kept as a workflow artifact, just without the code-scanning UI.

### Gaps
- PR-comment availability per free tier wasn't verified for Semgrep and Snyk.

## Data handling: does code leave the machine?

### Takeaway
Only partly verified. Endor Labs' free tier is explicitly local. The privacy pages for Semgrep, Snyk and Aikido couldn't be fetched (404s or not reached).

### Cited Findings
- Endor Labs Developer tier: "runs all scanning locally" with read-only access to vulnerability data. — [endorlabs.com/pricing](https://www.endorlabs.com/pricing)
- Socket's Bun scanner runs at `bun install` time. — [GitHub: SocketDev/bun-security-scanner](https://github.com/SocketDev/bun-security-scanner)

### Inferences
- Unverified, from general knowledge: Semgrep CLI and CI run analysis locally and upload findings metadata (possibly snippets) to the Semgrep App. Snyk Code sends code to Snyk's cloud for analysis. Aikido connects as a GitHub App and clones repos on its side. All three need confirming against vendor privacy docs before deciding.

### Gaps
- The Semgrep privacy page (`docs.semgrep.dev/semgrep-ci/privacy`) returned 404. Snyk and Aikido data-retention docs weren't fetched.

# Practitioner consensus: minimal security stack for a solo dev's GitHub repos, and why people move away from SonarQube (as of Oct 2026)

Method note: about 20 searches and fetches. Search results came mostly from vendor and affiliate comparison blogs. No Reddit or Hacker News threads appeared in the results, even with targeted queries. The Latio 2026 report is behind a form, so its placements are known only from vendor press releases. Strong primary sources: the OpenSSF Concise Guide, GitHub's Actions hardening doc, Sonar's own docs, and the Trail of Bits blog. Everything else is labelled by source type.

## Which tools do respected sources and practitioners recommend for small teams?

### Takeaway
The independent sources agree on process and free controls more than on any scanner brand. OpenSSF says to use several detection tools in CI, but warns that tools alone are not enough. For small teams, the open-source or free tools named most often are Semgrep (OSS CLI), CodeQL, zizmor for Actions, Dependabot/OSV-style SCA and a secret scanner. Aikido is the all-in-one SaaS that small-team roundups mention most. Snyk is named mainly for IDE-centred developer workflows.

### Cited Findings
- The OpenSSF Concise Guide (dated 2023-06-14, still current on best.openssf.org) says to use multiple vulnerability-detection tools in CI, but not as the only safeguard. It also says to monitor direct and indirect dependencies for known vulnerabilities, never push secrets (use detection tools), require review through protected branches or rulesets, sign releases (e.g. cosign), improve your Scorecard score and SLSA level, and publish SBOMs — [OpenSSF Concise Guide](https://best.openssf.org/Concise-Guide-for-Developing-More-Secure-Software)
- The Concise Guide recommends a cooldown of about 3 days before taking non-security dependency updates. This guards against freshly published malicious versions — [OpenSSF Concise Guide](https://best.openssf.org/Concise-Guide-for-Developing-More-Secure-Software)
- The Latio 2026 Application Security Market Report covers four themes: AI-driven SAST, ASPM evolving into broader vulnerability management, reachability and runtime context for prioritization, and developer experience plus false-positive reduction now mattering more than raw finding volume. It combines technical reviews with a survey of more than 100 practitioners (summary via a vendor page) — [Datadog's Latio 2026 page](https://www.datadoghq.com/ja/resources/latio-application-security-report2026/)
- Vendors claim placements in the Latio 2026 report: Datadog as "Application Security Platform Leader" and "Runtime Innovator", Invicti as a Leader and DAST Innovator, and Semgrep recognised for the first time. These are vendor self-reports, and the full SAST/SCA tables could not be retrieved — [Invicti](https://www.invicti.com/blog/news/latio-2026-application-security-market-report-recognizes-invicti-as-leader-and-innovator); [Semgrep](https://semgrep.dev/resources/download-latio-application-security-report)
- Latio's tool directory (list.latio.tech, which now redirects to latio.com) tags Wiz, Aikido and Cycode as ASPM, with "Trending" badges. It tags Glow and Pluto Security as "Agentic Development Security". The visible page has no ordered SAST or SCA ranking — [Latio](https://www.latio.com/)
- Trail of Bits sponsors zizmor, a static analyzer for GitHub Actions, and in 2026 helped harden it. It tested zizmor on 41,253 workflows from 6,612 repositories, which led to 20 filed issues and 15 merged PRs. The post says supply-chain attacks such as the 2026 Trivy compromise "begin with a single misconfigured workflow" — [Trail of Bits, 2026-05-22](https://blog.trailofbits.com/2026/05/22/we-hardened-zizmors-github-actions-static-analyzer/)
- zizmor flags template injection, credential persistence, over-broad permissions and untrusted git references — [zizmor on PyPI](https://pypi.org/p/zizmor)
- GitHub's own hardening guide recommends running OpenSSF Scorecard to flag script injection, token permissions and unpinned actions — [GitHub Docs: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- Small-team roundups (secondary, affiliate-style) describe Aikido as a low-noise hub that bundles SAST, DAST, SCA, CSPM, secrets and runtime protection, and suggest Snyk for teams that want to fix issues in the IDE — [aicodereview.cc SonarQube alternatives](https://aicodereview.cc/blog/sonarqube-alternatives); [stackpick Snyk alternatives](https://stackpick.net/blog/best-snyk-alternatives-2026/)
- One small-team framing (not from Latio): "one tool per question, plus the checks that cost nothing but configuration" — [Vantaige](https://vantaige.io/blog/ai-security-tools-small-teams-2026)
- Comparison blogs agree on the split. Semgrep suits security-focused teams (fast scans, custom rules written in minutes). SonarQube suits teams that want one dashboard for code quality and security together. Semgrep tracks no code smells, duplication or coverage — [appsecsanta SonarQube vs Semgrep](https://appsecsanta.com/sast-tools/sonarqube-vs-semgrep); [Pixee](https://www.pixee.ai/blog/semgrep-vs-sonarqube)

### Inferences
- For a solo developer, the evidence points to a stack of free point tools, each answering one question: secrets (e.g. Gitleaks, already in this repo), dependencies (Dependabot/OSV), Actions (zizmor plus Scorecard), and optionally one SAST tool (Semgrep OSS or CodeQL). A paid ASPM platform aimed at a security team does not fit.
- Latio's themes (noise reduction, reachability, developer experience) favour fewer, quieter tools over coverage.

### Gaps
- Latio's actual 2025–2026 SAST, SCA and AI-native category rankings were not retrievable (form-gated).
- No primary Reddit (r/devsecops, r/netsec) or Hacker News threads appeared in search results, so practitioner sentiment there is unverified. The comparison blogs found are vendor- or affiliate-adjacent.
- No relevant 2025–2026 OWASP DevSecOps Guideline, CISA Secure by Design or Chainguard material was retrieved in this pass.
- Daniel Miessler's views were not found.

## Why do people move away from SonarQube for security specifically?

### Takeaway
The main criticism is that the free SonarQube (now called "Community Build") is a code-quality tool with pattern-matching security rules. Taint (data-flow) analysis, the part that finds injection vulnerabilities, is paid only. Sonar's own docs say Security Hotspots are not meant to pinpoint real vulnerabilities, and they do not count in the Quality Gate. Teams that read "hotspots" in the free UI as SAST coverage are overestimating what they have.

### Cited Findings
- Sonar's docs say Security Hotspot rules aim to guide security auditors during code review rather than pinpoint real vulnerabilities. Hotspot issues do not count in the Quality Gate. Hotspot rules are available in the free edition — [Sonar docs: security-related rules](https://docs.sonarsource.com/sonarqube/latest/user-guide/rules/security-related-rules)
- Sonar's own Community Build page treats taint tracking (untrusted data flow across functions and files) as a commercial capability. The free edition lacks it — [SonarSource Community Build page](https://www.sonarsource.com/products/sonarqube/why-upgrade/community-build/)
- An older SonarSource community forum reply says taint rules are only in Developer Edition and above (dated, but consistent with the current page) — [Sonar community forum](https://community.sonarsource.com/t/s2077-has-been-deprecated-but-documentation-doesnt-include-a-justification/1688)
- SonarQube Server 2025.4 LTA made "SonarQube Advanced Security" (SCA plus advanced SAST) generally available as a paid add-on. It added taint analysis for Go and a new JS/TS taint engine. Security depth is moving further into paid tiers — [Sonar blog, 2025.4](https://www.sonarsource.com/blog/sonarqube-server-2025-4-faster-analysis-stronger-security-better-coverage/)
- The free tier was renamed from Community Edition to Community Build, and Sonar moved to calendar versioning in 2025 — [SonarSource Community Build page](https://www.sonarsource.com/products/sonarqube/why-upgrade/community-build/); [aicodereview.cc](https://aicodereview.cc/blog/is-sonarqube-free)
- Third-party opinion (labelled as opinion by its author): the free tier is "a code-quality tool wearing a security badge" — [aicodereview.cc: Is SonarQube free?](https://aicodereview.cc/blog/is-sonarqube-free)
- Other reasons cited for switching: custom rules are harder to write than Semgrep's, the UI feels dated next to Codacy, DeepSource or Qlty, and Developer Edition pricing is per lines of code (reported as about $150/year per 100K LOC, unverified against Sonar's pricing page) — [appsecsanta](https://appsecsanta.com/sast-tools/sonarqube-vs-semgrep); [aicodereview.cc alternatives](https://aicodereview.cc/blog/sonarqube-alternatives)
- Sonar's defence: its taint engine produces fewer false positives and explains where an injection comes from, but like any taint engine it cannot detect every injection — [Sonar docs](https://docs.sonarsource.com/sonarqube-server/10.8/user-guide/rules/security-related-rules)

### Inferences
- For a TypeScript solo project, the free SonarQube adds code-quality signal that overlaps with Biome and tsc (already in this repo) and gives no data-flow security. That combination of overlap without security depth is the core reason to drop it for security purposes.
- Self-hosting SonarQube Server also means running a JVM service plus a database, which is operational load for one person. This is an inference; no source quantified it.

### Gaps
- Whether SonarQube Cloud's free plan for public projects includes taint analysis was not verified in this pass.
- No practitioner forum threads (Reddit or HN) about migrating away from SonarQube were retrieved.

## Recommended free baseline controls for repo security

### Takeaway
The highest-value free controls are about accounts and supply chain, not scanners: MFA or passkeys, least-privilege and short-lived tokens, SHA-pinned Actions with a read-only `GITHUB_TOKEN`, no `pull_request_target` on untrusted code, secret scanning, and dependency monitoring with a cooldown. On GitHub Free, branch protection and rulesets are not enforced on private repos, so local hooks and advisory CI are the practical gates.

### Cited Findings
- OpenSSF item 1 is to require MFA for anyone with commit or accept rights — [OpenSSF Concise Guide](https://best.openssf.org/Concise-Guide-for-Developing-More-Secure-Software)
- GitHub's Actions hardening guide recommends the following — [GitHub Docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions):
  - Pin actions to a full commit SHA, verifying it comes from the action's own repo and not a fork. Workflow dependency lockfiles are mentioned as a stronger option where available.
  - Default `GITHUB_TOKEN` to read-only and raise permissions per job.
  - Avoid `pull_request_target` and `workflow_run` with untrusted checkouts.
  - Pass untrusted context values (e.g. PR titles) through environment variables, never interpolated into scripts.
  - Never use self-hosted runners on public repos.
  - Use OIDC instead of long-lived cloud secrets.
  - Protect `.github/workflows` with CODEOWNERS.
  - Use Dependabot for actions, noting that Dependabot does not alert on SHA-pinned actions.
  - Run Scorecard.
- The tj-actions/changed-files compromise (March 2025, CVE-2025-30066) started with a compromised PAT. It was preceded by a compromise of reviewdog/action-setup's v1 tag. The attackers repointed mutable tags and dumped runner memory to exfiltrate secrets into logs. The main lesson drawn is to pin to 40-character SHAs — [Wiz: tj-actions](https://www.wiz.io/fr-fr/blog/github-action-tj-actions-changed-files-supply-chain-attack-cve-2025-30066); [Wiz: reviewdog](https://wiz.io/blog/new-github-action-supply-chain-attack-reviewdog-action-setup); [SoftwareSeni](https://www.softwareseni.com/responding-to-the-tj-actions-github-actions-compromise-and-preventing-tag-based-supply-chain-attacks)
- Trail of Bits ties the 2026 Trivy compromise to a `pull_request_target` misconfiguration — [Trail of Bits](https://blog.trailofbits.com/2026/05/22/we-hardened-zizmors-github-actions-static-analyzer/)
- GitHub Free: rulesets and branch protection are enforced on public repos only. Private repos need Pro, Team or Enterprise. GitHub Community threads (2025) asking to make basic private-repo branch protection free remain open requests. One unofficial reply says rulesets can be created on Free private repos but are not enforced — [GitHub docs: available rules for rulesets (GHES 3.17)](https://docs.github.com/en/enterprise-server@3.17/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets); [Community #174400](https://github.com/orgs/community/discussions/174400); [SSW: which GitHub plan](https://www.ssw.com.au/rules/which-github-plan)
- OpenSSF Scorecard scores each check from 0 to 10. Its checks include Branch-Protection, Pinned-Dependencies, Dangerous-Workflow, Token-Permissions, Code-Review, Signed-Releases, Security-Policy, Binary-Artifacts and Fuzzing — [ossf/scorecard README](https://cdn.jsdelivr.net/gh/ossf/scorecard@main/README.md)
- OpenSSF also recommends signing important releases (cosign), raising your SLSA level, publishing SBOMs and a security policy, and using Allstar — [OpenSSF Concise Guide](https://best.openssf.org/Concise-Guide-for-Developing-More-Secure-Software)

### Inferences
- Ranked by risk reduction per hour for a solo developer (my synthesis):
  1. Account security: passkeys or hardware 2FA, and no long-lived classic PATs. Use fine-grained, repo-scoped, expiring tokens. The tj-actions chain started with a stolen PAT.
  2. Actions hardening: SHA pins, `permissions: read` by default, no `pull_request_target`, plus zizmor in CI or pre-commit.
  3. Secret scanning, both a local hook and GitHub's free push protection where available.
  4. Dependency monitoring with a cooldown and exact pins (which this repo's security review already requires).
  5. Only then, one SAST tool.
- Scanners rank last because a solo developer's likeliest compromise path is credentials or CI, not an injection bug found by SAST.
- Scorecard's Branch-Protection and Code-Review checks will score poorly on a GitHub Free private solo repo whatever you do. That should be accepted, not "fixed".

### Gaps
- Current GitHub docs on passkeys and fine-grained PAT behaviour, and on SSH and Git commit signing, were not fetched in this pass. The recommendations above rest on the general sources cited, not on GitHub's own pages for these features.
- The SLSA spec was not fetched. Whether build-level requirements apply to a repo that ships nothing is unexamined.
- CISA Secure by Design material was not retrieved.

## Consensus on AI code reviewers for security

### Takeaway
The independent evidence says AI reviewers complement deterministic scanners and human review, not replace them. A 2025–2026 academic study found Copilot code review often misses critical vulnerability classes. Vendor claims of large false-positive reductions from AI triage layers are unverified.

### Cited Findings
- Amro and Alalfi (PMLR 2026, arXiv 2509.13650) found that GitHub Copilot's code review frequently fails to detect SQL injection, XSS and insecure deserialization — [PMLR](https://proceedings.mlr.press/v318/amro26a.html); [arXiv](https://arxiv.org/html/2509.13650v1)
- Belozerov et al. caution that AI tools can find vulnerabilities but may also introduce them and mislead developers about code security — [arXiv 2504.20814](https://arxiv.org/html/2504.20814v2)
- AppSec Santa's 2026 study reports that about 25.7% of 522 AI-generated code samples had at least one confirmed vulnerability (five SAST tools, including CodeQL). This is a single lab, and the figures differ between its versions — [AppSec Santa](https://appsecsanta.com/researchai-code-security-study-2026)
- tl;dr sec #305 (Nov 2025) covered open-source AI SAST tools and a vendor comparison. Only the blurb was seen — [tl;dr sec archive](https://tldrsec.com/t/Newsletter)
- Vendors claim that an AI reasoning layer on top of SAST lifts precision (e.g. 35.7% to 89.5%) and cuts false positives below 5%. These are vendor marketing claims, and one vendor itself notes that every vendor says this — [Arnica](https://www.arnica.io/blog/ai-powered-sast-tools-false-positives); [Hacktron](https://www.hacktron.ai/blog/best-ai-sast-tools)
- Latio 2026 lists AI-driven SAST as a headline theme, which signals analyst interest rather than proven replacement — [Datadog's Latio page](https://www.datadoghq.com/ja/resources/latio-application-security-report2026/)

### Inferences
- An AI reviewer (e.g. Claude Code's `/security-review`) is reasonable as a second opinion on diffs. It should not be the only gate, and it adds a third-party app with repo access if installed as a GitHub App.

### Gaps
- No HN or Reddit practitioner threads on trusting AI reviewers were retrieved.
- Clint Gibler's and Latio's specific verdicts on AI code review could not be read in full.

## Common pitfalls: alert fatigue, tool overlap, third-party GitHub Apps

### Takeaway
The sources agree that noise kills adoption: Latio's 2026 framing puts false-positive reduction ahead of finding volume. Overlapping scanners multiply noise. Every third-party GitHub App or action is supply-chain attack surface, as the tj-actions/reviewdog chain showed.

### Cited Findings
- Latio 2026 says developer experience and false-positive reduction now outweigh raw finding volume — [Datadog's Latio page](https://www.datadoghq.com/ja/resources/latio-application-security-report2026/)
- Vendor writing describes alert fatigue leading teams to stop trusting findings. It cites a SAST false-positive rate above 68%, a figure without a clear source — [Arnica](https://www.arnica.io/blog/ai-powered-sast-tools-false-positives)
- An overlap-and-gaps analysis of the AppSec tool landscape (vendor blog) — [Arnica: AppSec tools landscape](https://www.arnica.io/blog/appsec-tools-landscape-categories-overlap-gaps)
- Third-party actions as risk: in the tj-actions/reviewdog cascade, each stage looked legitimate in isolation — [SoftwareSeni](https://www.softwareseni.com/responding-to-the-tj-actions-github-actions-compromise-and-preventing-tag-based-supply-chain-attacks)
- On GitHub Free private repos, some protection settings "look like they work, but do nothing" — [SSW](https://www.ssw.com.au/rules/which-github-plan)

### Inferences
- Each added SaaS scanner that installs as a GitHub App with read/write access to repo contents is a new credential holder. For a solo developer, CLI tools run inside CI with a read-only `GITHUB_TOKEN` have a smaller blast radius than broad GitHub Apps.
- Running SonarQube, Semgrep and CodeQL together on a small TypeScript repo would mostly duplicate findings.

### Gaps
- No primary source was found that quantifies GitHub App permission risk, or that gives guidance on reviewing app scopes specifically.

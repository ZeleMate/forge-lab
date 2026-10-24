# AI / agentic code review and AI-native security review for a solo developer (October 2026)

Scope: LLM-based reviewers that find security bugs in PRs or whole codebases, beyond pattern-matching SAST. The setting is a TypeScript/Bun monorepo in private repos on GitHub Free. Researched 2026-10-24. Many prices come from third-party aggregators because vendor pages were missing, blocked or vague. Each one is flagged. Re-check vendor pages before buying.

## CodeRabbit: pricing, security capabilities, data retention

### Takeaway
CodeRabbit has no free tier for private repos. Private reviews start at Essentials, $24/user/month billed annually or $30 monthly, limited to 1 linked repo. Its "Security Code Review" is included in all plans and runs bundled third-party tools (static analysis, secrets, dependencies, IaC); the docs name Betterleaks. A separately priced "Deep Scan" hunts for exploitable vulnerabilities. Code is described as ephemeral with zero LLM retention, but caching/knowledge-base retention and learnings embeddings are on by default. In January 2025 a researcher got RCE through a malicious PR, and that is the clearest case study of reviewer-as-attack-surface.

### Cited Findings
- Plans per user/month, annual: Essentials $24 (1 linked repo), Team $48 (5 repos), Advanced $72 (10 repos), Enterprise custom (20 repos). Monthly: Essentials $30, Team $60, taken from the FAQ. Annual saves 20%. Paid plans have a 14-day trial. — [CodeRabbit pricing](https://www.coderabbit.ai/pricing)
- Free reviews are "forever for public repositories". No free private-repo tier is described. — [CodeRabbit pricing](https://www.coderabbit.ai/pricing)
- "Security Code Review" in all plans covers "Static analysis, secrets, dependency, and infrastructure checks". A separate, on-demand-priced "Deep Scan" finds "exploitable vulnerabilities and exposed secrets". — [CodeRabbit pricing](https://www.coderabbit.ai/pricing)
- Third-party tools run on Essentials (formerly Pro), Team (formerly Pro+), Advanced and Enterprise. "Almost all tools are enabled by default", and a tool runs only when the repo has files it understands. The tools page names Betterleaks (a secrets scanner) and ESLint (`reviews.tools.eslint.enabled`). Biome is not mentioned on that page. — [CodeRabbit tools docs](https://docs.coderabbit.ai/tools/)
- Data handling: the review environment is disposed of after comments are posted. LLM queries are "ephemeral, with zero retention", and code is not used for training. Exceptions: learnings from chat are stored as embeddings (opt-out available), and a "Data Retention" setting that caches repo data and a knowledge base is on by default; disabling it deletes the cache. — [CodeRabbit Trust Center](https://coderabbit.ai/coderabbit-trust-center); [CodeRabbit config reference](https://docs.coderabbit.ai/reference/configuration)
- Kudelski Security incident: CodeRabbit ran RuboCop outside its sandbox. A PR carrying a crafted `.rubocop.yml` and `ext.rb` ran arbitrary Ruby on CodeRabbit servers and leaked env vars, including the GitHub App private key, which gave write access to about 1M repos where the app was installed (private ones included). The write-up was published August 2025. — [Kudelski Security write-up](https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories)
- CodeRabbit says the issue was disclosed on 2025-01-24 through its VDP, remediated "within hours", with no evidence of other unauthorized access. — [CodeRabbit response blog](https://coderabbit.ai/blog/our-response-to-the-january-2025-kudelski-security-vulnerability-disclosure-action-and-continuous-improvement)
- The RuboCop docs now say it is skipped when the config contains `require` with disallowed entries. — [CodeRabbit RuboCop docs](https://docs.coderabbit.ai/tools/rubocop.md)

### Inferences
- For one developer with one private repo, Essentials is the floor, about $288/yr annual or $360/yr monthly. The 1-repo cap matters if the user wants several private repos covered.
- CodeRabbit's security depth comes from bundled scanners plus LLM review of the diff. It is a general reviewer with a security layer, not a dedicated security agent. Deep Scan is the security-specific add-on, and its price is unpublished.
- Default-on retention settings should be turned off (Data Retention, learnings) if minimising stored code matters.

### Gaps
- I could not confirm from a primary source whether CodeRabbit currently runs Semgrep, Gitleaks, OSV-Scanner or Checkov. The tools page only named Betterleaks and ESLint, and the full tool catalog was not fetched.
- The Deep Scan price was not published.
- Contract-level retention terms (privacy policy, subprocessors, LLM providers used) were not read.

## WorkOS: is there a code-security product?

### Takeaway
No. WorkOS sells auth/identity and adjacent enterprise infrastructure. Its docs index lists no code review, SAST or code-scanning product. It is relevant to "securing the codebase" only indirectly: delegating authentication, authorization, secrets/sensitive-data storage and audit logging to a vendor shrinks the amount of security-critical code you write and review.

### Cited Findings
- The product list in WorkOS's official llms.txt: AuthKit, SSO, Directory Sync, RBAC, Audit Logs, Radar, Vault, Admin Portal, Fine-Grained Authorization (FGA), Feature Flags, Pipes, Events, Domain Verification, MFA, Magic Link, Widgets, Connect, Agent Auth / Agent Registration, Custom Domains, Migrations, plus SDKs/CLI/MCP server. No code review, SAST or code-scanning product appears. — [WorkOS llms.txt](https://workos.com/llms.txt)
- AuthKit covers email/password, social login, passkeys, MFA, magic auth and enterprise SSO, and is free up to 1M MAU. — [WorkOS llms.txt](https://workos.com/llms.txt)
- Radar is bot, fraud and abuse protection during authentication (email/SMS challenges), not source analysis. Vault is encrypted storage and access control for sensitive data, with BYOK. FGA is resource-level authorization. Audit Logs records, exports and streams events to SIEMs. — [WorkOS llms.txt](https://workos.com/llms.txt)
- Third-party pricing: Radar $100/month per 50,000 checks after the first 1,000 free; Audit Logs streaming $125/month per SIEM connection; retention $99/month per 1M events. — [Sacra on WorkOS](https://sacra.com/c/workos) (aggregator, verify)

### Inferences
- For a personal project, the realistic WorkOS relevance is "don't hand-roll auth": AuthKit (free tier) plus FGA/RBAC moves session handling, password storage and authz modelling out of your code. That cuts the authz-bug surface that AI reviewers otherwise have to catch. It does nothing to scan code.

### Gaps
- None material. I verified the absence of a code-security product against WorkOS's own docs index.

## AI-native SAST vendors: pricing, free tiers, logic/authz detection

### Takeaway
Only a few have a usable free tier for one developer's private repos: Corgea Free (10 repos, 10 PR scans/month, claims logic and auth analysis), Aikido Developer (2 users, 10 repos, small AutoFix quota), Snyk Free (about 100 Code tests/month), and probably Semgrep (10 contributors; repo cap and Assistant inclusion disputed). ZeroPath is effectively team/enterprise-priced. DryRun publishes no prices. GitHub Copilot Autofix for private repos needs the $30/committer Code Security add-on, which GitHub lists for Team and Enterprise; on Free it covers public repos only.

### Cited Findings
**Corgea**
- Free $0 "for individual devs": AI SAST, logic and auth scanning, dependency, secrets, container and IaC scanning. Team size 2, 10 repos, 10 PR scans/month. Growth $39/dev/month adds PR scanning, Corgea Agent, Jira and code quality. Scale $49/dev/month adds custom and blocking rules and APIs. Enterprise custom adds single-tenant and SSO. The page is internally inconsistent: PR scanning is listed as a Growth feature, but the table shows 10/month on Free. SOC 2 Type II. No retention or training statement. — [Corgea pricing](https://corgea.com/pricing)
- Corgea's self-run July 2026 benchmark: 47 confirmed issues, 51 findings, 42 TP, 9 FP, 82% precision, 89% recall. This is a vendor figure. — [Corgea "best SAST tools"](https://corgea.com/learn/best-sast-tools)

**ZeroPath**
- Credits (usage-based) is "Coming soon". Team "starting from $1,000/mo + $60/dev" with unlimited repos, PR scans and full scans. Enterprise custom with on-prem, private cloud and BYOK LLM keys, plus a "free proof of value". Startup discount up to 50%. Free access for independent security researchers by application. No free tier. — [ZeroPath pricing](https://zeropath.com/pricing)

**DryRun Security**
- No public pricing; G2 lists none. — [G2](https://www.g2.com/products/dryrun-security/pricing)
- An aggregator reports a 30-day trial, quote-based per-developer pricing, and an unofficial figure of about $19/user/month (unverified). — [StackPick](https://stackpick.net/pricing/dryrun-security/)
- Sacra reports a free GitHub Marketplace plan as a self-serve entry point. Its limits are unknown. — [Sacra](https://sacra.com/research/dryrun-security)
- One independent tester skipped DryRun because the trial required signing a contract. — [Joshua Rogers, Sep 2025](https://joshua.hu/llm-engineer-review-sast-security-ai-tools-pentesters)

**Aikido (AI AutoFix)**
- The free Developer plan has 2 users, 10 repos, 2 container images, 1 domain, 1 cloud account, and rescans every 3 days. The AutoFix quota is disputed (10/month vs 2/month). Paid Basic is about $300–350+/month with 10 users. The source is a competitor blog, so verify. — [CodeAnt AI on Aikido pricing](https://codeant.ai/blogs/aikido-security-pricing); [MakerStack review](https://makerstack.co/reviews/aikido-security-review/)

**Semgrep Assistant**
- Free tier up to 10 contributors. The repo cap is disputed (10 private repos vs 50). Whether Assistant (AI triage/autofix) is free is disputed between sources. Team is $30–35/contributor/month. One tracker says the limits applied 2025-12-23 to 2026-08-28, so they may have changed. — [agentdeals Semgrep](https://agentdeals.dev/vendor/semgrep); [toolradar Semgrep](https://toolradar.com/tools/semgrep/pricing); [aicodereview.cc](https://aicodereview.cc/blog/is-semgrep-free/)

**Snyk (DeepCode AI)**
- Free tier, per an aggregator: 100 Snyk Code tests, 200 Open Source, 100 Container and 300 IaC tests per month. Team $25/dev/month. Public-repo scans don't count toward limits. — [DEV: Snyk pricing 2026](https://dev.to/rahulxsingh/snyk-pricing-in-2026-free-plan-team-business-and-enterprise-costs-breakdown-5e88)

**Pixee**
- Pricing is listed only as "per-repository". There is no published free tier, only a free trial run on your repo. — [Pixee blog](https://www.pixee.ai/blog/checkmarx-alternatives)

**Endor Labs**
- Sources conflict: one says commercial-only with no free tier, another claims a small-project free tier and about $300/project/year. Both are unverified. — [AppSecSanta](https://appsecsanta.com/sca-tools/endor-labs-vs-snyk); [guptadeepak.com](https://guptadeepak.com/tools/top-5-sca-tools-2026/)

**GitHub Copilot Autofix / Code Security**
- Secret Protection is $19 and Code Security $30 per active committer/month. Copilot Autofix is part of Code Security ("automatic fixes for 90% of alert types" in JS, TS, Java and Python). It is included for Team and Enterprise and available on Free for public repos only. On Free, CodeQL, Autofix, push protection and secret scanning cover public repos. Dependabot alerts and updates are on Free. — [GitHub security plans](https://github.com/security/plans)
- An active committer is someone who pushed at least one commit in the last 90 days. — [Redress Compliance](https://redresscompliance.com/microsoft-github-advanced-security-licensing) (third-party)

**Amplify Security**
- In an independent test "nearly all findings were false positives". — [Joshua Rogers](https://joshua.hu/llm-engineer-review-sast-security-ai-tools-pentesters)

### Inferences
- Copilot Autofix sits on CodeQL alerts, so it fixes pattern/dataflow findings. It is not an LLM logic or authz bug finder. For a private repo on GitHub Free it is likely out of reach without moving to Team (the page doesn't say whether Free personal accounts can buy the add-on).
- Of the vendors, Corgea Free is the only one that explicitly claims logic/auth analysis at $0 for private repos. ZeroPath, rated best by the independent tester, is priced for teams ($1,000/month floor).

### Gaps
- DryRun's official pricing page returned 404, and I found no primary source for its free plan.
- I did not find official pricing pages for Snyk, Aikido, Semgrep, Endor Labs or Amplify; all figures above are secondary.
- No source evaluated whether Semgrep Assistant, Snyk DeepCode, Endor Labs AI or Aikido find logic/authz bugs. Their AI features are mostly triage and autofix on rule-based findings.

## Frontier-lab and code-review agents: security focus, cost, how they run

### Takeaway
Anthropic's `/security-review` command and the `anthropics/claude-code-security-review` Action are the only free (pay-your-own-API) LLM security reviewers aimed at PRs. The Action is open source (MIT) and diff-scoped, and its README explicitly says it is not hardened against prompt injection. Anthropic's separate "Claude Code Security" (Feb 2026) is a whole-codebase scanner in limited preview for Team and Enterprise customers. OpenAI's Aardvark became Codex Security in March 2026, billed against ChatGPT/Codex allowances. Google's CodeMender is still research-only. Greptile, Cursor Bugbot and Graphite Diamond are general bug reviewers with no security-specific evidence.

### Cited Findings
**Anthropic**
- The `claude-code-security-review` Action runs Claude Code on PR diffs (changed files only), checks context, filters false positives in a second pass, and posts line comments. It needs `claude-api-key` and `pull-requests: write`. Optional inputs are `exclude-directories`, `claude-model`, `claudecode-timeout` (default 20 min), `run-every-commit` and custom FP-filter instructions. MIT licence. The README shows the default model as `claude-opus-4-1-20250805`, possibly stale. — [GitHub repo](https://github.com/anthropics/claude-code-security-review)
- The FP filter excludes DoS, rate limiting, resource exhaustion, generic input validation without proven impact, and open redirects. Coverage includes injection, authn/authz flaws, data exposure, crypto, race conditions/TOCTOU, deserialization/eval and XSS. — [GitHub repo](https://github.com/anthropics/claude-code-security-review)
- The README says the Action "is not hardened against prompt injection", should only review trusted PRs, and recommends "Require approval for all external contributors". — [GitHub repo](https://github.com/anthropics/claude-code-security-review)
- `/security-review` is the local slash-command equivalent and can be customised by copying `security-review.md` into `.claude/commands/`. — [GitHub repo](https://github.com/anthropics/claude-code-security-review)
- Cost is API usage on your own key; no per-run figure is published. — [GitHub repo](https://github.com/anthropics/claude-code-security-review)
- "Claude Code Security" launched in limited research preview in Feb 2026 for Enterprise and Team customers, with an application route for OSS maintainers. It reasons over code, re-checks findings to filter FPs, assigns severity and confidence, and suggests patches that need human approval. Anthropic reports 500+ previously unknown vulnerabilities in OSS found with Claude Opus 4.6. This is secondary coverage; I did not read Anthropic's announcement. — [ThaiCERT](https://www.thaicert.or.th/en/2026/02/25/anthropic-launches-claude-code-security-an-ai-tool-for-detecting-and-remediating-source-code-vulnerabilities/); [IT Daily](https://itdaily.com/news/cloud/anthropic-launches-claude-code-security)

**OpenAI**
- Aardvark was announced in Oct 2025 as an agentic security researcher in private beta. — [OpenAI](https://openai.com/index/introducing-aardvark/)
- It was renamed Codex Security in March 2026: a research preview in Codex Web for ChatGPT Pro, Enterprise, Business and Edu. — [Help Net Security](https://www.helpnetsecurity.com/2026/03/09/openai-codex-security%E2%81%A0-feature/); [SecurityWeek](https://www.securityweek.com/openai-rolls-out-codex-security-vulnerability-scanner/)
- No standalone price; reviews "consume included Codex allowance or ChatGPT credits". One source says the pricing matrix still lists Codex Security on connected GitHub repos as Enterprise-only. — [eesel.ai](https://www.eesel.ai/blog/codex-security-cloud) (third-party)

**Google DeepMind CodeMender**
- Still a research project, not a usable product, as of Oct 2026 coverage. 72 human-reviewed fixes were upstreamed to OSS. No release timeline. — [CSO Online](https://www.csoonline.com/article/4068774/google-deepmind-launches-an-ai-agent-to-fix-code-vulnerabilities-automatically.html); [agentsinthewild](https://agentsinthewild.co/use-cases/google-deepmind-codemender)

**Greptile / Cursor Bugbot / Graphite Diamond**
- Greptile: free Starter for 1 active developer with 50 credits/month. Pro $30/seat with 50 credits/seat; extra credits $1. A review costs 1 (Base), 3 (Plus) or 10 (Apex) credits. — [cubic.dev pricing roundup](https://www.cubic.dev/blog/ai-code-review-pricing) (competitor)
- Cursor Bugbot: no standalone price. Included in Cursor Teams ($40/user/month); individual plans from $20/month with usage-based Bugbot billing at about $1.00–1.50 per run. — [repowise](https://repowise.dev/blog/comparisons/cursor-bugbot-pricing-alternatives) (third-party)
- Graphite Diamond: included in Graphite Team, $40/user/month. — [cubic.dev](https://www.cubic.dev/blog/ai-code-review-pricing)
- A competitor-run benchmark on 118 real production bugs (not security-specific): Bugbot 42.4%, Greptile 23.6% (on a 72-bug subset), Diamond 18.3%. — [Macroscope](https://macroscope.com/content/best-code-review-tools-2026) (vendor bias)

### Inferences
- For this user, `/security-review` run locally needs no CI secret and is the cheapest deep option. The Action adds automation but puts an API key in Actions secrets.
- Greptile's free Starter is the only free general reviewer for private repos found. Nothing shows it is strong on security.

### Gaps
- No published cost per run for the Anthropic Action.
- No security-specific benchmark for Greptile, Bugbot or Diamond.
- I did not verify Codex Security availability for an individual ChatGPT Plus/Pro user on private GitHub repos.

## Evidence of quality

### Takeaway
Independent evidence is thin. The most-cited hands-on comparison, by Joshua Rogers (Sep 2025, over a year old), ranked ZeroPath first, then Corgea and Almanax. Corgea had about 50% false positives in his tests, and Amplify and Gecko found almost nothing. The rest are vendor-run or competitor-run benchmarks.

### Cited Findings
- On deliberately vulnerable corpora: ZeroPath found nearly all issues, Almanax about 85%, Corgea about 80%. ZeroPath found real bugs in curl (Kerberos5 FTP OOB read, a broken infinite loop, lowercase STARTTLS) and sudo (invalid free, a TLS cert check accepting by IP). False positives: Corgea about 50%; ZeroPath some (C/C++ macros, duplicates); Amplify nearly all. All tools missed a manually found infinite loop in the image-size npm package. Daniel Stenberg's quote: "this is what an AI can do when wielded by a competent human". — [Joshua Rogers, 2025-09-18](https://joshua.hu/llm-engineer-review-sast-security-ai-tools-pentesters)
- An academic study of LLM agents filtering SAST false positives exists. Not read in full. — [arXiv 2601.22952](https://arxiv.org/pdf/2601.22952)
- Vendor claims (unverified): Corgea 82% precision / 89% recall on its own benchmark ([Corgea](https://corgea.com/learn/best-sast-tools)); ZeroPath "up to 75%" fewer FPs ([ZeroPath blog](https://zeropath.com/blog/best-sast-tools)); Anthropic 500+ OSS vulns ([IT Daily](https://itdaily.com/news/cloud/anthropic-launches-claude-code-security)); CodeMender 72 upstream fixes ([agentsinthewild](https://agentsinthewild.co/use-cases/google-deepmind-codemender)).

### Inferences
- The tools differ more by codebase than by brand. The Rogers review notes results "depended on the codebase". The only reliable test for this repo is a pilot on a seeded set of known bugs, which fits the project's Experiment-driven style.

### Gaps
- No independent 2026 head-to-head of DryRun, ZeroPath, Corgea and Claude Code Security.
- No practitioner (HN/Reddit) threads were collected in this pass.
- No published false-positive rate for the Anthropic Action.

## Risks: prompt injection, CI secrets on fork PRs, code sent to third parties

### Takeaway
The risks are real and documented. In "Comment and Control" (2026), attacker text in issues and PRs made the Claude Code Security Review Action, the Gemini CLI action and the Copilot agent leak CI secrets, using GitHub itself as the exfiltration channel. Microsoft documented a patched path in the Claude Code GitHub Action, and Aikido's "PromptPwnd" showed the same class earlier. The CodeRabbit RCE shows that a hosted reviewer holding a GitHub App key is itself high-value. Every SaaS reviewer receives your code.

### Cited Findings
- Microsoft Threat Intelligence found a prompt-injection path in the Claude Code GitHub Action that reached workflow secrets. A hidden HTML comment in an issue made the agent read `/proc/self/environ`. Patched in v2.1.128. Microsoft recommends a "Rule of Two" hardening framework. — [Microsoft Security blog, 2026-06-05](https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/); [datawater summary](https://datawater.com/claude-code-github-action-prompt-injection/)
- "Comment and Control" (Aonan Guan et al., Johns Hopkins) was validated against Claude Code Security Review, the Gemini CLI action and the Copilot agent. Vendors paid bounties and patched; one outlet says none publicly warned users. — [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-ci-prompt-injection-202608/); [VentureBeat](https://venturebeat.com/security/ai-agent-runtime-security-system-card-audit-comment-and-control-2026)
- PromptPwnd: hidden instructions in issues made AI agents in Actions run commands and post secrets into the issue thread. — [Aikido blog](https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents)
- CSA guidance: treat all untrusted GitHub text as instructions-bearing, minimise agent tools and secret scope, and don't rely on regex filtering. — [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-github-actions-security-20260503-csa-st/)
- The Anthropic Action README itself says it is not hardened against prompt injection and recommends requiring approval for external contributors. — [GitHub repo](https://github.com/anthropics/claude-code-security-review)
- Hosted-reviewer compromise: the CodeRabbit RCE through a PR-supplied linter config leaked its GitHub App private key, giving write access to about 1M repos. — [Kudelski Security](https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories)
- Data handling claims: CodeRabbit says zero LLM retention and no training, but caching is on by default ([Trust Center](https://coderabbit.ai/coderabbit-trust-center)). Corgea states only SOC 2 Type II ([pricing](https://corgea.com/pricing)). ZeroPath offers self-host and BYOK only on Enterprise ([pricing](https://zeropath.com/pricing)).

### Inferences
- For a solo private repo with no outside contributors, the fork-PR secret risk is low. Prompt injection can still arrive through content the agent reads: dependency READMEs, fetched docs, issue text, and files an attacker manages to get into a PR. Concrete mitigations from the sources: trigger on `pull_request` (not `pull_request_target`), use least-privilege `permissions:`, require approval for outside contributors, scope the API key to a low-spend workspace, and prefer running `/security-review` locally where no CI secret exists.
- Installing any review GitHub App grants it standing read (often write) access to the repo. The CodeRabbit case shows that access is only as safe as the vendor's sandboxing.
- This fits the existing project rules (`docs/research/security-review.md`: loopback only, no trusted dependency scripts). An LLM reviewer with CI secrets is a new trust boundary that should be documented there.

### Gaps
- No CodeRabbit-specific prompt-injection research was found. The Kudelski issue was RCE through tooling, not prompt injection.
- I did not read Microsoft's "Rule of Two" specifics in full.
- No data on which LLM subprocessors each vendor uses.

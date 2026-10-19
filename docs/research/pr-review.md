# Automatic agentic PR review for forge-lab (issue #16)

Researched 2026-10-18 from first-party docs. Web content treated as data. Nothing was installed, purchased or changed.

## Verdict

GitHub's review is **not free for a private personal repo by default**. Copilot code review needs a paid individual plan (Pro, Pro+, Max, or the free-for-some Pro/Student), and it also consumes GitHub Actions minutes on private repos. Repository rulesets, the documented "every PR in the repo" switch, are documented for Team/Enterprise plans only, which probably excludes a private repo on a Free personal account. Pro's per-user "review my own PRs automatically" setting works as a substitute.

**Recommendation (conditional, one fact is unverified):**
1. Open https://github.com/settings/copilot. If the account has Copilot Pro (paid, or free via student/teacher/OSS-maintainer eligibility), use **Copilot code review via the per-user "Automatic Copilot code review" setting**. Marginal cost is AI credits from the plan allowance plus Actions minutes inside the free 2,000/month.
2. If there is no Copilot Pro, do **not** pay for it just for this. Use the **Claude Code GitHub Action** with a review workflow. It is the next-best fit (reads CLAUDE.md and the full checkout, runs in our own CI, no third-party code storage). Auth with `CLAUDE_CODE_OAUTH_TOKEN` if the user has a Claude subscription (no extra API bill), otherwise an `ANTHROPIC_API_KEY` (pay per token).
3. CodeRabbit and Gemini Code Assist are not recommended (paid or Google Cloud billing, preview, third-party code handling).

## User's entitlement (read-only checks)

- `gh api user --jq .plan` returned `null`: the token lacks the `user` scope (scopes: `admin:public_key, gist, read:org, repo`), so GitHub plan could not be read. Fixing needs `gh auth refresh -s user`, a token change we did not make.
- `gh api user/copilot`, `/user/copilot_billing`, `/users/ZeleMate/settings/billing/premium_request/usage` all returned 404. Copilot entitlement is **unknown**.
- Repo `ZeleMate/forge-lab`: private, user has admin. `GET /repos/.../rulesets` returned `[]` (no rulesets yet).
- Open question for the user: does https://github.com/settings/copilot show Copilot Pro? Does https://github.com/settings/billing/summary show GitHub Free or Pro?

## Option A: GitHub Copilot code review

Sources: docs.github.com/en/copilot/concepts/agents/code-review, .../how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review, .../get-started/plans, .../concepts/billing/usage-based-billing-for-individuals, .../billing/.../about-billing-for-github-actions.

| Question | Answer |
|---|---|
| Plans | Included in Copilot Student, Pro ($10/mo), Pro+ ($39/mo), Max. **Copilot Free does not include it** (only "Review selection" in VS Code). Pro is "free for some users" (docs do not state who; GitHub's student/teacher/OSS programs are the known routes, verify on the sign-up page). |
| Limits | Billing is now **AI credits** (1 credit = $0.01), not premium requests. Monthly allowance: Pro 1,500, Pro+ 7,000, Max 20,000; reset 00:00 UTC on the 1st, no rollover. Estimated cost per review: Lite about $0.05 to $1, Balanced (default) about $0.25 to $5. These estimates exclude Actions minutes. |
| Out of credits | Upgrade, set a USD budget for extra usage, or wait for the reset. The individual-billing page does not say review is hard-blocked for individuals (it is for Business/Enterprise at budget). |
| Private repos | Works, but **each review consumes GitHub Actions minutes as well as AI credits**; self-hosted runners do not consume minutes. Free personal accounts get 2,000 private-repo minutes/month. Public repos are free of Actions minutes. |
| Automatic review | Two routes. (1) **User setting** (Pro/Pro+/Max/Business/Enterprise): profile > Copilot settings > Code review > "Automatic Copilot code review", for your own PRs, optional "Review new pushes" and "Review draft pull requests". (2) **Repository ruleset** "Automatically request Copilot code review". Rulesets are documented as available on GitHub Team/Enterprise; for a private repo on a Free personal account this is an inference that the ruleset is unavailable (the docs do not mention personal accounts). Not available for managed user accounts. |
| Without either | Copilot only reviews a PR when assigned/requested as reviewer. |
| Context | "Full project context gathering" over the whole repo. It runs on GitHub Actions; if unavailable it falls back to a more limited review. Ignores dependency manifests/lockfiles, logs, SVG. |
| Custom instructions | Reads `.github/copilot-instructions.md`, path-scoped `.github/instructions/NAME.instructions.md` (frontmatter `applyTo`; `excludeAgent: "code-review"` opts out), and agent instructions (`AGENTS.md`, or root `CLAUDE.md`/`GEMINI.md`) plus skills. **Read from the head (PR) branch, not the base**, so a PR can alter its own review rules. Docs state no size limit. |
| Enforce CONTEXT.md / security notes | Not natively. Put the rules in the instruction files, and keep them short; point to CONTEXT.md and `research/security-review.md` by path (the reviewer has repo-wide context, but nothing guarantees it opens linked files). Treat as best-effort guidance. |
| Permissions / secrets | First-party GitHub feature: no app install, no secrets to create. It posts review comments; it does not need you to hand any key to a third party. Suggestions can be handed to the Copilot agent only when you ask. |

## Option B: Claude Code GitHub Action

Sources: code.claude.com/docs/en/github-actions, .../code-review.

- **Not free**: runs on our Actions minutes (free 2,000/mo private) plus either API tokens (`ANTHROPIC_API_KEY`) or the user's Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; subscription Pro/Max/Team/Enterprise).
- The separate managed **Code Review** product is **Team/Enterprise only**, so not available on a personal account.
- Setup: `/install-github-app` (admin on repo) or manual: install the Claude GitHub App, add the secret, add a workflow. Docs include a review workflow that triggers on `pull_request` (opened, synchronize, ready_for_review, reopened) and runs the `code-review` plugin with `--comment` and `--allowedTools "mcp__github_inline_comment__create_inline_comment"`. Skips drafts, closed, trivial and already-commented PRs.
- Instructions: reads `CLAUDE.md` (and repo skills in `.claude/skills/`) from the checkout, so CONTEXT.md and the security notes can be referenced directly and it can read any file in the repo.
- **Permissions caveat**: installing the official app grants its whole shared set (Contents, Issues, PRs, Workflows, Actions, Administration-read, etc., mostly read+write); you cannot accept a subset. A custom GitHub App limited to Contents/Issues/PRs is the documented least-privilege route. Workflow itself can be limited to `contents: read, pull-requests: read` per the docs' review example.
- Secrets: stored as repo Actions secrets; fork PRs do not receive secrets on public repos (not relevant while private). Prompt-injection risk from PR content is real, so keep the review job read-only and do not reuse the `@claude` write workflow for it.
- Does not block merges by itself; findings are comments.

## Option C: CodeRabbit

Source: coderabbit.ai/pricing, docs.coderabbit.ai/faq.

- Free reviews forever only for **public** repos (pricing page). Paid: Essentials $24/dev/mo annual ($30 monthly), Team $48, Advanced $72; 14-day trial. The pages do not say a free plan covers private repos (the FAQ defers to a plans page), so assume **not free for private**.
- Shares code with OpenAI and/or Anthropic for review, caches encrypted code and vector indexes, "Learnings" opt-out. Third-party app install with review permissions. Config via repo YAML; the FAQ does not name `AGENTS.md`/`CLAUDE.md` support.

## Option D: Gemini Code Assist for GitHub

Source: docs.cloud.google.com/gemini/docs/code-review/{review-repo-code,set-up-code-assist-github}.

- The current docs describe an enterprise setup via a Google Cloud project with a **valid billing account** and Developer Connect, labelled **Preview**, quota "100+ PRs/day". Docs fetched do not state any free tier for private repos. A previous free consumer GitHub app may exist but was not documented in the pages checked; not verified. Not recommended.

## Comparison

| | Free for private personal repo? | Auto on every PR | Reads CONTEXT.md/AGENTS.md | Write access | Secrets |
|---|---|---|---|---|---|
| Copilot (Pro) | Only if Pro already owned/eligible; plus Actions minutes | Yes (user setting; ruleset needs Team) | Instructions files, AGENTS.md | Comments only | None |
| Copilot Free | No (no code review) | n/a | n/a | n/a | n/a |
| Claude Action | No (tokens or subscription, plus minutes) | Yes (workflow) | CLAUDE.md, full checkout | App has broad perms; job can be read-only | 1 repo secret |
| CodeRabbit | No (paid, trial only) | Yes | YAML config | App | none (3rd party) |
| Gemini Code Assist | No evidence of free | Yes | style guide | App | GCP billing |

## Setup checklist for the follow-up task

Option A (Copilot Pro already available):
- [ ] User confirms at github.com/settings/copilot that Copilot Pro (or Student/free Pro) is active; if not, stop and use Option B.
- [ ] Add `.github/copilot-instructions.md`: project one-liner, "use the vocabulary in CONTEXT.md exactly, flag renamed or synonym terms", a short checklist from `research/security-review.md` (secrets, injection, dependency/lockfile changes, permissions), "prefer few, high-severity comments". Keep it brief.
- [ ] Add `AGENTS.md` at repo root if the project wants one shared file (code review reads it); avoid duplicating text across both.
- [ ] User (not an agent): github.com > profile photo > Copilot settings > Code review > enable **Automatic Copilot code review**; enable **Review new pushes**; leave drafts off.
- [ ] If the account is on GitHub Team: instead add a branch ruleset (Settings > Rules > Rulesets > New branch ruleset, Active, target default branch, "Automatically request Copilot code review").
- [ ] Optionally set review effort to Lite under repo Settings > Copilot > Code review to save credits.
- [ ] Open a throwaway PR and confirm a Copilot review appears; check the Actions minutes and AI credits usage at github.com/settings/billing after a week.
- [ ] Remember instructions come from the PR branch: instruction-file changes in a PR affect that PR's own review.

Option B (no Copilot Pro):
- [ ] Decide auth: `claude setup-token` to get an OAuth token (subscription) or a Console API key.
- [ ] Add repo secret `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) via Settings > Secrets and variables > Actions.
- [ ] Install the Claude GitHub App on forge-lab only (accepts its full permission set), or create a custom app limited to Contents/Issues/PRs.
- [ ] Add `.github/workflows/claude-review.yml` using the docs' review example (`pull_request` trigger, `contents: read`, `pull-requests: read`, `id-token: write`, `--comment` plus inline comment tool, `--max-turns` and `timeout-minutes` caps, concurrency group per PR). Pin `anthropics/claude-code-action` to a reviewed version/SHA.
- [ ] Add `CLAUDE.md` with CONTEXT.md vocabulary rule and security checklist reference.
- [ ] Test on a throwaway PR; watch Actions minutes and token spend.

## Open questions

- Is Copilot Pro active (or free-eligible) on ZeleMate? Is the GitHub plan Free or Pro? (needs the user, or `gh auth refresh -s user`.)
- Is a Claude subscription available for OAuth-token use in Actions?
- Do we want the review to be advisory only (all options are) or a required check? Required check needs branch protection/rulesets, which is a Team/Pro feature on private repos.
- Is the head-branch instruction loading acceptable given the hardening goals (a malicious or agent-authored PR could weaken its own review rules)? Claude Code Review managed reads `REVIEW.md` from the base branch, but is Team/Enterprise only.

## Sources

- https://docs.github.com/en/copilot/concepts/agents/code-review
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review
- https://docs.github.com/en/copilot/get-started/plans
- https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
- https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- https://code.claude.com/docs/en/github-actions
- https://code.claude.com/docs/en/code-review
- https://www.coderabbit.ai/pricing and https://docs.coderabbit.ai/faq
- https://docs.cloud.google.com/gemini/docs/code-review/review-repo-code and .../set-up-code-assist-github

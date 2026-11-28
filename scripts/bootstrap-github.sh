#!/usr/bin/env bash
# Create the GitHub repo (if needed) and apply this repo's GitHub settings, or check them for drift.
#
#   ./scripts/bootstrap-github.sh --dry-run             # print what would happen
#   ./scripts/bootstrap-github.sh                       # do it (idempotent: safe to re-run)
#   ./scripts/bootstrap-github.sh --check [owner/repo]  # read-only: report drift, exit 1 if any
#
# What to set is in .github/settings-requirements.json and .github/secret-requirements.json, both
# written by the repo template (ADR 0003 and ADR 0005 there). This script only applies or checks them;
# the repo-github-setup audit runs --check.
# Needs: gh (authenticated as ZeleMate or an org admin), git, jq.
set -euo pipefail

OWNER="ZeleMate"
REPO="forge-lab"
VISIBILITY="public"
DESCRIPTION="Learning repo: Cartographer, an agent on the TrueForge harness (TS + Bun)"
ANSWERS=".copier-answers.yml"
SETTINGS=.github/settings-requirements.json
SECRETS=.github/secret-requirements.json

MODE=apply
case "${1:-}" in
  "") ;;
  --dry-run) MODE=dry-run ;;
  --check) MODE=check ;;
  *) echo "usage: $0 [--dry-run | --check [owner/repo]]" >&2; exit 2 ;;
esac
FULL="$OWNER/$REPO"
if [ "$MODE" = check ] && [ -n "${2:-}" ]; then FULL=$2; fi

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "Needs jq (brew install jq, or apt-get install jq)."; exit 2; }
[ -f "$SETTINGS" ] || { echo "No $SETTINGS: run copier update to get it."; exit 2; }
if [ "$MODE" != dry-run ]; then
  gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first."; exit 2; }
fi

drift=0
say()     { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()      { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn()    { printf '\033[33m  ! %s\033[0m\n' "$*"; }
unknown() { printf '\033[33m  ? %s\033[0m\n' "$*"; }
# A requirement that isn't met: drift for the check, a warning for bootstrap.
unmet()   { if [ "$MODE" = check ]; then printf '\033[31m  DRIFT %s\033[0m\n' "$*"; drift=1; else warn "$*"; fi; }

# Run a command, or print it in dry-run mode. Failures are reported, not fatal.
run() {
  if [ "$MODE" = dry-run ]; then printf '  [dry-run] %s\n' "$*"; return 0; fi
  if out=$("$@" 2>&1); then ok "$*"; else warn "failed: $*"; printf '    %s\n' "$out" | head -5; fi
}

# ------------------------------------------------------------------ the GitHub port
# The only two functions that call the GitHub API for settings and secrets. The template's tests put
# a fake gh on PATH that serves recorded API responses; dry-run mode stands in for writes.
CACHE=$(mktemp -d)
trap 'rm -rf "$CACHE"' EXIT
GH_BODY=null
GH_STATUS=unreadable
# gh_read <endpoint>: sets GH_BODY to GitHub's answer (null when empty), and GH_STATUS to ok,
# missing (HTTP 404) or unreadable (anything else: permissions, plan, network). Answers are cached.
gh_read() {
  local c err
  c="$CACHE/$(printf '%s' "$1" | tr '/?&=' '____')"
  if [ -f "$c.status" ]; then GH_STATUS=$(cat "$c.status"); GH_BODY=$(cat "$c.body"); return 0; fi
  GH_BODY=null; GH_STATUS=unreadable
  if [ "$MODE" != dry-run ]; then
    err="$c.err"
    if GH_BODY=$(gh api -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$1" 2>"$err"); then
      GH_STATUS=ok; [ -n "$GH_BODY" ] || GH_BODY=null
    else
      GH_BODY=null
      if grep -q '(HTTP 404)' "$err"; then GH_STATUS=missing; fi
    fi
  fi
  printf '%s' "$GH_STATUS" >"$c.status"; printf '%s' "$GH_BODY" >"$c.body"
}
# gh_write <method> <endpoint> [json body] [label for the body]: makes the change, or prints it in
# dry-run mode. Failures are reported, not fatal, because some endpoints depend on plan or visibility.
gh_write() {
  local out args
  if [ "$MODE" = dry-run ]; then
    printf '  [dry-run] gh api -X %s %s%s\n' "$1" "$2" "${3:+ --input ${4:-$3}}"; return 0
  fi
  args=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -X "$1" "$2")
  if [ -n "${3:-}" ]; then args+=(--input -); fi
  if out=$(gh api "${args[@]}" 2>&1 <<<"${3:-}"); then ok "$1 $2"; else warn "failed: $1 $2"; printf '    %s\n' "$out" | head -5; fi
}

# ------------------------------------------------------------------ reading the requirements
# covers($w): GitHub's answer has everything in $w. Objects: every key in $w, recursively. Arrays:
# every element of $w is covered by some element. Anything else: equal. misses lists what isn't.
JQ_LIB='
def path_join($p; $k): if $p == "" then $k else "\($p).\($k)" end;
def show: if type == "string" then . else tojson end;
def covers($w):
  if ($w | type) == "object" then
    type == "object" and (. as $g | all($w | to_entries[]; . as $e | $g | has($e.key) and (.[$e.key] | covers($e.value))))
  elif ($w | type) == "array" then
    type == "array" and (. as $g | all($w[]; . as $x | any($g[]; covers($x))))
  else . == $w end;
def misses($w; $p):
  if ($w | type) == "object" then
    if type != "object" then "unknown\t\($p): not in GitHub'"'"'s answer"
    else . as $g | $w | to_entries[] | . as $e
      | if ($g | has($e.key)) then ($g[$e.key] | misses($e.value; path_join($p; $e.key)))
        else "unknown\t\(path_join($p; $e.key)): not in GitHub'"'"'s answer" end
    end
  elif ($w | type) == "array" then
    if type != "array" then "drift\t\($p) = \(show) (want \($w | show))"
    else . as $g | $w[] | . as $x | select(any($g[]; covers($x)) | not) | "drift\t\($p) lacks \($x | show)" end
  elif . == $w then empty
  else "drift\t\($p) = \(show) (want \($w | show))" end;
'
covers() { jq -e --argjson w "$2" "$JQ_LIB covers(\$w)" <<<"$1" >/dev/null 2>&1; }
# field <entry> <name>: the field as text (strings bare, anything else as JSON), empty when absent.
field() { jq -r --arg f "$2" '.[$f] // empty | if type == "string" then . else tojson end' <<<"$1"; }
body_of() { # what bootstrap sends, compact JSON, or empty
  local f
  f=$(field "$1" body_file)
  if [ -n "$f" ]; then jq -c . "$f"; else field "$1" body; fi
}
expect_of() { # what the check compares: expect, else the body, else nothing ({})
  local x
  x=$(field "$1" expect)
  [ -n "$x" ] || x=$(body_of "$1")
  [ -n "$x" ] || x='{}'
  printf '%s' "$x"
}
# item_id <collection endpoint> <key>: the id of the collection item matching key, or empty.
# It runs in $(...), so callers gh_read the collection first to see GH_STATUS (the read is cached).
item_id() {
  gh_read "$1"
  [ "$GH_STATUS" = ok ] || return 0
  jq -r --argjson k "$2" "$JQ_LIB"'(if type == "array" then . else [.[] | arrays] | add // [] end)
    | map(select(covers($k))) | .[0].id // empty' <<<"$GH_BODY" 2>/dev/null || true
}

apply_entry() {
  local e=$1 name ep method reason body key id
  name=$(field "$e" name); ep=$(field "$e" endpoint); method=$(field "$e" method); reason=$(field "$e" unavailable)
  if [ -n "$reason" ]; then say "$name"; warn "Skipped: $reason"; return 0; fi
  if [ -z "$ep" ] || [ -z "$method" ]; then return 0; fi # manual steps and check-only entries
  ep=${ep//\{repo\}/$FULL}
  say "$name"
  body=$(body_of "$e"); key=$(field "$e" key)
  if [ -n "$key" ]; then
    id=$(item_id "$ep" "$key")
    if [ -n "$id" ]; then
      gh_read "$ep/$id"
      if [ "$GH_STATUS" = ok ] && covers "$GH_BODY" "$body"; then ok "already set"; else gh_write PUT "$ep/$id" "$body" "$(field "$e" body_file)"; fi
      return 0
    fi
  fi
  gh_write "$method" "$ep" "$body" "$(field "$e" body_file)"
}

check_entry() {
  local e=$1 name ep reason when wep wexp key id kind text
  name=$(field "$e" name); ep=$(field "$e" endpoint); reason=$(field "$e" unavailable)
  if [ -n "$reason" ]; then say "$name"; unknown "unavailable: $reason"; return 0; fi
  if [ -z "$ep" ]; then say "$name"; unknown "the API can't show this: confirm by hand"; return 0; fi
  ep=${ep//\{repo\}/$FULL}
  when=$(field "$e" when)
  if [ -n "$when" ]; then
    while IFS=$'\t' read -r -u 4 wep wexp; do
      wep=${wep//\{repo\}/$FULL}
      gh_read "$wep"
      if [ "$GH_STATUS" != ok ]; then say "$name"; unknown "could not read $wep"; return 0; fi
      covers "$GH_BODY" "$wexp" || return 0
    done 4< <(jq -r 'to_entries[] | [.key, (.value | tojson)] | @tsv' <<<"$when")
  fi
  say "$name"
  key=$(field "$e" key)
  if [ -n "$key" ]; then
    gh_read "$ep"
    id=$(item_id "$ep" "$key")
    case "$GH_STATUS" in
      ok) if [ -z "$id" ]; then unmet "missing: no item matching $key in $ep"; return 0; fi ;;
      missing) unmet "missing: $ep (HTTP 404)"; return 0 ;;
      *) unknown "could not read $ep (permissions or plan)"; return 0 ;;
    esac
    ep="$ep/$id"
  fi
  gh_read "$ep"
  case "$GH_STATUS" in
    missing) unmet "missing: $ep (HTTP 404)"; return 0 ;;
    unreadable) unknown "could not read $ep (permissions or plan)"; return 0 ;;
  esac
  while IFS=$'\t' read -r -u 4 kind text; do
    case "$kind" in
      ok) ok "${text:-enabled}" ;;
      drift) unmet "$text" ;;
      *) unknown "$text" ;;
    esac
  done 4< <(jq -r --argjson w "$(expect_of "$e")" "$JQ_LIB"'
    if ($w | length) == 0 then "ok\t"
    elif type != "object" then "unknown\tGitHub'"'"'s answer has no fields"
    else . as $g | $w | to_entries[] | . as $e | [$g | misses({($e.key): $e.value}; "")]
      | if length > 0 then .[]
        else "ok\t\($e.key)" + ($g[$e.key] | if type == "object" or type == "array" then "" else " = \(tostring)" end) end
    end' <<<"$GH_BODY")
}

# ------------------------------------------------------------------ secrets
# TPL_PRIVATE: true, false or unknown: is the template repo (_src_path in the answers file) private?
TPL="" TPL_PRIVATE=""
template_private() {
  [ -z "$TPL_PRIVATE" ] || return 0
  TPL=$(sed -n 's/^_src_path: *//p' "$ANSWERS" 2>/dev/null | head -n 1 \
    | sed -E -e "s/^['\"]//" -e "s/['\"]\$//" -e 's#^gh:##' -e 's#^(https://|git@)github\.com[:/]##' -e 's#\.git$##')
  TPL_PRIVATE=unknown
  if printf '%s' "$TPL" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    gh_read "repos/$TPL"
    # Not `.private // empty`: jq's // treats false as missing.
    case "$(jq -r '.private | tostring' <<<"$GH_BODY" 2>/dev/null)" in true) TPL_PRIVATE=true ;; false) TPL_PRIVATE=false ;; esac
  fi
}

# The Actions secrets in the secret requirements, each set or not needed. Names only, never values.
secrets_step() {
  local names name used_by waiver cond if_missing wf note
  say "Secrets the workflows need"
  if [ ! -f "$SECRETS" ]; then unknown "no $SECRETS: run copier update to get it"; return 0; fi
  if [ "$MODE" = dry-run ]; then
    jq -r '.secrets[] | select(.store == "actions") | "  [dry-run] check that \(.name) is set"' "$SECRETS"; return 0
  fi
  gh_read "repos/$FULL/actions/secrets?per_page=100"
  if [ "$GH_STATUS" != ok ]; then unknown "cannot list secrets (needs admin)"; return 0; fi
  names=$(jq -r '.secrets[].name' <<<"$GH_BODY")
  # One line per secret; "-" for an absent field, because read collapses empty tab-separated fields.
  # fd 3, so nothing in the loop can read the list.
  while IFS=$'\t' read -r -u 3 name used_by waiver cond if_missing; do
    note=""
    # A secret is needed only while the file that reads it is in the repo (a repo may delete a workflow).
    if [ "$used_by" != - ] && [ ! -e "$used_by" ]; then ok "$name is not needed: $used_by isn't in this repo"; continue; fi
    case "$waiver" in
      -) ;;
      workflow_disabled=*)
        wf=${waiver#workflow_disabled=}
        gh_read "repos/$FULL/actions/workflows/$wf"
        if [ "$(jq -r '.state // empty' <<<"$GH_BODY" 2>/dev/null)" = disabled_manually ]; then
          ok "$name is not needed: $wf is disabled (re-enable with: gh workflow enable $wf)"; continue
        fi
        note=" (not needed while $wf is disabled)" ;;
      *) unknown "$name: unknown waiver '$waiver'"; continue ;;
    esac
    case "$cond" in
      -) ;;
      template_private)
        template_private
        case "$TPL_PRIVATE" in
          true) note=" (the template repo is private)" ;;
          false) ok "$name is not needed: the template repo is public"; continue ;;
          *) unknown "$name: could not tell whether the template repo '${TPL:-?}' is private; if it is, $name must be set"; continue ;;
        esac ;;
      *) unknown "$name: unknown condition '$cond'"; continue ;;
    esac
    if grep -qx "$name" <<<"$names"; then ok "$name is set"; else unmet "$name is not set$note: $if_missing until it is (see docs/SETUP.md)"; fi
  done 3< <(jq -r '.secrets[] | select(.store == "actions")
    | [.name, (.used_by // "-"), ((.waived_if // {}) | to_entries | map("\(.key)=\(.value)") | join(",") | if . == "" then "-" else . end),
       (.only_if // "-"), (.if_missing // "-")] | @tsv' "$SECRETS")
}

# ------------------------------------------------------------------ check
if [ "$MODE" = check ]; then
  echo "Checking $FULL against $SETTINGS and $SECRETS"
  gh_read "repos/$FULL"
  if [ "$GH_STATUS" != ok ]; then unmet "repository $FULL does not exist or is not visible to you"; exit 1; fi
  while IFS= read -r -u 3 entry; do check_entry "$entry"; done 3< <(jq -c '.settings[]' "$SETTINGS")
  secrets_step
  echo
  if [ "$drift" = 0 ]; then echo "NO DRIFT"; exit 0; fi
  echo "DRIFT FOUND: re-run ./scripts/bootstrap-github.sh (dry run first; it is idempotent) or fix the items above"
  exit 1
fi

# ------------------------------------------------------------------ git + repo
say "Local git repository"
# forge-lab: `git rev-parse` rather than `-d .git`, which is a file in a git worktree.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  run git init -b main
fi
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  run git add -A
  run git commit -m "chore: initial commit from repo template"
else
  ok "already has commits"
fi

say "GitHub repository $FULL ($VISIBILITY)"
if gh repo view "$FULL" >/dev/null 2>&1; then
  ok "exists"
else
  run gh repo create "$FULL" "--$VISIBILITY" --description "$DESCRIPTION" --source . --remote origin --push
fi

# ------------------------------------------------------------------ settings and secrets
while IFS= read -r -u 3 entry; do apply_entry "$entry"; done 3< <(jq -c '.settings[]' "$SETTINGS")
secrets_step

# ------------------------------------------------------------------ manual steps
say "Done. Remaining manual steps (also in docs/SETUP.md):"
sed -n '/^## Manual steps/,$p' docs/SETUP.md | tail -n +2

#!/usr/bin/env bash
# PostToolUse hook: format the file Claude just edited with Biome. Never blocks (always exits 0).
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
file=$(jq -r '.tool_input.file_path // empty')
[[ -n "$file" && -f "$file" ]] || exit 0
root="${CLAUDE_PROJECT_DIR:-.}"

case "$file" in
  # Recorded output stays as it was written; Biome skips it too.
  *-results/*) ;;
  *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.jsonc)
    (cd "$root" && bun x biome check --write --no-errors-on-unmatched --files-ignore-unknown=true "$file") >/dev/null 2>&1
    ;;
esac
exit 0

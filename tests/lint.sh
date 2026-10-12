#!/bin/bash
# The lint: every shell script here through ShellCheck, plus the classes a linter cannot see, as greps,
# the same shape as cocoon-agent-sandbox's tests/lint.sh (the owner's rule, 2026-10-11: nothing unlinted,
# every class of mistake a rule the day it is found). Exit 1 on anything. `npm run lint` and the check run it.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
TOOLS=(
  shellcheck   # the linter; preinstalled on GitHub's runner and in the sandbox image
  grep
)
for tool in "${TOOLS[@]}"; do
  command -v "$tool" >/dev/null || { echo "lint: '$tool' is required" >&2; exit 1; }
done
echo "lint: shellcheck $(shellcheck --version | sed -n 's/^version: //p')"
scripts=(scripts/*.sh tests/*.sh)
fail=0
shellcheck "${scripts[@]}" || fail=1
# Our own classes, each with the date it was learned. This file is skipped: its patterns would match themselves.
for f in "${scripts[@]}"; do
  [ "$f" = tests/lint.sh ] && continue
  # 2026-10-11: a recursive delete on a variable path that can collapse to / (the sandbox's guardrail catch)
  if grep -nE 'rm -r[f]? +"?\$[A-Za-z_{][^:?}]*[/"]' "$f" | grep -vE '\$\{[A-Za-z_]+:\?' ; then echo "lint: $f: rm -r on a variable path without \${var:?}"; fail=1; fi
  # 2026-10-11: a file command whose first operand is a variable path with no -- before it, so a value
  # beginning with a dash would be read as an option (Izzy: mkdir -p -- "$dir"); the plain forms only
  # (options, a mode or an owner, then the quoted variable); an option that takes a value (stat -c,
  # tar -C) is outside it and is read by hand
  if grep -nE '(^|&&[[:space:]]*|;[[:space:]]*|\{[[:space:]]*|\|\|[[:space:]]*)[[:space:]]*(mkdir|rm|rmdir|chmod|chown|cp|mv|ln|touch|cat|cmp)( -[A-Za-z0-9]+| [0-7]{3,4}| [0-9]+:[0-9]+)* "\$' "$f"; then echo "lint: $f: a variable path as the first operand without -- before it"; fail=1; fi
  # 2026-10-02, 2026-10-08: a pipeline's status is its last command's; every script turns pipefail on in its first set line
  grep -qE '^set -[a-z]*o pipefail' "$f" || { echo "lint: $f: no 'set -...o pipefail' at the top"; fail=1; }
done
[ $fail -eq 0 ] && echo "lint: clean"
exit $fail

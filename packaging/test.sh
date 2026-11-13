#!/usr/bin/env bash
# Run the add-on test suite that works from this repository alone.
# Their tests resolve unchanged engine modules from the integration tree, so no
# EVEJS_ROOT checkout is needed; set EVEJS_ROOT to run against a full tree.
set -uo pipefail

DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DIR"

fail=0
count=0
for file in tests/*.cjs; do
  case "$file" in
    tests/engine-checkout.cjs) continue ;;
    tests/local-defense-*.test.cjs|tests/run-local-defense.cjs)
      # These resolve unchanged engine modules, which the repository does not
      # carry; they need a full EveJS checkout in EVEJS_ROOT.
      if [ -z "${EVEJS_ROOT:-}" ]; then
        echo "skip $file (set EVEJS_ROOT to run)"
        continue
      fi
      ;;
  esac
  count=$((count + 1))
  if output=$(node "$file" 2>&1); then
    echo "ok   $file"
  else
    echo "FAIL $file"
    printf '%s\n' "$output" | tail -20
    fail=1
  fi
done

echo "$count test file(s), suite $([ $fail -eq 0 ] && echo passed || echo failed)"
exit "$fail"

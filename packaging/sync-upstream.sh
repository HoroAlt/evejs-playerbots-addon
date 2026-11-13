#!/usr/bin/env bash
# Bring this fork up to the current upstream release.
#   1. fetch kroryan/main
#   2. rebase our dev branch onto it
#   3. push dev and mirror main to the fork
# Usage: packaging/sync-upstream.sh
set -euo pipefail

DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DIR"

git fetch origin
git switch dev
git rebase origin/main
git push --force-with-lease fork dev
git push fork origin/main:main

echo "upstream: $(git log --oneline -1 origin/main)"
echo "dev:      $(git log --oneline -1 dev)"

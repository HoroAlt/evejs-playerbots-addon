#!/usr/bin/env bash
# Apply the homelab patches to the base EveJS tree (files the add-on does not own).
# Usage: homelab/apply-base.sh /path/to/EveJS-261108.1
set -euo pipefail
TREE=${1:?usage: apply-base.sh /path/to/EveJS-tree}
DIR=$(cd -- "$(dirname -- "$0")" && pwd)

for patch_file in "$DIR"/base/*.patch; do
  if patch -p1 -d "$TREE" --dry-run --reverse --force <"$patch_file" >/dev/null 2>&1; then
    echo "already applied: $(basename "$patch_file")"
  else
    patch -p1 -d "$TREE" <"$patch_file"
  fi
done

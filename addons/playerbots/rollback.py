#!/usr/bin/env python3
"""Restore files saved by install.py without touching EveJS databases."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path


STATE_NAME = ".playerbots-install-state.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Roll back the latest playerbots add-on installation.")
    parser.add_argument("target", nargs="?", default=".", help="EveJS source directory (default: current directory)")
    args = parser.parse_args()
    target = Path(args.target).expanduser().resolve()
    state_path = target / STATE_NAME
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        backup = target / state["backupDirectory"]
        managed = state["managedFiles"]
        expected = state["installedSha256"]
        changed = [relative for relative in managed
                   if not (target / relative).is_file() or sha256(target / relative) != expected.get(relative)]
        if changed:
            raise RuntimeError("Installed files changed after setup; rollback refused to overwrite: " + ", ".join(changed[:12]))
        for relative in reversed(managed):
            destination = target / relative
            saved = backup / relative
            if saved.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(saved, destination)
            else:
                destination.unlink(missing_ok=True)
        created_directories = sorted(
            {(target / relative).parent for relative in managed},
            key=lambda directory: len(directory.parts),
            reverse=True,
        )
        for directory in created_directories:
            while directory != target and target in directory.parents:
                try:
                    directory.rmdir()
                except OSError:
                    break
                directory = directory.parent
        state_path.unlink()
        print(f"Playerbots add-on files restored from {backup}.")
        print("Database files were not read, written, moved, or deleted. Restart or stop services separately.")
        return 0
    except (OSError, json.JSONDecodeError, KeyError, RuntimeError) as error:
        print(f"Rollback stopped: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

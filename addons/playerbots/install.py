#!/usr/bin/env python3
"""Version-pinned installer for the EveJS playerbots add-on bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parent
INTEGRATION_ROOT = PACKAGE_ROOT / "integration" / "server"
ADDON_SOURCE = PACKAGE_ROOT / "addons" / "playerbots"
OVERRIDE_SOURCE = PACKAGE_ROOT / "compose.override.yaml"
STATE_NAME = ".playerbots-install-state.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest() -> dict:
    path = PACKAGE_ROOT / "integration" / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"The ZIP integration manifest is missing or invalid: {error}") from error


def check_version(target: Path, expected: str) -> None:
    for relative in ("package.json", "server/package.json"):
        path = target / relative
        try:
            actual = json.loads(path.read_text(encoding="utf-8")).get("version")
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Cannot read {relative}: {error}") from error
        if actual != expected:
            raise RuntimeError(f"Unsupported EveJS source version in {relative}: expected {expected}, found {actual!r}.")


def validate_target(target: Path, manifest: dict, replace_conflicts: bool = False) -> tuple[list[str], list[str]]:
    if not (target / "compose.yaml").is_file() or not (target / "docker/entrypoint.sh").is_file():
        raise RuntimeError(f"{target} is not an EveJS Docker Compose source tree.")
    check_version(target, str(manifest["evejsVersion"]))
    conflicts = []
    for relative, record in manifest["files"].items():
        source = INTEGRATION_ROOT / relative
        if not source.is_file():
            raise RuntimeError(f"The package integration source is missing: {relative}.")
        source_hash = sha256(source)
        if source_hash != record.get("sourceSha256") or source_hash != record.get("overlaySha256"):
            raise RuntimeError(f"The package source/overlay checksum failed: {relative}.")
        destination = target / relative
        if destination.exists():
            current = sha256(destination)
            if current not in {record.get("baseSha256"), record["overlaySha256"]}:
                conflicts.append(relative)
        elif record.get("baseSha256") is not None:
            conflicts.append(relative)
    if conflicts and not replace_conflicts:
        sample = ", ".join(conflicts[:8])
        more = "" if len(conflicts) <= 8 else f" and {len(conflicts) - 8} more"
        raise RuntimeError(
            "Source files differ from both the supported original and this add-on version: "
            f"{sample}{more}. No files were changed. To upgrade a previous customized Playerbots overlay, "
            "review the conflicts and rerun with --replace-conflicts; the installer will back up each file "
            "and the rollback tool can restore it."
        )
    return list(manifest["files"]), conflicts


def docker_compose(target: Path, *arguments: str, check: bool = True) -> subprocess.CompletedProcess:
    command = [
        "docker", "compose",
        "-f", str(target / "compose.yaml"),
        "-f", str(target / "addons/playerbots/compose.override.yaml"),
        *arguments,
    ]
    return subprocess.run(command, cwd=target, check=check)


def preflight_compose(target: Path, override: Path) -> None:
    command = [
        "docker", "compose",
        "-f", str(target / "compose.yaml"),
        "-f", str(override),
        "config", "--quiet",
    ]
    subprocess.run(command, cwd=target, check=True)


def update_env(path: Path) -> tuple[bool, bool, bool]:
    existed = path.exists()
    original_mode = path.stat().st_mode & 0o777 if existed else None
    lines = path.read_text(encoding="utf-8").splitlines() if existed else []
    keys = {
        "EVEJS_PLAYER_BOTS_ADDON_TOKEN",
        "EVEJS_PLAYER_BOTS_ADDON_MODE",
    }
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() in keys:
            values[key.strip()] = value.strip().strip("\"'")

    token = values.get("EVEJS_PLAYER_BOTS_ADDON_TOKEN", "")
    token_created = len(token) < 32
    if token_created:
        values["EVEJS_PLAYER_BOTS_ADDON_TOKEN"] = secrets.token_hex(32)
    mode_created = "EVEJS_PLAYER_BOTS_ADDON_MODE" not in values
    if mode_created:
        values["EVEJS_PLAYER_BOTS_ADDON_MODE"] = "auto"

    output = []
    emitted: set[str] = set()
    for line in lines:
        stripped = line.strip()
        key = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else ""
        if key == "EVEJS_PLAYER_BOTS_DASHBOARD_PASSWORD":
            continue
        if key in values:
            if key not in emitted:
                output.append(f"{key}={values[key]}")
                emitted.add(key)
        else:
            output.append(line)
    for key in keys:
        if key not in emitted:
            output.append(f"{key}={values[key]}")
    path.write_text("\n".join(output) + "\n", encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
    return token_created, mode_created


def install(target: Path, overlay_files: list[str]) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = target / f".playerbots-install-backup-{stamp}"
    backup.mkdir(mode=0o700)
    managed: list[str] = []
    existed: list[str] = []

    def copy_managed(source: Path, relative: str) -> None:
        destination = target / relative
        backup_path = backup / relative
        if destination.is_file():
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(destination, backup_path)
            existed.append(relative)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        managed.append(relative)

    try:
        for relative in overlay_files:
            copy_managed(INTEGRATION_ROOT / relative, relative)

        for source in sorted(ADDON_SOURCE.rglob("*")):
            if not source.is_file() or "__pycache__" in source.parts or source.suffix == ".pyc":
                continue
            relative = source.relative_to(PACKAGE_ROOT).as_posix()
            if relative in {
                "addons/playerbots/install.sh",
                "addons/playerbots/install.py",
                "addons/playerbots/rollback.py",
                "addons/playerbots/compose.override.yaml",
            }:
                continue
            copy_managed(source, relative)
        copy_managed(OVERRIDE_SOURCE, "addons/playerbots/compose.override.yaml")

        env_path = target / ".env"
        env_existed = env_path.is_file()
        if env_existed:
            shutil.copy2(env_path, backup / ".env")
            existed.append(".env")
        token_created, mode_created = update_env(env_path)
        managed.append(".env")

        state = {
            "installedAt": datetime.now(timezone.utc).isoformat(),
            "backupDirectory": backup.name,
            "managedFiles": managed,
            "installedSha256": {relative: sha256(target / relative) for relative in managed},
            "preExistingFiles": existed,
            "envExisted": env_existed,
            "tokenCreated": token_created,
            "modeCreated": mode_created,
        }
        state_path = target / STATE_NAME
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        if os.name != "nt":
            state_path.chmod(0o600)

        docker_compose(target, "config", "--quiet")
        return backup
    except Exception:
        for relative in reversed(managed):
            destination = target / relative
            saved = backup / relative
            if saved.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(saved, destination)
            elif destination.is_file():
                destination.unlink()
        state_path = target / STATE_NAME
        if state_path.is_file():
            state_path.unlink()
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the standalone EveJS playerbots add-on.")
    parser.add_argument("target", nargs="?", default=".", help="EveJS source directory (default: current directory)")
    parser.add_argument("--dry-run", action="store_true", help="check source compatibility and Compose configuration without writing files")
    parser.add_argument(
        "--replace-conflicts",
        action="store_true",
        help="replace modified managed server files after backing them up (for reviewed add-on upgrades)",
    )
    parser.add_argument("--start", action="store_true", help="after installation, build the EveJS image and start only server and playerbots-addon")
    arguments = parser.parse_args()

    target = Path(arguments.target).expanduser().resolve()
    try:
        manifest = load_manifest()
        overlay_files, conflicts = validate_target(target, manifest, arguments.replace_conflicts)
        if arguments.dry_run:
            preflight_compose(target, OVERRIDE_SOURCE)
            note = f"; {len(conflicts)} modified managed files will be backed up and replaced" if conflicts else ""
            print(f"Dry run passed for EveJS {manifest['evejsVersion']} at {target}{note}; no files were changed.")
            return 0

        backup = install(target, overlay_files)
        print(f"Playerbots add-on installed for EveJS {manifest['evejsVersion']}.")
        if conflicts:
            print(f"Replaced {len(conflicts)} modified managed server files after saving them in the backup.")
        print(f"Source backups: {backup}")
        print("No database files were read, written, moved, or deleted.")
        print("Server and add-on processes were not started.")
        if arguments.start:
            docker_compose(target, "build", "init")
            docker_compose(target, "up", "-d", "--no-deps", "server", "playerbots-addon")
            print("Started only the server and playerbots-addon services; Market was left untouched.")
        else:
            print("Start manually with the commands in OPERATIONS.md when the EveJS Market service is healthy.")
        return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError, KeyError) as error:
        print(f"Installation stopped: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

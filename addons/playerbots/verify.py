#!/usr/bin/env python3
"""Read-only check of a playerbots add-on installation, reported by subsystem."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parent
STATE_NAME = ".playerbots-install-state.json"
# Keep in step with tools/playerbots/build-addon-package.py.
SUBSYSTEM_PREFIXES = (
    ("server/src/services/playerbots/", "playerbots-core"),
    ("server/src/services/scheduler/", "scheduler"),
    ("server/src/services/market/", "economy-authorities"),
    ("server/src/services/account/", "economy-authorities"),
    ("server/src/services/contracts/", "economy-authorities"),
    ("server/src/services/corporation/", "corporation-sovereignty-structures"),
    ("server/src/services/sovereignty/", "corporation-sovereignty-structures"),
    ("server/src/services/structure/", "corporation-sovereignty-structures"),
    ("server/src/services/chat/", "chat-commands"),
    ("server/src/services/dungeon/", "dungeon"),
    ("server/src/services/planet/", "planetary"),
    ("server/src/services/fleets/", "fleets"),
    ("server/src/space/", "space-runtime"),
    ("server/src/gameStore/", "gamestore"),
    ("server/assets/fittings/", "fittings"),
    ("server/src/_secondary/fitting/", "fittings"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def subsystem_for(relative: str) -> str:
    for prefix, name in SUBSYSTEM_PREFIXES:
        if relative.startswith(prefix):
            return name
    return "platform"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def version_at(path: Path) -> str | None:
    try:
        return str(read_json(path).get("version", "")) or None
    except (OSError, json.JSONDecodeError):
        return None


def overlay_status(target: Path, relative: str, record: dict) -> str:
    destination = target / relative
    if not destination.is_file():
        return "missing"
    current = sha256(destination)
    if current == record.get("overlaySha256"):
        return "installed"
    base = record.get("baseSha256")
    if base is not None and current == base:
        return "original"
    return "modified" if base is not None else "unexpected-present"


def token_status(env_path: Path) -> str:
    if not env_path.is_file():
        return "no .env file"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return "unreadable .env file"
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("EVEJS_PLAYER_BOTS_ADDON_TOKEN="):
            value = stripped.split("=", 1)[1].strip().strip("\"'")
            return "present (32 or more characters)" if len(value) >= 32 else "too short"
    return "missing"


def install_state(target: Path) -> dict:
    path = target / STATE_NAME
    if not path.is_file():
        return {"present": False}
    try:
        state = read_json(path)
        managed = [relative for relative in state.get("managedFiles", []) if relative != ".env"]
        expected = state.get("installedSha256", {})
        unchanged = sum(1 for relative in managed
                        if (target / relative).is_file() and sha256(target / relative) == expected.get(relative))
        return {
            "present": True,
            "installedAt": state.get("installedAt"),
            "managedFiles": len(managed),
            "unchangedSinceInstall": unchanged,
            "rollbackAvailable": unchanged == len(managed) and (target / str(state.get("backupDirectory", ""))).is_dir(),
        }
    except (OSError, json.JSONDecodeError, AttributeError, TypeError):
        return {"present": True, "error": "install state file is unreadable"}


def verify(target: Path, only_subsystem: str | None = None) -> dict:
    manifest = read_json(PACKAGE_ROOT / "integration" / "manifest.json")
    package = read_json(PACKAGE_ROOT / "manifest.json")
    files: dict[str, dict] = {}
    subsystems: dict[str, dict] = {}
    for relative, record in sorted(manifest["files"].items()):
        name = record.get("subsystem") or subsystem_for(relative)
        if only_subsystem and name != only_subsystem:
            continue
        status = overlay_status(target, relative, record)
        files[relative] = {"subsystem": name, "status": status, "newInThisAddon": record.get("baseSha256") is None}
        counts = subsystems.setdefault(name, {"files": 0, "installed": 0})
        counts["files"] += 1
        counts["installed"] += 1 if status == "installed" else 0

    addon: dict[str, str] = {}
    if not only_subsystem or only_subsystem == "addon-process":
        for relative, expected in sorted((manifest.get("addonFiles") or {}).items()):
            destination = target / relative
            status = "missing" if not destination.is_file() else "installed" if sha256(destination) == expected else "modified"
            addon[relative] = status
        if addon:
            subsystems["addon-process"] = {
                "files": len(addon),
                "installed": sum(1 for status in addon.values() if status == "installed"),
            }

    statuses = [entry["status"] for entry in files.values()] + list(addon.values())
    target_versions = {
        "package.json": version_at(target / "package.json"),
        "server/package.json": version_at(target / "server/package.json"),
    }
    version_matches = all(value == manifest["evejsVersion"] for value in target_versions.values())
    untouched = bool(files) and all(
        entry["status"] == "original" or (entry["newInThisAddon"] and entry["status"] == "missing")
        for entry in files.values()
    ) and all(status == "missing" for status in addon.values())
    if statuses and all(status == "installed" for status in statuses) and version_matches:
        result = "ok"
    elif untouched:
        result = "not-installed"
    else:
        result = "drift"
    return {
        "addonVersion": package.get("version"),
        "evejsVersion": manifest["evejsVersion"],
        "manifestSchemaVersion": manifest.get("schemaVersion"),
        "targetVersions": target_versions,
        "targetVersionMatches": version_matches,
        "installedAddonVersion": version_at(target / "addons/playerbots/manifest.json"),
        "subsystems": subsystems,
        "files": files,
        "addon": addon,
        "state": install_state(target),
        "token": token_status(target / ".env"),
        "result": result,
    }


def print_report(report: dict, strict: bool) -> None:
    print(f"Playerbots add-on {report['addonVersion']} for EveJS {report['evejsVersion']}")
    versions = ", ".join(f"{name}={value or 'unreadable'}" for name, value in report["targetVersions"].items())
    print(f"Target EveJS version: {versions}" + ("" if report["targetVersionMatches"] else "  <-- does not match"))
    print(f"Installed add-on version: {report['installedAddonVersion'] or 'not installed'}")
    width = max((len(name) for name in report["subsystems"]), default=10)
    for name, counts in sorted(report["subsystems"].items()):
        marker = "ok" if counts["installed"] == counts["files"] else "CHECK"
        print(f"  {name.ljust(width)}  {counts['installed']}/{counts['files']} installed  {marker}")
    problems = [(relative, entry["status"]) for relative, entry in report["files"].items() if entry["status"] != "installed"]
    problems += [(relative, status) for relative, status in report["addon"].items() if status != "installed"]
    if problems and report["result"] != "not-installed":
        print("Files that do not match this release:")
        for relative, status in problems[:60]:
            print(f"  {status:<19} {relative}")
        if len(problems) > 60:
            print(f"  ... and {len(problems) - 60} more")
    state = report["state"]
    if state.get("present") and "error" not in state:
        print(f"Install state: {state['unchangedSinceInstall']}/{state['managedFiles']} managed files unchanged since "
              f"{state['installedAt']}; rollback {'available' if state['rollbackAvailable'] else 'not available'}")
    else:
        print(f"Install state: {state.get('error', 'no install state file')}")
    print(f"Add-on API token in .env: {report['token']}")
    summary = {
        "ok": "Result: every guarded file matches this release.",
        "not-installed": "Result: the target is the unmodified supported EveJS source; the add-on is not installed."
        + (" (--strict treats this as drift.)" if strict else ""),
        "drift": "Result: the target differs from this release. Reinstall with install.py or review the listed files.",
    }
    print(summary[report["result"]])


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a playerbots add-on installation without changing anything.")
    parser.add_argument("target", nargs="?", default=".", help="EveJS source directory (default: current directory)")
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    parser.add_argument("--strict", action="store_true", help="treat an uninstalled target as a failure")
    parser.add_argument("--subsystem", help="check only one subsystem")
    arguments = parser.parse_args()
    target = Path(arguments.target).expanduser().resolve()
    if not (target / "server").is_dir():
        print(f"Verification stopped: {target} is not an EveJS source tree.", file=sys.stderr)
        return 2
    try:
        report = verify(target, arguments.subsystem)
    except (OSError, json.JSONDecodeError, KeyError) as error:
        print(f"Verification stopped: {error}", file=sys.stderr)
        return 2
    if arguments.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report, arguments.strict)
    if report["result"] == "ok":
        return 0
    if report["result"] == "not-installed":
        return 1 if arguments.strict else 3
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

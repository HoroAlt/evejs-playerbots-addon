#!/usr/bin/env python3
"""Build a local release ZIP from the upstream release plus our integration files.

The upstream build tool expects a full EveJS working tree at the repository
root; this repo only carries the published ``integration/`` layout. So the
stock release ZIP is the base and every file under ``integration/server`` is
overlayed on top of it, with the manifest hashes recomputed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "integration" / "server"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_state() -> str:
    """Commit and dirty flag, so a built ZIP can be traced back to the tree."""
    try:
        import subprocess

        head = subprocess.check_output(["git", "rev-parse", "--short=12", "HEAD"], cwd=ROOT, text=True).strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"],
                               cwd=ROOT, capture_output=True, text=True).stdout.strip()
        return f"{head}{'-dirty' if dirty else ''}"
    except Exception:
        return ""


def write_version(path: Path, version: str) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    version = (ROOT / "packaging" / "VERSION").read_text().strip()
    parser.add_argument("--version", default=version,
                        help="release version, e.g. 0.2.145-local.1")
    parser.add_argument("--base-version", default=version.split("-")[0],
                        help="upstream release version to overlay (defaults to the VERSION prefix)")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    expected_base = version.split("-")[0]
    if args.base_version != expected_base:
        raise SystemExit(
            f"base version {args.base_version} does not match packaging/VERSION ({version}); "
            f"rebuild the integration tree on {expected_base} first"
        )

    base_zip = ROOT / "dist" / f"evejs-playerbots-addon-v{args.base_version}.zip"
    if not base_zip.is_file():
        raise SystemExit(f"missing stock release: {base_zip}")
    output = Path(args.output or ROOT / "dist" / f"evejs-playerbots-addon-v{args.version}.zip").resolve()
    stage_name = f"EveJS-Playerbots-Addon-v{args.version}"

    with tempfile.TemporaryDirectory(prefix="overlay-build-") as temporary:
        temporary_path = Path(temporary)
        with zipfile.ZipFile(base_zip) as archive:
            archive.extractall(temporary_path)
        extracted = temporary_path / f"EveJS-Playerbots-Addon-v{args.base_version}"
        if not extracted.is_dir():
            raise SystemExit(f"unexpected release layout in {base_zip}")
        stage = temporary_path / stage_name
        extracted.rename(stage)

        manifest_path = stage / "integration" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != 3:
            raise SystemExit(
                f"unexpected manifest schema {manifest.get('schemaVersion')}; "
                "this builder only understands schema 3"
            )
        changed = []
        for source in sorted(INTEGRATION.rglob("*")):
            if not source.is_file():
                continue
            relative = source.relative_to(INTEGRATION).as_posix()
            record = manifest["files"].get(relative)
            if record is None:
                raise SystemExit(f"{relative} is not a managed file of release {args.base_version}")
            destination = stage / "integration" / "server" / relative
            if destination.is_file() and sha256(destination) == sha256(source):
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            digest = sha256(destination)
            record["sourceSha256"] = digest
            record["overlaySha256"] = digest
            changed.append(relative)

        write_version(stage / "manifest.json", args.version)
        addon_manifest = stage / "addons" / "playerbots" / "manifest.json"
        write_version(addon_manifest, args.version)
        # The add-on manifest is version-stamped above, so its hash in the
        # integration manifest has to follow or verify.py reports a false diff.
        addon_manifest_key = "addons/playerbots/manifest.json"
        if addon_manifest_key in manifest.get("addonFiles", {}):
            manifest["addonFiles"][addon_manifest_key] = sha256(addon_manifest)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    archive.write(path, (Path(stage_name) / path.relative_to(stage)).as_posix())

    print(f"{output} ({output.stat().st_size:,} bytes), {len(changed)} overlay files:")
    for relative in changed:
        print(f"  {relative}")
    provenance = git_state()
    if provenance:
        Path(f"{output}.commit").write_text(provenance + "\n", encoding="utf-8")
        print(f"  commit {provenance}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build the version-pinned standalone playerbots ZIP for EveJS 261108.1."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION = "0.2.137"
EVEJS_VERSION = "261108.1"
PACKAGE_NAME = f"EveJS-Playerbots-Addon-v{VERSION}"
OUTPUT = ROOT / "dist" / f"evejs-playerbots-addon-v{VERSION}.zip"
EXTERNAL_OVERLAY_LIST = ROOT / "tools/playerbots/addon-overlay-files.txt"
ADDON_SOURCE = ROOT / "addons/playerbots"
INTEGRATION_SOURCE = ROOT / "integration/server"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version_at(root: Path, relative: str) -> str:
    return str(json.loads((root / relative).read_text(encoding="utf-8")).get("version", ""))


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--compat-root",
        required=True,
        help="path to the original EveJS 261108.1 source tree used to generate base hashes",
    )
    parser.add_argument("--output", default=str(OUTPUT), help="output ZIP path")
    args = parser.parse_args()
    compat_root = Path(args.compat_root).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()

    addon_version = str(json.loads((ADDON_SOURCE / "manifest.json").read_text(encoding="utf-8")).get("version", ""))
    if addon_version != VERSION:
        raise SystemExit(f"Add-on source must be version {VERSION}, found {addon_version!r}.")
    if version_at(compat_root, "package.json") != EVEJS_VERSION or version_at(compat_root, "server/package.json") != EVEJS_VERSION:
        raise SystemExit(f"Compatibility source must be EveJS {EVEJS_VERSION}: {compat_root}")

    external = [line.strip() for line in EXTERNAL_OVERLAY_LIST.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.lstrip().startswith("#")]
    playerbot_files = sorted(path.relative_to(INTEGRATION_SOURCE).as_posix()
                             for path in (INTEGRATION_SOURCE / "server/src/services/playerbots").rglob("*.js"))
    overlay_files = sorted(set(external + playerbot_files))
    records = {}
    for relative in overlay_files:
        current = INTEGRATION_SOURCE / relative
        original = compat_root / relative
        if not current.is_file():
            raise SystemExit(f"Current integration file is missing: {relative}")
        records[relative] = {
            "baseSha256": sha256(original) if original.is_file() else None,
            "sourceSha256": sha256(current),
            "overlaySha256": sha256(current),
        }

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="evejs-playerbots-package-") as temporary:
        stage = Path(temporary) / PACKAGE_NAME
        (stage / "integration/server").mkdir(parents=True)
        for relative in overlay_files:
            copy_file(INTEGRATION_SOURCE / relative, stage / "integration/server" / relative)

        for source in sorted(ADDON_SOURCE.rglob("*")):
            if not source.is_file() or "__pycache__" in source.parts or source.suffix == ".pyc":
                continue
            relative = source.relative_to(ADDON_SOURCE).as_posix()
            if relative in {"install.sh", "install.py", "rollback.py"}:
                continue
            copy_file(source, stage / "addons/playerbots" / relative)

        copy_file(ADDON_SOURCE / "install.py", stage / "install.py")
        copy_file(ADDON_SOURCE / "rollback.py", stage / "rollback.py")
        copy_file(ROOT / "addons/playerbots/compose.override.yaml", stage / "compose.override.yaml")
        copy_file(ADDON_SOURCE / "README.md", stage / "README.md")
        for name in ("INSTALLATION.md", "OPERATIONS.md", "TROUBLESHOOTING.md", "GUIDE.md", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            copy_file(ADDON_SOURCE / name, stage / name)
        copy_file(ROOT / "doc/COMMUNITY_FITTINGS.md", stage / "COMMUNITY_FITTINGS.md")
        copy_file(ROOT / "doc/PLAYERBOTS_CAPACITY_MODEL.md", stage / "PLAYERBOTS_CAPACITY_MODEL.md")
        copy_file(ROOT / "doc/PLAYERBOTS_ROADMAP.md", stage / "PLAYERBOTS_ROADMAP.md")
        (stage / "install.sh").write_text(
            "#!/usr/bin/env bash\nset -Eeuo pipefail\n"
            "PACKAGE_DIR=\"$(cd -- \"$(dirname -- \"${BASH_SOURCE[0]}\")\" && pwd)\"\n"
            "exec python3 \"${PACKAGE_DIR}/install.py\" \"$@\"\n",
            encoding="utf-8",
        )
        (stage / "install.sh").chmod(0o755)
        (stage / "manifest.json").write_text(json.dumps({
            "id": "evejs.playerbots",
            "name": "EveJS Playerbots Add-on",
            "version": VERSION,
            "evejsVersion": EVEJS_VERSION,
            "apiVersion": 1,
            "runtime": "node >= 24",
            "process": "standalone",
            "sourceOverlay": "integration/manifest.json",
        }, indent=2) + "\n", encoding="utf-8")
        (stage / "integration/manifest.json").write_text(json.dumps({
            "schemaVersion": 2,
            "evejsVersion": EVEJS_VERSION,
            "files": records,
        }, indent=2) + "\n", encoding="utf-8")

        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    archive.write(path, (Path(PACKAGE_NAME) / path.relative_to(stage)).as_posix())

    print(f"Created {output} ({output.stat().st_size:,} bytes, {len(overlay_files)} guarded source files).")
    print(f"Compatibility base: EveJS {EVEJS_VERSION} at {compat_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

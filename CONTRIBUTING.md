# Maintaining this add-on

This repository contains the Playerbots add-on, its installer, the hash-guarded EveJS integration files required by it, and its release ZIP. It does not contain the EveJS server source tree. The selected files under `integration/server/` are add-on overlays applied by the guarded installer.

The ZIP under `dist/` is the standard install and redistribution artifact. Keep its version synchronized with `addons/playerbots/manifest.json` and `tools/playerbots/build-addon-package.py`. Build against the supported original EveJS checkout with:

```sh
python3 tools/playerbots/build-addon-package.py --compat-root "/path/to/EveJS-261108.1"
```

Installation, verification (`verify.py`) and rollback instructions are in `INSTALLATION.md`; operator commands are in `GUIDE.md` and `OPERATIONS.md`. Tests that require EveJS runtime services must run from a compatible EveJS checkout after applying the add-on overlay.

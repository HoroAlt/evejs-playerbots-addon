# Installation

## Requirements

- An EveJS source checkout at version `261108.1`.
- Docker Engine and the Docker Compose v2 plugin.
- Python 3.10 or newer.
- For an existing deployment, its initialized game database and healthy EveJS
  Market service before starting the playerbot add-on.
- Linux/macOS shell for `install.sh`, or Python for Windows PowerShell.

The archive supports the original EveJS `261108.1` source tree at any local
path. It does not target arbitrary EveJS releases. The installer checks both
`package.json` version fields and hashes of every server file it manages. Keep
using the versioned ZIP as the standard installation artifact even though the
editable source is also in Git.
`GUIDE.md` in the archive documents every playerbot chat command and how to
change the roster target.

## Recommended setup for a new EveJS installation

For a new server, use a clean EveJS `261108.1` checkout with no pre-existing
GameStore or Market database. The installer can run before database
initialization: it prepares source files and `.env` only. Follow EveJS's normal
first-run setup in `doc/SETUP.md`, including its `init` image build, then build
the standard Jita-only starter market:

```sh
docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_only
```

That market rebuild replaces market contents, so use it only for a new or
deliberately disposable Market database. The Playerbots Add-on does not seed
Jita or create market orders; EveJS's market tools do that. Start Market and
wait for it to become healthy before starting EveJS and the add-on. A fresh
add-on installation gradually seeds a 500-bot roster by default, in bounded
batches with EveJS load checks. Before the first batch, the server gathers two
five-second load samples. Hard seeding limits are 10 pilots per batch, 250 ms
event-loop p95, 95% EveJS process CPU, and 1,000 ms for one pilot creation;
neither environment settings nor saved dashboard values can raise these caps.
Existing installations keep their databases and saved dashboard settings;
installation never resets, moves, or reseeds them.

## Install from the release ZIP

Extract `evejs-playerbots-addon-v0.2.144.zip`. In a terminal, pass the EveJS
source directory as the single positional argument:

```sh
cd EveJS-Playerbots-Addon-v0.2.144
EVEJS_SOURCE="/path/to/your EveJS checkout"
./install.sh "$EVEJS_SOURCE"
```

Replace the example value with the checkout's actual path. Keep the quotes so
paths containing spaces are passed as one argument.

The installer is staged by default: it checks compatibility, makes a backup,
installs the server integration and add-on source, writes a private token to
`.env`, and validates the combined Compose configuration. It does not start
containers or touch database files.

If a previous manual Playerbots deployment changed managed EveJS files, the
default installer stops when their hashes do not match the supported EveJS
source or this release. After reviewing those conflicts, upgrade with:

```sh
./install.sh --replace-conflicts "$EVEJS_SOURCE"
```

That option saves every replaced source file in the timestamped install backup;
`rollback.py` can restore them if the installed files have not changed since.
It does not permit changes to unmanaged files and does not touch databases.

Run a read-only compatibility check first with:

```sh
./install.sh --dry-run "$EVEJS_SOURCE"
```

To perform the same install and then build/start the EveJS server and add-on:

```sh
./install.sh --start "$EVEJS_SOURCE"
```

The installation step itself never creates bots. The `--start` option assumes
that Market is already running and healthy. It
builds the `init` image target (the Compose file's image build target), then
starts only `server` and `playerbots-addon` with `--no-deps`. It never starts,
stops, or rebuilds Market. If Market is not running, install without `--start`,
start the existing Market service with your normal EveJS procedure, then follow
`OPERATIONS.md`.

When `--start` is used, gradual seeding starts only after EveJS has produced
two load samples. Each batch is limited to ten pilots and yields between
creations. Seeding pauses automatically above the hard load or per-pilot
creation caps, including when old saved settings request looser thresholds.

### Windows PowerShell

From the extracted directory, run:

```powershell
$EveJsSource = Read-Host 'Enter the path to your EveJS 261108.1 source checkout'
python .\install.py --dry-run "$EveJsSource"
python .\install.py "$EveJsSource"
```

The source path is supplied by the operator and may contain spaces. The
installer does not assume a fixed checkout directory or drive letter.

Use `--start` only when the existing EveJS Market service is already healthy.
No Linux-only shell features are required by `install.py`.

## Verify an installation

`verify.py` compares an EveJS source tree with this release and reports the
result by subsystem. It only reads files: it does not start Docker, change the
source tree, or open a database.

```sh
python3 verify.py "$EVEJS_SOURCE"
```

| Exit code | Meaning |
| --- | --- |
| `0` | Every guarded file and add-on file matches this release. |
| `1` | At least one file is missing or differs. The report lists each one. |
| `3` | The tree is the unmodified supported EveJS source; the add-on is not installed. |
| `2` | The path is not an EveJS source tree, or the package manifest is unreadable. |

Add `--strict` to treat an uninstalled tree as a failure, `--json` for a
machine-readable report, or `--subsystem playerbots-core` to check one
subsystem. The report states only whether the add-on API token is present; it
never prints the token.

## What the installer changes

The installer overlays the server source files listed in
`integration/manifest.json`, places the standalone driver in
`addons/playerbots`, installs `addons/playerbots/compose.override.yaml`, and
writes or preserves these `.env` values:

- `EVEJS_PLAYER_BOTS_ADDON_TOKEN`: a random 64-character hexadecimal token.
- `EVEJS_PLAYER_BOTS_ADDON_MODE=auto`: written only if this setting is absent.

The Compose overlay gives the EveJS health probe a 20-second Docker timeout so
the default 15-second game and gateway probes do not fail spuriously while a
large roster is loading. It allows up to 120 seconds for EveJS to flush state
on an orderly container stop. The same overlay sets the optional
`EVEJS_PLAYER_BOTS_WAR_TEST_CORPORATION_ID` to empty unless an operator
explicitly sets it for a human-CEO corporation war test. It supplies these
population defaults when the corresponding `.env` variables are absent: roster
target 1,000, gradual seeding
enabled, roster ceiling 1,500, online limit 300, 30 autonomous bots per solar
system, and an eight-hour connection
rotation. The code hard limits are 15,000 persistent pilots and 5,000 online
sessions. Existing `.env` values and saved dashboard settings take precedence.

An existing token with at least 32 characters is kept. An explicit existing
mode, including `disabled`, is respected. All other `.env` entries are
preserved; the obsolete `EVEJS_PLAYER_BOTS_DASHBOARD_PASSWORD` entry is
removed because the dashboard does not use login authentication. Settings updates are limited to the same-origin JSON settings endpoint; the private bearer token remains inside the Compose network.
On Linux, `.env` permissions are set to `0600`.

The integration overlay includes the public FitALL catalog at
`server/assets/fittings/fitall.json` and the fitting service that exposes it.
The catalog is installed from the ZIP; the installer does not need the original
download folder or run any of its scripts. See `COMMUNITY_FITTINGS.md` in the
archive for the public owner and fitting protocol details.

Every source file replaced by the integration overlay is copied to a
timestamped `.playerbots-install-backup-*` folder. If preflight checks fail,
the installer restores files changed during that attempt.

## Manual Compose configuration

If you are integrating this archive through your own deployment automation,
apply the guarded source overlay using the manifest rules, install the runtime
files under `addons/playerbots`, then use both Compose files:

```sh
docker compose \
  -f compose.yaml \
  -f addons/playerbots/compose.override.yaml \
  config --quiet
```

Do not publish port `26004` on the host. It is only for server-to-add-on
traffic on the internal Compose network. The dashboard port is `8080` and is
bound to `0.0.0.0`. The dashboard does not require login. It provides paginated operation history and a same-origin settings form. Official killboard ship renders require outbound HTTPS from the add-on host to `images.evetech.net`. See
`OPERATIONS.md` for direct and SSH-tunnel access.

## Roll back

Stop the add-on and server first, then run:

```sh
python3 rollback.py "$EVEJS_SOURCE"
```

The rollback tool restores only the files changed by the latest installer run.
It refuses to overwrite a file that has changed since installation. It leaves
the timestamped backup directory in place and does not touch database files.
After rollback, restart the server only if you want to resume the previous
installation. See `OPERATIONS.md` for the exact Compose commands.

On Windows PowerShell, run the Python rollback entrypoint with the same source
path variable:

```powershell
python .\rollback.py "$EveJsSource"
```

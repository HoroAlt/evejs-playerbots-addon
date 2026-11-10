# Playerbots add-on process

## What runs where

`playerbots-addon` is a separate Docker Compose service and Node process. It owns the periodic roster loop, runs one fleet-wide preparation pass, then submits different pilots concurrently to EveJS. The default worker limit is 16 concurrent pilots (configurable from 1 to 100). This keeps a large director pass from becoming one long serial request in the game server's event loop while moving the roster through work promptly.

EveJS remains the authority for wallet transfers, market orders, inventory, PI networks, ship and location state, and the durable operation steps. The add-on has no database mount or database credentials. The internal API uses a bearer token, shares only the private Compose network, and is not mapped to a host port. The durable scheduler still owns short navigation and active-operation step jobs.

This is the first process boundary for the playerbots system. The server still
performs each atomic game mutation because those services own the world state;
the add-on moves the periodic director and roster orchestration out of the
game process. The add-on also serves a public, read-only operations dashboard
on port 8080 and responds to incoming ship damage through durable immediate
operation wakeups. Combat pilots engage only a legally attackable, weaker
threat when their live fit is healthy; otherwise they evacuate, and miners
pause while a qualified escort responds.

## Source and release artifact

The current public test package is `0.2.138`. The versioned ZIP in `dist/` is
the standard artifact to install and redistribute; commit it with matching
source and documentation. The source checkout alone is not the installation
artifact.

The ZIP targets EveJS `261108.1` and includes its guarded server integration,
standalone process, installer, static data, and public FitALL community
fittings. It is built and validated against the supported original EveJS
source tree. The documented roadmap lists current implementation status and
remaining live acceptance gates.

## Install

The distributable archive is `dist/evejs-playerbots-addon-v0.2.138.zip`. Extract it and run:

```sh
EVEJS_SOURCE="/path/to/your EveJS checkout"
./install.sh "$EVEJS_SOURCE"
```

Replace the example value with the checkout's actual path. The installer
supports arbitrary source paths, including paths with spaces.

The installer is staged by default: it checks the EveJS version and managed
source hashes, backs up replaced source, installs the server integration,
creates or preserves the add-on API token, and validates Compose. It does not
start services or touch databases. The overlay also installs the 5,353 public
FitALL community ship fittings into the original source tree.
See [Community Fittings](COMMUNITY_FITTINGS.md) for the catalog and public
read-only fitting endpoint.

To install and start, pass `--start` only after the existing Market service is
healthy:

```sh
./install.sh --start "$EVEJS_SOURCE"
```

The default `EVEJS_PLAYER_BOTS_ADDON_MODE=auto` uses the add-on when the token is valid. With no token, EveJS retains its built-in periodic loop. To return to that loop, stop `playerbots-addon`, set `EVEJS_PLAYER_BOTS_ADDON_MODE=disabled`, and restart `server`.

For new users, the recommended setup is a clean EveJS `261108.1` checkout with
no existing GameStore or Market database. Install the add-on before first-run
initialization, then follow EveJS's normal setup and seed its Jita market with
the market tools. The add-on seeds player characters, not market stock. A fresh
install gradually seeds 500 bots by default; existing databases and saved
settings are preserved and never reset by the installer.

## Operations and configuration

```sh
docker compose ps server playerbots-addon
docker compose logs -f playerbots-addon
```

`EVEJS_PLAYER_BOTS_ADDON_INTERVAL_MS` controls the delay after a full roster pass (default 300000 ms). `EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY` controls simultaneous pilot requests (default 16, maximum 100). `EVEJS_PLAYER_BOTS_ADDON_BOT_DELAY_MS` controls the optional yield between bot requests (default 0 ms). The add-on resumes an interrupted in-memory cycle while the API remains available; durable game tasks remain in the existing GameStore.

Run `python3 verify.py "$EVEJS_SOURCE"` from the extracted archive to check an installed tree against the release; it only reads files. The dashboard's Performance page and `GET /v1/dashboard/telemetry` report event-loop delay, CPU, memory, garbage collection, scheduled work, and time per subsystem.

The add-on ZIP contains its own README, manifest, installer, verifier, and runtime. It is versioned in Git for redistribution. No database reset or migration is part of installation.

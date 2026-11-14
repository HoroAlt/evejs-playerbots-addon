# EveJS Playerbots Add-on

The Playerbots Add-on runs EveJS's autonomous playerbot director as a separate
Node.js process. The game server remains authoritative for characters,
corporations, wallets, market orders, inventory, planetary colonies, ships,
contracts, sovereignty, and movement. The add-on talks to a private HTTP API
inside the Docker network and has no database connection. Its dashboard is served without login on host port 8080, bound to `0.0.0.0`.

This release targets the original EveJS source version `261108.1`. The ZIP
contains the standalone add-on process and a version-pinned integration overlay
that adapts it to that EveJS release, including its current war, fleet, combat,
structure, career, inventory, and scheduler paths. The installer accepts the
supported source checkout at any path. Installing only `index.js` will not
work on the original tree.

## Distribution contract

The repository is the editable source; the versioned ZIP in `dist/` is the
standard installation and redistribution artifact. Every playerbots release
must include that ZIP in Git alongside the source changes. Build it with
`tools/playerbots/build-addon-package.py` and pass the local path of the
supported EveJS checkout explicitly, for example:

```sh
EVEJS_COMPAT_ROOT="/path/to/your EveJS 261108.1 checkout"
python tools/playerbots/build-addon-package.py --compat-root "$EVEJS_COMPAT_ROOT"
```

Validate the resulting ZIP before distribution. Do not describe a source-only
commit as an installable release.

## Package contents

- `addons/playerbots/index.js`: standalone roster-cycle driver.
- `addons/playerbots/dashboard-server.js` and `dashboard/`: unauthenticated,
  operations dashboard, operation archive, editable runtime settings, and static assets, served by the add-on
  process on container port 8080. Pilot and killboard tables load portraits
  through a same-origin proxy to EveJS's image service.
- `addons/playerbots/compose.override.yaml`: private sidecar service and API
  settings for Docker Compose.
- `addons/playerbots/GUIDE.md`: English command reference, roster sizing, and
  operator workflows.
- `integration/server/`: the exact server source files needed by this release.
- The guarded universe-site runtime also memoizes content hashes for immutable
  dungeon templates, avoiding repeated deep copies while the system-wide site
  reconciler seeds anomalies and exploration sites.
- Task-queue reads share the cached map; a write copies the map once and only
  clones task records it changes. Retained history is not JSON-cloned per update.
- `integration/manifest.json`: supported EveJS version and SHA-256 guards for
  the original source and the overlay.
- `integration/server/server/assets/fittings/fitall.json`: the bundled public
  FitALL community fitting catalog; the installer adds it to EveJS along with
  the fitting service integration.
- `install.py`, `install.sh`, and `rollback.py`: guarded installer and rollback
  tools.
- `INSTALLATION.md`, `OPERATIONS.md`, `TROUBLESHOOTING.md`, and `GUIDE.md`:
  installation, service, recovery, and command instructions.
- `COMMUNITY_FITTINGS.md`: public FitALL catalog, fitting IDs, and server
  fitting endpoint details.
- `PLAYERBOTS_CAPACITY_MODEL.md`: population definitions, measured baseline,
  scaling changes, and staged load acceptance gates.
- `PLAYERBOTS_ROADMAP.md`: the complete operator-requested feature register,
  acceptance criteria, and live evidence gaps.
- `THIRD_PARTY_NOTICES.md`: EveJS project and community-fitting credits.

## Credits and provenance

This add-on is built for the original EveJS server and uses its native game
services. EveJS project information and community support are available on the
[official EveJS Discord](https://discord.gg/qrdfam8Mz). See
`THIRD_PARTY_NOTICES.md` for the source and license notes.

The bundled fitting data comes from the EveJS Discord post titled
“[EveJS v12.3.1] 400+ Saved Fittings,” attributed by the maintainer to John
Elysian (the exact Discord display name and spelling have not been verified).
The source was supplied as XML and converted into the static catalog; no
message permalink was included with the supplied files. The package contains
5,353 usable fits after excluding 11 entries without a usable fit. See
`COMMUNITY_FITTINGS.md` for the data provenance note.

## Current release

The current package is **0.2.148**, an experimental public test build. It is not a declaration that the playerbot roadmap is complete. New bots are born across all four empires with names from their own race, and each works from its empire's hub instead of one station; relocating pilots prefer the least crowded nearby system. Trade pilots keep real buy and sell orders for minerals where they work, playerbots can now be legal targets for each other's piracy and war patrols, and bot corporations with a war headquarters declare normal wars on each other. The dashboard confirms that saved settings were applied. The Settings page shows every setting's default, can reset them all, and can delete every bot to start the roster over. Corporation and alliance names can come from an optional name library edited in Settings (contributed by @gzy40347). It adds mining, upgrade, structure, war patrol and industry fixes and an opt-in local defense service (off by default, see `LOCAL_DEFENSE.md`), and `/bots corp` commands to recall a whole corporation to its HQ and send it back to work. By default at most 300 bots are online at once and 30 per solar system; bots above the online limit stay in the roster and take turns. The space tick now runs on a fixed 100 ms deadline grid instead of a plain interval timer: a late tick does not push later ticks back, slots missed during a stall are skipped, and a tick never starts less than 50 ms after a very late one (`EVEJS_SPACE_TICK_SCHEDULER=interval` restores the interval timer). A stall watch records every space tick that holds the server for a second or longer, with the solar systems it spent the time in, and shows them on the Performance page. Both are adapted from the Living Universe server tree. This release also removes the largest main-thread costs found by profiling a 500-pilot server: dungeon and incursion upkeep in systems with no human pilot in space now runs every ten seconds instead of every second (and incursion system effects every ten seconds instead of every tick), restored at once when a human enters space there (`EVEJS_PLAYER_BOTS_UNOBSERVED_SITE_TICK_MS`, `0` to turn off); structure and combat planning no longer copy every pilot's operation on each call; a pilot's corporation role masks are reused for up to a minute instead of being recomputed on every session read; the profit-share pass no longer copies every pilot's character once per pilot; and repeated hits from the same pirate NPC are assessed once every three seconds instead of once per hit. It also includes a Performance page and a read-only telemetry endpoint that report the EveJS event loop, process and main-thread CPU, memory, garbage collection, scheduled playerbot work, time spent per subsystem, and how many bot ships are in systems with no human pilot in space. A director pass now hands control back to EveJS between pilots once it has run for the configured slice budget (8 ms by default; 0 turns this off), so one long pass no longer holds the server in a single uninterrupted slice. Piracy pilots no longer all deploy to the nearest pirate system: destinations are ranked by distance, current patrols and recent deployments, rotate on a per-corporation period, and are capped at six patrols per system. `verify.py` checks an installed tree against this release without changing anything. The work-budget, garbage-collection summary and deterministic rotation helpers are adapted from the Living Universe patch; see `THIRD_PARTY_NOTICES.md`. The package includes the standalone director, operations dashboard, public fitting catalog, guarded EveJS integration, and operator controls for population and work. New bot creation requires a complete portrait set before saving the roster entry; if portrait generation fails, bot creation is reported as a failure instead of leaving an invisible pilot. Cycle timing changes made in the dashboard now take effect in both the add-on and EveJS's next-cycle gate. After the bundled portrait pool runs out, bots reuse a catalog face deterministically instead of blocking EveJS to render another full-size image. Notification reads now normalize only the requested pilot instead of scanning every pilot inbox. The dashboard's active-work totals include industry cycles and the per-pilot activity view shows them as current work. Director think jobs coalesce into roster-wide assignment passes, resume capacity-paused jobs, and start new work in bounded waves. A failed or completed assignment must not strand an otherwise eligible pilot: capsule recovery waves count successful starts rather than existing/deferred attempts; cross-trained security-fit pilots can accept director-issued war patrols; a review-only industry cycle keeps its ledger untouched while its pilot receives independent mining work or a mining-hull upgrade; and a combat pilot without a reachable patrol target receives mining or a mining-hull upgrade in the same director pass. Work capacity counts pilots once even if recovered state contains both an operation and an industry cycle. Stale cooldowns caused by unavailable patrols or review-cycle sell guards are released. The default active-work ceiling covers the configured online population, while each pass limits starts and resumptions to 20 pilots. The lightweight roster-wide director pass enforces the Jita arrival cap without repeated package lookups. The dashboard records and displays planetary setup wait reasons separately from active work, so queued pilots are not presented as producing. This release includes the guarded 500-pilot hot-path optimizations for entity-ID normalization and dungeon-state cloning, and gives the EveJS game/gateway health probes enough time to remain healthy during roster load so Compose can start the add-on reliably. Rollback removes only empty directories left by the managed overlay and leaves user files untouched. The roadmap remains the source of truth for features still being implemented or awaiting live evidence.

Portraits work offline. When the optional CCP agent image pool has an unused
portrait, the server assigns it to the bot. Once all pool faces are assigned, it
reuses a face deterministically so bulk seeding does not block EveJS with
synchronous image rendering. If no pool exists, it creates a local character
image. The dashboard streams the same portraits from EveJS on the
same origin, so browser CORS settings do not hide them. Remote game clients
still need an `imageServerUrl` they can reach; see `TROUBLESHOOTING.md`.

Fresh installations gradually seed a target of 500 bots in bounded batches.
The worker waits for two five-second EveJS load samples before its first
batch. Hard seeding caps are 10 bots per batch, 250 ms event-loop p95, 95%
EveJS process CPU, and 1,000 ms for one pilot creation; stored settings cannot
raise those limits. Seeding backs off when load crosses the effective cap.
The public-test defaults cap the persistent roster and online sessions at
1,500. The remote clean test has seeded 500 bots and verified all 500 online
at once; live samples stayed healthy at 2.6–3.2 GiB server memory and usually
96–426 ms event-loop p95. An 18.1-second spike occurred during initial
connection/restart waves, so this validates the simultaneous-session count,
not consistent latency or sustained work throughput. Operators
can change these settings from the dashboard up to the code hard limits after
validating their server capacity. The add-on seeds bot characters, not the
market: EveJS's own market setup must seed Jita before bots can buy its stock.
For new users, a clean EveJS source checkout with no existing game or market
database is the recommended starting point. Install the add-on before the
normal EveJS first-run initialization, then use EveJS's own market tools to
seed Jita. Existing deployments can install the add-on without resetting or
moving their databases.

## Safety and persistence

The installer validates the source version and every managed source-file hash
before it writes anything. Existing modified files that match neither the
supported original nor this release cause installation to stop. Before it
replaces source files, the installer backs them up to a timestamped
`.playerbots-install-backup-*` directory in the EveJS source tree.

Installation and rollback do not read, write, migrate, move, or delete EveJS
databases. By default, installation only updates source files and `.env`,
checks the Compose configuration, and leaves services stopped. The optional
`--start` switch rebuilds the image and starts the EveJS server and add-on; it
does not start, stop, or rebuild the Market service. EveJS server and add-on
containers use `restart: "no"`, so Docker does not start them at machine boot.
The install step itself never creates pilots or begins roster seeding. If
`--start` is used, the add-on waits for load telemetry and then seeds gradually
under the hard caps above; it never performs a bulk roster insert.

The API token is generated locally with 256 bits of randomness and stored in
the EveJS `.env` file with owner-only permissions on Linux. It is passed only
between the server and add-on containers. Do not publish it in logs, screenshots,
or support bundles.

## License

This package is distributed under the repository's AGPL-3.0-only license. See
`LICENSE`.

## Contributors

- [@gzy40347](https://github.com/gzy40347)

## Acknowledgements

Playerbots and the Living Universe project share code in both directions in
an open, collaborative spirit: Living Universe builds on parts of Playerbots,
and Playerbots adapts some of Living Universe's work, including the
performance helpers, the patrol rotation helpers, the space tick timer and the
stall watch. Thanks to the Living Universe project for the collaboration. See
`THIRD_PARTY_NOTICES.md` for the details and licenses.

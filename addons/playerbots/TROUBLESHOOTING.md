# Troubleshooting

## The dashboard does not open on port 8080

The dashboard binds to `0.0.0.0:8080` and does not require a login. Check
`docker compose ps playerbots-addon`, the sidecar log for
`PlayerBotsDashboard`, and the host port mapping. Operation records are loaded
through a paginated API; settings updates require a same-origin request. The
private server API token is never sent to the browser.

## Recreate only the add-on container (launcher or modded Compose setups)

If the dashboard or the bot driver stops answering, or after editing the
add-on settings in `.env`, recreate just the `playerbots-addon` container. The
game server and market keep running. Run this from the EveJS checkout, with
every Compose file your installation uses: the EveJS launcher adds
`.evejs-launcher/compose.images.yaml` and `.evejs-launcher/compose.mods.yaml`;
leave them out if you do not use the launcher. Use the override that
`install.py` placed in `addons/playerbots/`, not the one in the extracted ZIP
folder, so the command does not change with each release. The project name
(`-p evejs`) must be the one your containers already use (the prefix of their
names, such as `evejs-server-1`); otherwise Compose starts duplicates.

Windows PowerShell:

```powershell
docker compose -p evejs -f compose.yaml -f .evejs-launcher/compose.images.yaml -f .evejs-launcher/compose.mods.yaml -f addons/playerbots/compose.override.yaml up -d --no-deps --force-recreate playerbots-addon
Start-Sleep -Seconds 20
node -e "async function main(){for(const p of ['/api/summary','/api/seed-status']){const r=await fetch('http://127.0.0.1:8080'+p);let b;try{b=await r.json()}catch{b={}};console.log(JSON.stringify({endpoint:p,status:r.status,data:b}))}}main().catch(e=>{console.error(e.message);process.exit(1)})"
docker logs evejs-playerbots-addon-1 --since 90s
```

Linux or macOS:

```sh
docker compose -p evejs -f compose.yaml -f .evejs-launcher/compose.images.yaml -f .evejs-launcher/compose.mods.yaml -f addons/playerbots/compose.override.yaml up -d --no-deps --force-recreate playerbots-addon
sleep 20
curl -s http://127.0.0.1:8080/api/seed-status
docker logs evejs-playerbots-addon-1 --since 90s
```

Both endpoints should answer with status 200. This does not apply changes to
the game server's own settings (the `EVEJS_PLAYER_BOTS_...` variables of the
`server` service, such as the online or per-system limits); for those, recreate
`server` as well by naming it after `playerbots-addon`, which restarts the
game. Thanks to Gordo for the original command.

## The browser shows a cached login prompt

The current dashboard does not use login authentication. Clear the browser's
cached HTTP credentials for the host and reload the page.

## A bot has no profile portrait

New playerbots are not added to the roster until EveJS has a portrait available
at every supported client size. With the optional CCP agent portrait pool,
EveJS assigns unused faces first and deterministically reuses one after the
finite pool is exhausted. If the pool is absent, it generates an offline portrait. The
dashboard proxies portraits through `/api/character-portrait` to the EveJS
image service at `http://server:26001` on the Compose network. The server image
service must bind to the container network; the add-on Compose override sets
`EVEJS_IMAGE_SERVER_BIND_HOST=0.0.0.0` by default.

For a remote game client, check that EveJS's `imageServerUrl` points to an
address the client can reach and that the mapped image port is open. Test a
bot with:

```sh
curl -I "$EVEJS_IMAGE_SERVER_URL/Character/<characterID>_64.jpg"
```

If that request returns an image but the client still shows a blank portrait,
refresh the client session so it reloads the image URL.

## `/playerbots ops` is slow or appears blank

The bare command returns a one-message automation overview. Use
`/playerbots ops 1` for the first live roster page, or
`/playerbots ops systems 1` for system totals. If the command still produces no
chat reply, check the server log for `Playerbots ops request received` and
`Playerbots ops reply`; the latter includes response size and elapsed time. A
request line without a reply points to command processing, while a reply line
confirms the server generated and sent the response through its XMPP chat
connection.

## Installer says the EveJS version is unsupported

This release is pinned to EveJS `261108.1`. Confirm both root and
`server/package.json` versions. Do not bypass the check or force-copy the
overlay over a different checkout. Use a matching source archive or build a
new package with a reviewed compatibility manifest.

## Installer reports a source-file conflict

The installer found a managed file whose hash matches neither the supported
original nor this package. It makes no changes in this case. Preserve your
local edits, compare the reported file with `integration/server/<path>`, and
port the changes deliberately. Do not delete the conflict file to make the
installer proceed.

## `docker compose config` fails

Run the command printed in `INSTALLATION.md` from the EveJS source root. Check
that Docker Compose v2 is installed, `.env` has valid `KEY=value` lines, and
the archive's `addons/playerbots/compose.override.yaml` exists. The installer
automatically restores files if Compose validation fails after copying.

## The add-on logs an authentication error

The server and sidecar must use the same
`EVEJS_PLAYER_BOTS_ADDON_TOKEN`. Confirm the `.env` file is loaded by Compose,
that the token has at least 32 characters, and that
`EVEJS_PLAYER_BOTS_ADDON_MODE` is not `disabled`. Recreate both runtime
services after changing `.env`:

```sh
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml up -d --no-deps server playerbots-addon
```

Do not paste the token into chat or issue trackers.

## The sidecar cannot reach the API

Confirm both services are on the same Compose project and network. The sidecar
uses `http://server:26004`; it must not use `127.0.0.1`, because that address
would refer to the sidecar itself. Check the server's startup log for
`Internal API listening on 0.0.0.0:26004` and the add-on log for its configured
API URL. Port `26004` is internal and must not be published.

## The API starts but there are no bots

The API reports the persisted roster. Open Settings, set the target and ceiling,
and enable gradual seeding. The separate add-on creates batches of at most ten
pilots after two server load samples. The server pauses them above its hard
event-loop, CPU, or per-pilot creation caps. Staff can also run
`/playerbots seed <target>` to enable the same gradual worker. Check the seed
status panel and server/add-on logs for progress and backoff. The command never
resets or shrinks the database roster.

## The driver repeatedly reports cycle failures

Read both service logs. Server-side steps report the affected character and
operation; the add-on reports the cycle and per-character HTTP failure. Check
that Market is healthy and that the server can reach its configured game data
and normal EveJS services. The sidecar does not connect to or repair databases.
Do not rebuild, reseed, or delete a database as a troubleshooting shortcut.

## The Performance page shows high event-loop delay

Read **Work by subsystem** first: the entry with the largest p95 is where the
EveJS main thread spends its time. A director pass with a long **Longest
slice** and no yields means the slice budget is `0`; set it back to `8` in
Settings. High process CPU with low main-thread CPU points to garbage
collection or other threads, so check the memory card. A growing **Oldest
overdue** value means scheduled work is falling behind; follow the reduction
order in `OPERATIONS.md`.

## `verify.py` reports files that do not match

Exit code `1` lists each file as `missing`, `modified`, or `original`. Files
marked `original` were never replaced; run `install.py` again. Files marked
`modified` were changed after installation; compare them with the release
before reinstalling with `--replace-conflicts`, which backs each one up first.

## Undo installation

Stop `playerbots-addon` and `server`, then run `python3 rollback.py <evejs-root>`.
Rollback checks each installed file's hash and restores only matching files.
If files changed after installation, preserve the backup and resolve those
differences manually. Database files are outside the rollback manifest.

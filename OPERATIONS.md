# Operations

The playerbot services are deliberately not configured to start at machine
boot. They use `restart: "no"`. Start them only when the initialized EveJS
instance and its Market service are ready.

Set the working directory to the EveJS app/source root. Define these values
once and use the same project name, base file, environment, and add-on override
for every Compose command. For a standalone checkout, use the defaults:

```sh
BASE_COMPOSE=compose.yaml
COMPOSE_PROJECT_ARGS=()
```

For a Server Panel deployment whose base Compose file is in sibling
`deploy/compose.yaml`, read the existing project's label and set the matching
arguments. Compose does not automatically load the app `.env` when the base
file lives outside the app root:

```sh
docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' evejs-playerbots-addon
BASE_COMPOSE=../deploy/compose.yaml
COMPOSE_PROJECT_ARGS=(--project-name evejs-serverpanel --env-file .env)
```

On this remote host the project label is `evejs-serverpanel`. If the label is
different on another host, use that value. Pointing Compose at the wrong base
file or project can silently operate on a different, empty project and leave
the Server Panel containers unchanged.

Use this invocation shape for start, stop, restart, and logs:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" \
  -f "$BASE_COMPOSE" \
  -f addons/playerbots/compose.override.yaml \
  ps server playerbots-addon
```

## Start and stop

Start EveJS after Market is healthy, and wait for the server to report
`healthy` before starting the playerbot driver. Starting both services in one
command can let the sidecar issue work while EveJS is still loading its game
store and listeners.

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml up -d --no-deps server
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml ps server
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml up -d --no-deps playerbots-addon
```

For a controlled server restart, stop the sidecar first, restart EveJS, wait
for `server` to be healthy, then start the sidecar:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml stop playerbots-addon
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml restart server
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml ps server
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml start playerbots-addon
```

When an add-on-only release changes no guarded EveJS server source, restart
only the sidecar after installation:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml restart playerbots-addon
```

Do not restart `server` and `playerbots-addon` together. Compose's `restart`
command does not wait for the server's health dependency before restarting the
sidecar. A premature sidecar cycle can log transient request failures and
needs to be checked after EveJS is healthy.

Stop only those two services:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml stop server playerbots-addon
```

The Market container is not stopped. To stop the driver but leave EveJS
available for human players, run:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml stop playerbots-addon
```

Check current state and logs:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml ps server playerbots-addon
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml logs --tail=100 server playerbots-addon
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml logs -f playerbots-addon
```

The `playerbots-addon` log uses English and reports cycle ID, roster progress,
completed bots, failures, retry delays, and shutdown. The private API health
endpoint is available only inside the Compose network at
`http://server:26004/health`.
The server caches the sorted bot-profile roster between profile writes and
reads character identity through the shared read-only character view. This
avoids serializing every full character record on every bot-list request while
keeping character names and corporation membership current.
SIGINT and SIGTERM interrupt both scheduled waits and in-flight HTTP requests,
so stopping the add-on does not wait for its five-minute cycle interval.

## Playerbot dashboard

The add-on serves the playerbot dashboard without login on port
`8080`. Docker publishes it on `0.0.0.0:8080`; open
`http://<evejs-host-ip>:8080` from a machine that can reach the EveJS host.

Killboard ship renders are fetched from the official EVE image service by a
size-limited same-origin dashboard proxy. This avoids mixed-origin and
embedded-browser image restrictions; the add-on host needs outbound HTTPS to
`images.evetech.net`. Render responses are cached in memory for six hours.

For access through SSH, create a tunnel:

```sh
ssh -L 8080:127.0.0.1:8080 user@evejs-host
```

Then open `http://127.0.0.1:8080` on that computer. The private bearer token and
game database are not exposed. Operations are searchable and paginated across
active records and the durable terminal history. Open a record to inspect its
steps, locations, ship, results, and financial totals. The Settings page edits
bounded runtime values. The same page can enable or pause gradual roster
seeding, choose the bounded batch size and interval, and show batch history,
EveJS event-loop delay, and CPU load. Seeding runs from the separate add-on
process and uses an authenticated internal API. It waits for two load samples,
yields between pilots, and automatically backs off above hard caps of 250 ms
event-loop p95, 95% process CPU, or 1,000 ms for a single pilot creation.
Dashboard and environment values can lower these limits but cannot raise them.
The staff `/playerbots seed <target>` command enables this worker rather than
doing synchronous bulk work. Startup roster seeding is off by default; an
operator may opt into one explicit small startup batch with
`EVEJS_PLAYER_BOTS_STARTUP_SEED_BATCH_SIZE` (1–25).
The same event-loop and CPU measurements automatically reduce active addon
work to four, two, or one concurrent pilot step as the server crosses its
fixed load bands; raising the configured concurrency does not override them.
Keep roster seeding paused whenever game login, undocking, scene ticks, or
dashboard reads show material delay. A configured safety threshold is a
back-pressure trigger, not evidence that the server is responsive; resume in
small batches only after a live profile and player-facing latency checks pass.
Within each specialty the seeder fills already founded corporations first and
balances their growth by quota. It does not open another shard while an
existing one has planned bot seats. This applies to managed corporations whose
CEO is human as well; monitor the Corporation view to confirm existing corps
receive the growing roster.

The overview reports connected playerbots and human pilots separately from
actors in space. The Territory view summarizes fleets and bot/human membership,
active wars, structures missing Quantum Cores or running low-power, and claimed
sovereignty systems. Pilot tables are paginated at 100 rows per request, and
the aggregate snapshot is cached for 30 seconds. The dashboard refreshes live views automatically while visible. It binds to
`0.0.0.0:8080`; use a firewall or SSH tunnel when the EveJS host is not on a
trusted network.

## Null-sec war mobilization

When two eligible corporations own structures in the same null-sec system, the
director can declare a normal billable corporation war from that real strategic
conflict. It does not hold the declaration until both sides have finished
fitting. The ordinary 24-hour spool-up is used to recruit and equip security
pilots. Recruitment uses EveJS's regular invitation and applicant-acceptance
handlers. The runtime does not edit affiliation directly, recruit humans, or
exceed the target corporation's member limit. It queues normal combat skills
for safe local members without stopping their current sale, mining, PI, or
industry work; the director waits for that work to finish before it takes them
to buy and fit a combat ship. External recruitment only moves idle security
bots from bot-only donor corporations and leaves at least three fitted security
pilots in each donor. An idle bot is never automatically removed from a mixed
corporation with a human member.

Each eligible bot-only corporation receives an exact 5B ISK grant on its first
war. Set `EVEJS_PLAYER_BOTS_WAR_TEST_CORPORATION_ID=<corporationID>` only when a
human-CEO test corporation should receive the same one-time grant. The Compose
override passes this optional `.env` setting to the server; leave it unset for
ordinary mixed corporations. The grant appears in the corporation journal as a
GM Cash Transfer and uses a durable idempotency receipt. Up to five eligible
combat pilots can receive up to 1B ISK each through the standard corporate wallet
transfer authority so they can buy the best ship their skills and the market
allow. Unfit security pilots are prioritized, including pilots in capsule
recovery. A 200M reserve stays with the corporation, and all unused funds
remain in its wallet. Grant and stipend receipts prevent duplicate transfers
after a restart. A pending transfer is checked against both corporation and
character wallet journals before retrying, so a completed transfer is not paid
twice if its receipt was not saved. If only one journal shows the old transfer,
it is held for operator review instead of being debited a second time. Extra
completed legacy stipend pairs are returned to the corporation through a
keyed character-to-corporation wallet transfer before that pilot can reserve
more war upgrade funds. The returned corporation and character balances
confirm that refund; retries use the same key if the service reports its
normal balance-pair response.
If capsule recovery supersedes an upgrade after the stipend was reserved, the
runtime releases that orphan only when the complete character market history
proves that no purchase followed the reservation. A later transaction,
incomplete history, pending spend, or review operation keeps the budget locked
for inspection rather than risking a duplicate or unaccounted ship purchase.
Reconciliation runs when the capsule-recovery path replaces work and again
before a security upgrade spends the war budget, so recovery does not depend on
the replaced operation receiving another scheduled step.
Capsule recovery is a finite market visit and may enter a system at its
autonomous population limit so the pilot can replace its lost ship. Once fitting
finishes, ordinary capacity planning resumes and relocates the pilot if the
system remains over limit. Routine upgrades still wait for a free arrival slot.
When this test setting is present, the director prioritizes a genuine eligible
structure rivalry that includes that corporation, so the human-CEO grant path
is exercised against a real war opponent.

For a funded first-war corporation, the director fills a five-pilot roster
from safe members already in that corporation before considering outside
recruits. It leaves the human CEO, officers, corporation membership, and
passive PI colonies alone. Each member's current durable operation continues
while combat skills train; the ship-upgrade operation starts after the current
work finishes. If the local roster cannot reach five, it can recruit idle
security bots through EveJS's normal invitation and applicant-acceptance flow;
source corporations keep at least three fitted security pilots.

Cross-trained pilots learn the Algos, Vexor, Myrmidon, and Dominix fit
requirements in that order through EveJS's normal skill queue. The director can
start fitting the strongest currently eligible hull while later levels keep
training. When a required skill is not injected, the pilot buys it through
EveJS's ordinary skill-purchase authority using its wallet. The pilot receives
its capped, idempotent first-war ship stipend before it needs to buy those
books; this is part of the corporation's existing 5B first-war grant, not an
additional grant. Up to five pilots can draw from the grant, with 200M left in
the corporation reserve. Queue and purchase retries do not duplicate skill
levels, books, or wallet transfers. `/playerbots ops` shows the in-corp
mobilization and training counts.

The normal 24-hour war start timer still applies. `/playerbots ops` shows the
active mobilized war count and the grant, stipend, and recruitment totals.
Recruitment attempts are recorded in the server log; `/playerbots op status
<bot>` shows a recruited pilot's travel and ship-upgrade work.

## Playerbot operations chat

`/playerbots ops` returns the compact saved automation overview as one chat
message. It avoids reading every character, wallet, operation, and solar-system
location before replying. Use `/playerbots ops 1` for the live bot roster,
`/playerbots ops systems 1` for the paged system distribution, and
`/playerbots ops system <solarSystemID>` to inspect bots in one system. Roster
pages retain current character, corporation, system, ship, wallet, and work
details. The server log records each overview request and its response time so
remote chat delivery can be checked without guessing at host load.

## Planetary export recovery

Automatic PI export creates a durable collection operation only after the bot
reaches the colony system and confirms cargo space for the selected commodities.
The server saves an attempt key before calling the normal PlanetMgr launch and
wallet authorities. Retries first check the persisted launch receipt, then
reuse its launch and physical container. They do not create a second launch or
charge a second export tax for the same attempt. If no launch was committed and
the original tax debit was fully refunded, the bot starts a fresh keyed attempt.
If the wallet, colony stock, launch receipt, or physical container disagree,
the operation stays in `review` rather than repeating an uncertain export.

Use `/playerbots op status <bot>` to inspect an export or collection operation
and `/playerbots tasks` to inspect queued PI policy work. Do not remove or move
a launch container while its owner has an active PI collection operation.
Some legacy operations in `review` have no durable attempt receipt and remain
there until their launch, wallet, and source-stock evidence can be reconciled.
The current code has one narrowly-scoped recovery for the known
`storedLaunchID is not defined` failure: it requires an
exact matching tax debit, no launch or durable receipt (including deleted
launches), and a keyed wallet refund. It resumes the operation only after the
refund is confirmed. Other ambiguous exports remain in `review` and are never
retried automatically.

## Mining belt safety and escort fits

Mining safety checks use the pirate NPC ships in the miner's observer-visible
grid, limited to 250 km. When the belt scan finds zero rats, no escort is
assigned and the miner continues its asteroid cycle. When rats are visible,
the runtime searches available security specialists for a complete, online
combat fit whose validated site tier meets the system-security tier. It
prefers the miner's corporation, then the strongest fitting ship, and starts
a durable security operation for that exact belt. If all suitable pilots are
busy, the recent rat sighting stays in the director queue and takes priority
when a security pilot finishes its current operation. The director upgrades
an insufficient combat fit first only when the normal skill, wallet, and
profit gates allow it. The miner keeps mining while the escort becomes
available and travels. A missing suitable ship is reported in operation
history and does not cause an empty-belt wait or a retreat.

System security requires fit tier 1 at 0.8 and above, tier 2 from 0.6, tier 3
from 0.45, tier 4 below 0.45 but above zero, and tier 5 at zero or below. If
static system data is missing, tier 5 is required. For a mining trip, only loss
of the miner's ship or destruction of its assigned escort triggers a security
retreat; full cargo and trip-time limits still send it back for routine work.
The scan count, escort name, actual fit tier, and required tier appear in
`/playerbots op status <bot>`.
An empty belt is a valid result: EveJS rolls belt rats on arrival when enabled
(`EVEJS_ASTEROID_BELT_NPC_RATS_ENABLED`, default `true`), with a default 25%
chance for a normal group in high security
(`EVEJS_ASTEROID_BELT_NPC_RAT_HIGHSEC_CHANCE`). A zero scan reports that the
miner currently sees no rats; it does not spawn them.

Mining state and cargo are checked every 15 seconds, matching the basic
Miner I module cycle. Faster polling cannot shorten that cycle and adds
scheduler jobs for the full mining roster.

## Combat repair fallback

If a patrol returns to an Upwell structure without an online repair service,
the pilot searches reachable NPC stations through EveJS's station service
authority for one that provides both repair and market services. This lookup
does not depend on the optional `stationOperations` SDE catalog. It saves that
destination, travels there through the normal navigation task, and repairs
before continuing to its sale or next patrol. Startup reconciliation also
resumes legacy combat returns blocked by
`REPAIR_OFFLINE` when such a station is available. If the route or service
cannot be verified, the operation remains blocked at a safe location; it does
not re-enter combat with a damaged ship. The detour does not grant structure
docking rights and does not bypass the NPC station's ordinary market and
repair authorities.

Combat operations also recheck their stored Upwell home and market destinations
before returning or settling loot. If corporation/alliance docking access has
since been removed, the ship replaces the stale destination with a reachable
NPC station that provides both repair and market service. It does not repeat a
docking command against the restricted structure.

## Structure Quantum Core transport

A caretaker checks the Quantum Core volume against the active ship's free cargo
space before loading it. If the core does not fit, the operation uses an owned
Badger or Tayra in a reachable NPC hangar. If the pilot owns no suitable
hauler, it may buy a trained hull within a protected 25 million ISK logistics
budget. Market selection prefers safe stock outside Jita, and the market
authority verifies regional supply before any Jita seed purchase. The former
ship remains safely in the station hangar while the hauler carries the core.
The operation still installs and reconciles the exact core through EveJS's
inventory and structure authorities; it does not grant structure access.

If the combat hull is destroyed, capsule recovery takes a safe settlement
path. The capsule leaves any combat or site-entry stage, reaches a station,
sells recovered loot outside Jita, and releases a still-incomplete anomaly to
the shared site pool without recording a clear. The completed combat operation
then frees its work slot for the director to buy and fit a skill-eligible
replacement hull. Old capsule operations whose market or home destination is
Jita are retargeted to a reachable non-Jita station with both repair and
market services. If none is reachable, the capsule remains in `holding`; it
does not route to Jita to sell.

## Industry listing recovery

Before placing a playerbot sell order, the cycle persists its inventory,
wallet, transaction, and existing-order snapshot. If a listing response times
out, the cycle checks the market and wallet authorities again. It retries only
after two snapshots, at least 15 seconds apart and at least 60 seconds after
the attempt, prove that inventory, wallet, transactions, and every existing
order stayed unchanged. If any value moved or cannot be read, the cycle stays
in `review` and never submits a duplicate listing.

Before listing, a market run uses the bound station inventory's normal
`Stack All` command to consolidate identical stackable goods. This reduces the
number of orders consumed by PI and manufacturing output; market items already
in escrow are untouched. If the inventory authority refuses stacking, sale
continues from the separate stacks.

All bot profiles provide Trade V, Retail V, Wholesale V, and Tycoon V, giving
each pilot the full 305 open market-order slots under EveJS's skill rules.
Existing orders are preserved during the raise-only skill-profile upgrade.
If the market authority
rejects a listing, the cycle includes the wrapped market error detail in its
visible holding reason, including details carried in EveJS `UserError`
responses. Unsold output remains in the hangar until an order is accepted.
When a later retry succeeds, the cycle clears any rejection recorded by an
earlier attempt; completed listings also hide such legacy stale errors from
the status summary. A completed sale rejected specifically because the pilot
has no free order slot is deferred for one five-minute director interval; the
pilot remains eligible for other work while the market capacity recovers.

Market matching skips a playerbot's own personal sell orders and corporate
sell orders paid from the same corporation wallet. The guard applies to both
immediate purchases and crosses triggered by changing a buy-order price. This
prevents a bot from manufacturing taxable turnover by buying its own stock.

Ship-kit purchases with an uncertain market response stay in review until the
wallet journal, market transactions, and station/cargo inventory resolve the
outcome. The director confirms a delivered purchase or a fully refunded one;
it retries a no-effect purchase only after a 60-second grace period and a
complete wallet-journal balance chain proves that no debit or inventory change
occurred. Missing or inconsistent evidence leaves the operation in review for
an operator instead of risking a duplicate charge. After confirming a
purchase, refund, or no-effect result, recovery wakes the bot's durable step
job so it continues without waiting for an unrelated assignment.
Each add-on roster visit also checks that a pilot with active mining, PI,
hauling, combat, or manufacturing work still has a durable step scheduled. A
missing step is recreated without duplicating an already scheduled or running
job. When a completed step assigns replacement work, the current scheduler
job creates its successor before it acknowledges itself.

## Structure investments

Only a bot with persisted CEO, Director, or Station Manager authority can
purchase a structure for its corporation or deploy its personally owned
package. Structure anchoring accepts the same three authorities through
EveJS's persisted corporation membership checks. The director limits
autonomous procurement to one medium specialty-appropriate structure per
corporation, only in neutral or allied claimable nullsec. It first uses
realized reinvestable profit when that covers the complete market package and
transport (with a 250M ISK minimum profit gate). If profit has not reached that
gate, a bot can bootstrap the purchase from its own wallet when the full
package, logistics budget, and protected working reserve are affordable.
This seed-capital fallback does not count the initial grant as profit and does
not use the corporation wallet. The market package includes the structure
hull and its type-required Quantum Core, must be available at one station, and
is capped at 1B ISK. The director prefers safe non-Jita supply and uses Jita
only when no such supply exists. The existing 40% cumulative net-profit share
for bots in corporations with a human CEO is unchanged.

An 8,000 m³ package uses a Tayra fitted with four Expanded Cargohold II modules.
Playerbot provisioning raises Caldari Hauler to V and Hull Upgrades to IV, and
the live inventory broker confirms capacity before the package is loaded. If
the bot does not have that cargo capacity, it can buy the logistics fit using
realized profit or its personal balance above the protected reserve. Larger
packages require a suitable active
ship and enough live cargo capacity. `/playerbots build` requires the matching
Quantum Core in the same hangar or cargo hold, then uses EveJS's normal
placement, persisted CEO/Director/Station Manager permission, item-consumption,
and anchoring
authorities. If the arrival grid has no legal anchor location, the carrier
warps to a clear point beyond a celestial warp-in exclusion zone and validates
the live position again before submitting deployment. Autonomous procurement
carries the required core with the hull and returns it to the home hangar after
anchoring. A newly anchored structure can display `Core absent` while EveJS's
structure authority advances its anchor and onlining states. The core stays in
the bot's custody until the structure reaches the authoritative dockable
`ONLINING_VULNERABLE` state; then a bot with persisted structure-management
authority receives a durable core-install operation. A human CEO alone does
not block that operation.
The director then assigns separate durable operations to install the
type-correct Quantum Core and, for
an eligible Raitaru, acquire and fit its basic manufacturing service module
and compatible fuel through the normal market, inventory, and structure
authorities. It confirms the service is online and accessible before assigning
manufacturing there. A separate structure-maintenance assignment now covers
every bot corporation that owns a dockable, core-powered structure, including
corporations with a human CEO. If no bot already has CEO, Director, or Station
Manager authority, one deterministic bot receives the Station Manager bit only
in its playerbot actor session; persisted corporation member roles are not
changed. That caretaker restores low-power structures with a compatible
service module, then replenishes online service fuel before it falls below one
day. It buys from non-Jita markets first and may use the bot's seeded wallet
only while preserving a 150M ISK working reserve. All null-sec structures now
resolve public docking and tethering policies to owner-alliance access; this
permits the owner corporation and its alliance and denies unaffiliated pilots.
Other security bands keep their configured access policy.

## Null-sec structure rivalries and wars

The global director pass checks authoritative structure ownership in each
claimable null-sec system. Two different, non-allied player corporations with
bot members and structures can become a rivalry; one side must have an active
security bot with a valid fitted combat ship, and the director prefers that
armed side to declare. The declaring corporation needs a persisted bot CEO or
Director with normal war authority and must cover the normal 100M ISK war bill
while retaining a 100M ISK corporate reserve. If required, a bot may contribute
only wallet funds above its 200M ISK working reserve through the account
authority. EveJS records a regular corporation war and its 24-hour spool-up;
combat assignments wait for the war authority to mark the war active. A human
CEO does not stop autonomous corporate operations, while a bot under direct
human control is excluded from autonomous war decisions. Null-sec open-combat
rules remain available independently of formal war status.

## Alliance founding and sovereignty access

A sovereignty-specialist playerbot can use persisted CEO authority or a
persisted Director role to found an alliance for its corporation. The
Director path is available only to the server-created playerbot actor session;
human clients still need to be CEO. EveJS rechecks live membership and the
Director role when settling the request. Empire Control V, the normal 1B ISK
founding fee, and a 1B ISK retained seed reserve are required. One pending or
active founding operation reserves the corporation's founder slot, so a
second bot cannot spend the fee concurrently. After the alliance is confirmed,
sovereignty specialists may pursue eligible neutral Hub captures or active
campaign command nodes through the normal Entosis, fuel, timer, and safety
authorities. Other corporations join only through the standard application and
approval flow.

## Combat anomalies and live-site recovery

An anomaly is complete only when dungeon authority records its completed
lifecycle state. If that authority removes a selected site before the bot
enters or while it is fighting, the bot recalls its drones, returns to station,
and closes the attempt as incomplete. It may sell loot already recovered, but
it never counts the anomaly as cleared. If the site remains active after a
safe retreat, the pilot repairs, sells recovered loot, and returns to that same
site to continue its remaining waves. Anomaly difficulty starts at tier 1 and
advances one tier only after Dungeon authority confirms a clear; this record is
durable and independent of the seeded wallet. `/playerbots ops` shows the
current site, tier, clear state, and recovery stage. If the current ship is
missing a required module or drone, the bot reserves the active site while it
buys and fits only the missing parts for the same hull, then resumes that exact
site. It makes one safe retry after that return. After a second safe failure,
it releases the still-active site for another eligible pilot, records the
attempt as incomplete, and moves on; it never claims a clear or monopolizes a
site in an endless loop. If replacement parts are unavailable, the operation
stays in `holding` and retries; its status reports the preserved site and last
market result.

After an authoritative clear, the pilot continues collecting accessible site
wrecks when its combat drones or weapons are no longer available, as long as
the ship still meets its shield, capacitor, and hull safety limits. Before it
travels back to a public station, it clears and persists its private dungeon
tracker. This lets the station accept docking and keeps a failed scope save in
a visible retry state instead of repeatedly issuing a rejected dock command.
Combat-site proceeds are handled at the site's local base. The regional sale
planner redirects actual cargo only when another non-Jita station has a better
buyer, so empty or unmarketable holds do not create a long round trip to the
central market.

## Human-led fleets

Managed playerbots accept ordinary fleet invitations from their online actor
sessions. A human-led fleet stays intact while at least one human member remains.
When the last human leaves or disconnects, explicitly disbands the fleet, or
declines an invitation to a bot-created fleet, EveJS dissolves the remaining
bot-only fleet and clears the members' fleet session state. Fleet membership
does not cancel or pause their durable work, so they continue their normal
mining, PI, industry, trade, or other assigned operation.

Fleet-chat `/follow [me|human character|stop]` gives every managed bot in the
fleet a durable order to follow an online human fleet member across systems.
`/escort` uses only security-specialty bots with a validated combat fit and
keeps them at closer range. Fleet-chat `/attack [all|exact bot name]` captures
the commander's most recently acquired target lock and gives fitted fleet bots
a durable attack order. The bot revalidates the live target against its own
war, null-sec conflict, pirate NPC and Crimewatch rules, then approaches or
warps, locks through the targeting authority, and engages fitted combat drones
through the drone authority. Capsules, friendly ships, illegal targets, and
bots without complete combat fits are refused. `/attack stop [all|exact bot
name]` safely recalls drones and returns the selected orders to their home
stations. A changed or docked target, offline commander or dissolved fleet
triggers withdrawal. Mining with cargo can be safely stopped; an industry
cycle, combat withdrawal, accepted courier package, or unresolved authority
action is not interrupted for a new attack order. When the commanded fleet
dissolves or has no human members, follow and attack operations withdraw and
the bots resume director-assigned work.

Roster maintenance advances up to 16 pilot steps concurrently by default.
Each pilot retains a durable director-think scheduler job, while overlapping
idle-pilot decisions are coalesced into one roster-wide assignment pass at a
15-second minimum interval. A completed operation immediately requests the
pilot's next assignment. Capacity relocation is allowed for the whole
100-pilot roster, so a group spawned in one system can spread out without
waiting for repeated batches. Quantum Core commissioning bypasses ordinary
work-slot saturation, requires the bot's persisted CEO, Director, or Station
Manager authority, and leaves the commissioning pilot in the structure's
system after installation. Use `/playerbots ops` to inspect operation stages
and current activity. The roster's `idle` status does not indicate whether the
autonomous director has active work for that pilot. Operations reports active
operations and production cycles separately from pending planetary setup
queues; queued work includes its blocking reason and is not counted as active.

## Rebuild after changing code

The server and add-on share the EveJS image. After changing overlay or add-on
source, rebuild the `init` service's image target and recreate only the runtime
services:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml build init
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml up -d --no-deps server playerbots-addon
```

This does not rebuild or recreate Market. It does not delete or recreate
database volumes. The running EveJS server may write its normal game state once
it is started.

## Configure bot count and connection rotation

Add or edit these values in `.env` before starting `server`:

```dotenv
EVEJS_PLAYER_BOTS_TARGET=500
EVEJS_PLAYER_BOTS_ROSTER_CEILING=1500
EVEJS_PLAYER_BOTS_MAX_ONLINE=300
EVEJS_PLAYER_BOTS_ROSTER_SEED_ENABLED=1
EVEJS_PLAYER_BOTS_CONNECTION_WINDOW_MS=28800000
EVEJS_PLAYER_BOTS_ADDON_MODE=auto
EVEJS_PLAYER_BOTS_ADDON_INTERVAL_MS=300000
EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY=16
EVEJS_PLAYER_BOTS_ADDON_BOT_DELAY_MS=0
EVEJS_PLAYER_BOTS_ADDON_REQUEST_TIMEOUT_MS=120000
EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH=24
EVEJS_PLAYER_BOTS_MAX_CONCURRENT_WORK=1500
EVEJS_PLAYER_BOTS_MAX_PER_SYSTEM=30
EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MIN_MS=90000
EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MAX_MS=210000
EVEJS_PLAYER_BOTS_DIRECTOR_INITIAL_SPREAD_MS=90000
```

Fresh installations default to a roster target of 500, a roster ceiling of
1,500, an online limit of 300, 30 autonomous bots per solar system, and
gradual seeding enabled. Bots above the online limit stay in the roster and
take turns through the connection rotation. On a four-core host with 500 bots
online the space tick ran about once a second instead of ten times, so the
online default is 300; raise it only while the Performance page stays
healthy. The remote clean
test targets 500 persistent bots. Its online cap is staged during roster creation,
then raised to 500 for simultaneous-session validation.
The active-work ceiling defaults to 5,000, matching the online hard maximum, so
the connection scheduler does not leave connected pilots without an assignment
solely because of a lower work cap. The director resumes paused jobs and starts
new ones in waves of at most 20 per pass; this bounds the burst while the roster
fills. Set `EVEJS_PLAYER_BOTS_MAX_CONCURRENT_WORK` or the matching dashboard
setting below the online population only when intentionally queueing some
pilots behind a lower active-work ceiling.
The dashboard's add-on cycle interval controls both how long the sidecar waits
after a pass and when EveJS permits the next pass; lowering it takes effect
without waiting for an old five-minute deadline.
Connection groups rotate over the configured window; human fleet control,
human-connected corporations, and active durable work
receive priority within the online limit. The code hard limits are 15,000
persistent pilots and 5,000 online sessions, but those larger limits have not
been validated at sustained scale. Increase the roster in stages and monitor
service latency, memory, database writes, and cycle completion.

`EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY` accepts 1–100 simultaneous per-pilot
steps during roster maintenance; its default is 16.
The three `EVEJS_PLAYER_BOTS_DIRECTOR_*` values control the independent
decision cadence. The minimum is clamped to 15,000 ms; the maximum is clamped
to at least the minimum; and the first-decision spread is clamped to 1,000 ms.
Set the minimum and maximum to the same value for a fixed recurring interval.
`EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH` sets the durable scheduler's global
dispatch limit (1–128), including playerbot movement, mining, industry, and
other scheduled EveJS work. The add-on Compose override defaults it to 24.
Monitor overdue scheduler jobs and client response times after changing it;
return to 16 if client actions start taking longer.
The release ZIP overlays both the scheduler supervisor and its EveJS worker so
this setting reaches the process that dispatches jobs on the supported base.

``EVEJS_PLAYER_BOTS_ADDON_MODE=disabled`
turns off the API provider; stop `playerbots-addon` as well. Do not remove the
token if the server and add-on are expected to reconnect.

## Performance telemetry

Open **Performance** in the dashboard, or read the same data from the private
API (`GET /v1/dashboard/telemetry`, bearer token required). Telemetry is
read-only and adds no host port.

| Section | What it reports |
| --- | --- |
| Event loop | Delay in the last five-second sample (mean, p50, p95, p99, longest) and across the last ten minutes. |
| CPU | EveJS process CPU, its main thread alone, the remainder on other threads, and how busy the host is. Percentages are of one CPU core. |
| Memory and garbage collection | Resident memory, heap against its limit, and the duration of recent collections. |
| Scheduler | How late playerbot jobs start and how many dispatch slots are in use; optionally the number scheduled, running and due. |
| Subsystem work | Duration of director passes and their stages, per-pilot autonomy steps, scheduled jobs by type, and the dashboard summary. |
| Space tick | The tick timer in use, slots skipped after late ticks, and each tick that held the server for a second or longer with its slowest systems. |
| Scene load | Bot ships in space, the systems they occupy, how many are in systems with no human pilot in space, and the site-upkeep cadence used there. |

The event-loop state uses the same boundaries as the add-on's load guard:

| p95 delay | State | What the add-on does |
| --- | --- | --- |
| up to 50 ms | Healthy | Runs the configured number of bot steps in parallel. |
| up to 100 ms | Constrained | Runs at most four bot steps in parallel. |
| up to 250 ms | Degraded | Runs at most two bot steps in parallel. |
| above 250 ms | Overloaded | Runs one bot step at a time and pauses roster seeding. |

When delay stays high, find the largest entry under **Work by subsystem** and
reduce load in this order:

1. Lower **Bot steps in parallel** or raise **Delay per bot**.
2. Lengthen the director think interval.
3. Lower **General work slots**.
4. Lower **Maximum online bots**.

Do not raise the load-guard or seeding thresholds to make the page look
healthy. These numbers describe this server under its current load; they are
not a capacity guarantee for other hardware.

How late scheduled jobs start is always measured and costs nothing extra.
Counting scheduled, running and due jobs requires one listing of every
playerbot job. The scheduler process answers in milliseconds, but the reply
waits for EveJS's main thread, so on a saturated 500-pilot test server the
round trip took up to 15 seconds. That queue scan is therefore off by
default. Set `EVEJS_PLAYER_BOTS_TELEMETRY_QUEUE_SCAN=1` and restart `server`
to enable it; it then runs only when the page or endpoint is read, is reused
for 60 seconds (`EVEJS_PLAYER_BOTS_TELEMETRY_BACKLOG_INTERVAL_MS`), and a
request waits at most 1.5 seconds for it. Subsystem durations include time
spent waiting on the market or scheduler process; that wait is reported
separately and is not part of any held slice.
Set `EVEJS_PLAYER_BOTS_TELEMETRY_FILE=1` to also write a snapshot every minute
to `runtime-performance/playerbots-latest.json` under the EveJS data root.
Keep that file out of public source control.

## Systems with no human pilot in space

EveJS runs dungeon and incursion site upkeep once a second, and refreshes
incursion system effects on every 100 ms gameplay tick, in every loaded solar
system. With hundreds of bot ships spread over dozens of systems and no human
nearby, that upkeep was the largest single cost on the profiled 500-pilot
server. The add-on therefore runs both once every ten seconds in a system
where no human pilot is in space. Site logic is driven by timestamps, so
spawns, gates, hazards and completions are still decided by the same EveJS
site authorities; they are only noticed up to ten seconds later. As soon as
a human pilot is in space in a system, that system returns to the normal
cadence. Ship movement, weapons, NPC behaviour and Crimewatch are not slowed.

Set `EVEJS_PLAYER_BOTS_UNOBSERVED_SITE_TICK_MS` to another interval between
`1001` and `60000`, or to `0` to run every system at the normal cadence, and
restart `server`. The Performance page shows the interval in use and how many
upkeep passes were skipped.

## Space tick timing and long ticks

The 100 ms space tick runs on a fixed deadline grid. A tick that wakes late
does not move the following deadlines, slots that pass while a tick is still
running are skipped and never replayed, and after a very late tick the next
one starts at least 50 ms later. This only changes when ticks are dispatched;
gameplay still reads the real clock. Set `EVEJS_SPACE_TICK_SCHEDULER=interval`
and restart `server` to return to EveJS's plain interval timer.

Every space tick that holds the server for one second or longer is recorded
with its duration, how late it started, and the five solar systems that took
the most time, with their entity, bot and human counts. **Long space ticks**
on the Performance page lists the last twenty and the totals since start, and
EveJS logs at most one warning a minute. Time outside any one system is
structure upkeep, hazard recovery and system collection. Change the threshold
with `EVEJS_PLAYER_BOTS_TICK_STALL_MS` (at least `100`) or switch the watch
off with `EVEJS_PLAYER_BOTS_TICK_STALL_WATCH=0`.

## Director slice budget

A director pass walks the whole online roster. **Director slice budget**
(Settings, or `EVEJS_PLAYER_BOTS_DIRECTOR_SLICE_BUDGET_MS`, default `8`) is the
longest the pass runs before it hands control back to EveJS and continues
afterwards. A pilot that started other work while the pass was waiting is
skipped for that pass. Assignment rules, attempt limits and capacity limits are
unchanged. When EveJS is already overloaded each hand-back returns late, so a
pass stops yielding after two seconds of accumulated waiting and finishes in
one go; the Performance page counts those passes. Set the budget to `0` to run
each pass in one slice, as earlier releases did; the pass is still measured.

## Patrol rotation

Piracy pilots choose among up to eight pirate systems within six jumps of the
nearest one. The choice weighs distance, patrols already assigned to each
system, and deployments in the last six hours. Each corporation rotates on its
own period of 45 to 180 minutes, at most six patrols share a system, and a
corporation that deployed to the same system in three consecutive periods
moves elsewhere while another system is available. A pilot with no system
below the patrol limit receives other work. Target legality is still decided
by Crimewatch, war status and the combat safety checks.

Set `EVEJS_PLAYER_BOTS_PATROL_ROTATION=0` and restart `server` to return to
nearest-system selection.

## Confirm the API is private

The Compose override does not publish port `26004`. Confirm the rendered
configuration before deployment:

```sh
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml config --quiet
docker compose "${COMPOSE_PROJECT_ARGS[@]}" -f "$BASE_COMPOSE" -f addons/playerbots/compose.override.yaml port server 26004
```

The second command should print no host binding. The API accepts bearer-token
requests only, except for its minimal internal health endpoint.

## Rollback

Stop the add-on and server, then run `python3 rollback.py /path/to/evejs`. The
script restores the latest installer-managed source files and `.env` from the
matching timestamped backup. If any installed file changed after setup, it
stops and reports the conflict rather than replacing the new content.

For a manual rollback, restore the files listed in the install's
`.playerbots-install-state.json` from its `backupDirectory`, remove
`addons/playerbots/compose.override.yaml`, and remove the package files from
`addons/playerbots`. If the add-on generated the token and no longer needs to
run, remove only the `EVEJS_PLAYER_BOTS_ADDON_TOKEN` line from `.env`. Keep the
backup directory until the rollback is confirmed.

## Settings page defaults

Every field on the dashboard's Settings page shows its default underneath.
The default is the add-on's built-in value, or the installation's value when
it is set in the add-on environment file (`.env`). **Reset to defaults** puts
every field back to its default and saves, after a confirmation; the page
then reads the settings back and reports anything that was not applied.

## Delete all bots and start over

**Delete all bots** at the bottom of the Settings page removes every playerbot.
Type `DELETE ALL BOTS` to confirm. Autonomous work and seeding switch off,
then pilots are removed five at a time: their market orders are cancelled (buy
order escrow returns to their wallet), their operation and industry cycle are
closed, they go off line, their roster entry is removed and their character
is deleted through the normal EveJS character deletion, which hands their
assets to their corporation. Bot corporations left without members keep their
record and assets but are not reused, so a new roster founds new
corporations. Human characters and corporations with human members are not
touched. With **Seed a new roster when the reset finishes** ticked, work and
seeding switch back on afterwards. A reset interrupted by a restart carries on
when the Settings page is opened again. It cannot be undone.

## Where bots live

Each new bot gets a race, a bloodline of that race and one of the race's
starting schools; the school whose system holds the fewest bots is used, so a
seeding run spreads pilots over the eight starting systems of the four
empires. Names come from the bot's race, and the first name least used by the
roster is preferred. A bot sells, buys and builds from its empire's hub: New
Caldari (Caldari), Amarr (Amarr), Dodixie (Gallente) or Hek (Minmatar). Bots
created before 0.2.146 keep New Caldari. When a system is over its bot limit,
a relocating pilot takes the least crowded system within four jumps of the
nearest free one.

## Market orders from trade pilots

A trade pilot docked outside Jita keeps one standing buy order for each
mineral at its station, at 90% of the Jita price, paid from its own wallet
into market escrow (at most 25 million ISK per order and a quarter of its
funds in escrow). What those orders buy is listed for sale at the Jita price.
Miners sell into these bids through the normal market. Eight traders are
handled per add-on cycle. Set `EVEJS_PLAYER_BOTS_MARKET_MAKING=0` and restart
`server` to stop placing new orders; existing orders stay until they fill or
expire.

## Combat between bots

Piracy and war patrols may target other playerbots under the same rules as
human targets: corporation, alliance and fleet mates are never targets, and
Crimewatch, war status and security space decide legality. A bot attacked by
another bot defends itself. A bot-run corporation that owns a structure (its
war headquarters) may declare a normal war on another bot-run corporation
whose pilots work in the same systems, at most one attempt an hour and two
such wars at a time; the usual war bill and 24-hour start apply. Set
`EVEJS_PLAYER_BOTS_BOT_VERSUS_BOT=0` and restart `server` to turn both off.

## Corporation-wide orders

`/bots corp` (also `/playerbots corp`) gives orders to every playerbot in a
corporation. Members of the corporation and staff can use it; only the CEO or
staff can change the saved HQ.

```text
/bots corp recall [corporationID] [station|structure <id>]
/bots corp work   [corporationID] [auto|mine|pi|director] [trips <n>]
/bots corp status [corporationID]
/bots corp hq     [corporationID] [list | set <structureOrStationID> | clear]
```

`recall` stops each pilot's work, sends it to the corporation HQ and pauses it
once docked. Recall to an NPC station uses the durable relocation operation;
recall to a corporation structure pauses the pilot at once and steps it there,
without its usual threat responses, so use it in safe space. A pilot whose
structure trip fails is released back to the director. `work` releases the
corporation and starts mining around the HQ (or the nearest safe belts) and
PI setup, or leaves the pilots to the director. Orders are kept in memory:
after a restart, run `recall` or `work` again; `status` lists held pilots that
are not at the HQ. Saved HQs are stored in the game store.

## Optional local defense

See [Local defense and safe task resumption](LOCAL_DEFENSE.md) for explicit enablement, responder eligibility, policy settings, safe disengagement and tests. The feature is disabled by default.

## Optional corporation and alliance name library

Open **Settings → Corporation and alliance names**, paste a name library and
press **Save name library**. **Load template** only fills the editor; it does
not save. Errors appear next to the buttons and leave the previous library
active. The basic template is `doc/name-library-template.json` in the source
repository. Each empire (`amarr`, `caldari`, `gallente`, `minmatar`) has just
two arrays, `corporations` and `alliances`, containing ASCII names.

Empty arrays keep original naming. Nonempty arrays are used in order when
new organizations are founded, skipping occupied names and abbreviations.
If none remain, add more names; numeric suffixes are not added to custom
names. Existing organizations and pending alliance plans are left alone.
The founder's race selects the naming style; specialties, membership and
director work are unchanged. New descriptions use the existing English
specialty label, with `Sovereignty` for automatically founded alliances.

The game process saves one UTF-8 file, `playerbots-name-library.json`, under
its resolved persistent GameStore root. Preserve that file with the server's
data backups. Saving an empty template restores original naming for future
organizations. The dashboard uses its existing management access boundary;
this is not an anonymous public upload service.

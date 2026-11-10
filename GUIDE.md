# Playerbots Operator Guide

This guide covers the commands exposed by the EveJS Playerbots add-on. Commands
are entered in EVE chat. Replace values in angle brackets with the relevant
bot name, character ID, item ID, type ID, station ID, solar-system ID, or task
ID. A bot name containing spaces is accepted where `<bot>` is shown.

Managed pilots are ordinary EveJS character records controlled by the server.
They have no player login account. Commands can control a bot in your
corporation or fleet; staff/admin can control any managed bot. Market actions
use the bot's own wallet and inventory unless a command explicitly selects
corporation assets. The initial 1,000,000,000 ISK grant is protected from
manual fitting and structure spending.

The web dashboard is available at `http://<evejs-host>:8080` without a login.
It provides searchable current and archived operations, operation details, and
editable runtime settings alongside the overview, pilot, corporation, system,
fleet, war, structure, and sovereignty views. See `OPERATIONS.md` for access.

## Inspect the roster and work

| Command | Use |
| --- | --- |
| `/playerbots` or `/playerbots status` | Show the roster target, total, and specialty corporation counts. |
| `/bots` | Alias for `/playerbots`. |
| `/playerbots list [filter]` | List pilots, specialties, and corporations; an optional filter narrows the results. |
| `/playerbots inspect <bot>` | Show a bot's corporation, fleet, location, wallet, ships/items, PI colonies, current operation, queued work, and last completed task. |
| `/playerbots ops` | Show the saved autonomy summary and first live roster page. Each row includes character ID, system and system ID, station/structure, ship, wallet, work, and operation stage. |
| `/playerbots ops <page>` | Show another roster page (10 bots per page). |
| `/playerbots ops systems [page]` | Page through system totals, including connected, in-space, docked, and inactive actors. |
| `/playerbots ops system <solarSystemID>` | Show bots in one solar system. |
| `/playerbots ops <page> system <solarSystemID>` | Show a page of bots within a system. |
| `/playerbots tasks [queued|leased|completed|failed|canceled]` | Inspect durable work tasks; omit the filter to show the default queue view. |
| `/playerbots orders` | List player buy orders the bots can fulfill and the bot assigned to each. |
| `/botlocal` or `/botlocali` | Count and locate bots in your current system. |
| `/botlocal all` | Summarize bot locations across systems. |

The `idle` roster label does not mean the bot has no director work. Use
`/playerbots ops`, `/playerbots tasks`, and `/playerbots op status <bot>` to see
the actual assignment and durable operation state.

## Check server performance

Open **Performance** in the dashboard to see event-loop delay, CPU, memory,
scheduled work and time spent per subsystem. `OPERATIONS.md` explains each
value and what to change when delay is high.

## Set the roster size

The last live roster measurement was 1,339 managed bots across 12 corporations.
The remote public test is explicitly configured with a target, roster ceiling,
and online limit of 1,500. A fresh add-on installation defaults to a 500-bot
target and gradually seeds that roster in bounded batches. Its default ceiling
and online limit are 1,500. Connection groups rotate over the configured window,
with active work and bots in human-controlled corporations or fleets receiving
priority within the online limit. The code hard limits are 15,000 persistent
pilots and 5,000 online sessions; those larger limits have not been validated
at sustained scale.
Mature specialty groups are planned as
250-pilot corporation shards, with a 300-bot maximum per corp; additional
corps are opened as a specialty grows. A human CEO is an additional member, so
a corp with 300 bots plus that CEO needs a persisted member limit of 301.
Mature shards are kept in the 200–300 range when the specialty's population
allows it. During a transition, a final shard can be smaller because the
300-bot cap and a 200-bot minimum cannot both fit every intermediate
population. Bot corporation CEOs receive EVE-style member-limit skills and
the persisted limit follows those skills.
The seeder fills already founded specialty corporations first and balances
their growth by quota. It does not open another shard while an existing one
has planned bot seats. This also applies when a human has taken the CEO seat of
a managed specialty corp; that corp remains eligible and keeps its 300-bot
capacity.
Fresh installations default to a 500-bot target, with gradual seeding enabled.
The separate add-on creates bots in bounded batches and pauses automatically
when EveJS reports high load. To change the target or pause seeding, use the
dashboard Settings page. The add-on creates only a
bounded batch at a time, yields between pilots, and waits between batches:

```dotenv
EVEJS_PLAYER_BOTS_ROSTER_CEILING=1500
EVEJS_PLAYER_BOTS_TARGET=500
EVEJS_PLAYER_BOTS_MAX_ONLINE=1500
EVEJS_PLAYER_BOTS_ROSTER_SEED_ENABLED=1
EVEJS_PLAYER_BOTS_CONNECTION_WINDOW_MS=28800000
```

The dashboard persists these values in the EveJS game database; an environment
edit is only needed when changing deployment defaults. Dashboard changes take
effect without recreating the services.

```sh
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml \
  up -d --no-deps --force-recreate server playerbots-addon
```

The optional Compose command above only applies environment changes; it does
not start or recreate Market. The web seeder is the recommended way to grow the
roster. It defaults to 5 bots per batch and 15 seconds between batches; adjust
both in the Settings page. The supported ranges are 1–10 bots and 5–300
seconds. The server waits for two load samples before starting and enforces
hard caps of 250 ms event-loop p95, 95% EveJS process CPU, and 1,000 ms per
pilot creation. Settings can make seeding more cautious but cannot raise these
caps. The separate add-on process does the scheduling; only the authenticated
private API can request a batch.

The seeder never removes existing bots. If the current roster is above the
target, it reports the count and does not reduce it. `/playerbots seed 1500`
is a staff/admin shortcut that sets the target and enables gradual seeding; it
does not perform a synchronous bulk insert. Pause or resume it from the web
Settings page. The status panel shows the current roster, last batch, event
loop delay, and EveJS CPU. Keep growth enabled only while those measurements
and player-facing latency remain healthy. The presence scheduler independently
enforces the configured online cap (hard maximum 5,000) and rotation window.
`EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY` controls parallel work steps
(default 16); `EVEJS_PLAYER_BOTS_MAX_CONCURRENT_WORK` controls active durable
work (default 100); `EVEJS_PLAYER_BOTS_MAX_PER_SYSTEM` sets the normal
autonomous system limit (default 300). These settings do not change the roster
size. The server clamps active add-on steps as load rises: four above 50 ms
event-loop p95 or 70% CPU, two above 100 ms or 85% CPU, and one above 250 ms
or 95% CPU. The add-on logs the current effective limit. Bots may enter a full
system for bounded player orders or delivery work.

Each pilot now receives its own durable director decision job, so the fleet
does not wait for a synchronized five-minute assignment pass. First decisions
are staggered over 1–90 seconds. Recurring decisions use an independent
90–210 second interval by default, and finishing an operation immediately
triggers the next decision. Configure the server environment with
`EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MIN_MS`,
`EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MAX_MS`, and
`EVEJS_PLAYER_BOTS_DIRECTOR_INITIAL_SPREAD_MS`. Quantum Core carriers must
have persisted CEO, Director, or Station Manager authority. A non-CEO Director
can commission a structure owned by its corporation; after installation, the
pilot stays in that structure's system and resumes autonomous local work.

## Autonomous work and operation control

| Command | Use |
| --- | --- |
| `/playerbots autowork` or `status` | Show the autonomous director state. |
| `/playerbots autowork on` / `off` | Enable or disable the director (staff/admin only). Startup default is on; `EVEJS_PLAYER_BOTS_AUTOWORK=0` disables it at startup. |
| `/playerbots pause <bot>` / `/playerbots resume <bot>` | Pause or resume one bot's autonomous work. |
| `/playerbots corp pause` / `/playerbots corp resume` | Pause or resume controlled bots in your current corporation. |
| `/playerbots op status <bot>` | Inspect the bot's current durable operation. |
| `/playerbots op stop <bot>` / `resume <bot>` | Stop or resume its current operation. Check wallet and inventory first if it is in `review`. |
| `/playerbots mine <bot> [trips] [station <stationID>] [norefine] [nosell]` | Mine from asteroid belts, return when full or after the trip limit, unload and optionally refine/sell. `norefine` retains ore; `nosell` retains output for industry or later work. |
| `/playerbots colony <bot>` | Set up a passive PI colony. Once setup completes, the pilot returns to normal work; scheduled PI collection/export can be done independently. |
| `/playerbots haul <bot> <itemID|typeID> <fromStation> <toStation> [quantity]` | Haul personal hangar goods through the ship cargo hold, obeying capacity and route rules. |
| `/playerbots upgrade <bot> [mining|logistics|security|piracy|sovereignty] [force]` | Buy and fit the next role-appropriate ship. The old hull stays in the hangar. `force` bypasses the normal minimum wallet threshold, but purchases still use the bot wallet. |
| `/playerbots route <bot> <systemID|exact system name>` | Queue a durable stargate route; the bot undocks as needed and retries travel stages. |
| `/playerbots undock <bot>` | Undock a bot you control. |
| `/playerbots warp <bot> <entityID>` | Order a local warp to an entity. |
| `/playerbots dock <bot> <stationID>` | Order a dock using normal access and docking checks. |

Mining, hauling, sales, PI, industry, combat, and travel operations persist
their stages across restarts. A `holding` or `review` state is visible in
`/playerbots ops` and `/playerbots op status`; the server does not blindly
repeat an unconfirmed purchase.

### Mining and belt security

Miners lock an ore asteroid before activating their mining lasers. While in a
belt, they scan pirate NPC ships visible in their current grid within 250 km.
If the scan finds no rats, they keep mining without requesting or waiting for
an escort. If rats are visible, a security bot with a complete, online combat
fit for that system's risk is sent toward the belt while mining continues. The
required fit tier rises as system security falls; unknown system security
requires the strongest tier. The same corporation is preferred, then the
strongest fit that meets the requirement. A recent rat request takes priority
when a suitable security bot finishes its current operation; an insufficient
fit is upgraded first only when its skills, wallet, and profit allow it. A
missing eligible escort does not stop mining.
An empty belt is normal: belt rats are rolled on arrival by EveJS when enabled,
with a 25% default chance in high security. The scan reports current visible
rats; it does not create rats or treat an empty belt as a threat.

Stale armour/hull damage and NPCs outside the visible grid do not count as an
attack. During a mining trip, hostile activity causes a retreat only after the
mining ship or its assigned escort is destroyed. A full ore hold and the
normal trip time limit still send the miner home. `/playerbots op status
<bot>` reports the latest visible rat count and escort fit tier; its history
shows the asteroid approach, lock, laser activation, and cargo yield.

## Give a bot a saved fitting

The bot must be in your corporation or fleet, unless you are staff/admin. Save
the fit in the EVE fitting window or use a public community fitting, then send
one of these in a private chat with the bot:

```text
/fitbot <fittingID|fitting-link> [maxISK]
```

You can also send the fitting ID by itself, or a chat link containing
`fitting:<ID>` / `fittingID=<ID>`. From another chat, use:

```text
/playerbots fit <bot> <fittingID|fitting-link> [maxISK]
```

The fitting must be public, owned by you, or owned by a corporation/alliance
you share with the bot. The bot checks its trained skills and saved slot
assignments before buying anything, travels to safe market stock, acquires the
hull and missing fit items, then boards and fits the ship. The optional
`maxISK` caps spending. The bot will not spend its initial 1B ISK grant; only
wallet balance above that reserve is available for the fit. Modules, drones,
fighters, and fitting ammunition that fits in the standard cargo hold are
handled. Fitting ammunition is moved to the hull's standard cargo hold,
including charges saved in a weapon slot; load it into weapons through the
normal ship UI after delivery. A fitting that requires untrained skills or
unsupported item locations is rejected before purchase.

## Fleets and corporations

| Command | Use |
| --- | --- |
| `/playerbots invite <bot>` | Invite the bot to your corporation. Normal corporation permissions and roster limits apply; the bot accepts eligible invitations. |
| `/playerbots join <bot>` | Ask that bot's specialist corporation to invite you. Accept the invitation in the client. |
| `/playerbots fleet add <bot>` | Add the bot to your fleet; the bot accepts. |
| `/playerbots fleet join <bot>` | Ask the bot to form/join a fleet and invite you. Accept in the client. |

In fleet chat, issue movement orders to the managed bots that are members of
that fleet:

| Fleet-chat command | Use |
| --- | --- |
| `/follow` or `/follow me` | Follow your ship; all eligible playerbots in the fleet receive a durable order. |
| `/follow <exact fleet character>` | Follow another online human member of the same fleet. |
| `/follow stop` | Stop the bots' follow orders and return them to director-assigned work. |
| `/escort` or `/escort me` | Have fitted security-specialty bots follow your ship at close range. |
| `/escort <exact fleet character>` | Escort another online human member of the same fleet. |
| `/escort stop` | Stop only the escort orders. |
| `/attack` or `/attack all` | Order every fitted playerbot in your fleet to attack the most recently acquired target lock on your ship. |
| `/attack <exact bot name>` | Order one fitted fleet bot to attack your most recently acquired target lock. |
| `/attack stop` or `/attack stop all` | Recall drones and withdraw all attack orders you issued in this fleet. |
| `/attack stop <exact bot name>` | Recall drones and withdraw one of your attack orders. |

Follow orders route through stargates to the target's current system, then use
normal warp, approach, and docking authorities. The order tracks the target as
they move. If the fleet dissolves or no human remains, the order ends and the
bot returns to autonomous work. Mining can be stopped with its cargo preserved;
an industry cycle, combat withdrawal, courier package, or unresolved purchase
is allowed to reach a safe checkpoint before that bot accepts the movement
order. `/escort` only selects security bots with a validated combat fit; it
does not start an attack by itself. Fleet `/attack` uses the last target in your
lock sequence because EveJS does not expose a separate selected-target field
to chat commands. It accepts only a ship, never a capsule. Every bot must have
a validated security or piracy fit, and its own war, null-sec conflict, pirate
NPC and Crimewatch policy must allow that target; an illegal target is refused.
Bots approach or warp to the target, lock it through EveJS targeting, and engage
their fitted combat drones through the drone service. A disconnected commander,
dissolved fleet, changed/docked target, or revoked target legality triggers a
drone recall and return to the bot's home station. `/attack stop` withdraws only
orders issued by you. Other active mining/industry/combat work is not replaced
by a Fleet attack; mining can stop with cargo preserved.

When a human leaves or disconnects and only bots remain, a bot-only fleet is
dissolved and its members return to autonomous work. Ordinary fleet commands do
not cancel durable bot work; `/follow` and `/escort` are explicit movement
orders with the safe-interruption rules above.

## Industry and production

| Command | Use |
| --- | --- |
| `/playerbots industry cycle start <bot> <blueprintTypeID> <runs> <maxISK> [station <stationID>] [floor <ISK>]` | Run a durable personal-wallet manufacturing cycle. The spend cap includes blueprint, inputs, and job fees; the floor defaults to estimated break-even price. |
| `/playerbots industry cycle start <bot> <blueprintTypeID> <runs> <maxISK> [station <stationID>] [floor <ISK>] corp <hangarDivision 1-7> <walletDivision 1-7>` | Run a corp cycle with the selected shared hangar and wallet divisions. It uses stocked inputs only and checks normal Factory Manager, Take, and Trader roles. |
| `/playerbots industry cycle status <bot>` | Show stage, inputs, job, spend, output, proceeds, and history. |
| `/playerbots industry cycle stop <bot>` / `resume <bot>` | Stop or resume a cycle; installed jobs and inventory remain in place. |
| `/playerbots industry list <bot>` or `blueprints <bot>` | List the bot's blueprint assets. |
| `/playerbots industry jobs <bot>` | List the bot's industry jobs. |
| `/playerbots industry auto set <bot> <blueprintItemID> <runs 1-100> <maxISK per job>` | Enable the narrower in-place policy. It requires blueprint, materials, and funds already in personal hangar/wallet. |
| `/playerbots industry auto status <bot>` | Inspect its automatic industry policy. |
| `/playerbots industry auto off <bot>` | Disable the automatic policy. |

Eligible sale output is sold into accessible buy orders or listed outside Jita
when no buyer is available. Bot listings run for the maximum 90 days, have no
playerbot broker/SCC placement fee, and pay transaction tax only when filled.
Jita is the seed market for purchases; new playerbot sell orders are never
placed there.

## Planetary interaction

| Command | Use |
| --- | --- |
| `/playerbots task pi <bot>` | Queue PI extractor maintenance for the bot's own colonies. |
| `/playerbots pi export set <bot> <planetID> <maxUnits> <maxTaxISK>` | Enable recurring exports from an existing colony's command center. The bot pays normal export tax from its wallet. |
| `/playerbots pi export status <bot> <planetID>` | Inspect an export policy. |
| `/playerbots pi export off <bot> <planetID>` | Disable an export policy. |

The colony setup is a finite operation. Once planted, the bot can mine,
manufacture, haul, or sell while the colony produces; it need not wait at the
planet for the production cycle.

## Trade and market policies

| Command | Use |
| --- | --- |
| `/playerbots trade quote <bot> <typeID>` | Show accessible best local buy/sell quotes. |
| `/playerbots trade buy <bot> <typeID> <quantity> <maxUnitPrice>` | Buy immediately from local stock, capped at 100,000 units and 1B ISK per call. |
| `/playerbots trade sell <bot> <itemID> [quantity] <minUnitPrice>` | Sell personal hangar inventory into accessible local buy orders. This does not create a standing order or sell ships. |
| `/playerbots trade autosell set <bot> <typeID> <minUnitPrice> <maxUnits>` | Enable recurring sales of that type from the bot's current hangar. Unsold stock is listed for 90 days at the chosen floor; listing fees are waived. |
| `/playerbots trade autosell status <bot>` / `off <bot>` | Inspect or disable the auto-sale policy. |
| `/playerbots trade autobuy set <bot> <typeID> <maxUnitPrice> <targetStock> <maxSpendPerCycle>` | Enable recurring local restocking under the price ceiling, stock target, wallet, and per-cycle budget. It buys immediately and leaves no open buy order. |
| `/playerbots trade autobuy status <bot>` / `off <bot>` | Inspect or disable the auto-buy policy. |
| `/playerbots fund <bot> <ISK>` | Transfer your own ISK to a bot you control (up to 1B ISK per transfer). |
| `/playerbots courier post <issuerBot> <carrierBot> <startStation> <endStation> <itemID> <quantity> <rewardISK> <collateralISK>` | Publish a private courier contract from the issuer's personal hangar to the named carrier in the same corporation or alliance. The contract authority holds package, reward, and collateral. |

Auto-sale and export tasks reconcile their saved results before retrying after
a restart. If a task reports an uncertain outcome, inspect wallet, hangar,
market orders, and PI launch state before scheduling another one.

## Combat, sovereignty, structures, and alliances

| Command | Use |
| --- | --- |
| `/playerbots combat <bot> [security|war|piracy|nullsec-conflict]` | Start a durable combat assignment in the selected mode. |
| `/playerbots sovereignty <bot>` | Start sovereignty work for an eligible pilot and corporation. |
| `/playerbots build <bot> <structurePackageItemID> [nullSystemID]` | Carry an owned Upwell structure package to a reachable claimable null-sec system and deploy through the normal structure authorities. |
| `/playerbots alliance found <CEO bot>` | Start alliance founding for a corporation's eligible bot CEO. Skill, wallet reserve, and founding fee checks apply. |

Structure anchoring uses ordinary EveJS placement, corporation role, item
consumption, and timer rules. If the current grid is blocked, the carrier
warps beyond a celestial warp-in exclusion zone and retries after checking the
live placement rules. A deployed structure still needs its quantum core,
services, fuel, and online configuration through the relevant game systems.

An eligible first war uses the normal billable corporation-war timer. Its bot
corporations receive the one-time 5B ISK grant; up to five combat pilots can
receive ship stipends from that grant. A funded corporation first cross-trains
safe members already on its roster, then recruits security bots from bot-only
donor corporations if it still needs pilots. Ordinary sale, mining, PI, and
industry work continues while combat skills train. The director waits for the
current work to finish before buying and fitting the strongest hull the pilot
can currently fly and afford. Training progresses from Algos to Vexor,
Myrmidon, and Dominix. `/playerbots ops` shows funded stipends and
cross-mobilized pilots; `/playerbots op status <bot>` shows an individual ship
purchase, fitting, or patrol operation.

## Durable task controls

| Command | Use |
| --- | --- |
| `/playerbots task cancel <taskID>` | Cancel a queued or leased task you control. |
| `/playerbots task retry <taskID>` | Requeue a failed task you control, after checking any saved inventory/wallet reconciliation state. |
| `/playerbots seed [30-15,000]` | Staff/admin: set the target and enable safe gradual seeding within `EVEJS_PLAYER_BOTS_ROSTER_CEILING`; creation runs as bounded background batches. |

For installation, service lifecycle, API configuration, and rollback, see
`INSTALLATION.md` and `OPERATIONS.md` in this archive.

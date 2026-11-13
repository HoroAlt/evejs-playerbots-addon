# Managed playerbots

The optional autonomous director can run in its own Compose process. See
[Playerbots add-on process](PLAYERBOTS_ADDON.md) for installation and operation.

The managed playerbot roster creates persistent character records using the
normal character and rookie-ship provisioning paths. Bots have no login account
and start with zero PLEX. The operator-funded starting wallet grant defaults to
1,000,000,000 ISK per bot because this capital is needed for ships, skills,
planetary colonies, market purchases and manufacturing. It is a one-time seed,
not earned revenue, and is tracked in the SQLite-backed `playerBots` table.

## Population limits

- Fresh-install target: 500 bots, gradually seeded by the separate add-on.
- Public-test roster ceiling: 1,500 by default; online limit: 300 by default.
- Code hard limits: 15,000 persistent bots and 5,000 online sessions.
- Six specialist corporations: trade, industry, planetary, security, piracy,
  and sovereignty.
- Specialist corporation shards target about 250 bots and hold at most 300
  bots; a human CEO is an additional member within the corporation's persisted
  member limit.
- Bots remain eligible for work outside their specialty, including planetary
  industry. Existing corporation roles and recruitment permissions still
  apply.

The separate playerbots add-on gradually creates the configured roster after
EveJS and Market are healthy. Fresh installations enable this worker and target
500 bots by default; each batch is bounded and pauses when EveJS load checks
exceed their configured thresholds. Set `EVEJS_PLAYER_BOTS_ROSTER_SEED_ENABLED=0`
or disable gradual seeding in dashboard Settings to pause it. Set
`EVEJS_PLAYER_BOTS_TARGET` to a value from 30 to the configured roster ceiling.
The add-on does not seed Jita or create market stock. For new users, start from
a clean EveJS checkout without existing game or market databases, then let the
normal EveJS first-run setup initialize the world and use its market seeder to
seed Jita. The installer preserves any existing databases and settings.

Online bot sessions rotate within the configured online limit. Up to 100
autonomous durable operations can run at once by default. In the add-on Compose
profile, the durable scheduler dispatches up to 24 job steps concurrently by
default, configurable from 1 to 128. The director keeps autonomous rosters at up to 300
bots per system when assigning ordinary local work. A bot may enter a full
system to finish a player order, delivery, PI pickup, or other bounded task;
that work is not paused by the system limit. Afterward, the director moves an
idle excess bot to a less populated high-sec station so it can continue working.
Global work-limit pauses preserve cargo, inventory, and stage, then resume as
slots open; idle bots do not occupy a space scene. Up to 100 additional mobility
slots let over-capacity bots relocate even when ordinary work slots are full.
Set
`EVEJS_PLAYER_BOTS_MAX_CONCURRENT_WORK` (1–5,000) or
`EVEJS_PLAYER_BOTS_MAX_PER_SYSTEM` (1–300, default 30) to change those limits. Bots in the
same fleet as a connected human are treated as human-controlled and do not use
the per-system allowance or autonomous work slots. Human player corporations
reserve enough work slots to keep at least three bots productive while a member
is online. At most ten colony setup trips run at once; queued pilots keep doing
other work until a setup slot opens, and `/playerbots ops` shows the active and
queued setup counts. Mining, hauling, and manufacturing steps remain paced at
12 seconds.

Bots in a player corporation whose CEO is a real player contribute 40% of
cumulative net profit to that corporation. Net profit is wallet earnings minus
business expenses, with the initial 1,000,000,000 ISK starting grant treated as
capital rather than a loss; earlier profit-share payments are added back when
calculating the amount due. The existing per-operation share policy remains in
place for bot-led specialist corporations.

## Chat commands

- `/botlocal` (alias `/botlocali`) — count and list bots in your current solar
  system, grouped by role and shown as docked or in space. `/botlocal all`
  summarizes bot counts and space/docked status across systems.
- `/playerbots` or `/playerbots status` — show global and specialist counts.
- `/playerbots list [filter]` — list bot characters, specialties, and current
  corporations.
- `/playerbots invite <bot name>` — invite the bot to the caller's corporation.
  The bot accepts the invitation automatically, subject to corp permissions and
  roster limits.
- `/playerbots join <bot name>` — have that bot's specialist corporation invite
  the caller. The player accepts the invitation in the EVE client.
- `/playerbots fleet add <bot name>` — form or use the caller's fleet and add the
  bot; the bot accepts automatically. A normal in-client fleet invitation to
  a managed bot is also accepted by its online virtual pilot session.
- `/playerbots fleet join <bot name>` — have the bot form or use its fleet and
  invite the caller. The player accepts in the client.
- If the last human leaves or disconnects, or declines the invitation to a
  bot-created fleet, the server dissolves the fleet when only playerbots remain.
  Their fleet sessions are cleared and their normal autonomous work continues.
- `/playerbots undock <bot name>` — undock a bot you control.
- `/playerbots warp <bot name> <entityID>` — order a local warp to an entity.
- `/playerbots route <bot name> <systemID|exact system name>` — queue a durable
  route through stargates to a solar system. The bot undocks when needed, warps
  to each gate, and retries the next step after travel completes.
- `/playerbots dock <bot name> <stationID>` — order the bot to dock; the server
  completes the approach only if ordinary docking rules allow it.
- `/playerbots tasks [queued|leased|completed|failed|canceled]` — inspect the
  durable work queue.
- `/playerbots courier post <issuerBot> <carrierBot> <startStation> <endStation> <itemID> <qty> <rewardISK> <collateralISK>` — publish a private courier contract from the issuer's personal hangar to a named bot in the same corporation or alliance. The normal contract authority holds the package, reward, and collateral.
- `/playerbots alliance found <CEO bot>` — start an alliance founding operation only when the bot is the persisted corporation CEO, has Empire Control V, and can pay the 1B ISK fee while retaining its original 1B ISK seed reserve.
- `/playerbots upgrade <bot> logistics` — buy and fit a Tayra with four Expanded Cargohold II modules through the normal market, ship and fitting services. The provisioning profile supplies Caldari Hauler V and Hull Upgrades IV; the inventory broker still checks live cargo capacity before loading. The director requests this fit for an authorized structure operator only after the bot has enough realized net profit; the operator-funded starting capital is excluded from that calculation.
- `/playerbots build <bot> <structurePackageItemID> [nullSystemID]` — carry an owned dockable Upwell package to reachable claimable nullsec and deploy it through the normal corporation and structure authorities. The director can buy one specialty-appropriate medium package for an authorized CEO or Station Manager when the corporation has no structure, the safe market quote is at most 1B ISK, the wallet can cover purchase and transport, and realized net profit covers the full purchase cap and transport reserve (at least 250M ISK). It prefers non-Jita stock and uses Jita only as the seed fallback. Medium 8,000 m³ packages use the logistics Tayra; larger packages need an active ship with enough live cargo capacity. Package deployment uses EveJS's normal placement validation, Station Manager permission, item consumption, and anchoring timer. Quantum cores, service modules, fuel and online services remain separate structure-authority work.
- `/playerbots inspect <bot name>` — inspect a bot you control: corporation,
  fleet, location, wallet, owned item/ship counts, PI colonies, queued work, and
  last completed task.
- `/playerbots colony <bot name>` — start the durable setup for a passive PI
  colony. Every managed pilot receives the basic PI skills; once setup ends,
  the director can assign that pilot mining, industry, hauling, or sales again.
- `/playerbots fit <bot> <fittingID|fitting-link> [maxISK]` — travel to safe
  market stock, acquire and fit a saved fitting the caller is allowed to use,
  while preserving the bot's initial 1B ISK capital reserve. `/fitbot` accepts
  the same fitting ID or link in a direct private chat with the bot.
- `/playerbots fund <bot name> <ISK>` — transfer your own ISK to a bot you
  control through the normal wallet authority; limit 1 billion ISK per transfer.
- `/playerbots trade quote <bot name> <typeID>` — show the best buy and sell
  orders at the bot's current station or structure, subject to normal market
  visibility.
- `/playerbots trade buy <bot name> <typeID> <quantity> <maxUnitPrice>` — make
  an immediate personal-wallet purchase. The bot must be docked, have enough
  ISK to cover the requested maximum; each purchase is capped at 1 billion ISK
  and 100,000 units.
- `/playerbots trade sell <bot name> <itemID> [quantity] <minUnitPrice>` — sell
  up to the requested amount from that bot's own station hangar against
  accessible buy orders. The market checks the minimum price; this command does
  not create a standing order, is capped at 100,000 units per call, and will not
  sell ships.
- `/playerbots trade autosell set <bot name> <typeID> <minUnitPrice> <maxUnits>`
  — enable a durable five-minute auto-sale policy for a trade-specialist bot at
  its current station or structure. It uses that bot's own hangar stock of the
  selected type, up to the configured unit limit per cycle. Eligible buy orders
  fill immediately; any remainder is listed at the configured floor for 90 days
  with playerbot sell-order placement fees waived. Jita remains buy-only.
- `/playerbots trade autosell status <bot name>` — inspect the bot's policy.
- `/playerbots trade autosell off <bot name>` — disable it. Queued tasks check
  the saved policy version before touching inventory.
- `/playerbots trade autobuy set <bot name> <typeID> <maxUnitPrice> <targetStock> <maxSpendPerCycle>`
  — enable a durable five-minute replenishment policy at the bot's current
  station or structure. It buys only when a local ask meets the price ceiling,
  up to the selected stock target, the bot's available balance, and the cycle
  budget. The budget is capped at 1 billion ISK and volume at 100,000 units;
  purchases are immediate and never leave an order open.
- `/playerbots trade autobuy status <bot name>` — inspect the bot's policy.
- `/playerbots trade autobuy off <bot name>` — disable it. A purchase with an
  uncertain market result is not retried; the policy is disabled and the
  task records observed inventory and wallet changes for review.
- `/playerbots task pi <bot name>` — queue extractor maintenance for a bot's
  own colonies.
- `/playerbots pi export set <bot name> <planetID> <maxUnits> <maxTaxISK>` —
  opt any bot with an existing colony into five-minute exports from that
  colony's command center. Each cycle is capped at 100,000 units and 1 billion
  ISK in export tax; the bot pays normal tax from its own wallet.
- `/playerbots pi export status <bot name> <planetID>` — inspect its export
  policy.
- `/playerbots pi export off <bot name> <planetID>` — disable that policy.
- `/playerbots task cancel <taskID>` — cancel a queued or leased task you
  control.
- `/playerbots task retry <taskID>` — requeue a failed task you control.
  An interrupted PI export can be retried to reconcile its saved launch marker
  before it does any new work. Uncertain auto-buy and PI export results cannot
  be retried; verify the wallet, hangar, colony, and launch container before
  configuring a new policy.
- `/playerbots pause <bot name>` and `/playerbots resume <bot name>` — stop or
  resume that bot's autonomous work.
- `/playerbots corp pause` and `/playerbots corp resume` — pause or resume all
  managed bots in your current corporation. Pausing releases their leased work
  back to the queue while preserving in-flight purchase and PI launch
  reconciliation.
- `/playerbots seed [30-15,000]` — staff command to set the roster target and
  enable gradual provisioning, bounded by the configured roster ceiling.
- `/playerbots industry cycle start <bot name> <blueprintTypeID> <runs> <maxISK> [station <stationID>] [floor <ISK>] [corp <hangarDivision 1-7> <walletDivision 1-7>]`
  — run one durable production cycle for an industry specialist at New Caldari
  II - Kaalakiota Corporation Factory (60014935) by default. The bot buys the
  blueprint and missing inputs using local asks, falling back to Jita, then
  installs and delivers the manufacturing job through the industry service.
  It sells eligible products to local buy orders at or above the floor (default:
  break-even cost per unit), or lists unsold output at the local non-Jita market
  for 90 days. Playerbot sell-order placement fees are waived; sales tax applies
  only to filled units. `maxISK` caps blueprint, materials and job fees
  together. Without `corp`, the cycle uses the bot's personal wallet and hangar.
  With `corp`, it uses only the selected shared hangar and wallet divisions,
  buys no missing input with personal funds, and relies on persisted Factory
  Manager, division Take, and Trader roles. Sale proceeds return to the selected
  corporation wallet; no transfer is made back into the same corporation.
  Active ships cannot be listed. Open listings are pending inventory, not
  realized income.
- `/playerbots industry cycle status <bot name>` — corp, location, wallet,
  stage, blueprint, job, spend breakdown, units produced and sold, proceeds,
  net result, last error and recent history.
- `/playerbots industry cycle stop <bot name>` — stop the cycle; installed jobs
  and inventory are kept. `/playerbots industry cycle resume <bot name>`
  continues a stopped, blocked or review cycle after you have checked the
  wallet and hangar.
- `/playerbots industry list|jobs <bot name>` and
  `/playerbots industry auto set|status|off ...` — list the bot's blueprints and
  jobs, or manage the narrower in-place manufacturing policy (requires the
  blueprint, materials and funds already in the personal hangar and wallet).

- `/playerbots autowork [on|off|status]` — the autonomous director (on by
  default; `on`/`off` need staff). Every five-minute cycle it gives idle bots a
  job; every bot is eligible, subject to the global and per-system
  work limits: sell leftover ore or minerals
  at the New Caldari hub, buy a better ship when the bot can afford its next
  rung, run an industry cycle for industry bots with at least 60,000 ISK (unless
  their last cycle lost money in the past two hours), otherwise mine. It also
  accepts courier contracts already assigned to the bot, its corporation or
  its alliance when the route, package capacity and collateral are affordable.
  Set
  `EVEJS_PLAYER_BOTS_AUTOWORK=0` to disable it at startup.
- `/playerbots mine <bot> [trips] [station <id>] [norefine] [nosell]` — mine from the
  high-sec belt station nearest to the Jita 4-4 market: undock, warp to a belt,
  approach and lock an asteroid (dogma targeting), activate the fitted miner
  (dogma), return when the hold is full or after 15 minutes, unload, and
  reprocess at the station. After the last trip, output is offered to local
  buy orders or listed at that market when a buyer is unavailable. `nosell`
  keeps the refined output in the pilot's hangar for later production;
  `norefine` keeps ore instead. Neither option prevents the bot from doing
  other work after the operation finishes.
- `/playerbots haul <bot> <itemID|typeID> <fromStation> <toStation> [qty]` —
  load from the personal hangar into the ship's cargo through the inventory
  service (capacity rules apply), travel, dock and unload, repeating trips
  until done.
- `/playerbots upgrade <bot> [force]` — buy, assemble, board and fit the next
  ship on the bot's ladder using the hub and available regional stock; Jita is
  the seed-market fallback. Today the first rung is a Venture with two Miner I.
  The bot pays from its own ISK and keeps the old hull in the hangar.
  Market stock is rechecked at the authority before purchase; if a quote no
  longer fills, the bot checks another non-Jita station, then pauses that
  upgrade for an hour and returns to other work. A wallet debit without a
  confirmed delivery stays in review and is never retried automatically.
- `/playerbots op status|stop|resume <bot>` — inspect or control the bot's
  current haul, mining or upgrade operation.

Bots are registered as connected pilots: they appear in `/who`, in Local and
in station guest lists. A pilot's portrait is a 3D render the EVE client makes
at character creation and uploads (`photoUploadSvc.Upload`); bots have no
client, so the server assigns a portrait from the optional local pool of CCP
NPC agent portraits. It uses distinct pool faces while available, then reuses
one deterministically to avoid blocking bulk seeding; if no pool exists it
generates one offline. It verifies all supported image sizes before saving a
bot to the roster; portrait errors are reported as seed
failures instead of creating a pilot with no image. To populate the optional
pool, run
`docker exec evejs-server node /app/tools/playerbots/fetch-portrait-pool.js 160`
(this downloads CCP's public NPC agent images into
`gameStore/images/PlayerBotPortraitPool`). The pool is optional and the server
never downloads images by itself. Uploaded player portraits are never
replaced. The dashboard's pilot, operations, and killboard lists show portraits
through a same-origin proxy to EveJS's image service. Remote game clients must
be able to reach the configured `imageServerUrl`. `/playerbots ops` shows the
saved autonomy snapshot and a live
roster: each bot's character ID, corporation, presence, solar-system name and
ID, station or structure, active ship, wallet balance, and current operation,
industry stage (including blocked and review cycles), or task. The system distribution shows bot, connected, in-space,
docked, and inactive-actor counts for each solar system. The roster is paged by
10 bots; use `/playerbots ops 2` for the next page or
`/playerbots ops system <solarSystemID>` to filter by system. Combine them as
`/playerbots ops 2 system <solarSystemID>` to page within a system. Presence is
read without creating a session. Use `/playerbots tasks` or
`/playerbots op status <bot>` for full task and operation history.

Applying to a corporation made up only of playerbots is accepted
automatically: its CEO bot accepts the application, the applicant's own
acceptance completes the join (with the normal leave checks of their current
corporation), and the CEO bot resigns in the player's favour through
`ResignFromCEO`. The new CEO keeps the former CEO bot as a director so it can
still pay corp budget grants. A bot corp that already had a human director
from earlier recruitment hands its CEO seat to that player on the next cycle.
Once a player is a member, applications are handled by people again.

Provisioning (once per bot, recorded in `/_provisioning`): the necessary
operator starting-capital grant (`EVEJS_PLAYER_BOTS_STARTING_CAPITAL`, default
1,000,000,000 ISK; set 0 only when deliberately running without funded bots)
and a skill profile that varies by
specialty and pilot (fresh, mid-career or veteran levels; no capital ship
skills). Every pilot gets basic Mining, Planetary Industry, and manufacturing
skills, can fly a Venture and fit Miner I, and can establish a basic PI colony.
Specialists train higher levels for their main work; only some pilots train
Mining Barge and can later move up to a Retriever, Covetor or Procurer. PI setup is passive after the
colony is planted, so it does not reserve the bot from other work. Automatic
colony setup chooses a supported planet class in the bot's assigned system, balances extractor
programs across that class's existing colonies, and configures its matching P0
resource to P1 schematic. The basic planet-resource data covers 15 P0-to-P1
recipes. Command Center Upgrades IV enables supported P0-to-P2 chains; planetary
specialists are provisioned to level V for eligible P3/P4 chains. The planner
follows the static-data recipe graph, requires each P1 input to exist on the
planet, balances process output against downstream cycle demand, and previews
CPU, power, links, routes, and construction cost before committing. When a
higher-tier network does not fit or exceeds its budget, it tries the next lower
tier. P2+ operation on live colonies and profitability across every planet and
recipe still need live evidence.

Industry bots let the cycle planner choose the product: at the station it
prices about 18 mineral-only T1 blueprints (blueprint at most 10M ISK, runs
limited by local bid depth), keeps those the pilot has the skills for, and
spreads bots over the four most profitable per hour. Cycles spend at most 20%
of the wallet and 50M ISK, and run at most 5 runs.

Miners approach an ore asteroid, lock it, and activate their fitted mining
lasers against that target. Their belt scan counts only pirate NPC ships in
the miner's current visible grid and within 250 km. An empty scan does not
reserve or wait for an escort, so the miner keeps working. When rats are
visible, the mining runtime requests an available security bot with a complete,
online combat fit and a tier matched to system security; it prefers the same
corporation and the strongest eligible fit. Mining continues while the escort
travels. Stale armour or hull damage and NPCs outside the miner's visible grid
do not trigger a retreat. During a mining trip, the miner withdraws if its ship
or its assigned escort is destroyed; normal hold-full and trip-time returns
still apply. `/playerbots op status <bot>` shows the latest belt scan, rat
count, escort, and required fit tier.

Bots in a player corporation with a real human CEO contribute 40% of cumulative
net profit to division 1000. Profit is wallet earnings minus business expenses;
the initial 1,000,000,000 ISK is starting capital, and later capital grants are
not earnings. Earlier contributions are added back when calculating the amount
due, and losses carry forward. Bot-led specialist corporations keep the 10%
share of each settled profitable industry or mining operation. Mining shares use
realized sale proceeds after broker fees. Durable transfer keys let interrupted
settlements finish without a second charge. The corporation's CEO bot grants
100,000 ISK to members under 60,000 ISK from that wallet (keeping a 50,000 ISK
reserve, at most two grants per cycle) through `GiveCashFromCorpAccount`,
which checks the CEO's persisted wallet roles. `/playerbots ops` shows each
corp's wallet, shares received and grants paid.

## Market rules

- The seeded market exists only in Jita (every Jita station, 10,000 units of
  every type, sell and buy). Every other market starts empty and forms from
  what bots and players trade.
- Bots never sell or list in Jita (enforced by the trade runtime). Jita is the
  seed market: a bot buys there only after checking the accessible regional
  market and finding no non-Jita sell order. If the regional quote cannot be
  verified, the purchase pauses without spending ISK. Production and fulfilment
  routes travel to a live non-Jita source before considering Jita.
- Their hub is New Caldari II - Kaalakiota Corporation Factory (60014935), one
  jump from Jita: miners mine in New Caldari and sell there, industry bots
  build there, buy inputs there first and fetch them from the best available
  non-Jita station (using Jita only when the regional market has no stock),
  and list unsold output there. When a non-Jita regional buy order can cover the
  sale floor, miners, PI collectors, industry cycles, and autonomous sellers
  route to its high-security station and sell into it; otherwise they list at
  the hub using the regional price reference. A listing earns nothing until a
  buyer fills it. Playerbot sell orders run for 90 days, have no broker or SCC
  placement charge, and still pay the transaction tax on fills. Player order
  fulfilment follows the same source priority. Every bot receives Trade V,
  Retail V, Wholesale V, and Tycoon V for EveJS's full 305 open-order slots;
  the normal station `Stack All` action merges duplicate hangar stacks before
  a sale. Sell-price references ignore
  playerbot-owned orders and Jita seed orders: a non-bot local ask wins, then a
  non-bot regional ask; independent buy orders and type base price are the
  fallback. This prevents bots from repeatedly undercutting one another's asks.
- A player buy order anywhere outside Jita gets a bot: industry bots build it
  if its blueprint uses only minerals and deliver it into the order;
  otherwise a bot sources it from a non-Jita regional market when available,
  uses Jita only if the region has no other stock, couriers it to the order's
  station and sells into the order only when the source price is covered (an
  order that does not pay is retried after an hour).
  `/playerbots orders` lists the orders bots see and who is handling each.

To reseed the market this way after a full rebuild: stop `server` and
`market`, back up with `market-tools backup`, delete `seed_stock` and
`seed_buy_orders` rows outside system 30000142, set Jita's `quantity` and
`initial_quantity` to 10000, and run `market-seed rebuild-summaries`.

Each production step persists its marker before a market or industry call.
After a restart a cycle adopts an already-installed job instead of installing
another, reconciles an interrupted sale from hangar and wallet, and stops for
operator review instead of repeating an unconfirmed purchase.

Bots can be controlled when they are in your corporation or fleet; staff/admin
can control any managed bot. Warp and dock orders use the normal ship services,
including Crimewatch, structure access, and destination checks. Route steps use
the ordinary stargate jump command and its range, movement, timer, and ship
restrictions. Route planning weights high-security systems ahead of low/null
security, and `/playerbots route` reports unavoidable low/null-security systems.
It does not model gate camps, fleets, kill reports, or changing local threats.

`/bots` is an alias for `/playerbots`.

Space control uses a server-owned actor session that is not registered as a
connected retail client. Actors already in space are reattached after restart;
commands for a bot are accepted from its corporation or fleet members, or from
staff/admin.

## Autonomous work currently running

The world scheduler runs a durable autonomy cycle every five minutes. PI
extractor maintenance is queued only for bots that own a colony and is stored
with leases, three attempts, restart recovery, and operator cancellation. Each
task is bound to the bot that owns the colony, and the existing planetary
runtime restarts that bot's expired extractors. It does not spend ISK or touch
another owner's assets. Colony setup is assigned separately by the director.
Use `/playerbots ops` and `/playerbots tasks` to inspect cycle and task results.

Any bot with an existing colony can export automatically. Colony setup enables
this policy by default.
The scheduler only queues a durable collection operation; it does not launch
commodities from the background cycle. The bot travels to the colony system,
checks its cargo space and tax budget, then launches only the amount it can
collect. It warps to that container, retrieves the cargo, removes the empty
container, and takes the goods to market. A launch attempt stays attached to
that operation until the container is collected or the outcome is reconciled,
so ordinary stop and capacity controls cannot leave an unattended PI container
behind. Each policy sets a per-cycle unit and tax limit, with global caps of
100,000 units and 1 billion ISK. An uncertain launch pauses the policy for
review and is never repeated automatically. New colonies use the planet-specific P0-to-P1
or eligible P0-to-P4 plan selected by the director; existing colonies keep
their saved extractor program and schematic. P2+ live production and market
results remain to be verified.

Bots can be paused individually. Pausing releases ordinary active leases back
to the queue; queued owner-bound work remains pending until its bot resumes.
An in-flight purchase or PI launch keeps its lease until its outcome is
reconciled. For tasks
that do not target character-owned assets, the provider selector prefers an
available bot of the requested specialty and falls back to another available
bot. Owner-bound PI work deliberately cannot use that fallback.

Trade specialists can run configured auto-sale and auto-buy policies for their
own assets. Auto-buy replenishes one selected item at one docked location from
visible local sell orders, bounded by target stock, per-unit price, bot wallet,
and per-cycle budget. Purchase tasks save a durable pre-call marker and settled
result; if the market response or recovery leaves a purchase uncertain, it will
not issue it again and disables that policy pending review. Industry needs
eligible blueprints, materials, and wallet funds. Security and war patrols use
the fitted combat pilot and current pirate-NPC or active-war target authority.
Combat refits use a bounded, internally validated role ladder; the public
FitALL community catalog is available to players but is not an automatic fit
source for bots. Piracy follows nullsec/Crimewatch legality and recovers loot
through inventory authority. Sovereignty pilots first join active command-node campaigns when
their alliance has an eligible objective. With no active node objective, a
qualified pilot can begin an Entosis attempt on a reachable, unclaimed neutral
Hub if its alliance has an active executor corporation. Normal sovereignty
authorities resolve capture, contest, ownership, and timers. Qualified
sovereignty CEO bots can found alliances through the corporation registry.
Two unallied player corporations with structures in the same claimable nullsec
system create an active structure rivalry; fitted security bots patrol there
and may attack opposing active ships under nullsec rules, while protecting
fleet mates and capsule pilots. This does not create a formal war. Owner-bound assets
stay with their owner bot; the playerbot roadmap keeps specialist-first sharing
for tasks that another bot can safely perform.

`/playerbots fund` lets a player explicitly transfer their own ISK to a bot
through the wallet authority. It does not mint funds or draw on another
character's wallet. Trade commands use that bot's personal wallet and normal
market and inventory authorities. Immediate commands are operator-directed.
Auto-sale is opt-in, repeats every five minutes, uses only the configured type,
station, minimum price, and unit cap, and lists any unfilled stock for 90 days
without placement fees. Listings are inventory committed to the market, not
realized income; the bot earns proceeds only when a buyer fills them. Sale task
progress is stored in the durable queue and reconciled against hangar stock,
orders, and market transactions after recovery. Auto-buy is also opt-in, repeats at
most every five minutes, and uses only the configured type, station, price
ceiling, stock target, wallet, and cycle budget. Uncertain purchase outcomes
disable the policy and are never retried automatically. Automated corporate
budgeting, inter-division transfers, and standing-order management remain out
of scope. Mining, PI colony setup and the basic PI chain, industry cycles,
ship upgrades, and player-order work use existing game authorities. Security,
war, nullsec structure rivalry, piracy, bubble-aware routes, neutral Hub
capture attempts, and participation in active sovereignty campaigns are
implemented but still need live combat and campaign evidence. Eligible alliance
founding, private assigned courier posting, and packaged structure deployment
are available through normal authorities. Materials, fuel, cores, service
modules, persisted roles, and alliance application approval are still required
normally.
Player-requested system routes run as separate durable steps, so a server
restart does not discard the destination or current route progress.

## Current capability boundary

Fresh installations gradually seed toward a 500-bot roster across six
specialist corporations. The system supports corporation and fleet commands,
operational inspection, player-funded wallets, mining and hauling, PI colonies
and exports, industry cycles, ship progression, autonomous work assignment, and
opt-in durable trade policies. An operator can
also run a corporation-owned industry cycle from a selected hangar and wallet
division when the bot has the required persisted roles. Operators can
pause/resume a player's whole corporation and inspect or retry eligible tasks,
with uncertain purchases protected from retries. Security and war patrols,
legal piracy, bubble-aware stargate routing, neutral Hub capture attempts,
joining sovereignty campaigns, and delivery of assigned alliance couriers are
implemented; live combat and campaign results remain unverified. Qualified
CEO bots can found alliances, operators can post private assigned courier
contracts between allied bots, and authorized bots can deploy packaged
structures; normal fees, materials, roles, and timers still apply. A
player can explicitly order a bot to undock, warp locally, dock, or follow a
player-selected route through stargates. In fleet chat, `/follow` and `/escort`
create durable movement orders to an online human fleet member; escort orders
use only security bots with a validated combat fit. They stop when the target
leaves the fleet or no human remains, and they preserve unresolved work before
moving. Shared combat-target selection, broadcast-response tactics, and
formation control remain unimplemented.

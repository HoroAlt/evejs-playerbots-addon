# Playerbot roadmap

## Shared rules

- Keep 500 bots as the fresh-install starting target. The current public test
  is capped at 1,500 persistent and 300 online bots by default; the long-term hard
  limits remain 15,000 persistent and 5,000 online. Connection groups rotate
  on fixed eight-hour windows; validate larger rosters in stages.
- Keep six specialist corporations: trade, industry, planetary, security,
  piracy, and sovereignty. Target roughly 250 managed bots per shard and cap
  each corporation at 300. Use the existing
  corporation membership, wallet, hangar, fleet, and role authorities wherever
  they already cover the work.
- Send transferable work to the specialist corporation first. Cross-corp
  fallback must not move owned assets or bypass access roles. Open another
  shard as a specialty grows; never exceed 300 managed bots in one corporation.
- Bot decisions submit through existing wallet, market, inventory, industry,
  planetary, ship, war, crimewatch, structure, and sovereignty authorities.
  No free items, wallet top-ups, bypassed timers, or assumed war rights.
- Every corporation with playerbots and a dockable structure has one
  deterministic bot caretaker. When a corporation has no bot CEO, Director, or
  Station Manager, that bot receives Station Manager authority only in its
  playerbot actor session; persisted corporation member roles remain unchanged.
  The caretaker keeps structures powered and service fuel supplied while
  preserving a 150M ISK wallet reserve. Null-sec structures grant docking and
  tethering only to their owning corporation and its alliance; public access is
  never effective there.
- A task counts as completed only when the authoritative game state shows the
  result. Durable tasks must reconcile safely after restart and expose their
  status to operators.
- The per-bot operator-funded starting wallet grant remains 1,000,000,000 ISK
  by default. This is required seed capital for ship access, PI setup, market
  purchases and production, not revenue earned by the bots.
- Jita is a seed-market fallback. Bots never sell or list there and may buy
  there only when the accessible region has no non-Jita sell orders. A failed
  regional quote check pauses spending safely.
- Seed Jita only with EveJS's own default NPC-market seed data and supported
  seed process. Confirm the expected item coverage across Jita NPC stations;
  never manufacture substitute seed data or alter non-Jita markets to make a
  bot workflow appear successful.
- Unsold bot output is listed at a non-Jita market for the maximum supported
  order term (90 days). Playerbot sell-order placement fees are waived; sales
  tax is charged only on fills. An open listing is inventory awaiting a buyer,
  not realized revenue.
- Distribute the playerbots add-on as its versioned ZIP in `dist/`, committed
  alongside its repository source. Each ZIP must carry the integration overlay,
  installer, data assets and hash manifest for a supported real EveJS source
  version; verify it against that EveJS checkout before calling a release ready.
- Autonomous miners use their current safe station and sell locally or travel
  to a verified regional buyer; discretionary combat sites are assigned only
  when their system has capacity and no other bot owns that site. PI collection
  and player orders may still enter a full system to complete finite work.
- On a fresh roster the director disperses autonomous pilots before starting
  passive colony setup. The colony chooses a supported planet in the bot's
  assigned system, buys its kit through normal regional/Jita market supply,
  and travels back to that planet's system before submitting the PI edit.
- Relocation fills nearby systems up to the autonomous limit before opening
  more distant scenes; this keeps the fleet distributed without spawning one
  scene per pilot during startup.
- The director evaluates ordinary work for pilots already in a system within
  its capacity. Relocation capacity is checked only when relocation is the
  chosen assignment. The configurable autonomous occupancy limit is 300 bots
  per system; human-controlled fleet members do not consume that allowance.
- Limit simultaneous colony setup trips to ten; queue later setups while bots
  continue mining, hauling, trading, or industry. The active slots are reused
  as a colony is planted, preventing the full roster from travelling to Jita
  together for command centers. A pilot with a queued colony remains eligible
  for ordinary work until its PI setup slot opens.

## Mandatory follow-up gates from the operator (8 Nov 2026)

These requirements are part of the roadmap and must not be dropped when work is
split across releases. They are open until the corresponding live evidence is
recorded below.

- **Seed existing managed corporations.** Resume seeding into founded,
  managed specialty corporations before founding more shards. This includes
  `EVEJS Frontier Compact` when its human CEO is online or has taken over;
  grow this test corporation to 300 bot members (plus its human CEO), subject
  to the global connection safeguards. Verify corporation IDs and per-
  corporation bot counts on the live server.
  Treat Frontier Compact as a managed seed target for this trial despite its
  human CEO; preserve its real player-corporation identity, CEO, and role
  authority. The operator also requested maximum skills for the `krory90`
  test account; inspect its live skill state and record the result before
  relying on that test prerequisite.
  Do not silently put bots into unrelated player corps without an invitation
  or explicit membership policy.
- **Reserve sessions for a human's corporation.** Before filling ordinary
  connection rotations, reserve eligible online slots for every bot in a
  corporation whose human member is online. Respect the global ceiling and
  never disconnect a human or human-controlled fleet. If the ceiling cannot
  fit the whole corporation, show the shortfall in the dashboard and preserve
  the human's session; do not claim full presence.
- **Portraits for every bot.** Assign valid character portraits when new bots
  are created and repair missing portraits for existing bots. Verify actual
  image endpoints and in-client character/corporation views; a profile row or
  cached placeholder is not proof that the portrait renders.
- **GM transport destination resolution.** The GM panel's “transport to
  player” action must resolve its selected player as the destination without
  requiring the operator to type a second destination. Test valid online
  humans and playerbots through the panel; a valid selected character must not
  be rejected as “Transport destination not found.”
- **Configurable corporation doctrine in the web dashboard.** Let the operator
  assign multiple operating focuses to each represented corporation and make
  those focuses change director work selection. Keep bot specialty as its
  training profile, so a corporation can combine production, NPC security,
  player piracy, mining/trade and sovereignty without relabeling pilots.
  Configure Frontier Compact to combine industry with anti-pirate NPC work;
  `NPC security` must remain distinct from `player piracy`.
- **Player piracy is capsuleer PvP and theft.** Piracy corporations should use
  PvP fits, scout changing routes between nullsec and empire space, and may use
  mobile warp disruption bubbles on nullsec gates where the game allows them.
  In lowsec, select only legally engageable player targets and respect
  Crimewatch, fleet/corporation protection, cargo value and retreat risk.
  Patrol locations and timing must rotate using recent deployments and player
  traffic; do not leave permanent bubbles, continuously camp a single gate,
  attack protected pilots, or make ordinary travel predictably unsafe. NPC
  pirate hunting belongs to the separate security doctrine.
- **Mandatory EVE Online mechanics research.** Before expanding combat,
  piracy, mining, industry, PI, market, hauling, sovereignty or Upwell behavior,
  consult current authoritative EVE material and the corresponding EveJS game
  authorities. Record the mechanic, applicable security-space rules, ship and
  skill requirements, economic constraints, code path, tests, and live proof.
  Current official [manufacturing], [blueprint], [industry activity],
  [mining], [warp disruption], [personal deployable], [Crimewatch],
  [container ownership], [sovereignty] and [Upwell deployment] rules are
  required references, not optional background reading. For each mechanic,
  record what EveJS actually implements and what still differs from Tranquility.
- **Hull and production variety.** Do not leave the roster concentrated in
  Ventures and combat frigates. Research and build a role- and threat-aware
  progression across mining frigates, mining barges and exhumers, hauling
  hulls, combat frigates/destroyers/cruisers and larger hulls where skills,
  wallet, fittings, logistics and activity justify them. Add production
  progression for modules, ammunition, ships and their material chains.
  Choices must vary by trained skills, available ISK, local supply, system
  security, target/site tier, fleet composition and replacement cost; record
  actual hull distribution and successful use on the live server.
- **Independent work and fleet orders.** A human invitation to Fleet must be
  accepted through EveJS's fleet authority. While a human controls a Fleet,
  its bots obey `/follow`, `/escort`, and `/attack` against the commander's
  currently locked target, subject to range, fit, target legality and survival
  checks. When human control ends or a bot is left only with other bots, it
  leaves/dissolves the empty bot-only fleet safely and resumes its own work.
  Ordinary bot schedules must be staggered and concurrency configurable; bots
  must not wait idle for a shared long polling interval when a safe task or
  urgent player command is available. Live tests must show movement, target
  lock, approach, module activation, mining/engagement, return, unloading,
  market sale or listing, and recovery without repeated loops or stranded
  operations.
- **Human presence and productive availability.** When a human member of a
  bot corporation is online, connect every bot member of that corporation,
  subject to the global online ceiling; never silently evict unrelated human-
  controlled fleets to satisfy it. Keep at least three of those bots actively
  producing while the human remains online. Publish accurate bot presence on
  the applicable in-game corporation, fleet, local/system and location views;
  presence must follow the real session and must not fabricate a location or
  connected state.
- **Fleet fitting by private message.** A fleet bot can receive a saved fitting
  ID or fitting link in direct chat, travel to a suitable station, obtain and
  install the fit through normal inventory, market and fitting authorities,
  then report success or the precise blocker in chat. Do not create modules or
  bypass fitting, skill, wallet or custody restrictions.
- **Safe planetary collection.** Launch containers and other PI output must
  remain at the command center until an assigned collector is on the collection
  operation. Expose and retrieve the container only for that collection trip;
  do not leave unattended PI containers in space where another pilot can take
  them. Resume ordinary work after a successful pickup or a safe recovery.
- **English player-facing text.** Keep bot chat, system announcements, logs
  shown to players, dashboard labels and command responses in English. Keep
  operator guides and release documentation in English as well, with the full
  command reference and examples kept current.
- **Combat readiness and survival.** Select a complete fit for the actual
  hull, skills, weapon range, ammunition, capacitor, tank, NPC damage profile,
  site/anomaly tier and fleet support. Combatants must reload and manage
  capacitor, finish and loot an anomaly only when the dungeon authority
  confirms completion, and withdraw promptly when their fit, damage, tackle,
  ammunition, capacitor, or hostile strength makes the fight unsafe. Miners
  lock an asteroid, approach it, and activate the fitted laser through Dogma;
  they coordinate with a fit-qualified escort when belt rats are present and
  retreat if it cannot protect them. Measure live survival and earnings, not
  only simulated combat decisions.
- **NPC-caused playerbot deaths.** The live killboard showed 107 NPC final
  blows against playerbot victims. Audit the underlying killmails, ships,
  specialties, systems, active operations, fits, NPC strength and nearby
  escorts. Correct avoidable exposure with NPC detection, capability-matched
  fits, retreat thresholds, coordinated escorts and safer site selection;
  never hide NPC losses or claim success from a test fixture. Track subsequent
  NPC losses and survival/earnings over a sustained live window.
- **Killboard correctness and ship renders.** Show playerbot kills, playerbot
  losses, and NPC kills as distinct categories; never attribute NPC kills as
  player kills. Ship images must resolve for both attacker and victim using
  bundled EveJS/game assets or the official EVE image host. A same-origin,
  size-bounded proxy to the official host now serves renders and has focused
  tests; verify recent kill rows, loss rows, type labels, and image responses
  through the installed dashboard and embedded browser before closing this
  gate.
- **Structures and nullsec economy.** Each corporation with playerbots and a
  structure needs a deterministic caretaker that can legally maintain power,
  fuel and services even when a human is CEO. Prove package transport,
  anchoring and restart recovery, correct Quantum Core installation, permitted
  service commissioning, upkeep, docking restrictions to owner corporation
  and alliance, and actual use of the service. Corporations and alliances
  should exploit their owned and allied systems through mining, PI, industry,
  hauling, sales and security, while respecting system capacity and access.
  Unallied structure rivals need legal wars, suitable funded fleets, combat,
  structure objectives and post-war recovery; ownership, alliance and
  sovereignty remain separate authorities.
- **Scaling and operator controls.** Preserve the requested 10,000–15,000
  persistent-pilot range and up to 5,000 simultaneous connections as targets,
  not as proven capacity. Make population, connection schedule, concurrency,
  seeding safeguards and the 300-bot system limit visible and configurable in
  the dashboard. Keep every operation pageable/searchable across the full
  archive and expose kills, losses, ship types, corporations and ship renders.
  Scale only with staged soak evidence for login, command latency, database
  writes, memory, CPU, restart recovery and productive output.
- **Roadmap scope.** Keep Phase 1 PI and the complete basic mining, refining,
  industry and non-Jita sale loop together; Phase 2 includes shared corporate
  production, ship manufacturing, higher-tier PI and planning; Phase 3 includes
  combat, piracy, sovereignty, wars and structure construction/operation.
  Retain all requirements in this section until each has code, focused tests,
  packaging and the required live evidence.

The economic acceptance calculation is cumulative realized income minus all
eligible operating costs, with the initial 1,000,000,000 ISK seed excluded
from losses. A human-CEO corporation's bot owes 40% of positive cumulative net
profit; bot-led corporations retain their configured 10% share. Open market
orders are inventory still awaiting a buyer, not revenue. Prove the calculation
with a positive-profit live bot, both wallet journal sides, restart recovery,
and a second settlement that does not duplicate the transfer.

Every roadmap gate must be reported with four separate states: implemented,
focused tests passed, included in the versioned add-on ZIP and validated on the
supported real EveJS checkout, and live behavior proven. A code path or a test
fixture alone never closes a live gate. Keep this register as the canonical
record of the operator's requested behavior; update the gate and evidence
instead of deleting an unfinished requirement.

**NPC-loss root cause and first correction (8 Nov 2026):** the 107 audited
playerbot losses were 81 Ventures, 10 Ibises, 10 Algos, four Tristans and two
Procurers. Recent M-OEE8 killmails and operation histories showed miners
staying on-grid with visible Guristas after mining lasers stopped because no
security fit covered the belt's required tier. If the belt has visible rats
and no fit-qualified escort exists, mining now marks it dangerous and starts
the retreat immediately. If a qualified escort is assigned but does not
engage within 45 seconds, the miner also retreats. Focused tests cover both
paths and preserve the existing shield-damage and escort-destruction retreats.
The live audit still shows all 107 historical playerbot losses with Guristas
corporation `1000127` as final blow; 37 occurred on 8 Nov, most recently at
08:04 UTC in system `30000848`. The combat safety fix was deployed at 11:58
UTC. No
new bot-victim killmail appeared by 12:15 UTC, but this 17-minute post-deploy
window does not establish survival under active rat exposure. Keep the gate
open and continue the live audit.

**Live economy, hull, corp and structure audit (8 Nov 2026, 12:15 UTC):** a
read-only query of the remote GameStore and Market databases found 685 bot
profiles in 12 managed corporations (57–58 bots each). Frontier Compact is
corporation `98000006`, has 57 bots, and its non-bot CEO is Noura Sairento.
After the pass, the fleet remained hull-concentrated: 547 Ibis, 66 Ventures,
35 Tristans, 15 Algos, 10 Vexors, six Badgers, three Procurers, two Tayras and
one Dominix. The pass finished all 685 bot steps in 15 minutes 36 seconds with
zero failed steps and effective concurrency 1 of 4. The dashboard operation
API reported 6,141 records, 195 active, one holding and one in review; its
last page returned 41 unique rows. Filtering that same archive to active work
took 7.98 seconds. Counts prove coverage and visibility, not that every
operation completed its intended in-space action.

The Market database contains 364 filled bot sell orders for 187,474 units and
18,975,128.33 ISK gross, all in non-Jita systems, plus 5,869 open sell orders
for 141,552 units. Open orders are not sales. Bounded bot wallet journals
contain 83,231,627.40 ISK in `Market sale proceeds`, 4,985,912,001.22 ISK in
`Market purchase` debits and 4,763,097.29 ISK in sale tax. The filled-order
gross and retained wallet-sale total do not reconcile to one another yet, so
neither is treated as a fully reconciled lifetime ledger. Frontier Compact's
retained journals contain 8,621,899.32 ISK of market sale credits and
713,157,075.07 ISK of market purchases. Its only retained type-10 bot journal
entry is the 1,000,000,000 ISK first-war ship budget; there is no live proof
yet of a 40% positive-net-profit remittance. This does not prove a missed
payment because a qualifying positive cumulative net profit has not been
established.

Five structures are persisted: four have a core installed and records in
state `110`/upkeep `1`; Frontier Compact's Astrahus is among them. The fifth is
in state `2`/upkeep `2` with no core. Verify services, fuel and actual service
use before closing the structure gate. At this snapshot the active 685-bot
autonomy pass was at 500/685 with zero failures and effective concurrency 1
of a configured maximum of 4. EveJS used 137.4% CPU and 5.70 GiB RAM; the
standalone add-on used under 1% CPU. Dashboard `/` returned HTTP 200 in 15 ms,
but the earlier seed-status API timed out. The live session, performance,
productive-cycle and dashboard API gates remain open.

The installed dashboard's killboard API returned HTTP 200 and separated 446
killmails into 331 NPC deaths, 107 playerbot deaths and 339 playerbot final
blows. Its latest 100 rows classified 59 bot losses with NPC final blows and
41 NPC losses with bot final blows. The dashboard ship-render proxy returned
valid 64×64 JPEGs for both Ibis and Venture. This verifies API classification
and image responses; a visual browser check and a newly recorded safe mining
window remain open. After the 685-step pass, EveJS sampled at 106.5% CPU and
6.24 GiB of 7.67 GiB memory; the separate add-on used 0.1% CPU and 67.77 MiB.

## Current remote test snapshot — 8 Nov 2026

At 17:53 UTC, the remote dashboard reported 1,339 persistent bots, 1,338
connected sessions and 80 in-space ships. At 17:57 UTC, the persisted target,
roster ceiling and online limit were all set to 1,500 for the public test.
Manifest held 795 bots despite the configured 300-bot autonomous system cap;
relocation enforcement is therefore an open defect. Four structures were
powered and cored; a fifth Astrahus was anchoring at low power without a core.
No sovereignty systems were claimed and no wars were active. This is live
playerbot activity, but it does not prove completed production sales,
commissioned fifth structure, sovereignty or war outcomes.

## Foundation already in place

The server defaults to a persistent 500-bot roster target. The public test
profile caps the roster and online sessions at 1,500; code hard limits remain
15,000 pilots and 5,000 sessions. Six specialist corporations, corporate
and fleet invitations, durable pause/resume and task
controls, local ship commands, and player-directed stargate routes. Every bot is
cross-trained in basic mining, PI, and manufacturing. The five-minute autonomy
scheduler supports owner-bound PI colony setup, extractor maintenance, bounded
trade policies, and PI exports. Colony setup is passive after planting, so the
director can return the bot to other productive work.

## Phase 1 — corporate industry, planetary production and a working economy (PI collection proven; live sale and ship-chain proof open)

**Goal:** an industry bot produces a real item through the existing game
services, and the production loop can earn and reuse ISK. This phase is not
complete when a command exists or a job is merely queued.

1. **Put the existing corps to work.** Keep industrial bots in the industry
   corporation. Use its member roles, wallet divisions, and hangar divisions
   for shared inputs and outputs when the bot has the required persisted roles;
   otherwise keep a clearly identified personal-wallet path. Do not silently
   grant director or wallet access.
2. **Reach a supported market and facility.** Use existing route and docking
   services to get bots to a station with market stock and an industry service.
   Do not assume a station has market seed stock just because it has a hangar.
3. **Acquire inputs through the market.** Obtain a blueprint and missing
   materials using the normal market service and an explicit per-job and
   per-cycle budget. Verify inventory and wallet changes. If the price, stock,
   skills, roles, or balance fail validation, wait and report why.
4. **Manufacture and deliver.** Requote from current state, then install and
   deliver using the ordinary industry manager, blueprint custody, wallet, and
   output-capacity checks. Keep work bound to the corporation or character that
   owns the blueprint and materials.
5. **Sell and account for the product.** Offer finished items through the
   normal market service at bounded prices and quantities. Fill eligible
   non-Jita player buy orders when they cover the cost floor; otherwise list
   output for 90 days without a placement fee. Track input costs, industry
   fees, realized proceeds, open listings, and net result. Reinvest only within
   configured capital limits.
6. **Make recovery safe and visible.** Persist task progress before a market or
   industry action. Reconcile ambiguous results before retrying. Show corp,
   bot, facility, assets, job, spend, sale result, and last error through
   `/playerbots ops`, `tasks`, `inspect`, and industry commands.

Planetary production is also part of Phase 1. Any bot with the basic PI skills
can establish a colony through the normal PI authority, then return to its other
work while scheduled tasks maintain extraction, export and collect output.
Provisioning applies the basic PI skill floor across all six specialties; colony
setup does not reserve bots from mining, industry, hauling, or sales. The first
live rollout used Base Metals on Barren planets into Reactive Metals. The colony
planner now selects a supported planet class in the bot's assigned system and balances each class's raw
P0 resources against existing ECU programs. Its basic factories use the matching
P1 schematic for each of the 15 supported P0 resources. This covers the basic
planet/resource variables without holding a bot in PI work. Command Center
Upgrades IV enables supported same-planet P0-to-P2 chains; planetary specialists
are provisioned to level V for eligible P3/P4 chains. The planner traverses the
static schematic graph, requires locally extractable P0 inputs, orders process
pins topologically, checks that upstream output covers downstream cycle demand,
and preflights CPU, power, routes, and construction cost. If a plan does not fit
or exceeds the colony budget, it falls back one tier at a time. Synthetic P0-to-P4
coverage now passes; live P2+ production and profitability still need evidence.

PI export policies are reconciled from owned colonies: colonies with no policy
receive the standard bounded export policy; an explicitly disabled policy or
one disabled for an uncertain launch is left disabled. Industry-cycle and
mining-operation corp-share transfers are idempotent and settle before those
operations are marked complete. Market transaction tax uses the current 7.5%
base rate before Accounting reductions.

On 5 Nov 2026, automated PI setup was expanded from the original Barren recipe
to planet-specific Command Centers and balanced P0-to-P1 plans, then generalized
to supported P0-to-P4 schematic chains. The planner stores each selected target
before buying or planting, and the director can return the pilot to mining,
industry, hauling, or sales after the colony is established. Higher-tier plans
remain bounded by live network preflight and the 35,000,000 ISK colony budget.
Live verification of P2+ production and sale remains open.

Observed 4 Nov 2026: Raika Aikinen established a Barren colony on Jita I
(40009077), with five Base Metals extractor heads, a Reactive Metals basic
factory, two links and two routes. The normal market supplied the command
center and a Badger; the bot returned to its Venture and the director assigned
it other work. The live extractor delivered 403 Base Metals to the factory
while Raika mined elsewhere. Six bots then exported 120 Reactive Metals in total (20 each; 7,200 ISK in PI
taxes); collectors loaded their launch containers and listed the output at New
Caldari. No local buy orders existed, so none sold and the sell orders remain
open for buyers. At the 22:54 UTC live check, 17 colonies had active export
policies and PI maintenance reported no failures; colony assignments continue
progressively as bots finish their current operations. The periodic PI and
director work continued while extraction ran. An isolated three-hour
simulation of that network, with a hypothetical extended extractor program,
delivered 20 Reactive Metals to the command center; it did not alter live
colony state.

**Historical pre-recovery audit (8 Nov 2026):** the 100-bot cycle completed with
zero failures. Structure caretaker Otsen Yakeno bought a manufacturing service
module and 2,016 fuel blocks through seeded market orders, loaded them into a
Tayra, and began a 10-jump route to the corporation's low-power Astrahus. The
service is not counted as commissioned until the structure authority confirms
full power and an online manufacturing module. The same audit found 14 PI
collection operations in `review` after the old `storedLaunchID is not defined`
failure. Each had a tax debit but no committed launch. Before the recovery fix,
those operations were correctly held instead of being retried from ambiguous
state.

**Live PI recovery (8 Nov 2026):** the new recovery verified
all 14 attempts against their original `storedLaunchID` error, one exact wallet
tax debit per pilot, no launch record since the attempt (including deleted
records), and no operation receipt. It returned exactly 94,680 ISK across 14
stable idempotency receipts. All 14 operations left `review` and resumed as
active PI work; no duplicate refund was recorded. This proves the legacy
failure can be reconciled safely. The renewed exports still need observation
through collection and market listing or sale before this PI recovery cycle is
considered complete.

### Phase 1 completion gate

- At least one bot in the existing industry corporation buys or uses a real
  blueprint and inputs without creating them for free.
- The industry authority records a completed job and delivers the product to
  its saved owner location.
- A product is sold through the regular market authority, or the bot reports
  the exact market/price reason it cannot sell yet.
- Wallet, inventory, job, and task results agree; restarting the server does
  not duplicate a purchase, job, output, or sale.
- `/playerbots ops` reports the working loop and its ISK results. The same
  bounded policy can be enabled for the other industry bots when they have
  capital and corporate access.

**Initial live starting state:** the seven industry bots had no blueprints and
were docked at Manifest V in the Exordium region, while seeded market stock was
at stations elsewhere. The first production loop had to travel lawfully and
acquire inputs through the market. Later live cycles established the mining
and PI input paths described above.

**Completion evidence (4 Nov 2026, live server):** industry bot Katsen Isokawa
(corp 98000002, EVEJS Industrial Union) was funded with 100,000 ISK by a
player transfer through `/playerbots fund`. Its cycle travelled 12 jumps from
Manifest V to Jita, docked at Jita IV - Moon 4 (60003760) and bought a Civilian
Shield Booster Blueprint (3,677.55 ISK) and 142 Tritanium, 48 Pyerite and 2
Mexallon (19,200.00 ISK) from seeded sell orders. It installed job
970000000000000 (2 runs, 58.00 ISK fee), delivered 2 Civilian Shield Boosters
to its personal hangar, and sold both to existing buy orders at 18,179.38 ISK
for 33,783.67 ISK net. Result: +10,848.12 ISK. The wallet went from
96,388.82 to 107,236.94 ISK, matching spend and proceeds exactly. Two server
restarts during the cycle (one during manufacturing, one after completion)
neither duplicated the job nor lost the result. A first attempt at Ytiri
Storage (60000361) stopped with the exact reason that station has no industry
service; its 3,611.18 ISK blueprint stays in the bot's hangar there. The cycle
now validates the facility before starting.

**PI crash-safety and sale-capacity evidence (8 Nov 2026):** after the fix
deployment, a new PI export for Soryn Tashimo wrote one operation-scoped launch
receipt, one matching 4,800 ISK wallet debit, and one physical container with
80 Water. The bot collected all 80 units and removed the empty container. The
sale did not complete: the character already had all 41 market-order slots in
use, and the director immediately retried the same sale. The fix raises
the shared Retail floor to V (57 slots) and defers a completed order-cap
failure for one five-minute interval while the bot performs other work. The
post-fix market state shows Soryn at Retail V with 57 slots and new Water
orders at New Caldari for 90 days. The sale operation has not yet reconciled
its full ledger, so no completed PI sale or fill is claimed. The live listing
also exposed multiple separate stacks of Water, each consuming a market-order
slot. A follow-up fix runs the normal inventory `Stack All` action through the
bound station inventory before listing. The runtime test confirms stack-before-
listing, and its live sale evidence is recorded below.

**Long-lived market orders and capacity (8 Nov 2026):** after the fix
was installed on the remote 261028.1 server, the recovered Soryn sale posted
5,000 Tritanium at New Caldari for the full 90 days. No local buyer existed and
the order remained open with zero proceeds; this proves listing, not a fill.
Soryn also had 12 earlier Water orders totaling 640 units. A read-only audit
found other bots with up to 113 open orders because their role profiles
already had Wholesale III. The common 57-slot floor was therefore inadequate
for sustained production when buyers are absent, and hangar stacking cannot
combine stock already escrowed by existing orders. A separate fix raises
Trade, Retail, Wholesale, and Tycoon to V for every bot, matching EveJS's
maximum 305 order slots, without changing existing orders or seed capital.
Focused and full isolated test suites passed. The ZIP passed hash audit and
dry-run/install/rollback against a disposable EveJS 261028.1 checkout with the
`.env` and database probe hashes unchanged. Commit `7d5164a` is pushed, and the
ZIP is installed on the remote Server Panel. All 100 pilots now have the four
market capacity skills at V and 305 order slots; provisioning raised 295
skills without granting capital again. The next 100-bot cycle finished in
69.6 seconds with zero failures, and all three services are healthy. A read-only
market audit found 4,246 playerbot sell orders across 98 sellers, with a
maximum of 113 orders for one owner; 21 pilots exceed the former 57-slot floor
and none exceed 305. Orders remain intact. A wallet-authority snapshot also
contains 874 retained seller transactions from 88 bots: 864 match seller
wallet-journal credits totaling 85,351,097.53 ISK, against 86,341,302.31 ISK
gross transaction value. Those retained transactions span 6 Nov through
01:00:37 UTC on 8 Nov; no fill after the deployment cycle is claimed.
Ten older transactions lack a matching entry in the bounded journal and are
excluded from credited revenue. New listings still need buyers to realize
proceeds.

Known follow-ups: one write of the cycle record was lost across a restart right
after the industry install (the job, the wallet and the items persisted; the
cycle adopted the job on recovery). The cause in the gameStore flush path is
still to be found.

On 5 Nov 2026, automated listings were changed to use the market's maximum
90-day term and to waive broker and SCC order-placement charges for playerbot
actors. The market authority still applies transaction tax when an order fills.
No-buyer output remains in open orders and contributes no sale proceeds or
corporation profit share until reconciled as sold. The listing wrapper and
industry, colony and mining sale paths are covered by isolated playerbot tests.

Live check on 6 Nov 2026: four five-run industry jobs completed and delivered
500 output units each to their owners. No local buy orders existed, so the bots
placed four 90-day sell orders at New Caldari (60014935); all remained open,
with zero broker fees and zero realized proceeds. Their ledgers keep the sale
result pending, so the listed inventory did not create a corporation donation
or a claimed realized loss. A separate cycle stopped safely at the hub when
neither the regional market nor Jita IV - Moon 4 had Pyerite available. A
read-only market audit then showed that 4-4 itself was depleted while the
other 17 seeded NPC stations in the Jita system each still held 10,000 units
of Pyerite and Mexallon before the later bot purchase. Type 34 Tritanium
remained seeded at all 18 stations; the 4-4 stockout therefore did not prove a
Jita-wide stockout.
This verifies manufacture and free long-term listing, but the four products
still need buyers before this is evidence of realized profit.

On 6 Nov 2026, the planner was corrected to rank all seeded Jita stations by
the exact requested quantities and route industry, ship-upgrade, player-order
courier, PI-kit, and structure-service purchases around an exhausted station.
Regional non-Jita orders are still checked first. After deploying the route
planner fix, industry bot Raika Endashi routed around depleted 4-4 to stocked
Jita NPC station 60000361,
bought 2,586 Mexallon (type 36) at 100 ISK per unit for 258,600 ISK, loaded
the same quantity into its ship, returned, and delivered it to New Caldari.
Its market transaction, inventory transfer, and industry purchase ledger
agreed; the purchase left 7,414 Mexallon at station 60000361. Isolated tests
cover station selection, industry rerouting and costing, player-order courier
fallback, and structure-service source planning. PI-kit and structure-use
live evidence remain open.

**Market audit and correction (6 Nov 2026):** a read-only audit found an
industry listing made at New Caldari whose 100-unit sale was filled by a
Jita-located NPC buyer through regional order range. The items and wallet
credit had settled, but the cycle's local-station-only transaction filter left
it in review. This violated the Jita seed-only rule. The market policy fix blocks
bot sales to every Jita-located buyer, rejects listings placed in Jita, and
reconciles legacy pending listings against transaction, order, inventory, and
the exact wallet journal entry so settled stock is never sold twice. Live
recovery on 6 Nov resumed Tovil Endashi's pending 100-unit Scourge Torpedo
cycle. It matched the single historical Jita transaction and its sale/tax
journal entries, credited 2,674,900.36 ISK net, cleared the pending marker, and
completed at a 2,533,924.96 ISK cycle cash result without relisting any item.
The separate add-on then completed its 100-bot autonomy cycle with zero
failures. Isolated tests verify that new playerbot sales exclude Jita; a fresh
live fill at a non-Jita buyer remains the final market-policy evidence gate.

**Timed-out industry listing recovery (6 Nov 2026):** a read-only audit found
Soryn Tashimo's 100 newly manufactured Inferno Auto-Targeting Cruise Missile I
still in the New Caldari hangar after an uncertain listing at 05:09Z. The
wallet had not changed, there was no new transaction, and existing order 498
had not changed since 01:25Z, but the cycle had stayed in `review`. The recovery
logic records full open-order snapshots and automatically retries only after
two spaced authority reads prove no inventory, wallet, transaction, or order
effect. Changed or unreadable state remains a manual review. Isolated tests
cover safe retry and changed-state refusal; the remote cycle was left to
recover through the deployed add-on without direct database edits.

After deployment on 6 Nov, the pending listing recovered without reselling or
changing the wallet. The next attempt still could not list Soryn's output. A
read-only audit found 13 open personal orders and Trade II, whose authority
limit is exactly 13. The skill-profile fix raises the minimum common market profile
to Trade III and Retail III (41 order slots), and retains the exact market
rejection in the cycle status. Isolated tests cover the skill floor, safe
recovery and visible rejection. On the remote universe, all 100 bot profiles
now have the higher skills, but Soryn's output remains in the New Caldari
hangar and the listing is still rejected; no order or sale was duplicated.
The listing did succeed on the next scheduled retry: market order 1617 is open
at New Caldari for all 100 missiles at 40,756.25 ISK, with a 90-day duration
and no placement fee. The item is in market escrow and no buyer has filled it
yet, so the non-Jita realized-sale gate remains open. The prior error remained
visible after the successful listing because completed cycles kept a stale
`lastError`. The listing fix extracts details from wrapped EveJS `UserError`
responses, clears stale errors after successful listings, and hides them for
already completed listings. Live non-Jita fill and human-CEO share
evidence remain open.

## Phase 2 — mining, hauling, refining and resource supply (largely delivered)

**Goal:** materials the industry corp consumes come from bot work that is
visible and accounted for, not only from seeded market stock.

Delivered (each one a durable, restart-safe operation driven by the same
per-bot step job as the industry cycle):

1. **Shared operation scheduler.** Haul, mining and ship-upgrade operations
   share the industry cycle's durable step job and status surfaces. A bot runs
   one operation or one cycle at a time.
2. **Cargo and hauling.** `invbroker` moves between hangar, cargo bay and ore
   hold with the regular capacity and access checks. Verified live: a bot
   carried a blueprint from Ytiri Storage to Jita 4-4.
3. **Mining.** Undock, warp to a belt, approach, lock through dogma targeting,
   activate the fitted miner through dogma, return when the hold is full or
   after 15 minutes. Verified live: 11 bots mining in Yulai with ore credited
   by the server's mining cycle.
   A later combat correction fixes the earlier policy that treated any nearby
   rat or persisted ship damage as a reason to flee. It caused false retreats
   and stale dangerous-belt cooldowns. The current correction scans only
   pirate NPC ships visible in the miner's grid and within 250 km. It continues
   without an escort when none are present and requests a security bot with a
   complete fit tier matched
   to system security when rats are visible. The miner keeps working while the
   escort travels and withdraws if the miner's ship or assigned escort is
   destroyed. `/playerbots op status` reports scan count and fit tier. Focused
   tests cover empty scans, visible rats, fit selection, laser targeting, and
   the destroyed-escort retreat. Live proof against a spawned belt-rat group
   remains open.
4. **Refining.** Mined ore is reprocessed at the base station through the
   reprocessing service (station yield and tax).
5. **Supply to industry (in progress).** Miners can sell missing materials to
   waiting industry cycles at the bot hub (New Caldari) through private contracts,
   then list the rest there. Contract purchases reserve the buyer's remaining
   budget and must reconcile the accepted contract, wallet and inventory; an
   uncertain result stops for review. Buyers travel to available regional
   sources before the Jita seed market. Older Jita cycles now move their own blueprints
   and inputs to the hub through normal cargo and navigation. The migration of
   Katsen Valkanen and Yorun Aikinen has been observed live. On 4 Nov 2026,
   Katsen Isokawa supplied 15,512 Tritanium to Yorun Aikinen through contract
   980000017 for 31,024 ISK; Yorun's cycle adopted the delivery and installed
   industry job 970000000000004. Its manufacture and sale are still running.
6. **Player demand (delivered).** A player's buy order outside Jita is
   built by an industry bot when it is mineral-only, otherwise sourced from a
   non-Jita regional sell order first; Jita is used only if the region has no
   other stock and the delivery still pays.

## Phase 3 — corporate growth and a broader earned economy (implementation delivered; live evidence open)

1. **Corporation budgets (delivered).** Bots in a corporation with a human CEO
   contribute 40% of cumulative net profit through the account service. The
   initial 1,000,000,000 ISK grant is excluded, later external funding is
   tracked, operating costs reduce profit, and earlier contributions are added
   back when calculating the amount due. Bot-led specialist corporations keep
   the 10% share of each settled profitable operation. Transfers use durable
   idempotency keys and recover after a lost response. The CEO bot grants
   members out of capital from the corp wallet, within reserve and per-cycle
   limits, using its persisted roles.
2. **Autonomous director (delivered).** Idle bots are assigned work every five
   minutes, including colony setup and PI collection, sales, ship upgrades,
   industry, mining, and player orders.
3. **Ship progression (delivered for supported roles; live progression evidence open).** Bots buy, assemble, board and fit a
   Venture with two Miner I, or a Procurer with a strip miner when their skills
   permit it. Both were observed live; bots setting up colonies also buy and use a Badger to
   carry colony equipment. When an older upgrade lacks skills, the hull and modules
   remain in the hangar and the bot resumes work in a fitted Venture. Combat
   hulls remain part of the later security phase. On 4 Nov 2026, Kiyora
   Endashi recovered from an empty hub market by carrying its existing modules
   to Jita, buying and boarding a Venture, then returning to director-assigned
   mining.
   If an ask no longer fills, the upgrade checks another non-Jita station; when
   no executable supply remains, the upgrade is deferred for an hour and the
   bot returns to productive work. A wallet debit without confirmed delivery
   stays in review instead of being retried.
4. **Players in bot corps (delivered).** Applying to an all-bot corporation is
   accepted by its CEO bot, and the applicant is made a director. Verified live
   with a test character.
5. **Reinvestment (delivered, bounded).** Industry bots with capital keep
   running cycles; negative cash flow sends them mining for two hours. Listed
   stock is reported separately and its final result remains pending until the
   orders can be reconciled. New order listings save a marker first and compare
   the resulting order with inventory and wallet changes. If the planner finds
   no viable product, the bot works elsewhere before checking again; Otsen
   Oniseki was observed returning to mining after such a plan.
6. **Longer chains (supported recipes implemented; end-to-end live proof open).** The cycle builds any supported blueprint,
   ships included; the autonomous planner also considers Venture, Badger and
   Rifter when market prices and stock justify them. Owned minerals can be
   planned using a market reference value. Materials present before the cycle
   have no recorded historical cost, so their estimated value protects the
   selling floor and the accounting result stays pending rather than claiming
   a realised profit. A complete bot-mined ship chain still needs live proof.
7. **Shared corporate manufacturing (implemented; live proof open).** An
   operator may start a cycle with `corp <hangarDivision> <walletDivision>`.
   It uses only the selected corporation hangar, charges the selected wallet
   division, and sells or lists output back to that division's wallet. The
   industry, hangar, wallet, and market authorities enforce the bot's persisted
   Factory Manager, division Take, and Trader roles; missing stock is not bought
   with personal ISK. This mode does not make a self-transfer profit share from
   corporate proceeds.

## Phase 4 — security, PvE, war, and piracy (implemented; cross-training funding fix packaged; live readiness and combat gates open)

Security specialists patrol belt rats and attack only NPC ships identified as
pirate factions when there is no active war. If their character is a legal
participant in an active war, the director switches them to a war patrol and
routes toward a reachable online opponent identified by the server's war
authority. It selects only player ships the active-war authority identifies as
legal opponents. Piracy specialists may attack cargo-bearing non-friendly
ships in ordinary nullsec. In Empire space, a player target must already be an
outlaw, suspect, criminal, in a limited engagement, or an active war opponent.
Capsules, managed bots, corporation/alliance members, and fleet mates are
excluded. All attacks still go through the drone, Dogma, Crimewatch, and war
authorities.

Piracy pilots use the fitted Tristan and Hobgoblin drones. Security pilots with
the seeded capital bootstrap directly into a fitted Vexor; lower hull rungs
remain available when their balance cannot cover the cruiser. Combat patrols
confirm a wreck before counting a kill, recover loot through InvBroker, and
sell or list it at the site's local base. The regional buyer planner redirects
actual cargo only when a non-Jita station has a better orderbook. Pilots repair
through the station repair authority and settle their corporation share.
The return-routing fix reroutes a combat pilot when its selected Upwell base has no
repair service, choosing the nearest reachable NPC station with both repair and
market access through EveJS's station service authority. This remains reliable
when the optional `stationOperations` SDE file is absent. Startup recovery
reactivates a previously blocked `REPAIR_OFFLINE` return only when that
destination is verified; without one the ship stays docked and the operation
remains blocked safely.
A Fleet command now broadcasts human-led attack orders using the commander's
most recently acquired target lock. Only bots in that human's Fleet with a
complete combat fit and live legal target authorization accept the order; the
bot locks and engages through EveJS targeting and drone authorities and
withdraws when the fleet, target, or legal authorization ends. `/attack stop`
recalls drones and returns the selected bots to base. Unit and runtime tests
cover lock selection, one/all selection, refusal, target movement, and safe
withdrawal; a live Fleet attack still needs an in-game verification. Formation
control and cross-bot combat target coordination remain open.
The live access audit found stale pirate-patrol operations returning to an
Upwell structure after their corporation had lost docking access. The access
fix rechecks both home and market structure access before return or loot
settlement and retargets through the station authority to an accessible NPC
repair-and-market base. The deployed addon routed both affected pilots to
Taisy III - Minedrill Refinery and queued one-jump navigation tasks with no
operation errors; docking, repair, and sale are still being monitored. It does
not loosen the corporation/alliance docking restriction.
Lost-hull recovery now makes capsules stop combat, settle
carried loot outside Jita, release an unfinished anomaly without claiming a
clear, and free the operation for director-led replacement-hull recovery.
Legacy Jita market routes are corrected to a reachable non-Jita repair and
market station.
Security pilots select a public combat anomaly only
when the hull's validated tank, weapon range, rat damage profile, complete
drone flight, and authored wave population meet the supported limits. They
activate unlocked gates, wait for the next wave, and record a clear only after
the dungeon authority reports completion; they recover remaining site wrecks
before selling. A new pilot starts at tier 1 and advances one tier only after a
durable record of an authority-confirmed clear. After a safe retreat, a site
that remains active is revisited after repairs and sale; it is never silently
replaced by another anomaly. A stop recalls drones and brings the ship home
before the operation ends. This does not cover
mission running, kill-right activation, or gate camping. Fleet-chat `/follow`
and `/escort` movement orders and the human `/attack` target broadcast are
implemented. Shared combat target coordination and formation control remain
open, as does live verification of Fleet attacks. A first tier-1 clear is now verified live; repeatable clears with
survival, profitable loot recovery, and PvP/Crimewatch outcomes still need
evidence. Empire target and loot rules follow CCP's [Suspect Timer],
[Criminal Timer], [Kill Rights], and [Container and Wreck Ownership] guidance.
Applied damage now triggers an immediate durable threat response. Combat bots
re-check legal target status, current combat fit, hull
mass, estimated effective hit points, shield reserve, armor/hull damage, and
capacitor; they engage only when the attacker is clearly weaker and otherwise
withdraw through normal navigation and docking. Unknown or stronger attackers
are treated as unsafe. A miner pauses its lasers while a qualified security
escort attempts a legal response, resumes when the attacker leaves, and
withdraws when no escort can cover the threat or the escort is lost. Incoming
NPC damage wakes the miner and its assigned escort without bypassing existing
pirate detection or wreck/site authorities. Focused policy, decision, escort,
and dispatch tests cover these branches; a live PvP response still needs a
controlled server verification.
When combat safety triggers an emergency withdrawal, the ship starts its return
route while drones recall; it does not remain under fire for the full drone-return
wait. If warp disruption is still active, the bot sends its drones after the
visible tackle source before retrying the escape.

Navigation checks actual active interdiction volumes before warp. A trapped
ship moves out of intersecting bubbles before retrying, and a route can use a
safe celestial detour or wait if every known warp approach is caught. Bubble
fields are a nullsec mechanic; this logic does not treat lowsec as bubble space.
The escape and detour rules follow CCP's [Warp Scrambling and Warp
Disruption] and [Interdiction Nullifiers] guidance. It does not deploy bubbles
or fit/activate interdiction nullifiers.

For null-sec structure conflicts, the director can declare a normal, billable
war from the actual structure rivalry without requiring the fleets to be fully
fitted first. Security recruitment and fitting proceed during the normal
24-hour spool-up. It recruits idle security bots only from bot-only
corporations, through EveJS's invitation and applicant-acceptance handlers,
and preserves at least three fitted pilots in each donor. For a funded
first-war corporation, it cross-trains safe local members toward a five-pilot
combat force before considering donor recruits. Their ordinary sale, mining,
PI, and industry work continues while combat skills train; ship upgrades wait
for the current durable work to finish. Donor corporations retain at least
three fitted pilots. Training queues the Algos, Vexor, Myrmidon, and Dominix
fit requirements in sequence, allowing a pilot to deploy the best rung already
supported by trained skills while later levels continue. Missing injected
skills are bought with the character's wallet through EveJS's ordinary
skill-purchase authority. The normal capped first-war stipend is transferred
first so a zero-wallet character can pay for those books; it remains part of
the corp's existing 5B grant. Up to five pilots draw from that grant while
preserving its 200M corp reserve. It does not change their corporation, touch
CEOs or officers, interrupt work under review, or stop passive PI. Only fitted
pilots enter the patrol. On the first war, each eligible
bot-only corporation receives one exact 5,000,000,000 ISK corp-wallet grant;
the configured human-CEO test corporation receives that grant once as well.
Up to five eligible combat pilots, prioritizing unfit pilots, can draw capped,
idempotent ship budgets through the normal corp-wallet authority and progress
through the best ship their skills and regional market stock support. Unused
grant money stays in the corporation. The war bill and standard spool-up remain
the normal EveJS lifecycle. The recovery logic preserves internal transfer
idempotency and reconciles transfers from both wallet journals before retry; a
one-sided legacy record is held for review. In-corporation training is the
fallback: missing skillbooks are bought and the training advance is funded from
the original first-war stipend. The system fills the five-pilot roster locally
before recruiting and queues a staged Algos-to-Dominix progression. Isolated
tests cover purchase/queue idempotency, mixed human-CEO corps, preservation of
operations under review, continued PI collection during training,
stipend-backed fitting, and war-patrol assignment. On 7 Nov 2026, the update was
installed on the supported remote EveJS server. Read-only live state confirms
war 2 corp `98000003` has five local pilots assigned with active skill queues,
one 5B grant, 4.8B across five stipend records, and the required 200M cash
reserve. Its assigned pilots retained active PI collection, mining, and sales;
no corporation membership was changed. The configured human test corp
`98000006` retains one war-1 5B grant, five funded stipend records totaling
4.8B, and its 200M reserve. Server and Playerbots are healthy; Market was not
restarted. Live queue completion, ship purchase/refit, patrol, and
post-spool-up combat sustainability remain to be observed. Structure core
installation also remains gated by the existing anchoring timers.

## Phase 5 — nullsec, alliances, structure construction, commissioning and operational use, and sovereignty (deployment implemented; commissioning partly implemented; territorial mining added; live proof open)

Sovereignty specialists first join an already active command-node event when
their corporation has persisted alliance membership and the pilot has a fitted,
fueled Entosis Link. If there is no active node objective, a qualified bot can
travel to a reachable, unclaimed neutral Sovereignty Hub in a claimable nullsec
system and begin an initial capture attempt. The alliance must have a persisted
active executor corporation. Competing alliance links use the sovereignty
authority's normal scoring, blocking, and reversal rules. The director prefers
an active campaign objective before starting a neutral-Hub attempt. The module
activates through normal Dogma; the sovereignty authority owns warm-up, scoring,
team blocking, campaign progress, and capture. One Strontium Clathrate is
consumed per completed module cycle, including warm-up. Operator stop and
campaign completion request normal module deactivation and wait for the current
cycle before the ship returns. During capture, the bot withdraws if it detects
hull or armor damage, shield below 75%, capacitor below 30%, or hostile warp
disruption. These mechanics follow CCP's [Entosis Link],
[Command Nodes Event], and [Vulnerability Window] guidance.

Bots can accept courier contracts already assigned to their character,
corporation, or alliance, subject to route, package volume, collateral, and
existing contract permissions. `/playerbots courier post` creates a private
contract assigned to a named bot in the issuer's corporation or alliance;
contract custody, escrow, completion, and reward still use the contract
authority. A sovereignty CEO bot can found an alliance through the corporation
registry when it has Empire Control V and at least 2,000,000,000 ISK. The
ordinary 1,000,000,000 ISK registration fee is charged once, and the original
1,000,000,000 ISK playerbot seed is retained. `/playerbots alliance found`
offers the same eligibility-checked operation to an operator.

`/playerbots build` plans a route to owned, allied, or neutral claimable nullsec
and deploys a personally owned, dockable Upwell package for its corporation.
The bot must have persisted CEO, Director, or Station Manager deployment
authority, carry the package in a ship hold, and pass the server's placement
and deployment checks. The director can procure one specialty-appropriate
medium structure per eligible corporation using realized profit after the
250M ISK minimum profit gate, or the bot's personal seed capital when the
complete hull, core, logistics budget, and protected working reserve are
affordable. This seed-capital path does not use corporation funds and applies
regardless of whether the CEO is a player or a bot. The 1B ISK market package
cap remains. The hull and core must
be available at one station. It uses the normal market and prefers non-Jita
supply. When an 8,000 m³ package does not fit, it can buy and
fit a Tayra with four Expanded Cargohold II modules, subject to skills and the
protected personal-wallet reserve. Provisioning raises Caldari Hauler to V and Hull
Upgrades to IV, and the inventory broker verifies the actual live hold before
the package is loaded. Larger packages require an active ship with enough live
cargo capacity. The operation carries the required Quantum Core with the hull
and returns it to the home hangar after confirming deployment. `Core absent`
is expected during anchoring: core installation waits for the structure
authority's dockable `ONLINING_VULNERABLE` state and a bot with persisted
structure-management authority. Anchoring is
confirmed through the structure authority, and no second deployment is issued
if package consumption is uncertain. Deployment starts the normal structure
timer; it does not itself install the core or make a service available.

The current implementation adds separate durable operations to install the
type-correct Quantum Core, buy a real Raitaru basic manufacturing module and
compatible fuel from verified regional orders (Jita only as a last resort),
move them through the normal inventory broker, and confirm the service online
and accessible through structure and industry authorities. The director sends
industry bots to an owned, dockable corporation structure only when its
manufacturing module is online and their service and docking access both pass;
the cycle returns output to a non-Jita market when the structure has no market
service. Structure commissioning and personal-asset manufacturing there have
isolated test coverage. They are not live proof. Corporation hangar and wallet
manufacturing at a structure, use of other service types, long-run fuel
maintenance, and the live completion gate below remain open.

### Corporation and alliance territorial exploitation — partial implementation; live proof open

An Upwell structure does not by itself grant sovereignty. Keep structure
ownership, alliance membership, and alliance sovereignty as separate inputs.
The deployment planner already recognizes owned/allied claimable nullsec and
prevents one corporation from placing duplicate structures of the same type
in a system; different corporations can deploy in the same system, including
members of one alliance. Alliance founding and sovereignty actions use their
existing corporation and sovereignty authorities.

The first guarded production path is implemented. A mining bot may use its
corporation's structure as a base only after EveJS confirms its Quantum Core,
docking service, and the pilot's docking access. It will not expand that work
during a corporation war or into a system with an unallied player structure.
The planner can also choose an asteroid-belt station one gate from the corp's
operational structure when the system is neutral or allied and the route has no
low-sec segment or hostile sovereignty. The director reserves the destination
system's autonomous capacity before dispatch, retains the 300-bot limit, and
routes ore/minerals to the non-Jita bot hub for market sale or listing.

The remaining territorial economy planner must coordinate PI, industry,
hauling, local sales, security patrols, and structure services across each
corporation's and alliance's productive footprint. It must compare belts,
planets, moons, stations, online services, market demand, route risk, and system
capacity, use corporate hangars and wallets only through persisted roles, and
leave systems when profitable work is exhausted. Structure ownership and
alliance sovereignty remain separate facts; the configurable
300-autonomous-bots-per-system limit applies to bots not under human control.
Bots in human-controlled fleets do not consume that allowance. The new mining
path has isolated tests but no live result yet. A read-only structure census
on 8 Nov found four core-powered, full-upkeep structures in system 30000848,
including Frontier Compact's Astrahus; a fifth Astrahus in system 30002440 was
still anchoring, lacked its core, and had low power. The first four share a
system with unallied corporations at war, so their territorial mining path
still needs live validation under the actual ownership and access rules.

### Structure construction, commissioning, and operational use — required completion work

Treat anchoring and operational use as separate outcomes. A deployed structure
is not a working corporation asset until bots bring it online and successfully
use a service through EveJS's existing authorities. The source now has
isolated-tested operations to install the correct Quantum Core, commission a
Raitaru's basic manufacturing service with compatible module and fuel, and run
a personal-asset manufacturing cycle at an owned, accessible structure. The
director checks docking and service access before assigning the cycle. These
tests establish code behavior only; they do not prove a live structure
lifecycle.

Construction, commissioning, and operational utilization are separate required
roadmap milestones. Completion means a bot can procure and anchor a structure,
install its correct core, commission and fuel a permitted service, then use
that service and reconcile the resulting assets and ISK through EveJS. The
remaining structure work is:

1. Prove anchoring and timer reconciliation after travel and server restart.
   Never report a timer complete before the structure authority does.
2. Extend service commissioning beyond the tested Raitaru manufacturing path:
   other compatible service modules, persisted corporation access configuration,
   and all type-specific bays and slots. Continue to verify wallet and
   inventory deltas and use safe non-Jita stock before the seed fallback.
3. Maintain fuel before expiry. Reconcile consumption, online/offline changes,
   shutdown, abandonment timers, and restart recovery so expired services are
   never presented as available.
4. Complete corporation-owned manufacturing using the corporation hangar and
   wallet at an eligible Raitaru; reconcile inputs, fees, output ownership,
   and inventory. Then exercise other supported services such as market,
   reprocessing, clone, or moon extraction only where EveJS exposes them and
   the structure profile permits them.
5. Prove an authorized corporation bot can reach and dock at the structure,
   use only permitted hangar and wallet divisions, and sell or correctly list
   output outside Jita. Include fuel and service costs in realized-profit and
   human-CEO 40% share accounting.
6. Expand tests for unavailable stock, denied roles, insufficient fuel,
   offline modules, failed docking, ambiguous purchases, and restart recovery,
   then run the lifecycle on a real server. Do not use synthetic cores,
   modules, fuel, assets, or access rights to make tests pass.

The live caretaker operation for Astrahus `1030000000000` exposed a transport
gap: its authorized bot carried the core, but its active ship had 480 m³ free
for a 500 m³ item. The logistics fix checks capacity, reuses an owned Badger or
Tayra where available, or buys a suitable hull within a 25M ISK personal
logistics budget from safe market stock, preferring sources outside Jita. The
bot's prior ship remains in its hangar. The live core transfer still must be
observed before counting this structure gate as passed.

**Structure-use completion gate:** the structure remains anchored after a
restart; all required core, service-module, fuel, online-state, and access
records match the authoritative inventory and structure state; a real bot
completes a supported service and the input, fees, output, sales or open order,
and net result reconcile. An anchored shell alone does not pass this gate.

**Remote evidence (6 Nov 2026, read-only audit):** the live GameStore has 100
playerbot records but no structure records and no
`structure-procurement` or `structure-deployment` operations. Playerbot
structure construction and use therefore have no live completion evidence;
both remain open roadmap work. Construction, core installation, service
commissioning, and actual use by an authorized bot remain explicit Phase 5
deliverables; the operational gate above must pass before this phase is closed.

Conflicts are
derived when different, non-allied player corporations have structures in the
same claimable nullsec system. Security bots with a valid combat fit patrol the
system and may attack active ships of the opposing corporation there; fleet
mates and capsule pilots remain protected. If the corporations later join the
same alliance, the rivalry ends on the next eligibility check.

When unallied corporations with bot members own real structures in the same
claimable null-sec system, one side with a fitted security fleet can lead a
normal billable corporation war through the war authority. The director checks
for a persisted bot CEO or Director, the 100M ISK declaration bill, and a
separate 100M ISK corporate reserve; any member contribution preserves that
bot's 200M ISK working balance. A human CEO alone does not block the activity;
bots actively controlled by a player are excluded. A rivalry with no prepared
security fleet remains peaceful until a corporation can field one. Null-sec
patrols can still use the system's open-combat rules where no formal war is
active, while sovereignty capture uses Entosis and sovereignty timers. Bots
must not invent roles, cores, fuel, service modules, or alliance membership.
Sovereignty playerbots with persisted CEO or Director authority can found an
alliance through EveJS's normal registration settlement; the Director path is
restricted to server-created bot actor sessions and rechecks the persisted
role before charging. The 1B ISK founding fee cannot consume the protected 1B
ISK seed reserve. Other corporations still join through the normal alliance
application and approval authorities.

**Remote structure census (7 Nov 2026, read-only):** the live null-sec system
30000848 contains four Astrahus/Athanor structures owned by four unallied
player corporations. Before this release, one structure was
`ONLINING_VULNERABLE`, three were `ANCHORING`, and no corporation war existed.
The director subsequently declared war 1 from bot corporation `98000001`
against `98000006` over this structure rivalry. EveJS recorded the normal
100M ISK war bill and 24-hour spool-up. The configured human-CEO test corp and
the bot-only corp each received an exact 5B grant. Three 1B stipends went to
corp `98000001` pilots and two to corp `98000006` pilots; both sides of all
five transfers appear in the corresponding corporation and character wallet
journals. The durable stipend status remained pending because its internal
caller passed options in a shape the AccountService kwarg reader did not accept.
The fix corrects that and reconciles those already completed payments
before any retry. Both corporations in war 2 received their exact first-war grants.
Corp `98000003` had no security-specialty members, so three idle members were
assigned. Their wallets had zero ISK and their Algos fit required un-injected
skills. The existing 1B first-war stipend was transferred to
each of those three pilots; the corporation wallet shows the exact 5B grant,
three 1B debits, and a 2B remaining balance. Character wallet journals show
the matching credits and skillbook purchases; each pilot has the missing skill
records and an active normal training queue. the current logic now targets five local
combat pilots and continues training in ship progression order. Verify the two
additional assignments and stipends, the ship fits and patrol handoff. The
first round of combat after spool-up still needs live verification.

War-budget recovery work closes a capsule-recovery deadlock found
in a read-only audit of the live roster: three pilots had a 1B stipend still
reserved to an upgrade operation that had been replaced, while their complete
market histories showed no purchase after that reservation. The runtime
releases such a reservation only when the history is complete and proves no
purchase occurred. Reconciliation runs at the capsule-recovery boundary and
again before security upgrades spend the stipend. Live rollout exposed a
second blocker: the per-system arrival queue stopped these finite recovery
trips, causing repeated replacement operations. The recovery path now allows capsule
recovery to visit a full market system and relies on ordinary relocation once
the fit is complete. A later market transaction, pending spend, or truncated
history keeps the budget reserved for review. Focused mobilization,
capsule-recovery, and capacity tests plus the full isolated suite cover release,
retention, the recovery hook, and the temporary full-system visit. Live
verification found that market optimization could retarget a recovery pilot
back to the empty hub after it found a regional hull offer. The recovery path pins that
verified source for the finite recovery trip; confirm those three pilots finish
fitting before counting the war force as ready.

The three bot-owned structures in the system are still in their normal
24-hour `ANCHORING` state, so the structure authority correctly refuses core
installation until `ONLINING_VULNERABLE`. Their CEOs already hold the matching
Quantum Cores at station `60003055`; the persisted anchor deadlines fall on 8
Nov at 03:20–03:28 UTC. The human test corporation's Astrahus already has its
core installed. Recheck the three bot structures after their timers and record
the authoritative core-slot inventory before claiming commissioning complete.
Neutral Hub capture, command-node participation, eligible structure deployment,
alliance founding, private assigned courier posting, and response to an active
structure rivalry are assigned through the director. Structure service
operation, sovereignty, and combat participation still need live in-server
evidence.

**Structure state update (8 Nov 2026, 10:07 UTC):** a read-only GameStore
census now shows four structures in system 30000848 in state 110
(`shield_vulnerable`), with their correct cores installed, full upkeep, and
basic manufacturing service state online. This includes Frontier Compact
structure `1030000000003`. A fifth Astrahus, `1030000000004`, remains in state
2 (`anchoring`), without a core and at low power. These state records supersede
the earlier anchoring snapshot for the first three bot-owned structures; the
fifth still needs its timer, core, and upkeep handled. An online service state
is not yet proof that a bot completed a production job there.

**Jita fuel-stock fallback defect (8 Nov 2026):** the live caretakers for
structures `1030000000000` and `1030000000001` were holding at the buy stage for
2,016 Hydrogen Fuel Blocks. A read-only market census found only 208 units left
at Jita station `60003466` but 10,000 units at several other seeded Jita
stations. The provisioning code treated the visible partial ask as a reason to
stop searching, so it never selected those other stations. The provisioning fix
rotates away from a missing or insufficient Jita ask, excludes every already
checked station, and still refuses to switch a regional purchase to Jita. The
focused structure industry suite passes 12/12 tests. Deployment, fuel transfer,
and online-service use by these live caretakers must be observed before this
gate is closed.

## Phase 6 — balance and operations

Measure load, task latency, wallets, assets, failures, and recovery at staged
roster levels through 15,000 identities and up to 5,000 connected pilots. Add
operator controls for capital, role access,
activity caps, emergency pause, and audit history. Keep the existing
`/botlocal`, `/playerbots inspect`, `/playerbots tasks`, and `/playerbots ops`
surfaces consistent with the actual persisted state.

### Delivered baseline — standalone operations dashboard

The installable playerbots add-on serves a browser dashboard on port 8080
from its own process. The dashboard is adapted to EveJS authorities and the
separate-process architecture. The read-only
dashboard provides server/add-on health, playerbot and human online/in-space
counts, specialty and corporation totals, system
distribution, paged pilot details, active operation types, recent actions,
fleet composition, active wars, structure cores and power state, and sovereignty
claims. It includes current character ID, ship, system, corporation and
operation. The private API token never leaves the Compose network, read views
are bounded, aggregate data is cached for 30 seconds, and the dashboard is
published without login on `0.0.0.0:8080` as requested.

the fix corrects a history gap: when a bot's active operation or industry cycle
was replaced by different work, the old row could be overwritten without being
archived. The old record is now retained with status `superseded`, its prior
status, successor operation ID, and a history event. The Operations page loads
100 rows per page by default and supports direct page jumps plus first/last
navigation. A live remote API walk on 8 Nov 2026 retrieved all 566 then-visible
records across six pages without duplicate IDs; the count grew during the walk
as bots continued creating work. This proves the current archive can be fully
traversed, not the 15,000-pilot capacity target.

The web Settings page now has gradual roster seeding controls:
operators can set the target, enable or pause the worker, choose a 1–25 pilot
batch, and set a 5–300 second interval. The standalone add-on schedules each
batch; the authenticated EveJS API creates pilots only in bounded, yielded
steps. Startup bulk seeding is disabled by default. EveJS checks event-loop p95
and process CPU before batches and stops early when one creation is slow. The
dashboard shows batch progress, timing, loop delay, and CPU. This implements
safe staged provisioning; it is not evidence that 15,000 pilots or 5,000
concurrent sessions are currently sustained. The current monitored seed trial
has reached 620 persistent pilots, but only 100 remains the validated
sustained-work ceiling. The latest snapshot and unresolved system concentration
are recorded below. The server also reduces active add-on step concurrency
to four, two, or one as loop p95 or process CPU crosses fixed guard bands; web
settings can raise the requested ceiling but cannot bypass those guards.

Remaining dashboard work: detailed alliance and war maps, realized
market/economy accounting, mining/PI/industry throughput, structure
service and fuel timelines, and bounded error history. These should use cached
or purpose-built summary readers; do not refresh 10,000 detailed rows or clone
full operation histories on each page poll. Reuse the paginated pilot endpoint.
Keep browser mutations narrow, same-origin, and bounded; roster seeding is the
only new operator mutation in this dashboard update.

### remove per-pilot scaling costs

The change remote sample showed 100 pilots completing a serialized add-on
pass in 4m47s, while event-loop p95 briefly reached 1.3–5.1 seconds. Inspection
found an extra scheduler request after every bot step and full grouped-map
copies for operation, industry-cycle, and per-pilot director-state writes.
The code change removes that redundant request, repairs missing durable jobs
in scheduler batches of at most 1,000, uses indexed/shared read-only planner
data, and stores new per-pilot records in flat GameStore rows. Existing grouped
records remain readable and migrate without a database reset.

The change has focused isolated test coverage; it is not yet a measured 5,000
session result. The documented baseline, throughput requirement, and staged
remote acceptance criteria are in
[`PLAYERBOTS_CAPACITY_MODEL.md`](PLAYERBOTS_CAPACITY_MODEL.md). The remote
seeder may be pointed at the 15,000 identity ceiling with the online ceiling
at 5,000, but its load guards must remain enabled. The next evidence is the
post-deploy 100-pilot cycle and then a monitored ramp through 250, 500, 1,000,
2,000, and at most 5,000 sessions. Pause at any guard-band regression.

Keep the UI in the standalone add-on. Expose authenticated, bounded snapshots
and only narrow same-origin operator changes through EveJS. Include the UI,
assets, integration overlay, auth setup, and operator guide in the versioned
ZIP. Validate install and rollback against the supported real EveJS 261028.1
checkout before release.

### adjustable scale trial and killboard

The dashboard now includes killmail totals and recent kills, bot pilot and
corporation results, and ship-loss summaries. The gradual roster seeder's
event-loop p95, process CPU, and single-pilot creation thresholds are editable
through the dashboard; it still creates bounded yielded batches and reports
why it pauses. Managed specialist corps can be grown to 300 bot members, plus
the human CEO, after a human takes over. The remote baseline is still 100 pilots; the
operator has configured a trial target of 3,000 persistent and 3,000 online.
The trial remains in progress until actual roster/session counts and login,
undock, event-loop, and failure measurements confirm the result.

### Active — 15,000-pilot population and corporation sharding

The requested limit is 15,000 persistent pilot identities with at most 5,000
online. The connection scheduler assigns deterministic balanced groups on
fixed eight-hour windows, gives durable operations and human-controlled
corporations/fleets priority within the global cap, and lets the add-on cycle
work only on connected pilots while retaining the full roster for fleet-wide
maintenance. Fresh installs gradually seed toward 500 bots; the public-test
ceiling is 1,500. Batch sizing, system visibility limits, and connected-session
capacity must be validated against measured EveJS load;
a roster size or brief mostly-docked run does not establish sustainable
connected capacity.

For larger populations, the planner targets roughly 250 bots in each specialty
corporation, keeps the hard roster cap at 300 per corp, and opens another shard
as the specialty grows. Mature shards fall in the 200–300 range; intermediate
totals can require a smaller final shard while respecting the per-corp limit.
Bot CEOs receive Corporation Management V and Megacorp Management II, giving
300 member slots under the EVE skill formula; the persisted member limit is
raised from the CEO's actual skill levels. The operational roster ceiling is
15,000, the online hard cap is 5,000, and the eight-hour schedule separates
active presence from persistent identity. The remote clean test has reached
500 persistent identities and 500 registered sessions simultaneously. This
is a short connection-capacity result; sustained production, login latency
under human traffic, database write rate, recovery, and the larger 1,000,
2,500, and 5,000 steps still need separate evidence.

Live capacity evidence (5 Nov 2026): the separate `playerbots-addon` process
completed a 100-bot pass in 21.6 seconds with zero failed steps; the fleet-wide
director also returned without error. The process used 16 concurrent pilot
requests; server memory was about 3.1 GiB and sampled CPU was about 60% after
the pass. This verifies the roster pass and bounded request path; it does not
by itself prove mining, sale, or industry throughput, and the game server still
owns the authoritative mutation work.
On 6 Nov 2026, a short live CPU profile found repeated deep copies of the full
durable playerbot task queue during read-only `listTasks` and `getTask` calls.
The remote queue held 517 records (496 completed). The read optimization changed those
read paths to inspect the shared snapshot and clone only records returned to
callers; task mutations still use a private full copy before persistence. A
focused test confirms returned task objects cannot mutate stored state. The
pre-fix five-minute sample had a 2.1-second median and 6.6-second p95 for slow
authority round trips, while measured worker queue and execution times were
under 20 ms at p95. A post-deploy CPU profile no longer ranked task listing
among its hot functions; it instead found repeated static stargate route
searches. A bounded 2,048-entry route cache now returns
isolated route arrays, with a test for cache reuse and mutation safety. The
post-restart authority latency sample is still dominated by startup and route
traffic, so re-measure after the server settles before claiming a user-visible
improvement.
During a live piracy patrol on 6 Nov, a 13.3-second authority command exceeded
the 10-second request deadline while the pilot was returning to base. Its
durable route task later completed, the ship returned to system H-PA29, and the
patrol resumed at its belt stage without a failed add-on pass or ship loss. No
NPC kill or combat-site clear occurred in that attempt, so it is recovery
evidence rather than combat proof. The recovered operation still displayed its
old timeout as the current error; the operation-state fix clears a prior error only
after a successful step and keeps current holding errors visible.
The same live review found that a nominal tier-1 Guristas Hidden Hideaway
contains five waves with up to nine entities in one wave, while the tier-1
Forlorn Hideaway reaches ten. The Tristan fit's 75% shield retreat threshold
caused repeated withdrawals and one security pilot was observed in a capsule.
Anomaly selection now gates on the authored wave count and population,
uses the seeded balance to bootstrap security pilots into a Vexor, and sends a
failed safe attempt to another site or an explicit incomplete result. The
isolated combat and fleet suites pass. At the time of this deployment, a live
anomaly clear was still open; the first authority-confirmed clear is recorded
below.

**Combat recovery correction (6 Nov 2026):** live operation history showed
Yashiro Pashanen's tier-3 Guristas site attempts retreating at `shield-reserve-low`
before recording a kill, followed by a different site assignment. Combat
recovery now records verified clears outside the seeded wallet, starts the next
operation at the next unproven tier, and resumes the same still-active site
after repair and sale. If its fit is missing a module or drone, it reserves
the site while a same-hull replenishment upgrade restores the required fit,
then resumes that exact site. A second safe failure releases the still-active
site to another eligible pilot instead of looping or claiming a clear. This
addresses the observed site abandonment and retry paths; live completed
anomaly evidence was still required at that point. NPC bounty settlement was
independently confirmed for Katsen Yakeno
(54,750 ISK) and Tovil Isokawa (21,750 ISK), with the pending buckets removed
and entry type 85 in their wallet journals.

**First live anomaly clear (6 Nov 2026):** Haato Arasai (140000058) has a
durable combat-progress record for site instance 583, difficulty 1, completed
at 11:25:38 UTC. The combat runtime writes this progression only after it has
observed the site's lifecycle state as `completed` through the dungeon
authority. Killmail 258 records the same pilot destroying a Guristas pirate
frigate in system 30000133 at 11:20:27 UTC, with a 3,000 ISK bounty claim.
This closes the first live tier-1 anomaly-clear gate. One clear does not prove
repeatable site completion, survival across the combat fleet, loot recovery
and sale, or legal PvP/Crimewatch behavior; those remain open.
The director now treats system capacity as a placement target rather than a
reason to strand a required route: destination-bound tasks may enter a full
system, finish, and then trigger relocation of an idle excess bot to a
less-populated high-sec station. The current configurable limit is 300 bots
per system. Bots in a human-controlled fleet remain excluded from autonomous
system counts. Global load shedding preserves
destination-bound work and queues only resumable local tasks. The director can
run assigned alliance courier contracts, begin authority-checked captures of
eligible neutral Hubs, found qualifying bot-CEO alliances, deploy owned
structure packages, and patrol active nullsec structure rivalries. These
actions go through the normal contract, corporation, structure, navigation,
combat, and sovereignty authorities; no formal war is fabricated for nullsec
combat.

On 6 Nov 2026, the update was installed on the remote EveJS 261028.1
instance. The server, playerbots add-on, and Market were healthy afterward;
Market was left running during deployment. The first post-restart roster pass
completed 100/100 bots with zero failed steps in 46 seconds. Server logs showed
bots mining, undocking, warping, and advancing gate routes across multiple
systems. This startup pass is not a steady-state latency measurement and does
not prove sale, PI, industry, combat-site, or sovereignty outcomes.

### region-indexed market planning

A brief remote V8 profile on 8 Nov 2026 traced a large share of the active
director work through upgrade market selection and `listSellOffers`. The
type-only supply query caused SQLite to scan the universe-wide `seed_stock`
table for each uncached item type; the market schema's existing indexes begin
with `region_id`, so they could not help that query. The deployed roster was
685 bots, seeding was paused, event-loop p95 was 4.93 seconds, and scheduler
round trips were 3.5–3.8 seconds even when worker execution was under 1.2 ms.
The live process was also logging missed Destiny ticks. These readings keep the
capacity and player-latency gates open.

The change source query now includes every region from EveJS static universe
data (115 region IDs, including 0) and lets the existing region/type indexes
serve both seeded stock and player asks. A read-only comparison against the
live Market database returned the same 2,832 type-34 offers in 13.26 ms instead
of 219.43 ms; the seed-stock branch for types 34–36 fell from 248.92–368.52 ms
to 0.33–6.32 ms. `EXPLAIN QUERY PLAN` confirmed indexed access on both tables.
The focused regression test checks the same global ask semantics and index
selection. This isolates and removes one expensive planner path without changing
the Market database or its service. Deployment and post-deploy steady-state
measurements are still required before saying server lag is resolved.

### dashboard and portrait scaling

A remote V8 sample after the fix restart found repeated synchronous work
in character persistence reads, market escrow cloning, and the playerbot
portrait pool directory scan. On the same live roster, the first dashboard
summary and seed-status requests also exceeded the dashboard's 10-second proxy
deadline; a direct seed-status read later completed in 2.2 seconds and reported
event-loop p95 near 1.21 seconds. EveJS and the add-on were healthy at the
protocol/container level, but these timings do not pass the responsiveness
gate.

The change dashboard uses cached bot profiles and raw read-only character
fields for summary and pilot pages, avoiding character normalization just to
display names, corporation membership, ship, and location. Portrait-pool
catalog reads are cached and invalidated when the source directory changes.
Assignment state continues to read the existing `assignments.json`; new
assignments are appended to a replayable log and compacted back into that JSON
format every 1,024 entries. Tests cover cached pool invalidation, replay across
restart, and compatibility with pre-existing assignments. Remote summary
latency, portrait seeding throughput, and event-loop p95 were open at release;
the post-deployment result is recorded below.

#### remote deployment check (8 Nov 2026)

The change archive was installed on the remote EveJS `261028.1` checkout,
then the game server was restarted and the separate add-on was started after
the server became healthy. At the latest check the server, add-on, and Market
containers were healthy with zero container restarts; Market kept its original
container ID. The dashboard seed-status endpoint reported `enabled=false`,
`running=false`, target 3,000. The add-on began a 685-pilot cycle at effective
concurrency 1 of 4 and had completed 75 pilots with zero failures at the
sample; this is an early progress sample, not a completed live cycle.

The general dashboard summary still returned an error after 10.1 seconds. A
seed-status read completed in 0.909 seconds but reported event-loop p95 of
2,791.3 ms and process CPU at 200.3% against the configured 300% safety limit.
Separate Docker samples ranged from 100.48% to 377.42% server CPU and from
3.67 to 5.88 GiB of 7.67 GiB container memory during recovery. These readings
do not meet the latency gate and do not establish normal steady-state load.
Human login/undock responsiveness and a complete post-deploy production cycle
remain unverified; keep roster seeding paused.

The server restart also exposed a shutdown-order race in the old process: its
durable GameStore flush began while a solar-system scene tick was still in
`crimewatchState`/`dockSession`, producing an uncaught exception report. The
new process reached healthy state without another container restart. The
The section below records the ticker-stop fix and its live restart
verification. Do not use repeated restarts as a recovery method.

Next performance work must profile the live server event loop and the summary
aggregate separately. The dashboard projection and portrait scan improvements
did not resolve the measured summary failure or multi-second event-loop delay.
Keep the current 685-pilot roster and paused seeder as the controlled baseline
until summary calls return promptly, event-loop p95 is below 100 ms, login and
undock are responsive, and several complete productive cycles finish without
missed simulation work.

### stop simulation before durable shutdown

The change restart showed that the global SpaceRuntime interval remained
armed while signal shutdown was preparing the GameStore flush. The code change
adds an early shutdown hook that clears that interval and marks the runtime as
stopping; an already-queued callback returns without ticking any scene. Startup
failure and explicit world shutdown also stop the interval. The focused test
checks interval cancellation, repeated stop, and the queued-callback guard.
The add-on archive is built against EveJS `261028.1`; installation and
rollback passed against a disposable copy, with `.env` and a database sentinel
preserved. A consecutive package upgrade replaced the single reviewed managed
conflict; rollback restored the previous files, again preserving both
sentinels. Backup names now include microseconds to avoid same-second upgrade
collisions. A controlled live restart on 8 Nov loaded the updated code and logged
`GameStore shutdown flush complete` without an uncaught exception or Node
report; EveJS returned healthy afterward. This closes the shutdown-order
restart check. Summary/API latency, event-loop delay, responsive login and
undock, and sustained productive work remain open; do not use repeated
restarts as a recovery method.

### indexed dashboard operation history

The remote dashboard had 6,141 operation records; an unfiltered final page
returned 41 unique rows in 1.91 seconds, while the active filter took 7.98
seconds for 195 rows. The history path rebuilt its combined current/archive
map, parsed creation timestamps during every sort comparison, recomputed
status counts and sorted the full archive for every request. The code change
precomputes row/search/sort fields once, keeps a sorted in-memory index, and
updates it incrementally when operations are saved or archived and when an
industry cycle changes. The seven operation-history tests cover current and
archive merging, terminal industry cycles, full pagination, stable offsets
and live operation updates; two dashboard-runtime tests and three dashboard-
server tests also pass (12 focused tests total).

**Remote check (8 Nov 2026):** the package is installed on the
supported remote EveJS 261028.1 host. Installation replaced two reviewed
managed files with backups, preserved the pre-existing `.env` content, and
reported no database reads or writes. Compose was run with the server's
existing `app/.env`; EveJS and the add-on are healthy, the add-on has its
64-character API token, and Market kept the same container ID and remained
healthy. The roster snapshot reports 685 pilots against a 3,000 trial target,
with the 15,000 identity ceiling, 5,000 online ceiling and seeder paused.

The first installed reads returned HTTP 200: summary 0.67 s, operation first
page 0.44 s, final page 0.27 s, active filter 0.37 s and killboard 0.55 s.
After the live archive grew to 6,220 rows, the last page returned 20 unique
rows in 0.64 s; a direct add-on-to-EveJS last-page request took 1.63 s. This
confirms that the indexed history can serve the current archive quickly, but
it does not close the overall responsiveness gate: later summary and
operation requests intermittently returned HTTP 503 at the dashboard's
10-second upstream timeout, while one summary read took 9.9 s. During that
window EveJS used about one CPU core and 5.8 GiB of its 7.7 GiB limit, and
scheduler round trips reached 60.8 s. The separate add-on used about 0.05%
CPU. The bottleneck therefore remains in EveJS and its durable scheduler;
responsive player login/undock and sustained dashboard availability still
need investigation. The add-on cycle was progressing 50/685 with zero
failures at effective concurrency 1 of 4; this is progress evidence, not a
completed-cycle or scale result.

### prevent mining operations without a fitted laser

A read-only audit of the remote operation archive found 1,416 completed
`mine` records for 31 pilots whose last action was “No mining ship is
available (capsule or no fitted miner).” The newest matching record was at
12:54 UTC on 8 Nov, shortly before the fix was installed. These records came
from the director repeatedly creating work that immediately completed; their
presence is not evidence of mining.

The code change checks the current mining fit before assigning home or
territorial belt work and repeats that check at dispatch as a final guard. If a
fitted miner is absent, it requests the existing Venture fit upgrade only
when skills, wallet reserve, market route and upgrade cooldown permit it. If
those conditions fail, the pilot remains available for PI, sales, combat,
industry or other finite work without a fabricated mining assignment. The
productive-work fallback preserves a fitted security or piracy combat ship,
and industry specialists receive their available production cycle before
mining progression. Four new focused regression cases and 47 related tests
passed across mining, director, PI, market, structure and recovery suites.

**Release/deployment gate:** the add-on ZIP was built against EveJS 261028.1
with 84 guarded integration files. Dry-run, install and rollback passed
against a disposable copy of the supported checkout. A pre-existing `.env`
and database sentinel were unchanged, and no local service was started. The
remote installation replaced one reviewed managed file with a backup and
preserved `.env`; the installer reported no database access. Only EveJS and
the playerbots add-on were restarted; Market kept container
`34b562dbdcd7`. Both returned healthy with all 685 pilots connected. The live
no-fit recurrence check passed for the sampled post-restart window, but the
gate remains open: the window did not prove a bot bought and fitted a Venture
or completed mining. Qualified miners must still be observed locking,
approaching and extracting ore through a complete director cycle.

**Remote observation (8 Nov 2026):** a read-only audit after restart
found no new no-fit mining records and no active no-fit mining operation. The
first recovered add-on cycle reached 125/685 with zero failures, while the
active operation set contained no mine operation at the sample. The earlier
restart did expose the transition shutdown exception addressed below.

### quiesce pending transitions before durable shutdown

Restarting the remote EveJS process while pilots were in transit exposed a
second shutdown race: a delayed stargate handoff fired after GameStore had
started flushing, attempted to persist a departing NPC controller, and emitted
an uncaught-exception report. The prior world-ticker stop did not cancel the
independent transition timers.

The code change registers an early shutdown hook ahead of TCP session closure.
It stops the SpaceRuntime ticker, cancels scheduled transition and
invulnerability timers (including async handoff waits), removes canceled
handles from the timer registry, invalidates active transition locks, and
rejects new transitions once shutdown starts. A canceled cynosural handoff
does not force-close its socket during process shutdown. Focused regression
tests verify canceled timers do not fire, async waits settle, and no new
transition timer is accepted; the world-ticker shutdown test also passes.

**Remote installation (8 Nov 2026):** the 86-file guarded archive
passed remote dry-run, installed without `--start`, and preserved `.env`
SHA-256 `8620a11ed2d19546d54a0d9c7521872880769dd0a4453e938bb706e52213a2c0`.
The installer reported no database access; the GameStore database kept inode
`10928519`, and Market kept healthy container
`34b562dbdcd783658470114a1675c1ab44823847e1710330c31471cee47f278b`. The
first EveJS shutdown flushed cleanly and created no new uncaught-exception
report. That process had loaded the updated code before the installation, so
this is not yet a live test of the shutdown hook with a pending handoff. Keep
that live gate open; the regression tests currently prove the timer behavior.

**Restart and dashboard observations (8 Nov 2026):** restarting EveJS and
the sidecar together started the sidecar before EveJS became healthy. Its
unfinished add-on cycle logged 47 `fetch failed` pilot-step attempts by
progress 450/685. The sidecar was then stopped while EveJS completed startup;
after EveJS was healthy, Compose started the sidecar and the dashboard
returned HTTP 200 with 685 bots online, zero humans, 81 bots in space, 414
operation records and 101 active operations. The new API cycle began at 0/685,
so cycle ID and processed-count recovery across a GameStore process restart are
not established; verify idempotency and checkpoint recovery instead of
counting this as a resumed cycle. The first summary request after startup
returned 503, a warmed summary later returned HTTP 200 in 2.31 seconds, and
two Operations page requests returned HTTP 503 at the add-on's 10-second
upstream timeout. The archive had 6,246 rows and 7.59 MB of stored JSON, so
large-archive paging and cold-start latency remain open even though the update
added a sorted in-memory index. The documented restart order now stops the
sidecar, restarts EveJS, waits for `healthy`, then starts the sidecar.

The restart loaded all 200 GameStore tables (840.9 MB) and registered 208
services; EveJS logged its game listener running before the container health
probe passed. Startup health took over four minutes, while a 10-second
MachoNet greeting probe and later 2-second probes passed. Investigate the
startup load and health-check delay before raising the sustained roster or
connection target. Read-only live audit also found zero new no-fit mining
records and zero active no-fit mining operations since the mining-fit fix; this
does not yet prove a bot bought a Venture or completed an ore extraction.

### bound dashboard API waits from the web setting

The remote Operations API exceeded the dashboard's hard-coded 10-second read
deadline twice after restart. A later read-only probe returned HTTP 200 in
6.04 seconds, then the next page returned in 0.80 seconds; a direct private
API request took 4.52 seconds. In the same sample, summary returned in 1.38
seconds and the killboard in 7.37 seconds. This confirms variable upstream
latency and recovery, not a resolved latency problem.

The code change makes dashboard API read and update deadlines follow the
existing EveJS request-timeout setting shown in the web UI, clamped to 10–30
seconds. The image-render proxy retains its separate 8-second outbound
deadline. The web field now explains the dashboard cap, and a focused test
checks both timeout bounds and authenticated proxy behavior. The higher cap
prevents a 10-second cutoff for measured 6-second Operations reads when the
server is busy; it does not speed up the underlying operation-history API.
Keep read latency and dashboard availability as open production gates and
measure again after deployment.

The change restart sample also confirmed that a process restart starts a new
in-memory API cycle at 0/685 even though the prior cycle had processed pilots.
The driver subsequently completed 685/685 with zero failures, but that is a
fresh pass, not recovered cycle progress. Per-pilot durable operations remain
the recovery authority; durable whole-cycle identity and checkpoint recovery
are still open and must be tested before claiming restart-resumable cycles.

**Remote check (8 Nov 2026):** the first restart command used the
app-local Compose file and default project, so it did not restart the Server
Panel container. Inspecting its labels identified the actual project as
`evejs-serverpanel` and the base file as `deploy/compose.yaml`. The sidecar was
then restarted through that exact project; EveJS and Market stayed healthy and
were not restarted. The new dashboard UI served the 30-second cap text, and
two Operations pages returned HTTP 200 in 3.74 and 5.79 seconds. This removes
the observed 10-second proxy cutoff for these samples, but the page still has
multi-second latency and needs sustained measurements. The driver reconnected
to the same live API cycle and reported 8/685 already complete; this proves
recovery across an add-on process restart while EveJS stays up. Whole-cycle
recovery across an EveJS process restart remains open because that server-owned
cycle state is in memory.

The change live scaling snapshot keeps the configured roster and online
targets at 3,000, but the roster is 685 and seeding is disabled. The seed
settings still specify batches of ten every five seconds; the last pause was
manual after Manifest reached 566 residents with 100 capacity relocations
active. Current event-loop p95 is 2,139 ms, process CPU is 106.1%, and the
driver's effective step concurrency is one of four. The previous 100 ms p95
and 85% CPU thresholds had since been raised to 10,000 ms and 300%. The add-on
now applies independent hard seeding caps of 250 ms p95 and 95% process CPU,
waits for two load samples before the first batch, and clamps single-pilot
creation time to 1,000 ms. Stored settings cannot override these limits. Keep
3,000 as the target, but treat capacity as unproven; tune placement and
back-pressure before resuming batches and measure user-facing latency while
the roster grows.

## Separate-client launcher and headless server

The server runs headless under Docker (`docker compose up --build --detach`)
and never starts on its own: run it with `docker compose up -d` when needed (`restart: "no"`). Client ports
(443, 5222, 26000–26002) are published on `${EVEJS_PUBLISH_HOST:-0.0.0.0}` so a
client elsewhere on the LAN can connect; set `EVEJS_PUBLISH_HOST=127.0.0.1` to
go back to loopback-only. The redshift monitor and market daemon stay on
loopback.

`python3 tools/ClientSETUP/build-client-launcher-package.py` builds
`dist/EvEJS-Client-Launcher.zip`: Linux/Proton (`launch-evejs-client.sh`) and
Windows launchers, verified client patch recipes, the server's public CA, and
instructions. It needs no EvEJS checkout after extraction and offers three
connection modes: local server, SSH tunnel to a remote headless server, or
direct LAN through a small local relay (the patched client only talks to
`localhost`). It does not include EVE game files, Steam, Proton or OpenSSH. Its
Linux launcher has its own name so an existing per-machine
`launch-evejs-proton.sh` beside `tq/` keeps working next to it.

## Current honest boundary

The director assigns mining, industry, ship upgrades, passive PI setup and
collection, security patrols and combat anomalies, piracy, assigned alliance
courier contracts, neutral Hub capture attempts, eligible sovereignty
campaign participation, alliance founding by qualifying CEOs, structure
package deployment, and security patrols during active nullsec structure
rivalries. The PI planner can synthesize supported P0-to-P4 networks and checks
recipe throughput before live network preflight; live P2+ profitability and
sales still need proof. PI and combat loot are listed when no buyer exists, so
realized income depends on market demand. Shared corporate manufacturing uses
selected hangar and wallet divisions, but the complete bot-mined ship chain
and corporate manufacturing cycle still need live proof. One authority-
confirmed tier-1 combat anomaly clear is recorded, while repeatable safe
completion, loot sale, PvP/Crimewatch, and sovereignty results still need live
evidence. Structure deployment begins the normal
anchoring lifecycle from a package; the bot does not invent the required core,
services, fuel, corporation roles, or alliance membership.
At the time of this 09:56 UTC snapshot, the configured default roster target
was 100 and the live trial target was 3,000.
The live roster had reached 580 identities across 12 managed corporations at
the 09:56 UTC read-only audit on 8 Nov 2026. That is evidence of seeding
progress, not evidence that 3,000 pilots can connect or sustain productive
work. Earlier 100-bot passes measured orchestration, not sustained mining,
combat or manufacturing capacity; continue the staged load and productivity
gates before claiming the requested scale is stable.

**Live staging snapshot (8 Nov 2026, 09:58 UTC):** the remote dashboard showed
620 persistent and online bots, 71 bots in space server-wide, 192 active
operations, and 93 capacity-relocation operations. The system aggregate showed
503 residents assigned to Manifest, exceeding the configured 300 autonomous
system limit. This is a resident count, not 503 ships in one grid; only 71 bots
were in space across the entire server. The relocation backlog was active, but
the system count had not yet fallen below 300, so per-system compliance remains
open. The add-on's last seed batch reported 1.72 s event-loop p95 and 4.01 s
maximum creation time against a 10 s p95 safety threshold. EveJS and the add-on
were healthy with zero restarts at the 09:57 UTC container check, and the
separate Market container remained healthy and unchanged. The remote online
ceiling was configured to 3,000 at this snapshot; the requested 5,000 online
target is not yet configured or validated. Do not treat this seed snapshot as
capacity proof; continue staged observation and confirm relocation reduces
Manifest below its limit before calling the placement policy compliant.

**Seed safety intervention (8 Nov 2026, 10:03 UTC):** after the roster reached
671 and Manifest 553, the seed worker was paused from the dashboard because
creation continued at roughly 10 bots per 26 seconds while event-loop p95 rose
above 2.1 seconds. The pause was confirmed in the persisted GameStore setting
and in the add-on log: the in-flight batch created four more bots, reached 685,
then stopped with `roster seeding is paused`. That final batch reported 4.84 s
event-loop p95 and the add-on logged one operation-step timeout. A read-only
database audit at 10:05 UTC found 685 bot profiles, 566 assigned to Manifest,
and 100 active relocation operations, unchanged from the prior audit. All
three remote services were healthy with zero restarts at 10:05 UTC. Keep seeding
paused until relocation makes measurable progress, Manifest falls below 300,
and player-facing latency is rechecked; this is a protective pause, not a
capacity result.

**Durable-work recovery (6 Nov 2026):** the remote add-on
completed two consecutive 100-bot cycles with zero failed steps (34 seconds
and 25 seconds). A read-only GameStore audit after the second pass found 98
active operations and no active operation without a scheduled or running
playerbot job. This verifies roster coverage across these passes; it is not a
long-duration production or latency result.

**Steady-state server profile (6 Nov 2026):** after a clean restart, the
standalone add-on completed 100/100 pilots in 29.4 seconds with zero failures
and negligible CPU, while the server process stayed around 103–114% of one CPU
core and 5.0 GiB RAM. A 18.5-second V8 profile attributed 19.3% of sampled
server CPU to full SQLite table reads, 9.8% to garbage collection, 8.2% to
SQLite path reads, 8.1% to `playerBotRuntime.listBots`, 7.7% to dungeon-state
cloning, and 6.5% to character-state cloning. Four market operations also
recorded authority calls over their 10-second deadline. The optimization caches
the sorted playerbot profile roster and uses the shared read-only character
view, with tests for invalidation and live character identity. Its post-deploy
V8 profile no longer ranks `listBots` or table-root reads among the hot paths;
character-state cloning fell from 6.5% to 1.5%, and garbage collection from
9.8% to 2.3% in comparable 18-second samples. The remaining profile attributed
20.8% to Node's deep-equality walk from nested GameStore writes, including the
large retained playerbot task queue. The task-write path marks already-mutated
queue writes as forced, and GameStore now honors that flag on nested paths
instead of comparing the entire task map first. The post-deploy profile no
longer ranked the deep-equality walk among the hot functions. A later profile
found repeated deep copies while hashing immutable dungeon template content
during universe-site reconciliation; the optimization memoizes that hash by the
deeply frozen authority view and includes the compatible runtime file in its
guarded overlay. The remote profile measured that reconciliation path at 1.3%,
down from 29.1%; server CPU remained around 108% and memory around 3.6 GiB. The
new profile then found task-queue reads at 33.8% inclusive CPU. An initial
optimization removed per-task deep clones but still copied the whole task map
on every read. The current read path shares the cached map and shallow-copies it once when a
write starts, then clones only modified task records. Focused tests cover task
leases, unrelated records, and detached return values. The host remains below
overall capacity, while authority requests still take 1–3 seconds end to end
with 1–23 ms in the owning worker; another post-deploy profile and latency
sample will determine whether this change improves that path.

**Post-deployment roster check (6 Nov 2026):** after deployment, two consecutive
add-on cycles each processed all 100 bots with zero failed steps. They took
26.7 and 31.5 seconds. Server and add-on health checks remained healthy, and
the Market service was not restarted. During the second pass, individual
scheduler authority warnings still showed 1.9–2.8 second round trips despite
low measured worker queue and execution time. These are individual samples,
not a percentile or a confirmed cause; sustained user-visible latency remains
open. The cycles verify roster execution, not production or market demand.

### remove repeated whole-state server work

A 44.4-second remote V8 profile at 685 pilots sampled 34,059 stacks. It
attributed 4.48 CPU seconds to deep-copying the complete customs inspection
case map during session attachment, 3.36 seconds to loading all Abyssal
instances on committed gate arrivals, 1.51 seconds to copying all market
escrow entries for each candidate order, and 3.82 seconds to garbage
collection. The main EveJS process used about 139% of one core while the
playerbots sidecar stayed below 1%; the host itself was not shown to be
exhausted.

The code change removes those repeated costs with a narrow career projection
after already-committed events, selective customs record copies, and an
incrementally maintained market pending-order index. Isolated regression tests
cover the behavior and index lifecycle. Next, deploy the guarded ZIP to a
disposable EveJS `261028.1` copy, then to the remote Server Panel project;
capture a comparable profile and measure login, undock, scene ticks, market
requests, dashboard latency, and productive addon cycles before restarting
seeding.

The configured 3,000 persistent and online target remains open: the remote
roster is 685 and seeding is paused. After the post-deploy profile improves,
grow in monitored batches while enforcing 300 autonomous residents per system.
Do not call 3,000 validated until user-facing latency remains healthy, event
loop p95 stays below 100 ms, and complete mining, market, PI, combat, and
structure cycles finish without missed safety work.

### narrow committed career projections

After the update was installed on the remote server, dashboard static assets
loaded in 35–108 ms, but API reads still took 1.7–5.8 seconds. The EveJS main
thread used about 110–122% of one core. A profile taken while requesting
dashboard data found 3.32 CPU seconds in durable whole-table reads from career
projection: every committed gate arrival was still re-reading combat killmails
and all map telemetry even though only travel progress had changed.

The code change projects career-event goals for ordinary committed facts and
adds visited-region goals only for gate arrivals. Region progress now reads a
single character's indexed `mapTelemetry` path. Full source reconciliation
remains available to explicit recovery and ordinary non-event sync calls.
Focused isolated tests cover projection options and path selection. Deploy
this ZIP, profile the same dashboard calls and active bot workload, and keep
seeding paused until the one-second dashboard target and sub-100 ms event-loop
target are met.

### remove per-candidate nullsec route searches

The first The remote profile showed the career read path was gone from
the hot sample, but dashboard timing still varied while bots were doing work.
The profile sampled about 3.02 CPU seconds in `positiveID` within structure
deployment planning. Its BFS was asking the weighted Dijkstra planner for a
route separately for each claimable nullsec system. The Dijkstra planner also
sorted each visited system's gate list, despite `worldData` sorting those
adjacency lists once at load time.

The code change makes the reachability BFS carry the chosen shortest-hop path's
risk summary and removes those repeated route searches and sorts. Deployment
travel continues to choose routes through the safe weighted planner. Isolated
tests verify hop limits, risk summaries and that candidate discovery avoids
per-system Dijkstra calls. After deploying, profile again and record dashboard
latency and event-loop p95 during a settled 685-bot cycle; keep the 3,000-bot
seed paused until the one-second summary/Operations and sub-100 ms event-loop
targets hold under active work.

[Suspect Timer]: https://support.eveonline.com/hc/en-us/articles/203268571-Suspect-Timer
[Criminal Timer]: https://support.eveonline.com/hc/en-us/articles/203268591-Criminal-Timer
[Kill Rights]: https://support.eveonline.com/hc/en-us/articles/203208922-Kill-Rights
[Container and Wreck Ownership]: https://support.eveonline.com/hc/en-us/articles/115000597345-Container-and-Wreck-Ownership
[Warp Scrambling and Warp Disruption]: https://support.eveonline.com/hc/en-us/articles/115004925705-Warp-Scrambling-and-Warp-Disruption
[Interdiction Nullifiers]: https://support.eveonline.com/hc/en-us/articles/4500991290908-Interdiction-Nullifiers
[Entosis Link]: https://support.eveonline.com/hc/en-us/articles/203729281-Entosis-Link
[Command Nodes Event]: https://support.eveonline.com/hc/en-us/articles/203728981-Command-Nodes-Event
[Vulnerability Window]: https://support.eveonline.com/hc/en-us/articles/203728711-Vulnerability-Window
[Upwell deployment]: https://support.eveonline.com/hc/en-us/articles/208289335-Upwell-Structure-Deployment-and-Unanchoring
[manufacturing]: https://support.eveonline.com/hc/en-us/articles/203210292-Manufacturing
[blueprint]: https://support.eveonline.com/hc/en-us/articles/203269951-Blueprints
[industry activity]: https://support.eveonline.com/hc/en-us/articles/203210272-Activities-and-Job-Types
[mining]: https://support.eveonline.com/hc/en-us/articles/23655785488668-Introduction-to-Mining
[warp disruption]: https://support.eveonline.com/hc/en-us/articles/115004925705-Warp-Scrambling-and-Warp-Disruption
[personal deployable]: https://support.eveonline.com/hc/en-us/articles/203278031-Personal-Deployables
[Crimewatch]: https://support.eveonline.com/hc/en-us/sections/201141682-Crimewatch
[container ownership]: https://support.eveonline.com/hc/en-us/articles/115000597345-Container-and-Wreck-Ownership
[sovereignty]: https://support.eveonline.com/hc/en-us/articles/203729281-Entosis-Link

## Current remote session evidence — 8 Nov 2026

The clean remote test reached 500/500 seeded bots and 500/500 registered
sessions, with zero offline. Across repeated snapshots, 46–48 actors were in
space, 447–449 were docked, five locations were still resolving, and no humans
were connected. All 500 bots had all six supported portrait resolutions.
After the previous add-on restart, EveJS stayed healthy with no additional
restart or OOM. Memory ranged from 2.6–3.2 GiB and event-loop p95 from 96–426
ms in settled samples. An 18.1-second spike appeared during the initial
connection and deployment waves. Consistent latency and human-traffic response
remain performance gates; this short run proves simultaneous session count,
not that all pilots are producing at once.

The former Overview total counted durable operations but omitted active
industry cycles. In a live 500-pilot check, the Operations history showed 408
active records, including 81 industry cycles, while the Overview showed only
327. The dashboard now calculates active work across operations and cycles and
shows those cycles in each pilot's activity row. The latest sample had 500/500
connected, 386 in space, 114 docked, 408 active work records on the Operations
page, and zero failed add-on steps; the current pilot cycle was still in
progress. Sustained production and latency remain open validation gates.


### 500-pilot active-work queue audit — 8 Nov 2026

328. The 22:14 UTC live snapshot had 500/500 sessions connected but 409/500
active work and 91 without current work. Sixty of those had no operation
record; 59 were docked in Manifest in Ibis hulls. Twenty-five others had just
completed capacity relocation. The live forecast was 314 in Jita against the 300-pilot system cap, with 262
upgrade trips inbound. This blocked new starters from buying Venture hulls and
mining modules. The capacity patch enforces the arrival cap during lightweight
director passes and displays PI setup queue reasons without counting queued
pilots as active. Keep this gate open until the active
work count rises as market capacity clears and all 500 pilots have executable
assignments; configured work capacity alone is not proof of active work.

## EveJS 261108.1 integration and Playerbots compatibility — 9 Nov 2026

The EveJS `261108.1` source was merged from the `original` branch into `main`
as an upstream merge, retaining all main-only Playerbots sources, tests, assets,
installer files, and release material. Playerbots integration points were
reconciled against the new source APIs: fleet membership and orders, structure
access, career event projections, inventory reads, shared damage dispatch,
portraits, and durable war declarations. The new war declaration authority
prepares first-war mobilization only after the fee and bill are durable and
schedules its idempotent recovery after the declaration succeeds.

The add-on targets EveJS `261108.1`. Its ZIP has guarded SHA-256 entries
for 95 integration files, including the war-declaration hook, and includes the
public fitting catalog. A disposable copy of the actual `261108.1` source
passed installer dry-run, install/hash verification, and rollback. An operator
`.env` sentinel and game-data sentinel survived both install and rollback.

The complete 87-file Playerbots test set passed, together with career committed
projection, career exploration reads, and null-sec structure access tests
(90 isolated test files total). Changed JavaScript passed `node --check`.
At the time of this merge record, remote deployment and live Playerbots
verification were pending. The following entry records the subsequent live
deployment and preserves the existing remote database during the upgrade.

## 500-pilot live profile and guarded hot-path patch — 9 Nov 2026

After the first `261108.1` deployment, the full roster remained 500/500 online
and the add-on ran as a separate process. A live sample showed the host at four
cores with low overall load and no Docker CPU quota or throttling, while the
main EveJS process used about 1.16 cores and its event-loop p95 reached 4.2 s.
A 10-second CPU profile attributed most samples to repeated JSON cloning of
dungeon templates/state and entity-ID normalization; this is a main-thread
hot-path issue, not host-wide CPU exhaustion.

The hot-path update includes SHA-guarded compatibility overlays that reuse the
existing JSON-compatible clone walker for dungeon templates and runtime state,
and avoid constructing a default options object for each normalized entity
ID. New tests cover clone equivalence and signed-int64 ID behavior. The release
ZIP contains 98 guarded integration files. Installation, exact source hashes,
rollback to the original `261108.1` files, and preservation of config and game
data sentinels all passed on a disposable copy of the real source.
The `.131` archive was installed on the remote after a fresh consistent snapshot
of both SQLite stores and the non-database game data. The existing 500-pilot
roster remained online, and the install did not reset or move either database.
After the patch, measured event-loop p95 fell from 4.2 s to 2.86 s and the
dashboard summary fell from 11.6 s to 5.3 s. These are improvements, while the
remaining latency is still too high to call the server fully responsive.

The first post-install check exposed a separate integration issue: the new
EveJS deployment health probe used a two-second timeout, while a direct game
and gateway check took 6.7 s and succeeded. That false unhealthy state could
prevent Compose from starting the standalone add-on on a loaded roster. Release
The healthcheck update below raises the probe and Docker healthcheck timeouts; the live
verification is recorded there.

## EveJS healthcheck compatibility follow-up — 9 Nov 2026

The healthcheck overlay replaces the upstream `deploymentHealthcheck.js` with a
15-second probe allowance and merges a 20-second Docker healthcheck timeout.
It also allows 120 seconds for EveJS to flush state on an orderly container
stop. These changes address the measured false negative and give durable state
more time to flush, while retaining both MachoNet and gateway probes. Focused
tests cover the default and explicit timeout paths. The change is hash-guarded
against the real EveJS `261108.1` source and included in the installer
backup/rollback workflow. Its archive passed dry-run, installation, Compose
merge, 99 overlay hash checks, and rollback on a disposable copy of the real
source; config and game-data sentinels survived.

The remote was upgraded without deleting or resetting either SQLite database.
The previous Playerbots sidecar and EveJS stopped cleanly, with process exit
code 0. A fresh snapshot of GameStore data plus online SQLite backups of
GameStore and Market passed `PRAGMA integrity_check`. EveJS, Market, and the
standalone Playerbots sidecar all returned healthy after restart. The full
500-pilot roster reattached (500 online, zero offline); the dashboard served
the summary in 1.4 s and its Operations API returned all 1,806 history records
as pages. The first cold Operations request exceeded its 15-second client
timeout while the history index initialized; the subsequent page returned 200
in 1.1 s.

This proves startup and compatibility, not sustained throughput. In the live
sample the add-on cycle had processed 25/500 pilots after 199 seconds with zero
failures and configured/effective concurrency 1. EveJS event-loop p95 was
3.8 s, process CPU about 105%, and the operations snapshot showed 266 active
work records with 234 pilots lacking current work. These remain open
performance and production-coverage gates; the persisted concurrency setting
was left unchanged during this compatibility deployment.

## Roster work recovery audit — 9 Nov 2026

After the persisted work limit was raised to the 500 online pilots, a full
roster read still found ten pilots with neither an active operation nor a
running durable task. The rows exposed three independent assignment defects:

- Three cross-trained pilots had been offered a corporation war patrol, but
  the combat starter rejected them for not having the `security` specialty.
  The director then applied a one-hour cooldown, leaving them without a job.
- Capsule recovery counted deferred and already-existing recoveries against
  the batch limit. Earlier capsule pilots therefore exhausted the limit before
  the idle capsule pilots were reached.
- An industry cycle in financial review marked its pilot busy, even though the
  cycle itself had no runnable work. That blocked unrelated director work.

Add-on `0.2.134` removes those conditions: security-fit cross-trained pilots
can take a war assignment, the recovery batch counts only new recovery jobs,
legacy cooldowns from the specialty rejection are cleared, and a review-only
industry cycle no longer prevents another assignment. The existing industry
review remains untouched; its pilot may receive a separate job while that
record is preserved for accounting review. Focused isolated tests passed for
these paths.

### Live work availability audit — 9 Nov 2026, before add-on 0.2.135

The remote dashboard reported 495 of 500 pilots with active operations or
industry cycles and five without active work. Four combat pilots had been
assigned war patrols when no legal opponent or local patrol site was available;
the failed starts imposed a one-hour cooldown instead of handing them another
job. One industry pilot had a financial-review cycle and an old failed-sale
cooldown, so that review blocked its unrelated mining fallback. The cycle is
retained for ledger review and is not retried or overwritten.

Add-on `0.2.135` releases only those stale no-target/review-sale cooldowns and
falls back to the normal mining fit or mining-hull upgrade in the same director
pass when a combat patrol cannot start. Focused isolated tests cover fallback
selection and cooldown clearing. After deployment the live roster reached 498
of 500 active pilots; the two remaining cases are detailed below.

### Roster-wide active assignment correction — 9 Nov 2026

The live dashboard and all five pages of the 500-pilot roster showed two
pilots without a currently executing operation or industry cycle:

- Kaijun Kaatanen had a durable queued PI-colony assignment because all five PI
  setup slots were occupied, but the dashboard correctly did not count a queue
  as active work.
- Sakiru Sairento retained an industry cycle in financial review. Its purchase
  evidence is ambiguous, so the cycle must remain unchanged and must not retry
  the market action. The director considered other work, but the operation
  starter still rejected all work while that review cycle existed.

The capacity pass counted operation and cycle records, not unique pilots. The
snapshot had 420 active operation records plus 80 active cycles but only 498
unique pilots with work; two pilots with overlapping records consumed two
capacity slots each. That false full-capacity result prevented replacements
for the two uncovered pilots.

Add-on `0.2.136` deduplicates capacity by character, preserves review-cycle
ledger state while allowing the director to assign only independent mining or
its ship-upgrade path when no purchase/job is pending, and lets a pilot with
queued colony setup take other work while waiting for a PI slot. Focused
isolated tests cover per-pilot capacity, review-safe work selection, and the
guard against starting parallel work when a market action or industry job is
still pending. Live verification found 499 pilots executing active work and
one durable upgrade operation held for financial review after an ambiguous
purchase response. The operation is retained and will not retry without
matching wallet, market, and inventory evidence.

Add-on `0.2.137` changes the fresh-install roster target to 500. Existing
installations retain their saved target and environment settings.

## Telemetry, main-thread cost removal, patrol rotation and unobserved systems — add-on 0.2.142, 11 Nov 2026

Add-on `0.2.142` is the single current release. It replaces the `0.2.138`,
`0.2.139`, `0.2.140` and `0.2.141` test builds of 10–11 Nov 2026 and contains all of
their work. It adapts
four patterns from the Living Universe patch while keeping playerbots as
persistent EveJS characters with sessions, wallets, corporations and
operations that go through the EveJS game authorities.

### What the release contains

- **Performance telemetry.** `GET /v1/dashboard/telemetry` and the dashboard's
  Performance page report event-loop delay, process and main-thread CPU,
  memory, garbage collection, how late scheduled playerbot work starts, work
  time per subsystem, how many bot ships are in systems with no human pilot in
  space, and the site-upkeep cadence used there. Counting scheduled, running
  and due jobs is optional (`EVEJS_PLAYER_BOTS_TELEMETRY_QUEUE_SCAN=1`).
- **Director slice budget.** A director pass hands control back to EveJS
  between pilots once its uninterrupted slice exceeds `directorSliceBudgetMs`
  (default 8 ms; 0 disables yielding and only measures). On a saturated event
  loop each yield returns late, so a pass stops yielding after two seconds of
  accumulated waiting and completes in one slice. Assignment rules, the
  20-attempt limit and capacity limits are unchanged.
- **Patrol rotation.** Piracy pilots no longer all deploy to the nearest pirate
  system. Up to eight systems within six jumps of the nearest are ranked by
  distance, patrols already assigned and deployments in the last six hours.
  Each corporation rotates on its own 45–180 minute period, a system takes at
  most six patrols, and a corporation that used one system in three
  consecutive periods moves on while another is available. Target legality
  remains with Crimewatch, war status and the combat safety checks.
  `EVEJS_PLAYER_BOTS_PATROL_ROTATION=0` restores nearest-system selection.
- **Installation verifier.** `verify.py` reports, per subsystem, whether every
  guarded file and add-on file matches the release. It only reads files.
- **Systems with no human pilot in space.** EveJS runs dungeon and incursion
  site upkeep once a second and refreshes incursion system effects on every
  100 ms gameplay tick in every loaded system. Where no human pilot is in
  space, both now run once every ten seconds
  (`EVEJS_PLAYER_BOTS_UNOBSERVED_SITE_TICK_MS`, `0` restores the normal
  cadence). Site logic is timestamp-driven, so spawns, gates, hazards and
  completions are decided by the same site authorities and only noticed
  later. A human pilot in space restores the normal cadence in that system at
  once. Movement, weapons, NPC behaviour and Crimewatch are not slowed.
- **Main-thread costs removed.** Structure, combat, sovereignty and alliance
  planning read pilot operations without copying all of them on every call.
  A pilot's corporation role masks are reused for up to a minute, or until the
  pilot changes corporation or docking location, instead of being recomputed
  on every session read. The profit-share pass resolves each corporation's
  leadership once instead of copying every pilot's character once per pilot.
  Repeated hits from one pirate NPC are assessed once every three seconds per
  pilot instead of once per hit. Site spawn checks share one template copy per
  call instead of three per encounter plan.
- **Space tick timing and stall watch (new in `0.2.141`).** The 100 ms space
  tick runs on a fixed deadline grid instead of a plain interval timer: a late
  wake does not shift later deadlines, slots that elapse during a long tick
  are skipped and never replayed, and a tick never starts less than 50 ms
  after a very late one (`EVEJS_SPACE_TICK_SCHEDULER=interval` restores the
  interval timer). Every space tick that holds the server for a second or
  longer is recorded with the solar systems it spent the time in and shown on
  the Performance page. Both are adapted from the Living Universe server tree
  (AGPL-3.0, as EveJS and this add-on). Living Universe's background worker
  for route planning was reviewed and not adopted: the profiles above show no
  pure computation in playerbot work large enough to move to another thread.
- **Default limits.** At most 300 bots are online at once by default (it was
  1,500) and 30 autonomous bots per solar system (it was 300). The roster
  target is unchanged; bots above the online limit take turns through the
  connection rotation. The hard maxima stay 5,000 online and 300 per system,
  and values saved by the operator are kept. With 500 bots online the live
  space tick ran about 1.3 times a second instead of ten.

Not adopted from Living Universe: session-less virtual pilots, fixed
pirate/police hostility, scripted campaigns, encounter timers, doctrine
catalogs that would replace the fitting planner, and NPC-stocked regional
markets. Jita remains a seed source for permitted purchases only.

### What profiling the 500-pilot server showed

Earlier entries attributed the delay to long director stages and industry
steps. A CPU profile of the main thread on the live 500-pilot server, with no
human online, showed otherwise. Those durations were mostly time spent
waiting for a saturated event loop; the processor time went to:

| Share of main-thread CPU | Where |
| --- | --- |
| 38% | dungeon and incursion site upkeep in loaded systems, all of them unobserved |
| 21% | director passes: copying every operation for each structure plan (11%) and recomputing corporation role masks on every session read (most of the rest) |
| 12% | the gameplay and movement tick of the loaded systems |
| 7% | threat responses, one full assessment per NPC hit |
| 8% | garbage collection |
| 3% | the scheduled playerbot jobs themselves |

A second profile caught the five-minute cycle's profit-share pass copying
250,000 character records and holding the server for 43–65 s. The scheduler's
"slow job listing" recorded on 10 Nov was a misreading: the scheduler process
answers a listing in about one millisecond and the reply then waits seconds
for the main thread. The tens of thousands of authority-timing warnings per
hour are a symptom of the saturated event loop, not a separate defect.

### Measured on a disposable copy of the live server

Same host, copied databases, 500 pilots online, no human online, director
slice budget 8 ms. Rates are per minute over each window; "start delay" is how
late scheduled work started at the end of the window.

| Build | Director think jobs | Industry steps | Navigation steps | Pilot steps | Start delay | Event-loop p95, median | Main thread |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Before (10 Nov build, 10 min) | 71 | 64 | 26 | 19 | 7–8 min | 4.0 s | 85–98% |
| `0.2.140` build (21 min) | 139 | 139 | 49 | 56 | about 4 min | 3.1 s | 58–98% |

The profit-share pass fell from 43–65 s to 12–17 s per cycle. In the final
profile site upkeep was 12% of main-thread CPU, the gameplay tick 25%,
garbage collection 20% and scheduled playerbot jobs 14%.

Scheduled work completes two to three times faster and starts sooner. **The
server is still overloaded at 500 pilots on this host**: main-thread CPU stays
near one full core, event-loop delay is still measured in seconds, and the
load guard still holds bot steps at one at a time. The freed time is taken up
by the backlog of late work. What remains is mostly the simulation of about
45 loaded systems and the bots' own work, not a single removable hot spot.
The before and after windows are from different runs with drifting workload,
so the rates are indicative, not a controlled benchmark.

### Patrol rotation, live

On the live server every one of the 68 piracy patrols created before the
rotation was deployed went to the same system. The eight created afterwards
were assigned to four different systems, at most three to one. They belonged
to one corporation and were still travelling when checked, so arrival,
engagement and the per-corporation rotation over several periods are not yet
observed.

### Delivery receipt and loss-replacement audit

The Living Universe patch reserves virtual stock, delivers it and records a
terminal receipt. Playerbots move real items and ISK through the EveJS
authorities, so the question was whether any flow can charge without
delivering, or deliver twice, after an interruption. This was a code review,
not a restart-injection test.

| Flow | Protection found |
| --- | --- |
| Ship and module purchase (upgrade, loss replacement) | pending marker with wallet and inventory baselines saved before the market call; an unknown or charged-without-items outcome goes to review and is reconciled against the wallet and hangar, never retried blindly |
| Industry-cycle purchase, sale and listing | pending marker with unit, balance, order and transaction baselines; recovery reconciles against the market and wallet journal; listings that changed nothing are confirmed over repeated observations |
| Industry job install and delivery | pending marker with quoted cost and balance baseline; delivery keyed by job |
| Supply contract between pilots | pending marker with a token, seller, units and price |
| Trade tasks | uncertain sales and purchases are flagged for review and not repeated |
| Planetary export and collection | operation key per launch; refund and collection use idempotency keys |
| Profit share, starting capital, war grants and stipends | wallet transfers carry idempotency keys; an interrupted profit-share transfer is recovered from the journal |
| Hauling and couriers | real items in a real cargo hold; a restart can only miscount the informational "units moved" total, not create or lose items |
| Working after a loss | combat and mining assignments require a complete fitted hull for the role; capsule recovery defers to any unresolved purchase or industry job |

Conclusion: no change required and none made. Open: a test that interrupts
the process between charge and effect for each flow.

### Gates

| Gate | Implemented | Focused tests | In ZIP for EveJS 261108.1 | Live behaviour proven |
| --- | --- | --- | --- | --- |
| Subsystem telemetry | yes | yes | yes | yes, on the production server |
| Director slice budget | yes | yes | yes | passes yield and stop yielding when saturated; no latency benefit shown |
| Patrol rotation | yes | yes | yes | destinations spread across four systems; arrival and multi-period rotation not yet observed |
| Installation verifier | yes | install/rollback matrix | yes | passed on the production checkout |
| Unobserved-system cadence | yes | yes | yes | counters show passes skipped on the disposable server; never exercised with a human entering a system |
| Main-thread cost removal | yes | yes | yes | two to three times the completed work on the disposable server; server still overloaded |
| Defaults of 300 online and 30 per system | yes | yes | yes | not applicable |
| Deadline tick timer and stall watch | yes | yes | yes | recorded in the handoff |

Install, rollback and production results for the archive are recorded in the
11 Nov 2026 handoff, because they are measured after the archive is built.

Open after this release: the server remains overloaded at 500 pilots on the
test host, so either the roster, the number of loaded systems or the per-pilot
work must come down, or the remaining simulation cost must be reduced further;
the unobserved cadence has not been exercised with a human arriving; patrol
arrival and rotation over several periods; interruption tests for the audited
flows; the burst of overdue jobs after every restart; the 15,000-pilot and
5,000-online targets, which this evidence argues against on this host; and
every live gate listed earlier in this roadmap.

## Community contributions — add-on 0.2.143, 12 Nov 2026

Seven pull requests from @gzy40347 to the public add-on repository were
reviewed, merged and packaged:

| PR | Change | Notes from review |
| --- | --- | --- |
| #1 | A mining trip counts only ore the unload confirms; ore within reach is preferred; ordinary miners move away from a base whose belts are all unsafe (territorial work keeps its base); stale asynchronous mining results are discarded | also overlays `miningNpcOperations.js`, whose export the bots already used but which the published overlay did not ship |
| #2 | Upgrades reuse an owned hull of the requested type at a reachable high-security station before buying another; a vanished reserved hull blocks instead of buying a substitute | a pilot already flying the requested hull only replenishes modules |
| #3 | Structure relocation skips points rejected by the ESS warp rule | |
| #4 | The security Dominix fit uses five mid slots; saved jobs with the old fit are repaired and the surplus module is returned to the hangar; fits are checked against the hull's slots before buying | |
| #5 | War patrols require an active war and a legal target and respect the combat cooldown | patrols no longer start during the declaration wait |
| #6 | Unconfirmed industrial purchases keep the request, baselines, observed outcome and the market authority's message | no retry is added |
| #7 | Opt-in local defense: same-system responders defend an attacked bot within Crimewatch rules, then resume their work; off by default with empty allow-lists; administrator commands under `/playerbots defense` | adds small hooks to `crimewatchState.js`, `hostileModuleRuntime.js`, the chat command router and the scheduler (`wakeEarlier`) |

Review covered every added line for network, process and file-system access
(none outside the existing authorities and test runners), the engine files
newly overlaid (each differs from EveJS 261108.1 only by the stated exports or
hooks), and the conflicts between the pull requests (resolved by keeping both
sides; PR #7's mining guard supersedes PR #1's). Nine existing tests needed
their fixtures updated for the new checks or the intended behaviour changes
above; one new test covers the war declaration wait. The contributors' own
tests ship in the public repository under `tests/`.

Live behaviour: local defense was not enabled on the remote server, and the
other changes have not yet been observed in live play.

## Corporation-wide orders from Luna — add-on 0.2.145, 13 Nov 2026

Luna's `/bots corp recall|work|status|hq` commands were submitted on Luna's
behalf as pull request #8 (#9 carried the same code plus Luna's original
archive, which was checked to match and not committed). Review fixes:

- `work director` after `work mine` left the mining job queued; any new order
  now replaces the corporation's earlier recall and work orders.
- A structure trip step still in flight when an order was cancelled could
  record a late result; it is now ignored.
- A pilot whose structure recall failed or timed out stayed paused in space
  without threat responses; it is now released to the director.
- After a restart, pilots held by an unfinished recall stay paused; `status`
  now lists them with the commands that release them.
- The saved HQ was written to a JSON file outside the game store and the
  module could load server code from a directory named by an environment
  variable; the HQ is now kept in the `playerBots` table and the module uses
  normal relative requires.
- A Compose volume added for the add-on container pointed at a path that does
  not exist in a standard deployment and would have hidden the add-on's own
  files; it was not taken.

Still to check in live play: recall and work with a full corporation, and
structure recalls through low-security space. Work for a corporation whose HQ
system has no safe belts is assigned outside the HQ area by design.

## Population spread, names, market orders and bot-versus-bot combat — add-on 0.2.146, 13 Nov 2026

From a tester's report: bots crowded New Caldari and The Forge, names repeated,
no market orders were visible outside Jita, and bots never fought each other.

- **Where bots are born and work.** Every bot was a Deteis Caldari and every
  bot sold, bought and built at one hub station in New Caldari, so the roster
  converged there whatever the per-system limit. New bots now take a race and
  one of its starting schools, choosing the school whose system holds the
  fewest bots, and work from their empire's hub (New Caldari, Amarr, Dodixie
  or Hek). Relocating pilots take the least crowded system within four jumps
  of the nearest free one instead of filling the nearest system first.
- **Names.** 50 first and 50 last names per race instead of 18 by 12 for
  Caldari only; the least used first name is preferred.
- **Market orders.** Trade pilots keep standing mineral buy orders at 90% of
  the Jita price where they are docked and list what they bought at the Jita
  price, with real ISK through the market authority. Jita itself and the
  Jita-only seed are unchanged.
- **Bot-versus-bot combat.** Piracy, war and defensive target rules no longer
  exclude other playerbots (corporation, alliance and fleet mates still are),
  and bot-run corporations with a structure as war headquarters declare
  normal wars on bot-run corporations they share systems with.
- **Dashboard settings.** After saving, the dashboard reads the settings back
  and lists any value that EveJS has not applied, including when the request
  timed out on a busy server.

Remote server: on 13 Nov the live server stopped twice because SQLite stayed
locked for over a minute and the persistence owner lease expired
(`PERSISTENCE_OWNER_LEASE_LOST`). The game database had grown to 464 MB,
mostly `dungeonRuntimeState` (174 MB) and `items` (137 MB). At the
operator's request the world was reset to a fresh database (backups kept),
and character orders were removed from the market while the Jita seed was
restored. Why `dungeonRuntimeState` grows is an EveJS question that was not
investigated further.

On the fresh world most pilots first need a ship from Jita, the only seeded
market. With the per-system limit of 30, about half of a 283-pilot roster sat
queued for Jita with no work; first-ship shopping trips to Jita may now
number up to 150 (or the configured limit, if higher).

Still to observe in live play: how evenly a full roster spreads, traders'
orders being filled by miners, and the first bot-versus-bot war, which needs
a bot corporation to own a structure first.


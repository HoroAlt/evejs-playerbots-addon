# Playerbots capacity model

## Population terms

The capacity target has four separate measures:

1. **Persistent roster** — character and corporation records stored in EveJS.
   The configured ceiling is 15,000 identities.
2. **Registered online sessions** — pilots admitted by the connection
   scheduler. The requested ceiling is 5,000.
3. **Attached/in-space actors** — sessions currently participating in a
   solar-system simulation. Their cost is higher than a docked session.
4. **Active work** — pilots executing durable travel, mining, combat, market,
   industry, planetary, or structure steps. This has its own configurable
   capacity and is not the same as the session count.

A roster of 15,000 does not imply 15,000 simultaneous sessions, and 5,000
sessions do not imply 5,000 ships are in one ballpark. The dashboard and load
reports must keep these measures distinct.

## Evidence and current limits

The current public-test profile defaults to a gradually seeded target of 500
bots, a 1,500 persistent-roster ceiling, and a 300 online-session limit.
The clean remote trial explicitly sets its target, roster ceiling, and online
limit to 500. It reached 500 persistent bots and 500 registered sessions at the
same time. Fresh installs use bounded batches and EveJS load checks; existing
saved settings take precedence and are not rewritten by the installer.

Capacity claims in this add-on are based on measured EveJS runs. Persistent
roster size, registered sessions, in-space actors, and active work are recorded
separately; a target or short run is not evidence of sustained capacity.

**Latest remote connection sample (8 Nov 2026):** 500/500 bots were registered
online simultaneously, with zero offline bots, 27–48 in space, 447–468 docked
and five with location still resolving. There were no connected humans during
the sample. EveJS remained healthy without OOM or unplanned restart. Across
post-ramp samples, memory ranged from 2.6–3.2 GiB, server CPU from about
64–118%, and event-loop p95 from 96–426 ms. An 18.1-second p95 spike occurred
during each large connection/restart wave. This proves the 500-session target
for this short sample, not consistent latency, sustained production throughput,
or the 5,000-session target.

An earlier EveJS remote baseline was 100 registered pilots, approximately
47–54 in space, and 94 active operations. A serialized post-restart add-on
pass completed 100/100 with no failures in 4m47s. During recovery, event-loop
p95 reached roughly 1.3–5.1 seconds and the server process briefly used about
three CPU cores. The host had 4 vCPUs and 7.7 GiB RAM. These warm-restart
observations remain useful historical context, not the current live result.

The 4m47s pass is approximately 0.35 bot steps per second. If every 5,000
online pilots must receive one add-on step in each five-minute interval, the
required average is 16.7 steps per second, about 48 times that serialized
baseline. The interval may be lengthened for low-priority maintenance, but
safety responses and player-directed work must remain prompt.

## Scaling changes

- Ordinary add-on work steps no longer make an extra per-pilot scheduler query
  just to confirm their already self-rescheduling durable job. Missing jobs
  are repaired during a roster reconciliation and scheduled in batches capped
  at the scheduler's 1,000-job limit.
- Director and autonomy hot paths use indexed bot lookup, a short-lived
  read-only planning roster, and shared read-only operation/cycle/character
  records rather than repeatedly deep-cloning full maps.
- New operation, industry-cycle, and per-pilot director-state writes use
  independent flat GameStore rows. Existing `_operations`, `_industryCycles`,
  and `_director.bots` data remains readable and is migrated as pilots are
  updated; the installer does not reset the database.
- Productive pilot counts are derived in one pass over active work rather than
  rescanning every operation once for each human corporation.

These changes remove identified O(N) copying and extra scheduler round trips
from individual work updates. They have not yet demonstrated 5,000 live
sessions; remote latency, actor simulation, market authorities, persistence,
and chat/session costs still require measurement.

## Safe remote ramp

The remote seeder is capped at 1,500 pilots for the current public test. The
connection scheduler remains capped at 5,000. Provisioning remains gradual:
bounded batches, a delay between batches, server-side event-loop/CPU checks,
and automatic pause when a batch is too slow or load crosses operator-set
guard bands. Set those limits from measured load before a monitored scale
trial; keep them conservative enough to protect human traffic.

After each step, record persistent roster, connected sessions, actors in space,
active work, seeding rate, event-loop p95/max, server and add-on CPU/RSS/heap,
scheduler pending/running counts, API response latency, work-step failures,
and login/undock latency. Pause seeding immediately if ordinary player actions
or event-loop latency regress.

Run explicit stages at 100, 250, 500, 1,000, 2,000, and 5,000 sessions. Hold
each stage long enough to include several work cycles, connection-window
changes, and at least one server restart/recovery before increasing it.
Capacity is accepted only when p95 event-loop delay stays below 100 ms during
steady work (50 ms preferred), scheduler queues drain within their service
window, no repeated operation failures or missed safety actions occur, memory
keeps restart headroom, and human login, undock, and market requests remain
responsive. A short run or a docked-only roster does not pass the gate.

The live remote roster was still 100 when the 3,000-pilot trial was prepared. The
configured target is 3,000 persistent pilots and 3,000 online; that is a
requested test scale, not a validated result. Earlier, the seeder paused every
batch because its fixed 50 ms event-loop and 85% process-CPU thresholds were
below measured operating values. A dashboard update makes event-loop p95, process
CPU, and per-pilot creation limits configurable in the dashboard while keeping
bounded batches, yielding, and automatic pause logic. For this monitored trial
the remote settings are 3,000 ms event-loop p95, 300% process CPU, and 1,000 ms
maximum for one bot creation. The actual roster, online count, seed rate, and
ordinary login/undock responsiveness must be recorded before describing 3,000
as sustained capacity.

Read-only remote audit on 8 Nov 2026 at 09:56 UTC: the persistent roster had
reached 580 pilots across 12 managed corporations, and the gradual seed worker
was still active. Existing managed specialty corporations, including the
human-CEO `EVEJS Frontier Compact`, are eligible for new pilots before
additional shards are founded. Never seed unrelated player corporations
without an invitation or an explicit membership policy.

Latest remote snapshot (8 Nov 2026, 09:58 UTC): 620 persistent pilots, 620
connected sessions, 71 bots in space across the server, and 192 active
operations. The dashboard counted 503 residents in Manifest, above the
configured 300 autonomous residents per system; 93 relocation operations were
active, but the count had not yet recovered below the limit. The system count
is not a same-grid ship count. The last seed batch reported 1.72 s event-loop
p95, 4.01 s maximum creation time, and a 10 s p95 safety threshold. Server and
add-on health checks were healthy with zero restarts at 09:57 UTC, and Market
was healthy with its existing container ID. The configured online ceiling was
3,000, below the requested 5,000 target. This demonstrates ongoing staged
seeding only; the previously validated sustained-work maximum remains 100.
Do not raise the next stage or claim per-system compliance until the relocation
backlog is observed clearing and player-facing latency, productive work, and
restart recovery meet the acceptance gates above.

Seed safety intervention (8 Nov 2026, 10:03 UTC): after the roster reached 671
and Manifest 553, gradual seeding was paused from the dashboard. The setting
was confirmed persisted, and the add-on log recorded the in-flight final batch
at 685 with reason `roster seeding is paused`. That batch reported 4.84 s
event-loop p95 and one operation-step timeout. A read-only GameStore audit at
10:05 UTC found 685 bot profiles, 566 assigned to Manifest, and 100 active
relocations, unchanged from the prior audit. All three remote services were
healthy with zero restarts at 10:05 UTC. Resume seeding only after relocations
show progress, system residency falls below 300, and player-facing latency is
rechecked. This pause is a safety action, not a capacity pass.

Read-only relocation audit (8 Nov 2026, 10:15 UTC) found 685 profiles, 462
residents in Manifest, 103 in system 30005204, 47 in New Caldari, 22 in Jita,
and 96 active relocations. Compared with the 10:05 audit, Manifest had fallen
from 566 and relocations from 100, so placement work was progressing, but
Manifest remained above its 300-resident limit. Keep seeding paused until
destination counts are compliant and player-facing login/undock latency is
checked again. All 685 profiles had corresponding character records; this does
not establish that all sessions were connected at the time of this later
read-only audit.

Specialist shards target 250 bots and cap at 300 bot members. A human CEO is an
additional member, so a corp that holds 300 bots plus that CEO needs a
persisted member limit of 301. Managed shards keep that capacity after a human
takes the CEO seat. Corporation Management V and Megacorp Management II provide
300 EVE-style member slots; a human CEO's published skills may be raised
through the normal skill owner before the operator sets the corp's explicit
limit.

The autonomous placement cap defaults to 30 bots per solar system and is
configurable up to 300.
Bots in a fleet with a connected human commander do not consume autonomous
placement capacity. Durable orders can still enter a full system to complete
finite work, then leave or trigger relocation. System occupancy is a placement
policy, not an artificial movement restriction.

## Market planner profile and indexed lookup fix (8 Nov 2026)

At 10:48 UTC the remote roster remained at 685 bots with seeding disabled. The
add-on's effective step concurrency was 1 of 4, event-loop p95 was 4.93 seconds,
and the EveJS process used about 106% of one CPU core in the latest add-on
sample. Scheduler commands reported 3.5–3.8 second round trips despite less
than 1.2 ms in the scheduler worker. A short V8 profile traced repeated work
through `playerBotDirectorRuntime` → `findUpgradeMarketStation` →
`findSellStationsForPackage` → `listSellOffers`.

The database query plan showed why: asking `seed_stock` and `market_orders` for
one type across the whole universe could not use their region-first indexes.
The regional lookup uses all 115 region IDs present in static universe data,
including region 0, so SQLite can use the existing region/type indexes without
changing or rebuilding Market's database. A read-only remote comparison for
type 34 returned the same 2,832 offers: 219.43 ms for the type-only query and
13.26 ms for the indexed regional query. The seed-stock-only comparisons for
types 34–36 took 248.92–368.52 ms before and 0.33–6.32 ms after. The query plan
confirmed the region/type indexes on both tables. A focused regression test
checks worldwide offer semantics and those index paths.

This is a measured lookup improvement, not yet a sustained server recovery
result. The 685-bot cycle had reached 350/685 without failed steps, but the
server still logged delayed scheduler round trips and missed simulation ticks.
The remote seeder remains paused. Keep the performance gate open until the
deployed build shows event-loop p95 below 100 ms, responsive human login and
undock, bounded memory, and several complete productive cycles without missed
safety work.

## Dashboard and portrait pass (8 Nov 2026)

The dashboard path avoids normalizing each roster character merely to
show operator fields. It reads cached bot profiles and uses the character
store's read-only record for corporation and location summaries. Portrait pool
directory scans are cached by directory modification time. New portrait
assignments append to `assignments.log`, replay after restart, and compact into
the compatible `assignments.json` map every 1,024 appended records. Focused
tests cover the projection, directory invalidation, log replay, and legacy map.

The remote first-summary request exceeded the dashboard's 10-second deadline
before this change. Post-deploy, the general summary still returned an error
after 10.1 seconds. A seed-status request completed in 0.909 seconds but
reported 2,791.3 ms event-loop p95 and 200.3% process CPU; separate Docker
samples ranged from 100.48% to 377.42% server CPU during recovery. The server,
add-on, and Market containers reached healthy state with zero restart counts;
the 685-pilot add-on cycle had reached 75/685 with no failures at the sample,
using effective concurrency 1 of 4. Seed status remained disabled, not running,
with target 3,000. These are early recovery samples, not steady-state capacity
or a completed cycle. Keep the dashboard and sustained event-loop latency gates
open until summary and roster pages respond promptly, event-loop p95 stays
below 100 ms, login and undock are responsive, and complete productive cycles
finish without missed simulation work. Roster seeding stays paused.

The server restart exposed a shutdown-order race in the old process: GameStore
durable flushing started while a solar-system scene tick still executed
`crimewatchState`/`dockSession`, producing an uncaught exception report. The add-on update stops the world-simulation interval before the durable flush and makes
queued tick callbacks return early; a focused isolated test covers cancellation
and the guard. A controlled remote restart logged `GameStore shutdown flush
complete` without an uncaught exception or Node report, then returned EveJS to
healthy state. This closes that restart check; general performance and user
latency remain open.

A dashboard update adds a sorted dashboard operation index updated as live work,
archived operations and industry cycles change. The preceding remote sample
had 6,141 dashboard records; reading the active filter took 7.98 seconds even
though a page request took 1.9 seconds. This was the path rebuilding and
sorting the whole archive for every filter/page request. Re-measure the same
filter and final-page API after deployment; keep the responsiveness gate open
until summary and filtered operations stay within the 1-second target through
a complete 685-bot cycle.

## Live event-loop profile and follow-up (8 Nov 2026)

The 44.4-second remote V8 capture at a 685-pilot roster sampled 34,059 CPU
stacks. The largest repeated costs were customs-session attachment deep-copying
the complete inspection-case map (4.48 CPU seconds), career projection loading
the complete Abyssal instance path on committed gate arrivals (3.36 seconds),
market matching deep-copying escrow records for each candidate order (1.51
seconds), and garbage collection (3.82 seconds). The EveJS process used about
139% of one core during a simultaneous sample; the add-on remained below 1%.
This is direct evidence that the delay is in repeated synchronous server work,
not proof that the remote host has exhausted its CPU or memory.

A subsequent optimization removes those three repeated whole-state paths: career commits
project from already-committed facts without replaying global recovery scans;
customs reads clone only the selected records; and pending market fills are
looked up from an index rebuilt once and updated with escrow writes. Isolated
tests cover recovery-option forwarding, detached customs records, and index
rebuild/update/removal behavior. Re-profile the live server after deployment,
then compare login, undock, market requests, scene-tick delay, and add-on cycle
progress at the same 685-pilot baseline before resuming roster seeding.

### Scope career projections to committed activity

After the optimization was installed, the remote dashboard's static assets loaded in
35–108 ms, while API reads took 1.7–5.8 seconds. A live V8 profile attributed
3.32 CPU seconds to full durable-table reads inside career projection, reached
repeatedly from gate-arrival events. The projection still checked combat and
all other career sources even when only travel progress had changed. The add-on update projects only career-event goals for ordinary committed events, adds
visited-region goals for gate jumps, and reads that character's map visits by
indexed path. Isolated tests cover projection scope and per-character visit
reads. These are causal code findings; deploy and remeasure before claiming
the web is responsive.

Keep seeding paused until summary and the Operations page return within the
one-second target at the same roster size, and event-loop p95 remains below
100 ms while bot work continues. Measure a second request after cache warmup
and a page load with the same browser view before deciding whether more API or
persistence changes are needed.

### Avoid repeated route planning for structure candidates

The first profile after the career update removed the career whole-table read from its
largest samples. It then found about 3.0 CPU seconds in `positiveID` under
nullsec structure planning: one bounded reachability BFS called the full
weighted route planner for each claimable system, and route planning also
re-sorted static gate lists. The route update uses the BFS path and carries its
risk summary to each candidate; the route used for actual deployment retains
the safe weighted planner. It also consumes the already sorted gate lists.
Focused isolated tests check hop bounds, null/low-sec risk and that candidate
planning does not invoke a Dijkstra search per system. Deploy and measure under
the same active 685-bot workload before reopening the scaling gate.

The current public package is 0.2.144 (built for EveJS 261108.1). Measure before scaling: its Performance page reports event-loop delay, main-thread CPU, scheduled-work lateness and time per subsystem, so a larger roster can be judged against recorded values instead of a single profile. The clean remote test is configured for
a 500-bot roster, 500 online sessions, and a 500-bot ceiling; all 500 were
connected in the latest snapshot. The long-term 15,000-pilot roster and
5,000-online target remain unvalidated.

### Live work availability audit — 8 Nov 2026

At 22:28 UTC, the remote dashboard reported 407 of 500 pilots with active work
(327 active operations plus 80 industry cycles) and 93 without active work.
Those 93 included 60 pilots with no operation record and 33 whose last
operation was complete, stopped, or blocked. Of the 60 with no operation
record, 59 were docked in Manifest in an Ibis; they had the seeded wallet and
Mining Frigate skill, but no fitted mining hull to use. Twenty-five more idle
pilots had just completed a capacity relocation and had not yet received their
next job.

The ship-upgrade queue was sending 262 pilots toward Jita while 52 bots were
already resident there, a forecast of 314 against the 300-per-system cap. This
includes upgrades bought from several different Jita stations; station count
does not create extra system capacity. This leaves fresh Ibis pilots without a safe Jita
arrival slot for the Venture and modules they need. The 500 configured work
slots are therefore not the bottleneck, and an assignment cap of 500 does not
mean all 500 can immediately execute work when their required market trips
cannot enter the same capped system.

The current add-on enforces the Jita arrival cap in lightweight roster-wide
director passes without repeating market-package lookups. It persists the
pending planetary setup reason per pilot and shows queued PI separately from
active work in Overview, Operations, and the pilot list. A queued setup is not
counted as active production. The package does not claim that 500 active jobs
have been achieved.

### Post-deployment live check — 8 Nov 2026

The preceding package was installed through the Server Panel Compose project and the
EveJS and add-on health checks passed. Market and the database were left intact.
At 22:45 UTC the summary reported 500 online, 268 in space, 384 with active
work, and 116 without active work. A full 500-pilot list read at 22:43 found
113 without an active operation or cycle; 111 had a persisted queued-work
entry. Counts moved during the startup recovery and first driver cycle, so
these are timestamped snapshots rather than a steady-state measurement.

The pilot rows identify why they are waiting. At 22:43, the Jita reservation
was full at 300/300 (143 resident pilots plus 157 inbound), and five planetary
setups were already active. Of the 113 pilots without active work, 111 had a
queued PI setup record. Many had a stopped upgrade operation whose last action
states that Jita had reached its 300-pilot system limit. The remaining two
were a completed Vexor upgrade with no follow-up job and an Ibis with no
operation record. This shows that the earlier 98/93-style dashboard count was
not a roster or connection failure: most were explicitly queued behind market
and PI capacity, with a small number still needing director reassignment.

The post-restart safety sample reported event-loop p95 of 3.26 s and process
CPU of 92.8%; configured add-on concurrency remained 1 and the driver cycle
was progressing with no failed steps at 22:45. The hard 300-pilot per-system
cap remains in force. Clearing the wait requires the market-slot queue to
drain and eligible pilots to receive fitted ships or other work in their
current systems; reporting queued pilots as active would hide the actual gap.

The director think scheduler also retains one durable think job per connected
pilot. The preceding scheduler update coalesced overlapping idle-pilot thinks into
a roster-wide assignment pass, replacing repeated per-pilot roster scans. The
remote relocation limit is 100 so over-capacity residents can be moved without
breaking the 300-pilot system limit. The active-work count remains the live
validation gate.
### Previous live run (before the clean 500-bot reset)

The following measurements describe the previous run and must not be read as
current state. At 17:53 UTC on 8 Nov 2026, the remote server had 1,339
persistent bots, 1,338 connected sessions, and 80 in-space actors. Manifest
held 795 bots, which exceeded the 300-per-system placement limit. Four
structures were fully powered and cored, one Astrahus was still anchoring
without a core and at low power, and no sovereignty systems were claimed. That
trial remained unvalidated until live work, market income, movement, and server
latency gates passed.

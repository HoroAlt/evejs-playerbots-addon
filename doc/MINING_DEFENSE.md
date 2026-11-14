# Mining-bot defence against NPC pirates — spec

Spec only: no code, no deploy, no upstream contact. Branch `dev`, live tree `/srv/stand/EveJS-261108.1`.
Paths abbreviated: `threat` = `playerBotThreatResponseRuntime.js`, `op` = `playerBotOperationRuntime.js`,
`escort` = `playerBotMiningEscortRuntime.js`, `cd` = `playerBotCombatDecisionRuntime.js`,
`cr` = `playerBotCombatRuntime.js`, `pol` = `playerBotDefensePolicy.js`, `dir` = `playerBotDirectorRuntime.js`,
`ldc`/`ldr`/`lda` = `playerBotLocalDefenseConfig/-Runtime/-Adapter.js`. All under `integration/server/server/src/services/playerbots/`.

## 1. Threat model

Belt rats (`space/npc/beltRatRuntime.js:189-250`) spawn per security band, one group per belt, 30 km out (`:405-424`):
highsec ≥0.8 → 1 frigate; ≥0.45 → 1-2 (frigate/destroyer); lowsec → 2-4 (up to cruiser/BC); nullsec → 3-5 (cruiser/BC/BS).
Special spawns: hauler 2-4, commander, officer (home regions), rare capital (`:52-90`). Respawn 20 min, roll 120 s
(`:405-413`). `beltRatRuntime` has no escalation waves; anomalies are a separate tiered system (`cr:502-537`).
Aggro: `autoAggro` 50 km, commanders up to 140 km (`NpcEngage … retail_dire_guristas_nullifier aggressionRangeMeters=140000`,
23:48:51). NPCs can warp-disrupt (`npcBehaviorLoop.js:1345-1349`), and combat ops already kill the tackler first (`cr:1461-1481`).

Current NPC response is one line: `threat:102-104` wakes the pilot and returns `wake-pve-response`; a miner is only
assessed if it already has an escort (`threat:125`), so an unescorted miner records nothing. The mining loop reacts on its
15 s poll (`op:25`): pause lasers, wait ≤45 s for an escort (`op:39-40`, `op:1067-1150`), withdraw if damaged (`op:911-914`).
Evacuation then blocks forever while scrambled (`op:750-755`) and a miner cannot clear tackle.

How ships die today (live stand, read-only):
- 6 h of logs: 1143 × `action=wake-pve-response`, **0 × `miner-retreat`**, 3 × `combat-evade`, 2 × `evacuate`.
- `killmails`: 50 × Venture (32880) on 10-13 Nov (25/15/10), avg 1253 damage, all `finalFactionID=500010`; top systems:
  23 in New Caldari 30000145 (0.949, exactly 1 frigate/belt), 15 in M-OEE8 30000848 (-0.22), 9 in Taisy 30001447 (0.33).
- Last one 13 Nov 23:50:44 in M-OEE8: warp ordered :40, capsule at :44, 688 total damage — the 45 s wait outlived the ship.
- Unrelated: 2 Vexors + 3 Algos + capsules died 00:31-00:34 today in M-OEE8 to `finalFactionID=500001` (not a pirate).

## 2. Response ladder

| Step | Trigger (all must hold) | Action | Decided by |
|---|---|---|---|
| L0 gate | belt not blacklisted; if any rat visible, a security pilot is already on grid and `ready` | enter belt | mining pilot |
| L1 drones | exactly 1 rat, frigate class, shield ≥0.60, not scrambled | launch 1 light drone, keep mining ≤1 cycle | mining pilot |
| L2 leave | any damage tick, **or** ≥2 rats, **or** destroyer+ in <0.5 sec, **or** shield <0.75 after first hit | stop lasers, warp to station (`op:5309-5331`) | mining pilot |
| L3 in-system | L2 active and (scrambled, or ≥2 rats, or L1 target not dying) | 1 same-corp security pilot, same system, ETA ≤60 s | director |
| L4 cross-system | no in-system candidate, route ≤3 jumps, ETA ≤180 s, survival > ETA+3 s | 1 responder | director |
| L5 abandon | 2 belts blacklisted in 60 min, or any ship loss | blacklist system, relocate base (`op:1018-1034`) | director |

L2 is unconditional on damage: the miner never stays to tank. L3/L4 are a rescue while leaving, not a reason to stay —
the miner keeps aligning and docks even if the responder arrives. 0.75 matches the combat entry reserve (`cd:15`);
0.60/0.35/0.20 come from `pol:2-13`. L1 exists because a scrambled Venture cannot warp; otherwise warping always wins.

## 3. Drone policy

| Hull | Carry | Launch |
|---|---|---|
| Venture 32880 (T1 mining) | 1 × Hobgoblin I (thermal) or Acolyte I (EM) | scrambled, or 1 frigate rat with shield ≥0.60 |
| Procurer/Retriever/Covetor 17478/17476/17480 | 2 × light | scrambled, or 1 destroyer rat |
| Mackinaw 22548 | 5 × light | same as barge |
| Escort Tristan/Algos (tier 1-2) | 5 light (Acolyte/Hobgoblin/Hornet/Warrior, `op:1601-1614`) | native combat path |
| Escort Vexor+ (tier 3-5) | 5 medium (Infiltrator/Hammerhead/Vespa/Valkyrie, `op:1616-1652`) | native combat path |

Rules: launch only against a rat already aggressed on the ship; engage at ≤20 km; recall at 60 % of the hull's
`droneControlDistance`; always `commandReturnBay` before warp (`cr:1442-1453`). The Venture rung has no `droneTypeIDs`
today (`op:1591`), so a mining drone is added to that rung and the normal upgrade path buys and loads it (`op:2076-2093`).
Cost that matters: a missing drone fails `hasRoleShipFit` for security (`op:2129`) and `cd:206-208` already withdraws on
drone casualty, so each loss benches an escort until restock. Budget 5 drones/pilot/hour, then drones off and pure retreat.
Never launch while merely aligning.

## 4. Reinforcement algorithm

Eligibility (reuse `escort:224-248`): online, `specialty=security`, no active operation (`:227`), no local-defence lease or
pending interrupt (`:228-230`), `hasRoleShipFit("security")` with tier ≥ required (`:238-240`), route succeeds (`:241`), and
**new** `hops ≤ 3` — today hops is only a sort key, never a filter (`escort:147-163`, `:243-248`). Always excluded: pilots with
an active `war` combat op or live war-mobilization assignment (`playerBotWarMobilizationRuntime.js:262-291`).

Order (existing sort, `escort:246-248`): same corporation → same alliance/agreement (`lda:22-52`) → fit tier desc → hops asc →
characterID. **Live conflict:** corp 98000002 is industry-only, 98000003 planetary-only, 98000006 sovereignty-only; only
98000001/4/5 mix in security. A miner in the industry corp cannot be reinforced by its own corp today — see Q1.

Dispatch: 1 responder per belt `groupKey` (system:belt, `escort:33-39`), not per miner; a second only if the first dies or
ETA >120 s. Ratio 1 responder per ≤2 rats, hard cap 1. ETA: same system 60 s; cross-system `hops × 45 s + 15 s` dock/undock,
or the native in-flight estimate (≤15 s only, `playerBotRescueArrival.js:52`). Never dispatch when `survival ≤ eta + 3000`
(same gate as `pol:124-136`).

Payment: pilot wallet. Defence fits are drone-only (`op:1591-1652`), so the only recurring cost is drone replacement. If pilot
balance < 3 × drone price the corp wallet tops up via corp-economy, bounded at 100 000 ISK/incident and 1 000 000 ISK/day/corp.
No ships are bought for defence.

Limits: 1/incident, 2/system, 4 global, 10 min cooldown per responder, never preempt a pilot with an active operation, never
pull a war-assigned pilot. Rationale: 100 of 500 pilots online, 43 mid-upgrade, 47 mining ops against 5 combat ops today
(live `/api/summary`).

## 5. Retreat and avoidance

Leave when: any damage while mining; or a visible rat without an engaging escort; or shield <0.75 at first hit; or scrambled
with no drone/responder. Destination is nearest NPC station in system (`op:5309-5331`) — there is no safe-spot concept in the
codebase and none should be added for v1. Keep the existing 30 min `dangerousBelts[beltID]` (`op:38`, `op:906-909`) but
**persist it** in a new `_miningDefenseSafety` row (system:belt → until), because it lives on the operation object and is lost
when the operation is replaced. Add a system blacklist: 60 min in nullsec (M-OEE8 pattern), 30 min otherwise. When all belts
are blacklisted the existing relocation path applies (security ≥0.45, ≤15 hops, `op:1018-1034`, `op:779-816`). The blacklist is
set on the first retreat (already at `op:948`, `:5412`), so a rat group cannot recycle bots into the same belt inside the window.

## 6. Integration

Extend:
- `threat:100-140`: for `operation.kind === "mine"` always call `setMiningIncomingThreat(..., {action:"retreat"})` on the first
  NPC damage tick (drop the `escortCharacterID > 0` condition at `:125`), then optionally promote to the escort path. This is
  the whole "don't die in the 15 s poll" fix and needs no new module.
- `escort`: add `underFire`/`maxHops`/ETA and a `hops ≤ N` filter in `findPendingMiningEscortRequest` (`:112-168`); keep the
  group dedupe (`:198-219`) and 30 s retry (`:269`).
- `op:1067-1150`: keep the 45 s unarmed-rat wait, add a 20 s under-fire wait; keep the existing withdrawal on damage.
- `dir:1106-1142`, `:1221-1224`: escort already has top precedence — add the war-assignment exclusion only.
- New `playerBotMiningDefenseRuntime.js` (pure: severity from rat count/class, ladder decision, blacklist, drone budget) and
  `playerBotMiningDefenseConfig.js` mirroring `ldc:20-55`.

Do **not** extend `lda`/`ldr` to NPCs: `lda:92-114` deliberately classifies pirate NPCs as null and `ldr:54-57` requires a
positive `attackerCharacterID`; relaxing that breaks the documented PvP contract in `LOCAL_DEFENSE.md`. Do not change
Crimewatch/legal targeting (`playerBotCombatPolicy.js:115-141`), local-defence defaults (`ldc:2-15`),
`assessDefensiveResponse` for combat pilots (`cr:745-800`), ladder tier numbers, or the 15 s mining poll.

Config `_miningDefenseSettings` (validated, clamped): `enabled` true; `minerDrone.enabled` true, `minerDroneCount` 1 (0-2);
`escortWaitUnderFireMs` 20000 (5000-45000); `reinforce.maxHops` 3 (0-8); `reinforce.etaBudgetMs` 180000 (60000-300000);
`reinforce.perIncident` 1 (1-2); `reinforce.perSystem` 2 (1-4); `reinforce.global` 4 (1-8); `reinforce.responderCooldownMs`
600000 (300000-1800000); `drones.lossBudgetPerHour` 5 (1-20); `beltBlacklistMs` 1800000 (600000-7200000); `systemBlacklistMs`
3600000 (1800000-7200000).

## 7. Safety and failure modes

| Risk | Bound |
|---|---|
| Chain-pulling more rats | never shoot first; no launch at ≥2 rats or non-aggressed targets; 1 responder; blacklist on first retreat |
| Responder arrives after the fight | ETA ≤180 s and `survival > eta + 3 s`, else no dispatch; miner leaves regardless |
| Pilot stranded/paused in space | pending retreat outranks director assignment (`dir` yield-test pattern); a dead responder releases on ship change (`lda:520-540`) |
| Reinforcements steal war pilots | hard exclusion of war ops/assignments; 1/incident, 2/system, 4 global; 10 min cooldown |
| Cost blow-up | pilot wallet only, drone-only fits, 5 drones/hour/pilot, no ship purchases, corp top-up ≤100k/incident, ≤1M/day |
| One system holds 245 bots (300 cap) | dedupe per belt group, per-system cap 2, system blacklist |
| Drone loss invalidates the escort fit | loss budget plus restock through the normal upgrade path before eligibility returns |

## 8. Test plan

Repo style (`tests/*.cjs`, `vm` extraction + `assert/strict`, as `run-local-defense.cjs:1-30`):
- `tests/mining-defense-policy.test.cjs` — ladder choice for rat count/class/shield/scramble; caps; ETA+survival gate;
  blacklist TTL; config bounds.
- `tests/mining-defense-threat.test.cjs` — vm `threat` with ops `{mine+no escort, mine+escort, combat, industry}` ×
  `{npc, player}`: immediate `setMiningIncomingThreat` for mine/no-escort (fails today — proves the gap), escort/combat/industry unchanged.
- `tests/mining-defense-dispatch.test.cjs` — vm `escort` slice: hops filter, same-corp preference, war/existing-op exclusion,
  group dedupe, per-system/global caps, cooldown.
- `tests/mining-defense-drone.test.cjs` — vm `hasRoleShipFit` slice: rung with 1 drone fails at 0, passes at 1; evacuation calls
  `commandReturnBay` before warp.
Register via `tests/run-mining-defense.cjs` (copy of the local-defence runner).

Only the live stand can prove: real rat DPS and aggro switch to drones; whether a Venture bay accepts 1 light drone and kills a
0.95-sec frigate inside one mining cycle; how often NPCs scramble; that a 20 s under-fire wait beats the first rat; a 3-jump ETA;
and that the 47 active mining ops do not regress.

## 9. Open questions

1. Same-corp reinforcement is impossible for the industry corp (98000002) — re-home miners, allow cross-corp agreements, or accept none?
2. Is nullsec mining intended for T1 Ventures? M-OEE8 had 6 bots and 15 losses; excluding nullsec belts for T1 hulls may beat defending them.
3. May a responder abandon an active anomaly site, or only idle/docked pilots?
4. Is 5 drones/hour/pilot the right budget, and should the corp wallet fund restock?
5. Should the system blacklist survive restarts (persisted), or is per-operation state acceptable?

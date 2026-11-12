"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  createCoordinator,
} = require("../integration/server/server/src/services/playerbots/playerBotLocalDefenseRuntime");
const root = path.resolve(__dirname, "..");
let clock = 100000,
  writes = 0,
  state = null;
const config = {
  enabled: true,
  systemIDs: [1, 2],
  responderIDs: Array.from({ length: 100 }, (_, i) => i + 100),
  perIncident: 3,
  systemLimit: 8,
  globalLimit: 12,
};
const ports = {
  load: () => state,
  save: (s) => {
    state = s;
    writes++;
  },
  now: () => clock,
  config: () => config,
  canAssist: (c, e) => c.side === e.side && c.legal === true,
};
const input = {
  victimID: 1,
  attackerID: 900,
  systemID: 1,
  scope: "public",
  side: "corp-A",
  kind: "damage",
  authoritative: true,
  sourceKind: "player",
  attackerCharacterID: 90,
};
const candidate = (i) => ({
  characterID: i,
  connected: true,
  ready: true,
  preemptible: true,
  role: "security",
  systemID: 1,
  scope: "public",
  side: "corp-A",
  legal: true,
  onGrid: false,
  etaMs: (i - 99) * 1000,
  operationID: `OP${i}`,
});
const results = [];
for (let repeat = 0; repeat < 10; repeat++) {
  state = null;
  writes = 0;
  clock += 100000;
  const c = createCoordinator(ports);
  const first = c.request(input);
  assert.equal(first.accepted, true);
  c.request({ ...input, victimID: 2 });
  for (let n = 0; n < 1000; n++)
    assert.equal(c.request(input).eventID, first.eventID);
  assert.equal(
    writes,
    2,
    "duplicate storm must be coalesced before persistence",
  );
  const candidates = Array.from({ length: 100 }, (_, i) => candidate(i + 100));
  candidates[0].legal = false;
  candidates[1].scope = "abyss:1";
  candidates[2].ready = false;
  candidates[3].preemptible = false;
  candidates[4].side = "enemy";
  candidates[5].onGrid = true;
  const assigned = c.dispatch(candidates);
  assert.equal(assigned.length, 3);
  assert.equal(assigned[0].characterID, 105);
  assert.equal(Object.keys(c.snapshot().events).length, 1);
  assert.equal(
    Object.keys(c.snapshot().events[first.eventID].victims).length,
    2,
  );
  c.dispatch(candidates);
  assert.equal(Object.keys(c.snapshot().leases).length, 3);
  const other = c.request({ ...input, attackerID: 901 });
  c.dispatch(candidates);
  assert.equal(Object.keys(c.snapshot().leases).length, 6);
  const lease = assigned[0];
  assert.equal(
    c.update(lease.characterID, "stale-token", "on-grid", {}),
    false,
  );
  assert.equal(c.update(lease.characterID, lease.token, "on-grid", {}), false);
  assert.equal(
    c.update(lease.characterID, lease.token, "engaging", {
      authorityAccepted: true,
    }),
    false,
  );
  assert.equal(
    c.update(lease.characterID, lease.token, "travelling", {}),
    true,
  );
  const evidence = {
    sameScope: true,
    visible: true,
    inRange: true,
    systemID: 1,
  };
  assert.equal(
    c.update(lease.characterID, lease.token, "on-grid", evidence),
    true,
  );
  assert.equal(
    c.update(lease.characterID, lease.token, "engaging", {
      ...evidence,
      authorityAccepted: true,
    }),
    true,
  );
  assert.equal(c.snapshot().events[first.eventID].status, "supporting");
  c.close(first.eventID, "victim-safe");
  assert.equal(c.snapshot().events[first.eventID].status, "resolving");
  assert.equal(c.update(lease.characterID, lease.token, "resumed", {}), false);
  for (const l of assigned)
    assert.equal(
      c.update(l.characterID, l.token, "resumed", { safeToResume: true }),
      true,
    );
  assert.equal(c.snapshot().events[first.eventID].status, "closed");
  assert.equal(
    c.update(lease.characterID, lease.token, "travelling", {}),
    false,
  );
  const restarted = createCoordinator(ports);
  restarted.recover(() => ({ valid: false, reason: "offline" }));
  for (const l of Object.values(restarted.snapshot().leases))
    assert.equal(l.phase, "disengaging");
  restarted.disable();
  for (const l of Object.values(restarted.snapshot().leases))
    restarted.update(l.characterID, l.token, "resumed", { safeToResume: true });
  assert.equal(Object.keys(restarted.snapshot().leases).length, 0);
  results.push({
    repeat,
    passed: true,
    duplicateRequests: 1000,
    initialWrites: 2,
    uniqueReservations: 6,
  });
}
// No available/legal candidates, no capability inflation, no lock-only event.
state = null;
const c = createCoordinator(ports);
assert.equal(c.request({ ...input, kind: "lock" }).accepted, false);
assert.equal(c.request({ ...input, scope: "" }).accepted, false);
const request = c.request(input);
c.dispatch([]);
assert.equal(c.snapshot().events[request.eventID].status, "unserviceable");
clock += 31000;
c.dispatch([]);
assert.equal(c.snapshot().events[request.eventID].status, "expired");
// Stress the global and system limits with 100 eligible pilots.
state = null;
for (let i = 0; i < 10; i++)
  c.request({ ...input, attackerID: 900 + i, systemID: i < 5 ? 1 : 2 });
c.dispatch(
  Array.from({ length: 100 }, (_, i) => ({
    ...candidate(i + 100),
    systemID: i < 50 ? 1 : 2,
  })),
);
assert.equal(Object.keys(c.snapshot().leases).length, 12);
assert.equal(
  Object.values(c.snapshot().leases).filter((l) => l.systemID === 1).length,
  8,
);
// A victim is never its own reinforcement; duplicate roster rows cannot create duplicate reservations.
state = null;
c.request({ ...input, victimID: 100 });
const unique = c.dispatch([
  candidate(100),
  candidate(101),
  candidate(101),
  candidate(102),
  candidate(103),
]);
assert.equal(unique.length, 3);
assert.equal(new Set(unique.map((l) => l.characterID)).size, 3);
assert.equal(c.snapshot().leases[100], undefined);
clock += 31000;
c.maintain();
assert.equal(Object.values(c.snapshot().events)[0].status, "resolving");
for (const l of unique)
  c.update(l.characterID, l.token, "resumed", { safeToResume: true });
assert.equal(Object.values(c.snapshot().events)[0].status, "expired");
// Repeated close/disable calls do not manufacture persistence writes during cleanup.
state = null;
c.request(input);
c.dispatch([candidate(101)]);
c.disable();
const before = writes;
c.disable();
c.close("LD1");
assert.equal(writes, before);
const out = path.join(root, "test-output/P2");
ignoreReportDirectory(out, { recursive: true });
state = null;
const ranked = createCoordinator({
  ...ports,
  config: () => ({ ...config, perIncident: 1 }),
});
ranked.request(input);
const rankedResult = ranked.dispatch([
  { ...candidate(101), etaMs: null, distanceMeters: 5e6 },
  { ...candidate(102), etaMs: null, distanceMeters: 1e6 },
]);
assert.equal(
  rankedResult[0].characterID,
  102,
  "unknown ETA uses observed distance rather than pilot ID",
);
// Existing qualified escorts retain priority, but an existing assignment never bypasses readiness or law.
const escortCases = [];
for (let n = 0; n < 10; n++) {
  state = null;
  ranked.request(input);
  const escort = {
    ...candidate(109),
    existingEscort: true,
    onGrid: false,
    etaMs: null,
    distanceMeters: 9e6,
  };
  const nearby = {
    ...candidate(101),
    onGrid: true,
    etaMs: 100,
    distanceMeters: 100,
  };
  let chosen = ranked.dispatch([nearby, escort]);
  assert.equal(chosen[0].characterID, 109);
  assert.equal(
    ranked.dispatch([nearby, escort]).length,
    0,
    "the original escort cannot acquire a second lease",
  );
  for (const invalid of [
    { legal: false },
    { ready: false },
    { preemptible: false },
    { scope: "other-instance" },
  ]) {
    state = null;
    ranked.request(input);
    chosen = ranked.dispatch([nearby, { ...escort, ...invalid }]);
    assert.equal(
      chosen[0].characterID,
      101,
      "existing escort priority cannot override candidate exclusion",
    );
  }
  escortCases.push({
    repeat: n,
    qualifiedEscortFirst: true,
    invalidEscortRejected: true,
    duplicateLeasePrevented: true,
  });
}
state = null;
ranked.request(input);
const cancellationLease = ranked.dispatch([candidate(102)])[0];
ranked.close(cancellationLease.eventID, "operator-cancelled");
assert.equal(ranked.request(input).reason, "operator-cancel-cooldown");
clock += 31000;
assert.equal(ranked.request(input).accepted, true);
state = null;
const roles = createCoordinator({
  ...ports,
  config: () => ({ ...config, miningRescue: true, generalRescue: false }),
});
assert.equal(roles.request({ ...input, role: "combat" }).accepted, false);
assert.equal(roles.request({ ...input, role: "miner" }).accepted, true);
printReport(
  path.join(out, "coordinator.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      environment:
        "pure coordinator with synchronous memory persistence adapter",
      results,
      escortCases,
      hardCapsPassed: true,
      liveEngineTest: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    repeats: 10,
    passed: true,
    stormRequests: 10000,
    liveEngineTest: false,
  }),
);

"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const src = path.resolve(__dirname, "../integration/server/server/src"),
  dir = path.join(src, "services/playerbots");
const scope = require(
  path.join(src, "space/destiny/identity/interactionScope"),
);
const runtime = require(path.join(dir, "playerBotLocalDefenseRuntime"));
const results = [];
async function scenario(kind, round) {
  const settings = {
    enabled: true,
    systemIDs: [1],
    responderIDs: [2],
    agreements: [],
    perIncident: 1,
    systemLimit: 8,
    globalLimit: 12,
  };
  const own = { itemID: 20, position: { x: 0, y: 0, z: 0 } },
    victim = { itemID: 10, position: { x: 100, y: 0, z: 0 } },
    target = { itemID: 90, position: { x: 500, y: 0, z: 0 } };
  const scopeValue = JSON.stringify(scope.resolveEntityInteractionScope(own));
  const db = {};
  let recalled = 0,
    moved = 0,
    released = 0,
    drained = 0;
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const c = runtime.createCoordinator({
    load: () => db.state,
    save: (s) => (db.state = clone(s)),
    config: () => settings,
    canAssist: () => true,
  });
  const event = c.request({
    authoritative: true,
    sourceKind: "player",
    attackerCharacterID: 90,
    kind: "damage",
    victimID: 1,
    attackerID: 90,
    systemID: 1,
    scope: scopeValue,
    side: "corp:5",
    position: victim.position,
  });
  c.dispatch([
    {
      characterID: 2,
      connected: true,
      ready: true,
      preemptible: true,
      role: "security",
      systemID: 1,
      scope: scopeValue,
      side: "corp:5",
      operationID: "op",
      resume: {
        shipID: 20,
        status: "active",
        position: { x: 1e6, y: 0, z: 0 },
      },
    },
  ]);
  assert.ok(c.snapshot().leases[2]);
  const bot = {
      characterID: 2,
      status: kind === "paused" ? "paused" : "active",
    },
    op = {
      operationID: "op",
      status: "active",
      emergencyRetreat: kind === "emergency",
      threatRetreat: kind === "threat",
    };
  if (kind === "disabled") settings.enabled = false;
  const scene = {
    systemID: 1,
    getEntityByID: (id) => (id === 90 ? target : null),
  };
  const deps = {
    "./playerBotLocalDefenseConfig": { get: () => settings },
    "../../space/destiny/identity/interactionScope": scope,
    "./playerBotInterruptRuntime": {
      acquire: () => ({}),
      release: () => released++,
    },
    "../../gameStore/tableRepository": {
      createTableRepository: () => ({
        read: () => ({ data: clone(db.state) }),
        ensureTable() {},
        write: (t, p, v) => {
          db.state = clone(v);
          return { success: true };
        },
        flushTableSync: () => ({ success: true }),
      }),
    },
    "./playerBotLocalDefenseRuntime": runtime,
    "./playerBotRuntime": {
      getBotByCharacterID: (id) => (id === 2 ? bot : { characterID: 1 }),
    },
    "./playerBotSpaceRuntime": {
      getBotPresenceInfo: (b) => ({
        inSpace: kind !== "absent",
        connected: kind !== "offline",
      }),
      getActorSpace: (b) => ({
        entity: b.characterID === 2 ? own : victim,
        session: { characterID: b.characterID },
        scene,
      }),
      getSpaceState: () => ({ busy: kind === "emergency" }),
      warpToPoint: () => moved++,
    },
    "./playerBotOperationRuntime": {
      getOperation: () => op,
      drainInterruptions: () => drained++,
    },
    "./playerBotCombatRuntime": {
      getControlledDrones: () => (kind === "disabled" ? [] : [{ itemID: 100 }]),
    },
    "./playerBotCombatPolicy": { isPirateNpc: () => true },
    "../character/characterState": {
      getCharacterRecord: () => ({ corporationID: 5 }),
    },
    "../corporation/corporationState": { getCorporationRecord: () => ({}) },
    "../corporation/warRuntimeState": { listAllWars: () => [] },
    "../drone/droneRuntime": { commandReturnBay: () => recalled++ },
    "../../space/runtime": { gotoPoint: () => moved++ },
  };
  if (kind === "disabled")
    db.state.leases[2].resume.position = { ...own.position };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(dir, "playerBotLocalDefenseAdapter.js"), "utf8"),
    {
      module,
      console,
      Date,
      setImmediate,
      require: (id) => {
        assert.ok(id in deps, id);
        return deps[id];
      },
    },
  );
  const adapter = module.exports;
  await adapter.advance(2, { unavailable: kind === "window" });
  assert.equal(adapter.hasLease(2), false, kind + " must release ownership");
  assert.equal(moved, 0, kind + " must not navigate to previous work position");
  assert.equal(released, 1);
  assert.equal(drained, 1);
  assert.equal(recalled, ["absent", "disabled"].includes(kind) ? 0 : 1);
  results.push({ kind, round, passed: true, recalled, moved });
}
(async () => {
  for (let n = 0; n < 10; n++)
    for (const kind of [
      "emergency",
      "threat",
      "paused",
      "offline",
      "window",
      "absent",
      "disabled",
    ])
      await scenario(kind, n);
  printReport(
    path.resolve(__dirname, "../test-output/P3/cleanup.json"),
    JSON.stringify({ passed: true, cases: results }, null, 2),
  );
  console.log("PASS 70 cleanup/handoff scenarios");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

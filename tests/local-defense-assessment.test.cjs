"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path");
const dir = path.resolve(
  __dirname,
  "../integration/server/server/src/services/playerbots",
);
let time = 1000,
  stored = {},
  full = true,
  partial = true,
  shipID = 20,
  modules = [{ itemID: 21, typeID: 22 }],
  count = 5;
const bot = { characterID: 1, specialty: "security" },
  target = { itemID: 30, typeID: 626 },
  scene = { systemID: 1 };
const entity = () => ({ itemID: shipID, typeID: 626 });
const state = {
  inSpace: true,
  shield: 0.7,
  armorDamage: 0,
  hullDamage: 0,
  capacitorRatio: 0.5,
};
const settings = {
  enabled: true,
  aggressive: true,
  systemIDs: [1],
  policy: {},
};
const repo = {
  read: () => ({ data: stored }),
  ensureTable() {},
  write: (t, k, v) => {
    stored = JSON.parse(JSON.stringify(v));
    return { success: true };
  },
  flushTableSync: () => ({ success: true }),
};
const deps = {
  "./playerBotDefensePolicy": require(path.join(dir, "playerBotDefensePolicy")),
  "./playerBotLocalDefenseConfig": { get: () => settings },
  "./playerBotSpaceRuntime": {
    getActorSpace: () => ({ entity: entity() }),
    getSpaceState: () => state,
  },
  "./playerBotCombatRuntime": {
    getControlledDrones: () => [],
    estimateEffectiveHitPoints: (t, e) => (e.itemID === 30 ? 11000 : 10000),
  },
  "./playerBotCombatFitRuntime": {
    buildCombatFitSnapshot: () => ({
      success: true,
      fit: {
        ready: true,
        modules,
        totalDrones: count,
        capacitorUsePerSecond: 0,
      },
    }),
  },
  "./playerBotOperationRuntime": {
    hasRoleShipFit: (b, r, o) => (o?.allowPartialDrones ? partial : full),
    getRoleShipFitProfile: () => ({ droneTypeIDs: [1, 1, 1, 1, 1] }),
  },
  "../../gameStore/tableRepository": { createTableRepository: () => repo },
  "./playerBotLocalDefenseAdapter": {
    supportFor: () => ({ onGridEffectiveHP: 0, acceptedEtaMs: null }),
  },
};
const moduleObject = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(dir, "playerBotDefenseAssessment.js"), "utf8"),
  {
    module: moduleObject,
    Date: { now: () => time },
    require: (id) => {
      assert.ok(id in deps, id);
      return deps[id];
    },
  },
);
const assess = () =>
  moduleObject.exports.assess(
    bot,
    target,
    scene,
    { kind: "combat", mode: "security" },
    true,
  );
full = false;
count = 4;
assert.equal(
  assess().action,
  "evade",
  "partial fit must not pass initial validation",
);
full = true;
count = 5;
assert.equal(assess().action, "engage");
assert.equal(stored.validated, true);
full = false;
count = 4;
time += 1000;
assert.equal(
  assess().action,
  "engage",
  "same previously validated hull can continue with four drones",
);
count = 1;
time += 1000;
assert.equal(
  assess().action,
  "evade",
  "one surviving drone must lower combat power",
);
count = 4;
shipID = 40;
assert.equal(
  assess().action,
  "evade",
  "different ship cannot inherit validation",
);
full = true;
count = 5;
assess();
full = false;
count = 4;
modules = [{ itemID: 99, typeID: 22 }];
assert.equal(
  assess().action,
  "evade",
  "refitted ship needs fresh full validation",
);
settings.enabled = false;
assert.equal(assess(), null);
const out = path.resolve(__dirname, "../test-output/P4");
ignoreReportDirectory(out, { recursive: true });
printReport(
  path.join(out, "assessment-tests.json"),
  JSON.stringify({ passed: true, cases: 7, liveEngineTest: false }, null, 2),
);
console.log("PASS seven assessment boundaries");

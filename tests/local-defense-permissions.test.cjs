"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path");
const src = path.resolve(__dirname, "../integration/server/server/src"),
  dir = path.join(src, "services/playerbots");
const scope = require(
  path.join(src, "space/destiny/identity/interactionScope"),
);
function load(file, deps, extra = "") {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8") + extra, {
    module,
    console,
    require: (id) => {
      assert.ok(id in deps, id);
      return deps[id];
    },
  });
  return module.exports;
}
const policy = load(path.join(dir, "playerBotCombatPolicy.js"), {
  "../../space/npc/pirateFactionPolicy": {
    PIRATE_FACTION_BY_FACTION_ID: { 500010: "guristas" },
    _testing: { classifyTextFaction: () => null },
    isSupportedLocalPirateFactionKey: () => false,
  },
});
let known = false;
const combat = load(
  path.join(dir, "playerBotCombatRuntime.js"),
  {
    "../../space/worldData": {},
    "./playerBotCombatPolicy": policy,
    "./playerBotCombatDecisionRuntime": {},
    "./playerBotEconomyRuntime": { BOT_HUB_STATION_ID: 1 },
    "./playerBotLocalDefenseAdapter": { hasLiveAttack: () => known },
    "../../space/destiny/identity/interactionScope": scope,
  },
  "\nmodule.exports.eligible=eligibleDefensiveTarget;",
);
const own = { kind: "ship", itemID: 10, session: { characterID: 1 } },
  target = {
    kind: "ship",
    itemID: 20,
    typeID: 626,
    corporationID: 200,
    session: { characterID: 2 },
  };
const base = {
  characterID: 1,
  corporationID: 100,
  allianceID: 300,
  systemSecurity: 0.9,
  specialSpace: false,
  isManagedBot: () => true,
  isFleetMate: () => false,
  securityStatusFor: () => 0,
  isSuspect: () => false,
  isCriminal: () => false,
  isWarTarget: () => false,
  hasLimitedEngagement: () => false,
};
const eligible = (t = {}, c = {}, ship = own) =>
  combat.eligible(
    { characterID: 1 },
    { ...target, ...t },
    { systemID: 1 },
    ship,
    null,
    { ...base, ...c },
  );
const cases = [];
function test(name, fn) {
  fn();
  cases.push(name);
}
test("managed bot protected unless this pilot has an authoritative live incident", () => {
  known = false;
  assert.equal(eligible({}, { isWarTarget: () => true }), false);
  known = true;
  assert.equal(eligible({}, { isWarTarget: () => true }), true);
});
test("live incident never grants third-party limited engagement rights", () => {
  known = true;
  assert.equal(eligible(), false);
  assert.equal(eligible({}, { hasLimitedEngagement: () => true }), true);
  assert.equal(eligible(), false);
});
test("corporation, alliance, fleet, self and capsule exclusions survive incident exception", () => {
  const war = { isWarTarget: () => true };
  for (const t of [
    { corporationID: 100 },
    { allianceID: 300 },
    { session: { characterID: 1 } },
    { typeID: 670 },
  ])
    assert.equal(eligible(t, war), false);
  assert.equal(eligible({}, { ...war, isFleetMate: () => true }), false);
});
test("independent Crimewatch and war permissions are honored", () => {
  for (const c of [
    { isWarTarget: () => true },
    { isSuspect: () => true },
    { isCriminal: () => true },
    { securityStatusFor: () => -5 },
  ])
    assert.equal(eligible({}, c), true);
  assert.equal(eligible({}, { systemSecurity: 0 }), true);
  assert.equal(eligible({}, { systemSecurity: 0, specialSpace: true }), false);
});
test("different abyssal instances and rooms cannot interact even in war", () => {
  const a = { ...own, abyssalRunID: 123, abyssalRoomIndex: 1 };
  assert.equal(
    eligible(
      { abyssalRunID: 124, abyssalRoomIndex: 1 },
      { isWarTarget: () => true },
      a,
    ),
    false,
  );
  assert.equal(
    eligible(
      { abyssalRunID: 123, abyssalRoomIndex: 2 },
      { isWarTarget: () => true },
      a,
    ),
    false,
  );
  assert.equal(
    eligible(
      { abyssalRunID: 123, abyssalRoomIndex: 1 },
      { isWarTarget: () => true },
      a,
    ),
    true,
  );
});
test("zero applied damage is rejected before threat notifications", () => {
  const hook = require(
    path.join(src, "space/runtime/playerBotThreatDamageHook"),
  );
  let notifications = 0;
  const dependencies = {
    getAppliedDamageAmount: (r) => r.applied,
    getOwningSessionForEntity: () => ({ _playerBotActor: true }),
    getThreatResponseRuntime: () => ({
      noteIncomingDamage() {
        notifications++;
      },
    }),
  };
  for (const applied of [0, -1, NaN])
    assert.equal(
      hook.dispatchPlayerBotThreatResponse(
        {},
        target,
        own,
        { applied },
        Date.now(),
        dependencies,
      ),
      false,
    );
  assert.equal(notifications, 0);
  assert.equal(
    hook.dispatchPlayerBotThreatResponse(
      {},
      target,
      own,
      { applied: 1 },
      Date.now(),
      dependencies,
    ),
    true,
  );
  assert.equal(notifications, 1);
});
const out = path.resolve(__dirname, "../test-output/P3");
ignoreReportDirectory(out, { recursive: true });
printReport(
  path.join(out, "permissions.json"),
  JSON.stringify(
    { passed: cases.length, cases, liveEngineTest: false },
    null,
    2,
  ),
);
console.log(JSON.stringify({ passed: cases.length }));

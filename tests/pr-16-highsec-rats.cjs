"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const results = [];
const SOURCE = fs.readFileSync(
  path.join(__dirname, "../integration/server/server/src/services/playerbots/playerBotOperationRuntime.js"),
  "utf8",
);

function extract(source, name) {
  const re = new RegExp("^(?:async )?function " + name + "\\(", "m");
  const match = re.exec(source);
  assert.ok(match, "Missing function " + name);
  const end = source.indexOf("\n}", match.index);
  assert.ok(end > match.index, "Unterminated function " + name);
  return source.slice(match.index, end + 2);
}

function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
  }
}

const SECURITY = { "30000133": 0.949, "30002754": 0.3 };
const REGIONS = { 60000400: 10000002, 60008494: 10000043 };
const calls = { engaged: [], records: [], saved: 0 };
let nearest = 0;

const ctx = {
  MINING_HIGHSEC_RAT_ENGAGE_COOLDOWN_MS: 30_000,
  MINING_ESCORT_DISPATCH_RANGE_METERS: 250_000,
  worldData: {
    getSolarSystemByID: (id) => ({ security: SECURITY[String(id)] }),
    getStationByID: (id) => ({ regionID: REGIONS[String(id)] || 0 }),
  },
  stationSystemID: () => 30000133,
  space: { getNearestPirateNpcEntityID: () => nearest },
  getSpace: () => ({ getNearestPirateNpcEntityID: () => nearest }),
  launchDefensiveDrones: (bot, id) => {
    calls.engaged.push(id);
    return true;
  },
  record: (_operation, message) => calls.records.push(message),
  saveOperation: () => { calls.saved += 1; },
};
vm.createContext(ctx);
vm.runInContext(extract(SOURCE, "beltSecurityForMining"), ctx);
vm.runInContext(extract(SOURCE, "stationRegionID"), ctx);
vm.runInContext(extract(SOURCE, "engageToleratedBeltRats"), ctx);

const now = Date.now();

test("high-sec belt reports its security", () => {
  assert.equal(ctx.beltSecurityForMining({ homeStationID: 60000400 }, { systemID: 30000133 }), 0.949);
});

test("low-sec belt reports its lower security", () => {
  assert.equal(ctx.beltSecurityForMining({ homeStationID: 60008494 }, { systemID: 30002754 }), 0.3);
});

test("station region is read from world data", () => {
  assert.equal(ctx.stationRegionID(60000400), 10000002);
  assert.equal(ctx.stationRegionID(60008494), 10000043);
});

test("a visible rat is answered with drones while mining continues", () => {
  nearest = 9001;
  calls.engaged.length = 0;
  calls.records.length = 0;
  const operation = { beltID: 40009256, lastBeltRatEngageAtMs: now - 60_000 };
  assert.equal(ctx.engageToleratedBeltRats({ characterID: 1 }, operation, 2), true);
  assert.deepEqual(calls.engaged, [9001]);
  assert.equal(operation.lastBeltRatEngageAtMs > now - 60_000, true);
  assert.match(calls.records[0], /drones are engaging while mining continues/);
});

test("the engage cooldown stops a drone launch every poll", () => {
  nearest = 9002;
  calls.engaged.length = 0;
  const operation = { beltID: 40009256, lastBeltRatEngageAtMs: Date.now() };
  assert.equal(ctx.engageToleratedBeltRats({ characterID: 1 }, operation, 2), false);
  assert.deepEqual(calls.engaged, []);
});

test("no visible rat means no launch", () => {
  nearest = 0;
  calls.engaged.length = 0;
  const operation = { beltID: 40009256, lastBeltRatEngageAtMs: 0 };
  assert.equal(ctx.engageToleratedBeltRats({ characterID: 1 }, operation, 1), false);
  assert.deepEqual(calls.engaged, []);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

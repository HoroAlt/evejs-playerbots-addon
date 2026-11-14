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

// Amarr hub carries only the modules; Jita carries the hull too.
const CANDIDATES = [
  { stationID: 60008494, isJita: false, completeTypes: 1, totalTypes: 2, coverage: 2, estimatedCost: 100 },
  { stationID: 60015261, isJita: true, completeTypes: 2, totalTypes: 2, coverage: 2, estimatedCost: 900 },
];

const ctx = {
  getUpgradePackageNeeds: () => [{ typeID: 32880, quantity: 1 }, { typeID: 483, quantity: 2 }],
  hubStationFor: () => 60014935,
  worldData: {
    getStationByID: (id) => ({ solarSystemID: Number(id) === 60015261 ? 30000142 : 30002187 }),
    getSolarSystemByID: (id) => ({ security: Number(id) === 30000142 ? 0.95 : 0.9 }),
  },
  require: (modulePath) => modulePath.includes("playerBotEconomyRuntime")
    ? { findSellStationsForPackage: () => CANDIDATES }
    : { previewSystemRoute: () => ({ success: true, hops: 3, risk: { lowsecSystemIDs: [], nullsecSystemIDs: [] } }) },
};
vm.createContext(ctx);
vm.runInContext(extract(SOURCE, "findUpgradeMarketStation"), ctx);

test("the station with the whole package wins over a nearer partial one", () => {
  assert.equal(ctx.findUpgradeMarketStation({ characterID: 1 }, {}), 60015261);
});

test("with no complete station the non-Jita partial one is used", () => {
  CANDIDATES[1].completeTypes = 1;
  assert.equal(ctx.findUpgradeMarketStation({ characterID: 1 }, {}), 60008494);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

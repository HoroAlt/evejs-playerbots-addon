"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const results = [];
const OPS = fs.readFileSync(
  path.join(__dirname, "../integration/server/server/src/services/playerbots/playerBotOperationRuntime.js"),
  "utf8",
);
const ECON = fs.readFileSync(
  path.join(__dirname, "../integration/server/server/src/services/playerbots/playerBotEconomyRuntime.js"),
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

// --- one trade region -----------------------------------------------------
const econCtx = { BOT_HUB_STATION_ID: 60014935 };
vm.createContext(econCtx);
vm.runInContext(extract(ECON, "getHubStationIDForBot"), econCtx);

test("every pilot uses the seeded hub, whatever its race", () => {
  assert.equal(econCtx.getHubStationIDForBot({ characterID: 1, hubStationID: 60008494 }), 60014935);
  assert.equal(econCtx.getHubStationIDForBot({ characterID: 2, hubStationID: 60005686 }), 60014935);
  assert.equal(econCtx.getHubStationIDForBot(3), 60014935);
});

// --- mining stops between trips for a ready hull --------------------------
const ctx = {
  nextShipUpgrade: () => ({ name: "Mining barge", minBalance: 60_000_000 }),
  require: () => ({ getCharacterWallet: () => ({ balance: 1_000_000_000 }) }),
};
vm.createContext(ctx);
vm.runInContext(extract(OPS, "readyHullUpgradeForMining"), ctx);

const operation = { autonomous: true };

test("a ready and affordable hull stops the mining operation", () => {
  assert.equal(ctx.readyHullUpgradeForMining({ characterID: 1 }, operation).name, "Mining barge");
});

test("territorial operations keep mining", () => {
  assert.equal(ctx.readyHullUpgradeForMining({ characterID: 1 }, { autonomous: true, territorialOperation: true }), null);
});

test("a fit top-up does not stop the operation", () => {
  ctx.nextShipUpgrade = () => ({ name: "Venture", replenishOnly: true, minBalance: 600_000 });
  assert.equal(ctx.readyHullUpgradeForMining({ characterID: 1 }, operation), null);
  ctx.nextShipUpgrade = () => ({ name: "Mining barge", minBalance: 60_000_000 });
});

test("a pilot that cannot afford the hull keeps mining", () => {
  ctx.require = () => ({ getCharacterWallet: () => ({ balance: 10_000_000 }) });
  assert.equal(ctx.readyHullUpgradeForMining({ characterID: 1 }, operation), null);
  ctx.require = () => ({ getCharacterWallet: () => ({ balance: 1_000_000_000 }) });
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

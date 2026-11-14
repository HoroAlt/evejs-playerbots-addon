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

const LADDER = {
  mining: [
    { name: "Venture", hullTypeID: 32880, moduleTypeIDs: [483, 483], droneTypeIDs: [2454] },
    { name: "Mining barge", hullTypeID: 17480, requiredSkills: [[17940, 1]], moduleTypeIDs: [17482] },
  ],
};

const ctx = {
  SHIP_LADDER: LADDER,
  getCharacterRecord: () => ({ shipTypeID: 32880, shipID: 1 }),
  resolveShipLadderRung: (rung) => rung,
  rungIndexOfHull: (ladder, hull) => ladder.findIndex((rung) => Number(rung.hullTypeID) === Number(hull)),
  applyCatalogFit: (_bot, rung) => rung,
  hasSkills: () => true,
  canUseRung: () => true,
  selectBootstrapRung: () => null,
  getInventory: () => ({ unitsOf: () => 0 }),
  require: (modulePath) => {
    if (modulePath.includes("itemStore")) {
      return {
        listCharacterItems: () => [],
        ITEM_FLAGS: { CARGO_HOLD: 5, DRONE_BAY: 87 },
      };
    }
    if (modulePath.includes("liveFittingState")) return { isFittedModuleItem: () => true, isEffectivelyOnlineModule: () => true };
    if (modulePath.includes("walletState")) return { getCharacterWallet: () => ({ balance: 1e9 }) };
    return {};
  },
};
vm.createContext(ctx);
vm.runInContext(extract(SOURCE, "nextShipUpgrade"), ctx);

const bot = { characterID: 1 };

test("an unfinished current fit is replenished first by default", () => {
  const rung = ctx.nextShipUpgrade(bot, "mining");
  assert.equal(rung.name, "Venture");
  assert.equal(rung.replenishOnly, true);
});

test("a ready next hull wins over the optional current fit", () => {
  const rung = ctx.nextShipUpgrade(bot, "mining", { preferReadyHull: true });
  assert.equal(rung.name, "Mining barge");
  assert.equal(rung.hullTypeID, 17480);
  assert.notEqual(rung.replenishOnly, true);
});

test("with no ready next hull the replenishment still happens", () => {
  ctx.canUseRung = (currentBot, rung) => Number(rung.hullTypeID) !== 17480;
  const rung = ctx.nextShipUpgrade(bot, "mining", { preferReadyHull: true });
  assert.equal(rung.name, "Venture");
  assert.equal(rung.replenishOnly, true);
  ctx.canUseRung = () => true;
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

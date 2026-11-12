"use strict";
const fs = require("fs"),
  path = require("path"),
  vm = require("vm"),
  assert = require("assert/strict");
const results = [];
const source = (slug, file = "playerBotOperationRuntime.js") =>
  fs.readFileSync(
    path.join(
      process.env.EVEJS_SOURCE_ROOT ||
        path.resolve(__dirname, "../integration/server"),
      "server/src/services/playerbots",
      file,
    ),
    "utf8",
  );
function extract(s, name) {
  const re = new RegExp("^(?:async )?function " + name + "\\(", "m"),
    m = re.exec(s);
  assert.ok(m, "Missing function " + name);
  const end = s.indexOf("\n}", m.index);
  assert.ok(end > m.index);
  return s.slice(m.index, end + 2);
}
function functions(s, names, context) {
  vm.createContext(context);
  vm.runInContext(names.map((n) => extract(s, n)).join("\n"), context);
  return context;
}
async function test(feature, name, fn) {
  try {
    await fn();
    results.push({ feature, name, passed: true });
  } catch (e) {
    results.push({ feature, name, passed: false, error: e.stack });
  }
}
const record = (o, m) => {
    o.lastAction = m;
  },
  saveOperation = () => {},
  block = (o, status, msg) => {
    o.status = status;
    o.lastError = msg;
    return { blocked: true };
  },
  bot = { characterID: 1, characterName: "fixture" };
async function hull() {
  const s = source("02-hull-reuse");
  function make(hulls, mods, routes) {
    const c = functions(s, ["findReusableUpgradeHull"], {
      worldData: {
        getStationByID: (id) => (id === 999 ? null : { solarSystemID: id }),
      },
      getSpace: () => ({
        getActorSession: () => ({ stationID: 10 }),
        previewSystemRoute: (b, id) =>
          routes[id] || { success: true, hops: 1, risk: {} },
      }),
      require: (p) =>
        p.includes("itemStore")
          ? {
              ITEM_FLAGS: { HANGAR: 4 },
              listCharacterItems: (id, q) => {
                assert.equal(id, 1);
                return q.locationID
                  ? mods[q.locationID] || []
                  : hulls.filter((h) => h.ownerID === id);
              },
            }
          : { isFittedModuleItem: (i) => i.fitted },
    });
    return c;
  }
  const hull = (id, station, owner = 1) => ({
    itemID: id,
    locationID: station,
    ownerID: owner,
    typeID: 645,
  });
  const o = { hullTypeID: 645, moduleTypeIDs: [100] };
  await test(
    "02-hull-reuse",
    "reuse the best fitted reachable owned hull",
    () => {
      const c = make(
        [hull(1, 10), hull(2, 20)],
        { 2: [{ typeID: 100, fitted: true }] },
        {},
      );
      assert.equal(c.findReusableUpgradeHull(bot, o).itemID, 2);
    },
  );
  await test("02-hull-reuse", "same fit prefers local hull", () => {
    const c = make([hull(1, 20), hull(2, 10)], {}, {});
    assert.equal(c.findReusableUpgradeHull(bot, o).itemID, 2);
  });
  await test(
    "02-hull-reuse",
    "unsafe unreachable nonstation and foreign hulls excluded",
    () => {
      const c = make(
        [hull(1, 20), hull(2, 30), hull(3, 999), hull(4, 10, 2)],
        {},
        {
          20: { success: false },
          30: { success: true, risk: { lowsecSystemIDs: [1] } },
        },
      );
      assert.equal(c.findReusableUpgradeHull(bot, o), null);
    },
  );
  await test(
    "02-hull-reuse",
    "lost reserved hull blocks without buying",
    async () => {
      const session = { shipID: 5 };
      let bought = false;
      const c = functions(s, ["advanceUpgrade"], {
        getInventory: () => ({ listHangar: () => [] }),
        getSpace: () => ({ getActorSession: () => session }),
        require: (p) =>
          p.includes("itemStore")
            ? {}
            : { getCombatUpgradeSupport: () => null },
        travelToStation: async () => null,
        block,
        canUseRung: () => true,
        // Merged with #4: advanceUpgrade first repairs a legacy Dominix fit.
        migrateLegacyDominixFit: () => {},
        upgradeSlotError: () => null,
        record,
        saveOperation,
        buyUnits: () => {
          bought = true;
        },
      });
      const o2 = {
        kind: "upgrade",
        role: "mining",
        stage: "collect-hull",
        reuseShipID: 8,
        reuseStationID: 10,
      };
      await c.advanceUpgrade(o2, bot);
      assert.equal(o2.status, "blocked");
      assert.equal(bought, false);
    },
  );
}
(async () => {
  await hull();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

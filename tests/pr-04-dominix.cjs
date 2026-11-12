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
async function dominix() {
  const s = source("04-dominix"),
    start = s.indexOf("const SHIP_LADDER ="),
    end = s.indexOf("\n});", start) + 4;
  assert.ok(start >= 0 && end > start);
  const ladder = vm.runInNewContext(s.slice(start, end) + "\nSHIP_LADDER");
  const rung = ladder.security.find((r) => r.hullTypeID === 645);
  const ids = new Map();
  let seq = 1;
  const id = (n) => {
    if (!ids.has(n)) ids.set(n, seq++);
    return ids.get(n);
  };
  const corrected = rung.moduleTypeIDs.map(id),
    extra = id("EM Shield Amplifier II");
  await test(
    "04-dominix",
    "template has exactly five mids and seven lows",
    () => {
      assert.equal(rung.moduleTypeIDs.length, 12);
      assert.equal(
        rung.moduleTypeIDs.filter((x) =>
          /^(Large Shield Extender|EM Shield Amplifier|Thermal Shield Amplifier)/.test(
            x,
          ),
        ).length,
        5,
      );
      assert.equal(
        rung.moduleTypeIDs.filter((x) => x === "EM Shield Amplifier II").length,
        1,
      );
    },
  );
  function migrate(o) {
    const c = functions(s, ["migrateLegacyDominixFit"], {
      SHIP_LADDER: ladder,
      resolveShipLadderRung: () => ({ moduleTypeIDs: corrected }),
      resolveLadderTypeID: id,
      record,
      saveOperation,
    });
    c.migrateLegacyDominixFit(o);
  }
  await test(
    "04-dominix",
    "exact legacy template migrates idempotently",
    () => {
      const o = {
        kind: "upgrade",
        role: "security",
        hullTypeID: 645,
        moduleTypeIDs: [...corrected, extra],
      };
      migrate(o);
      assert.equal(JSON.stringify(o.moduleTypeIDs), JSON.stringify(corrected));
      migrate(o);
      assert.equal(JSON.stringify(o.moduleTypeIDs), JSON.stringify(corrected));
    },
  );
  await test("04-dominix", "custom template is not rewritten", () => {
    const o = {
      kind: "upgrade",
      role: "security",
      hullTypeID: 645,
      moduleTypeIDs: [extra, extra],
    };
    migrate(o);
    assert.deepEqual(o.moduleTypeIDs, [extra, extra]);
  });
  await test(
    "04-dominix",
    "impossible fit is rejected by slot capacity",
    () => {
      const c = functions(s, ["upgradeSlotError"], {
        Map,
        require: () => ({
          getRequiredSlotFamily: () => "med",
          getSlotFlagsForFamily: () => [1, 2, 3, 4, 5],
        }),
      });
      assert.match(
        c.upgradeSlotError({
          moduleTypeIDs: [1, 2, 3, 4, 5, 6],
          name: "bad",
          hullTypeID: 645,
        }),
        /requires 6 med slots/,
      );
    },
  );
  await test(
    "04-dominix",
    "surplus module returned through inventory broker",
    () => {
      const modules = [
          { itemID: 10, locationID: 7, flagID: 19 },
          { itemID: 11, locationID: 7, flagID: 20 },
        ],
        session = {
          shipID: 7,
          shipTypeID: 645,
          stationID: 10,
          currentBoundObjectID: "prior",
        };
      const c = functions(s, ["reconcileDominixMidSlots"], {
        resolveLadderTypeID: () => extra,
        record,
        saveOperation,
        getSpace: () => ({ describeError: String }),
        require: (p) =>
          p.includes("itemStore")
            ? {
                ITEM_FLAGS: { HANGAR: 4 },
                listCharacterItems: () => modules,
                findItemById: (i) => modules.find((m) => m.itemID === i),
              }
            : p.includes("liveFitting")
              ? { isFittedModuleItem: () => true }
              : class {
                  Handle_GetInventory() {
                    return { value: { value: ["bound"] } };
                  }
                  Handle_Add([itemID], ss, { flag }) {
                    const m = modules.find((m) => m.itemID === itemID);
                    m.locationID = 10;
                    m.flagID = flag;
                  }
                },
      });
      assert.equal(
        c.reconcileDominixMidSlots(
          {
            kind: "upgrade",
            role: "security",
            hullTypeID: 645,
            marketStationID: 10,
            moduleTypeIDs: [extra],
          },
          bot,
          session,
        ),
        null,
      );
      assert.equal(modules[0].locationID, 7);
      assert.equal(modules[1].locationID, 10);
      assert.equal(session.currentBoundObjectID, "prior");
    },
  );
}
(async () => {
  await dominix();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

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
async function mining() {
  const s = source("01-mining");
  function context(cargo, unloaded) {
    return functions(s, ["advanceMining"], {
      Date,
      WAIT_DELAY_MS: 300000,
      DEFAULT_MARKET_STATION_ID: 10,
      STEP_DELAY_MS: 5000,
      TRAVEL_DELAY_MS: 5000,
      BELT_DANGER_MS: 1800000,
      ACTIVE_STATUSES: new Set(["active", "holding"]),
      record,
      saveOperation,
      block,
      getSpace: () => ({}),
      getInventory: () => ({ unloadCargo: () => unloaded }),
      oreInCargo: () => cargo,
      addCounts: (a, b) => {
        for (const k in b) a[k] = (a[k] || 0) + b[k];
      },
      require: (p) => {
        assert.equal(p, "./playerBotEconomyRuntime");
        return { isJitaStation: () => false };
      },
    });
  }
  const op = () => ({
    stage: "unload",
    status: "active",
    miningThreatPolicyVersion: 2,
    marketStationID: 10,
    oreMined: {},
    trips: 0,
    beltID: 7,
    refine: false,
    sell: false,
  });
  await test("01-mining", "only actual unloaded ore counts", async () => {
    const o = op();
    await context(
      { 34: 100 },
      { success: true, unloaded: { 34: 60 } },
    ).advanceMining(o, bot);
    assert.equal(o.oreMined[34], 60);
    assert.equal(o.trips, 1);
  });
  await test(
    "01-mining",
    "empty return does not complete a productive trip",
    async () => {
      const o = op();
      await context({}, { success: true, unloaded: {} }).advanceMining(o, bot);
      assert.equal(o.trips, 0);
      assert.equal(o.stage, "undock");
      assert.ok(o.dangerousBelts[7]);
    },
  );
  await test(
    "01-mining",
    "rejected unload leaves output and trip unchanged",
    async () => {
      const o = op();
      await context(
        { 34: 100 },
        { success: false, message: "denied" },
      ).advanceMining(o, bot);
      assert.equal(o.status, "holding");
      assert.equal(o.trips, 0);
      assert.deepEqual(o.oreMined, {});
    },
  );
  for (const territorial of [false, true])
    await test(
      "01-mining",
      "unsafe belts " +
        (territorial
          ? "preserve territorial base"
          : "relocate ordinary autonomy"),
      async () => {
        const o = {
          ...op(),
          stage: "undock",
          autonomous: true,
          territorialOperation: territorial,
          homeStationID: 10,
          dangerousBelts: { 7: Date.now() },
        };
        const c = context({}, {});
        Object.assign(c, {
          getCharacterRecord: () => ({ shipTypeID: 32880 }),
          getMiningModules: () => [{}],
          worldData: { getAsteroidBeltsForSystem: () => [{ itemID: 7 }] },
          stationSystemID: () => 100,
          pickBelt: () => null,
          findNearestMiningStation: () => ({
            stationID: 20,
            systemID: 200,
            hops: 1,
          }),
          clearRouteTask: () => {},
        });
        await c.advanceMining(o, bot);
        assert.equal(o.homeStationID, territorial ? 10 : 20);
        assert.equal(o.stage, territorial ? "undock" : "to-home");
      },
    );
  const sp = source("01-mining", "playerBotSpaceRuntime.js");
  function spaceContext() {
    let valid = true;
    const e = { position: { x: 0, y: 0, z: 0 }, mode: "STOP" },
      session = {},
      rocks = [
        {
          entity: { itemID: 1, position: { x: 100, y: 0, z: 0 } },
          state: { yieldKind: "ore", yieldTypeID: 34, remainingQuantity: 100 },
        },
        {
          entity: { itemID: 2, position: { x: 10000, y: 0, z: 0 } },
          state: { yieldKind: "ore", yieldTypeID: 35, remainingQuantity: 100 },
        },
      ];
    const c = functions(sp, ["mineNearestAsteroid"], {
      Map,
      Set,
      log: { info() {} },
      ensureActorInSpace: () => ({
        entity: e,
        session,
        scene: { getShipEntityForSession: () => e },
      }),
      getSurfaceDistanceBetweenEntities: (x, y) => y.position.x,
      estimateOreValuePerVolume: async (b, s, t) => (t === 35 ? 100 : 1),
      spaceRuntime: {
        getTargets: () => [1],
        addTarget: () => ({ success: true }),
      },
      getDogmaService: () => ({ Handle_Activate() {}, Handle_Deactivate() {} }),
      require: (p) =>
        p.includes("miningNpc")
          ? { resolveAvailableMineableTargetEntries: () => rocks }
          : class {
              Handle_CmdFollowBall() {}
            },
    });
    return {
      c,
      rocks,
      e,
      options: { isCurrent: () => valid },
      invalidate: () => (valid = false),
    };
  }
  await test(
    "01-mining",
    "in-range ore wins over rich distant ore",
    async () => {
      const { c } = spaceContext();
      const r = await c.mineNearestAsteroid(bot, [{ itemID: 9 }], 5000, 10);
      assert.equal(r.targetID, 1);
      assert.equal(r.phase, "mining");
    },
  );
  await test(
    "01-mining",
    "stale async quote cannot reactivate lasers",
    async () => {
      const x = spaceContext();
      x.c.estimateOreValuePerVolume = async () => {
        x.invalidate();
        return 10;
      };
      const r = await x.c.mineNearestAsteroid(
        bot,
        [{ itemID: 9 }],
        5000,
        10,
        x.options,
      );
      assert.equal(r.interrupted, true);
    },
  );
  await test(
    "01-mining",
    "depleted belt has explicit noOre result",
    async () => {
      const { c, rocks } = spaceContext();
      rocks.length = 0;
      assert.equal(
        (await c.mineNearestAsteroid(bot, [{ itemID: 9 }], 5000, 10)).noOre,
        true,
      );
    },
  );
}
(async () => {
  await mining();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

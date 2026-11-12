"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const {
  createRuntime,
} = require("../integration/server/server/src/services/playerbots/playerBotInterruptRuntime");
const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(
  root,
  "integration/server/server/src/services/playerbots",
);
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const results = [];
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const rows = new Map();
  const repo = {
    ensureTable() {},
    flushTableSync: () => ({ success: true }),
    read(t, k) {
      return {
        success: true,
        data:
          k === "/"
            ? Object.fromEntries(
                [...rows]
                  .filter(([key]) => key.startsWith(t + ":/"))
                  .map(([key, v]) => [key.slice(t.length + 2), v]),
              )
            : rows.get(t + ":" + k),
      };
    },
    write(t, k, v) {
      rows.set(t + ":" + k, clone(v));
      return { success: true };
    },
  };
  return { rows, repo, authority: createRuntime(repo) };
}
function load(name, dependencies, extra = "") {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    Date,
    console,
    setImmediate,
    setTimeout,
    clearTimeout,
    require(id) {
      if (!(id in dependencies)) throw new Error(`Unexpected dependency ${id}`);
      return dependencies[id];
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(sourceRoot, name), "utf8") + extra,
    context,
    { filename: name },
  );
  return { exports: module.exports, context };
}
async function check(name, fn) {
  await fn();
  results.push({ name, passed: true });
}

async function main() {
  for (const confirmed of [true, false])
    await check(
      `supply contract owner settles before emergency; confirmed=${confirmed}`,
      () => {
        const f = fixture();
        let units = 0,
          balance = 1000,
          drains = 0;
        const deps = {
          "../../gameStore/tableRepository": {
            createTableRepository: () => f.repo,
          },
          "../character/characterState": {
            getCharacterRecord: () => ({ stationID: 60000400 }),
          },
          "../account/walletState": { getCharacterWallet: () => ({ balance }) },
          "../inventory/itemStore": {
            ITEM_FLAGS: { HANGAR: 4 },
            listCharacterItems: () => (units ? [{ stacksize: units }] : []),
          },
          "../../space/worldData": {},
          "../industry/industryStaticData": {},
          "../industry/industryConstants": { INDUSTRY_STATUS: {} },
          "./playerBotEconomyRuntime": { BOT_HUB_STATION_ID: 60000400 },
          "./playerBotInterruptRuntime": f.authority,
          "./playerBotLocalDefenseAdapter": { hasLease: () => false },
          "./playerBotRuntime": { listBots: () => [{ characterID: 1 }] },
          "./playerBotIndustryRuntime": {
            getManufacturingContext: () => ({
              quoteResult: {
                quote: {
                  materials: [{ typeID: 34, quantity: 2 }],
                  availableMaterials: {},
                },
              },
            }),
          },
          "./playerBotOperationRuntime": {
            drainInterruptions: () => {
              assert.equal(f.authority.isBusy(1), false);
              drains++;
            },
          },
          "./playerBotAutonomyRuntime": {
            wakeIndustryCycleStep: async () => {},
          },
        };
        const cycle = {
          characterID: 1,
          cycleID: "C1",
          status: "active",
          stage: "acquire-materials",
          stationID: 60000400,
          maxSpend: 1000,
          history: [],
          ledger: { materialSpend: 0, blueprintSpend: 0, unitsBought: {} },
        };
        f.repo.write("playerBots", "/_playerBotIndustryCycle_1", {
          playerBotIndustryCycleRecord: cycle,
        });
        const runtime = load("playerBotIndustryCycleRuntime.js", deps).exports;
        const reservation = runtime.beginSupplyPurchase(
          1,
          "C1",
          60000400,
          34,
          2,
          10,
          2,
        );
        assert.equal(reservation.success, true);
        assert.equal(f.authority.isBusy(1), true);
        f.authority.request(1, { kind: "retreat", attackerID: 9 });
        assert.equal(
          f.authority.drain(1, () => true),
          false,
        );
        assert.equal(
          runtime.finishSupplyPurchase(1, "stale", {}).reason,
          "supply-owner-mismatch",
        );
        assert.equal(f.authority.isBusy(1), true);
        units = confirmed ? 2 : 0;
        balance = 980;
        const result = runtime.finishSupplyPurchase(1, reservation.token, {
          confirmed,
          sellerName: "fixture",
          contractID: 1,
        });
        assert.equal(result.success, confirmed);
        assert.equal(drains, 1);
        assert.equal(f.authority.isBusy(1), false);
        const saved = runtime.getCycle(1);
        assert.equal(saved.status, confirmed ? "active" : "review");
        assert.equal(saved.ledger.materialSpend, confirmed ? 20 : 0);
        assert.equal(Boolean(saved.pending), !confirmed);
        assert.equal(
          runtime.finishSupplyPurchase(1, reservation.token, {
            confirmed: true,
          }).reason,
          "supply-owner-missing",
        );
      },
    );
  await check(
    "one owner; stale token; durable replay and conditional acknowledgment",
    () => {
      const f = fixture(),
        a = f.authority;
      const owner = a.acquire(1, "operation", "OP1");
      assert.ok(owner);
      assert.equal(a.acquire(1, "navigation"), null);
      a.request(1, { kind: "retreat", attackerID: 9 });
      assert.equal(a.current(owner), false);
      assert.equal(
        a.drain(1, () => true),
        false,
      );
      a.release(owner);
      const recovered = createRuntime(f.repo);
      assert.deepEqual(recovered.pendingIDs(), [1]);
      assert.equal(
        recovered.drain(1, () => false),
        false,
      );
      assert.equal(recovered.hasPending(1), true);
      recovered.drain(1, () => {
        recovered.request(1, { kind: "retreat", attackerID: 10 });
        return true;
      });
      assert.equal(recovered.pending(1).pending.attackerID, 10);
      recovered.drain(1, () => true);
      assert.equal(recovered.hasPending(1), false);
    },
  );
  await check(
    "retreat cannot be downgraded by engage or escort; bounded mailbox",
    () => {
      const f = fixture(),
        a = f.authority;
      for (let i = 0; i < 100; i++) {
        a.request(1, {
          kind: "mining",
          attackerID: 9,
          details: { action: "retreat" },
        });
        a.request(1, {
          kind: "mining",
          attackerID: 10,
          details: { action: "escort" },
        });
        a.request(1, { kind: "engage", attackerID: 11 });
      }
      assert.equal(a.pending(1).pending.details.action, "retreat");
      assert.equal(f.rows.size, 1);
      assert.equal(a.pending(1).generation, 300);
    },
  );
  for (const unknown of [false, true])
    await check(
      `committed purchase preserves ledger and ${unknown ? "review marker" : "single debit"} on attack`,
      async () => {
        const f = fixture(),
          payment = deferred(),
          entered = deferred();
        const bot = {
            characterID: 1,
            characterName: "fixture",
            specialty: "trade",
          },
          character = { shipID: 20, solarSystemID: 30000132 };
        let calls = 0,
          wallet = 1000,
          items = 0;
        const deps = {
          "./playerBotLocalDefenseAdapter": { hasLease: () => false },
          "../../gameStore/tableRepository": {
            createTableRepository: () => f.repo,
          },
          "./playerBotInterruptRuntime": f.authority,
          "./playerBotTaskRuntime": { hasBlockingLease: () => false },
          "../character/characterState": {
            getCharacterRecord: () => character,
          },
          "../../space/worldData": {
            getStationsForSystem: () => [{ stationID: 60000400 }],
          },
          "./playerBotEconomyRuntime": {
            BOT_HUB_STATION_ID: 60000400,
            isJitaStation: () => false,
          },
          "./playerBotRuntime": { getBotByCharacterID: () => bot },
          "./playerBotTradeRuntime": {
            readQuote: async () => ({
              success: true,
              bestAsk: { price: 10, quantity: 10 },
            }),
            buy: async () => {
              calls++;
              wallet -= 20;
              items += unknown ? 0 : 2;
              entered.resolve();
              return payment.promise;
            },
          },
          "./playerBotInventoryRuntime": {
            countHangar: () => items,
            countCargo: () => 0,
          },
          "../account/walletState": {
            getCharacterWallet: () => ({ balance: wallet }),
          },
          "./playerBotAutonomyRuntime": {
            wakeIndustryCycleStep: async () => {},
          },
          "../../utils/logger": { warn: () => {} },
        };
        // Adapter uses the actual buyUnits and saveOperation bodies; no economic
        // algorithm is reimplemented in the fixture. External payment is controlled.
        const { exports: ops } = load(
          "playerBotOperationRuntime.js",
          deps,
          `
      HANDLERS['qa-purchase'] = async (operation,bot) => {
        const result = await buyUnits(operation,bot,34,2);
        operation.status = result.review ? 'review' : 'active';
        operation.lastError = result.review || null;
        saveOperation(operation); return {delayMs:5000};
      };`,
        );
        ops._testing.saveOperation({
          operationID: "QABUY",
          characterID: 1,
          characterName: "fixture",
          kind: "qa-purchase",
          status: "active",
          stage: "buy",
          marketStationID: 60000400,
          maxSpend: 1000,
          spent: 0,
        });
        const step = ops.advanceOperation(1);
        await entered.promise;
        ops.requestThreatRetreat(1, 99, "test incoming threat");
        assert.equal(f.authority.hasPending(1), true);
        assert.equal(ops.getOperation(1).pending.action, "buy");
        assert.equal((await ops.advanceOperation(1)).busy, true);
        payment.resolve(
          unknown
            ? { success: false, outcomeUnknown: true, message: "response lost" }
            : { success: true, bought: 2, spent: 20 },
        );
        await step;
        const saved = ops.getOperation(1);
        assert.equal(saved.operationID, "QABUY");
        assert.equal(saved.kind, "qa-purchase");
        assert.equal(saved.threatRetreat.attackerEntityID, 99);
        assert.equal(calls, 1);
        assert.equal(wallet, 980);
        if (unknown) {
          assert.equal(saved.pending.action, "buy");
          assert.equal(saved.threatRetreat.resumeStatus, "review");
        } else {
          assert.equal(saved.spent, 20);
          assert.equal(saved.pending, null);
          assert.equal(items, 2);
        }
        character.stationID = 60000400;
        await ops.advanceOperation(1);
        assert.equal(ops.getOperation(1).status, unknown ? "review" : "active");
        assert.equal(calls, 1);
        assert.equal(f.authority.hasPending(1), false);
      },
    );
  // Exercise the actual asynchronous mining function, not a replacement that
  // simply claims it aborted. World/services are probes so no real DB is opened.
  for (const locationChange of [false, true])
    await check(
      `no late movement/lock/miner activation after ${locationChange ? "ship change" : "interruption"}`,
      async () => {
        const quote = deferred(),
          entered = deferred(),
          calls = [];
        const entity = {
          itemID: 20,
          position: { x: 0, y: 0, z: 0 },
          activeModuleEffects: new Map(),
        };
        const scene = { getShipEntityForSession: () => entity };
        const session = { shipID: 20 };
        let valid = true;
        const candidates = [1, 2].map((i) => ({
          entity: { itemID: 100 + i, position: { x: i * 1000, y: 0, z: 0 } },
          state: {
            yieldKind: "ore",
            yieldTypeID: 34 + i,
            remainingQuantity: 100,
          },
        }));
        const deps = {
          "../character/characterState": {},
          "./playerBotRuntime": {},
          "../../space/runtime": {
            getTargets: () => [],
            addTarget: () => {
              calls.push("lock");
              return { success: true };
            },
          },
          "../../space/worldData": {},
          "../structure/structureLocation": {},
          "../../common/machoErrors": {},
          "../../utils/logger": { info: () => {}, warn: () => {} },
          "../../common/vector": {
            distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
          },
          "./playerBotCombatPolicy": {},
          "../mining/miningNpcOperations": {
            resolveAvailableMineableTargetEntries: () => candidates,
          },
          "../ship/beyonceService": class {
            Handle_CmdFollowBall() {
              calls.push("move");
            }
          },
          probes: { entity, scene, session, quote, entered, calls },
        };
        const { exports: space } = load(
          "playerBotSpaceRuntime.js",
          deps,
          `
      const probes=require('probes');
      ensureActorInSpace=()=>({entity:probes.entity,scene:probes.scene,session:probes.session});
      estimateOreValuePerVolume=async()=>{probes.entered.resolve();return probes.quote.promise;};
      getDogmaService=()=>({Handle_Activate(){probes.calls.push('activate');},Handle_Deactivate(){probes.calls.push('deactivate');}});`,
        );
        const run = space.mineNearestAsteroid(
          { characterID: 1, characterName: "fixture" },
          [{ itemID: 200 }],
          5000,
          60000400,
          { isCurrent: () => valid },
        );
        await entered.promise;
        if (locationChange)
          scene.getShipEntityForSession = () => ({ ...entity, itemID: 21 });
        else valid = false;
        quote.resolve(10);
        const outcome = await run;
        assert.equal(outcome.interrupted, true);
        assert.deepEqual(calls, []);
      },
    );
  printReport(
    path.join(root, "test-output/P15/authority-tests.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: "source modules, simulated world/payment/repository",
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: results.length, results }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

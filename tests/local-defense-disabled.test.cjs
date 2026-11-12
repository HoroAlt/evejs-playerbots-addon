"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const dir = path.resolve(
  __dirname,
  "../integration/server/server/src/services/playerbots",
);
const defaults = require(
  path.join(dir, "playerBotLocalDefenseConfig"),
).validate({});
assert.equal(defaults.enabled, false);
assert.equal(defaults.aggressive, false);
assert.deepEqual(defaults.systemIDs, []);
assert.deepEqual(defaults.responderIDs, []);
function fixture(settings, kind, npc) {
  const module = { exports: {} },
    calls = [];
  let now = 100000;
  const mine = {
      kind: "mine",
      status: "active",
      escortCharacterID: 2,
      miningEscortGroupKey: "belt",
    },
    escort = {
      kind: "combat",
      status: "active",
      mode: "security",
      miningEscortGroupKey: "belt",
    };
  const op = kind === "mine" ? mine : { kind, status: "active" };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(dir, "playerBotThreatResponseRuntime.js"),
      "utf8",
    ),
    {
      module,
      Date,
      Map,
      Set,
      setImmediate,
      require: (id) => {
        if (id === "./playerBotLocalDefenseConfig")
          return { get: () => settings };
        if (id === "./playerBotLocalDefenseAdapter")
          return { hasLease: () => false };
        if (id === "./playerBotCombatPolicy") return { isPirateNpc: () => npc };
        if (id === "./playerBotAutonomyRuntime")
          return { wakeIndustryCycleStep: async () => {} };
        throw Error(id);
      },
    },
  );
  const deps = {
    now: () => now,
    playerBots: {
      getBotByCharacterID: (id) => ({ characterID: id, status: "active" }),
    },
    operationRuntime: {
      getOperation: (id) => (id === 2 ? escort : op),
      setMiningIncomingThreat: (id, target, details) =>
        calls.push(details.action),
      setDefensiveCombatTarget: () => calls.push("engage"),
      requestThreatRetreat: () => calls.push("retreat"),
    },
    combatRuntime: { assessDefensiveResponse: () => ({ action: "engage" }) },
    miningEscortRuntime: {},
    space: {},
    logger: {},
  };
  const payload = {
    characterID: 1,
    scene: { systemID: 1 },
    attackerEntity: { itemID: 20, kind: "ship", session: { characterID: 9 } },
  };
  return {
    calls,
    run: () => module.exports.handleIncomingThreat(payload, deps),
    later: () => {
      now += 1000;
    },
  };
}
(async () => {
  for (const kind of ["combat", "mine", "pi-collect", "haul", "industry"])
    for (const npc of [true, false]) {
      const f = fixture(defaults, kind, npc);
      await f.run();
      const expected =
        kind === "combat"
          ? ["engage"]
          : kind === "mine"
            ? npc
              ? ["engage"]
              : ["engage", "escort"]
            : npc
              ? []
              : ["retreat"];
      assert.deepEqual(
        f.calls,
        expected,
        `disabled legacy routing ${kind}/${npc}`,
      );
    }
  for (const npc of [true, false]) {
    const f = fixture(
      {
        enabled: true,
        aggressive: false,
        miningRescue: false,
        generalRescue: true,
        systemIDs: [1],
      },
      "mine",
      npc,
    );
    await f.run();
    assert.deepEqual(
      f.calls,
      npc ? ["engage"] : ["engage", "escort"],
      "miningRescue=false preserves existing escort behavior",
    );
  }
  const f = fixture(
    { enabled: true, aggressive: false, systemIDs: [1] },
    "combat",
    true,
  );
  await f.run();
  f.later();
  const repeated = await f.run();
  assert.equal(repeated.reused, true);
  assert.equal(
    f.calls.length,
    1,
    "non-aggressive policy keeps legacy NPC cache",
  );
  let writes = 0,
    queued = 0;
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(dir, "playerBotLocalDefenseAdapter.js"), "utf8"),
    {
      module,
      setImmediate: () => queued++,
      require: (id) => {
        if (id === "./playerBotLocalDefenseConfig")
          return { get: () => defaults };
        if (id === "../../space/destiny/identity/interactionScope") return {};
        if (id === "./playerBotInterruptRuntime") return {};
        if (id === "../../gameStore/tableRepository")
          return {
            createTableRepository: () => ({
              read: () => ({ data: undefined }),
              ensureTable() {
                writes++;
              },
              write() {
                writes++;
                return { success: true };
              },
              flushTableSync: () => ({ success: true }),
            }),
          };
        if (id === "./playerBotLocalDefenseRuntime")
          return require(path.join(dir, "playerBotLocalDefenseRuntime"));
        throw Error("disabled path unexpectedly loaded " + id);
      },
    },
  );
  const a = module.exports;
  a.reportThreat({ systemID: 1 }, {}, {});
  assert.equal(a.noteThreat({ systemID: 1 }, {}, {}), false);
  assert.equal(await a.advance(1), null);
  a.maintain();
  assert.equal(writes, 0);
  assert.equal(queued, 0);
  console.log(
    "PASS disabled/default routing, independent switches, cached NPC assessment and zero rescue writes/dispatch",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const fs = require("fs"),
  vm = require("vm"),
  path = require("path"),
  assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
const results = [];
for (let n = 0; n < 10; n++)
  for (const kind of ["pi-collect", "haul", "industry", "combat", "mine"])
    for (const npc of [true, false]) {
      const calls = [];
      const module = { exports: {} };
      const settings = { enabled: true, aggressive: true, generalRescue: true, systemIDs: [1] };
      vm.runInNewContext(
        fs.readFileSync(
          path.join(
            root,
            "integration/server/server/src/services/playerbots/playerBotThreatResponseRuntime.js",
          ),
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
            if (id === "./playerBotCombatPolicy")
              return { isPirateNpc: () => npc };
            if (id === "./playerBotAutonomyRuntime")
              return { wakeIndustryCycleStep: async () => {} };
            throw Error(id);
          },
        },
      );
      const op = { kind, status: "active" },
        deps = {
          playerBots: {
            getBotByCharacterID: () => ({ characterID: 1, status: "active" }),
          },
          operationRuntime: {
            getOperation: () => op,
            requestThreatRetreat: () => calls.push("retreat"),
            setMiningIncomingThreat: () => calls.push("mine"),
            setDefensiveCombatTarget: () => calls.push("engage"),
          },
          combatRuntime: {
            assessDefensiveResponse: () => ({ action: "engage" }),
          },
          miningEscortRuntime: {},
          space: {},
          logger: {},
        };
      const payload = {
        characterID: 1,
        scene: { systemID: 1 },
        attackerEntity: {
          itemID: 2,
          kind: "ship",
          session: { characterID: 2 },
        },
      };
      results.push(
        (async () => {
          await module.exports.handleIncomingThreat(payload, deps);
          assert.deepEqual(calls, [
            kind === "combat" ? "engage" : kind === "mine" ? "mine" : "retreat",
          ]);
          if (npc && !["combat", "mine"].includes(kind)) {
            for (const field of ["enabled", "generalRescue"]) {
              calls.length = 0;
              settings[field] = false;
              await module.exports.handleIncomingThreat(payload, deps);
              assert.equal(calls.length, 0);
              settings[field] = true;
            }
            calls.length = 0;
            payload.scene.systemID = 99;
            await module.exports.handleIncomingThreat(payload, deps);
            assert.equal(calls.length, 0);
          }
          return { repeat: n, kind, npc, passed: true };
        })(),
      );
    }
Promise.all(results)
  .then((rows) => {
    printReport(
      path.join(root, "test-output/P8-pi-fix/threat-boundaries.json"),
      JSON.stringify(
        { passed: true, cases: rows.length, results: rows },
        null,
        2,
      ),
    );
    console.log("PASS", rows.length, "threat routing cases");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

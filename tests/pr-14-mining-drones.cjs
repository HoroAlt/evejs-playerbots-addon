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

function build(context) {
  vm.createContext(context);
  vm.runInContext(extract(SOURCE, "launchDefensiveDrones"), context);
  return context;
}

function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
  }
}

function harness({ inSpace = true, busy = false, launched = [{ itemID: 11 }, { itemID: 12 }] } = {}) {
  const calls = { engage: [], launch: 0 };
  const ctx = build({
    normalizePositiveInteger: (value) => {
      const n = Math.trunc(Number(value));
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    },
    getSpace: () => ({
      getSpaceState: () => ({ inSpace, busy }),
      getActorSpace: () => ({ session: { id: "s" }, scene: { id: "scene" }, entity: { itemID: 9001 } }),
    }),
    require: (id) => {
      if (id.includes("playerBotCombatRuntime")) {
        return {
          launchDrones: () => {
            calls.launch += 1;
            return launched ? { success: true, drones: launched } : { success: false };
          },
        };
      }
      if (id.includes("droneRuntime")) {
        return { commandEngage: (session, ids, target) => calls.engage.push({ ids, target }) };
      }
      return {};
    },
  });
  return { ctx, calls };
}

test("a miner under fire launches its drones at the attacker", () => {
  const { ctx, calls } = harness();
  assert.equal(ctx.launchDefensiveDrones({ characterID: 1 }, 555), true);
  assert.equal(calls.launch, 1);
  assert.deepEqual(calls.engage, [{ ids: [11, 12], target: 555 }]);
});

test("no launch while the ship is warping out", () => {
  const { ctx, calls } = harness({ busy: true });
  assert.equal(ctx.launchDefensiveDrones({ characterID: 1 }, 555), false);
  assert.equal(calls.launch, 0);
});

test("no launch when the bay is empty", () => {
  const { ctx, calls } = harness({ launched: [] });
  assert.equal(ctx.launchDefensiveDrones({ characterID: 1 }, 555), false);
  assert.equal(calls.engage.length, 0);
});

test("an invalid attacker is ignored", () => {
  const { ctx, calls } = harness();
  assert.equal(ctx.launchDefensiveDrones({ characterID: 1 }, 0), false);
  assert.equal(calls.launch, 0);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

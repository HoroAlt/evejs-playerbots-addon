"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const results = [];
const SOURCE = fs.readFileSync(
  path.join(__dirname, "../integration/server/server/src/services/playerbots/playerBotFitPlanner.js"),
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

function build(names, context) {
  vm.createContext(context);
  vm.runInContext(names.map((name) => extract(SOURCE, name)).join("\n"), context);
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

const attributes = {
  17478: { cpuOutput: 250, powerOutput: 60 },
  1: { cpu: 298, power: 50 },
  2: { cpu: 60, power: 10 },
  3: { cpu: 400, power: 5 },
};

function fittingStub() {
  return {
    getTypeAttributeValue(typeID, attribute) {
      const row = attributes[Number(typeID)] || {};
      return Object.prototype.hasOwnProperty.call(row, attribute) ? row[attribute] : undefined;
    },
  };
}

function plannerContext() {
  return build(["planResourceLoad", "planPriceEstimate", "isOreMiningFit", "pilotHash"], {
    ORE_MODULE_GROUP: /strip miner|mining laser/i,
    NON_ORE_MODULE: /ice harvester|gas cloud/i,
    FIT_RESOURCE_TOLERANCE: 1.05,
    require(id) {
      if (id.includes("liveFittingState")) return fittingStub();
      if (id.includes("itemTypeRegistry")) {
        return {
          resolveItemByTypeID(typeID) {
            const types = {
              100: { name: "Miner II", groupName: "Mining Laser", basePrice: 1000000 },
              101: { name: "Ice Harvester II", groupName: "Strip Miner", basePrice: 5000000 },
              102: { name: "Gas Cloud Harvester I", groupName: "Gas Cloud Harvester", basePrice: 900000 },
              103: { name: "Strip Miner I", groupName: "Strip Miner", basePrice: null },
              17478: { name: "Retriever", basePrice: 28800000 },
            };
            return types[Number(typeID)] || null;
          },
        };
      }
      return {};
    },
  });
}

test("an over-budget CPU fit is not feasible", () => {
  const ctx = plannerContext();
  const load = ctx.planResourceLoad({ shipTypeID: 17478, moduleTypeIDs: [1] });
  assert.equal(load.feasible, false);
  assert.equal(load.cpu, 298);
});

test("an affordable fit is feasible", () => {
  const ctx = plannerContext();
  const load = ctx.planResourceLoad({ shipTypeID: 17478, moduleTypeIDs: [2, 2, 2, 2] });
  assert.equal(load.feasible, true);
});

test("missing hull attributes do not drop every fit", () => {
  const ctx = plannerContext();
  const load = ctx.planResourceLoad({ shipTypeID: 999, moduleTypeIDs: [3] });
  assert.equal(load.feasible, true);
});

test("ice harvesters and gas scoops are not ore fits", () => {
  const ctx = plannerContext();
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [101] }), false);
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [102] }), false);
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [100] }), true);
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [] }), false);
});

test("price estimate counts unknown base prices instead of zeroing them", () => {
  const ctx = plannerContext();
  const estimate = ctx.planPriceEstimate({ shipTypeID: 17478, moduleTypeIDs: [103, 100] });
  assert.equal(estimate.total, 29800000);
  assert.equal(estimate.unknown, 1);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

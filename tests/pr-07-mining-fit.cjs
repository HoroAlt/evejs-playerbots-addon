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

function constant(name) {
  const match = new RegExp("^const " + name + " = ([^;]+);", "m").exec(SOURCE);
  assert.ok(match, "Missing constant " + name);
  return match[1];
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
  1: { cpu: 250, power: 10 },
  2: { cpu: 251, power: 10 },
  3: { cpu: 100, power: 10 },
};

function plannerContext() {
  return build(["planResourceLoad", "isOreMiningFit", "pilotHash", "oreFitForPilot"], {
    ORE_MODULE_GROUP: /strip miner|mining laser/i,
    NON_ORE_MODULE: /ice harvester|gas cloud/i,
    FIT_RESOURCE_TOLERANCE: Number(constant("FIT_RESOURCE_TOLERANCE")),
    require(id) {
      if (id.includes("liveFittingState")) {
        return {
          getTypeAttributeValue(typeID, attribute) {
            const row = attributes[Number(typeID)] || {};
            return Object.prototype.hasOwnProperty.call(row, attribute) ? row[attribute] : undefined;
          },
        };
      }
      if (id.includes("itemTypeRegistry")) {
        return {
          resolveItemByTypeID(typeID) {
            const types = {
              100: { name: "Miner II", groupName: "Mining Laser" },
              101: { name: "Ice Harvester II", groupName: "Strip Miner" },
              102: { name: "Gas Cloud Harvester I", groupName: "Gas Cloud Harvester" },
            };
            return types[Number(typeID)] || null;
          },
        };
      }
      return {};
    },
  });
}

test("a fit exactly at the hull limit is feasible", () => {
  const ctx = plannerContext();
  assert.equal(ctx.planResourceLoad({ shipTypeID: 17478, moduleTypeIDs: [1] }).feasible, true);
});

test("one point over the hull limit is not feasible", () => {
  const ctx = plannerContext();
  assert.equal(ctx.planResourceLoad({ shipTypeID: 17478, moduleTypeIDs: [2] }).feasible, false);
});

test("missing hull attributes do not drop every fit", () => {
  const ctx = plannerContext();
  assert.equal(ctx.planResourceLoad({ shipTypeID: 999, moduleTypeIDs: [3] }).feasible, true);
});

test("ice harvesters and gas scoops are not ore fits", () => {
  const ctx = plannerContext();
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [101] }), false);
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [102] }), false);
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [100] }), true);
  assert.equal(ctx.isOreMiningFit({ moduleTypeIDs: [] }), false);
});

test("the best-yield set is chosen deterministically per pilot", () => {
  const ctx = plannerContext();
  const fits = [
    { catalogIndex: 0, miningYield: 400, cpu: 300 },
    { catalogIndex: 1, miningYield: 400, cpu: 400 },
    { catalogIndex: 2, miningYield: 300, cpu: 100 },
  ];
  ctx.oreFitsForHull = () => fits;
  const picked = new Set();
  for (let characterID = 140000001; characterID <= 140000020; characterID += 1) {
    const first = ctx.oreFitForPilot(17478, characterID);
    const second = ctx.oreFitForPilot(17478, characterID);
    assert.equal(first, second);
    assert.ok(first.miningYield === 400);
    picked.add(first.catalogIndex);
  }
  // Both 400-yield fits must be reachable, or the hash tie-break is inert.
  assert.deepEqual([...picked].sort(), [0, 1]);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

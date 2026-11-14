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

// --- curated mining fits respect the hull's CPU/PG budget -------------------
const feasible = { value: true };
const ctx = {
  CURATED_MINING_FITS: {
    32880: [
      { name: "T2", moduleTypeIDs: [1, 1, 2], droneTypeIDs: [] },
      { name: "T1", moduleTypeIDs: [3, 3], droneTypeIDs: [] },
    ],
  },
  canUseRung: () => true,
  require: () => ({
    planResourceLoad: ({ moduleTypeIDs }) => ({
      // The T2 option carries module 1, which the stub hull cannot power.
      feasible: feasible.value || !moduleTypeIDs.includes(1),
    }),
  }),
};
vm.createContext(ctx);
vm.runInContext(extract(SOURCE, "curatedMiningFit"), ctx);

test("an over-budget fit is skipped for the next option", () => {
  feasible.value = false;
  assert.equal(ctx.curatedMiningFit({ characterID: 1 }, {}, 32880).name, "T1");
});

test("the first feasible option wins", () => {
  feasible.value = true;
  assert.equal(ctx.curatedMiningFit({ characterID: 1 }, {}, 32880).name, "T2");
});

test("a hull whose every fit is infeasible yields no fit", () => {
  assert.equal(ctx.curatedMiningFit({ characterID: 1 }, {}, 17480), null);
});

// --- a repeatedly rejected module stops holding forever --------------------
const blocked = [];
const failCtx = {
  block: (operation, status, reason) => {
    blocked.push({ status, reason });
    return { state: status, reason };
  },
  getSpace: () => ({ getActorSession: () => ({ shipID: 0 }) }),
};
vm.createContext(failCtx);
vm.runInContext(extract(SOURCE, "failSavedFitting"), failCtx);

test("the same rejected module is blocked after five attempts", () => {
  blocked.length = 0;
  const operation = { kind: "upgrade" };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    failCtx.failSavedFitting(operation, { characterID: 1 }, "holding", "Fitting module 482 was rejected: CustomNotify.", {});
  }
  assert.equal(blocked.at(-1).status, "blocked");
  assert.match(blocked.at(-1).reason, /abandoned after 5 attempts/);
});

test("a blocked failure is passed through without counting", () => {
  blocked.length = 0;
  failCtx.failSavedFitting({ kind: "upgrade" }, { characterID: 1 }, "blocked", "No slot.", {});
  assert.equal(blocked.at(-1).status, "blocked");
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

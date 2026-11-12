"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const dir = path.resolve(
  __dirname,
  "../integration/server/server/src/services/playerbots",
);
let corps = { 1: 10, 2: 20 },
  alliances = {},
  wars = [],
  agreements = [];
const deps = {
  "./playerBotLocalDefenseConfig": { get: () => ({ agreements }) },
  "./playerBotInterruptRuntime": {},
  "../../space/destiny/identity/interactionScope": {},
  "../character/characterState": {
    getCharacterRecord: (id) => ({ corporationID: corps[id] }),
  },
  "../corporation/corporationState": {
    getCorporationRecord: (id) => ({ allianceID: alliances[id] }),
  },
  "../corporation/warRuntimeState": { listAllWars: () => wars },
};
const moduleObject = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(dir, "playerBotLocalDefenseAdapter.js"), "utf8"),
  {
    module: moduleObject,
    require: (id) => {
      assert.ok(id in deps, id);
      return deps[id];
    },
  },
);
const related = () => moduleObject.exports.related(1, 2);
assert.equal(related(), false);
corps[2] = 10;
assert.equal(related(), true);
corps[2] = 20;
alliances = { 10: 99, 20: 99 };
assert.equal(related(), true);
alliances = {};
agreements = [[10, 20]];
assert.equal(related(), true);
wars = [
  {
    declaredByID: 20,
    againstID: 10,
    timeStarted: "future",
    timeFinished: null,
  },
];
assert.equal(related(), false, "pending declaration overrides aid agreement");
wars[0].timeFinished = "past";
assert.equal(related(), true);
alliances = { 10: 99 };
wars = [{ declaredByID: 99, againstID: 20, timeFinished: null }];
assert.equal(related(), false);
wars = [];
corps[2] = undefined;
assert.equal(related(), false);
printReport(
  path.resolve(__dirname, "../test-output/P3/relations.json"),
  JSON.stringify(
    {
      passed: true,
      groups: 8,
      scope: "actual affiliation selector; controlled corporation/war records",
    },
    null,
    2,
  ),
);
console.log("PASS eight affiliation/war boundaries");

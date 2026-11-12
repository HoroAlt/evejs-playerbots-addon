"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const dir = path.resolve(
  __dirname,
  "../integration/server/server/src/services/playerbots",
);
const config = require(path.join(dir, "playerBotLocalDefenseConfig"));
let settings = config.validate({}),
  writes = 0,
  wakes = 0,
  cancelled = 0;
const deps = {
  "./playerBotLocalDefenseConfig": {
    get: () => settings,
    set: (v) => {
      settings = config.validate(v);
      writes++;
    },
  },
  "./playerBotLocalDefenseAdapter": {
    maintain() {},
    snapshot: () => ({ events: {}, leases: { 2: {} } }),
    cancelIncident: (id) => {
      cancelled++;
      return id === "LD1";
    },
  },
  "./playerBotAutonomyRuntime": { wakeIndustryCycleStep: async () => wakes++ },
};
const moduleObject = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(dir, "playerBotLocalDefenseCommands.js"), "utf8"),
  {
    module: moduleObject,
    require: (id) => {
      assert.ok(id in deps, id);
      return deps[id];
    },
  },
);
const command = moduleObject.exports.handle;
assert.match(command('set {"enabled":true}', false), /Administrator/);
assert.equal(writes, 0);
assert.match(
  command(
    'set {"enabled":true,"miningRescue":true,"generalRescue":false}',
    true,
  ),
  /saved/,
);
assert.equal(settings.enabled, true);
assert.equal(settings.generalRescue, false);
assert.equal(wakes, 1);
assert.match(command('set {"unknown":1}', true), /failed/);
assert.equal(writes, 1);
assert.match(command("set []", true), /failed/);
assert.equal(writes, 1);
assert.match(command("status", true), /miningRescue":true/);
assert.match(command("events", true), /No local/);
assert.match(command("cancel LD1", true), /closing/);
assert.equal(cancelled, 1);
command("off", true);
assert.equal(settings.enabled, false);
assert.equal(settings.aggressive, false);
assert.throws(() => config.validate({ generalRescue: "yes" }));
printReport(
  path.resolve(__dirname, "../test-output/P3/commands.json"),
  JSON.stringify(
    {
      passed: true,
      groups: 8,
      scope:
        "command handler and actual config validation; chat client UI not connected",
    },
    null,
    2,
  ),
);
console.log(
  "PASS admin commands, independent switches and invalid-config rejection",
);

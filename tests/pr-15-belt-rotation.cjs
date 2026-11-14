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

const BELTS = [{ itemID: 11 }, { itemID: 12 }, { itemID: 13 }];
const ctx = {
  BELT_DANGER_MS: 30 * 60 * 1000,
  worldData: { getAsteroidBeltsForSystem: () => BELTS },
  stationSystemID: () => 30001447,
};
vm.createContext(ctx);
vm.runInContext(extract(SOURCE, "pickBelt"), ctx);

const now = 1_000_000_000;

test("a belt never visited is picked before recently used ones", () => {
  const operation = {
    homeStationID: 60000826,
    recentBelts: { 11: now - 1000, 12: now - 2000 },
  };
  assert.equal(ctx.pickBelt(operation, now).itemID, 13);
});

test("the least recently visited belt wins", () => {
  const operation = {
    homeStationID: 60000826,
    recentBelts: { 11: now - 1000, 12: now - 500_000, 13: now - 900_000 },
  };
  assert.equal(ctx.pickBelt(operation, now).itemID, 13);
});

test("a belt marked dangerous is skipped", () => {
  const operation = {
    homeStationID: 60000826,
    recentBelts: {},
    dangerousBelts: { 11: now - 1000 },
  };
  assert.equal(ctx.pickBelt(operation, now).itemID, 12);
});

test("no safe belt returns null", () => {
  const operation = {
    homeStationID: 60000826,
    dangerousBelts: { 11: now, 12: now, 13: now },
  };
  assert.equal(ctx.pickBelt(operation, now), null);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

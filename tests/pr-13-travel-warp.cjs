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

const STATION = 60000826;
const ctx = build(["travelNeedsWarp"], {
  DOCK_WARP_RANGE_METERS: 50_000,
  normalizePositiveInteger: (value) => {
    const n = Math.trunc(Number(value));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  },
});

test("a distant ship warps", () => {
  assert.equal(ctx.travelNeedsWarp(180_000, {}, STATION, 1_000_000), true);
});

test("a ship inside docking range does not warp", () => {
  assert.equal(ctx.travelNeedsWarp(30_000, {}, STATION, 1_000_000), false);
});

test("a warp that made no progress hands over to the docking approach", () => {
  const operation = { travelWarpStationID: STATION, travelWarpAtMs: 1_000_000, travelWarpDistance: 82_000 };
  assert.equal(ctx.travelNeedsWarp(81_500, operation, STATION, 1_030_000), false);
});

test("a warp that is still closing keeps warping", () => {
  const operation = { travelWarpStationID: STATION, travelWarpAtMs: 1_000_000, travelWarpDistance: 900_000 };
  assert.equal(ctx.travelNeedsWarp(120_000, operation, STATION, 1_030_000), true);
});

test("progress after a stalled warp resumes warping", () => {
  const operation = { travelWarpStationID: STATION, travelWarpAtMs: 1_000_000, travelWarpDistance: 200_000 };
  assert.equal(ctx.travelNeedsWarp(120_000, operation, STATION, 1_030_000), true);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

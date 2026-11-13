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

const VENTURE = 32880;
const RETRIEVER = 17478;
const COVETOR = 17476;
const PROCURER = 17480;
const MACKINAW = 22548;
const CAPSULE = 670;

// Mirrors the mining ladder: one barge rung covering three hulls of the same
// tier, then the exhumer.
const ladder = [
  { hullTypeID: VENTURE, hullChoices: [VENTURE] },
  { hullTypeID: PROCURER, hullChoices: [RETRIEVER, COVETOR, PROCURER] },
  { hullTypeID: MACKINAW, hullChoices: [MACKINAW] },
];

const ctx = build(["rungIndexOfHull", "rungHullForPilot"], {});

test("every hull of a multi-hull rung resolves to that rung", () => {
  for (const hull of [RETRIEVER, COVETOR, PROCURER]) {
    assert.equal(ctx.rungIndexOfHull(ladder, hull), 1, `hull ${hull}`);
  }
});

test("a barge pilot is not treated as off-ladder", () => {
  // The downgrade bug sent currentIndex -1 pilots back to the Venture rung.
  assert.notEqual(ctx.rungIndexOfHull(ladder, RETRIEVER), -1);
  assert.equal(ctx.rungIndexOfHull(ladder, MACKINAW), 2);
  assert.equal(ctx.rungIndexOfHull(ladder, VENTURE), 0);
});

test("a hull outside the ladder stays off-ladder", () => {
  assert.equal(ctx.rungIndexOfHull(ladder, CAPSULE), -1);
  assert.equal(ctx.rungIndexOfHull(ladder, 0), -1);
});

test("the hull choice is stable per pilot", () => {
  const rung = ladder[1];
  for (const characterID of [140000011, 140000777, 140001234]) {
    const first = ctx.rungHullForPilot({ characterID }, rung);
    const second = ctx.rungHullForPilot({ characterID }, rung);
    assert.equal(first, second);
    assert.ok(rung.hullChoices.includes(first));
  }
});

test("the fleet spreads across the offered hulls", () => {
  const rung = ladder[1];
  const seen = new Set();
  for (let characterID = 140000001; characterID <= 140000030; characterID += 1) {
    seen.add(ctx.rungHullForPilot({ characterID }, rung));
  }
  assert.equal(seen.size, rung.hullChoices.length);
});

test("a single-hull rung keeps its hull", () => {
  assert.equal(ctx.rungHullForPilot({ characterID: 140000011 }, ladder[2]), MACKINAW);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const results = [];
const SOURCE = fs.readFileSync(
  path.join(__dirname, "../integration/server/server/src/services/playerbots/playerBotThreatResponseRuntime.js"),
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

function build(names, context = {}) {
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

const ctx = build(["miningNpcRetreat"]);

test("a mining pilot under NPC fire retreats", () => {
  const decision = ctx.miningNpcRetreat({ kind: "mine", status: "active" });
  assert.deepEqual(JSON.parse(JSON.stringify(decision)), { action: "retreat" });
});

test("a holding mining operation retreats too", () => {
  assert.ok(ctx.miningNpcRetreat({ kind: "mine", status: "holding" }));
});

test("a finished mining operation is left alone", () => {
  assert.equal(ctx.miningNpcRetreat({ kind: "mine", status: "completed" }), null);
});

test("non-mining operations keep their own combat path", () => {
  assert.equal(ctx.miningNpcRetreat({ kind: "combat", status: "active" }), null);
  assert.equal(ctx.miningNpcRetreat({ kind: "industry", status: "active" }), null);
  assert.equal(ctx.miningNpcRetreat(null), null);
});

console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.passed) ? 0 : 1);

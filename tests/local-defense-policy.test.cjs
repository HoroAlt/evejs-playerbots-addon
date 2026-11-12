"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const base = path.resolve(
  __dirname,
  "../integration/server/server/src/services/playerbots",
);
const policy = require(path.join(base, "playerBotDefensePolicy"));
const config = require(path.join(base, "playerBotLocalDefenseConfig"));
const old = require(path.join(base, "playerBotCombatDecisionRuntime"));
const input = {
  role: "combat",
  legal: true,
  validated: true,
  hasOutput: true,
  ownEffectiveHP: 10000,
  targetEffectiveHP: 11000,
  state: {
    inSpace: true,
    isCapsule: false,
    shield: 0.7,
    armorDamage: 0.02,
    hullDamage: 0,
    capacitorRatio: 0.5,
    warpScrambleStatus: 0,
  },
  fit: {
    ready: true,
    ammunitionReady: true,
    droneCapacityReady: true,
    capacitorUsePerSecond: 0,
  },
};
const cases = [];
function test(name, fn) {
  fn();
  cases.push({ name, passed: true });
}
const decide = (patch = {}, memory = {}, now = 1000) =>
  policy.decide(
    { ...input, ...patch, state: { ...input.state, ...patch.state } },
    memory,
    now,
  );
test("matched opponent, light armor damage: new engage; old evade", () => {
  assert.equal(decide().action, "engage");
  assert.equal(
    old.decideDefensiveResponse({
      eligible: true,
      roleFitReady: true,
      ...input,
      ownMass: 10,
      targetMass: 10,
    }).action,
    "evade",
  );
});
test("noncombat, illegal, no output, invalid fit, missing ammunition fail closed", () => {
  for (const patch of [
    { role: "miner" },
    { legal: false },
    { hasOutput: false },
    { validated: false },
    { fit: { ammunitionReady: false } },
  ])
    assert.equal(decide(patch).action, "evade");
});
test("critical structure and armor bypass waiting", () => {
  for (const state of [{ hullDamage: 0.2 }, { armorDamage: 0.5 }])
    assert.equal(
      decide({
        state,
        reinforcementAccepted: true,
        acceptedEtaMs: 1000,
        survivalMs: 60000,
      }).reason,
      "critical-structural-damage",
    );
});
test("low-shield debounce and reengagement hysteresis", () => {
  const a = decide({ state: { shield: 0.34 }, alreadyEngaged: true }, {}, 1000);
  assert.equal(a.action, "engage");
  const b = decide(
    { state: { shield: 0.34 }, alreadyEngaged: true },
    a.memory,
    3999,
  );
  assert.equal(b.action, "engage");
  const c = decide(
    { state: { shield: 0.34 }, alreadyEngaged: true },
    b.memory,
    4000,
  );
  assert.equal(c.action, "evade");
  assert.equal(
    decide({ state: { shield: 0.64 } }, c.memory, 5000).reason,
    "reengagement-hysteresis",
  );
  assert.equal(
    decide({ state: { shield: 0.65 } }, c.memory, 5000).action,
    "engage",
  );
});
test("shield recovery clears debounce before three seconds", () => {
  const a = decide({ state: { shield: 0.34 }, alreadyEngaged: true });
  const b = decide(
    { state: { shield: 0.36 }, alreadyEngaged: true },
    a.memory,
    4000,
  );
  assert.equal(b.action, "engage");
  assert.equal(b.memory.lowSince, undefined);
});
test("scrambled critical ship requests tackle clearance, not healthy engagement", () => {
  const d = decide({
    state: { shield: 0.19, warpScrambleStatus: 2 },
    alreadyEngaged: true,
  });
  assert.equal(d.action, "clear-tackle");
  assert.equal(d.safe, false);
});
test("passive drone ship does not require arbitrary 60 percent capacitor", () => {
  assert.equal(decide({ state: { capacitorRatio: 0.01 } }).action, "engage");
  assert.equal(
    decide({
      state: { capacitorRatio: 0.01 },
      fit: { capacitorUsePerSecond: 10 },
    }).action,
    "evade",
  );
});
test("partial drone loss reduces evaluated strength rather than categorical retreat", () => {
  assert.equal(decide({ ownEffectiveHP: 8000 }).action, "engage");
  assert.equal(decide({ ownEffectiveHP: 2000 }).action, "evade");
});
test("accepted en-route reinforcements add no on-grid strength", () => {
  assert.equal(
    decide({ targetEffectiveHP: 20000, reinforcementAccepted: true }).action,
    "evade",
  );
  assert.equal(
    decide({ targetEffectiveHP: 20000, onGridEffectiveHP: 5000 }).action,
    "engage",
  );
});
test("credible ETA and survival permit at most fifteen seconds waiting", () => {
  const patch = {
    targetEffectiveHP: 20000,
    reinforcementAccepted: true,
    acceptedEtaMs: 8000,
    survivalMs: 20000,
  };
  const first = decide(patch, {}, 1000);
  assert.equal(first.reason, "bounded-wait-for-credible-help");
  assert.equal(decide(patch, first.memory, 15999).action, "engage");
  assert.equal(decide(patch, first.memory, 16000).action, "evade");
  for (const eta of [null, undefined, NaN, Infinity, 16000, -1])
    assert.equal(decide({ ...patch, acceptedEtaMs: eta }).action, "evade");
  assert.equal(decide({ ...patch, survivalMs: 10000 }).action, "evade");
});
test("unknown opponent allows limited healthy ongoing defense, no new aggressive entry", () => {
  assert.equal(decide({ targetEffectiveHP: NaN }).action, "evade");
  assert.equal(
    decide({ targetEffectiveHP: NaN, alreadyEngaged: true }).action,
    "engage",
  );
});
test("configuration defaults off; malformed thresholds rejected", () => {
  assert.equal(config.validate({}).enabled, false);
  for (const policyValue of [
    { entryShield: 0.2 },
    { helpWaitMs: 16000 },
    { strengthRatio: 5 },
    { unknown: 1 },
    { criticalShield: NaN },
  ])
    assert.throws(() => config.validate({ policy: policyValue }));
  assert.equal(
    config.validate({ policy: { entryShield: 0.62 } }).policy.entryShield,
    0.62,
  );
});
const out = path.resolve(__dirname, "../test-output/P4");
ignoreReportDirectory(out, { recursive: true });
printReport(
  path.join(out, "policy-tests.json"),
  JSON.stringify(
    { passed: cases.length, cases, liveEngineTest: false },
    null,
    2,
  ),
);
console.log(JSON.stringify({ passed: cases.length }));

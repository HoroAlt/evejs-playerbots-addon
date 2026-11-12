"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
const {
  estimateArrival,
} = require("../integration/server/server/src/services/playerbots/playerBotRescueArrival");
const ball = {
  mode: "WARP",
  effectStamp: 0,
  warpFactor: 3000,
  warpDistance: 4000000,
  maxVelocity: 200,
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 1000, y: 0, z: 0 },
  targetPoint: { x: 4000000, y: 0, z: 0 },
};
const scene = { _destinyPark: { currentTime: 11 }, getTimeDilation: () => 1 },
  destination = { ...ball.targetPoint };
const original = JSON.stringify(ball),
  estimate = estimateArrival(ball, scene, destination);
assert.ok(estimate && estimate.etaMs > 0 && estimate.etaMs <= 15000);
assert.equal(
  JSON.stringify(ball),
  original,
  "forecast must not mutate a real Ball",
);
assert.equal(
  estimateArrival({ ...ball, effectStamp: -1 }, scene, destination),
  null,
  "alignment must remain unknown",
);
assert.equal(
  estimateArrival(ball, { ...scene, getTimeDilation: () => 0.1 }, destination),
  null,
  "slow dilation must not fabricate a short arrival",
);
assert.equal(
  estimateArrival(ball, scene, { x: 9000000, y: 0, z: 0 }),
  null,
  "changed destination invalidates forecast",
);
assert.equal(
  estimateArrival({ ...ball, warpDistance: NaN }, scene, destination),
  null,
);
assert.equal(estimateArrival(ball, {}, destination), null);
const out = path.resolve(__dirname, "../test-output/P4");
ignoreReportDirectory(out, { recursive: true });
printReport(
  path.join(out, "arrival-boundaries.json"),
  JSON.stringify(
    { passed: true, estimate, cases: 7, liveEngineTimingVerified: false },
    null,
    2,
  ),
);
console.log(
  "PASS seven forecast boundaries; native timing test still required",
);

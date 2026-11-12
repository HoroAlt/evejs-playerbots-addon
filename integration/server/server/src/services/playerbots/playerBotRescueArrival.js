"use strict";
const {
  warpDistance,
  isWarping,
} = require("../../space/destiny/simulation/evolve");
const finitePoint = (p) => p && [p.x, p.y, p.z].every(Number.isFinite);
// A deliberately narrow forecast: only a warp that has already entered flight,
// using Destiny's own curve. Alignment, inter-system routing and subwarp
// approaches remain unknown. This is arrival, not a promise of effective DPS.
function estimateArrival(
  entity,
  scene,
  destination,
  maxLandingDistance = 10000,
) {
  const park = scene?._destinyPark,
    stamp = Number(park?.currentTime),
    dilation = scene?.getTimeDilation?.();
  if (
    !isWarping(entity) ||
    !Number.isFinite(stamp) ||
    !Number.isFinite(dilation) ||
    dilation <= 0 ||
    dilation > 1 ||
    !finitePoint(entity.position) ||
    !finitePoint(entity.velocity) ||
    !finitePoint(entity.targetPoint) ||
    !finitePoint(destination) ||
    !(entity.warpDistance > 0) ||
    !(entity.warpFactor > 0) ||
    !Number.isFinite(entity.effectStamp) ||
    Math.hypot(
      entity.targetPoint.x - destination.x,
      entity.targetPoint.y - destination.y,
      entity.targetPoint.z - destination.z,
    ) > maxLandingDistance
  )
    return null;
  const elapsed = stamp - entity.effectStamp;
  if (elapsed < 0) return null;
  for (let ticks = 1; ticks <= 12; ticks++) {
    const result = warpDistance(
      entity,
      entity.position,
      entity.velocity,
      elapsed + ticks,
    );
    if (result.overrun) return null;
    if (result.dropped) {
      const etaMs = Math.ceil((ticks * 1000) / dilation) + 3000; // tick scheduling / landing margin
      return etaMs <= 15000
        ? { etaMs, basis: "native-in-flight-warp", predictedDropTicks: ticks }
        : null;
    }
  }
  return null;
}
module.exports = { estimateArrival };

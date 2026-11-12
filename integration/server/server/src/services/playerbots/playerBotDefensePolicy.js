"use strict";
const defaults = Object.freeze({
  entryShield: 0.6,
  retreatShield: 0.35,
  criticalShield: 0.2,
  reengageShield: 0.65,
  hullDamageLimit: 0.2,
  armorDamageLimit: 0.5,
  activeCapFloor: 0.15,
  lowShieldMs: 3000,
  strengthRatio: 1.6,
  helpWaitMs: 15000,
});
function parameters(value = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !Object.hasOwn(defaults, k))
  )
    throw new Error("INVALID_DEFENSE_POLICY");
  const p = { ...defaults, ...value };
  for (const k of [
    "entryShield",
    "retreatShield",
    "criticalShield",
    "reengageShield",
    "hullDamageLimit",
    "armorDamageLimit",
    "activeCapFloor",
  ])
    if (!Number.isFinite(p[k]) || p[k] <= 0 || p[k] >= 1)
      throw new Error("INVALID_DEFENSE_THRESHOLD");
  if (
    !(
      p.criticalShield < p.retreatShield &&
      p.retreatShield < p.entryShield &&
      p.entryShield <= p.reengageShield
    ) ||
    !Number.isInteger(p.lowShieldMs) ||
    p.lowShieldMs < 0 ||
    p.lowShieldMs > 5000 ||
    !Number.isInteger(p.helpWaitMs) ||
    p.helpWaitMs < 0 ||
    p.helpWaitMs > 15000 ||
    !Number.isFinite(p.strengthRatio) ||
    p.strengthRatio < 1 ||
    p.strengthRatio > 2
  )
    throw new Error("UNSAFE_DEFENSE_THRESHOLDS");
  return p;
}
// Pure, role-sensitive decisions; caller persists memory and supplies observed,
// on-grid support only. En-route ships never add to available combat power.
function decide(input, previous = {}, now = Date.now()) {
  const p = parameters(input.parameters);
  const state = input.state || {},
    fit = input.fit || {};
  const memory = { ...previous };
  const answer = (action, reason) => ({
    action,
    reason,
    safe: action === "engage",
    memory,
  });
  if (!input.legal) return answer("evade", "target-not-legally-engageable");
  if (input.unknownAdditionalThreat)
    return answer("evade", "unmeasured-hostile-reinforcement");
  if (!state.inSpace || state.isCapsule)
    return answer("evade", "ship-unavailable");
  if (input.role !== "combat")
    return answer("evade", "noncombat-preserve-hull");
  if (
    !input.validated ||
    !input.hasOutput ||
    fit.ammunitionReady === false ||
    fit.droneCapacityReady === false
  )
    return answer("evade", "no-validated-effective-output");
  if (
    state.hullDamage >= p.hullDamageLimit ||
    state.armorDamage >= p.armorDamageLimit
  )
    return answer("evade", "critical-structural-damage");
  const shield = Number(state.shield),
    cap = Number(state.capacitorRatio);
  if (!Number.isFinite(shield)) return answer("evade", "unknown-own-reserves");
  if (shield < p.criticalShield)
    return answer(
      state.warpScrambleStatus > 0 ? "clear-tackle" : "evade",
      "critical-shield",
    );
  if (
    fit.capacitorUsePerSecond > 0 &&
    (!Number.isFinite(cap) || cap < p.activeCapFloor)
  )
    return answer("evade", "active-fit-capacitor-critical");
  if (shield < p.retreatShield) memory.lowSince ??= now;
  else delete memory.lowSince;
  if (memory.lowSince !== undefined && now - memory.lowSince >= p.lowShieldMs) {
    memory.withdrawing = true;
    return answer(
      state.warpScrambleStatus > 0 ? "clear-tackle" : "evade",
      "sustained-low-shield",
    );
  }
  if (memory.withdrawing) {
    if (shield < p.reengageShield)
      return answer("evade", "reengagement-hysteresis");
    delete memory.withdrawing;
  }
  if (!input.alreadyEngaged && shield < p.entryShield)
    return answer("evade", "entry-reserve-low");
  const own = Number(input.ownEffectiveHP),
    enemy = Number(input.targetEffectiveHP);
  const presentSupport = Math.max(0, Number(input.onGridEffectiveHP) || 0);
  if (
    own > 0 &&
    enemy > 0 &&
    enemy > (own + presentSupport) * p.strengthRatio
  ) {
    const eta = Number(input.acceptedEtaMs),
      survival = Number(input.survivalMs);
    if (
      input.reinforcementAccepted === true &&
      input.acceptedEtaMs !== null &&
      input.acceptedEtaMs !== undefined &&
      Number.isFinite(eta) &&
      eta >= 0 &&
      eta <= p.helpWaitMs &&
      survival > eta + 3000
    ) {
      memory.helpWaitSince ??= now;
      if (now - memory.helpWaitSince < p.helpWaitMs)
        return answer("engage", "bounded-wait-for-credible-help");
    }
    memory.withdrawing = true;
    return answer(
      state.warpScrambleStatus > 0 ? "clear-tackle" : "evade",
      "observed-strength-disadvantage",
    );
  }
  delete memory.helpWaitSince;
  if (!(own > 0 && enemy > 0))
    return answer(
      input.alreadyEngaged && shield >= 0.65 ? "engage" : "evade",
      "opponent-strength-uncertain",
    );
  return answer(
    "engage",
    presentSupport > 0 ? "on-grid-support" : "combat-reserves-sufficient",
  );
}
module.exports = { decide, parameters };

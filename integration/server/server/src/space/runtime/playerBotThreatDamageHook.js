"use strict";

function dispatchPlayerBotThreatResponse(scene, attackerEntity, targetEntity, damageResult, whenMs, dependencies = {}) {
  if (!targetEntity || String(targetEntity.kind || "").toLowerCase() !== "ship" ||
      damageResult && damageResult.data && damageResult.data.destroyed === true) return false;
  const appliedDamage = typeof dependencies.getAppliedDamageAmount === "function"
    ? dependencies.getAppliedDamageAmount(damageResult)
    : require("./combatDamageMessages").getAppliedDamageAmount(damageResult);
  if (!(Number(appliedDamage) > 0)) return false;
  const targetSession = typeof dependencies.getOwningSessionForEntity === "function"
    ? dependencies.getOwningSessionForEntity(scene, targetEntity)
    : require("./entityOwnerSession").getOwningSessionForEntity(scene, targetEntity);
  if (!targetSession || targetSession._playerBotActor !== true) return false;
  const runtime = typeof dependencies.getThreatResponseRuntime === "function"
    ? dependencies.getThreatResponseRuntime()
    : require("../../services/playerbots/playerBotThreatResponseRuntime");
  runtime.noteIncomingDamage(scene, attackerEntity, targetEntity, targetSession, damageResult, whenMs);
  return true;
}

module.exports = { dispatchPlayerBotThreatResponse };

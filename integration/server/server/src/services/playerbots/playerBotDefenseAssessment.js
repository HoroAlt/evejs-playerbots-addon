"use strict";

// Shared adapter for current defensive combat and rescue. Persistent decision
// memory is separate from operation snapshots, like the interruption mailbox.
const policy = require("./playerBotDefensePolicy");
const config = require("./playerBotLocalDefenseConfig");
function enabled(systemID) {
  const settings = config.get();
  return (
    settings.enabled &&
    settings.aggressive &&
    settings.systemIDs.includes(Number(systemID))
  );
}
function assess(bot, target, scene, operation, legal, options = {}) {
  if (!enabled(scene.systemID)) return null;
  const space = require("./playerBotSpaceRuntime"),
    combat = require("./playerBotCombatRuntime");
  const { entity } = space.getActorSpace(bot),
    state = space.getSpaceState(bot);
  const drones = combat.getControlledDrones(scene, entity.itemID);
  const fitResult =
    require("./playerBotCombatFitRuntime").buildCombatFitSnapshot(bot, entity, {
      ...state,
      deployedDrones: drones,
    });
  const fit = fitResult.fit || {},
    operations = require("./playerBotOperationRuntime");
  const role =
    operation?.kind === "combat"
      ? operation.mode === "piracy"
        ? "piracy"
        : "security"
      : bot.specialty;
  const ownHP = combat.estimateEffectiveHitPoints(entity.typeID, entity, fit);
  const repo = require("../../gameStore/tableRepository").createTableRepository(
    "service:playerbots",
    { strict: true },
  );
  const key = `/_localDefenseDecision_${bot.characterID}`;
  const stored = repo.read("playerBots", key).data || {};
  const fitSignature = JSON.stringify(
    (fit.modules || [])
      .map((m) => [Number(m.itemID), Number(m.typeID)])
      .sort((a, b) => a[0] - b[0]),
  );
  const fullRoleFit =
    ["security", "piracy"].includes(role) &&
    operations.hasRoleShipFit(bot, role);
  const priorValidation =
    stored.shipID === Number(entity.itemID) &&
    stored.fitSignature === fitSignature &&
    stored.validated === true;
  const roleFit =
    fullRoleFit ||
    (priorValidation &&
      operations.hasRoleShipFit(bot, role, { allowPartialDrones: true }));
  const profile = roleFit ? operations.getRoleShipFitProfile(bot, role) : null;
  const nominalDrones = profile?.droneTypeIDs?.length || 5;
  const outputFraction = Math.min(
    1,
    Math.max(0, Number(fit.totalDrones) || 0) / nominalDrones,
  );
  const now = Date.now(),
    identity = `${entity.itemID}:${target?.itemID || 0}`;
  let memory =
    stored.identity === identity
      ? stored.memory || {}
      : stored.shipID === Number(entity.itemID)
        ? {
            withdrawing: stored.memory?.withdrawing,
            observation: stored.memory?.observation,
            lossRate: stored.memory?.lossRate,
          }
        : {};
  const previous = memory.observation;
  // Do not turn a missing sample into an invented survival estimate.
  let lossRate = Number(memory.lossRate) || 0;
  if (previous && now - previous.at >= 1000 && now - previous.at <= 10000) {
    lossRate = Math.max(
      lossRate * 0.8,
      (Math.max(0, previous.hp - ownHP) * 1000) / (now - previous.at),
    );
  }
  const support = require("./playerBotLocalDefenseAdapter").supportFor(
    bot,
    target,
    scene,
  );
  const decision = policy.decide(
    {
      role: roleFit ? "combat" : "noncombat",
      legal,
      state,
      fit,
      parameters: config.get().policy,
      validated: fitResult.success && roleFit && fit.ready,
      hasOutput: outputFraction > 0,
      alreadyEngaged:
        options.alreadyEngaged ??
        Boolean(
          operation?.defensiveTargetID ||
            drones.some((d) => Number(d.targetID) === Number(target?.itemID)),
        ),
      ownEffectiveHP: ownHP * outputFraction,
      targetEffectiveHP: target
        ? combat.estimateEffectiveHitPoints(target.typeID, target) +
          (support.additionalEnemyEffectiveHP || 0)
        : NaN,
      ...support,
      survivalMs: lossRate > 0 ? (ownHP / lossRate) * 1000 : null,
    },
    memory,
    now,
  );
  decision.memory = {
    ...decision.memory,
    observation:
      !previous || now - previous.at >= 1000
        ? { at: now, hp: ownHP }
        : previous,
    lossRate,
  };
  const next = {
    identity,
    shipID: Number(entity.itemID),
    fitSignature,
    validated: Boolean(fullRoleFit || (priorValidation && roleFit)),
    memory: decision.memory,
    action: decision.action,
    reason: decision.reason,
  };
  if (JSON.stringify(stored) !== JSON.stringify(next)) {
    repo.ensureTable("playerBots");
    if (
      !repo.write("playerBots", key, next).success ||
      !repo.flushTableSync("playerBots")?.success
    )
      throw new Error("DEFENSE_DECISION_PERSIST_FAILED");
  }
  return decision;
}
module.exports = { enabled, assess };

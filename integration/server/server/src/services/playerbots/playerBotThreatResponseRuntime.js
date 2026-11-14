"use strict";

// Playerbot threat response is event-driven: the authoritative damage path
// dispatches here after a real hit, then durable operation jobs are woken
// immediately so combat, escort, or evacuation does not wait for the ordinary
// autonomy poll window.

// Damage ticks can arrive every Destiny frame. The first hit wakes an
// immediate response; subsequent hits from the same attacker do not need to
// cancel and recreate the pilot's durable scheduler job every second.
const RESPONSE_COOLDOWN_MS = 5_000;
const WAKE_COOLDOWN_MS = 10_000;
const pendingByCharacter = new Map();
const scheduledCharacterIDs = new Set();
const lastResponseByKey = new Map();
const lastWakeByCharacter = new Map();

function positiveID(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function characterIDForEntity(entity) {
  return positiveID(entity && entity.session && (
    entity.session.characterID || entity.session.charID || entity.session.charid
  ) || entity && (entity.pilotCharacterID || entity.characterID || entity.ownerCharacterID));
}

function resolveAttacker(scene, attackerEntity) {
  if (!attackerEntity) return null;
  if (String(attackerEntity.kind || "").toLowerCase() === "ship") return attackerEntity;
  const controllerID = positiveID(attackerEntity.controllerID || attackerEntity.controllerShipID ||
    attackerEntity.ownerShipID || attackerEntity.droneControllerID);
  return controllerID && scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(controllerID) || attackerEntity
    : attackerEntity;
}

function wake(characterID) {
  const id = positiveID(characterID);
  if (!id) return false;
  const now = Date.now();
  const lastWake = Number(lastWakeByCharacter.get(id)) || 0;
  if (now - lastWake < WAKE_COOLDOWN_MS) return false;
  lastWakeByCharacter.set(id, now);
  if (lastWakeByCharacter.size > 4_096) {
    for (const [character, at] of lastWakeByCharacter) {
      if (now - Number(at) > WAKE_COOLDOWN_MS * 4) lastWakeByCharacter.delete(character);
    }
  }
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(id, { immediate: true }).catch((error) => {
    if (lastWakeByCharacter.get(id) === now) lastWakeByCharacter.delete(id);
    require("../../utils/logger").warn(`[PlayerBots] Could not wake incoming-threat response char=${id}: ${error.message}`);
  });
  return true;
}

const NPC_ASSESSMENT_REUSE_MS = 3_000;
const lastNpcAssessmentByCharacter = new Map();

// A mining ship never trades fire with a belt rat: the first NPC hit stops the
// lasers and sends it to the nearest station. An escort still engages below.
function miningNpcRetreat(operation) {
  if (!operation || operation.kind !== "mine") return null;
  if (!["active", "holding", "review"].includes(String(operation.status || ""))) return null;
  return { action: "retreat" };
}

async function handleIncomingThreat(payload, dependencies = {}) {
  const playerBots = dependencies.playerBots || require("./playerBotRuntime");
  const operationRuntime = dependencies.operationRuntime || require("./playerBotOperationRuntime");
  const combatRuntime = dependencies.combatRuntime || require("./playerBotCombatRuntime");
  const miningEscortRuntime = dependencies.miningEscortRuntime || require("./playerBotMiningEscortRuntime");
  const space = dependencies.space || require("./playerBotSpaceRuntime");
  const logger = dependencies.logger || require("../../utils/logger");
  const bot = playerBots.getBotByCharacterID(payload.characterID);
  if (!bot || bot.status === "paused" || bot.autonomyPaused === true) {
    return { handled: false, reason: "bot-unavailable-or-paused" };
  }
  const attacker = resolveAttacker(payload.scene, payload.attackerEntity);
  const attackerEntityID = positiveID(attacker && attacker.itemID);
  if (!attackerEntityID) return { handled: false, reason: "attacker-entity-unavailable" };
  let operation = operationRuntime.getOperation(bot.characterID);
  const pirateNPC = require("./playerBotCombatPolicy").isPirateNpc(attacker);
  const localSettings = require("./playerBotLocalDefenseConfig").get();
  if (localSettings.enabled && localSettings.systemIDs.includes(Number(payload.scene?.systemID))) {
    if (require("./playerBotLocalDefenseAdapter").hasLease(bot.characterID)) {
      wake(bot.characterID);
      return {handled:true,action:"rescue-owner-reassess",attackerEntityID};
    }
    if (operation?.kind === "mine" && localSettings.miningRescue !== false) {
      operationRuntime.setMiningIncomingThreat(bot.characterID,attackerEntityID,{action:"retreat",
        attackerCharacterID:characterIDForEntity(attacker)||null,receivedAtMs:Number(payload.whenMs)||Date.now()});
      return {handled:true,action:"local-rescue-miner-evacuation",attackerEntityID};
    }
    // Non-combat operations have no rat-combat state machine. Merely waking a
    // PI/courier/industrial job leaves it executing business work under fire.
    // Queue the durable intent; an in-flight economic commit keeps ownership
    // until its safe handoff instead of being cancelled or replayed.
    if (localSettings.generalRescue !== false && operation &&
        operation.kind !== "combat" && operation.kind !== "mine" && ["active", "holding"].includes(operation.status)) {
      operationRuntime.requestThreatRetreat(bot.characterID, attackerEntityID,
        "non-combat operation under local attack");
      return {handled:true,action:"local-rescue-noncombat-evacuation",attackerEntityID};
    }
  }

  // Existing PvE and mining-escort logic owns NPC rat combat. Wake both sides
  // of the mining group so a rat cannot sit on grid for a full poll interval.
  if (pirateNPC) {
    wake(bot.characterID);
    // Every hit from the same rat arrives here. One assessment per pilot and
    // attacker every few seconds decides the same thing as one per hit.
    const assessedAtMs = typeof dependencies.now === "function" ? dependencies.now() : Date.now();
    const previous = lastNpcAssessmentByCharacter.get(bot.characterID);
    // Local adaptive defense updates survival and withdrawal decisions from
    // live damage. Reusing an earlier decision would suppress that update.
    // Preserve upstream duplicate reuse outside the configured local policy.
    const adaptiveDefense = localSettings.enabled && localSettings.aggressive === true &&
      localSettings.systemIDs.includes(Number(payload.scene?.systemID));
    if (!adaptiveDefense && previous && previous.attackerEntityID === attackerEntityID &&
        assessedAtMs - previous.atMs < NPC_ASSESSMENT_REUSE_MS && assessedAtMs >= previous.atMs) {
      return { handled: true, action: "wake-pve-response", attackerEntityID, reused: true };
    }
    lastNpcAssessmentByCharacter.set(bot.characterID, { attackerEntityID, atMs: assessedAtMs });
    if (operation && operation.kind === "combat" && ["active", "holding"].includes(operation.status)) {
      const decision = combatRuntime.assessDefensiveResponse(bot, attacker, payload.scene, operation);
      if (decision.action === "engage") {
        operationRuntime.setDefensiveCombatTarget(bot.characterID, attackerEntityID, decision.reason);
      } else {
        operationRuntime.requestThreatRetreat(bot.characterID, attackerEntityID, decision.reason);
      }
    } else if (miningNpcRetreat(operation)) {
      // Leave on the first NPC hit, before any damage is traded, whether or not
      // an escort is available. An escort still engages, but the miner goes.
      operationRuntime.setMiningIncomingThreat(bot.characterID, attackerEntityID, {
        action: "retreat",
        attackerName: String((attacker && (attacker.itemName || attacker.name)) || "").slice(0, 80),
        receivedAtMs: Number(payload.whenMs) || Date.now(),
      });
      if (Number(operation.escortCharacterID) > 0) {
        const escortID = Number(operation.escortCharacterID);
        const escortBot = playerBots.getBotByCharacterID(escortID);
        const escortOperation = operationRuntime.getOperation(escortID);
        if (escortBot && escortOperation && escortOperation.kind === "combat" &&
            ["active", "holding"].includes(escortOperation.status)) {
          const decision = combatRuntime.assessDefensiveResponse(escortBot, attacker, payload.scene, escortOperation);
          if (decision.action === "engage") {
            operationRuntime.setDefensiveCombatTarget(escortID, attackerEntityID,
              `protecting miner ${bot.characterName}`);
          }
        }
        wake(escortID);
      }
    }
    return { handled: true, action: "wake-pve-response", attackerEntityID };
  }

  if (!attacker.session || String(attacker.kind || "").toLowerCase() !== "ship") {
    wake(bot.characterID);
    return { handled: true, action: "wake-current-operation", attackerEntityID };
  }
  const attackerCharacterID = characterIDForEntity(attacker);
  const details = {
    attackerCharacterID: attackerCharacterID || null,
    attackerName: String(attacker.session.characterName || attacker.characterName || attacker.itemName || "").slice(0, 80),
    receivedAtMs: Number(payload.whenMs) || Date.now(),
  };

  if (operation && operation.kind === "mine") {
    const escortID = positiveID(operation.escortCharacterID);
    const escortBot = escortID && playerBots.getBotByCharacterID(escortID);
    const escortOperation = escortID && operationRuntime.getOperation(escortID);
    let escortDecision = null;
    if (escortBot && escortOperation && escortOperation.kind === "combat" &&
        ["active", "holding"].includes(escortOperation.status) &&
        String(escortOperation.miningEscortGroupKey || "") === String(operation.miningEscortGroupKey || "")) {
      escortDecision = combatRuntime.assessDefensiveResponse(escortBot, attacker, payload.scene, escortOperation);
    }
    if (escortDecision && escortDecision.action === "engage") {
      operationRuntime.setDefensiveCombatTarget(escortID, attackerEntityID,
        `protecting miner ${bot.characterName}`);
      operationRuntime.setMiningIncomingThreat(bot.characterID, attackerEntityID, {
        ...details,
        action: "escort",
        escortCharacterID: escortID,
      });
      return { handled: true, action: "escort-engage", attackerEntityID, escortCharacterID: escortID };
    }
    operationRuntime.setMiningIncomingThreat(bot.characterID, attackerEntityID, {
      ...details,
      action: "retreat",
      escortCharacterID: escortID || null,
    });
    return { handled: true, action: "miner-retreat", attackerEntityID, escortCharacterID: escortID || null,
      reason: escortDecision && escortDecision.reason || "no-qualified-escort" };
  }

  if (operation && operation.kind === "combat" && ["active", "holding"].includes(operation.status)) {
    const decision = combatRuntime.assessDefensiveResponse(bot, attacker, payload.scene, operation);
    if (decision.action === "engage") {
      operationRuntime.setDefensiveCombatTarget(bot.characterID, attackerEntityID, decision.reason);
      return { handled: true, action: "combat-engage", attackerEntityID, reason: decision.reason };
    }
    operationRuntime.requestThreatRetreat(bot.characterID, attackerEntityID, decision.reason);
    return { handled: true, action: "combat-evade", attackerEntityID, reason: decision.reason };
  }

  if (!operation || !["active", "holding"].includes(operation.status)) {
    const decision = combatRuntime.assessDefensiveResponse(bot, attacker, payload.scene, null);
    if (decision.action === "engage") {
      const started = operationRuntime.startCombat(bot.characterName, bot.specialty, {
        autonomous: true,
        defensiveTargetID: attackerEntityID,
      });
      if (started.success) {
        wake(bot.characterID);
        return { handled: true, action: "combat-started", attackerEntityID, reason: decision.reason };
      }
      logger.warn(`[PlayerBots] Could not start immediate defense char=${bot.characterID} target=${attackerEntityID}: ${started.message}`);
    }
    operationRuntime.requestThreatRetreat(bot.characterID, attackerEntityID,
      decision.reason || "no validated combat fit is available");
    return { handled: true, action: "evacuate", attackerEntityID,
      reason: decision.reason || "no-validated-combat-fit" };
  }

  // Industry, courier, fleet-follow and logistics pilots keep their durable
  // transaction record, but abandon navigation and dock before resuming it.
  operationRuntime.requestThreatRetreat(bot.characterID, attackerEntityID,
    "the active ship and operation are not validated for this fight");
  return { handled: true, action: "evacuate", attackerEntityID };
}

function scheduleThreatResponse(payload) {
  const characterID = positiveID(payload && payload.characterID);
  if (!characterID) return false;
  pendingByCharacter.set(characterID, payload);
  if (scheduledCharacterIDs.has(characterID)) return true;
  scheduledCharacterIDs.add(characterID);
  setImmediate(async () => {
    scheduledCharacterIDs.delete(characterID);
    const latest = pendingByCharacter.get(characterID);
    pendingByCharacter.delete(characterID);
    if (!latest) return;
    try {
      const result = await handleIncomingThreat(latest);
      if (result && result.handled && result.reused !== true) {
        require("../../utils/logger").info(
          `[PlayerBots] Threat response char=${characterID} attacker=${result.attackerEntityID || "unknown"} action=${result.action}${result.reason ? ` reason=${String(result.reason).slice(0, 120)}` : ""}.`,
        );
      }
    } catch (error) {
      require("../../utils/logger").warn(`[PlayerBots] Threat response failed char=${characterID}: ${error.message}`);
    }
  });
  return true;
}

function noteIncomingDamage(scene, attackerEntity, targetEntity, targetSession, damageResult, whenMs) {
  if (!targetSession || targetSession._playerBotActor !== true || !targetEntity ||
      String(targetEntity.kind || "").toLowerCase() !== "ship") return false;
  const characterID = positiveID(targetSession.characterID || targetSession.charID || targetSession.charid);
  const attacker = resolveAttacker(scene, attackerEntity);
  const attackerID = positiveID(attacker && attacker.itemID);
  const applied = Number(damageResult && damageResult.damageResult && damageResult.damageResult.data &&
    damageResult.damageResult.data.applied) || Number(damageResult && damageResult.applied) ||
    Number(damageResult && damageResult.data && damageResult.data.applied) || 0;
  // The caller already verifies accepted damage. Some layer-based damage
  // results publish their applied amount only through perLayer, so do not
  // discard them when the summarized field is absent.
  const amount = applied || (damageResult && damageResult.data && Array.isArray(damageResult.data.perLayer)
    ? damageResult.data.perLayer.reduce((sum, layer) => sum + Math.max(0, Number(layer && layer.appliedEffective) || 0), 0)
    : 1);
  if (!characterID || !attackerID || !(amount > 0)) return false;
  require("./playerBotLocalDefenseAdapter").reportThreat(scene, attacker, targetEntity, "damage");
  const key = `${characterID}:${attackerID}`;
  const now = Math.max(0, Number(whenMs) || Date.now());
  const last = Number(lastResponseByKey.get(key)) || 0;
  if (now - last < RESPONSE_COOLDOWN_MS) return true;
  lastResponseByKey.set(key, now);
  if (lastResponseByKey.size > 8_192) {
    for (const [entry, at] of lastResponseByKey) {
      if (now - Number(at) > RESPONSE_COOLDOWN_MS * 4) lastResponseByKey.delete(entry);
    }
  }
  return scheduleThreatResponse({ characterID, scene, attackerEntity, targetEntity, whenMs: now });
}

module.exports = {
  noteIncomingEwar(scene, attackerEntity, targetEntity, kind) {
    const localSettings = require("./playerBotLocalDefenseConfig").get();
    if (!localSettings.enabled || !localSettings.systemIDs.includes(Number(scene?.systemID))) return false;
    if (!["scram", "web", "neut"].includes(kind) || targetEntity?.session?._playerBotActor !== true) return false;
    const attacker = resolveAttacker(scene, attackerEntity);
    const characterID = characterIDForEntity(targetEntity), attackerID = positiveID(attacker?.itemID);
    if (!characterID || !attackerID) return false;
    require("./playerBotLocalDefenseAdapter").reportThreat(scene, attacker, targetEntity, kind);
    const key = `${characterID}:${attackerID}`, now = Date.now();
    if (now - Number(lastResponseByKey.get(key) || 0) < RESPONSE_COOLDOWN_MS) return true;
    lastResponseByKey.set(key, now);
    return scheduleThreatResponse({ characterID, scene, attackerEntity: attacker, targetEntity, whenMs: now });
  },
  RESPONSE_COOLDOWN_MS,
  handleIncomingThreat,
  noteIncomingDamage,
  _testing: { resolveAttacker, characterIDForEntity, miningNpcRetreat },
};

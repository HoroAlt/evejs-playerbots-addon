"use strict";

// Player-issued Fleet attack broadcasts. The human's most recently acquired
// lock is captured once, then every bot rechecks target identity, fleet
// membership, fit readiness and Crimewatch legality before engaging it.

const COMBAT_POLL_MS = 10_000;
const TARGET_MISSING_GRACE_MS = 30_000;
const WARP_RANGE_METERS = 150_000;

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function sessionCharacterID(session) {
  return positive(session && (session.characterID || session.charID || session.charid));
}

function systemIDForSession(session, character = {}) {
  return positive(session && (session.solarsystemid2 || session.solarsystemid || session.solarSystemID) ||
    character.solarSystemID || character.solarsystemid);
}

function isDocked(session, character = {}) {
  return positive(session && (session.stationID || session.stationid || session.structureID || session.structureid) ||
    character.stationID || character.structureID) > 0;
}

function resolveCommandTarget(session, spaceRuntime) {
  const scene = spaceRuntime.getSceneForSession(session);
  const ship = scene && scene.getShipEntityForSession(session);
  if (!scene || !ship || typeof scene.getTargetsForEntity !== "function") {
    return { error: "You must be in space with a locked target to issue a Fleet attack." };
  }
  const targets = scene.getTargetsForEntity(ship);
  const targetID = positive(Array.isArray(targets) && targets[targets.length - 1]);
  if (!targetID) return { error: "Lock a target first; the Fleet attack uses your most recently acquired lock." };
  const target = scene.getEntityByID(targetID);
  if (!target || String(target.kind || "").toLowerCase() !== "ship" || Number(target.typeID) === 670) {
    return { error: "The most recently locked target is not an attackable ship." };
  }
  return { scene, target, targetID, targetSystemID: positive(scene.systemID) || systemIDForSession(session) };
}

function listFleetBots(fleet, playerBots) {
  return playerBots.listBots().filter((bot) => fleet.members.has(positive(bot.characterID)));
}

function chooseFleetTargetRole(bot, hasRoleShipFit) {
  return ["security", "piracy"].find((role) => hasRoleShipFit(bot, role)) || "";
}

function stopFleetAttack(session, query, dependencies = {}) {
  const requesterID = sessionCharacterID(session);
  const fleetRuntime = dependencies.fleetRuntime || require("../fleets/fleetRuntime");
  const playerBots = dependencies.playerBots || require("./playerBotRuntime");
  const operationRuntime = dependencies.operationRuntime || require("./playerBotOperationRuntime");
  const fleet = fleetRuntime.getMemberFleetForCharacter(requesterID);
  if (!requesterID || !fleet || !fleet.members.has(requesterID)) {
    return { success: false, message: "Join a fleet before stopping Fleet attack orders." };
  }
  const allBots = playerBots.listBots();
  if (allBots.some((bot) => positive(bot.characterID) === requesterID)) {
    return { success: false, message: "A human fleet member must issue the attack command." };
  }
  const queryText = String(query || "").trim().replace(/^stop\s*/i, "").trim();
  const fleetBots = listFleetBots(fleet, playerBots);
  let selected = fleetBots;
  if (queryText && !/^all$/i.test(queryText)) {
    selected = fleetBots.filter((bot) => String(bot.characterName || "").trim().toLowerCase() === queryText.toLowerCase());
    if (selected.length !== 1) return { success: false, message: `No unique bot named "${queryText}" is in fleet ${fleet.fleetID}.` };
  }
  const stopped = [];
  for (const bot of selected) {
    const operation = operationRuntime.getOperation(bot.characterID);
    if (!operation || operation.kind !== "fleet-attack" ||
        !["active", "holding", "blocked", "review"].includes(operation.status) ||
        Number(operation.fleetID) !== Number(fleet.fleetID) ||
        Number(operation.requestedByCharacterID) !== requesterID) continue;
    const result = operationRuntime.requestFleetAttackStop(bot.characterName, requesterID, fleet.fleetID);
    if (result.success) stopped.push(bot.characterName);
  }
  return {
    success: true,
    message: stopped.length
      ? `Stopping ${stopped.length} Fleet attack order(s): ${stopped.join(", ")}. They are recalling drones and returning to their home station.`
      : "No Fleet attack orders from you were found for that selection.",
  };
}

function commandFleetAttack(session, query = "", dependencies = {}) {
  const requesterID = sessionCharacterID(session);
  const fleetRuntime = dependencies.fleetRuntime || require("../fleets/fleetRuntime");
  const playerBots = dependencies.playerBots || require("./playerBotRuntime");
  const sessionRegistry = dependencies.sessionRegistry || require("../chat/sessionRegistry");
  const spaceRuntime = dependencies.spaceRuntime || require("../../space/runtime");
  const combatRuntime = dependencies.combatRuntime || require("./playerBotCombatRuntime");
  const operationRuntime = dependencies.operationRuntime || require("./playerBotOperationRuntime");
  const hasRoleShipFit = dependencies.hasRoleShipFit || operationRuntime.hasRoleShipFit;
  const fleet = fleetRuntime.getMemberFleetForCharacter(requesterID);
  if (!requesterID || !fleet || !fleet.members.has(requesterID)) {
    return { success: false, message: "Join a fleet before issuing /attack." };
  }
  const allBots = playerBots.listBots();
  const botIDs = new Set(allBots.map((bot) => positive(bot.characterID)));
  if (botIDs.has(requesterID)) return { success: false, message: "A human fleet member must issue the attack command." };
  const humanIDs = [...fleet.members.keys()].map(positive).filter((id) => id && !botIDs.has(id));
  if (!humanIDs.length) return { success: false, message: "A human pilot must remain in the fleet to command playerbots." };

  const queryText = String(query || "").trim();
  if (/^stop(?:\s|$)/i.test(queryText)) return stopFleetAttack(session, queryText, dependencies);
  const fleetBots = listFleetBots(fleet, playerBots);
  let selected = fleetBots;
  if (queryText && !/^all$/i.test(queryText)) {
    selected = fleetBots.filter((bot) => String(bot.characterName || "").trim().toLowerCase() === queryText.toLowerCase());
    if (selected.length !== 1) {
      return { success: false, message: `No unique bot named "${queryText}" is in fleet ${fleet.fleetID}; use /attack all or an exact bot name.` };
    }
  }
  if (!selected.length) return { success: false, message: `There are no playerbots in fleet ${fleet.fleetID}.` };

  const commanderSession = sessionRegistry.findSessionByCharacterID(requesterID) || session;
  const captured = resolveCommandTarget(commanderSession, spaceRuntime);
  if (captured.error) return { success: false, message: captured.error };
  const combatPolicy = dependencies.combatPolicy || require("./playerBotCombatPolicy");
  const targetCharacterID = combatPolicy.isPirateNpc(captured.target)
    ? 0
    : positive(combatPolicy.resolveEntityCharacterID(captured.target));
  const results = [];
  const eligible = [];
  for (const bot of selected) {
    const authorization = combatRuntime.authorizeFleetAttackTarget(bot, captured.target, captured.scene);
    if (!authorization.success) {
      results.push({ success: false, message: `${bot.characterName}: ${authorization.message}` });
      continue;
    }
    const role = chooseFleetTargetRole(bot, hasRoleShipFit);
    if (!role) {
      results.push({ success: false, message: `${bot.characterName} has no complete, validated security or piracy combat fit.` });
      continue;
    }
    eligible.push({ bot, role, mode: authorization.mode });
  }
  if (!eligible.length) {
    return { success: false, message: `No selected fleet bot has both legal authorization and a complete combat fit. ${results.map((entry) => entry.message).slice(0, 3).join(" ")}` };
  }
  for (const { bot, role, mode } of eligible) {
    results.push(operationRuntime.startFleetAttack(bot.characterName, {
      targetID: captured.targetID,
      targetCharacterID,
      targetSystemID: captured.targetSystemID,
      targetTypeID: Number(captured.target.typeID) || 0,
      targetName: String(captured.target.itemName || captured.target.name || captured.targetID),
      mode,
      role,
      requesterCharacterID: requesterID,
      fleetID: Number(fleet.fleetID),
    }));
  }
  const accepted = results.filter((entry) => entry.success).length;
  const refused = results.filter((entry) => !entry.success);
  const targetName = String(captured.target.itemName || captured.target.name || captured.targetID);
  return {
    success: accepted > 0,
    message: refused.length
      ? `${accepted}/${eligible.length} selected bot(s) accepted the attack on ${targetName} (${captured.targetID}). ${refused.map((entry) => entry.message).slice(0, 3).join(" ")}`
      : `${accepted}/${eligible.length} selected bot(s) are attacking your latest locked target ${targetName} (${captured.targetID}).`,
  };
}

function beginRetreat(operation, bot, reason, kit, attached = null) {
  if (operation.stage !== "retreat" || !operation.stopReason) {
    operation.stopReason = String(reason || "The Fleet attack ended.").slice(0, 240);
    operation.stage = "retreat";
    kit.record(operation, `${operation.stopReason} Recalling drones and returning through normal navigation authority.`);
    kit.save(operation);
  }
  const actor = attached || (() => {
    try { return kit.space.getActorSpace(bot); } catch (_) { return null; }
  })();
  if (actor && actor.scene && actor.entity) {
    const drones = controlledCombatDrones(actor.scene, actor.entity.itemID, operation.requiredDroneTypes);
    if (drones.length) {
      try {
        kit.droneRuntime.commandReturnBay(actor.session, drones.map((drone) => Number(drone.itemID)));
      } catch (_) {
        // The durable retreat stage repeats the recall after transient failures.
      }
    }
  }
  return { delayMs: 5_000 };
}

function requiredDroneTypeIDs(operation) {
  return [...new Set((Array.isArray(operation.requiredDroneTypes) ? operation.requiredDroneTypes : [])
    .map(positive).filter(Boolean))];
}

function controlledCombatDrones(scene, shipID, requiredTypes) {
  const types = new Set((Array.isArray(requiredTypes) ? requiredTypes : []).map(positive).filter(Boolean));
  return [...(scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [])]
    .filter((entity) => entity && entity.kind === "drone" && Number(entity.controllerID) === Number(shipID) &&
      (!types.size || types.has(Number(entity.typeID))));
}

function launchCombatDrones(bot, session, scene, shipID, operation, kit) {
  const itemStore = kit.itemStore;
  const inventory = kit.inventory;
  const needed = new Map();
  for (const typeID of operation.requiredDroneTypes || []) {
    const id = positive(typeID);
    if (id) needed.set(id, (needed.get(id) || 0) + 1);
  }
  const requests = [];
  for (const item of itemStore.listCharacterItems(bot.characterID, {
    locationID: Number(shipID),
    flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
  })) {
    const typeID = positive(item.typeID);
    const remaining = needed.get(typeID) || 0;
    if (!remaining) continue;
    const amount = Math.min(remaining, inventory.unitsOf(item));
    if (amount > 0) {
      requests.push([Number(item.itemID), amount]);
      needed.set(typeID, remaining - amount);
    }
  }
  if ([...needed.values()].some((amount) => amount > 0)) {
    return { success: false, message: "The validated combat drones are no longer available in the ship's bay." };
  }
  const response = kit.droneRuntime.launchDronesForSession(session, requests);
  const drones = controlledCombatDrones(scene, shipID, operation.requiredDroneTypes);
  return drones.length
    ? { success: true, drones, response: response && response.response }
    : { success: false, message: "The drone authority did not launch the fitted combat drones." };
}

async function advanceFleetAttack(operation, bot, dependencies = {}) {
  const kit = {
    fleetRuntime: dependencies.fleetRuntime || require("../fleets/fleetRuntime"),
    playerBots: dependencies.playerBots || require("./playerBotRuntime"),
    sessionRegistry: dependencies.sessionRegistry || require("../chat/sessionRegistry"),
    space: dependencies.space || require("./playerBotSpaceRuntime"),
    worldData: dependencies.worldData || require("../../space/worldData"),
    combatRuntime: dependencies.combatRuntime || require("./playerBotCombatRuntime"),
    combatFitRuntime: dependencies.combatFitRuntime || require("./playerBotCombatFitRuntime"),
    combatDecision: dependencies.combatDecision || require("./playerBotCombatDecisionRuntime"),
    hasRoleShipFit: dependencies.hasRoleShipFit || require("./playerBotOperationRuntime").hasRoleShipFit,
    droneRuntime: dependencies.droneRuntime || require("../drone/droneRuntime"),
    itemStore: dependencies.itemStore || require("../inventory/itemStore"),
    inventory: dependencies.inventory || require("./playerBotInventoryRuntime"),
    getCharacterRecord: dependencies.getCharacterRecord || require("../character/characterState").getCharacterRecord,
    travelToSystem: dependencies.travelToSystem || require("./playerBotOperationRuntime").travelToSystem,
    travelToStation: dependencies.travelToStation || require("./playerBotOperationRuntime").travelToStation,
    record: dependencies.record || null,
    save: dependencies.save || null,
    finish: dependencies.finish || null,
  };
  kit.record = dependencies.record || ((current, message) => {
    current.lastAction = String(message).slice(0, 300);
    current.history = [...(current.history || []), { at: new Date().toISOString(), stage: current.stage, message: current.lastAction }].slice(-25);
  });
  kit.save = dependencies.save || (() => {});
  kit.finish = dependencies.finish || (() => ({ done: true }));
  kit.spaceState = kit.space.getSpaceState(bot);

  if (operation.stopRequested === true) return beginRetreat(operation, bot, operation.stopReason || "Fleet commander stopped the attack.", kit);
  const botID = positive(bot && bot.characterID);
  const requesterID = positive(operation.requestedByCharacterID);
  const fleetID = positive(operation.fleetID);
  const botFleet = kit.fleetRuntime.getMemberFleetForCharacter(botID);
  const requesterFleet = kit.fleetRuntime.getMemberFleetForCharacter(requesterID);
  const bots = kit.playerBots.listBots();
  const botIDs = new Set(bots.map((entry) => positive(entry.characterID)));
  if (!botID || !requesterID || !fleetID || !botFleet || !requesterFleet ||
      Number(botFleet.fleetID) !== fleetID || Number(requesterFleet.fleetID) !== fleetID ||
      !botFleet.members.has(requesterID) || ![...botFleet.members.keys()].some((id) => !botIDs.has(positive(id)))) {
    return beginRetreat(operation, bot, "The human commander or bot is no longer in the original fleet.", kit);
  }

  const requesterSession = kit.sessionRegistry.findSessionByCharacterID(requesterID);
  if (!requesterSession) return beginRetreat(operation, bot, "The human fleet commander went offline.", kit);
  const targetCharacterID = positive(operation.targetCharacterID);
  const targetSession = targetCharacterID ? kit.sessionRegistry.findSessionByCharacterID(targetCharacterID) : null;
  if (targetCharacterID && !targetSession) {
    return beginRetreat(operation, bot, "The locked player target went offline.", kit);
  }
  if (targetSession && (positive(targetSession.shipID || targetSession.shipid) !== positive(operation.targetID) ||
      Number(targetSession.shipTypeID || targetSession.shiptypeid) === 670 || isDocked(targetSession))) {
    return beginRetreat(operation, bot, "The locked player ship was destroyed, changed hull, or docked.", kit);
  }
  const targetSystemID = targetSession
    ? systemIDForSession(targetSession, kit.getCharacterRecord(targetCharacterID) || {})
    : positive(operation.targetSystemID);
  if (!targetSystemID || !kit.worldData.getSolarSystemByID(targetSystemID)) {
    return beginRetreat(operation, bot, "The locked target's system is no longer available.", kit);
  }
  const botCharacter = kit.getCharacterRecord(botID) || {};
  const botSession = kit.space.getActorSession(bot);
  const botSystemID = systemIDForSession(botSession, botCharacter);
  if (botSystemID !== targetSystemID) {
    if (positive(operation.routeDestinationSystemID) !== targetSystemID && operation.routeTaskID) {
      const tasks = require("./playerBotTaskRuntime");
      const route = tasks.getTask(operation.routeTaskID);
      if (route && ["queued", "leased"].includes(route.status)) tasks.cancelTask(route.taskID);
      operation.routeTaskID = null;
    }
    operation.routeDestinationSystemID = targetSystemID;
    const step = await kit.travelToSystem(operation, bot, targetSystemID);
    return step || { delayMs: COMBAT_POLL_MS };
  }

  const spaceState = kit.spaceState;
  if (!spaceState.inSpace) {
    const result = kit.space.undock(bot, { allowOverCapacityDeparture: true });
    return result.success ? { delayMs: COMBAT_POLL_MS } : { delayMs: result.capacityQueued ? COMBAT_POLL_MS : 30_000 };
  }
  if (spaceState.busy) return { delayMs: COMBAT_POLL_MS };

  let attached;
  try { attached = kit.space.getActorSpace(bot); } catch (_) { return { delayMs: COMBAT_POLL_MS }; }
  const { scene, entity, session } = attached || {};
  const target = scene && scene.getEntityByID(Number(operation.targetID));
  if (!target) {
    if (targetSession) {
      operation.targetMissingSinceAtMs ||= Date.now();
      kit.save(operation);
      if (Date.now() - Number(operation.targetMissingSinceAtMs) < TARGET_MISSING_GRACE_MS) {
        return { delayMs: COMBAT_POLL_MS };
      }
    }
    return beginRetreat(operation, bot, "The locked target left the grid or was destroyed.", kit, attached);
  }
  delete operation.targetMissingSinceAtMs;
  const authorization = kit.combatRuntime.authorizeFleetAttackTarget(bot, target, scene);
  if (!authorization.success) return beginRetreat(operation, bot, authorization.message, kit, attached);
  operation.mode = authorization.mode;

  const roleFit = kit.hasRoleShipFit(bot, operation.role);
  if (!roleFit) return beginRetreat(operation, bot, "The selected combat fit is no longer valid.", kit, attached);
  const requiredDroneTypes = operation.requiredDroneTypes || [];
  const drones = controlledCombatDrones(scene, entity.itemID, requiredDroneTypes);
  const requiredDroneTypeCounts = new Map();
  for (const typeID of requiredDroneTypes) {
    const id = positive(typeID);
    if (id) requiredDroneTypeCounts.set(id, (requiredDroneTypeCounts.get(id) || 0) + 1);
  }
  const fitResult = kit.combatFitRuntime.buildCombatFitSnapshot(bot, entity, {
    shield: spaceState.shield,
    hullDamage: spaceState.hullDamage,
    armorDamage: spaceState.armorDamage,
    warpScrambleStatus: spaceState.warpScrambleStatus,
    requiredDrones: requiredDroneTypes.length,
    requiredDroneTypes: requiredDroneTypeCounts,
    droneDamageTypeByID: operation.droneDamageTypeByID || {},
    maxSiteDifficulty: Number(operation.maxSiteDifficulty) || 1,
    deployedDrones: drones,
  });
  const fit = fitResult.success ? fitResult.fit : { ready: false, readinessProblems: [fitResult.reason || "combat-fit-unavailable"] };
  const safety = kit.combatDecision.assessSafety(spaceState, fit, drones.length, drones.length > 0);
  if (!safety.safe) return beginRetreat(operation, bot, `Combat safety withdrew the pilot (${safety.reason}).`, kit, attached);

  const distance = spaceState.distanceTo(Number(target.itemID));
  if (!Number.isFinite(distance)) return { delayMs: COMBAT_POLL_MS };
  const effectiveDroneRange = Math.max(1_000, Math.min(15_000,
    Number(fit.droneAttackRange) || 15_000,
    Number(fit.droneControlRange) || 15_000));
  const maxTargetRange = Math.max(1_000, Number(entity.maxTargetRange) || effectiveDroneRange);
  const approachRange = Math.max(1_000, Math.min(effectiveDroneRange * 0.7, maxTargetRange * 0.8));
  if (distance > WARP_RANGE_METERS) {
    const warp = kit.space.warp(bot, Number(target.itemID));
    if (!warp.success) {
      if (operation.lastMovementError !== warp.message) {
        operation.lastMovementError = String(warp.message || "Warp authority is retrying.").slice(0, 180);
        kit.record(operation, `Waiting for a legal route to the fleet target: ${operation.lastMovementError}`);
        kit.save(operation);
      }
      return { delayMs: warp.blocked ? 60_000 : COMBAT_POLL_MS, interdictionHold: warp.blocked === true };
    }
    delete operation.lastMovementError;
    kit.record(operation, `Warping to locked target ${operation.targetID} in system ${targetSystemID}.`);
    kit.save(operation);
    return { delayMs: COMBAT_POLL_MS };
  }
  if (distance > approachRange) {
    const currentFollowID = positive(entity.followTargetID);
    const currentFollowRange = Number(entity.followRange) || 0;
    if (currentFollowID !== Number(target.itemID) || Math.abs(currentFollowRange - approachRange) > 1) {
      const moved = kit.space.approach(bot, Number(target.itemID), approachRange);
      if (!moved.success) {
        kit.record(operation, `Waiting to close on locked target ${operation.targetID}: ${String(moved.message || "approach authority is retrying.").slice(0, 180)}`);
        kit.save(operation);
      }
    }
    return { delayMs: COMBAT_POLL_MS };
  }

  const locked = typeof scene.getTargetsForEntity === "function"
    ? scene.getTargetsForEntity(entity).map(Number).includes(Number(target.itemID))
    : false;
  if (!locked) {
    const result = kit.space.lockTarget(bot, Number(target.itemID));
    if (!result.success) {
      kit.record(operation, `Target lock is being retried: ${String(result.errorMsg || result.message || "targeting authority refused the lock.").slice(0, 160)}`);
      kit.save(operation);
    }
    return { delayMs: COMBAT_POLL_MS };
  }
  let currentDrones = drones;
  if (!currentDrones.length) {
    const launched = launchCombatDrones(bot, session, scene, entity.itemID, operation, kit);
    if (!launched.success) return beginRetreat(operation, bot, launched.message, kit, attached);
    currentDrones = launched.drones;
    kit.record(operation, `Launched ${currentDrones.length} fitted combat drone(s) for locked target ${operation.targetID}.`);
    kit.save(operation);
  }
  if (!currentDrones.some((drone) => Number(drone.targetID) === Number(target.itemID))) {
    const response = kit.droneRuntime.commandEngage(session,
      currentDrones.map((drone) => Number(drone.itemID)), Number(target.itemID));
    const refreshed = controlledCombatDrones(scene, entity.itemID, requiredDroneTypes);
    if (!refreshed.some((drone) => Number(drone.targetID) === Number(target.itemID))) {
      const details = JSON.stringify(response && response.entries || []).slice(0, 180);
      return beginRetreat(operation, bot, `The drone combat authority refused the target: ${details || "no engagement was accepted"}.`, kit, attached);
    }
    operation.engagedAtMs ||= Date.now();
    operation.lastEngagedTargetID = Number(target.itemID);
    kit.record(operation, `Engaged the legally authorized Fleet target ${target.itemID} with ${refreshed.length} fitted combat drone(s).`);
    kit.save(operation);
  }
  return { delayMs: COMBAT_POLL_MS };
}

async function advanceFleetAttackRetreat(operation, bot, dependencies = {}) {
  const space = dependencies.space || require("./playerBotSpaceRuntime");
  const dronesAPI = dependencies.droneRuntime || require("../drone/droneRuntime");
  const attached = space.getSpaceState(bot).inSpace ? space.getActorSpace(bot) : null;
  if (attached) {
    const drones = controlledCombatDrones(attached.scene, attached.entity.itemID, operation.requiredDroneTypes);
    if (drones.length) dronesAPI.commandReturnBay(attached.session, drones.map((drone) => Number(drone.itemID)));
  }
  const step = await (dependencies.travelToStation || require("./playerBotOperationRuntime").travelToStation)(
    operation, bot, Number(operation.homeStationID),
  );
  if (step) return step;
  return (dependencies.finish || (() => ({ done: true })))(
    operation, `${operation.stopReason || "Fleet attack complete."} Ship returned to station ${operation.homeStationID}; the director can assign its next work.`,
  );
}

function advance(operation, bot, dependencies = {}) {
  if (operation.stage === "retreat" || operation.stopRequested === true) {
    return advanceFleetAttackRetreat(operation, bot, dependencies);
  }
  return advanceFleetAttack(operation, bot, dependencies);
}

module.exports = {
  advance,
  commandFleetAttack,
  stopFleetAttack,
  _testing: {
    advanceFleetAttack,
    advanceFleetAttackRetreat,
    chooseFleetTargetRole,
    resolveCommandTarget,
  },
};

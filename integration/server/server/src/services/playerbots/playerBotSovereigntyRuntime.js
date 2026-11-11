"use strict";

// Sovereignty specialists join existing campaigns and may contest an
// unclaimed neutral Sovereignty Hub. Eligibility, timers, Entosis fuel/cycles,
// capture results and ownership remain with the game authorities.

const worldData = require("../../space/worldData");

const HUB_TYPE_ID = 32458;
const COMMAND_NODE_TYPE_ID = 34832;
const ENTOSIS_LINK_TYPE_ID = 34593;
const STRONTIUM_TYPE_ID = 16275;
const OWNER_SCC = 1000132;
const MAX_OPERATION_MS = 45 * 60 * 1000;
const OBJECTIVE_CACHE_MS = 30_000;
const MAX_NEUTRAL_HUB_SUPPORT_BOTS = 3;
const objectiveCache = new Map();
const neutralObjectiveCache = new Map();

function selectObjectives(objectives = [], allianceID, activeNodeIDs = []) {
  const claimed = new Set((Array.isArray(activeNodeIDs) ? activeNodeIDs : []).map(Number));
  return (Array.isArray(objectives) ? objectives : [])
    .filter((objective) => objective && !claimed.has(Number(objective.nodeID)))
    .filter((objective) => Number.isFinite(Number(objective.hops)) && Number(objective.hops) < 64)
    .sort((left, right) =>
      Number(right.defenderAllianceID === Number(allianceID)) - Number(left.defenderAllianceID === Number(allianceID)) ||
      Number(left.hops) - Number(right.hops) || Number(left.nodeID) - Number(right.nodeID));
}

function selectNeutralHubObjectives(objectives = [], activeTargetIDs = []) {
  const activeCounts = new Map();
  for (const targetID of Array.isArray(activeTargetIDs) ? activeTargetIDs : []) {
    const numericID = Number(targetID) || 0;
    if (numericID) activeCounts.set(numericID, (activeCounts.get(numericID) || 0) + 1);
  }
  return (Array.isArray(objectives) ? objectives : [])
    .filter((objective) => objective && Number(objective.targetID) > 0 &&
      (activeCounts.get(Number(objective.targetID)) || 0) < MAX_NEUTRAL_HUB_SUPPORT_BOTS)
    .filter((objective) => Number.isFinite(Number(objective.hops)) && Number(objective.hops) < 64)
    .sort((left, right) => {
      const isContested = (objective) => {
        const rate = Number(objective.capture && objective.capture.scoringRate);
        return Number.isFinite(rate) && rate !== 0;
      };
      return Number(isContested(right)) - Number(isContested(left)) ||
        Number(left.hops) - Number(right.hops) || Number(left.targetID) - Number(right.targetID);
    });
}

function normalizeID(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function getPersistedAllianceID(bot) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporation = require("../corporation/corporationState").getCorporationRecord(
    normalizeID(character.corporationID || bot.corporationID),
  ) || {};
  return normalizeID(corporation.allianceID || character.allianceID);
}

function getCampaignObjectives(bot, options = {}) {
  const allianceID = normalizeID(options.allianceID || getPersistedAllianceID(bot));
  if (!allianceID) return [];
  const now = Date.now();
  const cached = objectiveCache.get(allianceID);

  const sov = require("../sovereignty/sovState");
  const campaigns = require("../sovereignty/sovCampaignState");
  const results = cached && cached.expiresAt > now ? cached.objectives : [];
  if (!cached || cached.expiresAt <= now) for (const system of worldData.getSolarSystems()) {
    const systemID = normalizeID(system.solarSystemID || system.solarSystemID2);
    if (!systemID) continue;
    const state = sov.getSystemState(systemID);
    const hubs = (Array.isArray(state && state.structures) ? state.structures : [])
      .filter((structure) => Number(structure.typeID) === HUB_TYPE_ID && normalizeID(structure.itemID));
    for (const hub of hubs) {
      const projection = campaigns.getSovereigntyCampaignProjection({ targetID: hub.itemID });
      if (!projection || projection.status !== "active") continue;
      const defenderAllianceID = normalizeID(projection.defenderAllianceID);
      if (!defenderAllianceID) continue;
      const attackerAllianceID = normalizeID(projection.attackerAllianceID);
      if (allianceID !== defenderAllianceID && attackerAllianceID && allianceID !== attackerAllianceID) continue;
      const teamID = allianceID === defenderAllianceID ? defenderAllianceID : -defenderAllianceID;
      for (const node of Array.isArray(projection.commandNodes) ? projection.commandNodes : []) {
        const nodeID = normalizeID(node.nodeID || node.itemID);
        const nodeSystemID = normalizeID(node.solarSystemID);
        if (!nodeID || !nodeSystemID || Number(node.typeID) && Number(node.typeID) !== COMMAND_NODE_TYPE_ID) continue;
        const capture = node.entosisCapture || node.commandNodeCapture || {};
        if (capture.isBlocked === true || Number(capture.scoringTeamID) === teamID) continue;
        results.push({
          allianceID,
          defenderAllianceID,
          attackerAllianceID,
          teamID,
          campaignTargetID: normalizeID(projection.targetID || hub.itemID),
          campaignEpoch: String(projection.campaignEpoch || ""),
          sourceSystemID: systemID,
          systemID: nodeSystemID,
          nodeID,
          scoreAtLastUpdateTime: Number(capture.scoreAtLastUpdateTime),
          scoringTeamID: normalizeID(capture.scoringTeamID),
          isBlocked: capture.isBlocked === true,
        });
      }
    }
  }

  if (!cached || cached.expiresAt <= now) objectiveCache.set(allianceID, { expiresAt: now + OBJECTIVE_CACHE_MS, objectives: results });

  const activeNodeClaims = new Set(require("./playerBotOperationRecords").listReadOnlyActiveOperations(require("./playerBotOperationRuntime"))
    .filter((operation) => operation.kind === "sovereignty")
    .map((operation) => Number(operation.nodeID) || 0));
  const currentSystemID = normalizeID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).solarSystemID);
  const space = require("./playerBotSpaceRuntime");
  const objectives = results.map((objective) => {
      const route = currentSystemID ? space.findStargateRoute(currentSystemID, objective.systemID) : null;
      return { ...objective, hops: route && route.success ? route.gates.length : Number.MAX_SAFE_INTEGER,
        routeRisk: route && route.success ? route.risk : null };
    });
  return selectObjectives(objectives, allianceID, [...activeNodeClaims]);
}

function findCampaignObjective(bot) {
  return getCampaignObjectives(bot)[0] || null;
}

function getNeutralHubObjectives(bot, options = {}) {
  const allianceID = normalizeID(options.allianceID || getPersistedAllianceID(bot));
  if (!allianceID) return [];
  if (!require("../corporation/allianceGovernanceState").getActiveExecutorCorporationID(allianceID)) return [];
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const currentSystemID = normalizeID(character.solarSystemID);
  if (!currentSystemID) return [];
  const cacheKey = `${allianceID}:${currentSystemID}`;
  const now = Date.now();
  const cached = neutralObjectiveCache.get(cacheKey);
  let candidates = cached && cached.expiresAt > now ? cached.objectives : null;
  if (!candidates) {
    const sov = require("../sovereignty/sovState");
    const claimable = require("../sovereignty/sovSystemRules").isSovereigntyClaimableSolarSystem;
    candidates = [];
    for (const row of worldData.getSolarSystems()) {
      const systemID = normalizeID(row.solarSystemID || row.solarSystemID2);
      if (!systemID || !claimable(systemID)) continue;
      const state = sov.getSystemState(systemID);
      if (!state || normalizeID(state.claimStructureID) || normalizeID(state.infrastructureHubID)) continue;
      for (const hub of Array.isArray(state.structures) ? state.structures : []) {
        const hubID = normalizeID(hub && hub.itemID);
        if (!hubID || Number(hub.typeID) !== HUB_TYPE_ID ||
            Number(hub.ownerID) !== OWNER_SCC || Number(hub.corporationID) !== OWNER_SCC ||
            normalizeID(hub.allianceID) || hub.devFlags && hub.devFlags.sovereigntyCaptured === true) continue;
        candidates.push({
          allianceID,
          kind: "neutral-hub",
          targetID: hubID,
          sourceSystemID: systemID,
          systemID,
          name: String(hub.name || `Neutral Sovereignty Hub ${hubID}`),
          capture: hub.entosisCapture && typeof hub.entosisCapture === "object"
            ? { ...hub.entosisCapture }
            : null,
        });
      }
    }
    neutralObjectiveCache.set(cacheKey, { expiresAt: now + OBJECTIVE_CACHE_MS, objectives: candidates });
  }
  const activeTargets = require("./playerBotOperationRecords").listReadOnlyActiveOperations(require("./playerBotOperationRuntime"))
    .filter((operation) => operation.kind === "sovereignty" && operation.objectiveKind === "neutral-hub")
    .map((operation) => normalizeID(operation.targetID || operation.nodeID))
    .filter(Boolean);
  const space = require("./playerBotSpaceRuntime");
  const reachable = candidates
    .map((objective) => {
      const route = space.findStargateRoute(currentSystemID, objective.systemID);
      return { ...objective,
        hops: route && route.success ? route.gates.length : Number.MAX_SAFE_INTEGER,
        routeRisk: route && route.success ? route.risk || null : null };
    });
  return selectNeutralHubObjectives(reachable, activeTargets);
}

function findSovereigntyObjective(bot) {
  return findCampaignObjective(bot) || getNeutralHubObjectives(bot)[0] || null;
}

function classifyNeutralHubState(state, operation) {
  const hubID = normalizeID(operation.targetID || operation.nodeID);
  const hub = (Array.isArray(state && state.structures) ? state.structures : [])
    .find((structure) => normalizeID(structure && structure.itemID) === hubID) || null;
  if (!state || !hub) return { status: "missing", state, hub };
  if (normalizeID(state.infrastructureHubID) === hubID || normalizeID(state.claimStructureID) === hubID) {
    return { status: normalizeID(state.allianceID) === normalizeID(operation.allianceID) ? "claimed" : "lost", state, hub };
  }
  const neutral = Number(hub.typeID) === HUB_TYPE_ID && Number(hub.ownerID) === OWNER_SCC &&
    Number(hub.corporationID) === OWNER_SCC && !normalizeID(hub.allianceID);
  return { status: neutral ? "neutral" : "lost", state, hub };
}

function getNeutralHubState(operation) {
  const state = require("../sovereignty/sovState").getSystemState(Number(operation.systemID));
  return classifyNeutralHubState(state, operation);
}

function getCampaignAndNode(operation) {
  const projection = require("../sovereignty/sovCampaignState").getSovereigntyCampaignProjection({
    targetID: operation.campaignTargetID,
  });
  if (!projection || projection.status !== "active" ||
      String(projection.campaignEpoch || "") !== String(operation.campaignEpoch || "")) {
    return { projection, node: null };
  }
  return {
    projection,
    node: (projection.commandNodes || []).find((node) => Number(node.nodeID || node.itemID) === Number(operation.nodeID)) || null,
  };
}

function isLinkActive(entity, moduleID) {
  const effect = entity && entity.activeModuleEffects instanceof Map
    ? entity.activeModuleEffects.get(Number(moduleID))
    : null;
  return Boolean(effect && effect.entosisLinkEffect === true &&
    (Number(effect.deactivatedAtMs) || 0) <= 0);
}

function getSovereigntyThreatReason(state) {
  if (!state || state.inSpace !== true) return "";
  if (state.isCapsule === true) return "the active hull was lost";
  if (Number(state.hullDamage) > 0) return "the ship has taken hull damage";
  if (Number(state.armorDamage) > 0) return "the ship has taken armor damage";
  if (Number(state.shield) < 0.75) return "shield reserve fell below 75%";
  if (Number(state.capacitorRatio) < 0.30) return "capacitor reserve fell below 30%";
  if (Number(state.warpScrambleStatus) > 0) return "hostile warp disruption was detected";
  return "";
}

async function advanceSovereignty(operation, bot, kit) {
  const space = kit.space;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  if (!operation.withdrawRequested && Date.now() - Number(operation.startedAtMs || Date.now()) > MAX_OPERATION_MS) {
    operation.withdrawRequested = true;
    if (operation.stage !== "scoring") operation.stage = "return";
    kit.record(operation, "Sovereignty operation reached its participation limit; the Entosis link will finish through the normal module deactivation rules before retreat.");
    kit.save(operation);
  }
  if (["node", "scoring"].includes(operation.stage) && !operation.withdrawRequested) {
    try {
      const threat = getSovereigntyThreatReason(space.getSpaceState(bot));
      if (threat) {
        operation.withdrawRequested = true;
        operation.withdrawReason = `Sovereignty safety check: ${threat}; disengaging through normal Entosis shutdown.`;
        if (operation.stage !== "scoring") operation.stage = "return";
        kit.record(operation, operation.withdrawReason);
        kit.save(operation);
      }
    } catch (error) {
      // A transient space-state read failure must not stop the durable task;
      // the next step will retry and the game authority still owns the ship.
      kit.record(operation, `Could not read sovereignty safety state; retrying before the next Entosis action: ${space.describeError(error)}.`);
      kit.save(operation);
      return { delayMs: 15_000 };
    }
  }

  if (operation.stage === "to-system") {
    const step = kit.travelToSystem(operation, bot, operation.systemID);
    if (step) return step;
    operation.stage = "node";
    operation.routeTaskID = null;
    kit.save(operation);
  }

  if (operation.stage === "node") {
    const isInitialClaim = operation.objectiveKind === "neutral-hub";
    const existing = isInitialClaim ? getNeutralHubState(operation) : getCampaignAndNode(operation);
    if (isInitialClaim ? existing.status !== "neutral" : (!existing.projection || !existing.node)) {
      const capturedByThisAlliance = isInitialClaim && existing.status === "claimed";
      operation.stage = "return";
      operation.withdrawRequested = true;
      operation.withdrawReason = capturedByThisAlliance
        ? `The alliance captured neutral Sovereignty Hub ${operation.targetID}; returning to station.`
        : isInitialClaim
          ? `Neutral Sovereignty Hub ${operation.targetID} is no longer available; returning to station.`
          : `Campaign command node ${operation.nodeID} is no longer active; returning to station.`;
      kit.record(operation, operation.withdrawReason);
      kit.save(operation);
      return { delayMs: 15_000 };
    }
    const session = space.getActorSession(bot);
    if (Number(session.stationID || session.structureID || character.stationID || character.structureID) > 0) {
      const undocked = space.undock(bot, { allowOverCapacityDeparture: true });
      if (!undocked.success) return kit.block(operation, "holding", undocked.message);
      return { delayMs: 15_000 };
    }
    const attached = space.getActorSpace(bot);
    const targetID = Number(operation.targetID || operation.nodeID);
    const node = attached.scene.getEntityByID(targetID);
    if (!node) return kit.block(operation, "holding", `${isInitialClaim ? "Neutral Sovereignty Hub" : "Campaign node"} ${targetID} is not present in the local scene yet.`);
    const module = require("../inventory/itemStore").listCharacterItems(bot.characterID, {
      locationID: Number(attached.entity.itemID),
    }).find((item) => Number(item.typeID) === ENTOSIS_LINK_TYPE_ID && Number(item.flagID) >= 27 && Number(item.flagID) <= 34);
    if (!module) return kit.block(operation, "blocked", `The active ship has no fitted Entosis Link I (${ENTOSIS_LINK_TYPE_ID}).`);
    const cargo = require("../inventory/itemStore").listCharacterItems(bot.characterID, {
      locationID: Number(attached.entity.itemID),
      flagID: require("../inventory/itemStore").ITEM_FLAGS.CARGO_HOLD,
    });
    const fuel = cargo.filter((item) => Number(item.typeID) === STRONTIUM_TYPE_ID)
      .reduce((total, item) => total + Math.max(0, Number(item.stacksize ?? item.quantity) || 0), 0);
    if (fuel < 2) return kit.block(operation, "blocked", `The Entosis Link needs Strontium Clathrates in the ship cargo; ${fuel} unit(s) remain, and the bot will not start an unfueled capture attempt.`);
    const distance = attached.scene.getEntitySurfaceDistance
      ? Number(attached.scene.getEntitySurfaceDistance(attached.entity, node))
      : Math.max(0, Math.hypot(
        Number(attached.entity.position.x) - Number(node.position.x),
        Number(attached.entity.position.y) - Number(node.position.y),
        Number(attached.entity.position.z) - Number(node.position.z),
      ) - Number(attached.entity.radius || 0) - Number(node.radius || 0));
    if (distance > 50_000) {
      const warped = space.warp(bot, node.itemID);
      if (!warped.success) return warped.blocked
        ? { delayMs: 60_000, interdictionHold: true }
        : kit.block(operation, "holding", warped.message);
      return { delayMs: 15_000 };
    }
    const targets = require("../../space/runtime").getTargets(session) || [];
    if (!targets.map(Number).includes(Number(node.itemID))) {
      const locked = space.lockTarget(bot, node.itemID);
      if (!locked || locked.success !== true) return kit.block(operation, "holding", `Could not lock sovereignty target ${node.itemID}: ${locked && locked.errorMsg || "targeting refused"}.`);
      return { delayMs: 15_000 };
    }
    if (distance > 20_000) {
      const approached = space.approach(bot, node.itemID, 18_000);
      if (!approached.success) return kit.block(operation, "holding", approached.message);
      return { delayMs: 15_000 };
    }
    if (!isLinkActive(attached.entity, module.itemID)) {
      try {
        new (require("../dogma/dogmaService"))().Handle_Activate(
          [Number(module.itemID), "entosisLink", Number(node.itemID), null],
          session,
        );
      } catch (error) {
        return kit.block(operation, "holding", `Entosis activation was refused by Dogma: ${space.describeError(error)}.`);
      }
      const refreshed = space.getActorSpace(bot);
      if (!isLinkActive(refreshed.entity, module.itemID)) {
        return kit.block(operation, "holding", "Dogma accepted no active Entosis effect; the sovereignty operation is waiting for review.");
      }
      operation.stage = "scoring";
      operation.linkModuleID = Number(module.itemID);
      operation.lastFuelCheckAtMs = Date.now();
      kit.record(operation, `Entosis Link activated on ${isInitialClaim ? "neutral Sovereignty Hub" : "campaign command node"} ${node.itemID}; the first five-minute cycle is warm-up and does not score.`);
      kit.save(operation);
      return { delayMs: 60_000 };
    }
    operation.stage = "scoring";
    operation.linkModuleID = Number(module.itemID);
    kit.save(operation);
    return { delayMs: 60_000 };
  }

  if (operation.stage === "scoring") {
    const isInitialClaim = operation.objectiveKind === "neutral-hub";
    const current = isInitialClaim ? getNeutralHubState(operation) : getCampaignAndNode(operation);
    const targetStillActive = isInitialClaim
      ? current.status === "neutral"
      : Boolean(current.projection && current.node);
    const attached = space.getActorSpace(bot);
    const active = isLinkActive(attached.entity, operation.linkModuleID);
    if (!targetStillActive) {
      operation.withdrawRequested = true;
      operation.withdrawReason = isInitialClaim && current.status === "claimed"
        ? `Neutral Hub ${operation.targetID} capture is complete for alliance ${operation.allianceID}; the ship is disengaging safely.`
        : isInitialClaim
          ? `Neutral Hub ${operation.targetID} is no longer a valid sovereignty target; the ship is disengaging safely.`
          : `Sovereignty campaign ${operation.campaignTargetID} ended; the ship is disengaging safely.`;
      if (active) {
        if (!operation.deactivationRequested) {
          try {
            new (require("../dogma/dogmaService"))().Handle_Deactivate(
              [Number(operation.linkModuleID), "entosisLink"],
              space.getActorSession(bot),
            );
            operation.deactivationRequested = true;
            kit.record(operation, "Campaign ended; requested normal Entosis deactivation and waiting for the active cycle boundary.");
          } catch (error) {
            kit.record(operation, `Campaign ended; Entosis deactivation is waiting for a cycle boundary: ${space.describeError(error)}.`);
          }
        }
        kit.save(operation);
        return { delayMs: 30_000 };
      }
      operation.stage = "return";
      operation.linkModuleID = null;
      kit.record(operation, operation.withdrawReason);
      kit.save(operation);
      return { delayMs: 15_000 };
    }
    if (!active) {
      operation.stage = operation.withdrawRequested ? "return" : "node";
      operation.linkModuleID = null;
      kit.record(operation, operation.withdrawRequested
        ? "The Entosis effect ended cleanly after the requested cycle; returning to station."
        : "The Entosis effect ended; checking campaign, lock and fuel state before any new activation.");
      kit.save(operation);
      return { delayMs: 15_000 };
    }
    if (operation.withdrawRequested && !operation.deactivationRequested) {
      try {
        new (require("../dogma/dogmaService"))().Handle_Deactivate(
          [Number(operation.linkModuleID), "entosisLink"],
          space.getActorSession(bot),
        );
        operation.deactivationRequested = true;
        kit.record(operation, "Requested normal Entosis deactivation; the current module cycle must finish before the ship can leave.");
      } catch (error) {
        // The ordinary Dogma state machine may refuse a mid-cycle request.
        // Keep the ship on grid and retry after the next normal cycle.
        kit.record(operation, `Entosis deactivation is waiting for a cycle boundary: ${space.describeError(error)}.`);
      }
      kit.save(operation);
      return { delayMs: 30_000 };
    }
    const capture = isInitialClaim
      ? require("../sovereignty/sovCaptureState").getSovereigntyCaptureProjection({ targetID: operation.targetID, solarSystemID: operation.systemID })
      : current.node && (current.node.entosisCapture || current.node.commandNodeCapture);
    operation.scoringTeamID = Number(capture && capture.scoringTeamID) || null;
    operation.lastFuelCheckAtMs = Date.now();
    kit.save(operation);
    return { delayMs: 60_000 };
  }

  if (operation.stage === "return") {
    const session = space.getActorSession(bot);
    if (Number(session.stationID || session.structureID || character.stationID || character.structureID) > 0) {
      return kit.finish(operation, "Sovereignty operation ended safely at station.");
    }
    const step = kit.travelToStation(operation, bot, operation.homeStationID);
    if (step) return step;
    return kit.finish(operation, `Sovereignty operation ended at ${operation.homeStationID}.`);
  }
  return kit.block(operation, "blocked", `Unknown sovereignty stage ${operation.stage}.`);
}

function startOperation(botQuery, suppliedObjective = null, options = {}) {
  const bot = require("./playerBotRuntime").resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found for: ${botQuery}.` };
  if (bot.specialty !== "sovereignty") return { success: false, message: `${bot.characterName} is not assigned to sovereignty.` };
  const allianceID = getPersistedAllianceID(bot);
  if (!allianceID) return { success: false, message: `${bot.characterName} is not in an alliance.` };
  const current = findSovereigntyObjective(bot);
  const objectiveID = (objective) => Number(objective && (objective.nodeID || objective.targetID)) || 0;
  const objective = suppliedObjective && current && objectiveID(suppliedObjective) === objectiveID(current)
    ? current
    : current;
  if (!objective) return { success: false, message: "No reachable sovereignty campaign or unclaimed neutral Hub is available to this alliance." };
  const operationRuntime = require("./playerBotOperationRuntime");
  const requiredUpgrade = operationRuntime.nextShipUpgrade(bot, "sovereignty");
  if (requiredUpgrade || !operationRuntime.hasRoleShipFit(bot, "sovereignty")) return { success: false, message: `${bot.characterName} needs the sovereignty ship fit before starting an Entosis operation.` };
  return require("./playerBotOperationRuntime").startSovereignty(bot.characterName, objective, options);
}

module.exports = {
  advanceSovereignty,
  findCampaignObjective,
  findSovereigntyObjective,
  getCampaignObjectives,
  getNeutralHubObjectives,
  getPersistedAllianceID,
  getNeutralHubState,
  startOperation,
  _testing: { getCampaignAndNode, selectObjectives, selectNeutralHubObjectives, classifyNeutralHubState, getNeutralHubState, getSovereigntyThreatReason },
};

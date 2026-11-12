"use strict";

const worldData = require("../../space/worldData");

const RETRY_ESCORT_ASSIGNMENT_MS = 30_000;
const MINING_RAT_REQUEST_MAX_AGE_MS = 90_000;
const MINING_ESCORT_ON_GRID_RANGE_METERS = 250_000;

function positiveID(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function systemIDForStation(stationID) {
  const station = worldData.getStationByID(positiveID(stationID)) ||
    worldData.getStructureByID(positiveID(stationID));
  return positiveID(station && station.solarSystemID);
}

function getRequiredSecurityFitTier(systemID) {
  const system = worldData.getSolarSystemByID(positiveID(systemID));
  const security = Number(system && system.security);
  // If static data cannot establish system security, select the strongest fit
  // tier. Treating unknown space as high-sec could send an underpowered guard.
  if (!Number.isFinite(security)) return 5;
  if (security >= 0.8) return 1;
  if (security >= 0.6) return 2;
  if (security >= 0.45) return 3;
  if (security > 0.0) return 4;
  return 5;
}

function getMiningEscortGroupKey(systemID, beltID) {
  const normalizedSystemID = positiveID(systemID);
  const normalizedBeltID = positiveID(beltID);
  return normalizedSystemID && normalizedBeltID
    ? `${normalizedSystemID}:${normalizedBeltID}`
    : "";
}

function escortShipWasDestroyed(bot, operation) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  return Number(character.shipTypeID) === 670 ||
    operation && (operation.escortShipLost === true || operation.miningEscortDestroyed === true);
}

function isActiveEscort(operation, requiredTier = 1) {
  if (!operation || operation.kind !== "combat" || !["active", "holding"].includes(operation.status) ||
      !operation.miningEscortGroupKey ||
      ["return", "to-market", "market-sell", "corp-share", "done"].includes(operation.stage)) return false;
  return Number(operation.miningEscortFitTier) >= Number(requiredTier);
}

function getEscortState(miningOperation) {
  const characterID = positiveID(miningOperation && miningOperation.escortCharacterID);
  if (!characterID) return { assigned: false, destroyed: false, onGrid: false, engaging: false, ready: false };
  const playerBots = require("./playerBotRuntime");
  const bot = playerBots.listBots().find((entry) => Number(entry.characterID) === characterID);
  if (!bot) return { assigned: false, destroyed: false, onGrid: false, engaging: false, ready: false, characterID };
  const operationRuntime = require("./playerBotOperationRuntime");
  const escortOperation = operationRuntime.getOperation(characterID);
  if (escortShipWasDestroyed(bot, escortOperation)) {
    return {
      assigned: true,
      destroyed: true,
      characterID,
      characterName: bot.characterName,
      operation: escortOperation,
    };
  }
  const groupKey = String(miningOperation.miningEscortGroupKey || "");
  const assigned = isActiveEscort(escortOperation, Number(miningOperation.escortRequiredTier) || 1) &&
    String(escortOperation.miningEscortGroupKey) === groupKey;
  if (!assigned) {
    return { assigned: false, destroyed: false, onGrid: false, engaging: false, ready: false,
      characterID, characterName: bot.characterName, operation: escortOperation };
  }

  let escortSpace = null;
  try {
    escortSpace = require("./playerBotSpaceRuntime").getSpaceState(bot);
  } catch (_) {
    // An unavailable actor is not proof that an escort is covering the belt.
  }
  const systemID = positiveID(miningOperation.miningEscortSystemID) ||
    systemIDForStation(miningOperation.homeStationID);
  const beltID = positiveID(miningOperation.beltID);
  let beltDistance = null;
  try {
    const rawDistance = escortSpace && typeof escortSpace.distanceTo === "function"
      ? escortSpace.distanceTo(beltID)
      : null;
    beltDistance = rawDistance === null || rawDistance === undefined ? null : Number(rawDistance);
  } catch (_) {
    beltDistance = null;
  }
  const onGrid = Boolean(escortSpace && escortSpace.inSpace && systemID > 0 && beltID > 0 &&
    Number(escortSpace.systemID) === systemID && Number.isFinite(beltDistance) &&
    beltDistance <= MINING_ESCORT_ON_GRID_RANGE_METERS);
  const engaging = onGrid && escortOperation.stage === "engage" &&
    Number(escortOperation.miningEscortForCharacterID) === Number(miningOperation.characterID) &&
    Number(escortOperation.miningEscortBeltID) === beltID && Number(escortOperation.targetID) > 0;
  return { assigned, destroyed: false, onGrid, engaging, ready: engaging,
    beltDistance, characterID, characterName: bot.characterName, operation: escortOperation };
}

// A security pilot may be finishing a sale, mining trip or other durable task
// when a rat appears. Once that task completes, the director should give the
// pilot the live belt request before starting another unrelated job. Mining
// operations refresh lastPirateScanAtMs while a rat remains visible, so a stale
// sighting cannot keep pulling guards across the region.
function findPendingMiningEscortRequest(bot, options = {}) {
  const now = Number(options.now) || Date.now();
  const requireFit = options.requireFit === true;
  if (!bot || bot.specialty !== "security" || bot.status === "paused" || bot.autonomyPaused === true) {
    return null;
  }
  const operationRuntime = require("./playerBotOperationRuntime");
  const activeOperations = operationRuntime.listActiveOperations();
  const recentMiningOperations = activeOperations.filter((miningOperation) => {
    if (miningOperation.kind !== "mine" || !["active", "holding"].includes(miningOperation.status) ||
        miningOperation.stage !== "mining" || Number(miningOperation.lastVisiblePirateNpcCount) <= 0 ||
        Number(miningOperation.characterID) === Number(bot.characterID)) return false;
    const scannedAt = Number(miningOperation.lastPirateScanAtMs) || Date.parse(miningOperation.lastPirateScanAt || "");
    return Number.isFinite(scannedAt) && now - scannedAt >= 0 && now - scannedAt <= MINING_RAT_REQUEST_MAX_AGE_MS;
  });
  if (!recentMiningOperations.length) return null;

  let fitTier = 0;
  if (requireFit) {
    fitTier = Number(operationRuntime.getRoleShipFitProfile(bot, "security")?.maxSiteDifficulty) || 0;
    if (!fitTier || !operationRuntime.hasRoleShipFit(bot, "security")) return null;
  }

  const requests = [];
  for (const miningOperation of recentMiningOperations) {
    const scannedAt = Number(miningOperation.lastPirateScanAtMs) || Date.parse(miningOperation.lastPirateScanAt || "");
    const systemID = positiveID(miningOperation.miningEscortSystemID) || systemIDForStation(miningOperation.homeStationID);
    const beltID = positiveID(miningOperation.beltID);
    const groupKey = getMiningEscortGroupKey(systemID, beltID);
    if (!groupKey) continue;
    const requiredTier = getRequiredSecurityFitTier(systemID);
    if (requireFit && fitTier < requiredTier) continue;
    const alreadyCovered = activeOperations.some((entry) =>
      String(entry.miningEscortGroupKey || "") === groupKey && isActiveEscort(entry, requiredTier));
    if (alreadyCovered) continue;
    const route = require("./playerBotSpaceRuntime").previewSystemRoute(bot, systemID);
    if (!route || route.success !== true) continue;
    const miner = require("../character/characterState").getCharacterRecord(miningOperation.characterID) || {};
    const minerCorpID = Number(miner.corporationID || miningOperation.corporationID) || 0;
    requests.push({
      characterID: Number(miningOperation.characterID),
      characterName: String(miningOperation.characterName || miner.characterName || ""),
      corporationID: minerCorpID,
      systemID,
      beltID,
      groupKey,
      requiredTier,
      fitTier,
      hops: Number(route.hops) || 0,
      sameCorporation: minerCorpID > 0 && minerCorpID === Number(bot.corporationID),
      scannedAt,
    });
  }
  requests.sort((left, right) => Number(right.sameCorporation) - Number(left.sameCorporation) ||
    left.hops - right.hops || right.scannedAt - left.scannedAt ||
    Number(left.characterID) - Number(right.characterID));
  return requests[0] || null;
}

function findPendingMiningEscortTarget(bot, now = Date.now()) {
  return findPendingMiningEscortRequest(bot, { now, requireFit: true });
}

function ensureMiningEscort(miner, miningOperation) {
  const operationRuntime = require("./playerBotOperationRuntime");
  const systemID = systemIDForStation(miningOperation.homeStationID);
  const beltID = positiveID(miningOperation.beltID);
  const groupKey = getMiningEscortGroupKey(systemID, beltID);
  if (!groupKey) return { assigned: false, changed: false, reason: "mining-grid-not-known" };

  const requiredTier = getRequiredSecurityFitTier(systemID);
  const changed = miningOperation.miningEscortGroupKey !== groupKey ||
    Number(miningOperation.escortRequiredTier) !== requiredTier;
  miningOperation.miningEscortGroupKey = groupKey;
  miningOperation.miningEscortSystemID = systemID;
  miningOperation.escortRequiredTier = requiredTier;

  const current = getEscortState(miningOperation);
  if (current.destroyed) return { ...current, changed };
  if (current.assigned) return { ...current, changed };

  const now = Date.now();
  if (Number(miningOperation.escortRetryAfterAtMs) > now) {
    return { assigned: false, destroyed: false, changed, requiredTier, groupKey };
  }

  const activeOperations = operationRuntime.listActiveOperations();
  const activeByCharacter = new Map(activeOperations.map((entry) => [Number(entry.characterID), entry]));
  const existing = activeOperations
    .filter((entry) => String(entry.miningEscortGroupKey || "") === groupKey &&
      isActiveEscort(entry, requiredTier))
    .sort((left, right) => Number(right.miningEscortFitTier) - Number(left.miningEscortFitTier) ||
      Number(left.characterID) - Number(right.characterID))[0];
  const bots = require("./playerBotRuntime").listBots();
  if (existing) {
    const escortBot = bots.find((entry) => Number(entry.characterID) === Number(existing.characterID));
    if (escortBot && !escortShipWasDestroyed(escortBot, existing)) {
      const assignmentChanged = Number(miningOperation.escortCharacterID) !== Number(existing.characterID) ||
        String(miningOperation.escortCharacterName || "") !== String(escortBot.characterName || "") ||
        Number(miningOperation.escortFitTier) !== Number(existing.miningEscortFitTier);
      miningOperation.escortCharacterID = Number(existing.characterID);
      miningOperation.escortCharacterName = escortBot.characterName;
      miningOperation.escortFitTier = Number(existing.miningEscortFitTier) || 0;
      return { assigned: true, changed: changed || assignmentChanged, characterID: Number(existing.characterID),
        characterName: escortBot.characterName, fitTier: miningOperation.escortFitTier,
        requiredTier, groupKey, shared: true };
    }
  }

  const minerCorporationID = Number(miner.corporationID) ||
    Number((require("../character/characterState").getCharacterRecord(miner.characterID) || {}).corporationID) || 0;
  const candidates = [];
  for (const bot of bots) {
    if (!bot || Number(bot.characterID) === Number(miner.characterID) || bot.specialty !== "security" ||
        bot.status === "paused" || bot.autonomyPaused === true) continue;
    if (activeByCharacter.has(Number(bot.characterID))) continue;
    if (require("./playerBotLocalDefenseAdapter").hasLease(bot.characterID) ||
        require("./playerBotInterruptRuntime").hasPending(bot.characterID) ||
        require("./playerBotInterruptRuntime").isBusy(bot.characterID)) continue;
    const localSettings = require("./playerBotLocalDefenseConfig").get();
    if (localSettings.enabled && localSettings.systemIDs.includes(systemID) &&
        (!localSettings.responderIDs.includes(Number(bot.characterID)) ||
         !require("./playerBotLocalDefenseAdapter").related(bot.characterID, miner.characterID) ||
         Number((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).solarSystemID) !== systemID)) continue;
    const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
    if (Number(character.shipTypeID) === 670) continue;
    const profile = operationRuntime.getRoleShipFitProfile(bot, "security");
    const fitTier = Number(profile && profile.maxSiteDifficulty) || 0;
    if (fitTier < requiredTier || !operationRuntime.hasRoleShipFit(bot, "security")) continue;
    const route = require("./playerBotSpaceRuntime").previewSystemRoute(bot, systemID);
    if (!route || route.success !== true) continue;
    candidates.push({ bot, fitTier, sameCorporation: Number(bot.corporationID) === minerCorporationID,
      hops: Number(route.hops) || 0 });
  }
  candidates.sort((left, right) => Number(right.sameCorporation) - Number(left.sameCorporation) ||
    right.fitTier - left.fitTier || left.hops - right.hops ||
    Number(left.bot.characterID) - Number(right.bot.characterID));

  let lastFailure = "No available security pilot has a validated fit for this system's risk tier.";
  for (const candidate of candidates) {
    const started = operationRuntime.startCombat(candidate.bot.characterName, "security", {
      autonomous: true,
      miningEscortForCharacterID: Number(miner.characterID),
    });
    if (!started.success) {
      lastFailure = String(started.message || lastFailure);
      continue;
    }
    miningOperation.escortCharacterID = Number(candidate.bot.characterID);
    miningOperation.escortCharacterName = candidate.bot.characterName;
    miningOperation.escortFitTier = candidate.fitTier;
    miningOperation.escortRetryAfterAtMs = 0;
    return { assigned: true, changed: true, characterID: Number(candidate.bot.characterID),
      characterName: candidate.bot.characterName, fitTier: candidate.fitTier,
      requiredTier, groupKey, started: true };
  }

  miningOperation.escortRetryAfterAtMs = now + RETRY_ESCORT_ASSIGNMENT_MS;
  const shouldLog = miningOperation.escortUnavailableLoggedKey !== groupKey;
  miningOperation.escortUnavailableLoggedKey = groupKey;
  return { assigned: false, destroyed: false, changed: true, requiredTier, groupKey,
    shouldLog, reason: lastFailure };
}

module.exports = {
  ensureMiningEscort,
  findPendingMiningEscortRequest,
  findPendingMiningEscortTarget,
  getEscortState,
  getMiningEscortGroupKey,
  getRequiredSecurityFitTier,
  _testing: { isActiveEscort, systemIDForStation, MINING_RAT_REQUEST_MAX_AGE_MS,
    MINING_ESCORT_ON_GRID_RANGE_METERS },
};

"use strict";

const worldData = require("../../space/worldData");
const CONFLICT_CACHE_MS = 5_000;
const conflictCache = new Map();

// Nullsec structure rivalry is derived from live corporation and structure
// records. It does not create a wardec: nullsec combat is already legal under
// the space rules, while sovereignty capture remains on the Entosis authority.

function positiveID(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function getCorporation(corporationID) {
  return require("../corporation/corporationState").getCorporationRecord(positiveID(corporationID)) || null;
}

function getCharacterCorporation(characterID) {
  const character = require("../character/characterState").getCharacterRecord(positiveID(characterID)) || {};
  return positiveID(character.corporationID || character.corpID);
}

function getAllianceID(corporationID) {
  return positiveID(getCorporation(corporationID)?.allianceID);
}

function isActiveNullsecStructure(structure, systemID) {
  if (!structure || positiveID(structure.solarSystemID) !== positiveID(systemID) ||
      structure.destroyedAt || structure.unanchoring) return false;
  const ownerCorporationID = positiveID(structure.ownerCorpID || structure.ownerID);
  if (!ownerCorporationID) return false;
  const corporation = getCorporation(ownerCorporationID);
  if (!corporation || corporation.deleted || corporation.isNPC === true) return false;
  const system = require("../../space/worldData").getSolarSystemByID(positiveID(systemID));
  if (!system || !require("../sovereignty/sovSystemRules").isSovereigntyClaimableSolarSystem(system)) return false;
  const structureConstants = require("../structure/structureConstants");
  const state = Number(structure.state);
  return Number.isSafeInteger(state) && state !== structureConstants.STRUCTURE_STATE.UNKNOWN &&
    state !== structureConstants.STRUCTURE_STATE.UNANCHORED;
}

function areCorporationsAllied(leftCorporationID, rightCorporationID) {
  const left = positiveID(leftCorporationID);
  const right = positiveID(rightCorporationID);
  if (!left || !right || left === right) return true;
  const leftAllianceID = getAllianceID(left);
  return leftAllianceID > 0 && leftAllianceID === getAllianceID(right);
}

function conflictSideForCorporation(corporationID, conflict) {
  const numericCorporationID = positiveID(corporationID);
  if (!numericCorporationID || !conflict) return -1;
  const exact = conflict.corporationIDs.indexOf(numericCorporationID);
  if (exact >= 0) return exact;
  const allianceID = getAllianceID(numericCorporationID);
  if (!allianceID) return -1;
  const sides = conflict.allianceIDs
    .map((candidate, index) => positiveID(candidate) === allianceID ? index : -1)
    .filter((index) => index >= 0);
  return sides.length === 1 ? sides[0] : -1;
}

function listConflictsInSystem(systemID) {
  const numericSystemID = positiveID(systemID);
  if (!numericSystemID) return [];
  const cached = conflictCache.get(numericSystemID);
  if (cached && cached.expiresAt > Date.now()) return cached.conflicts;
  const structures = require("../../space/worldData").getStructuresForSystem(numericSystemID)
    .filter((structure) => isActiveNullsecStructure(structure, numericSystemID))
    .map((structure) => ({
      structureID: positiveID(structure.structureID || structure.itemID),
      corporationID: positiveID(structure.ownerCorpID || structure.ownerID),
      allianceID: getAllianceID(structure.ownerCorpID || structure.ownerID),
      typeID: positiveID(structure.typeID),
    }))
    .filter((structure) => structure.structureID && structure.corporationID)
    .sort((left, right) => left.corporationID - right.corporationID || left.structureID - right.structureID);
  const conflicts = [];
  const seen = new Set();
  for (let leftIndex = 0; leftIndex < structures.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < structures.length; rightIndex += 1) {
      const left = structures[leftIndex];
      const right = structures[rightIndex];
      if (left.corporationID === right.corporationID ||
          areCorporationsAllied(left.corporationID, right.corporationID)) continue;
      const first = Math.min(left.corporationID, right.corporationID);
      const second = Math.max(left.corporationID, right.corporationID);
      const key = `${first}:${second}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({
        systemID: numericSystemID,
        corporationIDs: [first, second],
        allianceIDs: [getAllianceID(first), getAllianceID(second)],
        structureIDs: structures
          .filter((entry) => entry.corporationID === first || entry.corporationID === second)
          .map((entry) => entry.structureID),
      });
    }
  }
  if (conflictCache.size >= 2048) conflictCache.delete(conflictCache.keys().next().value);
  conflictCache.set(numericSystemID, { expiresAt: Date.now() + CONFLICT_CACHE_MS, conflicts });
  return conflicts;
}

function listConflictsForBot(bot) {
  if (!bot) return [];
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  if (!corporationID) return [];
  const allianceID = getAllianceID(corporationID);
  const structures = require("../structure/structureState").listStructures()
    .filter((structure) => positiveID(structure.ownerCorpID || structure.ownerID) === corporationID ||
      (allianceID > 0 && getAllianceID(structure.ownerCorpID || structure.ownerID) === allianceID))
    .filter((structure) => isActiveNullsecStructure(structure, structure.solarSystemID));
  const conflicts = structures.flatMap((structure) => listConflictsInSystem(structure.solarSystemID));
  const byKey = new Map();
  for (const conflict of conflicts) {
    if (conflictSideForCorporation(corporationID, conflict) < 0) continue;
    byKey.set(`${conflict.systemID}:${conflict.corporationIDs.join(":")}`, conflict);
  }
  return [...byKey.values()].sort((left, right) => left.systemID - right.systemID ||
    left.corporationIDs[1] - right.corporationIDs[1]);
}

function isEligibleTarget(bot, entity, systemID) {
  if (!bot || !entity || !entity.session) return false;
  const targetCharacterID = positiveID(entity.session.characterID || entity.session.charID || entity.session.charid ||
    entity.controllerOwnerID || entity.ownerID || entity.pilotCharacterID || entity.characterID);
  if (!targetCharacterID || targetCharacterID === positiveID(bot.characterID) ||
      positiveID(entity.typeID) === 670) return false;
  const botCharacter = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const ownCorporationID = positiveID(botCharacter.corporationID || bot.corporationID);
  const targetCorporationID = positiveID(entity.corporationID || entity.corpID) || getCharacterCorporation(targetCharacterID);
  if (!ownCorporationID || !targetCorporationID || areCorporationsAllied(ownCorporationID, targetCorporationID)) return false;
  const ownFleet = require("../fleets/fleetRuntime").getFleetForCharacter(bot.characterID);
  const targetFleet = require("../fleets/fleetRuntime").getFleetForCharacter(targetCharacterID);
  if (ownFleet && targetFleet && positiveID(ownFleet.fleetID) === positiveID(targetFleet.fleetID)) return false;
  return listConflictsInSystem(systemID).some((conflict) => {
    const ownSide = conflictSideForCorporation(ownCorporationID, conflict);
    const targetSide = conflictSideForCorporation(targetCorporationID, conflict);
    return ownSide >= 0 && targetSide >= 0 && ownSide !== targetSide;
  });
}

function findNearestConflictBase(bot, maxHops = 24) {
  if (!bot) return { success: false, message: "Playerbot not found." };
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const startSystemID = positiveID(character.solarSystemID);
  if (!startSystemID) return { success: false, message: "Could not determine the bot's current system." };
  const space = require("./playerBotSpaceRuntime");
  const combat = require("./playerBotCombatRuntime");
  const candidates = [];
  for (const conflict of listConflictsForBot(bot)) {
    const bases = combat.getCombatBaseLocations(bot, conflict.systemID);
    const route = space.previewSystemRoute(bot, conflict.systemID);
    if (!route.success || route.hops > maxHops) continue;
    const base = bases.find((location) => location.kind === "structure" &&
      Number(location.ownerCorpID || location.ownerID) === Number(character.corporationID || bot.corporationID)) || bases[0];
    const currentStationID = positiveID(character.stationID || character.structureID);
    const fallbackStationID = currentStationID || require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID;
    const stationID = positiveID(base && (base.stationID || base.itemID)) || fallbackStationID;
    if (!stationID) continue;
    const ownSide = conflictSideForCorporation(positiveID(character.corporationID || bot.corporationID), conflict);
    const structures = conflict.structureIDs
      .map((structureID) => worldData.getStructureByID(structureID))
      .filter((structure) => structure && conflictSideForCorporation(
        positiveID(structure.ownerCorpID || structure.ownerID), conflict,
      ) === ownSide)
      .sort((left, right) => positiveID(left.structureID || left.itemID) - positiveID(right.structureID || right.itemID));
    candidates.push({
      success: true,
      mode: "nullsec-conflict",
      systemID: conflict.systemID,
      stationID,
      patrolEntityID: positiveID(structures[0] && (structures[0].structureID || structures[0].itemID)),
      conflict,
      hops: route.hops,
      risk: route.risk || null,
    });
  }
  candidates.sort((left, right) => left.hops - right.hops || left.systemID - right.systemID);
  return candidates[0] || { success: false, message: "No reachable null-sec system has deployed structures owned by two unallied player corporations." };
}

function hasOnlineConflictOpponent(bot, systemID = 0) {
  const own = positiveID((require("../character/characterState").getCharacterRecord(bot && bot.characterID) || {}).corporationID || bot && bot.corporationID);
  const sessions = require("../chat/sessionRegistry").getSessions();
  const systems = systemID ? [positiveID(systemID)] : listConflictsForBot(bot).map((entry) => entry.systemID);
  for (const candidateSystemID of systems) {
    const conflicts = listConflictsInSystem(candidateSystemID);
    for (const session of sessions) {
      const characterID = positiveID(session && (session.characterID || session.charID || session.charid));
      if (!characterID || characterID === positiveID(bot && bot.characterID)) continue;
      const character = require("../character/characterState").getCharacterRecord(characterID) || {};
      const targetCorporationID = positiveID(session.corporationID || session.corpid || character.corporationID);
      if (positiveID(character.solarSystemID) !== candidateSystemID ||
          positiveID(character.stationID || character.structureID) ||
          positiveID(character.shipTypeID || session.shipTypeID) === 670) continue;
      if (!conflicts.some((conflict) => {
        const ownSide = conflictSideForCorporation(own, conflict);
        const targetSide = conflictSideForCorporation(targetCorporationID, conflict);
        return ownSide >= 0 && targetSide >= 0 && ownSide !== targetSide;
      })) continue;
      if (isEligibleTarget(bot, {
        kind: "ship",
        typeID: Number(character.shipTypeID || session.shipTypeID) || 0,
        corporationID: targetCorporationID,
        session,
      }, candidateSystemID)) return true;
    }
  }
  return false;
}

module.exports = {
  areCorporationsAllied,
  findNearestConflictBase,
  isActiveNullsecStructure,
  isEligibleTarget,
  hasOnlineConflictOpponent,
  listConflictsForBot,
  listConflictsInSystem,
};

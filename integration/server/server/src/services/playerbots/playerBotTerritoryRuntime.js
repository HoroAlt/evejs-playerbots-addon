"use strict";

// A corporation's powered, accessible Upwell structure is its operating base,
// including while rival structures are anchoring in the same null-sec system.
// In that case keep the work at the owned base instead of expanding outward.

const worldData = require("../../space/worldData");

function positiveID(value) {
  const id = Math.trunc(Number(value));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function getCorporationContext(bot) {
  const character = require("../character/characterState").getCharacterRecord(bot && bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot && bot.corporationID);
  const corporation = corporationID
    ? require("../corporation/corporationState").getCorporationRecord(corporationID) || {}
    : {};
  return { character, corporationID, allianceID: positiveID(corporation.allianceID || character.allianceID) };
}

function hasActiveCorporationWar(bot) {
  try {
    const wars = require("../corporation/warRuntimeState");
    return typeof wars.hasActiveWarForCharacter === "function" && wars.hasActiveWarForCharacter(bot.characterID);
  } catch (_) {
    // If war state is unavailable, do not send workers into a contested region.
    return true;
  }
}

function liveStructuresInSystem(systemID) {
  return require("../structure/structureState").listStructures()
    .filter((structure) => positiveID(structure && structure.solarSystemID) === positiveID(systemID))
    .filter((structure) => !structure.destroyedAt && !structure.unanchoring);
}

function systemIsContested(systemID, corporationID, allianceID) {
  const corps = require("../corporation/corporationState");
  return liveStructuresInSystem(systemID).some((structure) => {
    const ownerCorpID = positiveID(structure.ownerCorpID || structure.ownerID);
    if (!ownerCorpID || ownerCorpID === corporationID) return false;
    const owner = corps.getCorporationRecord(ownerCorpID) || {};
    const ownerAllianceID = positiveID(owner.allianceID || structure.allianceID);
    return !allianceID || ownerAllianceID !== allianceID;
  });
}

function systemAllianceID(systemID) {
  try {
    return positiveID(require("../sovereignty/sovState").getSystemState(positiveID(systemID))?.allianceID);
  } catch (_) {
    return 0;
  }
}

function isRouteWithinFriendlyTerritory(route, allianceID, allowedUnclaimedNullSystems = [], options = {}) {
  if (!route || route.success !== true || !Array.isArray(route.systemIDs)) return false;
  const risk = route.risk || {};
  if (options.allowLowsecTransit !== true && (risk.lowsecSystemIDs || []).length) return false;
  const permittedNullSystems = new Set(allowedUnclaimedNullSystems.map(positiveID).filter(Boolean));
  return route.systemIDs.every((systemID) => {
    const system = worldData.getSolarSystemByID(positiveID(systemID)) || {};
    const security = Number(system.security ?? system.securityStatus ?? system.trueSecurity);
    const ownerAllianceID = systemAllianceID(systemID);
    if (security > 0 || (ownerAllianceID > 0 && ownerAllianceID === allianceID) ||
        permittedNullSystems.has(positiveID(systemID))) return true;
    // Getting to a corporation's own null-sec base can require crossing
    // unclaimed null-sec systems. The route chooser already minimizes risk;
    // never use this exception to cross another alliance's claimed systems.
    return options.allowUnclaimedNullTransit === true && security <= 0 && ownerAllianceID === 0;
  });
}

function canDockAtOwnedStructure(bot, structure) {
  try {
    const space = require("./playerBotSpaceRuntime");
    const session = space.getActorSession(bot);
    const state = require("../structure/structureState");
    if (!session || !state.isDockingServiceOnline(structure)) return false;
    const access = state.canCharacterDockAtStructure(session, structure, {
      shipTypeID: positiveID(session.shipTypeID) || undefined,
    });
    return Boolean(access && access.success === true);
  } catch (_) {
    return false;
  }
}

function operationalCorporationStructures(bot, context) {
  const state = require("../structure/structureState");
  const space = require("./playerBotSpaceRuntime");
  return state.listStructures()
    .filter((structure) => positiveID(structure.ownerCorpID || structure.ownerID) === context.corporationID)
    .filter((structure) => structure.hasQuantumCore === true && !structure.destroyedAt && !structure.unanchoring)
    .filter((structure) => state.isDockingServiceOnline(structure))
    .filter((structure) => isRouteWithinFriendlyTerritory(
      space.previewSystemRoute(bot, positiveID(structure.solarSystemID)),
      context.allianceID,
      [positiveID(structure.solarSystemID)],
      { allowLowsecTransit: true, allowUnclaimedNullTransit: true },
    ))
    .filter((structure) => canDockAtOwnedStructure(bot, structure))
}

function currentCorporationBases(structures, context) {
  return structures
    .filter((structure) => (worldData.getAsteroidBeltsForSystem(positiveID(structure.solarSystemID)) || []).length > 0)
    .map((structure) => ({
      stationID: positiveID(structure.structureID),
      systemID: positiveID(structure.solarSystemID),
      structureID: positiveID(structure.structureID),
      anchorSystemID: positiveID(structure.solarSystemID),
      anchorHops: 0,
      baseKind: "corporation-structure",
      security: Number((worldData.getSolarSystemByID(positiveID(structure.solarSystemID)) || {}).security) || 0,
      contested: systemIsContested(
        structure.solarSystemID, context.corporationID, context.allianceID,
      ),
    }));
}

function adjacentStationBases(bot, context, anchorSystemIDs) {
  const bases = [];
  const space = require("./playerBotSpaceRuntime");
  const seen = new Set();
  for (const anchorSystemID of anchorSystemIDs) {
    for (const gate of worldData.getStargatesForSystem(anchorSystemID) || []) {
      const paired = worldData.getStargateByID(gate.destinationID);
      const systemID = positiveID(gate.destinationSolarSystemID || paired && paired.solarSystemID);
      if (!systemID || seen.has(systemID)) continue;
      seen.add(systemID);
      const system = worldData.getSolarSystemByID(systemID) || {};
      const allianceOwnerID = systemAllianceID(systemID);
      if (Number(system.security) <= 0 && (!context.allianceID || allianceOwnerID !== context.allianceID)) continue;
      if (allianceOwnerID && allianceOwnerID !== context.allianceID) continue;
      if (systemIsContested(systemID, context.corporationID, context.allianceID)) continue;
      if (!(worldData.getAsteroidBeltsForSystem(systemID) || []).length) continue;
      const route = space.previewSystemRoute(bot, systemID);
      if (!isRouteWithinFriendlyTerritory(route, context.allianceID)) continue;
      const stations = (worldData.getStationsForSystem(systemID) || [])
        .map((station) => ({ station, stationID: positiveID(station.stationID || station.itemID) }))
        .filter(({ stationID }) => stationID && !require("./playerBotEconomyRuntime").isJitaStation(stationID))
        .sort((left, right) => left.stationID - right.stationID);
      for (const { station, stationID } of stations) {
        bases.push({
          stationID,
          systemID,
          structureID: 0,
          anchorSystemID,
          anchorHops: 1,
          baseKind: "nearby-station",
          security: Number(system.security) || 0,
          routeHops: Number(route.hops) || 0,
          stationName: String(station.stationName || station.name || ""),
        });
      }
    }
  }
  return bases;
}

function findTerritorialMiningBase(bot) {
  if (!bot || !positiveID(bot.characterID)) return null;
  const context = getCorporationContext(bot);
  if (!context.corporationID) return null;
  const operationalStructures = operationalCorporationStructures(bot, context);
  if (!operationalStructures.length) return null;
  const structures = currentCorporationBases(operationalStructures, context);
  // A live own structure is an anchor for local production even in a contested
  // system or during a wardec. War and rival anchors stop expansion to adjacent
  // systems; they must not make the corporation abandon its own station.
  if (structures.length) return structures.sort((left, right) =>
    Number(left.contested) - Number(right.contested) ||
    Number(right.security >= 0.45) - Number(left.security >= 0.45) ||
    left.systemID - right.systemID || left.stationID - right.stationID)[0];
  if (hasActiveCorporationWar(bot) || operationalStructures.some((structure) =>
    systemIsContested(structure.solarSystemID, context.corporationID, context.allianceID))) return null;
  const structureSystemIDs = [...new Set(operationalStructures.map((structure) => positiveID(structure.solarSystemID)))];
  const nearby = adjacentStationBases(bot, context, structureSystemIDs);
  return nearby.sort((left, right) =>
    Number(right.security >= 0.45) - Number(left.security >= 0.45) ||
    Number(left.routeHops || 0) - Number(right.routeHops || 0) ||
    left.systemID - right.systemID || left.stationID - right.stationID)[0] || null;
}

module.exports = {
  findTerritorialMiningBase,
  _testing: {
    positiveID,
    isRouteWithinFriendlyTerritory,
    systemAllianceID,
    systemIsContested,
  },
};

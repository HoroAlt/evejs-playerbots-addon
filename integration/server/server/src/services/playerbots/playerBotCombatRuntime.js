"use strict";

const worldData = require("../../space/worldData");
const combatPolicy = require("./playerBotCombatPolicy");
const combatDecision = require("./playerBotCombatDecisionRuntime");

const HUB_STATION_ID = require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID;

// Piracy and war patrols may target other playerbots under the same
// Crimewatch and war rules as human targets. EVEJS_PLAYER_BOTS_BOT_VERSUS_BOT=0
// keeps playerbots off each other's target lists.
function botVersusBotCombatEnabled() {
  return String(process.env.EVEJS_PLAYER_BOTS_BOT_VERSUS_BOT ?? "1").trim() !== "0";
}
const WARP_RANGE_METERS = 50_000;
const APPROACH_RANGE_METERS = 15_000;
const DRONE_ATTACK_RANGE_METERS = 15_000;
const MAX_TRIP_MS = 15 * 60 * 1000;
const MAX_SITE_TRIP_MS = 2 * 60 * 60 * 1000;
const MAX_KILLS_PER_TRIP = 5;
const EMPTY_SYSTEM_GRACE_MS = 90_000;
const WRECK_APPEARANCE_GRACE_MS = 30_000;
const COMBAT_SITE_CACHE_MS = 15_000;
const FAILED_SITE_COOLDOWN_MS = 60 * 60 * 1000;
const combatSiteCache = new Map();
const combatBaseCache = new Map();

function selectAvailableAnomaly(candidates, bot, excludedSiteInstanceIDs = []) {
  const capacity = require("./playerBotCapacityRuntime");
  const controlled = capacity.getHumanControlledBotIDs();
  const characterID = Number(bot.characterID);
  const excludedSites = new Set((Array.isArray(excludedSiteInstanceIDs) ? excludedSiteInstanceIDs : [])
    .map(normalizeID).filter(Boolean));
  const loads = new Map();
  const add = (systemID, pilotID) => {
    const id = normalizeID(systemID);
    if (!id || pilotID === characterID || controlled.has(pilotID)) return;
    if (!loads.has(id)) loads.set(id, new Set());
    loads.get(id).add(pilotID);
  };
  for (const pilot of require("./playerBotRuntime").listBots()) {
    add(capacity.getBotSystemID(pilot), Number(pilot.characterID));
  }
  const claims = new Set();
  for (const operation of require("./playerBotOperationRecords").listReadOnlyActiveOperations(require("./playerBotOperationRuntime"))) {
    const pilotID = Number(operation.characterID);
    if (pilotID === characterID) continue;
    if (operation.kind === "combat" && operation.siteCompleted !== true) {
      if (Number(operation.siteInstanceID) > 0) claims.add(Number(operation.siteInstanceID));
      if (!["to-market", "market-sell", "corp-share"].includes(operation.stage)) {
        add(operation.targetSystemID, pilotID);
      }
    }
  }
  const limit = capacity.getMaxAutonomousBotsPerSystem();
  const dungeon = require("../dungeon/dungeonRuntime");
  return candidates.find((candidate) => {
    if (excludedSites.has(Number(candidate.siteInstanceID))) return false;
    if (claims.has(Number(candidate.siteInstanceID))) return false;
    if (!controlled.has(characterID) && (loads.get(Number(candidate.systemID))?.size || 0) >= limit) return false;
    const site = dungeon.getInstance(Number(candidate.siteInstanceID));
    return site && String(site.lifecycleState || "").toLowerCase() === "active";
  }) || null;
}

function normalizeID(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function getCurrentSystemID(bot) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  return normalizeID(character.solarSystemID);
}

function getCombatBaseLocations(bot, systemID) {
  const locations = worldData.getStationsForSystem(systemID)
    .map((station) => ({ ...station, stationID: normalizeID(station.stationID || station.itemID), kind: "station" }))
    .filter((station) => station.stationID > 0);
  const space = require("./playerBotSpaceRuntime");
  let session;
  try { session = space.getActorSession(bot); } catch (_) { session = null; }
  if (session) {
    const structureState = require("../structure/structureState");
    for (const structure of worldData.getStructuresForSystem(systemID)) {
      if (!structure || Number(structure.destroyedAt) > 0 || Number(structure.unanchoring) > 0) continue;
      const docking = structureState.canCharacterDockAtStructure(session, structure, {
        shipTypeID: Number(session.shipTypeID) || 0,
      });
      if (docking && docking.success) {
        locations.push({ ...structure, stationID: normalizeID(structure.structureID || structure.itemID), kind: "structure" });
      }
    }
  }
  return locations.sort((left, right) => left.stationID - right.stationID);
}

// NPC repair can rescue a combat hull whose selected Upwell base no longer
// offers repair (or was made private after the operation was created). Pick
// the nearest reachable NPC station that has both services this operation
// needs next: repair and market access for its loot return leg.
function findNearestRepairStation(bot, maxHops = 64, options = {}) {
  const startSystemID = getCurrentSystemID(bot);
  if (!startSystemID) return { success: false, message: "Could not determine the bot's current system." };
  // Use EveJS's station authority. The NPC structure-directory service list
  // depends on the optional stationOperations SDE file, which may be absent
  // in a supported server install even though NPC station repair and market
  // services remain enabled by stationStaticData.
  const stationStaticData = require("../_shared/stationStaticData");
  const serviceIDs = new Map(stationStaticData.getStationServiceIdentifiers()
    .map((service) => [String(service.serviceName || "").toLowerCase(), Number(service.serviceID) || 0]));
  const marketServiceID = serviceIDs.get("market") || 0;
  const repairServiceID = serviceIDs.get("repair facilities") || 0;
  const jitaSystemID = options.excludeJita === true
    ? Number(require("./playerBotEconomyRuntime").JITA_SYSTEM_ID) || 30000142
    : 0;
  if (!marketServiceID || !repairServiceID) {
    return { success: false, message: "EveJS NPC station market and repair service IDs are unavailable." };
  }
  const queue = [{ systemID: startSystemID, hops: 0 }];
  const seen = new Set([startSystemID]);
  const space = require("./playerBotSpaceRuntime");

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const stations = worldData.getStationsForSystem(current.systemID)
      .filter((station) => {
        if (jitaSystemID > 0 && Number(current.systemID) === jitaSystemID) return false;
        const stationID = normalizeID(station.stationID || station.itemID);
        if (!stationID) return false;
        const services = new Set(stationStaticData.getStationServiceStates(null, stationID)
          .filter((service) => Number(service.isEnabled) === 1)
          .map((service) => Number(service.serviceID)));
        return services.has(repairServiceID) && services.has(marketServiceID);
      })
      .sort((left, right) => normalizeID(left.stationID || left.itemID) -
        normalizeID(right.stationID || right.itemID));
    if (stations.length) {
      const route = space.previewSystemRoute(bot, current.systemID);
      const routeHops = Number.isFinite(Number(route.hops)) ? Number(route.hops) : current.hops;
      if (route.success && routeHops <= maxHops) {
        const station = stations[0];
        return {
          success: true,
          stationID: normalizeID(station.stationID || station.itemID),
          systemID: current.systemID,
          stationName: String(station.stationName || station.name || "NPC repair station"),
          hops: routeHops,
          risk: route.risk || null,
        };
      }
    }
    if (current.hops >= maxHops) continue;
    const gates = worldData.getStargatesForSystem(current.systemID)
      .sort((left, right) => normalizeID(left.itemID) - normalizeID(right.itemID));
    for (const gate of gates) {
      const paired = worldData.getStargateByID(gate.destinationID);
      const nextSystemID = normalizeID(gate.destinationSolarSystemID) ||
        normalizeID(paired && paired.solarSystemID);
      if (!nextSystemID || seen.has(nextSystemID)) continue;
      seen.add(nextSystemID);
      queue.push({ systemID: nextSystemID, hops: current.hops + 1 });
    }
  }
  return { success: false, message: `No reachable NPC station with both repair and market services was found within ${maxHops} jumps.` };
}

function retargetCombatRepairBase(operation, repairStation) {
  const stationID = normalizeID(repairStation && repairStation.stationID);
  const systemID = normalizeID(repairStation && repairStation.systemID);
  if (!operation || !stationID || !systemID) return false;
  const previousHomeStationID = normalizeID(operation.homeStationID);
  if (previousHomeStationID === stationID) return false;
  operation.repairFallbackFromStationID = previousHomeStationID || null;
  operation.repairFallbackStationID = stationID;
  operation.repairFallbackSystemID = systemID;
  operation.homeStationID = stationID;
  const economy = require("./playerBotEconomyRuntime");
  if (!normalizeID(operation.marketStationID) ||
      normalizeID(operation.marketStationID) === previousHomeStationID ||
      economy.isJitaStation(operation.marketStationID)) {
    operation.marketStationID = stationID;
  }
  operation.routeTaskID = null;
  return true;
}

function retargetCombatInaccessibleStructure(operation, bot, kit) {
  if (!operation || !["to-home", "return", "to-market", "market-sell", "corp-share"].includes(operation.stage)) {
    return null;
  }
  const stationIDs = [...new Set([
    normalizeID(operation.homeStationID),
    normalizeID(operation.marketStationID),
  ].filter(Boolean))];
  if (typeof worldData.getStructureByID !== "function") return null;
  const inaccessible = [];
  const structureState = require("../structure/structureState");
  const session = kit.space.getActorSession(bot);
  for (const stationID of stationIDs) {
    const structure = worldData.getStructureByID(stationID);
    if (!structure) continue;
    const access = structureState.canCharacterDockAtStructure(session, structure, {
      shipTypeID: Number(session.shipTypeID) || 0,
    });
    if (!access || access.success !== true) inaccessible.push({ stationID, access });
  }
  if (!inaccessible.length) return null;

  const repairStation = findNearestRepairStation(bot, 64, { excludeJita: true });
  if (!repairStation.success) {
    return kit.block(operation, "holding",
      `Structure docking or market access was revoked for ${inaccessible.map((entry) => entry.stationID).join(", ")}; ${repairStation.message} Keeping the ship at a safe checkpoint until a permitted repair-and-market base is reachable.`);
  }
  const previousHomeStationID = normalizeID(operation.homeStationID);
  const inaccessibleIDs = new Set(inaccessible.map((entry) => entry.stationID));
  operation.repairFallbackFromStationID = previousHomeStationID || inaccessible[0].stationID;
  operation.repairFallbackStationID = repairStation.stationID;
  operation.repairFallbackSystemID = repairStation.systemID;
  operation.homeStationID = repairStation.stationID;
  if (!normalizeID(operation.marketStationID) || inaccessibleIDs.has(normalizeID(operation.marketStationID)) ||
      normalizeID(operation.marketStationID) === previousHomeStationID) {
    operation.marketStationID = repairStation.stationID;
  }
  operation.routeTaskID = null;
  record(operation, kit,
    `Structure access was revoked for ${inaccessible.map((entry) => entry.stationID).join(", ")}; rerouting to permitted NPC repair-and-market station ${repairStation.stationName} (${repairStation.stationID}) in system ${repairStation.systemID}${repairStation.hops ? ` (${repairStation.hops} jumps)` : ""}.`);
  return { delayMs: 5_000, accessRouted: true };
}

function getTerritoryPriority(bot, systemID) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = normalizeID(character.corporationID || bot.corporationID);
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  const allianceID = normalizeID(corporation.allianceID || character.allianceID);
  const structures = worldData.getStructuresForSystem(systemID)
    .filter((structure) => structure && !structure.destroyedAt && !structure.unanchoring);
  const ownStructure = structures.some((structure) => Number(structure.ownerCorpID || structure.ownerID) === corporationID);
  const alliedStructure = allianceID > 0 && structures.some((structure) => Number(structure.allianceID) === allianceID);
  let sovAllianceID = 0;
  try { sovAllianceID = normalizeID(require("../sovereignty/sovState").getSystemState(systemID)?.allianceID); }
  catch (_) { sovAllianceID = 0; }
  const system = worldData.getSolarSystemByID(systemID) || {};
  const nullsec = Number(system.security) <= 0;
  if (nullsec && ownStructure) return 0;
  if (nullsec && alliedStructure) return 1;
  if (nullsec && allianceID > 0 && sovAllianceID === allianceID) return 2;
  if (nullsec) return 3;
  if (ownStructure) return 4;
  if (alliedStructure) return 5;
  return 6;
}

const PATROL_ROTATION_TABLE = "playerBots";
const PATROL_ROTATION_PATH = "/_patrolRotation";
const PATROL_ROUTE_PREVIEW_LIMIT = 3;
let patrolRotationRepo = null;

function getPatrolRotationRepo() {
  if (!patrolRotationRepo) {
    patrolRotationRepo = require("../../gameStore/tableRepository")
      .createTableRepository("service:playerbots", { strict: true });
  }
  return patrolRotationRepo;
}

function isPatrolRotationEnabled() {
  return process.env.EVEJS_PLAYER_BOTS_PATROL_ROTATION !== "0";
}

// Rotation memory is advisory: an unreadable ledger only means the next
// choice is made without history.
function readPatrolLedger() {
  try {
    const repo = getPatrolRotationRepo();
    repo.ensureTable(PATROL_ROTATION_TABLE);
    const result = repo.read(PATROL_ROTATION_TABLE, PATROL_ROTATION_PATH);
    return result && result.success && result.data && typeof result.data === "object" ? result.data : null;
  } catch (_) {
    return null;
  }
}

function recordPatrolDeployment(operation) {
  if (!operation || !isPatrolRotationEnabled()) return false;
  const systemID = normalizeID(operation.targetSystemID);
  if (!systemID || !operation.operationID) return false;
  try {
    const rotation = require("./playerBotPatrolRotation");
    const next = rotation.recordDeployment(readPatrolLedger(), {
      operationID: operation.operationID,
      systemID,
      characterID: operation.characterID,
      corporationID: operation.corporationID,
      mode: operation.mode,
      atMs: Date.now(),
    });
    const repo = getPatrolRotationRepo();
    repo.ensureTable(PATROL_ROTATION_TABLE);
    return repo.write(PATROL_ROTATION_TABLE, PATROL_ROTATION_PATH, next).success === true;
  } catch (_) {
    return false;
  }
}

// Active piracy and security patrols per destination system.
function countPatrolPresenceBySystem(excludeCharacterID = 0) {
  const presence = new Map();
  try {
    const operations = require("./playerBotOperationRuntime");
    const active = typeof operations.listActiveOperationRecords === "function"
      ? operations.listActiveOperationRecords() : operations.listActiveOperations();
    for (const operation of active || []) {
      if (!operation || operation.kind !== "combat" || !["piracy", "security"].includes(operation.mode)) continue;
      if (Number(operation.characterID) === Number(excludeCharacterID)) continue;
      const systemID = normalizeID(operation.targetSystemID);
      if (systemID) presence.set(systemID, (presence.get(systemID) || 0) + 1);
    }
  } catch (_) {
    presence.clear();
  }
  return presence;
}

// Breadth-first search for pirate systems with a base station and belts. Hop
// counts come from the search itself; routes are previewed only for the
// destination that is finally chosen.
function listPirateBaseCandidates(bot, maxHops = 64, options = {}) {
  const rotation = require("./playerBotPatrolRotation");
  const limit = Math.max(1, Math.trunc(Number(options.maxCandidates) || rotation.DEFAULTS.maxCandidates));
  const extraHops = Math.max(0, Math.trunc(Number(options.extraHopsBeyondNearest ?? rotation.DEFAULTS.extraHopsBeyondNearest)));
  const startSystemID = getCurrentSystemID(bot);
  if (!startSystemID) return { success: false, candidates: [], message: "Could not determine the bot's current system." };
  const queue = [{ systemID: startSystemID, hops: 0 }];
  const seen = new Set([startSystemID]);
  const piratePolicy = require("../../space/npc/pirateFactionPolicy");
  const candidates = [];
  let nearestHops = null;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (nearestHops !== null && current.hops > nearestHops + extraHops) break;
    const system = worldData.getSolarSystemByID(current.systemID);
    if (system && Number(system.security) <= 0 && !piratePolicy.isSpecialSpaceSystem(current.systemID, system) &&
        !piratePolicy.isWormholeSpaceSystem(current.systemID)) {
      const faction = piratePolicy.resolvePirateFactionForSystem(current.systemID);
      const station = getCombatBaseLocations(bot, current.systemID)[0];
      const belts = worldData.getAsteroidBeltsForSystem(current.systemID) || [];
      if (faction.supportedLocalFaction && station && belts.length) {
        candidates.push({
          systemID: current.systemID,
          stationID: normalizeID(station.stationID || station.itemID),
          hops: current.hops,
          factionKey: faction.factionKey,
        });
        if (nearestHops === null) nearestHops = current.hops;
        if (candidates.length >= limit) break;
      }
    }
    if (current.hops >= maxHops) continue;
    const gates = worldData.getStargatesForSystem(current.systemID)
      .sort((left, right) => normalizeID(left.itemID) - normalizeID(right.itemID));
    for (const gate of gates) {
      const paired = worldData.getStargateByID(gate.destinationID);
      const nextSystemID = normalizeID(gate.destinationSolarSystemID) || normalizeID(paired && paired.solarSystemID);
      if (!nextSystemID || seen.has(nextSystemID)) continue;
      seen.add(nextSystemID);
      queue.push({ systemID: nextSystemID, hops: current.hops + 1 });
    }
  }
  return { success: true, candidates };
}

function findNearestPirateBase(bot, maxHops = 64) {
  const space = require("./playerBotSpaceRuntime");
  const rotationEnabled = isPatrolRotationEnabled();
  const listed = listPirateBaseCandidates(bot, maxHops, rotationEnabled ? {} : { maxCandidates: 1 });
  if (!listed.success) return { success: false, message: listed.message };
  const noRegion = { success: false, message: "No reachable null-sec pirate region with an NPC station and asteroid belts was found." };
  if (!listed.candidates.length) return noRegion;
  let ranked = listed.candidates;
  if (rotationEnabled && listed.candidates.length > 1) {
    const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
    const choice = require("./playerBotPatrolRotation").choosePatrolSystem({
      candidates: listed.candidates,
      characterID: bot.characterID,
      corporationID: character.corporationID || bot.corporationID,
      nowMs: Date.now(),
      presenceBySystem: countPatrolPresenceBySystem(bot.characterID),
      ledger: readPatrolLedger(),
    });
    if (!choice.chosen) {
      return { success: false, message: "No reachable null-sec pirate region is below its patrol limit; all reachable pirate systems already have enough patrols." };
    }
    ranked = choice.ranked;
  }
  for (const candidate of ranked.slice(0, PATROL_ROUTE_PREVIEW_LIMIT)) {
    const route = space.previewSystemRoute(bot, candidate.systemID);
    if (!route.success) continue;
    return {
      success: true,
      systemID: candidate.systemID,
      stationID: candidate.stationID,
      hops: route.hops,
      risk: route.risk,
      factionKey: candidate.factionKey,
    };
  }
  return noRegion;
}

function findNearestWarBase(bot, maxHops = 20) {
  const space = require("./playerBotSpaceRuntime");
  const startSystemID = getCurrentSystemID(bot);
  if (!startSystemID) return { success: false, message: "Could not determine the bot's current system." };
  const managedIDs = new Set(require("./playerBotRuntime").listBots()
    .map((entry) => Number(entry.characterID) || 0));
  const wars = require("../corporation/warRuntimeState");
  const characterState = require("../character/characterState");
  const sessions = require("../chat/sessionRegistry").getSessions();
  const candidates = [];
  for (const session of sessions) {
    const characterID = normalizeID(session && (session.characterID || session.charID || session.charid));
    if (!characterID || characterID === Number(bot.characterID) || managedIDs.has(characterID) ||
        !wars.areCharactersLegalWarOpponents(bot.characterID, characterID)) continue;
    const systemID = normalizeID((characterState.getCharacterRecord(characterID) || {}).solarSystemID);
    if (!systemID || !(worldData.getAsteroidBeltsForSystem(systemID) || []).length) continue;
    const stationID = worldData.getStationsForSystem(systemID)
      .map((station) => normalizeID(station.stationID || station.itemID))
      .filter(Boolean)
      .sort((left, right) => left - right)[0];
    if (!stationID) continue;
    const route = space.previewSystemRoute(bot, systemID);
    if (!route.success || route.hops > maxHops) continue;
    candidates.push({ success: true, mode: "war", systemID, stationID,
      opponentCharacterID: characterID, hops: route.hops, risk: route.risk });
  }
  candidates.sort((left, right) => left.hops - right.hops ||
    left.opponentCharacterID - right.opponentCharacterID || left.stationID - right.stationID);
  return candidates[0] || {
    success: false,
    message: "No reachable online legal war opponent is currently in a system with a station and asteroid belt.",
  };
}

function resolveSiteFactionKey(instance, template = null) {
  const direct = String(instance && (instance.factionKey || instance.siteFactionKey) ||
    template && (template.factionKey || template.siteFactionKey) ||
    instance && instance.metadata && instance.metadata.factionKey || "").toLowerCase();
  if (/angel/.test(direct)) return "angels";
  if (/blood/.test(direct)) return "blood";
  if (/gurista/.test(direct)) return "guristas";
  if (/sansha/.test(direct)) return "sanshas";
  if (/serpent/.test(direct)) return "serpentis";
  if (/drone/.test(direct)) return "rogue_drones";
  const factionID = normalizeID(instance && instance.factionID || template && template.factionID);
  const byFactionID = require("../../space/npc/pirateFactionPolicy").PIRATE_FACTION_BY_FACTION_ID[factionID];
  if (byFactionID) return byFactionID;
  const label = `${instance && instance.metadata && instance.metadata.label || ""} ${template && (template.resolvedName || template.name || template.templateID) || ""}`.toLowerCase();
  if (label.includes("angel")) return "angels";
  if (label.includes("blood")) return "blood";
  if (label.includes("gurista")) return "guristas";
  if (label.includes("sansha")) return "sanshas";
  if (label.includes("serpent")) return "serpentis";
  if (label.includes("drone")) return "rogue_drones";
  return "";
}

function resolveSiteDifficulty(instance, template = null) {
  const values = [
    instance && instance.difficulty,
    instance && instance.siteDifficulty,
    instance && instance.metadata && instance.metadata.difficulty,
    template && template.difficulty,
    template && template.siteDifficulty,
  ];
  for (const value of values) {
    const numeric = Math.trunc(Number(value));
    if (Number.isFinite(numeric) && numeric > 0) return Math.min(5, numeric);
    const match = String(value || "").match(/(?:tier|level|difficulty)[^0-9]{0,8}(\d+)/i);
    if (match) return Math.min(5, Math.max(1, Number(match[1])));
  }
  return 1;
}

function listCombatAnomaliesInSystem(systemID) {
  const numericSystemID = normalizeID(systemID);
  if (!numericSystemID) return [];
  const cached = combatSiteCache.get(numericSystemID);
  if (cached && cached.expiresAt > Date.now()) return cached.sites;
  const runtime = require("../dungeon/dungeonRuntime");
  const authority = require("../dungeon/dungeonAuthority");
  const sites = runtime.listActiveInstancesBySystem(numericSystemID, { full: true })
    .map((instance) => {
      const template = authority.getTemplateByIDReadOnly(instance.templateID) || null;
      return { instance, template };
    })
    .filter(({ instance, template }) => combatDecision.isPublicCombatAnomaly(instance, template))
    .map(({ instance, template }) => ({
      ...instance,
      template,
      factionKey: resolveSiteFactionKey(instance, template),
      difficulty: resolveSiteDifficulty(instance, template),
      capitalOrCommanderThreat: instance.capitalOrCommanderThreat === true ||
        template && template.capitalOrCommanderThreat === true,
      siteID: normalizeID(instance.metadata && instance.metadata.siteID),
      label: String(instance.metadata && instance.metadata.label || template && template.resolvedName || instance.templateID || "Combat Anomaly"),
    }));
  combatSiteCache.set(numericSystemID, { expiresAt: Date.now() + COMBAT_SITE_CACHE_MS, sites });
  return sites;
}

function findNearestCombatAnomalyBase(bot, fitProfile, maxHops = 20, options = {}) {
  if (!fitProfile || !(Number(fitProfile.maxSiteDifficulty) > 0)) {
    return { success: false, message: "The active hull has no validated combat-anomaly fit tier." };
  }
  const startSystemID = getCurrentSystemID(bot);
  if (!startSystemID) return { success: false, message: "Could not determine the bot's current system." };
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = normalizeID(character.corporationID || bot.corporationID);
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  const allianceID = normalizeID(corporation.allianceID || character.allianceID);
  const cacheKey = JSON.stringify([
    startSystemID,
    corporationID,
    allianceID,
    maxHops,
    Number(fitProfile.maxSiteDifficulty) || 0,
    Number(fitProfile.maxWaveHostiles) || 0,
    Number(fitProfile.maxWaveThreatScore) || 0,
    Number(fitProfile.maxSiteWaves) || 0,
    fitProfile.shieldResistances || {},
    fitProfile.droneDamageTypeByID || {},
  ]);
  const targetDifficulty = normalizeID(options.targetDifficulty);
  const limitCandidatesToTargetTier = (candidates) => targetDifficulty
    ? candidates.filter((candidate) => candidate.siteDifficulty <=
      Math.min(targetDifficulty, Number(fitProfile.maxSiteDifficulty) || targetDifficulty))
    : candidates;
  const cached = combatBaseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const eligible = limitCandidatesToTargetTier(cached.candidates);
    return selectAvailableAnomaly(eligible, bot, options.excludedSiteInstanceIDs) || {
      success: false,
      message: targetDifficulty
        ? `No unclaimed combat anomaly at or below the next proven tier ${targetDifficulty} is reachable.`
        : "All reachable combat anomalies are claimed or their systems are full.",
    };
  }
  const queue = [{ systemID: startSystemID, hops: 0 }];
  const seen = new Set([startSystemID]);
  const candidates = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const system = worldData.getSolarSystemByID(current.systemID);
    const stations = getCombatBaseLocations(bot, current.systemID);
    if (stations.length) {
      for (const site of listCombatAnomaliesInSystem(current.systemID)) {
        const eligibility = combatDecision.siteEligibility({
          supported: true,
          difficulty: site.difficulty,
          factionKey: site.factionKey,
          populationHints: site.template && site.template.populationHints,
          capitalOrCommanderThreat: site.capitalOrCommanderThreat,
          requireKnownNpcProfile: true,
        }, fitProfile);
        if (!eligibility.eligible) continue;
        const route = require("./playerBotSpaceRuntime").previewSystemRoute(bot, current.systemID);
        if (!route.success) continue;
        candidates.push({
          success: true,
          mode: "anomaly",
          stationID: normalizeID(stations[0].stationID || stations[0].itemID),
          systemID: current.systemID,
          siteInstanceID: normalizeID(site.instanceID),
          siteID: normalizeID(site.siteID),
          siteDifficulty: eligibility.difficulty,
          encounterLoad: eligibility.encounterLoad,
          siteFactionKey: site.factionKey,
          siteLabel: site.label,
          sitePosition: site.position,
          combatDroneTypeID: eligibility.selectedDroneTypeID,
          combatDroneDamageType: eligibility.selectedDroneDamageType,
          // Keep the full validated flight deployed. The preferred drone is
          // present for the faction's weakest resistance, while its mixed
          // damage mates keep the whole flight's DPS rather than leaving a
          // single drone to clear the room.
          combatDroneCount: (fitProfile.droneTypeIDs || []).length,
          hops: current.hops,
          risk: route.risk,
          territoryPriority: getTerritoryPriority(bot, current.systemID),
          baseKind: stations[0].kind || "station",
        });
      }
    }
    if (current.hops >= maxHops) continue;
    const gates = worldData.getStargatesForSystem(current.systemID)
      .sort((left, right) => normalizeID(left.itemID) - normalizeID(right.itemID));
    for (const gate of gates) {
      const paired = worldData.getStargateByID(gate.destinationID);
      const nextSystemID = normalizeID(gate.destinationSolarSystemID) || normalizeID(paired && paired.solarSystemID);
      if (!nextSystemID || seen.has(nextSystemID)) continue;
      seen.add(nextSystemID);
      queue.push({ systemID: nextSystemID, hops: current.hops + 1 });
    }
  }
  // Prefer the best reward tier the verified fit can clear, then minimize
  // travel among sites at that tier. Security pilots pass a targetDifficulty
  // based only on previously completed sites, so a fresh or upgraded pilot
  // proves the next tier before it takes on harder waves.
  candidates.sort((left, right) => right.siteDifficulty - left.siteDifficulty ||
    left.territoryPriority - right.territoryPriority || left.hops - right.hops ||
    left.siteInstanceID - right.siteInstanceID);
  const eligibleCandidates = limitCandidatesToTargetTier(candidates);
  combatBaseCache.set(cacheKey, { expiresAt: Date.now() + COMBAT_SITE_CACHE_MS, candidates });
  return selectAvailableAnomaly(eligibleCandidates, bot, options.excludedSiteInstanceIDs) || { success: false,
    message: candidates.length
      ? targetDifficulty
        ? `No unclaimed combat anomaly at or below the next proven tier ${targetDifficulty} is reachable.`
        : "All reachable combat anomalies are claimed or their systems are full."
      : `No reachable combat anomaly is within the current hull's tier ${fitProfile.maxSiteDifficulty} limit and its fitted resist/drone profile.` };
}

function getControlledDrones(scene, shipID) {
  return [...(scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [])]
    .filter((entity) => entity && entity.kind === "drone" && Number(entity.controllerID) === Number(shipID));
}

function getDroneBayItems(bot, shipID) {
  const itemStore = require("../inventory/itemStore");
  return itemStore.listCharacterItems(bot.characterID, {
    locationID: Number(shipID) || 0,
    flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
  });
}

function launchDrones(bot, session, scene, shipID, selectedTypeID = 0) {
  // selectedTypeID was formerly used to launch only the faction-preferred
  // drone. A site flight is checked as a complete, validated set; launch the
  // complete set so the bot does not enter a wave with one drone's DPS.
  void selectedTypeID;
  const bay = getDroneBayItems(bot, shipID);
  if (!bay.length) return { success: false, message: "The ship has no combat drones in its bay." };
  const inventory = require("./playerBotInventoryRuntime");
  const requests = bay.map((item) => [Number(item.itemID), inventory.unitsOf(item)]);
  const result = require("../drone/droneRuntime").launchDronesForSession(session, requests);
  const launched = getControlledDrones(scene, shipID);
  return launched.length
    ? { success: true, drones: launched, requested: requests, response: result && result.response }
    : { success: false, message: "The drone service did not launch a controllable drone.", response: result && result.response };
}

function getCombatContext(bot, scene, entity, operation = null) {
  const playerBots = require("./playerBotRuntime").listBots();
  const managedBotIDs = new Set(playerBots.map((entry) => Number(entry.characterID) || 0));
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = normalizeID(character.corporationID || bot.corporationID);
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  const crimewatch = require("../security/crimewatchState");
  if (typeof crimewatch.isCharacterSuspect !== "function" || typeof crimewatch.isCharacterCriminal !== "function")
    throw new Error("LOCAL_DEFENSE_CRIMEWATCH_INTERFACE_MISSING");
  const war = require("../corporation/warRuntimeState");
  const fleetRuntime = require("../fleets/fleetRuntime");
  const ownFleet = fleetRuntime.getFleetForCharacter(bot.characterID);
  const piratePolicy = require("../../space/npc/pirateFactionPolicy");
  const faction = piratePolicy.resolvePirateFactionForSystem(Number(scene.systemID));
  const itemStore = require("../inventory/itemStore");
  const cargoFlag = itemStore.ITEM_FLAGS.CARGO_HOLD;
  const typeRegistry = require("../inventory/itemTypeRegistry");
  const cargoScore = (target) => itemStore.listContainerItems(null, Number(target.itemID), cargoFlag)
    .reduce((sum, item) => {
      const type = typeRegistry.resolveItemByTypeID(Number(item.typeID)) || {};
      const units = Math.max(1, Number(item.stacksize ?? item.quantity) || 1);
      return sum + units * Math.max(0.01, Number(type.basePrice) || 1);
    }, 0);
  return {
    characterID: Number(bot.characterID),
    corporationID,
    allianceID: Number(corporation.allianceID || character.allianceID) || 0,
    systemSecurity: Number(worldData.getSolarSystemByID(Number(scene.systemID))?.security),
    specialSpace: faction.specialSpace === true || faction.wormholeSpace === true,
    position: entity.position,
    isManagedBot: (characterID) => managedBotIDs.has(Number(characterID)),
    allowManagedBotTargets: botVersusBotCombatEnabled(),
    isFleetMate: (characterID) => {
      if (!ownFleet) return false;
      const targetFleet = fleetRuntime.getFleetForCharacter(Number(characterID));
      return Boolean(targetFleet && Number(targetFleet.fleetID) === Number(ownFleet.fleetID));
    },
    hasCargo: (target) => itemStore.listContainerItems(null, Number(target.itemID), cargoFlag).length > 0,
    cargoScore,
    isSuspect: crimewatch.isCharacterSuspect,
    isCriminal: crimewatch.isCharacterCriminal,
    securityStatusFor: crimewatch.getCharacterSecurityStatus,
    isWarTarget: (targetCharacterID) => war.areCharactersLegalWarOpponents(bot.characterID, targetCharacterID),
    hasLimitedEngagement: (targetCharacterID) => crimewatch.hasActiveLimitedEngagement(bot.characterID, targetCharacterID),
    isNullsecConflictTarget: (target) => Boolean(operation && operation.mode === "nullsec-conflict" &&
      require("./playerBotNullsecConflictRuntime").isEligibleTarget(bot, target, Number(scene.systemID))),
  };
}

function estimateEffectiveHitPoints(typeID, entity = null, fit = null) {
  const fitting = require("../fitting/liveFittingState");
  const condition = entity && entity.conditionState || {};
  const layers = [
    { key: "shield", hp: Number(fit && fit.shieldCapacity || entity && (entity.shieldCapacity || entity.maxShieldHP)) || 0,
      remaining: Math.max(0, Math.min(1, Number(condition.shieldCharge ?? 1))) },
    { key: "armor", hp: Number(fit && fit.armorHP || entity && (entity.armorHP || entity.maxArmorHP)) ||
      Number(fitting.getTypeAttributeValue(typeID, "armorHP")) || 0,
      remaining: Math.max(0, 1 - (Number(condition.armorDamage) || 0)) },
    { key: "structure", hp: Number(fit && fit.structureHP || entity && (entity.structureHP || entity.maxHP)) ||
      Number(fitting.getTypeAttributeValue(typeID, "structureHP")) || 0,
      remaining: Math.max(0, 1 - (Number(condition.damage) || 0)) },
  ];
  let effective = 0;
  for (const layer of layers) {
    if (!(layer.hp > 0)) continue;
    let resonanceTotal = 0;
    let resonanceCount = 0;
    for (const damageType of ["em", "explosive", "kinetic", "thermal"]) {
      const attribute = `${layer.key}${damageType[0].toUpperCase()}${damageType.slice(1)}DamageResonance`;
      const raw = Number(fitting.getTypeAttributeValue(typeID, attribute));
      if (Number.isFinite(raw) && raw >= 0 && raw <= 1) {
        resonanceTotal += raw;
        resonanceCount += 1;
      }
    }
    const averageResonance = resonanceCount ? resonanceTotal / resonanceCount : 1;
    effective += layer.hp * layer.remaining / Math.max(0.05, averageResonance);
  }
  return effective;
}

function eligibleDefensiveTarget(bot,target,scene,entity,operation=null,providedContext=null) {
  if(!require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(entity,target))return false;
  if(combatPolicy.isPirateNpc(target))return true;
  const context=providedContext||getCombatContext(bot,scene,entity,operation);
  if(require("./playerBotLocalDefenseAdapter").hasLiveAttack(bot.characterID,target,scene)){
    // A known managed attacker may be defended against, but this never bypasses
    // corporation, alliance, fleet, Crimewatch, war or instance authority.
    context.isManagedBot=()=>false;
  }
  return combatPolicy.isEligibleDefensiveTarget(target,context);
}

function assessDefensiveResponse(bot, target, scene, operation = null) {
  const activeCombat = operation && operation.kind === "combat" &&
    Number(operation.characterID) === Number(bot && bot.characterID) &&
    ["active", "holding"].includes(operation.status);
  const role = activeCombat && ["security", "piracy", "war", "nullsec-conflict"].includes(operation.mode)
    ? operation.mode === "piracy" ? "piracy" : "security"
    : String(bot && bot.specialty || "");
  if (!bot || !target || !scene || !["security", "piracy"].includes(role)) {
    return { safe: false, action: "evade", reason: "no-supported-combat-pilot-or-target" };
  }
  try {
    const space = require("./playerBotSpaceRuntime");
    const attached = space.getActorSpace(bot);
    if(!require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(attached.entity,target))
      return {safe:false,action:"evade",reason:"target-scope-mismatch"};
    const state = space.getSpaceState(bot);
    const drones = getControlledDrones(scene, attached.entity.itemID);
    const combatFit = require("./playerBotCombatFitRuntime").buildCombatFitSnapshot(
      bot,
      attached.entity,
      { ...state, deployedDrones: drones },
    );
    const fit = combatFit.success ? combatFit.fit : { ready: false, readinessProblems: [combatFit.reason] };
    const defenseAssessment = require("./playerBotDefenseAssessment");
    if (defenseAssessment.enabled(scene.systemID)) {
      const eligible = eligibleDefensiveTarget(bot,target,scene,attached.entity,operation||{mode:"security"});
      return defenseAssessment.assess(bot, target, scene, operation, eligible);
    }
    if (combatPolicy.isPirateNpc(target)) {
      const operationRuntime = require("./playerBotOperationRuntime");
      const roleFitReady = operationRuntime.hasRoleShipFit(bot, role);
      const safety = combatDecision.assessSafety(state, fit, drones.length, drones.length > 0);
      if (!roleFitReady || !safety.safe || fit.ready !== true) {
        return { ...safety, safe: false, action: "evade",
          reason: !roleFitReady ? "validated-combat-fit-unavailable" : safety.reason || "combat-fit-not-ready" };
      }
      return { safe: true, action: "engage", reason: "attacking-pirate-npc-under-existing-site-and-escort-rules" };
    }
    const combatContext = getCombatContext(bot, scene, attached.entity, operation || { mode: "security" });
    const eligible = eligibleDefensiveTarget(bot,target,scene,attached.entity,operation||{mode:"security"},combatContext);
    const operationRuntime = require("./playerBotOperationRuntime");
    const roleFitReady = operationRuntime.hasRoleShipFit(bot, role);
    const fitting = require("../fitting/liveFittingState");
    const mass = (typeID) => Number(fitting.getTypeAttributeValue(Number(typeID), "mass")) || 0;
    return combatDecision.decideDefensiveResponse({
      eligible,
      roleFitReady,
      fit,
      state,
      liveDroneCount: drones.length,
      dronesLaunched: drones.length > 0,
      ownMass: mass(attached.entity.typeID),
      targetMass: mass(target.typeID),
      ownEffectiveHP: estimateEffectiveHitPoints(attached.entity.typeID, attached.entity, fit),
      targetEffectiveHP: estimateEffectiveHitPoints(target.typeID, target),
    });
  } catch (error) {
    return { safe: false, action: "evade", reason: `defensive-snapshot-unavailable:${String(error && error.message || error).slice(0, 100)}` };
  }
}

function authorizeFleetAttackTarget(bot, target, scene) {
  if (!target || String(target.kind || "").toLowerCase() !== "ship" || Number(target.typeID) === 670) {
    return { success: false, message: "Fleet attack only accepts a non-capsule ship target." };
  }
  if (combatPolicy.isPirateNpc(target)) return { success: true, mode: "security" };
  if (!target.session) return { success: false, message: "The locked ship is not a supported pirate NPC or online player target." };
  const targetPosition = target.position || { x: 0, y: 0, z: 0 };
  const observer = { position: targetPosition };
  const warContext = getCombatContext(bot, scene, observer, { mode: "war" });
  if (combatPolicy.isEligibleWarTarget(target, warContext)) return { success: true, mode: "war" };
  const conflictContext = getCombatContext(bot, scene, observer, { mode: "nullsec-conflict" });
  if (combatPolicy.isEligibleNullsecConflictTarget(target, conflictContext)) {
    return { success: true, mode: "nullsec-conflict" };
  }
  const piracyContext = getCombatContext(bot, scene, observer, { mode: "piracy" });
  if (combatPolicy.isEligiblePiracyTarget(target, piracyContext)) return { success: true, mode: "piracy" };
  return { success: false, message: "EveJS war, fleet, faction, cargo, and Crimewatch policy does not authorize this target for this pilot." };
}

function hasMiningEscortMembers(operation) {
  const groupKey = String(operation && operation.miningEscortGroupKey || "");
  if (!groupKey) return false;
  return require("./playerBotOperationRecords").listReadOnlyActiveOperations(require("./playerBotOperationRuntime")).some((entry) =>
    entry && entry.kind === "mine" && ["active", "holding"].includes(entry.status) &&
    String(entry.miningEscortGroupKey || "") === groupKey &&
    ["to-belt", "mining"].includes(entry.stage),
  );
}

function findWreckForTarget(scene, targetID, siteInstanceID = 0) {
  const scopedSiteID = normalizeID(siteInstanceID);
  return [...(scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [])]
    .filter((entity) => entity && (entity.kind === "wreck" || entity.nativeNpcWreck === true))
    .filter((entity) => !scopedSiteID || Number(entity.dungeonSiteInstanceID) === scopedSiteID)
    .filter((entity) => Number(entity.launcherID || entity.sourceEntityID) === Number(targetID))
    .sort((left, right) => normalizeID(left.itemID) - normalizeID(right.itemID))[0] || null;
}

function listSiteEntities(scene, instanceID) {
  const numericInstanceID = normalizeID(instanceID);
  return [...(scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [])]
    .filter((entity) => entity && Number(entity.dungeonSiteInstanceID) === numericInstanceID);
}

function listUnlootedSiteWrecks(scene, instanceID, operation) {
  const looted = new Set((operation.siteLootWreckIDs || []).map(Number));
  return listSiteEntities(scene, instanceID)
    .filter((entity) => (entity.kind === "wreck" || entity.nativeNpcWreck === true) && !looted.has(Number(entity.itemID)))
    .sort((left, right) => normalizeID(left.itemID) - normalizeID(right.itemID));
}

function findWarpTackler(scene, shipEntity, bot, operation) {
  const records = shipEntity && shipEntity.hostileModuleState &&
    shipEntity.hostileModuleState.incomingEffects instanceof Map
    ? [...shipEntity.hostileModuleState.incomingEffects.values()]
    : [];
  const sources = records
    .filter((record) => record && ["scram", "disrupt"].includes(String(record.family || "").toLowerCase()))
    .map((record) => scene.getEntityByID(Number(record.sourceBallID)))
    .filter((entity) => entity && (
      eligibleDefensiveTarget(bot,entity,scene,shipEntity,operation) ||
      (operation.mode === "piracy"
      ? combatPolicy.isEligiblePiracyTarget(entity, getCombatContext(bot, scene, shipEntity, operation)) || combatPolicy.isPirateNpc(entity)
      : operation.mode === "war"
        ? combatPolicy.isEligibleWarTarget(entity, getCombatContext(bot, scene, shipEntity, operation))
        : operation.mode === "nullsec-conflict"
          ? combatPolicy.isEligibleNullsecConflictTarget(entity, getCombatContext(bot, scene, shipEntity, operation))
          : combatPolicy.isPirateNpc(entity))))
    .sort((left, right) => normalizeID(left.itemID) - normalizeID(right.itemID));
  return sources[0] || null;
}

function record(operation, kit, message) {
  kit.record(operation, message);
  kit.save(operation);
}

function getSiteInstance(operation) {
  const instanceID = normalizeID(operation && operation.siteInstanceID);
  return instanceID ? require("../dungeon/dungeonRuntime").getInstance(instanceID) : null;
}

function recordFailedAnomalySite(operation, reason, now = Date.now()) {
  const instanceID = normalizeID(operation && operation.siteInstanceID);
  if (!instanceID) return [];
  const cutoff = now - FAILED_SITE_COOLDOWN_MS;
  const entries = (Array.isArray(operation.failedAnomalySites) ? operation.failedAnomalySites : [])
    .filter((entry) => normalizeID(entry && entry.siteInstanceID) &&
      Number(entry.failedAtMs) >= cutoff)
    .filter((entry) => Number(entry.siteInstanceID) !== instanceID);
  entries.push({ siteInstanceID: instanceID, failedAtMs: now, reason: String(reason || "incomplete-site-attempt").slice(0, 120) });
  operation.failedAnomalySites = entries.slice(-32);
  return operation.failedAnomalySites;
}

function recentFailedAnomalySiteIDs(operation, now = Date.now()) {
  const cutoff = now - FAILED_SITE_COOLDOWN_MS;
  return [...new Set((Array.isArray(operation && operation.failedAnomalySites) ? operation.failedAnomalySites : [])
    .filter((entry) => Number(entry && entry.failedAtMs) >= cutoff)
    .map((entry) => normalizeID(entry && entry.siteInstanceID))
    .filter(Boolean))];
}

function retargetToAnotherAnomaly(operation, bot, kit) {
  const fitProfile = require("./playerBotOperationRuntime").getRoleShipFitProfile(bot, "security");
  const failedAnomalySites = recentFailedAnomalySiteIDs(operation);
  const target = findNearestCombatAnomalyBase(bot, fitProfile, 20, {
    excludedSiteInstanceIDs: failedAnomalySites,
  });
  if (!target.success) return false;
  Object.assign(operation, {
    stage: "to-home",
    routeTaskID: null,
    homeStationID: target.stationID,
    marketStationID: target.stationID,
    optimizeMarketDestination: true,
    targetSystemID: target.systemID,
    siteInstanceID: target.siteInstanceID,
    siteID: target.siteID,
    siteDifficulty: target.siteDifficulty,
    siteFactionKey: target.siteFactionKey,
    siteLabel: target.siteLabel,
    siteCompleted: false,
    siteIncomplete: false,
    siteUnavailable: false,
    siteAbandoned: false,
    siteHandedOff: false,
    siteFailureReason: null,
    siteContextReleasedAtMs: 0,
    siteRetryCount: 0,
    siteMaxWaveHostiles: Number(target.encounterLoad && target.encounterLoad.maxWaveHostiles) || 0,
    siteMaxWaveThreatScore: Number(target.encounterLoad && target.encounterLoad.maxWaveThreatScore) || 0,
    siteWaveCount: Number(target.encounterLoad && target.encounterLoad.waveCount) || 0,
    combatDroneTypeID: Number(target.combatDroneTypeID) || null,
    combatDroneDamageType: target.combatDroneDamageType || null,
    combatDroneCount: Number(target.combatDroneCount) || null,
    tripStartedAt: null,
    emptySinceAt: 0,
    targetID: null,
    pendingCombatAction: null,
  });
  record(operation, kit,
    `The previous anomaly attempt did not clear safely; its instance is on a one-hour retry cooldown. The bot is switching to ${target.siteLabel} in system ${target.systemID}.`);
  return true;
}

function withdrawFromUnavailableAnomaly(operation, kit, phase, attached = null) {
  if (attached) {
    try {
      const drones = getControlledDrones(attached.scene, attached.entity.itemID);
      if (drones.length) {
        require("../drone/droneRuntime").commandReturnBay(
          attached.session,
          drones.map((drone) => Number(drone.itemID)),
        );
      }
    } catch (_) {
      // The durable return stage retries drone recovery using the live actor.
    }
  }
  operation.siteIncomplete = true;
  operation.siteUnavailable = true;
  operation.siteFailureReason = `site-unavailable-${phase}`;
  operation.siteUnavailableAt ||= new Date().toISOString();
  operation.targetID = null;
  operation.pendingCombatAction = null;
  operation.stage = "return";
  record(operation, kit,
    `Dungeon authority no longer lists ${operation.siteLabel} ${phase}; returning to station without reporting a clear.`);
  return { delayMs: 15_000 };
}

function getUnlockedSiteGate(scene, instance) {
  if (!scene || !instance || !(scene.staticEntitiesByID instanceof Map)) return null;
  const entities = [
    ...scene.staticEntitiesByID.values(),
    ...(scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : []),
  ];
  return entities.filter((entity) => entity && entity.kind === "siteAccelerationGate" &&
      Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID))
    .filter((entity) => {
      const state = instance.gateStatesByKey && instance.gateStatesByKey[String(entity.dungeonGateKey)];
      const stateName = String(state && state.state || entity.dungeonGateState || "locked").toLowerCase();
      return stateName === "unlocked" ||
        (stateName === "locked" && Number(entity.dungeonGateKeyLock) === 2 &&
          (!Array.isArray(entity.dungeonGateRequiredItems) || entity.dungeonGateRequiredItems.length === 0));
    })
    .sort((left, right) => normalizeID(left.itemID) - normalizeID(right.itemID))[0] || null;
}

function buildLiveCombatFit(bot, entity, state, operation, deployedDrones = []) {
  const requiredDroneTypes = new Map();
  for (const typeID of operation.requiredDroneTypes || []) {
    requiredDroneTypes.set(Number(typeID), (requiredDroneTypes.get(Number(typeID)) || 0) + 1);
  }
  const result = require("./playerBotCombatFitRuntime").buildCombatFitSnapshot(bot, entity, {
    shield: state.shield,
    hullDamage: state.hullDamage,
    armorDamage: state.armorDamage,
    warpScrambleStatus: state.warpScrambleStatus,
    requiredDrones: [...requiredDroneTypes.values()].reduce((total, count) => total + count, 0),
    requiredDroneTypes,
    droneDamageTypeByID: operation.droneDamageTypeByID || {},
    maxSiteDifficulty: operation.maxSiteDifficulty,
    deployedDrones,
  });
  if (!result.success) return { ready: false, readinessProblems: [result.reason] };
  const fit = result.fit;
  const requiredModuleTypes = operation.requiredModuleTypes || [];
  const fittedCounts = new Map();
  for (const module of fit.modules || []) {
    fittedCounts.set(Number(module.typeID), (fittedCounts.get(Number(module.typeID)) || 0) + 1);
  }
  for (const typeID of requiredModuleTypes) {
    const count = fittedCounts.get(Number(typeID)) || 0;
    if (!count) {
      fit.ready = false;
      fit.readinessProblems.push(`required module ${typeID} is missing`);
    } else {
      fittedCounts.set(Number(typeID), count - 1);
      const module = (fit.modules || []).find((entry) => Number(entry.typeID) === Number(typeID));
      if (module && !require("../fitting/liveFittingState").isEffectivelyOnlineModule(module)) {
        fit.ready = false;
        fit.readinessProblems.push(`required module ${typeID} is offline`);
      }
    }
  }
  if (Number(operation.combatDroneTypeID) > 0) {
    fit.requiredDrones = Math.max(1, Number(operation.combatDroneCount) || 1);
  }
  return fit;
}

function releaseCombatSiteContextForStationTravel(operation, attached) {
  if (!normalizeID(operation && operation.siteInstanceID) || !attached || !attached.entity || !attached.scene) {
    return { success: true, released: false };
  }
  const tracking = require("../dungeon/dungeonTrackingRuntime");
  const entity = attached.entity;
  const dungeonID = normalizeID(entity.dungeonCurrentDungeonID);
  const hadDungeonContext = [
    "dungeonCurrentInstanceID",
    "dungeonCurrentDungeonID",
    "dungeonCurrentSiteID",
    "dungeonCurrentRoomID",
    "dungeonCurrentRoomKey",
    "dungeonCurrentRoomPosition",
  ].some((key) => Object.prototype.hasOwnProperty.call(entity, key));
  tracking.clearShipCurrentDungeonRoom(entity);
  if (typeof attached.scene.persistAcceptedDungeonTrackingContext !== "function") {
    return { success: false, message: "The active site context cannot be persisted as cleared." };
  }
  try {
    const persisted = attached.scene.persistAcceptedDungeonTrackingContext(entity);
    if (persisted && persisted.success === false) {
      return { success: false, message: persisted.errorMsg || "The cleared site context could not be saved." };
    }
  } catch (error) {
    return { success: false, message: String(error && error.message || error).slice(0, 200) };
  }
  if (hadDungeonContext && dungeonID) {
    try {
      tracking.sendExitingDungeonNotification(attached.session, dungeonID);
    } catch (_) {
      // State release is authoritative; the client notification is best effort.
    }
  }
  return { success: true, released: hadDungeonContext };
}

function ensureCombatSiteContextReleased(operation, attached, kit) {
  if (!normalizeID(operation && operation.siteInstanceID) ||
      Number(operation.siteContextReleasedAtMs) > 0 || !attached) return null;
  const result = releaseCombatSiteContextForStationTravel(operation, attached);
  if (!result.success) {
    return kit.block(operation, "holding",
      `The combat pilot cannot leave its private anomaly context before station travel: ${result.message}.`);
  }
  operation.siteContextReleasedAtMs = Date.now();
  if (result.released) {
    record(operation, kit,
      `Released the completed or abandoned anomaly context before returning to station; the site outcome remains ${operation.siteCompleted === true ? "authority-confirmed complete" : "incomplete"}.`);
  } else {
    kit.save(operation);
  }
  return null;
}

async function repairAtStation(operation, bot, kit, options = {}) {
  const space = kit.space;
  const session = space.getActorSession(bot);
  const shipID = Number(session.shipID) || 0;
  const repairRuntime = require("../station/repairRuntime");
  const quote = repairRuntime.buildRepairQuotesForSelection(session, [shipID]);
  if (!quote.success || !quote.data) return { success: false, message: quote.message || quote.errorMsg || "Could not price ship repairs." };
  if (options.quoteOnly === true) return { success: true, repaired: false, amount: 0 };
  const rows = quote.data.groupedQuotes.get(shipID) || [];
  const amount = Math.round(rows.reduce((total, row) =>
    total + Math.ceil(Number(row.damage) || 0) * (Number(row.costToRepairOneUnitOfDamage) || 0), 0) * 100) / 100;
  if (!(amount > 0)) return { success: true, repaired: false, amount: 0 };
  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  if (amount > balance) return { success: false, message: `Ship repairs cost ${amount.toFixed(2)} ISK; wallet balance is ${balance.toFixed(2)} ISK.` };
  try {
    await new (require("../station/repairService"))().Handle_RepairItems([[shipID], amount], session);
  } catch (error) {
    return { success: false, message: space.describeError(error) };
  }
  operation.spent = Math.round(((Number(operation.spent) || 0) + amount) * 100) / 100;
  return { success: true, repaired: true, amount };
}

async function advanceCombat(operation, bot, kit) {
  const space = kit.space;
  const inventory = kit.inventory;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const capsule = Number(character.shipTypeID) === 670;
  const capsuleSafeStages = new Set(["return", "to-market", "market-sell", "corp-share"]);

  // Old saves may already contain a waiting-period war patrol. Settle that
  // trip normally instead of resuming another empty belt visit after update.
  if (operation.mode === "war" && !operation.defensiveTargetID &&
      !(operation.stage === "loot" && operation.lastDestroyedTargetID) &&
      !capsuleSafeStages.has(operation.stage) &&
      !require("../corporation/warRuntimeState").hasActiveWarForCharacter(bot.characterID)) {
    module.exports.requestSafeRetreat(operation, bot, "The war is not active; returning to station until a legal patrol opportunity exists.");
    record(operation, kit, operation.withdrawReason);
    return { delayMs: 5_000 };
  }

  if (capsule && ["return", "to-market", "market-sell"].includes(operation.stage)) {
    const economy = require("./playerBotEconomyRuntime");
    const homeInJita = economy.isJitaStation(operation.homeStationID);
    const marketInJita = economy.isJitaStation(operation.marketStationID);
    if (homeInJita || marketInJita) {
      const safeStation = findNearestRepairStation(bot, 64, { excludeJita: true });
      if (!safeStation.success) {
        return kit.block(operation, "holding",
          `The capsule has a Jita-only destination, where playerbots cannot sell. ${safeStation.message} Keeping it out of Jita until a non-Jita repair-and-market station is available.`);
      }
      if (homeInJita || !normalizeID(operation.homeStationID)) operation.homeStationID = safeStation.stationID;
      if (marketInJita || !normalizeID(operation.marketStationID)) operation.marketStationID = safeStation.stationID;
      operation.routeTaskID = null;
      record(operation, kit,
        `Jita is a seed-only market for playerbots; rerouting this capsule to ${safeStation.stationName} (${safeStation.stationID}) outside Jita for safe settlement and hull recovery.`);
      return { delayMs: 5_000, reroutedFromJita: true };
    }
  }

  const accessRoute = retargetCombatInaccessibleStructure(operation, bot, kit);
  if (accessRoute) return accessRoute;

  if (capsule && !capsuleSafeStages.has(operation.stage)) {
    operation.combatHullLost = true;
    operation.siteIncomplete = Boolean(operation.siteInstanceID && operation.siteCompleted !== true);
    operation.siteFailureReason ||= "combat-hull-lost";
    operation.stage = "return";
    operation.routeTaskID = null;
    operation.targetID = null;
    operation.pendingCombatAction = null;
    operation.emergencyRetreat = false;
    operation.emergencyDepartureOrderedAt = null;
    record(operation, kit,
      "The combat hull was lost; the capsule is withdrawing to a safe station before the incomplete site is released and a replacement ship is fitted.");
    return { delayMs: 5_000, combatHullLost: true };
  }

  if (operation.stage === "to-home") {
    const step = await kit.travelToStation(operation, bot, operation.homeStationID);
    if (step) return step;
    operation.stage = Number(character.solarSystemID) === Number(operation.targetSystemID) ? "undock" : "to-system";
    kit.save(operation);
  }
  if (operation.stage === "to-system") {
    if (typeof kit.travelToSystem !== "function") {
      return kit.block(operation, "blocked", "This combat route has no system-navigation authority attached.");
    }
    const step = kit.travelToSystem(operation, bot, Number(operation.targetSystemID));
    if (step) return step;
    operation.stage = "undock";
    kit.save(operation);
  }
  if (operation.stage === "undock") {
    const session = space.getActorSession(bot);
    const fitRole = operation.mode === "piracy" ? "piracy" : "security";
    const fitProfile = require("./playerBotOperationRuntime").getRoleShipFitProfile(bot, fitRole);
    if (!fitProfile || Number(session.shipTypeID) !== Number(fitProfile.hullTypeID)) {
      return kit.block(operation, "blocked", `The ${operation.mode} operation requires its current validated combat hull and fit.`);
    }
    if (!require("./playerBotOperationRuntime").hasRoleShipFit(bot, fitRole)) {
      return kit.block(operation, "blocked", `The ${operation.mode} ship needs its complete online combat fit and drone flight before undocking.`);
    }
    if (operation.siteInstanceID) {
      const alreadyInSpace = space.getSpaceState(bot).inSpace;
      const undocked = alreadyInSpace ? { success: true } : space.undock(bot, { allowOverCapacityDeparture: true });
      if (!undocked.success) return undocked.capacityQueued
        ? { delayMs: 15_000, capacityQueued: true, capacityReason: undocked.message }
        : kit.block(operation, "blocked", undocked.message);
      operation.tripStartedAt = Date.now();
      operation.stage = "to-anomaly";
      record(operation, kit, `${alreadyInSpace ? "Arrived in space for" : "Undocked for"} combat anomaly ${operation.siteLabel} (tier ${operation.siteDifficulty}, ${operation.siteFactionKey || "unknown NPC faction"}).`);
      return { delayMs: 15_000 };
    }
    const asteroidBelts = worldData.getAsteroidBeltsForSystem(operation.targetSystemID) || [];
    const structurePatrolTarget = operation.mode === "nullsec-conflict" && operation.patrolEntityID
      ? worldData.getStructureByID(operation.patrolEntityID)
      : null;
    const belt = structurePatrolTarget
      ? { itemID: Number(operation.patrolEntityID), entityType: "structure" }
      : operation.miningEscortBeltID
        ? asteroidBelts.find((entry) => Number(entry.itemID) === Number(operation.miningEscortBeltID)) || null
      : asteroidBelts.length
        // Piracy patrols start at a per-operation belt so pilots sharing a
        // system do not all open on the same belt.
        ? asteroidBelts[(Number(operation.kills || 0) + (operation.mode === "piracy" && isPatrolRotationEnabled()
          ? require("./playerBotPatrolRotation").stableHash32(operation.operationID, operation.characterID) : 0)) %
          asteroidBelts.length]
        : null;
    const alreadyInSpace = space.getSpaceState(bot).inSpace;
    const undocked = alreadyInSpace ? { success: true } : space.undock(bot, { allowOverCapacityDeparture: true });
    if (!undocked.success) return undocked.capacityQueued
      ? { delayMs: 15_000, capacityQueued: true, capacityReason: undocked.message }
      : kit.block(operation, "blocked", undocked.message);
    operation.beltID = belt ? Number(belt.itemID) : null;
    operation.tripStartedAt = Date.now();
    operation.emptySinceAt = 0;
    operation.stage = belt ? "to-belt" : "engage";
    record(operation, kit, belt
      ? `${alreadyInSpace ? "Reached space for" : "Undocked for"} a ${operation.mode} patrol in system ${operation.targetSystemID}, ${belt.entityType === "structure" ? `structure ${operation.beltID}` : `belt ${operation.beltID}`}.`
      : `System ${operation.targetSystemID} has no asteroid belt; undocked to scan the conflict system grid directly.`);
    return { delayMs: belt ? 15_000 : 10_000 };
  }
  if (operation.stage === "to-belt") {
    const state = space.getSpaceState(bot);
    if (!state.inSpace || state.busy) return { delayMs: 15_000 };
    const distance = state.distanceTo(operation.beltID);
    if (distance === null && operation.mode === "nullsec-conflict" &&
        Number(operation.beltID) === Number(operation.patrolEntityID)) {
      const fallbackBelt = (worldData.getAsteroidBeltsForSystem(operation.targetSystemID) || [])[0];
      if (fallbackBelt) {
        operation.beltID = Number(fallbackBelt.itemID);
        kit.record(operation, `Conflict structure ${operation.patrolEntityID} is not on the current grid; moving to asteroid belt ${operation.beltID} to continue the system patrol.`);
        kit.save(operation);
        return { delayMs: 10_000 };
      }
      operation.beltID = null;
      operation.stage = "engage";
      kit.record(operation, `Conflict structure ${operation.patrolEntityID} is not on the current grid and the system has no asteroid belt; scanning the present system grid.`);
      kit.save(operation);
      return { delayMs: 10_000 };
    }
    if (distance === null) return kit.block(operation, "blocked", `Patrol location ${operation.beltID} is not present in the local system.`);
    if (distance > WARP_RANGE_METERS) {
      const result = space.warp(bot, operation.beltID);
      if (!result.success) return result.blocked
        ? { delayMs: 60_000, interdictionHold: true }
        : kit.block(operation, "holding", result.message);
      return { delayMs: 15_000 };
    }
    if (distance > APPROACH_RANGE_METERS) {
      const result = space.approach(bot, operation.beltID, APPROACH_RANGE_METERS);
      if (!result.success) return kit.block(operation, "holding", result.message);
      return { delayMs: 15_000 };
    }
    operation.stage = "engage";
    operation.emptySinceAt = Date.now();
    kit.save(operation);
    return { delayMs: 10_000 };
  }

  if (operation.stage === "to-anomaly") {
    const state = space.getSpaceState(bot);
    if (!state.inSpace || state.busy) return { delayMs: 15_000 };
    if (Number(state.systemID) !== Number(operation.targetSystemID)) return { delayMs: 15_000 };
    const siteInstance = getSiteInstance(operation);
    if (!siteInstance) {
      return withdrawFromUnavailableAnomaly(operation, kit, "before entry");
    }
    if (String(siteInstance.lifecycleState || "").toLowerCase() === "completed") {
      operation.siteCompleted = true;
      operation.siteIncomplete = false;
      operation.stage = "site-loot";
      record(operation, kit, `Dungeon authority reports ${operation.siteLabel} completed before entry; recovering remaining site loot.`);
      return { delayMs: 10_000 };
    }
    const attached = space.getActorSpace(bot);
    const siteService = require("../dungeon/dungeonUniverseSiteService");
    const materialized = siteService.ensureSiteContentsMaterialized(attached.scene, {
      instanceID: Number(operation.siteInstanceID),
      siteID: Number(operation.siteID),
    }, {
      session: attached.session,
      broadcast: true,
      spawnEncounters: true,
      markCurrentDungeonRoom: false,
    });
    if (!materialized || materialized.success !== true) {
      return kit.block(operation, "holding", `Combat anomaly ${operation.siteLabel} is still active but its server site authority could not prepare the pocket: ${materialized && materialized.errorMsg || "unknown site error"}.`);
    }
    const distance = state.distanceTo(operation.siteID);
    if (distance === null) return kit.block(operation, "holding", `Combat anomaly ${operation.siteLabel} (${operation.siteID}) is not present in system ${operation.targetSystemID}.`);
    if (distance > WARP_RANGE_METERS) {
      const result = space.warp(bot, operation.siteID);
      if (!result.success) return result.blocked
        ? { delayMs: 60_000, interdictionHold: true }
        : kit.block(operation, "holding", result.message);
      return { delayMs: 15_000 };
    }
    if (distance > APPROACH_RANGE_METERS) {
      const result = space.approach(bot, operation.siteID, APPROACH_RANGE_METERS);
      if (!result.success) return kit.block(operation, "holding", result.message);
      return { delayMs: 15_000 };
    }
    const entered = siteService.ensureSiteContentsMaterialized(attached.scene, {
      instanceID: Number(operation.siteInstanceID),
      siteID: Number(operation.siteID),
    }, {
      session: attached.session,
      broadcast: true,
      spawnEncounters: true,
      markCurrentDungeonRoom: true,
    });
    if (!entered || entered.success !== true) {
      return kit.block(operation, "holding", `The ship reached ${operation.siteLabel}, but the instance authority did not admit it to the combat room.`);
    }
    operation.stage = "site-engage";
    operation.emptySinceAt = Date.now();
    operation.siteIncomplete = false;
    operation.siteFailureReason = null;
    operation.siteContextReleasedAtMs = 0;
    operation.tackleSearchStartedAt = null;
    record(operation, kit, `Entered combat anomaly ${operation.siteLabel}; wave and gate completion will be checked against dungeon lifecycle state.`);
    return { delayMs: 15_000 };
  }

  if (["engage", "site-engage", "loot", "site-loot"].includes(operation.stage)) {
    const state = space.getSpaceState(bot);
    if (!state.inSpace) return kit.block(operation, "holding", "The combat ship left space before the patrol could finish; returning to its home station.");
    const attached = space.getActorSpace(bot);
    const { scene, entity, session } = attached;
    const siteInstance = operation.siteInstanceID ? getSiteInstance(operation) : null;
    if (operation.siteInstanceID && !siteInstance && operation.siteCompleted !== true) {
      return withdrawFromUnavailableAnomaly(operation, kit, "during the combat attempt", attached);
    }
    const drones = getControlledDrones(scene, entity.itemID);
    const siteLifecycleState = String(siteInstance && siteInstance.lifecycleState || "").toLowerCase();
    if (operation.siteInstanceID && siteLifecycleState === "completed" && operation.stage !== "site-loot") {
      operation.siteCompleted = true;
      operation.siteIncomplete = false;
      operation.stage = "site-loot";
      record(operation, kit, `Dungeon authority reports ${operation.siteLabel} completed after its supported encounter chain resolved; collecting remaining site wrecks.`);
      kit.save(operation);
    }
    const fit = buildLiveCombatFit(bot, entity, state, operation, drones);
    if (operation.miningEscortGroupKey && state.isCapsule && operation.escortShipLost !== true) {
      operation.escortShipLost = true;
      record(operation, kit, `Mining security escort ship was destroyed on belt ${operation.miningEscortBeltID}.`);
      kit.save(operation);
    }
    let safety = combatDecision.decideCombatAction({
      state,
      fit,
      liveDroneCount: drones.length,
      dronesLaunched: drones.length > 0,
      siteLifecycleState: operation.siteCompleted === true ? "completed" : siteLifecycleState,
      siteLootOnly: operation.stage === "site-loot" && operation.siteCompleted === true,
      withdrawRequested: operation.withdrawRequested === true,
      withdrawReason: operation.withdrawReason,
    });
    if (!operation.withdrawRequested && operation.stage !== "site-loot" &&
        require("./playerBotDefenseAssessment").enabled(scene.systemID)) {
      const currentTarget = scene.getEntityByID(Number(operation.defensiveTargetID || operation.targetID));
      if (currentTarget) {
        const context = getCombatContext(bot,scene,entity,operation);
        const legal = eligibleDefensiveTarget(bot,currentTarget,scene,entity,operation,context);
        const decision = require("./playerBotDefenseAssessment").assess(bot,currentTarget,scene,operation,legal);
        safety = {...decision,action:decision.action === "clear-tackle" ? "clear-tackle-and-withdraw" : decision.action};
      }
    }
    let defensiveTarget = null;
    if (Number(operation.defensiveTargetID) > 0) {
      defensiveTarget = scene.getEntityByID(Number(operation.defensiveTargetID));
      if (!defensiveTarget || defensiveTarget.destroying === true ||
          defensiveTarget.destructionState === "destroying") {
        const previousTargetID = Number(operation.defensiveTargetID);
        const confirmedWreck = findWreckForTarget(scene, previousTargetID, operation.siteInstanceID);
        // Destruction may span ticks. Keep the target until its wreck can be
        // matched; a ship merely leaving the grid must never count as a kill.
        if (defensiveTarget && !confirmedWreck) {
          operation.wreckMissingSinceAt ||= Date.now();
          if (Date.now() - operation.wreckMissingSinceAt < WRECK_APPEARANCE_GRACE_MS) {
            kit.save(operation);
            return { delayMs: 1_000 };
          }
        }
        if (Number(operation.targetID) === previousTargetID) operation.targetID = null;
        operation.defensiveTargetID = null;
        operation.pendingCombatAction = null;
        if (confirmedWreck) {
          operation.lastDestroyedTargetID = previousTargetID;
          operation.lastTargetLabel = operation.targetLabel || `target ${previousTargetID}`;
          operation.defensiveLootResumeStage = operation.defensiveResumeStage || null;
          operation.defensiveResumeStage = null;
          operation.stage = "loot";
          operation.wreckMissingSinceAt = null;
          record(operation, kit, `Confirmed wreck ${confirmedWreck.itemID} for defensive target ${previousTargetID}; recovering it before resuming the interrupted work.`);
          kit.save(operation);
          return { delayMs: 1_000, defensiveTargetCleared: true };
        }
        if (operation.defensiveResumeStage) operation.stage = operation.defensiveResumeStage;
        operation.defensiveResumeStage = null;
        operation.emptySinceAt = Date.now();
        record(operation, kit, `Hostile ship ${previousTargetID} left the grid or was destroyed; defensive response ended and the interrupted combat work resumes.`);
        kit.save(operation);
        return { delayMs: 1_000, defensiveTargetCleared: true };
      }
      const defensiveContext = getCombatContext(bot, scene, entity, operation);
      const legalDefensiveTarget = eligibleDefensiveTarget(bot,defensiveTarget,scene,entity,operation,defensiveContext);
      if (!legalDefensiveTarget) {
        if (drones.length) require("../drone/droneRuntime").commandReturnBay(session,drones.map(drone=>Number(drone.itemID)));
        const previousTargetID = Number(operation.defensiveTargetID);
        if (Number(operation.targetID) === previousTargetID) operation.targetID = null;
        operation.defensiveTargetID = null;
        operation.pendingCombatAction = null;
        if (operation.defensiveResumeStage) operation.stage = operation.defensiveResumeStage;
        operation.defensiveResumeStage = null;
        operation.emptySinceAt = Date.now();
        record(operation, kit, `Hostile ship ${previousTargetID} is no longer a legal defensive target; drones disengage and the prior combat work resumes.`);
        kit.save(operation);
        return { delayMs: 1_000, defensiveTargetCleared: true };
      }
      const defensiveDecision = assessDefensiveResponse(bot, defensiveTarget, scene, operation);
      if (defensiveDecision.action !== "engage") {
        operation.siteIncomplete = Boolean(operation.siteInstanceID && operation.siteCompleted !== true);
        if (operation.siteIncomplete) {
          operation.siteFailureReason = `defensive-withdrawal:${defensiveDecision.reason}`;
          recordFailedAnomalySite(operation, operation.siteFailureReason);
        }
        operation.emergencyRetreat = true;
        operation.withdrawRequested = true;
        operation.withdrawReason = `Incoming attacker ${defensiveTarget.itemID}; ${defensiveDecision.reason}.`;
        operation.stage = "return";
        if (drones.length) require("../drone/droneRuntime").commandReturnBay(
          session, drones.map((drone) => Number(drone.itemID)),
        );
        record(operation, kit, `Threat assessment chose evacuation from ${defensiveTarget.itemID}: ${defensiveDecision.reason}; recalling drones and leaving immediately.`);
        kit.save(operation);
        return { delayMs: 1_000, defensiveResponse: "evade", reason: defensiveDecision.reason };
      }
    }
    const timedOut = !operation.miningEscortGroupKey &&
      Date.now() - Number(operation.tripStartedAt || 0) >=
      (operation.siteInstanceID ? MAX_SITE_TRIP_MS : MAX_TRIP_MS);
    const killLimit = !operation.miningEscortGroupKey && !operation.siteInstanceID &&
      Number(operation.kills || 0) >= MAX_KILLS_PER_TRIP;
    const siteIsComplete = operation.siteCompleted === true || siteLifecycleState === "completed";
    if (Number(state.warpScrambleStatus) > 0 && operation.stage !== "site-loot") {
      const tackler = findWarpTackler(scene, entity, bot, operation);
      let tackleDrones = drones;
      if (!tackleDrones.length) {
        const launched = launchDrones(bot, session, scene, entity.itemID, operation.combatDroneTypeID);
        if (launched.success) tackleDrones = launched.drones;
      }
      if (tackler && tackleDrones.length) {
        const assignedToTackler = tackleDrones.every((drone) => Number(drone.targetID) === Number(tackler.itemID));
        if (!assignedToTackler) {
          const command = require("../drone/droneRuntime").commandEngage(
            session,
            tackleDrones.map((drone) => Number(drone.itemID)),
            Number(tackler.itemID),
          );
          operation.targetID = Number(tackler.itemID);
          operation.targetLabel = String(tackler.itemName || tackler.itemID);
          record(operation, kit, `Warp-disrupting rat ${tackler.itemID} is being cleared before the bot attempts to withdraw.`);
          kit.save(operation);
          return { delayMs: 5_000, combatResponse: command && command.entries || [] };
        }
        return { delayMs: 5_000 };
      }
      if (safety.action === "clear-tackle-and-withdraw" || !safety.safe) {
        operation.tackleSearchStartedAt ||= Date.now();
        if (Date.now() - Number(operation.tackleSearchStartedAt) > 60_000) {
          record(operation, kit, "Warp disruption remains active but its source is not visible; holding position and retrying the defensive scan.");
        }
        kit.save(operation);
        return { delayMs: 5_000 };
      }
    }
    if (!safety.safe || timedOut || killLimit) {
      if (drones.length) require("../drone/droneRuntime").commandReturnBay(session, drones.map((drone) => Number(drone.itemID)));
      if (operation.siteInstanceID && !siteIsComplete) operation.siteIncomplete = true;
      if (operation.siteInstanceID && !siteIsComplete && (safety.safe === false || timedOut)) {
        operation.siteFailureReason = safety.safe === false ? safety.reason : "site-trip-timeout";
        recordFailedAnomalySite(operation, operation.siteFailureReason);
      }
      operation.emergencyRetreat = safety.safe === false;
      operation.stage = "return";
      const reason = !safety.safe
        ? `${safety.reason}; `
        : `${timedOut ? "time limit" : "belt kill limit"}; `;
      record(operation, kit, operation.siteInstanceID
        ? `Safely withdrawing from ${operation.siteLabel} (${reason}${siteIsComplete ? "Dungeon authority has already confirmed the clear; returning with any recovered loot." : "the site stays incomplete until its authority reports completion."})`
        : `Combat patrol withdrawing from belt ${operation.beltID} (${reason}returning to station).`);
      return { delayMs: 15_000 };
    }

    if (operation.pendingCombatAction) {
      const pendingTarget = scene.getEntityByID(Number(operation.pendingCombatAction.targetID));
      const alreadyAssigned = drones.some((drone) => Number(drone.targetID) === Number(operation.pendingCombatAction.targetID));
      if (pendingTarget && alreadyAssigned) {
        operation.targetID = Number(pendingTarget.itemID);
        operation.pendingCombatAction = null;
        kit.save(operation);
      } else {
        operation.pendingCombatAction = null;
        operation.targetID = null;
        record(operation, kit, "Recovered an interrupted combat command from current ship and drone state.");
      }
    }

    if (operation.stage === "site-loot") {
      const wreck = listUnlootedSiteWrecks(scene, operation.siteInstanceID, operation)
        .sort((left, right) => {
          const leftDistance = state.distanceTo(left.itemID) ?? Number.POSITIVE_INFINITY;
          const rightDistance = state.distanceTo(right.itemID) ?? Number.POSITIVE_INFINITY;
          return leftDistance - rightDistance || normalizeID(left.itemID) - normalizeID(right.itemID);
        })[0];
      if (!wreck) {
        operation.stage = "return";
        if (drones.length) require("../drone/droneRuntime").commandReturnBay(session, drones.map((drone) => Number(drone.itemID)));
        record(operation, kit, `Recovered all accessible wrecks after dungeon authority confirmed ${operation.siteLabel} complete; returning to sell the loot and settle income.`);
        return { delayMs: 15_000 };
      }
      const siteWreckDistance = state.distanceTo(wreck.itemID);
      if (siteWreckDistance === null) return { delayMs: 10_000 };
      if (siteWreckDistance > WARP_RANGE_METERS) {
        const result = space.warp(bot, wreck.itemID);
        return result.success ? { delayMs: 15_000 } : result.blocked
          ? { delayMs: 60_000, interdictionHold: true }
          : kit.block(operation, "holding", result.message);
      }
      if (siteWreckDistance > 2_000) {
        const result = space.approach(bot, wreck.itemID, 1_000);
        return result.success ? { delayMs: 15_000 } : kit.block(operation, "holding", result.message);
      }
      const loaded = inventory.loadFromContainer(bot, wreck.itemID);
      if (loaded.error || Number(loaded.remaining) > 0) {
        operation.siteLootRetryCount = Number(operation.siteLootRetryCount || 0) + 1;
        record(operation, kit, `Site wreck ${wreck.itemID} loot attempt ${operation.siteLootRetryCount} is incomplete: ${loaded.error || `${loaded.remaining} stack(s) remain`}.`);
        if (operation.siteLootRetryCount >= 3) {
          operation.stage = "return";
          record(operation, kit, "Leaving an inaccessible wreck after three attempts; the anomaly clear remains recorded from dungeon authority.");
        }
        kit.save(operation);
        return { delayMs: operation.stage === "return" ? 15_000 : 30_000 };
      }
      operation.siteLootWreckIDs = [...new Set([...(operation.siteLootWreckIDs || []), Number(wreck.itemID)])].slice(-500);
      operation.unitsCollected = Number(operation.unitsCollected || 0) + (Number(loaded.moved) || 0);
      operation.siteLootRetryCount = 0;
      record(operation, kit, `Recovered ${loaded.moved} item(s) from site wreck ${wreck.itemID}; checking the next remaining wreck.`);
      kit.save(operation);
      return { delayMs: 5_000 };
    }

    if (operation.stage === "loot") {
      const wreck = findWreckForTarget(scene, operation.lastDestroyedTargetID, operation.siteInstanceID);
      if (!wreck) {
        const firstMissingAt = Number(operation.wreckMissingSinceAt) || Date.now();
        operation.wreckMissingSinceAt = firstMissingAt;
        if (Date.now() - firstMissingAt < WRECK_APPEARANCE_GRACE_MS) {
          kit.save(operation);
          return { delayMs: 10_000 };
        }
        operation.stage = operation.defensiveLootResumeStage || (operation.siteInstanceID ? "site-engage" : "engage");
        operation.defensiveLootResumeStage = null;
        operation.targetID = null;
        operation.lastDestroyedTargetID = null;
        operation.emptySinceAt = Date.now();
        record(operation, kit, `${operation.lastTargetLabel || "Target"} disappeared without a confirmed wreck; it was not counted as a kill.`);
        return { delayMs: 10_000 };
      }
      operation.wreckMissingSinceAt = null;
      const distance = state.distanceTo(wreck.itemID);
      if (distance === null) {
        operation.stage = operation.defensiveLootResumeStage || (operation.siteInstanceID ? "site-engage" : "engage");
        operation.defensiveLootResumeStage = null;
        operation.targetID = null;
        operation.lastDestroyedTargetID = null;
        kit.save(operation);
        return { delayMs: 10_000 };
      }
      if (distance > WARP_RANGE_METERS) {
        const result = space.warp(bot, wreck.itemID);
        if (!result.success) return result.blocked
          ? { delayMs: 60_000, interdictionHold: true }
          : kit.block(operation, "holding", result.message);
        return { delayMs: 15_000 };
      }
      if (distance > 2_000) {
        const result = space.approach(bot, wreck.itemID, 1_000);
        if (!result.success) return kit.block(operation, "holding", result.message);
        return { delayMs: 15_000 };
      }
      operation.pendingCombatAction = { kind: "loot", targetID: operation.lastDestroyedTargetID, wreckID: Number(wreck.itemID) };
      kit.save(operation);
      const loaded = inventory.loadFromContainer(bot, wreck.itemID);
      operation.pendingCombatAction = null;
      if (loaded.error || Number(loaded.remaining) > 0) {
        operation.lootRetryCount = Number(loaded.moved) > 0
          ? 0
          : Number(operation.lootRetryCount || 0) + 1;
        operation.lastLootError = loaded.error || null;
        const reason = loaded.error || `${loaded.remaining} wreck item stack(s) remain.`;
        record(operation, kit, `Wreck loot attempt ${operation.lootRetryCount} did not finish: ${reason}`);
        if (operation.lootRetryCount >= 3) {
          operation.stage = "return";
          operation.withdrawRequested = true;
          operation.withdrawReason = "The patrol is returning after three incomplete attempts to recover the confirmed wreck.";
        }
        const crimewatch = require("../security/crimewatchState");
        const crimeState = crimewatch.getCharacterCrimewatchState(bot.characterID) || {};
        if (crimeState.suspect === true || crimeState.criminal === true) {
          operation.stage = "return";
          operation.withdrawRequested = true;
          operation.withdrawReason = "A Crimewatch timer is active after the wreck interaction; the pirate is withdrawing.";
          record(operation, kit, "A Crimewatch timer is active after the wreck interaction; the pirate is withdrawing.");
        }
        kit.save(operation);
        return { delayMs: operation.stage === "return" ? 15_000 : 30_000 };
      } else {
        operation.kills = Number(operation.kills || 0) + 1;
        operation.stage = operation.defensiveLootResumeStage || (operation.siteInstanceID ? "site-engage" : "engage");
        operation.defensiveLootResumeStage = null;
        operation.targetID = null;
        operation.lastDestroyedTargetID = null;
        operation.lootRetryCount = 0;
        operation.emptySinceAt = Date.now();
        record(operation, kit, `Collected ${loaded.moved} item(s) from wreck ${wreck.itemID}; ${loaded.remaining} item(s) remain.`);
      }
      return { delayMs: 10_000 };
    }

    if (operation.targetID) {
      const target = scene.getEntityByID(Number(operation.targetID));
      if (!target) {
        if (Number(operation.defensiveTargetID) === Number(operation.targetID)) {
          operation.defensiveTargetID = null;
          operation.targetID = null;
          operation.pendingCombatAction = null;
          if (operation.defensiveResumeStage) operation.stage = operation.defensiveResumeStage;
          operation.defensiveResumeStage = null;
          operation.emptySinceAt = Date.now();
          record(operation, kit, "The defensive target disappeared before a wreck was confirmed; resuming the patrol without counting a kill or attempting loot.");
          kit.save(operation);
          return { delayMs: 1_000 };
        }
        operation.lastDestroyedTargetID = Number(operation.targetID);
        operation.lastTargetLabel = operation.targetLabel || `target ${operation.targetID}`;
        operation.targetID = null;
        operation.stage = "loot";
        operation.wreckMissingSinceAt = Date.now();
        record(operation, kit, `${operation.lastTargetLabel} left the local grid; waiting to confirm a wreck before counting a kill.`);
        return { delayMs: 10_000 };
      }
      const combatContext = getCombatContext(bot, scene, entity, operation);
      const stillEligibleByMode = Number(operation.defensiveTargetID) === Number(target.itemID)
        ? eligibleDefensiveTarget(bot,target,scene,entity,operation,combatContext)
        : operation.mode === "piracy"
        ? combatPolicy.isEligiblePiracyTarget(target, combatContext)
        : operation.mode === "war"
          ? combatPolicy.isEligibleWarTarget(target, combatContext)
          : operation.mode === "nullsec-conflict"
            ? combatPolicy.isEligibleNullsecConflictTarget(target, combatContext)
          : combatPolicy.isPirateNpc(target);
      const stillEligible = stillEligibleByMode && require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(entity,target) &&
        (Number(operation.defensiveTargetID) === Number(target.itemID) || !operation.siteInstanceID ||
        Number(target.dungeonSiteInstanceID) === Number(operation.siteInstanceID));
      if (!stillEligible) {
        if (drones.length) require("../drone/droneRuntime").commandReturnBay(session, drones.map((drone) => Number(drone.itemID)));
        operation.targetID = null;
        operation.pendingCombatAction = null;
        operation.withdrawRequested = true;
      operation.withdrawReason = `Target ${target.itemID} is no longer eligible under the live war and Crimewatch policy; the patrol is withdrawing.`;
        operation.stage = "return";
        record(operation, kit, operation.withdrawReason);
        return { delayMs: 15_000 };
      }
      const assigned = drones.some((drone) => Number(drone.targetID) === Number(target.itemID));
      if (assigned) return { delayMs: 15_000 };
      operation.targetID = null;
      kit.save(operation);
    }

    let currentDrones = getControlledDrones(scene, entity.itemID);
    if (!currentDrones.length) {
      const launched = launchDrones(bot, session, scene, entity.itemID, operation.combatDroneTypeID);
      if (!launched.success) {
        operation.stage = "return";
        record(operation, kit, `${launched.message} The combat patrol is returning to station.`);
        return { delayMs: 15_000 };
      }
      currentDrones = launched.drones;
      record(operation, kit, `Launched ${currentDrones.length} combat drone(s) through the drone service.`);
    }

    const targets = operation.siteInstanceID
      ? listSiteEntities(scene, operation.siteInstanceID)
      : operation.miningEscortGroupKey && typeof scene.getVisibleEntitiesForSession === "function"
        ? scene.getVisibleEntitiesForSession(session)
        : [...(scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [])];
    const target = combatPolicy.selectCombatTarget(
      targets,
      operation.mode,
      getCombatContext(bot, scene, entity, operation),
    );
    const activeTarget = defensiveTarget || target;
    if (!activeTarget) {
      if (operation.siteInstanceID) {
        if (!siteInstance) {
          operation.siteIncomplete = true;
          operation.stage = "return";
          record(operation, kit, `Dungeon authority no longer has ${operation.siteLabel}; the combat operation remains incomplete and will not be reported as cleared.`);
          kit.save(operation);
          return { delayMs: 15_000 };
        }
        const gate = getUnlockedSiteGate(scene, siteInstance);
        if (gate) {
          const gateDistance = state.distanceTo(gate.itemID);
          const activationRange = Math.max(1_000, Number(gate.dungeonGateActivationRangeMeters) || 2_500);
          if (gateDistance === null) return { delayMs: 10_000 };
          if (gateDistance > WARP_RANGE_METERS) {
            const result = space.warp(bot, gate.itemID);
            return result.success ? { delayMs: 15_000 } : result.blocked
              ? { delayMs: 60_000, interdictionHold: true }
              : kit.block(operation, "holding", result.message);
          }
          if (gateDistance > activationRange - 500) {
            const result = space.approach(bot, gate.itemID, activationRange - 500);
            return result.success ? { delayMs: 10_000 } : kit.block(operation, "holding", result.message);
          }
          try {
            new (require("../dungeon/keeperService"))().Handle_ActivateAccelerationGate([Number(gate.itemID)], session);
            record(operation, kit, `Activated unlocked site gate ${gate.itemID} through dungeon authority to enter the next room of ${operation.siteLabel}.`);
            return { delayMs: 15_000 };
          } catch (error) {
            operation.lastGateError = space.describeError(error);
            kit.save(operation);
            return { delayMs: 30_000 };
          }
        }
        if (!Number(operation.emptySinceAt)) operation.emptySinceAt = Date.now();
        kit.save(operation);
        return { delayMs: 15_000 };
      }
      if (operation.miningEscortGroupKey) {
        if (!hasMiningEscortMembers(operation)) {
          if (drones.length) require("../drone/droneRuntime").commandReturnBay(
            session, drones.map((drone) => Number(drone.itemID)),
          );
          operation.stage = "return";
          record(operation, kit, `Mining group for belt ${operation.miningEscortBeltID} is no longer working there; the escort is returning to station.`);
          kit.save(operation);
          return { delayMs: 15_000 };
        }
        if (!Number(operation.emptySinceAt)) operation.emptySinceAt = Date.now();
        if (Date.now() - Number(operation.emptySinceAt) >= EMPTY_SYSTEM_GRACE_MS) {
          if (drones.length) require("../drone/droneRuntime").commandReturnBay(
            session, drones.map((drone) => Number(drone.itemID)),
          );
          operation.stage = "return";
          record(operation, kit, `No visible pirate NPCs remained on mining belt ${operation.miningEscortBeltID} for ${Math.round(EMPTY_SYSTEM_GRACE_MS / 1000)} seconds; the escort is returning to station.`);
          kit.save(operation);
          return { delayMs: 15_000 };
        }
        kit.save(operation);
        return { delayMs: 15_000 };
      }
      if (!Number(operation.emptySinceAt)) operation.emptySinceAt = Date.now();
      if (Date.now() - Number(operation.emptySinceAt) >= EMPTY_SYSTEM_GRACE_MS) {
        operation.stage = "return";
        if (operation.siteInstanceID) {
          operation.siteIncomplete = true;
          operation.siteFailureReason = "active-site-has-no-target-or-unlocked-gate";
          recordFailedAnomalySite(operation, operation.siteFailureReason);
        }
        record(operation, kit, `No eligible ${operation.mode === "piracy" ? "cargo-bearing pirate target or pirate NPC" : operation.mode === "war" ? "active war target" : operation.mode === "nullsec-conflict" ? "opposing corporation ship in the structure-conflict system" : "pirate NPC"} appeared during the patrol window; returning to station.`);
        return { delayMs: 15_000 };
      }
      kit.save(operation);
      return { delayMs: 15_000 };
    }
    operation.emptySinceAt = 0;
    const targetDistance = Math.hypot(
      Number(entity.position.x) - Number(activeTarget.position.x),
      Number(entity.position.y) - Number(activeTarget.position.y),
      Number(entity.position.z) - Number(activeTarget.position.z),
    );
    const effectiveDroneRange = Math.max(1_000, Math.min(
      DRONE_ATTACK_RANGE_METERS,
      Number(fit.droneAttackRange) || DRONE_ATTACK_RANGE_METERS,
      Number(fit.droneControlRange) || DRONE_ATTACK_RANGE_METERS,
    ));
    if (targetDistance > effectiveDroneRange * 0.8) {
      const moved = space.approach(bot, activeTarget.itemID, Math.min(APPROACH_RANGE_METERS, effectiveDroneRange * 0.7));
      if (!moved.success) return kit.block(operation, "holding", moved.message);
      return { delayMs: 15_000 };
    }
    operation.targetID = Number(activeTarget.itemID);
    operation.targetLabel = String(activeTarget.itemName || activeTarget.itemID);
    operation.pendingCombatAction = { kind: "engage", targetID: Number(activeTarget.itemID), startedAt: new Date().toISOString() };
    kit.save(operation);
    const response = require("../drone/droneRuntime").commandEngage(
      session,
      currentDrones.map((drone) => Number(drone.itemID)),
      Number(activeTarget.itemID),
    );
    const refreshed = getControlledDrones(scene, entity.itemID);
    if (!refreshed.some((drone) => Number(drone.targetID) === Number(activeTarget.itemID))) {
      operation.targetID = null;
      operation.pendingCombatAction = null;
      operation.stage = "return";
      operation.defensiveTargetID = null;
      record(operation, kit, `Drone combat authority refused target ${activeTarget.itemID}: ${JSON.stringify(response && response.entries || []).slice(0, 180)}.`);
      return { delayMs: 15_000 };
    }
    operation.pendingCombatAction = null;
    record(operation, kit, Number(operation.defensiveTargetID) === Number(activeTarget.itemID)
      ? `Responding to legal hostile ship ${activeTarget.itemID} with ${refreshed.length} drone(s); the attack will be revalidated each combat step.`
      : `Engaged eligible ${activeTarget.npcEntityType === "npc" ? "pirate NPC" : operation.mode === "war" ? "war target" : "cargo-bearing player ship"} ${activeTarget.itemID} with ${refreshed.length} drone(s).`);
    return { delayMs: Number(operation.defensiveTargetID) === Number(activeTarget.itemID) ? 1_000 : 15_000 };
  }

  if (operation.stage === "return") {
    const session = space.getActorSession(bot);
    const isCapsule = Number(session.shipTypeID || character.shipTypeID) === 670;
    const characterState = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
    const docked = Number(session.stationID || session.structureID || characterState.stationID || characterState.structureID) > 0;
    const attached = docked ? null : space.getActorSpace(bot);
    const drones = attached ? getControlledDrones(attached.scene, attached.entity.itemID) : [];
    let alreadyTravellingHome = false;
    if (drones.length) {
      require("../drone/droneRuntime").commandReturnBay(session, drones.map((drone) => Number(drone.itemID)));
      if (!operation.emergencyRetreat) return { delayMs: 30_000 };
      const state = space.getSpaceState(bot);
      if (Number(state.warpScrambleStatus) > 0) {
        const tackler = findWarpTackler(attached.scene, attached.entity, bot, operation);
        if (tackler) {
          const response = require("../drone/droneRuntime").commandEngage(
            session,
            drones.map((drone) => Number(drone.itemID)),
            Number(tackler.itemID),
          );
          operation.targetID = Number(tackler.itemID);
          operation.targetLabel = String(tackler.itemName || tackler.itemID);
          record(operation, kit, `Emergency retreat is warp-scrambled; combat drones are clearing tackle ${tackler.itemID} before the ship warps out.`);
          return { delayMs: 5_000, combatResponse: response && response.entries || [] };
        }
        return { delayMs: 5_000 };
      }
      // Recall drones, but do not leave a damaged ship exposed for another
      // full drone-return interval. Warp and navigation proceed immediately;
      // drones that reach the bay first are retained, while the ship escapes.
      if (!operation.emergencyDepartureOrderedAt) {
        operation.emergencyDepartureOrderedAt = Date.now();
        record(operation, kit, `Emergency retreat is leaving immediately while ${drones.length} drone(s) return to bay; the ship will not wait under fire.`);
      }
      const contextRelease = ensureCombatSiteContextReleased(operation, attached, kit);
      if (contextRelease) return contextRelease;
      const step = await kit.travelToStation(operation, bot, operation.homeStationID);
      if (step) return step;
      alreadyTravellingHome = true;
    } else {
      const state = docked ? null : space.getSpaceState(bot);
      if (operation.emergencyRetreat && state && Number(state.warpScrambleStatus) > 0) {
        const tackler = attached && findWarpTackler(attached.scene, attached.entity, bot, operation);
        if (tackler) {
          const launched = launchDrones(bot, session, attached.scene, attached.entity.itemID, operation.combatDroneTypeID);
          if (launched.success) {
            const response = require("../drone/droneRuntime").commandEngage(
              session,
              launched.drones.map((drone) => Number(drone.itemID)),
              Number(tackler.itemID),
            );
            record(operation, kit, `Emergency retreat is warp-scrambled; launched combat drones to clear tackle ${tackler.itemID}.`);
            return { delayMs: 5_000, combatResponse: response && response.entries || [] };
          }
        }
        return { delayMs: 5_000 };
      }
    }
    const contextRelease = ensureCombatSiteContextReleased(operation, attached, kit);
    if (contextRelease) return contextRelease;
    const step = alreadyTravellingHome ? null : await kit.travelToStation(operation, bot, operation.homeStationID);
    if (step) return step;
    const repaired = await repairAtStation(operation, bot, kit, { quoteOnly: isCapsule });
    if (isCapsule && repaired.success) {
      operation.combatHullLost = true;
      operation.siteIncomplete = Boolean(operation.siteInstanceID && operation.siteCompleted !== true);
      operation.siteFailureReason ||= "combat-hull-lost";
      record(operation, kit,
        "The capsule reached a station with online repair service; there is no combat hull to repair, so it is proceeding to settle carried loot before ship recovery.");
    }
    if (!repaired.success) {
      if (/REPAIR_OFFLINE/i.test(String(repaired.message || ""))) {
        const repairStation = findNearestRepairStation(bot);
        if (repairStation.success && retargetCombatRepairBase(operation, repairStation)) {
          operation.status = "active";
          operation.lastError = null;
          record(operation, kit,
            `Repair service is offline at the selected base; rerouting to ${repairStation.stationName} (${repairStation.stationID}) in system ${repairStation.systemID} for repair and market access${repairStation.hops ? ` (${repairStation.hops} jumps)` : ""}.`);
          return { delayMs: 5_000, repairRouted: true };
        }
      }
      return kit.block(operation, "blocked", `The combat ship is safely docked, but ${repaired.message} The director will leave it idle until repairs are available.`);
    }
    if (repaired.repaired) record(operation, kit, `Repaired the combat ship through the station repair service for ${repaired.amount.toFixed(2)} ISK.`);
    operation.emergencyRetreat = false;
    operation.emergencyDepartureOrderedAt = null;
    operation.stage = "to-market";
    kit.save(operation);
  }
  if (operation.stage === "to-market") {
    const step = await kit.travelToStation(operation, bot, operation.marketStationID);
    if (step) return step;
    inventory.unloadCargo(bot);
    operation.stage = "market-sell";
    kit.save(operation);
  }
  if (operation.stage === "market-sell") {
    const currentSession = space.getActorSession(bot);
    const isCapsule = Number(currentSession.shipTypeID || 0) === 670;
    const route = isCapsule
      ? null
      : await kit.maybeBeginRegionalSaleRoute(operation, bot, operation.marketStationID, "market-sell");
    if (route) return route;
    await kit.sellMiningOutput(operation, bot, operation.marketStationID);
    if (operation.siteInstanceID && operation.siteCompleted !== true) {
      const site = getSiteInstance(operation);
      if (site && String(site.lifecycleState || "").toLowerCase() === "completed") {
        operation.siteCompleted = true;
        operation.siteIncomplete = false;
        record(operation, kit, `Dungeon authority confirmed ${operation.siteLabel} completed during the regional return leg.`);
      } else if (isCapsule) {
        operation.siteIncomplete = true;
        operation.siteFailureReason = "combat-hull-lost";
        operation.siteHandedOff = true;
        operation.siteHandedOffReason = "combat-hull-lost";
        operation.siteAbandoned = false;
        operation.routeTaskID = null;
        operation.stage = "corp-share";
        kit.record(operation,
          `${operation.siteLabel} remains incomplete because the combat hull was lost; releasing its claim so a fitted pilot can continue it. No site clear is recorded.`);
      } else if (!site || String(site.lifecycleState || "").toLowerCase() !== "active") {
        operation.siteIncomplete = true;
        operation.siteUnavailable = true;
        operation.siteFailureReason ||= "site-no-longer-active";
        recordFailedAnomalySite(operation, operation.siteFailureReason);
        if (retargetToAnotherAnomaly(operation, bot, kit)) return { delayMs: 10_000 };
        operation.siteAbandoned = true;
        operation.stage = "corp-share";
        kit.record(operation, `Combat income was settled, but ${operation.siteLabel} never reached the authority's completed state and no other eligible anomaly is available. The site remains explicitly incomplete.`);
      } else if (!require("./playerBotOperationRuntime").hasRoleShipFit(bot,
        operation.mode === "piracy" ? "piracy" : "security")) {
        operation.marketStationID = normalizeID(operation.homeStationID) || operation.marketStationID;
        operation.optimizeMarketDestination = true;
        operation.siteIncomplete = true;
        const replenishment = kit.startCombatReplenishment(operation, bot);
        if (!replenishment) {
          return kit.block(operation, "holding", `The combat fit for ${operation.siteLabel} is incomplete, and no safe same-hull replacement package is available yet. The active site remains reserved; the pilot will retry after market supply or wallet state changes.`);
        }
        return { delayMs: 5_000, replenishingCombatFit: true };
      } else {
        // Keep an active anomaly's next repair and sale leg local. A central
        // market detour can add dozens of jumps even when no saleable loot was
        // recovered; the regional buyer planner handles actual cargo.
        operation.marketStationID = normalizeID(operation.homeStationID) || operation.marketStationID;
        operation.optimizeMarketDestination = true;
        operation.siteIncomplete = true;
        operation.siteFailureReason ||= "site-attempt-ended-without-authoritative-clear";
        operation.siteRetryCount = Math.max(0, Math.trunc(Number(operation.siteRetryCount) || 0)) + 1;
        if (operation.siteRetryCount > 1) {
          recordFailedAnomalySite(operation, operation.siteFailureReason);
          operation.siteHandedOff = true;
          operation.siteAbandoned = false;
          operation.stage = "corp-share";
          operation.routeTaskID = null;
          kit.record(operation, `After two safe attempts, ${operation.siteLabel} remains active and incomplete. Releasing its claim so another eligible pilot can continue it; no clear is recorded.`);
          kit.save(operation);
          return { delayMs: 5_000, siteHandedOff: true };
        }
        operation.stage = "to-home";
        operation.routeTaskID = null;
        operation.tripStartedAt = null;
        operation.siteContextReleasedAtMs = 0;
        operation.targetID = null;
        operation.pendingCombatAction = null;
        operation.lastDestroyedTargetID = null;
        operation.wreckMissingSinceAt = null;
        operation.emergencyRetreat = false;
        operation.siteAbandoned = false;
        record(operation, kit, `Regional sale and repairs are complete; ${operation.siteLabel} is still active, so the pilot is making one retry at the same site to finish its remaining waves.`);
        return { delayMs: 15_000 };
      }
    }
    operation.stage = "corp-share";
    kit.save(operation);
  }
  if (operation.stage === "corp-share") {
    if (operation.siteCompleted === true && Number(operation.siteInstanceID) > 0) {
      try {
        require("./playerBotCombatProgressRuntime").recordSiteClear(
          bot.characterID,
          operation.siteInstanceID,
          operation.siteDifficulty,
        );
      } catch (error) {
        return kit.block(operation, "holding", `Could not save the confirmed anomaly progression: ${String(error && error.message || error).slice(0, 160)}`);
      }
    }
    const endingBalance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
    const netGain = Math.max(0, endingBalance - Number(operation.startingBalance || 0));
    try {
      operation.corpShare = await require("./playerBotCorpEconomyRuntime").payCorpShare(
        bot,
        netGain,
        `${operation.mode} operation ${operation.operationID}`,
        `${operation.mode}:${operation.operationID}`,
      );
      operation.corpShareSettled = true;
    } catch (error) {
      return kit.block(operation, "holding", `Could not settle the corporation share: ${String(error && error.message || error).slice(0, 160)}`);
    }
    operation.noOpportunity = Number(operation.kills || 0) === 0 && operation.siteCompleted !== true;
    const operationLabel = operation.mode === "piracy" ? "Piracy" : operation.mode === "war" ? "War patrol" : operation.mode === "nullsec-conflict" ? "Null-sec structure conflict patrol" : "Security patrol";
    const outcome = operation.siteUnavailable === true
      ? ` ended with ${operation.siteLabel} incomplete because dungeon authority no longer listed it; the anomaly was not reported as cleared: `
      : operation.siteHandedOff === true
        ? operation.siteHandedOffReason === "combat-hull-lost"
          ? ` released ${operation.siteLabel} to the shared site pool after the combat hull was lost; it remains incomplete and no clear was recorded: `
          : ` handed ${operation.siteLabel} back to the shared site pool after two safe attempts; it remains incomplete and no clear was recorded: `
      : operation.siteAbandoned === true
        ? ` ended with ${operation.siteLabel} incomplete after a safe attempt and no alternate eligible site; it was not reported as cleared: `
        : " completed: ";
    return kit.finish(operation,
      `${operationLabel}${outcome}${Number(operation.kills || 0)} target(s) destroyed, ` +
      `${Number(operation.unitsSold || 0)} loot/mineral unit(s) sold for ${Number(operation.proceeds || 0).toFixed(2)} ISK, ` +
      `${Number(operation.unitsListed || 0)} unit(s) listed; spent ${Number(operation.spent || 0).toFixed(2)} ISK.`);
  }
  return kit.block(operation, "blocked", `Unknown combat stage ${operation.stage}.`);
}

module.exports = {
  botVersusBotCombatEnabled,
  getCombatContext,
  getControlledDrones,
  launchDrones,
  estimateEffectiveHitPoints,
  advanceCombat,
  assessDefensiveResponse,
  authorizeFleetAttackTarget,
  findNearestPirateBase,
  listPirateBaseCandidates,
  recordPatrolDeployment,
  findNearestCombatAnomalyBase,
  findNearestWarBase,
  findNearestNullsecConflictBase(bot, maxHops = 24) {
    return require("./playerBotNullsecConflictRuntime").findNearestConflictBase(bot, maxHops);
  },
  findNearestRepairStation,
  retargetCombatRepairBase,
  getCombatBaseLocations,
  requestSafeRetreat(operation, bot, reason = "Combat patrol stopped by an operator; returning to station.") {
    operation.withdrawRequested = true;
    operation.withdrawReason = String(reason).slice(0, 240);
    if (!["to-market", "market-sell", "corp-share"].includes(operation.stage)) {
      operation.stage = "return";
    }
    try {
      const space = require("./playerBotSpaceRuntime");
      const session = space.getActorSession(bot);
      if (Number(session.stationID || session.structureID) <= 0) {
        const attached = space.getActorSpace(bot);
        const drones = getControlledDrones(attached.scene, attached.entity.itemID);
        if (drones.length) require("../drone/droneRuntime").commandReturnBay(session, drones.map((drone) => Number(drone.itemID)));
      }
    } catch (_) {
      // The durable return stage retries once the bot has a space actor.
    }
    return operation;
  },
  _testing: {
    estimateEffectiveHitPoints,
    selectAvailableAnomaly,
    resolveSiteDifficulty,
    resolveSiteFactionKey,
    listCombatAnomaliesInSystem,
    getCombatBaseLocations,
    getUnlockedSiteGate,
    listSiteEntities,
    listUnlootedSiteWrecks,
    findWreckForTarget,
  },
};

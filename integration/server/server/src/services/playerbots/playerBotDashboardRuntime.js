"use strict";

// The dashboard is an operator view, not part of a bot's decision loop. A
// longer cache keeps reads bounded as the persistent roster grows.
const CACHE_MS = 30_000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const REQUESTED_TOTAL_BOTS = 15_000;
const REQUESTED_ONLINE_BOTS = 5_000;
const LAST_VALIDATED_ROSTER = 500;
const LAST_VALIDATED_ONLINE = 500;

function positiveInteger(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function boundedInteger(value, fallback, maximum) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) ? Math.max(0, Math.min(maximum, number)) : fallback;
}

function activeStatus(operation) {
  return Boolean(operation && !["completed", "finished", "stopped", "cancelled", "canceled", "failed", "abandoned"].includes(String(operation.status || "").toLowerCase()));
}

function createPlayerBotDashboardRuntime(options = {}) {
  const playerBots = options.playerBots || require("./playerBotRuntime");
  const characters = options.characters || require("../character/characterState");
  const corporations = options.corporations || require("../corporation/corporationState");
  const factions = options.factions || options.factionState || require("../faction/factionState");
  const space = options.space || require("./playerBotSpaceRuntime");
  const operations = options.operations || require("./playerBotOperationRuntime");
  const industryCycles = options.industryCycles || require("./playerBotIndustryCycleRuntime");
  const directorAssignments = options.directorAssignments || require("./playerBotDirectorRuntime");
  const tasks = options.tasks || require("./playerBotTaskRuntime");
  const autonomy = options.autonomy || require("./playerBotAutonomyRuntime");
  const worldData = options.worldData || require("../../space/worldData");
  const sessions = options.sessions || require("../chat/sessionRegistry");
  const fleetRuntime = options.fleetRuntime || require("../fleets/fleetRuntime");
  const warRuntime = options.warRuntime || require("../corporation/warRuntimeState");
  const structureState = options.structureState || require("../structure/structureState");
  const sovereigntyState = options.sovereigntyState || require("../sovereignty/sovState");
  const killmailState = options.killmailState || require("../killmail/killmailState");

  let snapshot = null;
  let snapshotAtMs = 0;
  let roster = [];
  let operationByCharacter = new Map();
  let activeWorkByCharacter = new Map();
  let queuedColonyByCharacter = new Map();
  let operationSummaryCache = null;
  let taskSummaryCache = { byCharacter: {} };
  let corporationNameByID = new Map();
  let killboardSnapshot = null;
  let killboardSnapshotAtMs = 0;
  let killboardCharacterNames = new Map();
  let killboardCorporationNames = new Map();
  let killboardTypeNames = new Map();
  let killboardTypes = new Map();
  // Ship names for the roster come from the same type registry the killboard
  // uses; the cache is shared so a hull is resolved once.
  const shipTypeName = (typeID) => {
    const id = positiveInteger(typeID);
    if (!id) return "";
    if (killboardTypeNames.has(id)) return killboardTypeNames.get(id);
    let type = null;
    try {
      type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(id) || null;
    } catch (_) {
      type = null;
    }
    const name = String(type && (type.name || type.typeName) || "");
    if (name) killboardTypeNames.set(id, name);
    return name;
  };
  let killboardFactionNames = new Map();
  let killboardKnownCharacters = new Map();

  function getKillboardSnapshot() {
    const now = Date.now();
    if (killboardSnapshot && now - killboardSnapshotAtMs < 30_000) return killboardSnapshot;
    if (!snapshot) refresh();
    const records = typeof killmailState.getAllKillmailRecords === "function"
      ? killmailState.getAllKillmailRecords()
      : [];
    const botByID = new Map(roster.map((bot) => [Number(bot.characterID), bot]));
    const botCorpIDs = new Set(roster.map((bot) => Number(bot.corporationID || bot.specialtyCorporationID)).filter(Boolean));
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const filetimeToMs = (value) => {
      try {
        const ticks = BigInt(String(value || 0));
        return ticks > 116444736000000000n
          ? Number((ticks - 116444736000000000n) / 10_000n)
          : 0;
      } catch { return 0; }
    };
    const characterName = (characterID) => {
      const id = positiveInteger(characterID);
      if (!id) return "Unknown pilot";
      if (killboardCharacterNames.has(id)) return killboardCharacterNames.get(id);
      const bot = botByID.get(id);
      const name = String(bot && bot.characterName || dashboardCharacter(id).characterName || `Pilot ${id}`);
      killboardCharacterNames.set(id, name);
      return name;
    };
    const corporationName = (corporationID) => {
      const id = positiveInteger(corporationID);
      if (!id) return "Unknown corporation";
      if (killboardCorporationNames.has(id)) return killboardCorporationNames.get(id);
      const corporation = corporations.getCorporationRecord(id);
      const name = String(corporation && corporation.corporationName || `Corporation ${id}`);
      killboardCorporationNames.set(id, name);
      return name;
    };
    const factionName = (factionID) => {
      const id = positiveInteger(factionID);
      if (!id) return "";
      if (killboardFactionNames.has(id)) return killboardFactionNames.get(id);
      const faction = typeof factions.getFactionRecord === "function" ? factions.getFactionRecord(id) : null;
      const name = String(faction && (faction.name || faction.factionName) || `Faction ${id}`);
      killboardFactionNames.set(id, name);
      return name;
    };
    const isKnownCharacter = (characterID) => {
      const id = positiveInteger(characterID);
      if (!id) return false;
      if (killboardKnownCharacters.has(id)) return killboardKnownCharacters.get(id);
      // peekCharacterRecord is deliberately read-only and avoids normalizing
      // or hydrating unknown NPC IDs while scanning historical killmails.
      const known = typeof characters.peekCharacterRecord === "function"
        ? Boolean(characters.peekCharacterRecord(id))
        : false;
      killboardKnownCharacters.set(id, known);
      return known;
    };
    const typeName = (typeID) => {
      const id = positiveInteger(typeID);
      if (!id) return "Unknown ship";
      if (killboardTypeNames.has(id)) return killboardTypeNames.get(id);
      const type = typeRecord(id);
      const name = String(type && (type.name || type.typeName) || `Type ${id}`);
      killboardTypeNames.set(id, name);
      return name;
    };
    const typeRecord = (typeID) => {
      const id = positiveInteger(typeID);
      if (!id) return null;
      if (killboardTypes.has(id)) return killboardTypes.get(id);
      const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(id) || null;
      killboardTypes.set(id, type);
      return type;
    };
    const isNpcCorporation = (corporationID) => {
      const id = positiveInteger(corporationID);
      if (!id) return false;
      if (typeof corporations.isNpcCorporationID === "function") return corporations.isNpcCorporationID(id);
      return id >= 1_000_000 && id < 2_000_000;
    };
    const classifySide = ({ characterID, corporationID, factionID, shipTypeID }) => {
      const character = positiveInteger(characterID);
      if (character && botByID.has(character)) return "playerbot";
      const categoryID = Number(typeRecord(shipTypeID)?.categoryID) || 0;
      if (categoryID === 65) return "structure";
      // NPC ships can use hulls that also appear in capsuleer fits. A native
      // NPC may also carry a synthetic character ID, so check the NPC corp or
      // faction before trusting an ID that is absent from the character store.
      // Known capsuleers in NPC starter corps remain player losses.
      if (character && isKnownCharacter(character)) return "player";
      if (isNpcCorporation(corporationID) || positiveInteger(factionID)) return "npc";
      if (character) return "player";
      return "other";
    };
    const pilotStats = new Map();
    const corporationStats = new Map();
    const shipLosses = new Map();
    let day = 0;
    let week = 0;
    let pods = 0;
    let npcDeaths = 0;
    let playerbotDeaths = 0;
    let playerDeaths = 0;
    let structureLosses = 0;
    let playerbotFinalBlows = 0;
    let npcFinalBlows = 0;
    let playerFinalBlows = 0;
    const recent = [];
    for (const record of records) {
      const timeMs = filetimeToMs(record.killTime);
      if (timeMs >= dayAgo) day += 1;
      if (timeMs >= weekAgo) week += 1;
      const victimCharacterID = positiveInteger(record.victimCharacterID);
      const finalCharacterID = positiveInteger(record.finalCharacterID);
      const victimCorporationID = positiveInteger(record.victimCorporationID);
      const finalCorporationID = positiveInteger(record.finalCorporationID);
      const shipTypeID = positiveInteger(record.victimShipTypeID);
      const victimCategory = classifySide({
        characterID: victimCharacterID,
        corporationID: victimCorporationID,
        factionID: record.victimFactionID,
        shipTypeID,
      });
      const finalCategory = classifySide({
        characterID: finalCharacterID,
        corporationID: finalCorporationID,
        factionID: record.finalFactionID,
        shipTypeID: record.finalShipTypeID,
      });
      if (victimCategory === "npc") npcDeaths += 1;
      else if (victimCategory === "playerbot") playerbotDeaths += 1;
      else if (victimCategory === "player") playerDeaths += 1;
      else if (victimCategory === "structure") structureLosses += 1;
      if (finalCategory === "playerbot") playerbotFinalBlows += 1;
      else if (finalCategory === "npc") npcFinalBlows += 1;
      else if (finalCategory === "player") playerFinalBlows += 1;
      if (/capsule|pod/i.test(typeName(shipTypeID))) pods += 1;
      if (shipTypeID) shipLosses.set(shipTypeID, (shipLosses.get(shipTypeID) || 0) + 1);
      if (botByID.has(finalCharacterID)) {
        const pilot = pilotStats.get(finalCharacterID) || { characterID: finalCharacterID, name: characterName(finalCharacterID), corporationID: Number(botByID.get(finalCharacterID).corporationID) || 0, kills: 0, losses: 0 };
        pilot.kills += 1;
        pilotStats.set(finalCharacterID, pilot);
      }
      if (botByID.has(victimCharacterID)) {
        const pilot = pilotStats.get(victimCharacterID) || { characterID: victimCharacterID, name: characterName(victimCharacterID), corporationID: Number(botByID.get(victimCharacterID).corporationID) || 0, kills: 0, losses: 0 };
        pilot.losses += 1;
        pilotStats.set(victimCharacterID, pilot);
      }
      const attackerCorporations = new Set((Array.isArray(record.attackers) ? record.attackers : [])
        .map((attacker) => positiveInteger(attacker && attacker.corporationID)).filter((id) => botCorpIDs.has(id)));
      for (const corporationID of attackerCorporations) {
        const stats = corporationStats.get(corporationID) || { corporationID, name: corporationName(corporationID), kills: 0, losses: 0, npcKills: 0, capsuleerKills: 0 };
        stats.kills += 1;
        if (victimCategory === "npc") stats.npcKills += 1;
        else if (victimCategory === "player" || victimCategory === "playerbot") stats.capsuleerKills += 1;
        corporationStats.set(corporationID, stats);
      }
      if (botCorpIDs.has(victimCorporationID)) {
        const stats = corporationStats.get(victimCorporationID) || { corporationID: victimCorporationID, name: corporationName(victimCorporationID), kills: 0, losses: 0, npcKills: 0, capsuleerKills: 0 };
        stats.losses += 1;
        corporationStats.set(victimCorporationID, stats);
      }
      if (recent.length < 100) {
        const systemID = positiveInteger(record.solarSystemID);
        const system = systemID ? worldData.getSolarSystemByID(systemID) || {} : {};
        recent.push({
          killID: Number(record.killID) || 0,
          time: timeMs ? new Date(timeMs).toISOString() : "",
          solarSystemID: systemID,
          systemName: String(system.solarSystemName || system.name || `System ${systemID || 0}`),
          victimCharacterID: victimCategory === "npc" ? null : victimCharacterID,
          victimName: victimCategory === "npc" ? "NPC ship" : victimCategory === "structure" ? "Structure" : victimCharacterID ? characterName(victimCharacterID) : corporationName(victimCorporationID),
          victimCategory,
          victimCorporationID,
          victimCorporationName: corporationName(victimCorporationID),
          victimFactionID: positiveInteger(record.victimFactionID),
          victimFactionName: factionName(record.victimFactionID),
          victimShipTypeID: shipTypeID,
          victimShipName: typeName(shipTypeID),
          finalCharacterID: finalCategory === "npc" ? null : finalCharacterID,
          finalName: finalCharacterID && finalCategory !== "npc" ? characterName(finalCharacterID) : finalCategory === "npc" ? "NPC" : corporationName(finalCorporationID),
          finalCategory,
          finalCorporationID,
          finalCorporationName: corporationName(finalCorporationID),
          finalFactionID: positiveInteger(record.finalFactionID),
          finalFactionName: factionName(record.finalFactionID),
          iskLost: Math.max(0, Number(record.iskLost) || 0),
        });
      }
    }
    const pilots = [...pilotStats.values()].sort((left, right) => right.kills - left.kills || left.losses - right.losses).slice(0, 25);
    const corporationsBoard = [...corporationStats.values()].sort((left, right) => (right.kills + right.losses) - (left.kills + left.losses)).slice(0, 25);
    const ships = [...shipLosses.entries()].map(([typeID, lost]) => ({ typeID, name: typeName(typeID), lost }))
      .sort((left, right) => right.lost - left.lost).slice(0, 25);
    killboardSnapshot = {
      generatedAt: new Date(now).toISOString(),
      total: records.length,
      day,
      week,
      pods,
      npcDeaths,
      playerbotDeaths,
      playerDeaths,
      structureLosses,
      playerbotFinalBlows,
      npcFinalBlows,
      playerFinalBlows,
      pilots,
      corporations: corporationsBoard,
      ships,
      recent,
    };
    killboardSnapshotAtMs = now;
    return killboardSnapshot;
  }

  function sharedCharacter(characterID) {
    if (typeof characters.readSharedCharacterRecord === "function") {
      return characters.readSharedCharacterRecord(characterID) || {};
    }
    return characters.getCharacterRecord(characterID) || {};
  }

  function dashboardCharacter(characterID) {
    if (typeof characters.peekCharacterRecord === "function") {
      return characters.peekCharacterRecord(characterID) || {};
    }
    return sharedCharacter(characterID);
  }

  function refresh() {
    const now = Date.now();
    if (snapshot && now - snapshotAtMs < CACHE_MS) return snapshot;

    roster = typeof playerBots.listBotProfiles === "function"
      ? playerBots.listBotProfiles()
      : playerBots.listBots();
    const botIDs = new Set(roster.map((bot) => Number(bot.characterID)).filter(Boolean));
    const bySpecialty = new Map();
    const byCorporation = new Map();
    const bySystem = new Map();
    const locationByBotID = new Map();
    const latestOperations = typeof operations.getDashboardOperationSummary === "function"
      ? null
      : operations.listOperations();
    operationSummaryCache = typeof operations.getDashboardOperationSummary === "function"
      ? operations.getDashboardOperationSummary(20)
      : null;
    operationByCharacter = new Map((latestOperations || []).map((operation) => [Number(operation.characterID), operation]));

    const activeOperations = typeof operations.listActiveOperationRecords === "function"
      ? operations.listActiveOperationRecords()
      : (latestOperations || operations.listOperations()).filter(activeStatus);
    const activeCycles = typeof industryCycles.listActiveCycleRecords === "function"
      ? industryCycles.listActiveCycleRecords()
      : typeof industryCycles.listActiveCycles === "function" ? industryCycles.listActiveCycles() : [];
    activeWorkByCharacter = new Map();
    for (const operation of activeOperations) {
      const characterID = positiveInteger(operation && operation.characterID);
      if (characterID) activeWorkByCharacter.set(characterID, operation);
    }
    for (const cycle of activeCycles) {
      const characterID = positiveInteger(cycle && cycle.characterID);
      if (characterID && !activeWorkByCharacter.has(characterID)) {
        activeWorkByCharacter.set(characterID, { ...cycle, operationID: cycle.cycleID, kind: "industry" });
      }
    }

    queuedColonyByCharacter = new Map();
    const queuedDirectorAssignments = typeof directorAssignments.listQueuedColonySetupAssignments === "function"
      ? directorAssignments.listQueuedColonySetupAssignments(roster.map((bot) => bot && bot.characterID))
      : null;
    for (const bot of roster) {
      const characterID = positiveInteger(bot && bot.characterID);
      if (!characterID || (!queuedDirectorAssignments && typeof directorAssignments.getBotDirectorAssignment !== "function")) continue;
      const assignment = queuedDirectorAssignments
        ? queuedDirectorAssignments[String(characterID)] || null
        : directorAssignments.getBotDirectorAssignment(characterID) || {};
      if (!assignment || (!queuedDirectorAssignments && assignment.queuedColonySetup !== true)) continue;
      queuedColonyByCharacter.set(characterID, {
        kind: "colony",
        status: "queued",
        reason: String(assignment.queuedReason || "Waiting for a planetary setup slot.").slice(0, 240),
        reasonCode: String(assignment.queuedReasonCode || "colony-setup-limit").slice(0, 80),
        queuedAt: Number(assignment.queuedAt) || 0,
      });
    }

    for (const bot of roster) {
      const specialty = String(bot.specialty || "unassigned");
      bySpecialty.set(specialty, (bySpecialty.get(specialty) || 0) + 1);

      const character = dashboardCharacter(bot.characterID);
      locationByBotID.set(Number(bot.characterID), {
        stationID: positiveInteger(character.stationID),
        structureID: positiveInteger(character.structureID),
      });
      const corporationID = positiveInteger(
        character.corporationID || bot.corporationID || bot.specialtyCorporationID,
      );
      if (corporationID) {
        let entry = byCorporation.get(corporationID);
        if (!entry) {
          const corporation = corporations.getCorporationRecord(corporationID) || {};
          entry = {
            corporationID,
            corporationName: String(corporation.corporationName || `Corporation ${corporationID}`),
            ticker: String(corporation.tickerName || ""),
            allianceID: positiveInteger(corporation.allianceID),
            memberCount: Math.max(0, Number(corporation.memberCount) || 0),
            memberLimit: Math.max(0, Number(corporation.memberLimit) || 0),
            botCount: 0,
            specialties: new Set(),
          };
          byCorporation.set(corporationID, entry);
        }
        entry.botCount += 1;
        entry.specialties.add(specialty);
      }

      const systemID = positiveInteger(character.solarSystemID || character.solarsystemid);
      if (systemID) bySystem.set(systemID, (bySystem.get(systemID) || 0) + 1);
    }

    const onlineBotIDs = new Set();
    const connectedHumanIDs = new Set();
    const inSpaceBotIDs = new Set();
    let humansInSpace = 0;
    const currentSessions = sessions.getSessions();
    for (const session of currentSessions) {
      if (!session) continue;
      const characterID = Number(session.characterID || session.charID || session.charid);
      if (session._playerBotActor === true || botIDs.has(characterID)) {
        if (!botIDs.has(characterID)) continue;
        onlineBotIDs.add(characterID);
        if (session._space) inSpaceBotIDs.add(characterID);
      } else if (Number.isSafeInteger(characterID) && characterID > 0) {
        connectedHumanIDs.add(characterID);
        if (session._space) humansInSpace += 1;
      }
    }
    let dockedAtStation = 0;
    let dockedAtStructure = 0;
    let connectedLocationUnknown = 0;
    for (const characterID of onlineBotIDs) {
      if (inSpaceBotIDs.has(characterID)) continue;
      const location = locationByBotID.get(characterID) || {};
      if (location.stationID) dockedAtStation += 1;
      else if (location.structureID) dockedAtStructure += 1;
      else connectedLocationUnknown += 1;
    }
    const actorsInSpace = inSpaceBotIDs.size;

    const fleetRows = [];
    let fleetBotMembers = 0;
    let fleetHumanMembers = 0;
    const fleetMap = fleetRuntime.runtimeState && fleetRuntime.runtimeState.fleets;
    if (fleetMap && typeof fleetMap.values === "function") {
      for (const fleet of fleetMap.values()) {
        const members = fleet && fleet.members && typeof fleet.members.values === "function"
          ? [...fleet.members.values()]
          : [];
        if (!members.length) continue;
        let botMembers = 0;
        let humanMembers = 0;
        let systemID = 0;
        for (const member of members) {
          const characterID = Number(member && member.charID) || 0;
          if (botIDs.has(characterID)) botMembers += 1;
          else humanMembers += 1;
          if (!systemID) systemID = positiveInteger(member && member.solarSystemID);
        }
        fleetBotMembers += botMembers;
        fleetHumanMembers += humanMembers;
        fleetRows.push({
          fleetID: Number(fleet.fleetID) || 0,
          name: String(fleet.advert && fleet.advert.fleetName || `Fleet ${fleet.fleetID}`),
          memberCount: members.length,
          botMembers,
          humanMembers,
          solarSystemID: systemID,
        });
      }
    }
    fleetRows.sort((left, right) => right.memberCount - left.memberCount || left.fleetID - right.fleetID);

    const currentFileTime = BigInt(require("../_shared/serviceHelpers").currentFileTime());
    const fileTime = (value) => {
      try { return BigInt(String(value || 0)); } catch { return 0n; }
    };
    const ownerLabels = new Map();
    const ownerLabel = (ownerID) => {
      if (ownerLabels.has(ownerID)) return ownerLabels.get(ownerID);
      const corporation = corporations.getCorporationRecord(ownerID);
      if (corporation) {
        const label = String(corporation.corporationName || `Corporation ${ownerID}`);
        ownerLabels.set(ownerID, label);
        return label;
      }
      const alliance = typeof corporations.getAllianceRecord === "function"
        ? corporations.getAllianceRecord(ownerID)
        : null;
      const label = String(alliance && (alliance.allianceName || alliance.name) || `Owner ${ownerID}`);
      ownerLabels.set(ownerID, label);
      return label;
    };
    const warRows = [];
    const allWars = typeof warRuntime.listAllWars === "function" ? warRuntime.listAllWars() : [];
    let activeWarCount = 0;
    for (const war of allWars) {
      const startedAt = fileTime(war && war.timeStarted);
      const finishedAt = fileTime(war && war.timeFinished);
      const started = startedAt > 0n && startedAt <= currentFileTime;
      const ended = finishedAt > 0n && finishedAt <= currentFileTime;
      const status = ended ? "ended" : !started ? "pending" : finishedAt > 0n ? "ending" : "active";
      if (status === "active" || status === "ending") activeWarCount += 1;
      warRows.push({
        warID: Number(war && war.warID) || 0,
        declaredByID: Number(war && war.declaredByID) || 0,
        declaredByName: ownerLabel(Number(war && war.declaredByID) || 0),
        againstID: Number(war && war.againstID) || 0,
        againstName: ownerLabel(Number(war && war.againstID) || 0),
        warHQID: positiveInteger(war && war.warHQID),
        mutual: Boolean(war && war.mutual),
        status,
      });
    }
    warRows.sort((left, right) => Number(right.status === "active" || right.status === "ending") - Number(left.status === "active" || left.status === "ending") || right.warID - left.warID);

    const structureRows = [];
    let lowPowerStructures = 0;
    let missingCoreStructures = 0;
    const structureConstants = require("../structure/structureConstants");
    const upkeepNames = structureConstants.STRUCTURE_UPKEEP_NAME_BY_ID || {};
    const stateNames = structureConstants.STRUCTURE_STATE_NAME_BY_ID || {};
    const structures = typeof structureState.peekStructures === "function"
      ? structureState.peekStructures()
      : structureState.listStructures({ refresh: false });
    for (const structure of structures) {
      if (Number(structure.upkeepState) === 2) lowPowerStructures += 1;
      if (structure.hasQuantumCore !== true) missingCoreStructures += 1;
      const solarSystemID = positiveInteger(structure.solarSystemID);
      const system = solarSystemID ? worldData.getSolarSystemByID(solarSystemID) || {} : {};
      structureRows.push({
        structureID: Number(structure.structureID) || 0,
        name: String(structure.itemName || structure.name || `Structure ${structure.structureID}`),
        ownerCorpID: Number(structure.ownerCorpID) || 0,
        allianceID: positiveInteger(structure.allianceID),
        solarSystemID,
        solarSystemName: String(system.solarSystemName || system.name || ""),
        state: String(stateNames[Number(structure.state)] || structure.state || "unknown"),
        upkeep: String(upkeepNames[Number(structure.upkeepState)] || "unknown"),
        hasQuantumCore: structure.hasQuantumCore === true,
        fuelExpiresAt: Number(structure.fuelExpiresAt) || null,
      });
    }
    structureRows.sort((left, right) => Number(left.upkeep !== "full_power") - Number(right.upkeep !== "full_power") || left.structureID - right.structureID);

    const sovereigntyRows = [];
    const sovSystems = typeof sovereigntyState.listAllSovereigntySystemStates === "function"
      ? sovereigntyState.listAllSovereigntySystemStates()
      : [];
    for (const systemState of sovSystems) {
      const allianceID = positiveInteger(systemState && systemState.allianceID);
      if (!allianceID) continue;
      const solarSystemID = positiveInteger(systemState.solarSystemID);
      const system = solarSystemID ? worldData.getSolarSystemByID(solarSystemID) || {} : {};
      const alliance = typeof corporations.getAllianceRecord === "function"
        ? corporations.getAllianceRecord(allianceID)
        : null;
      sovereigntyRows.push({
        solarSystemID,
        solarSystemName: String(system.solarSystemName || system.name || `System ${solarSystemID}`),
        allianceID,
        allianceName: String(alliance && (alliance.allianceName || alliance.name) || `Alliance ${allianceID}`),
      });
    }
    sovereigntyRows.sort((left, right) => left.solarSystemID - right.solarSystemID);

    const operationCounts = operationSummaryCache?.byStatus || {};
    const operationKindCounts = operationSummaryCache?.byKind || {};
    const activeOperationRows = operationSummaryCache?.recent || [];
    if (!operationSummaryCache) {
      for (const operation of latestOperations) {
        const status = String(operation.status || "unknown");
        operationCounts[status] = (operationCounts[status] || 0) + 1;
        if (!activeStatus(operation)) continue;
        const kind = String(operation.kind || "other");
        operationKindCounts[kind] = (operationKindCounts[kind] || 0) + 1;
        activeOperationRows.push(operation);
      }
      activeOperationRows.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    }
    const activeWorkKindCounts = {};
    const activeWorkRows = [...activeWorkByCharacter.values()];
    for (const work of activeWorkRows) {
      const kind = String(work.kind || "other");
      activeWorkKindCounts[kind] = (activeWorkKindCounts[kind] || 0) + 1;
    }
    activeWorkRows.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    const queuedColonySetupsWithoutActiveWork = [...queuedColonyByCharacter.keys()]
      .filter((characterID) => !activeWorkByCharacter.has(characterID)).length;

    const autonomySnapshot = autonomy.getAutonomySnapshot() || {};
    const director = autonomySnapshot.director && typeof autonomySnapshot.director === "object"
      ? autonomySnapshot.director
      : {};
    const taskSummary = typeof tasks.getDashboardTaskSummary === "function"
      ? tasks.getDashboardTaskSummary()
      : (() => {
        const rows = tasks.listTasks({ limit: 100 });
        const byStatus = {};
        const byKind = {};
        const byCharacter = {};
        for (const task of rows) {
          const status = String(task.status || "unknown");
          const kind = String(task.kind || "other");
          byStatus[status] = (byStatus[status] || 0) + 1;
          byKind[kind] = (byKind[kind] || 0) + 1;
          const ownerID = Number(task.providerCharacterID || task.resourceOwnerCharacterID || task.targetCharacterID) || 0;
          if (ownerID > 0 && ["queued", "leased"].includes(status)) {
            const key = String(ownerID);
            const list = byCharacter[key] || (byCharacter[key] = []);
            if (list.length < 3) list.push({ taskID: String(task.taskID || ""), kind, status, stage: String(task.progress && (task.progress.phase || task.progress.stage) || ""), updatedAt: String(task.updatedAt || task.createdAt || "") });
          }
        }
        return { total: rows.length, byStatus, byKind, byCharacter };
      })();
    taskSummaryCache = taskSummary;

    const corporationsList = [...byCorporation.values()]
      .map((entry) => ({ ...entry, specialties: [...entry.specialties].sort() }))
      .sort((left, right) => right.botCount - left.botCount || left.corporationID - right.corporationID);
    corporationNameByID = new Map(corporationsList.map((corporation) => [corporation.corporationID, corporation.corporationName]));
    const systemsList = [...bySystem.entries()]
      .map(([systemID, botCount]) => {
        const system = worldData.getSolarSystemByID(systemID) || {};
        return { systemID, systemName: String(system.solarSystemName || system.name || `System ${systemID}`), botCount };
      })
      .sort((left, right) => right.botCount - left.botCount || left.systemID - right.systemID);
    const maxPerSystem = require("./playerBotCapacityRuntime").getMaxAutonomousBotsPerSystem();
    const connectionState = typeof space.getStatusSummary === "function" ? space.getStatusSummary() : {};
    const connectionPolicy = require("./playerBotConnectionScheduleRuntime");

    snapshot = {
      generatedAt: new Date(now).toISOString(),
      process: { pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) },
      roster: {
        total: roster.length,
        target: playerBots.getConfiguredTarget(),
        operationalCeiling: playerBots.getOperationalCeiling ? playerBots.getOperationalCeiling() : playerBots.getConfiguredTarget(),
        hardMaximum: playerBots.HARD_MAX,
        validatedMaximum: LAST_VALIDATED_ROSTER,
        requestedScale: { totalBots: REQUESTED_TOTAL_BOTS, onlineBots: REQUESTED_ONLINE_BOTS },
        connections: {
          maximumOnline: connectionState.connectionSchedule && connectionState.connectionSchedule.maxConnected || connectionPolicy.getMaxConnected(),
          connectedNow: onlineBotIDs.size,
          validatedMaximum: LAST_VALIDATED_ONLINE,
          rotation: connectionState.connectionSchedule || null,
        },
        corporationSizing: { targetBotsPerCorporation: playerBots.BOT_CORPORATION_TARGET_SIZE || 250, maximumBotsPerCorporation: playerBots.MAX_BOTS_PER_CORPORATION || 300 },
        online: onlineBotIDs.size,
        inSpace: actorsInSpace,
        dockedAtStation,
        dockedAtStructure,
        connectedLocationUnknown,
        offline: Math.max(0, roster.length - onlineBotIDs.size),
        connectedHumans: connectedHumanIDs.size,
        humansInSpace,
        bySpecialty: Object.fromEntries([...bySpecialty.entries()].sort(([a], [b]) => a.localeCompare(b))),
      },
      corporations: corporationsList,
      systems: systemsList,
      systemCapacity: { autonomousBotsPerSystem: maxPerSystem },
      activity: {
        fleets: fleetRows.length,
        fleetMembers: fleetBotMembers + fleetHumanMembers,
        botFleetMembers: fleetBotMembers,
        humanFleetMembers: fleetHumanMembers,
        activeWars: activeWarCount,
        structures: structureRows.length,
        lowPowerStructures: lowPowerStructures,
        structuresMissingQuantumCore: missingCoreStructures,
        claimedSystems: sovereigntyRows.length,
      },
      territory: {
        fleets: fleetRows.slice(0, 100),
        wars: warRows.slice(0, 100),
        structures: structureRows.slice(0, 100),
        sovereignty: sovereigntyRows.slice(0, 100),
      },
      operations: {
        total: operationSummaryCache?.total ?? latestOperations.length,
        recordedBots: operationSummaryCache?.recordedBots ?? operationSummaryCache?.total ?? latestOperations.length,
        active: operationSummaryCache?.active ?? activeOperationRows.length,
        withoutActiveRecord: Math.max(0, roster.length - (operationSummaryCache?.active ?? activeOperationRows.length)),
        activeWork: activeWorkByCharacter.size,
        activeIndustryCycles: activeCycles.length,
        withoutActiveWork: Math.max(0, roster.length - activeWorkByCharacter.size),
        queuedColonySetups: queuedColonyByCharacter.size,
        queuedColonySetupsWithoutActiveWork,
        activeWorkByKind: activeWorkKindCounts,
        byStatus: operationCounts,
        byKind: operationKindCounts,
        recent: activeWorkRows.slice(0, 20).map((operation) => ({
          characterID: Number(operation.characterID) || 0,
          kind: String(operation.kind || "other"),
          status: String(operation.status || "unknown"),
          stage: String(operation.stage || ""),
          updatedAt: String(operation.updatedAt || ""),
          lastAction: String(operation.lastAction || "").slice(0, 240),
        })),
      },
      work: {
        queuedColonySetups: queuedColonyByCharacter.size,
        queuedColonySetupsWithoutActiveWork,
        nextCycleAt: String(autonomySnapshot.nextCycleAt || ""),
        lastCycleAt: String(autonomySnapshot.lastCycleAt || autonomySnapshot.completedAt || ""),
        cycleDurationMs: Math.max(0, Number(autonomySnapshot.cycleDurationMs) || 0),
        cyclePilotWorkMs: Math.max(0, Number(autonomySnapshot.cyclePilotWorkMs ?? autonomySnapshot.cycleDurationMs) || 0),
        cycleElapsedMs: Math.max(0, Number(autonomySnapshot.cycleElapsedMs) || 0),
        cycleStartedAt: String(autonomySnapshot.cycleStartedAt || ""),
        cycleFinishedAt: String(autonomySnapshot.cycleFinishedAt || autonomySnapshot.lastCycleAt || ""),
        cycleExpectedBots: Math.max(0, Number(autonomySnapshot.cycleExpectedBots) || 0),
        cycleCompletedBots: Math.max(0, Number(autonomySnapshot.cycleCompletedBots) || 0),
        addonFailedBots: Math.max(0, Number(autonomySnapshot.addonFailedBots) || 0),
        addonFailures: (() => {
          const details = Array.isArray(autonomySnapshot.addonFailures) ? autonomySnapshot.addonFailures : [];
          const byID = new Map(details.map((failure) => [Number(failure.characterID), failure]));
          const failedIDs = Array.isArray(autonomySnapshot.addonFailedCharacterIDs)
            ? autonomySnapshot.addonFailedCharacterIDs
            : details.map((failure) => failure.characterID);
          const botsByID = new Map(roster.map((bot) => [Number(bot.characterID), bot]));
          return [...new Set(failedIDs.map((value) => Number(value) || 0).filter(Boolean))].slice(0, 20).map((characterID) => ({
            characterID,
            characterName: String(botsByID.get(characterID)?.characterName || `Pilot ${characterID}`),
            message: String(byID.get(characterID)?.message || "Step failed; see the add-on log for its error.").slice(0, 240),
          }));
        })(),
        directorError: String(autonomySnapshot.directorError || ""),
        director: {
          assigned: Math.max(0, Number(director.assigned) || 0),
          failures: Math.max(0, Number(director.failures) || 0),
          mine: Math.max(0, Number(director.mine) || 0),
          industry: Math.max(0, Number(director.industry) || 0),
          colony: Math.max(0, Number(director.colony) || 0),
          combat: Math.max(0, Number(director.combat) || 0),
        },
        taskTotal: Math.max(0, Number(taskSummary.total) || 0),
        taskStatuses: taskSummary.byStatus || {},
        taskKinds: taskSummary.byKind || {},
        botsWithQueuedOrLeasedTasks: Object.keys(taskSummary.byCharacter || {}).length,
      },
    };
    snapshotAtMs = now;
    return snapshot;
  }

  function listBots(query = {}) {
    const current = refresh();
    const specialty = String(query.specialty || "").trim().toLowerCase();
    const corporationID = positiveInteger(query.corporationID);
    const search = String(query.search || "").trim().toLowerCase().slice(0, 80);
    const filtered = roster.filter((bot) => {
      if (specialty && String(bot.specialty || "").toLowerCase() !== specialty) return false;
      if (corporationID && Number(bot.corporationID) !== corporationID) return false;
      if (search && !`${bot.characterName || ""} ${bot.characterID}`.toLowerCase().includes(search)) return false;
      return true;
    });
    const limit = boundedInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
    const offset = boundedInteger(query.offset, 0, Math.max(0, filtered.length));
    const pageBots = filtered.slice(offset, offset + limit);
    const pageOperationMap = typeof operations.getDashboardOperationsForCharacters === "function"
      ? operations.getDashboardOperationsForCharacters(pageBots.map((bot) => bot.characterID))
      : null;
    const rows = pageBots.map((bot) => {
      const character = dashboardCharacter(bot.characterID);
      const presence = space.getBotPresenceInfo(bot, character);
      const operation = pageOperationMap
        ? pageOperationMap[String(bot.characterID)] || null
        : operationByCharacter.get(Number(bot.characterID)) || null;
      const activeWork = activeWorkByCharacter.get(Number(bot.characterID));
      const queuedWork = queuedColonyByCharacter.get(Number(bot.characterID)) || null;
      const currentWork = activeWork || operation;
      const systemID = positiveInteger(presence.solarSystemID || character.solarSystemID);
      const system = systemID ? worldData.getSolarSystemByID(systemID) || {} : {};
      return {
        characterID: Number(bot.characterID),
        characterName: String(bot.characterName || `Bot ${bot.characterID}`),
        specialty: String(bot.specialty || "unassigned"),
        corporationID: positiveInteger(bot.corporationID),
        corporationName: corporationNameByID.get(Number(bot.corporationID)) || "",
        status: String(bot.status || "idle"),
        paused: bot.status === "paused" || bot.autonomyPaused === true,
        connected: Boolean(presence.connected),
        inSpace: Boolean(presence.inSpace),
        solarSystemID: systemID,
        solarSystemName: String(system.solarSystemName || system.name || ""),
        stationID: positiveInteger(presence.stationID),
        structureID: positiveInteger(presence.structureID),
        shipTypeID: positiveInteger(character.shipTypeID),
        shipTypeName: shipTypeName(positiveInteger(character.shipTypeID)),
        operation: currentWork ? {
          operationID: String(currentWork.operationID || currentWork.cycleID || ""),
          kind: String(currentWork.kind || ""),
          status: String(currentWork.status || ""),
          stage: String(currentWork.stage || ""),
          updatedAt: String(currentWork.updatedAt || ""),
          lastAction: String(currentWork.lastAction || "").slice(0, 240),
        } : null,
        queuedWork,
        tasks: Array.isArray(taskSummaryCache.byCharacter && taskSummaryCache.byCharacter[String(bot.characterID)])
          ? taskSummaryCache.byCharacter[String(bot.characterID)]
          : [],
      };
    });
    return { total: filtered.length, offset, limit, rows, generatedAt: current.generatedAt };
  }

  function getOperations(limit = 50) {
    const current = refresh();
    return {
      generatedAt: current.generatedAt,
      total: current.operations.total,
      recordedBots: current.operations.recordedBots,
      active: current.operations.active,
      rows: current.operations.recent.slice(0, boundedInteger(limit, 50, 100) || 50),
    };
  }

  function getOperationHistoryPage(query = {}) {
    if (typeof operations.getDashboardOperationHistoryPage === "function") {
      return operations.getDashboardOperationHistoryPage(query);
    }
    const rows = operations.listOperations().map((operation) => ({
      operationID: String(operation.operationID || ""),
      characterID: Number(operation.characterID) || 0,
      characterName: String(operation.characterName || ""),
      corporationID: Number(operation.corporationID) || 0,
      kind: String(operation.kind || "other"),
      status: String(operation.status || "unknown"),
      stage: String(operation.stage || ""),
      updatedAt: String(operation.updatedAt || ""),
      lastAction: String(operation.lastAction || "").slice(0, 240),
    }));
    const offset = boundedInteger(query.offset, 0, 10_000_000);
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, boundedInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) || DEFAULT_PAGE_SIZE));
    const status = String(query.status || "").trim().toLowerCase();
    const kind = String(query.kind || "").trim().toLowerCase();
    const search = String(query.search || "").trim().toLowerCase().slice(0, 80);
    const filtered = rows.filter((row) => (!status || row.status.toLowerCase() === status) &&
      (!kind || row.kind.toLowerCase() === kind) &&
      (!search || `${row.operationID} ${row.characterName} ${row.characterID} ${row.lastAction}`.toLowerCase().includes(search)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { total: filtered.length, offset, limit, counts: {}, rows: filtered.slice(offset, offset + limit) };
  }

  function getOperationDetails(operationID) {
    if (typeof operations.getDashboardOperationDetails === "function") {
      return operations.getDashboardOperationDetails(operationID);
    }
    return operations.listOperations().find((operation) => String(operation.operationID || "") === String(operationID || "")) || null;
  }

  return Object.freeze({ getSnapshot: refresh, getKillboardSnapshot, listBots, getOperations, getOperationHistoryPage, getOperationDetails });
}

module.exports = { createPlayerBotDashboardRuntime, MAX_PAGE_SIZE };

"use strict";

const { performance } = require("node:perf_hooks");
const { createTableRepository } = require("../../gameStore/tableRepository");
const {
  getCharacterRecord,
} = require("../character/characterState");
const {
  getValidRandomName,
} = require("../character/characterNameRuntime");
const {
  createCustomCorporation,
  findCorporationByFoundingOperationID,
  findCorporationByName,
  getCorporationRecord,
  setCharacterAffiliation,
} = require("../corporation/corporationState");
const {
  ensureCharacterMemberState,
  getCorporationSessionRoleState,
} = require("../corporation/corporationRuntimeState");

const TABLE = "playerBots";
const repo = createTableRepository("service:playerbots", { strict: true });
const DEFAULT_TARGET = 500;
const HARD_MAX = 15_000;
const DEFAULT_ROSTER_CEILING = HARD_MAX;
const MIN_CORPORATIONS = 6;
const MIN_BOTS_PER_CORPORATION = 5;
const BOT_CORPORATION_TARGET_SIZE = 250;
const MAX_BOTS_PER_CORPORATION = 300;
// Player-owned corporations that accept bots and managed specialist shards
// share the 300-member ceiling, including a human CEO's corporation.
const MAX_BOTS_PER_PLAYER_CORPORATION = 300;
const DEFAULT_ROSTER_SEED_BATCH_SIZE = 5;
const MAX_ROSTER_SEED_BATCH_SIZE = 25;
const SPECIALTIES = Object.freeze([
  { id: "trade", name: "Trade", corpName: "EVEJS Independent Traders" },
  { id: "industry", name: "Industry", corpName: "EVEJS Industrial Union" },
  { id: "planetary", name: "Planetary", corpName: "EVEJS Planetary Combine" },
  { id: "security", name: "Security", corpName: "EVEJS Security Fleet" },
  { id: "piracy", name: "Piracy", corpName: "EVEJS Freebooters" },
  { id: "sovereignty", name: "Sovereignty", corpName: "EVEJS Frontier Compact" },
]);
const CORP_INVITED_BY_CORPORATION = 8;
const CORP_ACCEPTED_BY_CHARACTER = 2;
const MAX_FUNDING_TRANSFER_ISK = 1_000_000_000;
let botProfilesCache = null;
let botProfilesByCharacterID = null;
let planningRosterCache = null;
let planningRosterCacheAt = 0;
const PLANNING_ROSTER_CACHE_TTL_MS = 1_000;
let rosterSeedContextCache = null;
let rosterSeedContextVersion = 0;
let creatingRosterSeedBot = false;

function getConfiguredTarget() {
  return require("./playerBotConfigurationRuntime").getSettings().rosterTarget;
}

function getOperationalCeiling() {
  return require("./playerBotConfigurationRuntime").getSettings().rosterCeiling;
}

function readBots() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, "/");
  return result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function listBots() {
  if (!botProfilesCache) loadBotProfiles();
  return hydrateBotProfiles(botProfilesCache, false);
}

// Operator dashboards only need a read-only projection. Avoid normalizing all
// character records before the dashboard aggregates them.
function listBotProfiles() {
  if (!botProfilesCache) loadBotProfiles();
  return botProfilesCache.slice();
}

function loadBotProfiles() {
  botProfilesCache = Object.values(readBots())
    .filter((record) => record && Number(record.characterID) > 0)
    .sort((left, right) => Number(left.characterID) - Number(right.characterID))
    .map((record) => Object.freeze({ ...record }));
  botProfilesByCharacterID = new Map(botProfilesCache.map((record) => [Number(record.characterID), record]));
}

function hydrateBotProfiles(profiles, freeze) {
  const { readSharedCharacterRecord } = require("../character/characterState");
  return profiles.map((record) => {
    const character = readSharedCharacterRecord(record.characterID) || {};
    const bot = {
      ...record,
      characterName: character.characterName || record.characterName || `Bot ${record.characterID}`,
      corporationID: Number(character.corporationID || record.corporationID) || null,
    };
    return freeze ? Object.freeze(bot) : bot;
  });
}

function getPlanningRoster() {
  const now = Date.now();
  if (planningRosterCache && now - planningRosterCacheAt < PLANNING_ROSTER_CACHE_TTL_MS) {
    return planningRosterCache;
  }
  if (!botProfilesCache) loadBotProfiles();
  planningRosterCache = Object.freeze(hydrateBotProfiles(botProfilesCache, true));
  planningRosterCacheAt = now;
  return planningRosterCache;
}

function getBotCount() {
  if (botProfilesCache) return botProfilesCache.length;
  return Object.values(readBots()).filter((record) => record && Number.isSafeInteger(Number(record.characterID)) && Number(record.characterID) > 0).length;
}

function getBotByCharacterID(characterID) {
  const id = Math.trunc(Number(characterID) || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!botProfilesByCharacterID) getPlanningRoster();
  const record = botProfilesByCharacterID && botProfilesByCharacterID.get(id);
  if (!record) return null;
  const { readSharedCharacterRecord } = require("../character/characterState");
  const character = readSharedCharacterRecord(id) || {};
  return {
    ...record,
    characterName: character.characterName || record.characterName || `Bot ${id}`,
    corporationID: Number(character.corporationID || record.corporationID) || null,
  };
}

function saveBot(record, options = {}) {
  const characterID = Number(record && record.characterID);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    throw new Error("PLAYERBOT_CHARACTER_ID_REQUIRED");
  }
  const result = repo.write(TABLE, `/${characterID}`, record);
  if (!result.success) {
    throw new Error(result.errorMsg || "PLAYERBOT_WRITE_FAILED");
  }
  botProfilesCache = null;
  botProfilesByCharacterID = null;
  planningRosterCache = null;
  planningRosterCacheAt = 0;
  if (options.rosterMembershipChanged === true && !creatingRosterSeedBot) {
    rosterSeedContextVersion += 1;
    rosterSeedContextCache = null;
  }
  repo.flushTableSync(TABLE);
  return record;
}

function setBotAutonomyState(characterID, state = {}) {
  const normalizedCharacterID = Number(characterID) || 0;
  if (!Number.isSafeInteger(normalizedCharacterID) || normalizedCharacterID <= 0) {
    return { success: false, message: "PLAYERBOT_CHARACTER_ID_REQUIRED" };
  }
  const records = readBots();
  const current = records[normalizedCharacterID];
  if (!current) return { success: false, message: "PLAYERBOT_NOT_FOUND" };
  const next = { ...current };
  if (typeof state.paused === "boolean") {
    next.autonomyPaused = state.paused;
    next.autonomyPausedAt = state.paused ? new Date().toISOString() : null;
  }
  if (typeof state.status === "string") next.status = state.status;
  if (Object.prototype.hasOwnProperty.call(state, "currentTask")) {
    next.currentTask = state.currentTask || null;
  }
  if (Number.isFinite(Number(state.lastTaskAssignedAtMs))) {
    next.lastTaskAssignedAtMs = Math.max(0, Math.trunc(Number(state.lastTaskAssignedAtMs)));
  }
  if (typeof state.lastTaskID === "string") next.lastTaskID = state.lastTaskID;
  saveBot(next);
  return { success: true, bot: next };
}

async function fundBotFromPlayer(session, botQuery, amount) {
  const bot = resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const playerCharacterID = getSessionCharacterID(session);
  const normalizedAmount = Math.round(Number(amount) * 100) / 100;
  if (!playerCharacterID) return { success: false, message: "Select a character before transferring funds." };
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return { success: false, message: "Amount must be greater than zero." };
  }
  if (normalizedAmount > MAX_FUNDING_TRANSFER_ISK) {
    return { success: false, message: `The maximum playerbot funding transfer is ${MAX_FUNDING_TRANSFER_ISK.toLocaleString("en-US")} ISK.` };
  }
  const wallet = require("../account/walletState");
  const balance = wallet.getCharacterWallet(playerCharacterID)?.balance || 0;
  if (balance < normalizedAmount) {
    return { success: false, message: `Insufficient funds: you have ${Number(balance).toFixed(2)} ISK and requested ${normalizedAmount.toFixed(2)} ISK.` };
  }
  try {
    const result = await wallet.transferCharacterBalanceAsync(
      playerCharacterID,
      Number(bot.characterID),
      normalizedAmount,
      {
        description: `Funding playerbot ${bot.characterName} from character ${playerCharacterID}`,
      },
      {
        source: "playerbot-funding",
        idempotencyKey: `playerbots.funding:${playerCharacterID}:${bot.characterID}:${Date.now()}`,
      },
    );
    if (!result || result.success !== true) {
      const errorCode = String(result && result.errorMsg || "TRANSFER_FAILED");
      const message = errorCode === "INSUFFICIENT_FUNDS"
        ? "Transfer declined because your balance is no longer sufficient."
        : errorCode === "BALANCE_LIMIT_EXCEEDED"
          ? "The bot's wallet reached its balance limit."
          : `The wallet authority rejected the transfer (${errorCode}).`;
      return { success: false, message };
    }
    require("../../utils/logger").info(
      `[PlayerBots] Funding transfer from=${playerCharacterID} to=${bot.characterID} amount=${normalizedAmount.toFixed(2)} ISK.`,
    );
    return {
      success: true,
      amount: normalizedAmount,
      balance: Number(result.to && result.to.balance) || 0,
      message: `Transferred ${normalizedAmount.toFixed(2)} ISK to ${bot.characterName}.` +
        ` Wallet balance: ${Number(result.to && result.to.balance || 0).toFixed(2)} ISK.`,
    };
  } catch (error) {
    return { success: false, message: `Could not transfer funds to the bot: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

function balancedTargets(target) {
  const base = Math.floor(target / MIN_CORPORATIONS);
  const remainder = target % MIN_CORPORATIONS;
  return SPECIALTIES.map((specialty, index) => ({
    specialty,
    target: base + (index < remainder ? 1 : 0),
  }));
}

function balancedCorporationTargets(target, shardTarget = BOT_CORPORATION_TARGET_SIZE) {
  const numericTarget = Math.max(0, Math.trunc(Number(target) || 0));
  const numericShardTarget = Math.max(1, Math.trunc(Number(shardTarget) || BOT_CORPORATION_TARGET_SIZE));
  if (!numericTarget) return [];
  // Keep mature corps near the requested shard size while never planning a
  // shard over the trained CEO's 300-member ceiling. Rounding avoids creating
  // a third underfilled corp for a 501-pilot group when two 250-member corps
  // are sufficient.
  const count = Math.max(
    1,
    Math.ceil(numericTarget / MAX_BOTS_PER_CORPORATION),
    Math.round(numericTarget / numericShardTarget),
  );
  const base = Math.floor(numericTarget / count);
  const remainder = numericTarget % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function botRecordsForCorporation(corporationID, records = listBots()) {
  return records.filter((bot) => Number(bot.corporationID) === Number(corporationID));
}

function foundingOperationIDForShard(specialtyID, shardIndex = 0) {
  return shardIndex === 0
    ? `evejs-playerbots:${specialtyID}`
    : `evejs-playerbots:${specialtyID}:shard:${shardIndex + 1}`;
}

function findTeamCorporationShard(specialtyID, shardIndex, records = listBots()) {
  const founded = findCorporationByFoundingOperationID(foundingOperationIDForShard(specialtyID, shardIndex));
  if (founded) return founded;
  const corporationIDs = [...new Set(records
    .filter((bot) => bot.specialty === specialtyID &&
      Number(bot.corporationID) === Number(bot.specialtyCorporationID))
    .map((bot) => Number(bot.specialtyCorporationID)))]
    .sort((left, right) => left - right);
  if (shardIndex === 0 && corporationIDs.length) return getCorporationRecord(corporationIDs[0]);
  return null;
}

function findTeamCorporations(specialtyID, records = listBots()) {
  const corporations = new Map();
  for (const bot of records) {
    if (bot.specialty !== specialtyID ||
        Number(bot.corporationID) !== Number(bot.specialtyCorporationID)) continue;
    const corporationID = Number(bot.specialtyCorporationID) || 0;
    if (corporationID && !corporations.has(corporationID)) {
      const corporation = getCorporationRecord(corporationID);
      if (corporation) corporations.set(corporationID, corporation);
    }
  }
  if (!corporations.size) {
    const first = findCorporationByFoundingOperationID(foundingOperationIDForShard(specialtyID, 0));
    if (first) corporations.set(Number(first.corporationID), first);
  }
  return [...corporations.values()].sort((left, right) => Number(left.corporationID) - Number(right.corporationID));
}

function findTeamCorporation(specialtyID, records = listBots()) {
  return findTeamCorporationShard(specialtyID, 0, records) || findTeamCorporations(specialtyID, records)[0] || null;
}

function createBotSession(bot) {
  const character = getCharacterRecord(bot.characterID);
  if (!character) throw new Error(`PLAYERBOT_CHARACTER_NOT_FOUND:${bot.characterID}`);
  const corporationID = Number(character.corporationID || bot.corporationID) || 0;
  const session = {
    userid: Number(character.accountId) || 0,
    characterID: Number(bot.characterID),
    charID: Number(bot.characterID),
    charid: Number(bot.characterID),
    corporationID,
    corpid: corporationID,
    allianceID: Number(character.allianceID) || 0,
    allianceid: Number(character.allianceID) || 0,
    structureID: Number(character.structureID) || null,
    structureid: Number(character.structureID) || null,
    stationID: Number(character.stationID) || null,
    stationid: Number(character.stationID) || null,
    stationid2: Number(character.stationID) || null,
    solarsystemid: Number(character.solarSystemID) || null,
    solarsystemid2: Number(character.solarSystemID) || null,
    regionID: Number(character.regionID) || null,
    regionid: Number(character.regionID) || null,
    shipID: Number(character.shipID) || null,
    shipid: Number(character.shipID) || null,
    shipTypeID: Number(character.shipTypeID) || null,
    shiptypeid: Number(character.shipTypeID) || null,
    raceID: Number(character.raceID) || null,
    raceid: Number(character.raceID) || null,
    sessionType: "playerbot",
  };
  syncBotCorporationSession(session, { ...bot, corporationID }, character);
  return session;
}

// The corporation authority copies the whole corporation runtime to resolve
// one member's role masks, and a director pass asks for the same pilot's
// session many times within a few milliseconds. Reuse the answer for a
// minute; a change of corporation or docking location always reads again.
// EveJS still checks persisted authority when a corporation action runs.
const BOT_ROLE_STATE_REUSE_MS = 60_000;
const BOT_ROLE_STATE_MAX_ENTRIES = 5_000;
const botRoleStateCache = new Map();

function readBotCorporationRoleState(corporationID, characterID, record) {
  const locationKey = `${Number(record.stationID) || 0}:${Number(record.structureID) || 0}`;
  const now = Date.now();
  const cached = botRoleStateCache.get(characterID);
  if (cached && cached.corporationID === corporationID && cached.locationKey === locationKey &&
      now - cached.readAtMs < BOT_ROLE_STATE_REUSE_MS && now >= cached.readAtMs) {
    return cached.roleState;
  }
  const roleState = getCorporationSessionRoleState(corporationID, characterID);
  if (botRoleStateCache.size >= BOT_ROLE_STATE_MAX_ENTRIES) botRoleStateCache.clear();
  botRoleStateCache.set(characterID, { corporationID, locationKey, readAtMs: now, roleState });
  return roleState;
}

function forgetBotCorporationRoleState(characterID = 0) {
  if (Number(characterID) > 0) botRoleStateCache.delete(Number(characterID));
  else botRoleStateCache.clear();
}

function syncBotCorporationSession(session, bot, character = null) {
  if (!session || !bot || !Number(bot.characterID)) return session;
  const record = character || getCharacterRecord(bot.characterID) || {};
  const corporationID = Number(record.corporationID || bot.corporationID) || 0;
  const roleState = corporationID > 0
    ? readBotCorporationRoleState(corporationID, Number(bot.characterID), record)
    : null;
  Object.assign(session, roleState || {
    corprole: 0n,
    rolesAtAll: 0n,
    rolesAtBase: 0n,
    rolesAtHQ: 0n,
    rolesAtOther: 0n,
    hqID: null,
    baseID: null,
  });
  // A corporation with Upwell assets always has one NPC structure caretaker.
  // If none of its playerbot members already has CEO, Director, or Station
  // Manager authority, the deterministic caretaker receives only the
  // Station Manager bit in its playerbot actor session. The corporation's
  // persisted member roles remain untouched.
  require("./playerBotStructureRuntime").applyStructureCaretakerRoleToSession(
    session,
    { ...bot, corporationID },
  );
  return session;
}

function createCorporationForSpecialty(specialty, founderID, shardIndex = 0) {
  const foundingOperationID = foundingOperationIDForShard(specialty.id, shardIndex);
  const existing = findCorporationByFoundingOperationID(
    foundingOperationID,
  );
  if (existing) return existing;
  let corporationName = shardIndex === 0 ? specialty.corpName : `${specialty.corpName} ${shardIndex + 1}`;
  for (let suffix = 2; findCorporationByName(corporationName); suffix += 1) {
    corporationName = `${specialty.corpName} ${suffix}`;
  }
  const result = createCustomCorporation(founderID, corporationName, {
    foundingOperationID,
  });
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_CORP_CREATE_FAILED");
  return result.data.corporationRecord;
}

// Race, school and name for a new bot. Falls back to the original Caldari
// start if character-creation data is unavailable.
function chooseNewBotIdentity() {
  const roster = Object.values(readBots()).filter((record) => record && Number(record.characterID) > 0);
  let origin = null;
  try {
    const capacity = require("./playerBotCapacityRuntime");
    const botsPerSystem = new Map();
    for (const record of roster) {
      const systemID = capacity.getBotSystemID(record);
      if (systemID) botsPerSystem.set(systemID, (botsPerSystem.get(systemID) || 0) + 1);
    }
    origin = require("./playerBotOriginRuntime").chooseOrigin(botsPerSystem);
  } catch (_) {
    origin = null;
  }
  const raceID = origin ? origin.raceID : 1;
  let characterName;
  try {
    const { validateCharacterName, VALIDATION_CODE } = require("../character/characterNameRuntime");
    characterName = require("./playerBotNameRuntime").generateBotName(raceID, {
      existingNames: roster.map((record) => record.characterName),
      isValid: (candidate) => validateCharacterName(candidate) === VALIDATION_CODE.VALID,
    });
  } catch (_) {
    characterName = getValidRandomName(1);
  }
  return { origin, characterName };
}

function createBotInTeam(specialty, corporationID, founder = false, shardIndex = 0) {
  const { origin, characterName } = chooseNewBotIdentity();
  const characterResult = require("../character/charService").createPlayerBotCharacter(
    characterName,
    specialty.id,
    origin ? {
      bloodlineID: origin.bloodlineID,
      schoolID: origin.schoolID,
      stationID: origin.stationID,
      gender: origin.gender,
    } : {},
  );
  if (!characterResult.success) {
    throw new Error(characterResult.errorMsg || "PLAYERBOT_CHARACTER_CREATE_FAILED");
  }
  const characterID = Number(characterResult.data.characterID);
  // A client asks the image service for a character portrait independently
  // of the roster record. Do not publish a new bot unless every supported
  // portrait URL already resolves to an image.
  require("./playerBotPortraitRuntime").ensurePortrait(characterID);
  let actualCorporationID = Number(corporationID) || 0;
  if (founder || !actualCorporationID) {
    const corporation = createCorporationForSpecialty(specialty, characterID, shardIndex);
    actualCorporationID = Number(corporation.corporationID);
    ensureCharacterMemberState(actualCorporationID, characterID);
  } else {
    const affiliation = setCharacterAffiliation(characterID, actualCorporationID, null);
    if (!affiliation.success) throw new Error(affiliation.errorMsg || "PLAYERBOT_AFFILIATION_FAILED");
    ensureCharacterMemberState(actualCorporationID, characterID);
  }
  const bot = {
    characterID,
    characterName: characterResult.data.characterName,
    specialty: specialty.id,
    specialtyCorporationID: actualCorporationID,
    corporationID: actualCorporationID,
    status: "idle",
    currentTask: null,
    createdAt: new Date().toISOString(),
    founder: Boolean(founder),
    ...(origin ? {
      raceID: origin.raceID,
      hubStationID: require("./playerBotEconomyRuntime").hubStationForRace(origin.raceID),
    } : {}),
  };
  saveBot(bot, { rosterMembershipChanged: true });
  return bot;
}

function buildRosterSeedContext(target) {
  if (rosterSeedContextCache && rosterSeedContextCache.target === target &&
      rosterSeedContextCache.version === rosterSeedContextVersion) return rosterSeedContextCache;
  // Seeding only needs persisted bot fields. Avoid hydrating every character
  // record here; at a 15k roster that would turn each batch into 15k database
  // lookups on the EveJS request loop.
  const records = Object.values(readBots())
    .filter((record) => record && Number.isSafeInteger(Number(record.characterID)) && Number(record.characterID) > 0);
  const corporationBotCounts = new Map();
  const specialtyCorporationBotCounts = new Map();
  const corporationIDsBySpecialty = new Map(SPECIALTIES.map((specialty) => [specialty.id, new Set()]));
  const botByCharacterID = new Map();
  const specialtyBotCounts = new Map(SPECIALTIES.map((specialty) => [specialty.id, 0]));
  for (const bot of records) {
    const characterID = Number(bot.characterID) || 0;
    const corporationID = Number(bot.corporationID) || 0;
    if (characterID) botByCharacterID.set(characterID, bot);
    if (corporationID) corporationBotCounts.set(corporationID, (corporationBotCounts.get(corporationID) || 0) + 1);
    if (specialtyBotCounts.has(bot.specialty)) specialtyBotCounts.set(bot.specialty, specialtyBotCounts.get(bot.specialty) + 1);
    if (bot.specialty && corporationID && Number(bot.specialtyCorporationID) === corporationID) {
      corporationIDsBySpecialty.get(bot.specialty)?.add(corporationID);
      const countKey = `${bot.specialty}:${corporationID}`;
      specialtyCorporationBotCounts.set(countKey, (specialtyCorporationBotCounts.get(countKey) || 0) + 1);
    }
  }
  const specialtyPlans = balancedTargets(target).map(({ specialty, target: specialtyTarget }, specialtyIndex) => {
    const targetBots = specialtyBotCounts.get(specialty.id) || 0;
    const shards = balancedCorporationTargets(specialtyTarget).map((shardSize, shardIndex) => {
      let corporation = findCorporationByFoundingOperationID(foundingOperationIDForShard(specialty.id, shardIndex));
      if (!corporation && shardIndex === 0) {
        const corporationID = [...(corporationIDsBySpecialty.get(specialty.id) || [])]
          .sort((left, right) => left - right)[0];
        corporation = corporationID ? getCorporationRecord(corporationID) : null;
      }
      const corporationID = Number(corporation && corporation.corporationID) || 0;
      return {
        shardIndex,
        target: Math.min(MAX_BOTS_PER_CORPORATION, shardSize),
        corporationID,
        botCount: corporationID ? Number(specialtyCorporationBotCounts.get(`${specialty.id}:${corporationID}`) || 0) : 0,
        corporationBotCount: corporationID ? Number(corporationBotCounts.get(corporationID) || 0) : 0,
      };
    });
    return { specialty, specialtyIndex, target: specialtyTarget, botCount: targetBots, shards };
  });
  const context = {
    target,
    version: rosterSeedContextVersion,
    records,
    recordByCharacterID: botByCharacterID,
    corporationBotCounts,
    specialtyCorporationBotCounts,
    specialtyPlans,
    createdBySpecialty: Object.fromEntries(SPECIALTIES.map((specialty) => [specialty.id, 0])),
  };
  rosterSeedContextCache = context;
  return context;
}

function compareFillRatio(leftCount, leftTarget, rightCount, rightTarget, leftIndex, rightIndex) {
  const leftRatio = leftTarget > 0 ? leftCount / leftTarget : 1;
  const rightRatio = rightTarget > 0 ? rightCount / rightTarget : 1;
  return leftRatio - rightRatio || leftIndex - rightIndex;
}

function checkSeedCorporationCapacity(context, specialtyPlan, shard) {
  let corporation = getCorporationRecord(shard.corporationID);
  if (!corporation) throw new Error(`Corporation ${shard.corporationID} is missing for ${specialtyPlan.specialty.id} shard ${shard.shardIndex + 1}.`);
  const founderBot = context.recordByCharacterID.get(Number(corporation.ceoID));
  const managedSpecialtyCorporation = String(corporation.foundingOperationID || "").startsWith("evejs-playerbots:");
  const nonBotMembers = Math.max(0, Number(corporation.memberCount || 0) - shard.corporationBotCount);
  if (founderBot && Number(corporation.memberLimit) < shard.target) {
    require("./playerBotProvisioningRuntime").reconcileManagedCorporationMemberLimits([founderBot]);
    corporation = getCorporationRecord(shard.corporationID) || corporation;
  }
  // A human can become CEO of a playerbot specialty corporation. Keep that
  // managed shard usable by the roster seeder; its trained bot CEO no longer
  // exists to raise the member limit automatically. Preserve 300 bot seats,
  // adding capacity for the human CEO and any other non-bot members.
  const requiredMemberLimit = MAX_BOTS_PER_CORPORATION + nonBotMembers;
  if (managedSpecialtyCorporation && Number(corporation.memberLimit) < requiredMemberLimit) {
    const result = require("../corporation/corporationRuntimeState")
      .updateCorporationRecord(shard.corporationID, { memberLimit: requiredMemberLimit });
    if (result && result.success) corporation = getCorporationRecord(shard.corporationID) || corporation;
    else throw new Error(`Could not raise managed corporation ${shard.corporationID} to ${requiredMemberLimit} total members (${MAX_BOTS_PER_CORPORATION} bot seats): ${result && result.errorMsg || "unknown error"}.`);
  }
  const memberLimit = Number(corporation.memberLimit) || 0;
  if (memberLimit - nonBotMembers < shard.target) {
    throw new Error(`Corporation ${shard.corporationID} has room for ${Math.max(0, memberLimit - nonBotMembers)} playerbots; ${shard.target} are required for this shard.`);
  }
  return corporation;
}

function createNextRosterSeedBot(context) {
  const specialtyPlan = context.specialtyPlans
    .filter((plan) => plan.botCount < plan.target)
    .sort((left, right) => compareFillRatio(
      left.botCount, left.target, right.botCount, right.target, left.specialtyIndex, right.specialtyIndex,
    ))[0];
  if (!specialtyPlan || context.records.length >= context.target) return null;
  const shardCandidates = specialtyPlan.shards.filter((plan) => plan.botCount < plan.target);
  // Never found a new shard while an existing corporation still has planned
  // bot seats. If secondary shards already exist (as on a resumed seed), fill
  // them by ratio so the older corp is not left to grow alone and all existing
  // corps remain populated together.
  const existingShardCandidates = shardCandidates.filter((plan) => Number(plan.corporationID) > 0);
  const shard = (existingShardCandidates.length ? existingShardCandidates : shardCandidates)
    .sort((left, right) => compareFillRatio(
      left.botCount, left.target, right.botCount, right.target, left.shardIndex, right.shardIndex,
    ))[0];
  if (!shard) throw new Error(`No corporation shard has room for ${specialtyPlan.specialty.id}.`);

  let bot;
  if (!shard.corporationID) {
    if (shard.target < MIN_BOTS_PER_CORPORATION) return null;
    bot = createBotInTeam(specialtyPlan.specialty, null, true, shard.shardIndex);
    shard.corporationID = Number(bot.corporationID) || 0;
    shard.botCount += 1;
    shard.corporationBotCount = 1;
    specialtyPlan.botCount += 1;
    context.corporationBotCounts.set(shard.corporationID, 1);
    context.specialtyCorporationBotCounts.set(`${specialtyPlan.specialty.id}:${shard.corporationID}`, 1);
    context.records.push(bot);
    context.recordByCharacterID.set(Number(bot.characterID), bot);
    // Newly founded shards need their CEO's normal EVE corporation skills
    // before we can safely fill them past the default member limit.
    require("./playerBotProvisioningRuntime").reconcileManagedCorporationMemberLimits([bot]);
    checkSeedCorporationCapacity(context, specialtyPlan, shard);
  } else {
    const corporation = checkSeedCorporationCapacity(context, specialtyPlan, shard);
    bot = createBotInTeam(specialtyPlan.specialty, corporation.corporationID, false, shard.shardIndex);
    shard.botCount += 1;
    shard.corporationBotCount += 1;
    specialtyPlan.botCount += 1;
    context.corporationBotCounts.set(shard.corporationID, shard.corporationBotCount);
    context.specialtyCorporationBotCounts.set(
      `${specialtyPlan.specialty.id}:${shard.corporationID}`,
      shard.botCount,
    );
    context.records.push(bot);
    context.recordByCharacterID.set(Number(bot.characterID), bot);
  }
  context.createdBySpecialty[specialtyPlan.specialty.id] += 1;
  return bot;
}

function normalizeRosterSeedBatchLimit(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0
    ? Math.min(MAX_ROSTER_SEED_BATCH_SIZE, numeric)
    : DEFAULT_ROSTER_SEED_BATCH_SIZE;
}

function validateRosterSeedTarget(requestedTarget) {
  const target = Math.trunc(Number(requestedTarget));
  const ceiling = getOperationalCeiling();
  if (!Number.isInteger(target) || target < MIN_CORPORATIONS * MIN_BOTS_PER_CORPORATION || target > ceiling) {
    return { success: false, target, message: `Roster target must be between ${MIN_CORPORATIONS * MIN_BOTS_PER_CORPORATION} and the configured ceiling of ${ceiling} bots (hard limit ${HARD_MAX}).` };
  }
  return { success: true, target };
}

function rosterSeedResult(context, created, extra = {}) {
  const complete = context.records.length >= context.target;
  const createdSummary = Object.entries(context.createdBySpecialty)
    .filter(([, count]) => count > 0)
    .map(([specialty, count]) => `${specialty} ${count}`)
    .join(", ");
  return {
    success: complete || !extra.error,
    complete,
    created,
    rosterCount: context.records.length,
    target: context.target,
    createdBySpecialty: { ...context.createdBySpecialty },
    message: complete
      ? `Roster ready: ${context.records.length}/${context.target} playerbots.`
      : `Roster seed batch created ${created} bot(s): ${context.records.length}/${context.target}${createdSummary ? ` (${createdSummary})` : ""}${extra.error ? `. ${extra.error}` : "."}`,
    ...extra,
  };
}

function resetSeedBatchCounts(context) {
  for (const specialty of SPECIALTIES) context.createdBySpecialty[specialty.id] = 0;
}

function seedRoster(requestedTarget = getConfiguredTarget(), maxNewBots = DEFAULT_ROSTER_SEED_BATCH_SIZE) {
  const validation = validateRosterSeedTarget(requestedTarget);
  if (!validation.success) return validation;
  const target = validation.target;
  const context = buildRosterSeedContext(target);
  if (context.records.length > target) {
    return { success: false, target, rosterCount: context.records.length, message: `There are already ${context.records.length} playerbots; the roster is never reduced automatically.` };
  }
  resetSeedBatchCounts(context);
  let created = 0;
  try {
    const limit = normalizeRosterSeedBatchLimit(maxNewBots);
    while (created < limit && context.records.length < target) {
      creatingRosterSeedBot = true;
      let bot;
      try { bot = createNextRosterSeedBot(context); } finally { creatingRosterSeedBot = false; }
      if (!bot) break;
      created += 1;
    }
  } catch (error) {
    return rosterSeedResult(context, created, { error: String(error && error.message || error).slice(0, 240) });
  }
  return rosterSeedResult(context, created);
}

async function seedRosterBatch(requestedTarget = getConfiguredTarget(), maxNewBots = DEFAULT_ROSTER_SEED_BATCH_SIZE, options = {}) {
  const validation = validateRosterSeedTarget(requestedTarget);
  if (!validation.success) return validation;
  const target = validation.target;
  const startedAt = performance.now();
  let context = null;
  let created = 0;
  let maxBotCreationMs = 0;
  let contextBuildMs = 0;
  const limit = normalizeRosterSeedBatchLimit(maxNewBots);
  const shouldContinue = typeof options.shouldContinue === "function" ? options.shouldContinue : () => true;
  const maximumSingleBotMs = Math.max(25, Math.min(10_000, Number(options.maximumSingleBotMs) || 1_000));
  let backpressure = false;
  let stopReason = "";
  try {
    const contextStartedAt = performance.now();
    context = buildRosterSeedContext(target);
    contextBuildMs = Math.max(0, performance.now() - contextStartedAt);
    if (context.records.length > target) {
      resetSeedBatchCounts(context);
      return {
        ...rosterSeedResult(context, 0),
        overTarget: true,
        message: `The roster already has ${context.records.length} pilots above target ${target}; no bots were removed.`,
      };
    }
    resetSeedBatchCounts(context);
    // Let EveJS process pending client/network work after building the plan,
    // then measure loop delay before writing the first new character.
    await new Promise((resolve) => setImmediate(resolve));
    while (created < limit && context.records.length < target) {
      if (!shouldContinue()) {
        stopReason = typeof options.getStopReason === "function"
          ? String(options.getStopReason() || "server load guard stopped the roster seed batch")
          : "server load guard stopped the roster seed batch";
        backpressure = stopReason !== "roster seeding is paused";
        break;
      }
      const createStartedAt = performance.now();
      creatingRosterSeedBot = true;
      let bot;
      try { bot = createNextRosterSeedBot(context); } finally { creatingRosterSeedBot = false; }
      const createDurationMs = Math.max(0, performance.now() - createStartedAt);
      maxBotCreationMs = Math.max(maxBotCreationMs, createDurationMs);
      if (!bot) break;
      created += 1;
      await new Promise((resolve) => setImmediate(resolve));
      if (rosterSeedContextCache !== context || context.version !== rosterSeedContextVersion) {
        backpressure = true;
        stopReason = "roster changed during this batch; refreshed the plan before continuing";
        break;
      }
      if (createDurationMs > maximumSingleBotMs) {
        backpressure = true;
        stopReason = `one bot creation took ${Math.round(createDurationMs)} ms; reducing seed pressure`;
        break;
      }
    }
  } catch (error) {
    if (context) created = Math.max(created, Object.values(context.createdBySpecialty).reduce((sum, count) => sum + count, 0));
    return rosterSeedResult(context || { records: [], target, createdBySpecialty: {} }, created, {
      error: String(error && error.message || error).slice(0, 240),
      batchDurationMs: Math.round(performance.now() - startedAt),
      contextBuildMs: Math.round(contextBuildMs),
      maxBotCreationMs: Math.round(maxBotCreationMs),
    });
  }
  const result = rosterSeedResult(context, created, {
    backpressure,
    stopReason,
    batchDurationMs: Math.round(performance.now() - startedAt),
    contextBuildMs: Math.round(contextBuildMs),
    maxBotCreationMs: Math.round(maxBotCreationMs),
    retryAfterMs: backpressure ? 15_000 : 0,
  });
  return result;
}

function getStatusMessage() {
  const records = listBots();
  const target = getConfiguredTarget();
  const pausedCount = records.filter((bot) =>
    bot.status === "paused" || bot.autonomyPaused === true,
  ).length;
  const rows = SPECIALTIES.map((specialty) => {
    const corps = findTeamCorporations(specialty.id, records);
    const sizes = corps.map((corporation) => botRecordsForCorporation(corporation.corporationID, records).length);
    const count = sizes.reduce((sum, size) => sum + size, 0);
    return `${specialty.name}: ${count} bots across ${corps.length} corps (${sizes.join(",") || "none"})`;
  });
  return [
    `Playerbots: ${records.length}/${target} target; operational ceiling ${getOperationalCeiling()}; hard maximum ${HARD_MAX}.`,
    `Specialist corporations: target shard ${BOT_CORPORATION_TARGET_SIZE}, maximum ${MAX_BOTS_PER_CORPORATION} bots per corporation.`,
    `Autonomy: ${pausedCount} bots paused; durable queue is available with /playerbots tasks.`,
    rows.join(" | "),
    "PI maintenance runs every 5 minutes; use /playerbots ops to view results.",
  ].join("\n");
}

function resolveBot(query) {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  if (!normalized) return null;
  const bots = listBots();
  const exact = bots.find((bot) => bot.characterName.toLocaleLowerCase() === normalized);
  if (exact) return exact;
  const matches = bots.filter((bot) => bot.characterName.toLocaleLowerCase().includes(normalized));
  return matches.length === 1 ? matches[0] : null;
}

function getSessionCharacterID(session) {
  return Math.trunc(Number(session && (
    session.characterID || session.charID || session.charid
  )) || 0);
}

function getCorpService() {
  const CorpRegistryRuntimeService = require("../corporation/corpRegistryRuntime");
  return new CorpRegistryRuntimeService();
}

function countBotsInCorporation(corporationID, records = listBots()) {
  return botRecordsForCorporation(corporationID, records).length;
}

function inviteBotToPlayerCorporation(session, botQuery) {
  const bot = resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique bot found for: ${botQuery}.` };
  const playerCharacterID = getSessionCharacterID(session);
  const targetCorporationID = Number(session && (session.corporationID || session.corpid)) || 0;
  if (!playerCharacterID || !targetCorporationID) return { success: false, message: "Select a character in a corporation before inviting bots." };
  const currentCorporationID = Number(bot.corporationID) || 0;
  if (currentCorporationID === targetCorporationID) return { success: false, message: `${bot.characterName} is already in your corporation.` };
  if (countBotsInCorporation(targetCorporationID) >= MAX_BOTS_PER_PLAYER_CORPORATION) {
    return { success: false, message: `Your corporation already has the maximum of ${MAX_BOTS_PER_PLAYER_CORPORATION} playerbots.` };
  }
  if (currentCorporationID === Number(bot.specialtyCorporationID) &&
      countBotsInCorporation(currentCorporationID) <= MIN_BOTS_PER_CORPORATION) {
    return { success: false, message: `${bot.characterName} is needed to keep the specialist corporation at ${MIN_BOTS_PER_CORPORATION} bots.` };
  }
  if (bot.founder && currentCorporationID === Number(bot.specialtyCorporationID)) {
    return { success: false, message: `${bot.characterName} is the CEO of a specialist corporation and cannot leave it.` };
  }

  const service = getCorpService();
  try {
    service.Handle_InsertInvitation([bot.characterID], session);
    const runtime = require("../corporation/corporationRuntimeState").getCorporationRuntime(targetCorporationID) || {};
    const application = Object.values(runtime.applications || {})
      .filter((item) => Number(item.characterID) === Number(bot.characterID) &&
        Number(item.status) === CORP_INVITED_BY_CORPORATION)
      .sort((left, right) => Number(right.applicationID) - Number(left.applicationID))[0];
    if (!application) throw new Error("INVITATION_NOT_RECORDED");
    service.Handle_UpdateApplicationStatus([
      application.applicationID,
      bot.characterID,
      targetCorporationID,
      "",
      CORP_ACCEPTED_BY_CHARACTER,
      "",
    ], createBotSession(bot));
    const updated = {
      ...bot,
      corporationID: targetCorporationID,
      status: "idle",
      currentTask: null,
      joinedPlayerCorporationAt: new Date().toISOString(),
    };
    saveBot(updated, { rosterMembershipChanged: true });
    const corporation = getCorporationRecord(targetCorporationID);
    return { success: true, message: `${bot.characterName} accepted the invitation and joined ${corporation?.corporationName || "your corporation"}.` };
  } catch (error) {
    return { success: false, message: `Could not complete the corporation invitation: ${error.message}` };
  }
}

function invitePlayerToBotCorporation(session, botQuery) {
  const selectedBot = resolveBot(botQuery);
  if (!selectedBot) return { success: false, message: `No unique bot found for: ${botQuery}.` };
  const playerCharacterID = getSessionCharacterID(session);
  if (!playerCharacterID) return { success: false, message: "Select a character before requesting an invitation." };
  const corporationID = Number(selectedBot.specialtyCorporationID) || 0;
  const corporation = getCorporationRecord(corporationID);
  if (!corporation) return { success: false, message: "That bot’s specialist corporation no longer exists." };
  const records = listBots();
  const ceoBot = records.find((bot) => Number(bot.characterID) === Number(corporation.ceoID) &&
    Number(bot.corporationID) === corporationID);
  if (!ceoBot) return { success: false, message: `There is no active CEO bot in ${corporation.corporationName} to issue the invitation.` };
  const runtime = require("../corporation/corporationRuntimeState").getCorporationRuntime(corporationID) || {};
  const pending = Object.values(runtime.applications || {}).find((application) =>
    Number(application.characterID) === playerCharacterID &&
    Number(application.status) === CORP_INVITED_BY_CORPORATION,
  );
  if (pending) return { success: true, message: `${corporation.corporationName} already has a pending invitation for you; accept it in the client.` };
  try {
    const invitationID = getCorpService().Handle_InsertInvitation(
      [playerCharacterID],
      createBotSession(ceoBot),
    );
    return { success: true, message: `${corporation.corporationName} invited you (application ${invitationID}). Accept it from the corporation window in the client.` };
  } catch (error) {
    return { success: false, message: `Could not request the invitation: ${error.message}` };
  }
}

function addBotToPlayerFleet(session, botQuery) {
  const bot = resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique bot found for: ${botQuery}.` };
  const playerCharacterID = getSessionCharacterID(session);
  if (!playerCharacterID) return { success: false, message: "Select a character before forming a fleet." };
  const fleetRuntime = require("../fleets/fleetRuntime");
  if (fleetRuntime.getFleetForCharacter(bot.characterID)) {
    return { success: false, message: `${bot.characterName} is already in a fleet.` };
  }
  let fleet = fleetRuntime.getFleetForCharacter(playerCharacterID);
  try {
    if (!fleet) {
      const fleetRecord = fleetRuntime.createFleetRecord(session);
      const fleetID = fleetRecord.fleetID;
      fleetRuntime.initFleet(session, fleetID, {
        shipTypeID: Number(session && (session.shipTypeID || session.shiptypeid)) || null,
      });
      fleet = fleetRuntime.getFleetByID(fleetID);
    }
    fleetRuntime.inviteCharacter(session, fleet.fleetID, bot.characterID, null, null, null, { autoAccept: true });
    return { success: true, message: `${bot.characterName} joined your fleet ${fleet.fleetID}.` };
  } catch (error) {
    return { success: false, message: `Could not add the bot to the fleet: ${error.message}` };
  }
}

function invitePlayerToBotFleet(session, botQuery) {
  const bot = resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique bot found for: ${botQuery}.` };
  const playerCharacterID = getSessionCharacterID(session);
  if (!playerCharacterID) return { success: false, message: "Select a character before requesting a fleet invitation." };
  const fleetRuntime = require("../fleets/fleetRuntime");
  if (fleetRuntime.getFleetForCharacter(playerCharacterID)) return { success: false, message: "Leave your current fleet before receiving another invitation." };
  try {
    let fleet = fleetRuntime.getFleetForCharacter(bot.characterID);
    const botSession = createBotSession(bot);
    if (!fleet) {
      const fleetRecord = fleetRuntime.createFleetRecord(botSession);
      const fleetID = fleetRecord.fleetID;
      fleetRuntime.initFleet(botSession, fleetID, { shipTypeID: botSession.shipTypeID });
      fleet = fleetRuntime.getFleetByID(fleetID);
    }
    fleetRuntime.inviteCharacter(botSession, fleet.fleetID, playerCharacterID, null, null, null);
    return { success: true, message: `${bot.characterName} invited you to fleet ${fleet.fleetID}; accept the invitation in the client.` };
  } catch (error) {
    return { success: false, message: `Could not create the fleet invitation: ${error.message}` };
  }
}

module.exports = {
  DEFAULT_TARGET,
  getConfiguredTarget,
  getOperationalCeiling,
  DEFAULT_ROSTER_CEILING,
  HARD_MAX,
  MAX_BOTS_PER_CORPORATION,
  BOT_CORPORATION_TARGET_SIZE,
  MAX_BOTS_PER_PLAYER_CORPORATION,
  MAX_FUNDING_TRANSFER_ISK,
  MIN_BOTS_PER_CORPORATION,
  SPECIALTIES,
  createBotSession,
  getBotByCharacterID,
  getPlanningRoster,
  getBotCount,
  forgetBotCorporationRoleState,
  syncBotCorporationSession,
  addBotToPlayerFleet,
  getStatusMessage,
  fundBotFromPlayer,
  inviteBotToPlayerCorporation,
  invitePlayerToBotCorporation,
  invitePlayerToBotFleet,
  listBotProfiles,
  listBots,
  resolveBot,
  setBotAutonomyState,
  seedRoster,
  seedRosterBatch,
  DEFAULT_ROSTER_SEED_BATCH_SIZE,
  MAX_ROSTER_SEED_BATCH_SIZE,
  balancedTargets,
  balancedCorporationTargets,
  findTeamCorporations,
};

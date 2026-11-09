"use strict";

// One-time provisioning of the managed roster, as an operator decision: a
// starting capital grant so bots can run their trades from day one, and a
// varied skill profile per specialty and per pilot instead of identical
// sheets. Each grant is recorded per bot and never repeated. Capital ships
// and their skills are deliberately absent.

const { createTableRepository } = require("../../gameStore/tableRepository");
const log = require("../../utils/logger");

const TABLE = "playerBots";
const PROVISIONING_PATH = "/_provisioning";
// v16 also trains bot corporation founders for 300 member slots per shard.
// The v3 random profile roll stays stable and migrations only raise skills.
const SKILL_PROFILE_VERSION = 16;
const SKILL_PROFILE_ROLL_VERSION = 3;
const DEFAULT_STARTING_CAPITAL = 1_000_000_000;
const DEFAULT_OPENING_WALLET_BALANCE = 100_000;
const repo = createTableRepository("service:playerbots", { strict: true });

function readState() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, PROVISIONING_PATH);
  const data = result.success && result.data && typeof result.data === "object" ? result.data : {};
  return { bots: {}, ...JSON.parse(JSON.stringify(data)) };
}

function getProvisioningRecord(characterID) {
  return readState().bots[String(Math.trunc(Number(characterID) || 0))] || null;
}

// Skill typeIDs by name (static SDE values).
const SKILL = Object.freeze({
  mining: 3386, astrogeology: 3410, miningFrigate: 32918, miningBarge: 17940,
  reprocessing: 3385, reprocessingEfficiency: 3389, scorditeProcessing: 12193,
  veldsparProcessing: 12195, simpleOreProcessing: 60377, miningUpgrades: 22578,
  industry: 3380, advancedIndustry: 3388, massProduction: 3387, advancedMassProduction: 24625,
  science: 3402, supplyChainManagement: 24268,
  trade: 3443, retail: 3444, wholesale: 16596, accounting: 16622, brokerRelations: 3446,
  marketing: 16598, daytrading: 16595, procurement: 16594,
  tycoon: 18580,
  spaceshipCommand: 3327, navigation: 3449, warpDriveOperation: 3455, evasiveManeuvering: 3453,
  mechanics: 3392, hullUpgrades: 3394, shieldOperation: 3416, cpuManagement: 3426,
  powerGridManagement: 3413, targetManagement: 3429, longRangeTargeting: 3428,
  gunnery: 3300, smallHybridTurret: 3301, smallProjectileTurret: 3302,
  missileLauncherOperation: 3319, lightMissiles: 3321, drones: 3436, lightDroneOperation: 24241,
  caldariFrigate: 3330, minmatarFrigate: 3329, gallenteFrigate: 3328, amarrFrigate: 3331,
  gallenteCruiser: 3335, gallenteDestroyer: 33093, mediumDroneOperation: 12484,
  caldariDestroyer: 33092,
  empireControl: 3732, megacorpManagement: 3731,
  commandCenterUpgrades: 2505, interplanetaryConsolidation: 2495, planetology: 2406, remoteSensing: 13279,
  caldariHauler: 3342,
  infomorphPsychology: 24242,
  leadership: 3348, corporationManagement: 3363, anchoring: 11584, social: 3355, connections: 3359,
});

// [skill, minLevel, maxLevel]; each pilot rolls its own level in that band.
const COMMON = [
  [SKILL.spaceshipCommand, 2, 4], [SKILL.navigation, 1, 4], [SKILL.warpDriveOperation, 1, 3],
  [SKILL.mechanics, 1, 3], [SKILL.hullUpgrades, 1, 3], [SKILL.shieldOperation, 1, 3],
  [SKILL.cpuManagement, 2, 4], [SKILL.powerGridManagement, 2, 4], [SKILL.targetManagement, 1, 3],
  [SKILL.mining, 1, 4], [SKILL.miningFrigate, 1, 3], [SKILL.caldariFrigate, 1, 3], [SKILL.astrogeology, 0, 3],
  [SKILL.reprocessing, 1, 3], [SKILL.scorditeProcessing, 0, 2], [SKILL.veldsparProcessing, 0, 2],
  [SKILL.commandCenterUpgrades, 1, 2], [SKILL.interplanetaryConsolidation, 1, 2],
  [SKILL.caldariHauler, 1, 2],
  [SKILL.planetology, 1, 2], [SKILL.remoteSensing, 1, 2],
  [SKILL.industry, 1, 3], [SKILL.massProduction, 1, 2], [SKILL.science, 1, 2],
  [SKILL.trade, 1, 3], [SKILL.accounting, 0, 3], [SKILL.brokerRelations, 0, 3],
];
const BY_SPECIALTY = Object.freeze({
  industry: [
    [SKILL.industry, 3, 5], [SKILL.advancedIndustry, 1, 4], [SKILL.massProduction, 1, 4],
    [SKILL.advancedMassProduction, 0, 2], [SKILL.science, 1, 4], [SKILL.supplyChainManagement, 0, 3],
    [SKILL.reprocessingEfficiency, 0, 3], [SKILL.miningBarge, 0, 2],
  ],
  trade: [
    [SKILL.trade, 3, 5], [SKILL.retail, 1, 4], [SKILL.wholesale, 0, 3], [SKILL.accounting, 2, 5],
    [SKILL.brokerRelations, 2, 5], [SKILL.marketing, 0, 3], [SKILL.daytrading, 0, 3], [SKILL.procurement, 0, 3],
  ],
  planetary: [
    [SKILL.commandCenterUpgrades, 1, 4], [SKILL.interplanetaryConsolidation, 1, 4],
    [SKILL.planetology, 0, 3], [SKILL.remoteSensing, 0, 3], [SKILL.miningBarge, 0, 1],
    [SKILL.caldariHauler, 1, 3],
  ],
  security: [
    [SKILL.gunnery, 2, 4], [SKILL.smallHybridTurret, 1, 4], [SKILL.drones, 1, 4], [SKILL.lightDroneOperation, 1, 3],
    [SKILL.gallenteFrigate, 3, 4], [SKILL.gallenteDestroyer, 1, 3], [SKILL.gallenteCruiser, 1, 3],
    [SKILL.mediumDroneOperation, 1, 3], [SKILL.longRangeTargeting, 0, 3],
  ],
  piracy: [
    [SKILL.gunnery, 2, 4], [SKILL.smallProjectileTurret, 1, 4], [SKILL.missileLauncherOperation, 1, 3],
    [SKILL.lightMissiles, 0, 3], [SKILL.gallenteFrigate, 3, 4], [SKILL.gallenteDestroyer, 1, 3],
    [SKILL.gallenteCruiser, 1, 3], [SKILL.mediumDroneOperation, 1, 3], [SKILL.evasiveManeuvering, 1, 4],
  ],
  sovereignty: [
    [SKILL.empireControl, 5, 5],
    [SKILL.leadership, 1, 4], [SKILL.corporationManagement, 1, 4], [SKILL.anchoring, 1, 3],
    [SKILL.social, 1, 3], [SKILL.connections, 0, 3], [SKILL.gallenteFrigate, 1, 3], [SKILL.amarrFrigate, 1, 3],
  ],
});

function saveState(state) {
  const result = repo.write(TABLE, PROVISIONING_PATH, state);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_PROVISIONING_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) throw new Error(flush && flush.errorMsg || "PLAYERBOT_PROVISIONING_FLUSH_FAILED");
  return state;
}

function seeded(characterID, salt) {
  let state = ((Number(characterID) * 2654435761) ^ (salt * 40503)) >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function buildSkillProfile(bot) {
  const random = seeded(bot.characterID, SKILL_PROFILE_ROLL_VERSION);
  // Some pilots are veterans, most are mid-career, a few are fresh.
  const experience = random();
  const shift = experience > 0.85 ? 1 : experience < 0.2 ? -1 : 0;
  const levels = new Map();
  for (const [typeID, minLevel, maxLevel] of [...COMMON, ...(BY_SPECIALTY[bot.specialty] || [])]) {
    const span = maxLevel - minLevel + 1;
    const level = Math.max(minLevel, Math.min(5, minLevel + Math.floor(random() * span) + shift));
    if (level > (levels.get(typeID) || 0)) levels.set(typeID, level);
  }
  // Every pilot can fly the mining ladder's first rung and fit Miner I.
  levels.set(SKILL.mining, Math.max(1, levels.get(SKILL.mining) || 0));
  levels.set(SKILL.miningFrigate, Math.max(1, levels.get(SKILL.miningFrigate) || 0));
  levels.set(SKILL.caldariFrigate, Math.max(1, levels.get(SKILL.caldariFrigate) || 0));
  levels.set(SKILL.spaceshipCommand, Math.max(1, levels.get(SKILL.spaceshipCommand) || 0));
  levels.set(SKILL.caldariHauler, Math.max(1, levels.get(SKILL.caldariHauler) || 0));
  levels.set(SKILL.caldariHauler, Math.max(5, levels.get(SKILL.caldariHauler) || 0));
  levels.set(SKILL.hullUpgrades, Math.max(4, levels.get(SKILL.hullUpgrades) || 0));
  levels.set(SKILL.industry, Math.max(1, levels.get(SKILL.industry) || 0));
  levels.set(SKILL.commandCenterUpgrades, Math.max(1, levels.get(SKILL.commandCenterUpgrades) || 0));
  levels.set(SKILL.interplanetaryConsolidation, Math.max(1, levels.get(SKILL.interplanetaryConsolidation) || 0));
  levels.set(SKILL.planetology, Math.max(1, levels.get(SKILL.planetology) || 0));
  levels.set(SKILL.remoteSensing, Math.max(1, levels.get(SKILL.remoteSensing) || 0));
  levels.set(SKILL.massProduction, Math.max(1, levels.get(SKILL.massProduction) || 0));
  levels.set(SKILL.science, Math.max(1, levels.get(SKILL.science) || 0));
  // Market orders can remain open for 90 days when buyers are absent. Give
  // every producer the game's full 305-slot market limit so sustained mining,
  // PI and manufacturing do not stall on the smaller specialty-only profiles.
  levels.set(SKILL.trade, Math.max(5, levels.get(SKILL.trade) || 0));
  levels.set(SKILL.retail, Math.max(5, levels.get(SKILL.retail) || 0));
  levels.set(SKILL.wholesale, Math.max(5, levels.get(SKILL.wholesale) || 0));
  levels.set(SKILL.tycoon, Math.max(5, levels.get(SKILL.tycoon) || 0));
  if (["security", "piracy"].includes(bot.specialty)) {
    levels.set(SKILL.gallenteFrigate, Math.max(4, levels.get(SKILL.gallenteFrigate) || 0));
    levels.set(SKILL.gallenteDestroyer, Math.max(3, levels.get(SKILL.gallenteDestroyer) || 0));
    levels.set(SKILL.gallenteCruiser, Math.max(3, levels.get(SKILL.gallenteCruiser) || 0));
    levels.set(SKILL.drones, Math.max(5, levels.get(SKILL.drones) || 0));
    levels.set(SKILL.lightDroneOperation, Math.max(3, levels.get(SKILL.lightDroneOperation) || 0));
    levels.set(SKILL.mediumDroneOperation, Math.max(3, levels.get(SKILL.mediumDroneOperation) || 0));
    try {
      for (const [typeID, requiredLevel] of require("./playerBotOperationRuntime")
        .getCombatShipSkillRequirements(bot.specialty)) {
        levels.set(Number(typeID), Math.max(Number(requiredLevel) || 1, levels.get(Number(typeID)) || 0));
      }
    } catch (_) {
      // The runtime fit audit still blocks a rung when static Dogma is unavailable.
    }
  }
  if (bot.specialty === "sovereignty") {
    levels.set(SKILL.gallenteFrigate, Math.max(1, levels.get(SKILL.gallenteFrigate) || 0));
    levels.set(SKILL.infomorphPsychology, Math.max(2, levels.get(SKILL.infomorphPsychology) || 0));
  }
  if (bot.founder && Number(bot.corporationID) === Number(bot.specialtyCorporationID)) {
    levels.set(SKILL.corporationManagement, 5);
    levels.set(SKILL.megacorpManagement, 2);
  }
  if (bot.specialty === "planetary") levels.set(SKILL.commandCenterUpgrades, 5);
  return levels;
}

function applySkillProfile(bot) {
  const skills = require("../skills/skillState");
  const current = skills.getCharacterSkillMap(bot.characterID);
  const grants = [];
  for (const [typeID, level] of buildSkillProfile(bot)) {
    const record = current && (current.get ? current.get(typeID) : current[typeID]);
    const currentLevel = Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0;
    if (level > currentLevel) grants.push({ typeID, level });
  }
  if (grants.length) skills.grantCharacterSkillLevels(bot.characterID, grants);
  return grants.length;
}

function corporationMemberLimitFromSkills(skillMap) {
  const level = (typeID) => {
    const record = skillMap && (skillMap.get ? skillMap.get(typeID) : skillMap[typeID]);
    const value = record && typeof record === "object"
      ? record.trainedSkillLevel ?? record.skillLevel
      : record;
    return Math.max(0, Math.min(5, Math.trunc(Number(value) || 0)));
  };
  const corporationManagement = level(SKILL.corporationManagement);
  const megacorpManagement = level(SKILL.megacorpManagement);
  const empireControl = level(SKILL.empireControl);
  return corporationManagement * 20 +
    (corporationManagement >= 5 ? megacorpManagement * 100 : 0) +
    (megacorpManagement >= 5 ? empireControl * 400 : 0);
}

function reconcileManagedCorporationMemberLimits(bots) {
  const state = require("../corporation/corporationState");
  const skills = require("../skills/skillState");
  const corporationRuntime = require("../corporation/corporationRuntimeState");
  const reconciled = new Set();
  let updated = 0;
  for (const bot of bots) {
    const corporationID = Number(bot && bot.specialtyCorporationID) || 0;
    if (!corporationID || Number(bot.corporationID) !== corporationID || reconciled.has(corporationID)) continue;
    reconciled.add(corporationID);
    const corporation = state.getCorporationRecord(corporationID);
    if (!corporation || !String(corporation.foundingOperationID || "").startsWith("evejs-playerbots:")) continue;
    const ceo = bots.find((candidate) => Number(candidate.characterID) === Number(corporation.ceoID));
    if (!ceo || Number(ceo.corporationID) !== corporationID) continue;
    const currentSkills = skills.getCharacterSkillMap(ceo.characterID);
    const leaderGrants = [
      [SKILL.corporationManagement, 5],
      [SKILL.megacorpManagement, 2],
    ].filter(([typeID, requiredLevel]) => {
      const record = currentSkills && (currentSkills.get ? currentSkills.get(typeID) : currentSkills[typeID]);
      const currentLevel = Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0;
      return currentLevel < requiredLevel;
    }).map(([typeID, level]) => ({ typeID, level }));
    if (leaderGrants.length) skills.grantCharacterSkillLevels(ceo.characterID, leaderGrants);
    const memberLimit = corporationMemberLimitFromSkills(skills.getCharacterSkillMap(ceo.characterID));
    if (memberLimit <= Number(corporation.memberLimit || 0)) continue;
    const result = corporationRuntime.updateCorporationRecord(corporationID, { memberLimit });
    if (result && result.success) updated += 1;
    else log.warn(`[PlayerBots] Corporation member limit update failed corp=${corporationID}: ${result && result.errorMsg || "unknown error"}.`);
  }
  return updated;
}

async function grantStartingCapital(bot, amount) {
  const wallet = require("../account/walletState");
  const result = await wallet.adjustCharacterBalanceAsync(
    bot.characterID,
    amount,
    { description: "Playerbot starting capital (operator grant)" },
    { source: "playerbot-starting-capital", idempotencyKey: `playerbots.starting-capital:${bot.characterID}` },
  );
  return Boolean(result && result.success);
}

function getConfiguredCapital() {
  const configured = Number(process.env.EVEJS_PLAYER_BOTS_STARTING_CAPITAL);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_STARTING_CAPITAL;
}

async function provisionRoster(bots = []) {
  const state = readState();
  const capital = getConfiguredCapital();
  const summary = { capitalGrants: 0, skillProfiles: 0, skillsRaised: 0, corporationLimitsRaised: 0 };
  let dirty = false;
  for (const bot of bots) {
    const key = String(bot.characterID);
    const entry = state.bots[key] || {};
    if (capital > 0 && !entry.startingCapitalAt) {
      const wallet = require("../account/walletState");
      const openingWalletBalance = Number(wallet.getCharacterWallet(bot.characterID)?.balance);
      try {
        if (await grantStartingCapital(bot, capital)) {
          entry.startingCapital = capital;
          entry.startingWalletBalance = Number.isFinite(openingWalletBalance)
            ? openingWalletBalance
            : DEFAULT_OPENING_WALLET_BALANCE;
          entry.startingCapitalAt = new Date().toISOString();
          summary.capitalGrants += 1;
          dirty = true;
        }
      } catch (error) {
        log.warn(`[PlayerBots] Starting capital failed char=${bot.characterID}: ${error.message}`);
      }
    }
    if (!Number.isFinite(Number(entry.startingWalletBalance))) {
      // Earlier provisioning versions stored the 1B grant but not the pilot's
      // ordinary opening wallet. The character's default wallet is 100,000 ISK.
      entry.startingWalletBalance = DEFAULT_OPENING_WALLET_BALANCE;
      dirty = true;
    }
    if (Number(entry.skillProfileVersion) !== SKILL_PROFILE_VERSION) {
      try {
        summary.skillsRaised += applySkillProfile(bot);
        entry.skillProfileVersion = SKILL_PROFILE_VERSION;
        summary.skillProfiles += 1;
        dirty = true;
      } catch (error) {
        log.warn(`[PlayerBots] Skill profile failed char=${bot.characterID}: ${error.message}`);
      }
    }
    state.bots[key] = entry;
  }
  try {
    summary.corporationLimitsRaised = reconcileManagedCorporationMemberLimits(bots);
  } catch (error) {
    log.warn(`[PlayerBots] Corporation member limit reconciliation failed: ${error.message}`);
  }
  if (dirty) {
    saveState(state);
    log.info(`[PlayerBots] Provisioning: capital grants=${summary.capitalGrants} (${capital} ISK each), skill profiles=${summary.skillProfiles}, skills raised=${summary.skillsRaised}, corporation limits raised=${summary.corporationLimitsRaised}.`);
  }
  return summary;
}

module.exports = {
  DEFAULT_OPENING_WALLET_BALANCE,
  DEFAULT_STARTING_CAPITAL,
  SKILL,
  buildSkillProfile,
  corporationMemberLimitFromSkills,
  getProvisioningRecord,
  reconcileManagedCorporationMemberLimits,
  provisionRoster,
};

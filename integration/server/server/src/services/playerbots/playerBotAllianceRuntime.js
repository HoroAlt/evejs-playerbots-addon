"use strict";

const ALLIANCE_FOUNDING_COST = 1_000_000_000;
const PLAYERBOT_SEED_RESERVE = 1_000_000_000;

function positiveID(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function getBotCorporation(bot) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  return require("../corporation/corporationState").getCorporationRecord(corporationID) || null;
}

function getAllianceFoundingPlan(bot) {
  if (!bot || bot.specialty !== "sovereignty") return null;
  const corporation = getBotCorporation(bot);
  if (!corporation || positiveID(corporation.allianceID)) return null;
  const corporationID = positiveID(corporation.corporationID || bot.corporationID);
  const activeFounding = require("./playerBotOperationRecords").listReadOnlyActiveOperations(require("./playerBotOperationRuntime"))
    .find((operation) => operation.kind === "alliance-founding" &&
      Number(operation.corporationID) === corporationID);
  if (activeFounding && Number(activeFounding.characterID) !== Number(bot.characterID)) return null;
  const pendingFounding = require("../corporation/allianceFoundingState")
    .getPendingAllianceFounding(corporationID);
  if (pendingFounding && Number(pendingFounding.characterID) !== Number(bot.characterID)) return null;
  const isCEO = Number(corporation.ceoID) === Number(bot.characterID);
  const roleMask = require("../corporation/corporationRuntimeState")
    .getCorporationMemberRoleMask(corporationID, bot.characterID);
  const allowDirectorFounder = !isCEO && (roleMask & 1n) === 1n;
  if (!isCEO && !allowDirectorFounder) return null;
  const balance = Math.max(0, Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0);
  if (balance < PLAYERBOT_SEED_RESERVE + ALLIANCE_FOUNDING_COST) return null;
  const formation = require("../corporation/allianceFormationEligibility");
  const base = `${String(corporation.corporationName || bot.characterName).trim()} Alliance`.slice(0, 50);
  const tickerBase = String(corporation.tickerName || corporation.shortName || "SOV").toUpperCase().replace(/[^A-Z0-9.-]/g, "").slice(0, 4) || "SOV";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const nameSuffix = attempt === 0 ? "" : attempt.toString(36).toUpperCase();
    const name = attempt === 0 ? base : `${base.slice(0, 49 - nameSuffix.length)} ${nameSuffix}`;
    const tickerSuffix = attempt === 0 ? "A" : attempt.toString(36).toUpperCase().padStart(2, "0");
    const shortName = `${tickerBase.slice(0, 5 - tickerSuffix.length)}${tickerSuffix}`;
    const allianceOptions = { name, shortName, description: `${name}, established by ${corporation.corporationName}.`, url: "" };
    const eligible = formation.checkAllianceFormationEligibility({
      characterID: Number(bot.characterID),
      corporationID: positiveID(corporation.corporationID || bot.corporationID),
      allianceOptions,
      allowDirectorFounder,
    });
    if (eligible && eligible.success) return {
      ...allianceOptions,
      allowDirectorFounder,
      balance,
      fee: ALLIANCE_FOUNDING_COST,
      retainedSeedReserve: PLAYERBOT_SEED_RESERVE,
    };
  }
  return null;
}

function start(bot, plan, options = {}) {
  const tools = options.operationTools || {};
  if (!bot || !plan || typeof tools.baseOperation !== "function" || typeof tools.saveOperation !== "function") {
    return { success: false, message: "A valid CEO bot and alliance founding plan are required." };
  }
  const currentPlan = getAllianceFoundingPlan(bot);
  if (!currentPlan || currentPlan.name !== plan.name || currentPlan.shortName !== plan.shortName ||
      currentPlan.allowDirectorFounder !== plan.allowDirectorFounder) {
    return { success: false, message: `${bot.characterName} is no longer eligible to found this alliance while retaining the original 1,000,000,000 ISK seed reserve.` };
  }
  const corporationID = positiveID(getBotCorporation(bot)?.corporationID || bot.corporationID);
  const existingPending = require("../corporation/allianceFoundingState").getPendingAllianceFounding(corporationID);
  if (existingPending && (JSON.stringify(existingPending.allianceOptions) !== JSON.stringify({
      name: plan.name,
      shortName: plan.shortName,
      description: plan.description,
      url: plan.url,
    }) || (existingPending.allowDirectorFounder === true) !== (plan.allowDirectorFounder === true))) {
    return { success: false, message: `Corporation ${corporationID} already has a different alliance founding settlement in progress.` };
  }
  const operation = tools.baseOperation("alliance-founding", bot, {
    stage: "found",
    allianceName: plan.name,
    allianceShortName: plan.shortName,
    allianceDescription: plan.description,
    allianceURL: plan.url,
    allowDirectorFounder: plan.allowDirectorFounder === true,
    foundingFee: ALLIANCE_FOUNDING_COST,
    retainedSeedReserve: PLAYERBOT_SEED_RESERVE,
    startingBalance: Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0,
    pendingFounding: Boolean(existingPending),
    allianceID: null,
    autonomous: options.autonomous === true,
  });
  tools.record(operation, `Preparing alliance ${plan.name} [${plan.shortName}]; the normal alliance authority will charge ${ALLIANCE_FOUNDING_COST.toFixed(2)} ISK and preserve the ${PLAYERBOT_SEED_RESERVE.toFixed(2)} ISK starting-capital reserve.`);
  tools.saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} is preparing alliance ${plan.name} [${plan.shortName}] through the normal corporation authority.` };
}

async function advance(operation, bot, kit) {
  const corporation = getBotCorporation(bot);
  const existingAllianceID = positiveID(corporation && corporation.allianceID);
  if (existingAllianceID) {
    const alliance = require("../corporation/corporationState").getAllianceRecord(existingAllianceID);
    if (alliance && Number(alliance.creatorCorpID || alliance.executorCorporationID) === Number(corporation.corporationID)) {
      operation.allianceID = existingAllianceID;
      operation.pendingFounding = false;
      operation.spent = Math.max(0, Number(operation.startingBalance || 0) -
        (Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0));
      return kit.finish(operation, `Alliance ${alliance.allianceName || operation.allianceName} [${alliance.shortName || operation.allianceShortName}] is confirmed as alliance ${existingAllianceID}; founding spend ${Number(operation.spent || 0).toFixed(2)} ISK, retained seed reserve ${Number(operation.retainedSeedReserve).toFixed(2)} ISK.`);
    }
  }

  const allianceOptions = {
    name: String(operation.allianceName || ""),
    shortName: String(operation.allianceShortName || ""),
    description: String(operation.allianceDescription || ""),
    url: String(operation.allianceURL || ""),
  };
  const eligibility = require("../corporation/allianceFormationEligibility").checkAllianceFormationEligibility({
    characterID: Number(bot.characterID),
    corporationID: Number(corporation && corporation.corporationID || bot.corporationID),
    allianceOptions,
    allowDirectorFounder: operation.allowDirectorFounder === true,
  });
  if (!eligibility.success) return kit.block(operation, "blocked", `Alliance founding is no longer eligible: ${eligibility.errorMsg}.`);
  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  if (balance < ALLIANCE_FOUNDING_COST + PLAYERBOT_SEED_RESERVE) {
    return kit.block(operation, "holding", `Alliance founding waits for ${Math.max(0, ALLIANCE_FOUNDING_COST + PLAYERBOT_SEED_RESERVE - balance).toFixed(2)} ISK more; the fee cannot consume the initial 1,000,000,000 ISK seed reserve.`);
  }

  operation.pendingFounding = true;
  operation.pendingFoundingAt = operation.pendingFoundingAt || new Date().toISOString();
  kit.save(operation);
  try {
    const session = require("./playerBotSpaceRuntime").getActorSession(bot);
    const result = await new (require("../corporation/corpRegistryRuntime"))()
      .Handle_CreateAlliance([
        allianceOptions.name,
        allianceOptions.shortName,
        allianceOptions.description,
        allianceOptions.url,
      ], session);
    const updated = getBotCorporation(bot);
    const allianceID = positiveID(result || updated && updated.allianceID);
    if (allianceID) operation.allianceID = allianceID;
  } catch (error) {
    operation.lastFoundingError = require("./playerBotSpaceRuntime").describeError(error).slice(0, 240);
  }

  const updatedCorporation = getBotCorporation(bot);
  const updatedAllianceID = positiveID(updatedCorporation && updatedCorporation.allianceID);
  if (updatedAllianceID) {
    const alliance = require("../corporation/corporationState").getAllianceRecord(updatedAllianceID);
    if (alliance && Number(alliance.creatorCorpID || alliance.executorCorporationID) === Number(updatedCorporation.corporationID)) {
      operation.allianceID = updatedAllianceID;
      operation.spent = Math.max(0, Number(operation.startingBalance || 0) -
        (Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0));
      operation.pendingFounding = false;
      return kit.finish(operation, `Alliance ${alliance.allianceName || operation.allianceName} [${alliance.shortName || operation.allianceShortName}] is confirmed as alliance ${updatedAllianceID}; founding spend ${Number(operation.spent || 0).toFixed(2)} ISK.`);
    }
  }

  const pending = require("../corporation/allianceFoundingState").getPendingAllianceFounding(Number(updatedCorporation && updatedCorporation.corporationID || bot.corporationID));
  if (pending) {
    return kit.block(operation, "holding", `Alliance ${operation.allianceName} is still being settled by the durable corporation authority; no duplicate founding fee was issued.`);
  }
  operation.pendingFounding = false;
  return kit.block(operation, "review", `Alliance founding did not reach an authoritative result${operation.lastFoundingError ? `: ${operation.lastFoundingError}` : "; inspect the corporation wallet and alliance record before retrying"}.`);
}

module.exports = {
  ALLIANCE_FOUNDING_COST,
  PLAYERBOT_SEED_RESERVE,
  advance,
  getAllianceFoundingPlan,
  start,
};

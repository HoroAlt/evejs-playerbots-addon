"use strict";

// Corporations with bot members can enter a normal, billable EVE war only after
// both actually establish structures in the same null-sec system. A human CEO
// alone is not an intervention; bots actively controlled by a human are
// excluded from the decision. Unfulfilled procurement plans never start wars.

const WAR_DECLARATION_BILL_ISK = 100_000_000;
const WAR_TREASURY_RESERVE_ISK = 100_000_000;
const WAR_MEMBER_WORKING_RESERVE_ISK = 200_000_000;

function positiveID(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function getCorporationID(bot) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  return positiveID(character.corporationID || bot.corporationID);
}

function hasPairWar(wars, leftCorpID, rightCorpID) {
  return wars.listAllWars().some((war) =>
    (Number(war.declaredByID) === leftCorpID && Number(war.againstID) === rightCorpID) ||
    (Number(war.declaredByID) === rightCorpID && Number(war.againstID) === leftCorpID));
}

function hasUnfinishedWar(wars, corporationID) {
  // A record without timeFinished includes the 24-hour declaration spool-up;
  // a future timeFinished is an ending war's cooldown and still blocks a new
  // declaration under the normal war lifecycle.
  const now = BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
  return wars.listWarsForOwner(corporationID).some((war) => {
    if (!war.timeFinished) return true;
    try {
      return BigInt(String(war.timeFinished)) > now;
    } catch (_) {
      return true;
    }
  });
}

function getEligibleStructureConflict(bots, excludedCharacterIDs = new Set(), options = {}) {
  const corporationState = require("../corporation/corporationState");
  const structures = require("../structure/structureState").listStructures()
    .filter((structure) => structure && !structure.destroyedAt && !structure.unanchoring)
    .map((structure) => ({
      structure,
      corporationID: positiveID(structure.ownerCorpID || structure.ownerID),
      systemID: positiveID(structure.solarSystemID),
    }))
    .filter((entry) => entry.corporationID && entry.systemID);
  const botCorporations = new Map();
  for (const bot of bots) {
    if (!bot || !positiveID(bot.characterID)) continue;
    const corporationID = getCorporationID(bot);
    if (!corporationID) continue;
    if (!botCorporations.has(corporationID)) botCorporations.set(corporationID, []);
    botCorporations.get(corporationID).push(bot);
  }
  const bySystem = new Map();
  for (const entry of structures) {
    if (!bySystem.has(entry.systemID)) bySystem.set(entry.systemID, []);
    bySystem.get(entry.systemID).push(entry);
  }
  const worlds = require("../../space/worldData");
  const wars = require("../corporation/warRuntimeState");
  const candidates = [];
  for (const [systemID, entries] of bySystem) {
    const system = worlds.getSolarSystemByID(systemID);
    if (!system || !(Number(system.security) < 0)) continue;
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const left = entries[leftIndex];
        const right = entries[rightIndex];
        if (left.corporationID === right.corporationID) continue;
        const leftBots = botCorporations.get(left.corporationID) || [];
        const rightBots = botCorporations.get(right.corporationID) || [];
        if (!leftBots.length || !rightBots.length) continue;
        if (!leftBots.some((bot) => !excludedCharacterIDs.has(Number(bot.characterID))) ||
            !rightBots.some((bot) => !excludedCharacterIDs.has(Number(bot.characterID)))) continue;
        const leftCorp = corporationState.getCorporationRecord(left.corporationID) || {};
        const rightCorp = corporationState.getCorporationRecord(right.corporationID) || {};
        if (positiveID(leftCorp.allianceID) || positiveID(rightCorp.allianceID)) continue;
        if (leftCorp.isNPC === true || rightCorp.isNPC === true) continue;
        if (hasPairWar(wars, left.corporationID, right.corporationID) ||
            hasUnfinishedWar(wars, left.corporationID) || hasUnfinishedWar(wars, right.corporationID)) continue;
        const leftHasSecurity = leftBots.some((bot) => bot.status !== "paused" &&
          !excludedCharacterIDs.has(Number(bot.characterID)) && bot.specialty === "security" &&
          require("./playerBotOperationRuntime").hasRoleShipFit(bot, "security"));
        const rightHasSecurity = rightBots.some((bot) => bot.status !== "paused" &&
          !excludedCharacterIDs.has(Number(bot.characterID)) && bot.specialty === "security" &&
          require("./playerBotOperationRuntime").hasRoleShipFit(bot, "security"));
        // Specialist corps do not each need to duplicate a combat fleet just
        // to respond to an actual structure rivalry. One prepared security
        // force is enough to make a normal, billable war viable; it will be
        // assigned to the side that can field it. The opposing corporation
        // still needs its own persisted war director and normal treasury.
        if (!leftHasSecurity && !rightHasSecurity && options.allowUnarmed !== true) continue;
        candidates.push({
          systemID,
          left,
          right,
          leftBots,
          rightBots,
          leftHasSecurity,
          rightHasSecurity,
        });
      }
    }
  }
  // When an operator explicitly configures a human-CEO test corporation for
  // its first-war grant, exercise that opt-in against a real rival structure
  // first. Outside that one configured test, preserve deterministic ordering.
  const testCorporationID = positiveID(process.env.EVEJS_PLAYER_BOTS_WAR_TEST_CORPORATION_ID);
  return candidates.sort((a, b) =>
    Number((b.left.corporationID === testCorporationID || b.right.corporationID === testCorporationID)) -
      Number((a.left.corporationID === testCorporationID || a.right.corporationID === testCorporationID)) ||
    a.systemID - b.systemID || a.left.corporationID - b.left.corporationID ||
    a.right.corporationID - b.right.corporationID)[0] || null;
}

function chooseWarDirector(bots, corporationID, excludedCharacterIDs = new Set()) {
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  const characterState = require("../character/characterState");
  const space = require("./playerBotSpaceRuntime");
  const authority = require("../corporation/warAuthority");
  const candidates = bots.filter((bot) => getCorporationID(bot) === corporationID)
    .filter((bot) => !excludedCharacterIDs.has(Number(bot.characterID)))
    .sort((left, right) =>
      Number(right.characterID === Number(corporation.ceoID)) - Number(left.characterID === Number(corporation.ceoID)) ||
      Number(left.characterID) - Number(right.characterID));
  for (const bot of candidates) {
    if (bot.status === "paused" || bot.autonomyPaused === true) continue;
    const session = space.getActorSession(bot);
    const persistedCharacter = characterState.getCharacterRecord(bot.characterID) || {};
    if (Number(persistedCharacter.corporationID || bot.corporationID) !== corporationID) continue;
    if (authority.getWarAuthority(session)) return { bot, session };
  }
  return null;
}

async function ensureWarTreasury(bots, corporationID, targetCorporationID, excludedCharacterIDs = new Set()) {
  const corpWallet = require("../corporation/corpWalletState");
  const getBalance = () => Number(corpWallet.getCorporationWalletBalance(corporationID, 1000)) || 0;
  const targetBalance = WAR_DECLARATION_BILL_ISK + WAR_TREASURY_RESERVE_ISK;
  if (getBalance() >= targetBalance) return true;
  const walletState = require("../account/walletState");
  const AccountService = require("../account/accountService");
  const accountService = new AccountService();
  const candidates = bots.filter((bot) => getCorporationID(bot) === corporationID && bot.status !== "paused" &&
      !excludedCharacterIDs.has(Number(bot.characterID)))
    .map((bot) => ({ bot, balance: Number(walletState.getCharacterWallet(bot.characterID)?.balance) || 0 }))
    .filter((entry) => entry.balance > WAR_MEMBER_WORKING_RESERVE_ISK)
    .sort((left, right) => right.balance - left.balance || Number(left.bot.characterID) - Number(right.bot.characterID));
  for (const candidate of candidates) {
    const deficit = Math.ceil(targetBalance - getBalance());
    if (deficit <= 0) return true;
    const contribution = Math.min(deficit, Math.floor(candidate.balance - WAR_MEMBER_WORKING_RESERVE_ISK));
    if (contribution <= 0) continue;
    const session = require("./playerBotSpaceRuntime").getActorSession(candidate.bot);
    const result = await accountService.Handle_GiveCash(
      [corporationID, contribution],
      session,
      {
        reason: `Playerbot structure-conflict war reserve ${targetCorporationID}`.slice(0, 100),
        toAccountKey: 1000,
        idempotencyKey: `playerbot:structure-war-reserve:${corporationID}:${targetCorporationID}:${candidate.bot.characterID}`,
      },
    );
    const succeeded = Array.isArray(result) || result && result.success === true;
    if (!succeeded) continue;
    if (getBalance() >= targetBalance) return true;
  }
  return getBalance() >= targetBalance;
}

async function declareStructureConflictWar(bots = [], options = {}) {
  let roster = Array.isArray(bots) ? bots : [];
  const excludedCharacterIDs = options.humanControlledBotIDs instanceof Set
    ? options.humanControlledBotIDs
    : new Set();
  let conflict = getEligibleStructureConflict(roster, excludedCharacterIDs, { allowUnarmed: true });
  if (!conflict) return { declared: false, reason: "no-eligible-nullsec-structure-rivalry" };

  // Rival structures in null-sec create the strategic cause for a war. Do not
  // make a fully fitted fleet a precondition: the ordinary war declaration
  // starts the 24-hour spool-up, during which first-war funding, recruitment,
  // and ship fitting can proceed through their normal authorities.
  const directions = [
    {
      attacker: conflict.left,
      defender: conflict.right,
      hasSecurity: conflict.leftHasSecurity,
    },
    {
      attacker: conflict.right,
      defender: conflict.left,
      hasSecurity: conflict.rightHasSecurity,
    },
  ].sort((left, right) => Number(right.hasSecurity) - Number(left.hasSecurity) ||
    left.attacker.corporationID - right.attacker.corporationID);
  let director = null;
  const direction = directions.find((entry) => {
    director = chooseWarDirector(roster, entry.attacker.corporationID, excludedCharacterIDs);
    return Boolean(director);
  });
  if (!direction) return { declared: false, reason: "no-persisted-corporation-war-director" };
  // The declaration raises a normal 100M ISK corporation bill. Keep enough in
  // the corporation wallet to cover that bill and leave a matching reserve.
  try {
    if (!await ensureWarTreasury(roster, direction.attacker.corporationID,
      direction.defender.corporationID, excludedCharacterIDs)) {
      return { declared: false, reason: "war-treasury-below-reserve" };
    }
  } catch (error) {
    return { declared: false, reason: String(error && error.message || error).slice(0, 180) };
  }
  const structureID = positiveID(direction.attacker.structure.structureID || direction.attacker.structure.itemID);
  if (!structureID) return { declared: false, reason: "missing-owned-war-headquarters" };
  try {
    await new (require("../corporation/corpRegistryRuntime"))().Handle_DeclareWarAgainst(
      [direction.defender.corporationID, structureID], director.session,
    );
  } catch (error) {
    return { declared: false, reason: String(error && error.message || error).slice(0, 180) };
  }
  const war = require("../corporation/warRuntimeState").listWarsForOwner(direction.attacker.corporationID)
    .find((entry) => Number(entry.declaredByID) === direction.attacker.corporationID &&
      Number(entry.againstID) === direction.defender.corporationID);
  if (!war) return { declared: false, reason: "war-authority-did-not-confirm-declaration" };
  return {
    declared: true,
    warID: positiveID(war.warID),
    declaringCorporationID: direction.attacker.corporationID,
    opposingCorporationID: direction.defender.corporationID,
    systemID: conflict.systemID,
    characterID: Number(director.bot.characterID),
    recruitedCombatPilots: 0,
  };
}

// ------------------------------------------------------- rivalry wars
// Bot-run corporations also fight each other outside null-sec structure
// disputes: a corporation that owns a structure (its war headquarters) may
// declare a normal, billed war on another bot-run corporation whose pilots
// work in the same systems. The usual 24-hour start timer, war bill and
// Crimewatch rules apply. Few such wars run at once.

const MAX_CONCURRENT_RIVALRY_WARS = 2;
const RIVALRY_ATTEMPT_INTERVAL_MS = 60 * 60 * 1000;
const RIVALRY_DECLARER_SPECIALTIES = new Set(["piracy", "security", "sovereignty"]);
let lastRivalryAttemptAtMs = 0;

function rivalryWarsEnabled() {
  return String(process.env.EVEJS_PLAYER_BOTS_BOT_VERSUS_BOT ?? "1").trim() !== "0";
}

function isBotRunCorporation(corporationID, roster) {
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  if (!corporation.corporationID && !corporation.ceoID) return false;
  if (corporation.isNPC === true) return false;
  const ceoID = Number(corporation.ceoID) || 0;
  return roster.some((bot) => Number(bot.characterID) === ceoID);
}

function unfinishedWars(wars) {
  const now = BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
  return wars.listAllWars().filter((war) => {
    if (!war.timeFinished) return true;
    try { return BigInt(String(war.timeFinished)) > now; } catch (_) { return true; }
  });
}

// Pure choice of declarer and target from roster facts; exported for tests.
function chooseRivalry(corporations, options = {}) {
  const busy = options.corporationsAtWar instanceof Set ? options.corporationsAtWar : new Set();
  const declarers = corporations
    .filter((corporation) => corporation.botRun && corporation.warHeadquartersID && !busy.has(corporation.corporationID))
    .sort((left, right) => Number(right.combatSpecialty) - Number(left.combatSpecialty) ||
      right.members - left.members || left.corporationID - right.corporationID);
  for (const declarer of declarers) {
    const targets = corporations
      .filter((corporation) => corporation.botRun && corporation.corporationID !== declarer.corporationID &&
        !busy.has(corporation.corporationID) &&
        !(declarer.allianceID && corporation.allianceID === declarer.allianceID))
      .map((corporation) => ({
        corporation,
        overlap: [...corporation.systems].filter((systemID) => declarer.systems.has(systemID)).length,
      }))
      .sort((left, right) => right.overlap - left.overlap ||
        right.corporation.members - left.corporation.members ||
        left.corporation.corporationID - right.corporation.corporationID);
    if (targets.length) return { declarer, target: targets[0].corporation };
  }
  return null;
}

async function declareRivalryWar(bots = [], options = {}) {
  if (!rivalryWarsEnabled()) return { declared: false, reason: "bot-versus-bot-disabled" };
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  if (nowMs - lastRivalryAttemptAtMs < RIVALRY_ATTEMPT_INTERVAL_MS) return { declared: false, reason: "waiting" };
  lastRivalryAttemptAtMs = nowMs;
  const roster = Array.isArray(bots) ? bots : [];
  const excludedCharacterIDs = options.humanControlledBotIDs instanceof Set ? options.humanControlledBotIDs : new Set();
  const wars = require("../corporation/warRuntimeState");
  const open = unfinishedWars(wars);
  const botCorporationIDs = new Set(roster.map((bot) => getCorporationID(bot)).filter(Boolean));
  const rivalries = open.filter((war) => botCorporationIDs.has(Number(war.declaredByID)) &&
    botCorporationIDs.has(Number(war.againstID)));
  if (rivalries.length >= MAX_CONCURRENT_RIVALRY_WARS) return { declared: false, reason: "rivalry-war-limit" };
  const corporationsAtWar = new Set(open.flatMap((war) => [Number(war.declaredByID), Number(war.againstID)]));

  const capacity = require("./playerBotCapacityRuntime");
  const structures = require("../structure/structureState").listStructures()
    .filter((structure) => structure && !structure.destroyedAt && !structure.unanchoring);
  const corporationState = require("../corporation/corporationState");
  const byCorporation = new Map();
  for (const bot of roster) {
    const corporationID = getCorporationID(bot);
    if (!corporationID) continue;
    if (!byCorporation.has(corporationID)) {
      const record = corporationState.getCorporationRecord(corporationID) || {};
      const headquarters = structures.find((structure) =>
        positiveID(structure.ownerCorpID || structure.ownerID) === corporationID);
      byCorporation.set(corporationID, {
        corporationID,
        allianceID: positiveID(record.allianceID),
        botRun: isBotRunCorporation(corporationID, roster),
        warHeadquartersID: headquarters ? positiveID(headquarters.structureID || headquarters.itemID) : 0,
        combatSpecialty: false,
        members: 0,
        systems: new Set(),
      });
    }
    const entry = byCorporation.get(corporationID);
    entry.members += 1;
    if (RIVALRY_DECLARER_SPECIALTIES.has(String(bot.specialty))) entry.combatSpecialty = true;
    const systemID = capacity.getBotSystemID(bot);
    if (systemID) entry.systems.add(systemID);
  }
  const choice = chooseRivalry([...byCorporation.values()], { corporationsAtWar });
  if (!choice) return { declared: false, reason: "no-eligible-bot-rivalry" };
  const declarerID = choice.declarer.corporationID;
  const targetID = choice.target.corporationID;
  if (hasPairWar(wars, declarerID, targetID)) return { declared: false, reason: "pair-already-at-war" };
  const director = chooseWarDirector(roster, declarerID, excludedCharacterIDs);
  if (!director) return { declared: false, reason: "no-persisted-corporation-war-director" };
  try {
    if (!await ensureWarTreasury(roster, declarerID, targetID, excludedCharacterIDs)) {
      return { declared: false, reason: "war-treasury-below-reserve" };
    }
    await new (require("../corporation/corpRegistryRuntime"))().Handle_DeclareWarAgainst(
      [targetID, choice.declarer.warHeadquartersID], director.session,
    );
  } catch (error) {
    return { declared: false, reason: String(error && error.message || error).slice(0, 180) };
  }
  const war = wars.listWarsForOwner(declarerID)
    .find((entry) => Number(entry.declaredByID) === declarerID && Number(entry.againstID) === targetID);
  if (!war) return { declared: false, reason: "war-authority-did-not-confirm-declaration" };
  return {
    declared: true,
    warID: positiveID(war.warID),
    declaringCorporationID: declarerID,
    opposingCorporationID: targetID,
    characterID: Number(director.bot.characterID),
  };
}

module.exports = {
  declareRivalryWar,
  declareStructureConflictWar,
  _testing: { getEligibleStructureConflict, hasPairWar, hasUnfinishedWar, chooseRivalry,
    resetRivalryClock: () => { lastRivalryAttemptAtMs = 0; },
    WAR_DECLARATION_BILL_ISK, WAR_TREASURY_RESERVE_ISK, WAR_MEMBER_WORKING_RESERVE_ISK },
};

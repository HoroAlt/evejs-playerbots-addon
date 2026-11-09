"use strict";

// Open recruitment for the specialist bot corporations. A player who applies
// to a corporation run only by playerbots is accepted by its CEO bot, joins
// through the applicant's own acceptance (so the normal departure checks of
// the player's current corporation apply), and receives the CEO seat: the bot
// resigns in the player's favour and the new CEO keeps the bot as a director
// so it can still run the corp budget. Every step uses corpRegistry handlers.

const log = require("../../utils/logger");

const APP_STATUS_ACCEPTED_BY_CHARACTER = 2;
const APP_STATUS_ACCEPTED_BY_CORPORATION = 6;
const CORP_ROLE_DIRECTOR = 1n;

function getPlayerBots() {
  return require("./playerBotRuntime");
}

function isBotOnlyCorporation(corporationID) {
  const bots = getPlayerBots().listBots();
  const botIDs = new Set(bots.map((bot) => Number(bot.characterID)));
  if (!bots.some((bot) => Number(bot.specialtyCorporationID) === Number(corporationID))) return false;
  const runtime = require("../corporation/corporationRuntimeState").getCorporationRuntime(corporationID) || {};
  const memberIDs = Object.keys(runtime.members || {}).map(Number).filter(Boolean);
  return memberIDs.length > 0 && memberIDs.every((memberID) => botIDs.has(memberID));
}

function onApplicationInserted(registry, corporationID, applicantID, applicationID, applicantSession, applicationText = "") {
  const bots = getPlayerBots().listBots();
  if (bots.some((bot) => Number(bot.characterID) === Number(applicantID))) return;
  if (!isBotOnlyCorporation(corporationID)) return;
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  const ceo = bots.find((bot) => Number(bot.characterID) === Number(corporation.ceoID));
  if (!ceo) return;
  // Let the client receive its InsertApplication answer before the offer flips.
  setImmediate(() => {
    try {
      const ceoSession = getPlayerBots().createBotSession(ceo);
      registry.Handle_UpdateApplicationOffer(
        [applicationID, applicantID, corporationID, applicationText, APP_STATUS_ACCEPTED_BY_CORPORATION, "Welcome to the corporation."],
        ceoSession,
      );
      registry.Handle_UpdateApplicationOffer(
        [applicationID, applicantID, corporationID, applicationText, APP_STATUS_ACCEPTED_BY_CHARACTER, ""],
        applicantSession,
      );
      const joined = Number(require("../character/characterState").getCharacterRecord(applicantID)?.corporationID) === Number(corporationID);
      if (!joined) {
        log.warn(`[PlayerBots] Application ${applicationID} accepted by ${corporationID}, but char=${applicantID} did not join.`);
        return;
      }
      handOverCeo(registry, corporationID, ceo, applicantID, applicantSession);
      log.info(`[PlayerBots] Recruited char=${applicantID} into bot corp ${corporationID} as CEO (previous CEO bot ${ceo.characterID}).`);
    } catch (error) {
      log.warn(`[PlayerBots] Auto-recruitment failed corp=${corporationID} char=${applicantID}: ${error && error.message || error}`);
    }
  });
}

function buildHumanSession(characterID) {
  const character = require("../character/characterState").getCharacterRecord(characterID) || {};
  const corporationID = Number(character.corporationID) || 0;
  return {
    userid: Number(character.accountId) || 0,
    characterID: Number(characterID),
    charID: Number(characterID),
    charid: Number(characterID),
    corporationID,
    corpid: corporationID,
    stationID: Number(character.stationID) || null,
    stationid: Number(character.stationID) || null,
    solarsystemid2: Number(character.solarSystemID) || null,
  };
}

// The CEO bot resigns in favour of the human member; the new CEO then makes
// the former CEO bot a director so the corp budget keeps a bot treasurer.
function handOverCeo(registry, corporationID, ceoBot, humanCharacterID, humanSession = null) {
  registry.Handle_ResignFromCEO([Number(humanCharacterID)], getPlayerBots().createBotSession(ceoBot));
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  if (Number(corporation.ceoID) !== Number(humanCharacterID)) {
    throw new Error(`CEO_HANDOVER_NOT_RECORDED:${corporationID}`);
  }
  const session = humanSession && Number(humanSession.characterID || humanSession.charid) === Number(humanCharacterID)
    ? { ...humanSession, corporationID, corpid: corporationID }
    : buildHumanSession(humanCharacterID);
  try {
    registry.Handle_UpdateMember([Number(ceoBot.characterID), null, null, null, String(CORP_ROLE_DIRECTOR)], session);
  } catch (error) {
    log.warn(`[PlayerBots] Former CEO bot ${ceoBot.characterID} could not be made director in ${corporationID}: ${error && error.message || error}`);
  }
}

// Corporations founded by bots whose CEO is still a bot but that already hold
// human directors (recruited before the CEO handover existed): hand the CEO
// seat to the longest-standing human director.
function reconcileHumanCeos() {
  const bots = getPlayerBots().listBots();
  const botIDs = new Set(bots.map((bot) => Number(bot.characterID)));
  const corporationIDs = new Set(bots.map((bot) => Number(bot.specialtyCorporationID)).filter(Boolean));
  const registry = new (require("../corporation/corpRegistryRuntime"))();
  const runtimeState = require("../corporation/corporationRuntimeState");
  let handedOver = 0;
  for (const corporationID of corporationIDs) {
    const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
    const ceo = bots.find((bot) => Number(bot.characterID) === Number(corporation.ceoID));
    if (!ceo) continue;
    const runtime = runtimeState.getCorporationRuntime(corporationID) || {};
    const humanDirectors = Object.values(runtime.members || {})
      .filter((member) => member && !member.deleted && !botIDs.has(Number(member.characterID)))
      .filter((member) => (BigInt(runtimeState.getCorporationMemberRoleMask(corporationID, Number(member.characterID)) || 0) & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR)
      .sort((left, right) => String(left.startDateTime || "").localeCompare(String(right.startDateTime || "")));
    if (!humanDirectors.length) continue;
    try {
      handOverCeo(registry, corporationID, ceo, Number(humanDirectors[0].characterID));
      handedOver += 1;
      log.info(`[PlayerBots] CEO of ${corporationID} handed from bot ${ceo.characterID} to char=${humanDirectors[0].characterID}.`);
    } catch (error) {
      log.warn(`[PlayerBots] CEO handover failed corp=${corporationID}: ${error && error.message || error}`);
    }
  }
  return handedOver;
}

module.exports = {
  reconcileHumanCeos,
  isBotOnlyCorporation,
  onApplicationInserted,
};

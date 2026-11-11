"use strict";

const DEFAULT_MAX_AUTONOMOUS_BOTS_PER_SYSTEM = 30;

function getMaxAutonomousBotsPerSystem() {
  return require("./playerBotConfigurationRuntime").getSettings().maxPerSystem;
}

function getBotSystemID(bot) {
  const characterID = Number(bot && bot.characterID);
  if (!Number.isSafeInteger(characterID) || characterID <= 0) return 0;
  const character = require("../character/characterState").readSharedCharacterRecord(characterID) || {};
  const systemID = Math.trunc(Number(character.solarSystemID || character.solarsystemid));
  return Number.isSafeInteger(systemID) && systemID > 0 ? systemID : 0;
}

function isPlayerBotSession(session) {
  return !session || session._playerBotActor === true || session.sessionType === "playerbot" ||
    session.sessionType === "playerbot-actor" || session.socket?.playerBotSink === true ||
    session.socket?.destroyed === true;
}

// Fleet membership is the explicit signal that a live human is directing a
// bot. Those bots do not consume the autonomous per-system allowance.
function getHumanControlledBotIDs(bots = null) {
  const fleets = require("../fleets/fleetRuntime");
  const sessionRegistry = require("../chat/sessionRegistry");
  const humanFleetIDs = new Set();
  for (const session of sessionRegistry.getSessions()) {
    if (isPlayerBotSession(session)) continue;
    const characterID = Math.trunc(Number(session.characterID || session.charID || session.charid));
    if (!Number.isSafeInteger(characterID) || characterID <= 0) continue;
    const fleet = fleets.getFleetForCharacter(characterID);
    if (fleet && Number(fleet.fleetID) > 0) humanFleetIDs.add(Number(fleet.fleetID));
  }
  if (!humanFleetIDs.size) return new Set();

  const controlled = new Set();
  const roster = Array.isArray(bots)
    ? bots
    : (() => {
      const playerBots = require("./playerBotRuntime");
      return typeof playerBots.getPlanningRoster === "function"
        ? playerBots.getPlanningRoster()
        : playerBots.listBots();
    })();
  for (const bot of roster) {
    const fleet = fleets.getFleetForCharacter(bot.characterID);
    if (fleet && humanFleetIDs.has(Number(fleet.fleetID))) controlled.add(Number(bot.characterID));
  }
  return controlled;
}

module.exports = {
  DEFAULT_MAX_AUTONOMOUS_BOTS_PER_SYSTEM,
  getBotSystemID,
  getHumanControlledBotIDs,
  getMaxAutonomousBotsPerSystem,
  isPlayerBotSession,
};

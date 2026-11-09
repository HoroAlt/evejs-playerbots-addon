"use strict";

function normalizePositiveInteger(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function resolvePlayerBotTransportDestination(characterID, dependencies = {}) {
  const numericCharacterID = normalizePositiveInteger(characterID);
  if (!numericCharacterID) return null;

  const listBots = dependencies.listBots || (() =>
    require("../playerbots/playerBotRuntime").listBots());
  const bot = listBots().find((entry) =>
    Number(entry && entry.characterID) === numericCharacterID);
  if (!bot) return null;

  const getCharacterRecord = dependencies.getCharacterRecord || ((id) =>
    require("../character/characterState").getCharacterRecord(id));
  const character = getCharacterRecord(numericCharacterID) || {};
  let destination = null;
  try {
    const findSession = dependencies.findSessionByCharacterID || ((id) =>
      require("./sessionRegistry").findSessionByCharacterID(id));
    const actorSession = findSession(numericCharacterID);
    if (actorSession && typeof dependencies.buildDestinationFromSession === "function") {
      destination = dependencies.buildDestinationFromSession(actorSession);
    }
  } catch (_) {
    // The persisted character location below still resolves pilots whose
    // session or in-space actor is temporarily unavailable.
  }

  const getWorldData = () => dependencies.worldData || require("../../space/worldData");
  const getStationByID = dependencies.getStationByID || ((id) => getWorldData().getStationByID(id));
  const getStructureByID = dependencies.getStructureByID || ((id) => getWorldData().getStructureByID(id));
  const getSolarSystemByID = dependencies.getSolarSystemByID || ((id) => getWorldData().getSolarSystemByID(id));
  const stationID = normalizePositiveInteger(character.stationID);
  const structureID = normalizePositiveInteger(character.structureID);
  const solarSystemID = normalizePositiveInteger(character.solarSystemID);
  // A live session can identify only the solar system while a pilot is docked
  // in an Upwell structure. Prefer the precise persisted dock location.
  if (stationID && getStationByID(stationID)) {
    destination = { kind: "station", stationID };
  } else if (structureID && getStructureByID(structureID)) {
    destination = { kind: "structure", structureID };
  } else if (!destination && solarSystemID && getSolarSystemByID(solarSystemID)) {
    destination = { kind: "solarSystem", solarSystemID };
  }

  return destination
    ? { ...destination, label: `${bot.characterName || `playerbot ${numericCharacterID}`} (${numericCharacterID})` }
    : null;
}

module.exports = { resolvePlayerBotTransportDestination };

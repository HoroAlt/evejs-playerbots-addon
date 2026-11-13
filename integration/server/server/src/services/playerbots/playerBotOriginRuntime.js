"use strict";

// Where a new playerbot is born. Each bot gets a race, a bloodline of that
// race and one of the race's starting schools; the school whose system holds
// the fewest bots wins, so seeding spreads the roster over the four empires
// instead of one station. The bot's work hub follows its race (see
// playerBotEconomyRuntime.getHubStationIDForBot).

const BLOODLINES_BY_RACE = Object.freeze({
  1: Object.freeze([1, 2, 11]), // Caldari: Deteis, Civire, Achura
  2: Object.freeze([3, 4, 14]), // Minmatar: Sebiestor, Brutor, Vherokior
  4: Object.freeze([5, 6, 13]), // Amarr: Amarr, Ni-Kunni, Khanid
  8: Object.freeze([7, 8, 12]), // Gallente: Gallente, Intaki, Jin-Mei
});

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

// Starting schools with a usable high-security station, from the character
// creation data. Injected in tests.
function listStartingSchools(deps = {}) {
  const creation = deps.creation || require("../character/characterCreationData");
  const worldData = deps.worldData || require("../../space/worldData");
  const economy = deps.economy || require("./playerBotEconomyRuntime");
  const schools = [];
  const seen = new Set();
  for (const school of creation.getCharacterCreationSchools() || []) {
    const raceID = positive(school && school.raceID);
    if (!BLOODLINES_BY_RACE[raceID]) continue;
    for (const rawStationID of school.startingStations || []) {
      const stationID = positive(rawStationID);
      if (!stationID || seen.has(stationID) || economy.isJitaStation(stationID)) continue;
      const station = worldData.getStationByID(stationID);
      const system = station && worldData.getSolarSystemByID(positive(station.solarSystemID));
      if (!station || !system || !(Number(system.security) >= 0.45)) continue;
      seen.add(stationID);
      schools.push({ schoolID: positive(school.schoolID), raceID, stationID, systemID: positive(station.solarSystemID) });
    }
  }
  return schools.sort((left, right) => left.stationID - right.stationID);
}

// botsPerSystem: Map of solarSystemID to the number of roster bots there.
function chooseOrigin(botsPerSystem, options = {}) {
  const random = typeof options.random === "function" ? options.random : Math.random;
  const schools = options.schools || listStartingSchools(options.deps);
  if (!schools.length) return null;
  const counts = botsPerSystem instanceof Map ? botsPerSystem : new Map();
  const fewest = Math.min(...schools.map((school) => counts.get(school.systemID) || 0));
  const emptiest = schools.filter((school) => (counts.get(school.systemID) || 0) === fewest);
  const school = emptiest[Math.floor(random() * emptiest.length) % emptiest.length];
  const bloodlines = BLOODLINES_BY_RACE[school.raceID];
  return {
    ...school,
    bloodlineID: bloodlines[Math.floor(random() * bloodlines.length) % bloodlines.length],
    gender: random() < 0.5 ? 0 : 1,
  };
}

module.exports = { BLOODLINES_BY_RACE, chooseOrigin, listStartingSchools };

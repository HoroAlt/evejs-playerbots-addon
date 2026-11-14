"use strict";

// Wildfire Protocol. Every "Delete all bots" is remembered. Once at least one
// has happened, about one new pilot in a hundred is born into Revenge Inc.,
// a piracy corporation whose pilots patrol the systems human players have
// recently been in or own structures in, and say "burn" in Local when they
// open fire. Targets are still chosen by the normal piracy rules: Crimewatch,
// war status and security space decide who may be attacked.
// EVEJS_PLAYER_BOTS_WILDFIRE=0 turns it off.

const TABLE = "playerBots";
const STATE_PATH = "/_wildfire";
const REVENGE_CORPORATION_NAME = "Revenge Inc.";
const REVENGE_FOUNDING_OPERATION_ID = "playerbots:wildfire:revenge-inc";
const REVENGE_SHARE = 0.01;
const VISIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VISITED_SYSTEMS = 200;
const BURN_INTERVAL_MS = 10 * 60 * 1000;
const lastBurnAtMs = new Map();

function repo() {
  return require("../../gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true });
}

function enabled(env = process.env) {
  return String(env.EVEJS_PLAYER_BOTS_WILDFIRE ?? "1").trim() !== "0";
}

function readState(store = repo()) {
  store.ensureTable(TABLE);
  const result = store.read(TABLE, STATE_PATH);
  const data = result.success && result.data && typeof result.data === "object" ? result.data : {};
  return {
    resets: Math.max(0, Math.trunc(Number(data.resets) || 0)),
    firstActivatedAt: data.firstActivatedAt || null,
    visitedSystems: data.visitedSystems && typeof data.visitedSystems === "object" ? { ...data.visitedSystems } : {},
  };
}

function writeState(state, store = repo()) {
  store.ensureTable(TABLE);
  store.write(TABLE, STATE_PATH, state);
  store.flushTableSync(TABLE);
  return state;
}

// Called by the roster reset. The counter is never shown on the dashboard.
function noteRosterReset(options = {}) {
  const store = options.repo || repo();
  const state = readState(store);
  state.resets += 1;
  if (!state.firstActivatedAt) state.firstActivatedAt = new Date(options.nowMs || Date.now()).toISOString();
  return writeState(state, store);
}

function isActive(options = {}) {
  return enabled(options.env) && readState(options.repo).resets > 0;
}

function shouldJoinRevenge(options = {}) {
  const random = typeof options.random === "function" ? options.random : Math.random;
  return isActive(options) && random() < REVENGE_SHARE;
}

// Remembers where human pilots are. Called from the director's global pass.
function noteHumanPresence(sessions, options = {}) {
  if (!isActive(options)) return 0;
  const isBot = options.isBotSession || ((session) => require("./playerBotCapacityRuntime").isPlayerBotSession(session));
  const nowMs = Number(options.nowMs) || Date.now();
  const store = options.repo || repo();
  const state = readState(store);
  let noted = 0;
  for (const session of sessions || []) {
    if (!session || isBot(session)) continue;
    const systemID = Math.trunc(Number(session.solarsystemid2 || session.solarsystemid ||
      session._space && session._space.systemID) || 0);
    if (systemID <= 0) continue;
    state.visitedSystems[String(systemID)] = nowMs;
    noted += 1;
  }
  const kept = Object.entries(state.visitedSystems)
    .filter(([, atMs]) => nowMs - Number(atMs) < VISIT_RETENTION_MS)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, MAX_VISITED_SYSTEMS);
  state.visitedSystems = Object.fromEntries(kept);
  if (noted) writeState(state, store);
  return noted;
}

// Systems Revenge Inc. hunts in: recently visited by humans, or holding a
// structure owned by a corporation that is not run by a bot.
function listTargetSystems(options = {}) {
  const state = readState(options.repo);
  const systems = new Set(Object.keys(state.visitedSystems).map(Number).filter((id) => id > 0));
  try {
    const bots = options.bots || require("./playerBotRuntime").listBots();
    const botIDs = new Set(bots.map((bot) => Number(bot.characterID)));
    const corporationState = options.corporationState || require("../corporation/corporationState");
    const structures = options.structures || require("../structure/structureState").listStructures();
    for (const structure of structures || []) {
      if (!structure || structure.destroyedAt) continue;
      const corporationID = Math.trunc(Number(structure.ownerCorpID || structure.ownerID) || 0);
      const corporation = corporationState.getCorporationRecord(corporationID);
      if (!corporation || corporation.isNPC === true || botIDs.has(Number(corporation.ceoID))) continue;
      const systemID = Math.trunc(Number(structure.solarSystemID) || 0);
      if (systemID > 0) systems.add(systemID);
    }
  } catch (_) {
    // Visited systems alone still give targets.
  }
  return [...systems].sort((left, right) => left - right);
}

function isRevengePilot(bot) {
  return Boolean(bot && bot.wildfire === true);
}

// Posts "burn" to the pilot's Local channel, at most once every ten minutes.
function sayBurn(session, characterID, options = {}) {
  const id = Number(characterID) || 0;
  const roomName = session && session._playerBotLocalRoom;
  if (!id || !roomName) return false;
  const nowMs = Number(options.nowMs) || Date.now();
  if (nowMs - (lastBurnAtMs.get(id) || 0) < BURN_INTERVAL_MS) return false;
  lastBurnAtMs.set(id, nowMs);
  try {
    const xmpp = options.xmpp || require("../chat/xmppStubServer");
    return typeof xmpp.broadcastPlayerBotLocalMessage === "function"
      ? xmpp.broadcastPlayerBotLocalMessage(roomName, id, "burn") > 0
      : false;
  } catch (_) {
    return false;
  }
}

module.exports = {
  REVENGE_CORPORATION_NAME,
  REVENGE_FOUNDING_OPERATION_ID,
  REVENGE_SHARE,
  enabled,
  isActive,
  isRevengePilot,
  listTargetSystems,
  noteHumanPresence,
  noteRosterReset,
  readState,
  sayBurn,
  shouldJoinRevenge,
};

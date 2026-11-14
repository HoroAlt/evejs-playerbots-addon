"use strict";

// Keeps the persisted universe sites bounded. EveJS seeds about sixteen
// exploration and combat sites in every solar system it loads and keeps them
// in the dungeon runtime table, in memory and on disk, for good. Human players
// load a handful of systems; playerbots travel through hundreds, and the table
// grew past a quarter of a gigabyte in a day, which exhausted the memory of a
// small host. This pass removes the seeded universe_dungeon sites of systems
// that have been unloaded for a while and that no human pilot has flown in
// recently. When such a system loads again EveJS seeds its sites as it does
// for any system it has never seen. Mining belts, incursions, sovereignty
// sites and anything not seeded by the universe reconciler are left alone.
// EVEJS_PLAYER_BOTS_SITE_PRUNE=0 turns it off.

const TABLE = "playerBots";
const STATE_PATH = "/_siteUpkeep";
const PRUNED_ORIGIN = "universe_dungeon";
const PASS_INTERVAL_MS = 60 * 1000;
const UNLOADED_GRACE_MS = 30 * 60 * 1000;
const HUMAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HUMAN_SYSTEMS = 2000;
const MAX_PURGED_PER_PASS = 500;

const lastLoadedAtBySystem = new Map();
let lastPassAtMs = 0;
const stats = { passes: 0, purged: 0, failures: 0, lastError: null };

function enabled(env = process.env) {
  return String(env.EVEJS_PLAYER_BOTS_SITE_PRUNE ?? "1").trim() !== "0";
}

function defaultDeps() {
  return {
    repo: () => require("../../gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true }),
    space: () => require("../../space/runtime"),
    dungeonState: () => require("../dungeon/dungeonRuntimeState"),
    dungeon: () => require("../dungeon/dungeonRuntime"),
    sessions: () => require("../chat/sessionRegistry").getSessions(),
    isBotSession: (session) => require("./playerBotCapacityRuntime").isPlayerBotSession(session),
  };
}

function readState(store) {
  store.ensureTable(TABLE);
  const result = store.read(TABLE, STATE_PATH);
  const data = result.success && result.data && typeof result.data === "object" ? result.data : {};
  return {
    humanSystems: data.humanSystems && typeof data.humanSystems === "object" ? { ...data.humanSystems } : {},
  };
}

function writeState(store, state) {
  store.ensureTable(TABLE);
  store.write(TABLE, STATE_PATH, state);
}

// Remembers the systems human pilots are in. Returns true when the stored
// list changed.
function noteHumanSystems(state, sessions, isBotSession, nowMs) {
  let changed = false;
  for (const session of sessions || []) {
    if (!session || isBotSession(session)) continue;
    const systemID = Math.trunc(Number(session.solarsystemid2 || session.solarsystemid ||
      session._space && session._space.systemID) || 0);
    if (systemID <= 0) continue;
    const key = String(systemID);
    // Refresh at most hourly so a docked pilot does not rewrite the row on
    // every pass.
    if (nowMs - Number(state.humanSystems[key] || 0) > 60 * 60 * 1000) changed = true;
    state.humanSystems[key] = nowMs;
  }
  const kept = Object.entries(state.humanSystems)
    .filter(([, atMs]) => nowMs - Number(atMs) < HUMAN_RETENTION_MS)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, MAX_HUMAN_SYSTEMS);
  if (kept.length !== Object.keys(state.humanSystems).length) changed = true;
  state.humanSystems = Object.fromEntries(kept);
  return changed;
}

// The seeded universe sites that may go: their system is not loaded, has not
// been loaded for the grace period and has had no human pilot recently.
function listPrunableInstanceIDs(entries, options) {
  const { isLoaded, humanSystems, nowMs, limit } = options;
  const ids = [];
  for (const entry of entries || []) {
    if (!entry || entry.siteOrigin !== PRUNED_ORIGIN) continue;
    const systemID = Math.trunc(Number(entry.solarSystemID) || 0);
    if (systemID <= 0 || humanSystems[String(systemID)]) continue;
    if (isLoaded(systemID)) {
      lastLoadedAtBySystem.set(systemID, nowMs);
      continue;
    }
    // A system seen loaded since start-up waits the grace period after it
    // unloaded. One not loaded since start-up has no pilot in it and goes at
    // once, which also clears what accumulated before this release.
    const lastLoadedAtMs = lastLoadedAtBySystem.get(systemID);
    if (lastLoadedAtMs && nowMs - lastLoadedAtMs < UNLOADED_GRACE_MS) continue;
    if (ids.length < limit) ids.push(Number(entry.instanceID));
  }
  return ids;
}

function runSiteUpkeepPass(options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  if (!enabled(options.env)) return { skipped: "disabled" };
  if (options.force !== true && nowMs - lastPassAtMs < PASS_INTERVAL_MS) return { skipped: "interval" };
  lastPassAtMs = nowMs;
  stats.passes += 1;
  const deps = { ...defaultDeps(), ...(options.deps || {}) };
  try {
    const store = deps.repo();
    const state = readState(store);
    if (noteHumanSystems(state, deps.sessions(), deps.isBotSession, nowMs)) writeState(store, state);
    const space = deps.space();
    const ids = listPrunableInstanceIDs(deps.dungeonState().listUniversePersistentLifecycleEntries(), {
      isLoaded: (systemID) => space.isSolarSystemSceneLoaded(systemID),
      humanSystems: state.humanSystems,
      nowMs,
      limit: MAX_PURGED_PER_PASS,
    });
    if (!ids.length) return { purged: 0 };
    const result = deps.dungeon().purgeInstances(ids, { source: "playerbots-site-upkeep" });
    const purged = Number(result && result.removedCount) || 0;
    stats.purged += purged;
    return { purged };
  } catch (error) {
    stats.failures += 1;
    stats.lastError = String(error && error.message || error).slice(0, 180);
    return { purged: 0, error: stats.lastError };
  }
}

function getStats() {
  return { ...stats };
}

module.exports = {
  PRUNED_ORIGIN,
  UNLOADED_GRACE_MS,
  enabled,
  getStats,
  runSiteUpkeepPass,
  _testing: {
    listPrunableInstanceIDs,
    noteHumanSystems,
    reset: () => { lastLoadedAtBySystem.clear(); lastPassAtMs = 0; Object.assign(stats, { passes: 0, purged: 0, failures: 0, lastError: null }); },
  },
};

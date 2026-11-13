"use strict";

const { createTableRepository } = require("../../gameStore/tableRepository");

const TABLE = "playerBots";
const PATH = "/_dashboardSettings";
const MAX_ROSTER = 15_000;
const MAX_ONLINE = 5_000;
const MAX_PER_SYSTEM = 300;
const DEFAULT_PER_SYSTEM = 30;
const DEFAULT_ONLINE = 300;
const ROSTER_SEED_SAFETY_LIMITS = Object.freeze({
  batchSize: 10,
  eventLoopP95Ms: 250,
  processCpuPercent: 95,
  maximumSingleBotMs: 1_000,
});
const repo = createTableRepository("service:playerbots", { strict: true });

function envInteger(name, fallback, minimum, maximum) {
  const value = Math.trunc(Number(process.env[name]));
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function defaults() {
  const rosterTarget = envInteger("EVEJS_PLAYER_BOTS_TARGET", 500, 30, MAX_ROSTER);
  const maxOnline = envInteger("EVEJS_PLAYER_BOTS_MAX_ONLINE", DEFAULT_ONLINE, 1, MAX_ONLINE);
  return {
    rosterTarget,
    rosterCeiling: envInteger("EVEJS_PLAYER_BOTS_ROSTER_CEILING", MAX_ROSTER, 30, MAX_ROSTER),
    maxOnline,
    rosterSeedEnabled: process.env.EVEJS_PLAYER_BOTS_ROSTER_SEED_ENABLED === "1",
    rosterSeedBatchSize: envInteger("EVEJS_PLAYER_BOTS_ROSTER_SEED_BATCH_SIZE", 5, 1, ROSTER_SEED_SAFETY_LIMITS.batchSize),
    rosterSeedIntervalMs: envInteger("EVEJS_PLAYER_BOTS_ROSTER_SEED_INTERVAL_MS", 15_000, 5_000, 5 * 60 * 1000),
    rosterSeedMaxEventLoopP95Ms: envInteger("EVEJS_PLAYER_BOTS_ROSTER_SEED_MAX_EVENT_LOOP_P95_MS", 100, 25, ROSTER_SEED_SAFETY_LIMITS.eventLoopP95Ms),
    rosterSeedMaxProcessCpuPercent: envInteger("EVEJS_PLAYER_BOTS_ROSTER_SEED_MAX_PROCESS_CPU_PERCENT", 85, 25, ROSTER_SEED_SAFETY_LIMITS.processCpuPercent),
    rosterSeedMaximumSingleBotMs: envInteger("EVEJS_PLAYER_BOTS_ROSTER_SEED_MAX_SINGLE_BOT_MS", 1_000, 25, ROSTER_SEED_SAFETY_LIMITS.maximumSingleBotMs),
    connectionWindowMs: envInteger("EVEJS_PLAYER_BOTS_CONNECTION_WINDOW_MS", 8 * 60 * 60 * 1000, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000),
    maxPerSystem: envInteger("EVEJS_PLAYER_BOTS_MAX_PER_SYSTEM", DEFAULT_PER_SYSTEM, 1, MAX_PER_SYSTEM),
    // The active-work ceiling must cover every pilot the connection scheduler
    // is allowed to keep online; director mutations themselves stay batched.
    maxConcurrentWork: envInteger("EVEJS_PLAYER_BOTS_MAX_CONCURRENT_WORK", Math.min(rosterTarget, maxOnline), 1, 5_000),
    maxConcurrentRelocations: envInteger("EVEJS_PLAYER_BOTS_MAX_CONCURRENT_CAPACITY_RELOCATIONS", 100, 1, 1_000),
    maxConcurrentColonySetups: envInteger("EVEJS_PLAYER_BOTS_MAX_CONCURRENT_COLONY_SETUPS", 10, 1, 500),
    directorThinkMinMs: envInteger("EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MIN_MS", 90_000, 15_000, 60 * 60 * 1000),
    directorThinkMaxMs: envInteger("EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MAX_MS", 210_000, 15_000, 60 * 60 * 1000),
    directorInitialSpreadMs: envInteger("EVEJS_PLAYER_BOTS_DIRECTOR_INITIAL_SPREAD_MS", 90_000, 1_000, 60 * 60 * 1000),
    // Longest synchronous slice a director pass may hold before yielding to
    // the event loop; 0 keeps the pass in one slice and only measures it.
    directorSliceBudgetMs: envInteger("EVEJS_PLAYER_BOTS_DIRECTOR_SLICE_BUDGET_MS", 8, 0, 100),
    addonConcurrency: envInteger("EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY", 16, 1, 100),
    addonCycleIntervalMs: envInteger("EVEJS_PLAYER_BOTS_ADDON_INTERVAL_MS", 300_000, 30_000, 24 * 60 * 60 * 1000),
    addonBotDelayMs: envInteger("EVEJS_PLAYER_BOTS_ADDON_BOT_DELAY_MS", 0, 0, 5_000),
    addonRequestTimeoutMs: envInteger("EVEJS_PLAYER_BOTS_ADDON_REQUEST_TIMEOUT_MS", 120_000, 10_000, 10 * 60 * 1000),
    autoworkEnabled: process.env.EVEJS_PLAYER_BOTS_AUTOWORK !== "0",
  };
}

const BOUNDS = Object.freeze({
  rosterTarget: [30, MAX_ROSTER],
  rosterCeiling: [30, MAX_ROSTER],
  maxOnline: [1, MAX_ONLINE],
  rosterSeedBatchSize: [1, ROSTER_SEED_SAFETY_LIMITS.batchSize],
  rosterSeedIntervalMs: [5_000, 5 * 60 * 1000],
  rosterSeedMaxEventLoopP95Ms: [25, ROSTER_SEED_SAFETY_LIMITS.eventLoopP95Ms],
  rosterSeedMaxProcessCpuPercent: [25, ROSTER_SEED_SAFETY_LIMITS.processCpuPercent],
  rosterSeedMaximumSingleBotMs: [25, ROSTER_SEED_SAFETY_LIMITS.maximumSingleBotMs],
  connectionWindowMs: [5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000],
  maxPerSystem: [1, MAX_PER_SYSTEM],
  maxConcurrentWork: [1, 5_000],
  maxConcurrentRelocations: [1, 1_000],
  maxConcurrentColonySetups: [1, 500],
  directorThinkMinMs: [15_000, 60 * 60 * 1000],
  directorThinkMaxMs: [15_000, 60 * 60 * 1000],
  directorInitialSpreadMs: [1_000, 60 * 60 * 1000],
  directorSliceBudgetMs: [0, 100],
  addonConcurrency: [1, 100],
  addonCycleIntervalMs: [30_000, 24 * 60 * 60 * 1000],
  addonBotDelayMs: [0, 5_000],
  addonRequestTimeoutMs: [10_000, 10 * 60 * 1000],
});

function readStored() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, PATH);
  return result.success && result.data && typeof result.data === "object" ? result.data : {};
}

function getSettings() {
  const baseline = defaults();
  const stored = readStored();
  const settings = { ...baseline };
  for (const [key, [minimum, maximum]] of Object.entries(BOUNDS)) {
    const value = Math.trunc(Number(stored[key]));
    if (Number.isSafeInteger(value)) settings[key] = Math.max(minimum, Math.min(maximum, value));
  }
  if (typeof stored.autoworkEnabled === "boolean") settings.autoworkEnabled = stored.autoworkEnabled;
  if (typeof stored.rosterSeedEnabled === "boolean") settings.rosterSeedEnabled = stored.rosterSeedEnabled;
  settings.rosterCeiling = Math.min(MAX_ROSTER, settings.rosterCeiling);
  settings.rosterTarget = Math.min(settings.rosterTarget, settings.rosterCeiling);
  settings.maxOnline = Math.min(MAX_ONLINE, settings.maxOnline);
  settings.directorThinkMaxMs = Math.max(settings.directorThinkMinMs, settings.directorThinkMaxMs);
  settings.maximums = {
    roster: MAX_ROSTER,
    online: MAX_ONLINE,
    perSystem: MAX_PER_SYSTEM,
    corporationMembers: 300,
    rosterSeedBatchSize: ROSTER_SEED_SAFETY_LIMITS.batchSize,
    rosterSeedIntervalMs: 5 * 60 * 1000,
    rosterSeedMaxEventLoopP95Ms: ROSTER_SEED_SAFETY_LIMITS.eventLoopP95Ms,
    rosterSeedMaxProcessCpuPercent: ROSTER_SEED_SAFETY_LIMITS.processCpuPercent,
    rosterSeedMaximumSingleBotMs: ROSTER_SEED_SAFETY_LIMITS.maximumSingleBotMs,
  };
  settings.updatedAt = String(stored.updatedAt || "");
  // What each setting returns to with "Reset to defaults": the code default,
  // or the installation's value in the add-on environment file.
  const reference = { ...baseline };
  reference.rosterTarget = Math.min(reference.rosterTarget, reference.rosterCeiling);
  reference.directorThinkMaxMs = Math.max(reference.directorThinkMinMs, reference.directorThinkMaxMs);
  settings.defaults = reference;
  return settings;
}

function updateSettings(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { success: false, message: "Settings must be sent as a JSON object." };
  }
  const booleanSettings = new Set(["autoworkEnabled", "rosterSeedEnabled"]);
  const unknown = Object.keys(patch).filter((key) => !Object.hasOwn(BOUNDS, key) && !booleanSettings.has(key));
  if (unknown.length) return { success: false, message: `Unknown playerbot settings: ${unknown.join(", ")}.` };
  const next = { ...getSettings() };
  delete next.maximums;
  delete next.updatedAt;
  delete next.defaults;
  for (const [key, value] of Object.entries(patch)) {
    if (booleanSettings.has(key)) {
      if (typeof value !== "boolean") return { success: false, message: `${key} must be true or false.` };
      next[key] = value;
      continue;
    }
    const numeric = Number(value);
    const integer = Math.trunc(numeric);
    const [minimum, maximum] = BOUNDS[key];
    if (!Number.isSafeInteger(integer) || integer !== numeric || integer < minimum || integer > maximum) {
      return { success: false, message: `${key} must be an integer between ${minimum} and ${maximum}.` };
    }
    next[key] = integer;
  }
  if (next.rosterTarget > next.rosterCeiling) return { success: false, message: "Roster target cannot exceed its ceiling." };
  if (next.directorThinkMaxMs < next.directorThinkMinMs) return { success: false, message: "Director maximum think delay must be at least the minimum." };
  next.updatedAt = new Date().toISOString();
  const result = repo.write(TABLE, PATH, next);
  if (!result.success) return { success: false, message: result.errorMsg || "Could not save playerbot settings." };
  const flushed = repo.flushTableSync(TABLE);
  if (!flushed || flushed.success !== true) return { success: false, message: flushed && flushed.errorMsg || "Could not persist playerbot settings." };
  return { success: true, settings: getSettings() };
}

module.exports = { MAX_ONLINE, MAX_PER_SYSTEM, MAX_ROSTER, ROSTER_SEED_SAFETY_LIMITS, getSettings, updateSettings };

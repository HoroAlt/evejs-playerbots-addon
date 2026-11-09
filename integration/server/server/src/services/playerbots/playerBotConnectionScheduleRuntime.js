"use strict";

// The roster may contain ten thousand persistent pilots, while at most four
// thousand may announce online presence at once. Connection groups advance on
// fixed eight-hour UTC windows so a restart does not reset the rotation.
const HARD_MAX_CONNECTED = 5_000;
const DEFAULT_MAX_CONNECTED = 5_000;
const DEFAULT_WINDOW_MS = 8 * 60 * 60 * 1000;
const MIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function readBoundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

function getMaxConnected() {
  return require("./playerBotConfigurationRuntime").getSettings().maxOnline || DEFAULT_MAX_CONNECTED;
}

function getConnectionWindowMs() {
  return readBoundedInteger(
    require("./playerBotConfigurationRuntime").getSettings().connectionWindowMs,
    DEFAULT_WINDOW_MS,
    MIN_WINDOW_MS,
    MAX_WINDOW_MS,
  );
}

function compareBots(left, right) {
  return String(left && left.specialty || "").localeCompare(String(right && right.specialty || "")) ||
    (Number(left && left.corporationID) || 0) - (Number(right && right.corporationID) || 0) ||
    (Number(left && left.characterID) || 0) - (Number(right && right.characterID) || 0);
}

function buildConnectionPlan(bots, options = {}) {
  const suppliedNowMs = Number(options.nowMs);
  const nowMs = Number.isFinite(suppliedNowMs) ? Math.max(0, Math.trunc(suppliedNowMs)) : Date.now();
  const roster = (Array.isArray(bots) ? bots : [])
    .filter((bot) => Number.isSafeInteger(Math.trunc(Number(bot && bot.characterID))) && Number(bot.characterID) > 0)
    .slice()
    .sort(compareBots);
  const maxConnected = Math.min(
    HARD_MAX_CONNECTED,
    readBoundedInteger(options.maxConnected, getMaxConnected(), 1, HARD_MAX_CONNECTED),
  );
  const windowMs = readBoundedInteger(options.windowMs, getConnectionWindowMs(), MIN_WINDOW_MS, MAX_WINDOW_MS);
  const groupCount = roster.length ? Math.ceil(roster.length / maxConnected) : 0;
  const windowNumber = Math.floor(nowMs / windowMs);
  const groupIndex = groupCount ? windowNumber % groupCount : 0;
  const scheduled = [];
  if (groupCount) {
    roster.forEach((bot, index) => {
      if (index % groupCount === groupIndex) scheduled.push(bot);
    });
  }

  const priorityGroups = Array.isArray(options.priorityGroups) ? options.priorityGroups : [];
  const priorityIDs = new Set();
  const priority = [];
  for (const group of priorityGroups) {
    const ids = group instanceof Set ? group : new Set(Array.isArray(group) ? group : []);
    for (const bot of roster) {
      const id = Math.trunc(Number(bot.characterID));
      if (ids.has(id) && !priorityIDs.has(id)) {
        priorityIDs.add(id);
        priority.push(bot);
      }
    }
  }

  const selected = [];
  const selectedIDs = new Set();
  const add = (bot) => {
    const id = Math.trunc(Number(bot.characterID));
    if (selected.length >= maxConnected || selectedIDs.has(id)) return;
    selectedIDs.add(id);
    selected.push(bot);
  };
  let prioritized = priority;
  if (priority.length > maxConnected) {
    const priorityGroupCount = Math.ceil(priority.length / maxConnected);
    const priorityGroupIndex = windowNumber % priorityGroupCount;
    prioritized = priority.slice(
      priorityGroupIndex * maxConnected,
      (priorityGroupIndex + 1) * maxConnected,
    );
  }
  prioritized.forEach(add);
  scheduled.forEach(add);

  const selectedPriorityIDs = new Set(prioritized.map((bot) => Number(bot.characterID)));
  const nextRotationAtMs = (windowNumber + 1) * windowMs;
  return Object.freeze({
    characterIDs: Object.freeze(selected.map((bot) => Number(bot.characterID))),
    scheduledCharacterIDs: Object.freeze(scheduled.map((bot) => Number(bot.characterID))),
    priorityCharacterIDs: Object.freeze(priority.map((bot) => Number(bot.characterID))),
    groupIndex,
    groupCount,
    maxConnected,
    rosterCount: roster.length,
    selectedCount: selected.length,
    scheduledCount: scheduled.length,
    priorityCount: priority.length,
    priorityOverflow: Math.max(0, priority.length - maxConnected),
    windowMs,
    nextRotationAtMs,
    nextRotationAt: new Date(nextRotationAtMs).toISOString(),
    windowEndsInMs: Math.max(0, nextRotationAtMs - nowMs),
    selectedPriorityCharacterIDs: Object.freeze([...selectedPriorityIDs]),
  });
}

function getNextScheduledAtMs(characterID, bots, nowMs = Date.now(), options = {}) {
  const id = Math.trunc(Number(characterID) || 0);
  const roster = (Array.isArray(bots) ? bots : []).filter((bot) => Number(bot && bot.characterID) > 0).slice().sort(compareBots);
  const index = roster.findIndex((bot) => Number(bot.characterID) === id);
  if (index < 0) return null;
  const maxConnected = Math.min(HARD_MAX_CONNECTED, readBoundedInteger(options.maxConnected, getMaxConnected(), 1, HARD_MAX_CONNECTED));
  const groupCount = Math.ceil(roster.length / maxConnected);
  const windowMs = readBoundedInteger(options.windowMs, getConnectionWindowMs(), MIN_WINDOW_MS, MAX_WINDOW_MS);
  const suppliedNow = Number(nowMs);
  const now = Number.isFinite(suppliedNow) ? Math.max(0, Math.trunc(suppliedNow)) : Date.now();
  const currentWindow = Math.floor(now / windowMs);
  if (groupCount <= 1) {
    return options.includeCurrentGroup !== false
      ? now
      : (currentWindow + 1) * windowMs;
  }
  const currentGroup = currentWindow % groupCount;
  const targetGroup = index % groupCount;
  let windowsAway = (targetGroup - currentGroup + groupCount) % groupCount;
  if (windowsAway === 0 && options.includeCurrentGroup === false) windowsAway = groupCount;
  return windowsAway === 0 ? now : (currentWindow + windowsAway) * windowMs;
}

module.exports = {
  DEFAULT_MAX_CONNECTED,
  DEFAULT_WINDOW_MS,
  HARD_MAX_CONNECTED,
  buildConnectionPlan,
  getConnectionWindowMs,
  getMaxConnected,
  getNextScheduledAtMs,
};

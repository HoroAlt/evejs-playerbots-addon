"use strict";

// Cadence for dungeon and incursion upkeep in solar systems no human pilot is
// flying in. Site upkeep is driven by timestamps, so a slower cadence only
// coarsens when a spawn, gate or completion is noticed; every decision still
// goes through the same site authorities. A human entering space in the
// system restores the normal cadence on the next pass or tick.

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60_000;

const lastTickAtByScene = new WeakMap();
const lastEffectsRefreshAtByScene = new WeakMap();
const stats = {
  passes: 0, observedTicks: 0, unobservedTicks: 0, unobservedSkips: 0,
  effectRefreshes: 0, effectRefreshSkips: 0,
};
let processIntervalMs = null;

function configuredIntervalMs(env = process.env) {
  const raw = env.EVEJS_PLAYER_BOTS_UNOBSERVED_SITE_TICK_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_INTERVAL_MS;
  const numeric = Math.trunc(Number(raw));
  if (!Number.isFinite(numeric) || numeric <= MIN_INTERVAL_MS) return 0;
  return Math.min(MAX_INTERVAL_MS, numeric);
}

function isBotSession(session) {
  return require("./playerBotCapacityRuntime").isPlayerBotSession(session);
}

function humanSystemIDs(sessions) {
  const systemIDs = new Set();
  for (const session of sessions || []) {
    if (!session || isBotSession(session) || !session._space) continue;
    const systemID = Math.trunc(Number(session._space.systemID) || 0);
    if (systemID > 0) systemIDs.add(systemID);
  }
  return systemIDs;
}

// true or false when the scene lists its own sessions, null when it does not.
function sceneHasHumanPilot(scene) {
  if (!scene || !(scene.sessions instanceof Map)) return null;
  for (const session of scene.sessions.values()) {
    if (session && !isBotSession(session)) return true;
  }
  return false;
}

function currentIntervalMs() {
  if (processIntervalMs === null) processIntervalMs = configuredIntervalMs();
  return processIntervalMs;
}

// Spread unobserved scenes across the interval so they do not all run on the
// same pass.
function phaseOffsetMs(systemID, intervalMs) {
  return (Math.imul(Math.trunc(Number(systemID) || 0), 2654435761) >>> 0) % intervalMs;
}

function beginSiteTickPass(options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const intervalMs = options.intervalMs === undefined ? currentIntervalMs() : Math.trunc(Number(options.intervalMs) || 0);
  stats.passes += 1;
  if (intervalMs <= MIN_INTERVAL_MS) {
    return { intervalMs: 0, shouldTick() { stats.observedTicks += 1; return true; } };
  }
  let observed = null;
  try {
    observed = humanSystemIDs(options.sessions || require("../chat/sessionRegistry").getSessions());
  } catch (_error) {
    // Without a session list every scene keeps the normal cadence.
    return { intervalMs: 0, shouldTick() { stats.observedTicks += 1; return true; } };
  }
  return {
    intervalMs,
    shouldTick(scene) {
      const systemID = Math.trunc(Number(scene && scene.systemID) || 0);
      const humanPresent = sceneHasHumanPilot(scene);
      if (!scene || systemID <= 0 || humanPresent === true ||
          (humanPresent === null && observed.has(systemID))) {
        if (scene) lastTickAtByScene.set(scene, nowMs);
        stats.observedTicks += 1;
        return true;
      }
      let lastTickAt = lastTickAtByScene.get(scene);
      if (lastTickAt === undefined) {
        lastTickAt = nowMs - phaseOffsetMs(systemID, intervalMs);
        lastTickAtByScene.set(scene, lastTickAt);
      }
      if (nowMs - lastTickAt < intervalMs && nowMs >= lastTickAt) {
        stats.unobservedSkips += 1;
        return false;
      }
      lastTickAtByScene.set(scene, nowMs);
      stats.unobservedTicks += 1;
      return true;
    },
  };
}

// The gameplay tick refreshes incursion system effects ten times a second in
// every loaded system. With no human pilot in space there, once per interval
// is enough for the bot ships present.
function shouldRefreshSystemEffects(scene, options = {}) {
  const intervalMs = options.intervalMs === undefined ? currentIntervalMs() : Math.trunc(Number(options.intervalMs) || 0);
  if (intervalMs <= MIN_INTERVAL_MS || sceneHasHumanPilot(scene) !== false) {
    stats.effectRefreshes += 1;
    return true;
  }
  const nowMs = Number(options.nowMs) || Date.now();
  const lastAt = lastEffectsRefreshAtByScene.get(scene);
  if (lastAt !== undefined && nowMs - lastAt < intervalMs && nowMs >= lastAt) {
    stats.effectRefreshSkips += 1;
    return false;
  }
  lastEffectsRefreshAtByScene.set(scene, nowMs);
  stats.effectRefreshes += 1;
  return true;
}

function getStats() {
  return { intervalMs: currentIntervalMs(), ...stats };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  beginSiteTickPass,
  configuredIntervalMs,
  getStats,
  humanSystemIDs,
  sceneHasHumanPilot,
  shouldRefreshSystemEffects,
};

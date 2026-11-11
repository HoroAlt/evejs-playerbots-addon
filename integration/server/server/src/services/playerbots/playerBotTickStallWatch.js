"use strict";

// Records space ticks that hold the server for a long time and which solar
// systems they spent it in, so a freeze can be attributed without taking a
// CPU profile. The idea of an always-on stall watch with a threshold and a
// short retained history is adapted from tickStallWatch.js in the X-Eve
// Living Universe server tree (AGPL-3.0). See THIRD_PARTY_NOTICES.md.
//
// Cost when nothing stalls: one comparison per runtime tick.

const DEFAULT_THRESHOLD_MS = 1_000;
const MAX_REPORTS = 20;
const MAX_SCENES_PER_REPORT = 5;
const WARN_INTERVAL_MS = 60_000;

function thresholdFromEnvironment(env = process.env) {
  if (String(env.EVEJS_PLAYER_BOTS_TICK_STALL_WATCH || "").trim() === "0") return 0;
  const numeric = Math.trunc(Number(env.EVEJS_PLAYER_BOTS_TICK_STALL_MS));
  return Number.isFinite(numeric) && numeric >= 100 ? numeric : DEFAULT_THRESHOLD_MS;
}

function createTickStallWatch(options = {}) {
  const thresholdMs = options.thresholdMs === undefined ? thresholdFromEnvironment() : Math.max(0, Number(options.thresholdMs) || 0);
  const isBotSession = options.isBotSession ||
    ((session) => require("./playerBotCapacityRuntime").isPlayerBotSession(session));
  const logger = options.logger === undefined ? null : options.logger;
  const now = options.now || (() => Date.now());
  const reports = [];
  const totals = { ticks: 0, stalls: 0, stallMs: 0, longestMs: 0, longestLateMs: 0 };
  let lastWarnAtMs = 0;
  let scheduler = null;

  function sceneRow(scene) {
    let bots = 0;
    let humans = 0;
    if (scene && scene.sessions instanceof Map) {
      for (const session of scene.sessions.values()) {
        if (!session) continue;
        if (isBotSession(session)) bots += 1;
        else humans += 1;
      }
    }
    return {
      solarSystemID: Math.trunc(Number(scene && scene.systemID) || 0),
      workMs: Math.round((Number(scene && scene._lastTickWorkMs) || 0) * 10) / 10,
      entities: Number(scene && scene.dynamicEntities && scene.dynamicEntities.size) || 0,
      botSessions: bots,
      humanSessions: humans,
    };
  }

  function recordRuntimeTick(summary, scenes) {
    totals.ticks += 1;
    const durationMs = Number(summary && summary.tickDurationMs) || 0;
    const lateMs = Number(summary && summary.latenessMs) || 0;
    if (lateMs > totals.longestLateMs) totals.longestLateMs = lateMs;
    if (thresholdMs <= 0 || durationMs < thresholdMs) return null;
    totals.stalls += 1;
    totals.stallMs += durationMs;
    if (durationMs > totals.longestMs) totals.longestMs = durationMs;
    const rows = [];
    let sceneWorkMs = 0;
    for (const scene of scenes || []) {
      const work = Number(scene && scene._lastTickWorkMs) || 0;
      // A scene that slept this tick still carries its previous figure.
      if (work <= 0 || Number(scene._lastTickAtWallclockMs) !== Number(summary.wallclockNowMs)) continue;
      sceneWorkMs += work;
      rows.push(scene);
    }
    rows.sort((left, right) => Number(right._lastTickWorkMs) - Number(left._lastTickWorkMs));
    const atMs = now();
    const report = {
      at: new Date(atMs).toISOString(),
      durationMs: Math.round(durationMs * 10) / 10,
      startedLateMs: Math.round(lateMs * 10) / 10,
      scenesTicked: Number(summary.tickedSceneCount) || 0,
      sceneWorkMs: Math.round(sceneWorkMs * 10) / 10,
      // Structure upkeep, hazard recovery and scene collection run outside
      // any one scene's tick.
      outsideScenesMs: Math.round(Math.max(0, durationMs - sceneWorkMs) * 10) / 10,
      slowestScenes: rows.slice(0, MAX_SCENES_PER_REPORT).map(sceneRow),
    };
    reports.push(report);
    if (reports.length > MAX_REPORTS) reports.shift();
    if (logger && atMs - lastWarnAtMs >= WARN_INTERVAL_MS) {
      lastWarnAtMs = atMs;
      const top = report.slowestScenes[0];
      logger.warn(`[PlayerBots] Space tick held the server for ${report.durationMs} ms across ${report.scenesTicked} systems` +
        (top ? `; slowest system ${top.solarSystemID} took ${top.workMs} ms (${top.entities} entities, ${top.botSessions} bots, ${top.humanSessions} humans)` : "") +
        `; ${totals.stalls} such ticks since start.`);
    }
    return report;
  }

  return {
    thresholdMs,
    recordRuntimeTick,
    attachScheduler(value) { scheduler = value || null; },
    getSnapshot() {
      return {
        thresholdMs,
        enabled: thresholdMs > 0,
        ...totals,
        stallMs: Math.round(totals.stallMs),
        longestMs: Math.round(totals.longestMs * 10) / 10,
        longestLateMs: Math.round(totals.longestLateMs * 10) / 10,
        scheduler: scheduler && typeof scheduler.getStats === "function" ? scheduler.getStats() : null,
        recent: reports.slice().reverse(),
      };
    },
  };
}

let shared = null;
function getTickStallWatch() {
  if (!shared) shared = createTickStallWatch({ logger: require("../../utils/logger") });
  return shared;
}

module.exports = { DEFAULT_THRESHOLD_MS, createTickStallWatch, getTickStallWatch, thresholdFromEnvironment };

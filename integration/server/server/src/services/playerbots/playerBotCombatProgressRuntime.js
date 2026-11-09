"use strict";

// Keep anomaly difficulty progression separate from the character's seeded
// wallet. A clear is earned only when Dungeon authority marks that exact site
// instance completed; every bot begins at tier 1 and advances one tier at a
// time after a verified clear.

const { createTableRepository } = require("../../gameStore/tableRepository");

const TABLE = "playerBots";
const PROGRESS_PATH = "/_combatProgress";
const MAX_RECORDED_SITES = 256;
const repo = createTableRepository("service:playerbots", { strict: true });

function readProgressMap() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, PROGRESS_PATH);
  return result.success && result.data && typeof result.data === "object" ? result.data : {};
}

function getProgress(characterID) {
  const id = Math.trunc(Number(characterID) || 0);
  return id > 0 ? readProgressMap()[String(id)] || { highestClearedTier: 0, clearedSites: [] } :
    { highestClearedTier: 0, clearedSites: [] };
}

function getNextSiteDifficulty(characterID, maxSiteDifficulty) {
  const maximum = Math.max(1, Math.trunc(Number(maxSiteDifficulty) || 1));
  const progress = getProgress(characterID);
  return Math.max(1, Math.min(maximum, Math.trunc(Number(progress.highestClearedTier) || 0) + 1));
}

function recordSiteClear(characterID, siteInstanceID, difficulty) {
  const id = Math.trunc(Number(characterID) || 0);
  const instanceID = Math.trunc(Number(siteInstanceID) || 0);
  const tier = Math.max(1, Math.trunc(Number(difficulty) || 1));
  if (!id || !instanceID) return { success: false, reason: "invalid-site-clear" };

  const progressMap = readProgressMap();
  const previous = progressMap[String(id)] || { highestClearedTier: 0, clearedSites: [] };
  const clearedSites = Array.isArray(previous.clearedSites) ? previous.clearedSites : [];
  if (clearedSites.some((entry) => Number(entry && entry.siteInstanceID) === instanceID)) {
    return { success: true, duplicate: true, progress: previous };
  }
  const next = {
    highestClearedTier: Math.max(Math.trunc(Number(previous.highestClearedTier) || 0), tier),
    completedSiteCount: Math.max(0, Math.trunc(Number(previous.completedSiteCount) || 0)) + 1,
    clearedSites: [...clearedSites, {
      siteInstanceID: instanceID,
      difficulty: tier,
      completedAt: new Date().toISOString(),
    }].slice(-MAX_RECORDED_SITES),
  };
  progressMap[String(id)] = next;
  const written = repo.write(TABLE, PROGRESS_PATH, progressMap);
  if (!written.success) throw new Error(written.errorMsg || "PLAYERBOT_COMBAT_PROGRESS_WRITE_FAILED");
  const flushed = repo.flushTableSync(TABLE);
  if (!flushed || flushed.success !== true) {
    throw new Error(flushed && flushed.errorMsg || "PLAYERBOT_COMBAT_PROGRESS_FLUSH_FAILED");
  }
  return { success: true, duplicate: false, progress: next };
}

module.exports = { getProgress, getNextSiteDifficulty, recordSiteClear };

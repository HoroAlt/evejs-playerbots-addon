"use strict";

const API_URL = String(process.env.EVEJS_PLAYER_BOTS_ADDON_URL || "http://127.0.0.1:26004").replace(/\/+$/, "");
const TOKEN = String(process.env.EVEJS_PLAYER_BOTS_ADDON_TOKEN || "").trim();
const dashboardServer = require("./dashboard-server").createDashboardServer({
  // Reuse the dashboard-controlled EveJS request timeout, capped so a slow
  // read cannot leave the operator waiting for minutes.
  getProxyTimeoutMs: () => Math.min(30_000, REQUEST_TIMEOUT_MS),
});
let CYCLE_INTERVAL_MS = positiveInteger(process.env.EVEJS_PLAYER_BOTS_ADDON_INTERVAL_MS, 5 * 60 * 1000);
let BOT_DELAY_MS = boundedInteger(process.env.EVEJS_PLAYER_BOTS_ADDON_BOT_DELAY_MS, 0, 0, 5_000);
let BOT_CONCURRENCY = boundedInteger(process.env.EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY, 16, 1, 100);
let REQUEST_TIMEOUT_MS = positiveInteger(process.env.EVEJS_PLAYER_BOTS_ADDON_REQUEST_TIMEOUT_MS, 120_000);
let ROSTER_SEED_ENABLED = false;
let ROSTER_TARGET = 500;
let ROSTER_SEED_BATCH_SIZE = 5;
let ROSTER_SEED_INTERVAL_MS = 15_000;
const log = (level, message) => process.stdout.write(`[playerbots-addon] ${new Date().toISOString()} ${level} ${message}\n`);
let stopping = false;
const shutdownController = new AbortController();
const shutdownWaiters = new Set();

function positiveInteger(value, fallback) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

function wait(ms) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      if (timer) clearTimeout(timer);
      shutdownWaiters.delete(finish);
      resolve();
    };
    if (stopping) return resolve();
    shutdownWaiters.add(finish);
    timer = setTimeout(finish, Math.max(1, ms));
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), shutdownController.signal]),
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(String(payload.error || `HTTP_${response.status}`));
    error.statusCode = response.status;
    error.retryAfterMs = Math.max(0, Number(payload.retryAfterMs) || 0);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function syncRuntimeSettings() {
  const payload = await request("/v1/dashboard/settings");
  const settings = payload.settings || {};
  CYCLE_INTERVAL_MS = boundedInteger(settings.addonCycleIntervalMs, CYCLE_INTERVAL_MS, 30_000, 24 * 60 * 60 * 1000);
  BOT_DELAY_MS = boundedInteger(settings.addonBotDelayMs, BOT_DELAY_MS, 0, 5_000);
  BOT_CONCURRENCY = boundedInteger(settings.addonConcurrency, BOT_CONCURRENCY, 1, 100);
  REQUEST_TIMEOUT_MS = boundedInteger(settings.addonRequestTimeoutMs, REQUEST_TIMEOUT_MS, 10_000, 10 * 60 * 1000);
  ROSTER_SEED_ENABLED = settings.rosterSeedEnabled === true;
  ROSTER_TARGET = boundedInteger(settings.rosterTarget, ROSTER_TARGET, 30, 15_000);
  ROSTER_SEED_BATCH_SIZE = boundedInteger(settings.rosterSeedBatchSize, ROSTER_SEED_BATCH_SIZE, 1, 25);
  ROSTER_SEED_INTERVAL_MS = boundedInteger(settings.rosterSeedIntervalMs, ROSTER_SEED_INTERVAL_MS, 5_000, 5 * 60 * 1000);
  return settings;
}

async function postWithRetry(path, body, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts && !stopping; attempt += 1) {
    try {
      return await request(path, { method: "POST", body });
    } catch (error) {
      lastError = error;
      if (error.statusCode === 429) throw error;
      if (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409) throw error;
      if (attempt + 1 < attempts) await wait(Math.min(10_000, 500 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("addon process is stopping");
}

async function runCycle() {
  // Settings are advisory for the driver. If the API is temporarily throttling
  // or unavailable, keep the last known values and still ask whether a cycle
  // is due; otherwise a settings read could prevent work indefinitely.
  try {
    await syncRuntimeSettings();
  } catch (error) {
    log("WARN", `could not refresh runtime settings (${error.message}); keeping current values`);
  }
  let cycle;
  try {
    cycle = await postWithRetry("/v1/cycles", undefined);
  } catch (error) {
    if (error.retryAfterMs > 0) {
      log("INFO", `next cycle is not due; retrying in ${Math.ceil(error.retryAfterMs / 1000)}s`);
      await wait(error.retryAfterMs);
      return false;
    }
    throw error;
  }
  if (!cycle.cycleID || !Array.isArray(cycle.characterIDs) || cycle.characterIDs.length === 0) {
    log("INFO", "no playerbots are available; checking again in 60s");
    await wait(60_000);
    return false;
  }

  const completed = new Set((cycle.completedCharacterIDs || []).map(Number));
  const configuredConcurrency = BOT_CONCURRENCY;
  let effectiveCycleConcurrency = boundedInteger(cycle.effectiveConcurrency, configuredConcurrency, 1, configuredConcurrency);
  const failed = new Map();
  let processed = completed.size;
  const pending = cycle.characterIDs.filter((characterID) => !completed.has(Number(characterID)));
  let nextIndex = 0;
  log("INFO", `cycle ${cycle.cycleID} started with ${cycle.characterIDs.length} bots; ${completed.size} already complete; effective concurrency=${effectiveCycleConcurrency} (configured maximum ${configuredConcurrency})`);
  const processCharacter = async (characterID) => {
    const numericID = Number(characterID);
    try {
      const step = await postWithRetry(`/v1/cycles/${encodeURIComponent(cycle.cycleID)}/steps/${numericID}`, {});
      const reportedConcurrency = boundedInteger(step.effectiveConcurrency, effectiveCycleConcurrency, 1, configuredConcurrency);
      if (reportedConcurrency !== effectiveCycleConcurrency) {
        log(reportedConcurrency < effectiveCycleConcurrency ? "WARN" : "INFO", `server load guard changed effective step concurrency ${effectiveCycleConcurrency} -> ${reportedConcurrency}; event-loop p95=${Number(step.eventLoopP95Ms) || 0}ms cpu=${Number(step.processCpuPercent) || 0}%`);
        effectiveCycleConcurrency = reportedConcurrency;
      }
    } catch (error) {
      if (!stopping) {
        failed.set(numericID, String(error.message || "add-on step failed").slice(0, 240));
        log("WARN", `cycle step failed for character ${numericID}: ${error.message}`);
      }
    }
    processed += 1;
    if (processed % 25 === 0 || processed === cycle.characterIDs.length) {
      log("INFO", `cycle ${cycle.cycleID} progress ${processed}/${cycle.characterIDs.length}; failures=${failed.size}`);
    }
    if (BOT_DELAY_MS) await wait(BOT_DELAY_MS);
  };
  // Finish one fleet-wide preparation step before parallel per-pilot work:
  // provisioning, shared corp ledgers, PI-policy reconciliation and director
  // assignment are deliberately done once against the complete roster.
  if (pending.length && !stopping) await processCharacter(pending.shift());
  let activeRequests = 0;
  const worker = async () => {
    while (!stopping) {
      if (nextIndex >= pending.length) return;
      if (activeRequests >= effectiveCycleConcurrency) {
        await wait(50);
        continue;
      }
      const index = nextIndex++;
      if (index >= pending.length) return;
      activeRequests += 1;
      try {
        await processCharacter(pending[index]);
      } finally {
        activeRequests -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(configuredConcurrency, pending.length) }, () => worker()));
  if (stopping) return false;

  const result = await postWithRetry(`/v1/cycles/${encodeURIComponent(cycle.cycleID)}/finish`, {
    failedCharacterIDs: [...failed.keys()],
    failedSteps: [...failed].map(([characterID, message]) => ({ characterID, message })),
  });
  log("INFO", `cycle ${result.cycleID} finished; completed=${result.completedBots} failed=${result.failedBots} elapsedMs=${result.elapsedMs}`);
  await wait(CYCLE_INTERVAL_MS);
  return true;
}

async function runRosterSeedWorker() {
  let failureCount = 0;
  while (!stopping) {
    try {
      await syncRuntimeSettings();
      if (!ROSTER_SEED_ENABLED) {
        await wait(10_000);
        continue;
      }
      let result;
      try {
        result = await request("/v1/roster/seed-step", { method: "POST" });
      } catch (error) {
        if (error.statusCode === 409 && error.message === "PLAYERBOT_ROSTER_SEED_PAUSED") {
          await wait(10_000);
          continue;
        }
        if (error.statusCode === 409 && error.message === "PLAYERBOT_ROSTER_SEED_STEP_IN_PROGRESS") {
          await wait(Math.max(1_000, error.retryAfterMs || 1_000));
          continue;
        }
        if (error.statusCode === 429) {
          log("WARN", `roster seeding backed off for ${Math.ceil((error.retryAfterMs || 60_000) / 1000)}s (${error.message})`);
          await wait(Math.max(5_000, error.retryAfterMs || 60_000));
          continue;
        }
        throw error;
      }
      failureCount = 0;
      const created = Number(result.created) || 0;
      const rosterCount = Number(result.rosterCount) || 0;
      const target = Number(result.target) || ROSTER_TARGET;
      if (created || result.complete || result.backpressure || result.success === false) {
        log(result.backpressure || result.success === false ? "WARN" : "INFO", `roster seed batch created=${created} progress=${rosterCount}/${target} duration=${Number(result.batchDurationMs) || 0}ms loopP95=${Number(result.eventLoopP95Ms) || 0}ms cpu=${Number(result.processCpuPercent) || 0}%${result.stopReason ? ` reason=${String(result.stopReason).slice(0, 160)}` : ""}`);
      }
      await wait(result.complete ? Math.max(60_000, ROSTER_SEED_INTERVAL_MS) :
        result.backpressure ? Math.max(ROSTER_SEED_INTERVAL_MS, Number(result.retryAfterMs) || 60_000) : ROSTER_SEED_INTERVAL_MS);
    } catch (error) {
      if (stopping) break;
      failureCount += 1;
      const backoff = Math.min(60_000, 1_000 * (2 ** Math.min(failureCount, 6)));
      log("WARN", `roster seeding check failed (${error.message}); retrying in ${Math.ceil(backoff / 1000)}s`);
      await wait(backoff);
    }
  }
}

async function main() {
  if (TOKEN.length < 32) {
    log("ERROR", "configure EVEJS_PLAYER_BOTS_ADDON_TOKEN with at least 32 random characters in the EveJS .env file");
    while (!stopping) await wait(60_000);
    return;
  }
  try {
    const dashboard = await dashboardServer.start();
    log("INFO", `dashboard listening on container port ${dashboard.port}; host publication is controlled by Compose`);
  } catch (error) {
    log("WARN", `dashboard did not start (${String(error && error.message || error).slice(0, 180)}); bot cycles remain available`);
  }
  try {
    await syncRuntimeSettings();
  } catch (error) {
    log("WARN", `could not load saved runtime settings (${String(error && error.message || error).slice(0, 180)}); using environment defaults`);
  }
  log("INFO", `started as a separate process; API=${API_URL}; concurrency=${BOT_CONCURRENCY}; per-bot delay=${BOT_DELAY_MS}ms; cycle interval=${CYCLE_INTERVAL_MS}ms`);
  void runRosterSeedWorker();
  let failureCount = 0;
  while (!stopping) {
    try {
      const completed = await runCycle();
      if (completed) failureCount = 0;
    } catch (error) {
      if (stopping) break;
      failureCount += 1;
      const backoff = Math.min(60_000, 1_000 * (2 ** Math.min(failureCount, 6)));
      log("WARN", `cycle driver request failed (${error.message}); retrying in ${Math.ceil(backoff / 1000)}s`);
      await wait(backoff);
    }
  }
  log("INFO", "stopped");
}

async function requestStop() {
  if (stopping) return;
  stopping = true;
  shutdownController.abort();
  for (const wake of [...shutdownWaiters]) wake();
  await dashboardServer.shutdown();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void requestStop(); });
}

main().catch((error) => {
  log("ERROR", error && error.stack || String(error));
  process.exitCode = 1;
});

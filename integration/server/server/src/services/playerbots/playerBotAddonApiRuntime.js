"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

const MAX_BODY_BYTES = 16 * 1024;
const CYCLE_TTL_MS = 30 * 60 * 1000;
const ROSTER_SEED_RETRY_MS = 15_000;
const LOAD_SAMPLE_INTERVAL_MS = 5_000;
const REQUIRED_LOAD_SAMPLES_BEFORE_SEED = 2;

function sendJson(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": payload.length,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function createPlayerBotAddonApiRuntime(options = {}) {
  const host = String(options.host || process.env.EVEJS_PLAYER_BOTS_ADDON_API_HOST || "127.0.0.1").trim();
  const portValue = Number(options.port ?? process.env.EVEJS_PLAYER_BOTS_ADDON_API_PORT ?? 26004);
  const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65_535
    ? portValue
    : 26_004;
  const token = String(options.token ?? process.env.EVEJS_PLAYER_BOTS_ADDON_TOKEN ?? "").trim();
  const playerBots = options.playerBots || require("./playerBotRuntime");
  const autonomy = options.autonomy || require("./playerBotAutonomyRuntime");
  const dashboard = options.dashboard || require("./playerBotDashboardRuntime").createPlayerBotDashboardRuntime({
    playerBots,
    autonomy,
  });
  const configuration = options.configuration || require("./playerBotConfigurationRuntime");
  const director = options.director || require("./playerBotDirectorRuntime");
  const getConnectedCharacterIDs = options.getConnectedCharacterIDs || (() =>
    require("./playerBotSpaceRuntime").getConnectedBotCharacterIDs());
  const logger = options.logger || require("../../utils/logger");
  const telemetry = options.telemetry || require("./playerBotPerformanceTelemetry").getTelemetry();
  const eventLoopDelay = options.eventLoopDelayMonitor || monitorEventLoopDelay({ resolution: 20 });
  const getEventLoopDelayP95Ms = options.getEventLoopDelayP95Ms || (() => Number(eventLoopDelay.percentile(95)) / 1_000_000 || 0);
  eventLoopDelay.enable();
  let cpuSampleUsage = process.cpuUsage();
  let cpuSampleAtMs = performance.now();
  let processCpuPercent = 0;
  let highCpuSamples = 0;
  let sampledEventLoopP95Ms = 0;
  let loadSampleCount = 0;
  const isLoadTelemetryReady = options.isLoadTelemetryReady || (() => loadSampleCount >= REQUIRED_LOAD_SAMPLES_BEFORE_SEED);
  const seedSafetyLimits = configuration.ROSTER_SEED_SAFETY_LIMITS || {
    batchSize: 10,
    eventLoopP95Ms: 250,
    processCpuPercent: 95,
    maximumSingleBotMs: 1_000,
  };
  function effectiveSeedLimits(settings = configuration.getSettings()) {
    return {
      configuredBatchSize: Math.max(1, Math.trunc(Number(settings.rosterSeedBatchSize) || 5)),
      batchSize: Math.min(seedSafetyLimits.batchSize, Math.max(1, Math.trunc(Number(settings.rosterSeedBatchSize) || 5))),
      configuredEventLoopP95Ms: Math.max(25, Number(settings.rosterSeedMaxEventLoopP95Ms) || 100),
      eventLoopP95Ms: Math.min(seedSafetyLimits.eventLoopP95Ms, Math.max(25, Number(settings.rosterSeedMaxEventLoopP95Ms) || 100)),
      configuredProcessCpuPercent: Math.max(25, Number(settings.rosterSeedMaxProcessCpuPercent) || 85),
      processCpuPercent: Math.min(seedSafetyLimits.processCpuPercent, Math.max(25, Number(settings.rosterSeedMaxProcessCpuPercent) || 85)),
      configuredMaximumSingleBotMs: Math.max(25, Number(settings.rosterSeedMaximumSingleBotMs) || 1_000),
      maximumSingleBotMs: Math.min(seedSafetyLimits.maximumSingleBotMs, Math.max(25, Number(settings.rosterSeedMaximumSingleBotMs) || 1_000)),
    };
  }
  const loadSampleTimer = setInterval(() => {
    const now = performance.now();
    const elapsedMs = Math.max(1, now - cpuSampleAtMs);
    const delta = process.cpuUsage(cpuSampleUsage);
    cpuSampleUsage = process.cpuUsage();
    cpuSampleAtMs = now;
    processCpuPercent = Math.max(0, ((delta.user + delta.system) / 1_000) / elapsedMs * 100);
    const cpuLimit = effectiveSeedLimits().processCpuPercent;
    highCpuSamples = processCpuPercent > cpuLimit ? highCpuSamples + 1 : 0;
    sampledEventLoopP95Ms = Math.max(0, Number(getEventLoopDelayP95Ms()) || 0);
    loadSampleCount += 1;
    if (typeof eventLoopDelay.reset === "function") eventLoopDelay.reset();
  }, LOAD_SAMPLE_INTERVAL_MS);
  loadSampleTimer.unref();
  let server = null;
  let cycle = null;
  let rosterSeedRunning = false;
  let lastRosterSeedBatch = null;

  function tokenMatches(request) {
    const header = String(request.headers.authorization || "");
    const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const left = Buffer.from(token);
    const right = Buffer.from(supplied);
    return supplied.length === token.length && crypto.timingSafeEqual(left, right);
  }

  function cyclePayload() {
    const effectiveConcurrency = recommendedCycleConcurrency(cycle.settings);
    cycle.effectiveConcurrency = effectiveConcurrency;
    return {
      cycleID: cycle.cycleID,
      characterIDs: [...cycle.characterIDs],
      connectedCount: cycle.characterIDs.length,
      rosterCount: cycle.rosterCount,
      effectiveConcurrency,
      eventLoopP95Ms: Math.round(currentEventLoopP95Ms() * 10) / 10,
      processCpuPercent: Math.round(processCpuPercent * 10) / 10,
      completedCharacterIDs: [...cycle.results.keys()],
      startedAtMs: cycle.startedAtMs,
    };
  }

  function expireCycle(nowMs = Date.now()) {
    if (cycle && cycle.running.size === 0 && nowMs - cycle.lastActivityAtMs >= CYCLE_TTL_MS) cycle = null;
  }

  function rosterSeedStatus() {
    const settings = configuration.getSettings();
    const limits = effectiveSeedLimits(settings);
    return {
      enabled: settings.rosterSeedEnabled === true,
      running: rosterSeedRunning,
      loadTelemetryReady: Boolean(isLoadTelemetryReady()),
      target: Number(settings.rosterTarget) || 0,
      configuredBatchSize: limits.configuredBatchSize,
      batchSize: limits.batchSize,
      intervalMs: Number(settings.rosterSeedIntervalMs) || 0,
      eventLoopP95Ms: Math.round(currentEventLoopP95Ms() * 10) / 10,
      configuredEventLoopSafetyLimitMs: limits.configuredEventLoopP95Ms,
      eventLoopSafetyLimitMs: limits.eventLoopP95Ms,
      processCpuPercent: Math.round(processCpuPercent * 10) / 10,
      configuredProcessCpuSafetyLimitPercent: limits.configuredProcessCpuPercent,
      processCpuSafetyLimitPercent: limits.processCpuPercent,
      maximumSingleBotMs: limits.maximumSingleBotMs,
      configuredStepConcurrency: Math.max(1, Math.min(100, Math.trunc(Number(settings.addonConcurrency) || 100))),
      effectiveStepConcurrency: cycle
        ? recommendedCycleConcurrency(cycle.settings)
        : recommendedCycleConcurrency(settings),
      lastBatch: lastRosterSeedBatch,
    };
  }

  function currentEventLoopP95Ms() {
    return Math.max(sampledEventLoopP95Ms, Math.max(0, Number(getEventLoopDelayP95Ms()) || 0));
  }

  function recommendedCycleConcurrency(settings = configuration.getSettings()) {
    const configured = Math.max(1, Math.min(100, Math.trunc(Number(settings.addonConcurrency) || 100)));
    const loopP95Ms = currentEventLoopP95Ms();
    if (loopP95Ms > 250 || processCpuPercent > 95) return 1;
    if (loopP95Ms > 100 || processCpuPercent > 85) return Math.min(2, configured);
    if (loopP95Ms > 50 || processCpuPercent > 70) return Math.min(4, configured);
    return configured;
  }

  async function reserveCycleCapacity(cycleID, characterID, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (cycle && cycle.cycleID === cycleID) {
      if (cycle.results.has(characterID)) return "cached";
      if (cycle.running.has(characterID)) return "running";
      if (cycle.running.size < recommendedCycleConcurrency(cycle.settings)) {
        cycle.running.add(characterID);
        return "reserved";
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("request body exceeds the size limit");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object expected");
      return parsed;
    } catch {
      const error = new Error("request body must be a JSON object");
      error.statusCode = 400;
      throw error;
    }
  }

  async function route(request, response) {
    const url = new URL(request.url || "/", "http://playerbots-addon.local");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { healthy: true, service: "evejs-playerbots-addon-api" });
      return;
    }
    if (!token || !tokenMatches(request)) {
      sendJson(response, 401, { error: "PLAYERBOTS_ADDON_UNAUTHORIZED" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/roster") {
      const bots = playerBots.listBots();
      sendJson(response, 200, {
        characterIDs: bots.map((bot) => Number(bot.characterID)).filter((id) => Number.isSafeInteger(id) && id > 0),
        count: bots.length,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/summary") {
      const summaryStartedAt = performance.now();
      const summary = dashboard.getSnapshot();
      telemetry.recordWork("dashboard.snapshot", performance.now() - summaryStartedAt);
      if (cycle && summary && typeof summary === "object") {
        sendJson(response, 200, {
          ...summary,
          work: {
            ...(summary.work || {}),
            currentCycle: {
              cycleID: cycle.cycleID,
              startedAt: new Date(cycle.startedAtMs).toISOString(),
              elapsedMs: Math.max(0, Date.now() - cycle.startedAtMs),
              expectedBots: cycle.characterIDs.length,
              completedBots: cycle.results.size,
              inFlightBots: cycle.running.size,
            },
          },
        });
      } else {
        sendJson(response, 200, summary);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/kills") {
      sendJson(response, 200, dashboard.getKillboardSnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/bots") {
      sendJson(response, 200, dashboard.listBots({
        offset: url.searchParams.get("offset"),
        limit: url.searchParams.get("limit"),
        specialty: url.searchParams.get("specialty"),
        corporationID: url.searchParams.get("corporationID"),
        search: url.searchParams.get("search"),
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/operations") {
      const query = {
        offset: url.searchParams.get("offset"),
        limit: url.searchParams.get("limit"),
        status: url.searchParams.get("status"),
        kind: url.searchParams.get("kind"),
        search: url.searchParams.get("search"),
      };
      const payload = typeof dashboard.getOperationHistoryPage === "function"
        ? dashboard.getOperationHistoryPage(query)
        : dashboard.getOperations(query.limit);
      sendJson(response, 200, payload);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/operation") {
      const operationID = String(url.searchParams.get("operationID") || "").slice(0, 100);
      const operation = typeof dashboard.getOperationDetails === "function"
        ? dashboard.getOperationDetails(operationID)
        : null;
      if (!operation) {
        sendJson(response, 404, { error: "PLAYERBOT_OPERATION_NOT_FOUND" });
        return;
      }
      sendJson(response, 200, { operation });
      return;
    }
    if (url.pathname === "/v1/dashboard/name-library") {
      const names = options.nameLibrary || require("./playerBotNameLibraryRuntime").getRuntime();
      if (request.method === "GET") return sendJson(response, 200, names.getStatus());
      if (request.method === "POST") {
        const body = await readBody(request);
        return sendJson(response, 200, names.saveText(body.text));
      }
      return sendJson(response, 405, { error: "Method not allowed." });
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/settings") {
      const effectiveAutoworkEnabled = typeof director.isEnabled === "function" ? director.isEnabled() : null;
      sendJson(response, 200, {
        settings: { ...configuration.getSettings(), ...(typeof effectiveAutoworkEnabled === "boolean" ? { autoworkEnabled: effectiveAutoworkEnabled } : {}) },
        effectiveAutoworkEnabled,
      });
      return;
    }
    if (url.pathname === "/v1/dashboard/roster-reset") {
      const reset = require("./playerBotRosterResetRuntime");
      if (request.method === "GET") {
        sendJson(response, 200, { reset: reset.getStatus(), confirmation: reset.CONFIRMATION });
        return;
      }
      if (request.method === "POST") {
        const body = await readBody(request);
        const result = reset.startReset({
          confirmation: body && body.confirmation,
          seedAfterReset: body && body.seedAfterReset === true,
        });
        sendJson(response, result.success ? 202 : 400, result.success
          ? { reset: result.state, message: result.message }
          : { error: result.message });
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/seed-status") {
      sendJson(response, 200, rosterSeedStatus());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/dashboard/telemetry") {
      const snapshot = await telemetry.getSnapshot({
        scheduler: typeof autonomy.getBoundDurableScheduler === "function" ? autonomy.getBoundDurableScheduler() : null,
        playerBots,
      });
      const guardSettings = cycle ? cycle.settings : configuration.getSettings();
      sendJson(response, 200, {
        ...snapshot,
        loadGuard: {
          eventLoopP95Ms: Math.round(currentEventLoopP95Ms() * 10) / 10,
          processCpuPercent: Math.round(processCpuPercent * 10) / 10,
          configuredStepConcurrency: Math.max(1, Math.min(100, Math.trunc(Number(guardSettings.addonConcurrency) || 100))),
          effectiveStepConcurrency: recommendedCycleConcurrency(guardSettings),
        },
      });
      return;
    }
    if (request.method === "PATCH" && url.pathname === "/v1/dashboard/settings") {
      const body = await readBody(request);
      const result = configuration.updateSettings(body);
      if (!result.success) {
        sendJson(response, 400, { error: result.message || "PLAYERBOT_SETTINGS_INVALID" });
        return;
      }
      if (Object.hasOwn(body, "autoworkEnabled") && typeof director.setEnabled === "function") {
        director.setEnabled(body.autoworkEnabled);
      }
      const effectiveAutoworkEnabled = typeof director.isEnabled === "function" ? director.isEnabled() : null;
      sendJson(response, 200, {
        settings: { ...configuration.getSettings(), ...(typeof effectiveAutoworkEnabled === "boolean" ? { autoworkEnabled: effectiveAutoworkEnabled } : {}) },
        effectiveAutoworkEnabled,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/roster/seed-step") {
      const settings = configuration.getSettings();
      if (settings.rosterSeedEnabled !== true) {
        sendJson(response, 409, { error: "PLAYERBOT_ROSTER_SEED_PAUSED", seedStatus: rosterSeedStatus() });
        return;
      }
      if (rosterSeedRunning) {
        sendJson(response, 409, { error: "PLAYERBOT_ROSTER_SEED_STEP_IN_PROGRESS", retryAfterMs: 1_000, seedStatus: rosterSeedStatus() });
        return;
      }
      const currentRosterCount = typeof playerBots.getBotCount === "function"
        ? playerBots.getBotCount()
        : playerBots.listBots().length;
      const seedTarget = Number(settings.rosterTarget) || 0;
      if (currentRosterCount >= seedTarget) {
        lastRosterSeedBatch = {
          at: new Date().toISOString(),
          created: 0,
          rosterCount: currentRosterCount,
          target: seedTarget,
          complete: true,
          overTarget: currentRosterCount > seedTarget,
          backpressure: false,
          stopReason: currentRosterCount > seedTarget
            ? `existing roster has ${currentRosterCount} pilots, above target ${seedTarget}; no bots were removed`
            : "roster target already reached",
          retryAfterMs: 0,
        };
        sendJson(response, 200, { success: true, ...lastRosterSeedBatch });
        return;
      }
      const currentLoopP95Ms = currentEventLoopP95Ms();
      const limits = effectiveSeedLimits(settings);
      const telemetryReady = Boolean(isLoadTelemetryReady());
      const loopLimit = limits.eventLoopP95Ms;
      const cpuLimit = limits.processCpuPercent;
      const cpuBackpressure = processCpuPercent > cpuLimit || highCpuSamples >= 2;
      if (!telemetryReady || currentLoopP95Ms > loopLimit || cpuBackpressure) {
        const rosterCount = typeof playerBots.getBotCount === "function" ? playerBots.getBotCount() : 0;
        const stopReason = !telemetryReady
          ? `waiting for ${REQUIRED_LOAD_SAMPLES_BEFORE_SEED} server load samples before seeding`
          : cpuBackpressure
            ? `EveJS process CPU is ${Math.round(processCpuPercent)}% (effective limit ${cpuLimit}%)`
            : `event-loop p95 is ${Math.round(currentLoopP95Ms)} ms (effective limit ${loopLimit} ms)`;
        lastRosterSeedBatch = {
          at: new Date().toISOString(),
          created: 0,
          rosterCount,
          target: Number(settings.rosterTarget) || 0,
          backpressure: true,
          warmingUp: !telemetryReady,
          stopReason,
          eventLoopP95Ms: Math.round(currentLoopP95Ms * 10) / 10,
          processCpuPercent: Math.round(processCpuPercent * 10) / 10,
          retryAfterMs: telemetryReady ? ROSTER_SEED_RETRY_MS : LOAD_SAMPLE_INTERVAL_MS * REQUIRED_LOAD_SAMPLES_BEFORE_SEED,
        };
        logger.warn(`[PlayerBotsAddon] Roster seed ${telemetryReady ? "paused by load guard" : "waiting for load samples"} p95=${Math.round(currentLoopP95Ms)}ms cpu=${Math.round(processCpuPercent)}%`);
        sendJson(response, 429, {
          error: telemetryReady ? "PLAYERBOT_ROSTER_SEED_BACKPRESSURE" : "PLAYERBOT_ROSTER_SEED_WARMING_UP",
          retryAfterMs: lastRosterSeedBatch.retryAfterMs,
          seedStatus: rosterSeedStatus(),
        });
        return;
      }
      rosterSeedRunning = true;
      try {
        const result = await playerBots.seedRosterBatch(
          Number(settings.rosterTarget),
          limits.batchSize,
          {
            maximumSingleBotMs: limits.maximumSingleBotMs,
            shouldContinue: () => {
              const currentSettings = configuration.getSettings();
              const currentLimits = effectiveSeedLimits(currentSettings);
              return currentSettings.rosterSeedEnabled === true && Boolean(isLoadTelemetryReady()) &&
                currentEventLoopP95Ms() <= currentLimits.eventLoopP95Ms &&
                processCpuPercent <= currentLimits.processCpuPercent;
            },
            getStopReason: () => {
              const currentSettings = configuration.getSettings();
              const currentLimits = effectiveSeedLimits(currentSettings);
              return currentSettings.rosterSeedEnabled !== true
                ? "roster seeding is paused"
                : !isLoadTelemetryReady()
                  ? `waiting for ${REQUIRED_LOAD_SAMPLES_BEFORE_SEED} server load samples before seeding`
                  : processCpuPercent > currentLimits.processCpuPercent
                    ? `EveJS process CPU is ${Math.round(processCpuPercent)}% (effective limit ${currentLimits.processCpuPercent}%)`
                    : `event-loop p95 is ${Math.round(currentEventLoopP95Ms())} ms (effective limit ${currentLimits.eventLoopP95Ms} ms)`;
            },
          },
        );
        lastRosterSeedBatch = {
          at: new Date().toISOString(),
          created: Number(result && result.created) || 0,
          rosterCount: Number(result && result.rosterCount) || (typeof playerBots.getBotCount === "function" ? playerBots.getBotCount() : 0),
          target: Number(result && result.target) || Number(settings.rosterTarget) || 0,
          complete: result && result.complete === true,
          backpressure: result && result.backpressure === true,
          stopReason: String(result && (result.stopReason || result.error) || "").slice(0, 240),
          batchDurationMs: Number(result && result.batchDurationMs) || 0,
          contextBuildMs: Number(result && result.contextBuildMs) || 0,
          maxBotCreationMs: Number(result && result.maxBotCreationMs) || 0,
          eventLoopP95Ms: Math.round(currentEventLoopP95Ms() * 10) / 10,
          processCpuPercent: Math.round(processCpuPercent * 10) / 10,
          createdBySpecialty: result && result.createdBySpecialty || {},
          retryAfterMs: result && result.retryAfterMs || 0,
        };
        logger.info(`[PlayerBotsAddon] Roster seed batch created=${lastRosterSeedBatch.created} roster=${lastRosterSeedBatch.rosterCount}/${lastRosterSeedBatch.target} duration=${lastRosterSeedBatch.batchDurationMs}ms loopP95=${lastRosterSeedBatch.eventLoopP95Ms}ms backpressure=${lastRosterSeedBatch.backpressure}`);
        sendJson(response, result && result.success === false ? 500 : 200, { success: result && result.success !== false, ...lastRosterSeedBatch });
      } catch (error) {
        lastRosterSeedBatch = {
          at: new Date().toISOString(), created: 0, target: Number(settings.rosterTarget) || 0,
          backpressure: true, stopReason: String(error && error.message || error).slice(0, 240),
          eventLoopP95Ms: Math.round(currentEventLoopP95Ms() * 10) / 10,
          retryAfterMs: ROSTER_SEED_RETRY_MS,
        };
        logger.warn(`[PlayerBotsAddon] Roster seed batch failed: ${lastRosterSeedBatch.stopReason}`);
        sendJson(response, 500, { error: "PLAYERBOT_ROSTER_SEED_FAILED", seedStatus: rosterSeedStatus() });
      } finally {
        rosterSeedRunning = false;
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/cycles") {
      const snapshot = autonomy.getAutonomySnapshot();
      const lastCycleAtMs = Date.parse(snapshot && (snapshot.lastCycleAt || snapshot.completedAt) || "") || 0;
      const configuredIntervalMs = Number(configuration.getSettings().addonCycleIntervalMs) || 5 * 60 * 1000;
      const publishedAvailableAtMs = Date.parse(snapshot && snapshot.nextCycleAt || "") || 0;
      const availableAtMs = lastCycleAtMs > 0
        ? lastCycleAtMs + configuredIntervalMs
        : publishedAvailableAtMs;
      if (availableAtMs > Date.now()) {
        sendJson(response, 429, {
          error: "PLAYERBOTS_ADDON_CYCLE_NOT_DUE",
          retryAfterMs: Math.max(1_000, availableAtMs - Date.now()),
        });
        return;
      }
      expireCycle();
      if (cycle) {
        cycle.lastActivityAtMs = Date.now();
        sendJson(response, 200, cyclePayload());
        return;
      }
      const roster = playerBots.listBots();
      const connectedIDs = getConnectedCharacterIDs();
      const connectedSet = connectedIDs instanceof Set ? connectedIDs : new Set(connectedIDs || []);
      const characterIDs = roster
        .map((bot) => Math.trunc(Number(bot.characterID) || 0))
        .filter((id) => id > 0 && connectedSet.has(id));
      if (!characterIDs.length) {
        sendJson(response, 200, {
          cycleID: null,
          characterIDs: [],
          completedCharacterIDs: [],
          rosterCount: roster.length,
          connectedCount: 0,
        });
        return;
      }
      const now = Date.now();
      const cycleSettings = configuration.getSettings();
      cycle = {
        cycleID: `${now}-${crypto.randomBytes(8).toString("hex")}`,
        characterIDs,
        roster,
        rosterCount: roster.length,
        results: new Map(),
        running: new Set(),
        settings: cycleSettings,
        effectiveConcurrency: recommendedCycleConcurrency(cycleSettings),
        globalMaintenanceStarted: false,
        startedAtMs: now,
        lastActivityAtMs: now,
      };
      sendJson(response, 201, cyclePayload());
      return;
    }
    const stepMatch = url.pathname.match(/^\/v1\/cycles\/([a-zA-Z0-9-]{1,80})\/steps\/(\d+)$/);
    if (request.method === "POST" && stepMatch) {
      if (!cycle || stepMatch[1] !== cycle.cycleID) {
        sendJson(response, 404, { error: "PLAYERBOTS_ADDON_CYCLE_NOT_FOUND" });
        return;
      }
      const characterID = Number(stepMatch[2]);
      if (!cycle.characterIDs.includes(characterID)) {
        sendJson(response, 404, { error: "PLAYERBOT_NOT_IN_CYCLE" });
        return;
      }
      cycle.lastActivityAtMs = Date.now();
      if (cycle.results.has(characterID)) {
        sendJson(response, 200, { success: true, cached: true, characterID });
        return;
      }
      if (cycle.running.has(characterID)) {
        sendJson(response, 409, { error: "PLAYERBOT_CYCLE_STEP_IN_PROGRESS" });
        return;
      }
      const capacity = await reserveCycleCapacity(cycle.cycleID, characterID);
      if (capacity === "cached") {
        sendJson(response, 200, { success: true, cached: true, characterID });
        return;
      }
      if (capacity === "running") {
        sendJson(response, 409, { error: "PLAYERBOT_CYCLE_STEP_IN_PROGRESS" });
        return;
      }
      if (capacity !== "reserved") {
        sendJson(response, 503, { error: "PLAYERBOT_CYCLE_CAPACITY_WAIT_TIMEOUT", retryAfterMs: 1_000 });
        return;
      }
      // The add-on driver processes different pilots concurrently. Claim the
      // one-per-cycle fleet-wide passes synchronously before the first await.
      const includeGlobalMaintenance = !cycle.globalMaintenanceStarted;
      cycle.globalMaintenanceStarted = true;
      try {
        const snapshot = await autonomy.runAutonomyChunk(
          characterID,
          cycle.cycleID,
          includeGlobalMaintenance,
          cycle.roster,
          {},
        );
        if (snapshot && snapshot.skipped === true) {
          if (includeGlobalMaintenance) cycle.globalMaintenanceStarted = false;
          sendJson(response, 409, { error: "PLAYERBOT_AUTONOMY_BUSY", reason: snapshot.reason || "busy" });
          return;
        }
        cycle.results.set(characterID, snapshot);
        const effectiveConcurrency = recommendedCycleConcurrency(cycle.settings);
        cycle.effectiveConcurrency = effectiveConcurrency;
        sendJson(response, 200, {
          success: true,
          characterID,
          effectiveConcurrency,
          eventLoopP95Ms: Math.round(currentEventLoopP95Ms() * 10) / 10,
          processCpuPercent: Math.round(processCpuPercent * 10) / 10,
        });
      } catch (error) {
        if (includeGlobalMaintenance) cycle.globalMaintenanceStarted = false;
        logger.warn(`[PlayerBotsAddon] Bot step failed char=${characterID}: ${String(error && error.message || error).slice(0, 240)}`);
        sendJson(response, 500, { error: String(error && error.message || "PLAYERBOT_ADDON_STEP_FAILED").slice(0, 240) });
      } finally {
        cycle.running.delete(characterID);
        cycle.lastActivityAtMs = Date.now();
      }
      return;
    }
    const finishMatch = url.pathname.match(/^\/v1\/cycles\/([a-zA-Z0-9-]{1,80})\/finish$/);
    if (request.method === "POST" && finishMatch) {
      if (!cycle || finishMatch[1] !== cycle.cycleID) {
        sendJson(response, 404, { error: "PLAYERBOTS_ADDON_CYCLE_NOT_FOUND" });
        return;
      }
      const body = await readBody(request);
      const failedCharacterIDs = [...new Set((Array.isArray(body.failedCharacterIDs) ? body.failedCharacterIDs : [])
        .map((value) => Math.trunc(Number(value) || 0))
        .filter((id) => cycle.characterIDs.includes(id) && !cycle.results.has(id)))];
      const failedIDSet = new Set(failedCharacterIDs);
      const failedStepsByID = new Map();
      for (const step of Array.isArray(body.failedSteps) ? body.failedSteps : []) {
        const characterID = Math.trunc(Number(step && step.characterID) || 0);
        if (!failedIDSet.has(characterID)) continue;
        failedStepsByID.set(characterID, {
          characterID,
          message: String(step && step.message || "Step failed; see the add-on log for details.")
            .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240),
        });
      }
      const completed = new Set([...cycle.results.keys(), ...failedCharacterIDs]);
      const missing = cycle.characterIDs.filter((id) => !completed.has(id));
      if (missing.length || cycle.running.size) {
        sendJson(response, 409, { error: "PLAYERBOTS_ADDON_CYCLE_INCOMPLETE", missingCharacterIDs: missing });
        return;
      }
      let snapshot = null;
      if (cycle.results.size) {
        snapshot = autonomy.aggregateAddonCycleSnapshots(
          [...cycle.results.values()],
          cycle.roster,
        );
      } else {
        snapshot = autonomy.getAutonomySnapshot();
      }
      const finishedAtMs = Date.now();
      const finishedAt = new Date(finishedAtMs).toISOString();
      const startedAt = new Date(cycle.startedAtMs).toISOString();
      const elapsedMs = Math.max(0, finishedAtMs - cycle.startedAtMs);
      snapshot = {
        ...(snapshot || {}),
        cycleStartedAt: startedAt,
        cycleFinishedAt: finishedAt,
        cycleElapsedMs: elapsedMs,
        cycleExpectedBots: cycle.characterIDs.length,
        cycleCompletedBots: cycle.results.size,
        cyclePilotWorkMs: Math.max(0, Number(snapshot && (snapshot.cyclePilotWorkMs ?? snapshot.cycleDurationMs)) || 0),
        addonFailedBots: failedCharacterIDs.length,
        addonFailedCharacterIDs: failedCharacterIDs,
        addonFailures: failedCharacterIDs.map((characterID) => failedStepsByID.get(characterID) || {
          characterID,
          message: "Step failed; see the add-on log for its error.",
        }),
      };
      autonomy.publishAutonomySnapshot(snapshot);
      const finished = { cycleID: cycle.cycleID, completedBots: cycle.results.size, failedBots: failedCharacterIDs.length, elapsedMs };
      logger.info(`[PlayerBotsAddon] Cycle complete id=${finished.cycleID} bots=${finished.completedBots} failures=${finished.failedBots}`);
      cycle = null;
      sendJson(response, 200, { success: true, ...finished });
      return;
    }
    sendJson(response, 404, { error: "PLAYERBOTS_ADDON_ROUTE_NOT_FOUND" });
  }

  return Object.freeze({
    getDiagnostics() {
      return Object.freeze({
        enabled: token.length >= 32,
        activeCycle: cycle ? cycle.cycleID : null,
        completedSteps: cycle ? cycle.results.size : 0,
        expectedSteps: cycle ? cycle.characterIDs.length : 0,
        rosterSeedRunning,
        rosterSeedEnabled: configuration.getSettings().rosterSeedEnabled === true,
        eventLoopP95Ms: Math.round(currentEventLoopP95Ms() * 10) / 10,
        processCpuPercent: Math.round(processCpuPercent * 10) / 10,
        listening: Boolean(server && server.listening),
        port: server && server.address() && server.address().port || null,
      });
    },
    async start() {
      if (token.length < 32) {
        eventLoopDelay.disable();
        clearInterval(loadSampleTimer);
        throw new Error("EVEJS_PLAYER_BOTS_ADDON_TOKEN must contain at least 32 characters");
      }
      if (server && server.listening) return this.getDiagnostics();
      server = http.createServer((request, response) => {
        void route(request, response).catch((error) => {
          if (!response.headersSent) {
            sendJson(response, Number(error && error.statusCode) || 500, {
              error: String(error && error.message || "PLAYERBOTS_ADDON_API_ERROR").slice(0, 240),
            });
          } else response.destroy();
        });
      });
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger.info(`[PlayerBotsAddon] Internal API listening on ${host}:${server.address().port}`);
      telemetry.start();
      return this.getDiagnostics();
    },
    async shutdown() {
      cycle = null;
      eventLoopDelay.disable();
      clearInterval(loadSampleTimer);
      telemetry.stop();
      if (!server || !server.listening) return;
      const current = server;
      server = null;
      await new Promise((resolve) => current.close(() => resolve()));
    },
  });
}

module.exports = { createPlayerBotAddonApiRuntime };

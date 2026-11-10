"use strict";

// Subsystem-separated performance telemetry for the playerbots services.
// The garbage-collection accumulator, percentile/summary helpers, host CPU
// aggregation and capture self-measurement are adapted from the X-Eve Living
// Universe patch (runtimePerformanceTelemetry.js), Copyright (c) 2026 X-Eve
// Living Universe patch contributors, MIT License (original patch
// contributions only). See THIRD_PARTY_NOTICES.md.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const v8 = require("node:v8");
const perfHooks = require("node:perf_hooks");

const SCHEMA_VERSION = 1;
const GC_RECENT_SAMPLE_LIMIT = 128;
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_WINDOW_COUNT = 120;
const DEFAULT_WORK_RING_SIZE = 256;
const DEFAULT_MAX_SUBSYSTEMS = 64;
const DEFAULT_BACKLOG_MIN_INTERVAL_MS = 60_000;
const DEFAULT_BACKLOG_WAIT_MS = 1_500;
const FILE_WRITE_INTERVAL_MS = 60_000;
const EVENT_LOOP_RESOLUTION_MS = 20;
// Same boundaries the add-on load guard uses for step concurrency.
const THRESHOLDS = Object.freeze({ healthyP95Ms: 50, constrainedP95Ms: 100, overloadedP95Ms: 250 });
const PLAYERBOT_JOB_TYPES = Object.freeze([
  "playerbots.autonomy.cycle",
  "playerbots.navigation.step",
  "playerbots.industry.cycle-step",
  "playerbots.director.think",
]);

const GC_KIND_NAMES = Object.freeze({
  [perfHooks.constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfHooks.constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfHooks.constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfHooks.constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakCallback",
});

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(toFiniteNumber(value, 0) * factor) / factor;
}

function percentile(values, fraction) {
  if (!values || !values.length) return 0;
  const sorted = Array.from(values).sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function summarizeValues(values) {
  const list = Array.from(values || []);
  if (!list.length) return { samples: 0, average: 0, p95: 0, maximum: 0 };
  let total = 0;
  let maximum = 0;
  for (const value of list) {
    total += value;
    if (value > maximum) maximum = value;
  }
  return {
    samples: list.length,
    average: round(total / list.length),
    p95: round(percentile(list, 0.95)),
    maximum: round(maximum),
  };
}

function classify(p95Ms) {
  const value = toFiniteNumber(p95Ms, 0);
  if (value <= THRESHOLDS.healthyP95Ms) return "healthy";
  if (value <= THRESHOLDS.constrainedP95Ms) return "constrained";
  if (value <= THRESHOLDS.overloadedP95Ms) return "degraded";
  return "overloaded";
}

function sanitizeName(name) {
  return String(name || "unnamed").slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "_") || "unnamed";
}

function createEmptyGcKindSummary() {
  return {
    minor: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    major: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    incremental: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    weakCallback: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    unknown: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
  };
}

function getGcKindName(kind) {
  return GC_KIND_NAMES[Math.trunc(toFiniteNumber(kind, -1))] || "unknown";
}

function addGcKindSample(summary, kind, durationMs) {
  const target = summary[getGcKindName(kind)] || summary.unknown;
  target.count += 1;
  target.totalDurationMs += durationMs;
  target.maximumDurationMs = Math.max(target.maximumDurationMs, durationMs);
}

function roundGcKindSummary(summary) {
  return Object.fromEntries(Object.entries(summary).map(([kind, values]) => [kind, {
    count: values.count,
    totalDurationMs: round(values.totalDurationMs),
    maximumDurationMs: round(values.maximumDurationMs),
  }]));
}

// Fixed ring of recent collections plus lifetime counters. It retains no heap
// objects and never walks the heap.
function createGcAccumulator(sampleLimit = GC_RECENT_SAMPLE_LIMIT) {
  const limit = Math.max(1, Math.trunc(toFiniteNumber(sampleLimit, GC_RECENT_SAMPLE_LIMIT)));
  const recentDurationsMs = new Float64Array(limit);
  const recentKinds = new Uint8Array(limit);
  const cumulativeKinds = createEmptyGcKindSummary();
  let cumulativeCount = 0;
  let cumulativeDurationMs = 0;
  let cumulativeMaximumDurationMs = 0;
  let recentCount = 0;
  let recentWriteIndex = 0;
  let lastObservedAtMs = 0;

  return {
    record(durationValue, kindValue, observedAtMs = Date.now()) {
      const durationMs = Math.max(0, toFiniteNumber(durationValue, 0));
      const kind = Math.max(0, Math.min(255, Math.trunc(toFiniteNumber(kindValue, 0))));
      cumulativeCount += 1;
      cumulativeDurationMs += durationMs;
      cumulativeMaximumDurationMs = Math.max(cumulativeMaximumDurationMs, durationMs);
      addGcKindSample(cumulativeKinds, kind, durationMs);
      recentDurationsMs[recentWriteIndex] = durationMs;
      recentKinds[recentWriteIndex] = kind;
      recentWriteIndex = (recentWriteIndex + 1) % limit;
      recentCount = Math.min(limit, recentCount + 1);
      lastObservedAtMs = Math.max(lastObservedAtMs, Math.trunc(toFiniteNumber(observedAtMs, 0)));
    },
    summarize() {
      const durations = [];
      const recentKindSummary = createEmptyGcKindSummary();
      const oldestIndex = recentCount < limit ? 0 : recentWriteIndex;
      for (let offset = 0; offset < recentCount; offset += 1) {
        const index = (oldestIndex + offset) % limit;
        const durationMs = recentDurationsMs[index];
        durations.push(durationMs);
        addGcKindSample(recentKindSummary, recentKinds[index], durationMs);
      }
      const recent = summarizeValues(durations);
      return {
        retainedSampleLimit: limit,
        lastObservedAtMs,
        cumulative: {
          count: cumulativeCount,
          totalDurationMs: round(cumulativeDurationMs),
          maximumDurationMs: round(cumulativeMaximumDurationMs),
          kinds: roundGcKindSummary(cumulativeKinds),
        },
        recent: {
          count: recent.samples,
          totalDurationMs: round(durations.reduce((sum, value) => sum + value, 0)),
          averageDurationMs: recent.average,
          p95DurationMs: recent.p95,
          maximumDurationMs: recent.maximum,
          kinds: roundGcKindSummary(recentKindSummary),
        },
      };
    },
  };
}

function createRing(size) {
  const values = new Float64Array(size);
  let count = 0;
  let writeIndex = 0;
  return {
    push(value) {
      values[writeIndex] = toFiniteNumber(value, 0);
      writeIndex = (writeIndex + 1) % size;
      count = Math.min(size, count + 1);
    },
    toArray() {
      const result = [];
      const oldest = count < size ? 0 : writeIndex;
      for (let offset = 0; offset < count; offset += 1) result.push(values[(oldest + offset) % size]);
      return result;
    },
    get count() { return count; },
  };
}

function aggregateHostCpuTimes(cpus = os.cpus()) {
  const totals = { idle: 0, total: 0, logicalCpus: 0 };
  for (const cpu of Array.isArray(cpus) ? cpus : []) {
    const times = cpu && cpu.times || {};
    const total = toFiniteNumber(times.user) + toFiniteNumber(times.nice) + toFiniteNumber(times.sys) +
      toFiniteNumber(times.idle) + toFiniteNumber(times.irq);
    totals.idle += toFiniteNumber(times.idle);
    totals.total += total;
    totals.logicalCpus += 1;
  }
  return totals;
}

function cpuPercent(delta, elapsedMs) {
  if (!delta || !(elapsedMs > 0)) return null;
  const userPercent = Math.max(0, toFiniteNumber(delta.user) / 1_000 / elapsedMs * 100);
  const systemPercent = Math.max(0, toFiniteNumber(delta.system) / 1_000 / elapsedMs * 100);
  return {
    userPercent: round(userPercent, 1),
    systemPercent: round(systemPercent, 1),
    totalPercent: round(userPercent + systemPercent, 1),
  };
}

function createPlayerBotPerformanceTelemetry(options = {}) {
  const now = options.now || (() => Date.now());
  const performanceNow = options.performanceNow || (() => perfHooks.performance.now());
  const sampleIntervalMs = Math.max(250, Math.trunc(toFiniteNumber(options.sampleIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS)));
  const windowCount = Math.max(1, Math.trunc(toFiniteNumber(options.windowCount, DEFAULT_WINDOW_COUNT)));
  const workRingSize = Math.max(1, Math.trunc(toFiniteNumber(options.workRingSize, DEFAULT_WORK_RING_SIZE)));
  const maxSubsystems = Math.max(1, Math.trunc(toFiniteNumber(options.maxSubsystems, DEFAULT_MAX_SUBSYSTEMS)));
  const backlogMinIntervalMs = Math.max(0, Math.trunc(toFiniteNumber(
    options.backlogMinIntervalMs ?? process.env.EVEJS_PLAYER_BOTS_TELEMETRY_BACKLOG_INTERVAL_MS,
    DEFAULT_BACKLOG_MIN_INTERVAL_MS)));
  const backlogWaitMs = Math.max(0, Math.trunc(toFiniteNumber(options.backlogWaitMs, DEFAULT_BACKLOG_WAIT_MS)));
  const createEventLoopMonitor = options.monitorEventLoopDelay || perfHooks.monitorEventLoopDelay;
  const cpuUsage = options.cpuUsage || ((previous) => process.cpuUsage(previous));
  const threadCpuUsage = options.threadCpuUsage !== undefined ? options.threadCpuUsage
    : (typeof process.threadCpuUsage === "function" ? (previous) => process.threadCpuUsage(previous) : null);
  const memoryUsage = options.memoryUsage || (() => process.memoryUsage());
  const eventLoopUtilization = options.eventLoopUtilization ||
    ((current, previous) => perfHooks.performance.eventLoopUtilization(current, previous));
  const getSessions = options.getSessions || (() => require("../chat/sessionRegistry").getSessions());
  const jobTypes = Array.isArray(options.jobTypes) ? options.jobTypes : PLAYERBOT_JOB_TYPES;
  const fileEnabled = options.fileEnabled ?? (process.env.EVEJS_PLAYER_BOTS_TELEMETRY_FILE === "1" &&
    Boolean(String(process.env.EVEJS_DATA_ROOT || "").trim()));
  const filePath = options.filePath || (fileEnabled
    ? path.resolve(String(process.env.EVEJS_DATA_ROOT), "runtime-performance", "playerbots-latest.json") : "");

  const gcAccumulator = createGcAccumulator(options.gcSampleLimit);
  const work = new Map();
  const lateness = new Map();
  const windows = { p95: createRing(windowCount), maximum: createRing(windowCount), mean: createRing(windowCount) };
  let histogram = null;
  let gcObserver = null;
  let gcObserverActive = false;
  let gcObserverError = "";
  let timer = null;
  let started = false;
  let currentWindow = null;
  let lastCpu = null;
  let lastThreadCpu = null;
  let lastElu = null;
  let lastHostCpu = null;
  let lastSampleAtMs = 0;
  let hasBaselineSample = false;
  let currentCpu = { process: null, mainThread: null, hostBusyPercent: null, utilization: null };
  let backlogCache = null;
  let backlogInFlight = null;
  let backlogError = "";
  let lastFileWriteAtMs = 0;
  let fileWriteInFlight = false;
  let cumulativeWriteSkips = 0;
  let lastFileWriteError = "";

  function readWindow() {
    if (!histogram) return null;
    const toMs = (value) => round(Math.max(0, toFiniteNumber(value, 0)) / 1_000_000, 2);
    return {
      meanMs: toMs(histogram.mean),
      p50Ms: toMs(histogram.percentile(50)),
      p95Ms: toMs(histogram.percentile(95)),
      p99Ms: toMs(histogram.percentile(99)),
      maxMs: toMs(histogram.max),
    };
  }

  function sample() {
    const nowPerf = performanceNow();
    const elapsedMs = hasBaselineSample ? Math.max(1, nowPerf - lastSampleAtMs) : 0;
    const window = readWindow();
    // After a long stall the timer can fire twice in a row; a window without
    // any delay samples says nothing and must not be reported as zero delay.
    const hasSamples = !histogram || histogram.count === undefined || Number(histogram.count) > 0;
    if (window && elapsedMs && hasSamples) {
      currentWindow = window;
      windows.p95.push(window.p95Ms);
      windows.maximum.push(window.maxMs);
      windows.mean.push(window.meanMs);
    }
    if (histogram && typeof histogram.reset === "function") histogram.reset();
    try {
      if (elapsedMs && lastCpu) currentCpu.process = cpuPercent(cpuUsage(lastCpu), elapsedMs);
      lastCpu = cpuUsage();
      if (threadCpuUsage) {
        if (elapsedMs && lastThreadCpu) currentCpu.mainThread = cpuPercent(threadCpuUsage(lastThreadCpu), elapsedMs);
        lastThreadCpu = threadCpuUsage();
      }
      const elu = eventLoopUtilization();
      if (lastElu) currentCpu.utilization = round(eventLoopUtilization(elu, lastElu).utilization, 4);
      lastElu = elu;
      const host = aggregateHostCpuTimes(options.cpus ? options.cpus() : os.cpus());
      if (lastHostCpu && host.total > lastHostCpu.total) {
        const total = host.total - lastHostCpu.total;
        currentCpu.hostBusyPercent = round(Math.max(0, 1 - (host.idle - lastHostCpu.idle) / total) * 100, 1);
      }
      lastHostCpu = host;
    } catch (_) {
      // Resource sampling is best effort; a failed probe must not stop the timer.
    }
    lastSampleAtMs = nowPerf;
    hasBaselineSample = true;
    if (filePath) maybeWriteFile();
  }

  function workEntry(name) {
    let key = sanitizeName(name);
    if (!work.has(key) && work.size >= maxSubsystems) key = "other";
    let entry = work.get(key);
    if (!entry) {
      entry = { ring: createRing(workRingSize), samples: 0, totalMs: 0, maximumMs: 0, lastAtMs: 0,
        yields: 0, maximumSliceMs: 0, items: 0, externalWaitMs: 0,
        parkedMs: 0, yieldingSuspended: 0 };
      work.set(key, entry);
    }
    return entry;
  }

  function recordWork(subsystem, durationMs, extra = {}) {
    const duration = Math.max(0, toFiniteNumber(durationMs, 0));
    const entry = workEntry(subsystem);
    entry.ring.push(duration);
    entry.samples += 1;
    entry.totalMs += duration;
    entry.maximumMs = Math.max(entry.maximumMs, duration);
    entry.lastAtMs = now();
    if (extra && typeof extra === "object") {
      entry.yields += Math.max(0, Math.trunc(toFiniteNumber(extra.yields, 0)));
      entry.maximumSliceMs = Math.max(entry.maximumSliceMs, toFiniteNumber(extra.maximumSliceMs, 0));
      entry.items += Math.max(0, Math.trunc(toFiniteNumber(extra.items, 0)));
      entry.externalWaitMs += Math.max(0, toFiniteNumber(extra.externalWaitMs, 0));
      entry.parkedMs += Math.max(0, toFiniteNumber(extra.parkedMs, 0));
      if (extra.yieldingSuspended === true) entry.yieldingSuspended += 1;
    }
  }

  async function time(subsystem, operation, extraFn) {
    const startedAt = performanceNow();
    try {
      return await operation();
    } finally {
      recordWork(subsystem, performanceNow() - startedAt, typeof extraFn === "function" ? extraFn() : undefined);
    }
  }

  function recordLateness(jobType, latenessMs) {
    const key = sanitizeName(jobType);
    let ring = lateness.get(key);
    if (!ring) {
      if (lateness.size >= maxSubsystems) return;
      ring = createRing(workRingSize);
      lateness.set(key, ring);
    }
    ring.push(Math.max(0, toFiniteNumber(latenessMs, 0)));
  }

  function recordBudget(subsystem, budgetSummary) {
    if (!budgetSummary || typeof budgetSummary !== "object") return;
    recordWork(subsystem, budgetSummary.wallDurationMs, {
      yields: budgetSummary.yields,
      maximumSliceMs: budgetSummary.maximumSliceMs,
      externalWaitMs: budgetSummary.totalExternalWaitMs,
      parkedMs: budgetSummary.totalParkedMs,
      yieldingSuspended: budgetSummary.yieldingSuspended,
    });
    for (const [stage, values] of Object.entries(budgetSummary.stages || {})) {
      recordWork(`${subsystem}.stage.${stage}`, values && values.totalWallDurationMs, {
        yields: values && values.cooperativeYields,
        externalWaitMs: values && values.externalWaitMs,
      });
    }
  }

  function buildEventLoop() {
    const current = currentWindow || readWindow() || { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    const p95Windows = windows.p95.toArray();
    const maxWindows = windows.maximum.toArray();
    const meanWindows = windows.mean.toArray();
    return {
      resolutionMs: EVENT_LOOP_RESOLUTION_MS,
      windowSeconds: round(sampleIntervalMs / 1_000, 1),
      current,
      recent: {
        windows: p95Windows.length,
        p95OfP95Ms: round(percentile(p95Windows, 0.95), 2),
        maxOfMaxMs: round(maxWindows.reduce((maximum, value) => Math.max(maximum, value), 0), 2),
        averageOfMeanMs: summarizeValues(meanWindows).average,
      },
      utilization: currentCpu.utilization,
      state: classify(current.p95Ms),
    };
  }

  function buildCpu() {
    const processCpu = currentCpu.process;
    const mainThread = currentCpu.mainThread;
    return {
      process: processCpu,
      mainThread,
      offMainThreadPercent: processCpu && mainThread
        ? round(Math.max(0, processCpu.totalPercent - mainThread.totalPercent), 1) : null,
      host: {
        logicalCpus: os.cpus().length,
        loadAverage: os.loadavg().map((value) => round(value, 2)),
        busyPercent: currentCpu.hostBusyPercent,
      },
    };
  }

  function buildMemory() {
    const usage = memoryUsage();
    const heapLimit = toFiniteNumber(v8.getHeapStatistics().heap_size_limit, 0);
    return {
      rssBytes: toFiniteNumber(usage.rss),
      heapUsedBytes: toFiniteNumber(usage.heapUsed),
      heapTotalBytes: toFiniteNumber(usage.heapTotal),
      externalBytes: toFiniteNumber(usage.external),
      arrayBuffersBytes: toFiniteNumber(usage.arrayBuffers),
      heapSizeLimitBytes: heapLimit,
      heapUsedOfLimitPercent: heapLimit > 0 ? round(toFiniteNumber(usage.heapUsed) / heapLimit * 100, 1) : 0,
    };
  }

  function buildWork() {
    const result = {};
    for (const [key, entry] of work) {
      const summary = summarizeValues(entry.ring.toArray());
      result[key] = {
        samples: entry.samples,
        recentSamples: summary.samples,
        averageMs: summary.average,
        p95Ms: summary.p95,
        maximumMs: round(entry.maximumMs),
        totalMs: round(entry.totalMs),
        lastAt: entry.lastAtMs ? new Date(entry.lastAtMs).toISOString() : null,
        yields: entry.yields,
        maximumSliceMs: round(entry.maximumSliceMs),
        items: entry.items,
        // Time spent waiting on the market or scheduler process, included in
        // the durations above but not in any held slice.
        externalWaitMs: round(entry.externalWaitMs),
        // Time a pass spent waiting to resume after yielding, and how many
        // passes stopped yielding because the event loop was saturated.
        parkedMs: round(entry.parkedMs),
        yieldingSuspended: entry.yieldingSuspended,
      };
    }
    return result;
  }

  function buildLateness() {
    const result = {};
    for (const [key, ring] of lateness) {
      const summary = summarizeValues(ring.toArray());
      result[key] = { samples: summary.samples, averageMs: summary.average, p95Ms: summary.p95, maximumMs: summary.maximum };
    }
    return result;
  }

  async function sampleBacklog(scheduler) {
    const startedAt = performanceNow();
    const nowMs = now();
    const byType = {};
    const totals = { scheduled: 0, running: 0, due: 0, oldestOverdueMs: 0 };
    for (const type of jobTypes) byType[type] = { scheduled: 0, running: 0, due: 0, oldestOverdueMs: 0 };
    // One query for every playerbot job type keeps the scan to a single
    // round trip to the scheduler process.
    const jobs = await scheduler.list({ types: [...jobTypes], states: ["scheduled", "running"] });
    for (const job of Array.isArray(jobs) ? jobs : []) {
      const row = job && byType[job.type];
      if (!row) continue;
      if (job.state === "running") { row.running += 1; totals.running += 1; continue; }
      if (job.state !== "scheduled") continue;
      row.scheduled += 1;
      totals.scheduled += 1;
      const overdueMs = nowMs - toFiniteNumber(job.dueAtMs, nowMs);
      if (overdueMs >= 0) {
        row.due += 1;
        totals.due += 1;
        row.oldestOverdueMs = Math.max(row.oldestOverdueMs, overdueMs);
        totals.oldestOverdueMs = Math.max(totals.oldestOverdueMs, overdueMs);
      }
    }
    return { sampledAtMs: nowMs, sampleDurationMs: round(performanceNow() - startedAt, 2), byType, totals };
  }

  // The queue scan crosses the scheduler process boundary, so it runs only
  // when a snapshot is requested and is cached between requests.
  async function buildQueue(scheduler) {
    if (!scheduler || typeof scheduler.list !== "function") return { error: "scheduler not bound" };
    const nowMs = now();
    let refreshing = false;
    let refreshError = "";
    if (!backlogCache || nowMs - backlogCache.sampledAtMs >= backlogMinIntervalMs) {
      if (!backlogInFlight) {
        backlogInFlight = sampleBacklog(scheduler)
          .then((result) => { backlogCache = result; backlogError = ""; return result; })
          .catch((error) => { backlogError = String(error && error.message || error).slice(0, 200); })
          .finally(() => { backlogInFlight = null; });
      }
      // A loaded server answers scheduler queries slowly. Wait briefly, then
      // report the previous scan instead of holding the telemetry request.
      let waitTimer = null;
      const finished = await Promise.race([
        backlogInFlight.then(() => true),
        new Promise((resolve) => { waitTimer = setTimeout(() => resolve(false), backlogWaitMs); }),
      ]);
      if (waitTimer) clearTimeout(waitTimer);
      refreshing = !finished;
      refreshError = backlogError;
    }
    if (!backlogCache) {
      return refreshError ? { error: refreshError }
        : { refreshing: true, minimumIntervalMs: backlogMinIntervalMs, note: "first scheduler scan is still running" };
    }
    return {
      sampledAt: new Date(backlogCache.sampledAtMs).toISOString(),
      sampleDurationMs: backlogCache.sampleDurationMs,
      cacheAgeMs: Math.max(0, now() - backlogCache.sampledAtMs),
      minimumIntervalMs: backlogMinIntervalMs,
      refreshing,
      ...(refreshError ? { refreshError } : {}),
      byType: backlogCache.byType,
      totals: backlogCache.totals,
    };
  }

  function buildDispatch(scheduler) {
    try {
      const stats = scheduler && typeof scheduler.getStats === "function" ? scheduler.getStats() : null;
      const dispatch = stats && stats.dispatch;
      return dispatch ? {
        active: Math.trunc(toFiniteNumber(dispatch.active)),
        queued: Math.trunc(toFiniteNumber(dispatch.queued)),
        maxConcurrent: Math.trunc(toFiniteNumber(dispatch.maxConcurrent)),
      } : null;
    } catch (_) {
      return null;
    }
  }

  function buildScene(playerBots) {
    const botIDs = new Set();
    const roster = playerBots && typeof playerBots.listBots === "function" ? playerBots.listBots() : [];
    for (const bot of roster) {
      const id = Math.trunc(Number(bot && bot.characterID) || 0);
      if (id > 0) botIDs.add(id);
    }
    const botsBySystem = new Map();
    const humanSystems = new Set();
    const onlineBots = new Set();
    const onlineHumans = new Set();
    let botsInSpace = 0;
    let humansInSpace = 0;
    for (const session of getSessions() || []) {
      if (!session) continue;
      const characterID = Math.trunc(Number(session.characterID || session.charID || session.charid) || 0);
      if (characterID <= 0) continue;
      const systemID = session._space ? Math.trunc(Number(session._space.systemID) || 0) : 0;
      if (session._playerBotActor === true || botIDs.has(characterID)) {
        if (!botIDs.has(characterID) || onlineBots.has(characterID)) continue;
        onlineBots.add(characterID);
        if (session._space) {
          botsInSpace += 1;
          botsBySystem.set(systemID, (botsBySystem.get(systemID) || 0) + 1);
        }
      } else if (!onlineHumans.has(characterID)) {
        onlineHumans.add(characterID);
        if (session._space) {
          humansInSpace += 1;
          if (systemID) humanSystems.add(systemID);
        }
      }
    }
    let observedSystems = 0;
    let botsInObservedSystems = 0;
    let largest = { solarSystemID: 0, botsInSpace: 0 };
    for (const [systemID, count] of botsBySystem) {
      if (systemID && humanSystems.has(systemID)) {
        observedSystems += 1;
        botsInObservedSystems += count;
      }
      if (count > largest.botsInSpace) largest = { solarSystemID: systemID, botsInSpace: count };
    }
    return {
      botsOnline: onlineBots.size,
      botsInSpace,
      botsDocked: onlineBots.size - botsInSpace,
      humansOnline: onlineHumans.size,
      humansInSpace,
      systemsWithBotsInSpace: botsBySystem.size,
      observedSystems,
      botsInObservedSystems,
      // Bot ships simulated in systems where no human pilot is in space.
      botsInUnobservedSystems: botsInSpace - botsInObservedSystems,
      largestBotScene: largest,
    };
  }

  function guarded(build) {
    try {
      return build();
    } catch (error) {
      return { error: String(error && error.message || error).slice(0, 200) };
    }
  }

  async function getSnapshot(context = {}) {
    const startedAt = performanceNow();
    const scheduler = context.scheduler || null;
    let queue;
    try {
      queue = await buildQueue(scheduler);
    } catch (error) {
      queue = { error: String(error && error.message || error).slice(0, 200) };
    }
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      capturedAt: new Date(now()).toISOString(),
      process: { pid: process.pid, uptimeSeconds: round(process.uptime(), 1), nodeVersion: process.version },
      eventLoop: guarded(buildEventLoop),
      cpu: guarded(buildCpu),
      memory: guarded(buildMemory),
      gc: guarded(() => ({
        available: gcObserverActive,
        observerActive: gcObserverActive,
        observerError: gcObserverError,
        ...gcAccumulator.summarize(),
      })),
      scheduler: {
        dispatch: buildDispatch(scheduler),
        lateness: guarded(buildLateness),
        queue,
      },
      work: guarded(buildWork),
      scene: guarded(() => buildScene(context.playerBots)),
      capture: {
        sampleIntervalMs,
        started,
        cumulativeWriteSkips,
        lastFileWriteError,
        buildDurationMs: 0,
      },
    };
    snapshot.capture.buildDurationMs = round(performanceNow() - startedAt, 2);
    return snapshot;
  }

  function maybeWriteFile() {
    const nowMs = now();
    if (nowMs - lastFileWriteAtMs < FILE_WRITE_INTERVAL_MS) return;
    if (fileWriteInFlight) {
      cumulativeWriteSkips += 1;
      return;
    }
    lastFileWriteAtMs = nowMs;
    fileWriteInFlight = true;
    const temporary = `${filePath}.tmp`;
    // The periodic file never triggers the scheduler queue scan.
    getSnapshot({})
      .then((snapshot) => fs.promises.mkdir(path.dirname(filePath), { recursive: true })
        .then(() => fs.promises.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8"))
        .then(() => fs.promises.rename(temporary, filePath)))
      .then(() => { lastFileWriteError = ""; })
      .catch((error) => { lastFileWriteError = String(error && error.message || error).slice(0, 200); })
      .finally(() => { fileWriteInFlight = false; });
  }

  function startGcObserver() {
    try {
      const Observer = options.PerformanceObserver || perfHooks.PerformanceObserver;
      const supported = Array.isArray(Observer.supportedEntryTypes) ? Observer.supportedEntryTypes : [];
      if (!supported.includes("gc")) {
        gcObserverError = "gc performance entries are not supported by this Node.js runtime";
        return;
      }
      gcObserver = new Observer((list) => {
        const observedAtMs = now();
        for (const entry of list.getEntries()) {
          const detailKind = entry && entry.detail && entry.detail.kind;
          gcAccumulator.record(entry && entry.duration, Number.isFinite(detailKind) ? detailKind : entry && entry.kind, observedAtMs);
        }
      });
      gcObserver.observe({ entryTypes: ["gc"] });
      gcObserverActive = true;
      gcObserverError = "";
    } catch (error) {
      gcObserverError = String(error && error.message || error).slice(0, 200);
      gcObserver = null;
    }
  }

  return Object.freeze({
    start() {
      if (started) return;
      started = true;
      try {
        histogram = createEventLoopMonitor({ resolution: EVENT_LOOP_RESOLUTION_MS });
        histogram.enable();
      } catch (_) {
        histogram = null;
      }
      startGcObserver();
      hasBaselineSample = false;
      sample();
      timer = setInterval(sample, sampleIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (!started) return;
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (histogram && typeof histogram.disable === "function") histogram.disable();
      histogram = null;
      if (gcObserver) gcObserver.disconnect();
      gcObserver = null;
      gcObserverActive = false;
    },
    recordWork,
    time,
    recordLateness,
    recordBudget,
    getSnapshot,
    _testing: { sample, gcAccumulator },
  });
}

let sharedTelemetry = null;

function getTelemetry() {
  if (!sharedTelemetry) sharedTelemetry = createPlayerBotPerformanceTelemetry();
  return sharedTelemetry;
}

module.exports = {
  SCHEMA_VERSION,
  THRESHOLDS,
  PLAYERBOT_JOB_TYPES,
  createPlayerBotPerformanceTelemetry,
  getTelemetry,
  _testing: { aggregateHostCpuTimes, classify, createGcAccumulator, createRing, percentile, sanitizeName, summarizeValues },
};

"use strict";

const { createTableRepository } = require("../../gameStore/tableRepository");

const TABLE = "playerBots";
const JOB_TYPE = "playerbots.autonomy.cycle";
const NAVIGATION_JOB_TYPE = "playerbots.navigation.step";
const INDUSTRY_CYCLE_JOB_TYPE = "playerbots.industry.cycle-step";
const DIRECTOR_THINK_JOB_TYPE = "playerbots.director.think";
const MAX_SCHEDULER_BATCH_SIZE = 1_000;
const JOB_ID_PREFIX = "playerbots:autonomy:";
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;
const NAVIGATION_RETRY_DELAY_MS = 15_000;
const repo = createTableRepository("service:playerbots", { strict: true });
const { formatAutonomyOverview } = require("./playerBotOpsSummary");
const ROLE_CAPABILITY_GAPS = Object.freeze({
  trade: "bounded local-market buying and selling; requires its own working capital",
  industry: "automatic manufacturing uses personal blueprints, materials, and wallet; configure /playerbots industry auto",
  planetary: "can maintain extractors and export PI; every specialty can also run passive colonies",
  security: "patrols asteroid belts for supported pirate NPCs with drones, repair, and retreat; does not run agent missions",
  piracy: "uses Crimewatch-legal targets and loot rights, avoids bubbles, and retreats; does not gate-camp or attack protected pilots",
  sovereignty: "joins eligible sovereignty campaigns with a fueled Entosis Link; qualifying bot CEOs or persisted playerbot Directors can found alliances while preserving the initial seed reserve",
});

let durableScheduler = null;
let activeAutonomyCycle = null;
const activeAutonomyChunks = new Map();
const activeDirectorThinkWakes = new Map();
let directorAssignmentBatchPromise = null;
let directorAssignmentBatchStartedAtMs = 0;
const DIRECTOR_ASSIGNMENT_BATCH_MIN_INTERVAL_MS = 15_000;

// Report handler duration and deadline lateness per job type. Telemetry must
// never change a job's outcome, so every probe is best effort.
function measuredJobHandler(handler) {
  return async function measuredPlayerBotJob(job = {}) {
    const { performance } = require("node:perf_hooks");
    const startedAt = performance.now();
    let telemetry = null;
    try {
      telemetry = require("./playerBotPerformanceTelemetry").getTelemetry();
      const dueAtMs = Number(job && job.dueAtMs) || 0;
      if (dueAtMs > 0 && job.type) telemetry.recordLateness(job.type, Date.now() - dueAtMs);
    } catch (_) {
      telemetry = null;
    }
    try {
      return await handler(job);
    } finally {
      if (telemetry) {
        try {
          telemetry.recordWork(`scheduler.job.${String(job && job.type || "unknown")}`, performance.now() - startedAt);
        } catch (_) { /* best effort */ }
      }
    }
  };
}

function stableHash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function directorThinkDelayMs(characterID, sequence = 0) {
  const settings = require("./playerBotConfigurationRuntime").getSettings();
  const normalizedID = Math.max(1, Math.trunc(Number(characterID) || 1));
  const normalizedSequence = Math.max(0, Math.trunc(Number(sequence) || 0));
  if (normalizedSequence === 0) {
    return 1_000 + (stableHash32(`${normalizedID}:first-think`) % settings.directorInitialSpreadMs);
  }
  const range = settings.directorThinkMaxMs - settings.directorThinkMinMs + 1;
  return settings.directorThinkMinMs + (stableHash32(`${normalizedID}:${normalizedSequence}`) % range);
}

function botStepJitterMs(characterID, delayMs) {
  const normalizedID = Math.max(1, Math.trunc(Number(characterID) || 1));
  const delay = Math.max(1_000, Math.trunc(Number(delayMs) || 1_000));
  const spread = Math.max(250, Math.min(4_000, Math.floor(delay * 0.2)));
  return stableHash32(`${normalizedID}:operation-step`) % (spread + 1);
}

function configuredCycleIntervalMs() {
  try {
    const configured = Number(require("./playerBotConfigurationRuntime").getSettings().addonCycleIntervalMs);
    return Number.isSafeInteger(configured) && configured >= 30_000
      ? Math.min(24 * 60 * 60 * 1000, configured)
      : CYCLE_INTERVAL_MS;
  } catch {
    return CYCLE_INTERVAL_MS;
  }
}

async function scheduleManyBounded(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return 0;
  let scheduled = 0;
  if (typeof durableScheduler.scheduleMany === "function") {
    for (let offset = 0; offset < jobs.length; offset += MAX_SCHEDULER_BATCH_SIZE) {
      const batch = jobs.slice(offset, offset + MAX_SCHEDULER_BATCH_SIZE);
      const result = await durableScheduler.scheduleMany(batch);
      scheduled += Number(result && result.scheduled) || 0;
    }
    return scheduled;
  }
  for (const job of jobs) {
    await durableScheduler.schedule(job);
    scheduled += 1;
  }
  return scheduled;
}

function createDirectorThinkJob(characterID, sequence, dueAtMs) {
  const id = Math.trunc(Number(characterID));
  const nextSequence = Math.max(0, Math.trunc(Number(sequence) || 0));
  return {
    jobID: `playerbots:director-think:${id}:${nextSequence}`,
    type: DIRECTOR_THINK_JOB_TYPE,
    dueAtMs: Math.max(Date.now() + 1, Math.trunc(Number(dueAtMs) || Date.now() + directorThinkDelayMs(id, nextSequence))),
    payload: { characterID: id, sequence: nextSequence },
  };
}

async function scheduleDirectorThinkStep(characterID, sequence, dueAtMs = null) {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const id = Math.trunc(Number(characterID));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("PLAYERBOT_DIRECTOR_THINK_BOT_REQUIRED");
  const nextSequence = Math.max(0, Math.trunc(Number(sequence) || 0));
  const due = Number(dueAtMs) > 0
    ? Number(dueAtMs)
    : Date.now() + directorThinkDelayMs(id, nextSequence);
  return durableScheduler.schedule(createDirectorThinkJob(id, nextSequence, due));
}

async function ensurePendingDirectorThinkJobs(bots = null) {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const roster = Array.isArray(bots) ? bots : getPlayerBotRuntime().listBots();
  const space = require("./playerBotSpaceRuntime");
  const eligibleIDs = new Set(space.getConnectionPlan(roster).characterIDs);
  const jobs = await durableScheduler.list({ type: DIRECTOR_THINK_JOB_TYPE, states: ["scheduled", "running"] });
  const pending = new Set();
  const sequences = new Map();
  const staleScheduled = [];
  for (const job of jobs) {
    if (!job || job.type !== DIRECTOR_THINK_JOB_TYPE) continue;
    const id = Math.trunc(Number(job.payload && job.payload.characterID) || 0);
    const sequence = Math.trunc(Number(job.payload && job.payload.sequence) || 0);
    if (id > 0) sequences.set(id, Math.max(sequences.get(id) ?? -1, sequence));
    if (id > 0 && job.state === "scheduled" && !eligibleIDs.has(id)) {
      staleScheduled.push(job.jobID);
      continue;
    }
    if (id > 0 && ["scheduled", "running"].includes(job.state)) pending.add(id);
  }
  if (staleScheduled.length) {
    if (typeof durableScheduler.cancelMany === "function") await durableScheduler.cancelMany(staleScheduled);
    else for (const jobID of staleScheduled) await durableScheduler.cancel(jobID);
  }
  const missing = [];
  for (const bot of roster) {
    const id = Math.trunc(Number(bot && bot.characterID) || 0);
    if (id <= 0 || !eligibleIDs.has(id) || pending.has(id)) continue;
    const sequence = (sequences.get(id) ?? -1) + 1;
    const dueAtMs = Date.now() + directorThinkDelayMs(id, sequence);
    missing.push(createDirectorThinkJob(id, sequence, dueAtMs));
    sequences.set(id, sequence);
    pending.add(id);
  }
  if (!missing.length) return { bots: eligibleIDs.size, roster: roster.length, scheduled: 0, pending: pending.size, cancelled: staleScheduled.length };
  const scheduled = await scheduleManyBounded(missing);
  return { bots: eligibleIDs.size, roster: roster.length, scheduled, pending: pending.size, cancelled: staleScheduled.length };
}

async function runIdleRosterDirectorBatch(roster, options = {}) {
  if (directorAssignmentBatchPromise) return directorAssignmentBatchPromise;
  const nowMs = Number(options.nowMs) || Date.now();
  const minimumIntervalMs = Math.max(0, Number(options.minimumIntervalMs ?? DIRECTOR_ASSIGNMENT_BATCH_MIN_INTERVAL_MS) || 0);
  if (nowMs - directorAssignmentBatchStartedAtMs < minimumIntervalMs) return null;

  const knownBots = Array.isArray(roster) ? roster : [];
  const isConnectedForWork = typeof options.isConnectedForWork === "function"
    ? options.isConnectedForWork
    : (characterID, bots) => require("./playerBotSpaceRuntime").isBotConnectedForWork(characterID, bots);
  const connectedBots = knownBots.filter((bot) => {
    const characterID = Math.trunc(Number(bot && bot.characterID) || 0);
    return characterID > 0 && isConnectedForWork(characterID, knownBots);
  });
  if (!connectedBots.length) return null;

  const director = options.director || require("./playerBotDirectorRuntime");
  directorAssignmentBatchStartedAtMs = nowMs;
  const batch = Promise.resolve().then(() => director.runDirector(connectedBots, {
    allBots: knownBots,
    skipGlobalMaintenance: true,
  }));
  directorAssignmentBatchPromise = batch;
  try {
    return await batch;
  } finally {
    if (directorAssignmentBatchPromise === batch) directorAssignmentBatchPromise = null;
  }
}

async function wakeDirectorThinkStep(characterID) {
  const id = Math.trunc(Number(characterID) || 0);
  if (id <= 0 || !durableScheduler) return { scheduled: false, reason: "scheduler-unavailable" };
  if (activeDirectorThinkWakes.has(id)) return activeDirectorThinkWakes.get(id);
  const waking = (async () => {
    const jobs = await durableScheduler.list({
      type: DIRECTOR_THINK_JOB_TYPE,
      payload: { characterID: id },
    });
    const ownJobs = jobs.filter((job) => job && job.type === DIRECTOR_THINK_JOB_TYPE &&
      Number(job.payload && job.payload.characterID) === id);
    if (ownJobs.some((job) => job.state === "running")) {
      return { scheduled: false, reason: "think-already-running" };
    }
    for (const job of ownJobs) {
      if (job.state === "scheduled") await durableScheduler.cancel(job.jobID);
    }
    const sequence = ownJobs.reduce((maximum, job) =>
      Math.max(maximum, Math.trunc(Number(job.payload && job.payload.sequence) || 0)), -1) + 1;
    const job = await scheduleDirectorThinkStep(id, sequence, Date.now() + 1_000);
    return { scheduled: true, jobID: job.jobID };
  })();
  activeDirectorThinkWakes.set(id, waking);
  try {
    return await waking;
  } finally {
    if (activeDirectorThinkWakes.get(id) === waking) activeDirectorThinkWakes.delete(id);
  }
}

function getPlayerBotRuntime() {
  return require("./playerBotRuntime");
}

function getAutonomySnapshot() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, "/_autonomy");
  return result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
}

function saveAutonomySnapshot(snapshot) {
  const result = repo.write(TABLE, "/_autonomy", snapshot);
  if (!result.success) {
    throw new Error(result.errorMsg || "PLAYERBOT_AUTONOMY_WRITE_FAILED");
  }
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_AUTONOMY_FLUSH_FAILED");
  }
  return snapshot;
}

function isExternalAddonMode() {
  const mode = String(process.env.EVEJS_PLAYER_BOTS_ADDON_MODE || "auto").trim().toLowerCase();
  const token = String(process.env.EVEJS_PLAYER_BOTS_ADDON_TOKEN || "").trim();
  return mode !== "disabled" && token.length >= 32;
}

function createCycleJob(cycleAtMs) {
  return {
    jobID: `${JOB_ID_PREFIX}${cycleAtMs}`,
    type: JOB_TYPE,
    dueAtMs: cycleAtMs,
    payload: { scheduledAtMs: cycleAtMs },
  };
}

async function scheduleNextCycle(dueAtMs = Date.now() + configuredCycleIntervalMs()) {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const normalizedDueAtMs = Math.max(Date.now() + 1, Math.trunc(Number(dueAtMs)));
  return durableScheduler.schedule(createCycleJob(normalizedDueAtMs));
}

async function scheduleNavigationTask(taskID, dueAtMs = Date.now() + 1000) {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const normalizedTaskID = String(taskID || "").trim().toUpperCase();
  if (!normalizedTaskID) throw new Error("PLAYERBOT_NAVIGATION_TASK_ID_REQUIRED");
  const normalizedDueAtMs = Math.max(Date.now() + 1, Math.trunc(Number(dueAtMs)));
  return durableScheduler.schedule({
    jobID: `playerbots:navigation:${normalizedTaskID}:${normalizedDueAtMs}`,
    type: NAVIGATION_JOB_TYPE,
    dueAtMs: normalizedDueAtMs,
    payload: { taskID: normalizedTaskID },
  });
}

async function ensureNavigationTask(taskID, dueAtMs = null) {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const normalizedTaskID = String(taskID || "").trim().toUpperCase();
  const taskRuntime = require("./playerBotTaskRuntime");
  const task = taskRuntime.getTask(normalizedTaskID);
  if (!task || task.kind !== "playerbot.space.route" || task.status !== "queued") {
    return { scheduled: false, reason: "task-not-queued" };
  }
  const jobs = await durableScheduler.list({
    type: NAVIGATION_JOB_TYPE,
    payload: { taskID: normalizedTaskID },
    states: ["scheduled", "running"],
  });
  const pending = jobs.find((job) =>
    job && job.type === NAVIGATION_JOB_TYPE &&
    String(job.payload && job.payload.taskID || "").toUpperCase() === normalizedTaskID &&
    ["scheduled", "running"].includes(job.state),
  );
  if (pending) return { scheduled: false, jobID: pending.jobID };
  const requestedDueAtMs = Number(dueAtMs);
  const nextAttemptAtMs = Number(task.nextAttemptAtMs) || 0;
  const due = Math.max(Date.now() + 1000, requestedDueAtMs > 0 ? requestedDueAtMs : 0, nextAttemptAtMs);
  const job = await scheduleNavigationTask(normalizedTaskID, due);
  return { scheduled: true, jobID: job.jobID };
}

async function ensurePendingNavigationTasks() {
  const tasks = require("./playerBotTaskRuntime").listTasks({ status: "queued", limit: 100 })
    .filter((task) => task.kind === "playerbot.space.route");
  const jobs = await durableScheduler.list({ type: NAVIGATION_JOB_TYPE, states: ["scheduled", "running"] });
  const pending = new Set(jobs
    .filter((job) => job && job.type === NAVIGATION_JOB_TYPE && ["scheduled", "running"].includes(job.state))
    .map((job) => String(job.payload && job.payload.taskID || "").toUpperCase()));
  let scheduled = 0;
  for (const task of tasks) {
    const taskID = String(task.taskID || "").toUpperCase();
    if (!taskID || pending.has(taskID)) continue;
    const dueAtMs = Math.max(Date.now() + 1000, Number(task.nextAttemptAtMs) || 0);
    await scheduleNavigationTask(taskID, dueAtMs);
    pending.add(taskID);
    scheduled += 1;
  }
  return { pending: tasks.length, scheduled };
}

async function handleNavigationJob(job = {}) {
  const taskID = String(job && job.payload && job.payload.taskID || "").trim().toUpperCase();
  if (!taskID) return { processed: false, reason: "missing-task-id" };
  const tasks = require("./playerBotTaskRuntime");
  const queuedTask = tasks.getTask(taskID);
  const interruptions = require("./playerBotInterruptRuntime");
  if (queuedTask && (interruptions.isBusy(queuedTask.resourceOwnerCharacterID) || interruptions.hasPending(queuedTask.resourceOwnerCharacterID))) {
    await scheduleNavigationTask(taskID, Date.now() + 1000);
    return { processed: false, reason: "pilot-emergency-or-step-in-progress" };
  }
  if (!queuedTask || queuedTask.kind !== "playerbot.space.route" || queuedTask.status !== "queued") {
    return { processed: false, reason: "task-not-queued" };
  }
  const assignment = tasks.claimNextTask({
    supportedKinds: ["playerbot.space.route"],
    taskID,
  });
  if (!assignment) {
    const owner = getPlayerBotRuntime().listBots().find((bot) =>
      Number(bot.characterID) === Number(queuedTask.resourceOwnerCharacterID),
    );
    if (owner && owner.status !== "paused" && owner.autonomyPaused !== true) {
      await scheduleNavigationTask(taskID, Date.now() + NAVIGATION_RETRY_DELAY_MS);
    }
    return { processed: false, reason: owner ? "provider-unavailable" : "provider-missing" };
  }

  const { task, provider } = assignment;
  try {
    if (Number(task.resourceOwnerCharacterID) !== Number(provider.characterID)) {
      throw new Error("PLAYERBOT_ROUTE_OWNER_MISMATCH");
    }
    const result = require("./playerBotSpaceRuntime").advanceSystemRoute(
      provider,
      task.payload && task.payload.destinationSystemID,
    );
    if (!result || result.success !== true) throw new Error(result && result.message || "PLAYERBOT_ROUTE_STEP_FAILED");
    if (result.completed === true) {
      const completion = tasks.completeTask(task.taskID, task.leaseToken, {
        ...(result.result && typeof result.result === "object" ? result.result : {}),
        destinationSystemID: Number(task.payload.destinationSystemID),
        systemIDs: Array.isArray(task.payload.plannedSystemIDs)
          ? task.payload.plannedSystemIDs
          : result.result && result.result.systemIDs || [],
        hops: Number(task.payload.plannedHopCount) || Number(result.result && result.result.hops) || 0,
        routeRisk: task.payload.routeRisk || null,
      });
      return { processed: completion.success, completed: completion.success, taskID };
    }
    const deferred = tasks.deferTask(task.taskID, task.leaseToken, {
      delayMs: result.delayMs,
      progress: result.progress,
    });
    if (deferred.success) {
      await scheduleNavigationTask(task.taskID, deferred.task.nextAttemptAtMs);
    }
    return { processed: deferred.success, deferred: deferred.success, taskID, message: result.message };
  } catch (error) {
    const failure = tasks.failTask(task.taskID, task.leaseToken, error);
    if (failure.success && failure.task && failure.task.status === "queued") {
      await scheduleNavigationTask(taskID, Date.now() + NAVIGATION_RETRY_DELAY_MS);
    }
    const log = require("../../utils/logger");
    log.warn(
      `[PlayerBots] Route step failed task=${taskID} char=${provider.characterID} ` +
        `failureCount=${failure.task && failure.task.failureCount || 0}: ${error.message}`,
    );
    return { processed: failure.success, failed: true, taskID, message: error.message };
  }
}

function createIndustryCycleStepJob(characterID, dueAtMs = Date.now() + 1000) {
  const normalizedID = Math.trunc(Number(characterID));
  if (!Number.isSafeInteger(normalizedID) || normalizedID <= 0) throw new Error("PLAYERBOT_INDUSTRY_CYCLE_BOT_REQUIRED");
  const normalizedDueAtMs = Math.max(Date.now() + 1, Math.trunc(Number(dueAtMs)));
  return {
    jobID: `playerbots:industry-cycle:${normalizedID}:${normalizedDueAtMs}`,
    type: INDUSTRY_CYCLE_JOB_TYPE,
    dueAtMs: normalizedDueAtMs,
    payload: { characterID: normalizedID },
  };
}

async function scheduleIndustryCycleStep(characterID, dueAtMs = Date.now() + 1000) {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  return durableScheduler.schedule(createIndustryCycleStepJob(characterID, dueAtMs));
}

async function ensureIndustryCycleStep(characterID, dueAtMs = null) {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const normalizedID = Math.trunc(Number(characterID));
  const jobs = await durableScheduler.list({
    type: INDUSTRY_CYCLE_JOB_TYPE,
    payload: { characterID: normalizedID },
    states: ["scheduled", "running"],
  });
  const pending = jobs.find((job) =>
    job && job.type === INDUSTRY_CYCLE_JOB_TYPE &&
    Number(job.payload && job.payload.characterID) === normalizedID &&
    ["scheduled", "running"].includes(job.state),
  );
  if (pending) return { scheduled: false, jobID: pending.jobID };
  const job = await scheduleIndustryCycleStep(
    normalizedID,
    Number(dueAtMs) > 0
      ? dueAtMs
      : Date.now() + 1_000 + botStepJitterMs(normalizedID, 5_000),
  );
  return { scheduled: true, jobID: job.jobID };
}

const industryWakeLanes = new Map();
async function wakeIndustryCycleStep(characterID, options = {}) {
  if (!durableScheduler) return;
  const id=Number(characterID);
  if(industryWakeLanes.has(id))return industryWakeLanes.get(id);
  const wake=(async()=>{
    const dueAtMs=Date.now()+(options.immediate===true?250:1000);
    const jobs=await durableScheduler.list({type:INDUSTRY_CYCLE_JOB_TYPE,payload:{characterID:id},states:["scheduled","running"]});
    const current=jobs.filter(j=>j&&j.type===INDUSTRY_CYCLE_JOB_TYPE&&Number(j.payload?.characterID)===id&&
      ["scheduled","running"].includes(j.state)).sort((a,b)=>a.dueAtMs-b.dueAtMs)[0];
    if(current){
      const result=await durableScheduler.wakeEarlier(current.jobID,dueAtMs);
      if(result&&["scheduled","running"].includes(result.state))return result;
    }
    return ensureIndustryCycleStep(id,dueAtMs);
  })();
  industryWakeLanes.set(id,wake);
  try{return await wake;}finally{if(industryWakeLanes.get(id)===wake)industryWakeLanes.delete(id);}
}

async function ensurePendingIndustryCycles() {
  require("./playerBotLocalDefenseAdapter").maintain();
  const operationRuntime = require("./playerBotOperationRuntime");
  const cycleRuntime = require("./playerBotIndustryCycleRuntime");
  // Recover accepted emergency intents before enumerating schedulable work.
  for (const id of require("./playerBotInterruptRuntime").pendingIDs()) operationRuntime.drainInterruptions(id);
  const cycles = [
    ...(typeof cycleRuntime.listActiveCycleRecords === "function"
      ? cycleRuntime.listActiveCycleRecords() : cycleRuntime.listActiveCycles()),
    ...(typeof operationRuntime.listActiveOperationRecords === "function"
      ? operationRuntime.listActiveOperationRecords() : operationRuntime.listActiveOperations()),
  ];
  const activeByCharacter = new Map();
  for (const id of Object.keys(require("./playerBotLocalDefenseAdapter").snapshot().leases)) activeByCharacter.set(Number(id), { characterID:Number(id) });
  for (const cycle of cycles) {
    const characterID = Math.trunc(Number(cycle && cycle.characterID) || 0);
    if (characterID > 0 && !activeByCharacter.has(characterID)) {
      activeByCharacter.set(characterID, cycle);
    }
  }
  const jobs = await durableScheduler.list({ type: INDUSTRY_CYCLE_JOB_TYPE, states: ["scheduled", "running"] });
  const pending = new Set(jobs
    .filter((job) => job && job.type === INDUSTRY_CYCLE_JOB_TYPE &&
      ["scheduled", "running"].includes(job.state))
    .map((job) => Math.trunc(Number(job.payload && job.payload.characterID) || 0)));
  const missing = [];
  for (const characterID of activeByCharacter.keys()) {
    if (pending.has(characterID)) continue;
    missing.push(createIndustryCycleStepJob(
      characterID,
      Date.now() + 1_000 + botStepJitterMs(characterID, 5_000),
    ));
    pending.add(characterID);
  }
  const scheduled = await scheduleManyBounded(missing);
  return { active: activeByCharacter.size, scheduled };
}

async function ensureActiveBotStep(characterID, options = {}) {
  const normalizedID = Math.trunc(Number(characterID) || 0);
  if (!normalizedID) return { scheduled: false, reason: "missing-character-id" };
  const operation = require("./playerBotOperationRuntime").getOperation(normalizedID);
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(normalizedID);
  const operationActive = operation && ["active", "holding"].includes(operation.status);
  const cycleActive = cycle && ["active", "holding"].includes(cycle.status);
  if (!operationActive && !cycleActive) return { scheduled: false, reason: "no-active-work" };
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const ignoreJobID = String(options.ignoreRunningJobID || "");
  const jobs = await durableScheduler.list({
    type: INDUSTRY_CYCLE_JOB_TYPE,
    payload: { characterID: normalizedID },
    states: ["scheduled", "running"],
  });
  const pending = jobs.find((job) =>
    job && job.type === INDUSTRY_CYCLE_JOB_TYPE &&
    Number(job.payload && job.payload.characterID) === normalizedID &&
    job.jobID !== ignoreJobID && ["scheduled", "running"].includes(job.state),
  );
  if (pending) return { scheduled: false, jobID: pending.jobID };
  const job = await scheduleIndustryCycleStep(
    normalizedID,
    Date.now() + 1_000 + botStepJitterMs(normalizedID, 5_000),
  );
  return { scheduled: true, jobID: job.jobID };
}

async function handleIndustryCycleJob(job = {}) {
  const characterID = Math.trunc(Number(job && job.payload && job.payload.characterID));
  if (!characterID) return { processed: false, reason: "missing-character-id" };
  const playerBots = getPlayerBotRuntime();
  const roster = typeof playerBots.getPlanningRoster === "function"
    ? playerBots.getPlanningRoster() : playerBots.listBots();
  const connectionSpace = require("./playerBotSpaceRuntime");
  // Cleanup must also run outside the connection window; otherwise a disconnected
  // responder retains its durable lease until its next scheduled login.
  const connectedForWork = connectionSpace.isBotConnectedForWork(characterID, roster);
  const rescueStep = await require("./playerBotLocalDefenseAdapter").advance(characterID, { unavailable: !connectedForWork });
  if (!connectedForWork) {
    const dueAtMs = connectionSpace.nextBotConnectionAtMs(characterID, roster) || Date.now() + 60_000;
    const deferred = await scheduleIndustryCycleStep(characterID, Math.max(Date.now() + 5_000, dueAtMs));
    return { processed: false, deferred: true, reason: "outside-connection-window", nextAttemptAtMs: deferred.dueAtMs };
  }
  // One step job per bot drives whichever durable operation it is running:
  // a generic operation (haul, mining) or the industry production cycle.
  const operations = require("./playerBotOperationRuntime");
  const result = rescueStep || (operations.hasActiveOperation(characterID)
    ? await operations.advanceOperation(characterID)
    : await require("./playerBotIndustryCycleRuntime").advanceCycle(characterID));
  if (result && result.done) {
    // Chain straight into the next job instead of idling until the next
    // five-minute autonomy cycle.
    try {
      const bot = playerBots.getBotByCharacterID(characterID);
      if (bot) {
        await require("./playerBotDirectorRuntime").runDirector([bot], {
          allBots: roster,
          skipGlobalMaintenance: true,
        });
      }
    } catch (error) {
      require("../../utils/logger").warn(`[PlayerBots] Follow-up assignment failed char=${characterID}: ${error.message}`);
    }
    try {
      await ensureActiveBotStep(characterID, { ignoreRunningJobID: job.jobID });
    } catch (error) {
      require("../../utils/logger").warn(
        `[PlayerBots] Could not schedule follow-up work after a completed step char=${characterID}: ${error.message}`,
      );
    }
    return { processed: true, done: true };
  }
  const delayMs = Math.max(1000, Math.trunc(Number(result && result.delayMs) || 5000));
  const staggerMs = botStepJitterMs(characterID, delayMs);
  await scheduleIndustryCycleStep(characterID, Date.now() + delayMs + staggerMs);
  return { processed: true, delayMs, staggerMs };
}


// Role training hook: queue the skills the pilot's target hull needs, through
// the same durable planner the war mobilization uses. Runs at most once per
// pilot per cooldown window so a busy roster cannot spam skillbook purchases.
// The first attempt is offset by pilot ID: without it a restart makes every
// pilot buy skillbooks at once, which stalls the event loop for seconds.
const SKILL_TRAINING_COOLDOWN_MS = 30 * 60 * 1000;
// characterID -> earliest ms at which this pilot may train again.
const skillTrainingNextAt = new Map();

function skillTrainingRoleFor(bot) {
  const specialty = String(bot && bot.specialty || "");
  if (specialty === "security" || specialty === "piracy" || specialty === "sovereignty") {
    return specialty;
  }
  // Industry, planetary and trade pilots climb the mining hull ladder.
  return "mining";
}

async function ensureBotSkillTraining(bot) {
  const characterID = Math.trunc(Number(bot && bot.characterID) || 0);
  if (!characterID || !bot || bot.status === "paused" || bot.autonomyPaused === true) return null;
  const role = skillTrainingRoleFor(bot);
  const warRuntime = require("./playerBotWarMobilizationRuntime");
  // War mobilization already owns this pilot's training queue.
  try {
    if (typeof warRuntime.getActiveWarCombatAssignment === "function" &&
        warRuntime.getActiveWarCombatAssignment(bot)) return null;
  } catch (_) {
    // Missing war state must not block ordinary training.
  }
  const nowMs = Date.now();
  let nextAtMs = Number(skillTrainingNextAt.get(characterID)) || 0;
  if (!nextAtMs) {
    // First sighting after a restart: wait a pilot-specific slice of the
    // cooldown window so 500 skillbook purchases never land in one minute.
    nextAtMs = nowMs + (characterID % 30) * 60 * 1000;
    skillTrainingNextAt.set(characterID, nextAtMs);
  }
  if (nowMs < nextAtMs) return null;
  skillTrainingNextAt.set(characterID, nowMs + SKILL_TRAINING_COOLDOWN_MS);
  try {
    const result = await warRuntime.queueRoleTraining(bot, role);
    if (result && result.queued === true) {
      require("../../utils/logger").info(
        `[PlayerBots] Skill training queued char=${characterID} role=${role} hull=${result.targetHull || "?"} ` +
          `skills=${(result.requiredSkills || []).length} endsAt=${result.queueEndTime || "unknown"}`,
      );
    }
    return result;
  } catch (error) {
    require("../../utils/logger").warn(
      `[PlayerBots] Skill training failed char=${characterID} role=${role}: ` +
        `${String(error && error.message || error).slice(0, 180)}`,
    );
    return null;
  }
}

async function handleDirectorThinkJob(job = {}) {
  const characterID = Math.trunc(Number(job && job.payload && job.payload.characterID) || 0);
  const sequence = Math.max(0, Math.trunc(Number(job && job.payload && job.payload.sequence) || 0));
  if (!characterID) return { processed: false, reason: "missing-character-id" };
  const playerBots = getPlayerBotRuntime();
  const roster = typeof playerBots.getPlanningRoster === "function"
    ? playerBots.getPlanningRoster() : playerBots.listBots();
  const bot = playerBots.getBotByCharacterID(characterID);
  if (!bot) return { processed: false, reason: "bot-not-in-roster" };
  const connectionSpace = require("./playerBotSpaceRuntime");
  if (!connectionSpace.isBotConnectedForWork(characterID, roster)) {
    const dueAtMs = connectionSpace.nextBotConnectionAtMs(characterID, roster) || Date.now() + 60_000;
    const nextJob = await scheduleDirectorThinkStep(
      characterID,
      sequence + 1,
      Math.max(Date.now() + 5_000, dueAtMs),
    );
    return { processed: true, skipped: true, reason: "outside-connection-window", characterID, nextThinkAtMs: nextJob.dueAtMs };
  }
  let directorSummary = null;
  try {
    directorSummary = await runIdleRosterDirectorBatch(roster);
    if (Number(directorSummary && directorSummary.assigned) > 0) {
      require("../../utils/logger").info(
        `[PlayerBots] Idle-roster director batch assigned=${Number(directorSummary.assigned) || 0} ` +
        `failures=${Number(directorSummary.failures) || 0} active=${Number(directorSummary.active) || 0}/` +
        `${Number(directorSummary.capacityLimit) || 0}.`,
      );
    }
    await ensureActiveBotStep(characterID);
    await ensureBotSkillTraining(bot);
  } catch (error) {
    require("../../utils/logger").warn(
      `[PlayerBots] Independent director think failed char=${characterID} sequence=${sequence}: ` +
        `${String(error && error.message || error).slice(0, 220)}`,
    );
  }
  const nextSequence = sequence + 1;
  const nextJob = await scheduleDirectorThinkStep(
    characterID,
    nextSequence,
    Date.now() + directorThinkDelayMs(characterID, nextSequence),
  );
  return {
    processed: true,
    characterID,
    sequence,
    assigned: Number(directorSummary && directorSummary.assigned) || 0,
    nextThinkAtMs: nextJob.dueAtMs,
  };
}

function summarizeSpecialties(bots, piSummary, tradeSummary, industrySummary) {
  const summary = {};
  for (const specialty of getPlayerBotRuntime().SPECIALTIES) {
    const team = bots.filter((bot) => bot.specialty === specialty.id);
    summary[specialty.id] = {
      bots: team.length,
      capabilityGap: `${ROLE_CAPABILITY_GAPS[specialty.id] || "no activity adapter"}; basic mining, PI, and manufacturing are cross-trained for every pilot`,
      planetaryColonies: Number(piSummary.coloniesBySpecialty && piSummary.coloniesBySpecialty[specialty.id]) || 0,
      extractorsRestarted: Number(piSummary.extractorsRestartedBySpecialty && piSummary.extractorsRestartedBySpecialty[specialty.id]) || 0,
      activeAutoSellPolicies: specialty.id === "trade" ? tradeSummary.activeSellPolicies : null,
      activeAutoBuyPolicies: specialty.id === "trade" ? tradeSummary.activeBuyPolicies : null,
      activeManufacturingPolicies: specialty.id === "industry" ? industrySummary.activePolicies : null,
    };
  }
  return summary;
}

async function runAutonomyCycle(options = {}) {
  const cycleStartedAt = process.hrtime.bigint();
  const roster = Array.isArray(options.roster)
    ? options.roster
    : getPlayerBotRuntime().listBots();
  const requestedCharacterIDs = Array.isArray(options.characterIDs)
    ? new Set(options.characterIDs.map((characterID) => Math.trunc(Number(characterID) || 0)))
    : null;
  const bots = requestedCharacterIDs
    ? roster.filter((bot) => requestedCharacterIDs.has(Number(bot.characterID)))
    : roster;
  const addonChunk = options.addonChunk === true;
  const includeGlobalMaintenance = !addonChunk || options.includeGlobalMaintenance === true;
  // The first add-on request is a preflight for the whole roster. Keep shared
  // provisioning, corporation ledgers and PI policy writes out of the parallel
  // per-pilot steps so concurrent chunks cannot overwrite one another.
  const globalBots = includeGlobalMaintenance ? (addonChunk ? roster : bots) : [];
  const cycleID = String(options.cycleID || Date.now());
  const taskCycleID = addonChunk
    ? `${cycleID}:${Number(bots[0] && bots[0].characterID) || 0}`
    : cycleID;
  const tasks = require("./playerBotTaskRuntime");
  const piRuntime = require("../planet/planetRuntimeStore");
  const tradeRuntime = require("./playerBotTradeRuntime");
  const planetaryExportRuntime = require("./playerBotPlanetaryRuntime");
  const industryRuntime = require("./playerBotIndustryRuntime");
  const taskKind = "planetary.extractor-maintenance";
  const initialAutoSellPolicies = tradeRuntime.listActiveAutoSellPolicies();
  const initialAutoBuyPolicies = tradeRuntime.listActiveAutoBuyPolicies();
  const piSummary = {
    botsVisited: 0,
    colonyCount: 0,
    coloniesBySpecialty: {},
    restartedCount: 0,
    extractorsRestartedBySpecialty: {},
    failedCount: 0,
    tasksQueued: 0,
    tasksCompleted: 0,
    tasksDeferred: 0,
    leasesRecovered: 0,
  };
  const tradeSummary = {
    activePolicies: initialAutoSellPolicies.length + initialAutoBuyPolicies.length,
    activeSellPolicies: initialAutoSellPolicies.length,
    activeBuyPolicies: initialAutoBuyPolicies.length,
    tasksQueued: 0,
    autoSellTasksQueued: 0,
    autoBuyTasksQueued: 0,
    tasksCompleted: 0,
    tasksDeferred: 0,
    unitsSold: 0,
    unitsListed: 0,
    unitsBought: 0,
    netProceeds: 0,
    purchaseSpend: 0,
    uncertainSales: 0,
    uncertainPurchases: 0,
    failedCount: 0,
    quoteFailures: 0,
    skippedReplay: false,
  };
  const planetaryExportSummary = {
    activePolicies: planetaryExportRuntime.listActiveAutoExportPolicies().length,
    tasksQueued: 0,
    tasksCompleted: 0,
    tasksDeferred: 0,
    collectionOperationsQueued: 0,
    unitsQueuedForCollection: 0,
    unitsLaunched: 0,
    taxSpent: 0,
    uncertainLaunches: 0,
    failedCount: 0,
    skippedReplay: false,
  };
  const industrySummary = {
    activePolicies: industryRuntime.listActiveAutoManufacturingPolicies().length,
    manufactureTasksQueued: 0,
    deliveryTasksQueued: 0,
    tasksCompleted: 0,
    jobsStarted: 0,
    jobsDelivered: 0,
    unitsManufactured: 0,
    iskSpent: 0,
    tasksDeferred: 0,
    quoteFailures: 0,
    overBudget: 0,
    waitingJobs: 0,
    failedCount: 0,
    skippedReplay: false,
  };

  if (!addonChunk || options.includeGlobalMaintenance === true) {
    try {
      require("./playerBotRecruitmentRuntime").reconcileHumanCeos();
    } catch (error) {
      industrySummary.failedCount += 1;
      industrySummary.lastError = String(error && error.message || error).slice(0, 240);
    }
  }
  let corpEconomySummary = null;
  if (globalBots.length) {
    try {
      await require("./playerBotProvisioningRuntime").provisionRoster(globalBots);
    } catch (error) {
      industrySummary.failedCount += 1;
      industrySummary.lastError = String(error && error.message || error).slice(0, 240);
    }
    try {
      corpEconomySummary = await require("./playerBotCorpEconomyRuntime").fundMembers(globalBots);
    } catch (error) {
      industrySummary.failedCount += 1;
      industrySummary.lastError = String(error && error.message || error).slice(0, 240);
    }
  }
  let directorSummary = null;
  let directorError = null;
  let directorThinkSummary = null;
  if (globalBots.length) {
    try {
      // Keep corporation-wide capacity, war, and market reconciliation on the
      // slow roster pass. Assignment itself is handled by each pilot's own
      // staggered durable think job.
      directorSummary = await require("./playerBotDirectorRuntime").runDirector([], {
        allBots: roster,
      });
    } catch (error) {
      industrySummary.failedCount += 1;
      directorError = String(error && error.message || error).slice(0, 240);
      industrySummary.lastError = directorError;
      require("../../utils/logger").warn(
        `[PlayerBots] Director maintenance pass failed bots=${roster.length}: ${directorError}`,
      );
    }
    try {
      directorThinkSummary = await ensurePendingDirectorThinkJobs(roster);
    } catch (error) {
      industrySummary.failedCount += 1;
      directorError = directorError || String(error && error.message || error).slice(0, 240);
      industrySummary.lastError = directorError;
      require("../../utils/logger").warn(
        `[PlayerBots] Could not schedule independent director thinks bots=${roster.length}: ${directorError}`,
      );
    }
  }
  if (!addonChunk || options.includeGlobalMaintenance === true) {
    try {
      await ensurePendingIndustryCycles();
    } catch (error) {
      industrySummary.failedCount += 1;
      industrySummary.lastError = String(error && error.message || error).slice(0, 240);
    }
  }

  if (!addonChunk || options.includeGlobalMaintenance === true) {
    const reconciliation = tasks.reconcileLeases();
    piSummary.leasesRecovered = reconciliation.recovered;
  }
  const maintenanceBots = addonChunk ? globalBots : bots;
  const enqueued = tasks.requestExtractorMaintenanceBatch(maintenanceBots);
  piSummary.colonyCount = enqueued.colonyCount;
  piSummary.tasksQueued = enqueued.tasks.filter((entry) => entry.created).length;
  const botsByID = new Map((maintenanceBots.length ? maintenanceBots : bots)
    .map((bot) => [Number(bot.characterID), bot]));
  for (const bot of (maintenanceBots.length ? maintenanceBots : bots)) {
    const colonyCount = Number(enqueued.coloniesByCharacter[Number(bot.characterID)]) || 0;
    if (!colonyCount || !bot.specialty) continue;
    piSummary.coloniesBySpecialty[bot.specialty] =
      (Number(piSummary.coloniesBySpecialty[bot.specialty]) || 0) + colonyCount;
  }

  for (let processed = 0; processed < bots.length; processed += 1) {
    const assignment = tasks.claimNextTask({
      supportedKinds: [taskKind],
      ...(addonChunk ? { providerCharacterIDs: bots.map((bot) => bot.characterID) } : {}),
      skipReconcile: true,
    });
    if (!assignment) break;
    const { task, provider } = assignment;
    piSummary.botsVisited += 1;
    try {
      const targetCharacterID = Number(task.resourceOwnerCharacterID || task.targetCharacterID);
      if (targetCharacterID !== Number(provider.characterID)) {
        throw new Error("PLAYERBOT_PI_TASK_OWNER_MISMATCH");
      }
      const candidatePlanetIDs = Array.isArray(task.payload && task.payload.planetIDs)
        ? task.payload.planetIDs
        : [];
      const result = piRuntime.restartExtractorsForCharacter(targetCharacterID, {
        planetIDs: candidatePlanetIDs,
      });
      piSummary.restartedCount += Number(result.restartedCount) || 0;
      const ownerBot = botsByID.get(targetCharacterID);
      if (ownerBot && ownerBot.specialty) {
        piSummary.extractorsRestartedBySpecialty[ownerBot.specialty] =
          (Number(piSummary.extractorsRestartedBySpecialty[ownerBot.specialty]) || 0) + (Number(result.restartedCount) || 0);
      }
      piSummary.failedCount += Number(result.failedCount) || 0;
      const completion = tasks.completeTask(task.taskID, task.leaseToken, {
        colonyCount: Number(result.colonyCount) || 0,
        restartedCount: Number(result.restartedCount) || 0,
        failedCount: Number(result.failedCount) || 0,
      });
      if (completion.success) piSummary.tasksCompleted += 1;
      else piSummary.failedCount += 1;
    } catch (error) {
      piSummary.failedCount += 1;
      piSummary.lastError = String(error && error.message || error).slice(0, 240);
      tasks.failTask(task.taskID, task.leaseToken, error);
    }
    // PI recovery may have dozens of expired colonies at once. The work is
    // durable per colony, so yield between owners and let Destiny ticks and
    // player RPCs run instead of holding the world loop for the whole batch.
    await new Promise((resolve) => setImmediate(resolve));
  }

  try {
    if (globalBots.length) {
      const reconciliation = planetaryExportRuntime.reconcileAutoExportPolicies(globalBots);
      planetaryExportSummary.policiesReconciled = reconciliation.added;
    }
    const exportCycle = await planetaryExportRuntime.scheduleAutoExportTasks(
      bots,
      taskCycleID,
    );
    planetaryExportSummary.tasksQueued = exportCycle.scheduled;
    planetaryExportSummary.skippedReplay = exportCycle.skippedReplay;
  } catch (error) {
    planetaryExportSummary.failedCount += 1;
    planetaryExportSummary.lastError = String(error && error.message || error).slice(0, 240);
  }

  try {
    const tradeCycle = await tradeRuntime.scheduleTradeTasks(
      bots,
      taskCycleID,
    );
    tradeSummary.tasksQueued = tradeCycle.scheduled;
    tradeSummary.autoSellTasksQueued = tradeCycle.autoSellScheduled;
    tradeSummary.autoBuyTasksQueued = tradeCycle.autoBuyScheduled;
    tradeSummary.quoteFailures = tradeCycle.quoteFailures;
    tradeSummary.skippedReplay = tradeCycle.skippedReplay;
  } catch (error) {
    tradeSummary.failedCount += 1;
    tradeSummary.lastError = String(error && error.message || error).slice(0, 240);
  }

  try {
    const industryCycle = industryRuntime.scheduleAutoManufacturingTasks(
      bots,
      taskCycleID,
    );
    industrySummary.activePolicies = industryCycle.activePolicies;
    industrySummary.manufactureTasksQueued = industryCycle.manufactureTasksQueued;
    industrySummary.deliveryTasksQueued = industryCycle.deliveryTasksQueued;
    industrySummary.quoteFailures = industryCycle.quoteFailures;
    industrySummary.overBudget = industryCycle.overBudget;
    industrySummary.waitingJobs = industryCycle.waitingJobs;
  } catch (error) {
    industrySummary.failedCount += 1;
    industrySummary.lastError = String(error && error.message || error).slice(0, 240);
  }

  for (let processed = 0; processed < bots.length; processed += 1) {
    const assignment = tasks.claimNextTask({
      supportedKinds: ["playerbot.trade.autosell"],
      ...(addonChunk ? { providerCharacterIDs: bots.map((bot) => bot.characterID) } : {}),
      skipReconcile: true,
    });
    if (!assignment) break;
    const { task, provider } = assignment;
    try {
      const result = await tradeRuntime.executeAutoSellTask(task, provider);
      tradeSummary.unitsSold += (Number(result && result.sold) || 0) + (Number(result && result.recoveredPriorSale) || 0);
      tradeSummary.unitsListed += Number(result && result.listed) || 0;
      tradeSummary.netProceeds += Number(result && result.netProceeds) || 0;
      if (result && result.requiresReview === true) tradeSummary.uncertainSales += 1;
      const completion = tasks.completeTask(task.taskID, task.leaseToken, result);
      if (completion.success) tradeSummary.tasksCompleted += 1;
      else tradeSummary.failedCount += 1;
    } catch (error) {
      tradeSummary.failedCount += 1;
      tradeSummary.lastError = String(error && error.message || error).slice(0, 240);
      tasks.failTask(task.taskID, task.leaseToken, error);
    }
  }

  for (let processed = 0; processed < bots.length; processed += 1) {
    const assignment = tasks.claimNextTask({
      supportedKinds: ["playerbot.trade.autobuy"],
      ...(addonChunk ? { providerCharacterIDs: bots.map((bot) => bot.characterID) } : {}),
      skipReconcile: true,
    });
    if (!assignment) break;
    const { task, provider } = assignment;
    try {
      const result = await tradeRuntime.executeAutoBuyTask(task, provider);
      tradeSummary.unitsBought += Number(result && result.bought) || 0;
      tradeSummary.purchaseSpend += Number(result && result.spent) || 0;
      if (result && result.outcomeUnknown === true) tradeSummary.uncertainPurchases += 1;
      const completion = tasks.completeTask(task.taskID, task.leaseToken, result);
      if (completion.success) tradeSummary.tasksCompleted += 1;
      else tradeSummary.failedCount += 1;
    } catch (error) {
      tradeSummary.failedCount += 1;
      tradeSummary.lastError = String(error && error.message || error).slice(0, 240);
      tasks.failTask(task.taskID, task.leaseToken, error);
    }
  }
  for (let processed = 0; processed < bots.length; processed += 1) {
    const assignment = tasks.claimNextTask({
      supportedKinds: [planetaryExportRuntime.TASK_KIND],
      ...(addonChunk ? { providerCharacterIDs: bots.map((bot) => bot.characterID) } : {}),
      skipReconcile: true,
    });
    if (!assignment) break;
    const { task, provider } = assignment;
    try {
      const result = await planetaryExportRuntime.executeAutoExportTask(task, provider);
      planetaryExportSummary.unitsLaunched += Number(result && result.launchedUnits) || 0;
      planetaryExportSummary.unitsQueuedForCollection += Number(result && result.scheduledUnits) || 0;
      if (result && (result.collectionOperationQueued === true || result.recoveredLaunchQueued === true)) {
        planetaryExportSummary.collectionOperationsQueued += 1;
      }
      planetaryExportSummary.taxSpent += Number(result && result.taxSpent) || 0;
      if (result && result.outcomeUnknown === true) planetaryExportSummary.uncertainLaunches += 1;
      const completion = tasks.completeTask(task.taskID, task.leaseToken, result);
      if (completion.success) planetaryExportSummary.tasksCompleted += 1;
      else planetaryExportSummary.failedCount += 1;
    } catch (error) {
      planetaryExportSummary.failedCount += 1;
      planetaryExportSummary.lastError = String(error && error.message || error).slice(0, 240);
      tasks.failTask(task.taskID, task.leaseToken, error);
    }
  }
  const industryTasksProcessed = new Set();
  for (let processed = 0; processed < bots.length; processed += 1) {
    const assignment = tasks.claimNextTask({
      supportedKinds: [industryRuntime.MANUFACTURE_TASK_KIND],
      excludeTaskIDs: [...industryTasksProcessed],
      ...(addonChunk ? { providerCharacterIDs: bots.map((bot) => bot.characterID) } : {}),
      skipReconcile: true,
    });
    if (!assignment) break;
    const { task, provider } = assignment;
    industryTasksProcessed.add(task.taskID);
    try {
      const result = await industryRuntime.executeManufacturingTask(task, provider);
      const completion = tasks.completeTask(task.taskID, task.leaseToken, result);
      if (completion.success) {
        industrySummary.tasksCompleted += 1;
        if (result && result.jobID && !result.recovered) {
          industrySummary.jobsStarted += 1;
          industrySummary.unitsManufactured += Number(result.runs) || 0;
          industrySummary.iskSpent += Number(result.totalCost) || 0;
        }
      } else {
        industrySummary.failedCount += 1;
      }
    } catch (error) {
      industrySummary.failedCount += 1;
      industrySummary.lastError = String(error && error.message || error).slice(0, 240);
      tasks.failTask(task.taskID, task.leaseToken, error);
    }
  }
  industryTasksProcessed.clear();
  for (let processed = 0; processed < bots.length; processed += 1) {
    const assignment = tasks.claimNextTask({
      supportedKinds: [industryRuntime.DELIVER_TASK_KIND],
      excludeTaskIDs: [...industryTasksProcessed],
      ...(addonChunk ? { providerCharacterIDs: bots.map((bot) => bot.characterID) } : {}),
      skipReconcile: true,
    });
    if (!assignment) break;
    const { task, provider } = assignment;
    industryTasksProcessed.add(task.taskID);
    try {
      const result = industryRuntime.executeDeliveryTask(task, provider);
      const completion = tasks.completeTask(task.taskID, task.leaseToken, result);
      if (completion.success) {
        industrySummary.tasksCompleted += 1;
        if (result && result.jobID && Number(result.status) >= 100 && !result.recovered) {
          industrySummary.jobsDelivered += 1;
        }
      } else {
        industrySummary.failedCount += 1;
      }
    } catch (error) {
      industrySummary.failedCount += 1;
      industrySummary.lastError = String(error && error.message || error).slice(0, 240);
      tasks.failTask(task.taskID, task.leaseToken, error);
    }
  }
  const queuedTasks = !addonChunk || options.includeGlobalMaintenance === true
    ? tasks.listTasks({ status: "queued", limit: 100 })
    : null;
  tradeSummary.tasksDeferred = queuedTasks
    ? queuedTasks.filter((task) => ["playerbot.trade.autosell", "playerbot.trade.autobuy"].includes(task.kind)).length
    : 0;
  tradeSummary.activeSellPolicies = initialAutoSellPolicies.length;
  tradeSummary.activeBuyPolicies = initialAutoBuyPolicies.length;
  tradeSummary.activePolicies = tradeSummary.activeSellPolicies + tradeSummary.activeBuyPolicies;
  planetaryExportSummary.activePolicies = planetaryExportRuntime.listActiveAutoExportPolicies().length;
  industrySummary.activePolicies = industryRuntime.listActiveAutoManufacturingPolicies().length;
  industrySummary.tasksDeferred = queuedTasks
    ? queuedTasks.filter((task) => [industryRuntime.MANUFACTURE_TASK_KIND, industryRuntime.DELIVER_TASK_KIND].includes(task.kind)).length
    : 0;
  planetaryExportSummary.tasksDeferred = queuedTasks
    ? queuedTasks.filter((task) => task.kind === planetaryExportRuntime.TASK_KIND).length
    : 0;
  piSummary.tasksDeferred = queuedTasks
    ? queuedTasks.filter((task) => task.kind === taskKind).length
    : 0;

  let marketMakingSummary = { traders: 0, buyOrdersPlaced: 0, unitsListed: 0, failures: 0 };
  if (globalBots.length) {
    try {
      marketMakingSummary = await require("./playerBotMarketMakerRuntime").runMarketMakerPass(globalBots);
    } catch (error) {
      marketMakingSummary.failures += 1;
      marketMakingSummary.lastError = String(error && error.message || error).slice(0, 180);
    }
  }
  tradeSummary.marketMaking = marketMakingSummary;

  let profitShareSummary = { eligibleBots: 0, contributions: 0, amount: 0, failures: 0 };
  if (globalBots.length) {
    try {
      profitShareSummary = await require("./playerBotCorpEconomyRuntime").settleProfitShares(globalBots);
    } catch (error) {
      profitShareSummary.failures += 1;
      profitShareSummary.lastError = String(error && error.message || error).slice(0, 180);
    }
  }
  corpEconomySummary = { ...(corpEconomySummary || {}), profitShare: profitShareSummary };

  const now = new Date().toISOString();
  const cycleDurationMs = Number(process.hrtime.bigint() - cycleStartedAt) / 1e6;
  const snapshot = {
    cycleID,
    lastCycleAt: now,
    nextCycleAt: new Date(Date.now() + configuredCycleIntervalMs()).toISOString(),
    cycleDurationMs: Math.round(cycleDurationMs * 10) / 10,
    cyclePilotWorkMs: Math.round(cycleDurationMs * 10) / 10,
    cycleElapsedMs: Math.round(cycleDurationMs * 10) / 10,
    botCount: bots.length,
    planetaryMaintenance: piSummary,
    planetaryExport: planetaryExportSummary,
    trade: tradeSummary,
    industry: industrySummary,
    director: directorSummary,
    directorError,
    corpEconomy: corpEconomySummary,
    specialties: summarizeSpecialties(bots, piSummary, tradeSummary, industrySummary),
  };
  if (!addonChunk) saveAutonomySnapshot(snapshot);
  const log = require("../../utils/logger");
  log.info(
    `[PlayerBots] ${addonChunk ? "Addon step" : "Autonomy cycle"} bots=${bots.length} durationMs=${cycleDurationMs.toFixed(1)} ` +
      `PI colonies=${piSummary.colonyCount} extractorsRestarted=${piSummary.restartedCount} ` +
      `tasksCreated=${piSummary.tasksQueued} tasksCompleted=${piSummary.tasksCompleted} ` +
      `autoSellPolicies=${tradeSummary.activeSellPolicies} autoBuyPolicies=${tradeSummary.activeBuyPolicies} ` +
      `tradeTasks=${tradeSummary.tasksCompleted}/${tradeSummary.tasksQueued} ` +
      `unitsSold=${tradeSummary.unitsSold} unitsListed=${tradeSummary.unitsListed} unitsBought=${tradeSummary.unitsBought} ` +
      `purchaseSpend=${tradeSummary.purchaseSpend.toFixed(2)} uncertainSales=${tradeSummary.uncertainSales} uncertainPurchases=${tradeSummary.uncertainPurchases} ` +
      `piExportPolicies=${planetaryExportSummary.activePolicies} piExportTasks=${planetaryExportSummary.tasksCompleted}/${planetaryExportSummary.tasksQueued} ` +
      `piCollectionsQueued=${planetaryExportSummary.collectionOperationsQueued} piExportQueuedUnits=${planetaryExportSummary.unitsQueuedForCollection} ` +
      `piExportUnits=${planetaryExportSummary.unitsLaunched} piExportTax=${planetaryExportSummary.taxSpent.toFixed(2)} ` +
      `uncertainPIExports=${planetaryExportSummary.uncertainLaunches} ` +
      `industryPolicies=${industrySummary.activePolicies} industryJobs=${industrySummary.jobsStarted}/${industrySummary.jobsDelivered} ` +
      `industryTasks=${industrySummary.manufactureTasksQueued + industrySummary.deliveryTasksQueued} ` +
      `industryRuns=${industrySummary.unitsManufactured} industryISK=${industrySummary.iskSpent.toFixed(2)} ` +
      `industryQuoteFailures=${industrySummary.quoteFailures} industryOverBudget=${industrySummary.overBudget} ` +
      `autowork=${directorThinkSummary ? `independent-thinks=${directorThinkSummary.scheduled} scheduled; fleet-active=${directorSummary.active}` : addonChunk ? "per-pilot-think-scheduled" : directorSummary ? "per-pilot-think-scheduled" : "error"} ` +
      `autoworkError=${directorError || "none"} ` +
      `corpProfitShare=${profitShareSummary.contributions}/${profitShareSummary.eligibleBots} ` +
      `corpProfitShareISK=${profitShareSummary.amount.toFixed(2)} ` +
      `deferred=${piSummary.tasksDeferred} recoveredLeases=${piSummary.leasesRecovered} ` +
      `failures=${piSummary.failedCount + tradeSummary.failedCount + tradeSummary.quoteFailures + planetaryExportSummary.failedCount + industrySummary.failedCount + profitShareSummary.failures}.`,
  );
  return snapshot;
}

function aggregateAddonCycleSnapshots(snapshots, roster = []) {
  const entries = (Array.isArray(snapshots) ? snapshots : []).filter((entry) =>
    entry && typeof entry === "object",
  );
  if (!entries.length) throw new Error("PLAYERBOT_ADDON_CYCLE_EMPTY");
  const latest = entries[entries.length - 1];
  const sum = (section, keys) => {
    const rows = entries.map((entry) => entry[section] || {});
    const result = { ...(rows[rows.length - 1] || {}) };
    for (const key of keys) {
      result[key] = rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
    }
    return result;
  };
  const max = (section, keys) => {
    const rows = entries.map((entry) => entry[section] || {});
    const result = { ...(rows[rows.length - 1] || {}) };
    for (const key of keys) {
      result[key] = rows.reduce((value, row) => Math.max(value, Number(row[key]) || 0), 0);
    }
    return result;
  };
  const sumMaps = (section, key) => {
    const output = {};
    for (const entry of entries) {
      const values = entry[section] && entry[section][key];
      for (const [name, value] of Object.entries(values || {})) {
        output[name] = (Number(output[name]) || 0) + (Number(value) || 0);
      }
    }
    return output;
  };

  const planetaryMaintenance = sum("planetaryMaintenance", [
    "botsVisited", "colonyCount", "restartedCount", "failedCount", "tasksQueued",
    "tasksCompleted", "leasesRecovered",
  ]);
  planetaryMaintenance.tasksDeferred = max("planetaryMaintenance", ["tasksDeferred"]).tasksDeferred;
  planetaryMaintenance.coloniesBySpecialty = sumMaps("planetaryMaintenance", "coloniesBySpecialty");
  planetaryMaintenance.extractorsRestartedBySpecialty = sumMaps("planetaryMaintenance", "extractorsRestartedBySpecialty");
  const planetaryExport = sum("planetaryExport", [
    "tasksQueued", "tasksCompleted", "collectionOperationsQueued", "unitsQueuedForCollection",
    "unitsLaunched", "taxSpent",
    "uncertainLaunches", "failedCount",
  ]);
  planetaryExport.activePolicies = max("planetaryExport", ["activePolicies"]).activePolicies;
  planetaryExport.tasksDeferred = max("planetaryExport", ["tasksDeferred"]).tasksDeferred;
  const trade = sum("trade", [
    "tasksQueued", "autoSellTasksQueued", "autoBuyTasksQueued", "tasksCompleted",
    "unitsSold", "unitsListed", "unitsBought", "netProceeds", "purchaseSpend",
    "uncertainSales", "uncertainPurchases", "failedCount", "quoteFailures",
  ]);
  trade.tasksDeferred = max("trade", ["tasksDeferred"]).tasksDeferred;
  trade.activeSellPolicies = max("trade", ["activeSellPolicies"]).activeSellPolicies;
  trade.activeBuyPolicies = max("trade", ["activeBuyPolicies"]).activeBuyPolicies;
  trade.activePolicies = trade.activeSellPolicies + trade.activeBuyPolicies;
  const industry = sum("industry", [
    "manufactureTasksQueued", "deliveryTasksQueued", "tasksCompleted", "jobsStarted",
    "jobsDelivered", "unitsManufactured", "iskSpent", "quoteFailures", "overBudget",
    "failedCount",
  ]);
  industry.tasksDeferred = max("industry", ["tasksDeferred"]).tasksDeferred;
  industry.waitingJobs = max("industry", ["waitingJobs"]).waitingJobs;
  industry.activePolicies = max("industry", ["activePolicies"]).activePolicies;
  const director = sum("director", [
    "assigned", "mine", "industry", "upgrade", "sell", "colony", "relocate", "order-courier",
    "order-build", "recoveredColonyReviews", "failures", "resumedForCapacity",
    "jitaOrdersCancelled",
  ]);
  Object.assign(director, max("director", [
    "active", "capacityLimit", "perSystemCapacityLimit", "capacityQueued",
    "pausedForCapacity", "capacityReserveLimit", "activeRelocations",
  ]));
  const profitRows = entries.map((entry) => entry.corpEconomy && entry.corpEconomy.profitShare || {});
  const profitShare = { ...(profitRows[profitRows.length - 1] || {}) };
  for (const key of ["eligibleBots", "contributions", "amount", "failures"]) {
    profitShare[key] = profitRows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  }
  const corpRows = entries.map((entry) => entry.corpEconomy || {});
  const corpEconomy = { ...(corpRows.find((row) => Object.keys(row).length) || {}) };
  for (const key of ["grants", "granted", "refused"]) {
    corpEconomy[key] = Math.max(0, ...corpRows.map((row) => Number(row[key]) || 0));
  }
  corpEconomy.profitShare = profitShare;
  const specialtyIDs = new Set(entries.flatMap((entry) => Object.keys(entry.specialties || {})));
  const specialties = {};
  for (const specialtyID of specialtyIDs) {
    const rows = entries.map((entry) => entry.specialties && entry.specialties[specialtyID] || {});
    specialties[specialtyID] = {
      ...rows[rows.length - 1],
      bots: rows.reduce((total, row) => total + (Number(row.bots) || 0), 0),
      planetaryColonies: rows.reduce((total, row) => total + (Number(row.planetaryColonies) || 0), 0),
      extractorsRestarted: rows.reduce((total, row) => total + (Number(row.extractorsRestarted) || 0), 0),
      activeAutoSellPolicies: Math.max(0, ...rows.map((row) => Number(row.activeAutoSellPolicies) || 0)),
      activeAutoBuyPolicies: Math.max(0, ...rows.map((row) => Number(row.activeAutoBuyPolicies) || 0)),
      activeManufacturingPolicies: Math.max(0, ...rows.map((row) => Number(row.activeManufacturingPolicies) || 0)),
    };
  }
  const snapshot = {
    ...latest,
    lastCycleAt: new Date().toISOString(),
    nextCycleAt: new Date(Date.now() + configuredCycleIntervalMs()).toISOString(),
    cycleDurationMs: Math.round(entries.reduce((total, entry) => total + (Number(entry.cycleDurationMs) || 0), 0) * 10) / 10,
    cyclePilotWorkMs: Math.round(entries.reduce((total, entry) => total + (Number(entry.cyclePilotWorkMs ?? entry.cycleDurationMs) || 0), 0) * 10) / 10,
    botCount: Array.isArray(roster) ? roster.length : entries.length,
    planetaryMaintenance,
    planetaryExport,
    trade,
    industry,
    director,
    directorError: entries.map((entry) => String(entry.directorError || "").trim()).find(Boolean) || null,
    corpEconomy,
    specialties,
    executionMode: "playerbots-addon-process",
    externalCycleID: latest.cycleID || null,
  };
  snapshot.cyclePilotWorkMs = snapshot.cycleDurationMs;
  return snapshot;
}

async function runAutonomyChunk(characterID, cycleID, includeGlobalMaintenance = false, roster = null, options = {}) {
  const normalizedID = Math.trunc(Number(characterID) || 0);
  const playerBots = getPlayerBotRuntime();
  const availableBots = Array.isArray(roster) ? roster :
    (typeof playerBots.getPlanningRoster === "function" ? playerBots.getPlanningRoster() : playerBots.listBots());
  const bot = playerBots.getBotByCharacterID(normalizedID);
  if (!bot) throw new Error("PLAYERBOT_NOT_FOUND");
  if (activeAutonomyChunks.has(normalizedID)) {
    return { skipped: true, reason: "this pilot's autonomy step is already running" };
  }
  const cycleRunner = typeof options._runCycle === "function" ? options._runCycle : runAutonomyCycle;
  const run = cycleRunner({
    addonChunk: true,
    characterIDs: [normalizedID],
    cycleID,
    includeGlobalMaintenance: includeGlobalMaintenance === true,
    roster: availableBots,
  });
  activeAutonomyChunks.set(normalizedID, run);
  const chunkStartedAt = require("node:perf_hooks").performance.now();
  try {
    // A durable operation/industry step reschedules itself after every step.
    // Recovery of missing jobs is batched once per roster pass; querying the
    // scheduler once for each add-on pilot multiplied IPC and HTTP latency.
    return await run;
  } finally {
    if (activeAutonomyChunks.get(normalizedID) === run) activeAutonomyChunks.delete(normalizedID);
    try {
      require("./playerBotPerformanceTelemetry").getTelemetry().recordWork(
        includeGlobalMaintenance === true ? "autonomy.chunk.global" : "autonomy.chunk.pilot",
        require("node:perf_hooks").performance.now() - chunkStartedAt,
      );
    } catch (_) { /* telemetry is best effort */ }
  }
}

async function handleJob(job = {}) {
  if (isExternalAddonMode()) {
    return { skipped: true, reason: "periodic autonomy is owned by the playerbots add-on process" };
  }
  const scheduledAtMs = Math.trunc(Number(job && job.payload && job.payload.scheduledAtMs) || 0);
  const previous = getAutonomySnapshot();
  const lastCycleAtMs = Date.parse(previous && previous.lastCycleAt || "") || 0;
  if (scheduledAtMs > 0 && lastCycleAtMs >= scheduledAtMs) {
    return { skipped: true, reason: "cycle already completed" };
  }
  if (activeAutonomyCycle) {
    return { skipped: true, reason: "another autonomy cycle is running" };
  }
  const run = (async () => {
    await runAutonomyCycle({ cycleID: scheduledAtMs || Date.now() });
    await scheduleNextCycle();
  })();
  activeAutonomyCycle = run;
  try {
    await run;
    return { completed: true };
  } finally {
    if (activeAutonomyCycle === run) activeAutonomyCycle = null;
  }
}

async function reconcile() {
  if (!durableScheduler) throw new Error("PLAYERBOT_SCHEDULER_NOT_BOUND");
  const tasks = require("./playerBotTaskRuntime");
  const playerBotJobTypes = new Set([
    JOB_TYPE,
    NAVIGATION_JOB_TYPE,
    INDUSTRY_CYCLE_JOB_TYPE,
    DIRECTOR_THINK_JOB_TYPE,
  ]);
  const jobs = await durableScheduler.list({
    types: [...playerBotJobTypes],
    states: ["scheduled", "running"],
  });
  const recoveredLeases = tasks.reconcileLeases({ force: true }).recovered;
  const recoveredOperations = require("./playerBotOperationRuntime").reconcileTransientOperations();
  const stalePlayerBotJobs = jobs.filter((job) =>
    job && playerBotJobTypes.has(job.type) && ["scheduled", "running"].includes(job.state),
  );
  const staleIDs = stalePlayerBotJobs.map((job) => job.jobID);
  if (staleIDs.length) {
    if (typeof durableScheduler.cancelMany === "function") {
      await durableScheduler.cancelMany(staleIDs);
    } else {
      for (const jobID of staleIDs) await durableScheduler.cancel(jobID);
    }
  }
  // These state machines are durable in playerBots/_tasks, _operations and
  // _industryCycles. Rebuild one wake-up per live task/character rather than
  // replaying thousands of obsolete scheduler leases after restart.
  const navigation = await ensurePendingNavigationTasks();
  const industry = await ensurePendingIndustryCycles();
  const directorThink = await ensurePendingDirectorThinkJobs(getPlayerBotRuntime().listBots());
  const job = isExternalAddonMode()
    ? null
    : await scheduleNextCycle(Date.now() + 30_000);
  return {
    scheduled: Boolean(job),
    externalAddonMode: isExternalAddonMode(),
    jobID: job && job.jobID || null,
    recoveredLeases,
    recoveredOperations,
    compactedJobs: staleIDs.length,
    navigationJobs: navigation.scheduled,
    industryJobs: industry.scheduled,
    directorThinkJobs: directorThink.scheduled,
  };
}

function formatAutonomyStatus(options = {}) {
  const snapshot = getAutonomySnapshot();
  const requestedPage = Math.max(1, Math.trunc(Number(options.page) || 1));
  const pageRequested = Number(options.page) > 0;
  const filterSystemID = Math.max(0, Math.trunc(Number(options.systemID) || 0));
  const systemsPage = Math.max(0, Math.trunc(Number(options.systemsPage) || 0));
  if (!pageRequested && !filterSystemID && !systemsPage) {
    return formatAutonomyOverview(snapshot);
  }

  const pageSize = 10;
  const playerBots = getPlayerBotRuntime();
  const bots = playerBots.listBots();
  const characterState = require("../character/characterState");
  const worldData = require("../../space/worldData");
  const space = require("./playerBotSpaceRuntime");
  const walletState = require("../account/walletState");
  const corporations = require("../corporation/corporationState");
  const operations = require("./playerBotOperationRuntime").listOperations();
  const cycles = require("./playerBotIndustryCycleRuntime").listCycles()
    .filter((cycle) => ["active", "holding", "review", "blocked"].includes(String(cycle.status).toLowerCase()));
  const tasks = require("./playerBotTaskRuntime").listTasks({ limit: 100 });
  const corporationByID = new Map();
  const operationByBot = new Map(operations.map((operation) => [Number(operation.characterID), operation]));
  const cycleByBot = new Map(cycles.map((cycle) => [Number(cycle.characterID), cycle]));
  const taskByID = new Map(tasks.map((task) => [String(task.taskID || "").toUpperCase(), task]));
  const taskByBot = new Map();
  for (const task of tasks) {
    if (!task || !["queued", "leased"].includes(task.status)) continue;
    const characterID = Number(task.providerCharacterID || task.targetCharacterID || 0);
    if (characterID && !taskByBot.has(characterID)) taskByBot.set(characterID, task);
  }

  const allRoster = bots.map((bot) => {
    const characterID = Number(bot.characterID) || 0;
    const character = characterState.getCharacterRecord(characterID) || {};
    const corporationID = Number(character.corporationID || bot.corporationID) || 0;
    if (!corporationByID.has(corporationID)) {
      corporationByID.set(corporationID, corporationID ? corporations.getCorporationRecord(corporationID) || {} : {});
    }
    const corporation = corporationByID.get(corporationID);
    const presence = space.getBotPresenceInfo(bot, character);
    let systemID = Number(presence.solarSystemID || character.solarSystemID) || 0;
    const stationID = Number(presence.stationID || character.stationID) || 0;
    const structureID = Number(presence.structureID || character.structureID) || 0;
    const station = stationID ? worldData.getStationByID(stationID) : null;
    const structure = structureID ? worldData.getStructureByID(structureID) : null;
    if (!systemID && station) systemID = Number(station.solarSystemID) || 0;
    if (!systemID && structure) systemID = Number(structure.solarSystemID) || 0;
    const system = systemID ? worldData.getSolarSystemByID(systemID) : null;
    const systemName = system && (system.solarSystemName || system.name) || "Unknown system";
    const location = presence.inSpace
      ? "in space"
      : stationID
        ? `docked at ${(station && station.stationName) || "station"} [${stationID}]`
        : structureID
          ? `docked at ${(structure && (structure.itemName || structure.name)) || "structure"} [${structureID}]`
          : "no active space actor";
    const operation = operationByBot.get(characterID);
    const cycle = cycleByBot.get(characterID);
    const recordedTask = taskByID.get(String(bot.currentTask || "").toUpperCase());
    const task = recordedTask && ["queued", "leased"].includes(recordedTask.status)
      ? recordedTask
      : taskByBot.get(characterID);
    let activity = bot.status === "paused" || bot.autonomyPaused === true
      ? "autonomy paused"
      : "idle; awaiting director assignment";
    if (operation && !["completed", "stopped", "canceled", "failed"].includes(String(operation.status).toLowerCase())) {
      activity = `${operation.kind} ${operation.status}/${operation.stage}`;
      if (operation.lastAction) activity += ` — ${String(operation.lastAction).replace(/[\r\n]+/g, " ").slice(0, 180)}`;
    } else if (cycle) {
      activity = `industry ${cycle.status}/${cycle.stage}`;
      if (cycle.lastAction) activity += ` — ${String(cycle.lastAction).replace(/[\r\n]+/g, " ").slice(0, 180)}`;
    } else if (task) {
      const phase = task.progress && (task.progress.phase || task.progress.stage);
      activity = `task ${task.taskID} ${task.kind} (${task.status}${phase ? `/${phase}` : ""})`;
      if (task.lastError) activity += ` — ${String(task.lastError).replace(/[\r\n]+/g, " ").slice(0, 90)}`;
    } else if (bot.currentTask) {
      activity = `task ${bot.currentTask}; task details unavailable`;
    }
    const wallet = walletState.getCharacterWallet(characterID);
    return {
      bot,
      characterID,
      corporationID,
      corporationName: corporation.corporationName || `Corporation ${corporationID || "?"}`,
      presence,
      systemID,
      systemName,
      location,
      shipID: Number(character.shipID) || 0,
      shipTypeID: Number(character.shipTypeID) || 0,
      wallet: Number(wallet && wallet.balance) || 0,
      activity,
      paused: bot.status === "paused" || bot.autonomyPaused === true,
    };
  });

  const groupedSystems = new Map();
  for (const entry of allRoster) {
    const key = entry.systemID || 0;
    if (!groupedSystems.has(key)) groupedSystems.set(key, { bots: 0, connected: 0, inSpace: 0, docked: 0, inactive: 0 });
    const group = groupedSystems.get(key);
    group.bots += 1;
    if (entry.presence.connected) group.connected += 1;
    if (entry.presence.inSpace) group.inSpace += 1;
    else if (entry.presence.stationID || entry.presence.structureID) group.docked += 1;
    else group.inactive += 1;
  }

  if (systemsPage) {
    const systems = [...groupedSystems.entries()].sort((left, right) =>
      right[1].bots - left[1].bots || Number(left[0]) - Number(right[0]),
    );
    const systemsPerPage = 6;
    const pageCount = Math.max(1, Math.ceil(systems.length / systemsPerPage));
    const page = Math.min(systemsPage, pageCount);
    const pageRows = systems.slice((page - 1) * systemsPerPage, page * systemsPerPage)
      .map(([systemID, group]) => {
        const system = Number(systemID) ? worldData.getSolarSystemByID(Number(systemID)) : null;
        const name = system && (system.solarSystemName || system.name) || "Unknown system";
        return `${name} [${systemID || "?"}]: ${group.bots} bots; ${group.connected} present; ${group.inSpace} in space; ${group.docked} docked; ${group.inactive} inactive.`;
      });
    if (page < pageCount) pageRows.push(`Next: /playerbots ops systems ${page + 1}.`);
    if (page > 1) pageRows.push(`Previous: /playerbots ops systems ${page - 1}.`);
    return [`Playerbot system distribution — page ${page}/${pageCount} (${systems.length} systems).`, ...pageRows].join("\n");
  }

  const connectedCount = allRoster.filter((entry) => entry.presence.connected).length;
  const inSpaceCount = allRoster.filter((entry) => entry.presence.inSpace).length;
  const dockedCount = allRoster.filter((entry) =>
    !entry.presence.inSpace && Boolean(entry.presence.stationID || entry.presence.structureID),
  ).length;
  const header = [
    `Playerbot live roster: ${bots.length} bots; ${connectedCount} present, ${inSpaceCount} in space, ${dockedCount} docked, ${bots.length - inSpaceCount - dockedCount} without an active space actor.`,
  ];

  if (filterSystemID) {
    const system = worldData.getSolarSystemByID(filterSystemID);
    header.push(`Filtered roster: ${(system && (system.solarSystemName || system.name)) || "Unknown system"} [${filterSystemID}].`);
  }
  const roster = allRoster.filter((entry) => !filterSystemID || entry.systemID === filterSystemID);
  if (!roster.length) {
    header.push(filterSystemID
      ? `No playerbots have a recorded location in solar system ${filterSystemID}.`
      : "No playerbots are registered.");
    return header.join("\n");
  }

  const pageCount = Math.max(1, Math.ceil(roster.length / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const rows = roster.slice((page - 1) * pageSize, page * pageSize).flatMap((entry) => [
    `${entry.bot.characterName} [${entry.characterID}] — ${entry.corporationName} [${entry.corporationID || "?"}] — ${entry.bot.specialty} — ${entry.paused ? "paused" : entry.bot.status || "active"} — ${entry.presence.connected ? "present" : "not present"}.`,
    `  ${entry.systemName} [${entry.systemID || "?"}], ${entry.location}; ship ${entry.shipTypeID || "?"} [${entry.shipID || "?"}]; wallet ${entry.wallet.toLocaleString("en-US", { maximumFractionDigits: 2 })} ISK; work: ${entry.activity}.`,
  ]);
  header.push(`Bot details — page ${page}/${pageCount} (${roster.length} matching bots; 10 per page):`);
  header.push(...rows);
  if (page < pageCount) header.push(`Next page: /playerbots ops ${page + 1}${filterSystemID ? ` system ${filterSystemID}` : ""}.`);
  if (page > 1) header.push(`Previous page: /playerbots ops ${page - 1}${filterSystemID ? ` system ${filterSystemID}` : ""}.`);
  header.push("Use /playerbots op status <bot> for full operation history; locations and task state above are current runtime reads.");
  return header.join("\n");
}

module.exports = {
  _testing: {
    ensureActiveBotStep,
    runIdleRosterDirectorBatch,
    directorThinkDelayMs,
    botStepJitterMs,
    configuredCycleIntervalMs,
    createDirectorThinkJob,
  },
  CYCLE_INTERVAL_MS,
  JOB_TYPE,
  INDUSTRY_CYCLE_JOB_TYPE,
  NAVIGATION_JOB_TYPE,
  DIRECTOR_THINK_JOB_TYPE,
  ensureIndustryCycleStep,
  ensurePendingDirectorThinkJobs,
  wakeIndustryCycleStep,
  wakeDirectorThinkStep,
  ensureNavigationTask,
  ensurePendingIndustryCycles,
  ensurePendingNavigationTasks,
  formatAutonomyStatus,
  handleIndustryCycleJob: measuredJobHandler(handleIndustryCycleJob),
  handleDirectorThinkJob: measuredJobHandler(handleDirectorThinkJob),
  handleNavigationJob: measuredJobHandler(handleNavigationJob),
  getAutonomySnapshot,
  isExternalAddonMode,
  aggregateAddonCycleSnapshots,
  runAutonomyChunk,
  publishAutonomySnapshot: saveAutonomySnapshot,
  handleJob: measuredJobHandler(handleJob),
  reconcile,
  runAutonomyCycle,
  bindDurableScheduler(scheduler) {
    if (!scheduler || typeof scheduler.schedule !== "function" || typeof scheduler.list !== "function") {
      throw new TypeError("playerbot autonomy requires a durable scheduler");
    }
    durableScheduler = scheduler;
  },
  getBoundDurableScheduler() {
    return durableScheduler;
  },
  unbindDurableScheduler(scheduler) {
    if (durableScheduler === scheduler) durableScheduler = null;
  },
};

"use strict";

const { createTableRepository } = require("../../gameStore/tableRepository");

const TABLE = "playerBots";
const STORAGE_PATH = "/_tasks";
const MAX_ATTEMPTS = 3;
const LEASE_MS = 60_000;
const HISTORY_LIMIT = 500;
const repo = createTableRepository("service:playerbots", { strict: true });
const queueTaskMapsOwnedByWrite = new WeakSet();

function readQueue() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, STORAGE_PATH);
  const data = result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
  const tasks = data.tasks && typeof data.tasks === "object" ? data.tasks : {};
  const queue = {
    nextSequence: Math.max(1, Math.trunc(Number(data.nextSequence) || 1)),
    // Reads share GameStore's cached map. The write path creates a shallow
    // copy on its first mutation, so read-only checks don't copy queue history.
    tasks,
  };
  return queue;
}

function mutableTaskMap(queue) {
  if (!queueTaskMapsOwnedByWrite.has(queue)) {
    queue.tasks = { ...queue.tasks };
    queueTaskMapsOwnedByWrite.add(queue);
  }
  return queue.tasks;
}

function cloneTask(task) {
  return task && typeof task === "object"
    ? JSON.parse(JSON.stringify(task))
    : null;
}

function mutableTask(queue, taskID) {
  const key = String(taskID || "").trim().toUpperCase();
  const current = queue.tasks[key];
  if (!current || typeof current !== "object") return null;
  const task = { ...current };
  mutableTaskMap(queue)[key] = task;
  return task;
}

function insertTask(queue, taskID, task) {
  mutableTaskMap(queue)[String(taskID)] = task;
}

function saveQueue(queue) {
  // Every caller writes only after a durable queue change. The queue can hold
  // hundreds of retained tasks, so do not deep-compare the entire subtree to
  // rediscover that fact before persistence.
  const result = repo.write(TABLE, STORAGE_PATH, queue, { force: true });
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_TASK_QUEUE_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_TASK_QUEUE_FLUSH_FAILED");
  }
  return queue;
}

function normalizeTaskKind(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9.-]/g, "");
}

function pruneHistory(queue) {
  const completed = Object.values(queue.tasks)
    .filter((task) => task && ["completed", "failed", "canceled"].includes(task.status))
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt));
  const expired = completed.slice(HISTORY_LIMIT);
  if (!expired.length) return;
  const tasks = mutableTaskMap(queue);
  for (const task of expired) delete tasks[task.taskID];
}

function enqueueTasks(entries = []) {
  const queue = readQueue();
  let changed = false;
  const results = [];
  for (const rawOptions of entries) {
    const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
    const kind = normalizeTaskKind(options.kind);
    const capability = String(options.capability || "").trim().toLowerCase();
    if (!kind || !capability) throw new Error("PLAYERBOT_TASK_KIND_AND_CAPABILITY_REQUIRED");
    const resourceOwnerCharacterID = Math.trunc(Number(options.resourceOwnerCharacterID) || 0);
    const dedupeKey = String(options.dedupeKey || "").trim().slice(0, 180) || null;
    const duplicate = dedupeKey && Object.values(queue.tasks).find((task) =>
      task && task.dedupeKey === dedupeKey && ["queued", "leased"].includes(task.status),
    );
    if (duplicate) {
      results.push({ created: false, task: cloneTask(duplicate) });
      continue;
    }
    const now = new Date().toISOString();
    const sequence = queue.nextSequence++;
    const taskID = `PB${String(sequence).padStart(8, "0")}`;
    const task = {
      taskID,
      kind,
      capability,
      status: "queued",
      priority: Math.max(-100, Math.min(100, Math.trunc(Number(options.priority) || 0))),
      targetCharacterID: resourceOwnerCharacterID || null,
      resourceOwnerCharacterID: resourceOwnerCharacterID || null,
      requestedByCharacterID: Math.trunc(Number(options.requestedByCharacterID) || 0) || null,
      requestedBy: options.requestedBy === "system" ? "system" : "player",
      dedupeKey,
      payload: options.payload && typeof options.payload === "object" ? options.payload : {},
      providerCharacterID: null,
      leaseToken: null,
      leaseExpiresAtMs: null,
      attempts: 0,
      failureCount: 0,
      nextAttemptAtMs: null,
      result: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    insertTask(queue, taskID, task);
    changed = true;
    results.push({ created: true, task: cloneTask(task) });
  }
  pruneHistory(queue);
  if (changed) saveQueue(queue);
  return results;
}

function enqueueTask(options = {}) {
  return enqueueTasks([options])[0];
}

function listTasks(options = {}) {
  const status = String(options.status || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(options.limit) || 25)));
  const tasks = readQueue().tasks;
  return Object.values(tasks)
    .filter((task) => task && (!status || task.status === status))
    .sort((left, right) => {
      const leftActive = ["queued", "leased"].includes(left.status);
      const rightActive = ["queued", "leased"].includes(right.status);
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (leftActive && Number(left.priority) !== Number(right.priority)) {
        return Number(right.priority) - Number(left.priority);
      }
      return Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt);
    })
    .slice(0, limit)
    .map(cloneTask);
}

// Compact all-queue projection for the operator dashboard. Unlike listTasks,
// this counts the complete queue without cloning its retained task history.
function getDashboardTaskSummary() {
  const queue = readQueue().tasks;
  const byStatus = {};
  const byKind = {};
  const byCharacter = {};
  let total = 0;
  for (const task of Object.values(queue)) {
    if (!task || typeof task !== "object") continue;
    total += 1;
    const status = String(task.status || "unknown");
    const kind = String(task.kind || "other");
    byStatus[status] = (byStatus[status] || 0) + 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (!(["queued", "leased"].includes(status))) continue;
    const characterIDs = new Set([
      Number(task.providerCharacterID) || 0,
      Number(task.resourceOwnerCharacterID) || 0,
      Number(task.targetCharacterID) || 0,
    ].filter((id) => Number.isSafeInteger(id) && id > 0));
    for (const characterID of characterIDs) {
      const rows = byCharacter[String(characterID)] || (byCharacter[String(characterID)] = []);
      if (rows.length >= 3) continue;
      rows.push({
        taskID: String(task.taskID || ""),
        kind,
        status,
        stage: String(task.progress && (task.progress.phase || task.progress.stage) || ""),
        updatedAt: String(task.updatedAt || task.createdAt || ""),
      });
    }
  }
  return { total, byStatus, byKind, byCharacter };
}

function getTask(taskID) {
  return cloneTask(readQueue().tasks[String(taskID || "").trim().toUpperCase()]);
}

function getAvailableProviders(task, bots) {
  let candidates = bots.filter((bot) =>
    bot && Number(bot.characterID) > 0 && bot.status !== "paused" &&
    bot.autonomyPaused !== true && !bot.currentTask,
  );
  if (task.resourceOwnerCharacterID) {
    candidates = candidates.filter((bot) =>
      Number(bot.characterID) === Number(task.resourceOwnerCharacterID),
    );
    return candidates;
  }

  const specialists = candidates.filter((bot) => bot.specialty === task.capability);
  const specialistCorps = specialists.filter((bot) =>
    Number(bot.corporationID) === Number(bot.specialtyCorporationID),
  );
  const preferred = specialistCorps.length ? specialistCorps : specialists;
  if (preferred.length) {
    const preferredIDs = new Set(preferred.map((bot) => Number(bot.characterID)));
    candidates = [
      ...preferred,
      ...candidates.filter((bot) => !preferredIDs.has(Number(bot.characterID))),
    ];
  }
  return candidates.sort((left, right) => {
    const leftSpecialist = left.specialty === task.capability ? 0 : 1;
    const rightSpecialist = right.specialty === task.capability ? 0 : 1;
    return leftSpecialist - rightSpecialist ||
      (Number(left.lastTaskAssignedAtMs) || 0) - (Number(right.lastTaskAssignedAtMs) || 0) ||
      Number(left.characterID) - Number(right.characterID);
  });
}

function reconcileLeases(options = {}) {
  const requestedNow = typeof options === "number" ? options : Number(options.nowMs);
  const nowMs = Number.isFinite(requestedNow)
    ? Math.max(0, Math.trunc(requestedNow))
    : Date.now();
  const forceRecovery = typeof options === "object" && options.force === true;
  const queue = readQueue();
  const bots = require("./playerBotRuntime").listBots();
  const botByID = new Map(bots.map((bot) => [Number(bot.characterID), bot]));
  let recovered = 0;
  for (const [taskID, task] of Object.entries(queue.tasks)) {
    if (!task || task.status !== "leased") continue;
    const leaseExpired = forceRecovery || Number(task.leaseExpiresAtMs) <= nowMs;
    const inFlightPlanetaryExport = task.kind === "playerbot.planetary.autoexport" &&
      task.progress && task.progress.phase === "launching";
    // A live launch may still be inside the normal PI authority call. Keep its
    // lease until it expires; startup recovery can reconcile it immediately.
    if (inFlightPlanetaryExport && !leaseExpired) continue;
    const provider = botByID.get(Number(task.providerCharacterID));
    const providerUnavailable = !provider || provider.status === "paused" || provider.autonomyPaused === true;
    if (!leaseExpired && !providerUnavailable) continue;
    const changedTask = mutableTask(queue, taskID);
    changedTask.lastError = providerUnavailable ? "provider unavailable during reconciliation" : "task lease expired";
    changedTask.updatedAt = new Date(nowMs).toISOString();
    changedTask.providerCharacterID = null;
    changedTask.leaseToken = null;
    changedTask.leaseExpiresAtMs = null;
    changedTask.status = changedTask.kind === "playerbot.space.route" || inFlightPlanetaryExport
      ? "queued"
      : Number(changedTask.attempts) >= MAX_ATTEMPTS ? "failed" : "queued";
    if (provider && String(provider.currentTask || "") === String(changedTask.taskID)) {
      require("./playerBotRuntime").setBotAutonomyState(provider.characterID, {
        status: "idle",
        currentTask: null,
      });
    }
    recovered += 1;
  }
  if (recovered) {
    pruneHistory(queue);
    saveQueue(queue);
  }
  return { recovered };
}

function claimNextTask(options = {}) {
  const supportedKinds = new Set((options.supportedKinds || []).map(normalizeTaskKind));
  if (!supportedKinds.size) return null;
  const excludedTaskIDs = new Set((Array.isArray(options.excludeTaskIDs) ? options.excludeTaskIDs : [])
    .map((taskID) => String(taskID || "").trim().toUpperCase()));
  const allowedProviderIDs = Array.isArray(options.providerCharacterIDs)
    ? new Set(options.providerCharacterIDs.map((characterID) => Math.trunc(Number(characterID) || 0)))
    : null;
  if (options.skipReconcile !== true) reconcileLeases();
  const queue = readQueue();
  const bots = require("./playerBotRuntime").listBots();
  const tasks = Object.values(queue.tasks)
    .filter((task) => task && task.status === "queued" && supportedKinds.has(task.kind) &&
      !excludedTaskIDs.has(String(task.taskID || "").toUpperCase()) &&
      (!options.taskID || task.taskID === String(options.taskID).trim().toUpperCase()) &&
      (!Number(task.nextAttemptAtMs) || Number(task.nextAttemptAtMs) <= Date.now()))
    .sort((left, right) => Number(right.priority) - Number(left.priority) || Date.parse(left.createdAt) - Date.parse(right.createdAt));
  for (const task of tasks) {
    const provider = getAvailableProviders(task, bots).find((candidate) =>
      (!allowedProviderIDs || allowedProviderIDs.has(Number(candidate.characterID))) &&
      !require("./playerBotInterruptRuntime").hasPending(candidate.characterID) &&
      !require("./playerBotLocalDefenseAdapter").hasLease(candidate.characterID) &&
      !require("./playerBotInterruptRuntime").isBusy(candidate.characterID),
    );
    if (!provider) continue;
    const leasedTask = mutableTask(queue, task.taskID);
    const nowMs = Date.now();
    const token = `${leasedTask.taskID}:${Number(leasedTask.attempts) + 1}:${nowMs}`;
    leasedTask.status = "leased";
    leasedTask.providerCharacterID = Number(provider.characterID);
    leasedTask.leaseToken = token;
    leasedTask.leaseExpiresAtMs = nowMs + LEASE_MS;
    leasedTask.attempts = Number(leasedTask.attempts) + 1;
    leasedTask.updatedAt = new Date(nowMs).toISOString();
    saveQueue(queue);
    require("./playerBotRuntime").setBotAutonomyState(provider.characterID, {
      status: "working",
      currentTask: leasedTask.taskID,
      lastTaskAssignedAtMs: Math.max(
        nowMs,
        (Number(provider.lastTaskAssignedAtMs) || 0) + 1,
      ),
      lastTaskID: leasedTask.taskID,
    });
    return { task: cloneTask(leasedTask), provider };
  }
  return null;
}

function releaseProvider(task) {
  if (!task || !task.providerCharacterID) return;
  const provider = require("./playerBotRuntime").listBots().find((bot) =>
    Number(bot.characterID) === Number(task.providerCharacterID),
  );
  if (!provider) return;
  if (String(provider.currentTask || "") === String(task.taskID)) {
    require("./playerBotRuntime").setBotAutonomyState(provider.characterID, {
      status: provider.autonomyPaused ? "paused" : "idle",
      currentTask: null,
    });
  }
}

function completeTask(taskID, leaseToken, result = {}) {
  const queue = readQueue();
  const key = String(taskID || "").trim().toUpperCase();
  const current = queue.tasks[key];
  if (!current || current.status !== "leased" || current.leaseToken !== leaseToken) {
    return { success: false, stale: true };
  }
  const task = mutableTask(queue, key);
  task.status = "completed";
  task.result = result && typeof result === "object" ? result : { value: String(result) };
  task.lastError = null;
  task.updatedAt = new Date().toISOString();
  task.leaseToken = null;
  task.leaseExpiresAtMs = null;
  releaseProvider(task);
  task.providerCharacterID = null;
  pruneHistory(queue);
  saveQueue(queue);
  return { success: true, task: cloneTask(task) };
}

function updateTaskProgress(taskID, leaseToken, progress = {}) {
  const queue = readQueue();
  const key = String(taskID || "").trim().toUpperCase();
  const current = queue.tasks[key];
  if (!current || current.status !== "leased" || current.leaseToken !== leaseToken) {
    return { success: false, stale: true };
  }
  const task = mutableTask(queue, key);
  task.progress = {
    ...(task.progress && typeof task.progress === "object" ? task.progress : {}),
    ...(progress && typeof progress === "object" ? progress : {}),
  };
  task.updatedAt = new Date().toISOString();
  saveQueue(queue);
  return { success: true, task: cloneTask(task) };
}

function deferTask(taskID, leaseToken, options = {}) {
  const queue = readQueue();
  const key = String(taskID || "").trim().toUpperCase();
  const current = queue.tasks[key];
  if (!current || current.status !== "leased" || current.leaseToken !== leaseToken) {
    return { success: false, stale: true };
  }
  const task = mutableTask(queue, key);
  const nowMs = Date.now();
  const delayMs = Math.max(1000, Math.min(10 * 60 * 1000, Math.trunc(Number(options.delayMs) || 15_000)));
  task.status = "queued";
  if (!Number.isFinite(Number(task.failureCount))) {
    task.failureCount = Math.max(0, Number(task.attempts || 0) - 1);
  }
  task.nextAttemptAtMs = nowMs + delayMs;
  task.progress = {
    ...(task.progress && typeof task.progress === "object" ? task.progress : {}),
    ...(options.progress && typeof options.progress === "object" ? options.progress : {}),
  };
  task.lastError = null;
  task.updatedAt = new Date(nowMs).toISOString();
  task.leaseToken = null;
  task.leaseExpiresAtMs = null;
  releaseProvider(task);
  task.providerCharacterID = null;
  saveQueue(queue);
  return { success: true, task: cloneTask(task) };
}

function failTask(taskID, leaseToken, error) {
  const queue = readQueue();
  const key = String(taskID || "").trim().toUpperCase();
  const current = queue.tasks[key];
  if (!current || current.status !== "leased" || current.leaseToken !== leaseToken) {
    return { success: false, stale: true };
  }
  const task = mutableTask(queue, key);
  const legacyFailureCount = Math.max(0, Number(task.attempts || 0) - 1);
  const previousFailureCount = Number(task.failureCount);
  task.failureCount = (Number.isFinite(previousFailureCount)
    ? Math.max(0, Math.trunc(previousFailureCount))
    : legacyFailureCount) + 1;
  task.status = task.failureCount >= MAX_ATTEMPTS ? "failed" : "queued";
  task.nextAttemptAtMs = null;
  task.lastError = String(error && error.message || error || "unknown error").slice(0, 300);
  task.updatedAt = new Date().toISOString();
  task.leaseToken = null;
  task.leaseExpiresAtMs = null;
  releaseProvider(task);
  task.providerCharacterID = null;
  pruneHistory(queue);
  saveQueue(queue);
  return { success: true, task: cloneTask(task) };
}

function pauseBot(bot) {
  if (!bot || !Number(bot.characterID)) return { success: false, message: "PLAYERBOT_NOT_FOUND" };
  const result = require("./playerBotRuntime").setBotAutonomyState(bot.characterID, {
    paused: true,
    status: "paused",
  });
  if (!result.success) return result;
  const queue = readQueue();
  let released = 0;
  let inFlightTaskID = null;
  for (const [taskID, task] of Object.entries(queue.tasks)) {
    if (!task || task.status !== "leased" || Number(task.providerCharacterID) !== Number(bot.characterID)) continue;
    if (
      task.kind === "playerbot.planetary.autoexport" &&
      task.progress && task.progress.phase === "launching"
    ) {
      inFlightTaskID = task.taskID;
      continue;
    }
    const changedTask = mutableTask(queue, taskID);
    changedTask.status = "queued";
    changedTask.providerCharacterID = null;
    changedTask.leaseToken = null;
    changedTask.leaseExpiresAtMs = null;
    changedTask.lastError = "provider paused by operator";
    changedTask.updatedAt = new Date().toISOString();
    released += 1;
  }
  require("./playerBotRuntime").setBotAutonomyState(bot.characterID, {
    currentTask: inFlightTaskID,
  });
  if (released) saveQueue(queue);
  return { success: true, released };
}

function resumeBot(bot) {
  if (!bot || !Number(bot.characterID)) return { success: false, message: "PLAYERBOT_NOT_FOUND" };
  const result = require("./playerBotRuntime").setBotAutonomyState(bot.characterID, {
    paused: false,
    status: "idle",
    currentTask: null,
  });
  if (result.success) {
    Promise.resolve(require("./playerBotAutonomyRuntime").ensurePendingNavigationTasks())
      .catch((error) => require("../../utils/logger").warn(
        `[PlayerBots] Navigation wake failed after resume char=${bot.characterID}: ${error.message}`,
      ));
  }
  return result;
}

function pauseBotsInCorporation(corporationID) {
  const normalizedCorporationID = Math.trunc(Number(corporationID) || 0);
  if (!normalizedCorporationID) return { success: false, message: "PLAYERBOT_CORPORATION_ID_REQUIRED" };
  const bots = require("./playerBotRuntime").listBots().filter((bot) =>
    Number(bot.corporationID) === normalizedCorporationID,
  );
  if (!bots.length) return { success: true, affected: 0, releasedTasks: 0 };
  let affected = 0;
  let releasedTasks = 0;
  const errors = [];
  for (const bot of bots) {
    try {
      const result = pauseBot(bot);
      if (!result.success) {
        errors.push(`${bot.characterName}:${result.message || "pause failed"}`);
        continue;
      }
      affected += 1;
      releasedTasks += Number(result.released) || 0;
    } catch (error) {
      errors.push(`${bot.characterName}:${String(error && error.message || error).slice(0, 160)}`);
    }
  }
  return {
    success: errors.length === 0,
    affected,
    releasedTasks,
    errors,
  };
}

function resumeBotsInCorporation(corporationID) {
  const normalizedCorporationID = Math.trunc(Number(corporationID) || 0);
  if (!normalizedCorporationID) return { success: false, message: "PLAYERBOT_CORPORATION_ID_REQUIRED" };
  const bots = require("./playerBotRuntime").listBots().filter((bot) =>
    Number(bot.corporationID) === normalizedCorporationID,
  );
  if (!bots.length) return { success: true, affected: 0 };
  let affected = 0;
  const errors = [];
  for (const bot of bots) {
    try {
      const result = resumeBot(bot);
      if (!result.success) {
        errors.push(`${bot.characterName}:${result.message || "resume failed"}`);
        continue;
      }
      affected += 1;
    } catch (error) {
      errors.push(`${bot.characterName}:${String(error && error.message || error).slice(0, 160)}`);
    }
  }
  return { success: errors.length === 0, affected, errors };
}

function retryTask(taskID) {
  const queue = readQueue();
  const key = String(taskID || "").trim().toUpperCase();
  const current = queue.tasks[key];
  if (!current) return { success: false, message: "Task not found." };
  if (current.status !== "failed") {
    return { success: false, message: `Only failed tasks can be retried; this task is ${current.status}.` };
  }
  if (
    current.kind === "playerbot.trade.autobuy" ||
    (current.progress && current.progress.phase === "buying") ||
    (current.result && current.result.outcomeUnknown === true &&
      current.kind !== "playerbot.planetary.autoexport")
  ) {
    return {
      success: false,
      message: "This operation will not be retried automatically. Check the wallet and inventory outcome before setting up a new policy.",
    };
  }
  if (
    current.kind === "playerbot.planetary.autoexport" &&
    ((current.result && current.result.outcomeUnknown === true) ||
      (current.progress && current.progress.result && current.progress.result.outcomeUnknown === true))
  ) {
    return {
      success: false,
      message: "This uncertain PI launch will not be retried. Reconcile the Command Center, launch containers, and bot wallet before setting up a new policy.",
    };
  }
  const task = mutableTask(queue, key);
  task.status = "queued";
  task.attempts = 0;
  task.failureCount = 0;
  task.nextAttemptAtMs = null;
  task.providerCharacterID = null;
  task.leaseToken = null;
  task.leaseExpiresAtMs = null;
  task.result = null;
  task.lastError = null;
  task.updatedAt = new Date().toISOString();
  saveQueue(queue);
  if (task.kind === "playerbot.space.route") {
    Promise.resolve(require("./playerBotAutonomyRuntime").ensureNavigationTask(task.taskID))
      .catch((error) => require("../../utils/logger").warn(
        `[PlayerBots] Navigation wake failed after retry task=${task.taskID}: ${error.message}`,
      ));
  }
  return { success: true, task: cloneTask(task) };
}

function cancelTask(taskID) {
  const queue = readQueue();
  const key = String(taskID || "").trim().toUpperCase();
  const current = queue.tasks[key];
  if (!current) return { success: false, message: "Task not found." };
  if (!["queued", "leased"].includes(current.status)) {
    return { success: false, message: `Task ${current.taskID} is already ${current.status}.` };
  }
  if (current.status === "leased" && String(current.kind || "").startsWith("playerbot.trade.")) {
    return {
      success: false,
      message: "The market operation is running or being reconciled. Disable its policy and let it finish before canceling queued tasks.",
    };
  }
  if (
    current.kind === "playerbot.planetary.autoexport" &&
    ((current.progress && current.progress.phase === "launching") ||
      (current.result && current.result.outcomeUnknown === true) ||
      (current.progress && current.progress.result && current.progress.result.outcomeUnknown === true))
  ) {
    return {
      success: false,
      message: "The PI launch has started and must finish or be reconciled before the task can be canceled.",
    };
  }
  if (
    String(current.kind || "") === "playerbot.trade.autobuy" &&
    current.progress && current.progress.phase === "buying"
  ) {
    return {
      success: false,
      message: "The purchase reached its execution point and must be reconciled; do not cancel this task until automatic review finishes.",
    };
  }
  const task = mutableTask(queue, key);
  releaseProvider(task);
  task.status = "canceled";
  task.nextAttemptAtMs = null;
  task.lastError = "canceled by operator";
  task.updatedAt = new Date().toISOString();
  task.providerCharacterID = null;
  task.leaseToken = null;
  task.leaseExpiresAtMs = null;
  pruneHistory(queue);
  saveQueue(queue);
  return { success: true, task: cloneTask(task) };
}

function requestExtractorMaintenance(bot, requesterCharacterID = null) {
  if (!bot || !Number(bot.characterID)) throw new Error("PLAYERBOT_NOT_FOUND");
  const maintenance = require("../planet/planetRuntimeStore").getExtractorMaintenanceCandidatesForCharacter(bot.characterID);
  if (!maintenance.planetIDs.length) {
    return {
      created: false,
      task: null,
      message: `${bot.characterName} has no expired extractors that need maintenance.`,
    };
  }
  return enqueueTask({
    kind: "planetary.extractor-maintenance",
    capability: "planetary",
    resourceOwnerCharacterID: Number(bot.characterID),
    requestedBy: requesterCharacterID ? "player" : "system",
    requestedByCharacterID: requesterCharacterID,
    dedupeKey: `planetary.extractor-maintenance:${Number(bot.characterID)}`,
    payload: { characterID: Number(bot.characterID), planetIDs: maintenance.planetIDs },
  });
}

function requestExtractorMaintenanceBatch(bots = []) {
  const planetRuntime = require("../planet/planetRuntimeStore");
  const work = [];
  const eligibleBots = (Array.isArray(bots) ? bots : []).filter((bot) =>
    bot && Number(bot.characterID) > 0,
  );
  const maintenance = planetRuntime.getExtractorMaintenanceCandidatesForCharacters(
    eligibleBots.map((bot) => bot.characterID),
  );
  const coloniesByCharacter = maintenance.coloniesByCharacter;
  const planetIDsByCharacter = maintenance.planetIDsByCharacter;
  const colonyCount = Object.values(coloniesByCharacter)
    .reduce((total, count) => total + (Number(count) || 0), 0);
  for (const bot of eligibleBots) {
    const characterID = Number(bot.characterID);
    const planetIDs = planetIDsByCharacter[characterID] || [];
    if (!planetIDs.length) continue;
    work.push({
      kind: "planetary.extractor-maintenance",
      capability: "planetary",
      resourceOwnerCharacterID: characterID,
      requestedBy: "system",
      dedupeKey: `planetary.extractor-maintenance:${characterID}`,
      payload: { characterID, planetIDs },
    });
  }
  return { colonyCount, coloniesByCharacter, tasks: enqueueTasks(work) };
}

module.exports = {
  hasBlockingLease(characterID) {
    return Object.values(readQueue().tasks).some(task => task?.status === "leased" &&
      Number(task.providerCharacterID) === Number(characterID) && task.kind !== "playerbot.space.route");
  },
  MAX_ATTEMPTS,
  cancelTask,
  claimNextTask,
  completeTask,
  deferTask,
  enqueueTask,
  enqueueTasks,
  failTask,
  getTask,
  getDashboardTaskSummary,
  listTasks,
  pauseBotsInCorporation,
  pauseBot,
  reconcileLeases,
  requestExtractorMaintenance,
  requestExtractorMaintenanceBatch,
  resumeBot,
  resumeBotsInCorporation,
  retryTask,
  updateTaskProgress,
};

"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "scheduler";

const crypto = require("node:crypto");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  installProcessLifecycleLogging,
} = require(path.join(__dirname, "../../utils/processLifecycle"));

installProcessLifecycleLogging({
  appName: "eve.js durable scheduler",
  signals: [],
});

const database = require(path.join(__dirname, "../../gameStore"));
require(path.join(__dirname, "../../gameStore/ownerProcessShutdown"))
  .installOwnerProcessShutdown(database);
const { createOrderedProcessHost } = require(path.join(
  __dirname,
  "../_shared/orderedProcessHost",
));

const TABLE_NAME = "scheduledJobs";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_DISPATCH = 16;
const MAX_SCHEDULE_BATCH_SIZE = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// A job that cannot succeed used to retry forever. With the backoff capped at
// 256s that is ~15 attempts/hour of invisible failure -- one settlement job
// reached attempt 297 over 20 hours without a single log line, while its
// pending record silently blocked every later operation for that character.
// Past this ceiling a job stops being rescheduled and parks in "dead-letter",
// where it keeps its payload and lastError for a recovery pass to inspect.
// Nothing revives a dead-lettered job automatically: re-`schedule` (which
// resets attempt) or `cancel` are the only ways out, so the ceiling cannot
// become a retry loop of its own.
// Overridable so a test can reach the ceiling without paying 25 durable
// round-trips; production never sets it.
const DEAD_LETTER_ATTEMPT_CEILING = Math.max(
  1,
  Math.trunc(Number(process.env.EVEJS_SCHEDULER_DEAD_LETTER_ATTEMPTS)) || 25,
);
// Shared with the owners that read this state back out of `list()`; see
// scheduledJobStates.js for why it cannot be spelled twice.
const { DEAD_LETTER_JOB_STATE: DEAD_LETTER_STATE } = require(path.join(
  __dirname,
  "./scheduledJobStates",
));
const { listScheduledJobs } = require(path.join(__dirname, "./scheduledJobQuery"));
let publishEvent = null;
let timer = null;
let dispatchPaused = process.env.EVEJS_SCHEDULER_START_PAUSED === "1";
const MAX_CONCURRENT_DISPATCH = Math.max(
  1,
  Math.min(128, Math.trunc(Number(process.env.EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH)) || DEFAULT_MAX_CONCURRENT_DISPATCH),
);

function cloneValue(value) {
  return value === undefined || value === null
    ? value
    : typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
}

function normalizeJobID(value) {
  const jobID = String(value || "").trim();
  if (!jobID || jobID.length > 320) {
    const error = new Error("Scheduled job ID is invalid");
    error.code = "SCHEDULED_JOB_ID_INVALID";
    throw error;
  }
  return jobID;
}

function normalizeType(value) {
  const type = String(value || "").trim();
  if (!type || type.length > 160) {
    const error = new Error("Scheduled job type is invalid");
    error.code = "SCHEDULED_JOB_TYPE_INVALID";
    throw error;
  }
  return type;
}

function normalizeDueAtMs(value) {
  const dueAtMs = Math.trunc(Number(value));
  if (!Number.isSafeInteger(dueAtMs) || dueAtMs < 0) {
    const error = new Error("Scheduled job due time is invalid");
    error.code = "SCHEDULED_JOB_DUE_INVALID";
    throw error;
  }
  return dueAtMs;
}

function readJobs() {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, "/");
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function readJob(jobID) {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, `/${normalizeJobID(jobID)}`);
  return result && result.success ? result.data : null;
}

function writeJob(jobID, job, { commit = true } = {}) {
  const result = database.write(TABLE_NAME, `/${jobID}`, cloneValue(job));
  if (!result || result.success !== true) {
    const error = new Error(result && result.errorMsg || "Scheduled job write failed");
    error.code = "SCHEDULED_JOB_WRITE_FAILED";
    throw error;
  }
  if (commit) commitJobs();
  return job;
}

function scheduleJobs(entries = []) {
  if (!Array.isArray(entries) || entries.length > MAX_SCHEDULE_BATCH_SIZE) {
    const error = new Error(`Scheduled job batch must contain at most ${MAX_SCHEDULE_BATCH_SIZE} jobs`);
    error.code = "SCHEDULED_JOB_BATCH_INVALID";
    throw error;
  }
  const normalized = entries.map((entry) => ({
    jobID: normalizeJobID(entry && entry.jobID),
    type: normalizeType(entry && entry.type),
    dueAtMs: normalizeDueAtMs(entry && entry.dueAtMs),
    payload: cloneValue(entry && entry.payload || {}),
  }));
  const results = [];
  let changed = 0;
  let earliestDueAtMs = Number.POSITIVE_INFINITY;
  for (const entry of normalized) {
    const current = readJob(entry.jobID);
    // Reasserting an identical active lease must not revoke the handler that
    // currently owns it. Identical scheduled work also needs no new write.
    if (
      current && current.state === "running" && current.leaseToken &&
      Number(current.leaseUntilMs || 0) > Date.now() &&
      current.type === entry.type && current.dueAtMs === entry.dueAtMs &&
      isDeepStrictEqual(current.payload, entry.payload)
    ) {
      results.push(cloneValue(current));
      continue;
    }
    if (
      current && current.state === "scheduled" &&
      current.type === entry.type && current.dueAtMs === entry.dueAtMs &&
      isDeepStrictEqual(current.payload, entry.payload)
    ) {
      results.push(cloneValue(current));
      continue;
    }
    const revived = Boolean(current && current.state === DEAD_LETTER_STATE);
    const next = {
      jobID: entry.jobID,
      type: entry.type,
      dueAtMs: entry.dueAtMs,
      payload: entry.payload,
      state: "scheduled",
      attempt: current && current.type === entry.type && !revived
        ? Number(current.attempt || 0)
        : 0,
      leaseToken: null,
      leaseUntilMs: 0,
      lastError: null,
      deadLetteredAtMs: 0,
      createdAtMs: current && current.createdAtMs || Date.now(),
      updatedAtMs: Date.now(),
    };
    writeJob(entry.jobID, next, { commit: false });
    results.push(cloneValue(next));
    changed += 1;
    earliestDueAtMs = Math.min(earliestDueAtMs, entry.dueAtMs);
  }
  if (changed > 0) {
    commitJobs();
    armTimerAt(earliestDueAtMs);
  }
  return { scheduled: changed, jobs: results };
}

function commitJobs() {
  const flush = database.flushTableSync(TABLE_NAME);
  if (!flush || flush.success !== true) {
    const error = new Error(flush && flush.errorMsg || "Scheduled job flush failed");
    error.code = "SCHEDULED_JOB_COMMIT_AMBIGUOUS";
    throw error;
  }
}

function removeJob(jobID) {
  const result = database.remove(TABLE_NAME, `/${jobID}`);
  if (result && result.success === false && result.errorMsg !== "ENTRY_NOT_FOUND") {
    const error = new Error(result.errorMsg || "Scheduled job remove failed");
    error.code = "SCHEDULED_JOB_REMOVE_FAILED";
    throw error;
  }
  if (!result || result.success !== false) {
    const flush = database.flushTableSync(TABLE_NAME);
    if (!flush || flush.success !== true) {
      const error = new Error(flush && flush.errorMsg || "Scheduled job remove flush failed");
      error.code = "SCHEDULED_JOB_COMMIT_AMBIGUOUS";
      throw error;
    }
  }
  return true;
}

function removeJobs(jobIDs = []) {
  const unique = [...new Set((Array.isArray(jobIDs) ? jobIDs : []).map(normalizeJobID))];
  let cancelled = 0;
  for (const jobID of unique) {
    const result = database.remove(TABLE_NAME, `/${jobID}`);
    if (result && result.success === false && result.errorMsg !== "ENTRY_NOT_FOUND") {
      const error = new Error(result.errorMsg || "Scheduled job remove failed");
      error.code = "SCHEDULED_JOB_REMOVE_FAILED";
      throw error;
    }
    if (!result || result.success !== false) cancelled += 1;
  }
  if (cancelled > 0) {
    const flush = database.flushTableSync(TABLE_NAME);
    if (!flush || flush.success !== true) {
      const error = new Error(flush && flush.errorMsg || "Scheduled job remove flush failed");
      error.code = "SCHEDULED_JOB_COMMIT_AMBIGUOUS";
      throw error;
    }
  }
  return cancelled;
}

function nextWakeAtMs(nowMs = Date.now()) {
  if (dispatchPaused) return null;
  const jobs = Object.values(readJobs()).filter(Boolean);
  const activeLeases = jobs.filter((job) =>
    job.state === "running" && Number(job.leaseUntilMs || 0) > nowMs,
  );
  const availableSlots = Math.max(0, MAX_CONCURRENT_DISPATCH - activeLeases.length);
  let next = Number.POSITIVE_INFINITY;
  for (const job of jobs) {
    if (job.state === DEAD_LETTER_STATE) continue;
    let candidate = Number.POSITIVE_INFINITY;
    if (job.state === "running") {
      const leaseUntilMs = Number(job.leaseUntilMs || 0);
      if (leaseUntilMs <= nowMs && availableSlots > 0) candidate = nowMs;
      else if (leaseUntilMs > nowMs) candidate = leaseUntilMs;
    } else if (job.state === "scheduled" && availableSlots > 0) {
      candidate = Number(job.dueAtMs || 0);
    }
    if (candidate >= 0 && candidate < next) next = candidate;
  }
  return Number.isFinite(next) ? Math.max(nowMs, next) : null;
}

let armedWakeAtMs = null;

function setWakeTimer(wakeAtMs) {
  if (timer) clearTimeout(timer);
  timer = null;
  armedWakeAtMs = null;
  if (wakeAtMs === null) return;
  const delayMs = Math.max(1, Math.min(MAX_TIMER_DELAY_MS, wakeAtMs - Date.now()));
  armedWakeAtMs = Date.now() + delayMs;
  timer = setTimeout(dispatchDueJobs, delayMs);
  if (typeof timer.unref === "function") timer.unref();
}

// Full scan: startup and after each dispatch pass.
function armTimer() {
  setWakeTimer(nextWakeAtMs());
}

// A new or changed job can only move the wake earlier. A removed or postponed
// job leaves the timer where it is; that wake finds nothing due and rescans.
function armTimerAt(wakeAtMs) {
  if (dispatchPaused) return;
  if (timer && armedWakeAtMs !== null && armedWakeAtMs <= wakeAtMs) return;
  setWakeTimer(Math.max(Date.now(), wakeAtMs));
}

function dispatchDueJobs() {
  if (dispatchPaused) return;
  timer = null;
  armedWakeAtMs = null;
  const leasedJobs = [];
  const nowMs = Date.now();
  const jobs = Object.values(readJobs())
    .filter(Boolean)
    .sort((left, right) => Number(left.dueAtMs) - Number(right.dueAtMs));
  const activeLeases = jobs.filter((job) =>
    job.state === "running" && Number(job.leaseUntilMs || 0) > nowMs,
  ).length;
  let availableSlots = Math.max(0, MAX_CONCURRENT_DISPATCH - activeLeases);
  for (const current of jobs) {
    if (availableSlots <= 0) break;
    let job = current;
    if (job.state === DEAD_LETTER_STATE) continue;
    if (job.state === "running") {
      if (Number(job.leaseUntilMs || 0) > nowMs) continue;
      job = {
        ...job,
        state: "scheduled",
        dueAtMs: nowMs,
        leaseToken: null,
        leaseUntilMs: 0,
      };
    }
    if (job.state !== "scheduled" || Number(job.dueAtMs) > nowMs) continue;
    const leased = {
      ...job,
      state: "running",
      attempt: Math.max(0, Math.trunc(Number(job.attempt) || 0)) + 1,
      leaseToken: crypto.randomUUID(),
      leaseUntilMs: nowMs + DEFAULT_LEASE_MS,
      updatedAtMs: nowMs,
    };
    writeJob(leased.jobID, leased, { commit: false });
    leasedJobs.push(leased);
    availableSlots -= 1;
  }
  // One commit for the whole pass, still before any lease is published.
  if (leasedJobs.length > 0) commitJobs();
  for (const leased of leasedJobs) {
    if (publishEvent) publishEvent("scheduler.due", cloneValue(leased));
  }
  armTimer();
}

function requireLease(payload = {}) {
  const jobID = normalizeJobID(payload.jobID);
  const current = readJob(jobID);
  if (!current || current.state !== "running" || current.leaseToken !== payload.leaseToken) {
    const error = new Error("Scheduled job lease is stale");
    error.code = "SCHEDULED_JOB_LEASE_STALE";
    throw error;
  }
  return current;
}

createOrderedProcessHost({
  authorityName: "scheduler",
  onStart({ publish }) {
    database.ensureTable(TABLE_NAME);
    publishEvent = publish;
    armTimer();
  },
  handleCommand(command, payload = {}) {
    if (command === "pauseDispatch") {
      dispatchPaused = true;
      if (timer) clearTimeout(timer);
      timer = null;
      armedWakeAtMs = null;
      return true;
    }
    if (command === "resumeDispatch") {
      dispatchPaused = false;
      armTimer();
      return true;
    }
    if (command === "cancelMany") {
      const cancelled = removeJobs(payload.jobIDs);
      armTimer();
      return { cancelled };
    }
    if (command === "schedule") {
      return scheduleJobs([payload]).jobs[0];
    }
    if (command === "scheduleMany") {
      return scheduleJobs(payload.jobs);
    }
    if (command === "cancel") {
      removeJob(normalizeJobID(payload.jobID));
      armTimer();
      return true;
    }
    if (command === "wakeEarlier") {
      // Check and update inside the sole scheduler owner. A job claimed between
      // a caller's list and this command keeps its live lease and handler.
      const jobID = normalizeJobID(payload.jobID);
      const dueAtMs = normalizeDueAtMs(payload.dueAtMs);
      const current = readJob(jobID);
      if (!current) return null;
      if (current.state !== "scheduled" || current.dueAtMs <= dueAtMs) return cloneValue(current);
      const next = { ...current, dueAtMs, updatedAtMs: Date.now() };
      writeJob(jobID, next);
      armTimerAt(dueAtMs);
      return cloneValue(next);
    }
    if (command === "renewLease") {
      const current = requireLease(payload);
      const nowMs = Date.now();
      const next = {
        ...current,
        leaseUntilMs: nowMs + DEFAULT_LEASE_MS,
        updatedAtMs: nowMs,
      };
      writeJob(current.jobID, next);
      armTimer();
      return cloneValue(next);
    }
    if (command === "ack") {
      const current = requireLease(payload);
      removeJob(current.jobID);
      armTimer();
      return true;
    }
    if (command === "validateLease") {
      requireLease(payload);
      return true;
    }
    if (command === "retry") {
      const current = requireLease(payload);
      const attempt = Math.max(0, Math.trunc(Number(current.attempt) || 0));
      const deadLettered = attempt >= DEAD_LETTER_ATTEMPT_CEILING;
      const next = {
        ...current,
        state: deadLettered ? DEAD_LETTER_STATE : "scheduled",
        dueAtMs: deadLettered
          ? Number(current.dueAtMs) || Date.now()
          : normalizeDueAtMs(payload.dueAtMs),
        leaseToken: null,
        leaseUntilMs: 0,
        lastError: String(payload.error || "").slice(0, 1000),
        deadLetteredAtMs: deadLettered
          ? Number(current.deadLetteredAtMs) || Date.now()
          : 0,
        updatedAtMs: Date.now(),
      };
      writeJob(current.jobID, next);
      if (!deadLettered) armTimerAt(next.dueAtMs);
      return cloneValue(next);
    }
    if (command === "get") {
      return cloneValue(readJob(payload.jobID) || null);
    }
    if (command === "list") {
      return listScheduledJobs(readJobs(), payload);
    }
    const error = new Error(`Unknown scheduler command: ${command}`);
    error.code = "SCHEDULER_COMMAND_UNKNOWN";
    throw error;
  },
  onShutdown() {
    if (timer) clearTimeout(timer);
    timer = null;
    return database.shutdown("scheduler-host");
  },
});

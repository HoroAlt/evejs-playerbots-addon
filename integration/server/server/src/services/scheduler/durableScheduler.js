"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const log = require(path.join(__dirname, "../../utils/logger"));
const { createOrderedProcessClient } = require(path.join(
  __dirname,
  "../_shared/orderedProcessClient",
));
const {
  configuredLeaseMs,
  recommendedOuterStartupTimeoutMs,
} = require(path.join(__dirname, "../../gameStore/persistenceLeasePolicy"));

// A handler that keeps throwing produced no output at all: the retry path only
// records lastError into the job row, and a handler whose failure is a *thrown*
// error (rather than a failure-shaped result) never reaches the domain's own
// retry reporting. Failures below this are ordinary transient noise; at or
// above it every retry says so, at the backoff's pace rather than per tick.
const RETRY_WARN_ATTEMPT = 5;
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS = 3;
const DEFAULT_MAX_CONCURRENT_DISPATCH = 16;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function createDurableScheduler(options = {}) {
  const handlers = new Map();
  const retryBaseMs = Math.max(10, Math.trunc(Number(options.retryBaseMs) || 1_000));
  const schedulerLog = options.logger || log;
  const orderedProcessClientFactory =
    options.orderedProcessClientFactory || createOrderedProcessClient;
  const persistenceOwnerInstanceId = String(
    options.persistenceOwnerInstanceId ||
      `scheduler-supervisor:${process.pid}:${crypto.randomUUID()}`,
  ).trim();
  if (!persistenceOwnerInstanceId) {
    throw new TypeError("durable scheduler requires a persistence owner instance ID");
  }
  const maxConcurrentDispatch = Math.min(128, positiveInteger(
    options.maxConcurrentDispatch ?? process.env.EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH,
    DEFAULT_MAX_CONCURRENT_DISPATCH,
  ));
  const leaseRenewIntervalMs = positiveInteger(
    options.leaseRenewIntervalMs,
    DEFAULT_LEASE_RENEW_INTERVAL_MS,
  );
  const childEnvironment = {
    ...(options.env && typeof options.env === "object" ? options.env : {}),
    EVEJS_GAMESTORE_OWNER_INSTANCE: persistenceOwnerInstanceId,
    EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH: String(maxConcurrentDispatch),
    EVEJS_SCHEDULER_START_PAUSED: options.startPaused === true ? "1" : "0",
  };
  const configuredAcquireWait =
    childEnvironment.EVEJS_PERSISTENCE_OWNER_ACQUIRE_WAIT_MS === undefined
      ? process.env.EVEJS_PERSISTENCE_OWNER_ACQUIRE_WAIT_MS
      : childEnvironment.EVEJS_PERSISTENCE_OWNER_ACQUIRE_WAIT_MS;
  const defaultStartupTimeoutMs = recommendedOuterStartupTimeoutMs(
    configuredLeaseMs(
      childEnvironment.EVEJS_PERSISTENCE_OWNER_LEASE_MS === undefined
        ? process.env.EVEJS_PERSISTENCE_OWNER_LEASE_MS
        : childEnvironment.EVEJS_PERSISTENCE_OWNER_LEASE_MS,
    ),
    configuredAcquireWait,
  );
  const restartDelayMs = positiveInteger(
    options.restartDelayMs,
    DEFAULT_RESTART_DELAY_MS,
  );
  const maxStartupRestartAttempts = positiveInteger(
    options.maxStartupRestartAttempts,
    DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS,
  );
  let closing = false;
  let desiredRunning = false;
  let state = "idle";
  let startPromise = null;
  let shutdownPromise = null;
  let restartTimer = null;
  let restartCount = 0;
  let startupRestartAttempts = 0;
  let lastExit = null;
  let lastRestartError = null;
  const staleLeaseInspectionLanes = new Map();
  const dispatchQueue = new Map();
  const activeDispatches = new Map();

  function drainDispatchQueue() {
    while (activeDispatches.size < maxConcurrentDispatch && dispatchQueue.size > 0) {
      let next = null;
      for (const [jobID, job] of dispatchQueue) {
        const activeLeaseToken = activeDispatches.get(jobID);
        if (activeLeaseToken && activeLeaseToken === job.leaseToken) {
          dispatchQueue.delete(jobID);
          continue;
        }
        if (activeLeaseToken) continue;
        next = [jobID, job];
        break;
      }
      if (!next) break;
      const [jobID, job] = next;
      dispatchQueue.delete(jobID);
      activeDispatches.set(jobID, job.leaseToken);
      void dispatch(job)
        .catch((error) => reportDispatchProtocolFailure(job, error))
        .finally(() => {
          if (activeDispatches.get(jobID) === job.leaseToken) activeDispatches.delete(jobID);
          drainDispatchQueue();
        });
    }
  }

  function clearRestartTimer() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function snapshotHealth() {
    return Object.freeze({
      desiredRunning,
      lastExit,
      lastRestartError,
      persistenceOwnerInstanceId,
      restartCount,
      startupRestartAttempts,
      state,
    });
  }

  function scheduleRestart(exit) {
    if (
      !desiredRunning || closing || restartTimer ||
      state === "closing" || state === "closed"
    ) {
      return;
    }
    state = "restarting";
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!desiredRunning || closing) return;
      restartCount += 1;
      void start().catch((error) => {
        lastRestartError = Object.freeze({
          code: String(error && error.code || "SCHEDULER_RESTART_FAILED"),
          message: String(error && error.message || error),
        });
        schedulerLog.error(
          `[DurableScheduler] process restart failed after unexpected exit ` +
            `(code=${exit.code == null ? "none" : exit.code} ` +
            `signal=${exit.signal || "none"}): ${lastRestartError.message}`,
        );
      });
    }, restartDelayMs);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  const client = orderedProcessClientFactory({
    authorityName: "scheduler",
    workerPath: path.join(__dirname, "durableSchedulerProcess.worker.js"),
    env: childEnvironment,
    maxPending: options.maxPending || 256,
    requestTimeoutMs: options.requestTimeoutMs || 10_000,
    startupTimeoutMs: positiveInteger(
      options.startupTimeoutMs,
      defaultStartupTimeoutMs,
    ),
    shutdownTimeoutMs: options.shutdownTimeoutMs || 10_000,
    onEvent(event) {
      if (event.topic !== "scheduler.due" || closing) return;
      const job = event.payload && typeof event.payload === "object" ? event.payload : null;
      const jobID = String(job && job.jobID || "").trim();
      if (!jobID) return;
      // Keep one newest lease event per job while the bounded dispatcher drains.
      dispatchQueue.set(jobID, job);
      drainDispatchQueue();
    },
    onExit(exit) {
      if (!exit || exit.unexpected !== true) return;
      lastExit = Object.freeze({ ...exit });
      const exitSummary =
        `[DurableScheduler] process exited unexpectedly ` +
        `(previousState=${exit.previousState || "unknown"} ` +
        `code=${exit.code == null ? "none" : exit.code} ` +
        `signal=${exit.signal || "none"})`;
      if (exit.previousState === "starting") {
        if (startupRestartAttempts >= maxStartupRestartAttempts) {
          state = "failed";
          schedulerLog.error(`${exitSummary}; startup restart limit reached`);
          return;
        }
        startupRestartAttempts += 1;
      } else if (exit.previousState === "ready") {
        startupRestartAttempts = 0;
      } else {
        state = "failed";
        schedulerLog.warn(`${exitSummary}; state is not restartable`);
        return;
      }
      schedulerLog.warn(`${exitSummary}; scheduling restart`);
      scheduleRestart(exit);
    },
  });

  function start() {
    desiredRunning = true;
    if (state === "started") return Promise.resolve(client.getStats());
    if (startPromise) return startPromise;
    if (closing || state === "closing" || state === "closed") {
      return Promise.reject(new Error("durable scheduler is shutting down"));
    }
    clearRestartTimer();
    state = "starting";
    startPromise = Promise.resolve()
      .then(() => client.start())
      .then((result) => {
        state = "started";
        startupRestartAttempts = 0;
        lastRestartError = null;
        return result;
      })
      .catch((error) => {
        state = desiredRunning && !closing
          ? (restartTimer ? "restarting" : "failed")
          : "closed";
        throw error;
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  function call(command, payload) {
    return start().then(() => client.call(command, payload));
  }

  async function inspectStaleLeaseReplacement(job) {
    const jobID = String(job && job.jobID || "unknown");
    const jobType = String(job && job.type || "unknown");
    try {
      const replacement = await call("get", { jobID });
      const replacementState = String(replacement && replacement.state || "");
      if (
        replacement &&
        String(replacement.type || "") === jobType &&
        ["running", "scheduled"].includes(replacementState) &&
        replacement.leaseToken !== (job && job.leaseToken)
      ) {
        schedulerLog.info(
          `[DurableScheduler] Superseded stale lease job=${jobID} ` +
            `type=${jobType} replacementState=${replacementState}; ` +
            `durable work remains queued`,
        );
        return;
      }
    } catch (_) {
      // ignored: if recovery cannot be proven, retain the warning below.
    }
    schedulerLog.warn(
      `[DurableScheduler] dispatch protocol failed job=${jobID} ` +
        "code=SCHEDULED_JOB_LEASE_STALE: Scheduled job lease is stale",
    );
  }

  function reportDispatchProtocolFailure(job, error) {
    if (error && error.code === "SCHEDULED_JOB_LEASE_STALE") {
      const inspectionKey = [
        String(job && job.jobID || "unknown"),
        String(job && job.type || "unknown"),
      ].join("\u001f");
      const existing = staleLeaseInspectionLanes.get(inspectionKey);
      if (existing) {
        return existing;
      }
      const inspection = inspectStaleLeaseReplacement(job).finally(() => {
        if (staleLeaseInspectionLanes.get(inspectionKey) === inspection) {
          staleLeaseInspectionLanes.delete(inspectionKey);
        }
      });
      staleLeaseInspectionLanes.set(inspectionKey, inspection);
      return inspection;
    }
    const jobID = String(job && job.jobID || "unknown");
    schedulerLog.warn(
      `[DurableScheduler] dispatch protocol failed job=${jobID} ` +
        `code=${String(error && error.code || "UNKNOWN")}: ` +
        `${String(error && error.message || "Unknown scheduler failure")}`,
    );
    return Promise.resolve();
  }

  async function dispatch(job) {
    // The lease is extended while a handler runs, so slow but healthy work does
    // not get dispatched again as another copy when it crosses the old 30s
    // deadline. Worker-side concurrency is bounded to match this dispatcher.
    let heartbeat = null;
    let renewing = false;
    try {
      await call("validateLease", {
        jobID: job.jobID,
        leaseToken: job.leaseToken,
      });
      heartbeat = setInterval(() => {
        if (renewing || closing) return;
        renewing = true;
        void call("renewLease", {
          jobID: job.jobID,
          leaseToken: job.leaseToken,
        }).catch((error) => {
          if (error && error.code === "SCHEDULED_JOB_LEASE_STALE") return;
          schedulerLog.warn(
            `[DurableScheduler] lease renewal failed job=${job.jobID} ` +
              `code=${String(error && error.code || "UNKNOWN")}: ` +
              `${String(error && error.message || "Unknown scheduler failure")}`,
          );
        }).finally(() => { renewing = false; });
      }, leaseRenewIntervalMs);
      if (typeof heartbeat.unref === "function") heartbeat.unref();
      const handler = handlers.get(String(job && job.type || ""));
      if (!handler) {
        await call("retry", {
          jobID: job.jobID,
          leaseToken: job.leaseToken,
          dueAtMs: Date.now() + retryBaseMs,
          error: `No handler registered for ${job.type}`,
        });
        return;
      }
      try {
        await handler(Object.freeze({
          attempt: Number(job.attempt || 0),
          dueAtMs: Number(job.dueAtMs || 0),
          jobID: String(job.jobID),
          payload: job.payload,
          type: String(job.type),
        }));
        await call("ack", {
          jobID: job.jobID,
          leaseToken: job.leaseToken,
        });
      } catch (error) {
        const attempt = Math.max(0, Number(job.attempt) || 0);
        const exponent = Math.min(8, Math.max(0, Number(job.attempt || 1) - 1));
        const errorMsg = error && error.message || "Scheduled handler failed";
        const retried = await call("retry", {
          jobID: job.jobID,
          leaseToken: job.leaseToken,
          dueAtMs: Date.now() + retryBaseMs * (2 ** exponent),
          error: errorMsg,
        });
        if (retried && retried.state === "dead-letter") {
          schedulerLog.error(
            `[DurableScheduler] Dead-lettered job=${job.jobID} type=${job.type} ` +
              `after ${attempt} attempts: ${errorMsg}. It will not run again until ` +
              `it is rescheduled or cancelled; its durable record still holds the ` +
              `work and needs operator or recovery-pass review`,
          );
          return;
        }
        if (attempt >= RETRY_WARN_ATTEMPT) {
          schedulerLog.warn(
            `[DurableScheduler] job=${job.jobID} type=${job.type} failed ` +
              `attempt=${attempt}: ${errorMsg}`,
          );
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  return Object.freeze({
    start,
    schedule: (job) => call("schedule", job),
    scheduleMany: (jobs = []) => {
      const normalized = Array.isArray(jobs) ? jobs : [];
      return normalized.length ? call("scheduleMany", { jobs: normalized }) :
        Promise.resolve({ scheduled: 0, jobs: [] });
    },
    cancel: (jobID) => call("cancel", { jobID }),
    wakeEarlier: (jobID, dueAtMs) => call("wakeEarlier", { jobID, dueAtMs }),
    list: (query = {}) => call("list", query && typeof query === "object" ? query : {}),
    register(type, handler) {
      const normalizedType = String(type || "").trim();
      if (!normalizedType || typeof handler !== "function") {
        throw new TypeError("scheduler handlers require a type and function");
      }
      if (handlers.has(normalizedType)) {
        throw new Error(`scheduler handler already registered: ${normalizedType}`);
      }
      handlers.set(normalizedType, handler);
      return () => handlers.delete(normalizedType);
    },
    getHealth: snapshotHealth,
    getStats: () => Object.freeze({
      ...client.getStats(),
      supervisor: snapshotHealth(),
      dispatch: Object.freeze({
        active: activeDispatches.size,
        queued: dispatchQueue.size,
        maxConcurrent: maxConcurrentDispatch,
      }),
    }),
    cancelMany(jobIDs = []) {
      const normalized = [...new Set((Array.isArray(jobIDs) ? jobIDs : [])
        .map((jobID) => String(jobID || "").trim())
        .filter(Boolean))];
      return normalized.length
        ? call("cancelMany", { jobIDs: normalized })
        : Promise.resolve({ cancelled: 0 });
    },
    resumeDispatch() { return call("resumeDispatch", {}); },
    pauseDispatch() { return call("pauseDispatch", {}); },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      desiredRunning = false;
      state = "closing";
      clearRestartTimer();
      shutdownPromise = (async () => {
        if (startPromise) await startPromise.catch(() => null);
        try {
          return await client.shutdown();
        } finally {
          state = "closed";
        }
      })();
      return shutdownPromise;
    },
  });
}

module.exports = { createDurableScheduler };

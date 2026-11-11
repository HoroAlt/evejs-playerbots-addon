"use strict";

// Deadline-grid driver for the 100 ms space tick. The deadline arithmetic
// (a late wake does not shift later deadlines, slots that elapsed during a
// stall are skipped and never replayed, and a tick never starts less than
// half an interval after the previous one) is adapted from
// runtimeTickScheduler.js in the X-Eve Living Universe server tree, which is
// licensed AGPL-3.0 like this add-on. See THIRD_PARTY_NOTICES.md.
//
// Only dispatch timing changes. Gameplay still reads the real clock.

const { performance } = require("node:perf_hooks");

function createTickScheduler(options = {}) {
  const intervalMs = Number(options.intervalMs ?? 100);
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError("intervalMs must be finite and at least 1");
  const mode = options.mode ?? "deadline";
  if (mode !== "deadline" && mode !== "interval") throw new RangeError("mode must be deadline or interval");
  if (typeof options.onTick !== "function") throw new TypeError("onTick must be a function");
  const now = options.now || (() => performance.now());
  const timers = {
    setTimeout: options.setTimeout || global.setTimeout,
    clearTimeout: options.clearTimeout || global.clearTimeout,
    setInterval: options.setInterval || global.setInterval,
    clearInterval: options.clearInterval || global.clearInterval,
  };

  let active = false;
  let unreferenced = false;
  let pending = null;
  let nextDueAt = null;
  const stats = {
    mode, intervalMs, ticks: 0, missedPeriods: 0, earlyWakeups: 0,
    maxLatenessMs: 0, lastLatenessMs: 0, tickErrors: 0,
  };

  function arm() {
    const delay = Math.max(0, nextDueAt - now());
    pending = timers.setTimeout(fire, delay);
    if (unreferenced && pending && typeof pending.unref === "function") pending.unref();
  }

  function advanceDeadline(startedAt, endedAt, dueAt) {
    let next = dueAt + intervalMs;
    let missed = 0;
    if (next <= endedAt) {
      const elapsed = Math.floor((endedAt - next) / intervalMs) + 1;
      next += elapsed * intervalMs;
      missed += elapsed;
    }
    const minimumStart = startedAt + (intervalMs / 2);
    if (next < minimumStart) {
      const clustered = Math.ceil((minimumStart - next) / intervalMs);
      next += clustered * intervalMs;
      missed += clustered;
    }
    nextDueAt = next;
    stats.missedPeriods += missed;
  }

  function fire() {
    pending = null;
    if (!active) return;
    const startedAt = now();
    const dueAt = nextDueAt;
    // Timers may fire a fraction early; wait out the remainder.
    if (startedAt < dueAt - 1) {
      stats.earlyWakeups += 1;
      arm();
      return;
    }
    stats.lastLatenessMs = Math.max(0, startedAt - dueAt);
    stats.maxLatenessMs = Math.max(stats.maxLatenessMs, stats.lastLatenessMs);
    stats.ticks += 1;
    try {
      options.onTick({ mode, dueAt, startedAt, index: stats.ticks });
    } catch (error) {
      // One failing tick must not stop the world; the interval timer it
      // replaces would have kept firing too.
      stats.tickErrors += 1;
      if (typeof options.onError === "function") options.onError(error);
    } finally {
      if (active) {
        advanceDeadline(startedAt, now(), dueAt);
        arm();
      }
    }
  }

  return {
    start() {
      if (active) return this;
      active = true;
      if (mode === "interval") {
        pending = timers.setInterval(() => {
          stats.ticks += 1;
          options.onTick({ mode, index: stats.ticks });
        }, intervalMs);
        if (unreferenced && pending && typeof pending.unref === "function") pending.unref();
        return this;
      }
      nextDueAt = now() + intervalMs;
      arm();
      return this;
    },
    stop() {
      active = false;
      const handle = pending;
      pending = null;
      if (handle !== null) (mode === "interval" ? timers.clearInterval : timers.clearTimeout)(handle);
    },
    unref() {
      unreferenced = true;
      if (pending && typeof pending.unref === "function") pending.unref();
      return this;
    },
    isActive: () => active,
    getStats: () => ({ ...stats }),
  };
}

function configuredMode(env = process.env) {
  return String(env.EVEJS_SPACE_TICK_SCHEDULER || "").trim().toLowerCase() === "interval" ? "interval" : "deadline";
}

module.exports = { configuredMode, createTickScheduler };

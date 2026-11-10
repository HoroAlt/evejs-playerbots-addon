"use strict";

// Cooperative work budget for long playerbot passes.
// Ported from the X-Eve Living Universe patch (livingEconomyWorkBudget.js),
// Copyright (c) 2026 X-Eve Living Universe patch contributors, MIT License
// (original patch contributions only). See THIRD_PARTY_NOTICES.md.

const { performance } = require("node:perf_hooks");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createWorkBudget(options = {}) {
  const budgetMs = Math.max(0.5, toFiniteNumber(options.budgetMs, 4));
  // Playerbots addition: a disabled budget still measures slices and stages
  // but never yields, which keeps the previous single-slice behaviour.
  const enabled = options.enabled !== false;
  // Playerbots addition: on a saturated event loop every yield returns late.
  // Once the pass has spent this long parked it stops yielding and finishes,
  // so yielding cannot stretch a pass without bound. 0 means no limit.
  const maxParkedMs = Math.max(0, toFiniteNumber(options.maxParkedMs, 0));
  const onYield = typeof options.onYield === "function" ? options.onYield : null;
  const startedAtMs = performance.now();
  let sliceStartedAtMs = startedAtMs;
  let checkpoints = 0;
  let yields = 0;
  let maximumSliceMs = 0;
  let totalParkedMs = 0;
  let maximumParkedMs = 0;
  let yieldingSuspended = false;
  let externalWaits = 0;
  let totalExternalWaitMs = 0;
  let maximumExternalWaitMs = 0;
  const externalWaitsByLabel = {};
  const stages = {};

  function closeActiveSlice(nowMs = performance.now()) {
    const sliceMs = Math.max(0, nowMs - sliceStartedAtMs);
    maximumSliceMs = Math.max(maximumSliceMs, sliceMs);
    return sliceMs;
  }

  // Playerbots addition: synchronous probe for callers that cannot await.
  function shouldYield() {
    return enabled && !yieldingSuspended && performance.now() - sliceStartedAtMs >= budgetMs;
  }

  async function checkpoint(force = false) {
    checkpoints += 1;
    if (!enabled || yieldingSuspended) return false;
    const nowMs = performance.now();
    const sliceMs = Math.max(0, nowMs - sliceStartedAtMs);
    if (!force && sliceMs < budgetMs) {
      return false;
    }
    closeActiveSlice(nowMs);
    yields += 1;
    if (onYield) {
      onYield({ sliceMs, yields, checkpoints });
    }
    await yieldToEventLoop();
    sliceStartedAtMs = performance.now();
    const parkedMs = Math.max(0, sliceStartedAtMs - nowMs);
    totalParkedMs += parkedMs;
    maximumParkedMs = Math.max(maximumParkedMs, parkedMs);
    if (maxParkedMs > 0 && totalParkedMs >= maxParkedMs) yieldingSuspended = true;
    return true;
  }

  async function waitFor(label, operation) {
    const waitLabel = String(label || "external");
    closeActiveSlice();
    const waitStartedAtMs = performance.now();
    try {
      return await (typeof operation === "function" ? operation() : operation);
    } finally {
      const resumedAtMs = performance.now();
      const waitMs = Math.max(0, resumedAtMs - waitStartedAtMs);
      externalWaits += 1;
      totalExternalWaitMs += waitMs;
      maximumExternalWaitMs = Math.max(maximumExternalWaitMs, waitMs);
      const existing = externalWaitsByLabel[waitLabel] || {
        waits: 0,
        totalWaitMs: 0,
        maximumWaitMs: 0,
      };
      existing.waits += 1;
      existing.totalWaitMs += waitMs;
      existing.maximumWaitMs = Math.max(existing.maximumWaitMs, waitMs);
      externalWaitsByLabel[waitLabel] = existing;
      // Time spent awaiting another service is wall latency, not an
      // uninterrupted JavaScript slice. Start a fresh CPU slice on resume.
      sliceStartedAtMs = resumedAtMs;
    }
  }

  function recordStage(stageName, wallDurationMs, yieldsBefore, waitsBefore, waitMsBefore) {
    const existing = stages[stageName] || {
      calls: 0,
      totalWallDurationMs: 0,
      maximumWallDurationMs: 0,
      cooperativeYields: 0,
      externalWaits: 0,
      externalWaitMs: 0,
    };
    existing.calls += 1;
    existing.totalWallDurationMs += wallDurationMs;
    existing.maximumWallDurationMs = Math.max(existing.maximumWallDurationMs, wallDurationMs);
    existing.cooperativeYields += yields - yieldsBefore;
    existing.externalWaits += externalWaits - waitsBefore;
    existing.externalWaitMs += totalExternalWaitMs - waitMsBefore;
    stages[stageName] = existing;
  }

  async function runStage(name, operation) {
    const stageName = String(name || "unnamed");
    const stageStartedAtMs = performance.now();
    const yieldsBefore = yields;
    const waitsBefore = externalWaits;
    const waitMsBefore = totalExternalWaitMs;
    try {
      return await operation();
    } finally {
      recordStage(stageName, Math.max(0, performance.now() - stageStartedAtMs),
        yieldsBefore, waitsBefore, waitMsBefore);
    }
  }

  // Playerbots addition: stage marks for long functions whose blocks share
  // local variables and cannot be wrapped in a closure without reordering.
  function beginStage(name) {
    const stageName = String(name || "unnamed");
    const stageStartedAtMs = performance.now();
    const yieldsBefore = yields;
    const waitsBefore = externalWaits;
    const waitMsBefore = totalExternalWaitMs;
    let ended = false;
    return function endStage() {
      if (ended) return;
      ended = true;
      recordStage(stageName, Math.max(0, performance.now() - stageStartedAtMs),
        yieldsBefore, waitsBefore, waitMsBefore);
    };
  }

  // Playerbots addition: sequential stage marks. Starting a stage closes the
  // previous one; finish() closes whichever stage is still open.
  let endOpenStage = null;
  function switchStage(name) {
    if (endOpenStage) endOpenStage();
    endOpenStage = name ? beginStage(name) : null;
  }

  // Playerbots addition: visit items, yielding between items once the slice
  // budget is spent. `revalidate(item)` runs only after a yield, because other
  // scheduler jobs may have changed that item while this pass was parked.
  async function forEachWithinBudget(items, visit, loopOptions = {}) {
    const revalidate = typeof loopOptions.revalidate === "function" ? loopOptions.revalidate : null;
    const shouldStop = typeof loopOptions.shouldStop === "function" ? loopOptions.shouldStop : null;
    let visited = 0;
    let skippedAfterYield = 0;
    for (const item of items || []) {
      if (shouldStop && shouldStop()) break;
      const yielded = await checkpoint();
      if (yielded && revalidate && !revalidate(item)) {
        skippedAfterYield += 1;
        continue;
      }
      await visit(item);
      visited += 1;
    }
    return { visited, skippedAfterYield };
  }

  function finish() {
    switchStage(null);
    const nowMs = performance.now();
    closeActiveSlice(nowMs);
    return {
      budgetMs,
      enabled,
      checkpoints,
      yields,
      maximumSliceMs,
      totalParkedMs,
      maximumParkedMs,
      yieldingSuspended,
      externalWaits,
      totalExternalWaitMs,
      maximumExternalWaitMs,
      externalWaitsByLabel,
      stages,
      wallDurationMs: Math.max(0, nowMs - startedAtMs),
    };
  }

  return {
    budgetMs,
    enabled,
    beginStage,
    checkpoint,
    forEachWithinBudget,
    shouldYield,
    switchStage,
    waitFor,
    runStage,
    finish,
  };
}

module.exports = {
  createWorkBudget,
  yieldToEventLoop,
};

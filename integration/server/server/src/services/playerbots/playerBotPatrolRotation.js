"use strict";

// Deterministic rotation and dispersal for playerbot patrol deployments.
// The stable hash, deterministic unit and duration-window helpers, the
// cooldown range and the per-location presence cap are adapted from the X-Eve
// Living Universe patch (livingRoamingKernel.js), Copyright (c) 2026 X-Eve
// Living Universe patch contributors, MIT License (original patch
// contributions only). See THIRD_PARTY_NOTICES.md.
//
// This module only ranks destinations. Target legality stays with the combat
// runtime, Crimewatch and the war authorities.

const SCHEMA_VERSION = 1;
const DEFAULTS = Object.freeze({
  maxCandidates: 8,
  extraHopsBeyondNearest: 6,
  maxPatrolsPerSystem: 6,
  rotationWindow: Object.freeze({ minMs: 45 * 60_000, maxMs: 180 * 60_000 }),
  saturationWindows: 3,
  cooldown: Object.freeze({ minMs: 15 * 60_000, maxMs: 60 * 60_000 }),
  ledgerRetentionMs: 6 * 60 * 60_000,
  ledgerMaxSystems: 256,
  ledgerMaxEntriesPerSystem: 16,
  weights: Object.freeze({ hop: 1, presence: 3, recent: 2, jitter: 2.5 }),
});

function positiveInteger(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function stableHash32(...parts) {
  const text = parts.map((part) => String(part)).join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicUnit(...parts) {
  return stableHash32(...parts) / 0x100000000;
}

function durationWithin(range, ...parts) {
  if (range.maxMs <= range.minMs) return range.minMs;
  return Math.round(range.minMs + ((range.maxMs - range.minMs) * deterministicUnit(...parts)));
}

// Each corporation rotates on its own period, so patrol changes are staggered
// across corporations instead of happening server-wide at one moment.
function rotationWindowMs(seed, corporationID) {
  return durationWithin(DEFAULTS.rotationWindow, seed, corporationID, "rotation-window");
}

function rotationEpoch(nowMs, windowMs) {
  return Math.floor(Math.max(0, Number(nowMs) || 0) / Math.max(1, Number(windowMs) || 1));
}

function normalizeLedger(raw, nowMs = Date.now()) {
  const ledger = { schemaVersion: SCHEMA_VERSION, systems: {} };
  const systems = raw && typeof raw === "object" && !Array.isArray(raw) &&
    raw.systems && typeof raw.systems === "object" && !Array.isArray(raw.systems) ? raw.systems : null;
  if (!systems) return ledger;
  const rows = [];
  for (const [key, entries] of Object.entries(systems)) {
    const systemID = positiveInteger(key);
    if (!systemID || !Array.isArray(entries)) continue;
    const kept = [];
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const atMs = Math.trunc(Number(entry.atMs) || 0);
      const operationID = String(entry.operationID || "").slice(0, 100);
      if (atMs <= 0 || !operationID || seen.has(operationID)) continue;
      if (nowMs - atMs > DEFAULTS.ledgerRetentionMs || atMs > nowMs + 60_000) continue;
      seen.add(operationID);
      kept.push({
        operationID,
        characterID: positiveInteger(entry.characterID),
        corporationID: positiveInteger(entry.corporationID),
        mode: String(entry.mode || "").slice(0, 32),
        atMs,
      });
    }
    if (!kept.length) continue;
    kept.sort((left, right) => left.atMs - right.atMs);
    rows.push([systemID, kept.slice(-DEFAULTS.ledgerMaxEntriesPerSystem)]);
  }
  rows.sort((left, right) => right[1][right[1].length - 1].atMs - left[1][left[1].length - 1].atMs);
  for (const [systemID, entries] of rows.slice(0, DEFAULTS.ledgerMaxSystems)) ledger.systems[String(systemID)] = entries;
  return ledger;
}

// Returns a new ledger; recording the same operation twice has no effect.
function recordDeployment(rawLedger, deployment = {}, nowMs = Date.now()) {
  const ledger = normalizeLedger(rawLedger, nowMs);
  const systemID = positiveInteger(deployment.systemID);
  const operationID = String(deployment.operationID || "").slice(0, 100);
  if (!systemID || !operationID) return ledger;
  for (const entries of Object.values(ledger.systems)) {
    if (entries.some((entry) => entry.operationID === operationID)) return ledger;
  }
  const key = String(systemID);
  const entries = [...(ledger.systems[key] || []), {
    operationID,
    characterID: positiveInteger(deployment.characterID),
    corporationID: positiveInteger(deployment.corporationID),
    mode: String(deployment.mode || "").slice(0, 32),
    atMs: Math.trunc(Number(deployment.atMs) || nowMs),
  }];
  return normalizeLedger({ systems: { ...ledger.systems, [key]: entries } }, nowMs);
}

function entriesFor(ledger, systemID) {
  const entries = ledger && ledger.systems && ledger.systems[String(positiveInteger(systemID))];
  return Array.isArray(entries) ? entries : [];
}

// Recent deployments weigh less as they age and stop counting at retention.
function recentPressure(ledger, systemID, nowMs = Date.now()) {
  let pressure = 0;
  for (const entry of entriesFor(ledger, systemID)) {
    const age = nowMs - Number(entry.atMs);
    if (age < 0 || age >= DEFAULTS.ledgerRetentionMs) continue;
    pressure += 1 - (age / DEFAULTS.ledgerRetentionMs);
  }
  return pressure;
}

// A corporation that deployed to one system in each of the last few rotation
// windows has been there continuously and should move on.
function isSaturated(ledger, systemID, corporationID, nowMs, windowMs) {
  const corporation = positiveInteger(corporationID);
  if (!corporation) return false;
  const currentEpoch = rotationEpoch(nowMs, windowMs);
  const epochs = new Set();
  for (const entry of entriesFor(ledger, systemID)) {
    if (Number(entry.corporationID) === corporation) epochs.add(rotationEpoch(entry.atMs, windowMs));
  }
  for (let offset = 1; offset <= DEFAULTS.saturationWindows; offset += 1) {
    if (!epochs.has(currentEpoch - offset)) return false;
  }
  return true;
}

function cooldownUntilMs(ledger, systemID, corporationID, seed, nowMs, windowMs) {
  if (!isSaturated(ledger, systemID, corporationID, nowMs, windowMs)) return 0;
  const corporation = positiveInteger(corporationID);
  const epochStartMs = rotationEpoch(nowMs, windowMs) * windowMs;
  return epochStartMs + durationWithin(DEFAULTS.cooldown, seed, corporation, systemID,
    rotationEpoch(nowMs, windowMs), "cooldown");
}

function choosePatrolSystem(input = {}) {
  const nowMs = Number(input.nowMs) || Date.now();
  const seed = input.seed === undefined ? "playerbots" : input.seed;
  const characterID = positiveInteger(input.characterID);
  const corporationID = positiveInteger(input.corporationID);
  const maxPatrolsPerSystem = positiveInteger(input.maxPatrolsPerSystem) || DEFAULTS.maxPatrolsPerSystem;
  const weights = { ...DEFAULTS.weights, ...(input.weights || {}) };
  const ledger = normalizeLedger(input.ledger, nowMs);
  const presenceOf = (systemID) => {
    const source = input.presenceBySystem;
    const value = source instanceof Map ? source.get(systemID) : source && source[systemID];
    return Math.max(0, Math.trunc(Number(value) || 0));
  };
  const candidates = [];
  const seen = new Set();
  for (const candidate of Array.isArray(input.candidates) ? input.candidates : []) {
    const systemID = positiveInteger(candidate && candidate.systemID);
    if (!systemID || seen.has(systemID)) continue;
    seen.add(systemID);
    candidates.push({ ...candidate, systemID, hops: Math.max(0, Math.trunc(Number(candidate.hops) || 0)) });
  }
  const windowMs = rotationWindowMs(seed, corporationID);
  const epoch = rotationEpoch(nowMs, windowMs);
  const base = { chosen: null, ranked: [], epoch, windowMs };
  if (!candidates.length) return { ...base, reason: "no-candidates" };

  const belowCap = candidates.filter((candidate) => presenceOf(candidate.systemID) < maxPatrolsPerSystem);
  if (!belowCap.length) return { ...base, reason: "all-candidates-at-patrol-cap" };
  const rested = belowCap.filter((candidate) =>
    cooldownUntilMs(ledger, candidate.systemID, corporationID, seed, nowMs, windowMs) <= nowMs);
  // Never leave the pilot without work only because every option is cooling.
  const pool = rested.length ? rested : belowCap;
  const minimumHops = pool.reduce((minimum, candidate) => Math.min(minimum, candidate.hops), Number.MAX_SAFE_INTEGER);
  const ranked = pool.map((candidate) => {
    const components = {
      hop: weights.hop * (candidate.hops - minimumHops),
      presence: weights.presence * presenceOf(candidate.systemID),
      recent: weights.recent * recentPressure(ledger, candidate.systemID, nowMs),
      jitter: weights.jitter * deterministicUnit(seed, corporationID, characterID, epoch, candidate.systemID),
    };
    return { ...candidate, components,
      score: components.hop + components.presence + components.recent + components.jitter };
  }).sort((left, right) => left.score - right.score || left.systemID - right.systemID);
  return {
    ...base,
    chosen: ranked[0],
    ranked,
    reason: rested.length ? (rested.length < belowCap.length ? "rotated-past-cooldown" : "ranked") : "cooldown-waived",
  };
}

module.exports = {
  DEFAULTS,
  SCHEMA_VERSION,
  choosePatrolSystem,
  cooldownUntilMs,
  deterministicUnit,
  isSaturated,
  normalizeLedger,
  recentPressure,
  recordDeployment,
  rotationEpoch,
  rotationWindowMs,
  stableHash32,
};

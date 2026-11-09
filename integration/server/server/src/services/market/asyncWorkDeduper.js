"use strict";

function createAsyncWorkDeduper() {
  const completed = new Map();
  const pending = new Map();

  function run(keyValue, fingerprintValue, work) {
    const key = String(keyValue || "").trim();
    const fingerprint = String(fingerprintValue ?? "");
    if (!key || typeof work !== "function") {
      return Promise.reject(new TypeError("async work deduper requires a key and work function"));
    }

    const previous = completed.get(key);
    if (previous && previous.fingerprint === fingerprint) {
      return Promise.resolve(previous.value);
    }
    const inFlight = pending.get(key);
    if (inFlight && !inFlight.invalidated && inFlight.fingerprint === fingerprint) {
      return inFlight.promise;
    }

    const entry = { fingerprint, invalidated: false, promise: null };
    entry.promise = Promise.resolve()
      .then(work)
      .then((value) => {
        if (!entry.invalidated && pending.get(key) === entry) {
          completed.set(key, { fingerprint, value });
        }
        return value;
      })
      .finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      });
    pending.set(key, entry);
    return entry.promise;
  }

  function invalidate(keyValue) {
    const key = String(keyValue || "").trim();
    if (!key) return false;
    const removed = completed.delete(key);
    const inFlight = pending.get(key);
    if (inFlight) inFlight.invalidated = true;
    return removed || Boolean(inFlight);
  }

  function clear() {
    completed.clear();
    for (const entry of pending.values()) entry.invalidated = true;
    pending.clear();
  }

  return Object.freeze({ run, invalidate, clear });
}

module.exports = { createAsyncWorkDeduper };

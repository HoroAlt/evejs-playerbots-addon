"use strict";

// One durable interruption mailbox and one in-process execution owner per pilot.
// The mailbox is separate from operation snapshots: a late transaction may
// settle its ledger without overwriting a newly received emergency command.
const PREFIX = "_playerBotInterrupt_";
const clone = (value) => JSON.parse(JSON.stringify(value));
const priorities = { engage: 1, mining: 2, retreat: 3, stop: 4 };
const priority = (intent) =>
  intent?.kind === "mining" && intent.details?.action === "retreat"
    ? priorities.retreat
    : priorities[intent?.kind] || 0;

function createRuntime(repo) {
  const owners = new Map();
  const applying = new Set();
  function read(id) {
    const result = repo.read("playerBots", `/${PREFIX}${Number(id)}`);
    return (result.success && result.data) || { generation: 0, pending: null };
  }
  function write(id, state) {
    repo.ensureTable("playerBots");
    const result = repo.write(
      "playerBots",
      `/${PREFIX}${Number(id)}`,
      clone(state),
    );
    if (!result.success)
      throw new Error(result.errorMsg || "PLAYERBOT_INTERRUPT_WRITE_FAILED");
    const flushed = repo.flushTableSync("playerBots");
    if (!flushed?.success)
      throw new Error(flushed?.errorMsg || "PLAYERBOT_INTERRUPT_FLUSH_FAILED");
  }
  function request(id, intent) {
    id = Number(id);
    if (!Number.isSafeInteger(id) || id <= 0 || !priorities[intent?.kind])
      throw new Error("INVALID_PLAYERBOT_INTERRUPT");
    const previous = read(id);
    const generation = Number(previous.generation || 0) + 1;
    // A fresh, weaker engage request must not revoke an unresolved evacuation.
    const next =
      previous.pending && priority(previous.pending) > priority(intent)
        ? previous.pending
        : clone(intent);
    const state = {
      generation,
      pending: { ...next, generation, receivedAtMs: Date.now() },
    };
    write(id, state); // Persist before acknowledging or signaling cancellation.
    const owner = owners.get(id);
    if (owner) {
      owner.cancelled = true;
      owner.cancel({ interrupted: true, generation });
    }
    return clone(state.pending);
  }
  function acquire(id, kind, operationID = "") {
    id = Number(id);
    if (owners.has(id)) return null;
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = resolve;
    });
    const owner = {
      id,
      kind,
      operationID,
      generation: Number(read(id).generation || 0),
      cancelled: false,
      cancelledPromise: cancelled,
      cancel,
    };
    owners.set(id, owner);
    return owner;
  }
  function release(owner) {
    if (owners.get(owner?.id) === owner) owners.delete(owner.id);
  }
  function current(owner) {
    return Boolean(
      owner &&
        owners.get(owner.id) === owner &&
        !owner.cancelled &&
        Number(read(owner.id).generation || 0) === owner.generation,
    );
  }
  function pendingIDs() {
    const result = repo.read("playerBots", "/");
    return Object.entries(result.data || {})
      .filter(([key, value]) => key.startsWith(PREFIX) && value?.pending)
      .map(([key]) => Number(key.slice(PREFIX.length)))
      .filter((id) => id > 0);
  }
  function drain(id, apply) {
    id = Number(id);
    if (owners.has(id) || applying.has(id)) return false;
    const state = read(id);
    if (!state.pending) return false;
    applying.add(id);
    try {
      const result = apply(clone(state.pending));
      if (result && typeof result.then === "function")
        throw new Error("INTERRUPT_APPLY_MUST_BE_SYNCHRONOUS");
      // Fail closed: failed application remains durable for retry/review.
      if (result === false || result?.success === false) return false;
      const latest = read(id);
      if (latest.generation === state.generation) {
        write(id, {
          generation: state.generation,
          pending: null,
          appliedAtMs: Date.now(),
        });
      }
      return true;
    } finally {
      applying.delete(id);
    }
  }
  return {
    request,
    acquire,
    release,
    current,
    drain,
    pendingIDs,
    hasPending: (id) => Boolean(read(id).pending),
    pending: (id) => clone(read(id)),
    isBusy: (id) => owners.has(Number(id)),
    isApplying: (id) => applying.has(Number(id)),
    // Use only for cancellable reads, never purchases/deliveries/PI commits.
    readUntilInterrupted: (owner, promise) =>
      Promise.race([promise, owner.cancelledPromise]),
  };
}
let singleton;
function runtime() {
  singleton ||= createRuntime(
    require("../../gameStore/tableRepository").createTableRepository(
      "service:playerbots",
      { strict: true },
    ),
  );
  return singleton;
}
module.exports = { createRuntime };
for (const name of [
  "request",
  "acquire",
  "release",
  "current",
  "drain",
  "pendingIDs",
  "hasPending",
  "pending",
  "isBusy",
  "isApplying",
  "readUntilInterrupted",
]) {
  module.exports[name] = (...args) => runtime()[name](...args);
}

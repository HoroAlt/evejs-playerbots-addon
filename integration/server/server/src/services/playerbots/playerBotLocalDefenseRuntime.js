"use strict";

// Persistent, synchronous reservation authority. Navigation/combat adapters
// report actual observations; assignment alone is never arrival or success.
const clone = (value) => JSON.parse(JSON.stringify(value));
const positive = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;
const priority = { escort: 1, damage: 2, web: 2, neut: 2, scram: 3 };
const terminal = new Set(["closed", "expired"]);

function createCoordinator({ load, save, now = Date.now, config, canAssist }) {
  function read() {
    const value = load();
    if (value && value.schemaVersion !== 1)
      throw new Error("UNSUPPORTED_LOCAL_DEFENSE_SCHEMA");
    return clone(
      value || {
        schemaVersion: 1,
        revision: 0,
        sequence: 0,
        events: {},
        leases: {},
      },
    );
  }
  function commit(state) {
    state.revision += 1;
    save(clone(state));
  }
  function enabledFor(systemID) {
    const settings = config();
    return (
      settings.enabled === true && settings.systemIDs.includes(Number(systemID))
    );
  }
  function roleEnabled(role) {
    const settings = config();
    return role === "miner"
      ? settings.miningRescue !== false
      : settings.generalRescue !== false;
  }
  function record(event, kind, details = {}) {
    event.history = [
      ...(event.history || []),
      { at: now(), kind, ...details },
    ].slice(-40);
  }
  function request(input) {
    if (
      !input ||
      !positive(input.victimID) ||
      !positive(input.attackerID) ||
      !positive(input.systemID) ||
      !priority[input.kind] ||
      !input.scope ||
      !input.side ||
      !["player", "bot"].includes(input.sourceKind) ||
      !positive(input.attackerCharacterID) ||
      input.authoritative !== true ||
      !enabledFor(input.systemID) ||
      !roleEnabled(input.role)
    )
      return { accepted: false, reason: "disabled-or-invalid-evidence" };
    const state = read(),
      time = now();
    // BOT retaliation inside an existing conflict cannot recursively recruit.
    // Human aggression always enters the request path, even against a responder.
    if (input.sourceKind === "bot") {
      const active = Object.values(state.events).filter(
        (e) =>
          !terminal.has(e.status) &&
          e.systemID === Number(input.systemID) &&
          e.scope === String(input.scope) &&
          (time - e.lastThreatAt <= 30000 ||
            Object.values(state.leases).some((l) => l.eventID === e.id)),
      );
      const involved = (id) =>
        Boolean(state.leases[id]) ||
        active.some((e) => e.victims[id] || e.attackerCharacterID === id);
      const same = active.some(
        (e) =>
          e.attackerID === Number(input.attackerID) &&
          e.side === String(input.side) &&
          e.status !== "resolving",
      );
      if (
        !same &&
        (involved(Number(input.victimID)) ||
          involved(Number(input.attackerCharacterID)))
      )
        return { accepted: false, reason: "existing-conflict-no-chain" };
    }
    const key = JSON.stringify([
      Number(input.systemID),
      String(input.scope),
      String(input.side),
      Number(input.attackerID),
    ]);
    if (
      Object.values(state.events).some(
        (e) =>
          e.key === key &&
          e.reason === "operator-cancelled" &&
          time - e.lastThreatAt < 30000,
      )
    )
      return { accepted: false, reason: "operator-cancel-cooldown" };
    let event = Object.values(state.events).find(
      (e) =>
        e.key === key && !terminal.has(e.status) && e.status !== "resolving",
    );
    if (
      event &&
      event.victims[input.victimID] &&
      time >= event.lastThreatAt &&
      time - event.lastThreatAt < 1000 &&
      event.priority >= priority[input.kind]
    )
      return {
        accepted: true,
        eventID: event.id,
        status: event.status,
        coalesced: true,
      };
    if (!event) {
      const inactive = Object.values(state.events)
        .filter(
          (e) =>
            terminal.has(e.status) &&
            !Object.values(state.leases).some(
              (lease) => lease.eventID === e.id,
            ),
        )
        .sort((a, b) => a.lastThreatAt - b.lastThreatAt);
      while (Object.keys(state.events).length >= 128 && inactive.length)
        delete state.events[inactive.shift().id];
      if (Object.keys(state.events).length >= 128)
        return { accepted: false, reason: "incident-capacity" };
      event = {
        id: `LD${++state.sequence}`,
        key,
        systemID: Number(input.systemID),
        scope: String(input.scope),
        side: String(input.side),
        attackerID: Number(input.attackerID),
        attackerCharacterID: Number(input.attackerCharacterID),
        sourceKind: input.sourceKind,
        victims: {},
        priority: priority[input.kind],
        firstThreatAt: time,
        lastThreatAt: time,
        status: "requested",
        history: [],
      };
      state.events[event.id] = event;
      record(event, "requested");
    }
    event.victims[input.victimID] = {
      characterID: Number(input.victimID),
      lastThreatAt: time,
      role: input.role || "noncombat",
      position: input.position ? clone(input.position) : null,
      state: "threatened",
    };
    event.lastThreatAt = time;
    event.priority = Math.max(event.priority, priority[input.kind]);
    event.lastKind = input.kind;
    // All duplicate notifications update freshness; none manufacture extra leases.
    commit(state);
    return { accepted: true, eventID: event.id, status: event.status };
  }
  function dispatch(candidates) {
    const state = read(),
      settings = config(),
      time = now(),
      assigned = [];
    let changed = false;
    if (!settings.enabled) return assigned;
    const events = Object.values(state.events)
      .filter((e) => !terminal.has(e.status) && e.status !== "resolving")
      .sort(
        (a, b) =>
          Number(b.sourceKind === "player") -
            Number(a.sourceKind === "player") ||
          b.priority +
            Math.min(2, (time - b.firstThreatAt) / 60000) -
            (a.priority + Math.min(2, (time - a.firstThreatAt) / 60000)) ||
          a.firstThreatAt - b.firstThreatAt,
      );
    for (const event of events) {
      if (!enabledFor(event.systemID)) continue;
      if (Object.values(event.victims).some((v) => !roleEnabled(v.role))) {
        beginClose(state, event, "closed", "rescue-role-disabled");
        changed = true;
        continue;
      }
      const ttl = event.lastKind === "escort" ? 90000 : 30000;
      if (time - event.lastThreatAt > ttl) {
        beginClose(state, event, "expired", "threat-evidence-expired");
        changed = true;
        continue;
      }
      if (!["player", "bot"].includes(event.sourceKind)) {
        beginClose(state, event, "closed", "legacy-source-unverified");
        changed = true;
        continue;
      }
      const existing = Object.values(state.leases).filter(
        (l) => l.eventID === event.id && l.phase !== "disengaging",
      );
      const limit = Math.max(1, Math.min(5, Number(settings.perIncident) || 3));
      const desired = Math.max(0, limit - existing.length);
      const eligible = candidates
        .filter(
          (c) =>
            positive(c.characterID) &&
            !state.leases[c.characterID] &&
            !event.victims[c.characterID] &&
            c.connected === true &&
            c.ready === true &&
            c.preemptible === true &&
            ["security", "piracy"].includes(c.role) &&
            c.systemID === event.systemID &&
            c.scope === event.scope &&
            settings.responderIDs.includes(c.characterID) &&
            canAssist(c, event) === true,
        )
        .sort(
          (a, b) =>
            Number(b.existingEscort || false) -
              Number(a.existingEscort || false) ||
            Number(b.onGrid) - Number(a.onGrid) ||
            (Number.isFinite(a.etaMs) ? a.etaMs : Infinity) -
              (Number.isFinite(b.etaMs) ? b.etaMs : Infinity) ||
            (Number.isFinite(a.distanceMeters) ? a.distanceMeters : Infinity) -
              (Number.isFinite(b.distanceMeters)
                ? b.distanceMeters
                : Infinity) ||
            a.characterID - b.characterID,
        );
      let incidentAssigned = 0;
      for (const candidate of eligible) {
        if (incidentAssigned >= desired) break;
        if (state.leases[candidate.characterID]) continue;
        const allLeases = Object.values(state.leases),
          reserve = Math.max(1, Number(settings.playerReserve) || 2);
        const globalLimit = Math.min(12, Number(settings.globalLimit) || 4),
          systemLimit = Math.min(8, Number(settings.systemLimit) || 4);
        if (event.sourceKind === "bot") {
          const botLeases = allLeases.filter(
            (l) => state.events[l.eventID]?.sourceKind !== "player",
          );
          if (
            botLeases.length >= Math.max(0, globalLimit - reserve) ||
            botLeases.filter((l) => l.systemID === event.systemID).length >=
              Math.max(0, systemLimit - reserve)
          )
            break;
          // A legal waiting player incident gets first refusal, regardless of threat kind.
          if (
            events.some(
              (e) =>
                e.sourceKind === "player" &&
                e.systemID === event.systemID &&
                e.scope === event.scope &&
                time - e.lastThreatAt <= 30000 &&
                Object.values(state.leases).filter((l) => l.eventID === e.id)
                  .length < limit &&
                canAssist(candidate, e) === true,
            )
          )
            continue;
        }
        if (Object.keys(state.leases).length >= globalLimit) break;
        if (
          Object.values(state.leases).filter(
            (l) => l.systemID === event.systemID,
          ).length >= systemLimit
        )
          break;
        const token = `${event.id}:${candidate.characterID}:${++state.sequence}`;
        state.leases[candidate.characterID] = {
          token,
          eventID: event.id,
          characterID: candidate.characterID,
          systemID: event.systemID,
          scope: event.scope,
          assignedAt: time,
          updatedAt: time,
          etaMs: Number.isFinite(candidate.etaMs)
            ? Math.max(0, candidate.etaMs)
            : null,
          phase: "reserved",
          operationID: candidate.operationID || null,
          resume: candidate.resume ? clone(candidate.resume) : null,
        };
        assigned.push(clone(state.leases[candidate.characterID]));
        changed = true;
        incidentAssigned += 1;
        record(event, "reserved", {
          characterID: candidate.characterID,
          token,
        });
      }
      const count = Object.values(state.leases).filter(
        (l) => l.eventID === event.id,
      ).length;
      if (!count && event.status !== "unserviceable") {
        event.status = "unserviceable";
        record(event, "unserviceable", {
          reason: "no-qualified-legal-local-responder",
        });
        changed = true;
      } else if (
        count &&
        ["requested", "unserviceable"].includes(event.status)
      ) {
        event.status = "assigned";
        changed = true;
      }
    }
    if (changed) commit(state);
    return assigned;
  }
  function beginClose(state, event, status, reason) {
    const leases = Object.values(state.leases).filter(
      (l) => l.eventID === event.id,
    );
    event.status = leases.length ? "resolving" : status;
    event.closeStatus = status;
    event.reason = reason;
    for (const lease of leases) {
      lease.phase = "disengaging";
      lease.reason = reason;
    }
    record(event, "closing", { reason });
  }
  function close(eventID, reason = "threat-ended", expired = false) {
    const state = read(),
      event = state.events[eventID];
    if (!event || terminal.has(event.status) || event.status === "resolving")
      return false;
    beginClose(state, event, expired ? "expired" : "closed", reason);
    commit(state);
    return true;
  }
  function update(characterID, token, phase, evidence = {}) {
    const state = read(),
      lease = state.leases[characterID];
    if (!lease || lease.token !== token) return false;
    const event = state.events[lease.eventID];
    const transitions = {
      reserved: ["travelling", "on-grid", "disengaging"],
      travelling: ["on-grid", "disengaging"],
      "on-grid": ["engaging", "disengaging"],
      engaging: ["on-grid", "disengaging"],
      disengaging: ["resumed"],
    };
    if (phase !== lease.phase && !transitions[lease.phase]?.includes(phase))
      return false;
    if (
      ["on-grid", "engaging"].includes(phase) &&
      !(
        evidence.sameScope === true &&
        evidence.visible === true &&
        evidence.inRange === true &&
        evidence.systemID === lease.systemID
      )
    )
      return false;
    if (phase === "engaging" && evidence.authorityAccepted !== true)
      return false;
    if (phase === "resumed" && evidence.safeToResume !== true) return false;
    if (
      phase === lease.phase &&
      JSON.stringify(lease.evidence || {}) === JSON.stringify(evidence)
    )
      return true;
    lease.phase = phase;
    lease.updatedAt = now();
    lease.evidence = clone(evidence);
    record(event, phase, { characterID: Number(characterID) });
    if (phase === "resumed") {
      delete state.leases[characterID];
      if (
        event.status === "resolving" &&
        !Object.values(state.leases).some((l) => l.eventID === event.id)
      )
        event.status = event.closeStatus || "closed";
    } else if (phase === "engaging") event.status = "supporting";
    else if (phase === "travelling") event.status = "responding";
    commit(state);
    return true;
  }
  function disable() {
    const state = read();
    let changed = false;
    for (const event of Object.values(state.events))
      if (!terminal.has(event.status) && event.status !== "resolving") {
        beginClose(state, event, "closed", "disabled");
        changed = true;
      }
    if (changed) commit(state);
  }
  function recover(validate) {
    const state = read();
    for (const lease of Object.values(state.leases)) {
      // Recovery never replays an attack. Live engine observations decide whether
      // a surviving lease may proceed; everything else enters orderly disengage.
      const evidence = validate(
        clone(lease),
        clone(state.events[lease.eventID]),
      );
      if (evidence?.valid !== true) {
        lease.phase = "disengaging";
        lease.reason = evidence?.reason || "recovery-unverified";
      }
      lease.updatedAt = now();
    }
    commit(state);
  }
  function maintain() {
    const state = read(),
      settings = config();
    let changed = false;
    for (const event of Object.values(state.events)) {
      if (terminal.has(event.status) || event.status === "resolving") continue;
      const disabled =
        !settings.enabled ||
        !settings.systemIDs.includes(event.systemID) ||
        Object.values(event.victims).some((v) => !roleEnabled(v.role));
      if (
        disabled ||
        now() - event.lastThreatAt >
          (event.lastKind === "escort" ? 90000 : 30000)
      ) {
        beginClose(
          state,
          event,
          disabled ? "closed" : "expired",
          disabled ? "disabled" : "threat-evidence-expired",
        );
        changed = true;
      }
    }
    if (changed) commit(state);
  }
  function annotate(characterID, token, patch) {
    const state = read(),
      lease = state.leases[characterID];
    if (!lease || lease.token !== token) return false;
    const allowed = new Set([
      "memory",
      "lastCommandAt",
      "shipID",
      "cleanupAt",
      "lastDecision",
      "returnOrderedAt",
    ]);
    if (Object.keys(patch).some((key) => !allowed.has(key)))
      throw new Error("INVALID_DEFENSE_LEASE_PATCH");
    if (
      Object.entries(patch).every(
        ([key, value]) => JSON.stringify(lease[key]) === JSON.stringify(value),
      )
    )
      return true;
    Object.assign(lease, clone(patch));
    commit(state);
    return true;
  }
  return {
    request,
    dispatch,
    update,
    close,
    disable,
    recover,
    maintain,
    annotate,
    snapshot: read,
  };
}
module.exports = { createCoordinator };

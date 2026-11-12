"use strict";
const config = require("./playerBotLocalDefenseConfig");
const scope = require("../../space/destiny/identity/interactionScope");
const interrupts = require("./playerBotInterruptRuntime");
const distance = (a, b) =>
  a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;
const bots = () => require("./playerBotRuntime");
const space = () => require("./playerBotSpaceRuntime");
const operations = () => require("./playerBotOperationRuntime");
const combat = () => require("./playerBotCombatRuntime");
const drones = () => require("../drone/droneRuntime");
const character = (id) =>
  require("../character/characterState").getCharacterRecord(id) || {};
function scopeKey(entity) {
  const value = scope.resolveEntityInteractionScope(entity);
  return value.valid
    ? JSON.stringify(value, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      )
    : null;
}
function affiliation(id) {
  const c = character(id),
    corp =
      require("../corporation/corporationState").getCorporationRecord(
        c.corporationID,
      ) || {};
  return {
    corp: Number(c.corporationID) || 0,
    alliance: Number(corp.allianceID || c.allianceID) || 0,
  };
}
function related(left, right) {
  const a = affiliation(left),
    b = affiliation(right);
  if (!a.corp || !b.corp) return false;
  const aa = [a.corp, a.alliance].filter(Boolean),
    bb = [b.corp, b.alliance].filter(Boolean);
  const wars = require("../corporation/warRuntimeState").listAllWars();
  if (
    wars.some(
      (w) =>
        !w.timeFinished &&
        ((aa.includes(Number(w.declaredByID)) &&
          bb.includes(Number(w.againstID))) ||
          (bb.includes(Number(w.declaredByID)) &&
            aa.includes(Number(w.againstID)))),
    )
  )
    return false;
  return (
    a.corp === b.corp ||
    (a.alliance > 0 && a.alliance === b.alliance) ||
    config
      .get()
      .agreements.some((pair) => pair.includes(a.corp) && pair.includes(b.corp))
  );
}
function side(id) {
  const a = affiliation(id);
  return a.alliance ? `alliance:${a.alliance}` : `corp:${a.corp}`;
}
function attached(id) {
  const bot = bots().getBotByCharacterID(id);
  if (!bot || !space().getBotPresenceInfo(bot).inSpace) return null;
  return { bot, ...space().getActorSpace(bot) };
}
function legal(bot, entity, target, scene, event) {
  if (!target || !scope.canEntitiesInteractLocally(entity, target))
    return false;
  const policy = require("./playerBotCombatPolicy");
  if (!classifyAttacker(target)) return false;
  const context = combat().getCombatContext(bot, scene, entity);
  const managed = context.isManagedBot;
  // Narrow exception only for the authoritative attacker of this live incident.
  context.isManagedBot = (id) =>
    Number(target.itemID) === event.attackerID ? false : managed(id);
  if (!policy.isEligibleDefensiveTarget(target, context)) return false;
  const permission =
    require("../security/crimewatchState").evaluateOffensiveAggression(
      scene,
      entity,
      target,
    );
  return (
    permission.success === true &&
    permission.data?.legal === true &&
    permission.data?.consequence === "none"
  );
}
// A real pilot session and managed roster membership distinguish bots from rats.
function classifyAttacker(entity) {
  if (
    entity?.kind !== "ship" ||
    !entity.session ||
    String(entity.npcEntityType || "").toLowerCase() === "npc"
  )
    return null;
  const id = Number(
    entity.session.characterID ||
      entity.session.charID ||
      entity.session.charid,
  );
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    require("./playerBotCombatPolicy").isPirateNpc(entity)
  )
    return null;
  if (bots().getBotByCharacterID(id))
    return { sourceKind: "bot", attackerCharacterID: id };
  if (entity.session._playerBotActor === true) return null;
  return { sourceKind: "player", attackerCharacterID: id };
}
let coordinator;
function core() {
  if (!coordinator) {
    const repo =
      require("../../gameStore/tableRepository").createTableRepository(
        "service:playerbots",
        { strict: true },
      );
    coordinator = require("./playerBotLocalDefenseRuntime").createCoordinator({
      load: () => repo.read("playerBots", "/_localDefense").data,
      save: (state) => {
        repo.ensureTable("playerBots");
        if (
          !repo.write("playerBots", "/_localDefense", state).success ||
          !repo.flushTableSync("playerBots")?.success
        )
          throw new Error("LOCAL_DEFENSE_PERSIST_FAILED");
      },
      config: config.get,
      canAssist: (candidate, event) => {
        const actor = attached(candidate.characterID),
          victims = Object.keys(event.victims).map(Number);
        return Boolean(
          actor &&
            victims.some((id) => related(candidate.characterID, id)) &&
            legal(
              actor.bot,
              actor.entity,
              actor.scene.getEntityByID(event.attackerID),
              actor.scene,
              event,
            ),
        );
      },
    });
  }
  return coordinator;
}
function hasLease(id) {
  return Boolean(core().snapshot().leases[id]);
}
function hasLiveAttack(characterID, target, scene) {
  const settings = config.get();
  if (!settings.enabled || !settings.systemIDs.includes(Number(scene.systemID)))
    return false;
  const snapshot = core().snapshot(),
    actor = attached(characterID);
  if (!actor) return false;
  return Object.values(snapshot.events).some(
    (event) =>
      event.attackerID === Number(target?.itemID) &&
      event.systemID === scene.systemID &&
      event.scope === scopeKey(actor.entity) &&
      Date.now() - event.lastThreatAt <= 30000 &&
      !["closed", "expired", "resolving"].includes(event.status) &&
      (event.victims[characterID] ||
        snapshot.leases[characterID]?.eventID === event.id),
  );
}
function supportFor(bot, target, scene) {
  let onGridEffectiveHP = 0,
    reinforcementAccepted = false,
    acceptedEtaMs = null;
  const snapshot = core().snapshot();
  const events = Object.values(snapshot.events).filter(
    (e) =>
      e.attackerID === Number(target?.itemID) &&
      e.systemID === scene.systemID &&
      !["closed", "expired", "resolving"].includes(e.status) &&
      Date.now() - e.lastThreatAt <= 30000,
  );
  for (const lease of Object.values(snapshot.leases)) {
    const event = events.find((e) => e.id === lease.eventID);
    if (
      !event ||
      lease.characterID === Number(bot.characterID) ||
      lease.phase === "disengaging"
    )
      continue;
    const actor = attached(lease.characterID);
    if (
      !actor ||
      actor.scene !== scene ||
      scopeKey(actor.entity) !== event.scope ||
      !related(lease.characterID, bot.characterID)
    )
      continue;
    if (!legal(actor.bot, actor.entity, target, scene, event)) continue;
    reinforcementAccepted = true;
    if (lease.phase === "travelling") {
      const position = event.victims[bot.characterID]?.position;
      const forecast = require("./playerBotRescueArrival").estimateArrival(
        actor.entity,
        scene,
        position,
      );
      if (forecast)
        acceptedEtaMs = Math.min(acceptedEtaMs ?? Infinity, forecast.etaMs);
    }
    if (
      !["on-grid", "engaging"].includes(lease.phase) ||
      distance(actor.entity.position, target.position) > 250000
    )
      continue;
    const ds = combat().getControlledDrones(scene, actor.entity.itemID);
    // Count support only when drones are actually assigned and within control range.
    const fit = require("./playerBotCombatFitRuntime").buildCombatFitSnapshot(
      actor.bot,
      actor.entity,
      { deployedDrones: ds },
    ).fit;
    if (
      !fit?.ready ||
      distance(actor.entity.position, target.position) >
        fit.droneControlRange ||
      !ds.some((d) => Number(d.targetID) === Number(target.itemID))
    )
      continue;
    onGridEffectiveHP +=
      combat().estimateEffectiveHitPoints(
        actor.entity.typeID,
        actor.entity,
        fit,
      ) * Math.min(1, fit.totalDrones / 5);
  }
  const ownLease = snapshot.leases[bot.characterID];
  const protectedIDs = new Set([
    Number(bot.characterID),
    ...Object.keys(snapshot.events[ownLease?.eventID]?.victims || {}).map(
      Number,
    ),
  ]);
  const relevant = Object.values(snapshot.events).filter(
    (e) =>
      e.systemID === scene.systemID &&
      Date.now() - e.lastThreatAt <= 30000 &&
      !["closed", "expired", "resolving"].includes(e.status) &&
      Object.keys(e.victims).some((id) => protectedIDs.has(Number(id))),
  );
  const ownActor = attached(bot.characterID),
    visible = ownActor
      ? new Set(
          (scene.getVisibleEntitiesForSession(ownActor.session) || []).map(
            (e) => Number(e.itemID),
          ),
        )
      : new Set();
  let additionalEnemyEffectiveHP = 0,
    unknownAdditionalThreat = false;
  for (const id of new Set(relevant.map((e) => e.attackerID))) {
    if (id === Number(target?.itemID) || !visible.has(id)) continue;
    const enemy = scene.getEntityByID(id);
    if (
      !enemy ||
      enemy.destroying ||
      !scope.canEntitiesInteractLocally(ownActor.entity, enemy)
    )
      continue;
    const hp = combat().estimateEffectiveHitPoints(enemy.typeID, enemy);
    if (hp > 0) additionalEnemyEffectiveHP += hp;
    else unknownAdditionalThreat = true;
  }
  return {
    onGridEffectiveHP,
    reinforcementAccepted,
    acceptedEtaMs,
    additionalEnemyEffectiveHP,
    unknownAdditionalThreat,
  };
}
function candidates(eventScene, eventTarget, attackerID) {
  const settings = config.get(),
    out = [];
  for (const id of settings.responderIDs) {
    const bot = bots().getBotByCharacterID(id);
    if (!bot || bot.status === "paused" || bot.autonomyPaused) continue;
    if (interrupts.isBusy(id) || interrupts.hasPending(id) || hasLease(id))
      continue;
    const presence = space().getBotPresenceInfo(bot);
    if (
      !presence.connected ||
      !presence.inSpace ||
      presence.solarSystemID !== eventScene.systemID
    )
      continue;
    const op = operations().getOperation(id),
      role =
        op?.kind === "combat" && op.mode !== "piracy"
          ? "security"
          : bot.specialty;
    const cycle = require("./playerBotIndustryCycleRuntime").getCycle(id);
    if (
      cycle &&
      (["active", "holding", "review"].includes(cycle.status) || cycle.pending)
    )
      continue;
    if (!["security", "piracy"].includes(role)) continue;
    if (
      require("./playerBotTaskRuntime").hasBlockingLease(id) ||
      op?.routeTaskID
    )
      continue;
    const active = op && ["active", "holding"].includes(op.status);
    if (
      active &&
      (op.kind !== "combat" ||
        op.stage !== "engage" ||
        op.siteInstanceID ||
        (op.targetID && Number(op.targetID) !== Number(attackerID)) ||
        (op.defensiveTargetID &&
          Number(op.defensiveTargetID) !== Number(attackerID)))
    )
      continue;
    if (op?.pending || op?.status === "review" || op?.loadSheddingPaused)
      continue;
    const actor = space().getActorSpace(bot),
      state = space().getSpaceState(bot);
    if (
      actor.scene !== eventScene ||
      state.busy ||
      !operations().hasRoleShipFit(bot, role)
    )
      continue;
    const key = scopeKey(actor.entity);
    if (!key) continue;
    out.push({
      characterID: id,
      connected: true,
      ready: true,
      preemptible: true,
      role,
      systemID: eventScene.systemID,
      scope: key,
      existingEscort:
        Number(
          operations().getOperation(Number(eventTarget.session?.characterID))
            ?.escortCharacterID,
        ) === id,
      onGrid: distance(actor.entity.position, eventTarget.position) <= 250000,
      etaMs: null,
      operationID: op?.operationID || null,
      distanceMeters: distance(actor.entity.position, eventTarget.position),
      resume: {
        position: { ...actor.entity.position },
        shipID: Number(actor.entity.itemID),
        operationID: op?.operationID || null,
        status: op?.status || null,
        moduleIDs: require("../fitting/liveFittingState")
          .getFittedModuleItems(id, actor.entity.itemID)
          .map((m) => Number(m.itemID)),
      },
    });
  }
  return out;
}
function wake(id) {
  require("./playerBotAutonomyRuntime")
    .wakeIndustryCycleStep(id, { immediate: true })
    .catch((error) =>
      require("../../utils/logger").warn(
        `[LocalDefense] Wake ${id}: ${error.message}`,
      ),
    );
}
function noteThreat(scene, attacker, victim, kind = "damage") {
  const settings = config.get();
  if (
    !settings.enabled ||
    !settings.systemIDs.includes(Number(scene?.systemID))
  )
    return false;
  const id = Number(victim?.session?.characterID);
  if (!id || victim.session._playerBotActor !== true || !attacker) return false;
  const key = scopeKey(victim);
  if (!key || !scope.canEntitiesInteractLocally(attacker, victim)) return false;
  const source = classifyAttacker(attacker);
  if (!source) return { accepted: false, reason: "excluded-attacker-source" };
  const op = operations().getOperation(id);
  const request = core().request({
    ...source,
    victimID: id,
    attackerID: Number(attacker.itemID),
    systemID: Number(scene.systemID),
    scope: key,
    side: side(id),
    kind,
    authoritative: true,
    role:
      op?.kind === "mine"
        ? "miner"
        : op?.kind === "combat"
          ? "combat"
          : "noncombat",
    position: victim.position,
  });
  if (request.accepted && !request.coalesced) {
    const assigned = core().dispatch(
      candidates(scene, victim, attacker.itemID),
    );
    for (const lease of assigned) {
      wake(lease.characterID);
      // The durable reservation already exists. Execute only its first step
      // promptly; shared pilot ownership still excludes concurrent work. All
      // subsequent steps and crash recovery remain on the durable scheduler.
      void advance(lease.characterID).catch((error) =>
        require("../../utils/logger").warn(
          `[LocalDefense] Initial step failed: ${error.message}`,
        ),
      );
    }
  }
  return request;
}
const pendingThreats = new Map();
function reportThreat(scene, attacker, victim, kind) {
  const settings = config.get();
  if (
    !settings.enabled ||
    !settings.systemIDs.includes(Number(scene?.systemID))
  )
    return;
  if (victim?.session?._playerBotActor !== true || !classifyAttacker(attacker))
    return;
  // Coalesce before queueing, retaining the strongest notification in this turn.
  const key = `${scene.systemID}:${attacker.itemID}:${victim.itemID}`;
  const existing = pendingThreats.get(key),
    rank = { damage: 1, web: 2, neut: 2, scram: 3 };
  if (existing) {
    if ((rank[kind] || 0) > (rank[existing.kind] || 0)) existing.kind = kind;
    return;
  }
  const notification = { kind };
  pendingThreats.set(key, notification);
  setImmediate(() => {
    pendingThreats.delete(key);
    try {
      noteThreat(scene, attacker, victim, notification.kind);
    } catch (error) {
      require("../../utils/logger").warn(
        `[LocalDefense] Request failed: ${error.message}`,
      );
    }
  });
}
async function advance(characterID, options = {}) {
  const c = core();
  c.maintain();
  let snapshot = c.snapshot(),
    lease = snapshot.leases[characterID];
  if (!lease) return null;
  const owner = interrupts.acquire(characterID, "local-defense", lease.token);
  if (!owner) return { delayMs: 1000, busy: true };
  try {
    const event = snapshot.events[lease.eventID],
      actor = attached(characterID),
      settings = config.get();
    if (!settings.enabled) {
      c.disable();
      lease = c.snapshot().leases[characterID];
    }
    if (
      !actor ||
      Number(actor.entity.itemID) !== Number(lease.resume?.shipID)
    ) {
      c.update(characterID, lease.token, "disengaging", {
        reason: "actor-offline-or-ship-changed",
      });
      c.update(characterID, lease.token, "resumed", {
        safeToResume: true,
        reason: "no-live-original-ship",
      });
      return { delayMs: 1000 };
    }
    const { bot, entity, session, scene } = actor,
      state = space().getSpaceState(bot);
    const currentOperation = operations().getOperation(characterID);
    const originalOperationUnchanged =
      (currentOperation?.operationID || null) === (lease.operationID || null) &&
      (currentOperation?.status || null) === (lease.resume?.status || null);
    const connected =
      space().getBotPresenceInfo(bot).connected && !options.unavailable;
    const emergency =
      currentOperation?.emergencyRetreat || currentOperation?.threatRetreat;
    if (
      !originalOperationUnchanged ||
      bot.status === "paused" ||
      bot.autonomyPaused ||
      !connected ||
      emergency
    ) {
      c.update(characterID, lease.token, "disengaging", {
        reason: "pilot-or-original-operation-unavailable",
      });
      lease = c.snapshot().leases[characterID];
    }
    const controlled = combat().getControlledDrones(scene, entity.itemID);
    const target = scene.getEntityByID(event.attackerID);
    const victims = Object.keys(event.victims)
      .map(Number)
      .map(attached)
      .filter(
        (a) => a && a.scene === scene && scopeKey(a.entity) === event.scope,
      );
    const liveVictim = victims.find(
      (a) =>
        distance(a.entity.position, event.victims[a.bot.characterID].position) <
        250000,
    );
    if (
      !target ||
      target.destroying ||
      target.destructionState === "destroying" ||
      !liveVictim ||
      Date.now() - event.lastThreatAt > 30000 ||
      scopeKey(entity) !== event.scope ||
      scene.systemID !== event.systemID ||
      !victims.some((v) => related(characterID, v.bot.characterID))
    ) {
      if (
        c.close(
          event.id,
          !target
            ? "attacker-gone"
            : !liveVictim
              ? "victims-left-incident-grid"
              : "threat-expired-or-no-longer-legal",
        )
      ) {
        for (const id of Object.keys(event.victims).map(Number)) wake(id);
      }
      lease = c.snapshot().leases[characterID];
    }
    if (
      lease.phase !== "disengaging" &&
      !legal(bot, entity, target, scene, event)
    ) {
      c.update(characterID, lease.token, "disengaging", {
        reason: "individual-engagement-right-expired",
      });
      lease = c.snapshot().leases[characterID];
    }
    if (lease.phase === "disengaging") {
      // Hand control back immediately when escape is pending or the pilot cannot
      // work. Recalling drones is best effort and must never delay emergency warp.
      if (
        emergency ||
        !connected ||
        bot.status === "paused" ||
        bot.autonomyPaused
      ) {
        if (controlled.length)
          drones().commandReturnBay(
            session,
            controlled.map((d) => Number(d.itemID)),
          );
        c.update(characterID, lease.token, "resumed", {
          safeToResume: true,
          reason: emergency
            ? "emergency-navigation-handoff"
            : "pilot-unavailable-handoff",
          dronesRemaining: controlled.length,
        });
        return { delayMs: 1, resumed: true };
      }
      if (controlled.length) {
        drones().commandReturnBay(
          session,
          controlled.map((d) => Number(d.itemID)),
        );
        if (!lease.cleanupAt)
          c.annotate(characterID, lease.token, { cleanupAt: Date.now() });
        if (Date.now() - (lease.cleanupAt || Date.now()) < 20000)
          return { delayMs: 1000 };
      }
      if (state.busy) return { delayMs: 1000 };
      const original = lease.resume?.position;
      if (
        originalOperationUnchanged &&
        bot.status !== "paused" &&
        !bot.autonomyPaused &&
        scene.systemID === lease.systemID &&
        scopeKey(entity) === lease.scope &&
        original &&
        distance(entity.position, original) > 25000 &&
        !operations().getOperation(characterID)?.emergencyRetreat
      ) {
        if (Date.now() - Number(lease.returnOrderedAt || 0) > 5000) {
          if (distance(entity.position, original) > 150000)
            space().warpToPoint(bot, original);
          else
            require("../../space/runtime").gotoPoint(session, original, {
              commandSource: "PlayerBotRescueResume",
            });
          c.annotate(characterID, lease.token, { returnOrderedAt: Date.now() });
        }
        if (Date.now() - Number(lease.cleanupAt || lease.assignedAt) < 120000)
          return { delayMs: 1000 };
      }
      c.update(characterID, lease.token, "resumed", {
        safeToResume: true,
        dronesRemaining: controlled.length,
      });
      return { delayMs: 1000, resumed: true };
    }
    if (state.busy) return { delayMs: 1000 };
    if (
      Date.now() - lease.assignedAt > 90000 &&
      ["reserved", "travelling"].includes(lease.phase)
    ) {
      c.update(characterID, lease.token, "disengaging", {
        reason: "navigation-timeout",
      });
      return { delayMs: 1000 };
    }
    const victim = liveVictim.entity;
    const visible = (scene.getVisibleEntitiesForSession(session) || []).some(
      (e) => Number(e.itemID) === event.attackerID,
    );
    if (distance(entity.position, victim.position) > 250000 || !visible) {
      if (lease.phase === "reserved")
        c.update(characterID, lease.token, "travelling", {});
      if (Date.now() - Number(lease.lastCommandAt || 0) > 5000) {
        const moved =
          distance(entity.position, victim.position) > 150000
            ? space().warpToPoint(bot, { ...victim.position })
            : space().approach(bot, victim.itemID, 10000);
        c.annotate(characterID, lease.token, {
          lastCommandAt: Date.now(),
          lastDecision: moved.message || "moving",
        });
        if (!moved.success)
          c.update(characterID, lease.token, "disengaging", {
            reason: moved.message,
          });
      }
      return { delayMs: 1000 };
    }
    const evidence = {
      systemID: scene.systemID,
      sameScope: true,
      visible: true,
      inRange: true,
    };
    if (["reserved", "travelling"].includes(lease.phase))
      c.update(characterID, lease.token, "on-grid", evidence);
    const fitResult =
      require("./playerBotCombatFitRuntime").buildCombatFitSnapshot(
        bot,
        entity,
        { ...state, deployedDrones: controlled },
      );
    const fit = fitResult.fit || {},
      own = combat().estimateEffectiveHitPoints(entity.typeID, entity, fit);
    const fitting = require("../fitting/liveFittingState");
    const modules = fitting.getFittedModuleItems(characterID, entity.itemID);
    const modulesValid = (lease.resume?.moduleIDs || []).every((id) =>
      modules.some(
        (m) => Number(m.itemID) === id && fitting.isEffectivelyOnlineModule(m),
      ),
    );
    const enemy = combat().estimateEffectiveHitPoints(target.typeID, target);
    const decision = !modulesValid
      ? { action: "evade", reason: "original-fitting-changed" }
      : settings.aggressive
        ? require("./playerBotDefenseAssessment").assess(
            bot,
            target,
            scene,
            operations().getOperation(characterID),
            true,
            { alreadyEngaged: lease.phase === "engaging" },
          )
        : combat().assessDefensiveResponse(
            bot,
            target,
            scene,
            operations().getOperation(characterID),
          );
    c.annotate(characterID, lease.token, {
      memory: decision.memory || {},
      lastDecision: decision.reason,
    });
    if (decision.action !== "engage") {
      c.update(characterID, lease.token, "disengaging", {
        reason: decision.reason,
      });
      operations().requestThreatRetreat(
        characterID,
        event.attackerID,
        decision.reason,
      );
      return { delayMs: 1000 };
    }
    let active = controlled;
    if (!active.length) {
      const launched = combat().launchDrones(
        bot,
        session,
        scene,
        entity.itemID,
      );
      if (!launched.success) {
        c.update(characterID, lease.token, "disengaging", {
          reason: launched.message,
        });
        return { delayMs: 1000 };
      }
      active = launched.drones;
    }
    const range = Math.min(
      15000,
      Number(fit.droneAttackRange) || 0,
      Number(fit.droneControlRange) || 0,
    );
    if (distance(entity.position, target.position) > range * 0.8) {
      space().approach(bot, target.itemID, Math.max(1000, range * 0.6));
      return { delayMs: 1000 };
    }
    if (!active.some((d) => Number(d.targetID) === event.attackerID))
      drones().commandEngage(
        session,
        active.map((d) => Number(d.itemID)),
        event.attackerID,
      );
    const engaged = combat()
      .getControlledDrones(scene, entity.itemID)
      .some((d) => Number(d.targetID) === event.attackerID);
    if (engaged)
      c.update(characterID, lease.token, "engaging", {
        ...evidence,
        authorityAccepted: true,
      });
    return { delayMs: 1000, engaging: engaged };
  } finally {
    interrupts.release(owner);
    operations().drainInterruptions(characterID);
  }
}
function cancelIncident(id) {
  const leases = Object.values(core().snapshot().leases).filter(
    (l) => l.eventID === id,
  );
  const closed = core().close(id, "operator-cancelled");
  if (closed) for (const lease of leases) wake(lease.characterID);
  return closed;
}
module.exports = {
  noteThreat,
  reportThreat,
  advance,
  hasLease,
  hasLiveAttack,
  maintain: () => core().maintain(),
  snapshot: () => core().snapshot(),
  related,
  scopeKey,
  supportFor,
  cancelIncident,
};

"use strict";

const { getCharacterRecord, getActiveShipRecord } = require("../character/characterState");
const playerBots = require("./playerBotRuntime");
const spaceRuntime = require("../../space/runtime");
const worldData = require("../../space/worldData");
const {
  isDockedSession,
} = require("../structure/structureLocation");
const {
  getMachoUserErrorMessage,
  isUserErrorMachoError,
} = require("../../common/machoErrors");
const log = require("../../utils/logger");
const { distance } = require("../../common/vector");
const playerBotCombatPolicy = require("./playerBotCombatPolicy");

const STARGATE_JUMP_RANGE_METERS = 2500;
const MIN_WARP_DISTANCE_METERS = 150_000;
const MAX_STARGATE_ROUTE_HOPS = 64;
// Gate topology and security are static for this process; bubble checks still
// happen against live scene state at the actual warp step.
const MAX_CACHED_STARGATE_ROUTES = 2_048;
const CORPORATION_BOT_RECONCILE_INTERVAL_MS = 30_000;
const ROUTE_SECURITY_COST = Object.freeze({ highsec: 1, lowsec: 3, nullsec: 9 });

const actorSessions = new Map();
const stargateRouteCache = new Map();
let desiredConnectedCharacterIDs = new Set();
let lastConnectionPlan = null;
const SHUTDOWN_TIMEOUT_MS = 5_000;
let started = false;
let localPresenceTimer = null;
let corporationBotPresenceTimer = null;
let connectedActorCount = 0;
const LOCAL_PRESENCE_INTERVAL_MS = 15_000;

function normalizePositiveID(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function getSurfaceDistanceBetweenEntities(entity, targetEntity) {
  const centerDistance = distance(entity.position, targetEntity.position);
  return Math.max(
    0,
    centerDistance - Math.max(0, Number(entity.radius) || 0) -
      Math.max(0, Number(targetEntity.radius) || 0),
  );
}

function vectorDistance(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.hypot(
    Number(left.x) - Number(right.x),
    Number(left.y) - Number(right.y),
    Number(left.z) - Number(right.z),
  );
}

function buildBubbleEscapePoint(position, activeVolumes = [], marginMeters = 50_000) {
  if (!position || !Array.isArray(activeVolumes) || !activeVolumes.length) return null;
  const fields = activeVolumes.filter((volume) => volume && volume.position &&
    Number(volume.rangeMeters) > 0);
  if (!fields.length) return null;

  // Choose a short subwarp vector that exits every sphere intersected on that
  // ray. A conservative triangle-inequality vector can put a bot millions of
  // kilometres away when a distant sphere is active in the same system.
  const directions = [];
  for (const field of fields) {
    const dx = Number(position.x) - Number(field.position.x);
    const dy = Number(position.y) - Number(field.position.y);
    const dz = Number(position.z) - Number(field.position.z);
    const magnitude = Math.hypot(dx, dy, dz);
    if (magnitude > 0) directions.push([dx / magnitude, dy / magnitude, dz / magnitude]);
  }
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (!x && !y && !z) continue;
        const magnitude = Math.hypot(x, y, z);
        directions.push([x / magnitude, y / magnitude, z / magnitude]);
      }
    }
  }

  let best = null;
  for (const [ux, uy, uz] of directions) {
    let distance = 0;
    for (const field of fields) {
      const cx = Number(field.position.x) - Number(position.x);
      const cy = Number(field.position.y) - Number(position.y);
      const cz = Number(field.position.z) - Number(position.z);
      const projection = cx * ux + cy * uy + cz * uz;
      const perpendicularSquared = Math.max(0, cx * cx + cy * cy + cz * cz - projection * projection);
      const radius = Number(field.rangeMeters);
      if (perpendicularSquared > radius * radius) continue;
      const exitDistance = projection + Math.sqrt(Math.max(0, radius * radius - perpendicularSquared));
      if (exitDistance >= 0) distance = Math.max(distance, exitDistance + marginMeters);
    }
    if (!(distance > 0) || (best && distance >= best.distance)) continue;
    const point = {
      x: Number(position.x) + ux * distance,
      y: Number(position.y) + uy * distance,
      z: Number(position.z) + uz * distance,
    };
    if (fields.some((field) => vectorDistance(point, field.position) <= Number(field.rangeMeters))) continue;
    best = { point, distance };
  }
  return best ? best.point : null;
}

function resolveInterdictionNavigation(scene, entity, target) {
  if (!scene || !entity || !target || typeof scene.getInterdictionVolumes !== "function") {
    return { action: "clear" };
  }
  const volumes = scene.getInterdictionVolumes();
  if (!volumes || typeof volumes.resolveWarpOutcome !== "function") return { action: "clear" };
  const context = { for: entity };
  const containing = typeof volumes.findVolumeContaining === "function"
    ? volumes.findVolumeContaining(entity, context)
    : null;
  if (containing) {
    const active = typeof volumes.listActive === "function" ? volumes.listActive(context) : [containing];
    const escapePoint = buildBubbleEscapePoint(entity.position, active,
      Math.max(10_000, Number(entity.radius) || 0));
    return escapePoint
      ? { action: "escape", containing, escapePoint, activeVolumeCount: active.length }
      : { action: "blocked", reason: "The active interdiction field has no usable position data." };
  }

  const outcome = volumes.resolveWarpOutcome(entity, target, context);
  if (!outcome) return { action: "clear" };
  const candidates = (Array.isArray(scene.staticEntities) ? scene.staticEntities : [])
    .filter((candidate) => candidate && Number(candidate.itemID) > 0 &&
      Number(candidate.itemID) !== Number(entity.itemID) &&
      Number(candidate.itemID) !== Number(target.itemID) && candidate.position)
    .filter((candidate) => vectorDistance(entity.position, candidate.position) >= MIN_WARP_DISTANCE_METERS &&
      vectorDistance(candidate.position, target.position) >= MIN_WARP_DISTANCE_METERS)
    .map((candidate) => ({
      candidate,
      distance: vectorDistance(entity.position, candidate.position) +
        vectorDistance(candidate.position, target.position),
    }))
    .sort((left, right) => left.distance - right.distance ||
      Number(left.candidate.itemID) - Number(right.candidate.itemID));
  for (const { candidate } of candidates) {
    if (volumes.resolveWarpOutcome(entity, candidate, context)) continue;
    if (volumes.resolveWarpOutcome(candidate, target, context)) continue;
    return { action: "detour", candidate, outcome };
  }
  return { action: "blocked", outcome };
}

function getSystemRouteSecurity(systemID) {
  const system = worldData.getSolarSystemByID(Number(systemID));
  if (!system) return -1;
  const security = Number(system && system.security);
  return Number.isFinite(security) ? security : -1;
}

function routeRiskForSystems(systemIDs = []) {
  const systems = (Array.isArray(systemIDs) ? systemIDs : []).map((systemID) => ({
    systemID: Number(systemID) || 0,
    security: getSystemRouteSecurity(systemID),
  }));
  const lowsecSystemIDs = systems
    .filter((entry) => entry.systemID && entry.security > 0 && entry.security < 0.45)
    .map((entry) => entry.systemID);
  const nullsecSystemIDs = systems
    .filter((entry) => entry.systemID && entry.security <= 0)
    .map((entry) => entry.systemID);
  const knownSecurity = systems.filter((entry) => entry.systemID).map((entry) => entry.security);
  return {
    lowestSecurity: knownSecurity.length ? Math.round(Math.min(...knownSecurity) * 1000) / 1000 : null,
    lowsecSystemIDs,
    nullsecSystemIDs,
    securityPenalty: lowsecSystemIDs.length * (ROUTE_SECURITY_COST.lowsec - ROUTE_SECURITY_COST.highsec) +
      nullsecSystemIDs.length * (ROUTE_SECURITY_COST.nullsec - ROUTE_SECURITY_COST.highsec),
  };
}

function routeSystemCost(systemID) {
  const security = getSystemRouteSecurity(systemID);
  if (security >= 0.45) return ROUTE_SECURITY_COST.highsec;
  if (security > 0) return ROUTE_SECURITY_COST.lowsec;
  return ROUTE_SECURITY_COST.nullsec;
}

function compareRouteCandidates(left, right) {
  return left.cost - right.cost || left.gates.length - right.gates.length || left.sequence - right.sequence;
}

function cloneStargateRoute(route) {
  return {
    ...route,
    ...(Array.isArray(route.systemIDs) ? { systemIDs: [...route.systemIDs] } : {}),
    ...(Array.isArray(route.gates)
      ? { gates: route.gates.map((gate) => gate && typeof gate === "object" ? { ...gate } : gate) }
      : {}),
    ...(route.risk && typeof route.risk === "object"
      ? {
        risk: {
          ...route.risk,
          lowsecSystemIDs: [...(route.risk.lowsecSystemIDs || [])],
          nullsecSystemIDs: [...(route.risk.nullsecSystemIDs || [])],
        },
      }
      : {}),
  };
}

function rememberStargateRoute(key, route) {
  stargateRouteCache.delete(key);
  stargateRouteCache.set(key, cloneStargateRoute(route));
  if (stargateRouteCache.size > MAX_CACHED_STARGATE_ROUTES) {
    stargateRouteCache.delete(stargateRouteCache.keys().next().value);
  }
  return route;
}

function readCachedStargateRoute(key) {
  const route = stargateRouteCache.get(key);
  if (!route) return null;
  stargateRouteCache.delete(key);
  stargateRouteCache.set(key, route);
  return cloneStargateRoute(route);
}

function pushRouteCandidate(heap, candidate) {
  heap.push(candidate);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRouteCandidates(heap[parent], candidate) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = candidate;
}

function popRouteCandidate(heap) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= heap.length) break;
      const child = right < heap.length && compareRouteCandidates(heap[right], heap[left]) < 0
        ? right
        : left;
      if (compareRouteCandidates(last, heap[child]) <= 0) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

function createActorSession(bot) {
  const session = playerBots.createBotSession(bot);
  const characterID = normalizePositiveID(bot && bot.characterID);
  if (!characterID) throw new Error("PLAYERBOT_CHARACTER_ID_REQUIRED");
  const clientID = -characterID;
  const connectedAt = Date.now();
  Object.assign(session, {
    clientID,
    clientId: clientID,
    clientid: clientID,
    sessionType: "playerbot-actor",
    _playerBotActor: true,
    // A sink transport so the session registry treats the bot like a logged-in
    // pilot (Local, station guests, online status) while nothing is sent.
    socket: {
      destroyed: false,
      playerBotSink: true,
      remoteAddress: "playerbot",
      write() { return true; },
      end() {},
      destroy() { this.destroyed = true; },
    },
    connectTime: connectedAt,
    connectedAt,
    lastActivity: connectedAt,
    sendNotification() {
      // Playerbots have no retail transport. Scene broadcasts still reach real
      // pilots; notifications addressed to this server-owned actor are ignored.
      return true;
    },
    // Undock and stargate handoffs push session changes to the client. The
    // authoritative fields are resynced from the character record, so these
    // transport calls are dropped like a ClientSession whose socket closed.
    sendSessionChange() {},
    sendPacket() {},
    sendRawPayload() {},
    sendEncodedNotification() { return true; },
    sendServiceNotification() { return true; },
    sendObjectNotification() { return true; },
    sendClientCallRequest() { return null; },
  });
  return session;
}

function syncActorSession(session, character, fallbackCharacterID = 0) {
  const characterID = normalizePositiveID(character && character.characterID) ||
    normalizePositiveID(fallbackCharacterID);
  const corporationID = normalizePositiveID(character && character.corporationID);
  const allianceID = normalizePositiveID(character && character.allianceID);
  const warFactionID = normalizePositiveID(character && character.warFactionID);
  const stationID = normalizePositiveID(character && character.stationID);
  const structureID = normalizePositiveID(character && character.structureID);
  const systemID = normalizePositiveID(character && character.solarSystemID);
  const shipID = normalizePositiveID(character && character.shipID);
  const shipTypeID = normalizePositiveID(character && character.shipTypeID);
  Object.assign(session, {
    characterID,
    charID: characterID,
    charid: characterID,
    corporationID,
    corpid: corporationID,
    allianceID,
    allianceid: allianceID,
    warFactionID,
    warfactionid: warFactionID,
    stationID: stationID || null,
    stationid: stationID || null,
    stationid2: stationID || null,
    structureID: structureID || null,
    structureid: structureID || null,
    solarsystemid: systemID || null,
    solarsystemid2: systemID || null,
    regionID: normalizePositiveID(character && character.regionID) || null,
    regionid: normalizePositiveID(character && character.regionID) || null,
    shipID: shipID || null,
    shipid: shipID || null,
    shipTypeID: shipTypeID || null,
    shiptypeid: shipTypeID || null,
    characterName: String(character && character.characterName || ""),
  });
  // Actor sessions stay in memory while a bot's corporation roles can change.
  // Refresh the same persisted role masks used for human sessions before any
  // corporation or structure authority check uses this server-owned pilot.
  playerBots.syncBotCorporationSession(session, { characterID, corporationID }, character);
  return session;
}

function getActorSession(bot) {
  const characterID = normalizePositiveID(bot && bot.characterID);
  if (!characterID) throw new Error("PLAYERBOT_CHARACTER_ID_REQUIRED");
  let session = actorSessions.get(characterID);
  if (!session) {
    session = createActorSession(bot);
    actorSessions.set(characterID, session);
  }
  const character = getCharacterRecord(characterID);
  if (!character) throw new Error(`PLAYERBOT_CHARACTER_NOT_FOUND:${characterID}`);
  syncActorSession(session, character, characterID);
  if (started && desiredConnectedCharacterIDs.has(characterID)) registerPresence(session, characterID);
  return session;
}

function registerPresence(session, characterID) {
  const id = normalizePositiveID(characterID);
  if (!id || !desiredConnectedCharacterIDs.has(id)) return false;
  const sessionRegistry = require("../chat/sessionRegistry");
  if (!sessionRegistry.isRegisteredSession(session)) {
    const limit = require("./playerBotConnectionScheduleRuntime").getMaxConnected();
    if (connectedActorCount >= limit) return false;
  }
  try {
    require("./playerBotPortraitRuntime").ensurePortrait(id);
  } catch (error) {
    log.warn(`[PlayerBots] Portrait generation failed char=${id}: ${error.message}`);
  }
  if (!sessionRegistry.isRegisteredSession(session)) {
    sessionRegistry.register(session);
    connectedActorCount += 1;
    require("../online/onlineStatusRuntime").notifyCharacterOnlineState(id, true);
  }
  return true;
}

function unregisterPresence(session, characterID) {
  const sessionRegistry = require("../chat/sessionRegistry");
  const xmpp = require("../chat/xmppStubServer");
  if (session && session._playerBotLocalRoom) {
    xmpp.broadcastPlayerBotLocalPresence(session._playerBotLocalRoom, characterID, false);
    session._playerBotLocalRoom = "";
  }
  if (session) {
    for (const roomName of session._playerBotScopedPresenceRooms || []) {
      xmpp.broadcastPlayerBotScopedPresence(roomName, characterID, false);
    }
    session._playerBotScopedPresenceRooms = [];
  }
  if (session && sessionRegistry.isRegisteredSession(session)) {
    sessionRegistry.unregister(session);
    connectedActorCount = Math.max(0, connectedActorCount - 1);
    require("../online/onlineStatusRuntime").notifyCharacterOnlineState(characterID, false);
  }
}

// Bots have no XMPP connection, so Local learns of their arrivals and
// departures from here: whenever a bot's Local room changes, its presence is
// withdrawn from the old room and announced in the new one.
function syncLocalPresence() {
  let chatRuntime;
  let xmpp;
  try {
    chatRuntime = require("../chat/channelRules");
    xmpp = require("../chat/xmppStubServer");
  } catch (error) {
    return;
  }
  const sessionRegistry = require("../chat/sessionRegistry");
  for (const session of sessionRegistry.getSessions()) {
    if (!session || session._playerBotActor !== true) continue;
    const characterID = normalizePositiveID(session.characterID || session.charID || session.charid);
    if (!characterID) continue;
    try {
      const roomName = chatRuntime.getLocalChatRoomNameForSession(session) || "";
      if (roomName === (session._playerBotLocalRoom || "")) continue;
      if (session._playerBotLocalRoom) xmpp.broadcastPlayerBotLocalPresence(session._playerBotLocalRoom, characterID, false);
      if (roomName) xmpp.broadcastPlayerBotLocalPresence(roomName, characterID, true);
      session._playerBotLocalRoom = roomName;
    } catch (error) {
      log.debug(`[PlayerBots] Local presence sync failed char=${characterID}: ${error.message}`);
    }
  }
}

function syncScopedChannelPresence() {
  let xmpp;
  try {
    xmpp = require("../chat/xmppStubServer");
  } catch (error) {
    return;
  }
  const sessionRegistry = require("../chat/sessionRegistry");
  for (const session of sessionRegistry.getSessions()) {
    if (!session || session._playerBotActor !== true) continue;
    const characterID = normalizePositiveID(session.characterID || session.charID || session.charid);
    if (!characterID) continue;
    try {
      const currentRooms = xmpp.getPlayerBotScopedRoomNames(session);
      const previousRooms = new Set(session._playerBotScopedPresenceRooms || []);
      for (const roomName of previousRooms) {
        if (!currentRooms.has(roomName)) {
          xmpp.broadcastPlayerBotScopedPresence(roomName, characterID, false);
        }
      }
      for (const roomName of currentRooms) {
        if (!previousRooms.has(roomName)) {
          xmpp.broadcastPlayerBotScopedPresence(roomName, characterID, true);
        }
      }
      session._playerBotScopedPresenceRooms = [...currentRooms];
    } catch (error) {
      log.debug(`[PlayerBots] Affiliation presence sync failed char=${characterID}: ${error.message}`);
    }
  }
}

function countAutonomousBotActorsInSystem(systemID, excludedCharacterID = 0, humanControlledBotIDs = new Set()) {
  const id = normalizePositiveID(systemID);
  if (!id) return 0;
  let count = 0;
  for (const [characterID, session] of actorSessions) {
    if (characterID === normalizePositiveID(excludedCharacterID) || humanControlledBotIDs.has(characterID) ||
        !session || !session._space) continue;
    const scene = spaceRuntime.getSceneForSession(session);
    if (Number(scene && scene.systemID) === id && scene.getShipEntityForSession(session)) count += 1;
  }
  return count;
}

function systemActorCapacityError(bot, systemID, options = {}) {
  const characterID = normalizePositiveID(bot && bot.characterID);
  const id = normalizePositiveID(systemID);
  if (options.allowOverCapacityDeparture === true) return null;
  const capacity = require("./playerBotCapacityRuntime");
  const humanControlledBotIDs = capacity.getHumanControlledBotIDs();
  if (!id || humanControlledBotIDs.has(characterID)) return null;
  const limit = capacity.getMaxAutonomousBotsPerSystem();
  const current = countAutonomousBotActorsInSystem(id, characterID, humanControlledBotIDs);
  if (current < limit) return null;
  // An active durable task is allowed to enter or leave an at-capacity system
  // and finish. The director relocates its bot when that task completes.
  if (activeWorkCharacterIDs().has(characterID)) return null;
  const error = new Error(
    `System ${id} already has ${current} autonomous playerbot actors (limit ${limit}); this bot is queued until room is available.`,
  );
  error.code = "PLAYERBOT_SYSTEM_CAPACITY";
  error.systemID = id;
  error.limit = limit;
  return error;
}

function ensureActorInSpace(bot, options = {}) {
  const session = getActorSession(bot);
  if (session._space) {
    const scene = spaceRuntime.getSceneForSession(session);
    const entity = scene && scene.getShipEntityForSession(session);
    if (entity) return { session, scene, entity };
    if (scene) spaceRuntime.detachSession(session, { broadcast: false });
    else session._space = null;
  }

  if (isDockedSession(session)) {
    throw new Error("PLAYERBOT_DOCKED_USE_UNDOCK");
  }
  const character = getCharacterRecord(bot.characterID) || {};
  const ship = getActiveShipRecord(bot.characterID);
  const systemID = normalizePositiveID(character.solarSystemID);
  if (!ship || !systemID) throw new Error("PLAYERBOT_SPACE_SHIP_UNAVAILABLE");
  const capacityError = systemActorCapacityError(bot, systemID, options);
  if (capacityError) throw capacityError;
  const entity = spaceRuntime.attachSession(session, ship, {
    systemID,
    broadcast: true,
    spawnStopped: false,
    skipLegacyStationNormalization: true,
    reconcileUniverseSites: true,
    universeSiteReconcileReason: "playerbot-actor-recovery",
  });
  const scene = spaceRuntime.getSceneForSession(session);
  if (!entity || !scene) throw new Error("PLAYERBOT_SPACE_ATTACH_FAILED");
  return { session, scene, entity };
}

function detachBotActorFromSpace(characterID, reason = "capacity") {
  const id = normalizePositiveID(characterID);
  const session = actorSessions.get(id);
  if (!session || !session._space) return false;
  spaceRuntime.detachSession(session, {
    broadcast: true,
    lifecycleReason: `playerbot-${String(reason || "capacity")}`,
  });
  return true;
}

function activeWorkCharacterIDs() {
  const operations = require("./playerBotOperationRuntime").listActiveOperations();
  const cycles = require("./playerBotIndustryCycleRuntime").listActiveCycles();
  return new Set([...operations, ...cycles].map((work) => normalizePositiveID(work.characterID)).filter(Boolean));
}

function getHumanConnectedCorporationIDs() {
  const capacity = require("./playerBotCapacityRuntime");
  const sessionRegistry = require("../chat/sessionRegistry");
  const corporationIDs = new Set();
  for (const session of sessionRegistry.getSessions()) {
    if (!session || capacity.isPlayerBotSession(session)) continue;
    const characterID = normalizePositiveID(session.characterID || session.charID || session.charid);
    if (!characterID) continue;
    const character = getCharacterRecord(characterID) || {};
    const corporationID = normalizePositiveID(
      session.corporationID || session.corpid || character.corporationID,
    );
    if (corporationID) corporationIDs.add(corporationID);
  }
  return corporationIDs;
}

function buildConnectionPlan(bots = playerBots.listBots(), options = {}) {
  const capacity = require("./playerBotCapacityRuntime");
  const humanCorporations = options.humanCorporations || getHumanConnectedCorporationIDs();
  const humanCorpBots = bots
    .filter((bot) => humanCorporations.has(Number(bot.corporationID)))
    .map((bot) => Number(bot.characterID));
  const priorityGroups = [
    capacity.getHumanControlledBotIDs(bots),
    humanCorpBots,
    [...activeWorkCharacterIDs()],
  ];
  if (Array.isArray(options.priorityGroups)) priorityGroups.push(...options.priorityGroups);
  return require("./playerBotConnectionScheduleRuntime").buildConnectionPlan(bots, {
    priorityGroups,
    nowMs: options.nowMs,
    maxConnected: options.maxConnected,
    windowMs: options.windowMs,
  });
}

function getConnectedBotCharacterIDs() {
  const sessionRegistry = require("../chat/sessionRegistry");
  return new Set(sessionRegistry.getSessions()
    .filter((session) => session && session._playerBotActor === true)
    .map((session) => normalizePositiveID(session.characterID || session.charID || session.charid))
    .filter(Boolean));
}

function isBotConnectedForWork(characterID, bots = null) {
  const id = normalizePositiveID(characterID);
  if (started) return desiredConnectedCharacterIDs.has(id);
  const roster = Array.isArray(bots) ? bots : playerBots.listBots();
  return buildConnectionPlan(roster).characterIDs.includes(id);
}

function nextBotConnectionAtMs(characterID, bots = playerBots.listBots(), nowMs = Date.now()) {
  return require("./playerBotConnectionScheduleRuntime").getNextScheduledAtMs(
    characterID,
    bots,
    nowMs,
    { includeCurrentGroup: false },
  );
}

function reconcileActorConnections(options = {}) {
  if (!started) {
    return { selected: 0, connected: getConnectedBotCharacterIDs().size, detached: 0, attached: 0, plan: null };
  }
  const bots = Array.isArray(options.bots) ? options.bots : playerBots.listBots();
  const humanCorporations = options.humanCorporations || getHumanConnectedCorporationIDs();
  const plan = buildConnectionPlan(bots, { ...options, humanCorporations });
  desiredConnectedCharacterIDs = new Set(plan.characterIDs);
  lastConnectionPlan = plan;
  const sessionRegistry = require("../chat/sessionRegistry");
  connectedActorCount = sessionRegistry.getSessions().filter((session) =>
    session && session._playerBotActor === true,
  ).length;
  const botsByID = new Map(bots.map((bot) => [Number(bot.characterID), bot]));
  let detached = 0;
  let attached = 0;

  for (const [characterID, session] of actorSessions) {
    const transportEnded = !session || !session.socket || session.socket.destroyed === true ||
      session._characterControlDisconnected === true;
    if (transportEnded) {
      unregisterPresence(session, characterID);
      if (session && session._space) {
        detachBotActorFromSpace(characterID, "connection-recovery");
        detached += 1;
      }
      actorSessions.delete(characterID);
      continue;
    }
    if (!sessionRegistry.isRegisteredSession(session) || desiredConnectedCharacterIDs.has(characterID)) continue;
    unregisterPresence(session, characterID);
    if (session._space) {
      detachBotActorFromSpace(characterID, "connection-rotation");
      detached += 1;
    }
  }
  const activeWork = activeWorkCharacterIDs();
  for (const characterID of desiredConnectedCharacterIDs) {
    const bot = botsByID.get(characterID);
    if (!bot) continue;
    try {
      const session = getActorSession(bot);
      registerPresence(session, characterID);
      if (activeWork.has(characterID) && !isDockedSession(session) &&
          bot.status !== "paused" && bot.autonomyPaused !== true) {
        const scene = session._space && spaceRuntime.getSceneForSession(session);
        const alreadyAttached = Boolean(scene && scene.getShipEntityForSession(session));
        ensureActorInSpace(bot);
        if (!alreadyAttached) attached += 1;
      } else if (session._space && !activeWork.has(characterID)) {
        detachBotActorFromSpace(characterID, "idle");
      }
    } catch (error) {
      log.warn(`[PlayerBots] Scheduled actor connection failed char=${characterID}: ${error.message}`);
    }
  }
  syncLocalPresence();
  syncScopedChannelPresence();
  return {
    selected: plan.selectedCount,
    connected: getConnectedBotCharacterIDs().size,
    detached,
    attached,
    plan,
  };
}

function ensureCorporationBotsConnected(corporationID) {
  const numericCorporationID = normalizePositiveID(corporationID);
  if (!numericCorporationID || !started) {
    return { corporationID: numericCorporationID, botCount: 0, connectedCount: 0, attachedCount: 0, failedCount: 0 };
  }
  const bots = playerBots.listBots().filter((bot) =>
    Number(bot.corporationID) === numericCorporationID,
  );
  const result = reconcileActorConnections({ priorityGroups: [bots.map((bot) => Number(bot.characterID))] });
  const connected = getConnectedBotCharacterIDs();
  return {
    corporationID: numericCorporationID,
    botCount: bots.length,
    connectedCount: bots.filter((bot) => connected.has(Number(bot.characterID))).length,
    attachedCount: result.attached,
    failedCount: Math.max(0, bots.length - result.selected),
    connectionLimit: result.plan && result.plan.maxConnected,
  };
}

function reconcileConnectedCorporations() {
  if (!started) return [];
  require("./playerBotDirectorRuntime").enforceConcurrentWorkLimit({ skipUpgradeMarketPlanning: true });
  const corporationIDs = getHumanConnectedCorporationIDs();
  const presence = reconcileActorConnections({ humanCorporations: corporationIDs });
  for (const corporationID of corporationIDs) {
    try {
      const director = require("./playerBotDirectorRuntime");
      if (director.countProductiveBots(corporationID) < 3) {
        director.ensureMinimumProductiveWork(corporationID).catch((error) => {
          log.warn(
            `[PlayerBots] Productive-work recovery failed corp=${corporationID}: ${error.message}`,
          );
        });
      }
    } catch (error) {
      log.warn(`[PlayerBots] Corporation work reconciliation failed corp=${corporationID}: ${error.message}`);
    }
  }
  return [{ ...presence, corporations: corporationIDs.size }];
}

function describeError(error) {
  const response = error && error.machoErrorResponse;
  if (isUserErrorMachoError(response)) {
    return getMachoUserErrorMessage(response) || "ORDEN_RECHAZADA";
  }
  return String(error && error.message || error || "UNKNOWN_ERROR");
}

function undock(bot, options = {}) {
  const session = getActorSession(bot);
  if (!isDockedSession(session)) {
    const attached = ensureActorInSpace(bot, options);
    return {
      success: true,
      message: `${bot.characterName} is already in space in system ${session.solarsystemid}.`,
      data: attached,
    };
  }
  const character = getCharacterRecord(bot.characterID) || {};
  const capacityError = systemActorCapacityError(bot, character.solarSystemID, options);
  if (capacityError) {
    return { success: false, capacityQueued: true, message: capacityError.message };
  }
  const shipID = normalizePositiveID(session.shipID);
  if (!shipID) return { success: false, message: `${bot.characterName} has no active ship.` };
  try {
    const ShipService = require("../ship/shipService");
    new ShipService().Handle_Undock([shipID, false], session, {});
    const attached = ensureActorInSpace(bot, options);
    log.info(
      `[PlayerBots] Actor undocked char=${bot.characterID} ship=${shipID} system=${session.solarsystemid}.`,
    );
    return {
      success: true,
      message: `${bot.characterName} undocked in system ${session.solarsystemid}.`,
      data: attached,
    };
  } catch (error) {
    return { success: false, message: `Could not undock ${bot.characterName}: ${describeError(error)}.` };
  }
}

function warp(bot, targetID) {
  const numericTargetID = normalizePositiveID(targetID);
  if (!numericTargetID) return { success: false, message: "Destination ID must be a positive integer." };
  try {
    const { session, scene } = ensureActorInSpace(bot);
    let target = scene.getEntityByID(numericTargetID);
    if (!target) return { success: false, message: `Destination ${numericTargetID} is not present in the local system.` };
    const navigation = resolveInterdictionNavigation(scene, scene.getShipEntityForSession(session), target);
    if (navigation.action === "escape") {
      const moved = spaceRuntime.gotoPoint(session, navigation.escapePoint, {
        commandSource: "PlayerBotInterdictionEscape",
      });
      if (moved === false) return { success: false, message: "The ship could not start its subwarp movement out of the interdiction field." };
      return {
        success: true,
        deferred: true,
        message: `${bot.characterName} is moving clear of an interdiction field before warping.`,
      };
    }
    if (navigation.action === "blocked") {
      return {
        success: false,
        blocked: true,
        message: `Every known warp approach to ${target.itemName || target.name || numericTargetID} intersects an active interdiction field.`,
      };
    }
    if (navigation.action === "detour") {
      target = navigation.candidate;
      log.info(
        `[PlayerBots] Interdiction detour char=${bot.characterID} target=${numericTargetID} ` +
          `via=${target.itemID} disruptor=${navigation.outcome.disruptorID}.`,
      );
    }
    const BeyonceService = require("../ship/beyonceService");
    new BeyonceService().Handle_CmdWarpToStuff(["item", Number(target.itemID)], session, {});
    log.info(
      `[PlayerBots] Actor warp ordered char=${bot.characterID} target=${target.itemID} system=${session.solarsystemid}.`,
    );
    return {
      success: true,
      deferred: target.itemID !== numericTargetID,
      message: `${bot.characterName} received a warp order to ${target.itemName || target.name || numericTargetID}.`,
    };
  } catch (error) {
    return { success: false, message: `Could not issue a warp order for ${bot.characterName}: ${describeError(error)}.` };
  }
}

function warpToPoint(bot, point) {
  const destination = point && typeof point === "object"
    ? { x: Number(point.x), y: Number(point.y), z: Number(point.z) }
    : null;
  if (!destination || !Object.values(destination).every(Number.isFinite)) {
    return { success: false, message: "Warp destination must have finite x, y and z coordinates." };
  }
  try {
    const { session, scene } = ensureActorInSpace(bot);
    const ship = scene && scene.getShipEntityForSession(session);
    if (!ship || !ship.position) return { success: false, message: "The active ship has no authoritative space position." };
    if (vectorDistance(ship.position, destination) < MIN_WARP_DISTANCE_METERS) {
      return { success: false, message: "The selected deployment point is too close for warp; a different celestial grid is required." };
    }
    const result = spaceRuntime.warpToPoint(session, destination, { stopDistance: 0 });
    if (!result || result.success !== true) {
      return { success: false, message: describeError(result && (result.errorMsg || result.message) || "WARP_REJECTED") };
    }
    log.info(
      `[PlayerBots] Actor warp-to-point ordered char=${bot.characterID} ` +
        `system=${session.solarsystemid} queued=${result.queued === true}.`,
    );
    return {
      success: true,
      queued: result.queued === true,
      message: `${bot.characterName} received a warp order to a clear position in system ${session.solarsystemid}.`,
    };
  } catch (error) {
    return { success: false, message: `Could not issue a point warp for ${bot.characterName}: ${describeError(error)}.` };
  }
}

function approach(bot, targetID, rangeMeters = 1000) {
  try {
    const { session, scene } = ensureActorInSpace(bot);
    if (!scene.getEntityByID(Number(targetID))) return { success: false, message: `Destination ${targetID} is not in the local scene.` };
    const BeyonceService = require("../ship/beyonceService");
    new BeyonceService().Handle_CmdFollowBall([
      Number(targetID),
      Math.max(1000, Math.trunc(Number(rangeMeters) || 1000)),
    ], session);
    return { success: true };
  } catch (error) {
    return { success: false, message: describeError(error) };
  }
}

function dock(bot, stationID) {
  const numericStationID = normalizePositiveID(stationID);
  if (!numericStationID) return { success: false, message: "Station or structure ID must be a positive integer." };
  try {
    const { session, scene } = ensureActorInSpace(bot);
    const destination = worldData.getStationByID(numericStationID) ||
      worldData.getStructureByID(numericStationID);
    if (!destination) {
      return { success: false, message: `No station or structure exists with ID ${numericStationID}.` };
    }
    const destinationSystemID = normalizePositiveID(destination.solarSystemID);
    if (destinationSystemID !== normalizePositiveID(session.solarsystemid)) {
      return { success: false, message: `Destination ${numericStationID} is not in ${bot.characterName}'s current system.` };
    }
    if (!scene.getEntityByID(numericStationID)) {
      return { success: false, message: `Destination ${numericStationID} is not available in the local system.` };
    }
    const BeyonceService = require("../ship/beyonceService");
    new BeyonceService().Handle_CmdDock([numericStationID], session);
    const character = getCharacterRecord(bot.characterID) || {};
    const docked = normalizePositiveID(character.stationID) === numericStationID ||
      normalizePositiveID(character.structureID) === numericStationID;
    log.info(
      `[PlayerBots] Actor dock command char=${bot.characterID} location=${numericStationID} docked=${docked}.`,
    );
    return {
      success: true,
      message: docked
        ? `${bot.characterName} docked at ${numericStationID}.`
        : `${bot.characterName} is approaching ${numericStationID}.`,
    };
  } catch (error) {
    const userMessage = describeError(error);
    if (userMessage === "DockingApproach") {
      log.info(
        `[PlayerBots] Actor docking approach started char=${bot.characterID} location=${numericStationID}.`,
      );
      return {
        success: true,
        message: `${bot.characterName} is approaching ${numericStationID}; the server will complete docking if the rules allow it.`,
      };
    }
    return { success: false, message: `Could not dock ${bot.characterName}: ${userMessage}.` };
  }
}

function findStargateRoute(fromSystemID, toSystemID) {
  const startID = normalizePositiveID(fromSystemID);
  const destinationID = normalizePositiveID(toSystemID);
  if (!startID || !destinationID || !worldData.getSolarSystemByID(startID) ||
      !worldData.getSolarSystemByID(destinationID)) {
    return { success: false, message: "The source or destination system does not exist." };
  }
  const cacheKey = `${startID}:${destinationID}`;
  const cached = readCachedStargateRoute(cacheKey);
  if (cached) return cached;
  if (startID === destinationID) {
    const systemIDs = [startID];
    return rememberStargateRoute(cacheKey, {
      success: true,
      systemIDs,
      gates: [],
      risk: routeRiskForSystems(systemIDs),
    });
  }

  // Prefer safer systems while keeping each route bounded. A low-security
  // system costs three high-sec jumps and nullsec costs nine, so a short high-
  // sec detour wins when it is available without making distant routes unbounded.
  const pending = [];
  let sequence = 0;
  const initial = { systemID: startID, systemIDs: [startID], gates: [], cost: 0, sequence: sequence++ };
  pushRouteCandidate(pending, initial);
  const routeFrontiersBySystem = new Map([[startID, [initial]]]);
  while (pending.length) {
    const current = popRouteCandidate(pending);
    const currentFrontier = routeFrontiersBySystem.get(current.systemID) || [];
    if (!currentFrontier.some((candidate) => candidate.sequence === current.sequence)) continue;
    if (current.systemID === destinationID) {
      return rememberStargateRoute(cacheKey, {
        success: true,
        systemIDs: current.systemIDs,
        gates: current.gates,
        risk: routeRiskForSystems(current.systemIDs),
        routeCost: current.cost,
      });
    }
    if (current.gates.length >= MAX_STARGATE_ROUTE_HOPS) continue;
    // worldData builds the per-system adjacency lists in itemID order once.
    const gates = worldData.getStargatesForSystem(current.systemID);
    for (const gate of gates) {
      const destinationGate = worldData.getStargateByID(gate.destinationID);
      const nextSystemID = normalizePositiveID(gate.destinationSolarSystemID) ||
        normalizePositiveID(destinationGate && destinationGate.solarSystemID);
      if (!nextSystemID) continue;
      const cost = current.cost + routeSystemCost(nextSystemID);
      const hops = current.gates.length + 1;
      const frontier = routeFrontiersBySystem.get(nextSystemID) || [];
      if (frontier.some((previous) => previous.cost <= cost && previous.gates.length <= hops)) continue;
      const candidate = {
        systemID: nextSystemID,
        systemIDs: [...current.systemIDs, nextSystemID],
        gates: [...current.gates, gate],
        cost,
        sequence: sequence++,
      };
      routeFrontiersBySystem.set(nextSystemID, [
        ...frontier.filter((previous) => !(cost <= previous.cost && hops <= previous.gates.length)),
        candidate,
      ]);
      pushRouteCandidate(pending, candidate);
    }
  }
  return rememberStargateRoute(cacheKey, {
    success: false,
    message: "No stargate route exists between those systems (maximum 64 jumps).",
  });
}

function previewSystemRoute(bot, destinationSystemID) {
  const destinationID = normalizePositiveID(destinationSystemID);
  if (!destinationID || !worldData.getSolarSystemByID(destinationID)) {
    return { success: false, message: "Destination system ID does not exist." };
  }
  const character = getCharacterRecord(bot && bot.characterID) || {};
  const session = getActorSession(bot);
  const currentSystemID = normalizePositiveID(session.solarsystemid || character.solarSystemID);
  const route = findStargateRoute(currentSystemID, destinationID);
  return route.success
    ? {
      success: true,
      hops: route.gates.length,
      systemIDs: route.systemIDs,
      risk: route.risk,
      routeCost: route.routeCost,
    }
    : route;
}

function advanceSystemRoute(bot, destinationSystemID) {
  const destinationID = normalizePositiveID(destinationSystemID);
  if (!destinationID || !worldData.getSolarSystemByID(destinationID)) {
    return { success: false, message: "Destination system ID does not exist." };
  }
  const session = getActorSession(bot);
  if (isDockedSession(session)) {
    // A route is an explicit departure. Let the bot leave a crowded origin
    // system even when the autonomous actor limit is already reached there.
    // Target-system order work may temporarily exceed that target's limit;
    // the director moves the bot on after the finite job is complete.
    const result = undock(bot, { allowOverCapacityDeparture: true });
    if (!result.success) return { success: false, message: result.message };
    return {
      success: true,
      deferred: true,
      delayMs: 5000,
      message: result.message,
      progress: { stage: "undocking", destinationSystemID: destinationID },
    };
  }

  // Navigation is already an explicit bounded job. A bot may have been
  // detached during recovery while its source system is still at capacity;
  // allow it to reattach so it can leave or finish the route.
  const attached = ensureActorInSpace(bot, { allowOverCapacityDeparture: true });
  const currentSystemID = normalizePositiveID(attached.session.solarsystemid ||
    attached.session._space && attached.session._space.systemID);
  if (!currentSystemID) return { success: false, message: "Could not determine the bot's current system." };
  if (currentSystemID === destinationID) {
    const system = worldData.getSolarSystemByID(destinationID);
    return {
      success: true,
      completed: true,
      message: `${bot.characterName} arrived in ${system.solarSystemName || system.name || destinationID}.`,
      result: { destinationSystemID: destinationID, systemIDs: [destinationID], hops: 0 },
    };
  }

  const route = findStargateRoute(currentSystemID, destinationID);
  if (!route.success) return route;
  const sourceGate = route.gates[0];
  const destinationGate = worldData.getStargateByID(sourceGate && sourceGate.destinationID);
  const sourceEntity = sourceGate && attached.scene.getEntityByID(sourceGate.itemID);
  if (!sourceGate || !destinationGate) {
    return { success: false, message: "The calculated route contains an incomplete stargate." };
  }
  if (!sourceEntity) {
    return {
      success: true,
      deferred: true,
      delayMs: 5000,
      message: "The stargate is not available in the local scene yet.",
      progress: { stage: "waiting-for-gate", currentSystemID, destinationSystemID: destinationID },
    };
  }
  if (attached.entity.mode === "WARP" || attached.session._transitionState) {
    return {
      success: true,
      deferred: true,
      delayMs: 5000,
      message: `${bot.characterName} is finishing its current movement.`,
      progress: { stage: "in-transit", currentSystemID, destinationSystemID: destinationID },
    };
  }

  const surfaceDistance = getSurfaceDistanceBetweenEntities(attached.entity, sourceEntity);
  const progress = {
    stage: surfaceDistance > MIN_WARP_DISTANCE_METERS
      ? "warping-to-gate"
      : surfaceDistance > STARGATE_JUMP_RANGE_METERS ? "approaching-gate" : "jumping-gate",
    currentSystemID,
    destinationSystemID: destinationID,
    nextSystemID: normalizePositiveID(destinationGate.solarSystemID || sourceGate.destinationSolarSystemID),
    gateID: Number(sourceGate.itemID),
    remainingHops: route.gates.length,
  };
  if (surfaceDistance > MIN_WARP_DISTANCE_METERS) {
    const interdiction = resolveInterdictionNavigation(attached.scene, attached.entity, sourceEntity);
    if (interdiction.action === "escape") {
      const moved = spaceRuntime.gotoPoint(attached.session, interdiction.escapePoint, {
        commandSource: "PlayerBotInterdictionEscape",
      });
      if (moved === false) {
        return {
          success: true,
          deferred: true,
          delayMs: 30_000,
          message: `${bot.characterName} is caught inside an interdiction sphere and could not start its escape vector yet.`,
          progress: { ...progress, stage: "inside-interdiction", disruptorID: interdiction.containing.disruptorID },
        };
      }
      log.warn(
        `[PlayerBots] Interdiction escape char=${bot.characterID} system=${currentSystemID} ` +
          `disruptor=${interdiction.containing.disruptorID} overlapping=${interdiction.activeVolumeCount}.`,
      );
      return {
        success: true,
        deferred: true,
        delayMs: 30_000,
        message: `${bot.characterName} is moving clear of an interdiction sphere before continuing its route.`,
        progress: { ...progress, stage: "escaping-interdiction", disruptorID: interdiction.containing.disruptorID },
      };
    }
    if (interdiction.action === "detour") {
      const result = warp(bot, interdiction.candidate.itemID);
      if (!result.success) return { success: false, message: result.message };
      log.info(
        `[PlayerBots] Interdiction detour char=${bot.characterID} system=${currentSystemID} ` +
          `gate=${sourceGate.itemID} via=${interdiction.candidate.itemID} disruptor=${interdiction.outcome.disruptorID}.`,
      );
      return {
        success: true,
        deferred: true,
        delayMs: 15_000,
        message: `${bot.characterName} is routing around a warp disruption sphere via ${interdiction.candidate.itemName || interdiction.candidate.itemID}.`,
        progress: {
          ...progress,
          stage: "interdiction-detour",
          viaEntityID: Number(interdiction.candidate.itemID),
          disruptorID: Number(interdiction.outcome.disruptorID) || null,
          warpOutcome: interdiction.outcome.kind,
        },
      };
    }
    if (interdiction.action === "blocked") {
      return {
        success: true,
        deferred: true,
        delayMs: 60_000,
        message: `${bot.characterName} is holding at a safe position because every known warp approach to gate ${sourceGate.itemID} intersects an active interdiction sphere.`,
        progress: {
          ...progress,
          stage: "interdiction-hold",
          disruptorID: Number(interdiction.outcome && interdiction.outcome.disruptorID) || null,
          warpOutcome: interdiction.outcome && interdiction.outcome.kind || null,
        },
      };
    }
    const result = warp(bot, sourceGate.itemID);
    if (!result.success) return { success: false, message: result.message };
    return { success: true, deferred: true, delayMs: 5000, message: result.message, progress };
  }

  if (surfaceDistance > STARGATE_JUMP_RANGE_METERS) {
    const result = approach(bot, sourceGate.itemID);
    if (!result.success) return { success: false, message: result.message };
    return {
      success: true,
      deferred: true,
      delayMs: 5000,
      message: `${bot.characterName} is approaching gate ${sourceGate.itemID} to enter jump range.`,
      progress,
    };
  }

  try {
    const BeyonceService = require("../ship/beyonceService");
    new BeyonceService().Handle_CmdStargateJump(
      [sourceGate.itemID, destinationGate.itemID, attached.entity.itemID],
      attached.session,
    );
    log.info(
      `[PlayerBots] Actor route gate jump char=${bot.characterID} from=${sourceGate.itemID} ` +
        `to=${destinationGate.itemID} destinationSystem=${progress.nextSystemID}.`,
    );
    return {
      success: true,
      deferred: true,
      delayMs: 5_000,
      message: `${bot.characterName} is jumping to system ${progress.nextSystemID}.`,
      progress,
    };
  } catch (error) {
    return { success: false, message: `Could not jump ${bot.characterName}: ${describeError(error)}.` };
  }
}

function getSpaceState(bot) {
  const session = getActorSession(bot);
  if (isDockedSession(session)) return { inSpace: false, docked: true, busy: false, distanceTo: () => null };
  const { scene, entity } = ensureActorInSpace(bot);
  const condition = entity.conditionState || {};
  const armorHP = Math.max(0, Number(entity.armorHP || entity.maxArmorHP) || 0);
  const structureHP = Math.max(0, Number(entity.hp || entity.structureHP || entity.maxHP) || 0);
  let warpScrambleStatus = 0;
  try {
    warpScrambleStatus = Number(require("../../space/modules/hostileModuleRuntime")
      .getEntityWarpScrambleStatus(entity)) || 0;
  } catch (_) {
    // Combat safety still uses Dogma health/capacitor if hostile-state data is unavailable.
  }
  return {
    inSpace: true,
    docked: false,
    systemID: normalizePositiveID(session.solarsystemid),
    busy: entity.mode === "WARP" || Boolean(session._transitionState),
    isCapsule: Number(session.shipTypeID) === 670 || Number(entity.typeID) === 670,
    shield: Number.isFinite(Number(condition.shieldCharge)) ? Number(condition.shieldCharge) : 1,
    armorDamage: Number(condition.armorDamage) || 0,
    hullDamage: Number(condition.damage) || 0,
    armorHP,
    structureHP,
    capacitorRatio: Number.isFinite(Number(entity.capacitorChargeRatio))
      ? Number(entity.capacitorChargeRatio) : 1,
    capacitorCapacity: Math.max(0, Number(entity.capacitorCapacity) || 0),
    warpScrambleStatus,
    shipID: Number(entity.itemID) || 0,
    shipTypeID: Number(entity.typeID) || 0,
    distanceTo(targetID) {
      const target = scene.getEntityByID(normalizePositiveID(targetID));
      return target ? getSurfaceDistanceBetweenEntities(entity, target) : null;
    },
  };
}

function getActorSpace(bot) {
  return ensureActorInSpace(bot);
}

function getNearbyPirateNpcCount(bot, radiusMeters) {
  const { scene, entity, session } = ensureActorInSpace(bot);
  // Use the same observer-specific bubble as the client SetState. Counting
  // every dynamic NPC in a scene included entities the pilot could not see.
  const visibleEntities = scene && typeof scene.getVisibleEntitiesForSession === "function"
    ? scene.getVisibleEntitiesForSession(session)
    : [];
  return playerBotCombatPolicy.countNearbyPirateNpcs(visibleEntities, entity.position, radiusMeters);
}

let dogmaService = null;

function getDogmaService() {
  if (!dogmaService) {
    const DogmaService = require("../dogma/dogmaService");
    dogmaService = new DogmaService();
  }
  return dogmaService;
}

// One mining step through the pilot authorities: choose ore by expected local
// value per cargo volume, then lock and activate idle mining modules on it.
// Ore is credited by the server's own mining cycle settlement.
const miningOreValueCache = new Map();
const MINING_ORE_VALUE_CACHE_MS = 5 * 60 * 1000;

async function readOreMarketValuePerUnit(bot, stationID, typeID) {
  const cacheKey = `${Number(stationID)}:${Number(typeID)}`;
  const cached = miningOreValueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const registry = require("../inventory/itemTypeRegistry");
  const itemType = registry.resolveItemByTypeID(Number(typeID)) || {};
  let value = Number(itemType.basePrice) || 0;
  try {
    const quote = await require("./playerBotTradeRuntime").readQuoteAt(bot.characterName, typeID, stationID);
    if (quote.success && quote.bestBid && Number(quote.bestBid.price) > 0) value = Number(quote.bestBid.price);
  } catch (_) {
    // Keep the static item value if the station quote is temporarily unavailable.
  }
  miningOreValueCache.set(cacheKey, { value, expiresAt: Date.now() + MINING_ORE_VALUE_CACHE_MS });
  return value;
}

async function estimateOreValuePerVolume(bot, stationID, oreTypeID) {
  const registry = require("../inventory/itemTypeRegistry");
  const type = registry.resolveItemByTypeID(Number(oreTypeID)) || {};
  const volume = Math.max(0.0001, Number(type.volume) || 1);
  try {
    const reprocessing = require("../reprocessing/reprocessingRuntime");
    const staticData = require("../reprocessing/reprocessingStaticData");
    const profile = staticData.getReprocessingProfile(Number(oreTypeID));
    const session = getActorSession(bot);
    const contextResult = reprocessing.resolveReprocessingContext({
      ...session,
      stationID: Number(stationID),
      stationid: Number(stationID),
      structureID: 0,
      structureid: 0,
      locationID: Number(stationID),
    });
    if (profile && contextResult.success) {
      const item = {
        itemID: 1,
        ownerID: Number(bot.characterID),
        locationID: Number(stationID),
        flagID: require("../inventory/itemStore").ITEM_FLAGS.HANGAR,
        typeID: Number(oreTypeID),
        singleton: 0,
        stacksize: Math.max(1, Number(profile.portionSize) || 1),
      };
      const quote = reprocessing.buildReprocessingQuoteForItem(item, contextResult.data);
      if (quote && !quote.errorMsg && quote.recoverables.length) {
        let grossValue = 0;
        for (const recovered of quote.recoverables) {
          const units = Math.max(0, Number(recovered.client) || 0);
          if (!units) continue;
          grossValue += units * await readOreMarketValuePerUnit(bot, stationID, recovered.typeID);
        }
        const netPerOre = Math.max(0, grossValue - (Number(quote.totalISKCost) || 0)) /
          Math.max(1, Number(quote.quantityToProcess) || 1);
        return netPerOre / volume;
      }
    }
  } catch (_) {
    // A raw-ore quote below provides a safe fallback if reprocessing data is absent.
  }
  return (await readOreMarketValuePerUnit(bot, stationID, oreTypeID)) / volume;
}

async function mineNearestAsteroid(bot, miningModules, approachMeters, marketStationID = 0) {
  const { session, scene, entity } = ensureActorInSpace(bot);
  if (entity.mode === "WARP" || session._transitionState) {
    return { success: true, phase: "moving", message: `${bot.characterName} is still moving.` };
  }
  if (!Array.isArray(miningModules) || miningModules.length === 0) {
    return { success: false, message: "No fitted online mining lasers are available on the active ship." };
  }
  const active = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : new Map();
  const busyModules = miningModules.filter((module) => active.has(Number(module.itemID)));
  const mining = require("../mining/miningNpcOperations");
  const candidates = mining.resolveAvailableMineableTargetEntries(scene, null, entity, { localGridOnly: true })
    .filter((entry) => entry && entry.state && entry.state.yieldKind === "ore");
  const activeTargetIDs = [...new Set(busyModules.map((module) =>
    Number(active.get(Number(module.itemID)) && active.get(Number(module.itemID)).targetID) || 0,
  ).filter(Boolean))];
  let target = activeTargetIDs.length === 1
    ? candidates.find((entry) => Number(entry.entity && entry.entity.itemID) === activeTargetIDs[0]) || null
    : null;
  if (busyModules.length && !target) {
    // A depleted or stale target must not leave the lasers apparently active
    // forever. Stop only mining modules, then choose and lock a fresh asteroid.
    for (const module of busyModules) {
      try {
        getDogmaService().Handle_Deactivate([Number(module.itemID), "miningLaser"], session);
      } catch (error) {
        log.warn(`[PlayerBots] Mining target reset failed char=${bot.characterID} module=${module.itemID}: ${describeError(error)}`);
      }
      active.delete(Number(module.itemID));
    }
  }
  const distanceSquared = (entry) => {
    const left = entry && entry.entity && entry.entity.position;
    const right = entity.position;
    if (!left || !right) return Number.MAX_SAFE_INTEGER;
    return (Number(left.x) - Number(right.x)) ** 2 +
      (Number(left.y) - Number(right.y)) ** 2 +
      (Number(left.z) - Number(right.z)) ** 2;
  };
  if (!target) {
    target = candidates.sort((left, right) => distanceSquared(left) - distanceSquared(right) ||
      Number(left.entity.itemID) - Number(right.entity.itemID))[0] || null;
  }
  if (!activeTargetIDs.length && marketStationID && candidates.length > 1) {
    const values = new Map();
    for (const entry of candidates) {
      const typeID = Number(entry.state.yieldTypeID) || 0;
      if (!values.has(typeID)) values.set(typeID, await estimateOreValuePerVolume(bot, marketStationID, typeID));
      entry.marketValuePerVolume = values.get(typeID);
    }
    target = candidates.sort((left, right) =>
      Number(right.marketValuePerVolume) - Number(left.marketValuePerVolume) ||
      Number(right.state.remainingQuantity) - Number(left.state.remainingQuantity) ||
      distanceSquared(left) - distanceSquared(right) ||
      Number(left.entity.itemID) - Number(right.entity.itemID))[0] || target;
  }
  if (!target || !target.entity) {
    return { success: false, message: "No mineable asteroids are available in this belt." };
  }
  const asteroid = target.entity;
  const BeyonceService = require("../ship/beyonceService");
  const distanceToAsteroid = getSurfaceDistanceBetweenEntities(entity, asteroid);
  if (distanceToAsteroid > approachMeters) {
    new BeyonceService().Handle_CmdFollowBall([asteroid.itemID, Math.round(approachMeters / 2)], session);
    return { success: true, phase: "approach", targetID: Number(asteroid.itemID),
      yieldTypeID: Number(target.state && target.state.yieldTypeID) || 0,
      message: `Approaching asteroid ${asteroid.itemID} (${Math.round(distanceToAsteroid / 1000)} km).` };
  }
  const activatedModuleIDs = [];
  const activeMiningModuleIDs = [];
  try {
    const targets = spaceRuntime.getTargets(session) || [];
    if (!targets.map(Number).includes(Number(asteroid.itemID))) {
      const locked = spaceRuntime.addTarget(session, asteroid.itemID);
      if (!locked || !locked.success) {
        if (locked && locked.errorMsg === "TARGET_OUT_OF_RANGE") {
          // Drifted past lock range; close in and lock on the next step.
          const decision = locked.data && locked.data.rangeDecision || {};
          new BeyonceService().Handle_CmdFollowBall([asteroid.itemID, 1000], session);
          return {
            success: true,
            // Out-of-range is a movement step, not a failed lock attempt.
            // The mining operation must wait for this approach to finish.
            phase: "approach",
            targetID: Number(asteroid.itemID),
            yieldTypeID: Number(target.state && target.state.yieldTypeID) || 0,
            lockFailed: false,
            message: `Moving closer to asteroid ${asteroid.itemID} to lock it (distance ${Math.round(Number(decision.actualDistance) || 0)} m, lock range ${Math.round(Number(decision.desiredRange) || 0)} m).`,
          };
        }
        return { success: false, message: `Could not lock asteroid ${asteroid.itemID}: ${locked && locked.errorMsg || "rejected"}.` };
      }
      if (locked.data && locked.data.pending) {
        return { success: true, phase: "locking", targetID: Number(asteroid.itemID),
          yieldTypeID: Number(target.state && target.state.yieldTypeID) || 0,
          message: `Locking asteroid ${asteroid.itemID}.` };
      }
    }
    for (const module of miningModules) {
      if (active.has(Number(module.itemID))) {
        const effect = active.get(Number(module.itemID));
        if (Number(effect && effect.targetID) === Number(asteroid.itemID)) {
          activeMiningModuleIDs.push(Number(module.itemID));
          continue;
        }
        getDogmaService().Handle_Deactivate([Number(module.itemID), "miningLaser"], session);
        active.delete(Number(module.itemID));
      }
      getDogmaService().Handle_Activate([Number(module.itemID), "miningLaser", Number(asteroid.itemID), null], session);
      activatedModuleIDs.push(Number(module.itemID));
      activeMiningModuleIDs.push(Number(module.itemID));
    }
  } catch (error) {
    return { success: false, message: `Miner activation was rejected: ${describeError(error)}.` };
  }
  const confirmedTarget = (spaceRuntime.getTargets(session) || []).map(Number).includes(Number(asteroid.itemID));
  if (!confirmedTarget) {
    return { success: false, message: `Mining lasers were not activated because asteroid ${asteroid.itemID} is not locked.` };
  }
  log.info(`[PlayerBots] Actor mining char=${bot.characterID} asteroid=${asteroid.itemID} yieldType=${Number(target.state && target.state.yieldTypeID) || 0} modules=${miningModules.map((module) => Number(module.itemID)).join(",")}.`);
  return { success: true, phase: "mining", targetID: Number(asteroid.itemID),
    yieldTypeID: Number(target.state && target.state.yieldTypeID) || 0,
    moduleIDs: activeMiningModuleIDs, activatedModuleIDs,
    message: `Locked asteroid ${asteroid.itemID}; ${activeMiningModuleIDs.length} mining laser(s) active against it.` };
}

function stopMining(bot) {
  const session = getActorSession(bot);
  if (!session._space) return { success: true };
  const { entity } = ensureActorInSpace(bot);
  const active = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : new Map();
  const itemStore = require("../inventory/itemStore");
  const miningDogma = require("../mining/miningDogma");
  const moduleIDs = [...active.keys()].filter((moduleID) =>
    miningDogma.isMiningEffectRecord(null, itemStore.findItemById(Number(moduleID))));
  for (const moduleID of moduleIDs) {
    try {
      getDogmaService().Handle_Deactivate([Number(moduleID), "miningLaser"], session);
    } catch (error) {
      log.warn(`[PlayerBots] Mining deactivate failed char=${bot.characterID} module=${moduleID}: ${describeError(error)}`);
    }
  }
  return { success: true };
}

// Lock a target through the scene targeting authority. Playerbot combat and
// Entosis operations use this wrapper instead of mutating lockedTargets.
function lockTarget(bot, targetID) {
  const session = getActorSession(bot);
  if (isDockedSession(session)) return { success: false, errorMsg: "NOT_IN_SPACE" };
  ensureActorInSpace(bot);
  return spaceRuntime.addTarget(session, normalizePositiveID(targetID));
}

function getBotLocation(bot) {
  const character = getCharacterRecord(bot && bot.characterID) || {};
  const session = actorSessions.get(normalizePositiveID(bot && bot.characterID));
  if (session && session._space && spaceRuntime.getSceneForSession(session)) {
    return `in space (${session.solarsystemid})`;
  }
  const stationID = normalizePositiveID(character.stationID);
  if (stationID) return `docked (${stationID})`;
  const structureID = normalizePositiveID(character.structureID);
  if (structureID) return `docked in structure (${structureID})`;
  return `no space actor (${normalizePositiveID(character.solarSystemID) || "unknown location"})`;
}

// Read-only view for admin/status surfaces. Unlike getActorSession(), this
// never creates a session or registers a bot as present just to display it.
function getBotPresenceInfo(bot, characterRecord = null) {
  const characterID = normalizePositiveID(bot && bot.characterID);
  const character = characterRecord || (characterID ? getCharacterRecord(characterID) || {} : {});
  const session = characterID ? actorSessions.get(characterID) || null : null;
  const scene = session && session._space ? spaceRuntime.getSceneForSession(session) : null;
  const entity = scene && session ? scene.getShipEntityForSession(session) : null;
  let connected = false;
  if (session) {
    try {
      connected = require("../chat/sessionRegistry").isRegisteredSession(session);
    } catch (error) {
      connected = false;
    }
  }
  const stationID = normalizePositiveID(character.stationID || session && session.stationid);
  const structureID = normalizePositiveID(character.structureID || session && session.structureid);
  const solarSystemID = normalizePositiveID(
    scene && scene.systemID || session && session.solarsystemid || character.solarSystemID,
  );
  return {
    connected,
    inSpace: Boolean(scene && entity),
    solarSystemID,
    stationID,
    structureID,
    actorAttached: Boolean(scene && entity),
  };
}

function getStatusSummary() {
  let inSpace = 0;
  for (const session of require("../chat/sessionRegistry").getSessions()) {
    if (session && session._playerBotActor === true && session._space && spaceRuntime.getSceneForSession(session)) {
      inSpace += 1;
    } else if (session && session._playerBotActor === true && session._space) {
      session._space = null;
    }
  }
  return {
    activeActors: inSpace,
    cachedActors: actorSessions.size,
    connectedActors: connectedActorCount,
    totalBots: playerBots.listBots().length,
    connectionSchedule: lastConnectionPlan ? {
      maxConnected: lastConnectionPlan.maxConnected,
      selected: lastConnectionPlan.selectedCount,
      groupIndex: lastConnectionPlan.groupIndex,
      groupCount: lastConnectionPlan.groupCount,
      windowMs: lastConnectionPlan.windowMs,
      nextRotationAt: lastConnectionPlan.nextRotationAt,
      priorityOverflow: lastConnectionPlan.priorityOverflow,
    } : null,
  };
}

function start() {
  if (started) return getStatusSummary();
  started = true;
  const bots = playerBots.listBots();
  const capacity = require("./playerBotDirectorRuntime").enforceConcurrentWorkLimit();
  const connection = reconcileActorConnections({ bots });
  const attachedCount = connection.attached;
  const failedCount = Math.max(0, connection.selected - connection.connected);
  const presentCount = connection.connected;
  reconcileConnectedCorporations();
  localPresenceTimer = setInterval(() => {
    syncLocalPresence();
    syncScopedChannelPresence();
  }, LOCAL_PRESENCE_INTERVAL_MS);
  if (typeof localPresenceTimer.unref === "function") localPresenceTimer.unref();
  corporationBotPresenceTimer = setInterval(
    reconcileConnectedCorporations,
    CORPORATION_BOT_RECONCILE_INTERVAL_MS,
  );
  if (typeof corporationBotPresenceTimer.unref === "function") corporationBotPresenceTimer.unref();
  const status = getStatusSummary();
  log.info(
    `[PlayerBots] Space actors ready attached=${attachedCount} active=${status.activeActors} ` +
      `failed=${failedCount}; online as pilots=${presentCount}; work capacity=${capacity.active}/${capacity.limit} ` +
      `queued=${capacity.queued}; connection rotation=${status.connectionSchedule && status.connectionSchedule.selected}/` +
      `${status.totalBots} across ${status.connectionSchedule && status.connectionSchedule.groupCount || 0} groups, ` +
      `next=${status.connectionSchedule && status.connectionSchedule.nextRotationAt || "n/a"}.`,
  );
  return { ...status, attachedCount, failedCount };
}

function shutdown() {
  if (!started && actorSessions.size === 0) return true;
  started = false;
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  if (localPresenceTimer) clearInterval(localPresenceTimer);
  localPresenceTimer = null;
  if (corporationBotPresenceTimer) clearInterval(corporationBotPresenceTimer);
  corporationBotPresenceTimer = null;
  for (const [characterID, session] of actorSessions) {
    unregisterPresence(session, characterID);
  }
  for (const [characterID, session] of actorSessions) {
    if (!session || !session._space) continue;
    try {
      spaceRuntime.detachSession(session, { broadcast: false });
    } catch (error) {
      log.warn(
        `[PlayerBots] Actor detach failed char=${characterID}: ${error.message}`,
      );
    }
    if (Date.now() >= deadline) break;
  }
  actorSessions.clear();
  desiredConnectedCharacterIDs = new Set();
  lastConnectionPlan = null;
  connectedActorCount = 0;
  return true;
}

module.exports = {
  _testing: { syncActorSession },
  buildBubbleEscapePoint,
  describeError,
  dock,
  detachBotActorFromSpace,
  approach,
  advanceSystemRoute,
  findStargateRoute,
  getBotLocation,
  getBotPresenceInfo,
  getConnectedBotCharacterIDs,
  getConnectionPlan: (bots, options) => buildConnectionPlan(bots || playerBots.listBots(), options || {}),
  isBotConnectedForWork,
  getActorSpace,
  getNearbyPirateNpcCount,
  getActorSession,
  getSpaceState,
  lockTarget,
  getStatusSummary,
  ensureCorporationBotsConnected,
  mineNearestAsteroid,
  reconcileConnectedCorporations,
  reconcileActorConnections,
  nextBotConnectionAtMs,
  stopMining,
  shutdown,
  start,
  previewSystemRoute,
  resolveInterdictionNavigation,
  undock,
  warp,
  warpToPoint,
};

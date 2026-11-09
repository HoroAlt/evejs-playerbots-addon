"use strict";

// Autonomous work assignment. Connected pilots receive durable jobs, with
// capacity-paused work and new assignments processed in bounded waves.

const { createTableRepository } = require("../../gameStore/tableRepository");
const characterState = require("../character/characterState");
const readSharedCharacterRecord = characterState.readSharedCharacterRecord || characterState.getCharacterRecord;
const { getCharacterWallet } = require("../account/walletState");

const TABLE = "playerBots";
const DIRECTOR_PATH = "/_director";
const DIRECTOR_BOT_ASSIGNMENT_PREFIX = "_playerBotDirectorBot_";
const EMPTY_DIRECTOR_ASSIGNMENTS = Object.freeze({});
const INDUSTRY_MIN_BALANCE = 60_000;
const INDUSTRY_MAX_SPEND = 50_000_000;
const INDUSTRY_SPEND_SHARE = 0.2;
const INDUSTRY_MAX_RUNS = 5;
// 0 lets the cycle's planner pick the most profitable product at the station.
const AUTO_PRODUCT = 0;
const MINING_TRIPS_PER_ASSIGNMENT = 2;
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const NO_OPPORTUNITY_COOLDOWN_MS = 30 * 60 * 1000;
const MARKET_ORDER_CAPACITY_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const UPGRADE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const UPGRADE_MARKET_QUEUE_RETRY_MS = 5 * 60 * 1000;
const MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP = 3;
const DEFAULT_MAX_CONCURRENT_WORK = 5_000;
// A light director pass may run every few seconds for a large connected
// roster. Resume and start work in bounded waves so filling the work queue
// cannot turn one pass into hundreds of synchronous authority mutations.
const MAX_CAPACITY_RESUMES_PER_PASS = 20;
const MAX_DIRECTOR_ASSIGNMENT_ATTEMPTS_PER_PASS = 20;
// Refit a small capsule cohort per pass so recovery buys never create a market
// burst. Deferred/existing recoveries do not consume this start budget.
const MAX_CAPSULE_RECOVERIES_PER_PASS = 20;
// Initial rosters and recovery can place many pilots in one station system.
// Relocation itself is durable, paced navigation; cap it at the fleet size so
// over-limit pilots do not have to wait through repeated small waves.
const DEFAULT_MAX_CONCURRENT_CAPACITY_RELOCATIONS = 100;
// Colony kits are initially available only from the Jita seed. Limit the
// number of simultaneous setup trips; the other pilots keep doing normal work
// and receive a colony slot as earlier setups finish.
const DEFAULT_MAX_CONCURRENT_COLONY_SETUPS = 10;
const BOT_CAPACITY = require("./playerBotCapacityRuntime");
const repo = createTableRepository("service:playerbots", { strict: true });
// Operation completions can arrive together from the durable scheduler. Keep
// every follow-up assignment request instead of returning the currently
// running pass and silently dropping the bot that just finished work.
let directorRunQueue = Promise.resolve();
let minimumProductiveWorkQueue = Promise.resolve();
const relocationCandidateCache = new Map();
let directorBotAssignmentsCache = null;
let directorLegacyAssignmentsCache = null;
let queuedColonySetupCountCache = null;

function readState() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, DIRECTOR_PATH);
  const data = result.success && result.data && typeof result.data === "object" ? result.data : {};
  const state = { ...data };
  // Per-pilot status lives in flat rows below; never clone the legacy 15k-bot
  // assignment map when one pilot changes its work.
  delete state.bots;
  state.enabled = data.enabled !== false;
  return state;
}

function readDirectorBotAssignments() {
  repo.ensureTable(TABLE);
  const legacyResult = repo.read(TABLE, `${DIRECTOR_PATH}/bots`);
  const legacy = legacyResult.success && legacyResult.data && typeof legacyResult.data === "object"
    ? legacyResult.data : EMPTY_DIRECTOR_ASSIGNMENTS;
  if (!directorBotAssignmentsCache || directorLegacyAssignmentsCache !== legacy) {
    const root = repo.read(TABLE, "/");
    const all = root.success && root.data && typeof root.data === "object" ? root.data : {};
    directorBotAssignmentsCache = { ...legacy };
    for (const [rowKey, wrapper] of Object.entries(all)) {
      if (!rowKey.startsWith(DIRECTOR_BOT_ASSIGNMENT_PREFIX) || !wrapper?.playerBotDirectorState) continue;
      directorBotAssignmentsCache[rowKey.slice(DIRECTOR_BOT_ASSIGNMENT_PREFIX.length)] = wrapper.playerBotDirectorState;
    }
    directorLegacyAssignmentsCache = legacy;
    queuedColonySetupCountCache = null;
  }
  return directorBotAssignmentsCache;
}

function getBotDirectorAssignment(characterID) {
  return readDirectorBotAssignments()[String(Math.trunc(Number(characterID) || 0))] || {};
}

function saveBotDirectorAssignment(characterID, entry) {
  const id = Math.trunc(Number(characterID) || 0);
  if (id <= 0) return false;
  const assignments = readDirectorBotAssignments();
  const key = String(id);
  const previous = assignments[key];
  const saved = { ...(entry || {}) };
  const result = repo.write(TABLE, `/${DIRECTOR_BOT_ASSIGNMENT_PREFIX}${key}`, {
    playerBotDirectorState: saved,
  });
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_DIRECTOR_BOT_STATE_WRITE_FAILED");
  assignments[key] = saved;
  if (queuedColonySetupCountCache !== null) {
    const before = previous?.queuedColonySetup === true;
    const after = saved.queuedColonySetup === true;
    queuedColonySetupCountCache += Number(after) - Number(before);
  }
  return true;
}

function getQueuedColonySetupCount() {
  if (queuedColonySetupCountCache === null) {
    queuedColonySetupCountCache = Object.values(readDirectorBotAssignments())
      .filter((entry) => entry && entry.queuedColonySetup === true).length;
  }
  return queuedColonySetupCountCache;
}

function listQueuedColonySetupAssignments(characterIDs = null) {
  const assignments = readDirectorBotAssignments();
  const ids = Array.isArray(characterIDs)
    ? characterIDs.map((value) => String(Math.trunc(Number(value) || 0))).filter((id) => id !== "0")
    : Object.keys(assignments);
  const result = {};
  for (const id of ids) {
    const assignment = assignments[id];
    if (!assignment || assignment.queuedColonySetup !== true) continue;
    result[id] = {
      queuedReason: String(assignment.queuedReason || "Waiting for a planetary setup slot.").slice(0, 240),
      queuedReasonCode: String(assignment.queuedReasonCode || "colony-setup-limit").slice(0, 80),
      queuedAt: Number(assignment.queuedAt) || 0,
    };
  }
  return result;
}

function saveState(state) {
  // Migrate any legacy map into independent rows before replacing the old
  // director record. This keeps status across upgrades while making future
  // per-pilot saves constant-size.
  const legacyResult = repo.read(TABLE, `${DIRECTOR_PATH}/bots`);
  const legacy = legacyResult.success && legacyResult.data && typeof legacyResult.data === "object"
    ? legacyResult.data : {};
  const root = repo.read(TABLE, "/");
  const all = root.success && root.data && typeof root.data === "object" ? root.data : {};
  for (const [id, entry] of Object.entries(legacy)) {
    const rowKey = `${DIRECTOR_BOT_ASSIGNMENT_PREFIX}${id}`;
    if (all[rowKey]?.playerBotDirectorState) continue;
    const result = repo.write(TABLE, `/${rowKey}`, { playerBotDirectorState: { ...entry } });
    if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_DIRECTOR_BOT_STATE_MIGRATION_FAILED");
  }
  delete state.bots;
  const result = repo.write(TABLE, DIRECTOR_PATH, state);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_DIRECTOR_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) throw new Error(flush && flush.errorMsg || "PLAYERBOT_DIRECTOR_FLUSH_FAILED");
  return state;
}

function isEnabled() {
  return process.env.EVEJS_PLAYER_BOTS_AUTOWORK !== "0" && readState().enabled !== false;
}

function setEnabled(enabled) {
  const state = readState();
  state.enabled = Boolean(enabled);
  state.updatedAt = new Date().toISOString();
  saveState(state);
  return state;
}

function isBusy(characterID) {
  const operations = require("./playerBotOperationRuntime");
  const operation = operations.getOperation(characterID);
  const retryableColonyReview = operation && operation.kind === "colony" &&
    operation.status === "review" && operation.stage === "planting" &&
    !operation.pending && Number(operation.automaticRecoveryCount || 0) < 1 &&
    String(operation.lastError || "").includes("CannotCreatePinWrongPlanetType") &&
    !require("../planet/planetRuntimeStore").getColony(operation.planetID, characterID);
  if (operations.hasActiveOperation(characterID) || operation?.pending || operation?.loadSheddingPaused === true ||
      (operation?.kind === "upgrade" && operation?.resumeCombat && !["stopped", "completed"].includes(operation.status)) ||
      (operation?.status === "review" && !retryableColonyReview)) return true;
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(characterID);
  // A review cycle is frozen for financial reconciliation, but it must not
  // freeze the pilot itself. The director may assign a different safe job;
  // startCycle still refuses to overwrite the unresolved review.
  return Boolean(cycle && (["active", "holding"].includes(cycle.status) || cycle.pending ||
    cycle.loadSheddingPaused === true));
}

function industryCycleNeedsManualReview(cycle) {
  return Boolean(cycle && ["review", "blocked"].includes(String(cycle.status || "").toLowerCase()));
}

function processCapsuleRecoveryCandidates(candidates, options = {}) {
  const maximumStarts = Math.max(0, Math.trunc(Number(options.maximumStarts) || 0));
  const canStart = typeof options.canStart === "function" ? options.canStart : () => true;
  const startRecovery = typeof options.startRecovery === "function" ? options.startRecovery : () => null;
  const onStarted = typeof options.onStarted === "function" ? options.onStarted : () => {};
  let starts = 0;
  let attempts = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (starts >= maximumStarts) break;
    if (!canStart(candidate)) continue;
    attempts += 1;
    const recovery = startRecovery(candidate);
    if (!recovery || recovery.success !== true || recovery.existing === true) continue;
    starts += 1;
    onStarted(candidate, recovery);
  }
  return { starts, attempts };
}

function shouldResetLegacyWarSpecialtyCooldown(bot, assignment) {
  return Boolean(bot && bot.specialty !== "security" && assignment && assignment.lastAssignment === "combat" &&
    /needs the security specialty to start a war patrol/i.test(String(assignment.lastMessage || "")));
}

function shouldResetStaleNoWorkCooldown(bot, assignment, cycle) {
  if (!bot || !assignment || Number(assignment.cooldownUntil || 0) <= Date.now()) return false;
  if (bot.specialty === "industry" && cycle && cycle.status === "review" && !cycle.pending) return true;
  const message = String(assignment.lastMessage || "");
  if ((bot.specialty === "security" || bot.specialty === "piracy") &&
      assignment.lastAssignment === "combat" &&
      /no suitable local patrol site|no local asteroid belt is available|no reachable (?:null-sec pirate region|online legal war opponent|combat anomaly)/i.test(message)) {
    return true;
  }
  return bot.specialty === "industry" && assignment.lastAssignment === "sell" &&
    cycle && ["review", "blocked"].includes(String(cycle.status || "").toLowerCase()) &&
    !cycle.pending && /is in industry cycle .*; stop it first\./i.test(message);
}

function isCombatOpportunityUnavailable(result) {
  return Boolean(result && result.success !== true &&
    /no suitable local patrol site|no local asteroid belt is available|no reachable (?:null-sec pirate region|online legal war opponent|combat anomaly)|all reachable combat anomalies are claimed/i
      .test(String(result.message || "")));
}

function chooseCombatOpportunityFallback(bot, result, options = {}) {
  if (!isCombatOpportunityUnavailable(result)) return null;
  return chooseMiningAssignment(bot, {
    ...options,
    prioritizeProductiveWork: false,
  });
}

function chooseIndustryReviewFallback(bot, options = {}) {
  return chooseMiningAssignment(bot, {
    ...options,
    prioritizeProductiveWork: true,
    allowTerritorialMining: true,
  });
}

function canStartWorkFromCurrentLocation(bot) {
  const character = readSharedCharacterRecord(Number(bot && bot.characterID)) || {};
  if (Number(character.stationID || character.structureID) > 0) return true;
  try {
    const session = require("./playerBotSpaceRuntime").getActorSession(bot);
    return Boolean(session && (session._space ||
      Number(session.solarsystemid || session.solarsystemid2 || character.solarSystemID) > 0));
  } catch (_) {
    return false;
  }
}

function canYieldDockedWorkForCoreInstall(operation, character) {
  if (!operation || !["active", "holding"].includes(operation.status) || operation.pending === true) {
    return false;
  }
  if (!Number(character && (character.stationID || character.structureID))) return false;
  if (!["mine", "sell", "haul", "fulfill", "pi-collect", "colony"].includes(operation.kind)) {
    return false;
  }
  if (operation.kind === "pi-collect" &&
      (Number(operation.containerID) > 0 || operation.exportAttempt)) return false;
  return true;
}

function countActive() {
  return getCapacityWorkEntries(listActiveWorkEntries()).length;
}

function getMaxConcurrentWork() {
  return require("./playerBotConfigurationRuntime").getSettings().maxConcurrentWork || DEFAULT_MAX_CONCURRENT_WORK;
}

function getMaxConcurrentCapacityRelocations() {
  return require("./playerBotConfigurationRuntime").getSettings().maxConcurrentRelocations || DEFAULT_MAX_CONCURRENT_CAPACITY_RELOCATIONS;
}

function getMaxConcurrentColonySetups() {
  return require("./playerBotConfigurationRuntime").getSettings().maxConcurrentColonySetups || DEFAULT_MAX_CONCURRENT_COLONY_SETUPS;
}

function listActiveWorkEntries() {
  const operationRuntime = require("./playerBotOperationRuntime");
  const cycleRuntime = require("./playerBotIndustryCycleRuntime");
  const operations = (typeof operationRuntime.listActiveOperationRecords === "function"
    ? operationRuntime.listActiveOperationRecords() : operationRuntime.listActiveOperations()).map((work) => ({
    characterID: Number(work.characterID),
    corporationID: Number(work.corporationID) || 0,
    kind: work.kind,
    stage: work.stage,
    work,
    source: "operation",
  }));
  const cycles = (typeof cycleRuntime.listActiveCycleRecords === "function"
    ? cycleRuntime.listActiveCycleRecords() : cycleRuntime.listActiveCycles()).map((work) => ({
    characterID: Number(work.characterID),
    corporationID: Number(work.corporationID) || 0,
    kind: "industry",
    stage: work.stage,
    work,
    source: "cycle",
  }));
  return [...operations, ...cycles];
}

function isCapacityRelocation(entry) {
  return Boolean(entry && entry.source === "operation" && entry.kind === "relocate");
}

function getCapacityWorkEntries(entries = listActiveWorkEntries()) {
  // Capacity is a per-pilot limit. Recovered legacy state can contain both
  // an operation and a production cycle for one pilot; count that pilot once,
  // matching the dashboard's active-work coverage map.
  const byCharacter = new Map();
  for (const entry of entries) {
    if (!entry || isCapacityRelocation(entry)) continue;
    const characterID = Number(entry.characterID) || 0;
    if (!characterID || byCharacter.has(characterID)) continue;
    byCharacter.set(characterID, entry);
  }
  return [...byCharacter.values()];
}

function countActiveCapacityRelocations(entries = listActiveWorkEntries()) {
  return entries.filter(isCapacityRelocation).length;
}

function canAssignAtCapacity(options = {}) {
  const active = Number(options.active) || 0;
  const limit = Number(options.limit) || 0;
  // A corporation-owned structure waiting for its Quantum Core cannot become
  // operational until a qualified pilot installs it. Treat that bounded,
  // single-item trip as commissioning work even when ordinary work slots are
  // full; the regular per-bot operation and route limits still apply.
  if (options.assignmentKind === "structure-core-install" || options.structureMaintenance === true) return true;
  if (options.assignmentKind === "relocate") {
    return options.overSystemLimit === true &&
      options.humanControlled !== true &&
      Number(options.activeRelocations) < getMaxConcurrentCapacityRelocations();
  }
  if (options.needsMinimumProductiveWork === true || active < limit) return true;
  return false;
}

function shouldDeferHumanCorporationBot(options = {}) {
  return options.hasHuman === true &&
    options.needsMinimumProductiveWork !== true &&
    options.overSystemLimit !== true &&
    !options.escortAssignment &&
    !options.coreInstallPlan &&
    !options.structureMaintenancePlan;
}

function canResumeColonySetup(activeCount, limit = getMaxConcurrentColonySetups()) {
  return Number(activeCount) < Number(limit);
}

function shouldResumeQueuedColonySetup(queued, activeCount, limit = getMaxConcurrentColonySetups()) {
  return queued === true && canResumeColonySetup(activeCount, limit);
}

function countColonyMarketArrivals(entries, botSystemIDs, jitaSystemID, humanControlledBotIDs = new Set()) {
  const arrivals = new Map();
  const destinationSystemID = Number(jitaSystemID) || 0;
  if (!destinationSystemID) return arrivals;
  for (const entry of entries || []) {
    if (entry.source !== "operation" || entry.kind !== "colony" ||
        !["active", "holding"].includes(entry.work && entry.work.status)) continue;
    const characterID = Number(entry.characterID) || 0;
    if (!characterID || humanControlledBotIDs.has(characterID)) continue;
    const stage = String(entry.stage || entry.work && entry.work.stage || "");
    const destinationStationID = stage === "to-purchase-source"
      ? Number(entry.work && entry.work.purchaseSourceStationID) || 0
      : ["to-jita", "return-to-jita"].includes(stage)
        ? Number(entry.work && entry.work.jitaStationID) || 0
        : 0;
    const currentSystemID = Number(botSystemIDs.get(characterID)) || 0;
    if (stage === "to-purchase-source" &&
        (!destinationStationID || stationSystemID(destinationStationID) !== destinationSystemID)) continue;
    if (!destinationStationID && !["to-jita", "return-to-jita"].includes(stage)) continue;
    if (currentSystemID === destinationSystemID) continue;
    arrivals.set(destinationSystemID, (arrivals.get(destinationSystemID) || 0) + 1);
  }
  return arrivals;
}

function needsColonySetup(bot) {
  const characterID = Number(bot && bot.characterID) || 0;
  return characterID > 0 &&
    !require("../planet/planetRuntimeStore").listColoniesForCharacter(characterID).length &&
    require("./playerBotColonyRuntime").hasColonySkill(bot);
}

function queueColonySetupAssignment(bot, reason, reasonCode = "colony-setup-limit", now = Date.now()) {
  const characterID = Number(bot && bot.characterID) || 0;
  if (!characterID) return false;
  const entry = { ...getBotDirectorAssignment(characterID) };
  const nextReasonCode = String(reasonCode || "colony-setup-limit").slice(0, 80);
  const nextReason = String(reason || "Waiting for a planetary colony setup slot.").slice(0, 240);
  if (entry.queuedColonySetup === true && entry.queuedReasonCode === nextReasonCode &&
      entry.queuedReason === nextReason) return true;
  if (entry.queuedColonySetup !== true) entry.queuedAt = now;
  entry.queuedColonySetup = true;
  entry.queuedReasonCode = nextReasonCode;
  entry.queuedReason = nextReason;
  saveBotDirectorAssignment(characterID, entry);
  return true;
}

function clearColonySetupAssignment(characterID) {
  const entry = { ...getBotDirectorAssignment(characterID) };
  if (entry.queuedColonySetup !== true && !entry.queuedReason && !entry.queuedAt) return false;
  entry.queuedColonySetup = false;
  delete entry.queuedAt;
  delete entry.queuedReason;
  delete entry.queuedReasonCode;
  saveBotDirectorAssignment(characterID, entry);
  return true;
}

function isProductiveWorkEntry(entry) {
  return entry.source === "cycle" ||
    ["mine", "sell", "haul", "fulfill", "pi-collect", "combat", "sovereignty", "alliance-courier", "structure-procurement", "structure-deployment", "structure-core-install", "structure-service-provision"]
      .includes(entry.kind);
}

// Work with a concrete destination is allowed to finish even when its target
// system is temporarily above the autonomous population limit. Once finished,
// the director schedules a relocation from that system.
function isFiniteDestinationWork(entry) {
  if (!entry) return false;
  if (entry.source === "cycle") {
    return Boolean(entry.work && (entry.work.deliverTo || entry.work.relistOnly));
  }
  return ["relocate", "sell", "haul", "fulfill", "pi-collect", "colony", "upgrade",
    "combat", "sovereignty", "alliance-courier", "alliance-founding", "structure-procurement", "structure-deployment", "structure-core-install", "structure-service-provision", "order-build", "order-courier"]
    .includes(String(entry.kind || ""));
}

function countBotRosterBySystem(botSystemIDs, humanControlledBotIDs = new Set()) {
  const counts = new Map();
  for (const [characterIDValue, systemIDValue] of botSystemIDs) {
    const characterID = Number(characterIDValue);
    const systemID = Number(systemIDValue);
    if (!systemID || humanControlledBotIDs.has(characterID)) continue;
    counts.set(systemID, (counts.get(systemID) || 0) + 1);
  }
  return counts;
}

function applyRelocationReservations(counts, entries, botSystemIDs) {
  for (const entry of entries) {
    if (entry.kind !== "relocate" || !["active", "holding"].includes(entry.work && entry.work.status)) continue;
    const characterID = Number(entry.characterID);
    const originSystemID = Number(entry.work.originSystemID) || Number(botSystemIDs.get(characterID)) || 0;
    const destinationSystemID = Number(entry.work.destinationSystemID) || 0;
    const actualSystemID = Number(botSystemIDs.get(characterID)) || 0;
    if (originSystemID && actualSystemID === originSystemID && destinationSystemID && destinationSystemID !== originSystemID) {
      counts.set(originSystemID, Math.max(0, (counts.get(originSystemID) || 0) - 1));
      counts.set(destinationSystemID, (counts.get(destinationSystemID) || 0) + 1);
    }
  }
  return counts;
}

function choosePostCapacityAssignment(assignment, systemCount, limit, humanControlled = false, stationID = 0,
  protectProductiveMinimum = false) {
  if (humanControlled || Number(systemCount) <= Number(limit) ||
      (protectProductiveMinimum && isProductiveAssignment(assignment)) ||
      (assignment && !["combat", "colony"].includes(assignment.kind) && isFiniteDestinationWork({
    kind: assignment && assignment.kind,
    source: assignment && assignment.source,
    work: assignment && assignment.work,
  }))) return assignment;
  const destinationStationID = typeof stationID === "function" ? stationID() : stationID;
  return destinationStationID ? { kind: "relocate", stationID: destinationStationID } : null;
}

function findRelocationStation(bot, rosterCounts, options = {}) {
  const worldData = require("../../space/worldData");
  const character = readSharedCharacterRecord(bot.characterID) || {};
  const startSystemID = Number(character.solarSystemID) || 0;
  const limit = Number(options.limit) || BOT_CAPACITY.getMaxAutonomousBotsPerSystem();
  if (!startSystemID || !worldData.getSolarSystemByID(startSystemID)) return 0;

  const economy = require("./playerBotEconomyRuntime");
  let candidates = relocationCandidateCache.get(startSystemID);
  if (!candidates) {
    const maxHops = 64;
    const queue = [{ systemID: startSystemID, hops: 0 }];
    const visited = new Set([startSystemID]);
    candidates = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      if (current.hops > 0) {
        const system = worldData.getSolarSystemByID(current.systemID) || {};
        const security = Number(system.security ?? system.securityStatus ?? system.trueSecurity);
        if (Number.isFinite(security) && security >= 0.45 &&
            (worldData.getAsteroidBeltsForSystem(current.systemID) || []).length) {
          for (const station of worldData.getStationsForSystem(current.systemID)) {
            const stationID = Number(station.stationID || station.itemID) || 0;
            if (!stationID || economy.isJitaStation(stationID)) continue;
            candidates.push({ stationID, systemID: current.systemID, hops: current.hops, security });
          }
        }
      }
      if (current.hops >= maxHops) continue;
      for (const gate of worldData.getStargatesForSystem(current.systemID)) {
        const destinationGate = worldData.getStargateByID(gate.destinationID);
        const nextSystemID = Number(gate.destinationSolarSystemID ||
          destinationGate && destinationGate.solarSystemID) || 0;
        if (!nextSystemID || visited.has(nextSystemID)) continue;
        visited.add(nextSystemID);
        queue.push({ systemID: nextSystemID, hops: current.hops + 1 });
      }
    }
    relocationCandidateCache.set(startSystemID, candidates);
  }
  const available = candidates.filter((candidate) =>
    (rosterCounts.get(candidate.systemID) || 0) < limit);
  available.sort((left, right) =>
    left.hops - right.hops ||
    (rosterCounts.get(right.systemID) || 0) - (rosterCounts.get(left.systemID) || 0) ||
    right.security - left.security || left.stationID - right.stationID);
  return available[0]?.stationID || 0;
}

function isActivelyProductiveWorkEntry(entry) {
  return entry.work.status === "active" && isProductiveWorkEntry(entry);
}

function workStagePriority(entry) {
  return ["sell", "unload", "reprocess", "deliver", "corp-share", "done-check", "manufacturing", "install"]
    .includes(String(entry.stage || "").toLowerCase()) ? 1 : 0;
}

function selectWorkToPause(entries, limit, protectedEntries = new Set(), humanControlledBotIDs = new Set()) {
  const prioritized = [...entries].sort((left, right) =>
    Number(humanControlledBotIDs.has(Number(right.characterID))) -
      Number(humanControlledBotIDs.has(Number(left.characterID))) ||
    Number(protectedEntries.has(right)) - Number(protectedEntries.has(left)) ||
    Number(isFiniteDestinationWork(right)) - Number(isFiniteDestinationWork(left)) ||
    workStagePriority(right) - workStagePriority(left) ||
    (Date.parse(left.work.createdAt || "") || 0) - (Date.parse(right.work.createdAt || "") || 0));
  const protectedWork = new Set([
    ...prioritized.filter(isFiniteDestinationWork),
    ...prioritized.filter((entry) => protectedEntries.has(entry)),
    ...prioritized.filter((entry) => humanControlledBotIDs.has(Number(entry.characterID))),
  ]);
  const pauseSlots = Math.max(0, Number(limit) - protectedWork.size);
  return prioritized.filter((entry) => !protectedWork.has(entry)).slice(pauseSlots);
}

function countActiveEntriesBySystem(entries, botSystemIDs, humanControlledBotIDs) {
  const counts = new Map();
  for (const entry of entries) {
    const characterID = Number(entry.characterID);
    const systemID = botSystemIDs.get(characterID) || 0;
    if (!systemID || humanControlledBotIDs.has(characterID)) continue;
    counts.set(systemID, (counts.get(systemID) || 0) + 1);
  }
  return counts;
}

function stationSystemID(stationID) {
  const worldData = require("../../space/worldData");
  const station = worldData.getStationByID(Number(stationID)) || worldData.getStructureByID(Number(stationID));
  return Number(station && station.solarSystemID) || 0;
}

function canReserveSystemArrival(residentCount, incomingCount, limit, humanControlled = false) {
  return humanControlled === true || Number(residentCount || 0) + Number(incomingCount || 0) < Number(limit || 0);
}

function shouldQueueUpgradeForMarketCapacity(operation, residentCount, incomingCount, limit) {
  // Capsule recovery is a finite trip to replace a lost ship. Let it reach its
  // chosen market even when the system is full; after the fit completes,
  // choosePostCapacityAssignment sends the pilot to an under-capacity system.
  if (operation && operation.capsuleRecovery === true) return false;
  return !canReserveSystemArrival(residentCount, incomingCount, limit);
}

function shouldRetargetUpgradeMarket(operation) {
  // A capsule-recovery purchase can discover regional hull stock only after
  // querying the live market at its first destination. Keep that verified
  // source station sticky; the package planner can otherwise send the pilot
  // back to an empty hub before the finite recovery trip reaches the offer.
  return !(operation && operation.capsuleRecovery === true &&
    Number(operation.sourceStationID) > 0);
}

function countUpgradeMarketArrivals(entries, botSystemIDs, humanControlledBotIDs = new Set()) {
  const arrivals = new Map();
  for (const entry of entries || []) {
    if (entry.source !== "operation" || entry.kind !== "upgrade" ||
        !["active", "holding"].includes(entry.work && entry.work.status)) continue;
    const characterID = Number(entry.characterID) || 0;
    if (!characterID || humanControlledBotIDs.has(characterID)) continue;
    const destinationSystemID = stationSystemID(entry.work && entry.work.marketStationID);
    const currentSystemID = Number(botSystemIDs.get(characterID)) || 0;
    if (!destinationSystemID || currentSystemID === destinationSystemID) continue;
    arrivals.set(destinationSystemID, (arrivals.get(destinationSystemID) || 0) + 1);
  }
  return arrivals;
}

function countMiningArrivals(entries, botSystemIDs, humanControlledBotIDs = new Set()) {
  const arrivals = new Map();
  for (const entry of entries || []) {
    if (entry.source !== "operation" || entry.kind !== "mine" ||
        !["active", "holding"].includes(entry.work && entry.work.status)) continue;
    const characterID = Number(entry.characterID) || 0;
    if (!characterID || humanControlledBotIDs.has(characterID)) continue;
    const destinationSystemID = stationSystemID(entry.work && entry.work.homeStationID);
    const currentSystemID = Number(botSystemIDs.get(characterID)) || 0;
    if (!destinationSystemID || currentSystemID === destinationSystemID) continue;
    arrivals.set(destinationSystemID, (arrivals.get(destinationSystemID) || 0) + 1);
  }
  return arrivals;
}

function enforceUpgradeMarketArrivalLimit(options = {}) {
  const operationRuntime = require("./playerBotOperationRuntime");
  const playerBotRuntime = require("./playerBotRuntime");
  const playerBots = typeof playerBotRuntime.getPlanningRoster === "function"
    ? playerBotRuntime.getPlanningRoster() : playerBotRuntime.listBots();
  const botsByID = new Map(playerBots.map((bot) => [Number(bot.characterID), bot]));
  const botSystemIDs = new Map(playerBots.map((bot) => [Number(bot.characterID), BOT_CAPACITY.getBotSystemID(bot)]));
  const humanControlledBotIDs = BOT_CAPACITY.getHumanControlledBotIDs(playerBots);
  const residentCounts = countBotRosterBySystem(botSystemIDs, humanControlledBotIDs);
  const incoming = new Map();
  const limit = BOT_CAPACITY.getMaxAutonomousBotsPerSystem();
  const upgrades = (typeof operationRuntime.listActiveOperationRecords === "function"
    ? operationRuntime.listActiveOperationRecords() : operationRuntime.listActiveOperations())
    .filter((operation) => operation.kind === "upgrade" && ["active", "holding"].includes(operation.status))
    .sort((left, right) => (Date.parse(left.createdAt || "") || 0) - (Date.parse(right.createdAt || "") || 0));
  let queued = 0;
  let retargeted = 0;
  const now = Date.now();
  for (let operation of upgrades) {
    const characterID = Number(operation.characterID) || 0;
    const bot = botsByID.get(characterID);
    if (!bot) continue;
    if (options.skipRetarget !== true && shouldRetargetUpgradeMarket(operation) &&
        Number(operation.spent) <= 0 && !operation.pending && !Number(operation.newShipID) &&
        ["to-market", "buy"].includes(operation.stage)) {
      const destinationStationID = operationRuntime.findUpgradeMarketStation(bot, operation);
      if (destinationStationID && Number(destinationStationID) !== Number(operation.marketStationID)) {
        const change = operationRuntime.retargetUnpurchasedUpgrade(characterID, destinationStationID);
        if (change.success && !change.unchanged) {
          operation = change.operation;
          retargeted += 1;
        }
      }
    }
    const destinationSystemID = stationSystemID(operation.marketStationID);
    const currentSystemID = Number(botSystemIDs.get(characterID)) || 0;
    if (!destinationSystemID || currentSystemID === destinationSystemID || humanControlledBotIDs.has(characterID)) continue;
    const arrivals = Number(incoming.get(destinationSystemID)) || 0;
    const residents = Number(residentCounts.get(destinationSystemID)) || 0;
    if (shouldQueueUpgradeForMarketCapacity(operation, residents, arrivals, limit)) {
      const result = operationRuntime.queueUpgradeForMarketCapacity(
        characterID,
        `Queued because system ${destinationSystemID} already has ${residents + arrivals}/${limit} autonomous pilots or upgrade arrivals.`,
        now + UPGRADE_MARKET_QUEUE_RETRY_MS,
      );
      if (result.success) {
        queued += 1;
        continue;
      }
    }
    incoming.set(destinationSystemID, arrivals + 1);
  }
  return { queued, retargeted, incoming };
}

function getCapacityTarget(entries, humanCorporations, humanControlledBotIDs = new Set()) {
  const productiveByCorporation = new Map();
  for (const entry of entries) {
    if (!isActivelyProductiveWorkEntry(entry) || !humanCorporations.has(entry.corporationID)) continue;
    if (!productiveByCorporation.has(entry.corporationID)) productiveByCorporation.set(entry.corporationID, new Set());
    productiveByCorporation.get(entry.corporationID).add(entry.characterID);
  }
  const reserveShortfall = [...humanCorporations].reduce((sum, corporationID) =>
    sum + Math.max(0, MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP -
      (productiveByCorporation.get(corporationID)?.size || 0)), 0);
  const protectedCount = [...productiveByCorporation.values()].reduce((sum, characters) =>
    sum + Math.min(MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP, characters.size), 0);
  const controlledCount = new Set(entries
    .filter((entry) => humanControlledBotIDs.has(Number(entry.characterID)))
    .map((entry) => Number(entry.characterID))).size;
  return {
    productiveByCorporation,
    limit: Math.max(protectedCount, getMaxConcurrentWork() - reserveShortfall) + controlledCount,
  };
}

function enforceConcurrentWorkLimit(options = {}) {
  let allEntries = listActiveWorkEntries();
  const upgradeMarket = options.skipUpgradeMarketPlanning === true
    ? { queued: 0, retargeted: 0, incoming: new Map() }
    : enforceUpgradeMarketArrivalLimit();
  // Keep the work closest to completion active; pause unfinished setup trips
  // first so a large fresh roster cannot send everyone to Jita.
  const excessColonies = selectExcessColonySetups(allEntries);
  const queuedColonyCharacterIDs = new Set();
  let colonySetupsPaused = 0;
  for (const entry of excessColonies) {
    const result = require("./playerBotOperationRuntime").queueColonySetupForDirector(
      entry.characterID,
      `Queued because planetary setup is limited to ${getMaxConcurrentColonySetups()} simultaneous colonies.`,
    );
    if (!result.success) continue;
    try {
      require("./playerBotSpaceRuntime").detachBotActorFromSpace(entry.characterID);
    } catch (error) {
      require("../../utils/logger").warn(
        `[PlayerBots] Could not park colony-queued bot char=${entry.characterID}: ${error.message}`,
      );
    }
    queuedColonyCharacterIDs.add(Number(entry.characterID));
    colonySetupsPaused += 1;
  }
  // Convert colony trips queued by an earlier global-capacity pass into the
  // independent PI setup queue so their pilots can take useful work meanwhile.
  for (const entry of listCapacityPausedWork().filter((candidate) =>
    candidate.source === "operation" && candidate.work.kind === "colony")) {
    const result = require("./playerBotOperationRuntime").queueColonySetupForDirector(
      entry.characterID,
      `Queued because planetary setup is limited to ${getMaxConcurrentColonySetups()} simultaneous colonies.`,
    );
    if (!result.success) continue;
    queuedColonyCharacterIDs.add(Number(entry.characterID));
    colonySetupsPaused += 1;
    try {
      require("./playerBotSpaceRuntime").detachBotActorFromSpace(entry.characterID);
    } catch (error) {
      require("../../utils/logger").warn(
        `[PlayerBots] Could not park colony-queued bot char=${entry.characterID}: ${error.message}`,
      );
    }
  }
  if (colonySetupsPaused || upgradeMarket.queued || upgradeMarket.retargeted) allEntries = listActiveWorkEntries();
  const entries = getCapacityWorkEntries(allEntries);
  const humanCorporations = onlineHumanCorporationIDs();
  const humanControlledBotIDs = BOT_CAPACITY.getHumanControlledBotIDs();
  const capacity = getCapacityTarget(entries, humanCorporations, humanControlledBotIDs);
  const protectedEntries = new Set();
  for (const corporationID of humanCorporations) {
    const productive = entries
      .filter((entry) => entry.corporationID === corporationID && isActivelyProductiveWorkEntry(entry))
      .sort((left, right) => workStagePriority(right) - workStagePriority(left));
    const protectedCharacters = new Set();
    for (const entry of productive) {
      if (protectedCharacters.has(entry.characterID)) continue;
      if (protectedCharacters.size >= MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP) break;
      protectedCharacters.add(entry.characterID);
      protectedEntries.add(entry);
    }
  }
  const prioritized = [...entries].sort((left, right) =>
    Number(humanControlledBotIDs.has(Number(right.characterID))) -
      Number(humanControlledBotIDs.has(Number(left.characterID))) ||
    Number(protectedEntries.has(right)) - Number(protectedEntries.has(left)) ||
    Number(isFiniteDestinationWork(right)) - Number(isFiniteDestinationWork(left)) ||
    workStagePriority(right) - workStagePriority(left) ||
    (Date.parse(left.work.createdAt || "") || 0) - (Date.parse(right.work.createdAt || "") || 0));
  const entriesToPause = new Set(selectWorkToPause(entries, capacity.limit, protectedEntries, humanControlledBotIDs));
  // Per-system overflow is resolved by relocating idle bots. Do not pause
  // in-flight work just because an order temporarily brings in a visitor.
  let paused = 0;
  for (const entry of prioritized.filter((entry) => entriesToPause.has(entry)).reverse()) {
    const reason = `Queued because autonomous work reached the global ${capacity.limit}-job capacity.`;
    const result = entry.source === "cycle"
      ? require("./playerBotIndustryCycleRuntime").pauseForCapacity(entry.characterID, reason)
      : require("./playerBotOperationRuntime").pauseForCapacity(entry.characterID, reason);
    if (!result.success) continue;
    try {
      require("./playerBotSpaceRuntime").detachBotActorFromSpace(entry.characterID);
    } catch (error) {
      require("../../utils/logger").warn(
        `[PlayerBots] Could not park capacity-queued bot char=${entry.characterID}: ${error.message}`,
      );
    }
    paused += 1;
  }
  const active = countActive();
  if (paused > 0) {
    require("../../utils/logger").info(
      `[PlayerBots] Space-work capacity active=${active}/${capacity.limit} ` +
        `queued=${paused}; per-system autonomous limit=${BOT_CAPACITY.getMaxAutonomousBotsPerSystem()}; ` +
        "all bot presence sessions remain online.",
    );
  }
  return {
    active,
    limit: capacity.limit,
    configuredLimit: getMaxConcurrentWork(),
    perSystemLimit: BOT_CAPACITY.getMaxAutonomousBotsPerSystem(),
    assignmentLimit: capacity.limit,
    queued: listCapacityPausedWork().length,
    paused,
    relocations: countActiveCapacityRelocations(allEntries),
    colonySetups: countActiveColonySetups(allEntries),
    colonySetupsPaused,
    upgradeTripsQueued: upgradeMarket.queued,
    upgradeTripsRetargeted: upgradeMarket.retargeted,
    queuedColonyCharacterIDs: [...queuedColonyCharacterIDs],
  };
}

function colonyStagePriority(stage) {
  const priorities = {
    "to-jita": 0,
    "to-purchase-source": 1,
    "buy-at-source": 2,
    "return-to-jita": 3,
    buy: 4,
    "to-colony-system": 5,
    plant: 6,
    planting: 7,
  };
  return Number(priorities[String(stage || "")]) || 0;
}

function isColonySetupEntry(entry) {
  if (!entry || entry.source !== "operation" || entry.kind !== "colony") return false;
  const work = entry.work || {};
  const planetID = Number(work.planetID) || 0;
  if (!planetID) return true;
  return !require("../planet/planetRuntimeStore").getColony(planetID, Number(entry.characterID));
}

function countActiveColonySetups(entries) {
  return (Array.isArray(entries) ? entries : []).filter(isColonySetupEntry).length;
}

function selectExcessColonySetups(entries, limit = getMaxConcurrentColonySetups()) {
  const active = (Array.isArray(entries) ? entries : [])
    .filter(isColonySetupEntry)
    .sort((left, right) => colonyStagePriority(right.work && right.work.stage) -
      colonyStagePriority(left.work && left.work.stage) ||
      (Date.parse(left.work && left.work.createdAt || "") || 0) -
      (Date.parse(right.work && right.work.createdAt || "") || 0));
  return active.slice(Math.max(0, Math.trunc(Number(limit) || 0)));
}

function listCapacityPausedWork() {
  const operationRuntime = require("./playerBotOperationRuntime");
  const cycleRuntime = require("./playerBotIndustryCycleRuntime");
  const operations = (typeof operationRuntime.listOperationRecords === "function"
    ? operationRuntime.listOperationRecords() : operationRuntime.listOperations())
    .filter((work) => work.loadSheddingPaused === true && work.status === "stopped")
    .map((work) => ({ characterID: Number(work.characterID), work, source: "operation" }));
  const cycles = (typeof cycleRuntime.listCycleRecords === "function"
    ? cycleRuntime.listCycleRecords() : cycleRuntime.listCycles())
    .filter((work) => work.loadSheddingPaused === true && work.status === "stopped")
    .map((work) => ({ characterID: Number(work.characterID), work, source: "cycle" }));
  return [...operations, ...cycles];
}

function resumeCapacityQueuedWork(options = {}) {
  const requestedMaximum = Number(options.maxResumes);
  const maxResumes = Number.isSafeInteger(requestedMaximum)
    ? Math.max(0, requestedMaximum)
    : MAX_CAPACITY_RESUMES_PER_PASS;
  const bots = require("./playerBotRuntime").listBots();
  const botsByID = new Map(bots.map((bot) => [Number(bot.characterID), bot]));
  const humanCorporations = onlineHumanCorporationIDs();
  let activeEntries = getCapacityWorkEntries(listActiveWorkEntries());
  let activeColonySetups = countActiveColonySetups(activeEntries);
  const humanControlledBotIDs = BOT_CAPACITY.getHumanControlledBotIDs();
  let capacity = getCapacityTarget(activeEntries, humanCorporations, humanControlledBotIDs);
  const paused = listCapacityPausedWork().sort((left, right) =>
    Number(humanCorporations.has(Number((botsByID.get(right.characterID) || {}).corporationID))) -
      Number(humanCorporations.has(Number((botsByID.get(left.characterID) || {}).corporationID))) ||
    (Number(left.work.loadSheddingPausedAtMs) || 0) - (Number(right.work.loadSheddingPausedAtMs) || 0));
  let resumed = 0;
  let attempts = 0;
  const maxAttempts = maxResumes * 3;
  for (const entry of paused) {
    if (resumed >= maxResumes || attempts >= maxAttempts) break;
    if (entry.source === "operation" && entry.work.kind === "colony" &&
        isColonySetupEntry(entry) && !canResumeColonySetup(activeColonySetups)) continue;
    const bot = botsByID.get(entry.characterID);
    if (!bot || bot.status === "paused" || bot.autonomyPaused === true) continue;
    const entryKind = entry.source === "cycle" ? "industry" : entry.work.kind;
    const productive = entry.source === "cycle" || ["mine", "sell", "haul", "fulfill", "pi-collect"].includes(entryKind);
    const humanCorporationID = Number(bot.corporationID) || 0;
    const productiveCount = activeEntries.filter((active) =>
      active.corporationID === humanCorporationID && isActivelyProductiveWorkEntry(active),
    ).length;
    const belowHumanMinimum = humanCorporations.has(humanCorporationID) && productive &&
      productiveCount < MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP;
    if (activeEntries.length >= capacity.limit && !belowHumanMinimum) continue;
    attempts += 1;
    const result = entry.source === "cycle"
      ? require("./playerBotIndustryCycleRuntime").resumeCycle(bot.characterName)
      : require("./playerBotOperationRuntime").resumeOperation(bot.characterName, { capacityManaged: true });
    if (!result.success) continue;
    resumed += 1;
    const work = result.operation || result.cycle || {
      ...entry.work,
      status: "active",
      loadSheddingPaused: false,
    };
    activeEntries = getCapacityWorkEntries([...activeEntries, {
      ...entry,
      corporationID: Number(work.corporationID) || Number(bot.corporationID) || 0,
      kind: entry.source === "cycle" ? "industry" : work.kind,
      stage: work.stage,
      work,
    }]);
    activeColonySetups = countActiveColonySetups(activeEntries);
    capacity = getCapacityTarget(activeEntries, humanCorporations, humanControlledBotIDs);
  }
  return {
    active: activeEntries.length,
    limit: getMaxConcurrentWork(),
    resumed,
    attempts,
    queued: listCapacityPausedWork().length,
  };
}

function hasActiveWork(characterID) {
  const operation = require("./playerBotOperationRuntime").getOperation(characterID);
  if (operation && ["active", "holding"].includes(operation.status)) return true;
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(characterID);
  return Boolean(cycle && ["active", "holding"].includes(cycle.status));
}

// The bot hub: where bot output is sold (never Jita).
const MARKET_STATION_ID = require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID;
const MINERAL_TYPE_IDS = new Set([34, 35, 36, 37, 38, 39, 40]);
const ORDER_MAX_RUNS = 10;
const ORDER_SKIP_MS = 60 * 60 * 1000;

// Unclaimed player buy orders, kept claimed while the bot working on one is busy.
function nextPlayerOrder(state, bot) {
  const economy = require("./playerBotEconomyRuntime");
  state.claims = state.claims || {};
  for (const [orderID, claim] of Object.entries(state.claims)) {
    if (!isBusy(claim.characterID)) delete state.claims[orderID];
  }
  state.skippedOrders = state.skippedOrders || {};
  return economy.listPlayerBuyOrders().find((order) =>
    !state.claims[String(order.order_id)] &&
    Date.now() - Number(state.skippedOrders[String(order.order_id)] || 0) > ORDER_SKIP_MS) || null;
}

// A courier only pays when Jita sells for less than the order offers.
async function courierPays(bot, order) {
  const economy = require("./playerBotEconomyRuntime");
  return economy.listSellOffers(Number(order.type_id))
    .filter((offer) => economy.isJitaStation(Number(offer.stationID)) &&
      Number(offer.quantity) > 0 && Number(offer.price) > 0)
    .sort((left, right) => Number(left.price) - Number(right.price) ||
      Number(left.stationID) - Number(right.stationID))
    .some((offer) => Number(offer.price) <= Number(order.price));
}

// Industry bots build what they can make from minerals; everyone else, or
// anything else, is couriered from Jita.
function chooseOrderAssignment(bot, order) {
  const { getBlueprintDefinitionByProductTypeID } = require("../industry/industryStaticData");
  const definition = getBlueprintDefinitionByProductTypeID(Number(order.type_id));
  const manufacturing = definition && definition.activities && definition.activities.manufacturing;
  const buildable = bot.specialty === "industry" && manufacturing &&
    (manufacturing.materials || []).every((material) => MINERAL_TYPE_IDS.has(Number(material.typeID)));
  if (buildable) {
    const perRun = Number(manufacturing.products?.[0]?.quantity) || 1;
    const product = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(order.type_id)) || {};
    const isShip = Number(product.categoryID) === 6;
    const stationID = Number(order.station_id) || 0;
    if (isShip && !require("../industry/industryRuntimeState").getFacilityPayloadByID(stationID)) return null;
    return {
      kind: "order-build",
      blueprintTypeID: Number(definition.blueprintTypeID),
      runs: Math.max(1, Math.min(ORDER_MAX_RUNS, Math.ceil(Number(order.vol_remaining) / perRun))),
      ...(isShip ? { stationID } : {}),
    };
  }
  const product = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(order.type_id)) || {};
  if (Number(product.categoryID) === 6) return null;
  return { kind: "order-courier" };
}

async function cancelBotOrdersInJita() {
  const economy = require("./playerBotEconomyRuntime");
  const trade = require("./playerBotTradeRuntime");
  const bots = require("./playerBotRuntime").listBots();
  let cancelled = 0;
  for (const order of economy.listBotSellOrdersInJita()) {
    const bot = bots.find((entry) => Number(entry.characterID) === Number(order.owner_id));
    if (!bot) continue;
    const result = await trade.cancelOrder(bot.characterName, order.order_id);
    if (result.success) cancelled += 1;
  }
  return cancelled;
}

function industryCoolingDown(cycle, now = Date.now()) {
  if (!cycle || cycle.status !== "completed") return false;
  if (marketOrderCapacityCoolingDown({
    status: cycle.status,
    completedAt: cycle.completedAt,
    saleReason: cycle.ledger && cycle.ledger.saleReason,
    unitsListed: cycle.ledger && cycle.ledger.unitsListed,
    unitsSold: cycle.ledger && cycle.ledger.unitsSold,
  }, now)) return true;
  const completedAt = Date.parse(cycle.completedAt || "");
  if (!Number.isFinite(completedAt) || completedAt > now) return false;
  if (cycle.noOpportunity === true || (cycle.autoPlan && !Number(cycle.blueprintTypeID))) {
    return now - completedAt < NO_OPPORTUNITY_COOLDOWN_MS;
  }
  return Number(cycle.ledger && cycle.ledger.netResult) < 0 && now - completedAt < LOSS_COOLDOWN_MS;
}

function marketOrderCapacityCoolingDown(operation, now = Date.now()) {
  if (!operation || operation.status !== "completed" ||
      Number(operation.unitsListed || operation.ledger && operation.ledger.unitsListed) > 0 ||
      Number(operation.unitsSold || operation.ledger && operation.ledger.unitsSold) > 0) return false;
  const reason = String(operation.saleReason || operation.ledger && operation.ledger.saleReason || "");
  if (!/already has \d+ active market orders, which meets the current market-order skill limit/i.test(reason)) {
    return false;
  }
  const completedAt = Date.parse(operation.completedAt || "");
  return Number.isFinite(completedAt) && completedAt <= now &&
    now - completedAt < MARKET_ORDER_CAPACITY_RETRY_COOLDOWN_MS;
}

function upgradeCoolingDown(operation, now = Date.now()) {
  if (!operation) return false;
  const marketCapacityRetryAtMs = Number(operation.marketCapacityRetryAtMs) || 0;
  if (marketCapacityRetryAtMs > 0) return marketCapacityRetryAtMs > now;
  const deferredRetryAtMs = Number(operation.deferredUpgrade && operation.deferredUpgrade.retryAfterAtMs) || 0;
  if (deferredRetryAtMs > 0) return deferredRetryAtMs > now;
  if (operation.kind !== "upgrade" || operation.status !== "blocked") return false;
  const retryAfterAtMs = Number(operation.retryAfterAtMs) || 0;
  if (retryAfterAtMs > 0) return retryAfterAtMs > now;
  const updated = Date.parse(operation.updatedAt || "");
  return Number.isFinite(updated) && updated <= now && now - updated < UPGRADE_RETRY_COOLDOWN_MS;
}

function combatCoolingDown(operation, now = Date.now()) {
  if (!operation || operation.kind !== "combat" || operation.status !== "completed" || operation.siteCompleted === true) return false;
  const shouldCoolDown = operation.siteAbandoned === true ||
    (operation.noOpportunity === true && Number(operation.kills) <= 0);
  if (!shouldCoolDown) return false;
  const completedAt = Date.parse(operation.completedAt || "");
  return Number.isFinite(completedAt) && completedAt <= now && now - completedAt < NO_OPPORTUNITY_COOLDOWN_MS;
}

function chooseMiningEscortAssignment(bot) {
  if (!bot || bot.specialty !== "security") return null;
  const escortRuntime = require("./playerBotMiningEscortRuntime");
  const request = escortRuntime.findPendingMiningEscortRequest(bot);
  if (!request) return null;

  const operations = require("./playerBotOperationRuntime");
  const profile = operations.getRoleShipFitProfile(bot, "security");
  const fitTier = Number(profile && profile.maxSiteDifficulty) || 0;
  if (fitTier >= Number(request.requiredTier) && operations.hasRoleShipFit(bot, "security")) {
    return { kind: "combat", mode: "security", miningEscortForCharacterID: request.characterID };
  }

  // A visible belt threat gives an idle security pilot's combat hull and fit
  // recovery priority over unrelated mining or market work. The normal
  // upgrade ladder still enforces skill, capital and profit requirements.
  const upgrade = operations.nextShipUpgrade(bot, "security");
  const balance = Number(getCharacterWallet(bot.characterID)?.balance) || 0;
  const earnedProfit = require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit;
  const upgradeReady = upgrade &&
    Number(upgrade.maxSiteDifficulty) >= Number(request.requiredTier) &&
    balance >= Number(upgrade.minBalance) &&
    (upgrade.replenishOnly === true || earnedProfit >= (Number(upgrade.minEarnedProfit) || 0)) &&
    !upgradeCoolingDown(operations.getOperation(bot.characterID));
  if (!upgradeReady) return null;
  return {
    kind: "upgrade",
    role: "security",
    marketStationID: operations.findUpgradeMarketStation(bot, upgrade),
  };
}

function findCoreInstallPlan(structureRuntime, bot) {
  return structureRuntime && typeof structureRuntime.findCoreInstallPlan === "function"
    ? structureRuntime.findCoreInstallPlan(bot)
    : null;
}

function chooseMiningAssignment(bot, options = {}) {
  const operations = require("./playerBotOperationRuntime");
  const hasMiningFit = typeof operations.hasRoleShipFit === "function" &&
    operations.hasRoleShipFit(bot, "mining");
  if (!hasMiningFit) {
    // A security or piracy ship is already productive work when it can answer
    // its own combat role. Do not replace that hull with a Venture just to
    // satisfy a generic productive-work fallback.
    if (options.prioritizeProductiveWork === true &&
        ["security", "piracy"].includes(bot.specialty) &&
        operations.hasRoleShipFit(bot, bot.specialty)) {
      const current = typeof operations.getOperation === "function"
        ? operations.getOperation(bot.characterID)
        : null;
      return combatCoolingDown(current)
        ? null
        : { kind: "combat", mode: bot.specialty };
    }

    // Mining operations without a fitted laser complete immediately and were
    // being rescheduled forever. Repair the fit through the normal upgrade
    // path when the pilot has the skills and working capital; otherwise leave
    // the bot eligible for other work without creating a no-op operation.
    const upgrade = options.skipUpgrade === true || typeof operations.nextShipUpgrade !== "function"
      ? null
      : operations.nextShipUpgrade(bot, "mining");
    const balance = Number(getCharacterWallet(bot.characterID)?.balance) || 0;
    const minimumProfit = Math.max(0, Number(upgrade && upgrade.minEarnedProfit) || 0);
    const earnedProfit = minimumProfit > 0
      ? Number(require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit) || 0
      : 0;
    const hasEarnedProfit = upgrade && (upgrade.replenishOnly === true || earnedProfit >= minimumProfit);
    if (upgrade && hasEarnedProfit && balance >= (Number(upgrade.minBalance) || 0) &&
        !upgradeCoolingDown(typeof operations.getOperation === "function"
          ? operations.getOperation(bot.characterID)
          : null)) {
      return {
        kind: "upgrade",
        role: "mining",
        marketStationID: typeof operations.findUpgradeMarketStation === "function"
          ? operations.findUpgradeMarketStation(bot, upgrade)
          : require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID,
      };
    }
    return null;
  }
  if (options.allowTerritorialMining === true && options.skipTerritorialMining !== true) {
    const base = require("./playerBotTerritoryRuntime").findTerritorialMiningBase(bot);
    if (base) return { kind: "mine", territorialBase: base };
  }
  return { kind: "mine" };
}

function chooseStructureMaintenanceAssignment(bot, plan, operations, options = {}) {
  if (!plan) return null;
  const structureRuntime = require("./playerBotStructureRuntime");
  if (structureRuntime.canCarryStructureServicePlan(bot, plan)) {
    return { kind: "structure-service-provision", plan };
  }
  if (options.skipUpgrade === true) return null;
  const upgrade = operations.nextShipUpgrade(bot, "logistics");
  if (!upgrade || upgradeCoolingDown(operations.getOperation(bot.characterID))) return null;
  const balance = Number(getCharacterWallet(bot.characterID)?.balance) || 0;
  const earnedProfit = Number(require("./playerBotCorpEconomyRuntime")
    .getCumulativeNetProfit(bot).reinvestableProfit) || 0;
  const canUseSeed = typeof structureRuntime.canFundStructureLogisticsUpgradeWithSeedCapital === "function" &&
    structureRuntime.canFundStructureLogisticsUpgradeWithSeedCapital(bot, upgrade.minBalance);
  if (balance < Number(upgrade.minBalance) ||
      (earnedProfit < Number(upgrade.minBalance) && !canUseSeed)) return null;
  return {
    kind: "upgrade",
    role: "logistics",
    marketStationID: operations.findUpgradeMarketStation(bot, upgrade),
    structureMaintenanceUpgrade: true,
  };
}

function chooseAssignment(bot, options = {}) {
  const balance = Number(getCharacterWallet(bot.characterID)?.balance) || 0;
  const operations = require("./playerBotOperationRuntime");
  const escortAssignment = chooseMiningEscortAssignment(bot);
  if (escortAssignment) return escortAssignment;
  const structureRuntime = require("./playerBotStructureRuntime");
  const coreInstallPlan = findCoreInstallPlan(structureRuntime, bot);
  if (coreInstallPlan) return { kind: "structure-core-install", plan: coreInstallPlan };
  const structureMaintenancePlan = typeof structureRuntime.findStructureMaintenancePlan === "function"
    ? structureRuntime.findStructureMaintenancePlan(bot)
    : null;
  const structureMaintenanceAssignment = chooseStructureMaintenanceAssignment(
    bot, structureMaintenancePlan, operations, options,
  );
  if (structureMaintenanceAssignment) return structureMaintenanceAssignment;
  if (bot.specialty !== "security") {
    const warRuntime = require("./playerBotWarMobilizationRuntime");
    const warAssignment = warRuntime.getActiveWarCombatAssignment(bot);
    if (warAssignment) {
      const warSupport = warRuntime.getCombatUpgradeSupport(bot);
      const balanceLimit = Number(require("../account/walletBalanceLimit").MAX_WALLET_BALANCE) || balance;
      const upgrade = operations.nextShipUpgrade(bot, "security", {
        balanceOverride: Math.min(balanceLimit, balance + Number(warSupport && warSupport.availableBudget || 0)),
      });
      if (warSupport && upgrade && balance >= Number(upgrade.minBalance) &&
          !upgradeCoolingDown(operations.getOperation(bot.characterID))) {
        return {
          kind: "upgrade",
          role: "security",
          marketStationID: operations.findUpgradeMarketStation(bot, upgrade),
          maxSpend: Math.min(balance, Number(warSupport.availableBudget) || 0),
          warMobilizationSupportID: warSupport.supportID,
        };
      }
      if (operations.hasRoleShipFit(bot, "security")) return { kind: "combat", mode: "war" };
    }
  }
  if (operations.nextPlanetaryLaunch(bot)) return { kind: "pi-collect" };
  // Establish passive PI before repeatedly moving mining stock to the market.
  // Once a colony exists, normal sell and production assignments resume.
  if (!options.skipColony &&
      !require("../planet/planetRuntimeStore").listColoniesForCharacter(bot.characterID).length &&
      require("./playerBotColonyRuntime").hasColonySkill(bot)) {
    return { kind: "colony" };
  }
  const structurePackage = structureRuntime.findStructurePackage(bot);
  if (structurePackage) {
    if (typeof structureRuntime.canCarryStructurePackage !== "function" ||
        structureRuntime.canCarryStructurePackage(bot, structurePackage)) {
      return { kind: "structure-deployment", itemID: Number(structurePackage.itemID) };
    }
    const logisticsUpgrade = operations.nextShipUpgrade(bot, "logistics");
    const corpEconomy = require("./playerBotCorpEconomyRuntime");
    const earnedProfit = corpEconomy.getCumulativeNetProfit(bot).reinvestableProfit;
    const seedCapitalAvailable = logisticsUpgrade &&
      typeof structureRuntime.canFundStructureLogisticsUpgradeWithSeedCapital === "function" &&
      structureRuntime.canFundStructureLogisticsUpgradeWithSeedCapital(bot, logisticsUpgrade.minBalance);
    if (options.skipUpgrade !== true && logisticsUpgrade &&
        balance >= Number(logisticsUpgrade.minBalance) &&
        (earnedProfit >= Number(logisticsUpgrade.minBalance) || seedCapitalAvailable) &&
        !upgradeCoolingDown(operations.getOperation(bot.characterID))) {
      return {
        kind: "upgrade",
        role: "logistics",
        marketStationID: operations.findUpgradeMarketStation(bot, logisticsUpgrade),
      };
    }
  }
  const serviceProvisionPlan = typeof structureRuntime.findStructureServiceProvisionPlan === "function"
    ? structureRuntime.findStructureServiceProvisionPlan(bot)
    : null;
  if (serviceProvisionPlan) {
    if (typeof structureRuntime.canCarryStructureServicePlan === "function" &&
        !structureRuntime.canCarryStructureServicePlan(bot, serviceProvisionPlan)) {
      const logisticsUpgrade = operations.nextShipUpgrade(bot, "logistics");
      const earnedProfit = require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit;
      if (options.skipUpgrade !== true && logisticsUpgrade &&
          balance >= Number(logisticsUpgrade.minBalance) &&
          earnedProfit >= Number(logisticsUpgrade.minBalance) &&
          !upgradeCoolingDown(operations.getOperation(bot.characterID))) {
        return { kind: "upgrade", role: "logistics", marketStationID: operations.findUpgradeMarketStation(bot, logisticsUpgrade) };
      }
    } else {
      return { kind: "structure-service-provision", plan: serviceProvisionPlan };
    }
  }
  if (!structurePackage && options.skipUpgrade !== true) {
    const structurePurchasePlan = typeof structureRuntime.findAutonomousPurchasePlan === "function"
      ? structureRuntime.findAutonomousPurchasePlan(bot)
      : null;
    if (structurePurchasePlan) return { kind: "structure-procurement", plan: structurePurchasePlan };
  }
  // Expired sell orders return their unsold items to the source hangar. Scan
  // every owned station so a bot that has since undocked will bring the stock
  // back to the regional hub and relist it at the current market price.
  const lastOperation = typeof operations.getOperation === "function"
    ? operations.getOperation(bot.characterID)
    : null;
  const cycleRuntime = require("./playerBotIndustryCycleRuntime");
  const lastCycle = typeof cycleRuntime.getCycle === "function"
    ? cycleRuntime.getCycle(bot.characterID)
    : null;
  const marketCapacityRetryCoolingDown = marketOrderCapacityCoolingDown(lastOperation) ||
    marketOrderCapacityCoolingDown(lastCycle && {
      status: lastCycle.status,
      completedAt: lastCycle.completedAt,
      saleReason: lastCycle.ledger && lastCycle.ledger.saleReason,
      unitsListed: lastCycle.ledger && lastCycle.ledger.unitsListed,
      unitsSold: lastCycle.ledger && lastCycle.ledger.unitsSold,
    });
  const returnedStockStationID = operations.findSellableGoodsStation(bot);
  if (returnedStockStationID && !marketCapacityRetryCoolingDown) {
    return { kind: "sell", originStationID: returnedStockStationID };
  }
  const expiredCorporateOutput = typeof cycleRuntime.findExpiredCorporateOutput === "function"
    ? cycleRuntime.findExpiredCorporateOutput(bot)
    : null;
  if (expiredCorporateOutput && !marketCapacityRetryCoolingDown) {
    return { kind: "sell", corporateListing: true, originStationID: Number(expiredCorporateOutput.stationID) };
  }
  if (bot.specialty === "industry" && balance >= INDUSTRY_MIN_BALANCE &&
      !industryCycleNeedsManualReview(lastCycle) &&
      !industryCoolingDown(lastCycle)) {
    const maxSpend = Math.min(INDUSTRY_MAX_SPEND, Math.floor(balance * INDUSTRY_SPEND_SHARE));
    const facility = typeof structureRuntime.findAccessibleManufacturingFacility === "function"
      ? structureRuntime.findAccessibleManufacturingFacility(bot)
      : null;
    return { kind: "industry", runs: INDUSTRY_MAX_RUNS, maxSpend,
      ...(facility ? { facilityID: facility.facilityID } : {}) };
  }
  if (options.prioritizeProductiveWork === true) {
    return chooseMiningAssignment(bot, options);
  }
  // Security, piracy and sovereignty pilots first acquire the hull required
  // for their own authority-backed activity. Other pilots follow the mining
  // progression ladder.
  const role = ["security", "piracy", "sovereignty"].includes(bot.specialty)
    ? bot.specialty
    : "mining";
  const operationRuntime = require("./playerBotOperationRuntime");
  const upgrade = operationRuntime.nextShipUpgrade(bot, role);
  const warShipSupport = bot.specialty === "security"
    ? require("./playerBotWarMobilizationRuntime").getCombatUpgradeSupport(bot)
    : null;
  const earnedProfit = ["security", "piracy"].includes(bot.specialty)
    ? require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit
    : 0;
  const combatUpgradeEarned = upgrade && (upgrade.replenishOnly === true ||
    earnedProfit >= (Number(upgrade.minEarnedProfit) || 0) || Boolean(warShipSupport));
  if (options.skipUpgrade !== true && upgrade && balance >= upgrade.minBalance && combatUpgradeEarned &&
      !upgradeCoolingDown(operations.getOperation(bot.characterID))) {
    return {
      kind: "upgrade",
      role,
      marketStationID: typeof operationRuntime.findUpgradeMarketStation === "function"
        ? operationRuntime.findUpgradeMarketStation(bot, upgrade)
        : require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID,
      ...(warShipSupport ? {
        maxSpend: Math.min(balance, Number(warShipSupport.availableBudget) || 0),
        warMobilizationSupportID: warShipSupport.supportID,
      } : {}),
    };
  }
  if (["security", "piracy"].includes(bot.specialty)) {
    if (!operationRuntime.hasRoleShipFit(bot, role)) return chooseMiningAssignment(bot, options);
    const atWar = bot.specialty === "security" &&
      require("../corporation/warRuntimeState").hasActiveWarForCharacter(bot.characterID);
    if (bot.specialty === "security" && !atWar) {
      const conflicts = require("./playerBotNullsecConflictRuntime");
      const conflict = conflicts.findNearestConflictBase(bot);
      if (conflict.success && (!combatCoolingDown(operations.getOperation(bot.characterID)) ||
          conflicts.hasOnlineConflictOpponent(bot, conflict.systemID))) {
        return { kind: "combat", mode: "nullsec-conflict" };
      }
    }
    if (combatCoolingDown(operations.getOperation(bot.characterID))) return chooseMiningAssignment(bot, options);
    return { kind: "combat", mode: atWar ? "war" : bot.specialty };
  }
  if (bot.specialty === "sovereignty") {
    const alliancePlan = require("./playerBotAllianceRuntime").getAllianceFoundingPlan(bot);
    if (alliancePlan) return { kind: "alliance-founding", plan: alliancePlan };
    const objective = require("./playerBotSovereigntyRuntime").findSovereigntyObjective(bot);
    if (objective && operationRuntime.hasRoleShipFit(bot, role)) return { kind: "sovereignty", objective };
  }
  // A negative cash flow, including unsold stock, delays reinvestment to
  // prevent repeatedly tying up capital before the market clears.
  return chooseMiningAssignment(bot, options);
}

function onlineHumanCorporationIDs() {
  const sessionRegistry = require("../chat/sessionRegistry");
  const corporationIDs = new Set();
  for (const session of sessionRegistry.getSessions()) {
    if (BOT_CAPACITY.isPlayerBotSession(session)) continue;
    const characterID = Number(session.characterID || session.charID || session.charid) || 0;
    if (!characterID) continue;
    const corporationID = Number(
      session.corporationID || session.corpid ||
      (readSharedCharacterRecord(characterID) || {}).corporationID,
    ) || 0;
    if (corporationID) corporationIDs.add(corporationID);
  }
  return corporationIDs;
}

function countProductiveBots(corporationID) {
  return getProductiveBotCountsByCorporation(new Set([Number(corporationID)]))
    .get(Number(corporationID)) || 0;
}

function getProductiveBotCountsByCorporation(corporationIDs, entries = listActiveWorkEntries()) {
  const productive = new Map([...corporationIDs].map((id) => [Number(id), new Set()]));
  const productiveKinds = new Set([
    "mine", "sell", "haul", "fulfill", "pi-collect", "combat", "sovereignty",
    "alliance-courier", "structure-procurement", "structure-deployment",
    "structure-core-install", "structure-service-provision",
  ]);
  for (const entry of entries) {
    const corporationID = Number(entry.corporationID) || 0;
    const characters = productive.get(corporationID);
    const work = entry.work;
    if (!characters || !work || work.status !== "active") continue;
    if (entry.source === "cycle" || productiveKinds.has(entry.kind)) {
      characters.add(Number(entry.characterID));
    }
  }
  return new Map([...productive].map(([corporationID, characters]) => [corporationID, characters.size]));
}

function isProductiveAssignment(assignment) {
  return ["mine", "industry", "sell", "haul", "fulfill", "pi-collect", "combat", "sovereignty",
    "alliance-courier", "alliance-founding", "structure-procurement", "structure-deployment", "structure-core-install", "structure-service-provision", "order-build", "order-courier"]
    .includes(assignment.kind);
}

async function runDirectorInternal(bots = [], options = {}) {
  const summary = { enabled: isEnabled(), active: 0, assigned: 0, mine: 0, industry: 0, upgrade: 0,
    sell: 0, "order-courier": 0, "order-build": 0, "alliance-courier": 0, "structure-procurement": 0, "structure-deployment": 0, "structure-core-install": 0, "structure-service-provision": 0, colony: 0,
    "alliance-founding": 0, combat: 0, sovereignty: 0, relocate: 0, activeRelocations: 0,
    recoveredColonyReviews: 0, recoveredLegacyPIExports: 0, capsuleRecoveries: 0, structureConflictWarsDeclared: 0,
    firstWarGrants: 0, warShipBudgetsFunded: 0, warPilotsRecruited: 0, failures: 0 };
  const skipGlobalMaintenance = options.skipGlobalMaintenance === true;
  const playerBotRuntime = require("./playerBotRuntime");
  const allRosterBots = Array.isArray(options.allBots)
    ? options.allBots
    : (typeof playerBotRuntime.getPlanningRoster === "function"
      ? playerBotRuntime.getPlanningRoster() : playerBotRuntime.listBots());
  let humanCorporations = null;
  let humanControlledBotIDs = null;
  let activeWorkEntries = null;
  let capacityState;
  if (summary.enabled && !skipGlobalMaintenance) {
    const operations = require("./playerBotOperationRuntime");
    try {
      const piRecovery = await operations.reconcileLegacyPIExportReviews();
      summary.recoveredLegacyPIExports = Number(piRecovery.recovered) || 0;
      if (summary.recoveredLegacyPIExports > 0) {
        require("../../utils/logger").warn(
          `[PlayerBots] Recovered ${piRecovery.recovered} legacy PI export(s) and refunded ${Number(piRecovery.refundedISK || 0).toFixed(2)} ISK after verifying exact tax debits and no committed launch records.`,
        );
      }
    } catch (error) {
      require("../../utils/logger").error(
        `[PlayerBots] Legacy PI export recovery failed safely: ${String(error && error.message || error).slice(0, 240)}.`,
      );
    }
    const purchaseRecovery = operations.reconcilePendingUpgradePurchases();
    const recoveredPurchases = {
      confirmed: Number(purchaseRecovery.confirmedPurchases || 0),
      refunded: Number(purchaseRecovery.retriedRefundedPurchases || 0),
      noEffect: Number(purchaseRecovery.retriedNoEffectPurchases || 0),
    };
    if (recoveredPurchases.confirmed + recoveredPurchases.refunded + recoveredPurchases.noEffect > 0) {
      require("../../utils/logger").info(
        `[PlayerBots] Reconciled uncertain ship-upgrade purchases: confirmed=${recoveredPurchases.confirmed}, refunded=${recoveredPurchases.refunded}, safely-retried-no-effect=${recoveredPurchases.noEffect}.`,
      );
    }
    const releasedUpgradeWaiters = operations.deferUnavailableUpgradeWaiters();
    if (releasedUpgradeWaiters > 0) {
      require("../../utils/logger").info(
        `[PlayerBots] Released ${releasedUpgradeWaiters} unavailable ship-upgrade waits so those bots can resume productive work.`,
      );
    }
  }
  if (skipGlobalMaintenance) {
    humanCorporations = onlineHumanCorporationIDs();
    humanControlledBotIDs = BOT_CAPACITY.getHumanControlledBotIDs(allRosterBots);
    activeWorkEntries = listActiveWorkEntries();
    // Keep the hard system cap in force during the lightweight idle-roster
    // assignment pass, but do not run market lookups/retargeting for every
    // existing upgrade package on each coalesced think batch.
    const upgradeMarket = enforceUpgradeMarketArrivalLimit({ skipRetarget: true });
    if (upgradeMarket.queued > 0) activeWorkEntries = listActiveWorkEntries();
    const capacityEntries = getCapacityWorkEntries(activeWorkEntries);
    const capacityTarget = getCapacityTarget(capacityEntries, humanCorporations, humanControlledBotIDs);
    capacityState = {
        active: capacityEntries.length,
        limit: capacityTarget.limit,
        perSystemLimit: BOT_CAPACITY.getMaxAutonomousBotsPerSystem(),
        assignmentLimit: capacityTarget.limit,
        queued: listCapacityPausedWork().length,
        paused: 0,
        upgradeTripsQueued: upgradeMarket.queued,
      };
  } else {
    capacityState = enforceConcurrentWorkLimit();
  }
  summary.active = capacityState.active;
  summary.capacityLimit = capacityState.limit;
  summary.perSystemCapacityLimit = capacityState.perSystemLimit;
  summary.capacityQueued = capacityState.queued;
  summary.pausedForCapacity = capacityState.paused;
  summary.capacityReserveLimit = capacityState.assignmentLimit;
  summary.activeColonySetups = capacityState.colonySetups || 0;
  summary.pausedColonySetups = capacityState.colonySetupsPaused || 0;
  summary.upgradeTripsQueued = capacityState.upgradeTripsQueued || 0;
  summary.upgradeTripsRetargeted = capacityState.upgradeTripsRetargeted || 0;
  // Enforce the no-Jita-selling rule for legacy orders even when new autonomous
  // work is disabled. Those orders can still fill unless the server cancels them.
  try {
    summary.jitaOrdersCancelled = skipGlobalMaintenance
      ? 0
      : await cancelBotOrdersInJita();
  } catch (error) {
    summary.jitaOrdersCancelled = 0;
  }
  const resumedCapacityWork = resumeCapacityQueuedWork({ maxResumes: MAX_CAPACITY_RESUMES_PER_PASS });
  if (resumedCapacityWork.resumed > 0) activeWorkEntries = listActiveWorkEntries();
  summary.active = resumedCapacityWork.active;
  summary.resumedForCapacity = resumedCapacityWork.resumed;
  summary.capacityQueued = resumedCapacityWork.queued;
  if (!summary.enabled) return summary;
  const state = readState();
  const now = Date.now();
  for (const characterID of capacityState.queuedColonyCharacterIDs || []) {
    const entry = { ...getBotDirectorAssignment(characterID) };
    const bot = allRosterBots.find((candidate) => Number(candidate.characterID) === Number(characterID));
    if (bot) {
      queueColonySetupAssignment(
        bot,
        `Waiting for one of ${getMaxConcurrentColonySetups()} planetary setup slots; the unfinished setup was safely paused for capacity.`,
        "colony-setup-limit",
        now,
      );
    } else {
      entry.queuedColonySetup = true;
      entry.queuedReasonCode = "colony-setup-limit";
      entry.queuedReason = `Waiting for one of ${getMaxConcurrentColonySetups()} planetary setup slots.`;
      saveBotDirectorAssignment(characterID, entry);
    }
  }
  summary.queuedColonySetups = getQueuedColonySetupCount();
  if (!humanCorporations) humanCorporations = onlineHumanCorporationIDs();
  if (!humanControlledBotIDs) humanControlledBotIDs = BOT_CAPACITY.getHumanControlledBotIDs(allRosterBots);
  const productiveByCorporation = getProductiveBotCountsByCorporation(humanCorporations, activeWorkEntries || listActiveWorkEntries());
  if (!skipGlobalMaintenance) {
    try {
      const mobilization = await require("./playerBotWarMobilizationRuntime")
        .processFirstWarMobilization({ humanControlledBotIDs });
      summary.firstWarGrants = (mobilization.grants || []).filter((entry) => entry.success).length;
      summary.warShipBudgetsFunded = Number(mobilization.fundedPilots) || 0;
      summary.warPilotsRecruited = Number(mobilization.recruitedPilots) || 0;
      summary.warPilotsCrossTrained = Number(mobilization.mobilizedPilots) || 0;
    } catch (error) {
      require("../../utils/logger").warn(
        `[PlayerBots] First-war mobilization reconciliation will retry: ${String(error && error.message || error).slice(0, 180)}.`,
      );
    }
    try {
      const conflictWar = await require("./playerBotStructureConflictWarRuntime")
        .declareStructureConflictWar(allRosterBots, { humanControlledBotIDs });
      if (conflictWar.declared) {
        summary.structureConflictWarsDeclared = 1;
        require("../../utils/logger").info(
          `[PlayerBots] Declared corporation war ${conflictWar.warID} from bot corporation ${conflictWar.declaringCorporationID} against ${conflictWar.opposingCorporationID} over null-sec structures in system ${conflictWar.systemID}; the normal 24-hour war start timer applies.`,
        );
      }
    } catch (error) {
      require("../../utils/logger").warn(
        `[PlayerBots] Structure-conflict war planning was skipped: ${String(error && error.message || error).slice(0, 180)}.`,
      );
    }
  }
  const botSystemIDs = new Map(allRosterBots.map((bot) => [Number(bot.characterID), BOT_CAPACITY.getBotSystemID(bot)]));
  if (!activeWorkEntries) activeWorkEntries = listActiveWorkEntries();
  const capacityWorkEntries = getCapacityWorkEntries(activeWorkEntries);
  const activeSystemCounts = countActiveEntriesBySystem(capacityWorkEntries, botSystemIDs, humanControlledBotIDs);
  const rosterSystemCounts = applyRelocationReservations(
    countBotRosterBySystem(botSystemIDs, humanControlledBotIDs), activeWorkEntries, botSystemIDs,
  );
  const upgradeIncomingBySystem = countUpgradeMarketArrivals(activeWorkEntries, botSystemIDs, humanControlledBotIDs);
  const jitaStationID = Number(require("./playerBotEconomyRuntime").JITA_BUY_STATION_ID) || 0;
  const jitaSystemID = stationSystemID(jitaStationID);
  const colonyIncomingBySystem = countColonyMarketArrivals(
    activeWorkEntries, botSystemIDs, jitaSystemID, humanControlledBotIDs,
  );
  const miningIncomingBySystem = countMiningArrivals(
    listActiveWorkEntries(), botSystemIDs, humanControlledBotIDs,
  );
  let activeRelocations = countActiveCapacityRelocations(activeWorkEntries);
  let activeColonySetups = activeWorkEntries.filter((entry) =>
    entry.source === "operation" && entry.kind === "colony").length;
  summary.activeRelocations = activeRelocations;
  const operationRuntime = require("./playerBotOperationRuntime");
  const capsuleCandidates = allRosterBots.map((bot) => {
    if (!bot || bot.status === "paused" || bot.autonomyPaused === true ||
        humanControlledBotIDs.has(Number(bot.characterID))) return null;
    const character = readSharedCharacterRecord(bot.characterID) || {};
    if (Number(character.shipTypeID) !== 670) return null;
    const current = operationRuntime.getOperation(bot.characterID);
    return {
      bot,
      hasActiveSlot: Boolean(current && ["active", "holding"].includes(current.status)),
      lastAssignedAt: Number(getBotDirectorAssignment(bot.characterID).lastAssignedAt) || 0,
    };
  }).filter(Boolean).sort((left, right) => Number(left.hasActiveSlot) - Number(right.hasActiveSlot) ||
    left.lastAssignedAt - right.lastAssignedAt);
  const capsuleRecoveryBatch = processCapsuleRecoveryCandidates(capsuleCandidates, {
    maximumStarts: MAX_CAPSULE_RECOVERIES_PER_PASS,
    canStart: (candidate) => candidate.hasActiveSlot || summary.active < capacityState.assignmentLimit,
    startRecovery: (candidate) => operationRuntime.startCapsuleRecovery(candidate.bot.characterName, { autonomous: true }),
    onStarted: (candidate, recovery) => {
      const { bot, hasActiveSlot } = candidate;
      const entry = { ...getBotDirectorAssignment(bot.characterID) };
      entry.lastAssignedAt = now;
      entry.lastAssignment = "capsule-recovery";
      entry.lastMessage = String(recovery.message || "Capsule recovery started.").slice(0, 240);
      entry.cooldownUntil = 0;
      saveBotDirectorAssignment(bot.characterID, entry);
      summary.assigned += 1;
      summary.upgrade += 1;
      summary.capsuleRecoveries += 1;
      if (!hasActiveSlot) summary.active += 1;
    },
  });
  summary.capsuleRecoveryAttempts = capsuleRecoveryBatch.attempts;
  for (const bot of bots) {
    if (!bot || bot.status === "paused" || bot.autonomyPaused === true) continue;
    const operation = operationRuntime.getOperation(bot.characterID);
    if (!operation || operation.kind !== "colony" || operation.status !== "review" ||
        operation.stage !== "planting" || operation.pending ||
        Number(operation.automaticRecoveryCount || 0) >= 1 ||
        !String(operation.lastError || "").includes("CannotCreatePinWrongPlanetType") ||
        require("../planet/planetRuntimeStore").getColony(operation.planetID, bot.characterID)) continue;
    const recovery = operationRuntime.startColony(bot.characterName);
    const entry = { ...getBotDirectorAssignment(bot.characterID) };
    entry.lastAssignedAt = now;
    entry.lastAssignment = "colony";
    entry.lastMessage = String(recovery.message || "").slice(0, 240);
    saveBotDirectorAssignment(bot.characterID, entry);
    if (recovery.success) {
      summary.assigned += 1;
      summary.active += 1;
      summary.colony += 1;
      summary.recoveredColonyReviews += 1;
    } else {
      summary.failures += 1;
    }
  }

  // A Quantum Core carrier or structure caretaker should handle urgent
  // corporation infrastructure before routine hauling or PI work. Only
  // interrupt a reversible operation while the pilot is docked; pending
  // authority actions, combat, and accepted contracts keep their safe path.
  const structureRuntime = require("./playerBotStructureRuntime");
  for (const bot of bots) {
    if (!bot || humanControlledBotIDs.has(Number(bot.characterID))) continue;
    const operation = operationRuntime.getOperation(bot.characterID);
    if (!operation) continue;
    const character = readSharedCharacterRecord(bot.characterID) || {};
    if (!canYieldDockedWorkForCoreInstall(operation, character)) continue;
    const corePlan = findCoreInstallPlan(structureRuntime, bot);
    const maintenancePlan = corePlan ? null : structureRuntime.findStructureMaintenancePlan(bot);
    const maintenanceAssignment = chooseStructureMaintenanceAssignment(
      bot, maintenancePlan, operationRuntime,
    );
    if (!corePlan && !maintenanceAssignment) continue;
    const stopped = operationRuntime.stopOperation(bot.characterName);
    if (stopped.success) {
      summary.active = Math.max(0, summary.active - 1);
      require("../../utils/logger").info(
        corePlan
          ? `[PlayerBots] Prioritized Quantum Core ${corePlan.coreItemID} for structure ${corePlan.structureID}; ` +
            `safely stopped docked ${operation.kind} work for ${bot.characterName}.`
          : `[PlayerBots] Prioritized ${maintenanceAssignment.kind === "upgrade" ? "a logistics hull upgrade for" : "power and fuel maintenance at"} ` +
            `structure ${maintenancePlan.structureID}; safely stopped docked ${operation.kind} work for ${bot.characterName}.`,
      );
    }
  }
  const candidates = bots
    .filter((bot) => bot && bot.status !== "paused" && bot.autonomyPaused !== true)
    // A parked actor can have no scene attachment while its persisted pilot
    // location is still in space. It can be attached again when new work begins.
    .filter(canStartWorkFromCurrentLocation)
    .filter((bot) => Number((readSharedCharacterRecord(bot.characterID) || {}).shipTypeID) !== 670)
    .filter((bot) => !isBusy(bot.characterID))
    .filter((bot) => {
      const assignment = getBotDirectorAssignment(bot.characterID);
      const cycle = require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID);
      if (Number(assignment.cooldownUntil || 0) > now &&
          ((shouldResetLegacyWarSpecialtyCooldown(bot, assignment) &&
            operationRuntime.hasRoleShipFit(bot, "security")) ||
           shouldResetStaleNoWorkCooldown(bot, assignment, cycle))) {
        // Failures caused by a missing combat target or by the old review-cycle
        // sell guard must not park the pilot for an hour. The assignment path
        // below selects another runnable job before the pilot is marked busy.
        assignment.cooldownUntil = 0;
        assignment.lastMessage = "Released a stale cooldown so the director can assign another runnable job.";
        saveBotDirectorAssignment(bot.characterID, assignment);
      }
      return Number(assignment.cooldownUntil || 0) <= now;
    })
    .sort((left, right) => {
      const leftCorp = Number((readSharedCharacterRecord(left.characterID) || {}).corporationID || left.corporationID) || 0;
      const rightCorp = Number((readSharedCharacterRecord(right.characterID) || {}).corporationID || right.corporationID) || 0;
      const leftPriority = humanCorporations.has(leftCorp) &&
        Number(productiveByCorporation.get(leftCorp) || 0) < MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP ? 0 : 1;
      const rightPriority = humanCorporations.has(rightCorp) &&
        Number(productiveByCorporation.get(rightCorp) || 0) < MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP ? 0 : 1;
      const leftCharacterID = Number(left.characterID);
      const rightCharacterID = Number(right.characterID);
      const leftSystem = botSystemIDs.get(leftCharacterID) || 0;
      const rightSystem = botSystemIDs.get(rightCharacterID) || 0;
      const leftLoad = humanControlledBotIDs.has(leftCharacterID)
        ? -1 : leftSystem ? activeSystemCounts.get(leftSystem) || 0 : Number.MAX_SAFE_INTEGER;
      const rightLoad = humanControlledBotIDs.has(rightCharacterID)
        ? -1 : rightSystem ? activeSystemCounts.get(rightSystem) || 0 : Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority ||
        leftLoad - rightLoad ||
        Number(getBotDirectorAssignment(left.characterID).lastAssignedAt || 0) -
        Number(getBotDirectorAssignment(right.characterID).lastAssignedAt || 0);
    });

  const autonomy = require("./playerBotAutonomyRuntime");
  let assignmentAttempts = 0;
  for (const bot of candidates) {
    if (assignmentAttempts >= MAX_DIRECTOR_ASSIGNMENT_ATTEMPTS_PER_PASS) break;
    const corporationID = Number((readSharedCharacterRecord(bot.characterID) || {}).corporationID || bot.corporationID) || 0;
    const hasHuman = humanCorporations.has(corporationID);
    const needsMinimumProductiveWork = hasHuman &&
      Number(productiveByCorporation.get(corporationID) || 0) < MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP;
    const systemID = botSystemIDs.get(Number(bot.characterID)) || 0;
    const autonomousSystemLimit = BOT_CAPACITY.getMaxAutonomousBotsPerSystem();
    const humanControlled = humanControlledBotIDs.has(Number(bot.characterID));
    const residentCount = systemID ? rosterSystemCounts.get(systemID) || 0 : 0;
    const overSystemLimit = Boolean(systemID && residentCount > autonomousSystemLimit && !humanControlled);
    const escortAssignment = humanControlled ? null : chooseMiningEscortAssignment(bot);
    const coreInstallPlan = escortAssignment ? null : findCoreInstallPlan(structureRuntime, bot);
    const rawStructureMaintenancePlan = escortAssignment || coreInstallPlan ? null :
      structureRuntime.findStructureMaintenancePlan(bot);
    const structureMaintenanceAssignment = chooseStructureMaintenanceAssignment(
      bot, rawStructureMaintenancePlan, operationRuntime,
    );
    const structureMaintenancePlan = structureMaintenanceAssignment?.kind === "structure-service-provision"
      ? structureMaintenanceAssignment.plan
      : rawStructureMaintenancePlan;
    if (shouldDeferHumanCorporationBot({
      hasHuman,
      needsMinimumProductiveWork,
      overSystemLimit,
      escortAssignment,
      coreInstallPlan,
      structureMaintenancePlan,
    })) continue;
    // A live belt-rat request has priority over new market work so a fitted
    // security pilot can respond as soon as its current operation completes.
    // Collect existing PI launches before they expire; otherwise serve player orders first.
    const hasLaunch = escortAssignment || coreInstallPlan ? false : operationRuntime.nextPlanetaryLaunch(bot);
    const courier = escortAssignment || coreInstallPlan || hasLaunch ? null : require("./playerBotAllianceLogisticsRuntime").findAssignedCourier(bot);
    const industryCycleReview = bot.specialty === "industry" &&
      industryCycleNeedsManualReview(require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID));
    let order = escortAssignment || coreInstallPlan || hasLaunch || courier ? null : nextPlayerOrder(state, bot);
    let assignment = escortAssignment || (coreInstallPlan
      ? { kind: "structure-core-install", plan: coreInstallPlan }
      : structureMaintenanceAssignment
      ? structureMaintenanceAssignment
      : hasLaunch
      ? { kind: "pi-collect" }
      : courier
        ? { kind: "alliance-courier", contractID: Number(courier.contract.contractID) }
        : order ? chooseOrderAssignment(bot, order) : null);
    let industryReviewFallback = false;
    if (industryCycleReview && assignment && assignment.kind === "order-build") {
      // Preserve the unresolved cycle and leave this order unclaimed so a
      // different industry pilot can build it; this pilot gets other work.
      assignment = null;
      order = null;
    }
    if (industryCycleReview && !escortAssignment && !coreInstallPlan && !hasLaunch && !courier) {
      // Keep the financial review record immutable, while routing the pilot to
      // separate mining work or the mining-hull ladder. Industry cycles remain
      // guarded against replacement and ambiguous market actions are not retried.
      order = null;
      assignment = chooseIndustryReviewFallback(bot, { skipColony: true });
      industryReviewFallback = Boolean(assignment && ["mine", "upgrade"].includes(assignment.kind));
    }
    if (order && !assignment) {
      state.skippedOrders[String(order.order_id)] = now;
      order = null;
    } else if (order) assignment = { ...assignment, order };
    if (assignment && assignment.kind === "order-courier" && !(await courierPays(bot, order))) {
      state.skippedOrders[String(order.order_id)] = now;
      order = null;
      assignment = null;
    }
    let queuedColonySetup = getBotDirectorAssignment(bot.characterID).queuedColonySetup === true;
    if (queuedColonySetup && !needsColonySetup(bot)) {
      clearColonySetupAssignment(bot.characterID);
      queuedColonySetup = false;
    }
    if (!assignment && shouldResumeQueuedColonySetup(queuedColonySetup, activeColonySetups)) {
      assignment = { kind: "colony" };
    }
    if (!assignment) assignment = chooseAssignment(bot, {
      prioritizeProductiveWork: needsMinimumProductiveWork,
      skipColony: !canResumeColonySetup(activeColonySetups),
      allowTerritorialMining: true,
    });
    const colonySetupLimit = getMaxConcurrentColonySetups();
    let colonyMarketCapacityBlocked = null;
    let upgradeMarketCapacityBlocked = null;
    if (assignment && assignment.kind === "colony" && !canResumeColonySetup(activeColonySetups, colonySetupLimit)) {
      queueColonySetupAssignment(
        bot,
        `Waiting for one of ${colonySetupLimit} planetary setup slots; ${activeColonySetups} are in progress.`,
        "colony-setup-limit",
        now,
      );
      assignment = chooseAssignment(bot, {
        prioritizeProductiveWork: needsMinimumProductiveWork,
        skipColony: true,
        allowTerritorialMining: true,
      });
    }
    if (assignment && assignment.kind === "mine" &&
        !operationRuntime.hasRoleShipFit(bot, "mining")) {
      assignment = chooseMiningAssignment(bot, {
        prioritizeProductiveWork: needsMinimumProductiveWork,
        skipColony: !canResumeColonySetup(activeColonySetups),
      });
      if (!assignment) continue;
    }
    let reservedTerritorialMiningSystemID = 0;
    if (assignment && assignment.kind === "mine" && assignment.territorialBase && !humanControlled) {
      const destinationSystemID = Number(assignment.territorialBase.systemID) ||
        stationSystemID(assignment.territorialBase.stationID);
      if (destinationSystemID && destinationSystemID !== systemID) {
        const residents = Number(rosterSystemCounts.get(destinationSystemID)) || 0;
        const arrivals = Number(miningIncomingBySystem.get(destinationSystemID)) || 0;
        if (!canReserveSystemArrival(residents, arrivals, autonomousSystemLimit)) {
          assignment = chooseAssignment(bot, {
            prioritizeProductiveWork: needsMinimumProductiveWork,
            skipColony: !canResumeColonySetup(activeColonySetups),
            allowTerritorialMining: true,
            skipTerritorialMining: true,
          });
        } else {
          reservedTerritorialMiningSystemID = destinationSystemID;
        }
      }
    }
    let reservedColonyDestinationSystemID = 0;
    if (assignment && assignment.kind === "colony" && !humanControlled &&
        jitaSystemID && jitaSystemID !== systemID) {
      const residents = Number(rosterSystemCounts.get(jitaSystemID)) || 0;
      const upgradeArrivals = Number(upgradeIncomingBySystem.get(jitaSystemID)) || 0;
      const colonyArrivals = Number(colonyIncomingBySystem.get(jitaSystemID)) || 0;
      const miningArrivals = Number(miningIncomingBySystem.get(jitaSystemID)) || 0;
      const arrivals = upgradeArrivals + colonyArrivals + miningArrivals;
      if (!canReserveSystemArrival(residents, arrivals, autonomousSystemLimit)) {
        colonyMarketCapacityBlocked = { systemID: jitaSystemID, residents, arrivals };
        queueColonySetupAssignment(
          bot,
          `Waiting for Jita system ${jitaSystemID} to free a slot (${residents} residents, ${arrivals} inbound; limit ${autonomousSystemLimit}).`,
          "jita-market-capacity",
          now,
        );
        assignment = chooseAssignment(bot, {
          prioritizeProductiveWork: needsMinimumProductiveWork,
          skipColony: true,
          allowTerritorialMining: true,
        });
      } else {
        reservedColonyDestinationSystemID = jitaSystemID;
      }
    }
    let reservedUpgradeDestinationSystemID = 0;
    if (assignment && assignment.kind === "upgrade" && !humanControlled) {
      const destinationSystemID = stationSystemID(assignment.marketStationID);
      if (destinationSystemID && destinationSystemID !== systemID) {
        const residents = Number(rosterSystemCounts.get(destinationSystemID)) || 0;
        const arrivals = Number(upgradeIncomingBySystem.get(destinationSystemID)) || 0;
        if (!canReserveSystemArrival(residents, arrivals, autonomousSystemLimit)) {
          upgradeMarketCapacityBlocked = { systemID: destinationSystemID, residents, arrivals };
          assignment = chooseAssignment(bot, {
            prioritizeProductiveWork: needsMinimumProductiveWork,
            skipColony: true,
            skipUpgrade: true,
          });
        } else {
          reservedUpgradeDestinationSystemID = destinationSystemID;
        }
      }
    }
    const desiredAssignment = choosePostCapacityAssignment(
      assignment,
      residentCount,
      autonomousSystemLimit,
      humanControlled,
      () => findRelocationStation(bot, rosterSystemCounts, { limit: autonomousSystemLimit }),
      needsMinimumProductiveWork,
    );
    if (desiredAssignment) assignment = desiredAssignment;
    else {
      if (!assignment && needsColonySetup(bot)) {
        const limit = getMaxConcurrentColonySetups();
        const reason = colonyMarketCapacityBlocked
          ? `Waiting for Jita system ${colonyMarketCapacityBlocked.systemID} capacity (${colonyMarketCapacityBlocked.residents} residents, ${colonyMarketCapacityBlocked.arrivals} inbound; limit ${autonomousSystemLimit}).`
          : upgradeMarketCapacityBlocked
            ? `Waiting for market system ${upgradeMarketCapacityBlocked.systemID} capacity (${upgradeMarketCapacityBlocked.residents} residents, ${upgradeMarketCapacityBlocked.arrivals} inbound; limit ${autonomousSystemLimit}); planetary setup is queued for the next available slot (${activeColonySetups}/${limit}).`
            : `Waiting for one of ${limit} planetary setup slots; ${activeColonySetups} are in progress.`;
        queueColonySetupAssignment(
          bot,
          reason,
          colonyMarketCapacityBlocked ? "jita-market-capacity" : "colony-setup-limit",
          now,
        );
      }
      continue;
    }
    if (!canAssignAtCapacity({
      active: summary.active,
      limit: summary.capacityLimit,
      needsMinimumProductiveWork,
      assignmentKind: assignment.kind,
      structureMaintenance: assignment.structureMaintenanceUpgrade === true ||
        (assignment.kind === "structure-service-provision" && assignment.plan?.purpose === "maintenance"),
      overSystemLimit,
      humanControlled,
      activeRelocations,
    })) continue;
    assignmentAttempts += 1;
    let result = assignment.kind === "order-courier"
      ? require("./playerBotOperationRuntime").startFulfill(bot.characterName, assignment.order)
      : assignment.kind === "order-build"
        ? require("./playerBotIndustryCycleRuntime").startCycle(
          bot.characterName,
          assignment.blueprintTypeID,
          assignment.runs,
          Math.min(INDUSTRY_MAX_SPEND, Math.floor((Number(getCharacterWallet(bot.characterID)?.balance) || 0) * INDUSTRY_SPEND_SHARE)),
          {
            stationID: assignment.stationID || null,
            deliverTo: {
              orderID: assignment.order.order_id,
              stationID: assignment.order.station_id,
              price: assignment.order.price,
              maxUnits: Number(assignment.order.vol_remaining) || assignment.runs,
            },
          },
        )
      : assignment.kind === "alliance-courier"
      ? require("./playerBotAllianceLogisticsRuntime").start(
        bot.characterName, assignment.contractID, { autonomous: true },
      )
      : assignment.kind === "structure-deployment"
      ? require("./playerBotOperationRuntime").startStructureDeployment(
        bot.characterName, assignment.itemID, null, { autonomous: true },
      )
      : assignment.kind === "structure-procurement"
      ? require("./playerBotOperationRuntime").startStructureProcurement(
        bot.characterName, assignment.plan, { autonomous: true },
      )
      : assignment.kind === "structure-core-install"
      ? require("./playerBotOperationRuntime").startStructureCoreInstall(
        bot.characterName, assignment.plan, { autonomous: true },
      )
      : assignment.kind === "structure-service-provision"
      ? require("./playerBotOperationRuntime").startStructureServiceProvision(
        bot.characterName, assignment.plan, { autonomous: true },
      )
      : assignment.kind === "alliance-founding"
      ? require("./playerBotOperationRuntime").startAllianceFounding(
        bot.characterName, { autonomous: true },
      )
      : assignment.kind === "pi-collect"
      ? require("./playerBotOperationRuntime").startPlanetaryCollection(bot.characterName)
      : assignment.kind === "colony"
      ? require("./playerBotOperationRuntime").startColony(bot.characterName)
      : assignment.kind === "sell"
      ? assignment.corporateListing
        ? require("./playerBotIndustryCycleRuntime").startExpiredCorporateResale(bot.characterName)
        : require("./playerBotOperationRuntime").startSell(bot.characterName, MARKET_STATION_ID, assignment.originStationID, { optimizeMarketDestination: true })
      : assignment.kind === "upgrade"
      ? require("./playerBotOperationRuntime").startShipUpgrade(bot.characterName,
        assignment.role || (["security", "piracy", "sovereignty"].includes(bot.specialty) ? bot.specialty : "mining"),
        { autonomous: true, marketStationID: assignment.marketStationID,
          ...(industryReviewFallback ? { industryReviewFallback: true } : {}),
          ...(assignment.warMobilizationSupportID ? {
            maxSpend: assignment.maxSpend,
            warMobilizationSupportID: assignment.warMobilizationSupportID,
          } : {}) })
      : assignment.kind === "combat"
      ? require("./playerBotOperationRuntime").startCombat(bot.characterName, assignment.mode, {
        autonomous: true,
        ...(Number(assignment.miningEscortForCharacterID) > 0
          ? { miningEscortForCharacterID: Number(assignment.miningEscortForCharacterID) }
          : {}),
      })
      : assignment.kind === "sovereignty"
      ? require("./playerBotSovereigntyRuntime").startOperation(bot.characterName, assignment.objective, { autonomous: true })
      : assignment.kind === "relocate"
      ? operationRuntime.startRelocation(bot.characterName, assignment.stationID)
      : assignment.kind === "mine" && assignment.territorialBase
      ? operationRuntime.startMining(bot.characterName, MINING_TRIPS_PER_ASSIGNMENT, {
        autonomous: true,
        ...(industryReviewFallback ? { industryReviewFallback: true } : {}),
        stationID: Number(assignment.territorialBase.stationID),
        marketStationID: MARKET_STATION_ID,
        optimizeMarketDestination: true,
        territorialOperation: true,
      })
      : assignment.kind === "industry"
      ? require("./playerBotIndustryCycleRuntime").startCycle(
        bot.characterName,
        AUTO_PRODUCT,
        assignment.runs,
        assignment.maxSpend,
        { stationID: assignment.facilityID || null },
      )
      : require("./playerBotOperationRuntime").startMining(bot.characterName, MINING_TRIPS_PER_ASSIGNMENT, {
        autonomous: true,
        ...(industryReviewFallback ? { industryReviewFallback: true } : {}),
      });
    let combatFallbackFailed = false;
    if (assignment.kind === "combat" && isCombatOpportunityUnavailable(result)) {
      const combatUnavailableMessage = String(result.message || "no patrol site was available");
      // No nearby patrol target is a lack of opportunity, not a reason to
      // leave the pilot idle. Preserve the combat hull and assign the normal
      // mining ladder (or mining itself) using the pilot's own wallet.
      const fallback = chooseCombatOpportunityFallback(bot, result, {
        allowTerritorialMining: true,
      });
      if (fallback && fallback.kind === "mine") {
        result = fallback.territorialBase
          ? operationRuntime.startMining(bot.characterName, MINING_TRIPS_PER_ASSIGNMENT, {
            autonomous: true,
            stationID: Number(fallback.territorialBase.stationID),
            marketStationID: MARKET_STATION_ID,
            optimizeMarketDestination: true,
            territorialOperation: true,
          })
          : operationRuntime.startMining(bot.characterName, MINING_TRIPS_PER_ASSIGNMENT, { autonomous: true });
      } else if (fallback && fallback.kind === "upgrade") {
        result = operationRuntime.startShipUpgrade(bot.characterName, "mining", {
          autonomous: true,
          marketStationID: fallback.marketStationID,
        });
      }
      if (fallback && result && result.success) {
        assignment = fallback;
        require("../../utils/logger").info(
          `[PlayerBots] Combat target unavailable for ${bot.characterName}; assigned ${fallback.kind} work instead.`,
        );
      } else {
        combatFallbackFailed = true;
        if (fallback && result && result.success === false) {
          result = {
            ...result,
            message: `Combat target unavailable (${combatUnavailableMessage}); fallback ${fallback.kind} failed: ${String(result.message || "unknown error")}`,
          };
        }
      }
    }
    const entry = { ...getBotDirectorAssignment(bot.characterID) };
    entry.lastAssignedAt = now;
    entry.lastAssignment = assignment.kind;
    entry.lastMessage = String(result.message || "").slice(0, 240);
    if (result.success && assignment.order) {
      state.claims[String(assignment.order.order_id)] = { characterID: Number(bot.characterID), at: now, kind: assignment.kind };
    }
    if (!result.success) {
      entry.cooldownUntil = now + (combatFallbackFailed ? 60_000 : FAILURE_COOLDOWN_MS);
      summary.failures += 1;
    } else {
      entry.cooldownUntil = 0;
      if (assignment.kind === "colony") {
        entry.queuedColonySetup = false;
        delete entry.queuedAt;
        delete entry.queuedReason;
        delete entry.queuedReasonCode;
      }
      summary.assigned += 1;
      if (assignment.kind === "relocate") activeRelocations += 1;
      else summary.active += 1;
      if (assignment.kind === "colony") activeColonySetups += 1;
      if (assignment.kind === "colony" && reservedColonyDestinationSystemID) {
        colonyIncomingBySystem.set(
          reservedColonyDestinationSystemID,
          (Number(colonyIncomingBySystem.get(reservedColonyDestinationSystemID)) || 0) + 1,
        );
      }
      if (assignment.kind === "upgrade" && reservedUpgradeDestinationSystemID) {
        upgradeIncomingBySystem.set(
          reservedUpgradeDestinationSystemID,
          (Number(upgradeIncomingBySystem.get(reservedUpgradeDestinationSystemID)) || 0) + 1,
        );
      }
      if (reservedTerritorialMiningSystemID && assignment.kind === "mine" && assignment.territorialBase) {
        miningIncomingBySystem.set(reservedTerritorialMiningSystemID,
          (Number(miningIncomingBySystem.get(reservedTerritorialMiningSystemID)) || 0) + 1);
      }
      summary[assignment.kind] = (summary[assignment.kind] || 0) + 1;
      const systemID = botSystemIDs.get(Number(bot.characterID)) || 0;
      if (systemID && !humanControlledBotIDs.has(Number(bot.characterID))) {
        activeSystemCounts.set(systemID, (activeSystemCounts.get(systemID) || 0) + 1);
      }
      if (assignment.kind === "relocate" && systemID && !humanControlled) {
        rosterSystemCounts.set(systemID, Math.max(0, (rosterSystemCounts.get(systemID) || 0) - 1));
        const destination = require("../../space/worldData").getStationByID(assignment.stationID);
        const destinationSystemID = Number(destination && destination.solarSystemID) || 0;
        if (destinationSystemID) rosterSystemCounts.set(destinationSystemID,
          (rosterSystemCounts.get(destinationSystemID) || 0) + 1);
      }
      if (hasHuman && isProductiveAssignment(assignment)) {
        productiveByCorporation.set(
          corporationID,
          Number(productiveByCorporation.get(corporationID) || 0) + 1,
        );
      }
      await autonomy.ensureIndustryCycleStep(bot.characterID);
    }
    saveBotDirectorAssignment(bot.characterID, entry);
  }
  summary.assignmentAttempts = assignmentAttempts;
  summary.assignmentAttemptLimit = MAX_DIRECTOR_ASSIGNMENT_ATTEMPTS_PER_PASS;
  summary.queuedColonySetups = getQueuedColonySetupCount();
  summary.activeRelocations = activeRelocations;
  state.lastRunAt = new Date(now).toISOString();
  state.lastSummary = summary;
  saveState(state);
  return summary;
}

function queueDirectorRun(run) {
  const queued = directorRunQueue.then(run);
  directorRunQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

async function runDirector(bots = [], options = {}) {
  return queueDirectorRun(() => runDirectorInternal(bots, options));
}

async function ensureMinimumProductiveWork(corporationID) {
  const numericCorporationID = Number(corporationID) || 0;
  let release;
  const previous = minimumProductiveWorkQueue;
  minimumProductiveWorkQueue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    if (!numericCorporationID || !onlineHumanCorporationIDs().has(numericCorporationID)) {
      return { success: false, productiveBots: 0, assigned: 0 };
    }
    await directorRunQueue.catch(() => null);
    const productiveBots = countProductiveBots(numericCorporationID);
    if (productiveBots >= MIN_PRODUCTIVE_BOTS_PER_HUMAN_CORP) {
      return { success: true, productiveBots, assigned: 0 };
    }
    const bots = require("./playerBotRuntime").listBots().filter((bot) =>
      Number(bot.corporationID) === numericCorporationID,
    );
    const summary = await runDirector(bots, { skipGlobalMaintenance: true });
    return {
      success: true,
      productiveBots: countProductiveBots(numericCorporationID),
      assigned: Number(summary.assigned) || 0,
    };
  } finally {
    release();
  }
}

function formatDirectorStatus() {
  const state = readState();
  const summary = state.lastSummary || {};
  const warMobilization = require("./playerBotWarMobilizationRuntime").getStatusSummary();
  return `Autonomous work: ${isEnabled() ? "enabled" : "disabled"}; ` +
    `${countActive()}/${getMaxConcurrentWork()} active, ${countActiveCapacityRelocations()}/${getMaxConcurrentCapacityRelocations()} capacity relocations, ` +
    `${summary.activeColonySetups || 0}/${getMaxConcurrentColonySetups()} colony setups active, ` +
    `${summary.queuedColonySetups || 0} PI queued; ${summary.upgradeTripsQueued || 0} market trips queued, ` +
    `${listCapacityPausedWork().length} capacity-queued. ` +
    `Last assignment ${state.lastRunAt || "never"}: ${summary.assigned || 0} new ` +
    `(${summary.mine || 0} mining, ${summary.industry || 0} industry, ${summary.upgrade || 0} ship upgrades, ` +
    `${summary.sell || 0} sales, ${(summary["order-courier"] || 0) + (summary["order-build"] || 0)} player orders, ` +
    `${summary["alliance-courier"] || 0} alliance deliveries, ${summary.combat || 0} combat, ` +
    `${summary.sovereignty || 0} sovereignty, ${summary.relocate || 0} relocations), ` +
    `${summary["structure-procurement"] || 0} structure purchases, ${summary["structure-deployment"] || 0} structure deployments, ` +
    `${summary["structure-core-install"] || 0} Quantum Cores installed, ` +
    `${summary["structure-service-provision"] || 0} structure services provisioned, ` +
    `${summary.structureConflictWarsDeclared || 0} null-sec structure-conflict wars declared, ` +
    `${warMobilization.activeWarCount} mobilized wars active, ${warMobilization.grants} first-war grants, ` +
    `${warMobilization.fundedPilots} war ship budgets funded, ${warMobilization.pendingGrants} grant transfers pending, ` +
    `${warMobilization.recruitedPilots} security pilots recruited, ${warMobilization.mobilizedPilots} in-corp pilots mobilized ` +
    `(${warMobilization.trainingWarPilots} training), ${warMobilization.pendingStipends} ship stipends and ` +
    `${warMobilization.pendingRecruitments} recruitments pending, ` +
    `${summary.failures || 0} rejected.`;
}

function formatPlayerOrders() {
  const economy = require("./playerBotEconomyRuntime");
  const state = readState();
  const bots = require("./playerBotRuntime").listBots();
  const orders = economy.listPlayerBuyOrders(20);
  if (!orders.length) return "No player buy orders outside Jita. Place one at any station and a bot will check it on the next 5-minute cycle.";
  return ["Player buy orders handled by bots:", ...orders.map((order) => {
    const claim = (state.claims || {})[String(order.order_id)];
    const bot = claim && bots.find((entry) => Number(entry.characterID) === Number(claim.characterID));
    const skipped = (state.skippedOrders || {})[String(order.order_id)];
    const status = bot
      ? `${claim.kind === "order-build" ? "building" : "hauling from Jita"}: ${bot.characterName}`
      : skipped && Date.now() - Number(skipped) < 60 * 60 * 1000
        ? "waiting: Jita sells it above your price"
        : "unassigned";
    return `Order ${order.order_id}: ${order.vol_remaining}× type ${order.type_id} at ${Number(order.price).toFixed(2)} ISK in ${order.station_id} — ${status}`;
  })].join("\n");
}

module.exports = {
  _testing: { industryCoolingDown, marketOrderCapacityCoolingDown, upgradeCoolingDown, combatCoolingDown, countProductiveBots, onlineHumanCorporationIDs,
    chooseAssignment, chooseMiningAssignment, isFiniteDestinationWork, countBotRosterBySystem, applyRelocationReservations,
    chooseStructureMaintenanceAssignment,
    choosePostCapacityAssignment, findRelocationStation, selectWorkToPause, getCapacityWorkEntries,
    countActiveCapacityRelocations, canAssignAtCapacity, shouldDeferHumanCorporationBot,
    canResumeColonySetup, shouldResumeQueuedColonySetup,
    canReserveSystemArrival, shouldQueueUpgradeForMarketCapacity, shouldRetargetUpgradeMarket,
    countUpgradeMarketArrivals,
    enforceUpgradeMarketArrivalLimit,
    countMiningArrivals, countColonyMarketArrivals, needsColonySetup, queueColonySetupAssignment,
    enforceConcurrentWorkLimit,
    isColonySetupEntry, countActiveColonySetups, selectExcessColonySetups, canStartWorkFromCurrentLocation,
    getMaxConcurrentWork, queueDirectorRun, courierPays, isBusy, resumeCapacityQueuedWork,
    processCapsuleRecoveryCandidates, shouldResetLegacyWarSpecialtyCooldown,
    shouldResetStaleNoWorkCooldown, isCombatOpportunityUnavailable,
    chooseCombatOpportunityFallback, chooseIndustryReviewFallback,
    industryCycleNeedsManualReview,
    maxCapacityResumesPerPass: MAX_CAPACITY_RESUMES_PER_PASS,
    maxDirectorAssignmentAttemptsPerPass: MAX_DIRECTOR_ASSIGNMENT_ATTEMPTS_PER_PASS },
  formatDirectorStatus,
  formatPlayerOrders,
  countProductiveBots,
  enforceConcurrentWorkLimit,
  ensureMinimumProductiveWork,
  getMaxConcurrentWork,
  getMaxConcurrentCapacityRelocations,
  getMaxConcurrentColonySetups,
  getBotDirectorAssignment,
  getQueuedColonySetupCount,
  listQueuedColonySetupAssignments,
  hasActiveWork,
  isEnabled,
  runDirector,
  setEnabled,
};

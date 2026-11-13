"use strict";

// Durable per-bot operations other than the industry production cycle:
// hauling between stations and mining (with optional reprocessing). Each
// operation is a small state machine advanced by the shared playerbot step
// job; every step goes through the route, docking, inventory, dogma, mining
// and reprocessing authorities. Progress is persisted before each action so a
// restart resumes instead of repeating it.

const { createTableRepository } = require("../../gameStore/tableRepository");
const { getCharacterRecord } = require("../character/characterState");
const worldData = require("../../space/worldData");

const TABLE = "playerBots";
const OPERATIONS_PATH = "/_operations";
const OPERATION_RECORD_PREFIX = "_playerBotOperation_";
const EMPTY_OPERATION_MAP = Object.freeze({});
const OPERATION_HISTORY_TABLE = "playerBotOperationHistory";
// Keep a short yield for human clients while avoiding long artificial pauses
// between durable actions across the 100-pilot roster.
const STEP_DELAY_MS = 5_000;
const TRAVEL_DELAY_MS = 5_000;
// Basic Miner I modules cycle every 15 seconds. Polling faster cannot finish
// that cycle sooner and multiplies overdue jobs across the active miner fleet.
const MINING_POLL_MS = 15_000;
const MINING_RAT_SCAN_PERSIST_MS = 15_000;
const WAIT_DELAY_MS = 5 * 60 * 1000;
const DOCK_WARP_RANGE_METERS = 50_000;
const MINING_APPROACH_METERS = 5_000;
const MAX_HISTORY = 25;
const MAX_TRIPS = 20;
const DEFAULT_MINING_TRIP_MS = 15 * 60 * 1000;
const UPGRADE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const LEGACY_PI_EXPORT_RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Bots sell at their own hub, never in Jita (see playerBotEconomyRuntime).
const DEFAULT_MARKET_STATION_ID = require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID;
const LIST_UNDERCUT = 0.98;
const BELT_DANGER_MS = 30 * 60 * 1000;
const MINING_ESCORT_DISPATCH_RANGE_METERS = 250_000;
const MINING_ESCORT_MAX_RESPONSE_WAIT_MS = 45_000;
const SELL_TO_BID_RATIO = 0.9;
const ACTIVE_STATUSES = new Set(["active", "holding"]);
const repo = createTableRepository("service:playerbots", { strict: true });
const runningBots = new Set();
const interruptions = require("./playerBotInterruptRuntime");
const executionOwners = new Map();

function queueInterruption(characterID, intent) {
  if (interruptions.isApplying(characterID)) return false;
  interruptions.request(characterID, intent);
  // The independent intent is durable before stopping any existing lasers.
  const bot = resolveBotByID(characterID);
  if (bot && intent.kind === "mining") getSpace().stopMining(bot);
  drainInterruptions(characterID);
  wakeThreatenedBot(characterID, "durable-interruption");
  return true;
}

function drainInterruptions(characterID) {
  if (getTasks().hasBlockingLease(characterID)) return false;
  return interruptions.drain(characterID, intent => {
    const bot = resolveBotByID(characterID);
    if (!bot) return true; // Roster removal cannot leave an eternal mailbox.
    if (intent.kind === "engage") {
      return setDefensiveCombatTarget(characterID, intent.attackerID, intent.reason) ||
        requestThreatRetreat(characterID, intent.attackerID, "defensive operation no longer available");
    }
    if (intent.kind === "mining") {
      return setMiningIncomingThreat(characterID, intent.attackerID, intent.details) ||
        requestThreatRetreat(characterID, intent.attackerID, "mining operation changed during interruption");
    }
    if (intent.kind === "stop") return stopOperation(bot.characterName);
    return requestThreatRetreat(characterID, intent.attackerID, intent.reason);
  });
}
let operationMapCache = null;
let legacyOperationMapCache = null;
let operationHistoryCache = null;
let dashboardOperationPageIndex = null;

// The bot's own empire hub (see playerBotEconomyRuntime).
function hubStationFor(bot) {
  const economy = require("./playerBotEconomyRuntime");
  return typeof economy.getHubStationIDForBot === "function"
    ? economy.getHubStationIDForBot(bot)
    : DEFAULT_MARKET_STATION_ID;
}

function getPlayerBots() {
  return require("./playerBotRuntime");
}

function getSpace() {
  return require("./playerBotSpaceRuntime");
}

function getInventory() {
  return require("./playerBotInventoryRuntime");
}

function getTasks() {
  return require("./playerBotTaskRuntime");
}

function normalizePositiveInteger(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function readOperationMap() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, OPERATIONS_PATH);
  const legacy = result.success && result.data && typeof result.data === "object" ? result.data : EMPTY_OPERATION_MAP;
  // Keep one indexed in-memory view. New records live in their own flat
  // playerBots rows, so saving one pilot never copies/serializes the whole
  // operations map. The old grouped map remains a read-through migration path.
  if (!operationMapCache || legacyOperationMapCache !== legacy) {
    const root = repo.read(TABLE, "/");
    const all = root.success && root.data && typeof root.data === "object" ? root.data : {};
    operationMapCache = { ...legacy };
    for (const [rowKey, wrapper] of Object.entries(all)) {
      if (!rowKey.startsWith(OPERATION_RECORD_PREFIX) || !wrapper?.playerBotOperationRecord) continue;
      const characterID = rowKey.slice(OPERATION_RECORD_PREFIX.length);
      operationMapCache[characterID] = wrapper.playerBotOperationRecord;
    }
    legacyOperationMapCache = legacy;
  }
  return operationMapCache;
}

function readOperationRecord(characterID) {
  const key = String(normalizePositiveInteger(characterID));
  if (key === "0") return null;
  repo.ensureTable(TABLE);
  const current = repo.read(TABLE, `/${OPERATION_RECORD_PREFIX}${key}`);
  if (current.success && current.data?.playerBotOperationRecord) {
    const record = current.data.playerBotOperationRecord;
    if (operationMapCache) operationMapCache[key] = record;
    return record;
  }
  const legacy = repo.read(TABLE, `${OPERATIONS_PATH}/${key}`);
  return legacy.success && legacy.data && typeof legacy.data === "object" ? legacy.data : null;
}

function writeOperationRecord(operation, options = {}) {
  const key = String(operation.characterID);
  const record = JSON.parse(JSON.stringify(operation));
  const result = repo.write(TABLE, `/${OPERATION_RECORD_PREFIX}${key}`, {
    playerBotOperationRecord: record,
  });
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_OPERATION_WRITE_FAILED");
  if (!operationMapCache) operationMapCache = {};
  operationMapCache[key] = record;
  upsertDashboardOperationPageIndex(record);
  if (options.flush !== false) {
    const flush = repo.flushTableSync(TABLE);
    if (!flush || flush.success !== true) {
      throw new Error(flush && flush.errorMsg || "PLAYERBOT_OPERATION_FLUSH_FAILED");
    }
  }
  return record;
}

function readOperationHistoryMap() {
  repo.ensureTable(OPERATION_HISTORY_TABLE);
  const result = repo.read(OPERATION_HISTORY_TABLE, "/");
  const data = result.success && result.data && typeof result.data === "object" ? result.data : {};
  if (operationHistoryCache !== data) operationHistoryCache = data;
  return operationHistoryCache;
}

function archiveOperation(operation) {
  const operationID = String(operation && (operation.operationID || operation.cycleID) || "");
  if (!operation || !operationID || !operation.characterID) return false;
  const history = readOperationHistoryMap();
  if (history[operationID]) return false;
  const fields = [
    "operationID", "cycleID", "characterID", "characterName", "corporationID", "kind", "mode", "role",
    "status", "stage", "createdAt", "updatedAt", "completedAt", "lastAction", "lastError",
    "priorStatus", "supersededAt", "supersededByOperationID",
    "homeStationID", "marketStationID", "originStationID", "destinationStationID",
    "sourceSystemID", "targetSystemID", "destinationSystemID", "planetID", "beltID",
    "shipID", "shipTypeID", "hullTypeID", "trips", "kills", "unitsSold", "unitsListed",
    "proceeds", "spent", "oreMined", "productsProduced", "siteLabel", "siteCompleted",
    "siteIncomplete", "withdrawReason", "history", "productTypeID", "blueprintTypeID", "runs",
    "stationID", "solarSystemID", "assetOwner", "assetOwnerID", "hangarDivision", "walletDivision",
    "maxSpend", "startingBalance", "endingBalance", "jobID", "ledger", "planningOutcome",
  ];
  const entry = {};
  for (const key of fields) {
    if (operation[key] !== undefined) entry[key] = operation[key];
  }
  entry.operationID = operationID;
  if (entry.cycleID && !entry.kind) entry.kind = "industry";
  entry.archivedAt = new Date().toISOString();
  entry.history = Array.isArray(entry.history) ? entry.history.slice(-MAX_HISTORY) : [];
  const result = repo.write(OPERATION_HISTORY_TABLE, `/${operationID}`, entry);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_OPERATION_HISTORY_WRITE_FAILED");
  const flushed = repo.flushTableSync(OPERATION_HISTORY_TABLE);
  if (!flushed || flushed.success !== true) throw new Error(flushed && flushed.errorMsg || "PLAYERBOT_OPERATION_HISTORY_FLUSH_FAILED");
  operationHistoryCache = null;
  upsertDashboardOperationPageIndex(entry);
  return true;
}

function archiveSupersededOperation(operation, successorOperationID, kind = "") {
  if (!operation || !operation.characterID) return false;
  const at = new Date().toISOString();
  const previousStatus = String(operation.status || "unknown");
  const operationID = String(operation.operationID || operation.cycleID ||
    `OP${operation.characterID}-${Date.now()}-superseded`);
  const successorID = String(successorOperationID || "unknown");
  const message = `Superseded by ${successorID}; previous status was ${previousStatus}.`;
  return archiveOperation({
    ...operation,
    operationID,
    ...(kind ? { kind } : {}),
    status: "superseded",
    priorStatus: previousStatus,
    updatedAt: at,
    supersededAt: at,
    supersededByOperationID: successorID,
    lastAction: message,
    history: [
      ...(Array.isArray(operation.history) ? operation.history : []),
      { at, stage: String(operation.stage || ""), message },
    ].slice(-MAX_HISTORY),
  });
}

function saveOperation(operation) {
  const key = String(operation.characterID);
  const previous = readOperationRecord(key);
  if (operation.kind === "upgrade") {
    delete operation.deferredUpgrade;
  } else {
    let deferredUpgrade = previous && previous.deferredUpgrade;
    if (!deferredUpgrade && previous && previous.kind === "upgrade" && previous.status === "blocked") {
      const retryAfterAtMs = Number(previous.retryAfterAtMs) ||
        (Date.parse(previous.updatedAt || "") || 0) + UPGRADE_RETRY_COOLDOWN_MS;
      if (retryAfterAtMs > Date.now()) {
        deferredUpgrade = {
          retryAfterAtMs,
          role: previous.role || "mining",
          name: previous.name || "ship upgrade",
          hullTypeID: Number(previous.hullTypeID) || 0,
          marketStationID: Number(previous.marketStationID) || 0,
          lastError: String(previous.lastError || "").slice(0, 240),
        };
      }
    }
    if (deferredUpgrade && Number(deferredUpgrade.retryAfterAtMs) > Date.now()) {
      operation.deferredUpgrade = deferredUpgrade;
    } else {
      delete operation.deferredUpgrade;
    }
  }
  operation.updatedAt = new Date().toISOString();
  const terminal = operation.status === "completed" || operation.status === "stopped" ||
    operation.status === "failed" || operation.status === "cancelled" ||
    operation.status === "canceled" || operation.status === "abandoned";
  // Preserve every prior operation when this bot starts different work. An
  // active operation used to be overwritten without entering the archive,
  // silently hiding it from the dashboard. Archive before replacing the live
  // row so a storage error cannot discard the only copy.
  const previousID = String(previous && (previous.operationID || previous.cycleID) || "");
  const nextID = String(operation.operationID || operation.cycleID || "");
  if (previous && previousID !== nextID) {
    const terminalStatuses = ["completed", "stopped", "failed", "cancelled", "canceled", "abandoned"];
    if (terminalStatuses.includes(String(previous.status || "").toLowerCase())) {
      archiveOperation(previous);
    } else {
      archiveSupersededOperation(previous, nextID, previous.kind);
    }
  }
  writeOperationRecord(operation);
  if (terminal) {
    try {
      archiveOperation(operation);
    } catch (error) {
      require("../../utils/logger").warn(`[PlayerBots] Could not archive operation ${operation.operationID}: ${error.message}`);
    }
  }
  return operation;
}

function getOperation(characterID) {
  const operation = readOperationRecord(characterID);
  return operation ? JSON.parse(JSON.stringify(operation)) : null;
}

function listOperations() {
  return Object.values(readOperationMap())
    .filter((operation) => operation && operation.characterID)
    .map((operation) => JSON.parse(JSON.stringify(operation)));
}

function dashboardOperationFields(operation) {
  return {
    operationID: String(operation.operationID || operation.cycleID || ""),
    characterID: Number(operation.characterID) || 0,
    characterName: String(operation.characterName || ""),
    corporationID: Number(operation.corporationID) || 0,
    kind: String(operation.kind || "other"),
    status: String(operation.status || "unknown"),
    stage: String(operation.stage || ""),
    updatedAt: String(operation.updatedAt || ""),
    lastAction: String(operation.lastAction || "").slice(0, 240),
  };
}

function dashboardIndustryCycleRecord(cycle) {
  const ledger = cycle && cycle.ledger || {};
  const spent = Number(cycle && cycle.totalSpend) ||
    Number(ledger.blueprintSpend || 0) + Number(ledger.materialSpend || 0) +
    Number(ledger.industryFees || 0) + Number(ledger.brokerFees || 0);
  return {
    ...cycle,
    operationID: String(cycle && cycle.cycleID || ""),
    kind: "industry",
    mode: String(cycle && cycle.assetOwner || "personal"),
    systemID: Number(cycle && cycle.solarSystemID) || 0,
    spent,
    proceeds: Number(ledger.proceeds) || 0,
    unitsSold: Number(ledger.unitsSold) || 0,
    unitsListed: Number(ledger.unitsListed) || 0,
    productsProduced: Number(ledger.unitsProduced) || 0,
  };
}

function readDashboardOperationRecords() {
  const byID = new Map();
  for (const entry of Object.values(readOperationHistoryMap())) {
    if (entry && entry.operationID) byID.set(String(entry.operationID), entry);
  }
  for (const operation of Object.values(readOperationMap())) {
    if (operation && operation.characterID) {
      const row = { ...operation, operationID: String(operation.operationID || `legacy-${operation.characterID}`) };
      byID.set(row.operationID, row);
    }
  }
  for (const cycle of require("./playerBotIndustryCycleRuntime").listCycles()) {
    if (!cycle || !cycle.cycleID) continue;
    byID.set(String(cycle.cycleID), dashboardIndustryCycleRecord(cycle));
  }
  return byID;
}

function dashboardOperationHistoryPageRow(operation) {
  const row = {
    ...dashboardOperationFields(operation),
    operationID: String(operation.operationID || ""),
    characterName: String(operation.characterName || ""),
    corporationID: Number(operation.corporationID) || 0,
    mode: String(operation.mode || ""),
    createdAt: String(operation.createdAt || ""),
    completedAt: String(operation.completedAt || ""),
    priorStatus: String(operation.priorStatus || ""),
    supersededAt: String(operation.supersededAt || ""),
    supersededByOperationID: String(operation.supersededByOperationID || ""),
    lastError: String(operation.lastError || "").slice(0, 240),
    systemID: Number(operation.systemID || operation.targetSystemID || operation.destinationSystemID || operation.sourceSystemID) || 0,
    planetID: Number(operation.planetID) || 0,
    shipTypeID: Number(operation.shipTypeID || operation.hullTypeID) || 0,
    trips: Number(operation.trips) || 0,
    kills: Number(operation.kills) || 0,
    unitsSold: Number(operation.unitsSold) || 0,
    unitsListed: Number(operation.unitsListed) || 0,
    proceeds: Number(operation.proceeds) || 0,
    spent: Number(operation.spent) || 0,
    historyCount: Array.isArray(operation.history) ? operation.history.length : 0,
  };
  const createdAt = Date.parse(operation.createdAt || operation.archivedAt || "");
  row._createdAtValid = Number.isFinite(createdAt);
  row._createdAtMs = row._createdAtValid ? createdAt : 0;
  row._statusKey = row.status.toLowerCase();
  row._kindKey = row.kind.toLowerCase();
  row._searchText = [
    row.operationID,
    row.characterName,
    row.characterID,
    row.corporationID,
    row.lastAction,
    row.stage,
    row.supersededByOperationID,
    row.systemID,
  ].join(" ").toLowerCase();
  return row;
}

function compareDashboardOperationPageRows(left, right) {
  if (left._createdAtValid && right._createdAtValid && left._createdAtMs !== right._createdAtMs) {
    return left._createdAtMs - right._createdAtMs;
  }
  if (left._createdAtValid !== right._createdAtValid) return left._createdAtValid ? -1 : 1;
  return left.operationID.localeCompare(right.operationID);
}

function adjustDashboardOperationCount(counts, key, delta) {
  const next = (Number(counts[key]) || 0) + delta;
  if (next > 0) counts[key] = next;
  else delete counts[key];
}

function getDashboardOperationPageIndex() {
  if (dashboardOperationPageIndex) return dashboardOperationPageIndex;
  const records = readDashboardOperationRecords();
  const rowsByID = new Map();
  for (const operation of records.values()) {
    const row = dashboardOperationHistoryPageRow(operation);
    if (row.operationID) rowsByID.set(row.operationID, row);
  }
  const rows = [...rowsByID.values()].sort(compareDashboardOperationPageRows);
  const counts = {};
  const kindCounts = {};
  for (const row of rows) {
    adjustDashboardOperationCount(counts, row.status, 1);
    adjustDashboardOperationCount(kindCounts, row.kind, 1);
  }
  dashboardOperationPageIndex = { rowsByID, rows, counts, kindCounts };
  return dashboardOperationPageIndex;
}

function upsertDashboardOperationPageIndex(operation) {
  const index = dashboardOperationPageIndex;
  if (!index || !operation) return;
  const row = dashboardOperationHistoryPageRow(operation);
  if (!row.operationID) return;
  const previous = index.rowsByID.get(row.operationID);
  if (previous) {
    const previousIndex = index.rows.indexOf(previous);
    if (previousIndex >= 0) index.rows.splice(previousIndex, 1);
    adjustDashboardOperationCount(index.counts, previous.status, -1);
    adjustDashboardOperationCount(index.kindCounts, previous.kind, -1);
  }
  index.rowsByID.set(row.operationID, row);
  adjustDashboardOperationCount(index.counts, row.status, 1);
  adjustDashboardOperationCount(index.kindCounts, row.kind, 1);
  let low = 0;
  let high = index.rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareDashboardOperationPageRows(row, index.rows[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  index.rows.splice(low, 0, row);
}

// Bounded read-only summaries for the add-on dashboard. The ordinary
// listOperations API intentionally returns detached histories to its callers;
// the dashboard must not deep-clone every history just to count active work.
function getDashboardOperationSummary(limit = 20) {
  // The periodic overview stays bounded to one current record per bot. The
  // historical archive is loaded only when an operator opens the paginated
  // Operations view or asks for a specific record.
  const operations = readOperationMap();
  const recentLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  const byStatus = {};
  const byKind = {};
  const recent = [];
  let total = 0;
  let active = 0;
  for (const operation of Object.values(operations)) {
    if (!operation || !operation.characterID) continue;
    total += 1;
    const status = String(operation.status || "unknown");
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!ACTIVE_STATUSES.has(status)) continue;
    active += 1;
    const kind = String(operation.kind || "other");
    byKind[kind] = (byKind[kind] || 0) + 1;
    const row = dashboardOperationFields(operation);
    let index = recent.findIndex((entry) => String(entry.updatedAt).localeCompare(row.updatedAt) < 0);
    if (index < 0) index = recent.length;
    if (index < recentLimit) recent.splice(index, 0, row);
    if (recent.length > recentLimit) recent.pop();
  }
  return { total, recordedBots: total, active, byStatus, byKind, recent };
}

function getDashboardOperationHistoryPage(query = {}) {
  const offset = Math.max(0, Math.min(10_000_000, Math.trunc(Number(query.offset) || 0)));
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(query.limit) || 50)));
  const statusFilter = String(query.status || "").trim().toLowerCase();
  const kindFilter = String(query.kind || "").trim().toLowerCase();
  const search = String(query.search || "").trim().toLowerCase().slice(0, 80);
  const index = getDashboardOperationPageIndex();
  const rows = [];
  for (const row of index.rows) {
    if (statusFilter && row._statusKey !== statusFilter) continue;
    if (kindFilter && row._kindKey !== kindFilter) continue;
    if (search && !row._searchText.includes(search)) continue;
    rows.push(row);
  }
  return {
    total: rows.length,
    offset,
    limit,
    counts: { ...index.counts },
    kindCounts: { ...index.kindCounts },
    rows: rows.slice(offset, offset + limit).map(({ _createdAtValid, _createdAtMs, _statusKey, _kindKey, _searchText, ...row }) => row),
  };
}

function refreshDashboardIndustryCyclePageIndex(cycle) {
  if (cycle && cycle.cycleID) {
    upsertDashboardOperationPageIndex(dashboardIndustryCycleRecord(cycle));
  }
}

function getDashboardOperationDetails(operationID) {
  const id = String(operationID || "").trim().slice(0, 100);
  if (!/^(?:OP|IC)[0-9]+-[0-9]+(?:-[a-z0-9-]+)?$/i.test(id)) return null;
  repo.ensureTable(OPERATION_HISTORY_TABLE);
  const archived = repo.read(OPERATION_HISTORY_TABLE, `/${id}`);
  if (archived.success && archived.data) return JSON.parse(JSON.stringify(archived.data));
  const operation = Object.values(readOperationMap()).find((entry) => String(entry && entry.operationID) === id);
  if (operation) return JSON.parse(JSON.stringify(operation));
  const cycle = require("./playerBotIndustryCycleRuntime").listCycles().find((entry) => String(entry && entry.cycleID) === id);
  return cycle ? JSON.parse(JSON.stringify({ ...cycle, operationID: cycle.cycleID, kind: "industry" })) : null;
}

function getDashboardOperationsForCharacters(characterIDs = []) {
  const operations = readOperationMap();
  const result = {};
  for (const value of characterIDs) {
    const characterID = normalizePositiveInteger(value);
    const operation = characterID ? operations[String(characterID)] : null;
    if (operation && operation.characterID) result[String(characterID)] = dashboardOperationFields(operation);
  }
  return result;
}

function listActiveOperations() {
  return listOperations().filter((operation) => ACTIVE_STATUSES.has(operation.status));
}

// Shared operation records are a read-only view for hot planning and
// capacity-accounting paths. Mutations must go through saveOperation().
function listActiveOperationRecords() {
  return Object.values(readOperationMap())
    .filter((operation) => operation && operation.characterID && ACTIVE_STATUSES.has(operation.status));
}

function listOperationRecords() {
  return Object.values(readOperationMap()).filter((operation) => operation && operation.characterID);
}

function hasActiveOperation(characterID) {
  const operation = getOperation(characterID);
  return Boolean(operation && ACTIVE_STATUSES.has(operation.status));
}

function record(operation, message) {
  operation.lastAction = String(message).slice(0, 300);
  operation.history = [
    ...(Array.isArray(operation.history) ? operation.history : []),
    { at: new Date().toISOString(), stage: operation.stage, message: operation.lastAction },
  ].slice(-MAX_HISTORY);
}

function block(operation, status, reason) {
  operation.status = status;
  if (operation.kind === "upgrade" && status === "blocked" && !Number(operation.retryAfterAtMs)) {
    operation.retryAfterAtMs = Date.now() + UPGRADE_RETRY_COOLDOWN_MS;
  }
  operation.lastError = String(reason).slice(0, 300);
  record(operation, reason);
  saveOperation(operation);
  return { done: status !== "holding", delayMs: WAIT_DELAY_MS };
}

function deferUnavailableUpgradeWaiters() {
  const operations = readOperationMap();
  const now = Date.now();
  const retryAfterAtMs = now + UPGRADE_RETRY_COOLDOWN_MS;
  let deferred = 0;
  const updated = [];
  for (const operation of Object.values(operations)) {
    if (!operation || operation.kind !== "upgrade" || operation.status !== "holding" || operation.resumeCombat ||
        !["buy", "fetch-parts"].includes(operation.stage) || operation.pending ||
        !/market did not deliver/i.test(String(operation.lastError || ""))) continue;
    operation.status = "blocked";
    operation.retryAfterAtMs = retryAfterAtMs;
    operation.lastError = `${String(operation.lastError).slice(0, 190)}; upgrade paused for 60 minutes so this bot can do other work.`;
    operation.lastAction = operation.lastError;
    operation.history = [
      ...(Array.isArray(operation.history) ? operation.history : []),
      { at: new Date(now).toISOString(), stage: operation.stage, message: operation.lastError },
    ].slice(-MAX_HISTORY);
    operation.updatedAt = new Date(now).toISOString();
    updated.push(operation);
    deferred += 1;
  }
  if (!deferred) return 0;
  for (const operation of updated) writeOperationRecord(operation, { flush: false });
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_OPERATION_FLUSH_FAILED");
  }
  return deferred;
}

function finish(operation, message) {
  operation.status = "completed";
  operation.stage = "done";
  operation.loadSheddingPaused = false;
  delete operation.loadSheddingPausedAtMs;
  delete operation.loadSheddingPauseReason;
  delete operation.loadSheddingPauseRequested;
  delete operation.loadSheddingPauseRequestedReason;
  delete operation.completeBeforeStop;
  operation.completedAt = new Date().toISOString();
  record(operation, message);
  saveOperation(operation);
  return { done: true };
}

function resolveBotByID(characterID) {
  const playerBots = getPlayerBots();
  if (typeof playerBots.getBotByCharacterID === "function") {
    return playerBots.getBotByCharacterID(characterID);
  }
  const id = normalizePositiveInteger(characterID);
  return id && typeof playerBots.listBots === "function"
    ? playerBots.listBots().find((bot) => Number(bot.characterID) === id) || null
    : null;
}

function stationSystemID(stationID) {
  const station = worldData.getStationByID(stationID) || worldData.getStructureByID(stationID);
  return station ? Number(station.solarSystemID) || 0 : 0;
}

function addCounts(target, counts) {
  for (const [typeID, units] of Object.entries(counts || {})) {
    target[typeID] = (Number(target[typeID]) || 0) + (Number(units) || 0);
  }
  return target;
}

function ensureRouteTask(operation, bot, destinationSystemID) {
  const tasks = getTasks();
  const existing = tasks.listTasks({ limit: 100 }).find((task) =>
    task.kind === "playerbot.space.route" &&
    ["queued", "leased"].includes(task.status) &&
    Number(task.resourceOwnerCharacterID) === Number(bot.characterID),
  );
  if (existing) {
    if (Number(existing.payload && existing.payload.destinationSystemID) !== Number(destinationSystemID)) {
      return { error: `${bot.characterName} already has another route (${existing.taskID}); cancel it before continuing.` };
    }
    return { task: existing, risk: existing.payload && existing.payload.routeRisk || null };
  }
  if (operation.routeTaskID) {
    const previous = tasks.getTask(operation.routeTaskID);
    if (previous && previous.status === "failed" &&
        Number(previous.payload && previous.payload.destinationSystemID) === Number(destinationSystemID)) {
      return { error: `Route ${previous.taskID} failed: ${String(previous.lastError || "no details").slice(0, 200)}.` };
    }
  }
  const preview = getSpace().previewSystemRoute(bot, destinationSystemID);
  if (!preview.success) return { error: preview.message || "No stargate route is available." };
  const queued = tasks.enqueueTask({
    kind: "playerbot.space.route",
    capability: "navigation",
    resourceOwnerCharacterID: Number(bot.characterID),
    requestedBy: "system",
    dedupeKey: `playerbot.space.route:${Number(bot.characterID)}:${destinationSystemID}`,
    payload: {
      destinationSystemID: Number(destinationSystemID),
      plannedSystemIDs: preview.systemIDs,
      plannedHopCount: preview.hops,
      routeRisk: preview.risk,
      operationID: operation.operationID,
    },
  });
  operation.routeRisk = preview.risk;
  return { task: queued.task, hops: preview.hops, risk: preview.risk };
}

function clearRouteTask(operation) {
  if (!operation || !operation.routeTaskID) return;
  const tasks = getTasks();
  const task = tasks.getTask(operation.routeTaskID);
  if (task && ["queued", "leased"].includes(task.status)) tasks.cancelTask(task.taskID);
  operation.routeTaskID = null;
}

function travelToSystem(operation, bot, destinationSystemID, store = OPERATION_STORE) {
  const destinationID = normalizePositiveInteger(destinationSystemID);
  const currentSystemID = normalizePositiveInteger((getCharacterRecord(bot.characterID) || {}).solarSystemID);
  if (!destinationID || !worldData.getSolarSystemByID(destinationID)) {
    return store.block(operation, "blocked", `Destination system ${destinationID || "unknown"} does not exist.`);
  }
  if (currentSystemID === destinationID) return null;
  const route = ensureRouteTask(operation, bot, destinationID);
  if (route.error) return store.block(operation, "blocked", route.error);
  if (operation.routeTaskID !== route.task.taskID) {
    operation.routeTaskID = route.task.taskID;
    record(operation, `Route ${route.task.taskID} to system ${destinationID} (${route.hops} jumps); risk ${route.risk.lowsecSystemIDs.length} low-sec and ${route.risk.nullsecSystemIDs.length} null-sec systems.`);
    store.save(operation);
  }
  require("./playerBotAutonomyRuntime").ensureNavigationTask(route.task.taskID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not advance route ${route.task.taskID}: ${error.message}`));
  return { delayMs: TRAVEL_DELAY_MS };
}

// Returns null once the bot is docked at stationID; otherwise the next step.
// `store` persists the travelling record: operations by default, or the
// industry cycle's own store when a cycle travels (e.g. a Jita buying run).
const OPERATION_STORE = Object.freeze({
  save: (entity) => saveOperation(entity),
  block: (entity, status, reason) => block(entity, status, reason),
});

async function travelToStation(operation, bot, stationID, store = OPERATION_STORE) {
  const character = getCharacterRecord(bot.characterID) || {};
  const dockedStationID = normalizePositiveInteger(character.stationID || character.structureID);
  if (dockedStationID === Number(stationID)) return null;
  const destinationSystemID = stationSystemID(stationID);
  const currentSystemID = normalizePositiveInteger(character.solarSystemID);
  if (currentSystemID !== destinationSystemID) {
    const route = ensureRouteTask(operation, bot, destinationSystemID);
    if (route.error) return store.block(operation, "blocked", route.error);
    if (operation.routeTaskID !== route.task.taskID) {
      operation.routeTaskID = route.task.taskID;
      const risk = route.risk;
      const riskSummary = risk
        ? `; risk ${risk.lowsecSystemIDs.length} low-sec, ${risk.nullsecSystemIDs.length} null-sec systems`
        : "; risk report unavailable";
      record(operation, `Route ${route.task.taskID} to system ${destinationSystemID}${route.hops !== undefined ? ` (${route.hops} jumps)` : ""}${riskSummary}.`);
      store.save(operation);
    }
    await require("./playerBotAutonomyRuntime").ensureNavigationTask(route.task.taskID);
    return { delayMs: TRAVEL_DELAY_MS };
  }
  const space = getSpace();
  if (dockedStationID) {
    const result = space.undock(bot, { allowOverCapacityDeparture: true });
    if (!result.success) return result.capacityQueued
      ? { delayMs: TRAVEL_DELAY_MS, capacityQueued: true, capacityReason: result.message }
      : store.block(operation, "blocked", result.message);
    record(operation, `Undocking from ${dockedStationID} toward ${stationID}.`);
    store.save(operation);
    return { delayMs: TRAVEL_DELAY_MS };
  }
  const state = space.getSpaceState(bot);
  if (!state.inSpace || state.busy) return { delayMs: TRAVEL_DELAY_MS };
  if ((operation.incomingThreat || operation.threatRetreat) && Number(state.warpScrambleStatus) > 0) {
    if (!operation.escapeBlockedByTackle) {
      operation.escapeBlockedByTackle = true;
      record(operation, "Evacuation is blocked by active warp disruption; awaiting clearance while the rescue request remains active.");
      store.save(operation);
    }
    return { delayMs: 1000, escapeBlocked: true };
  }
  if (operation.escapeBlockedByTackle) {
    delete operation.escapeBlockedByTackle;
    record(operation, "Warp disruption cleared; retrying the existing evacuation route.");
    store.save(operation);
  }
  const distance = state.distanceTo(stationID);
  if (distance === null) return store.block(operation, "blocked", `Station ${stationID} is not in the local scene.`);
  if (distance > DOCK_WARP_RANGE_METERS) {
    const result = space.warp(bot, stationID);
    if (!result.success && (operation.incomingThreat || operation.threatRetreat) && /WARP_SCRAMBLED/i.test(String(result.message)))
      return { delayMs: 1000, escapeBlocked: true };
    if (!result.success) return store.block(operation, "blocked", result.message);
    return { delayMs: TRAVEL_DELAY_MS };
  }
  const result = space.dock(bot, stationID);
  if (!result.success) return store.block(operation, "blocked", result.message);
  return { delayMs: STEP_DELAY_MS * 2 };
}

// Nearest high-sec system (by stargate hops) with an asteroid belt and a
// station to dock at; the bot's current system counts as zero hops.
function findNearestMiningStation(fromSystemID, minSecurity = 0.45, maxHops = 15, excludedSystemIDs = []) {
  const start = normalizePositiveInteger(fromSystemID);
  if (!start) return null;
  const excluded = new Set((Array.isArray(excludedSystemIDs) ? excludedSystemIDs : [])
    .map((systemID) => normalizePositiveInteger(systemID)).filter(Boolean));
  const visited = new Set([start]);
  let frontier = [start];
  for (let hops = 0; hops <= maxHops && frontier.length; hops += 1) {
    const candidates = [];
    for (const systemID of frontier) {
      if (excluded.has(systemID)) continue;
      const system = worldData.getSolarSystemByID(systemID);
      if (!system || Number(system.security) < minSecurity) continue;
      if (!(worldData.getAsteroidBeltsForSystem(systemID) || []).length) continue;
      const stations = (worldData.getStationsForSystem(systemID) || [])
        .map((station) => Number(station.stationID))
        .filter(Boolean)
        .sort((left, right) => left - right);
      if (stations.length) candidates.push({ systemID, stationID: stations[0], hops });
    }
    if (candidates.length) return candidates.sort((left, right) => left.systemID - right.systemID)[0];
    const next = [];
    for (const systemID of frontier) {
      for (const gate of worldData.getStargatesForSystem(systemID) || []) {
        const destination = worldData.getStargateByID(gate.destinationID);
        const nextSystemID = normalizePositiveInteger(gate.destinationSolarSystemID) ||
          normalizePositiveInteger(destination && destination.solarSystemID);
        const nextSystem = nextSystemID && worldData.getSolarSystemByID(nextSystemID);
        // Never path through low-sec to reach a mining spot.
        if (!nextSystem || visited.has(nextSystemID) || excluded.has(nextSystemID) || Number(nextSystem.security) < minSecurity) continue;
        visited.add(nextSystemID);
        next.push(nextSystemID);
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------- hauling

function findHaulStacks(operation, bot) {
  const inventory = getInventory();
  if (operation.itemID) {
    return inventory.listHangar(bot, operation.fromStationID).filter((item) => Number(item.itemID) === Number(operation.itemID));
  }
  return inventory.listHangar(bot, operation.fromStationID, operation.typeID);
}

async function advanceHaul(operation, bot) {
  const inventory = getInventory();
  if (operation.stage === "to-source") {
    const step = await travelToStation(operation, bot, operation.fromStationID);
    if (step) return step;
    operation.stage = "load";
    saveOperation(operation);
  }
  if (operation.stage === "load") {
    const remaining = operation.quantity ? operation.quantity - operation.moved : Infinity;
    let loaded = 0;
    for (const stack of findHaulStacks(operation, bot)) {
      if (remaining - loaded <= 0) break;
      const result = inventory.loadToCargo(bot, stack.itemID, Number.isFinite(remaining) ? remaining - loaded : null);
      loaded += Number(result.moved) || 0;
      if (!result.success) break;
    }
    if (!loaded && !inventory.listCargo(bot).length) {
      if (operation.moved > 0) return finish(operation, `Hauling complete: moved ${operation.moved} units to ${operation.toStationID}.`);
      return block(operation, "blocked", `There is nothing to load at ${operation.fromStationID}, or it does not fit in the hold.`);
    }
    operation.trips += 1;
    operation.stage = "to-destination";
    record(operation, `Trip ${operation.trips}: loaded ${loaded} units at ${operation.fromStationID}.`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "to-destination") {
    const step = await travelToStation(operation, bot, operation.toStationID);
    if (step) return step;
    operation.stage = "unload";
    saveOperation(operation);
  }
  if (operation.stage === "unload") {
    const result = inventory.unloadCargo(bot);
    const units = Object.values(result.unloaded).reduce((total, value) => total + Number(value || 0), 0);
    operation.moved += units;
    addCounts(operation.delivered, result.unloaded);
    record(operation, `Unloaded ${units} units at ${operation.toStationID}.`);
    const remaining = operation.quantity ? operation.quantity - operation.moved : null;
    // The source hangar can be read from anywhere; skip the empty trip back.
    if ((remaining !== null && remaining <= 0) || operation.trips >= MAX_TRIPS ||
        !findHaulStacks(operation, bot).length) {
      return finish(operation, `Hauling complete: moved ${operation.moved} units in ${operation.trips} trip(s).`);
    }
    operation.stage = "to-source";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  return block(operation, "blocked", `Unknown hauling stage ${operation.stage}.`);
}

// ---------------------------------------------------------------- mining

function getMiningModules(bot) {
  const session = getSpace().getActorSession(bot);
  const shipID = Number(session.shipID) || 0;
  const itemStore = require("../inventory/itemStore");
  const miningDogma = require("../mining/miningDogma");
  return itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
    .filter((item) => Number(item.flagID) >= 27 && Number(item.flagID) <= 34 &&
      miningDogma.isMiningEffectRecord(null, item));
}

function oreInCargo(bot) {
  const counts = {};
  const registry = require("../inventory/itemTypeRegistry");
  for (const item of getInventory().listCargo(bot)) {
    const type = registry.resolveItemByTypeID(Number(item.typeID));
    if (Number(type && type.categoryID) !== 25) continue;
    counts[String(item.typeID)] = (counts[String(item.typeID)] || 0) + getInventory().unitsOf(item);
  }
  return counts;
}

function pickBelt(operation, now = Date.now()) {
  const belts = worldData.getAsteroidBeltsForSystem(stationSystemID(operation.homeStationID)) || [];
  if (!belts.length) return null;
  const danger = operation.dangerousBelts || {};
  const safe = belts.filter((belt) => now - Number(danger[String(belt.itemID)] || 0) > BELT_DANGER_MS);
  return safe.length ? safe[operation.trips % safe.length] : null;
}

function shouldWithdrawMinerWithoutEscort(state) {
  return Number(state && state.warpScrambleStatus) > 0 ||
    Number(state && state.hullDamage) > 0 || Number(state && state.armorDamage) > 0 ||
    Number(state && state.shield) <= 0.3;
}

async function advanceMining(operation, bot) {
  if (Number(operation.miningThreatPolicyVersion) !== 2) {
    // Previous builds marked whole belts dangerous from nearby NPC presence or
    // any persisted armor damage. Neither proves that the miner is under fire.
    operation.dangerousBelts = {};
    operation.miningThreatPolicyVersion = 2;
    record(operation, "Updated mining safety state; clearing legacy belt alarms that were not tied to a destroyed escort.");
    saveOperation(operation);
  }
  if (operation.trips > 0 && !Object.values(operation.oreMined || {}).some(units => units > 0)) {
    operation.trips = 0;
    if (["next", "refine", "sell", "load-output", "corp-share"].includes(operation.stage)) {
      operation.stage = "to-home";
    }
    saveOperation(operation);
  }
  if (operation.optimizeMarketDestination === undefined) operation.optimizeMarketDestination = true;
  if (operation.marketStationID === undefined ||
      require("./playerBotEconomyRuntime").isJitaStation(operation.marketStationID)) {
    operation.marketStationID = hubStationFor(bot);
  }
  const space = getSpace();
  const inventory = getInventory();
  if (operation.incomingThreat && Number(operation.incomingThreat.attackerEntityID) > 0) {
    const threat = operation.incomingThreat;
    const threatID = Number(threat.attackerEntityID);
    const now = Date.now();
    if (threat.action === "retreat") {
      space.stopMining(bot);
      if (operation.stage !== "return") {
        operation.stage = "return";
        operation.dangerousBelts = { ...(operation.dangerousBelts || {}), [String(operation.beltID)]: now };
        record(operation, `Hostile ${threat.attackerName || `pilot ${threat.attackerCharacterID || threatID}`} attacked the miner without a qualified escort able to respond; lasers stopped and the ship is withdrawing.`);
        saveOperation(operation);
        return { delayMs: STEP_DELAY_MS };
      }
    } else {
      let scene = null;
      let attacker = null;
      try {
        const attached = space.getActorSpace(bot);
        scene = attached.scene;
        attacker = scene && scene.getEntityByID(threatID);
      } catch (_) {
        // The normal mining state machine handles a ship that is already docked or recovering.
      }
      if (!attacker || attacker.destructionState === "destroying" || attacker.destroying === true) {
        delete operation.incomingThreat;
        record(operation, "The hostile ship left the mining grid; the miner resumes its ore cycle.");
        saveOperation(operation);
      } else {
        space.stopMining(bot);
        const escort = require("./playerBotMiningEscortRuntime").getEscortState(operation);
        const escortOperation = escort.operation || getOperation(threat.escortCharacterID);
        if (escort.destroyed || !escort.assigned || !escortOperation ||
            !ACTIVE_STATUSES.has(escortOperation.status)) {
          operation.incomingThreat.action = "retreat";
          operation.threatReturnStationID = findThreatEvacuationStation(bot);
          operation.dangerousBelts = { ...(operation.dangerousBelts || {}), [String(operation.beltID)]: now };
          operation.stage = "return";
          record(operation, `Mining escort ${escort.characterName || escort.characterID || "assigned"} cannot cover the hostile ship; lasers stopped and the miner is withdrawing.`);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
        if (now - Number(threat.receivedAtMs || now) > 20_000 &&
            Number(escortOperation.targetID) !== threatID &&
            Number(escortOperation.defensiveTargetID) !== threatID) {
          operation.incomingThreat.action = "retreat";
          operation.threatReturnStationID = findThreatEvacuationStation(bot);
          operation.stage = "return";
          record(operation, "The security escort could not establish a legal response to the attacker; the miner is withdrawing.");
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
        // Keep the miner safe and quiet while its security escort resolves the
        // hostile target. It resumes mining as soon as that ship leaves grid.
        return { delayMs: 1_000 };
      }
    }
  }
  if (operation.stage === "sale-route") return advanceRegionalSaleRoute(operation, bot);
  if (operation.stage === "to-home") {
    const step = await travelToStation(operation, bot, operation.homeStationID);
    if (step) return step;
    operation.stage = operation.relocatingMiningBase || operation.trips === 0 ? "undock" : "unload";
    delete operation.relocatingMiningBase;
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "undock") {
    if (Number((getCharacterRecord(bot.characterID) || {}).shipTypeID) === 670 || !getMiningModules(bot).length) {
      return block(operation, "blocked", "No mining ship is available (capsule or no fitted miner); the director must assign another ship.");
    }
    const belts = worldData.getAsteroidBeltsForSystem(stationSystemID(operation.homeStationID)) || [];
    if (!belts.length) return block(operation, "blocked", `The system for ${operation.homeStationID} has no asteroid belts.`);
    const belt = pickBelt(operation);
    if (!belt) {
      const now = Date.now();
      if (operation.autonomous === true && operation.territorialOperation !== true) {
        const currentSystemID = stationSystemID(operation.homeStationID);
        operation.dangerousMiningSystems = Object.fromEntries(
          Object.entries(operation.dangerousMiningSystems || {}).filter(([, at]) => now - Number(at) < BELT_DANGER_MS),
        );
        operation.dangerousMiningSystems[currentSystemID] = now;
        const excludedSystems = [...Object.keys(operation.dangerousMiningSystems).map(Number), 30000142];
        const alternative = findNearestMiningStation(currentSystemID, 0.45, 15, excludedSystems);
        if (alternative) {
          clearRouteTask(operation);
          operation.homeStationID = alternative.stationID;
          operation.relocatingMiningBase = true;
          operation.stage = "to-home";
          record(operation, `All local belts are unsafe; moving the mining base from system ${currentSystemID} to station ${alternative.stationID} in system ${alternative.systemID} over ${alternative.hops} high-security jump(s).`);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
      }
      const nextSafeAt = Math.min(...belts.map((entry) =>
        Number(operation.dangerousBelts && operation.dangerousBelts[String(entry.itemID)] || 0) + BELT_DANGER_MS + 1,
      ));
      const delayMs = Math.max(STEP_DELAY_MS, Math.min(WAIT_DELAY_MS, nextSafeAt - now));
      record(operation, `All ${belts.length} asteroid belts were recently marked dangerous; waiting before selecting another belt.`);
      saveOperation(operation);
      return { delayMs };
    }
    const result = space.undock(bot, { allowOverCapacityDeparture: true });
    if (!result.success) return result.capacityQueued
      ? { delayMs: TRAVEL_DELAY_MS, capacityQueued: true, capacityReason: result.message }
      : block(operation, "blocked", result.message);
    operation.beltID = Number(belt.itemID);
    operation.tripStartedAt = Date.now();
    operation.stage = "to-belt";
    record(operation, `Undocked; trip ${operation.trips + 1} to asteroid belt ${operation.beltID}.`);
    saveOperation(operation);
    return { delayMs: TRAVEL_DELAY_MS };
  }
  if (operation.stage === "mining" && Number(operation.beltID) > 0) {
    const state = space.getSpaceState(bot);
    if (state.inSpace && state.isCapsule) {
      space.stopMining(bot);
      operation.shipLost = true;
      operation.stage = "return";
      record(operation, `Mining ship was destroyed in asteroid belt ${operation.beltID}; returning in a capsule to recover.`);
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    const escortRuntime = require("./playerBotMiningEscortRuntime");
    const escortState = escortRuntime.getEscortState(operation);
    if (escortState.destroyed) {
      space.stopMining(bot);
      operation.threatReturnStationID = findThreatEvacuationStation(bot);
      operation.dangerousBelts = { ...(operation.dangerousBelts || {}), [String(operation.beltID)]: Date.now() };
      operation.miningEscortLost = true;
      operation.stage = "return";
      record(operation, `Security escort ${escortState.characterName || operation.escortCharacterName || escortState.characterID} was destroyed; the miner is returning to station.`);
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    const visiblePirateNpcCount = state.inSpace && typeof space.getNearbyPirateNpcCount === "function"
      ? Number(space.getNearbyPirateNpcCount(bot, MINING_ESCORT_DISPATCH_RANGE_METERS)) || 0
      : 0;
    const pirateScanAtMs = Date.now();
    let pirateScanChanged = false;
    if (state.inSpace && Number(operation.lastVisiblePirateNpcCount) !== visiblePirateNpcCount) {
      operation.lastVisiblePirateNpcCount = visiblePirateNpcCount;
      operation.lastPirateScanAt = new Date(pirateScanAtMs).toISOString();
      operation.lastPirateScanAtMs = pirateScanAtMs;
      operation.lastPirateScanPersistedAtMs = pirateScanAtMs;
      record(operation, visiblePirateNpcCount > 0
        ? `Belt scan detected ${visiblePirateNpcCount} visible pirate rat(s) within ${MINING_ESCORT_DISPATCH_RANGE_METERS / 1000} km; requesting a security escort while mining continues.`
        : `Belt scan found no visible pirate rats within ${MINING_ESCORT_DISPATCH_RANGE_METERS / 1000} km; mining continues without an escort.`);
      pirateScanChanged = true;
    } else if (state.inSpace && visiblePirateNpcCount > 0 &&
        pirateScanAtMs - Number(operation.lastPirateScanPersistedAtMs || 0) >= MINING_RAT_SCAN_PERSIST_MS) {
      // Keep a fresh durable escort request without writing the full operation
      // on every five-second mining poll. The director can pick up a guard
      // when its current safe-to-finish task completes.
      operation.lastPirateScanAt = new Date(pirateScanAtMs).toISOString();
      operation.lastPirateScanAtMs = pirateScanAtMs;
      operation.lastPirateScanPersistedAtMs = pirateScanAtMs;
      pirateScanChanged = true;
    }
    if (pirateScanChanged) saveOperation(operation);
    if (visiblePirateNpcCount > 0) {
      const escort = escortRuntime.ensureMiningEscort(bot, operation);
      if (escort.assigned && (escort.started || escort.characterID !== Number(operation.escortCharacterID))) {
        operation.escortCharacterID = Number(escort.characterID);
        operation.escortCharacterName = escort.characterName;
        operation.escortFitTier = Number(escort.fitTier) || 0;
        record(operation, `Security escort ${escort.characterName} (fit tier ${escort.fitTier}, required ${escort.requiredTier}) is covering belt ${operation.beltID}.`);
        saveOperation(operation);
      } else if (escort.shouldLog) {
        record(operation, `Visible pirate NPCs=${visiblePirateNpcCount} on belt ${operation.beltID}; no validated security escort meets risk tier ${escort.requiredTier}: ${escort.reason} Mining continues while the escort is unavailable.`);
        saveOperation(operation);
      } else if (escort.changed) {
        saveOperation(operation);
      }
      const coverage = escortRuntime.getEscortState(operation);
      if (!coverage.ready) {
        if (operation.miningEscortWaiting !== true) {
          space.stopMining(bot);
          operation.miningEscortWaiting = true;
          operation.miningEscortWaitStartedAtMs = Date.now();
          record(operation, `Mining lasers paused: ${visiblePirateNpcCount} pirate rat(s) are visible and no fitted security escort is on the belt and engaging yet.`);
        }
        if (shouldWithdrawMinerWithoutEscort(state)) {
          operation.dangerousBelts = { ...(operation.dangerousBelts || {}), [String(operation.beltID)]: Date.now() };
          operation.stage = "return";
          record(operation, "The miner is taking damage or warp-disrupted before escort cover is established; withdrawing to protect the remaining hull.");
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
        // A belt with visible rats and no fit-qualified escort is not a safe
        // place to wait. Older behavior left miners idle on-grid until their
        // shield had already collapsed; the live killboard showed repeated
        // NPC losses in exactly that state. Leave immediately when no guard
        // can cover this risk tier, and give an assigned guard only a short,
        // bounded time to enter the grid and engage.
        const noQualifiedEscort = !coverage.assigned && escort.assigned !== true;
        const escortWaitStartedAtMs = Number(operation.miningEscortWaitStartedAtMs) || Date.now();
        const escortResponseExpired = coverage.assigned === true &&
          Date.now() - escortWaitStartedAtMs >= MINING_ESCORT_MAX_RESPONSE_WAIT_MS;
        if (noQualifiedEscort || escortResponseExpired) {
          operation.dangerousBelts = { ...(operation.dangerousBelts || {}), [String(operation.beltID)]: Date.now() };
          operation.stage = "return";
          operation.threatReturnStationID = findThreatEvacuationStation(bot);
          record(operation, noQualifiedEscort
            ? `No validated security fit can cover risk tier ${Number(escort.requiredTier || operation.escortRequiredTier) || "unknown"}; leaving belt ${operation.beltID} with ${visiblePirateNpcCount} visible pirate rat(s).`
            : `Escort ${coverage.characterName || coverage.characterID || operation.escortCharacterName || "assigned"} did not engage within ${Math.round(MINING_ESCORT_MAX_RESPONSE_WAIT_MS / 1000)} seconds; leaving belt ${operation.beltID} with ${visiblePirateNpcCount} visible pirate rat(s).`);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
        const lastWaitLogAtMs = Number(operation.miningEscortWaitLoggedAtMs) || 0;
        if (Date.now() - lastWaitLogAtMs >= 60_000) {
          operation.miningEscortWaitLoggedAtMs = Date.now();
          record(operation, coverage.assigned
            ? `Waiting for escort ${coverage.characterName || coverage.characterID} to reach belt ${operation.beltID} and engage a rat.`
            : `Waiting for a qualified security escort before resuming mining on belt ${operation.beltID}.`);
          saveOperation(operation);
        }
        return { delayMs: MINING_POLL_MS };
      }
      if (operation.miningEscortWaiting === true) {
        operation.miningEscortWaiting = false;
        operation.miningEscortWaitLoggedAtMs = 0;
        operation.miningEscortWaitStartedAtMs = 0;
        record(operation, `Security escort ${coverage.characterName || coverage.characterID} is on belt ${operation.beltID} and engaging; mining may resume.`);
        saveOperation(operation);
      }
    } else if (operation.miningEscortWaiting === true) {
      operation.miningEscortWaiting = false;
      operation.miningEscortWaitLoggedAtMs = 0;
      operation.miningEscortWaitStartedAtMs = 0;
      record(operation, `No pirate rats are visible on belt ${operation.beltID}; mining resumes without needing an escort.`);
      saveOperation(operation);
    }
  }
  if (operation.stage === "to-belt") {
    const state = space.getSpaceState(bot);
    if (!state.inSpace || state.busy) return { delayMs: TRAVEL_DELAY_MS };
    const distance = state.distanceTo(operation.beltID);
    if (distance !== null && distance > DOCK_WARP_RANGE_METERS) {
      const result = space.warp(bot, operation.beltID);
      if (!result.success) return block(operation, "blocked", result.message);
      return { delayMs: TRAVEL_DELAY_MS };
    }
    operation.stage = "mining";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "mining") {
    const cargo = inventory.getCargoCapacity(bot);
    const timedOut = Date.now() - Number(operation.tripStartedAt || 0) > operation.maxTripMs;
    if (cargo.capacity > 0 && cargo.free < cargo.capacity * 0.05 || timedOut) {
      space.stopMining(bot);
      operation.stage = "return";
      record(operation, `Hold ${cargo.used.toFixed(1)}/${cargo.capacity.toFixed(1)} m³${timedOut ? " (trip time limit reached)" : ""}; returning to station.`);
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    const miningModules = getMiningModules(bot);
    if (!miningModules.length) {
      space.stopMining(bot);
      operation.stage = "return";
      record(operation, "No fitted online mining laser is available on the active ship; returning to station for a fit recovery instead of waiting in an empty belt.");
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    const cargoBeforeMining = oreInCargo(bot);
    if (!operation.miningCargoSnapshot) operation.miningCargoSnapshot = cargoBeforeMining;
    const owner = executionOwners.get(Number(bot.characterID));
    const startingShip = getCharacterRecord(bot.characterID) || {};
    const shipID = Number(startingShip.shipID);
    const systemID = Number(startingShip.solarSystemID);
    const isCurrent = () => {
      const liveBot = resolveBotByID(bot.characterID);
      const liveShip = getCharacterRecord(bot.characterID) || {};
      const latest = getOperation(bot.characterID);
      return (!owner || interruptions.current(owner)) && Boolean(liveBot) &&
        liveBot.status !== "paused" && liveBot.autonomyPaused !== true &&
        Number(liveShip.shipID) === shipID && Number(liveShip.solarSystemID) === systemID &&
        Number(liveShip.shipTypeID) !== 670 && !liveShip.stationID && !liveShip.structureID &&
        latest?.operationID === operation.operationID && latest.stage === "mining" &&
        ACTIVE_STATUSES.has(latest.status) && !latest.incomingThreat;
    };
    if (!isCurrent()) return { delayMs: 1000, interrupted: true };
    const miningRead = space.mineNearestAsteroid(bot, miningModules, MINING_APPROACH_METERS,
      operation.homeStationID, { isCurrent });
    const result = owner ? await interruptions.readUntilInterrupted(owner, miningRead) : await miningRead;
    // Do not write any stale mining snapshot, even if a dependency ignores cancellation.
    if (result.interrupted || !isCurrent()) return { delayMs: 1000, interrupted: true };
    if (result.noOre) {
      space.stopMining(bot);
      operation.stage = "return";
      record(operation, result.message);
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    if (!result.success) return block(operation, "holding", result.message);
    operation.lockFailures = result.lockFailed ? (Number(operation.lockFailures) || 0) + 1 : 0;
    if (operation.lockFailures >= 3) {
      // Repeated lock failures (e.g. sensors not restored after a restart):
      // dock and start the next trip with a freshly undocked ship.
      operation.lockFailures = 0;
      space.stopMining(bot);
      operation.stage = "return";
      record(operation, `Could not lock asteroids (${result.message}); returning to dock and resetting sensors.`);
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    const phaseKey = result.targetID && result.phase
      ? `${Number(result.targetID)}:${result.phase}`
      : null;
    if (phaseKey && phaseKey !== operation.miningPhaseKey) {
      operation.miningPhaseKey = phaseKey;
      const phaseMessage = result.phase === "approach"
        ? `Approaching ore asteroid ${result.targetID} before locking it.`
        : result.phase === "locking"
          ? `Locking ore asteroid ${result.targetID}; mining lasers have not fired yet.`
          : result.phase === "mining"
            ? `Locked ore asteroid ${result.targetID}; activated ${Number(result.moduleIDs && result.moduleIDs.length) || miningModules.length} mining laser(s) against that target.`
            : result.message;
      if (phaseMessage) record(operation, phaseMessage);
    } else if (result.message && result.message !== operation.lastAction) {
      record(operation, result.message);
    }
    const cargoAfterMining = oreInCargo(bot);
    const delivered = {};
    for (const [typeID, units] of Object.entries(cargoAfterMining)) {
      const delta = Number(units) - Number(operation.miningCargoSnapshot[typeID] || 0);
      if (delta > 0) delivered[typeID] = delta;
    }
    if (Object.keys(delivered).length) {
      operation.miningCycleYield ||= {};
      addCounts(operation.miningCycleYield, delivered);
      record(operation, `Mining cycle delivered ore ${JSON.stringify(delivered)} to the ship cargo hold.`);
      operation.miningCargoSnapshot = cargoAfterMining;
    }
    if (phaseKey || Object.keys(delivered).length) {
      saveOperation(operation);
    }
    return { delayMs: MINING_POLL_MS };
  }
  if (operation.stage === "return") {
    const threatReturnStationID = normalizePositiveInteger(operation.threatReturnStationID);
    const step = await travelToStation(operation, bot, threatReturnStationID || operation.homeStationID);
    if (step) return step;
    if (threatReturnStationID) {
      operation.homeStationID = threatReturnStationID;
      operation.marketStationID = threatReturnStationID;
      delete operation.threatReturnStationID;
    }
    if (operation.incomingThreat) {
      delete operation.incomingThreat;
      record(operation, "The ship reached its mining base after the threat response; clearing the alert before the next safe work cycle.");
    }
    operation.stage = "unload";
    saveOperation(operation);
  }
  if (operation.stage === "unload") {
    const before = oreInCargo(bot);
    const result = inventory.unloadCargo(bot);
    if (!result.success) return block(operation, "holding", result.message);
    const delivered = {};
    for (const [typeID, units] of Object.entries(before)) {
      const moved = Math.min(units, Number(result.unloaded[typeID]) || 0);
      if (moved > 0) delivered[typeID] = moved;
    }
    addCounts(operation.oreMined, delivered);
    if (!Object.keys(delivered).length) {
      if (operation.shipLost) return block(operation, "blocked", "Mining ship lost before ore could be unloaded.");
      operation.dangerousBelts = { ...operation.dangerousBelts, [operation.beltID]: Date.now() };
      operation.stage = "undock";
      operation.miningCargoSnapshot = {};
      operation.miningPhaseKey = null;
      record(operation, "Empty return; no productive trip counted. Selecting another belt after docking.");
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    operation.trips += 1;
    operation.miningCargoSnapshot = {};
    operation.miningPhaseKey = null;
    record(operation, `Trip ${operation.trips}: unloaded ore ${JSON.stringify(result.unloaded)}.`);
    if (operation.shipLost) {
      return finish(operation, `Operation ended because the ship was lost; the director will assign another. Ore was saved at ${operation.homeStationID}.`);
    }
    operation.stage = operation.refine ? "refine" : operation.sell ? "sell" : "next";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "refine") {
    const refined = await refineOreInHangar(operation, bot);
    if (refined.error) record(operation, `Reprocessing did not complete: ${refined.error}`);
    operation.stage = operation.sell ? "sell" : "next";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "sell") {
    // Sell at the base only when it is the market station; otherwise the
    // output travels to the market after the last trip.
    if (!operation.marketStationID || operation.marketStationID === operation.homeStationID) {
      if (operation.trips >= operation.maxTrips) {
        const route = await maybeBeginRegionalSaleRoute(operation, bot, operation.homeStationID, "market-sell");
        if (route) return route;
      }
      await sellMiningOutput(operation, bot);
    }
    operation.stage = "next";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "next") {
    if (operation.trips >= operation.maxTrips && operation.marketStationID &&
        operation.marketStationID !== operation.homeStationID && operation.sell) {
      operation.stage = "load-output";
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    if (operation.trips >= operation.maxTrips) {
      if (operation.sell) {
        operation.stage = "corp-share";
        operation.finalMessage = `Mining completed: ${operation.trips} trip(s); sold ${Number(operation.unitsSold || 0)} units for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units.`;
        saveOperation(operation);
        return { delayMs: STEP_DELAY_MS };
      }
      return finish(operation, `Mining completed: ${operation.trips} trip(s); ore ${JSON.stringify(operation.oreMined)}, refined minerals ${JSON.stringify(operation.mineralsRefined)}.`);
    }
    operation.stage = "undock";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "load-output") {
    const step = await travelToStation(operation, bot, operation.homeStationID);
    if (step) return step;
    const registry = require("../inventory/itemTypeRegistry");
    let loaded = 0;
    for (const stack of inventory.listHangar(bot, operation.homeStationID)) {
      const categoryID = Number((registry.resolveItemByTypeID(Number(stack.typeID)) || {}).categoryID);
      if (!SELLABLE_CATEGORIES.has(categoryID)) continue;
      const result = inventory.loadToCargo(bot, stack.itemID);
      loaded += Number(result.moved) || 0;
      if (!result.success) break;
    }
    operation.stage = loaded ? "to-market" : "done-check";
    record(operation, loaded ? `Loaded ${loaded} units for market station ${operation.marketStationID}.` : "Nothing to take to market.");
    saveOperation(operation);
    if (!loaded) return finish(operation, `Mining completed with no output to sell: ${operation.trips} trip(s).`);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "to-market") {
    const step = await travelToStation(operation, bot, operation.marketStationID);
    if (step) return step;
    inventory.unloadCargo(bot);
    operation.stage = "market-sell";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "market-sell") {
    const route = await maybeBeginRegionalSaleRoute(operation, bot, operation.marketStationID, "market-sell");
    if (route) return route;
    await sellMiningOutput(operation, bot, operation.marketStationID);
    operation.stage = "corp-share";
    operation.finalMessage = `Mining completed: ${operation.trips} trip(s); sold ${Number(operation.unitsSold || 0)} units for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units.`;
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "corp-share") {
    try {
      operation.corpShare = await require("./playerBotCorpEconomyRuntime").payCorpShare(
        bot,
        (Number(operation.proceeds) || 0) - (Number(operation.brokerFees) || 0),
        `mining operation ${operation.operationID}`,
        `mining:${operation.operationID}`,
      );
      operation.corpShareSettled = true;
      saveOperation(operation);
    } catch (error) {
      return block(operation, "holding", `Could not settle the corporation share: ${String(error && error.message || error).slice(0, 160)}`);
    }
    return finish(operation, operation.finalMessage || `Mining completed: ${operation.trips} trip(s); sold ${Number(operation.unitsSold || 0)} units for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units.`);
  }
  return block(operation, "blocked", `Unknown mining stage ${operation.stage}.`);
}

async function refineOreInHangar(operation, bot) {
  const reprocessing = require("../reprocessing");
  const registry = require("../inventory/itemTypeRegistry");
  const inventory = getInventory();
  const session = getSpace().getActorSession(bot);
  const oreStacks = inventory.listHangar(bot, operation.homeStationID)
    .filter((item) => Number((registry.resolveItemByTypeID(Number(item.typeID)) || {}).categoryID) === 25);
  if (!oreStacks.length) return { refined: {} };
  const mineralsBefore = {};
  for (const item of inventory.listHangar(bot, operation.homeStationID)) {
    mineralsBefore[String(item.typeID)] = (mineralsBefore[String(item.typeID)] || 0) + inventory.unitsOf(item);
  }
  let result;
  try {
    result = await reprocessing.reprocessItems(session, {
      itemIDs: oreStacks.map((item) => Number(item.itemID)),
      fromLocationID: operation.homeStationID,
    });
  } catch (error) {
    return { error: String(error && error.message || error).slice(0, 200) };
  }
  if (result && result.success === false) return { error: result.errorMsg || "REPROCESSING_FAILED" };
  const refined = {};
  for (const item of inventory.listHangar(bot, operation.homeStationID)) {
    const type = registry.resolveItemByTypeID(Number(item.typeID));
    if (Number(type && type.categoryID) !== 4) continue;
    refined[String(item.typeID)] = (refined[String(item.typeID)] || 0) + inventory.unitsOf(item);
  }
  for (const [typeID, units] of Object.entries(refined)) {
    refined[typeID] = Math.max(0, units - (Number(mineralsBefore[typeID]) || 0));
    if (!refined[typeID]) delete refined[typeID];
  }
  addCounts(operation.mineralsRefined, refined);
  record(operation, `Reprocessed ore at ${operation.homeStationID}; minerals ${JSON.stringify(refined)}.`);
  return { refined };
}

// Sell refined minerals (or unrefined ore) to existing local buy orders. A bid
// far below the local ask is treated as a dumping price and the stock is kept.

async function sellMiningOutput(operation, bot, stationID = operation.homeStationID) {
  // Industry bots waiting on these materials here get them first, by contract.
  try {
    const supplied = await require("./playerBotSupplyRuntime").supplyIndustryBots(bot, stationID);
    if (supplied.contracts) {
      operation.unitsSupplied = (Number(operation.unitsSupplied) || 0) + supplied.units;
      operation.proceeds = Math.round(((Number(operation.proceeds) || 0) + supplied.proceeds) * 100) / 100;
      record(operation, `Supplied ${supplied.units} units to industry in ${supplied.contracts} contract(s) for ${supplied.proceeds.toFixed(2)} ISK.`);
    }
  } catch (error) {
    record(operation, `Industry supply unavailable: ${String(error && error.message || error).slice(0, 160)}`);
  }
  const registry = require("../inventory/itemTypeRegistry");
  const trade = require("./playerBotTradeRuntime");
  const inventory = getInventory();
  if (typeof inventory.stackHangar === "function") {
    const stacked = inventory.stackHangar(bot, stationID);
    if (stacked.success && Number(stacked.mergedStacks) > 0) {
      record(operation, `Consolidated ${stacked.mergedStacks} duplicate hangar stack(s) through the inventory service before listing goods.`);
    } else if (!stacked.success) {
      record(operation, `Hangar stacking was unavailable; continuing with existing stacks: ${String(stacked.message || "unknown inventory error").slice(0, 160)}`);
    }
  }
  const stacks = inventory.listHangar(bot, stationID).filter((item) => {
    const categoryID = Number((registry.resolveItemByTypeID(Number(item.typeID)) || {}).categoryID);
    return SELLABLE_CATEGORIES.has(categoryID);
  });
  const kept = [];
  const saleReasons = [];
  for (const stack of stacks) {
    let quote;
    try {
      quote = await trade.readQuote(bot.characterName, stack.typeID);
    } catch (error) {
      const reason = `${stack.typeID}: local market unavailable (${String(error && error.message || error).slice(0, 120)}).`;
      kept.push(reason);
      saleReasons.push(reason);
      continue;
    }
    if (!quote.success) {
      const reason = `${stack.typeID}: ${quote.message}`;
      kept.push(reason);
      saleReasons.push(reason);
      continue;
    }
    const bid = quote.bestBid;
    const ask = quote.bestAsk;
    let units = inventory.unitsOf(stack);
    let attemptedBid = false;
    let bidFailureReason = "";
    if (bid && (!ask || bid.price >= ask.price * SELL_TO_BID_RATIO)) {
      attemptedBid = true;
      const result = await trade.sell(bot.characterName, stack.itemID, Math.min(units, bid.quantity), bid.price);
      if (result.success && result.sold) {
        operation.unitsSold = (Number(operation.unitsSold) || 0) + Number(result.sold);
        operation.proceeds = Math.round(((Number(operation.proceeds) || 0) + Number(result.credited || 0)) * 100) / 100;
        units = Math.max(0, units - Number(result.sold));
        if (units <= 0) continue;
      } else bidFailureReason = String(result.message || "the order did not fill");
    }
    const noBidReason = !bid
      ? `No local buy orders for ${stack.typeID} at station ${stationID}.`
      : attemptedBid
        ? `Could not fill the local buy order for ${stack.typeID}: ${bidFailureReason}.`
        : `Best local bid for ${stack.typeID} is ${Number(bid.price).toFixed(2)} ISK, below the ${Math.round(SELL_TO_BID_RATIO * 100)}% minimum of the local ask.`;
    const economy = require("./playerBotEconomyRuntime");
    const marketLocation = (typeof worldData.getStationByID === "function" && worldData.getStationByID(Number(stationID))) ||
      (typeof worldData.getStructureByID === "function" && worldData.getStructureByID(Number(stationID))) || {};
    const marketSystem = (typeof worldData.getSolarSystemByID === "function" &&
      worldData.getSolarSystemByID(Number(marketLocation.solarSystemID))) || {};
    const regionID = Number(marketLocation.regionID || marketSystem.regionID) || 0;
    const itemType = registry.resolveItemByTypeID(Number(stack.typeID)) || {};
    const pricing = typeof economy.getListingReferencePrice === "function"
      ? economy.getListingReferencePrice({
      stationID,
      regionID,
      asks: typeof economy.listSellOffers === "function" ? economy.listSellOffers(stack.typeID) : [],
      bids: typeof economy.listPlayerBuyOrders === "function"
        ? economy.listPlayerBuyOrders(100, stack.typeID, regionID) : [],
      botOwnerIDs: typeof economy.getBotOwnerIDs === "function" ? economy.getBotOwnerIDs() : new Set(),
      stationIsJita: economy.isJitaStation,
      fallbackBid: bid && bid.price,
      basePrice: itemType.basePrice,
      })
      : (Number(itemType.basePrice) > 0
        ? { price: Number(itemType.basePrice), side: "base", stationID: Number(stationID) }
        : null);
    const reference = pricing
      ? pricing.side === "ask"
        ? pricing.price * LIST_UNDERCUT
        : pricing.price * 1.05
      : 0;
    if (!reference) {
      const reason = `${noBidReason} No reference price is available, so the stock remains in the hangar.`;
      kept.push(reason);
      saleReasons.push(reason);
      continue;
    }
    const price = Math.max(bid ? bid.price * 1.01 : 0.01, Math.round(reference * 100) / 100);
    const listed = await trade.listSellOrder(bot.characterName, stack.itemID, units, price, 14);
    if (listed.success) {
      operation.unitsSold = (Number(operation.unitsSold) || 0) + Number(listed.sold || 0);
      operation.proceeds = Math.round(((Number(operation.proceeds) || 0) + Number(listed.credited || 0)) * 100) / 100;
      operation.unitsListed = (Number(operation.unitsListed) || 0) + Number(listed.listed || 0);
      operation.brokerFees = Math.round(((Number(operation.brokerFees) || 0) + Number(listed.fees || 0)) * 100) / 100;
      const jitaFillUnits = Math.max(0, Number(listed.jitaFillUnits) || 0);
      if (jitaFillUnits > 0) {
        operation.jitaPolicyViolationUnits = (Number(operation.jitaPolicyViolationUnits) || 0) + jitaFillUnits;
      }
      const referenceText = pricing
        ? ` Price reference: ${pricing.side} at station ${pricing.stationID}, excluding playerbot-owned orders.`
        : " Price reference: static item base price.";
      saleReasons.push(`${noBidReason}${referenceText} Sold ${Number(listed.sold || 0)} units and listed ${Number(listed.listed || 0)} units at ${price.toFixed(2)} ISK for ${require("./playerBotTradeRuntime").MAX_PLAYERBOT_SELL_ORDER_DAYS} days; bot listing fees were waived.${jitaFillUnits ? ` Legacy Jita-located fills: ${jitaFillUnits} units (reconciled once; new playerbot sales exclude Jita).` : ""}`);
    } else {
      const reason = `${noBidReason} Listing failed: ${listed.message}`;
      kept.push(reason);
      saleReasons.push(reason);
    }
  }
  operation.saleReason = saleReasons.join(" ").slice(0, 800);
  record(operation, `Market ${stationID}: sold ${Number(operation.unitsSold || 0)} units for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units${kept.length ? `; retained ${kept.slice(0, 3).join("; ")}` : ""}.`);
}

// ---------------------------------------------------------------- ship upgrades

// Progression ladder: each rung is bought, assembled, boarded and fitted with
// the pilot's own ISK. The previous hull stays in the hangar.
const SHIP_LADDER = Object.freeze({
  mining: [
    { name: "Venture", hullTypeID: 32880, moduleTypeIDs: [483, 483], minBalance: 600_000 },
    // Only pilots trained in Mining Barge climb to the Procurer.
    // catalogFit: the modules come from the killmail catalog (two strip miners
    // instead of the single hard-coded one), see applyCatalogFit.
    { name: "Mining barge", hullTypeID: 17480, hullChoices: [17478, 17476, 17480], catalogFit: true, moduleTypeIDs: [17482], minBalance: 60_000_000, requiredSkills: [[17940, 1]] },
    // Tech II barge: Exhumers 1 implies Mining Barge 5 through its prerequisites.
    { name: "Mackinaw", hullTypeID: 22548, catalogFit: true, moduleTypeIDs: [], minBalance: 250_000_000, requiredSkills: [[22551, 1]] },
  ],
  security: [
    {
      name: "Tristan combat fit (site tier 1)", hullTypeID: 593,
      moduleTypeIDs: ["Damage Control I", "Drone Damage Amplifier I", "Shield Power Relay I", "Small Shield Extender I", "Small Shield Extender I", "EM Shield Amplifier I"],
      droneTypeIDs: ["Acolyte I", "Hobgoblin I", "Hornet I", "Warrior I", "Hobgoblin I"],
      droneDamageByName: { "Acolyte I": "em", "Hobgoblin I": "thermal", "Hornet I": "kinetic", "Warrior I": "explosive" },
      maxSiteDifficulty: 1, maxWaveHostiles: 5, maxWaveThreatScore: 10, maxSiteWaves: 5, minBalance: 10_000_000,
    },
    {
      name: "Algos combat fit (site tier 2)", hullTypeID: 32872,
      moduleTypeIDs: ["Damage Control I", "Drone Damage Amplifier I", "Shield Power Relay I", "Small Shield Extender I", "EM Shield Amplifier I", "Thermal Shield Amplifier I"],
      droneTypeIDs: ["Acolyte I", "Hobgoblin I", "Hornet I", "Warrior I", "Hobgoblin I"],
      droneDamageByName: { "Acolyte I": "em", "Hobgoblin I": "thermal", "Hornet I": "kinetic", "Warrior I": "explosive" },
      maxSiteDifficulty: 2, maxWaveHostiles: 8, maxWaveThreatScore: 16, maxSiteWaves: 6,
      minBalance: 20_000_000, minEarnedProfit: 15_000_000, bootstrapStarter: true,
    },
    {
      name: "Vexor combat fit (site tier 3)", hullTypeID: 626,
      moduleTypeIDs: ["Damage Control I", "Drone Damage Amplifier I", "Drone Damage Amplifier I", "Shield Power Relay I", "Shield Power Relay I", "Medium Shield Extender I", "Medium Shield Extender I", "EM Shield Amplifier I", "Thermal Shield Amplifier I"],
      droneTypeIDs: ["Infiltrator I", "Hammerhead I", "Vespa I", "Valkyrie I", "Hammerhead I"],
      droneDamageByName: { "Infiltrator I": "em", "Hammerhead I": "thermal", "Vespa I": "kinetic", "Valkyrie I": "explosive" },
      maxSiteDifficulty: 3, maxWaveHostiles: 10, maxWaveThreatScore: 24, maxSiteWaves: 8, bootstrapStarter: true,
      minBalance: 60_000_000, minEarnedProfit: 50_000_000,
    },
    {
      name: "Myrmidon combat fit (site tier 4)", hullTypeID: 24700,
      moduleTypeIDs: ["Damage Control I", "Drone Damage Amplifier I", "Drone Damage Amplifier I", "Drone Damage Amplifier I", "Shield Power Relay I", "Shield Power Relay I", "Medium Shield Extender II", "Medium Shield Extender II", "Medium Shield Extender II", "EM Shield Amplifier II", "Thermal Shield Amplifier II"],
      droneTypeIDs: ["Infiltrator I", "Hammerhead I", "Vespa I", "Valkyrie I", "Hammerhead I"],
      droneDamageByName: { "Infiltrator I": "em", "Hammerhead I": "thermal", "Vespa I": "kinetic", "Valkyrie I": "explosive" },
      maxSiteDifficulty: 4, maxWaveHostiles: 14, maxWaveThreatScore: 36, maxSiteWaves: 10,
      minBalance: 250_000_000, minEarnedProfit: 150_000_000,
    },
    {
      name: "Dominix combat fit (site tier 5)", hullTypeID: 645,
      moduleTypeIDs: ["Damage Control I", "Drone Damage Amplifier I", "Drone Damage Amplifier I", "Drone Damage Amplifier I", "Shield Power Relay I", "Shield Power Relay I", "Shield Power Relay I", "Large Shield Extender I", "Large Shield Extender I", "Large Shield Extender I", "EM Shield Amplifier II", "Thermal Shield Amplifier II"],
      droneTypeIDs: ["Infiltrator I", "Hammerhead I", "Vespa I", "Valkyrie I", "Hammerhead I"],
      droneDamageByName: { "Infiltrator I": "em", "Hammerhead I": "thermal", "Vespa I": "kinetic", "Valkyrie I": "explosive" },
      maxSiteDifficulty: 5, maxWaveHostiles: 20, maxWaveThreatScore: 60, maxSiteWaves: 12,
      minBalance: 500_000_000, minEarnedProfit: 350_000_000,
    },
  ],
  piracy: [
    {
      name: "Tristan piracy fit", hullTypeID: 593,
      moduleTypeIDs: ["Damage Control I", "Drone Damage Amplifier I", "Shield Power Relay I", "Small Shield Extender I", "Small Shield Extender I", "EM Shield Amplifier I"],
      droneTypeIDs: ["Acolyte I", "Hobgoblin I", "Hornet I", "Warrior I", "Hobgoblin I"],
      droneDamageByName: { "Acolyte I": "em", "Hobgoblin I": "thermal", "Hornet I": "kinetic", "Warrior I": "explosive" },
      minBalance: 10_000_000,
    },
    {
      name: "Algos piracy fit", hullTypeID: 32872,
      moduleTypeIDs: ["Damage Control I", "Drone Damage Amplifier I", "Shield Power Relay I", "Small Shield Extender I", "EM Shield Amplifier I", "Thermal Shield Amplifier I"],
      droneTypeIDs: ["Acolyte I", "Hobgoblin I", "Hornet I", "Warrior I", "Hobgoblin I"],
      droneDamageByName: { "Acolyte I": "em", "Hobgoblin I": "thermal", "Hornet I": "kinetic", "Warrior I": "explosive" },
      minBalance: 20_000_000,
    },
  ],
  sovereignty: [
    { name: "Tristan sovereignty fit", hullTypeID: 593, moduleTypeIDs: [34593], droneTypeIDs: [], cargoTypeIDs: Array(24).fill(16275), minBalance: 10_000_000 },
  ],
  logistics: [
    // Upwell medium structure packages are 8,000 m³. The Tayra has a 7,300 m³
    // base hold, four low slots, and a trained hull bonus; the inventory broker
    // still verifies the live hold before the package is loaded.
    { name: "Tayra structure hauler", hullTypeID: 649, moduleTypeIDs: [1319, 1319, 1319, 1319], minBalance: 25_000_000 },
  ],
});

function resolveLadderTypeID(value) {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  const registry = require("../inventory/itemTypeRegistry");
  const resolved = registry.resolveItemByName(String(value || ""), { exactOnly: true });
  return resolved && resolved.success === true ? Number(resolved.match.typeID) || 0 : 0;
}

function resolveShipLadderRung(rung) {
  if (!rung) return null;
  const hullTypeID = resolveLadderTypeID(rung.hullTypeID);
  const hullChoices = [...new Set(
    [hullTypeID, ...(rung.hullChoices || []).map(resolveLadderTypeID)].filter((id) => id > 0),
  )];
  const moduleTypeIDs = (rung.moduleTypeIDs || []).map(resolveLadderTypeID);
  const droneTypeIDs = (rung.droneTypeIDs || []).map(resolveLadderTypeID);
  const cargoTypeIDs = (rung.cargoTypeIDs || []).map(resolveLadderTypeID);
  if (!hullTypeID || moduleTypeIDs.includes(0) || droneTypeIDs.includes(0) || cargoTypeIDs.includes(0)) return null;
  const droneDamageTypeByID = {};
  for (const [name, damageType] of Object.entries(rung.droneDamageByName || {})) {
    const typeID = resolveLadderTypeID(name);
    if (typeID) droneDamageTypeByID[typeID] = damageType;
  }
  return { ...rung, hullTypeID, hullChoices, moduleTypeIDs, droneTypeIDs, cargoTypeIDs, droneDamageTypeByID };
}

// A rung can name several hulls of the same tier. Matching by hullTypeID alone
// would treat a Retriever pilot as off-ladder and send it back to a Venture.
function rungIndexOfHull(ladder, hullTypeID) {
  const hull = Number(hullTypeID) || 0;
  if (!hull) return -1;
  return ladder.findIndex((rung) =>
    Number(rung.hullTypeID) === hull || (rung.hullChoices || []).includes(hull));
}

// Deterministic per pilot, so training, purchasing and refitting agree.
function rungHullForPilot(bot, rung) {
  const choices = (rung && rung.hullChoices || []).filter((id) => Number(id) > 0);
  if (choices.length <= 1) return Number(rung && rung.hullTypeID) || 0;
  const seed = Math.abs(Math.trunc(Number(bot && bot.characterID) || 0));
  return choices[seed % choices.length];
}

// The skills the static data requires to fly a hull or fit a module.
function requiredSkillsForType(typeID) {
  const fitting = require("../fitting/liveFittingState");
  const required = [];
  for (let index = 1; index <= 6; index += 1) {
    const skillTypeID = Number(fitting.getTypeAttributeValue(typeID, `requiredSkill${index}`)) || 0;
    const level = Number(fitting.getTypeAttributeValue(typeID, `requiredSkill${index}Level`)) || 0;
    if (skillTypeID > 0) required.push([skillTypeID, Math.max(1, level)]);
  }
  return required;
}

// Returns the next rung above the pilot's current hull when that rung is
// blocked by untrained skills, so the director can queue training instead of
// silently returning null. Returns null when there is no next rung or when the
// pilot already satisfies every requirement.
function nextShipUpgradeSkillGap(bot, role) {
  const character = getCharacterRecord(bot && bot.characterID) || {};
  const ladder = (SHIP_LADDER[role] || []).map(resolveShipLadderRung).filter(Boolean);
  const currentHull = Number(character.shipTypeID) || 0;
  const currentIndex = rungIndexOfHull(ladder, currentHull);
  const next = ladder[currentIndex + 1] || null;
  if (!next) return null;
  if (canUseRung(bot, next) && hasSkills(bot, next.requiredSkills)) return null;
  return next;
}

function getCombatShipSkillRequirements(role) {
  const requirements = new Map();
  for (const rung of (SHIP_LADDER[role] || []).map(resolveShipLadderRung).filter(Boolean)) {
    for (const typeID of [rung.hullTypeID, ...(rung.moduleTypeIDs || []), ...(rung.droneTypeIDs || [])]) {
      for (const [skillTypeID, level] of requiredSkillsForType(typeID)) {
        requirements.set(skillTypeID, Math.max(requirements.get(skillTypeID) || 0, level));
      }
    }
  }
  return [...requirements.entries()];
}

function getShipRungSkillRequirements(role, hullTypeID) {
  const ladder = (SHIP_LADDER[role] || []).map(resolveShipLadderRung).filter(Boolean);
  const index = rungIndexOfHull(ladder, hullTypeID);
  const rung = index >= 0 ? ladder[index] : null;
  if (!rung) return [];
  const requirements = new Map();
  for (const typeID of [rung.hullTypeID, ...(rung.moduleTypeIDs || []),
    ...(rung.droneTypeIDs || []), ...(rung.fighterTypeIDs || [])]) {
    for (const [skillTypeID, level] of requiredSkillsForType(typeID)) {
      requirements.set(skillTypeID, Math.max(requirements.get(skillTypeID) || 0, level));
    }
  }
  return [...requirements.entries()];
}

function canUseRung(bot, rung) {
  return [rung.hullTypeID, ...(rung.moduleTypeIDs || []), ...(rung.droneTypeIDs || []), ...(rung.fighterTypeIDs || [])]
    .every((typeID) => hasSkills(bot, requiredSkillsForType(typeID)));
}

function hasSkills(bot, requiredSkills = []) {
  if (!requiredSkills.length) return true;
  const skillState = require("../skills/skillState");
  // This is a read-only decision path. Reuse the shared versioned map so the
  // director does not deep-clone every trained skill on each upgrade check.
  const getSkillMap = skillState.getCachedCharacterSkillMap || skillState.getCharacterSkillMap;
  const map = getSkillMap(bot.characterID);
  return requiredSkills.every(([typeID, level]) => {
    const record = map && (map.get ? map.get(typeID) : map[typeID]);
    return (Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0) >= level;
  });
}

function selectBootstrapRung(role, currentIndex, balance, ladder = SHIP_LADDER[role] || [], bot = null) {
  if (role !== "security" || currentIndex >= 0) return null;
  const starter = ladder
    .filter((rung) => rung.bootstrapStarter === true && Number(balance) >= Number(rung.minBalance))
    .filter((rung) => {
      if (!bot) return true;
      const resolved = resolveShipLadderRung(rung);
      return Boolean(resolved && canUseRung(bot, resolved));
    })
    .sort((left, right) => Number(right.maxSiteDifficulty) - Number(left.maxSiteDifficulty))[0] || null;
  if (!starter) return null;
  return { ...starter, minEarnedProfit: 0 };
}

// Hand-written mining rungs carry a single module; the killmail catalog carries
// a full fit (two strip miners). Swap in the catalog fit for this pilot so the
// hull is bought and flown with what actually mines. Deterministic per pilot,
// so the replenish check and the upgrade decision always agree.
function applyCatalogFit(bot, rung) {
  if (!rung || rung.catalogFit !== true) return rung;
  // A rung may offer several hulls of the same tier. A pilot already flying
  // one of them keeps it; otherwise the pilot picks one deterministically and
  // the fit is planned for that hull.
  const currentHull = Number((getCharacterRecord(bot && bot.characterID) || {}).shipTypeID) || 0;
  const hullTypeID = (rung.hullChoices || []).includes(currentHull)
    ? currentHull
    : (rungHullForPilot(bot, rung) || rung.hullTypeID);
  const fit = require("./playerBotFitPlanner").oreFitForPilot(
    hullTypeID, bot && bot.characterID, { maxISK: Number(rung.minBalance) || 0 });
  if (!fit || !fit.plan) return { ...rung, hullTypeID };
  return {
    ...rung,
    hullTypeID,
    name: `${rung.name} (${fit.name})`,
    moduleTypeIDs: [...(fit.plan.moduleTypeIDs || [])],
    droneTypeIDs: [...(fit.plan.droneTypeIDs || [])],
    fitCargoPlan: [...(fit.plan.cargoPlan || [])],
    catalogIndex: fit.catalogIndex,
  };
}

// Raw next rung above the pilot's hull, ignoring skill and price gates. The
// training path targets this, so a pilot prepares for the upgrade before it can
// fly it. Off-ladder hulls resolve to the first rung of the ladder.
function nextShipRungForTraining(bot, role) {
  const character = getCharacterRecord(bot && bot.characterID) || {};
  const currentHull = Number(character.shipTypeID) || 0;
  const ladder = (SHIP_LADDER[role] || []).map(resolveShipLadderRung).filter(Boolean);
  const currentIndex = rungIndexOfHull(ladder, currentHull);
  return ladder[currentIndex + 1] || null;
}

function nextShipUpgrade(bot, role = "mining", options = {}) {
  const character = getCharacterRecord(bot.characterID) || {};
  const currentHull = Number(character.shipTypeID) || 0;
  const ladder = (SHIP_LADDER[role] || []).map(resolveShipLadderRung).filter(Boolean);
  const currentIndex = rungIndexOfHull(ladder, currentHull);
  const currentRung = currentIndex >= 0 ? applyCatalogFit(bot, ladder[currentIndex]) : null;
  if (currentRung && ((currentRung.moduleTypeIDs || []).length || (currentRung.droneTypeIDs || []).length || (currentRung.cargoTypeIDs || []).length)) {
    const itemStore = require("../inventory/itemStore");
    const shipID = Number(character.shipID) || 0;
    const fitted = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
      .filter((item) => Number(item.flagID) >= 11 && Number(item.flagID) <= 34);
    const fittedModuleCounts = new Map();
    for (const item of fitted) fittedModuleCounts.set(Number(item.typeID), (fittedModuleCounts.get(Number(item.typeID)) || 0) + 1);
    const requiredModuleCounts = new Map();
    for (const typeID of currentRung.moduleTypeIDs || []) requiredModuleCounts.set(Number(typeID), (requiredModuleCounts.get(Number(typeID)) || 0) + 1);
    const missingModule = [...requiredModuleCounts].some(([typeID, count]) => (fittedModuleCounts.get(typeID) || 0) < count);
    const liveFitting = require("../fitting/liveFittingState");
    const offlineModule = [...requiredModuleCounts].some(([typeID, count]) =>
      fitted.filter((item) => Number(item.typeID) === typeID).slice(0, count)
        .some((item) => !liveFitting.isEffectivelyOnlineModule(item)));
    const cargo = itemStore.listCharacterItems(bot.characterID, {
      locationID: shipID,
      flagID: itemStore.ITEM_FLAGS.CARGO_HOLD,
    });
    const cargoCounts = new Map();
    for (const item of cargo) cargoCounts.set(Number(item.typeID), (cargoCounts.get(Number(item.typeID)) || 0) + getInventory().unitsOf(item));
    const requiredCargo = new Map();
    for (const typeID of currentRung.cargoTypeIDs || []) requiredCargo.set(typeID, (requiredCargo.get(typeID) || 0) + 1);
    const missingCargo = [...requiredCargo].some(([typeID, count]) => (cargoCounts.get(typeID) || 0) < count);
    const bay = itemStore.listCharacterItems(bot.characterID, {
      locationID: shipID,
      flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
    });
    const counts = new Map();
    for (const item of bay) counts.set(Number(item.typeID), (counts.get(Number(item.typeID)) || 0) + getInventory().unitsOf(item));
    const required = new Map();
    for (const typeID of currentRung.droneTypeIDs || []) required.set(typeID, (required.get(typeID) || 0) + 1);
    const needsDrones = [...required].some(([typeID, count]) => (counts.get(typeID) || 0) < count);
    if ((needsDrones || missingModule || offlineModule || missingCargo) && canUseRung(bot, currentRung)) return { ...currentRung, replenishOnly: true };
  }
  // The seeded capital exists so security pilots can start in a cruiser that
  // can hold a researched anomaly wave. Buying a Tristan first strands the
  // pilot behind profit gates before it can survive even a beginner site.
  if (role === "security" && currentIndex < 0) {
    const balance = Number.isFinite(Number(options.balanceOverride))
      ? Math.max(0, Number(options.balanceOverride))
      : Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
    const starter = selectBootstrapRung(role, currentIndex, balance, ladder, bot);
    const fittedStarter = starter ? applyCatalogFit(bot, starter) : null;
    if (fittedStarter && hasSkills(bot, fittedStarter.requiredSkills) && canUseRung(bot, fittedStarter)) {
      return fittedStarter;
    }
  }
  const next = ladder[currentIndex + 1] || null;
  const fittedNext = next ? applyCatalogFit(bot, next) : null;
  return fittedNext && hasSkills(bot, fittedNext.requiredSkills) && canUseRung(bot, fittedNext)
    ? fittedNext
    : null;
}

function startCombatReplenishment(combatOperation, bot) {
  const role = combatOperation.mode === "piracy" ? "piracy" : "security";
  const rung = nextShipUpgrade(bot, role);
  if (!rung || rung.replenishOnly !== true) return null;

  const wallet = require("../account/walletState").getCharacterWallet(bot.characterID);
  const balance = Math.max(0, Number(wallet && wallet.balance) || 0);
  if (!balance) return null;

  const upgrade = buildCombatReplenishmentOperation(combatOperation, bot, rung,
    findUpgradeMarketStation(bot, rung), balance);
  record(upgrade, `Replacing missing combat-fit parts for ${upgrade.resumeCombat.siteLabel || "the active anomaly"}; the original site will resume after fitting.`);
  saveOperation(upgrade);
  return upgrade;
}

function buildCombatReplenishmentOperation(combatOperation, bot, rung, marketStationID, balance) {
  const role = combatOperation.mode === "piracy" ? "piracy" : "security";
  const resumeCombat = structuredClone(combatOperation);
  Object.assign(resumeCombat, {
    kind: "combat",
    status: "active",
    stage: "to-home",
    routeTaskID: null,
    tripStartedAt: null,
    targetID: null,
    pendingCombatAction: null,
    lastDestroyedTargetID: null,
    wreckMissingSinceAt: null,
    emergencyRetreat: false,
    siteAbandoned: false,
    siteIncomplete: true,
    siteFailureReason: "combat-fit-replenishment",
  });
  const upgrade = baseOperation("upgrade", bot, {
    stage: "to-market",
    role,
    name: rung.name,
    hullTypeID: rung.hullTypeID,
    moduleTypeIDs: [...(rung.moduleTypeIDs || [])],
    droneTypeIDs: [...(rung.droneTypeIDs || [])],
    cargoTypeIDs: [...(rung.cargoTypeIDs || [])],
    replenishOnly: true,
    marketStationID: normalizePositiveInteger(marketStationID),
    maxSpend: Math.round(balance * 100) / 100,
    spent: 0,
    pending: null,
    newShipID: null,
    autonomous: true,
    resumeCombat,
  });
  return upgrade;
}

function prepareResumedCombat(upgrade) {
  if (!upgrade || !upgrade.resumeCombat || upgrade.resumeCombat.kind !== "combat") return null;
  const resumed = upgrade.resumeCombat;
  resumed.status = "active";
  resumed.stage = "to-home";
  resumed.routeTaskID = null;
  resumed.spent = Math.round(((Number(resumed.spent) || 0) + (Number(upgrade.spent) || 0)) * 100) / 100;
  resumed.siteIncomplete = true;
  resumed.siteAbandoned = false;
  return resumed;
}

function getUpgradePackageNeeds(rung) {
  if (!rung) return [];
  const counts = new Map();
  if (rung.replenishOnly !== true && Number(rung.hullTypeID) > 0) counts.set(Number(rung.hullTypeID), 1);
  for (const typeID of [
    ...(rung.moduleTypeIDs || []),
    ...(rung.droneTypeIDs || []),
    ...(rung.fighterTypeIDs || []),
    ...(rung.cargoTypeIDs || []),
  ]) {
    const numericTypeID = Number(typeID) || 0;
    if (numericTypeID) counts.set(numericTypeID, (counts.get(numericTypeID) || 0) + 1);
  }
  for (const entry of Array.isArray(rung.fitCargoPlan) ? rung.fitCargoPlan : []) {
    const typeID = Number(entry && entry.typeID) || 0;
    const quantity = Math.max(0, Math.trunc(Number(entry && entry.quantity) || 0));
    if (typeID && quantity) counts.set(typeID, (counts.get(typeID) || 0) + quantity);
  }
  return [...counts].map(([typeID, quantity]) => ({ typeID, quantity }));
}

function findUpgradeMarketStation(bot, rungOrOperation) {
  const needs = getUpgradePackageNeeds(rungOrOperation);
  if (!needs.length) return hubStationFor(bot);
  const economy = require("./playerBotEconomyRuntime");
  const candidates = economy.findSellStationsForPackage(needs);
  if (!candidates.length) return hubStationFor(bot);
  const outsideJita = candidates.filter((candidate) => !candidate.isJita);
  const preferred = outsideJita.length ? outsideJita : candidates.filter((candidate) => candidate.isJita);
  const stationCandidatesBySystem = new Map();
  for (const candidate of preferred) {
    const station = worldData.getStationByID(Number(candidate.stationID));
    if (!station) continue;
    const systemID = Number(station.solarSystemID) || 0;
    const system = worldData.getSolarSystemByID(systemID) || {};
    if (!systemID || Number(system.security) < 0.45) continue;
    if (!stationCandidatesBySystem.has(systemID)) stationCandidatesBySystem.set(systemID, []);
    stationCandidatesBySystem.get(systemID).push({ ...candidate, systemID, security: Number(system.security) || 0 });
  }
  const routeCandidates = [];
  for (const [systemID, systemCandidates] of stationCandidatesBySystem) {
    systemCandidates.sort((left, right) =>
      Number(right.complete) - Number(left.complete) ||
      right.coverage - left.coverage ||
      left.estimatedCost - right.estimatedCost ||
      left.stationID - right.stationID);
    const candidate = systemCandidates[0];
    const route = require("./playerBotSpaceRuntime").previewSystemRoute(bot, systemID);
    if (!route.success || (route.risk && (
      (Array.isArray(route.risk.lowsecSystemIDs) && route.risk.lowsecSystemIDs.length) ||
      (Array.isArray(route.risk.nullsecSystemIDs) && route.risk.nullsecSystemIDs.length)
    ))) continue;
    routeCandidates.push({ ...candidate, hops: Number(route.hops) || 0 });
  }
  routeCandidates.sort((left, right) =>
    Number(right.complete) - Number(left.complete) ||
    right.coverage - left.coverage ||
    left.hops - right.hops ||
    right.security - left.security ||
    left.estimatedCost - right.estimatedCost ||
    left.stationID - right.stationID);
  return Number(routeCandidates[0] && routeCandidates[0].stationID) || hubStationFor(bot);
}

function retargetUnpurchasedUpgrade(characterID, stationID) {
  const id = normalizePositiveInteger(characterID);
  const destinationID = normalizePositiveInteger(stationID);
  if (!id || !destinationID || runningBots.has(id)) return { success: false, reason: "action-in-progress" };
  const operation = getOperation(id);
  if (!operation || operation.kind !== "upgrade" || !ACTIVE_STATUSES.has(operation.status) ||
      operation.pending || Number(operation.spent) > 0 || Number(operation.newShipID) > 0 ||
      !["to-market", "buy"].includes(operation.stage)) return { success: false, reason: "upgrade-not-retargetable" };
  if (Number(operation.marketStationID) === destinationID) return { success: true, unchanged: true, operation };
  if (operation.routeTaskID) {
    const task = getTasks().getTask(operation.routeTaskID);
    if (task && task.status === "running") return { success: false, reason: "route-in-progress" };
    if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
  }
  operation.marketStationID = destinationID;
  operation.stage = "to-market";
  operation.routeTaskID = null;
  record(operation, `Changed the unpurchased upgrade destination to station ${destinationID}, where market supply is available.`);
  saveOperation(operation);
  return { success: true, operation };
}

function queueUpgradeForMarketCapacity(characterID, reason, retryAfterAtMs = Date.now() + 5 * 60 * 1000) {
  const id = normalizePositiveInteger(characterID);
  if (!id || runningBots.has(id)) return { success: false, reason: "action-in-progress" };
  const operation = getOperation(id);
  if (!operation || operation.kind !== "upgrade" || !ACTIVE_STATUSES.has(operation.status) ||
      operation.pending || Number(operation.spent) > 0 || Number(operation.newShipID) > 0 ||
      operation.modulesInTransit || !["to-market", "buy"].includes(operation.stage)) {
    return { success: false, reason: "upgrade-not-queueable" };
  }
  if (operation.routeTaskID) {
    const task = getTasks().getTask(operation.routeTaskID);
    if (task && task.status === "running") return { success: false, reason: "route-in-progress" };
    if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
  }
  operation.status = "stopped";
  operation.loadSheddingPaused = false;
  delete operation.loadSheddingPausedAtMs;
  delete operation.loadSheddingPauseReason;
  operation.routeTaskID = null;
  operation.marketCapacityRetryAtMs = Math.max(Date.now() + 30_000, Number(retryAfterAtMs) || 0);
  record(operation, `${reason} The purchase has not started; the pilot can resume productive work while waiting for market capacity.`);
  saveOperation(operation);
  return { success: true, operation };
}

function hasRoleShipFit(bot, role, options = {}) {
  const ladder = (SHIP_LADDER[role] || []).map(resolveShipLadderRung).filter(Boolean);
  const character = getCharacterRecord(bot && bot.characterID) || {};
  const index = rungIndexOfHull(ladder, character.shipTypeID);
  const rung = index >= 0 ? ladder[index] : null;
  if (!rung || !canUseRung(bot, rung)) return false;
  const itemStore = require("../inventory/itemStore");
  const fitting = require("../fitting/liveFittingState");
  const shipID = Number(character.shipID) || 0;
  const fitted = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
    .filter((item) => fitting.isFittedModuleItem(item));
  const fittedCounts = new Map();
  for (const item of fitted) fittedCounts.set(Number(item.typeID), (fittedCounts.get(Number(item.typeID)) || 0) + 1);
  for (const typeID of rung.moduleTypeIDs || []) {
    const candidates = fitted.filter((item) => Number(item.typeID) === Number(typeID));
    const count = fittedCounts.get(Number(typeID)) || 0;
    if (count <= 0) return false;
    fittedCounts.set(Number(typeID), count - 1);
    const module = candidates[candidates.length - count];
    if (module && !fitting.isEffectivelyOnlineModule(module)) return false;
  }
  const bay = itemStore.listCharacterItems(bot.characterID, {
    locationID: shipID,
    flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
  });
  // Launched drones belong to this fit too. Read the live scene rather than
  // treating a normal launch as a missing-drone casualty on the next hit.
  let entity = null;
  let deployedDrones = [];
  if (["security", "piracy"].includes(role)) {
    try {
      const space = require("./playerBotSpaceRuntime");
      if (space.getSpaceState(bot).inSpace) {
        const attached = space.getActorSpace(bot);
        entity = attached.entity;
        deployedDrones = [...attached.scene.dynamicEntities.values()].filter((drone) =>
          drone.kind === "drone" && Number(drone.controllerID) === shipID);
      }
    } catch (_) {
      // A docked ship is checked from its persisted bay and Dogma attributes.
    }
  }
  const availableDrones = [...bay, ...deployedDrones.map((drone) => ({ ...drone, stacksize: 1, quantity: 1 }))];
  const droneCounts = new Map();
  for (const item of availableDrones) droneCounts.set(Number(item.typeID), (droneCounts.get(Number(item.typeID)) || 0) + getInventory().unitsOf(item));
  const requiredDrones = new Map();
  for (const typeID of rung.droneTypeIDs || []) requiredDrones.set(Number(typeID), (requiredDrones.get(Number(typeID)) || 0) + 1);
  if (options.allowPartialDrones === true) {
    if (![...requiredDrones].some(([typeID]) => (droneCounts.get(typeID) || 0) > 0)) return false;
  } else if ([...requiredDrones].some(([typeID, quantity]) => (droneCounts.get(typeID) || 0) < quantity)) return false;
  const cargo = itemStore.listCharacterItems(bot.characterID, {
    locationID: shipID,
    flagID: itemStore.ITEM_FLAGS.CARGO_HOLD,
  });
  const cargoCounts = new Map();
  for (const item of cargo) cargoCounts.set(Number(item.typeID), (cargoCounts.get(Number(item.typeID)) || 0) + getInventory().unitsOf(item));
  const requiredCargo = new Map();
  for (const typeID of rung.cargoTypeIDs || []) requiredCargo.set(Number(typeID), (requiredCargo.get(Number(typeID)) || 0) + 1);
  if ([...requiredCargo].some(([typeID, quantity]) => (cargoCounts.get(typeID) || 0) < quantity)) return false;
  if (["security", "piracy"].includes(role)) {
    const requiredDroneTypes = new Map();
    for (const typeID of rung.droneTypeIDs || []) requiredDroneTypes.set(Number(typeID), (requiredDroneTypes.get(Number(typeID)) || 0) + 1);
    if (options.allowPartialDrones === true) {
      for (const [typeID, quantity] of requiredDroneTypes) requiredDroneTypes.set(typeID, Math.min(quantity, droneCounts.get(typeID) || 0));
    }
    const shipItem = itemStore.findItemById(shipID) || {};
    entity ||= {
      itemID: shipID,
      typeID: Number(character.shipTypeID),
      capacitorChargeRatio: 1,
      conditionState: shipItem.conditionState || { shieldCharge: 1, armorDamage: 0, damage: 0 },
    };
    const fitResult = require("./playerBotCombatFitRuntime").buildCombatFitSnapshot(bot, entity, {
      maxSiteDifficulty: Number(rung.maxSiteDifficulty) || 0,
      requiredDroneTypes,
      droneDamageTypeByID: rung.droneDamageTypeByID,
      deployedDrones,
    });
    if (!fitResult.success || fitResult.fit.ready !== true) return false;
  }
  return true;
}

function getRoleShipFitProfile(bot, role) {
  const character = getCharacterRecord(bot && bot.characterID) || {};
  const rung = (SHIP_LADDER[role] || []).map(resolveShipLadderRung).filter(Boolean)
    .find((entry) => Number(entry.hullTypeID) === Number(character.shipTypeID));
  if (!rung) return null;
  const itemStore = require("../inventory/itemStore");
  const shipID = Number(character.shipID) || 0;
  const shipItem = itemStore.findItemById(shipID) || {};
  const entity = {
    itemID: shipID,
    typeID: Number(character.shipTypeID),
    capacitorChargeRatio: 1,
    conditionState: shipItem.conditionState || { shieldCharge: 1, armorDamage: 0, damage: 0 },
  };
  const fitSnapshot = require("./playerBotCombatFitRuntime").buildCombatFitSnapshot(bot, entity, {
    maxSiteDifficulty: Number(rung.maxSiteDifficulty) || 0,
    requiredDroneTypes: (rung.droneTypeIDs || []).reduce((counts, typeID) => {
      counts.set(Number(typeID), (counts.get(Number(typeID)) || 0) + 1);
      return counts;
    }, new Map()),
    droneDamageTypeByID: rung.droneDamageTypeByID,
  });
  return {
    ...rung,
    shieldResistances: fitSnapshot.success ? fitSnapshot.fit.shieldResistances : {},
    requiredDroneTypes: (rung.droneTypeIDs || []).reduce((counts, typeID) => {
      counts.set(Number(typeID), (counts.get(Number(typeID)) || 0) + 1);
      return counts;
    }, new Map()),
  };
}

async function buyUnits(operation, bot, typeID, needed, stationID = operation.marketStationID) {
  const trade = require("./playerBotTradeRuntime");
  const economy = require("./playerBotEconomyRuntime");
  if (typeof economy.isJitaStation === "function" && economy.isJitaStation(stationID)) {
    const regional = await trade.readBestAskOutsideJita(bot.characterName, typeID, 1, Number(stationID));
    if (!regional.success) {
      return { error: regional.message || `Could not verify non-Jita supply for ${typeID} before buying at Jita.` };
    }
    if (regional.bestAsk) {
      return {
        unavailable: true,
        sourceAvailable: true,
        sourceStationID: Number(regional.bestAsk.stationID),
        error: `Type ${typeID} is available outside Jita at ${regional.bestAsk.stationID}; using that stock first.`,
      };
    }
  }
  const quote = await trade.readQuote(bot.characterName, typeID);
  if (!quote.success) return { error: quote.message || `Could not query the market for ${typeID} at ${stationID}.` };
  if (!quote.bestAsk) {
    const regional = await trade.readBestAskOutsideJita(bot.characterName, typeID, 1, Number(stationID));
    if (!regional.success) return { error: regional.message || `Could not verify regional supply for ${typeID}.` };
    const isJitaSource = typeof economy.isJitaStation === "function" && economy.isJitaStation(stationID);
    const jitaSeedStationID = typeof economy.findBestJitaSeedStation === "function"
      ? Number(economy.findBestJitaSeedStation([{ typeID, quantity: needed }], isJitaSource ? [stationID] : [])) || 0
      : 0;
    const jita = Number(economy.JITA_BUY_STATION_ID) || 0;
    return {
      unavailable: true,
      sourceAvailable: Boolean(regional.bestAsk || jitaSeedStationID || (!isJitaSource && jita)),
      sourceStationID: Number(regional.bestAsk && regional.bestAsk.stationID) || jitaSeedStationID || (isJitaSource ? 0 : jita),
      error: `No sell orders for ${typeID} at ${stationID}${jitaSeedStationID && isJitaSource ? `; trying stocked Jita station ${jitaSeedStationID}` : ""}.`,
    };
  }
  const price = quote.bestAsk.price;
  const remaining = operation.maxSpend - operation.spent;
  const quantity = Math.min(needed, quote.bestAsk.quantity, Math.floor((remaining + 0.0001) / price));
  if (quantity <= 0) return { error: `The ${operation.maxSpend.toFixed(2)} ISK limit does not cover ${typeID} at ${price.toFixed(2)} ISK per unit.` };
  operation.pending = {
    action: "buy",
    typeID,
    quantity,
    stationID: Number(stationID),
    quotedPrice: Number(price),
    baselineUnits: getInventory().countHangar(bot, stationID, typeID) +
      getInventory().countCargo(bot, typeID),
    baselineBalance: Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0,
    startedAt: new Date().toISOString(),
  };
  saveOperation(operation);
  const result = await trade.buy(bot.characterName, typeID, quantity, price);
  if (!result.success && result.outcomeUnknown) return { review: result.message };
  const spent = Number(result.spent ?? result.observedSpent) || 0;
  operation.spent = Math.round((operation.spent + spent) * 100) / 100;
  const bought = Number(result.bought) || 0;
  if (result.success && bought <= 0 && spent > 0) {
    // The market reported a successful request and charged the wallet but no
    // matching item appeared in inventory. Preserve the pending marker for
    // operator reconciliation; never retry or release this uncertain spend.
    operation.pending = { ...operation.pending, outcomeUnknown: true };
    saveOperation(operation);
    return { review: `The market charged ${spent.toFixed(2)} ISK for ${typeID} but no units appeared in the hangar; verify the wallet and inventory before retrying.` };
  }
  operation.pending = null;
  if (!result.success && result.sourceAvailable) {
    saveOperation(operation);
    return { unavailable: true, sourceAvailable: true, sourceStationID: Number(result.sourceStationID), error: result.message };
  }
  if (!result.success) return { error: result.message };
  if (bought > 0) return { bought, spent };

  const regional = await trade.readBestAskOutsideJita(bot.characterName, typeID, 1, Number(stationID));
  if (!regional.success) {
    return {
      unavailable: true,
      error: `The market quote for ${typeID} at ${stationID} delivered no units, and non-Jita stock could not be checked: ${regional.message || "unknown market error"}`,
    };
  }
  const jita = require("./playerBotEconomyRuntime").JITA_BUY_STATION_ID;
  if (regional.bestAsk) {
    return {
      unavailable: true,
      sourceAvailable: true,
      sourceStationID: Number(regional.bestAsk.stationID),
      error: `The quote at ${stationID} delivered no units; use verified non-Jita stock at ${regional.bestAsk.stationID}.`,
    };
  }
  return {
    unavailable: true,
    sourceStationID: Number(stationID) === Number(jita) ? 0 : Number(jita),
    error: `The market quote for ${typeID} at ${stationID} was not executable and no other non-Jita sell order remains.`,
  };
}

// Assemble (if packaged) and board a hull in the current station's hangar
// through the ship service. Returns the boarded ship's itemID or an error.
function boardShip(bot, hullItem) {
  const session = getSpace().getActorSession(bot);
  const ShipService = require("../ship/shipService");
  const ships = new ShipService();
  try {
    if (!(Number(hullItem.singleton) > 0)) ships.Handle_AssembleShip([[Number(hullItem.itemID)]], session, {});
    ships.Handle_ActivateShip([Number(hullItem.itemID), Number(session.shipID) || null], session, {});
  } catch (error) {
    return { error: getSpace().describeError(error) };
  }
  const character = getCharacterRecord(bot.characterID) || {};
  if (Number(character.shipID) !== Number(hullItem.itemID)) {
    return { error: "the ship service did not change the active ship" };
  }
  return { shipID: Number(character.shipID) || Number(hullItem.itemID) };
}

// Preserve a usable mining ship when an older upgrade lacks required skills.
function deferUpgradeForSkills(operation, bot) {
  const inventory = getInventory();
  const session = getSpace().getActorSession(bot);
  if (Number(session.shipTypeID) === Number(operation.hullTypeID)) {
    const itemStore = require("../inventory/itemStore");
    const previousID = Number(operation.previousShipID) || 0;
    const previousItem = previousID ? itemStore.findItemById(previousID) : null;
    const candidates = inventory.listHangar(bot, operation.marketStationID, 32880);
    const usable = candidates.filter((ship) => itemStore.listCharacterItems(bot.characterID, { locationID: Number(ship.itemID) })
      .some((item) => Number(item.typeID) === 483 && Number(item.flagID) >= 27 && Number(item.flagID) <= 34));
    const previous = previousItem && Number(previousItem.ownerID) === Number(bot.characterID)
      ? previousItem
      : usable[0];
    if (!previous) return block(operation, "holding", `Missing skills for ${operation.name}; no saved working ship is available to resume.`);
    const boarded = boardShip(bot, previous);
    if (boarded.error) return block(operation, "holding", `Missing skills for ${operation.name}; could not return to the Venture: ${boarded.error}.`);
  }
  return block(operation, "blocked", `Required skills are missing to fly and fit ${operation.name}; the ship and modules remain at ${operation.marketStationID}.`);
}

function failSavedFitting(operation, bot, status, reason, itemStore) {
  if (operation.kind === "fit") {
    const session = getSpace().getActorSession(bot);
    const currentShipID = Number(session.shipID) || 0;
    const previousShipID = Number(operation.previousShipID) || 0;
    if (currentShipID && currentShipID === Number(operation.newShipID) && previousShipID && previousShipID !== currentShipID) {
      const previousShip = itemStore.findItemById(previousShipID);
      if (previousShip) {
        const restored = boardShip(bot, previousShip);
        if (!restored.error) {
          operation.stage = "board";
          return block(operation, "blocked", `${reason} Returned to the previous ship; the saved-fit hull remains in the hangar and can be retried.`);
        }
        reason = `${reason} Could not return to the previous ship: ${restored.error}.`;
      }
    }
  }
  return block(operation, status, reason);
}

function findReusableUpgradeHull(bot, operation) {
  const store = require("../inventory/itemStore");
  const docked = Number(getSpace().getActorSession(bot).stationID);
  const routes = new Map();
  const fitting = require("../fitting/liveFittingState");
  let best = null;
  for (const hull of store.listCharacterItems(bot.characterID, {
    typeID: operation.hullTypeID, flagID: store.ITEM_FLAGS.HANGAR,
  })) {
    const station = worldData.getStationByID(Number(hull.locationID));
    if (!station) continue;
    const systemID = Number(station.solarSystemID);
    let hops = 0;
    if (Number(hull.locationID) !== docked) {
      if (!routes.has(systemID)) routes.set(systemID, getSpace().previewSystemRoute(bot, systemID));
      const route = routes.get(systemID);
      if (!route.success || route.risk?.lowsecSystemIDs?.length || route.risk?.nullsecSystemIDs?.length) continue;
      hops = 1 + route.hops;
    }
    const missing = [...operation.moduleTypeIDs];
    for (const item of store.listCharacterItems(bot.characterID, { locationID: hull.itemID })) {
      if (!fitting.isFittedModuleItem(item)) continue;
      const index = missing.indexOf(Number(item.typeID));
      if (index >= 0) missing.splice(index, 1);
    }
    if (!best || missing.length < best.missing || (missing.length === best.missing && hops < best.hops)) {
      best = { missing: missing.length, hops, hull };
      if (!best.missing && !hops) break;
    }
  }
  return best && best.hull;
}

function upgradeSlotError(operation) {
  const fitting = require("../fitting/liveFittingState");
  const counts = new Map();
  for (const typeID of operation.moduleTypeIDs || []) {
    const family = fitting.getRequiredSlotFamily(typeID);
    if (!family) return `Module ${typeID} has no supported fitting slot.`;
    counts.set(family, (counts.get(family) || 0) + 1);
  }
  for (const [family, count] of counts) {
    const available = fitting.getSlotFlagsForFamily(family, operation.hullTypeID, []).length;
    if (count > available) return `${operation.name} requires ${count} ${family} slots, but the hull has ${available}.`;
  }
  return null;
}

function migrateLegacyDominixFit(operation) {
  if (operation.kind !== "upgrade" || operation.role !== "security" || Number(operation.hullTypeID) !== 645) return;
  const corrected = resolveShipLadderRung(SHIP_LADDER.security.find((rung) => rung.hullTypeID === 645));
  const extraType = resolveLadderTypeID("EM Shield Amplifier II");
  const sorted = (types) => [...types].map(Number).sort((a, b) => a - b).join(",");
  if (sorted(operation.moduleTypeIDs || []) !== sorted([...corrected.moduleTypeIDs, extraType])) return;
  operation.moduleTypeIDs = [...corrected.moduleTypeIDs];
  operation.lastError = null;
  record(operation, "Corrected the legacy Dominix fit to five mid slots; owned surplus modules will remain in the station hangar.");
  saveOperation(operation);
}

function reconcileDominixMidSlots(operation, bot, session) {
  if (operation.kind !== "upgrade" || operation.role !== "security" || Number(operation.hullTypeID) !== 645) return null;
  const itemStore = require("../inventory/itemStore");
  const fitting = require("../fitting/liveFittingState");
  const typeID = resolveLadderTypeID("EM Shield Amplifier II");
  const wanted = (operation.moduleTypeIDs || []).filter((id) => Number(id) === typeID).length;
  if (wanted !== 1) return null;
  const shipID = Number(session.shipID);
  const stationID = Number(session.stationID || session.structureID);
  if (!stationID || stationID !== Number(operation.marketStationID) || Number(session.shipTypeID) !== 645) {
    return "The Dominix must be docked at its fitting station before repairing its legacy fit.";
  }
  const surplus = itemStore.listCharacterItems(bot.characterID, { locationID: shipID, typeID })
    .filter((item) => fitting.isFittedModuleItem(item)).sort((a, b) => Number(a.flagID) - Number(b.flagID)).slice(wanted);
  for (const module of surplus) {
    const broker = new (require("../inventory/invBrokerService"))();
    const previous = session.currentBoundObjectID;
    try {
      const bound = broker.Handle_GetInventory([stationID], session, null);
      session.currentBoundObjectID = bound.value.value[0];
      broker.Handle_Add([Number(module.itemID), shipID], session, { flag: itemStore.ITEM_FLAGS.HANGAR, qty: 1 });
    } catch (error) {
      return `Could not return the surplus Dominix resistance module to the hangar: ${getSpace().describeError(error)}`;
    } finally {
      session.currentBoundObjectID = previous;
    }
    const moved = itemStore.findItemById(Number(module.itemID));
    if (!moved || Number(moved.locationID) !== stationID || Number(moved.flagID) !== itemStore.ITEM_FLAGS.HANGAR) {
      return "The inventory service did not return the surplus Dominix module to the station hangar.";
    }
    record(operation, `Returned surplus Dominix module ${module.itemID} to station ${stationID}; the ship and module are preserved.`);
    saveOperation(operation);
  }
  return null;
}

async function advanceUpgrade(operation, bot) {
  const inventory = getInventory();
  const itemStore = require("../inventory/itemStore");
  if (operation.pending && operation.pending.action === "buy") {
    return block(operation, "review", "A purchase was not confirmed after a restart; check the hangar and wallet before resuming the operation.");
  }
  migrateLegacyDominixFit(operation);
  if (operation.kind === "upgrade") {
    const slotError = upgradeSlotError(operation);
    if (slotError) return block(operation, "blocked", slotError);
  }
  // A capsule-recovery or security upgrade can already be active when the
  // corporation receives its first-war grant. Extend its existing spend cap
  // once, using the normal stipend reservation, so it can finish its fit.
  if (operation.role === "security" && !operation.warMobilizationSupportID) {
    const support = require("./playerBotWarMobilizationRuntime").getCombatUpgradeSupport(bot);
    const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
    const existingRemaining = Math.max(0, (Number(operation.maxSpend) || 0) - (Number(operation.spent) || 0));
    const additionalBudget = Math.min(Math.max(0, balance - existingRemaining), Number(support && support.availableBudget) || 0);
    if (support && additionalBudget >= 60_000_000) {
      const reservation = require("./playerBotWarMobilizationRuntime")
        .reserveCombatUpgrade(bot, operation, support.supportID, additionalBudget);
      if (reservation.success) {
        operation.warMobilizationSupportID = reservation.supportID;
        operation.warSupportReservedAmount = reservation.reservedAmount;
        operation.warSupportBaselineSpent = Number(operation.spent) || 0;
        operation.maxSpend = Math.round(((Number(operation.maxSpend) || 0) + reservation.reservedAmount) * 100) / 100;
        record(operation, `First-war ship stipend added ${reservation.reservedAmount.toFixed(2)} ISK to this existing combat fitting operation.`);
        saveOperation(operation);
      }
    }
  }
  if (operation.stage === "to-market") {
    const step = await travelToStation(operation, bot, operation.marketStationID);
    if (step) return step;
    if (operation.modulesInTransit) {
      for (const { typeID } of getUpgradePackageNeeds({ ...operation, replenishOnly: true })) {
        inventory.unloadCargo(bot, typeID);
        if (inventory.countCargo(bot, typeID) > 0) return block(operation, "holding", `Could not unload module ${typeID} for the upgrade.`);
      }
      operation.modulesInTransit = false;
    }
    operation.stage = "buy";
    saveOperation(operation);
  }
  if (["buy", "board", "fit", "fetch-parts"].includes(operation.stage) && !canUseRung(bot, operation)) {
    return operation.kind === "fit"
      ? block(operation, "blocked", `Required skills are missing to fly or fit the saved ${operation.name} fitting; the bot keeps its previous ship.`)
      : deferUpgradeForSkills(operation, bot);
  }
  if (operation.kind === "upgrade" && operation.stage === "buy" && !operation.replenishOnly) {
    const session = getSpace().getActorSession(bot);
    if (Number(session.shipTypeID) === Number(operation.hullTypeID)) {
      operation.replenishOnly = true;
      saveOperation(operation);
    } else {
      const hull = findReusableUpgradeHull(bot, operation);
      if (hull) {
        operation.reuseShipID = Number(hull.itemID);
        operation.reuseStationID = Number(hull.locationID);
        operation.stage = "collect-hull";
        saveOperation(operation);
      }
    }
  }
  if (operation.stage === "collect-hull") {
    const step = await travelToStation(operation, bot, operation.reuseStationID);
    if (step) return step;
    const session = getSpace().getActorSession(bot);
    if (Number(session.shipID) !== operation.reuseShipID) {
      const hull = inventory.listHangar(bot, operation.reuseStationID, operation.hullTypeID)
        .find(item => Number(item.itemID) === operation.reuseShipID);
      if (!hull) return block(operation, "blocked", "Reserved hull is no longer in the owner's station hangar.");
      operation.previousShipID = Number(session.shipID);
      const boarded = boardShip(bot, hull);
      if (boarded.error) return block(operation, "blocked", boarded.error);
    }
    operation.targetShipID = operation.reuseShipID;
    operation.replenishOnly = true;
    operation.stage = "to-market";
    record(operation, `Reusing owned ship ${operation.targetShipID} from station ${operation.reuseStationID}.`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "buy") {
    const station = operation.marketStationID;
    const kitNeeds = getUpgradePackageNeeds({ ...operation, replenishOnly: true });
    const onShipCounts = new Map();
    if (operation.replenishOnly) {
      const replenishedTypes = new Set([...(operation.moduleTypeIDs || []), ...(operation.droneTypeIDs || []), ...(operation.fighterTypeIDs || [])].map(Number));
      for (const typeID of replenishedTypes) {
        const unloaded = inventory.unloadCargo(bot, typeID);
        if (!unloaded.success || inventory.countCargo(bot, typeID) > 0) {
          return block(operation, "holding", `Could not move carried replacement part ${typeID} into the station hangar.`);
        }
      }
      const shipID = Number(getSpace().getActorSession(bot).shipID) || 0;
      const fitting = require("../fitting/liveFittingState");
      for (const item of itemStore.listCharacterItems(bot.characterID, { locationID: shipID })) {
        if (!fitting.isFittedModuleItem(item)) continue;
        const typeID = Number(item.typeID) || 0;
        if (typeID && (operation.moduleTypeIDs || []).map(Number).includes(typeID)) {
          onShipCounts.set(typeID, (onShipCounts.get(typeID) || 0) + 1);
        }
      }
      for (const item of itemStore.listCharacterItems(bot.characterID, {
        locationID: shipID,
        flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
      })) {
        const typeID = Number(item.typeID) || 0;
        if (typeID && (operation.droneTypeIDs || []).map(Number).includes(typeID)) {
          onShipCounts.set(typeID, (onShipCounts.get(typeID) || 0) + inventory.unitsOf(item));
        }
      }
      for (const item of itemStore.listCharacterItems(bot.characterID, {
        locationID: shipID,
        flagID: itemStore.ITEM_FLAGS.FIGHTER_BAY,
      })) {
        const typeID = Number(item.typeID) || 0;
        if (typeID && (operation.fighterTypeIDs || []).map(Number).includes(typeID)) {
          onShipCounts.set(typeID, (onShipCounts.get(typeID) || 0) + inventory.unitsOf(item));
        }
      }
    }
    const needs = [
      ...(!operation.replenishOnly ? [[operation.hullTypeID, 1]] : []),
      ...kitNeeds.map(({ typeID, quantity }) => [Number(typeID), quantity]),
    ];
    for (const [typeID, count] of needs) {
      const cargoOwned = ((operation.cargoTypeIDs || []).map(Number).includes(Number(typeID)) ||
        (operation.fitCargoPlan || []).some((entry) => Number(entry.typeID) === Number(typeID)))
        ? inventory.countCargo(bot, typeID)
        : 0;
      const have = inventory.countHangar(bot, station, typeID) +
        (Number(onShipCounts.get(Number(typeID))) || 0) + cargoOwned;
      if (have >= count) continue;
      const result = await buyUnits(operation, bot, typeID, count - have);
      if (result.review) return block(operation, "review", result.review);
      if ((result.unavailable || result.sourceAvailable) && Number(result.sourceStationID) > 0) {
        const sourceStationID = Number(result.sourceStationID);
        if (Number(typeID) === Number(operation.hullTypeID)) {
          operation.sourceStationID = sourceStationID;
          operation.stage = "move-kit-to-source";
          record(operation, `Hull ${typeID} is unavailable at ${station}; moving the upgrade kit to source ${sourceStationID}.`);
        } else {
          operation.stage = "fetch-parts";
          operation.fetchParts = { typeID: Number(typeID), quantity: count - have, sourceStationID };
          record(operation, `Module ${typeID} is unavailable at ${station}; fetching ${count - have} from source ${sourceStationID}.`);
        }
        saveOperation(operation);
        return { delayMs: STEP_DELAY_MS };
      }
      if (result.unavailable) return block(operation, "blocked", `${result.error} The upgrade is paused and the bot can do other work.`);
      if (result.error) return block(operation, "blocked", `${result.error} The upgrade is paused and the bot can do other work.`);
      if (!(result.bought > 0)) return block(operation, "holding", `The market did not deliver ${typeID}; waiting before retrying.`);
      record(operation, `Bought ${result.bought}× ${typeID}; spent ${operation.spent.toFixed(2)} ISK.`);
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    operation.stage = "board";
    saveOperation(operation);
  }
  if (operation.stage === "move-kit-to-jita") operation.sourceStationID = require("./playerBotEconomyRuntime").JITA_BUY_STATION_ID;
  if (["move-kit-to-jita", "move-kit-to-source"].includes(operation.stage)) {
    const origin = operation.marketStationID;
    const sourceStationID = Number(operation.sourceStationID) || require("./playerBotEconomyRuntime").JITA_BUY_STATION_ID;
    for (const { typeID, quantity: count } of getUpgradePackageNeeds({ ...operation, replenishOnly: true })) {
      const numericType = Number(typeID);
      const expected = Math.min(count, inventory.countCargo(bot, numericType) + inventory.countHangar(bot, origin, numericType));
      for (const stack of inventory.listHangar(bot, origin, numericType)) {
        const missing = expected - inventory.countCargo(bot, numericType);
        if (missing <= 0) break;
        const loaded = inventory.loadToCargo(bot, stack.itemID, missing);
        if (!loaded.success) return block(operation, "holding", `Could not move part ${numericType} to source ${sourceStationID}: ${loaded.message}`);
      }
      if (inventory.countCargo(bot, numericType) < expected) return block(operation, "holding", `Could not load all units of ${numericType} for source ${sourceStationID}.`);
    }
    operation.marketStationID = sourceStationID;
    operation.modulesInTransit = true;
    operation.stage = "to-market";
    record(operation, `Loaded owned parts; moving the upgrade kit to ${operation.marketStationID}.`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "fetch-parts") {
    const jita = require("./playerBotEconomyRuntime").JITA_BUY_STATION_ID;
    const part = operation.fetchParts;
    if (!part || !Number(part.typeID) || !Number(part.quantity)) return block(operation, "blocked", "Missing the type or quantity for the requested item.");
    const sourceStationID = Number(part.sourceStationID) || jita;
    // Keep the fitted hull with the pilot while sourcing a module from another
    // station. Capsule recovery can buy the hull at the hub, then discover
    // missing modules and route to a regional market before boarding it. A
    // capsule has no cargo capacity, so loadToCargo would retry forever there.
    const session = getSpace().getActorSession(bot);
    const activeShipID = Number(session.shipID) || 0;
    const targetShipID = Number(operation.targetShipID) || 0;
    const alreadyBoardedTarget = targetShipID
      ? activeShipID === targetShipID
      : Number(session.shipTypeID) === Number(operation.hullTypeID);
    if (!alreadyBoardedTarget && Number(operation.hullTypeID) > 0) {
      const hubHull = inventory.listHangar(bot, operation.marketStationID, operation.hullTypeID)[0];
      if (hubHull) {
        const hubStep = await travelToStation(operation, bot, operation.marketStationID);
        if (hubStep) return hubStep;
        const availableHull = inventory.listHangar(bot, operation.marketStationID, operation.hullTypeID)[0];
        if (!availableHull) return block(operation, "holding", `The ${operation.name || "upgrade"} hull is no longer in the hangar at ${operation.marketStationID}.`);
        operation.previousShipID = activeShipID || null;
        operation.targetShipID = Number(availableHull.itemID);
        saveOperation(operation);
        const boarded = boardShip(bot, availableHull);
        if (boarded.error) return block(operation, "holding", `Could not board ${operation.name || "upgrade"} hull before fetching modules: ${boarded.error}.`);
        record(operation, `Boarded ${operation.name || "upgrade"} hull ${operation.targetShipID} before fetching modules from ${sourceStationID}.`);
        saveOperation(operation);
        return { delayMs: STEP_DELAY_MS };
      }
    }
    const step = await travelToStation(operation, bot, sourceStationID);
    if (step) return step;
    const owned = inventory.countHangar(bot, sourceStationID, part.typeID) + inventory.countCargo(bot, part.typeID);
    if (owned < part.quantity) {
      const result = await buyUnits(operation, bot, part.typeID, part.quantity - owned, sourceStationID);
      if (result.review) return block(operation, "review", result.review);
      if (result.unavailable) {
        if (result.sourceStationID && Number(result.sourceStationID) !== sourceStationID) {
          part.sourceStationID = Number(result.sourceStationID);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
        part.quantity = owned;
        part.deferAfterReturn = true;
        if (!owned) {
          operation.stage = "return-parts";
          record(operation, `No stock for ${part.typeID} at the selected source; returning to the hub and deferring the upgrade.`);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
      } else {
        if (result.sourceAvailable && result.sourceStationID) {
          part.sourceStationID = Number(result.sourceStationID);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
        if (result.error) return block(operation, "blocked", `${result.error} The upgrade is paused and the bot can do other work.`);
        if (!(result.bought > 0)) return block(operation, "holding", `The market did not deliver ${part.typeID}; waiting before retrying.`);
        record(operation, `Bought ${result.bought}× ${part.typeID} at ${sourceStationID}; spent ${operation.spent.toFixed(2)} ISK.`);
        saveOperation(operation);
        return { delayMs: STEP_DELAY_MS };
      }
    }
    for (const stack of inventory.listHangar(bot, sourceStationID, part.typeID)) {
      const missing = Number(part.quantity) - inventory.countCargo(bot, part.typeID);
      if (missing <= 0) break;
      const loaded = inventory.loadToCargo(bot, stack.itemID, missing);
      if (!loaded.success) return block(operation, "holding", `Could not load ${part.typeID}: ${loaded.message}`);
    }
    if (inventory.countCargo(bot, part.typeID) < part.quantity) return block(operation, "holding", `Could not load all units of ${part.typeID}.`);
    operation.stage = "return-parts";
    record(operation, `Loaded ${part.typeID} for ${operation.marketStationID}.`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "return-parts") {
    const step = await travelToStation(operation, bot, operation.marketStationID);
    if (step) return step;
    const part = operation.fetchParts;
    if (!part || !Number(part.typeID)) return block(operation, "blocked", "Missing the type for the delivered item.");
    inventory.unloadCargo(bot, part.typeID);
    if (inventory.countCargo(bot, part.typeID) > 0) return block(operation, "holding", `Could not unload ${part.typeID} at ${operation.marketStationID}.`);
    operation.fetchParts = null;
    operation.stage = "buy";
    if (part.deferAfterReturn) return block(operation, "blocked", `Jita has no more units of ${part.typeID}; the upgrade is deferred and the bot can do other work.`);
    record(operation, `Delivered ${part.typeID} to ${operation.marketStationID}.`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "board") {
    const session = getSpace().getActorSession(bot);
    if (operation.replenishOnly && Number(session.shipTypeID) === Number(operation.hullTypeID)) {
      operation.newShipID = Number(session.shipID) || null;
      operation.stage = "fit";
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    if (operation.targetShipID && Number(session.shipID) === Number(operation.targetShipID)) {
      operation.newShipID = Number(operation.targetShipID);
      operation.stage = "fit";
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    const hull = inventory.listHangar(bot, operation.marketStationID, operation.hullTypeID)[0];
    if (!hull) return block(operation, "blocked", "The purchased ship is not in the hangar.");
    operation.previousShipID = Number(session.shipID) || null;
    operation.targetShipID = Number(hull.itemID);
    saveOperation(operation);
    const ShipService = require("../ship/shipService");
    const ships = new ShipService();
    try {
      if (!(Number(hull.singleton) > 0)) ships.Handle_AssembleShip([[Number(hull.itemID)]], session, {});
      const oldShipID = Number(session.shipID) || null;
      ships.Handle_ActivateShip([Number(hull.itemID), oldShipID], session, {});
    } catch (error) {
      const reason = getSpace().describeError(error);
      if (reason.includes("ShipHasSkillPrerequisites")) {
        return operation.kind === "fit"
          ? block(operation, "blocked", `Required ship skills are missing for ${operation.name}; the previous ship remains available.`)
          : deferUpgradeForSkills(operation, bot);
      }
      return block(operation, "holding", `The ship service could not assemble ${operation.name}: ${reason}.`);
    }
    const character = getCharacterRecord(bot.characterID) || {};
    if (Number(character.shipID) !== Number(hull.itemID)) {
      return block(operation, "holding", `${bot.characterName} did not board ${operation.name}.`);
    }
    operation.newShipID = Number(character.shipID) || Number(hull.itemID);
    operation.stage = "fit";
    record(operation, `Boarded the new ${operation.name} (${operation.newShipID}).`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "fit") {
    const session = getSpace().getActorSession(bot);
    const failFit = (status, reason) => failSavedFitting(operation, bot, status, reason, itemStore);
    const legacyFitError = reconcileDominixMidSlots(operation, bot, session);
    if (legacyFitError) return failFit("holding", legacyFitError);
    const shipID = Number(session.shipID) || 0;
    const fitting = require("../fitting/liveFittingState");
    const fitted = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
      .filter((item) => fitting.isFittedModuleItem(item));
    let fittedNow = 0;
    const plannedSlots = Array.isArray(operation.fitSlotPlan)
      ? [...operation.fitSlotPlan].sort((left, right) =>
        Number(right.family === "subsystem") - Number(left.family === "subsystem"))
      : null;
    let slotWork = plannedSlots || [...(operation.moduleTypeIDs || [])].map((typeID) => ({ typeID }));
    if (!plannedSlots) {
      for (const item of fitted) {
        const index = slotWork.findIndex((entry) => Number(entry.typeID) === Number(item.typeID));
        if (index >= 0) slotWork.splice(index, 1);
      }
    }
    for (const planned of slotWork) {
      const typeID = Number(planned.typeID) || 0;
      const family = planned.family || fitting.getRequiredSlotFamily(typeID);
      const itemType = require("../inventory/itemTypeRegistry").resolveItemByTypeID(typeID);
      if (plannedSlots && fitted.some((item) => Number(item.typeID) === typeID && Number(item.flagID) === Number(planned.flagID))) {
        continue;
      }
      const candidates = fitting.getSlotFlagsForFamily(family, Number(session.shipTypeID), fitted, shipID);
      const occupied = new Set(fitted.map((item) => Number(item.flagID)));
      const flag = plannedSlots
        ? Number(planned.flagID)
        : candidates.find((candidate) => !occupied.has(Number(candidate)));
      if (!Number.isSafeInteger(flag) || flag <= 0) {
        return failFit("blocked", `No available ${family} slot for ${itemType && itemType.name || typeID} on ${operation.name}.`);
      }
      if (plannedSlots && !candidates.includes(flag)) {
        return failFit("blocked", `Saved slot ${flag} is unavailable for ${itemType && itemType.name || typeID} on ${operation.name}.`);
      }
      if (occupied.has(flag)) {
        return failFit("blocked", `Saved fitting slot ${flag} is already occupied on ${operation.name}.`);
      }
      if (inventory.countCargo(bot, typeID) > 0) {
        const unloaded = inventory.unloadCargo(bot, typeID);
        if (!unloaded.success || inventory.countCargo(bot, typeID) > 0) {
          return failFit("holding", `Could not unload carried fitting module ${typeID} into the station hangar.`);
        }
      }
      const stack = inventory.listHangar(bot, operation.marketStationID, typeID)[0];
      if (!stack) return failFit("holding", `Missing fitted module ${typeID} in the station hangar.`);
      if (plannedSlots) {
        const shipItem = itemStore.findItemById(shipID) || {
          itemID: shipID,
          typeID: Number(session.shipTypeID),
          categoryID: 6,
          ownerID: bot.characterID,
        };
        const candidate = {
          ...itemType,
          itemID: Number(stack.itemID),
          typeID,
          ownerID: bot.characterID,
          locationID: shipID,
          flagID: flag,
          singleton: 1,
          stacksize: 1,
        };
        const validation = fitting.validateFitForShip(bot.characterID, shipItem, candidate, flag, fitted);
        if (!validation.success) {
          return failFit("blocked", `Saved fitting cannot place ${itemType && itemType.name || typeID} in slot ${flag}: ${validation.errorMsg}.`);
        }
      }
      try {
        const broker = new (require("../inventory/invBrokerService"))();
        const previous = session.currentBoundObjectID;
        const bound = broker.Handle_GetInventoryFromId([shipID], session, null);
        session.currentBoundObjectID = bound.value.value[0];
        try {
          broker.Handle_Add([Number(stack.itemID), operation.marketStationID], session, { flag, qty: 1 });
        } finally {
          session.currentBoundObjectID = previous;
        }
        const installed = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
          .some((item) => fitting.isFittedModuleItem(item) && Number(item.typeID) === Number(typeID) && Number(item.flagID) === flag);
        if (!installed) return failFit("holding", `The inventory service did not fit module ${typeID} in slot ${flag}.`);
        const installedItem = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
          .find((item) => fitting.isFittedModuleItem(item) && Number(item.typeID) === Number(typeID) && Number(item.flagID) === flag);
        if (installedItem) fitted.push(installedItem);
        fittedNow += 1;
      } catch (error) {
        const reason = getSpace().describeError(error);
        if (reason.includes("FittingHasSkillPrerequisites")) {
          return operation.kind === "fit"
            ? block(operation, "blocked", `Required skills changed while fitting ${operation.name}; the previous ship remains available.`)
            : deferUpgradeForSkills(operation, bot);
        }
        return failFit("holding", `Fitting module ${typeID} was rejected: ${reason}.`);
      }
    }
    const finalModules = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
      .filter((item) => fitting.isFittedModuleItem(item))
      .map((item) => Number(item.typeID));
    for (const typeID of operation.moduleTypeIDs) {
      const index = finalModules.indexOf(Number(typeID));
      if (index < 0) return failFit("holding", `Module ${typeID} is not fitted on ${operation.name}.`);
      finalModules.splice(index, 1);
    }
    if (plannedSlots) {
      const placed = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
        .filter((item) => fitting.isFittedModuleItem(item));
      for (const planned of plannedSlots) {
        if (!placed.some((item) => Number(item.typeID) === Number(planned.typeID) && Number(item.flagID) === Number(planned.flagID))) {
          return failFit("holding", `Saved module ${planned.typeID} is not fitted in slot ${planned.flagID}.`);
        }
      }
    }
    const requiredDrones = new Map();
    for (const typeID of operation.droneTypeIDs || []) {
      requiredDrones.set(Number(typeID), (requiredDrones.get(Number(typeID)) || 0) + 1);
    }
    const droneBayReconcile = inventory.unloadExcessDroneBay(bot, requiredDrones);
    if (!droneBayReconcile.success) return failFit("holding", droneBayReconcile.message);
    for (const [typeID, count] of requiredDrones) {
      const bay = itemStore.listCharacterItems(bot.characterID, {
        locationID: shipID,
        flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
      });
      const existing = bay.filter((item) => Number(item.typeID) === Number(typeID))
        .reduce((total, item) => total + inventory.unitsOf(item), 0);
      let missing = Math.max(0, count - existing);
      for (const stack of inventory.listHangar(bot, operation.marketStationID, typeID)) {
        if (!missing) break;
        const loaded = inventory.loadToDroneBay(bot, stack.itemID, missing);
        if (!loaded.success) return failFit("holding", `Could not load drone ${typeID} into the ship bay: ${loaded.message}`);
        missing -= Number(loaded.moved) || 0;
      }
      const finalBayCount = itemStore.listCharacterItems(bot.characterID, {
        locationID: shipID,
        flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
      }).filter((item) => Number(item.typeID) === Number(typeID))
        .reduce((total, item) => total + inventory.unitsOf(item), 0);
      if (finalBayCount < count) return failFit("holding", `The ship has ${finalBayCount}/${count} combat drones of type ${typeID}.`);
    }
    const requiredFighters = new Map();
    for (const typeID of operation.fighterTypeIDs || []) {
      requiredFighters.set(Number(typeID), (requiredFighters.get(Number(typeID)) || 0) + 1);
    }
    for (const [typeID, count] of requiredFighters) {
      const bay = itemStore.listCharacterItems(bot.characterID, {
        locationID: shipID,
        flagID: itemStore.ITEM_FLAGS.FIGHTER_BAY,
      });
      let missing = Math.max(0, count - bay.filter((item) => Number(item.typeID) === Number(typeID))
        .reduce((total, item) => total + inventory.unitsOf(item), 0));
      for (const stack of inventory.listHangar(bot, operation.marketStationID, typeID)) {
        if (!missing) break;
        const loaded = inventory.loadToFighterBay(bot, stack.itemID, missing);
        if (!loaded.success) return failFit("holding", `Could not load fighter ${typeID} into the ship bay: ${loaded.message}`);
        missing -= Number(loaded.moved) || 0;
      }
      const finalBayCount = itemStore.listCharacterItems(bot.characterID, {
        locationID: shipID,
        flagID: itemStore.ITEM_FLAGS.FIGHTER_BAY,
      }).filter((item) => Number(item.typeID) === Number(typeID))
        .reduce((total, item) => total + inventory.unitsOf(item), 0);
      if (finalBayCount < count) return failFit("holding", `The ship has ${finalBayCount}/${count} fighters of type ${typeID}.`);
    }
    const requiredCargo = new Map();
    for (const typeID of operation.cargoTypeIDs || []) {
      requiredCargo.set(Number(typeID), (requiredCargo.get(Number(typeID)) || 0) + 1);
    }
    for (const entry of operation.fitCargoPlan || []) {
      requiredCargo.set(Number(entry.typeID), (requiredCargo.get(Number(entry.typeID)) || 0) + Math.max(0, Math.trunc(Number(entry.quantity) || 0)));
    }
    for (const [typeID, count] of requiredCargo) {
      let missing = Math.max(0, count - inventory.countCargo(bot, typeID));
      for (const stack of inventory.listHangar(bot, operation.marketStationID, typeID)) {
        if (!missing) break;
        const loaded = inventory.loadToCargo(bot, stack.itemID, missing);
        if (!loaded.success) return failFit("holding", `Could not load required cargo ${typeID}: ${loaded.message}`);
        missing -= Number(loaded.moved) || 0;
      }
      if (inventory.countCargo(bot, typeID) < count) {
        return failFit("holding", `The ship has ${inventory.countCargo(bot, typeID)}/${count} units of required cargo ${typeID}.`);
      }
    }
    const finalFittedItems = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
      .filter((item) => fitting.isFittedModuleItem(item));
    const dogmaService = new (require("../dogma/dogmaService"))();
    for (const typeID of operation.moduleTypeIDs || []) {
      const modules = finalFittedItems.filter((item) => Number(item.typeID) === Number(typeID));
      for (const module of modules) {
        if (fitting.isEffectivelyOnlineModule(module)) continue;
        try {
          dogmaService.Handle_SetModuleOnline([shipID, Number(module.itemID)], session);
        } catch (error) {
          return failFit("holding", `Could not online required module ${typeID}: ${getSpace().describeError(error)}.`);
        }
      }
    }
    const finalOnlineFailures = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
      .filter((item) => (operation.moduleTypeIDs || []).includes(Number(item.typeID)) &&
        fitting.isFittedModuleItem(item) && !fitting.isEffectivelyOnlineModule(item));
    if (finalOnlineFailures.length) {
      return failFit("holding", `${finalOnlineFailures.length} combat fit module(s) remain offline.`);
    }
    const resumed = prepareResumedCombat(operation);
    if (resumed) {
      record(resumed, `Combat fit replenished at ${operation.marketStationID}; returning to ${resumed.siteLabel || "the same anomaly"} to finish it.`);
      saveOperation(resumed);
      return { delayMs: STEP_DELAY_MS, resumedCombat: true };
    }
    const droneCount = (operation.droneTypeIDs || []).length;
    if (operation.kind === "fit") {
      const fighterCount = (operation.fighterTypeIDs || []).length;
      return finish(operation, `Fit completed: ${bot.characterName} is flying ${operation.name} (${operation.hullTypeID}) with ${operation.moduleTypeIDs.length} fitted module(s), ${droneCount} drone(s), and ${fighterCount} fighter(s); spent ${operation.spent.toFixed(2)} ISK.`);
    }
    return finish(operation, `Upgrade completed: ${bot.characterName} is flying ${operation.name} with ${operation.moduleTypeIDs.length} module(s) and ${droneCount} drone(s) (${fittedNow} modules newly fitted); spent ${operation.spent.toFixed(2)} ISK.`);
  }
  return block(operation, "blocked", `Unknown upgrade stage ${operation.stage}.`);
}

function startShipUpgrade(botQuery, role = "mining", options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot, {
    allowIndependentIndustryReview: options.autonomous === true && options.industryReviewFallback === true,
  });
  if (refusal) return { success: false, message: refusal };
  const rung = nextShipUpgrade(bot, role);
  if (!rung) return { success: false, message: `${bot.characterName} already flies the best ship on the ${role} upgrade ladder.` };
  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  const maxSpend = Math.min(balance, Number(options.maxSpend) || rung.minBalance);
  if (balance < rung.minBalance && !options.force) {
    return { success: false, message: `${bot.characterName} needs ${rung.minBalance.toLocaleString("en-US")} ISK for a ${rung.name}; current balance is ${balance.toFixed(2)} ISK.` };
  }
  const operation = baseOperation("upgrade", bot, {
    stage: "to-market",
    role,
    name: rung.name,
    hullTypeID: rung.hullTypeID,
    moduleTypeIDs: [...(rung.moduleTypeIDs || [])],
    droneTypeIDs: [...(rung.droneTypeIDs || [])],
    cargoTypeIDs: [...(rung.cargoTypeIDs || [])],
    replenishOnly: rung.replenishOnly === true,
    marketStationID: normalizePositiveInteger(options.marketStationID) || findUpgradeMarketStation(bot, rung),
    maxSpend: Math.round(maxSpend * 100) / 100,
    spent: 0,
    pending: null,
    newShipID: null,
    autonomous: options.autonomous === true,
  });
  if (options.warMobilizationSupportID) {
    const reservation = require("./playerBotWarMobilizationRuntime")
      .reserveCombatUpgrade(bot, operation, options.warMobilizationSupportID, operation.maxSpend);
    if (!reservation.success) return { success: false, message: reservation.error };
    operation.warMobilizationSupportID = reservation.supportID;
    operation.warSupportReservedAmount = reservation.reservedAmount;
  }
  record(operation, `Upgrading to ${rung.name} at ${operation.marketStationID}; spend limit ${operation.maxSpend.toFixed(2)} ISK.`);
  saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will buy and fit a ${rung.name} at ${operation.marketStationID} (maximum spend ${operation.maxSpend.toFixed(2)} ISK).` };
}

function startSavedFitting(botQuery, fittingID, requesterSession, requestedMaxSpend = null) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const numericFittingID = normalizePositiveInteger(fittingID);
  if (!numericFittingID) return { success: false, message: "Send a saved fitting ID or fitting link." };

  const fittingStore = require("../../_secondary/fitting/fittingStore");
  const saved = fittingStore.findFittingByID(numericFittingID);
  if (!saved) return { success: false, message: `Saved fitting ${numericFittingID} was not found.` };
  const requesterID = Number(requesterSession && (requesterSession.characterID || requesterSession.charid)) || 0;
  const requesterCorpID = Number(requesterSession && (requesterSession.corporationID || requesterSession.corpid)) || 0;
  const requesterAllianceID = Number(requesterSession && (requesterSession.allianceID || requesterSession.allianceid)) || 0;
  const botCorp = require("../corporation/corporationState").getCorporationRecord(Number(bot.corporationID) || 0);
  const allowedOwnerIDs = new Set([
    requesterID,
    requesterCorpID,
    requesterAllianceID,
    Number(bot.characterID) || 0,
    Number(bot.corporationID) || 0,
    Number(botCorp && botCorp.allianceID) || 0,
    Number(fittingStore.COMMUNITY_FITTING_CORP) || 0,
  ].filter((id) => id > 0));
  if (!allowedOwnerIDs.has(Number(saved.ownerID))) {
    return { success: false, message: "That fitting is not public and is not owned by you, your corporation, or your alliance." };
  }

  const planned = require("./playerBotFitPlanner").buildFitPlan(saved);
  if (!planned.success) return planned;
  const plan = planned.plan;
  const rung = {
    hullTypeID: plan.shipTypeID,
    moduleTypeIDs: plan.moduleTypeIDs,
    droneTypeIDs: plan.droneTypeIDs,
    fighterTypeIDs: plan.fighterTypeIDs,
    fitCargoPlan: plan.cargoPlan,
  };
  if (!canUseRung(bot, rung)) {
    return { success: false, message: `${bot.characterName} is missing trained skills required by ${saved.name}; no items were bought or moved.` };
  }

  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  const protectedCapital = require("./playerBotProvisioningRuntime").DEFAULT_STARTING_CAPITAL;
  const spendable = Math.max(0, balance - protectedCapital);
  const requestedCap = Number(requestedMaxSpend) > 0 ? Number(requestedMaxSpend) : spendable;
  const maxSpend = Math.min(spendable, requestedCap);
  const operation = baseOperation("fit", bot, {
    stage: "to-market",
    role: "saved-fitting",
    name: saved.name,
    fittingID: numericFittingID,
    fittingOwnerID: Number(saved.ownerID),
    fittingRequestedByCharacterID: requesterID || null,
    hullTypeID: plan.shipTypeID,
    moduleTypeIDs: [...plan.moduleTypeIDs],
    fitSlotPlan: plan.fitSlotPlan.map((entry) => ({ ...entry })),
    droneTypeIDs: [...plan.droneTypeIDs],
    fighterTypeIDs: [...plan.fighterTypeIDs],
    fitCargoPlan: plan.cargoPlan.map((entry) => ({ ...entry })),
    cargoTypeIDs: [],
    marketStationID: findUpgradeMarketStation(bot, rung),
    maxSpend: Math.round(maxSpend * 100) / 100,
    spent: 0,
    pending: null,
    newShipID: null,
    autonomous: false,
  });
  record(operation, `Preparing saved fitting ${saved.name} (${numericFittingID}) at ${operation.marketStationID}; spend limit ${operation.maxSpend.toFixed(2)} ISK with ${protectedCapital.toFixed(2)} ISK starting capital protected.`);
  saveOperation(operation);
  return {
    success: true,
    operation,
    message: `${bot.characterName} will travel to ${operation.marketStationID}, buy missing items from the saved ${saved.name} fit, board the fitted hull, and preserve ${protectedCapital.toLocaleString("en-US")} ISK starting capital. Spend limit: ${operation.maxSpend.toFixed(2)} ISK.`,
  };
}

// ---------------------------------------------------------------- control

// Sell eligible mined, manufactured, and planetary goods through the market.
async function advanceSell(operation, bot) {
  if (operation.optimizeMarketDestination === undefined) operation.optimizeMarketDestination = true;
  if (operation.stage === "sale-route") return advanceRegionalSaleRoute(operation, bot);
  if (operation.stage === "sell" && operation.originStationID && operation.originStationID !== operation.marketStationID) {
    const step = await travelToStation(operation, bot, operation.originStationID);
    if (step) return step;
    const registry = require("../inventory/itemTypeRegistry");
    let loaded = 0;
    for (const stack of getInventory().listHangar(bot, operation.originStationID)) {
      const categoryID = Number((registry.resolveItemByTypeID(Number(stack.typeID)) || {}).categoryID);
      if (!SELLABLE_CATEGORIES.has(categoryID)) continue;
      const result = getInventory().loadToCargo(bot, stack.itemID);
      loaded += Number(result.moved) || 0;
      if (!result.success) break;
    }
    operation.stage = "to-market";
    record(operation, `Loaded ${loaded} units at ${operation.originStationID} to sell at ${operation.marketStationID}.`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  const step = await travelToStation(operation, bot, operation.marketStationID);
  if (step) return step;
  if (getInventory().listCargo(bot).length) getInventory().unloadCargo(bot);
  const route = await maybeBeginRegionalSaleRoute(operation, bot, operation.marketStationID, "market-sell");
  if (route) return route;
  await sellMiningOutput(operation, bot, operation.marketStationID);
  if (operation.kind === "pi-collect" && operation.collectAgain && operation.containerID) {
    operation.collectAgain = false;
    operation.stage = "return-to-source";
    record(operation, "PI cargo was delivered; returning to the same launch container for the remaining stacks.");
    saveOperation(operation);
    return { delayMs: TRAVEL_DELAY_MS };
  }
  return finish(operation, `Sale completed: ${Number(operation.unitsSold || 0)} units for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units.`);
}

// Ore, minerals, manufactured charges and planetary commodities a bot sells.
const SELLABLE_CATEGORIES = new Set([4, 7, 8, 25, 43]);

function hasSellableGoods(bot, stationID) {
  const registry = require("../inventory/itemTypeRegistry");
  return getInventory().listHangar(bot, stationID).some((item) => {
    const categoryID = Number((registry.resolveItemByTypeID(Number(item.typeID)) || {}).categoryID);
    return SELLABLE_CATEGORIES.has(categoryID);
  });
}

// Market orders return unfilled stock to the exact source hangar when they
// expire. Find that stock even when the bot has since undocked or moved to a
// different station, so the director can route it back to a non-Jita market
// and publish a fresh 90-day order at current prices.
function findSellableGoodsStation(bot) {
  const characterID = normalizePositiveInteger(bot && bot.characterID);
  if (!characterID) return 0;
  const itemStore = require("../inventory/itemStore");
  const registry = require("../inventory/itemTypeRegistry");
  const items = itemStore.listCharacterItems(characterID, {
    flagID: itemStore.ITEM_FLAGS.HANGAR,
  });
  const stockByStation = new Map();
  const systemByStation = new Map();
  for (const item of items) {
    const categoryID = Number((registry.resolveItemByTypeID(Number(item.typeID)) || {}).categoryID);
    if (!SELLABLE_CATEGORIES.has(categoryID)) continue;
    const stationID = normalizePositiveInteger(item.locationID);
    if (!stationID) continue;
    let station = worldData.getStationByID(stationID);
    if (!station && typeof worldData.getStructureByID === "function") {
      try { station = worldData.getStructureByID(stationID); } catch (_) { station = null; }
    }
    const systemID = normalizePositiveInteger(station && (station.solarSystemID || station.solarSystemID2));
    if (!station || !systemID) continue;
    stockByStation.set(stationID, (stockByStation.get(stationID) || 0) + getInventory().unitsOf(item));
    systemByStation.set(stationID, systemID);
  }
  if (!stockByStation.size) return 0;

  const character = getCharacterRecord(characterID) || {};
  const currentStationID = normalizePositiveInteger(character.stationID || character.structureID);
  const currentSystemID = normalizePositiveInteger(character.solarSystemID);
  const space = getSpace();
  return [...stockByStation.entries()]
    .map(([stationID, units]) => {
      const systemID = systemByStation.get(stationID) || 0;
      const route = currentSystemID && systemID
        ? space.findStargateRoute(currentSystemID, systemID)
        : null;
      if (route && route.success !== true) return null;
      return {
        stationID,
        units,
        currentStation: stationID === currentStationID,
        sameSystem: Boolean(currentSystemID && systemID === currentSystemID),
        hops: route && route.success ? (Array.isArray(route.gates) ? route.gates.length : 0) : Number.MAX_SAFE_INTEGER,
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.currentStation) - Number(left.currentStation) ||
      Number(right.sameSystem) - Number(left.sameSystem) || left.hops - right.hops ||
      right.units - left.units || left.stationID - right.stationID)[0]?.stationID || 0;
}

async function findBestRegionalSaleStation(bot, stationID, options = {}) {
  const inventory = getInventory();
  const registry = require("../inventory/itemTypeRegistry");
  const economy = require("./playerBotEconomyRuntime");
  const onlyTypeID = normalizePositiveInteger(options.typeID);
  const minimumUnitPrice = Math.max(0, Number(options.minimumUnitPrice) || 0);
  const stacks = inventory.listHangar(bot, stationID).filter((item) => {
    if (onlyTypeID && Number(item.typeID) !== onlyTypeID) return false;
    const categoryID = Number((registry.resolveItemByTypeID(Number(item.typeID)) || {}).categoryID);
    return SELLABLE_CATEGORIES.has(categoryID);
  });
  const expectedByStation = new Map();
  for (const stack of stacks) {
    const units = inventory.unitsOf(stack);
    const quote = await require("./playerBotTradeRuntime")
      .readRegionalMarketQuote(bot.characterName, Number(stack.typeID)).catch(() => ({ success: false }));
    const askByStation = new Map();
    for (const ask of quote.success && Array.isArray(quote.sellOrders) ? quote.sellOrders : []) {
      const key = Number(ask.stationID);
      const previous = askByStation.get(key);
      if (!previous || Number(ask.price) < Number(previous.price)) askByStation.set(key, ask);
    }
    const orders = economy.listPlayerBuyOrders(1000, Number(stack.typeID));
    const ordersByStation = new Map();
    for (const order of orders) {
      if (Number(order.price) < minimumUnitPrice || Number(order.min_volume) > units) continue;
      const key = Number(order.station_id);
      const localAsk = askByStation.get(key);
      if (localAsk && Number(order.price) < Number(localAsk.price) * SELL_TO_BID_RATIO) continue;
      const system = worldData.getSolarSystemByID(stationSystemID(key));
      if (!worldData.getStationByID(key) || !system || Number(system.security) < 0.45) continue;
      if (!ordersByStation.has(key)) ordersByStation.set(key, []);
      ordersByStation.get(key).push({ price: Number(order.price), quantity: Number(order.vol_remaining) || 0 });
    }
    for (const [buyerStationID, orders] of ordersByStation) {
      let remaining = units;
      let proceeds = 0;
      for (const order of orders) {
        const quantity = Math.min(remaining, Math.max(0, Number(order.quantity) || 0));
        proceeds += quantity * Number(order.price);
        remaining -= quantity;
        if (remaining <= 0) break;
      }
      if (proceeds > 0) {
        expectedByStation.set(buyerStationID, (expectedByStation.get(buyerStationID) || 0) + proceeds);
      }
    }
  }
  const best = [...expectedByStation.entries()]
    .map(([buyerStationID, expectedProceeds]) => ({ stationID: buyerStationID, expectedProceeds: Math.round(expectedProceeds * 100) / 100 }))
    .sort((left, right) => right.expectedProceeds - left.expectedProceeds || left.stationID - right.stationID)[0] || null;
  return best && best.expectedProceeds > 0 ? best : null;
}

async function maybeBeginRegionalSaleRoute(operation, bot, sourceStationID, returnStage) {
  if (operation.optimizeMarketDestination !== true || operation.saleRouteAttempted === true) return null;
  operation.saleRouteAttempted = true;
  const destination = await findBestRegionalSaleStation(bot, sourceStationID);
  if (!destination || Number(destination.stationID) === Number(sourceStationID)) {
    saveOperation(operation);
    return null;
  }
  operation.saleRoute = {
    sourceStationID: Number(sourceStationID),
    destinationStationID: Number(destination.stationID),
    expectedProceeds: Number(destination.expectedProceeds) || 0,
    returnStage: String(returnStage || "market-sell"),
    phase: "load",
  };
  operation.stage = "sale-route";
  record(operation, `Regional buyer selected at ${destination.stationID} (${destination.expectedProceeds.toFixed(2)} ISK estimated); routing goods there instead of listing without a local bid.`);
  saveOperation(operation);
  return { delayMs: STEP_DELAY_MS };
}

async function advanceRegionalSaleRoute(operation, bot) {
  const route = operation.saleRoute || {};
  const destinationStationID = normalizePositiveInteger(route.destinationStationID);
  if (!destinationStationID || require("./playerBotEconomyRuntime").isJitaStation(destinationStationID)) {
    return block(operation, "blocked", "Regional sale route has no valid non-Jita destination.");
  }
  if (route.phase !== "travel") {
    const inventory = getInventory();
    const registry = require("../inventory/itemTypeRegistry");
    let loaded = 0;
    for (const stack of inventory.listHangar(bot, Number(route.sourceStationID))) {
      const type = registry.resolveItemByTypeID(Number(stack.typeID)) || {};
      if (!SELLABLE_CATEGORIES.has(Number(type.categoryID))) continue;
      const result = inventory.loadToCargo(bot, stack.itemID);
      loaded += Number(result.moved) || 0;
      if (!result.success) break;
    }
    const cargoHasSaleableGoods = inventory.listCargo(bot).some((item) => {
      const type = registry.resolveItemByTypeID(Number(item.typeID)) || {};
      return SELLABLE_CATEGORIES.has(Number(type.categoryID));
    });
    if (!loaded && !cargoHasSaleableGoods) {
      return block(operation, "holding", "No saleable stock could be loaded for the selected regional buyer.");
    }
    operation.saleRoute.phase = "travel";
    record(operation, `Loaded ${loaded} units for regional buyer station ${destinationStationID}.`);
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  const step = await travelToStation(operation, bot, destinationStationID);
  if (step) return step;
  getInventory().unloadCargo(bot);
  operation.marketStationID = destinationStationID;
  operation.stage = String(route.returnStage || "market-sell");
  operation.saleRoute = null;
  record(operation, `Arrived at regional buyer station ${destinationStationID}; unloading goods for sale.`);
  saveOperation(operation);
  return { delayMs: STEP_DELAY_MS };
}

function startRelocation(botQuery, destinationStationID) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const stationID = normalizePositiveInteger(destinationStationID);
  const station = worldData.getStationByID(stationID);
  if (!station) return { success: false, message: "Relocation destination " + (stationID || "unknown") + " is not a supported station." };
  const character = getCharacterRecord(bot.characterID) || {};
  const originSystemID = normalizePositiveInteger(character.solarSystemID);
  if (Number(character.solarSystemID) === Number(station.solarSystemID) &&
      Number(character.stationID || character.structureID) === stationID) {
    return { success: false, message: bot.characterName + " is already at station " + stationID + "." };
  }
  const operation = baseOperation("relocate", bot, {
    stage: "travel",
    destinationStationID: stationID,
    homeStationID: stationID,
    originSystemID,
    destinationSystemID: Number(station.solarSystemID) || 0,
    reason: "per-system autonomous work distribution",
  });
  record(operation, "Leaving the crowded system for station " + stationID + " in system " + operation.destinationSystemID + "; regular work will resume there.");
  saveOperation(operation);
  return { success: true, operation, message: bot.characterName + " will relocate to station " + stationID + " to continue work in a less crowded system." };
}

function startSell(botQuery, stationID = null, originStationID = null, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const station = normalizePositiveInteger(stationID) ||
    normalizePositiveInteger((getCharacterRecord(bot.characterID) || {}).stationID);
  if (!station) return { success: false, message: `${bot.characterName} must be docked or a station must be specified.` };
  const operation = baseOperation("sell", bot, {
    stage: "sell",
    marketStationID: station,
    originStationID: normalizePositiveInteger(originStationID) || station,
    homeStationID: station,
    unitsSold: 0,
    proceeds: 0,
    unitsListed: 0,
    brokerFees: 0,
    optimizeMarketDestination: options.optimizeMarketDestination !== false,
  });
  record(operation, `Selling marketable goods at ${station}.`);
  saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will sell eligible goods at ${station}.` };
}

// ---------------------------------------------------------------- player orders

// Courier a player's buy order: source the item from regional stock first,
// using the Jita seed market only when the region has no other sell order.
async function advanceFulfill(operation, bot) {
  const economy = require("./playerBotEconomyRuntime");
  const trade = require("./playerBotTradeRuntime");
  const inventory = getInventory();
  const order = economy.getOpenOrder(operation.orderID);
  if ((!order || order.state !== "open" || Number(order.vol_remaining) <= 0) && operation.stage !== "sell") {
    return finish(operation, `Order ${operation.orderID} is no longer open; delivery canceled.`);
  }
  if (operation.stage === "choose-source") {
    const previousSourceStationID = Number(operation.sourceStationID) || 0;
    const regional = await trade.readBestAskOutsideJita(bot.characterName, operation.typeID, 1, previousSourceStationID);
    if (!regional.success) return block(operation, "holding", `Could not verify regional supply for type ${operation.typeID}; purchase paused safely.`);
    const jitaSourceStationID = !regional.bestAsk && typeof economy.findBestJitaSeedStation === "function"
      ? Number(economy.findBestJitaSeedStation([{ typeID: operation.typeID, quantity: 1 }],
        operation.checkedJitaStationIDs || [])) || 0
      : 0;
    operation.sourceStationID = Number(regional.bestAsk && regional.bestAsk.stationID) ||
      jitaSourceStationID || economy.JITA_BUY_STATION_ID;
    operation.stage = "to-source";
    record(operation, regional.bestAsk
      ? `Selected regional source ${operation.sourceStationID} for order ${operation.orderID}.`
      : `No non-Jita stock for order ${operation.orderID}; using seeded Jita station ${operation.sourceStationID}.`);
    saveOperation(operation);
  }
  if (operation.stage === "to-jita") operation.stage = "to-source";
  const sourceStationID = Number(operation.sourceStationID) || economy.JITA_BUY_STATION_ID;
  if (operation.stage === "to-source") {
    const step = await travelToStation(operation, bot, sourceStationID);
    if (step) return step;
    operation.stage = "buy";
    saveOperation(operation);
  }
  if (operation.stage === "buy") {
    const have = inventory.countHangar(bot, sourceStationID, operation.typeID);
    const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(operation.typeID) || {};
    const unitVolume = Number(type.volume) || 0.01;
    const cargoFree = inventory.getCargoCapacity(bot).free || 0;
    const fits = Math.max(1, Math.floor(cargoFree / unitVolume));
    let wanted = Math.min(Number(order.vol_remaining), operation.quantity, fits) - have;
    if (wanted > 0) {
      const quote = await trade.readQuote(bot.characterName, operation.typeID);
      if (!quote.success) return block(operation, "holding", quote.message || `Could not query type ${operation.typeID} at ${sourceStationID}.`);
      if (!quote.bestAsk) {
        if (have > 0) {
          // Deliver what this station did supply rather than stranding a
          // partial purchase when the remaining stock has been exhausted.
          wanted = 0;
          record(operation, `Station ${sourceStationID} has no more type ${operation.typeID}; delivering the ${have} units already acquired.`);
        } else if (typeof economy.isJitaStation === "function" && economy.isJitaStation(sourceStationID)) {
          const regional = await trade.readBestAskOutsideJita(bot.characterName, operation.typeID, 1, sourceStationID);
          if (!regional.success) return block(operation, "holding", `Could not verify non-Jita supply for type ${operation.typeID}; no Jita purchase was attempted.`);
          if (regional.bestAsk) {
            operation.sourceStationID = Number(regional.bestAsk.stationID);
            operation.stage = "to-source";
            record(operation, `Found non-Jita supply at ${operation.sourceStationID}; using it before another Jita station.`);
            saveOperation(operation);
            return { delayMs: STEP_DELAY_MS };
          }
          const checked = [...new Set([...(operation.checkedJitaStationIDs || []).map(Number), sourceStationID])];
          const nextSeedStationID = typeof economy.findBestJitaSeedStation === "function"
            ? Number(economy.findBestJitaSeedStation([{ typeID: operation.typeID, quantity: 1 }], checked)) || 0
            : 0;
          operation.checkedJitaStationIDs = checked;
          if (nextSeedStationID) {
            operation.sourceStationID = nextSeedStationID;
            operation.stage = "to-source";
            record(operation, `Jita station ${sourceStationID} is out of type ${operation.typeID}; routing to stocked Jita station ${nextSeedStationID}.`);
            saveOperation(operation);
            return { delayMs: STEP_DELAY_MS };
          }
          return block(operation, "holding", `No Jita seed station has a sell order for type ${operation.typeID}; the order will be retried later.`);
        } else {
          operation.stage = "choose-source";
          record(operation, `Selected source ${sourceStationID} has run out of type ${operation.typeID}; checking regional supply again.`);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
      }
      if (wanted > 0 && quote.bestAsk.price > Number(order.price)) {
        if (have > 0) {
          wanted = 0;
          record(operation, `Remaining stock at ${sourceStationID} is above the order price; delivering the ${have} affordable units already acquired.`);
        } else {
          return finish(operation, `Station ${sourceStationID} sells type ${operation.typeID} for ${quote.bestAsk.price.toFixed(2)} ISK, above the order price (${Number(order.price).toFixed(2)}); delivery is not worthwhile.`);
        }
      }
      if (wanted > 0) {
        const result = await trade.buy(bot.characterName, operation.typeID, Math.min(wanted, quote.bestAsk.quantity), quote.bestAsk.price);
        if (!result.success && result.sourceAvailable && Number(result.sourceStationID) > 0) {
          operation.sourceStationID = Number(result.sourceStationID);
          operation.stage = "to-source";
          record(operation, `Non-Jita supply appeared at ${operation.sourceStationID}; sourcing there instead of Jita.`);
          saveOperation(operation);
          return { delayMs: STEP_DELAY_MS };
        }
        if (!result.success) return block(operation, result.outcomeUnknown ? "review" : "holding", result.message);
        operation.spent = Math.round(((Number(operation.spent) || 0) + Number(result.spent || 0)) * 100) / 100;
        record(operation, `Bought at ${sourceStationID}: ${result.bought}× ${operation.typeID} for ${Number(result.spent || 0).toFixed(2)} ISK.`);
        saveOperation(operation);
        return { delayMs: STEP_DELAY_MS };
      }
    }
    for (const stack of inventory.listHangar(bot, sourceStationID, operation.typeID)) {
      const result = inventory.loadToCargo(bot, stack.itemID);
      if (!result.success) break;
    }
    operation.stage = "to-order";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "to-order") {
    const step = await travelToStation(operation, bot, operation.orderStationID);
    if (step) return step;
    inventory.unloadCargo(bot);
    operation.stage = "sell";
    saveOperation(operation);
  }
  if (operation.stage === "sell") {
    let sold = 0;
    let credited = 0;
    for (const stack of inventory.listHangar(bot, operation.orderStationID, operation.typeID)) {
      const result = await trade.sell(bot.characterName, stack.itemID, null, Math.max(0.01, Number(operation.price) * 0.999));
      if (!result.success) {
        record(operation, result.message);
        break;
      }
      sold += Number(result.sold) || 0;
      credited += Number(result.credited) || 0;
    }
    operation.unitsDelivered = (Number(operation.unitsDelivered) || 0) + sold;
    operation.proceeds = Math.round(((Number(operation.proceeds) || 0) + credited) * 100) / 100;
    return finish(operation, `Order ${operation.orderID}: delivered ${sold} units at ${operation.orderStationID} for ${credited.toFixed(2)} ISK (source cost ${Number(operation.spent || 0).toFixed(2)} ISK).`);
  }
  return block(operation, "blocked", `Unknown delivery stage ${operation.stage}.`);
}

function startFulfill(botQuery, order) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const operation = baseOperation("fulfill", bot, {
    stage: "choose-source",
    orderID: Number(order.order_id),
    orderStationID: Number(order.station_id),
    typeID: Number(order.type_id),
    quantity: Number(order.vol_remaining),
    price: Number(order.price),
    spent: 0,
    proceeds: 0,
    unitsDelivered: 0,
  });
  record(operation, `Fulfilling order ${order.order_id}: ${order.vol_remaining}× ${order.type_id} at ${Number(order.price).toFixed(2)} ISK at ${order.station_id}.`);
  saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will source ${order.vol_remaining}× type ${order.type_id} from a non-Jita market when available, then deliver to ${order.station_id} (order ${order.order_id}).` };
}

const COLONY_KIT = Object.freeze({
  travelToStation: (operation, bot, stationID) => travelToStation(operation, bot, stationID),
  save: (operation) => saveOperation(operation),
  record: (operation, message) => record(operation, message),
  block: (operation, status, reason) => block(operation, status, reason),
  finish: (operation, message) => finish(operation, message),
});

function startColony(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found for: ${botQuery}.` };
  const existing = getOperation(bot.characterID);
  const planetRuntime = require("../planet/planetRuntimeStore");
  if (existing && existing.kind === "colony" && existing.status === "review" &&
      existing.stage === "planting" && !existing.pending &&
      Number(existing.automaticRecoveryCount || 0) < 1 &&
      String(existing.lastError || "").includes("CannotCreatePinWrongPlanetType") &&
      !planetRuntime.getColony(existing.planetID, bot.characterID)) {
    const colonyRuntime = require("./playerBotColonyRuntime");
    const plan = colonyRuntime._testing.planForOperation(existing);
    Object.assign(existing, plan);
    existing.stage = getInventory().countCargo(bot, plan.commandCenterTypeID) > 0 ? "plant" : "buy";
    existing.status = "active";
    existing.lastError = null;
    existing.routeTaskID = null;
    existing.automaticRecoveryCount = Number(existing.automaticRecoveryCount || 0) + 1;
    record(existing, "Resuming PI setup with planet-specific Command Center, extractor, and factory types.");
    saveOperation(existing);
    require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
      require("../../utils/logger").warn(`[PlayerBots] Could not resume PI operation ${existing.operationID}: ${error.message}`));
    return { success: true, operation: existing, message: `${bot.characterName} is retrying its PI setup with corrected planet-specific structures.` };
  }
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const colonies = require("./playerBotColonyRuntime");
  if (!colonies.hasColonySkill(bot)) {
    return { success: false, message: `${bot.characterName} does not have the Command Center Upgrades skill required to establish a colony.` };
  }
  const operation = baseOperation("colony", bot, { stage: "to-jita", spent: 0, planetID: null, pins: 0 });
  record(operation, "PI colony: buy a planet-specific Command Center in Jita and deploy the best supported P0-to-P1 or P0-to-P2 chain.");
  saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will establish the best supported P0-to-P1 or P0-to-P2 PI chain, then return to other work.` };
}

// Collect an already launched PI container using normal movement and inventory services.
function nextPlanetaryLaunch(bot) {
  const items = require("../inventory/itemStore");
  return require("../planet/planetRuntimeStore").listLaunchesForCharacter(bot.characterID)
    .filter((launch) => Number(launch.itemID) > 0 && Number(launch.itemID) !== Number(launch.launchID))
    .filter((launch) => items.findItemById(Number(launch.itemID)) &&
      items.listCharacterItems(bot.characterID, { locationID: Number(launch.itemID) }).length > 0)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}

function startPlanetaryCollection(botQuery, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const exportRequest = options.exportRequest && typeof options.exportRequest === "object"
    ? options.exportRequest
    : null;
  const planetRuntime = require("../planet/planetRuntimeStore");
  const launch = exportRequest ? null : nextPlanetaryLaunch(bot);
  if (!exportRequest && !launch) return { success: false, message: "There are no PI launch containers waiting to be collected." };
  const colony = exportRequest
    ? planetRuntime.getColony(Number(exportRequest.planetID), Number(bot.characterID))
    : null;
  if (exportRequest && !colony) return { success: false, message: bot.characterName + " no longer owns the PI colony on planet " + (Number(exportRequest.planetID) || "?") + "." };
  const systemID = Number(exportRequest ? colony.solarSystemID : launch.solarSystemID) || 0;
  const stations = worldData.getStationsForSystem(systemID) || [];
  const stationID = Number(stations[0] && stations[0].stationID) || 0;
  if (!stationID) return { success: false, message: "There is no station in the PI collection system." };
  let commandPinID = 0;
  let commodities = {};
  if (exportRequest) {
    const commandPin = (Array.isArray(colony.pins) ? colony.pins : []).find((pin) =>
      require("../planet/planetStaticData").getPinEntityType(pin && pin.typeID) === "command",
    );
    commandPinID = Number(commandPin && commandPin.pinID) || 0;
    commodities = Object.fromEntries(Object.entries(exportRequest.commodities || {})
      .map(([typeID, quantity]) => [String(Number(typeID) || 0), Math.max(0, Math.trunc(Number(quantity) || 0))])
      .filter(([typeID, quantity]) => Number(typeID) > 0 && quantity > 0));
    if (!commandPinID || !Object.keys(commodities).length) {
      return { success: false, message: "PI export plan for planet " + (Number(exportRequest.planetID) || "?") + " is empty or has no Command Center." };
    }
  }
  const operation = baseOperation("pi-collect", bot, {
    stage: "to-source", sourceStationID: stationID, containerID: launch ? Number(launch.itemID) : null,
    launchID: launch ? Number(launch.launchID) : null,
    exportRequest: exportRequest ? {
      policyVersion: Math.max(1, Math.trunc(Number(exportRequest.policyVersion) || 1)),
      planetID: Number(exportRequest.planetID),
      solarSystemID: systemID,
      commandPinID,
      maxUnitsPerCycle: Math.max(1, Math.trunc(Number(exportRequest.maxUnitsPerCycle) || 1)),
      maxTaxPerCycle: Math.max(0, Number(exportRequest.maxTaxPerCycle) || 0),
      commodities,
    } : null,
    marketStationID: hubStationFor(bot),
    homeStationID: hubStationFor(bot),
    unitsSold: 0, proceeds: 0, unitsListed: 0, brokerFees: 0,
    optimizeMarketDestination: true,
  });
  record(operation, exportRequest
    ? "Preparing PI export from planet " + operation.exportRequest.planetID + "; the bot will launch only after it reaches the collection system and has enough cargo capacity."
    : "Collecting PI from launch container " + operation.containerID + ".");
  saveOperation(operation);
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not wake PI collection ${operation.operationID}: ${error.message}`));
  return {
    success: true,
    operation,
    message: exportRequest
      ? bot.characterName + " will travel to planet " + operation.exportRequest.planetID + "'s system, launch only the PI cargo it can collect, and bring it to market."
      : bot.characterName + " will collect PI launch " + operation.launchID + ".",
  };
}

function countCommodityUnits(contents = {}) {
  return Object.values(contents || {}).reduce((total, quantity) =>
    total + Math.max(0, Math.trunc(Number(quantity) || 0)), 0,
  );
}

async function reconcileLegacyPIExportAttempt(operation, dependencies = {}) {
  const attempt = operation && operation.exportAttempt;
  const request = operation && operation.exportRequest;
  const errorText = [operation && operation.lastError,
    ...(Array.isArray(operation && operation.history) ? operation.history.map((entry) => entry && entry.message) : [])]
    .filter(Boolean).join("\n");
  if (!operation || operation.kind !== "pi-collect" || operation.status !== "review" ||
      !attempt || attempt.operationKey || !request ||
      !errorText.includes("storedLaunchID is not defined")) {
    return { recovered: false, reason: "not-known-legacy-failure" };
  }

  const characterID = normalizePositiveInteger(operation.characterID);
  const planetID = normalizePositiveInteger(request.planetID);
  const startedAtMs = Number(attempt.startedAtMs);
  const expectedTax = Number(attempt.expectedTax);
  const commodities = attempt.commodities && typeof attempt.commodities === "object"
    ? attempt.commodities : {};
  const nowMs = Number(dependencies.nowMs) || Date.now();
  if (!characterID || !planetID || !Number.isFinite(startedAtMs) || startedAtMs <= 0 ||
      nowMs - startedAtMs < 0 || nowMs - startedAtMs > LEGACY_PI_EXPORT_RECOVERY_MAX_AGE_MS ||
      !Number.isFinite(expectedTax) || expectedTax <= 0 || !Object.keys(commodities).length ||
      !operation.operationID) {
    return { recovered: false, reason: "invalid-or-expired-attempt" };
  }

  const wallet = dependencies.wallet || require("../account/walletState");
  const planetRuntime = dependencies.planetRuntime || require("../planet/planetRuntimeStore");
  if (typeof planetRuntime.getLaunchOperationReplay !== "function" ||
      typeof planetRuntime.findLaunchesForCharacterOnPlanetSince !== "function" ||
      typeof wallet.getCharacterWalletJournal !== "function" ||
      typeof wallet.adjustCharacterBalanceAsync !== "function") {
    return { recovered: false, reason: "recovery-authorities-unavailable" };
  }

  const colony = planetRuntime.getColony(planetID, characterID);
  const operationKey = `${operation.operationID}:pi-export:${Math.max(1,
    Math.trunc(Number(attempt.sequence || operation.exportAttemptSequence) || 1))}`;
  const replay = planetRuntime.getLaunchOperationReplay({
    operationID: operationKey,
    ownerID: characterID,
    planetID,
    solarSystemID: Number(request.solarSystemID) || 0,
    planetTypeID: Number(colony && colony.planetTypeID) || 0,
    commandPinID: Number(request.commandPinID) || 0,
    commodities,
  });
  if (!replay || replay.status !== "none") {
    return { recovered: false, reason: `launch-receipt-${replay && replay.status || "unknown"}` };
  }

  const launchAudit = planetRuntime.findLaunchesForCharacterOnPlanetSince(
    characterID, planetID, startedAtMs,
  );
  if (!launchAudit || launchAudit.valid !== true || Number(launchAudit.unknownTimestampCount) !== 0 ||
      !Array.isArray(launchAudit.launches) || launchAudit.launches.length !== 0) {
    return { recovered: false, reason: "launch-history-is-not-empty-and-provable" };
  }

  const entryTypeID = Number(wallet.JOURNAL_ENTRY_TYPE && wallet.JOURNAL_ENTRY_TYPE.PLANETARY_EXPORT_TAX) || 97;
  const journal = wallet.getCharacterWalletJournal(characterID);
  const entries = (Array.isArray(journal) ? journal : []).filter((entry) =>
    Number(entry && entry.entryTypeID) === entryTypeID &&
    Number(entry && entry.referenceID) === planetID &&
    Number(entry && entry.ownerID1) === characterID &&
    fileTimeToMs(entry && entry.transactionDate) >= startedAtMs - 2_000 &&
    fileTimeToMs(entry && entry.transactionDate) <= startedAtMs + 120_000,
  );
  const debits = entries.filter((entry) => Number(entry.amount) < 0);
  if (debits.length !== 1 || Math.abs(Number(debits[0].amount) + expectedTax) >= 0.01) {
    return { recovered: false, reason: "wallet-debit-does-not-match-exactly" };
  }

  const refundKey = `playerbot:pi-export:${characterID}:${operationKey}:legacy-recovery-refund`;
  const refundDescription = `Recovered failed PI export tax for operation ${operation.operationID} on planet ${planetID}`;
  const priorReceipt = typeof wallet.getCharacterWalletOperationReceipt === "function"
    ? wallet.getCharacterWalletOperationReceipt(characterID, refundKey)
    : null;
  const receiptResult = priorReceipt && (priorReceipt.result || priorReceipt);
  const validRefundReceipt = Boolean(priorReceipt &&
    String(priorReceipt.idempotencyKey || refundKey) === refundKey &&
    Math.abs(Number(receiptResult && receiptResult.delta) - expectedTax) < 0.01 &&
    Number(receiptResult && receiptResult.journalEntry && receiptResult.journalEntry.entryTypeID) === entryTypeID &&
    Number(receiptResult && receiptResult.journalEntry && receiptResult.journalEntry.referenceID) === planetID);
  const priorCredits = (Array.isArray(journal) ? journal : []).filter((entry) =>
    Number(entry && entry.entryTypeID) === entryTypeID &&
    Number(entry && entry.referenceID) === planetID &&
    Number(entry && entry.ownerID1) === characterID &&
    Number(entry.amount) > 0 &&
    Math.abs(Number(entry.amount) - expectedTax) < 0.01 &&
    String(entry.description || "") === refundDescription);
  if (priorReceipt && !validRefundReceipt) {
    return { recovered: false, reason: "existing-refund-receipt-does-not-match" };
  }
  if (priorCredits.length > 1) {
    return { recovered: false, reason: "duplicate-recovery-credits-found" };
  }

  let refund = null;
  if (validRefundReceipt) {
    refund = { success: true, ...receiptResult };
  } else if (priorCredits.length === 1) {
    // A restart may occur after the wallet committed the keyed refund but
    // before the operation record was saved. The operation-specific journal
    // description is a second durable check if the bounded receipt aged out.
    refund = { success: true, delta: Number(priorCredits[0].amount), journalEntry: priorCredits[0] };
  } else {
    refund = await wallet.adjustCharacterBalanceAsync(characterID, expectedTax, {
      entryTypeID,
      referenceID: planetID,
      ownerID1: characterID,
      ownerID2: planetID,
      description: refundDescription,
      idempotencyKey: refundKey,
    }, {
      source: "playerbots-legacy-pi-recovery",
      idempotencyKey: refundKey,
    });
  }
  if (!refund || refund.success !== true || Math.abs(Number(refund.delta) - expectedTax) >= 0.01 ||
      Number(refund.journalEntry && refund.journalEntry.entryTypeID) !== entryTypeID ||
      Number(refund.journalEntry && refund.journalEntry.referenceID) !== planetID ||
      Number(refund.journalEntry && refund.journalEntry.ownerID1) !== characterID) {
    return { recovered: false, reason: "wallet-refund-not-confirmed", refundKey };
  }

  operation.exportAttemptSequence = Math.max(
    Number(operation.exportAttemptSequence) || 0,
    Number(attempt.sequence) || 1,
  );
  operation.exportAttempt = null;
  operation.status = "active";
  operation.lastError = null;
  operation.routeTaskID = null;
  record(operation, `Recovered ${expectedTax.toFixed(2)} ISK from a legacy PI export that charged tax without committing a launch; the exact debit and empty launch history were verified.`);
  return { recovered: true, amount: expectedTax, operationKey, refundKey };
}

async function reconcileLegacyPIExportReviews() {
  const summary = { checked: 0, recovered: 0, refundedISK: 0, skipped: 0 };
  for (const operation of listOperations()) {
    if (!operation || operation.kind !== "pi-collect" || operation.status !== "review" ||
        !operation.exportAttempt || operation.exportAttempt.operationKey) continue;
    const historyText = [operation.lastError,
      ...(Array.isArray(operation.history) ? operation.history.map((entry) => entry && entry.message) : [])]
      .filter(Boolean).join("\n");
    if (!historyText.includes("storedLaunchID is not defined")) continue;
    summary.checked += 1;
    if (runningBots.has(Number(operation.characterID))) {
      summary.skipped += 1;
      continue;
    }
    const result = await reconcileLegacyPIExportAttempt(operation);
    if (!result.recovered) {
      summary.skipped += 1;
      continue;
    }
    saveOperation(operation);
    summary.recovered += 1;
    summary.refundedISK = Math.round((summary.refundedISK + result.amount) * 100) / 100;
    try {
      await require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(operation.characterID);
    } catch (error) {
      require("../../utils/logger").warn(`[PlayerBots] Could not wake recovered PI collection ${operation.operationID}: ${error.message}`);
    }
  }
  return summary;
}

async function advancePIExportLaunch(operation, bot, state, inventory) {
  const request = operation.exportRequest;
  const planetRuntime = require("../planet/planetRuntimeStore");
  const planetary = require("./playerBotPlanetaryRuntime");
  const itemStore = require("../inventory/itemStore");
  if (Number(state.systemID) !== Number(request.solarSystemID)) {
    return block(operation, "holding", "PI collection ship is in system " + (state.systemID || "?") +
      ", not colony system " + request.solarSystemID + ". No launch was created.");
  }

  const colony = planetRuntime.getColony(request.planetID, bot.characterID);
  let attempt = operation.exportAttempt || null;
  const currentState = planetary.currentCommandCenterContents(bot.characterID, request.planetID);
  const currentBalance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  if (attempt) {
    const wallet = require("../account/walletState");
    const operationKey = String(attempt.operationKey || "");
    if (operationKey) {
      const replay = planetRuntime.getLaunchOperationReplay({
        operationID: operationKey,
        ownerID: bot.characterID,
        planetID: request.planetID,
        solarSystemID: request.solarSystemID,
        planetTypeID: Number(colony && colony.planetTypeID) || 0,
        commandPinID: request.commandPinID,
        commodities: attempt.commodities,
      });
      if (replay.status === "conflict" || replay.status === "missing-launch") {
        return block(operation, "review", `PI launch receipt for operation ${operationKey} is ${replay.status}; no second launch will be attempted.`);
      }
      if (replay.status === "replay") {
        const launch = replay.launch;
        if (launch.deleted === true) {
          const cargoHasLaunch = Object.entries(attempt.commodities || {}).every(([typeID, quantity]) =>
            inventory.countCargo(bot, Number(typeID)) -
              Number(attempt.baselineCargoUnitsByTypeID && attempt.baselineCargoUnitsByTypeID[typeID] || 0) >=
              Number(quantity),
          );
          if (!cargoHasLaunch) {
            return block(operation, "review", `PI launch ${launch.launchID} for operation ${operationKey} was already removed but its cargo is not aboard; the bot will not duplicate the export.`);
          }
          operation.launchID = null;
          operation.containerID = null;
          operation.exportAttempt = null;
          operation.stage = "to-market";
          record(operation, `Recovered PI launch ${launch.launchID} from its durable receipt; its cargo is already aboard and is going to market.`);
          saveOperation(operation);
          return { delayMs: TRAVEL_DELAY_MS };
        }

        let recoveredLaunch = launch;
        let container = Number(launch.itemID) > Number(launch.launchID)
          ? itemStore.findItemById(Number(launch.itemID))
          : null;
        if (!container && Number(launch.itemID) <= Number(launch.launchID)) {
          recoveredLaunch = require("../planet/planetMgrService").ensurePlayerbotLaunchContainer(
            launch, require("./playerBotSpaceRuntime").getActorSession(bot),
          ) || launch;
          container = Number(recoveredLaunch.itemID) > Number(recoveredLaunch.launchID)
            ? itemStore.findItemById(Number(recoveredLaunch.itemID))
            : null;
        }
        if (!container || Number(container.locationID) !== Number(request.solarSystemID)) {
          return block(operation, "review", `PI launch ${launch.launchID} for operation ${operationKey} is committed but its physical container is unavailable; no duplicate will be launched.`);
        }
        operation.launchID = Number(recoveredLaunch.launchID);
        operation.containerID = Number(recoveredLaunch.itemID);
        operation.unitsLaunched = countCommodityUnits(attempt.commodities);
        operation.taxSpent = Math.max(0, Number(attempt.expectedTax) || 0);
        operation.exportAttempt = null;
        operation.lastError = null;
        record(operation, `Recovered PI launch ${operation.launchID} from its durable operation receipt; collection will continue from container ${operation.containerID}.`);
        saveOperation(operation);
        return { delayMs: TRAVEL_DELAY_MS, launched: true };
      }

      if (replay.status === "none") {
        const unchanged = currentState.commandPin && Object.keys(attempt.commodities || {}).every((typeID) =>
          Number(attempt.baselineContents && attempt.baselineContents[typeID] || 0) ===
          Number(currentState.contents[typeID] || 0),
        );
        const debit = wallet.getCharacterWalletOperationReceipt(bot.characterID, attempt.walletDebitKey);
        const refund = wallet.getCharacterWalletOperationReceipt(bot.characterID, attempt.walletRefundKey);
        const taxEntryTypeID = Number(wallet.JOURNAL_ENTRY_TYPE &&
          wallet.JOURNAL_ENTRY_TYPE.PLANETARY_EXPORT_TAX) || 97;
        const taxEntries = wallet.getCharacterWalletJournal(bot.characterID).filter((entry) =>
          Number(entry.entryTypeID) === taxEntryTypeID &&
          Number(entry.referenceID) === Number(request.planetID) &&
          Number(entry.transactionID) >= Number(attempt.startedAtMs || 0) * 1000 - 1_000_000,
        );
        const netTax = taxEntries.length
          ? taxEntries.reduce((total, entry) => total + (Number(entry.amount) || 0), 0)
          : (Number(debit && debit.result && debit.result.delta) || 0) +
            (Number(refund && refund.result && refund.result.delta) || 0);
        const paidTax = Number(attempt.expectedTax) || 0;
        if (!unchanged) {
          return block(operation, "review", `PI launch ${operationKey} has no durable launch receipt and its source stock changed; no second export will be attempted.`);
        }
        if (Math.abs(netTax) < 0.01) {
          operation.exportAttemptSequence = Math.max(
            Number(operation.exportAttemptSequence) || 0,
            Number(attempt.sequence) || 0,
          );
          operation.exportAttempt = null;
          record(operation, `PI launch ${operationKey} had no committed effect and its tax was fully refunded; preparing a fresh attempt.`);
          saveOperation(operation);
          attempt = null;
        } else if (Math.abs(netTax + paidTax) < 0.01) {
          // The PI handler charged this attempt but did not commit a launch.
          // Retry the same key so the existing tax debit is not repeated.
        } else {
          return block(operation, "review", `PI launch ${operationKey} has no commit receipt and wallet tax delta ${netTax.toFixed(2)} ISK cannot be reconciled; no second export will be attempted.`);
        }
      }
    }

    if (operation.exportAttempt) attempt = operation.exportAttempt;
  }

  if (attempt && !attempt.operationKey) {
    const launch = planetRuntime.listLaunchesForCharacter(bot.characterID)
      .filter((entry) => Number(entry.planetID) === Number(request.planetID) &&
        Date.parse(entry.createdAt || "") >= Number(attempt.startedAtMs || 0) - 1000)
      .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))[0] || null;
    const container = launch && Number(launch.itemID) > Number(launch.launchID)
      ? itemStore.findItemById(Number(launch.itemID))
      : null;
    if (container && Number(container.locationID) === Number(request.solarSystemID)) {
      operation.launchID = Number(launch.launchID);
      operation.containerID = Number(launch.itemID);
      operation.unitsLaunched = countCommodityUnits(attempt.commodities);
      operation.taxSpent = Math.max(0, Number(attempt.baselineBalance) - currentBalance);
      operation.exportAttempt = null;
      operation.lastError = null;
      record(operation, "Recovered PI launch " + operation.launchID +
        "; this operation will collect container " + operation.containerID + ".");
      saveOperation(operation);
      return { delayMs: TRAVEL_DELAY_MS, launched: true };
    }
    const unchanged = currentState.commandPin &&
      Object.keys(attempt.commodities || {}).every((typeID) =>
        Number(attempt.baselineContents && attempt.baselineContents[typeID] || 0) ===
        Number(currentState.contents[typeID] || 0),
      ) && Math.abs(Number(attempt.baselineBalance) - currentBalance) < 0.01;
    if (!unchanged) {
      return block(operation, "review", "PI launch result for planet " + request.planetID +
        " is ambiguous; no second launch will be attempted and the bot will not be assigned away.");
    }
    operation.exportAttempt = null;
    attempt = null;
  }

  const commandPin = (Array.isArray(colony && colony.pins) ? colony.pins : []).find((pin) =>
    require("../planet/planetStaticData").getPinEntityType(pin && pin.typeID) === "command",
  );
  const policyResult = planetary.getAutoExportPolicy(bot.characterName, request.planetID);
  if (!commandPin || !policyResult.success || !policyResult.policy ||
      Number(policyResult.policy.version) !== Number(request.policyVersion)) {
    return finish(operation, "PI export on planet " + request.planetID +
      " was disabled or changed before launch; no container was created.");
  }
  if (Number(commandPin.pinID) !== Number(request.commandPinID)) {
    return finish(operation, "PI Command Center changed on planet " + request.planetID +
      "; no container was created.");
  }
  const stock = Object.fromEntries(Object.keys(request.commodities || {}).map((typeID) =>
    [typeID, Number(currentState.contents[typeID]) || 0],
  ));
  const hasStock = Object.entries(request.commodities || {}).every(([typeID, quantity]) =>
    Number(stock[typeID]) >= Number(quantity),
  );
  if (!currentState.commandPin || !hasStock) {
    return finish(operation, "PI export stock on planet " + request.planetID +
      " changed before launch; no container was created.");
  }
  const preview = planetRuntime.previewLaunchCommodities({
    planetID: request.planetID,
    ownerID: bot.characterID,
    solarSystemID: request.solarSystemID,
    planetTypeID: Number(colony.planetTypeID) || 0,
    commandPinID: request.commandPinID,
    commodities: request.commodities,
  });
  if (!preview.success) {
    return finish(operation, "PI export preflight on planet " + request.planetID +
      " was rejected (" + preview.errorMsg + "); no container was created.");
  }
  const commodities = preview.commoditiesToLaunch || request.commodities;
  const volume = Object.entries(commodities).reduce((total, [typeID, quantity]) =>
    total + inventory.getUnitVolume({ typeID: Number(typeID) }) * Number(quantity), 0,
  );
  const freeCargo = inventory.getCargoBayFree(bot);
  if (!(volume > 0) || volume > freeCargo + 1e-6) {
    return block(operation, "holding", "PI container not launched: the ship needs " +
      volume.toFixed(2) + " m³ of free cargo but has " + freeCargo.toFixed(2) + " m³.");
  }
  const planetCosts = require("../planet/planetCostCalculator");
  const tax = planetCosts.calculateExportTax(
    Number(preview.commandPin && preview.commandPin.typeID), commodities, planetCosts.DEFAULT_TAX_RATE,
  );
  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  if (tax > Number(request.maxTaxPerCycle) + 0.0001 || balance + 0.0001 < tax) {
    return block(operation, "holding", "PI container not launched: export tax " +
      Number(tax).toFixed(2) + " ISK exceeds the current policy or wallet limit.");
  }

  operation.exportRequest.commodities = commodities;
  const attemptNumber = attempt
    ? Math.max(1, Number(attempt.sequence) || 1)
    : Math.max(0, Number(operation.exportAttemptSequence) || 0) + 1;
  const operationKey = attempt && attempt.operationKey
    ? String(attempt.operationKey)
    : `${operation.operationID}:pi-export:${attemptNumber}`;
  const walletDebitKey = attempt && attempt.walletDebitKey
    ? String(attempt.walletDebitKey)
    : `playerbot:pi-export:${bot.characterID}:${operationKey}`;
  const walletRefundKey = attempt && attempt.walletRefundKey
    ? String(attempt.walletRefundKey)
    : `${walletDebitKey}:refund`;
  operation.exportAttemptSequence = Math.max(Number(operation.exportAttemptSequence) || 0, attemptNumber);
  operation.exportAttempt = attempt || {
    operationKey,
    sequence: attemptNumber,
    walletDebitKey,
    walletRefundKey,
    startedAtMs: Date.now(),
    baselineContents: currentState.contents,
    baselineBalance: balance,
    baselineCargoUnitsByTypeID: Object.fromEntries(Object.keys(commodities).map((typeID) =>
      [typeID, inventory.countCargo(bot, Number(typeID))],
    )),
    commodities,
    expectedTax: Number(tax) || 0,
  };
  record(operation, "Launching " + countCommodityUnits(commodities) +
    " PI units from planet " + request.planetID + " after confirming " + volume.toFixed(2) + " m³ of free cargo.");
  saveOperation(operation);
  try {
    await planetary.invokeNormalPlanetLaunch(
      bot, request.planetID, request.commandPinID, commodities, operationKey,
    );
  } catch (error) {
    return block(operation, "holding", "PI launch attempt will be reconciled before any retry: " +
      String(error && error.message || error).slice(0, 180) + ".");
  }
  return { delayMs: TRAVEL_DELAY_MS, launched: false };
}

async function advancePlanetaryCollection(operation, bot) {
  const inventory = getInventory();
  const space = getSpace();
  if (operation.stage === "to-source") {
    const step = await travelToStation(operation, bot, operation.sourceStationID);
    if (step) return step;
    operation.stage = "collect";
    saveOperation(operation);
  }
  if (operation.stage === "return-to-source") {
    const step = await travelToStation(operation, bot, operation.sourceStationID);
    if (step) return step;
    operation.stage = "collect";
    saveOperation(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "collect") {
    const state = space.getSpaceState(bot);
    if (state.docked) {
      const result = space.undock(bot, { allowOverCapacityDeparture: true });
      if (!result.success) return result.capacityQueued
        ? { delayMs: TRAVEL_DELAY_MS, capacityQueued: true, capacityReason: result.message }
        : block(operation, "holding", result.message);
      return { delayMs: TRAVEL_DELAY_MS };
    }
    if (!state.inSpace || state.busy) return { delayMs: TRAVEL_DELAY_MS };
    if (operation.exportRequest && !operation.containerID) {
      return advancePIExportLaunch(operation, bot, state, inventory);
    }
    const hasPlanetaryCargo = () => inventory.listCargo(bot).some((item) =>
      require("../planet/planetStaticData").isPlanetaryCommodity(Number(item.typeID)));
    let distance = state.distanceTo(operation.containerID);
    if (distance === null) {
      const itemStore = require("../inventory/itemStore");
      const container = itemStore.findItemById(Number(operation.containerID));
      const contents = itemStore.listContainerItems(null, Number(operation.containerID));
      if (container && contents.length > 0) {
        if (Number(container.locationID) !== Number(state.systemID)) {
          const station = (worldData.getStationsForSystem(Number(container.locationID)) || [])[0];
          if (!station) return block(operation, "holding", `PI container ${operation.containerID} still has cargo in system ${container.locationID}, which has no station for a safe collection route.`);
          clearRouteTask(operation);
          operation.sourceStationID = Number(station.stationID);
          operation.stage = "return-to-source";
          record(operation, `PI container ${operation.containerID} is in system ${container.locationID}; routing back to collect it.`);
          saveOperation(operation);
          return { delayMs: TRAVEL_DELAY_MS };
        }
        const spawned = require("../../space/runtime").spawnDynamicInventoryEntity(Number(state.systemID), Number(operation.containerID));
        if (!spawned || !spawned.success) {
          return block(operation, "holding", `PI container ${operation.containerID} still has cargo but could not be restored in space: ${(spawned && spawned.errorMsg) || "UNKNOWN"}.`);
        }
        return { delayMs: TRAVEL_DELAY_MS };
      }
      if (!container && !hasPlanetaryCargo()) {
        if (Number(operation.launchID) > 0) {
          require("../planet/planetRuntimeStore").deleteLaunch(
            Number(operation.launchID), Number(bot.characterID),
          );
        }
        operation.containerID = null;
        operation.launchID = null;
        operation.stage = "to-market";
        record(operation, "The PI launch container no longer exists and the ship has no PI cargo; cleared the stale launch record.");
        saveOperation(operation);
        return { delayMs: STEP_DELAY_MS };
      }
      if (container && contents.length === 0) {
        if (Number(container.locationID) !== Number(state.systemID)) {
          const station = (worldData.getStationsForSystem(Number(container.locationID)) || [])[0];
          if (!station) return block(operation, "holding", `Empty PI container ${operation.containerID} remains in system ${container.locationID}, which has no station for a safe cleanup route.`);
          clearRouteTask(operation);
          operation.sourceStationID = Number(station.stationID);
          operation.stage = "return-to-source";
          record(operation, `Empty PI container ${operation.containerID} is in system ${container.locationID}; routing back to remove it.`);
          saveOperation(operation);
          return { delayMs: TRAVEL_DELAY_MS };
        }
        const runtime = require("../../space/runtime");
        const spawned = runtime.spawnDynamicInventoryEntity(Number(state.systemID), Number(operation.containerID));
        if (!spawned || !spawned.success) {
          return block(operation, "holding", `Empty PI container ${operation.containerID} could not be restored for cleanup: ${(spawned && spawned.errorMsg) || "UNKNOWN"}.`);
        }
        return { delayMs: TRAVEL_DELAY_MS };
      }
      operation.stage = "to-market";
      operation.collectAgain = false;
      record(operation, "The container is no longer available; taking the existing PI cargo to market.");
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    if (distance > DOCK_WARP_RANGE_METERS) {
      const result = space.warp(bot, operation.containerID);
      if (!result.success) return block(operation, "holding", result.message);
      return { delayMs: TRAVEL_DELAY_MS };
    }
    if (distance > 2000) {
      const result = space.approach(bot, operation.containerID);
      if (!result.success) return block(operation, "holding", result.message);
      return { delayMs: TRAVEL_DELAY_MS };
    }
    const loaded = inventory.loadFromContainer(bot, operation.containerID);
    if (!loaded.moved && loaded.remaining > 0 && !hasPlanetaryCargo()) {
      return block(operation, "holding", "Could not load the PI container; check cargo capacity and access.");
    }
    operation.unitsCollected = (Number(operation.unitsCollected) || 0) + Number(loaded.moved || 0);
    if (loaded.remaining > 0) {
      operation.collectAgain = true;
      operation.stage = "to-market";
      record(operation, "Collected " + loaded.moved + " PI units; " + loaded.remaining +
        " stack(s) remain. The bot will unload and return to this same container before ending the operation.");
      saveOperation(operation);
      return { delayMs: STEP_DELAY_MS };
    }
    const destroyed = require("../../space/runtime").destroyDynamicInventoryEntity(
      Number(state.systemID), Number(operation.containerID), {
        actor: Number(bot.characterID),
        idempotencyKey: "playerbot-pi-collection:" + operation.launchID + ":" + operation.containerID,
      },
    );
    if (!destroyed || !destroyed.success) {
      return block(operation, "holding", "Collected PI but could not remove empty space container " +
        operation.containerID + ": " + (destroyed && destroyed.errorMsg || "UNKNOWN") + ".");
    }
    require("../planet/planetRuntimeStore").deleteLaunch(Number(operation.launchID), Number(bot.characterID));
    operation.containerID = null;
    operation.launchID = null;
    operation.exportAttempt = null;
    operation.collectAgain = false;
    operation.stage = "to-market";
    record(operation, "Collected all PI cargo and removed its empty launch container; " +
      loaded.moved + " units are going to market.");
    saveOperation(operation);
  }
  return advanceSell(operation, bot);
}

async function advanceRelocation(operation, bot) {
  const step = await travelToStation(operation, bot, Number(operation.destinationStationID));
  if (step) return step;
  return finish(operation, "Relocation complete: arrived at station " + operation.destinationStationID +
    " in system " + stationSystemID(operation.destinationStationID) +
    " to spread autonomous work across systems.");
}

async function advanceFleetFollow(operation, bot, dependencies = {}) {
  const fleetRuntime = dependencies.fleetRuntime || require("../fleets/fleetRuntime");
  const sessionRegistry = dependencies.sessionRegistry || require("../chat/sessionRegistry");
  const playerBots = dependencies.playerBots || getPlayerBots();
  const space = dependencies.space || getSpace();
  const mapData = dependencies.worldData || worldData;
  const readCharacter = dependencies.getCharacterRecord || getCharacterRecord;
  const save = dependencies.save || saveOperation;
  const recordAction = dependencies.record || record;
  const complete = dependencies.finish || finish;
  const routeToSystem = dependencies.travelToSystem || travelToSystem;
  const routeToStation = dependencies.travelToStation || travelToStation;
  const clearRoute = dependencies.clearRouteTask || clearRouteTask;
  const pauseMs = 15_000;
  const positive = normalizePositiveInteger;
  const finishFollow = (message) => {
    if (operation && operation.routeTaskID) clearRoute(operation);
    return complete(operation, message);
  };
  const botID = positive(bot && bot.characterID);
  const targetID = positive(operation && operation.followTargetCharacterID);
  const fleetID = positive(operation && operation.fleetID);
  if (!botID || !targetID || !fleetID) {
    return finishFollow("Fleet follow stopped because its target or fleet record is missing.");
  }

  const botFleet = fleetRuntime.getMemberFleetForCharacter(botID);
  const targetFleet = fleetRuntime.getMemberFleetForCharacter(targetID);
  if (!botFleet || !targetFleet || Number(botFleet.fleetID) !== fleetID ||
      Number(targetFleet.fleetID) !== fleetID || !botFleet.members.has(targetID)) {
    return finishFollow("Fleet follow ended because the pilot and target are no longer together in the commanded fleet.");
  }

  const bots = playerBots.listBots();
  const botIDs = new Set(bots.map((entry) => positive(entry && entry.characterID)).filter(Boolean));
  if (![...botFleet.members.keys()].some((memberID) => !botIDs.has(positive(memberID)))) {
    return finishFollow("Fleet follow ended because no human pilot remains in the fleet.");
  }

  const targetSession = sessionRegistry.findSessionByCharacterID(targetID);
  if (!targetSession) return { delayMs: 30_000 };
  const targetCharacter = readCharacter(targetID) || {};
  const targetSystemID = positive(targetSession.solarsystemid2 || targetSession.solarsystemid ||
    targetSession.solarSystemID || targetCharacter.solarSystemID);
  if (!targetSystemID || !mapData.getSolarSystemByID(targetSystemID)) return { delayMs: pauseMs };

  const botCharacter = readCharacter(botID) || {};
  const botSession = space.getActorSession ? space.getActorSession(bot) : null;
  const botSystemID = positive(botCharacter.solarSystemID || botCharacter.solarsystemid ||
    botSession && (botSession.solarsystemid || botSession.solarSystemID));
  if (botSystemID !== targetSystemID) {
    const destinationChanged = positive(operation.routeDestinationSystemID) !== targetSystemID;
    if (destinationChanged && operation.routeTaskID) {
      clearRouteTask(operation);
      operation.routeTaskID = null;
      recordAction(operation, `The fleet target moved to system ${targetSystemID}; replacing the previous follow route.`);
    }
    if (destinationChanged) {
      operation.routeDestinationSystemID = targetSystemID;
      save(operation);
    }
    const step = await routeToSystem(operation, bot, targetSystemID);
    return step || { delayMs: pauseMs };
  }

  const targetStationID = positive(targetSession.stationID || targetSession.stationid ||
    targetSession.structureID || targetSession.structureid || targetCharacter.stationID ||
    targetCharacter.structureID);
  if (targetStationID) {
    const step = await routeToStation(operation, bot, targetStationID);
    return step || { delayMs: pauseMs };
  }

  const targetShipID = positive(targetSession.shipID || targetSession.shipid || targetCharacter.shipID);
  if (!targetShipID) return { delayMs: pauseMs };
  const state = space.getSpaceState(bot);
  if (!state.inSpace) {
    const undocked = space.undock(bot, { allowOverCapacityDeparture: true });
    if (!undocked.success) return { delayMs: undocked.capacityQueued ? pauseMs : 30_000 };
    recordAction(operation, `Undocked to follow fleet member ${targetID} in system ${targetSystemID}.`);
    save(operation);
    return { delayMs: pauseMs };
  }
  if (state.busy) return { delayMs: pauseMs };

  const actor = space.getActorSpace(bot);
  const targetEntity = actor && actor.scene && actor.scene.getEntityByID(targetShipID);
  if (!targetEntity) return { delayMs: pauseMs };
  const range = operation.followMode === "escort" ? 2_500 : 5_000;
  const currentTargetID = positive(actor.entity && actor.entity.followTargetID);
  const currentRange = Math.max(0, Number(actor.entity && actor.entity.followRange) || 0);
  const distance = state.distanceTo(targetShipID);
  if (!Number.isFinite(distance)) return { delayMs: pauseMs };
  // Keep re-evaluating long-range separation. A local Follow command does not
  // make a ship enter warp when its target warps elsewhere in the same system.
  // The busy check above prevents reissuing warp while this ship is in warp.
  if (distance <= 150_000 && currentTargetID === targetShipID &&
      Math.abs(currentRange - range) < 1) {
    return { delayMs: pauseMs };
  }
  const command = distance > 150_000
    ? space.warp(bot, targetShipID)
    : space.approach(bot, targetShipID, range);
  if (!command || command.success !== true) {
    const reason = String(command && command.message || "Movement authority refused the fleet follow command.");
    if (operation.lastFollowError !== reason) {
      operation.lastFollowError = reason;
      recordAction(operation, reason);
      save(operation);
    }
    return { delayMs: pauseMs };
  }
  delete operation.lastFollowError;
  operation.lastFollowTargetShipID = targetShipID;
  operation.lastFollowCommandAtMs = Date.now();
  recordAction(operation, distance > 150_000
    ? `Warping to fleet member ${targetID}'s ship ${targetShipID} in system ${targetSystemID}.`
    : `Following fleet member ${targetID}'s ship ${targetShipID} at ${range} m in system ${targetSystemID}.`);
  save(operation);
  return { delayMs: pauseMs };
}

const HANDLERS = {
  "threat-retreat": advanceThreatRetreat,
  relocate: advanceRelocation,
  "fleet-attack": (operation, bot) => require("./playerBotFleetAttackRuntime").advance(operation, bot, {
    fleetRuntime: require("../fleets/fleetRuntime"),
    playerBots: getPlayerBots(),
    sessionRegistry: require("../chat/sessionRegistry"),
    space: getSpace(),
    travelToSystem: (current, actor, systemID) => travelToSystem(current, actor, systemID),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    record,
    save: saveOperation,
    finish,
  }),
  "fleet-follow": (operation, bot) => advanceFleetFollow(operation, bot, {
    fleetRuntime: require("../fleets/fleetRuntime"),
    sessionRegistry: require("../chat/sessionRegistry"),
    playerBots: getPlayerBots(),
    space: getSpace(),
    travelToSystem: (current, actor, systemID) => travelToSystem(current, actor, systemID),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    record,
    save: saveOperation,
    block,
    finish,
  }),
  "pi-collect": advancePlanetaryCollection,
  colony: (operation, bot) => require("./playerBotColonyRuntime").advanceColony(operation, bot, COLONY_KIT),
  fulfill: advanceFulfill,
  sell: advanceSell,
  haul: advanceHaul,
  mine: advanceMining,
  upgrade: advanceUpgrade,
  fit: advanceUpgrade,
  combat: (operation, bot) => require("./playerBotCombatRuntime").advanceCombat(operation, bot, {
    space: getSpace(),
    inventory: getInventory(),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    travelToSystem: (current, actor, systemID) => travelToSystem(current, actor, systemID),
    maybeBeginRegionalSaleRoute,
    sellMiningOutput,
    record,
    save: saveOperation,
    block,
    finish,
    startCombatReplenishment: (current, actor) => startCombatReplenishment(current, actor),
  }),
  sovereignty: (operation, bot) => require("./playerBotSovereigntyRuntime").advanceSovereignty(operation, bot, {
    space: getSpace(),
    inventory: getInventory(),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    travelToSystem: (current, actor, systemID) => travelToSystem(current, actor, systemID),
    record,
    save: saveOperation,
    block,
    finish,
  }),
  "alliance-courier": (operation, bot) => require("./playerBotAllianceLogisticsRuntime").advance(operation, bot, {
    space: getSpace(),
    inventory: getInventory(),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    record,
    save: saveOperation,
    block,
    finish,
  }),
  "alliance-founding": (operation, bot) => require("./playerBotAllianceRuntime").advance(operation, bot, {
    record,
    save: saveOperation,
    block,
    finish,
  }),
  "structure-procurement": (operation, bot) => require("./playerBotStructureRuntime").advanceProcurement(operation, bot, {
    inventory: getInventory(),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    buyMarketUnits: (current, actor, typeID, quantity, stationID) => buyUnits(current, actor, typeID, quantity, stationID),
    record,
    save: saveOperation,
    block,
    finish,
  }),
  "structure-core-install": (operation, bot) => require("./playerBotStructureRuntime").advanceCoreInstall(operation, bot, {
    space: getSpace(),
    inventory: getInventory(),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    buyMarketUnits: (current, actor, typeID, quantity, stationID) => buyUnits(current, actor, typeID, quantity, stationID),
    boardShip: (actor, hullItem) => boardShip(actor, hullItem),
    record,
    save: saveOperation,
    block,
    finish,
  }),
  "structure-service-provision": (operation, bot) => require("./playerBotStructureRuntime").advanceStructureServiceProvision(operation, bot, {
    space: getSpace(),
    inventory: getInventory(),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    record,
    save: saveOperation,
    block,
    finish,
  }),
  "structure-deployment": (operation, bot) => require("./playerBotStructureRuntime").advance(operation, bot, {
    space: getSpace(),
    inventory: getInventory(),
    travelToStation: (current, actor, stationID) => travelToStation(current, actor, stationID),
    travelToSystem: (current, actor, systemID) => travelToSystem(current, actor, systemID),
    record,
    save: saveOperation,
    block,
    finish,
  }),
};

function canRunIndependentWorkAlongsideIndustryReview(cycle, requested) {
  return requested === true && Boolean(cycle) &&
    String(cycle.status || "").toLowerCase() === "review" &&
    !cycle.pending && !Number(cycle.jobID);
}

function assertCanStart(bot, options = {}) {
  if (!bot) return "Playerbot not found.";
  if (interruptions.hasPending(bot.characterID) || interruptions.isBusy(bot.characterID) ||
      require("./playerBotLocalDefenseAdapter").hasLease(bot.characterID))
    return "The pilot is completing a step or emergency handoff.";
  const current = getOperation(bot.characterID);
  if (current && current.kind === "upgrade" && current.resumeCombat &&
      !["stopped", "completed"].includes(current.status)) {
    return `${bot.characterName} is replenishing its combat fit to resume ${current.resumeCombat.siteLabel || "the active anomaly"}; resolve or stop that operation first.`;
  }
  if (current && (["active", "holding", "review"].includes(current.status) || current.pending ||
      current.loadSheddingPaused === true)) {
    return `${bot.characterName} already has operation ${current.operationID} (${current.kind}/${current.stage}, ${current.status}). Resolve or stop it first.`;
  }
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID);
  const independentReviewWork = canRunIndependentWorkAlongsideIndustryReview(
    cycle,
    options.allowIndependentIndustryReview === true,
  );
  if (cycle && (["active", "holding"].includes(cycle.status) || cycle.pending ||
      cycle.status === "review" && !independentReviewWork)) {
    return `${bot.characterName} is in industry cycle ${cycle.cycleID}; stop it first.`;
  }
  return null;
}

function baseOperation(kind, bot, fields) {
  const character = getCharacterRecord(bot.characterID) || {};
  return {
    operationID: `OP${bot.characterID}-${Date.now()}`,
    kind,
    characterID: Number(bot.characterID),
    characterName: bot.characterName,
    corporationID: Number(character.corporationID || bot.corporationID) || 0,
    status: "active",
    routeTaskID: null,
    trips: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    history: [],
    ...fields,
  };
}

function startFleetFollow(botQuery, targetCharacterID, followMode, requesterCharacterID, fleetID) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found for ${botQuery}.` };
  if (bot.status === "paused" || bot.autonomyPaused === true) {
    return { success: false, message: `${bot.characterName} is paused and cannot take a fleet movement order.` };
  }
  const targetID = normalizePositiveInteger(targetCharacterID);
  const requesterID = normalizePositiveInteger(requesterCharacterID);
  const commandedFleetID = normalizePositiveInteger(fleetID);
  const mode = String(followMode || "follow").toLowerCase() === "escort" ? "escort" : "follow";
  const fleetRuntime = require("../fleets/fleetRuntime");
  const botFleet = fleetRuntime.getMemberFleetForCharacter(bot.characterID);
  const requesterFleet = fleetRuntime.getMemberFleetForCharacter(requesterID);
  const targetFleet = fleetRuntime.getMemberFleetForCharacter(targetID);
  if (!targetID || !requesterID || !commandedFleetID ||
      !botFleet || !requesterFleet || !targetFleet ||
      Number(botFleet.fleetID) !== commandedFleetID ||
      Number(requesterFleet.fleetID) !== commandedFleetID ||
      Number(targetFleet.fleetID) !== commandedFleetID) {
    return { success: false, message: `${bot.characterName} and the requested human target must still be members of the same fleet.` };
  }
  if (getPlayerBots().listBots().some((entry) => Number(entry.characterID) === targetID)) {
    return { success: false, message: "Fleet follow targets must be a human fleet member." };
  }
  if (!require("../chat/sessionRegistry").findSessionByCharacterID(targetID)) {
    return { success: false, message: "The selected fleet target is not online." };
  }
  if (mode === "escort" && (bot.specialty !== "security" || !hasRoleShipFit(bot, "security"))) {
    return { success: false, message: `${bot.characterName} needs a complete security combat fit to join the fleet as an escort.` };
  }

  const current = getOperation(bot.characterID);
  if (current && current.kind === "fleet-follow" && ACTIVE_STATUSES.has(current.status)) {
    current.followTargetCharacterID = targetID;
    current.requestedByCharacterID = requesterID;
    current.fleetID = commandedFleetID;
    current.followMode = mode;
    current.lastFollowError = null;
    record(current, `${bot.characterName} retargeted its ${mode} order to human fleet member ${targetID}.`);
    saveOperation(current);
    require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
      require("../../utils/logger").warn(`[PlayerBots] Could not wake fleet-follow order char=${bot.characterID}: ${error.message}`));
    return { success: true, operation: current, message: `${bot.characterName} is following human fleet member ${targetID}.` };
  }

  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID);
  if (cycle && (["active", "holding", "review"].includes(cycle.status) || cycle.pending)) {
    return { success: false, message: `${bot.characterName} is finishing industry cycle ${cycle.cycleID}; its production will not be interrupted for fleet movement.` };
  }
  if (current && (current.pending || current.status === "review" || current.loadSheddingPaused === true)) {
    return { success: false, message: `${bot.characterName}'s ${current.kind} operation has unresolved work; it must reconcile before taking a fleet movement order.` };
  }
  if (current && ACTIVE_STATUSES.has(current.status)) {
    if (current.kind !== "mine") {
      return { success: false, message: `${bot.characterName} is completing ${current.kind}/${current.stage}; it will keep that work and can follow after it reaches a safe checkpoint.` };
    }
    const stopped = stopOperation(bot.characterName);
    if (!stopped.success) return { success: false, message: stopped.message };
    const afterStop = getOperation(bot.characterID);
    if (afterStop && ACTIVE_STATUSES.has(afterStop.status)) {
      return { success: false, message: `${bot.characterName} is safely stopping its mining operation; send the fleet order again after it reaches a safe checkpoint.` };
    }
  }

  const operation = baseOperation("fleet-follow", bot, {
    stage: "following",
    followTargetCharacterID: targetID,
    requestedByCharacterID: requesterID,
    fleetID: commandedFleetID,
    followMode: mode,
    routeDestinationSystemID: 0,
    lastFollowTargetShipID: 0,
    lastFollowCommandAtMs: 0,
    userDirected: true,
  });
  record(operation, `${bot.characterName} accepted a ${mode} movement order from human fleet member ${requesterID}, targeting ${targetID}.`);
  saveOperation(operation);
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not wake fleet-follow order char=${bot.characterID}: ${error.message}`));
  return { success: true, operation, message: `${bot.characterName} accepted the ${mode} order and will follow human fleet member ${targetID}.` };
}

function startFleetAttack(botQuery, target = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found for ${botQuery}.` };
  if (bot.status === "paused" || bot.autonomyPaused === true) {
    return { success: false, message: `${bot.characterName} is paused and cannot take a Fleet attack order.` };
  }
  const targetID = normalizePositiveInteger(target.targetID);
  const targetSystemID = normalizePositiveInteger(target.targetSystemID);
  const requesterID = normalizePositiveInteger(target.requesterCharacterID);
  const commandedFleetID = normalizePositiveInteger(target.fleetID);
  const role = ["security", "piracy"].includes(String(target.role || "").toLowerCase())
    ? String(target.role).toLowerCase()
    : "";
  if (!targetID || !targetSystemID || !requesterID || !commandedFleetID || !role) {
    return { success: false, message: "Fleet attack is missing its target, human commander, fleet, system, or validated combat role." };
  }
  const fleetRuntime = require("../fleets/fleetRuntime");
  const botFleet = fleetRuntime.getMemberFleetForCharacter(bot.characterID);
  const requesterFleet = fleetRuntime.getMemberFleetForCharacter(requesterID);
  const requesterSession = require("../chat/sessionRegistry").findSessionByCharacterID(requesterID);
  if (!botFleet || !requesterFleet || Number(botFleet.fleetID) !== commandedFleetID ||
      Number(requesterFleet.fleetID) !== commandedFleetID || !botFleet.members.has(requesterID) ||
      !requesterSession || getPlayerBots().listBots().some((entry) => Number(entry.characterID) === requesterID)) {
    return { success: false, message: `${bot.characterName} and an online human commander must remain in Fleet ${commandedFleetID}.` };
  }
  if (!hasRoleShipFit(bot, role)) {
    return { success: false, message: `${bot.characterName} no longer has a complete, online ${role} combat fit.` };
  }
  const existing = getOperation(bot.characterID);
  if (existing && existing.kind === "fleet-attack" && ACTIVE_STATUSES.has(existing.status) &&
      Number(existing.fleetID) === commandedFleetID &&
      Number(existing.requestedByCharacterID) === requesterID) {
    if (existing.stopRequested === true || existing.stage === "retreat") {
      return { success: false, message: `${bot.characterName} is already withdrawing from its previous attack; wait for it to reach base before assigning another target.` };
    }
    clearRouteTask(existing);
    Object.assign(existing, {
      targetID,
      targetCharacterID: normalizePositiveInteger(target.targetCharacterID),
      targetSystemID,
      targetTypeID: normalizePositiveInteger(target.targetTypeID),
      targetName: String(target.targetName || targetID).slice(0, 100),
      mode: String(target.mode || "security"),
      role,
      targetMissingSinceAtMs: 0,
      stopRequested: false,
      stopReason: "",
      stage: "engage",
      routeDestinationSystemID: 0,
      routeTaskID: null,
      lastMovementError: "",
    });
    record(existing, `${bot.characterName} retargeted the human fleet command to ship ${targetID}.`);
    saveOperation(existing);
    require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
      require("../../utils/logger").warn(`[PlayerBots] Could not wake fleet attack char=${bot.characterID}: ${error.message}`));
    return { success: true, operation: existing, message: `${bot.characterName} is changing to the new locked Fleet target.` };
  }

  const character = getCharacterRecord(bot.characterID) || {};
  let homeStationID = normalizePositiveInteger(character.stationID || character.structureID);
  if (!homeStationID && existing && normalizePositiveInteger(existing.homeStationID)) {
    homeStationID = normalizePositiveInteger(existing.homeStationID);
  }
  const economy = require("./playerBotEconomyRuntime");
  if (!homeStationID || economy.isJitaStation(homeStationID)) {
    homeStationID = Number(hubStationFor(bot)) || 0;
  }
  if (!homeStationID) return { success: false, message: `No safe home station is configured for ${bot.characterName}.` };

  if (existing && (existing.pending || existing.status === "review" || existing.loadSheddingPaused === true)) {
    return { success: false, message: `${bot.characterName}'s ${existing.kind} operation has unresolved work; it must reconcile before a Fleet attack.` };
  }
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID);
  if (cycle && (["active", "holding", "review"].includes(cycle.status) || cycle.pending)) {
    return { success: false, message: `${bot.characterName} is finishing industry cycle ${cycle.cycleID}; it will not be interrupted for a Fleet attack.` };
  }
  if (existing && ACTIVE_STATUSES.has(existing.status)) {
    if (!["mine", "fleet-follow"].includes(existing.kind)) {
      return { success: false, message: `${bot.characterName} is completing ${existing.kind}/${existing.stage}; that operation will not be interrupted for combat.` };
    }
    const stopped = stopOperation(bot.characterName);
    if (!stopped.success) return { success: false, message: stopped.message };
    const stoppedOperation = getOperation(bot.characterID);
    if (stoppedOperation && ACTIVE_STATUSES.has(stoppedOperation.status)) {
      return { success: false, message: `${bot.characterName} is safely ending ${existing.kind}; repeat the attack order after its safe checkpoint.` };
    }
  }

  const fitProfile = getRoleShipFitProfile(bot, role);
  if (!fitProfile) return { success: false, message: `${bot.characterName}'s ${role} fit profile is unavailable.` };
  const operation = baseOperation("fleet-attack", bot, {
    stage: "engage",
    mode: String(target.mode || "security"),
    role,
    targetID,
    targetCharacterID: normalizePositiveInteger(target.targetCharacterID),
    targetSystemID,
    targetTypeID: normalizePositiveInteger(target.targetTypeID),
    targetName: String(target.targetName || targetID).slice(0, 100),
    requestedByCharacterID: requesterID,
    fleetID: commandedFleetID,
    homeStationID,
    routeDestinationSystemID: 0,
    maxSiteDifficulty: Number(fitProfile.maxSiteDifficulty) || 1,
    requiredDroneTypes: (fitProfile.droneTypeIDs || []).map(Number).filter(Boolean),
    droneDamageTypeByID: { ...(fitProfile.droneDamageTypeByID || {}) },
    requiredModuleTypes: (fitProfile.moduleTypeIDs || []).map(Number).filter(Boolean),
    userDirected: true,
    autonomous: false,
    stopRequested: false,
    stopReason: "",
  });
  record(operation, `${bot.characterName} accepted a human Fleet attack order for ${target.targetName || `ship ${targetID}`} (${targetID}); policy ${operation.mode}, fleet ${commandedFleetID}.`);
  saveOperation(operation);
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not wake fleet attack char=${bot.characterID}: ${error.message}`));
  return { success: true, operation, message: `${bot.characterName} accepted the Fleet attack order for ${target.targetName || targetID}.` };
}

function requestFleetAttackStop(botQuery, requesterCharacterID = 0, fleetID = 0) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found for ${botQuery}.` };
  const operation = getOperation(bot.characterID);
  if (!operation || operation.kind !== "fleet-attack" ||
      ![...ACTIVE_STATUSES, "blocked", "review"].includes(operation.status)) {
    return { success: true, message: `${bot.characterName} has no active Fleet attack order.` };
  }
  if ((requesterCharacterID && Number(operation.requestedByCharacterID) !== Number(requesterCharacterID)) ||
      (fleetID && Number(operation.fleetID) !== Number(fleetID))) {
    return { success: false, message: `${bot.characterName}'s Fleet attack belongs to another commander or fleet.` };
  }
  operation.stopRequested = true;
  operation.stopReason = "Fleet commander stopped the attack.";
  operation.stage = "retreat";
  operation.status = "active";
  operation.lastError = null;
  record(operation, `${operation.stopReason} Recalling drones and returning to station.`);
  saveOperation(operation);
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not wake Fleet attack withdrawal char=${bot.characterID}: ${error.message}`));
  return { success: true, operation, graceful: true, message: `${bot.characterName} is recalling drones and returning to station.` };
}

function commandFleetFollow(session, followMode, targetQuery = "", dependencies = {}) {
  const requesterID = normalizePositiveInteger(session &&
    (session.characterID || session.charID || session.charid));
  const mode = String(followMode || "").trim().toLowerCase();
  if (!requesterID || !["follow", "escort"].includes(mode)) {
    return { success: false, message: "Fleet movement commands require a connected fleet member and a valid follow or escort mode." };
  }
  const fleetRuntime = dependencies.fleetRuntime || require("../fleets/fleetRuntime");
  const playerBots = dependencies.playerBots || getPlayerBots();
  const sessionRegistry = dependencies.sessionRegistry || require("../chat/sessionRegistry");
  const readOperation = dependencies.getOperation || getOperation;
  const stopBotOperation = dependencies.stopOperation || stopOperation;
  const startBotFollow = dependencies.startFleetFollow || startFleetFollow;
  const canEscort = dependencies.hasRoleShipFit || hasRoleShipFit;
  const fleet = fleetRuntime.getMemberFleetForCharacter(requesterID);
  if (!fleet || !fleet.members.has(requesterID)) {
    return { success: false, message: "Join a fleet before issuing /follow or /escort orders." };
  }
  const allBots = playerBots.listBots();
  const botIDs = new Set(allBots.map((bot) => Number(bot.characterID)));
  const humanIDs = [...fleet.members.keys()].map(Number).filter((id) => id > 0 && !botIDs.has(id));
  if (!humanIDs.length) return { success: false, message: "A human pilot must remain in the fleet to command playerbots." };
  const sessions = sessionRegistry.getSessions();
  const onlineHumans = sessions.filter((entry) => humanIDs.includes(Number(
    entry.characterID || entry.charID || entry.charid,
  )));
  const query = String(targetQuery || "").trim();
  const stop = /^stop$/i.test(query);
  const targetText = query.replace(/^to\s+/i, "");
  let targetID = requesterID;
  if (targetText && !/^(me|self)$/i.test(targetText) && !stop) {
    const numericTarget = normalizePositiveInteger(targetText);
    const matching = onlineHumans.filter((entry) =>
      numericTarget
        ? Number(entry.characterID || entry.charID || entry.charid) === numericTarget
        : String(entry.characterName || entry.charname || entry.name || "").trim().toLowerCase() === targetText.toLowerCase(),
    );
    if (matching.length !== 1) {
      return { success: false, message: `Target must be one unique online human member of fleet ${fleet.fleetID}; use /${mode} me or an exact fleet character name.` };
    }
    targetID = Number(matching[0].characterID || matching[0].charID || matching[0].charid);
  }

  const fleetBots = allBots.filter((bot) => fleet.members.has(Number(bot.characterID)));
  if (stop) {
    const stopped = [];
    for (const bot of fleetBots) {
      const operation = readOperation(bot.characterID);
      if (!operation || operation.kind !== "fleet-follow" ||
          ![...ACTIVE_STATUSES, "blocked", "review"].includes(operation.status) ||
          (mode === "escort" && operation.followMode !== "escort") ||
          (mode === "follow" && operation.followMode !== "follow")) continue;
      const result = stopBotOperation(bot.characterName);
      if (result.success) stopped.push(bot.characterName);
    }
    return {
      success: true,
      message: stopped.length
        ? `Stopped ${mode} orders for ${stopped.length} fleet bot(s): ${stopped.join(", ")}. They will return to director-assigned work.`
        : `No active fleet ${mode} orders were found to stop.`,
    };
  }

  if (!fleetBots.length) return { success: false, message: `No playerbots are currently in fleet ${fleet.fleetID}.` };
  const eligible = mode === "escort"
    ? fleetBots.filter((bot) => bot.specialty === "security" && canEscort(bot, "security"))
    : fleetBots;
  if (!eligible.length) {
    return { success: false, message: mode === "escort"
      ? "No security playerbot in this fleet has a complete validated combat fit for escort duty."
      : `No playerbots are currently in fleet ${fleet.fleetID}.` };
  }
  const results = eligible.map((bot) => startBotFollow(
    bot.characterName, targetID, mode, requesterID, Number(fleet.fleetID),
  ));
  const accepted = results.filter((result) => result.success).length;
  const refused = results.filter((result) => !result.success);
  const summary = `${accepted}/${eligible.length} fleet bot(s) accepted /${mode} for ${targetID}.`;
  return {
    success: accepted > 0,
    message: refused.length
      ? `${summary} ${refused.map((result) => result.message).slice(0, 3).join(" ")}`
      : summary,
  };
}

function startHaul(botQuery, itemOrTypeID, fromStationID, toStationID, quantity = null) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const from = normalizePositiveInteger(fromStationID);
  const to = normalizePositiveInteger(toStationID);
  if (!worldData.getStationByID(from) || !worldData.getStationByID(to) || from === to) {
    return { success: false, message: "Origin and destination must be two different existing stations." };
  }
  const reference = normalizePositiveInteger(itemOrTypeID);
  const itemStore = require("../inventory/itemStore");
  const item = itemStore.findItemById(reference);
  const isItem = item && Number(item.ownerID) === Number(bot.characterID);
  const operation = baseOperation("haul", bot, {
    stage: "to-source",
    fromStationID: from,
    toStationID: to,
    itemID: isItem ? reference : null,
    typeID: isItem ? Number(item.typeID) : reference,
    quantity: normalizePositiveInteger(quantity) || null,
    moved: 0,
    delivered: {},
  });
  record(operation, `Hauling ${isItem ? `item ${reference}` : `type ${reference}`} from ${from} to ${to}.`);
  saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will haul ${isItem ? `item ${reference}` : `type ${reference}`}${operation.quantity ? ` (${operation.quantity} units)` : ""} from ${from} to ${to} (operation ${operation.operationID}).` };
}

function startAllianceCourier(botQuery, contractID, options = {}) {
  const numericContractID = normalizePositiveInteger(contractID);
  if (!numericContractID) return { success: false, message: "Contract ID must be a positive integer." };
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const logistics = require("./playerBotAllianceLogisticsRuntime");
  const selected = logistics.inspectAssignedCourier(bot, numericContractID);
  if (!selected) return { success: false, message: "No unexpired courier contract assigned to this bot, its corporation or its alliance is available." };
  const capacity = logistics.validateCourierCapacity(bot, selected.contract);
  if (!capacity.success) return capacity;
  const operation = baseOperation("alliance-courier", bot, {
    stage: "accept",
    contractID: Number(selected.contract.contractID),
    startStationID: Number(selected.contract.startStationID),
    endStationID: Number(selected.contract.endStationID),
    wrapItemID: Number(selected.contract.plasticWrapItemID) || null,
    plannedRouteHops: selected.route.hops,
    routeRisk: selected.route.risk,
    packageVolume: capacity.volume,
    collateral: capacity.collateral,
    startingBalance: capacity.balance,
    pendingContractAction: null,
    autonomous: options.autonomous === true,
  });
  record(operation, `Prepared assigned alliance courier contract ${operation.contractID}: ${operation.startStationID} to ${operation.endStationID}, ${operation.packageVolume.toFixed(2)} m³, ${operation.collateral.toFixed(2)} ISK collateral.`);
  saveOperation(operation);
  return {
    success: true,
    operation,
    message: `${bot.characterName} will deliver assigned courier contract ${operation.contractID} across ${operation.plannedRouteHops} jump(s).`,
  };
}

function startAllianceFounding(botQuery, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const alliance = require("./playerBotAllianceRuntime");
  const plan = alliance.getAllianceFoundingPlan(bot);
  if (!plan) return { success: false, message: `${bot.characterName} needs persisted CEO or Director authority, Empire Control V, no existing alliance, and enough wallet funds to pay the 1,000,000,000 ISK founding fee while keeping the initial 1,000,000,000 ISK seed reserve intact.` };
  return alliance.start(bot, plan, {
    ...options,
    operationTools: { assertCanStart, baseOperation, record, saveOperation },
  });
}

function startMining(botQuery, maxTrips = 1, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot, {
    allowIndependentIndustryReview: options.autonomous === true && options.industryReviewFallback === true,
  });
  if (refusal) return { success: false, message: refusal };
  const character = getCharacterRecord(bot.characterID) || {};
  let homeStationID = normalizePositiveInteger(options.stationID);
  if (homeStationID && !(worldData.getAsteroidBeltsForSystem(stationSystemID(homeStationID)) || []).length) {
    return { success: false, message: `The system for ${homeStationID} has no asteroid belts.` };
  }
  const marketStationWasConfigured = Boolean(normalizePositiveInteger(options.marketStationID));
  if (!homeStationID) {
    const currentStationID = normalizePositiveInteger(character.stationID);
    const economy = require("./playerBotEconomyRuntime");
    const currentSystemID = normalizePositiveInteger(character.solarSystemID) || stationSystemID(currentStationID);
    const currentSystem = worldData.getSolarSystemByID(currentSystemID) || {};
    // Keep dispersed miners at their local base. Shipping every fresh mining
    // assignment back to the hub undoes the director's capacity relocation.
    const localBase = currentStationID && !economy.isJitaStation(currentStationID) &&
      Number(currentSystem.security) >= 0.45 &&
      (worldData.getAsteroidBeltsForSystem(currentSystemID) || []).length
      ? { systemID: currentSystemID, stationID: currentStationID }
      : null;
    // Jita is the seed market, not a mining home. Once a bot has bought its
    // starter hull there, send it to the nearest safe belt system outside Jita.
    const excludedSystems = [require("./playerBotEconomyRuntime").JITA_SYSTEM_ID];
    const nearest = localBase || findNearestMiningStation(currentSystemID, 0.45, 15, excludedSystems) ||
      findNearestMiningStation(stationSystemID(hubStationFor(bot)), 0.45, 15, excludedSystems);
    if (!nearest) return { success: false, message: "No high-security system with an asteroid belt and station was found within 15 jumps." };
    homeStationID = currentStationID && !economy.isJitaStation(currentStationID) &&
      stationSystemID(currentStationID) === nearest.systemID ? currentStationID : nearest.stationID;
  }
  if (!worldData.getStationByID(homeStationID)) {
    const structure = typeof worldData.getStructureByID === "function"
      ? worldData.getStructureByID(homeStationID)
      : null;
    const characterCorporationID = normalizePositiveInteger(character.corporationID || bot.corporationID);
    const structureCorporationID = normalizePositiveInteger(structure && (structure.ownerCorpID || structure.ownerID));
    if (!structure || structureCorporationID !== characterCorporationID || structure.hasQuantumCore !== true ||
        structure.destroyedAt || structure.unanchoring) {
      return { success: false, message: "Specify a valid station or an operational, core-powered corporation structure." };
    }
    try {
      const structureState = require("../structure/structureState");
      const session = require("./playerBotSpaceRuntime").getActorSession(bot);
      const docking = structureState.isDockingServiceOnline(structure) &&
        structureState.canCharacterDockAtStructure(session, structure, {
          shipTypeID: normalizePositiveInteger(session && session.shipTypeID) || undefined,
        });
      if (!docking || docking.success !== true) {
        return { success: false, message: `Corporation structure ${homeStationID} is not currently dockable by ${bot.characterName}.` };
      }
    } catch (error) {
      return { success: false, message: `Could not verify docking access to corporation structure ${homeStationID}: ${String(error && error.message || error).slice(0, 120)}.` };
    }
  }
  const marketStationID = options.marketStationID === null ? null
    : normalizePositiveInteger(options.marketStationID) ||
      (require("./playerBotEconomyRuntime").isJitaStation(homeStationID) ? hubStationFor(bot) : homeStationID);
  const trips = Math.min(MAX_TRIPS, Math.max(1, normalizePositiveInteger(maxTrips) || 1));
  const operation = baseOperation("mine", bot, {
    stage: "to-home",
    homeStationID,
    maxTrips: trips,
    maxTripMs: DEFAULT_MINING_TRIP_MS,
    refine: options.refine !== false,
    sell: options.sell !== false,
    marketStationID,
    optimizeMarketDestination: options.optimizeMarketDestination === true || !marketStationWasConfigured,
    territorialOperation: options.territorialOperation === true,
    unitsListed: 0,
    brokerFees: 0,
    autonomous: options.autonomous === true,
    unitsSold: 0,
    proceeds: 0,
    beltID: null,
    tripStartedAt: null,
    oreMined: {},
    mineralsRefined: {},
    miningCycleYield: {},
    miningCargoSnapshot: null,
    miningPhaseKey: null,
  });
  record(operation, `Mining from ${homeStationID}: ${trips} trip(s)${operation.refine ? "; ore will be reprocessed" : ""}${operation.sell ? "; output will be sold or listed" : "; output will stay in the personal hangar"}.`);
  saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will mine from ${homeStationID} for ${trips} trip(s)${operation.refine ? " and reprocess the ore" : ""}${operation.sell ? " and sell or list the output" : "; output will remain in the personal hangar"} (operation ${operation.operationID}).` };
}

function canStartCombatModeForPilot(bot, mode, hasCombatFit) {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  const shipRole = ["war", "nullsec-conflict"].includes(normalizedMode) ? "security" : normalizedMode;
  return Boolean(bot && (bot.specialty === shipRole ||
    normalizedMode === "war" && hasCombatFit === true));
}

function startCombat(botQuery, mode = "security", options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const normalizedMode = String(mode || "").trim().toLowerCase();
  if (!["security", "piracy", "war", "nullsec-conflict"].includes(normalizedMode)) {
    return { success: false, message: "Combat mode must be security, war, piracy, or nullsec-conflict." };
  }
  if (normalizedMode === "war" &&
      !require("../corporation/warRuntimeState").hasActiveWarForCharacter(bot.characterID)) {
    return { success: false, message: "War patrol requires an active war; declarations still in the waiting period only allow preparation." };
  }
  const shipRole = ["war", "nullsec-conflict"].includes(normalizedMode) ? "security" : normalizedMode;
  const hasCombatFit = hasRoleShipFit(bot, shipRole);
  // The war director deliberately mobilizes any cross-trained pilot whose
  // security fit can participate. Keep specialty-specific patrols restricted
  // to their own role, but do not reject those valid war assignments.
  if (!canStartCombatModeForPilot(bot, normalizedMode, hasCombatFit)) {
    return { success: false, message: `${bot.characterName} needs the ${shipRole} specialty to start a ${normalizedMode} patrol.` };
  }
  if (!hasCombatFit) {
    return { success: false, message: `${bot.characterName} needs a complete, online ${shipRole} combat fit with sufficient drone capacity, Dogma range and capacitor stability before starting a ${normalizedMode} patrol.` };
  }
  const combat = require("./playerBotCombatRuntime");
  const hubStationID = hubStationFor(bot);
  const fitProfile = getRoleShipFitProfile(bot, shipRole);
  let miningEscortTarget = null;
  const miningEscortForCharacterID = normalizePositiveInteger(options.miningEscortForCharacterID);
  if (miningEscortForCharacterID) {
    if (normalizedMode !== "security") {
      return { success: false, message: "A mining escort must use the validated security combat fit." };
    }
    const miningOperation = getOperation(miningEscortForCharacterID);
    if (!miningOperation || miningOperation.kind !== "mine" ||
        !ACTIVE_STATUSES.has(miningOperation.status) ||
        !["to-belt", "mining"].includes(miningOperation.stage)) {
      return { success: false, message: "The mining operation is no longer active on an asteroid belt." };
    }
    const systemID = stationSystemID(miningOperation.homeStationID);
    const beltID = normalizePositiveInteger(miningOperation.beltID);
    const groupKey = require("./playerBotMiningEscortRuntime").getMiningEscortGroupKey(systemID, beltID);
    const requiredTier = require("./playerBotMiningEscortRuntime").getRequiredSecurityFitTier(systemID);
    if (!groupKey || !(worldData.getAsteroidBeltsForSystem(systemID) || []).some((entry) => Number(entry.itemID) === beltID)) {
      return { success: false, message: "The mining operation has no valid asteroid belt for its security escort." };
    }
    if (Number(fitProfile && fitProfile.maxSiteDifficulty) < requiredTier) {
      return { success: false, message: `The fitted security ship is tier ${Number(fitProfile && fitProfile.maxSiteDifficulty) || 0}; belt security ${Number((worldData.getSolarSystemByID(systemID) || {}).security).toFixed(3)} requires tier ${requiredTier}.` };
    }
    const route = getSpace().previewSystemRoute(bot, systemID);
    if (!route || route.success !== true) {
      return { success: false, message: route && route.message || `No route is available to mining belt system ${systemID}.` };
    }
    miningEscortTarget = {
      success: true,
      stationID: Number(miningOperation.homeStationID),
      systemID,
      beltID,
      groupKey,
      requiredTier,
      fitTier: Number(fitProfile.maxSiteDifficulty) || 0,
      hops: Number(route.hops) || 0,
      risk: route.risk || null,
    };
  }
  const priorOperation = getOperation(bot.characterID);
  const failedAnomalySites = (Array.isArray(priorOperation && priorOperation.failedAnomalySites)
    ? priorOperation.failedAnomalySites
    : []).filter((entry) => Number(entry && entry.failedAtMs) > Date.now() - 60 * 60 * 1000);
  const defensiveTargetID = normalizePositiveInteger(options.defensiveTargetID);
  const anomalyTarget = !defensiveTargetID && !miningEscortTarget && normalizedMode === "security"
    ? combat.findNearestCombatAnomalyBase(bot, fitProfile, 20, {
      excludedSiteInstanceIDs: failedAnomalySites.map((entry) => Number(entry.siteInstanceID)).filter(Boolean),
      targetDifficulty: require("./playerBotCombatProgressRuntime")
        .getNextSiteDifficulty(bot.characterID, fitProfile && fitProfile.maxSiteDifficulty),
    })
    : { success: false };
  const warTarget = !defensiveTargetID && !miningEscortTarget && normalizedMode === "war" ? combat.findNearestWarBase(bot) : { success: false };
  const conflictTarget = !defensiveTargetID && !miningEscortTarget && normalizedMode === "nullsec-conflict"
    ? combat.findNearestNullsecConflictBase(bot)
    : { success: false };
  let target;
  if (defensiveTargetID) {
    const currentSystemID = Number((getCharacterRecord(bot.characterID) || {}).solarSystemID) || 0;
    const stationID = findThreatEvacuationStation(bot);
    target = stationID && currentSystemID
      ? { success: true, stationID, systemID: currentSystemID, hops: 0, risk: null, mode: "defensive-response" }
      : { success: false, message: "Could not determine a safe station for the defensive response." };
  } else if (miningEscortTarget) target = miningEscortTarget;
  else if (normalizedMode === "nullsec-conflict") target = conflictTarget;
  else if (normalizedMode === "piracy") target = combat.findNearestPirateBase(bot);
  else if (normalizedMode === "war") target = warTarget;
  else if (anomalyTarget.success) target = anomalyTarget;
  else {
    const currentSystemID = Number((getCharacterRecord(bot.characterID) || {}).solarSystemID) || 0;
    const localStation = (worldData.getStationsForSystem(currentSystemID) || [])[0];
    target = localStation && (worldData.getAsteroidBeltsForSystem(currentSystemID) || []).length
      ? { success: true, stationID: Number(localStation.stationID), systemID: currentSystemID, hops: 0, risk: null, mode: "belt" }
      : { success: false, message: `${anomalyTarget.message || "No suitable local patrol site"}; no local asteroid belt is available.` };
  }
  if (!target.success) return { success: false, message: target.message };
  const operation = baseOperation("combat", bot, {
    stage: defensiveTargetID ? "engage" : "to-home",
    mode: normalizedMode,
    combatHullTypeID: Number(fitProfile && fitProfile.hullTypeID) || null,
    homeStationID: target.stationID,
    // Start combat salvage at the local base. Regional buyer routing can move
    // actual cargo; empty holds should not trigger a trip to a central hub.
    marketStationID: normalizePositiveInteger(target.stationID) || hubStationID,
    optimizeMarketDestination: true,
    targetSystemID: target.systemID,
    patrolEntityID: Number(target.patrolEntityID) || null,
    targetFactionKey: target.factionKey || null,
    siteFactionKey: target.siteFactionKey || null,
    siteInstanceID: Number(target.siteInstanceID) || null,
    siteID: Number(target.siteID) || null,
    siteDifficulty: Number(target.siteDifficulty) || null,
    siteLabel: target.siteLabel || null,
    siteMaxWaveHostiles: Number(target.encounterLoad && target.encounterLoad.maxWaveHostiles) || 0,
    siteMaxWaveThreatScore: Number(target.encounterLoad && target.encounterLoad.maxWaveThreatScore) || 0,
    siteWaveCount: Number(target.encounterLoad && target.encounterLoad.waveCount) || 0,
    failedAnomalySites: failedAnomalySites.slice(-32),
    maxSiteDifficulty: Number(fitProfile && fitProfile.maxSiteDifficulty) || 0,
    maxWaveHostiles: Number(fitProfile && fitProfile.maxWaveHostiles) || 0,
    maxSiteWaves: Number(fitProfile && fitProfile.maxSiteWaves) || 0,
    requiredDroneTypes: (fitProfile && fitProfile.droneTypeIDs || []).map(Number),
    droneDamageTypeByID: { ...(fitProfile && fitProfile.droneDamageTypeByID || {}) },
    combatDroneTypeID: Number(target.combatDroneTypeID) || null,
    combatDroneDamageType: target.combatDroneDamageType || null,
    combatDroneCount: Number(target.combatDroneCount) || null,
    requiredModuleTypes: (fitProfile && fitProfile.moduleTypeIDs || []).map(Number),
    siteCompleted: false,
    siteIncomplete: false,
    siteHandedOff: false,
    siteRetryCount: 0,
    plannedRouteHops: Number(target.hops) || 0,
    routeRisk: target.risk || null,
    beltID: miningEscortTarget ? miningEscortTarget.beltID : null,
    miningEscortForCharacterID: miningEscortForCharacterID || null,
    miningEscortGroupKey: miningEscortTarget && miningEscortTarget.groupKey || null,
    miningEscortSystemID: miningEscortTarget && miningEscortTarget.systemID || null,
    miningEscortBeltID: miningEscortTarget && miningEscortTarget.beltID || null,
    miningEscortRequiredTier: miningEscortTarget && miningEscortTarget.requiredTier || null,
    miningEscortFitTier: miningEscortTarget && miningEscortTarget.fitTier || null,
    targetID: null,
    defensiveTargetID: defensiveTargetID || null,
    defensiveThreatAtMs: defensiveTargetID ? Date.now() : null,
    emptySinceAt: defensiveTargetID ? Date.now() : 0,
    tripStartedAt: defensiveTargetID ? Date.now() : 0,
    targetLabel: null,
    lastDestroyedTargetID: null,
    kills: 0,
    unitsSold: 0,
    unitsListed: 0,
    proceeds: 0,
    brokerFees: 0,
    spent: 0,
    startingBalance: Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0,
    maxTripMs: 15 * 60 * 1000,
    autonomous: options.autonomous === true,
  });
  record(operation, defensiveTargetID
    ? `Responding immediately to legally engageable attacker ${defensiveTargetID}; the live combat fit and opponent strength are rechecked before drones launch.`
    : miningEscortTarget
    ? `Security escort for mining belt ${miningEscortTarget.beltID} in system ${miningEscortTarget.systemID}; fit tier ${miningEscortTarget.fitTier}, risk requires tier ${miningEscortTarget.requiredTier}.`
    : target.siteInstanceID
    ? `Preparing to clear combat anomaly ${target.siteLabel} (tier ${target.siteDifficulty}, ${target.siteFactionKey || "unknown NPC faction"}) in system ${operation.targetSystemID}.`
    : `${normalizedMode === "piracy" ? "Piracy" : normalizedMode === "war" ? "War" : normalizedMode === "nullsec-conflict" ? "Null-sec structure conflict" : "Security"} patrol preparing for system ${operation.targetSystemID}${operation.plannedRouteHops ? ` (${operation.plannedRouteHops} jumps)` : ""}.`);
  saveOperation(operation);
  if (normalizedMode === "piracy" && !defensiveTargetID) combat.recordPatrolDeployment(operation);
  if (defensiveTargetID) wakeThreatenedBot(bot.characterID, "immediate defensive combat");
  return { success: true, operation, message: target.siteInstanceID
    ? `${bot.characterName} will clear ${target.siteLabel} (tier ${target.siteDifficulty}) in system ${operation.targetSystemID}, recover the loot and sell it outside Jita.`
    : `${bot.characterName} will run a ${normalizedMode === "nullsec-conflict" ? "null-sec structure conflict" : normalizedMode} patrol in system ${operation.targetSystemID} (operation ${operation.operationID}).` };
}

function startSovereignty(botQuery, objective = null, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  if (!bot || bot.specialty !== "sovereignty") {
    return { success: false, message: `${bot ? bot.characterName : "The selected bot"} is not in the sovereignty specialty.` };
  }
  const sovereignty = require("./playerBotSovereigntyRuntime");
  const currentObjective = sovereignty.findSovereigntyObjective(bot);
  const objectiveID = (entry) => Number(entry && (entry.nodeID || entry.targetID)) || 0;
  const selected = objective && currentObjective && objectiveID(objective) === objectiveID(currentObjective)
    ? currentObjective
    : currentObjective;
  if (!selected) return { success: false, message: "No reachable sovereignty campaign or unclaimed neutral Hub is available to this alliance." };
  if (nextShipUpgrade(bot, "sovereignty") || !hasRoleShipFit(bot, "sovereignty")) {
    return { success: false, message: `${bot.characterName} needs the Entosis Link sovereignty fit before starting an Entosis operation.` };
  }
  if (selected.kind === "neutral-hub" && sovereignty.getNeutralHubState({
    targetID: selected.targetID,
    nodeID: selected.targetID,
    systemID: selected.systemID,
    allianceID: selected.allianceID,
  }).status !== "neutral") {
    return { success: false, message: `Neutral Sovereignty Hub ${selected.targetID} is no longer available.` };
  }
  const character = getCharacterRecord(bot.characterID) || {};
  const currentStationID = normalizePositiveInteger(character.stationID || character.structureID);
  const homeStationID = currentStationID ||
    Number((worldData.getStationsForSystem(Number(character.solarSystemID) || 0) || [])[0]?.itemID) ||
    hubStationFor(bot);
  const operation = baseOperation("sovereignty", bot, {
    stage: "to-system",
    mode: selected.kind === "neutral-hub" ? "initial-claim" : "campaign-support",
    objectiveKind: selected.kind === "neutral-hub" ? "neutral-hub" : "command-node",
    allianceID: selected.allianceID,
    systemID: selected.systemID,
    sourceSystemID: selected.sourceSystemID,
    nodeID: selected.nodeID || selected.targetID,
    targetID: selected.targetID || selected.nodeID,
    campaignTargetID: selected.campaignTargetID,
    campaignEpoch: selected.campaignEpoch,
    homeStationID,
    linkModuleID: null,
    startedAtMs: Date.now(),
    maxOperationMs: 60 * 60 * 1000,
    plannedRouteHops: Number(selected.hops) || 0,
    routeRisk: selected.routeRisk || null,
    autonomous: options.autonomous === true,
  });
  record(operation, selected.kind === "neutral-hub"
    ? `Queued an authority-backed Entosis attempt on neutral Sovereignty Hub ${selected.targetID} for alliance ${selected.allianceID}.`
    : `Queued Entosis participation in active campaign ${selected.campaignTargetID} at command node ${selected.nodeID}.`);
  saveOperation(operation);
  return { success: true, operation, message: selected.kind === "neutral-hub"
    ? `${bot.characterName} will attempt to claim neutral Sovereignty Hub ${selected.targetID} for alliance ${selected.allianceID}, subject to normal Entosis capture rules.`
    : `${bot.characterName} will join active sovereignty campaign ${selected.campaignTargetID} at command node ${selected.nodeID}.` };
}

function startStructureDeployment(botQuery, itemID, systemID = null, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  return require("./playerBotStructureRuntime").start(bot, itemID, systemID, {
    ...options,
    operationTools: { assertCanStart, baseOperation, record, saveOperation },
  });
}

function startStructureProcurement(botQuery, plan, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  return require("./playerBotStructureRuntime").startProcurement(bot, plan, {
    baseOperation,
    record,
    saveOperation,
  });
}

function startStructureCoreInstall(botQuery, plan, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  return require("./playerBotStructureRuntime").startCoreInstall(bot, plan, {
    baseOperation,
    record,
    saveOperation,
  });
}

function startStructureServiceProvision(botQuery, plan, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  const refusal = assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  const result = require("./playerBotStructureRuntime").startStructureServiceProvision(bot, plan, {
    baseOperation,
    record,
    saveOperation,
  });
  if (result.success && options.autonomous === true) {
    result.operation.autonomous = true;
    saveOperation(result.operation);
  }
  return result;
}

function requestSafeOperationStop(operation, bot, reason, forCapacity = false) {
  if (!bot || !operation) return { success: false, reason: "bot-or-operation-missing" };
  if (operation.routeTaskID) {
    const task = getTasks().getTask(operation.routeTaskID);
    if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
    operation.routeTaskID = null;
  }
  if (operation.kind === "combat") {
    require("./playerBotCombatRuntime").requestSafeRetreat(operation, bot, reason);
  } else if (operation.kind === "sovereignty") {
    operation.withdrawRequested = true;
    operation.withdrawReason = String(reason).slice(0, 240);
    operation.deactivationRequested = false;
    if (operation.stage !== "scoring") operation.stage = "return";
  } else if (operation.kind === "alliance-courier") {
    const contract = require("../contracts/contractRuntimeState").getContractRecord(Number(operation.contractID));
    const accepted = contract && Number(contract.status) === 1 && Number(contract.acceptorID) === Number(bot.characterID);
    if (!accepted && !operation.pendingContractAction) {
      operation.stage = "cancelled";
    } else {
      operation.completeBeforeStop = true;
    }
  }
  operation.status = "active";
  operation.loadSheddingPaused = false;
  delete operation.loadSheddingPausedAtMs;
  delete operation.loadSheddingPauseReason;
  operation.loadSheddingPauseRequested = forCapacity;
  if (forCapacity) {
    operation.loadSheddingPauseRequestedReason = String(reason).slice(0, 200);
    record(operation, `${reason} The ship is completing a safe withdrawal through the normal game authorities.`);
  } else {
    delete operation.loadSheddingPauseRequestedReason;
    operation.operatorStopRequested = true;
    record(operation, `${reason} The ship will return through the normal game authorities before the operation ends.`);
  }
  saveOperation(operation);
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not wake safe withdrawal for ${operation.operationID}: ${error.message}`));
  return { success: true, operation, graceful: true };
}

function findThreatEvacuationStation(bot) {
  const character = getCharacterRecord(bot.characterID) || {};
  const economy = require("./playerBotEconomyRuntime");
  const currentSystemID = normalizePositiveInteger(character.solarSystemID);
  try {
    const repair = require("./playerBotCombatRuntime").findNearestRepairStation(bot, 64, { excludeJita: true });
    if (repair && repair.success && !economy.isJitaStation(repair.stationID)) return Number(repair.stationID);
  } catch (_) {
    // Fall through to a supported local NPC station.
  }
  const localStations = typeof worldData.getStationsForSystem === "function"
    ? worldData.getStationsForSystem(currentSystemID)
    : [];
  const localStation = (localStations || [])
    .map((station) => Number(station.stationID || station.itemID))
    .filter((stationID) => stationID > 0 && !economy.isJitaStation(stationID))
    .sort((left, right) => left - right)[0];
  if (localStation) return localStation;
  const currentStation = normalizePositiveInteger(character.stationID || character.structureID);
  return currentStation && !economy.isJitaStation(currentStation)
    ? currentStation
    : normalizePositiveInteger(hubStationFor(bot));
}

async function advanceThreatRetreat(operation, bot) {
  if (!operation.threatRetreat) return { delayMs: STEP_DELAY_MS };
  const character = getCharacterRecord(bot.characterID) || {};
  const dockedStationID = normalizePositiveInteger(character.stationID || character.structureID);
  if (dockedStationID) {
    const targetID = Number(operation.threatRetreat.attackerEntityID) || 0;
    const resumeStatus = operation.threatRetreat.resumeStatus;
    delete operation.threatRetreat;
    if (operation.kind === "threat-retreat") {
      return finish(operation, `Evacuated to station ${dockedStationID} after incoming aggression from ${targetID || "an unknown attacker"}.`);
    }
    operation.routeTaskID = null;
    if (resumeStatus) operation.status = resumeStatus;
    record(operation, `Reached station ${dockedStationID} to get clear of an incoming attacker; the interrupted operation is safely resuming.`);
    saveOperation(operation);
    return { delayMs: 1_000 };
  }
  if (!normalizePositiveInteger(operation.threatRetreat.destinationStationID)) {
    operation.threatRetreat.destinationStationID = findThreatEvacuationStation(bot);
    if (!operation.threatRetreat.destinationStationID) {
      operation.threatRetreat.retryAtMs = Date.now() + 5_000;
      record(operation, "Incoming aggression detected; no reachable station is available yet, retrying the evacuation route shortly.");
      saveOperation(operation);
      return { delayMs: 5_000 };
    }
    operation.routeTaskID = null;
    record(operation, `Incoming aggression detected; abandoning the current route and evacuating to station ${operation.threatRetreat.destinationStationID}.`);
    saveOperation(operation);
  }
  if (Number(operation.threatRetreat.retryAtMs) > Date.now()) {
    return { delayMs: Math.min(5_000, Number(operation.threatRetreat.retryAtMs) - Date.now()) };
  }
  return await travelToStation(operation, bot, operation.threatRetreat.destinationStationID) || { delayMs: STEP_DELAY_MS };
}

function wakeThreatenedBot(characterID, reason) {
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(characterID, { immediate: true }).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not wake threat response char=${characterID} (${reason}): ${error.message}`));
}

function setDefensiveCombatTarget(characterID, attackerEntityID, reason = "incoming aggression") {
  if (queueInterruption(characterID, { kind: "engage", attackerID: attackerEntityID, reason })) return true;
  const operation = getOperation(characterID);
  const id = normalizePositiveInteger(attackerEntityID);
  if (!operation || operation.kind !== "combat" || !ACTIVE_STATUSES.has(operation.status) || !id) return false;
  clearRouteTask(operation);
  operation.defensiveTargetID = id;
  operation.targetID = null;
  operation.pendingCombatAction = null;
  operation.defensiveThreatAtMs = Date.now();
  if (!operation.defensiveResumeStage && !["engage", "site-engage"].includes(operation.stage)) {
    operation.defensiveResumeStage = operation.stage;
    operation.stage = operation.siteInstanceID ? "site-engage" : "engage";
  }
  record(operation, `Incoming aggression from ${id}; checking live Crimewatch, fit strength, range and ship reserves for an immediate defensive response (${reason}).`);
  saveOperation(operation);
  wakeThreatenedBot(characterID, "combat");
  return true;
}

function setMiningIncomingThreat(characterID, attackerEntityID, details = {}) {
  if (queueInterruption(characterID, { kind: "mining", attackerID: attackerEntityID, details })) return true;
  const operation = getOperation(characterID);
  const id = normalizePositiveInteger(attackerEntityID);
  if (!operation || operation.kind !== "mine" || !ACTIVE_STATUSES.has(operation.status) || !id) return false;
  clearRouteTask(operation);
  operation.incomingThreat = {
    attackerEntityID: id,
    attackerCharacterID: normalizePositiveInteger(details.attackerCharacterID) || null,
    attackerName: String(details.attackerName || "").slice(0, 80),
    escortCharacterID: normalizePositiveInteger(details.escortCharacterID) || null,
    receivedAtMs: Number(details.receivedAtMs) || Date.now(),
    action: details.action === "escort" ? "escort" : "retreat",
  };
  const bot = resolveBotByID(characterID);
  if (bot) getSpace().stopMining(bot);
  if (operation.incomingThreat.action === "retreat") {
    operation.stage = "return";
    operation.threatReturnStationID = findThreatEvacuationStation(bot);
    operation.dangerousBelts = { ...(operation.dangerousBelts || {}), [String(operation.beltID)]: Date.now() };
  }
  record(operation, operation.incomingThreat.action === "escort"
    ? `Incoming hostile ship ${id}; mining lasers paused while security escort ${operation.incomingThreat.escortCharacterID} responds.`
    : `Incoming hostile ship ${id}; no capable escort is available, so mining lasers stop and the ship returns to station.`);
  saveOperation(operation);
  wakeThreatenedBot(characterID, "mining");
  return true;
}

function requestThreatRetreat(characterID, attackerEntityID, reason = "the ship cannot safely fight") {
  const id = normalizePositiveInteger(characterID);
  const bot = resolveBotByID(id);
  if (!bot) return { success: false, message: "Threatened bot is no longer in the roster." };
  if (queueInterruption(id, { kind: "retreat", attackerID: attackerEntityID, reason })) {
    return { success: true, queued: interruptions.hasPending(id), message: "Emergency intent recorded; settling the current step before navigation handoff." };
  }
  let operation = getOperation(id);
  if (operation && operation.kind === "combat" && ACTIVE_STATUSES.has(operation.status)) {
    clearRouteTask(operation);
    operation.emergencyRetreat = true;
    operation.emergencyDepartureOrderedAt = null;
    const safeStationID = findThreatEvacuationStation(bot);
    if (safeStationID) {
      operation.homeStationID = safeStationID;
      operation.marketStationID = safeStationID;
      operation.routeTaskID = null;
    }
    require("./playerBotCombatRuntime").requestSafeRetreat(operation, bot,
      `Incoming aggression from ${attackerEntityID || "an unknown attacker"}; ${reason}.`);
    saveOperation(operation);
  } else if (operation && operation.kind === "mine" && ACTIVE_STATUSES.has(operation.status)) {
    return setMiningIncomingThreat(id, attackerEntityID, { action: "retreat", receivedAtMs: Date.now() });
  } else {
    if (!operation || (!ACTIVE_STATUSES.has(operation.status) && !operation.pending &&
        !["review", "blocked"].includes(operation.status))) {
      operation = baseOperation("threat-retreat", bot, { stage: "retreat" });
    }
    if (operation.routeTaskID) {
      const task = getTasks().getTask(operation.routeTaskID);
      if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
      operation.routeTaskID = null;
    }
    operation.threatRetreat = {
      resumeStatus: operation.threatRetreat?.resumeStatus ||
        (!ACTIVE_STATUSES.has(operation.status) ? operation.status : null),
      attackerEntityID: normalizePositiveInteger(attackerEntityID) || null,
      reason: String(reason).slice(0, 200),
      requestedAtMs: Date.now(),
      destinationStationID: null,
      retryAtMs: 0,
    };
    operation.status = "active";
    record(operation, `Incoming aggression from ${attackerEntityID || "an unknown attacker"}; ${reason}. Evacuating through normal navigation and docking authorities.`);
    saveOperation(operation);
  }
  wakeThreatenedBot(id, "evacuation");
  return { success: true, operation, message: `${bot.characterName} is evacuating from the hostile grid.` };
}

function stopOperation(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  if (!interruptions.isApplying(bot.characterID) && interruptions.isBusy(bot.characterID)) {
    queueInterruption(bot.characterID, { kind: "stop" });
    return { success: true, queued: true, message: "Stop recorded; the current committed action will settle before stopping." };
  }
  const operation = getOperation(bot.characterID);
  if (!operation || (!["active", "holding", "blocked", "review"].includes(operation.status) &&
      operation.loadSheddingPaused !== true)) {
    return { success: true, message: `${bot.characterName} has no active operation.` };
  }
  if (operation.kind === "pi-collect" &&
      (Number(operation.containerID) > 0 || operation.exportAttempt)) {
    return {
      success: false,
      operation,
      message: `PI collection ${operation.operationID} cannot be stopped while launch container ${operation.containerID || "result pending"} is outstanding. The bot will keep working until it collects the cargo or reconciles the launch.`,
    };
  }
  if (operation.kind === "structure-deployment" && operation.pendingDeployment) {
    return {
      success: false,
      operation,
      message: `Structure package ${operation.itemID} is being reconciled with the deployment authority; do not issue a second deployment or stop until this step resolves.`,
    };
  }
  if (operation.kind === "alliance-founding" && operation.pendingFounding &&
      require("../corporation/allianceFoundingState").getPendingAllianceFounding(Number(operation.corporationID))) {
    return {
      success: false,
      operation,
      message: `Alliance founding for corporation ${operation.corporationID} is being reconciled by the durable corporation authority; do not stop it or issue a second founding request until it resolves.`,
    };
  }
  if (["combat", "sovereignty", "alliance-courier"].includes(operation.kind)) {
    const result = requestSafeOperationStop(
      operation,
      bot,
      "Operation stopped by an operator.",
      false,
    );
    return {
      success: result.success,
      operation,
      message: operation.kind === "alliance-courier"
        ? `Operation ${operation.operationID} for ${bot.characterName} is stopping safely; an accepted courier package will be delivered before the operation ends.`
        : `Operation ${operation.operationID} for ${bot.characterName} is withdrawing safely; combat drones will return and an active Entosis cycle will finish before warp.`,
    };
  }
  if (operation.kind === "fleet-attack") {
    const result = requestFleetAttackStop(bot.characterName);
    return {
      success: result.success,
      operation,
      graceful: true,
      message: `${bot.characterName} is recalling combat drones and returning to its home station before the attack ends.`,
    };
  }
  if (operation.routeTaskID) {
    const task = getTasks().getTask(operation.routeTaskID);
    if (task && (task.status === "queued" ||
        operation.kind === "fleet-follow" && task.status === "leased")) {
      getTasks().cancelTask(task.taskID);
    }
  }
  try {
    if (operation.kind === "mine") getSpace().stopMining(bot);
  } catch (error) {
    // The ship may already be docked; nothing to deactivate.
  }
  operation.status = "stopped";
  operation.loadSheddingPaused = false;
  delete operation.loadSheddingPausedAtMs;
  delete operation.loadSheddingPauseReason;
  record(operation, "Operation stopped by an operator. Cargo and inventory are preserved.");
  saveOperation(operation);
  try {
    require("./playerBotAutonomyRuntime").wakeDirectorThinkStep(bot.characterID).catch((error) =>
      require("../../utils/logger").warn(
        `[PlayerBots] Could not wake ${bot.characterName}'s next independent decision: ${error.message}`,
      ));
  } catch (error) {
    // The operation runtime is also used before the durable scheduler starts.
  }
  return { success: true, message: `Operation ${operation.operationID} for ${bot.characterName} stopped at ${operation.stage}.` };
}

function startCapsuleRecovery(botQuery, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, deferred: true, message: `No unique playerbot found with that name: ${botQuery}.` };
  const character = getCharacterRecord(bot.characterID) || {};
  if (Number(character.shipTypeID) !== 670) {
    return { success: false, skipped: true, message: `${bot.characterName} is not in a capsule.` };
  }

  // Capsule recovery may replace an earlier upgrade before its next scheduled
  // step. Reconcile any stipend reservation at that boundary so a lost hull
  // cannot strand the pilot's war budget between operation IDs.
  try {
    require("./playerBotWarMobilizationRuntime")
      .reconcileOrphanedUpgradeReservation(bot);
  } catch (error) {
    require("../../utils/logger").warn(
      `[PlayerBots] Could not reconcile ${bot.characterName}'s war ship reservation during capsule recovery: ${String(error && error.message || error).slice(0, 180)}.`,
    );
  }

  const current = getOperation(bot.characterID);
  if (current && current.kind === "upgrade" && ACTIVE_STATUSES.has(current.status)) {
    return { success: true, existing: true, operation: current,
      message: `${bot.characterName} is already recovering a ship through ${current.operationID}.` };
  }
  if (current && current.pending) {
    return { success: false, deferred: true,
      message: `${bot.characterName}'s ${current.kind} operation has an unresolved authority action; preserving it before ship recovery.` };
  }
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID);
  if (cycle && (["active", "holding", "review"].includes(cycle.status) || cycle.pending)) {
    return { success: false, deferred: true,
      message: `${bot.characterName}'s industry cycle is reconciling a job; capsule recovery will retry without interrupting production.` };
  }

  const role = ["security", "piracy", "sovereignty"].includes(bot.specialty)
    ? bot.specialty
    : "mining";
  const rung = nextShipUpgrade(bot, role);
  if (!rung) {
    return { success: false, deferred: true,
      message: `${bot.characterName} has no skill-eligible replacement hull on the ${role} ladder.` };
  }
  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  if (balance < Number(rung.minBalance)) {
    return { success: false, deferred: true,
      message: `${bot.characterName} needs ${Number(rung.minBalance).toLocaleString("en-US")} ISK for capsule recovery; wallet has ${balance.toFixed(2)} ISK.` };
  }

  if (current && ["active", "holding", "review", "blocked"].includes(current.status)) {
    // Combat, sovereignty and accepted courier work must finish their existing
    // safe withdrawal/delivery protocol; replacing those operations would
    // discard a live site or a package controlled by another authority.
    if (["combat", "sovereignty", "alliance-courier", "structure-deployment",
      "structure-procurement", "structure-core-install", "structure-service-provision",
      "alliance-founding"].includes(current.kind)) {
      return { success: false, deferred: true,
        message: `${bot.characterName}'s ${current.kind} operation is reconciling a protected action; ship recovery will retry after it reaches a safe checkpoint.` };
    }
    const stopped = stopOperation(bot.characterName);
    if (!stopped.success) return { success: false, deferred: true, message: stopped.message };
    const afterStop = getOperation(bot.characterID);
    if (afterStop && ACTIVE_STATUSES.has(afterStop.status)) {
      return { success: false, deferred: true,
        message: `${bot.characterName}'s ${afterStop.kind} operation is completing a safe withdrawal before ship recovery.` };
    }
  }

  const marketStationID = findUpgradeMarketStation(bot, rung);
  if (!normalizePositiveInteger(marketStationID)) {
    return { success: false, deferred: true,
      message: `${bot.characterName} has no reachable non-Jita market for the ${rung.name} recovery hull.` };
  }
  const recovery = startShipUpgrade(bot.characterName, role, {
    autonomous: options.autonomous === true,
    marketStationID,
    maxSpend: Number(rung.minBalance),
  });
  if (recovery.success) {
    recovery.operation.capsuleRecovery = true;
    recovery.operation.capsuleRecoveryReplacedOperationID = current && current.operationID || null;
    record(recovery.operation, `Capsule recovery replaces the lost hull with the skill-eligible ${rung.name}; the bot will resume normal director work after fitting.`);
    saveOperation(recovery.operation);
  }
  return recovery;
}

function pauseForCapacity(characterID, reason = "Playerbot work is queued to protect the game server.") {
  const id = normalizePositiveInteger(characterID);
  if (!id || runningBots.has(id)) return { success: false, reason: "action-in-progress" };
  const operation = getOperation(id);
  if (!operation || !ACTIVE_STATUSES.has(operation.status) || operation.pending) {
    return { success: false, reason: "operation-not-pausable" };
  }
  if (operation.kind === "pi-collect" &&
      (Number(operation.containerID) > 0 || operation.exportAttempt)) {
    return { success: false, reason: "pi-container-collection-must-finish" };
  }
  const bot = resolveBotByID(id);
  if (["combat", "sovereignty", "alliance-courier"].includes(operation.kind)) {
    return requestSafeOperationStop(operation, bot, String(reason), true);
  }
  if (operation.routeTaskID) {
    const task = getTasks().getTask(operation.routeTaskID);
    if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
  }
  if (operation.kind === "mine" && bot) {
    try {
      getSpace().stopMining(bot);
    } catch (error) {
      // The bot may not have a live space actor while its durable operation is queued.
    }
  }
  operation.status = "stopped";
  operation.loadSheddingPaused = true;
  operation.loadSheddingPausedAtMs = Date.now();
  operation.loadSheddingPauseReason = String(reason).slice(0, 200);
  operation.routeTaskID = null;
  record(operation, `Paused for server capacity at ${operation.stage}; cargo and operation progress are preserved.`);
  saveOperation(operation);
  return { success: true, operation };
}

function queueColonySetupForDirector(characterID, reason = "Planetary setup is waiting for a free setup slot.") {
  const id = normalizePositiveInteger(characterID);
  if (!id || runningBots.has(id)) return { success: false, reason: "action-in-progress" };
  const operation = getOperation(id);
  if (!operation || operation.kind !== "colony" || operation.pending ||
      !["active", "holding", "stopped"].includes(operation.status)) {
    return { success: false, reason: "colony-not-queueable" };
  }
  if (Number(operation.planetID) > 0 &&
      require("../planet/planetRuntimeStore").getColony(Number(operation.planetID), id)) {
    return { success: false, reason: "colony-already-established" };
  }
  if (operation.routeTaskID) {
    const task = getTasks().getTask(operation.routeTaskID);
    if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
  }
  operation.status = "stopped";
  operation.loadSheddingPaused = false;
  delete operation.loadSheddingPausedAtMs;
  delete operation.loadSheddingPauseReason;
  operation.routeTaskID = null;
  operation.queuedForColonySetup = true;
  operation.queuedForColonySetupAtMs = Date.now();
  record(operation, `${reason} PI progress is preserved; this pilot can take other work until a setup slot opens.`);
  saveOperation(operation);
  return { success: true, operation };
}

function resumeOperation(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const operation = getOperation(bot.characterID);
  if (runningBots.has(Number(bot.characterID))) return { success: false, message: `${bot.characterName} still has an action in progress; wait for it to finish.` };
  if (!operation || !["blocked", "stopped", "review"].includes(operation.status)) {
    return { success: false, message: `${bot.characterName} has no stopped or blocked operation.` };
  }
  const hadPendingPurchase = Boolean(operation.pending && operation.pending.action === "buy");
  operation.status = "active";
  operation.loadSheddingPaused = false;
  delete operation.loadSheddingPausedAtMs;
  delete operation.loadSheddingPauseReason;
  if (hadPendingPurchase) operation.pending = null;
  operation.lastError = null;
  operation.routeTaskID = null;
  record(operation, hadPendingPurchase
    ? "Operation resumed by an operator after reviewing the pending purchase."
    : "Operation resumed by an operator.");
  saveOperation(operation);
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not advance operation ${operation.operationID}: ${error.message}`));
  return { success: true, operation, message: `Operation ${operation.operationID} for ${bot.characterName} resumed at ${operation.stage}.` };
}

function fileTimeToMs(value) {
  const ticks = Number(value);
  return Number.isFinite(ticks) ? (ticks - 116444736000000000) / 10_000 : 0;
}

function isWalletJournalChainConsistentSince(journal, baselineBalance, currentBalance, startedAtMs) {
  const baseline = Number(baselineBalance);
  const current = Number(currentBalance);
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) return false;
  const entries = (Array.isArray(journal) ? journal : [])
    .filter((entry) => fileTimeToMs(entry && entry.transactionDate) >= startedAtMs - 1000 &&
      Number.isFinite(Number(entry && entry.amount)) && Number.isFinite(Number(entry && entry.balance)))
    .sort((left, right) => fileTimeToMs(left.transactionDate) - fileTimeToMs(right.transactionDate));
  if (!entries.length) return Math.abs(current - baseline) <= 0.02;

  let expectedBalance = baseline;
  for (const entry of entries) {
    const amount = Number(entry.amount);
    const recordedBalance = Number(entry.balance);
    if (Math.abs(expectedBalance + amount - recordedBalance) > 0.02) return false;
    expectedBalance = recordedBalance;
  }
  return Math.abs(expectedBalance - current) <= 0.02;
}

function wakeRecoveredUpgradeOperation(operation) {
  try {
    const wake = require("./playerBotAutonomyRuntime").wakeIndustryCycleStep;
    if (typeof wake !== "function") return;
    Promise.resolve(wake(operation.characterID)).catch((error) =>
      require("../../utils/logger").warn(
        `[PlayerBots] Could not resume recovered upgrade ${operation.operationID}: ${error.message}`,
      ));
  } catch (error) {
    require("../../utils/logger").warn(
      `[PlayerBots] Could not resume recovered upgrade ${operation.operationID}: ${error.message}`,
    );
  }
}

function reconcileUncertainUpgradePurchase(operation, bot) {
  const pending = operation.pending;
  const wallet = require("../account/walletState");
  const startedAtMs = Date.parse(pending.startedAt || "") || 0;
  const typeID = Number(pending.typeID) || 0;
  const expected = Math.max(1, Math.trunc(Number(pending.quantity) || 1));
  const stationID = Number(pending.stationID || operation.marketStationID) || 0;
  const transactions = wallet.getCharacterMarketTransactions(operation.characterID)
    .filter((entry) => Number(entry.typeID) === typeID &&
      Number(entry.buyerID) === Number(operation.characterID) &&
      (!stationID || Number(entry.stationID) === stationID) &&
      (!startedAtMs || fileTimeToMs(entry.transactionDate) >= startedAtMs - 1000));
  const bought = transactions.reduce((total, entry) => total + Math.max(0, Number(entry.quantity) || 0), 0);
  const baselineUnits = Math.max(0, Number(pending.baselineUnits) || 0);
  const presentUnits = getInventory().countHangar(bot, stationID, typeID) +
    getInventory().countCargo(bot, typeID);
  if (bought >= expected && presentUnits >= baselineUnits + expected) {
    const spent = transactions.reduce((total, entry) =>
      total + Math.max(0, Number(entry.quantity) || 0) * Math.max(0, Number(entry.price) || 0), 0);
    operation.spent = Math.round(((Number(operation.spent) || 0) + spent) * 100) / 100;
    operation.pending = null;
    operation.status = "active";
    operation.lastError = null;
    record(operation, `Recovered confirmed market purchase of ${expected}× ${typeID}; continuing the upgrade.`);
    saveOperation(operation);
    return "confirmed";
  }

  const walletJournal = wallet.getCharacterWalletJournal(operation.characterID);
  const journal = (Array.isArray(walletJournal) ? walletJournal : [])
    .filter((entry) => (!startedAtMs || fileTimeToMs(entry.transactionDate) >= startedAtMs - 1000) &&
      String(entry.description || "").includes(`(${typeID})`));
  const debits = journal.filter((entry) =>
    Number(entry.amount) < 0 && /market purchase of/i.test(String(entry.description || "")),
  ).reduce((total, entry) => total + Math.abs(Number(entry.amount) || 0), 0);
  const refunds = journal.filter((entry) =>
    Number(entry.amount) > 0 && /purchase refund/i.test(String(entry.description || "")),
  ).reduce((total, entry) => total + (Number(entry.amount) || 0), 0);
  const currentBalance = Number(wallet.getCharacterWallet(operation.characterID)?.balance);
  const baselineBalance = Number(pending.baselineBalance);
  const balanceDebit = Number.isFinite(currentBalance) && Number.isFinite(baselineBalance)
    ? baselineBalance - currentBalance
    : Number.NaN;
  const inventoryIncrease = presentUnits - baselineUnits;
  const expectedSpend = Math.max(0, Number(pending.quotedPrice) || 0) * expected;
  const debitTolerance = Math.max(0.02, debits * 1e-9);
  // Wallet-authority transaction rows may not have reached the projection when
  // restart recovery runs. A matching journal debit plus the exact inventory
  // increase and wallet delta is sufficient to confirm the purchase safely.
  if (bought === 0 && inventoryIncrease >= expected && debits > 0 && refunds === 0 &&
      debits <= expectedSpend + 0.02 && Math.abs(balanceDebit - debits) <= debitTolerance) {
    operation.spent = Math.round(((Number(operation.spent) || 0) + debits) * 100) / 100;
    operation.pending = null;
    operation.status = "active";
    operation.lastError = null;
    record(operation, `Recovered confirmed purchase of ${expected}× ${typeID} from wallet journal and inventory evidence; recorded ${debits.toFixed(2)} ISK spent.`);
    saveOperation(operation);
    return "confirmed";
  }
  const noNewInventory = presentUnits <= baselineUnits;
  if (debits > 0 && refunds + 0.01 >= debits && noNewInventory && bought === 0) {
    operation.pending = null;
    operation.status = "active";
    operation.lastError = null;
    record(operation, `Recovered refunded market purchase of ${typeID}; retrying it safely.`);
    saveOperation(operation);
    return "refunded";
  }
  const noPurchaseEffect = startedAtMs > 0 && Date.now() - startedAtMs >= 60_000 &&
    transactions.length === 0 && noNewInventory && bought === 0 && debits === 0 && refunds === 0 &&
    isWalletJournalChainConsistentSince(walletJournal, baselineBalance, currentBalance, startedAtMs);
  if (noPurchaseEffect) {
    operation.pending = null;
    operation.status = "active";
    operation.lastError = null;
    record(operation, `Confirmed no market purchase effect for ${expected}× ${typeID}; wallet journal, transactions, and inventory reconcile to the pre-purchase state, so the purchase can be retried safely.`);
    saveOperation(operation);
    return "not-executed";
  }
  return "unresolved";
}

function reconcilePendingUpgradePurchases() {
  const summary = { confirmedPurchases: 0, retriedRefundedPurchases: 0, retriedNoEffectPurchases: 0, unresolvedPurchases: 0 };
  for (const operation of listOperations()) {
    if (operation.status !== "review" || !operation.pending || operation.pending.action !== "buy") continue;
    const bot = resolveBotByID(operation.characterID);
    if (!bot) {
      summary.unresolvedPurchases += 1;
      continue;
    }
    const outcome = reconcileUncertainUpgradePurchase(operation, bot);
    if (outcome === "confirmed") {
      summary.confirmedPurchases += 1;
      wakeRecoveredUpgradeOperation(operation);
    } else if (outcome === "refunded") {
      summary.retriedRefundedPurchases += 1;
      wakeRecoveredUpgradeOperation(operation);
    } else if (outcome === "not-executed") {
      summary.retriedNoEffectPurchases += 1;
      wakeRecoveredUpgradeOperation(operation);
    } else summary.unresolvedPurchases += 1;
  }
  return summary;
}

function reconcileTransientOperations() {
  const summary = { resumedRouteConflicts: 0, resumedMiningWarps: 0, resumedCombatRepairRoutes: 0, confirmedPurchases: 0, retriedRefundedPurchases: 0, retriedNoEffectPurchases: 0, unresolvedPurchases: 0 };
  Object.assign(summary, reconcilePendingUpgradePurchases());
  const tasks = getTasks();
  for (const operation of listOperations()) {
    if (operation.status !== "blocked") continue;
    if (operation.kind === "combat" && operation.stage === "return" &&
        /REPAIR_OFFLINE/i.test(String(operation.lastError || ""))) {
      const bot = resolveBotByID(operation.characterID);
      if (bot) {
        const combat = require("./playerBotCombatRuntime");
        const repairStation = combat.findNearestRepairStation(bot);
        if (repairStation.success && combat.retargetCombatRepairBase(operation, repairStation)) {
          operation.status = "active";
          operation.lastError = null;
          record(operation,
            `Recovered combat return after restart: repair was offline at the old base, so rerouting to ${repairStation.stationName} (${repairStation.stationID}) in system ${repairStation.systemID}${repairStation.hops ? ` (${repairStation.hops} jumps)` : ""}.`);
          saveOperation(operation);
          summary.resumedCombatRepairRoutes += 1;
        }
      }
      continue;
    }
    const conflict = String(operation.lastError || "").match(/already has another route \((PB[A-Z0-9]+)\)/i);
    if (conflict) {
      const route = tasks.getTask(conflict[1]);
      if (!route || !["queued", "leased"].includes(route.status)) {
        operation.status = "active";
        operation.routeTaskID = null;
        operation.lastError = null;
        record(operation, "Recovered a stale route reference; the operation will request a fresh route.");
        saveOperation(operation);
        summary.resumedRouteConflicts += 1;
      }
      continue;
    }
    if (operation.kind === "mine" && operation.stage === "return" &&
        /CustomNotify/i.test(String(operation.lastError || ""))) {
      operation.status = "active";
      operation.routeTaskID = null;
      operation.lastError = null;
      record(operation, "Retrying the return warp after a transient space notification.");
      saveOperation(operation);
      summary.resumedMiningWarps += 1;
    }
  }
  return summary;
}

async function advanceOperation(characterID) {
  const id = normalizePositiveInteger(characterID);
  if (require("./playerBotLocalDefenseAdapter").hasLease(id)) return { delayMs: 1000, busy: true };
  if (runningBots.has(id) || interruptions.isBusy(id)) return { delayMs: 1000, busy: true };
  drainInterruptions(id);
  if (interruptions.hasPending(id)) return { delayMs: 1000, interrupted: true };
  const operation = getOperation(id);
  if (!operation || !ACTIVE_STATUSES.has(operation.status)) return { done: true };
  const bot = resolveBotByID(id);
  if (!bot) return block(operation, "blocked", "The bot is no longer in the roster.");
  if (bot.status === "paused" || bot.autonomyPaused === true) return { delayMs: WAIT_DELAY_MS };
  const handler = operation.threatRetreat && operation.kind !== "combat" && operation.kind !== "mine"
    ? advanceThreatRetreat
    : HANDLERS[operation.kind];
  if (!handler) return block(operation, "blocked", `Unknown operation type ${operation.kind}.`);
  if (operation.status === "holding") operation.status = "active";
  const owner = interruptions.acquire(id, "operation", operation.operationID);
  if (!owner) return { delayMs: 1000, busy: true };
  executionOwners.set(id, owner);
  runningBots.add(id);
  let result;
  let interrupted = false;
  let handlerFailed = false;
  let capacityReason = "";
  try {
    result = await handler(operation, bot);
    if (result && result.capacityQueued) capacityReason = String(result.capacityReason || "System actor capacity reached.");
  } catch (error) {
    if (error && error.code === "PLAYERBOT_SYSTEM_CAPACITY") {
      capacityReason = String(error.message || "System actor capacity reached.");
    } else {
      const latest = getOperation(id) || operation;
      handlerFailed = true;
      result = block(latest, "holding", `Error during ${latest.stage}: ${String(error && error.message || error).slice(0, 200)}`);
    }
  } finally {
    runningBots.delete(id);
    executionOwners.delete(id);
    interruptions.release(owner);
    // Transaction handlers have completed their own durable result accounting.
    // No old handler may write after the mailbox is applied at this safe point.
    interrupted = drainInterruptions(id);
  }
  if (interrupted) return { delayMs: 1000, interrupted: true };
  if (handlerFailed) return result;
  if (["active", "completed"].includes(operation.status) && operation.lastError) {
    operation.lastError = null;
    record(operation, `Recovered from a transient error and continued at ${describeOperationStage(operation)}.`);
    saveOperation(operation);
  }
  if (capacityReason) {
    const queued = pauseForCapacity(id, capacityReason);
    return queued.success
      ? { done: true, capacityQueued: true }
      : { delayMs: WAIT_DELAY_MS, capacityQueued: true };
  }
  return result || { delayMs: STEP_DELAY_MS };
}

function describeOperationStage(operation, stage = operation.stage) {
  const descriptions = {
    "pi-collect": {
      collect: "travelling to or collecting from the PI launch container",
    "to-source": "travelling to the PI collection system",
    "return-to-source": "returning to the outstanding PI launch container",
      "to-market": "returning PI goods to market",
      sell: "selling or listing PI goods",
      done: "PI collection completed",
    },
    colony: {
      buy: "buying colony equipment",
      "to-planet": "travelling to the colony planet",
      setup: "installing the colony network",
      done: "colony setup completed",
    },
    upgrade: {
      "to-market": "travelling to the market station",
      buy: "buying the ship and required modules",
      "move-kit-to-jita": "moving owned modules to Jita",
      "fetch-parts": "fetching missing modules in Jita",
      "return-parts": "returning modules to the upgrade station",
      board: "boarding the upgraded ship",
      fit: "fitting the ship",
      done: "ship upgrade completed",
    },
    fit: {
      "to-market": "travelling to the selected safe-market fitting station",
      buy: "buying the missing hull, modules, bay items, and cargo from the saved fitting",
      "move-kit-to-jita": "moving owned fitting items to the selected source station",
      "move-kit-to-source": "moving owned fitting items to the selected source station",
      "fetch-parts": "fetching missing fitting items from verified market stock",
      "return-parts": "returning fitting items to the selected fitting station",
      board: "boarding the saved fitting's ship hull",
      fit: "installing the saved fitting and loading its bays",
      done: "saved ship fitting completed",
    },
    combat: {
      "to-home": "travelling to the patrol base",
      "to-system": "travelling to the combat or structure-conflict system",
      undock: "undocking for patrol",
      "to-belt": "travelling to the asteroid belt",
      "to-anomaly": "travelling to and entering the combat anomaly",
      engage: "engaging only legal combat targets",
      "site-engage": "clearing the current anomaly wave and checking its unlocked gate",
      loot: "checking wreck rights and recovering permitted loot",
      "site-loot": "recovering anomaly wrecks after an authority-confirmed clear",
      return: "returning, recalling drones, and repairing the ship",
      "to-market": "travelling to sell recovered loot",
      "market-sell": "selling or listing recovered loot",
      "corp-share": "settling the operation profit share",
      done: "combat patrol completed",
    },
    sovereignty: {
      "to-system": "travelling to a sovereignty objective",
      node: "approaching and locking the Hub or command node with Entosis fuel checks",
      scoring: "holding the Entosis Link through its warm-up and scoring cycles",
      return: "returning to the home station",
      done: "sovereignty participation completed",
    },
    "structure-deployment": {
      "to-source": "travelling to the structure package",
      load: "loading the packaged structure through inventory services",
      "to-system": "travelling to the selected null-sec system",
      deploy: "checking placement and corporation authority before anchoring",
      return: "returning after the structure authority confirms deployment",
      done: "structure deployment handed to the anchoring authority",
    },
    "fleet-follow": {
      following: "following a human fleet member",
      done: "fleet movement order completed",
    },
    "fleet-attack": {
      engage: "following and attacking the human commander's locked target when legally authorized",
      retreat: "recalling combat drones and returning to the home station",
      done: "Fleet attack order completed",
    },
    "structure-core-install": {
      "to-core": "collecting the structure's required Quantum Core through inventory services",
      "to-structure": "travelling to the owned structure after its anchor timer",
      "install-core": "installing and reconciling the core through the structure inventory authority",
      return: "returning after the structure confirms its Quantum Core",
      done: "structure core installation confirmed; service setup remains separate",
    },
    "structure-service-provision": {
      source: "checking regional service-module and fuel supply",
      "to-jita": "using Jita only after non-Jita service supply is exhausted",
      buy: "buying service modules and fuel while preserving the bot's protected working reserve",
      load: "loading verified service provisions into ship cargo",
      "to-structure": "travelling to the corporation structure",
      "install-fuel": "loading matching service fuel into the structure bay",
      "install-module": "fitting the service module through structure inventory",
      "online-service": "confirming structure power or manufacturing service and fuel state",
      return: "returning after structure maintenance or service provisioning",
      done: "structure full power or manufacturing service confirmed",
    },
    "structure-procurement": {
      "to-market": "travelling to safe market stock for an earned-profit structure purchase",
      "buy-package": "buying and reconciling the structure package through the market authority",
      done: "structure package purchased and ready for transport planning",
    },
    "alliance-founding": {
      found: "founding an alliance through the corporation authority and reconciling its fee",
      done: "alliance founding confirmed",
    },
    "alliance-courier": {
      accept: "accepting an assigned courier contract within the collateral limit",
      "to-source": "travelling to the courier pickup station",
      "load-package": "loading and verifying the contract package",
      "to-destination": "travelling to the courier destination with the package",
      "deliver-package": "delivering the intact package through the contract authority",
      "complete-contract": "confirming delivery and collateral settlement",
      "corp-share": "settling the corporation profit share",
      cancelled: "stopping before contract acceptance",
      done: "alliance courier contract completed",
    },
    mine: {
      "to-belt": "travelling to an asteroid belt",
      mining: "mining asteroids",
      "to-home": "returning to the home station",
      reprocess: "reprocessing ore",
      sell: "selling or listing materials",
      done: "mining operation completed",
    },
    haul: {
      "to-origin": "travelling to the pickup station",
      load: "loading cargo",
      "to-destination": "travelling to the delivery station",
      deliver: "delivering cargo",
      done: "haul completed",
    },
    sell: {
      "to-origin": "travelling to recover returned market stock",
      "to-market": "travelling to the market station",
      sell: "selling or listing goods",
      done: "sale operation completed",
    },
    fulfill: {
      "to-market": "travelling to fulfill the player order",
      buy: "acquiring the requested goods",
      deliver: "delivering the order",
      done: "player order completed",
    },
  };
  return descriptions[operation.kind]?.[stage] || `working on stage ${stage || "unknown"}`;
}

function formatOperationError(error) {
  const message = String(error || "");
  const lockError = message.match(/^Could not lock asteroid (\d+): (.+)\.$/i);
  if (lockError) return `Could not lock asteroid ${lockError[1]}: ${lockError[2]}.`;
  const legacyLockError = message.match(/^(?:No pude fijar el asteroide|Could not lock asteroid) (\d+): (.+)\.$/i);
  if (legacyLockError) return `Could not lock asteroid ${legacyLockError[1]}: ${legacyLockError[2]}.`;
  if (message === "La construcción supera el presupuesto PI." || message === "Colony construction exceeds the PI budget.") {
    return "Colony construction exceeds the PI budget.";
  }
  return message;
}

function formatOperation(operation, includeHistory = false) {
  if (!operation) return "";
  const bot = resolveBotByID(operation.characterID);
  const location = bot ? getSpace().getBotLocation(bot) : "unknown";
  const detail = operation.kind === "pi-collect"
    ? `planet ${operation.exportRequest && operation.exportRequest.planetID || "existing launch"}; launch ${operation.launchID || "pending"}; container ${operation.containerID || "pending"}; collected ${Number(operation.unitsCollected || 0)} units; sold ${Number(operation.unitsSold || 0)} for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units; market ${operation.marketStationID || "pending"}`
    : operation.kind === "colony"
    ? `planet ${operation.planetID || "pending"} (type ${operation.planetTypeID || "pending"}); ${operation.pins || 0} structures; P0 ${(operation.resourceTypeIDs || [operation.resourceTypeID]).filter(Boolean).join("+") || "pending"} to P${operation.piTier || 1} ${operation.productTypeID || "pending"}; spent ${Number(operation.spent || 0).toFixed(2)} ISK`
    : operation.kind === "fulfill"
    ? `order ${operation.orderID}: ${operation.quantity}× ${operation.typeID} at ${operation.orderStationID}; cost ${Number(operation.spent || 0).toFixed(2)}, paid ${Number(operation.proceeds || 0).toFixed(2)} ISK`
    : operation.kind === "sell"
    ? `at ${operation.marketStationID}; sold ${Number(operation.unitsSold || 0)} units for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units`
    : operation.kind === "upgrade"
    ? `${operation.name} (${operation.hullTypeID}) with modules ${operation.moduleTypeIDs.join(",")}; spent ${Number(operation.spent || 0).toFixed(2)}/${Number(operation.maxSpend || 0).toFixed(2)} ISK; ship ${operation.newShipID || "pending"}`
    : operation.kind === "fit"
    ? `${operation.name} (fitting ${operation.fittingID}, hull ${operation.hullTypeID}); modules ${operation.moduleTypeIDs.length}, drones ${(operation.droneTypeIDs || []).length}, fighters ${(operation.fighterTypeIDs || []).length}, cargo types ${(operation.fitCargoPlan || []).length}; spent ${Number(operation.spent || 0).toFixed(2)}/${Number(operation.maxSpend || 0).toFixed(2)} ISK; ship ${operation.newShipID || "pending"}`
    : operation.kind === "combat"
    ? `${operation.mode}; system ${operation.targetSystemID}; ${operation.siteInstanceID
      ? `anomaly ${operation.siteLabel} (instance ${operation.siteInstanceID}, tier ${operation.siteDifficulty}, ${operation.siteFactionKey || "unknown faction"}; ${operation.siteWaveCount || "?"} waves, up to ${operation.siteMaxWaveHostiles || "?"} entities/wave, threat ${operation.siteMaxWaveThreatScore || "?"}); hull ${operation.combatHullTypeID || "unknown"}; clear ${operation.siteCompleted === true ? "confirmed" : operation.siteAbandoned === true ? "abandoned incomplete" : "incomplete"}; site loot recovered ${Number(operation.unitsCollected || 0)} units`
      : `belt ${operation.beltID || "pending"}`}; kills ${Number(operation.kills || 0)}; loot sold ${Number(operation.unitsSold || 0)} for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)}; spent ${Number(operation.spent || 0).toFixed(2)} ISK${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "sovereignty"
    ? `alliance ${operation.allianceID}; ${operation.objectiveKind === "neutral-hub"
      ? `neutral Hub ${operation.targetID || operation.nodeID}`
      : `campaign ${operation.campaignTargetID}; node ${operation.nodeID}`
    } in system ${operation.systemID}; Entosis module ${operation.linkModuleID || "pending"}; route ${operation.plannedRouteHops || 0} jumps${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "structure-deployment"
    ? `${operation.structureName} type ${operation.typeID}; package ${operation.itemID}; system ${operation.destinationSystemID}; structure ${operation.structureID || "pending"}; state ${operation.anchorState || "pending"}; route ${operation.plannedRouteHops || 0} jumps${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "structure-core-install"
    ? `structure ${operation.structureID}; core type ${operation.coreTypeID}; item ${operation.coreItemID}; source ${operation.sourceStationID}; transport ${operation.transportHullTypeID ? `${operation.transportHullTypeID} (${operation.transportShipItemID || "pending"})` : "current ship"}; transport spend ${Number(operation.spent || 0).toFixed(2)}/${Number(operation.maxSpend || 0).toFixed(2)} ISK; core ${operation.coreInstalled === true ? "installed" : "pending"}${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "structure-service-provision"
    ? `${operation.purpose === "maintenance" ? "maintenance" : `service ${operation.serviceID}`}; structure ${operation.structureID}; module ${operation.moduleTypeID}; fuel ${operation.fuelUnitsNeeded} ${operation.fuelTypeID || "pending"}; ${operation.serviceOnline === true ? "online" : "provisioning"}; spent ${Number(operation.spent || 0).toFixed(2)}/${Number(operation.maxSpend || 0).toFixed(2)} ISK; funding ${operation.fundingSource || "pending"}; protected reserve ${Number(operation.minimumWalletReserve || 0).toFixed(2)} ISK${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "structure-procurement"
    ? `${operation.structureName} type ${operation.typeID}; market ${operation.marketStationID}; package ${operation.itemID || "pending"}; cost ${Number(operation.spent || 0).toFixed(2)}/${Number(operation.maxSpend || 0).toFixed(2)} ISK; funding ${operation.fundingSource || "realized-profit"}; reserve ${Number(operation.minimumWalletReserve || 0).toFixed(2)} ISK${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "alliance-founding"
    ? `alliance ${operation.allianceName} [${operation.allianceShortName}]; alliance ${operation.allianceID || "pending"}; fee ${Number(operation.foundingFee || 0).toFixed(2)} ISK; protected seed reserve ${Number(operation.retainedSeedReserve || 0).toFixed(2)} ISK${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "alliance-courier"
    ? `contract ${operation.contractID}; ${operation.startStationID} to ${operation.endStationID}; package ${Number(operation.packageVolume || 0).toFixed(2)} m³; collateral ${Number(operation.collateral || 0).toFixed(2)} ISK; route ${operation.plannedRouteHops || 0} jumps; reward ${Number(operation.proceeds || 0).toFixed(2)} ISK${operation.autonomous ? "; assigned by director" : ""}`
    : operation.kind === "haul"
    ? `from ${operation.fromStationID} to ${operation.toStationID}; moved ${operation.moved || 0} units in ${operation.trips || 0} trip(s); delivered ${JSON.stringify(operation.delivered || {})}`
    : operation.kind === "relocate"
    ? `to station ${operation.destinationStationID} in system ${operation.destinationSystemID}; reason ${operation.reason || "system capacity"}`
    : operation.kind === "fleet-follow"
    ? `${operation.followMode || "follow"} target ${operation.followTargetCharacterID}; fleet ${operation.fleetID}; range ${operation.followMode === "escort" ? "2,500" : "5,000"} m; route ${operation.routeDestinationSystemID || "local"}; player-directed`
    : operation.kind === "fleet-attack"
    ? `target ${operation.targetName || operation.targetID} (${operation.targetID}); ${operation.mode}/${operation.role}; system ${operation.targetSystemID}; fleet ${operation.fleetID}; drones ${operation.lastEngagedTargetID === Number(operation.targetID) ? "engaged" : "preparing"}; player-directed`
    : `home ${operation.homeStationID}; trips ${operation.trips || 0}/${operation.maxTrips}; ore ${JSON.stringify(operation.oreMined || {})}; minerals ${JSON.stringify(operation.mineralsRefined || {})}; supplied ${Number(operation.unitsSupplied || 0)} units to industry; sold ${Number(operation.unitsSold || 0)} units for ${Number(operation.proceeds || 0).toFixed(2)} ISK; listed ${Number(operation.unitsListed || 0)} units; market ${operation.marketStationID || "home station"}${operation.autonomous ? "; assigned by director" : ""}`;
  const rows = [
    `${operation.characterName} — ${operation.kind} ${operation.operationID} — ${operation.status}/${operation.stage} — corp ${operation.corporationID}; ${location}.`,
    `${detail}.`,
    operation.lastError
      ? `Operation error: ${formatOperationError(operation.lastError)}`
      : `Current step: ${describeOperationStage(operation)}.`,
  ];
  if (operation.kind === "mine") {
    const ratCount = Number.isFinite(Number(operation.lastVisiblePirateNpcCount))
      ? Number(operation.lastVisiblePirateNpcCount)
      : null;
    rows.push(`Belt safety: ${ratCount === null ? "not scanned yet" : `${ratCount} visible pirate rat(s)`}; escort ${operation.escortCharacterName
      ? `${operation.escortCharacterName} (fit tier ${Number(operation.escortFitTier) || 0}, required ${Number(operation.escortRequiredTier) || 0})`
      : "none assigned"}; the miner withdraws if its ship or assigned escort is destroyed.`);
  }
  if (operation.saleReason) rows.push(`Sale outcome: ${operation.saleReason}`);
  if (operation.resumeCombat && operation.kind === "upgrade") {
    rows.push(`Combat site preserved: ${operation.resumeCombat.siteLabel || "unknown anomaly"} (${operation.resumeCombat.siteInstanceID || "unknown instance"}); the pilot will resume it after fitting.`);
  }
  if (operation.deferredUpgrade && Number(operation.deferredUpgrade.retryAfterAtMs) > Date.now()) {
    rows.push(`Ship upgrade deferred until ${new Date(Number(operation.deferredUpgrade.retryAfterAtMs)).toISOString()}: ${operation.deferredUpgrade.name} (${operation.deferredUpgrade.hullTypeID || "unknown hull"}) — ${operation.deferredUpgrade.lastError || "market stock unavailable"}.`);
  }
  if (operation.kind === "pi-collect" && operation.lastAction) rows.push(`Last action: ${operation.lastAction}`);
  if (includeHistory) {
    rows.push(...(operation.history || []).slice(-10).map((entry) =>
      `  ${entry.at} [${entry.stage}] ${describeOperationStage(operation, entry.stage)}.`,
    ));
  }
  return rows.join("\n");
}

function getOperationStatus(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique bot found for: ${botQuery}.` };
  const operation = getOperation(bot.characterID);
  return { success: true, operation, message: operation ? formatOperation(operation, true) : `${bot.characterName} has no recorded operations.` };
}

function formatOperationsSummary() {
  const operations = listOperations().sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 5);
  if (!operations.length) return "Operations (mining, industry, PI, combat, sovereignty, alliances, structures, couriers, hauling): none.";
  return [`Operations (${listActiveOperations().length} active):`, ...operations.map((operation) => formatOperation(operation))].join("\n");
}

// Marks a removed pilot's operation stopped at once. Pending purchases and
// other unfinished actions are abandoned with the character.
function retireOperationForRemovedPilot(characterID, reason = "The pilot was removed from the roster.") {
  const current = readOperationRecord(characterID);
  if (!current || !ACTIVE_STATUSES.has(current.status) && current.status !== "review" && current.status !== "blocked") return false;
  const operation = JSON.parse(JSON.stringify(current));
  operation.status = "stopped";
  operation.pending = null;
  operation.lastError = reason;
  record(operation, reason);
  saveOperation(operation);
  return true;
}

module.exports = {
  retireOperationForRemovedPilot,
  _testing: {
    advanceMining,
    sellMiningOutput,
    pickBelt,
    advancePlanetaryCollection,
    advanceUpgrade,
    hasSkills,
    combatShipLadder: SHIP_LADDER,
    selectBootstrapRung,
    nextShipUpgradeSkillGap,
    getShipRungSkillRequirements,
    getUpgradePackageNeeds,
    canRunIndependentWorkAlongsideIndustryReview,
    assertCanStart,
    saveOperation,
    deferUnavailableUpgradeWaiters,
    reconcilePendingUpgradePurchases,
    reconcileLegacyPIExportAttempt,
    buyUnits,
    advanceFulfill,
    buildCombatReplenishmentOperation,
    prepareResumedCombat,
    canStartCombatModeForPilot,
    startCapsuleRecovery,
    advanceFleetFollow,
    advanceFleetAttack: (operation, bot, dependencies = {}) => require("./playerBotFleetAttackRuntime").advance(operation, bot, {
      ...dependencies,
      record: dependencies.record || record,
      save: dependencies.save || saveOperation,
      finish: dependencies.finish || finish,
    }),
  },
  advanceOperation,
  drainInterruptions,
  setDefensiveCombatTarget,
  setMiningIncomingThreat,
  requestThreatRetreat,
  travelToStation,
  travelToSystem,
  findNearestMiningStation,
  findBestRegionalSaleStation,
  hasSellableGoods,
  findSellableGoodsStation,
  startColony,
  nextPlanetaryLaunch,
  startPlanetaryCollection,
  startFulfill,
  startSell,
  startRelocation,
  formatOperation,
  formatOperationsSummary,
  getOperation,
  getOperationStatus,
  hasActiveOperation,
  pauseForCapacity,
  queueColonySetupForDirector,
  listActiveOperations,
  listActiveOperationRecords,
  listOperationRecords,
  listOperations,
  getDashboardOperationSummary,
  getDashboardOperationHistoryPage,
  refreshDashboardIndustryCyclePageIndex,
  getDashboardOperationDetails,
  archiveOperationRecord: archiveOperation,
  archiveSupersededOperationRecord: archiveSupersededOperation,
  getDashboardOperationsForCharacters,
  boardShip,
  nextShipUpgrade,
  findUpgradeMarketStation,
  queueUpgradeForMarketCapacity,
  retargetUnpurchasedUpgrade,
  hasRoleShipFit,
  getRoleShipFitProfile,
  requiredSkillsForType,
  getCombatShipSkillRequirements,
  nextShipUpgradeSkillGap,
  nextShipRungForTraining,
  getShipRungSkillRequirements,
  resumeOperation,
  reconcileLegacyPIExportReviews,
  startShipUpgrade,
  startCapsuleRecovery,
  startSavedFitting,
  startHaul,
  startAllianceCourier,
  startAllianceFounding,
  startMining,
  startCombat,
  startSovereignty,
  startStructureDeployment,
  startStructureProcurement,
  startStructureCoreInstall,
  startStructureServiceProvision,
  startFleetFollow,
  commandFleetFollow,
  startFleetAttack,
  requestFleetAttackStop,
  stopOperation,
  reconcileTransientOperations,
  reconcilePendingUpgradePurchases,
  deferUnavailableUpgradeWaiters,
};

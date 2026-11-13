"use strict";

// Durable end-to-end production cycle for one industry playerbot: travel to a
// market station or accessible structure with an industry service, buy the blueprint and missing
// materials from existing sell orders, install and deliver the manufacturing
// job, then sell the output to existing buy orders. Every step goes through
// the regular route, market, wallet and industry authorities. The pilot's
// personal wallet and hangar are used; corporation treasury and hangars are
// never touched by this path.

const { createTableRepository } = require("../../gameStore/tableRepository");
const { getCharacterRecord } = require("../character/characterState");
const {
  getCharacterMarketTransactions,
  getCharacterWalletJournal,
  getCharacterWallet,
} = require("../account/walletState");
const itemStore = require("../inventory/itemStore");
const worldData = require("../../space/worldData");
const {
  getBlueprintDefinitionByTypeID,
  getFacilityPayloadByID,
} = require("../industry/industryStaticData");
const { INDUSTRY_STATUS } = require("../industry/industryConstants");

const TABLE = "playerBots";
const CYCLE_PATH = "/_industryCycles";
const CYCLE_RECORD_PREFIX = "_playerBotIndustryCycle_";
const EMPTY_CYCLE_MAP = Object.freeze({});
const CORPORATE_LISTINGS_PATH = "/_corporateSellListings";
const MAX_CORPORATE_LISTINGS = 5_000;
// Bots manufacture and sell at their own hub, never in Jita; Jita is only a
// fallback source of inputs (see playerBotEconomyRuntime).
const DEFAULT_MARKET_STATION_ID = require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID;

// The bot's own empire hub (see playerBotEconomyRuntime).
function hubStationFor(botOrCharacterID) {
  const economy = require("./playerBotEconomyRuntime");
  return typeof economy.getHubStationIDForBot === "function"
    ? economy.getHubStationIDForBot(botOrCharacterID)
    : DEFAULT_MARKET_STATION_ID;
}
const LIST_UNDERCUT = 0.98;
const MAX_CYCLE_RUNS = 100;
const MAX_CYCLE_SPEND_ISK = 1_000_000_000;
const MAX_HISTORY = 25;
const MAX_SELL_ATTEMPTS = 12;
// Keep a short yield for the game loop without making production and travel
// appear idle between durable steps across the 100-pilot roster.
const STEP_DELAY_MS = 5_000;
const TRAVEL_DELAY_MS = 5_000;
const WAIT_DELAY_MS = 5 * 60 * 1000;
const LISTING_NO_EFFECT_MIN_AGE_MS = 60_000;
const LISTING_NO_EFFECT_CONFIRM_INTERVAL_MS = 15_000;
const LISTING_NO_EFFECT_RETRY_DELAY_MS = 30_000;
const JITA_STOCK_RETRY_MS = 10 * 60 * 1000;
const DOCK_WARP_RANGE_METERS = 50_000;
const ACTIVE_STATUSES = new Set(["active", "holding"]);
const repo = createTableRepository("service:playerbots", { strict: true });
const runningBots = new Set();
const supplyOwners = new Map();
let cycleMapCache = null;
let legacyCycleMapCache = null;

function getPlayerBots() {
  return require("./playerBotRuntime");
}

function getSpace() {
  return require("./playerBotSpaceRuntime");
}

function getTrade() {
  return require("./playerBotTradeRuntime");
}

function getIndustry() {
  return require("../industry/industryRuntimeState");
}

function getIndustryPolicy() {
  return require("./playerBotIndustryRuntime");
}

function getTasks() {
  return require("./playerBotTaskRuntime");
}

function roundIsk(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function normalizePositiveInteger(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function readCycleMap() {
  return JSON.parse(JSON.stringify(readSharedCycleMap()));
}

function readSharedCycleMap() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, CYCLE_PATH);
  const legacy = result.success && result.data && typeof result.data === "object" ? result.data : EMPTY_CYCLE_MAP;
  if (!cycleMapCache || legacyCycleMapCache !== legacy) {
    const root = repo.read(TABLE, "/");
    const all = root.success && root.data && typeof root.data === "object" ? root.data : {};
    cycleMapCache = { ...legacy };
    for (const [rowKey, wrapper] of Object.entries(all)) {
      if (!rowKey.startsWith(CYCLE_RECORD_PREFIX) || !wrapper?.playerBotIndustryCycleRecord) continue;
      cycleMapCache[rowKey.slice(CYCLE_RECORD_PREFIX.length)] = wrapper.playerBotIndustryCycleRecord;
    }
    legacyCycleMapCache = legacy;
  }
  return cycleMapCache;
}

function readCycleRecord(characterID) {
  const key = String(normalizePositiveInteger(characterID));
  if (key === "0") return null;
  repo.ensureTable(TABLE);
  const current = repo.read(TABLE, `/${CYCLE_RECORD_PREFIX}${key}`);
  if (current.success && current.data?.playerBotIndustryCycleRecord) {
    const cycle = current.data.playerBotIndustryCycleRecord;
    if (cycleMapCache) cycleMapCache[key] = cycle;
    return cycle;
  }
  const legacy = repo.read(TABLE, `${CYCLE_PATH}/${key}`);
  return legacy.success && legacy.data && typeof legacy.data === "object" ? legacy.data : null;
}

function saveCycle(cycle) {
  const key = String(cycle.characterID);
  const previous = readCycleRecord(key);
  const terminalStatuses = ["completed", "stopped", "failed", "cancelled", "canceled", "abandoned"];
  if (previous && previous.cycleID && previous.cycleID !== cycle.cycleID) {
    const operations = require("./playerBotOperationRuntime");
    if (terminalStatuses.includes(String(previous.status || "").toLowerCase())) {
      operations.archiveOperationRecord({ ...previous, operationID: previous.cycleID, kind: "industry" });
    } else {
      operations.archiveSupersededOperationRecord(previous, cycle.cycleID, "industry");
    }
  }
  cycle.updatedAt = new Date().toISOString();
  const record = JSON.parse(JSON.stringify(cycle));
  const result = repo.write(TABLE, `/${CYCLE_RECORD_PREFIX}${key}`, {
    playerBotIndustryCycleRecord: record,
  });
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_INDUSTRY_CYCLE_WRITE_FAILED");
  if (cycleMapCache) cycleMapCache[key] = record;
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_INDUSTRY_CYCLE_FLUSH_FAILED");
  }
  const operations = require("./playerBotOperationRuntime");
  if (typeof operations.refreshDashboardIndustryCyclePageIndex === "function") {
    operations.refreshDashboardIndustryCyclePageIndex(cycle);
  }
  if (cycle.cycleID && terminalStatuses.includes(cycle.status)) {
    try {
      require("./playerBotOperationRuntime").archiveOperationRecord({ ...cycle, operationID: cycle.cycleID, kind: "industry" });
    } catch (error) {
      require("../../utils/logger").warn(`[PlayerBots] Could not archive industry cycle ${cycle.cycleID}: ${error.message}`);
    }
  }
  return cycle;
}

function readCorporateListings() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, CORPORATE_LISTINGS_PATH);
  return result.success && result.data && typeof result.data === "object"
    ? JSON.parse(JSON.stringify(result.data))
    : {};
}

function saveCorporateListings(listings) {
  const result = repo.write(TABLE, CORPORATE_LISTINGS_PATH, listings);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_CORPORATE_LISTING_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_CORPORATE_LISTING_FLUSH_FAILED");
  }
}

function rememberCorporateListing(cycle, order) {
  if (!cycle || cycle.assetOwner !== "corporation" || !order) return;
  const orderID = normalizePositiveInteger(order.order_id);
  if (!orderID) return;
  const listings = readCorporateListings();
  const corporationID = getCycleAssetOwnerID(cycle);
  const stationID = normalizePositiveInteger(cycle.stationID);
  const typeID = normalizePositiveInteger(cycle.productTypeID);
  const hangarDivision = Math.trunc(Number(cycle.hangarDivision) || 0);
  // A new listing includes returned stock in this division's hangar. Mark only
  // earlier orders which have actually expired; live listings can still
  // expire later and must remain eligible for their own return/relist cycle.
  for (const previous of Object.values(listings)) {
    if (previous && Number(previous.corporationID) === corporationID &&
        Number(previous.stationID) === stationID && Number(previous.typeID) === typeID &&
        Number(previous.hangarDivision) === hangarDivision && !previous.relistedByOrderID) {
      const previousOrder = require("./playerBotEconomyRuntime").getOpenOrder(previous.orderID);
      if (String(previousOrder && previousOrder.state || "").toLowerCase() === "expired") {
        previous.relistedByOrderID = orderID;
      }
    }
  }
  listings[String(orderID)] = {
    orderID,
    characterID: Number(cycle.characterID),
    corporationID,
    stationID,
    typeID,
    hangarDivision,
    walletDivision: Math.trunc(Number(cycle.walletDivision) || 0),
    units: Math.max(0, Number(order.vol_remaining) || Number(order.vol_entered) || 0),
    price: Number(order.price) || 0,
    minimumUnitPrice: getSellFloor(cycle),
    createdAt: new Date().toISOString(),
  };
  const keys = Object.keys(listings).sort((left, right) =>
    String(listings[left]?.createdAt || "").localeCompare(String(listings[right]?.createdAt || "")));
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CORPORATE_LISTINGS))) delete listings[key];
  saveCorporateListings(listings);
}

function getCycle(characterID) {
  const cycle = readCycleRecord(characterID);
  return cycle ? JSON.parse(JSON.stringify(cycle)) : null;
}

function findExpiredCorporateOutput(bot) {
  const characterID = normalizePositiveInteger(bot && bot.characterID);
  const corporationID = normalizePositiveInteger(
    getCharacterRecord(characterID)?.corporationID || bot && bot.corporationID,
  );
  if (!characterID || !corporationID) return null;
  const economy = require("./playerBotEconomyRuntime");
  const listings = Object.values(readCorporateListings())
    .filter((listing) => listing && Number(listing.corporationID) === corporationID &&
      !listing.relistedByOrderID && normalizePositiveInteger(listing.orderID))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  for (const listing of listings) {
    const order = economy.getOpenOrder(listing.orderID);
    if (!order || String(order.state || "").toLowerCase() !== "expired") continue;
    const cycle = {
      characterID,
      corporationID,
      assetOwner: "corporation",
      assetOwnerID: corporationID,
      hangarDivision: Number(listing.hangarDivision) || 0,
      walletDivision: Number(listing.walletDivision) || 0,
      stationID: Number(listing.stationID) || 0,
      productTypeID: Number(listing.typeID) || 0,
    };
    const stacks = listCycleItems(cycle, cycle.stationID, cycle.productTypeID);
    const returnedUnits = stacks.reduce((total, item) => total +
      (Number(item.singleton) > 0 ? 1 : Math.max(1, Math.trunc(Number(item.stacksize ?? item.quantity) || 1))), 0);
    if (returnedUnits > 0) return { ...listing, returnedUnits, cycle };
  }
  return null;
}

function startExpiredCorporateResale(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const existing = getCycle(bot.characterID);
  if (existing && (ACTIVE_STATUSES.has(existing.status) || existing.status === "review" || existing.pending ||
      existing.loadSheddingPaused === true)) {
    return { success: false, message: `${bot.characterName} already has industry cycle ${existing.cycleID} in progress (${existing.stage}).` };
  }
  const listing = findExpiredCorporateOutput(bot);
  if (!listing) return { success: false, message: `${bot.characterName} has no accessible corporate sell order with returned stock after expiry.` };
  const cycle = {
    ...listing.cycle,
    cycleID: `IC${bot.characterID}-${Date.now()}-relist`,
    characterID: Number(bot.characterID),
    characterName: bot.characterName,
    status: "active",
    stage: "sell",
    solarSystemID: Number(worldData.getStationByID(listing.stationID)?.solarSystemID) || 0,
    blueprintTypeID: 0,
    autoPlan: false,
    runs: 1,
    maxSpend: 1,
    minUnitPrice: Math.max(0.01, Number(listing.minimumUnitPrice) || 0.01),
    startingBalance: roundIsk(getCycleBalance(listing.cycle)),
    pending: null,
    routeTaskID: null,
    relistOnly: true,
    relistSourceOrderIDs: [Number(listing.orderID)],
    saleRoute: null,
    saleRouteAttempted: true,
    createdAt: new Date().toISOString(),
    lastError: null,
    history: [],
    ledger: {
      blueprintSpend: 0,
      materialSpend: 0,
      industryFees: 0,
      brokerFees: 0,
      unitsListed: 0,
      unitsBought: {},
      unitsProduced: Number(listing.returnedUnits) || 0,
      unitsSold: 0,
      proceeds: 0,
      saleOrders: [],
    },
  };
  record(cycle, `Relisting ${listing.returnedUnits} corporate output unit(s) from expired sell order ${listing.orderID} at station ${listing.stationID}; the saved production price floor remains in force.`);
  saveCycle(cycle);
  return { success: true, cycle, message: `${bot.characterName} will recover and relist ${listing.returnedUnits} returned corporate item(s) from expired order ${listing.orderID}.` };
}

function listCycles() {
  return Object.values(readCycleMap()).filter((cycle) => cycle && cycle.characterID);
}

function listActiveCycles() {
  return listCycles().filter((cycle) => ACTIVE_STATUSES.has(cycle.status) ||
    cycle.status === "review" && cycle.pending && cycle.pending.action === "list" &&
    cycle.pending.listingAutoRecoveryBlocked !== true &&
    Array.isArray(cycle.pending.baselineOrderIDs));
}

// Read-only references for hot director/capacity scans. Keep public list APIs
// detached because many legacy callers treat their results as mutable copies.
function listActiveCycleRecords() {
  return Object.values(readSharedCycleMap()).filter((cycle) => cycle && cycle.characterID &&
    (ACTIVE_STATUSES.has(cycle.status) || cycle.status === "review" && cycle.pending &&
      cycle.pending.action === "list" && cycle.pending.listingAutoRecoveryBlocked !== true &&
      Array.isArray(cycle.pending.baselineOrderIDs)));
}

function listCycleRecords() {
  return Object.values(readSharedCycleMap()).filter((cycle) => cycle && cycle.characterID);
}

function record(cycle, message) {
  cycle.lastAction = String(message).slice(0, 300);
  cycle.history = [
    ...(Array.isArray(cycle.history) ? cycle.history : []),
    { at: new Date().toISOString(), stage: cycle.stage, message: cycle.lastAction },
  ].slice(-MAX_HISTORY);
}

function getBalance(characterID) {
  const balance = Number(getCharacterWallet(characterID)?.balance);
  return Number.isFinite(balance) ? balance : 0;
}

function getCycleAssetOwnerID(cycle) {
  return cycle && cycle.assetOwner === "corporation"
    ? normalizePositiveInteger(cycle.assetOwnerID || cycle.corporationID)
    : normalizePositiveInteger(cycle && cycle.characterID);
}

function getCycleHangarFlag(cycle) {
  if (!cycle || cycle.assetOwner !== "corporation") return itemStore.ITEM_FLAGS.HANGAR;
  const division = Math.trunc(Number(cycle.hangarDivision) || 0);
  return division >= 1 && division <= 7
    ? require("../industry/industryConstants").ITEM_FLAG_CORP_HANGAR_1 + division - 1
    : 0;
}

function getCycleWalletKey(cycle) {
  if (!cycle || cycle.assetOwner !== "corporation") return 1000;
  const division = Math.trunc(Number(cycle.walletDivision) || 0);
  return division >= 1 && division <= 7 ? 999 + division : 0;
}

function getCycleBalance(cycle) {
  if (!cycle || cycle.assetOwner !== "corporation") return getBalance(Number(cycle && cycle.characterID) || 0);
  const walletKey = getCycleWalletKey(cycle);
  if (!walletKey) return 0;
  const balance = Number(require("../corporation/corpWalletState")
    .getCorporationWalletBalance(getCycleAssetOwnerID(cycle), walletKey));
  return Number.isFinite(balance) ? balance : 0;
}

function getCycleMarketTransactions(cycle) {
  if (cycle && cycle.assetOwner === "corporation") {
    return require("../corporation/corpWalletState").getCorporationMarketTransactions(
      getCycleAssetOwnerID(cycle), { accountKey: getCycleWalletKey(cycle) },
    );
  }
  return getCharacterMarketTransactions(Number(cycle && cycle.characterID) || 0);
}

function getCycleWalletJournal(cycle) {
  if (cycle && cycle.assetOwner === "corporation") {
    return require("../corporation/corpWalletState").getCorporationWalletJournal(
      getCycleAssetOwnerID(cycle), { accountKey: getCycleWalletKey(cycle) },
    );
  }
  return getCharacterWalletJournal(Number(cycle && cycle.characterID) || 0);
}

function transactionUnixTime(entry) {
  try {
    const fileTime = BigInt(String(entry && entry.transactionDate || "0"));
    return Number((fileTime - 116444736000000000n) / 10000n);
  } catch (_) {
    return 0;
  }
}

function transactionAfterListingCheckpoint(entry, pending) {
  if (pending.baselineTransactionID !== null && pending.baselineTransactionID !== undefined) {
    return Number(entry && entry.transactionID) > Number(pending.baselineTransactionID);
  }
  const startedAtMs = Date.parse(pending.startedAt || "");
  const transactionMs = transactionUnixTime(entry);
  // Older durable checkpoints predate transaction IDs. Permit only a narrow
  // clock margin; inventory, order and wallet-journal deltas still must match.
  return startedAtMs > 0 && transactionMs > 0 && transactionMs >= startedAtMs - 2_000;
}

function journalAfterListingCheckpoint(entry, pending) {
  if (pending.baselineWalletJournalID !== null && pending.baselineWalletJournalID !== undefined) {
    return Number(entry && entry.transactionID) > Number(pending.baselineWalletJournalID);
  }
  const startedAtMs = Date.parse(pending.startedAt || "");
  const journalMs = transactionUnixTime(entry);
  return startedAtMs > 0 && journalMs > 0 && journalMs >= startedAtMs - 2_000;
}

function reconcilePendingListing(cycle) {
  const pending = cycle && cycle.pending;
  if (!pending || pending.action !== "list") return false;
  const economy = require("./playerBotEconomyRuntime");
  const ownerID = getCycleAssetOwnerID(cycle);
  const orders = economy.listOpenSellOrders(ownerID, cycle.stationID, cycle.productTypeID);
  if (!orders.success || !Array.isArray(pending.baselineOrderIDs)) return false;

  const baselineIDs = new Set(pending.baselineOrderIDs.map(Number));
  const createdOrders = orders.orders.filter((order) => !baselineIDs.has(Number(order.order_id)));
  if (createdOrders.length > 1 || createdOrders.some((order) =>
    Math.abs(Number(order.price) - Number(pending.price)) >= 0.01)) return false;
  const listed = createdOrders.reduce((total, order) =>
    total + Math.max(0, Math.trunc(Number(order.vol_remaining) || 0)), 0);
  const remainingUnits = countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle);
  const removed = Math.max(0, Number(pending.baselineUnits) - remainingUnits);
  if (removed <= 0) return false;

  const transactions = getCycleMarketTransactions(cycle).filter((entry) =>
    transactionAfterListingCheckpoint(entry, pending) &&
    Number(entry.sellerID) === ownerID && Number(entry.typeID) === Number(cycle.productTypeID));
  const sold = transactions.reduce((total, entry) =>
    total + Math.max(0, Math.trunc(Number(entry.quantity) || 0)), 0);
  if (removed !== sold + listed) return false;

  const walletDelta = roundIsk(getCycleBalance(cycle) - Number(pending.baselineBalance));
  const walletEntries = getCycleWalletJournal(cycle).filter((entry) =>
    journalAfterListingCheckpoint(entry, pending));
  const journalDelta = roundIsk(walletEntries.reduce((total, entry) =>
    total + Number(entry.amount || 0), 0));
  if (Math.abs(walletDelta - journalDelta) >= 0.02) return false;

  let grossProceeds = 0;
  if (sold > 0) {
    const journalByID = new Map(walletEntries.map((entry) =>
      [Number(entry.transactionID), entry]));
    const journalIDs = new Set();
    for (const transaction of transactions) {
      const journalID = Number(transaction.journalRefID);
      const journalEntry = journalByID.get(journalID);
      if (!(journalID > 0) || !journalEntry || journalIDs.has(journalID) ||
          !(Number(journalEntry.amount) > 0)) return false;
      journalIDs.add(journalID);
      grossProceeds = roundIsk(grossProceeds + Number(journalEntry.amount));
    }
  }

  const taxEntries = sold > 0 ? walletEntries.filter((entry) =>
    Number(entry.entryTypeID) === 54 && Number(entry.amount) < 0 &&
    Number(entry.ownerID2) === ownerID &&
    transactions.some((transaction) => Number(entry.referenceID) === Number(transaction.stationID) &&
      String(entry.description || "").includes(`(${Number(transaction.typeID)})`) &&
      Math.abs(transactionUnixTime(entry) - transactionUnixTime(transaction)) <= 10_000)) : [];
  const proceeds = roundIsk(grossProceeds + taxEntries.reduce((total, entry) =>
    total + Number(entry.amount || 0), 0));

  const jitaUnits = transactions.reduce((total, entry) =>
    total + (economy.isJitaStation(Number(entry.stationID))
      ? Math.max(0, Math.trunc(Number(entry.quantity) || 0)) : 0), 0);
  cycle.ledger.unitsSold = (Number(cycle.ledger.unitsSold) || 0) + sold;
  cycle.ledger.proceeds = roundIsk((Number(cycle.ledger.proceeds) || 0) + proceeds);
  cycle.ledger.unitsListed = (Number(cycle.ledger.unitsListed) || 0) + listed;
  if (listed > 0) {
    cycle.ledger.saleOrders = [...(cycle.ledger.saleOrders || []), ...createdOrders.map((order) => ({
      orderID: Number(order.order_id),
      units: Math.max(0, Number(order.vol_remaining) || 0),
      price: Number(order.price) || 0,
    }))];
    for (const order of createdOrders) rememberCorporateListing(cycle, order);
  }
  if (jitaUnits > 0) {
    cycle.ledger.jitaPolicyViolationUnits = (Number(cycle.ledger.jitaPolicyViolationUnits) || 0) + jitaUnits;
    cycle.ledger.saleReason = `Legacy listing filled ${jitaUnits} unit(s) at Jita. The fill is reconciled and will not be retried; new playerbot sales now exclude Jita buyers.`;
    record(cycle, `Recovered a legacy Jita-located market fill of ${jitaUnits} unit(s); credited ${proceeds.toFixed(2)} ISK from its exact wallet journal entry. No item was resold.`);
  } else {
    record(cycle, `Recovered pending listing: ${sold} sold, ${listed} still listed; wallet and market journal reconcile.`);
  }
  cycle.pending = null;
  saveCycle(cycle);
  return true;
}

function normalizeListingOrderSnapshot(orders) {
  return (Array.isArray(orders) ? orders : []).map((order) => ({
    orderID: Number(order && (order.order_id ?? order.orderID)) || 0,
    remaining: Math.max(0, Math.trunc(Number(order && (order.remaining ?? order.vol_remaining ?? order.volRemaining)) || 0)),
    price: roundIsk(order && order.price),
    updatedAt: String(order && (order.updated_at || order.updatedAt) || ""),
  })).sort((left, right) => left.orderID - right.orderID);
}

// A listing timeout can be retried only after authoritative reads prove no
// side effect occurred. Older durable checkpoints have IDs but no full order
// snapshot; for those, every existing order must also predate the attempt.
function pendingListingNoEffectFingerprint(cycle) {
  const pending = cycle && cycle.pending;
  if (!pending || pending.action !== "list" || !Array.isArray(pending.baselineOrderIDs)) return null;
  const startedAtMs = Date.parse(pending.startedAt || "");
  const baselineUnits = Number(pending.baselineUnits);
  if (!(startedAtMs > 0) || !Number.isFinite(baselineUnits) || baselineUnits < 0) return null;

  const economy = require("./playerBotEconomyRuntime");
  const ownerID = getCycleAssetOwnerID(cycle);
  const orderResult = economy.listOpenSellOrders(ownerID, cycle.stationID, cycle.productTypeID);
  if (!orderResult.success || !Array.isArray(orderResult.orders)) return null;
  const baselineIDs = [...new Set(pending.baselineOrderIDs.map(Number))].sort((left, right) => left - right);
  const currentOrders = normalizeListingOrderSnapshot(orderResult.orders);
  const currentIDs = currentOrders.map((order) => order.orderID);
  if (currentOrders.some((order) => !order.orderID) ||
      JSON.stringify(currentIDs) !== JSON.stringify(baselineIDs)) return null;

  if (Array.isArray(pending.baselineOrders)) {
    if (JSON.stringify(currentOrders) !== JSON.stringify(normalizeListingOrderSnapshot(pending.baselineOrders))) return null;
  } else {
    for (const order of currentOrders) {
      const updatedAtMs = Date.parse(order.updatedAt);
      if (!(updatedAtMs > 0) || updatedAtMs > startedAtMs - 2_000) return null;
    }
  }

  const remainingUnits = countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle);
  if (remainingUnits !== baselineUnits ||
      Math.abs(roundIsk(getCycleBalance(cycle) - Number(pending.baselineBalance))) >= 0.01) return null;

  const transactions = getCycleMarketTransactions(cycle).filter((entry) =>
    transactionAfterListingCheckpoint(entry, pending) &&
    Number(entry && entry.sellerID) === ownerID && Number(entry && entry.typeID) === Number(cycle.productTypeID));
  if (transactions.length) return null;
  const walletEntries = getCycleWalletJournal(cycle).filter((entry) => journalAfterListingCheckpoint(entry, pending));
  if (walletEntries.length) return null;

  return JSON.stringify({ orders: currentOrders, remainingUnits, balance: roundIsk(getCycleBalance(cycle)) });
}

function confirmPendingListingNoEffect(cycle, now = Date.now()) {
  const pending = cycle && cycle.pending;
  const fingerprint = pendingListingNoEffectFingerprint(cycle);
  const startedAtMs = Date.parse(pending && pending.startedAt || "");
  if (!fingerprint || !(startedAtMs > 0)) {
    if (pending) pending.listingAutoRecoveryBlocked = true;
    return { retry: false, delayMs: WAIT_DELAY_MS, ambiguous: true };
  }

  const lastObservedAt = Number(pending.lastNoEffectObservedAt) || 0;
  const sameSnapshot = String(pending.noEffectFingerprint || "") === fingerprint;
  if (sameSnapshot && lastObservedAt && now - lastObservedAt >= LISTING_NO_EFFECT_CONFIRM_INTERVAL_MS) {
    pending.noEffectObservations = Math.max(1, Math.trunc(Number(pending.noEffectObservations) || 0)) + 1;
    pending.lastNoEffectObservedAt = now;
  } else if (!sameSnapshot || !lastObservedAt) {
    pending.noEffectObservations = 1;
    pending.noEffectFingerprint = fingerprint;
    pending.lastNoEffectObservedAt = now;
    pending.firstNoEffectObservedAt = now;
  }

  const stableLongEnough = now - startedAtMs >= LISTING_NO_EFFECT_MIN_AGE_MS &&
    Number(pending.noEffectObservations) >= 2 &&
    now - Number(pending.firstNoEffectObservedAt || now) >= LISTING_NO_EFFECT_CONFIRM_INTERVAL_MS;
  if (stableLongEnough) {
    cycle.pending = null;
    cycle.status = "active";
    cycle.lastError = null;
    record(cycle, "Two spaced authority snapshots confirm the timed-out sell listing changed no inventory, wallet, transaction, or order state; safely retrying it.");
    saveCycle(cycle);
    return { retry: true, delayMs: 0 };
  }
  saveCycle(cycle);
  return { retry: false, delayMs: LISTING_NO_EFFECT_RETRY_DELAY_MS, ambiguous: false };
}

function listCycleItems(cycle, stationID, typeID) {
  if (!cycle || cycle.assetOwner !== "corporation") {
    return itemStore.listCharacterItems(Number(cycle && cycle.characterID) || 0, {
      locationID: stationID,
      flagID: itemStore.ITEM_FLAGS.HANGAR,
      typeID,
    });
  }
  const ownerID = getCycleAssetOwnerID(cycle);
  const session = getSpace().getActorSession(resolveBotByID(cycle.characterID));
  const locations = getIndustry().resolveFacilityLocations(stationID, ownerID, null, session);
  const flagID = getCycleHangarFlag(cycle);
  const accessible = locations.some((location) => Number(location.flagID) === flagID &&
    Number(location.ownerID) === ownerID && location.canView !== false && location.canTake === true);
  if (!accessible) return [];
  return itemStore.listOwnedItems(ownerID, { locationID: stationID, flagID, typeID });
}

function countUnits(characterID, stationID, typeID, cycle = null) {
  const items = cycle
    ? listCycleItems(cycle, stationID, typeID)
    : itemStore.listCharacterItems(characterID, {
        locationID: stationID,
        flagID: itemStore.ITEM_FLAGS.HANGAR,
        typeID,
      });
  return items.reduce((total, item) => {
    if (Number(item && item.singleton) > 0) return total + 1;
    const units = Number(item && (item.stacksize ?? item.quantity));
    return total + (Number.isFinite(units) && units > 0 ? Math.trunc(units) : 1);
  }, 0);
}

function getCycleTradeOptions(cycle) {
  if (!cycle || cycle.assetOwner !== "corporation") return {};
  return {
    corporationID: getCycleAssetOwnerID(cycle),
    hangarDivision: Number(cycle.hangarDivision),
    walletDivision: Number(cycle.walletDivision),
  };
}

function totalSpend(cycle) {
  const ledger = cycle.ledger || {};
  return roundIsk((Number(ledger.blueprintSpend) || 0) + (Number(ledger.materialSpend) || 0) + (Number(ledger.industryFees) || 0) + (Number(ledger.brokerFees) || 0));
}

function remainingBudget(cycle) {
  return roundIsk(Number(cycle.maxSpend) - totalSpend(cycle));
}

function resolveBotByID(characterID) {
  return getPlayerBots().listBots().find((bot) => Number(bot.characterID) === Number(characterID)) || null;
}

function block(cycle, status, reason) {
  cycle.status = status;
  cycle.lastError = String(reason).slice(0, 300);
  record(cycle, reason);
  saveCycle(cycle);
  return { done: status !== "holding", delayMs: WAIT_DELAY_MS };
}

function startCycle(botQuery, blueprintTypeID, runs, maxSpend, options = {}) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  if (bot.specialty !== "industry") {
    return { success: false, message: `${bot.characterName} is not an industry specialist.` };
  }
  const autoPlan = Number(blueprintTypeID) === 0;
  const definition = autoPlan
    ? { blueprintTypeID: 0, productTypeID: 0, blueprintName: "most profitable product", productName: "product selected on arrival" }
    : getBlueprintDefinitionByTypeID(blueprintTypeID);
  const manufacturing = definition && definition.activities && definition.activities.manufacturing;
  if (!autoPlan && (!definition || !manufacturing || !Number(definition.productTypeID))) {
    return { success: false, message: `Type ${blueprintTypeID} is not a supported manufacturing blueprint.` };
  }
  const normalizedRuns = Math.trunc(Number(runs));
  if (!Number.isSafeInteger(normalizedRuns) || normalizedRuns < 1 || normalizedRuns > MAX_CYCLE_RUNS) {
    return { success: false, message: `Runs per cycle must be between 1 and ${MAX_CYCLE_RUNS}.` };
  }
  const normalizedSpend = roundIsk(maxSpend);
  if (!(normalizedSpend >= 1) || normalizedSpend > MAX_CYCLE_SPEND_ISK) {
    return { success: false, message: `Maximum cycle spend must be between 1 and ${MAX_CYCLE_SPEND_ISK.toLocaleString("en-US")} ISK.` };
  }
  const stationID = normalizePositiveInteger(options.stationID) || hubStationFor(bot);
  const station = worldData.getStationByID(stationID);
  const structure = !station ? worldData.getStructureByID(stationID) : null;
  const facility = station || structure;
  if (!facility) return { success: false, message: `Industry facility ${stationID} does not exist.` };
  const character = getCharacterRecord(bot.characterID) || {};
  const session = getSpace().getActorSession(bot);
  const facilityPayload = getFacilityPayloadByID(stationID, session);
  if (!facilityPayload || !facilityPayload.activities ||
      !facilityPayload.activities[require("../industry/industryConstants").INDUSTRY_ACTIVITY.MANUFACTURING]) {
    return { success: false, message: `${facility.stationName || facility.name || stationID} has no online manufacturing service.` };
  }
  const structureFacility = Boolean(structure);
  if (structureFacility) {
    const manufacturingServices = require("../structure/structureServiceAuthority")
      .getStructureServiceIDsForModuleType(35878);
    const exposedServices = facilityPayload.serviceAccess || {};
    if (!manufacturingServices.some((serviceID) => Object.hasOwn(exposedServices, String(serviceID)))) {
      return { success: false, message: `${facility.name || stationID} does not grant this pilot access to its manufacturing service.` };
    }
    if (options.assetOwner === "corporation") {
      return { success: false, message: "Structure manufacturing currently uses the bot's personal hangar and wallet; corporation structure cycles are not enabled." };
    }
    if (!autoPlan) {
      const product = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(definition.productTypeID)) || {};
      if (Number(product.categoryID) === 6) {
        return { success: false, message: "Structure cycles can only transport manufactured outputs that fit in cargo; ship production must run at its buyer's station." };
      }
      const outputVolume = (Number(product.volume) || 0) *
        (Number(manufacturing.products && manufacturing.products[0] && manufacturing.products[0].quantity) || 1) *
        normalizedRuns;
      if (outputVolume > require("./playerBotInventoryRuntime").getCargoBayCapacity(bot) + 1e-9) {
        return { success: false, message: `The requested structure output needs ${outputVolume.toFixed(2)} m³; the active ship's cargo bay is too small for the return trip to market.` };
      }
    }
  }
  const minUnitPrice = options.minUnitPrice === undefined || options.minUnitPrice === null
    ? null
    : roundIsk(options.minUnitPrice);
  const corporationID = Number(session.corporationID || session.corpid || character.corporationID || bot.corporationID) || 0;
  const corporateAssets = options.assetOwner === "corporation";
  const hangarDivision = Math.trunc(Number(options.hangarDivision) || 0);
  const walletDivision = Math.trunc(Number(options.walletDivision) || 0);
  if (corporateAssets && (autoPlan || !corporationID || hangarDivision < 1 || hangarDivision > 7 || walletDivision < 1 || walletDivision > 7)) {
    return { success: false, message: "Corporation cycles need an explicit blueprint type, a valid member corporation, and hangar and wallet divisions from 1 to 7." };
  }
  let deliverTo = null;
  if (options.deliverTo && Number(options.deliverTo.orderID)) {
    if (corporateAssets) {
      return { success: false, message: "Corporation cycles sell or list output from the selected shared hangar; remote order delivery is not enabled for shared assets." };
    }
    const order = require("./playerBotEconomyRuntime").getPlayerBuyOrder(options.deliverTo.orderID);
    const requestedStationID = normalizePositiveInteger(options.deliverTo.stationID);
    if (!order || Number(order.type_id) !== Number(definition.productTypeID) ||
        Number(order.station_id) !== requestedStationID || Number(order.vol_remaining) <= 0) {
      return { success: false, message: `Player buy order ${options.deliverTo.orderID} is no longer available for ${definition.productName}.` };
    }
    const product = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(definition.productTypeID)) || {};
    if (Number(product.categoryID) === 6 && stationID !== requestedStationID) {
      return { success: false, message: `Ship orders must be manufactured at the buyer's station (${requestedStationID}).` };
    }
    deliverTo = {
      orderID: Number(order.order_id),
      stationID: Number(order.station_id),
      price: Number(order.price),
      maxUnits: Math.max(0, Math.trunc(Number(options.deliverTo.maxUnits) || 0)),
    };
  }

  const priorOperation = require("./playerBotOperationRuntime").getOperation(bot.characterID);
  if (priorOperation && (["active", "holding", "review"].includes(priorOperation.status) || priorOperation.pending ||
      priorOperation.loadSheddingPaused === true)) {
    return { success: false, message: `${bot.characterName} has an active hauling or mining operation; stop it first.` };
  }
  const existing = getCycle(bot.characterID);
  if (existing && (ACTIVE_STATUSES.has(existing.status) || existing.status === "review" || existing.pending ||
      existing.loadSheddingPaused === true)) {
    return { success: false, message: `${bot.characterName} already has industry cycle ${existing.cycleID} in progress (${existing.stage}). Stop it before starting another.` };
  }
  const cycle = {
    cycleID: `IC${bot.characterID}-${Date.now()}`,
    characterID: Number(bot.characterID),
    characterName: bot.characterName,
    corporationID,
    assetOwner: corporateAssets ? "corporation" : "personal",
    assetOwnerID: corporateAssets ? corporationID : Number(bot.characterID),
    hangarDivision: corporateAssets ? hangarDivision : null,
    walletDivision: corporateAssets ? walletDivision : null,
    status: "active",
    stage: "travel",
    stationID,
    industryFacilityID: structureFacility ? stationID : null,
    structureFacility,
    solarSystemID: Number(facility.solarSystemID) || 0,
    blueprintTypeID: Number(definition.blueprintTypeID),
    productTypeID: Number(definition.productTypeID),
    autoPlan,
    runs: normalizedRuns,
    maxSpend: normalizedSpend,
    minUnitPrice,
    requestedByCharacterID: normalizePositiveInteger(options.requestedByCharacterID) || null,
    startingBalance: corporateAssets
      ? roundIsk(require("../corporation/corpWalletState").getCorporationWalletBalance(corporationID, 999 + walletDivision))
      : roundIsk(getBalance(bot.characterID)),
    blueprintItemID: null,
    jobID: null,
    routeTaskID: null,
    pending: null,
    sellAttempts: 0,
    ledger: {
      blueprintSpend: 0,
      materialSpend: 0,
      industryFees: 0,
      brokerFees: 0,
      unitsListed: 0,
      unitsBought: {},
      unitsProduced: 0,
      unitsSold: 0,
      proceeds: 0,
    },
    lastError: null,
    createdAt: new Date().toISOString(),
    history: [],
    deliverTo,
    previousCycle: existing ? {
      cycleID: existing.cycleID,
      status: existing.status,
      stage: existing.stage,
      stationID: existing.stationID,
      blueprintItemID: existing.blueprintItemID,
      totalSpend: totalSpend(existing),
      proceeds: Number(existing.ledger && existing.ledger.proceeds) || 0,
      lastError: existing.lastError,
    } : null,
  };
  const facilityName = facility.stationName || facility.name || String(stationID);
  record(cycle, `Started cycle: ${definition.blueprintName} ×${normalizedRuns} at ${facilityName}, maximum spend ${normalizedSpend.toFixed(2)} ISK${corporateAssets ? ` from corporation hangar ${hangarDivision} and wallet ${walletDivision}` : " from the personal hangar and wallet"}.`);
  saveCycle(cycle);
  return {
    success: true,
    cycle,
    message: corporateAssets
      ? `${bot.characterName} started corporation cycle ${cycle.cycleID}: it will use only blueprint and materials already present in hangar division ${hangarDivision}, charge industry fees to wallet division ${walletDivision} through normal role checks, deliver output to the selected corporation hangar, then sell or list it back to the same corporation wallet. No missing corporate input will be purchased from personal funds. Maximum spend: ${normalizedSpend.toFixed(2)} ISK.`
      : `${bot.characterName} started cycle ${cycle.cycleID}: it will travel to ${facilityName}, buy ${definition.blueprintName} and missing inputs using its personal wallet (${cycle.startingBalance.toFixed(2)} ISK), manufacture ${normalizedRuns} ${definition.productName}, then sell to eligible buy orders or list unsold output. Ship hulls are retained in the personal hangar. Maximum spend: ${normalizedSpend.toFixed(2)} ISK.`,
  };
}

function stopCycle(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const cycle = getCycle(bot.characterID);
  if (!cycle || (!ACTIVE_STATUSES.has(cycle.status) && !["review", "blocked"].includes(cycle.status) &&
      cycle.loadSheddingPaused !== true)) {
    return { success: true, message: `${bot.characterName} has no active industry cycle.` };
  }
  if (cycle.routeTaskID) {
    const task = getTasks().getTask(cycle.routeTaskID);
    if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
  }
  cycle.status = "stopped";
  cycle.loadSheddingPaused = false;
  delete cycle.loadSheddingPausedAtMs;
  delete cycle.loadSheddingPauseReason;
  record(cycle, "Cycle stopped by an operator. Installed jobs and inventory are preserved.");
  saveCycle(cycle);
  return { success: true, message: `Cycle ${cycle.cycleID} for ${bot.characterName} stopped at stage ${cycle.stage}. Installed jobs and inventory are preserved.` };
}

function pauseForCapacity(characterID, reason = "Playerbot work is queued to protect the game server.") {
  const id = normalizePositiveInteger(characterID);
  if (!id || runningBots.has(id)) return { success: false, reason: "action-in-progress" };
  const cycle = getCycle(id);
  if (!cycle || !ACTIVE_STATUSES.has(cycle.status) || cycle.pending) {
    return { success: false, reason: "cycle-not-pausable" };
  }
  if (cycle.routeTaskID) {
    const task = getTasks().getTask(cycle.routeTaskID);
    if (task && ["queued", "leased"].includes(task.status)) getTasks().cancelTask(task.taskID);
  }
  cycle.status = "stopped";
  cycle.loadSheddingPaused = true;
  cycle.loadSheddingPausedAtMs = Date.now();
  cycle.loadSheddingPauseReason = String(reason).slice(0, 200);
  cycle.routeTaskID = null;
  record(cycle, `Paused for server capacity at ${cycle.stage}; installed jobs and inventory are preserved.`);
  saveCycle(cycle);
  return { success: true, cycle };
}

function resumeCycle(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const cycle = getCycle(bot.characterID);
  if (runningBots.has(Number(bot.characterID))) return { success: false, message: `${bot.characterName} still has an industry action in progress; wait for it to finish.` };
  if (!cycle || !["review", "blocked", "stopped"].includes(cycle.status)) {
    return { success: false, message: `${bot.characterName} has no stopped or review-pending industry cycle.` };
  }
  cycle.status = "active";
  cycle.loadSheddingPaused = false;
  delete cycle.loadSheddingPausedAtMs;
  delete cycle.loadSheddingPauseReason;
  // Keep an uncertain listing checkpoint so the next step can reconcile its
  // exact order, item, market-transaction and wallet-journal deltas.
  if (!cycle.pending || cycle.pending.action !== "list") cycle.pending = null;
  cycle.lastError = null;
  cycle.routeTaskID = null;
  record(cycle, "Cycle resumed by an operator after reviewing the wallet and inventory.");
  saveCycle(cycle);
  require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(bot.characterID).catch((error) =>
    require("../../utils/logger").warn(`[PlayerBots] Could not advance cycle ${cycle.cycleID}: ${error.message}`));
  return { success: true, cycle, message: `Cycle ${cycle.cycleID} for ${bot.characterName} resumed at stage ${cycle.stage}.` };
}

function ensureRouteTask(cycle, bot) {
  const tasks = getTasks();
  const existing = tasks.listTasks({ limit: 100 }).find((task) =>
    task.kind === "playerbot.space.route" &&
    ["queued", "leased"].includes(task.status) &&
    Number(task.resourceOwnerCharacterID) === Number(bot.characterID),
  );
  if (existing) {
    if (Number(existing.payload && existing.payload.destinationSystemID) !== Number(cycle.solarSystemID)) {
      return { error: `${bot.characterName} already has another route (${existing.taskID}) to ${existing.payload.destinationSystemID}; cancel it before continuing.` };
    }
    return { task: existing, created: false, risk: existing.payload && existing.payload.routeRisk || null };
  }
  if (cycle.routeTaskID) {
    const previous = tasks.getTask(cycle.routeTaskID);
    if (previous && previous.status === "failed") {
      return { error: `Route ${previous.taskID} failed: ${String(previous.lastError || "no details").slice(0, 200)}.` };
    }
  }
  const preview = getSpace().previewSystemRoute(bot, cycle.solarSystemID);
  if (!preview.success) return { error: preview.message || "No stargate route to the market is available." };
  const queued = tasks.enqueueTask({
    kind: "playerbot.space.route",
    capability: "navigation",
    resourceOwnerCharacterID: Number(bot.characterID),
    requestedBy: "system",
    dedupeKey: `playerbot.space.route:${Number(bot.characterID)}:${cycle.solarSystemID}`,
    payload: {
      destinationSystemID: Number(cycle.solarSystemID),
      plannedSystemIDs: preview.systemIDs,
      plannedHopCount: preview.hops,
      routeRisk: preview.risk,
      industryCycleID: cycle.cycleID,
    },
  });
  return { task: queued.task, created: queued.created !== false, hops: preview.hops, risk: preview.risk };
}

async function stepTravel(cycle, bot) {
  const character = getCharacterRecord(bot.characterID) || {};
  const dockedStationID = normalizePositiveInteger(character.stationID || character.structureID);
  if (dockedStationID === cycle.stationID) {
    cycle.stage = cycle.autoPlan && !cycle.blueprintTypeID ? "plan" : "acquire-blueprint";
    record(cycle, `Docked at ${cycle.stationID}.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  const currentSystemID = normalizePositiveInteger(character.solarSystemID);
  if (currentSystemID !== cycle.solarSystemID) {
    const route = ensureRouteTask(cycle, bot);
    if (route.error) return block(cycle, "blocked", route.error);
    if (cycle.routeTaskID !== route.task.taskID) {
      cycle.routeTaskID = route.task.taskID;
      const risk = route.risk;
      const riskSummary = risk
        ? `risk ${risk.lowsecSystemIDs.length} low-sec, ${risk.nullsecSystemIDs.length} null-sec systems`
        : "risk report unavailable";
      record(cycle, `Route ${route.task.taskID} to system ${cycle.solarSystemID}${route.hops !== undefined ? ` (${route.hops} jumps)` : ""}; ${riskSummary}.`);
      saveCycle(cycle);
    }
    await require("./playerBotAutonomyRuntime").ensureNavigationTask(route.task.taskID);
    return { delayMs: TRAVEL_DELAY_MS };
  }

  const space = getSpace();
  if (dockedStationID) {
    const result = space.undock(bot, { allowOverCapacityDeparture: true });
    if (!result.success) return result.capacityQueued
      ? { delayMs: TRAVEL_DELAY_MS, capacityQueued: true, capacityReason: result.message }
      : block(cycle, "blocked", result.message);
    record(cycle, `Undocking from ${dockedStationID} to travel to ${cycle.stationID}.`);
    saveCycle(cycle);
    return { delayMs: TRAVEL_DELAY_MS };
  }
  const state = space.getSpaceState(bot);
  if (!state.inSpace) return { delayMs: TRAVEL_DELAY_MS };
  if (state.busy) return { delayMs: TRAVEL_DELAY_MS };
  const distance = state.distanceTo(cycle.stationID);
  if (distance === null) return block(cycle, "blocked", `Station ${cycle.stationID} is not in the local scene.`);
  if (distance > DOCK_WARP_RANGE_METERS) {
    const result = space.warp(bot, cycle.stationID);
    if (!result.success) return block(cycle, "blocked", result.message);
    record(cycle, `Warping to station ${cycle.stationID} (${Math.round(distance / 1000)} km).`);
    saveCycle(cycle);
    return { delayMs: TRAVEL_DELAY_MS };
  }
  const result = space.dock(bot, cycle.stationID);
  if (!result.success) return block(cycle, "blocked", result.message);
  return { delayMs: STEP_DELAY_MS * 2 };
}

function settlePendingPurchase(cycle) {
  const pending = cycle.pending;
  const units = countUnits(cycle.characterID, Number(pending.stationID) || cycle.stationID, pending.typeID, cycle);
  const balance = getCycleBalance(cycle);
  const bought = Math.max(0, units - Number(pending.baselineUnits));
  const spent = roundIsk(Math.max(0, Number(pending.baselineBalance) - balance));
  const hasTransactionCheckpoint = pending.baselineTransactionID !== null &&
    pending.baselineTransactionID !== undefined;
  const baselineTransactionID = Number(pending.baselineTransactionID);
  const transactions = hasTransactionCheckpoint && Number.isFinite(baselineTransactionID) &&
    typeof getCharacterMarketTransactions === "function"
    ? getCharacterMarketTransactions(cycle.characterID).filter((entry) =>
      Number(entry.transactionID) > baselineTransactionID &&
      Number(entry.buyerID) === Number(cycle.characterID) &&
      Number(entry.typeID) === Number(pending.typeID) &&
      Number(entry.stationID) === Number(pending.stationID))
    : [];
  const transactionUnits = transactions.reduce((total, entry) =>
    total + Math.max(0, Math.trunc(Number(entry.quantity) || 0)), 0);
  const transactionSpend = roundIsk(transactions.reduce((total, entry) =>
    total + Math.max(0, Number(entry.quantity) || 0) * Math.max(0, Number(entry.price) || 0), 0));
  // A lost market response is safe to accept only when the market ledger,
  // hangar delta, and wallet delta all describe the same completed fills.
  const transactionReconciled = hasTransactionCheckpoint && Number.isFinite(baselineTransactionID) &&
    bought > 0 && transactionUnits === bought && Math.abs(transactionSpend - spent) < 0.02;
  return { bought, spent, transactionUnits, transactionSpend, transactionReconciled };
}

function applyPurchase(cycle, typeID, bought, spent, kind) {
  const ledger = cycle.ledger;
  ledger.unitsBought[String(typeID)] = (Number(ledger.unitsBought[String(typeID)]) || 0) + bought;
  if (kind === "blueprint") ledger.blueprintSpend = roundIsk(ledger.blueprintSpend + spent);
  else ledger.materialSpend = roundIsk(ledger.materialSpend + spent);
}

function markJitaRunPurchase(cycle, stationID, bought) {
  if (Number(bought) > 0 && cycle.jitaRun &&
      Number(cycle.jitaRun.sourceStationID) === Number(stationID)) {
    cycle.jitaRun.bought = true;
  }
}

async function buyFromBestAsk(cycle, bot, typeID, neededUnits, kind, atStationID = cycle.stationID) {
  let quote;
  try {
    quote = await getTrade().readQuote(bot.characterName, typeID);
  } catch (error) {
    return block(cycle, "holding", `Market unavailable for ${typeID}: ${String(error && error.message || error).slice(0, 160)}.`);
  }
  if (!quote.success) {
    if (cycle.structureFacility === true && Number(atStationID) === Number(cycle.industryFacilityID)) {
      const supply = await getTrade().readBestAskOutsideJita(bot.characterName, typeID).catch(() => ({ success: false }));
      if (!supply.success) return block(cycle, "holding", `Could not verify non-Jita supply for ${typeID}; ${quote.message || supply.message || "market quote unavailable at the structure"}.`);
      return startJitaRun(cycle, [{ typeID, units: neededUnits, kind }],
        Number(supply.bestAsk && supply.bestAsk.stationID) || require("./playerBotEconomyRuntime").JITA_BUY_STATION_ID);
    }
    return block(cycle, "holding", quote.message);
  }
  const ask = quote.bestAsk;
  if (!ask) {
    const economy = require("./playerBotEconomyRuntime");
    if (Number(atStationID) !== economy.JITA_BUY_STATION_ID) {
      if (Number(cycle.jitaUnavailableUntil || 0) > Date.now()) {
        return block(cycle, "holding", `No local sell orders for ${typeID}; Jita is also out of stock. Waiting for supply at ${cycle.stationID}.`);
      }
      const supply = await getTrade().readBestAskOutsideJita(bot.characterName, typeID);
      if (!supply.success) return block(cycle, "holding", `Could not verify non-Jita supply for ${typeID}; the purchase is paused safely. ${supply.message}`);
      // Use any live regional source before travelling to the seed market.
      return startJitaRun(cycle, [{ typeID, units: neededUnits, kind }],
        supply.bestAsk ? Number(supply.bestAsk.stationID) : economy.JITA_BUY_STATION_ID);
    }
    return block(cycle, "holding", `No sell orders for ${typeID} at ${atStationID}; waiting for stock.`);
  }
  const budget = remainingBudget(cycle);
  const balance = getBalance(cycle.characterID);
  const affordable = Math.floor((Math.min(budget, balance) + 0.0001) / ask.price);
  const quantity = Math.min(neededUnits, ask.quantity, affordable);
  if (quantity <= 0) {
    return block(
      cycle,
      "holding",
      `Insufficient funds or budget for ${typeID}: price ${ask.price.toFixed(2)} ISK, remaining budget ${budget.toFixed(2)} ISK, wallet ${balance.toFixed(2)} ISK.`,
    );
  }
  cycle.pending = {
    action: "buy",
    kind,
    typeID,
    quantity,
    unitPrice: ask.price,
    stationID: Number(atStationID),
    baselineUnits: countUnits(cycle.characterID, atStationID, typeID),
    baselineBalance: balance,
    baselineTransactionID: typeof getCharacterMarketTransactions === "function"
      ? getCharacterMarketTransactions(cycle.characterID)
        .reduce((highest, entry) => Math.max(highest, Number(entry.transactionID) || 0), 0)
      : null,
    startedAt: new Date().toISOString(),
  };
  cycle.status = "active";
  saveCycle(cycle);
  const trade = await getTrade().buy(bot.characterName, typeID, quantity, ask.price);
  const purchaseAttempt = { ...cycle.pending };
  const observed = settlePendingPurchase(cycle);
  if (!trade.success && trade.outcomeUnknown) {
    applyPurchase(cycle, typeID, observed.bought, observed.spent, kind);
    markJitaRunPurchase(cycle, atStationID, observed.bought);
    cycle.pending = null;
    if (observed.transactionReconciled) {
      cycle.lastError = null;
      record(cycle, `Market response was lost, but the ledger, wallet, and hangar confirm ${observed.bought} units of ${typeID} bought for ${observed.spent.toFixed(2)} ISK.`);
      saveCycle(cycle);
      return { delayMs: STEP_DELAY_MS };
    }
    cycle.lastPurchaseReview = {
      ...purchaseAttempt,
      observedBought: observed.bought,
      observedSpent: observed.spent,
      authorityMessage: String(trade.message || "Market outcome was not confirmed").slice(0, 600),
      recordedAt: new Date().toISOString(),
    };
    return block(cycle, "review", `Uncertain purchase of ${typeID}: observed ${observed.bought} units for ${observed.spent.toFixed(2)} ISK. ${cycle.lastPurchaseReview.authorityMessage} Review it before using /playerbots industry cycle resume.`);
  }
  cycle.pending = null;
  applyPurchase(cycle, typeID, observed.bought, observed.spent, kind);
  markJitaRunPurchase(cycle, atStationID, observed.bought);
  if (!trade.success) return block(cycle, "holding", trade.message);
  cycle.lastError = null;
  record(cycle, observed.bought
    ? `Bought ${observed.bought} units of ${typeID} for ${observed.spent.toFixed(2)} ISK.`
    : `Could not buy ${typeID}: ${trade.message}`);
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

// Reserve the buyer's cycle before a contract can move its cash or items.
// A crash leaves the marker visible and requires reconciliation, not a retry.
function beginSupplyPurchase(characterID, cycleID, stationID, typeID, requestedUnits, unitPrice, sellerID) {
  const id = normalizePositiveInteger(characterID);
  if (!id || runningBots.has(id)) return { success: false, reason: "buyer-busy" };
  const interruptions = require("./playerBotInterruptRuntime");
  if (interruptions.hasPending(id) || require("./playerBotLocalDefenseAdapter").hasLease(id))
    return { success: false, reason: "buyer-emergency-busy" };
  const owner = interruptions.acquire(id, "supply-contract", cycleID);
  if (!owner) return { success: false, reason: "buyer-busy" };
  runningBots.add(id);
  let acquired = true;
  try {
    const cycle = getCycle(id);
    const buyer = resolveBotByID(id);
    const character = getCharacterRecord(id) || {};
    if (!cycle || !buyer || cycle.cycleID !== cycleID || cycle.stage !== "acquire-materials" ||
        !ACTIVE_STATUSES.has(cycle.status) || cycle.pending || Number(cycle.stationID) !== Number(stationID) ||
        Number(character.stationID) !== Number(stationID)) return { success: false, reason: "buyer-not-ready" };
    const context = getIndustryPolicy().getManufacturingContext(buyer, cycle.blueprintItemID, cycle.runs);
    const quote = context.quoteResult && context.quoteResult.quote;
    const material = quote && Array.isArray(quote.materials) && quote.materials.find((entry) => Number(entry.typeID) === Number(typeID));
    const deficit = material ? Math.max(0, Number(material.quantity) - Number(quote.availableMaterials?.[typeID] || 0)) : 0;
    const price = Number(unitPrice);
    if (!(price > 0) || !Number.isFinite(price)) return { success: false, reason: "invalid-price" };
    const maxSpend = Math.min(remainingBudget(cycle), getBalance(id));
    const units = Math.max(0, Math.min(Math.trunc(Number(requestedUnits) || 0), deficit, Math.floor((maxSpend + 0.0001) / price)));
    if (!units) return { success: false, reason: "no-demand-or-budget" };
    const total = roundIsk(units * price);
    if (total > maxSpend + 0.0001) return { success: false, reason: "budget-exceeded" };
    const token = `${cycle.cycleID}:${sellerID}:${typeID}:${Date.now()}`;
    cycle.pending = { action: "supply-contract", token, sellerID: Number(sellerID), typeID: Number(typeID), units, price: total,
      baselineUnits: countUnits(id, stationID, typeID), baselineBalance: getBalance(id), startedAt: new Date().toISOString() };
    saveCycle(cycle);
    supplyOwners.set(id, { token, owner });
    acquired = false;
    return { success: true, token, units, price: total };
  } finally {
    if (acquired) { runningBots.delete(id); interruptions.release(owner); }
  }
}

function finishSupplyPurchase(characterID, token, result) {
  const id = normalizePositiveInteger(characterID);
  const reservation = supplyOwners.get(id);
  if (!reservation) return { success: false, reason: "supply-owner-missing" };
  if (reservation && reservation.token !== token) return { success: false, reason: "supply-owner-mismatch" };
  try {
    const cycle = getCycle(id);
    const pending = cycle && cycle.pending;
    if (!pending || pending.action !== "supply-contract" || pending.token !== token) return { success: false, reason: "supply-marker-missing" };
    const observedUnits = Math.max(0, countUnits(id, cycle.stationID, pending.typeID) - Number(pending.baselineUnits));
    const observedSpend = roundIsk(Math.max(0, Number(pending.baselineBalance) - getBalance(id)));
    if (!result || result.confirmed !== true || observedUnits !== Number(pending.units) || Math.abs(observedSpend - Number(pending.price)) >= 0.01) {
      block(cycle, "review", "Unreconciled supply contract; check the contract, inventory, and wallet before resuming.");
      return { success: false, reason: "supply-outcome-unknown" };
    }
    applyPurchase(cycle, pending.typeID, observedUnits, observedSpend, "material");
    cycle.ledger.suppliedUnits = (Number(cycle.ledger.suppliedUnits) || 0) + observedUnits;
    cycle.pending = null;
    if (cycle.status === "holding") cycle.status = "active";
    cycle.lastError = null;
    record(cycle, `Supply from ${result.sellerName} (contract ${result.contractID}): ${observedUnits}× ${pending.typeID} for ${observedSpend.toFixed(2)} ISK.`);
    saveCycle(cycle);
    if (cycle.status === "active") require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(id).catch((error) =>
      require("../../utils/logger").warn(`[PlayerBots] Could not advance cycle ${cycle.cycleID}: ${error.message}`));
    return { success: true, units: observedUnits, spent: observedSpend };
  } finally {
    runningBots.delete(id);
    if (reservation) {
      supplyOwners.delete(id);
      require("./playerBotInterruptRuntime").release(reservation.owner);
      require("./playerBotOperationRuntime").drainInterruptions(id);
    }
  }
}

const CYCLE_STORE = Object.freeze({
  save: (entity) => saveCycle(entity),
  block: (entity, status, reason) => block(entity, status, reason),
});

function isJitaSeedStation(economy, stationID) {
  return typeof economy.isJitaStation === "function"
    ? economy.isJitaStation(Number(stationID))
    : Number(stationID) === Number(economy.JITA_BUY_STATION_ID);
}

function selectJitaSeedStation(economy, items, excludedStationIDs = []) {
  if (typeof economy.findBestJitaSeedStation !== "function") return 0;
  return Number(economy.findBestJitaSeedStation(items, excludedStationIDs)) || 0;
}

async function readBestJitaSeedQuote(trade, economy, bot, typeID) {
  const stationID = selectJitaSeedStation(economy, [{ typeID: Number(typeID), quantity: 1 }]) ||
    Number(economy.JITA_BUY_STATION_ID) || 0;
  let quote = { success: false };
  if (stationID && typeof trade.readQuoteAt === "function") {
    quote = await trade.readQuoteAt(bot.characterName, Number(typeID), stationID)
      .catch(() => ({ success: false }));
    if (quote.success && quote.bestAsk) return quote;
  }
  const offer = typeof economy.listSellOffers === "function"
    ? economy.listSellOffers(Number(typeID))
      .filter((entry) => typeof economy.isJitaStation === "function" &&
        economy.isJitaStation(Number(entry.stationID)) &&
        Number(entry.price) > 0 && Number(entry.quantity) > 0)
      .sort((left, right) => Number(left.price) - Number(right.price) ||
        Number(left.stationID) - Number(right.stationID))[0] || null
    : null;
  return { success: Boolean(offer), stationID: Number(offer && offer.stationID) || stationID, bestAsk: offer };
}

function startJitaRun(cycle, items, sourceStationID = null) {
  const economy = require("./playerBotEconomyRuntime");
  const requestedSource = Number(sourceStationID) || economy.JITA_BUY_STATION_ID;
  const source = isJitaSeedStation(economy, requestedSource)
    ? selectJitaSeedStation(economy, items) || requestedSource
    : requestedSource;
  cycle.jitaRun = {
    items: items.map((item) => ({ ...item })),
    sourceStationID: source,
    phase: "to-source",
    trips: 0,
    checkedJitaStationIDs: [],
  };
  cycle.resumeStage = cycle.stage;
  cycle.stage = "jita-run";
  cycle.status = "active";
  record(cycle, `No sell orders at ${cycle.stationID}; sourcing ${items.map((item) => `${item.units}× ${item.typeID}`).join(", ")} from station ${source}${isJitaSeedStation(economy, source) ? " (Jita seed-market fallback)" : " (regional market)"}.`);
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

function redirectLegacyJitaCycle(cycle, run, economy) {
  if (Number(cycle.stationID) !== Number(economy.JITA_BUY_STATION_ID)) return false;
  const definition = getBlueprintDefinitionByTypeID(cycle.blueprintTypeID);
  const materialTypes = definition?.activities?.manufacturing?.materials || [];
  const needed = [
    { typeID: Number(cycle.blueprintTypeID), kind: "blueprint" },
    ...(run.items || []),
    ...materialTypes.map((material) => ({ typeID: Number(material.typeID), kind: "material" })),
  ];
  const seen = new Set();
  run.items = needed.filter((entry) => {
    const typeID = Number(entry.typeID);
    if (!typeID || seen.has(typeID)) return false;
    seen.add(typeID);
    return true;
  });
  cycle.stationID = hubStationFor(cycle.characterID);
  record(cycle, `Legacy cycle in Jita: moving the blueprint and inputs to hub ${cycle.stationID}.`);
  saveCycle(cycle);
  return true;
}

async function stepJitaRun(cycle, bot) {
  const economy = require("./playerBotEconomyRuntime");
  const operations = require("./playerBotOperationRuntime");
  const inventory = require("./playerBotInventoryRuntime");
  const jita = economy.JITA_BUY_STATION_ID;
  const run = cycle.jitaRun || { items: [], phase: "to-hub" };
  run.sourceStationID = Number(run.sourceStationID) || jita;
  const sourceStationID = run.sourceStationID;
  if (["load", "to-hub"].includes(run.phase)) redirectLegacyJitaCycle(cycle, run, economy);
  if (run.phase === "to-jita") run.phase = "to-source";
  if (run.phase === "to-source") {
    const step = await operations.travelToStation(cycle, bot, sourceStationID, CYCLE_STORE);
    if (step) return step;
    // Later trips only carry what the first one bought.
    run.phase = run.bought ? "load" : "buy";
    saveCycle(cycle);
  }
  if (run.phase === "buy") {
    for (const item of run.items) {
      const atHub = countUnits(cycle.characterID, cycle.stationID, item.typeID);
      const remaining = Math.max(0, Number(item.units) - countUnits(cycle.characterID, sourceStationID, item.typeID) - (item.kind === "blueprint" ? atHub : 0));
      if (remaining <= 0 || (run.unavailable || []).includes(Number(item.typeID))) continue;
      if (isJitaSeedStation(economy, sourceStationID)) {
        const regional = await getTrade().readBestAskOutsideJita(bot.characterName, item.typeID).catch(() => ({ success: false }));
        if (!regional.success) return block(cycle, "holding", `Could not verify non-Jita supply for ${item.typeID}; no Jita purchase was attempted.`);
        if (regional.bestAsk) {
          run.sourceStationID = Number(regional.bestAsk.stationID);
          run.phase = "to-source";
          record(cycle, `Found ${item.typeID} at non-Jita station ${run.sourceStationID}; using it instead of the seed market.`);
          saveCycle(cycle);
          return { delayMs: STEP_DELAY_MS };
        }
      }
      const quote = await getTrade().readQuote(bot.characterName, item.typeID).catch(() => null);
      if (quote && quote.success && !quote.bestAsk) {
        if (isJitaSeedStation(economy, sourceStationID) && !run.bought) {
          const checked = [...new Set([
            ...(run.checkedJitaStationIDs || []).map(Number),
            Number(sourceStationID),
          ].filter(Boolean))];
          const nextSeedStationID = selectJitaSeedStation(economy, run.items, checked);
          if (nextSeedStationID && nextSeedStationID !== Number(sourceStationID)) {
            run.checkedJitaStationIDs = checked;
            run.sourceStationID = nextSeedStationID;
            run.phase = "to-source";
            run.unavailable = (run.unavailable || []).filter((typeID) => Number(typeID) !== Number(item.typeID));
            cycle.jitaUnavailableUntil = 0;
            record(cycle, `Jita station ${sourceStationID} is out of type ${item.typeID}; routing to stocked Jita station ${nextSeedStationID}.`);
            saveCycle(cycle);
            return { delayMs: STEP_DELAY_MS };
          }
          run.checkedJitaStationIDs = checked;
        }
        run.unavailable = [...(run.unavailable || []), Number(item.typeID)];
        cycle.jitaUnavailableUntil = Date.now() + JITA_STOCK_RETRY_MS;
        if (redirectLegacyJitaCycle(cycle, run, economy)) {
          run.phase = "load";
        record(cycle, `Station ${sourceStationID} is out of type ${item.typeID}; moving the blueprint and inputs to the hub to wait for supply.`);
          saveCycle(cycle);
          return { delayMs: STEP_DELAY_MS };
        }
        record(cycle, `Station ${sourceStationID} is out of type ${item.typeID}; returning to the hub to wait for supply.`);
        saveCycle(cycle);
        continue;
      }
      return buyFromBestAsk(cycle, bot, item.typeID, remaining, item.kind, sourceStationID);
    }
    run.phase = "load";
    saveCycle(cycle);
  }
  if (run.phase === "load") {
    let loaded = 0;
    for (const item of run.items) {
      for (const stack of inventory.listHangar(bot, sourceStationID, item.typeID)) {
        const result = inventory.loadToCargo(bot, stack.itemID);
        loaded += Number(result.moved) || 0;
        if (!result.success) break;
      }
    }
    run.trips = (Number(run.trips) || 0) + 1;
    run.bought = true;
    run.phase = "to-hub";
    record(cycle, `Loaded ${loaded} units from ${sourceStationID} (trip ${run.trips}) for ${cycle.stationID}.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  if (run.phase === "to-hub") {
    const step = await operations.travelToStation(cycle, bot, cycle.stationID, CYCLE_STORE);
    if (step) return step;
    inventory.unloadCargo(bot);
    const leftAtSource = run.items.some((item) => inventory.listHangar(bot, sourceStationID, item.typeID).length > 0);
    if (leftAtSource && run.trips < 20) {
      run.phase = "to-source";
      record(cycle, `Remaining stock at ${sourceStationID}; starting another trip.`);
      saveCycle(cycle);
      return { delayMs: STEP_DELAY_MS };
    }
    cycle.stage = cycle.resumeStage || "acquire-materials";
    if ((run.unavailable || []).length) cycle.jitaUnavailableUntil = Date.now() + JITA_STOCK_RETRY_MS;
    cycle.jitaRun = null;
    cycle.lastError = null;
    record(cycle, `Supply from ${sourceStationID} delivered to ${cycle.stationID}.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  cycle.stage = cycle.resumeStage || "acquire-materials";
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

function findUsableBlueprintOfType(cycle, blueprintTypeID) {
  return findUsableBlueprint({ ...cycle, blueprintTypeID });
}

function findUsableBlueprint(cycle) {
  const industry = getIndustry();
  const bot = resolveBotByID(cycle.characterID);
  const session = getSpace().getActorSession(bot);
  const items = listCycleItems(cycle, cycle.stationID, cycle.blueprintTypeID);
  for (const item of items) {
    const blueprint = industry.getBlueprintByItemID(item.itemID, session);
    if (!blueprint || Number(blueprint.ownerID) !== getCycleAssetOwnerID(cycle) || blueprint.jobID) continue;
    if (!blueprint.original && Number(blueprint.runs) < cycle.runs) continue;
    return blueprint;
  }
  return null;
}

// Mineral-only T1 blueprints that the planner prices at the station before
// each cycle. Blueprint prices are capped so no single cycle sinks a fortune.
const PLAN_CANDIDATES = Object.freeze([
  10040, 32783, 17649, 17669, 17657, 17675, 17663, 17671, 1833, 17679,
  17659, 2507, 17655, 17667, 1221, 2511, 17677, 17651,
  32881, 983, 691, // Venture, Badger and Rifter: selected only when economic.
]);
const PLAN_MAX_BLUEPRINT_ISK = 10_000_000;
const PLAN_VARIETY = 4;

function missingSkills(definition, characterID) {
  const map = require("../skills/skillState").getCharacterSkillMap(characterID);
  return (definition.activities.manufacturing.skills || []).some((skill) => {
    const record = map && (map.get ? map.get(Number(skill.typeID)) : map[skill.typeID]);
    return (Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0) < Number(skill.level);
  });
}

function planMaterialInput(material, owned, quote) {
  const required = Number(material && material.quantity) || 0;
  const have = Math.max(0, Number(owned) || 0);
  const ask = quote && quote.success && quote.bestAsk;
  const valuation = Number(ask && ask.price) || Number(quote && quote.success && quote.bestBid && quote.bestBid.price) || 0;
  const offered = Math.max(0, Number(ask && ask.quantity) || 0);
  if (!(required > 0) || !(valuation > 0) || have + offered < required) return null;
  return { perRun: required * valuation, maxRuns: Math.floor((have + offered) / required) };
}

function outputUnitsForCycle(cycle) {
  const definition = getBlueprintDefinitionByTypeID(Number(cycle && cycle.blueprintTypeID));
  const perRun = Number(definition?.activities?.manufacturing?.products?.[0]?.quantity) || 1;
  return Math.max(0, Math.trunc(Number(cycle && cycle.runs) || 0) * perRun);
}

function reservedOrderUnits(orderID, exceptCharacterID = 0) {
  return listCycles().reduce((total, cycle) => {
    if (Number(cycle.characterID) === Number(exceptCharacterID) ||
        Number(cycle.deliverTo?.orderID) !== Number(orderID) ||
        !["active", "holding", "review"].includes(cycle.status)) return total;
    const planned = Math.max(0, Math.trunc(Number(cycle.deliverTo.maxUnits) || outputUnitsForCycle(cycle)));
    const sold = Math.max(0, Math.trunc(Number(cycle.ledger?.unitsSold) || 0));
    return total + Math.max(0, planned - sold);
  }, 0);
}

function eligibleExternalOrders(typeID, units = 1) {
  const economy = require("./playerBotEconomyRuntime");
  const itemType = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(typeID)) || {};
  const isShip = Number(itemType.categoryID) === 6;
  return economy.listPlayerBuyOrders(2000, typeID)
    .filter((order) => {
      const stationID = Number(order.station_id) || 0;
      const station = worldData.getStationByID(stationID);
      const system = station && worldData.getSolarSystemByID(Number(station.solarSystemID));
      return station && system && Number(system.security) >= 0.45 &&
        (!isShip || Boolean(getFacilityPayloadByID(stationID))) &&
        Number(order.vol_remaining) >= Math.max(Number(order.min_volume) || 1, units);
    });
}

async function stepPlan(cycle, bot) {
  const trade = getTrade();
  const prices = new Map();
  const economy = require("./playerBotEconomyRuntime");
  // Buy cost estimates prefer accessible non-Jita stock. Jita is priced only
  // as the seed-market fallback after a complete regional quote finds none.
  const quote = async (typeID) => {
    if (!prices.has(typeID)) {
      let local = { success: false };
      let regional = { success: false };
      let jita = { success: false };
      try {
        local = await trade.readQuote(bot.characterName, typeID);
        if (!local.success || !local.bestAsk) regional = await trade.readBestAskOutsideJita(bot.characterName, typeID);
        if ((!local.success || !local.bestAsk) && regional.success && !regional.bestAsk) {
          jita = await readBestJitaSeedQuote(trade, economy, bot, typeID);
        }
      } catch (error) {
        // Market unavailable; treated as no quote.
      }
      const bestAsk = local.success && local.bestAsk ? local.bestAsk
        : regional.success && regional.bestAsk ? regional.bestAsk
          : jita.success ? jita.bestAsk : null;
      prices.set(typeID, { success: Boolean(bestAsk), bestAsk });
    }
    return prices.get(typeID);
  };
  const options = [];
  const structureTransportCapacity = cycle.structureFacility === true
    ? require("./playerBotInventoryRuntime").getCargoBayCapacity(bot)
    : Infinity;
  for (const blueprintTypeID of PLAN_CANDIDATES) {
    const definition = getBlueprintDefinitionByTypeID(blueprintTypeID);
    const manufacturing = definition && definition.activities && definition.activities.manufacturing;
    if (!manufacturing || missingSkills(definition, cycle.characterID)) continue;
    const productType = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(definition.productTypeID)) || {};
    if (cycle.structureFacility === true && Number(productType.categoryID) === 6) continue;
    const ownsBlueprint = Boolean(findUsableBlueprintOfType(cycle, blueprintTypeID));
    const blueprintQuote = ownsBlueprint ? null : await quote(blueprintTypeID);
    const blueprintCost = ownsBlueprint ? 0 : blueprintQuote && blueprintQuote.success && blueprintQuote.bestAsk ? blueprintQuote.bestAsk.price : null;
    if (blueprintCost === null || blueprintCost > PLAN_MAX_BLUEPRINT_ISK) continue;
    let materialCost = 0;
    let available = true;
    let maxRunsByStock = Infinity;
    for (const material of manufacturing.materials) {
      const materialQuote = await quote(Number(material.typeID));
      const owned = countUnits(cycle.characterID, cycle.stationID, Number(material.typeID), cycle);
      const input = planMaterialInput(material, owned, materialQuote);
      if (!input) { available = false; break; }
      materialCost += input.perRun;
      maxRunsByStock = Math.min(maxRunsByStock, input.maxRuns);
    }
    if (!available) continue;
    const perRun = Number(manufacturing.products?.[0]?.quantity) || 1;
    const outputVolume = Math.max(0, Number(productType.volume) || 0) * perRun;
    const maxRunsByTransport = cycle.structureFacility === true
      ? (outputVolume > 0 ? Math.floor(structureTransportCapacity / outputVolume) : 0)
      : Infinity;
    const productOrders = eligibleExternalOrders(Number(definition.productTypeID), perRun)
      .map((order) => ({
        order,
        availableUnits: Math.max(0, Number(order.vol_remaining) - reservedOrderUnits(order.order_id, cycle.characterID)),
      }))
      .filter(({ order, availableUnits }) => availableUnits >= Math.max(Number(order.min_volume) || 1, perRun))
      .sort((left, right) => Number(right.order.price) - Number(left.order.price) || Number(left.order.order_id) - Number(right.order.order_id));
    const budget = Number(cycle.maxSpend) - blueprintCost;
    const maxRunsByBudget = Math.floor(budget / Math.max(1, materialCost * 1.05));
    const optionCountBefore = options.length;
    if (productOrders.length) {
      for (const { order, availableUnits } of productOrders.slice(0, 8)) {
        const maxRunsByBid = Math.max(0, Math.floor(availableUnits / perRun));
        const runs = Math.min(cycle.runs, maxRunsByBid, maxRunsByStock, maxRunsByBudget, maxRunsByTransport);
        if (runs < 1 || runs * perRun < Math.max(1, Number(order.min_volume) || 1)) continue;
        const grossRevenue = runs * perRun * Number(order.price);
        const netRevenue = grossRevenue * 0.925; // 7.5% default transaction tax, before Accounting skill reductions.
        const profit = netRevenue - runs * materialCost - blueprintCost;
        if (profit <= 0) continue;
        options.push({
          blueprintTypeID,
          definition,
          runs,
          profit,
          perHour: profit / Math.max(60, manufacturing.time * runs) * 3600,
          order,
          maxUnits: Math.min(availableUnits, runs * perRun),
        });
      }
    }
    if (options.length === optionCountBefore) {
      // With no buyer, price against non-Jita sell offers or static base value
      // and post an outside-Jita sell order. This estimate is not revenue: the
      // cycle remains pending until the market authority records a fill.
      let listingReference = Number(require("../inventory/itemTypeRegistry")
        .resolveItemByTypeID(Number(definition.productTypeID))?.basePrice) || 0;
      const outsideAsk = await trade.readBestAskOutsideJita(bot.characterName, Number(definition.productTypeID))
        .catch(() => ({ success: false }));
      if (outsideAsk.success && outsideAsk.bestAsk && Number(outsideAsk.bestAsk.price) > 0) {
        listingReference = Number(outsideAsk.bestAsk.price) * LIST_UNDERCUT;
      }
      if (!(listingReference > 0)) continue;
      const runs = Math.min(cycle.runs, maxRunsByStock, maxRunsByBudget, maxRunsByTransport);
      if (runs < 1) continue;
      const estimatedNetRevenue = runs * perRun * listingReference * 0.925;
      const estimatedProfit = estimatedNetRevenue - runs * materialCost - blueprintCost;
      if (estimatedProfit <= 0) continue;
      options.push({
        blueprintTypeID,
        definition,
        runs,
        profit: estimatedProfit,
        perHour: estimatedProfit / Math.max(60, manufacturing.time * runs) * 3600,
        order: null,
        maxUnits: runs * perRun,
        estimatedListingPrice: listingReference,
      });
    }
  }
  if (!options.length) {
    cycle.noOpportunity = true;
    cycle.planningOutcome = "No safely funded manufacturing plan with a positive market-price estimate was available; no purchase or job was started.";
    return finish(cycle, cycle.planningOutcome);
  }
  options.sort((left, right) => right.perHour - left.perHour);
  // Spread the roster over several good products instead of draining one bid.
  const choice = options[Number(cycle.characterID) % Math.min(PLAN_VARIETY, options.length)];
  cycle.blueprintTypeID = choice.blueprintTypeID;
  cycle.productTypeID = Number(choice.definition.productTypeID);
  cycle.runs = choice.runs;
  cycle.plannedProfit = Math.round(choice.profit * 100) / 100;
  cycle.deliverTo = choice.order ? {
    orderID: Number(choice.order.order_id),
    stationID: Number(choice.order.station_id),
    price: Number(choice.order.price),
    maxUnits: Number(choice.maxUnits),
  } : null;
  if (choice.order && Number(require("../inventory/itemTypeRegistry")
    .resolveItemByTypeID(Number(choice.definition.productTypeID))?.categoryID) === 6) {
    // A packaged ship cannot be hauled as a normal stack; manufacture it
    // directly at the buyer's industry station and keep the delivery local.
    cycle.stationID = Number(choice.order.station_id);
    cycle.solarSystemID = Number(choice.order.solar_system_id) ||
      Number(worldData.getStationByID(cycle.stationID)?.solarSystemID) || cycle.solarSystemID;
    cycle.stage = "travel";
  } else {
    cycle.stage = "acquire-blueprint";
  }
  record(cycle, choice.order
    ? `Plan: ${choice.definition.productName} ×${choice.runs} for external order ${cycle.deliverTo.orderID} at ${cycle.deliverTo.stationID} (${cycle.plannedProfit.toFixed(2)} ISK estimated net; ${options.length} profitable option(s)).`
    : `Plan: ${choice.definition.productName} ×${choice.runs} at an estimated ${Number(choice.estimatedListingPrice).toFixed(2)} ISK per unit; no buyer exists, so the output will be listed outside Jita and revenue will remain pending until filled.`);
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

async function stepAcquireBlueprint(cycle, bot) {
  const blueprint = findUsableBlueprint(cycle);
  if (blueprint) {
    cycle.blueprintItemID = Number(blueprint.itemID);
    cycle.stage = "acquire-materials";
    record(cycle, `Blueprint ${blueprint.itemID} available in the ${cycle.assetOwner === "corporation" ? `corporation hangar division ${cycle.hangarDivision}` : "personal hangar"} (${blueprint.original ? "original" : `copy, ${blueprint.runs} runs`}).`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  if (cycle.assetOwner === "corporation") {
    return block(cycle, "holding", `No usable type ${cycle.blueprintTypeID} blueprint is in corporation hangar division ${cycle.hangarDivision}; the cycle will not spend personal ISK.`);
  }
  return buyFromBestAsk(cycle, bot, cycle.blueprintTypeID, 1, "blueprint");
}

async function stepAcquireMaterials(cycle, bot) {
  if (!cycle.initialMaterialStock) {
    const definition = getBlueprintDefinitionByTypeID(cycle.blueprintTypeID);
    const materials = definition?.activities?.manufacturing?.materials || [];
    cycle.initialMaterialStock = Object.fromEntries(materials.map((material) => [String(material.typeID),
      countUnits(cycle.characterID, cycle.stationID, Number(material.typeID), cycle)]));
    saveCycle(cycle);
  }
  const context = getIndustryPolicy().getManufacturingContext(bot, cycle.blueprintItemID, cycle.runs, {
    assetOwner: cycle.assetOwner,
    hangarDivision: cycle.hangarDivision,
    walletDivision: cycle.walletDivision,
  });
  if (context.success) {
    const inputs = {};
    for (const material of context.quote.materials || []) {
      const quantity = Math.min(Number(material.quantity) || 0, Number(cycle.initialMaterialStock[String(material.typeID)]) || 0);
      if (quantity > 0) inputs[String(material.typeID)] = quantity;
    }
    cycle.ledger.unpricedInputs = inputs;
    cycle.stage = "install";
    record(cycle, `Materials acquired; quote ${Number(context.quote.totalCost).toFixed(2)} ISK.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  const quote = context.quoteResult && context.quoteResult.quote;
  if (!quote || !Array.isArray(quote.materials)) {
    return block(cycle, "blocked", context.message || "The industry authority returned no quote.");
  }
  const available = quote.availableMaterials || {};
  const missingList = quote.materials
    .map((material) => ({
      typeID: Number(material.typeID),
      deficit: Math.max(0, Number(material.quantity) - (Number(available[material.typeID]) || 0)),
    }))
    .filter((material) => material.deficit > 0);
  if (!missingList.length) return block(cycle, "blocked", context.message);
  if (cycle.assetOwner === "corporation") {
    return block(cycle, "holding", `Restock corporation hangar division ${cycle.hangarDivision} with ${missingList.map((material) => `${material.deficit}× ${material.typeID}`).join(", ")}; this cycle will not buy corporate inputs with personal funds.`);
  }
  // Buy locally first; otherwise select a non-Jita regional source before the seed market.
  for (const material of missingList) {
    const local = await getTrade().readQuote(bot.characterName, material.typeID).catch(() => ({ success: false }));
    if (local.success && local.bestAsk) return buyFromBestAsk(cycle, bot, material.typeID, material.deficit, "material");
    if (Number(cycle.jitaUnavailableUntil || 0) > Date.now()) {
      return block(cycle, "holding", `No stock locally or in the seed market; waiting at ${cycle.stationID} for type ${material.typeID}.`);
    }
    const supply = await getTrade().readBestAskOutsideJita(bot.characterName, material.typeID).catch(() => ({ success: false }));
    if (!supply.success) return block(cycle, "holding", `Could not verify non-Jita supply for ${material.typeID}; the purchase is paused safely.`);
    return startJitaRun(cycle, [{ typeID: material.typeID, units: material.deficit, kind: "material" }],
      supply.bestAsk ? Number(supply.bestAsk.stationID) : require("./playerBotEconomyRuntime").JITA_BUY_STATION_ID);
  }
  return block(cycle, "holding", `No market source is currently available for ${missingList.map((item) => item.typeID).join(", ")}.`);
}

async function stepInstall(cycle, bot) {
  const industry = getIndustry();
  const ownerID = getCycleAssetOwnerID(cycle);
  const existingJob = industry.listJobsByOwner(ownerID, false).find((job) =>
    Number(job.blueprintID) === Number(cycle.blueprintItemID) &&
    (cycle.assetOwner !== "corporation" ||
      (cycle.pending && cycle.pending.action === "install" && Number(job.installerID) === Number(cycle.characterID))));
  if (existingJob) {
    if (cycle.pending && cycle.pending.action === "install") {
      cycle.ledger.industryFees = roundIsk(cycle.ledger.industryFees +
        Math.max(0, Number(cycle.pending.baselineBalance) - getCycleBalance(cycle)));
    }
    cycle.pending = null;
    cycle.jobID = Number(existingJob.jobID);
    cycle.stage = "manufacturing";
    record(cycle, `Recovered job ${existingJob.jobID} after restart.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  const context = getIndustryPolicy().getManufacturingContext(bot, cycle.blueprintItemID, cycle.runs, {
    assetOwner: cycle.assetOwner,
    hangarDivision: cycle.hangarDivision,
    walletDivision: cycle.walletDivision,
  });
  if (!context.success) {
    cycle.stage = "acquire-materials";
    cycle.pending = null;
    record(cycle, `The quote changed before installation: ${context.message}`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  const totalCost = Number(context.quote.totalCost) || 0;
  const budget = remainingBudget(cycle);
  if (totalCost > budget) {
    return block(cycle, "holding", `Installation costs ${totalCost.toFixed(2)} ISK, above the remaining budget of ${budget.toFixed(2)} ISK.`);
  }
  const balance = getCycleBalance(cycle);
  cycle.pending = { action: "install", quotedCost: totalCost, baselineBalance: balance, startedAt: new Date().toISOString() };
  saveCycle(cycle);
  let jobID = 0;
  try {
    const installed = await industry.installManufacturingJob(context.session, context.request);
    jobID = Number(installed && installed.data && installed.data.jobID) || 0;
  } catch (error) {
    cycle.pending = null;
    return block(cycle, "holding", `The industry authority rejected the installation: ${getSpace().describeError(error)}.`);
  }
  const job = jobID ? industry.getJobByID(jobID) : null;
  if (!job || Number(job.ownerID) !== ownerID) {
    return block(cycle, "review", "The installation returned no verifiable job; check the bot's industry jobs.");
  }
  cycle.ledger.industryFees = roundIsk(cycle.ledger.industryFees + Math.max(0, balance - getCycleBalance(cycle)));
  cycle.pending = null;
  cycle.jobID = jobID;
  cycle.stage = "manufacturing";
  cycle.lastError = null;
  record(cycle, `Installed job ${jobID}: ${job.runs} run(s), cost ${cycle.ledger.industryFees.toFixed(2)} ISK, completes ${job.endDate}.`);
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

function stepManufacturing(cycle) {
  const job = getIndustry().getJobByID(cycle.jobID);
  if (!job || Number(job.ownerID) !== getCycleAssetOwnerID(cycle)) {
    return block(cycle, "review", `Job ${cycle.jobID} no longer exists for this bot.`);
  }
  const status = Number(job.status);
  if (status === INDUSTRY_STATUS.READY || status >= INDUSTRY_STATUS.COMPLETED && status !== INDUSTRY_STATUS.CANCELLED) {
    cycle.stage = "deliver";
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  if (status === INDUSTRY_STATUS.CANCELLED || status === INDUSTRY_STATUS.REVERTED) {
    return block(cycle, "blocked", `Job ${cycle.jobID} was canceled or rolled back.`);
  }
  return { delayMs: 30_000 };
}

function stepDeliver(cycle, bot) {
  const industry = getIndustry();
  let job = industry.getJobByID(cycle.jobID);
  if (job && Number(job.ownerID) !== getCycleAssetOwnerID(cycle)) {
    return block(cycle, "review", `Job ${cycle.jobID} belongs to another asset owner.`);
  }
  if (job && Number(job.status) === INDUSTRY_STATUS.READY) {
    cycle.pending = { action: "deliver", jobID: cycle.jobID, startedAt: new Date().toISOString() };
    saveCycle(cycle);
    try {
      industry.deliverIndustryJob(getSpace().getActorSession(bot), cycle.jobID);
    } catch (error) {
      cycle.pending = null;
      return block(cycle, "holding", `Delivery of job ${cycle.jobID} was rejected: ${getSpace().describeError(error)}.`);
    }
    job = industry.getJobByID(cycle.jobID);
  }
  if (!job || Number(job.status) < INDUSTRY_STATUS.COMPLETED) {
    return block(cycle, "holding", `Job ${cycle.jobID} is not marked as delivered yet.`);
  }
  const definition = getBlueprintDefinitionByTypeID(cycle.blueprintTypeID);
  const perRun = Number(definition.activities.manufacturing.products?.[0]?.quantity) || 1;
  cycle.pending = null;
  cycle.ledger.unitsProduced = Number(job.runs) * perRun;
  cycle.stage = "sell";
  record(cycle, `Job ${cycle.jobID} delivered: ${cycle.ledger.unitsProduced} ${definition.productName} to the ${cycle.assetOwner === "corporation" ? `corporation hangar division ${cycle.hangarDivision}` : "personal hangar"}.`);
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

function prepareSettlement(cycle) {
  cycle.ledger.netResult = roundIsk(cycle.ledger.proceeds - totalSpend(cycle) - (Number(cycle.ledger.estimatedInputValue) || 0));
  cycle.ledger.unsoldUnits = countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle);
  cycle.ledger.resultPending = Number(cycle.ledger.unitsListed || 0) > 0 || cycle.ledger.unsoldUnits > 0 ||
    Object.values(cycle.ledger.unpricedInputs || {}).some((quantity) => Number(quantity) > 0);
}

function finish(cycle, message) {
  prepareSettlement(cycle);
  if (Number(cycle.ledger.unitsListed) > 0 || Number(cycle.ledger.unitsSold) > 0) {
    // A successful sale/listing supersedes any rejection from an earlier
    // retry. Keep the final no-buyer reason on cycles that close unsold.
    cycle.lastError = null;
  }
  cycle.status = "completed";
  cycle.stage = "done";
  cycle.completedAt = new Date().toISOString();
  cycle.endingBalance = roundIsk(getCycleBalance(cycle));
  record(cycle, message);
  saveCycle(cycle);
  return { done: true };
}

async function finishWithCorpShare(cycle, bot, message) {
  prepareSettlement(cycle);
  cycle.stage = "corp-share";
  cycle.status = "active";
  cycle.finalMessage = message;
  saveCycle(cycle);
  return settleCorpShare(cycle, bot);
}

async function settleCorpShare(cycle, bot) {
  if (cycle.assetOwner === "corporation") {
    cycle.ledger.corpShare = 0;
    cycle.ledger.corpShareSettled = true;
    saveCycle(cycle);
    return finish(cycle, `${cycle.finalMessage || `Industry cycle ${cycle.cycleID} completed.`} Corporation-owned proceeds remain in wallet division ${cycle.walletDivision}; no self-transfer was made.`);
  }
  try {
    const paid = await require("./playerBotCorpEconomyRuntime").payCorpShare(
      bot,
      cycle.ledger.resultPending ? 0 : Number(cycle.ledger.netResult) || 0,
      `industry cycle ${cycle.cycleID}`,
      `industry:${cycle.cycleID}`,
    );
    cycle.ledger.corpShare = paid;
    cycle.ledger.corpShareSettled = true;
    if (paid > 0) {
      record(cycle, `Contributed ${paid.toFixed(2)} ISK of realized profit to corporation ${cycle.corporationID}.`);
    }
    saveCycle(cycle);
  } catch (error) {
    return block(cycle, "holding", `Could not settle the corporation share: ${String(error && error.message || error).slice(0, 160)}`);
  }
  return finish(cycle, cycle.finalMessage || `Industry cycle ${cycle.cycleID} completed.`);
}

function getSellFloor(cycle) {
  if (cycle.minUnitPrice) return cycle.minUnitPrice;
  const produced = Number(cycle.ledger.unitsProduced) || 1;
  return Math.max(0.01, Math.ceil((totalSpend(cycle) + (Number(cycle.ledger.estimatedInputValue) || 0)) / produced * 100) / 100);
}

// Built for a player's buy order: carry the product there and sell into it.
async function stepDeliverOrder(cycle, bot) {
  const operations = require("./playerBotOperationRuntime");
  const inventory = require("./playerBotInventoryRuntime");
  const economy = require("./playerBotEconomyRuntime");
  const target = cycle.deliverTo;
  let order = target && economy.getPlayerBuyOrder(target.orderID);
  if (!order || Number(order.type_id) !== Number(cycle.productTypeID) ||
      Number(order.station_id) !== Number(target.stationID)) {
    cycle.deliverTo = null;
    cycle.deliverPhase = null;
    cycle.saleRouteAttempted = false;
    cycle.stage = "sell";
    record(cycle, `Player buy order ${target && target.orderID || "unknown"} is no longer open; listing output at a non-Jita market instead.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  const itemType = require("../inventory/itemTypeRegistry").resolveItemByTypeID(cycle.productTypeID) || {};
  const isShip = Number(itemType.categoryID) === 6;
  if (isShip && Number(cycle.stationID) !== Number(target.stationID)) {
    return block(cycle, "blocked", "Ship orders must be manufactured at the buyer's station because packaged hulls cannot be loaded into cargo.");
  }
  if (cycle.deliverPhase !== "to-order" && !isShip) {
    for (const stack of inventory.listHangar(bot, cycle.stationID, cycle.productTypeID)) {
      const result = inventory.loadToCargo(bot, stack.itemID);
      if (!result.success) break;
    }
  }
  cycle.deliverPhase = "to-order";
  saveCycle(cycle);
  const step = await operations.travelToStation(cycle, bot, target.stationID, CYCLE_STORE);
  if (step) return step;
  if (!isShip) inventory.unloadCargo(bot);
  order = economy.getPlayerBuyOrder(target.orderID);
  if (!order || Number(order.type_id) !== Number(cycle.productTypeID) ||
      Number(order.station_id) !== Number(target.stationID)) {
    cycle.deliverTo = null;
    cycle.deliverPhase = null;
    cycle.stationID = Number(target.stationID);
    cycle.solarSystemID = Number(worldData.getStationByID(target.stationID)?.solarSystemID) || cycle.solarSystemID;
    cycle.saleRouteAttempted = false;
    cycle.stage = "sell";
    record(cycle, `Player buy order ${target.orderID} closed during transit; remaining goods will be listed outside Jita.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  let sold = 0;
  let credited = 0;
  const alreadySoldForOrder = Math.max(0, Number(cycle.ledger.unitsSold) || 0);
  const maxUnits = Math.max(0, Number(target.maxUnits) || outputUnitsForCycle(cycle));
  let remainingForOrder = Math.min(
    Math.max(0, maxUnits - alreadySoldForOrder),
    Math.max(0, Number(order.vol_remaining) || 0),
  );
  for (const stack of inventory.listHangar(bot, target.stationID, cycle.productTypeID)) {
    if (remainingForOrder <= 0) break;
    const quantity = Math.min(inventory.unitsOf(stack), remainingForOrder);
    const result = await getTrade().sell(
      bot.characterName,
      stack.itemID,
      quantity,
      Math.max(0.01, Number(order.price) * 0.999),
      { targetOrderID: Number(target.orderID), allowShip: isShip },
    );
    if (!result.success) {
      cycle.lastError = result.message;
      break;
    }
    const stackSold = Number(result.sold) || 0;
    sold += stackSold;
    remainingForOrder -= stackSold;
    credited += Number(result.credited) || 0;
  }
  cycle.ledger.unitsSold += sold;
  cycle.ledger.proceeds = roundIsk(cycle.ledger.proceeds + credited);
  cycle.stationID = Number(target.stationID);
  cycle.soldOrderID = Number(target.orderID);
  cycle.deliverTo = null;
  cycle.deliverPhase = null;
  if (countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle) > 0) {
    cycle.stage = "sell";
    cycle.saleRouteAttempted = false;
    record(cycle, `Order ${target.orderID} received ${sold} units; extra output remains for a separate non-Jita listing.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  return finishWithCorpShare(cycle, bot, `Order ${target.orderID}: manufactured and delivered ${sold} units at ${target.stationID} for ${roundIsk(credited).toFixed(2)} ISK.`);
}

async function advanceRegionalSaleRoute(cycle, bot) {
  const route = cycle.saleRoute || {};
  const destinationStationID = normalizePositiveInteger(route.destinationStationID);
  if (!destinationStationID || require("./playerBotEconomyRuntime").isJitaStation(destinationStationID)) {
    return block(cycle, "blocked", "Regional sale route has no valid non-Jita destination.");
  }
  const inventory = require("./playerBotInventoryRuntime");
  if (route.phase !== "travel") {
    let loaded = 0;
    for (const stack of inventory.listHangar(bot, Number(route.sourceStationID), cycle.productTypeID)) {
      const result = inventory.loadToCargo(bot, stack.itemID);
      loaded += Number(result.moved) || 0;
      if (!result.success) break;
    }
    const cargoHasProduct = inventory.listCargo(bot).some((item) =>
      Number(item.typeID) === Number(cycle.productTypeID));
    if (!loaded && !cargoHasProduct) {
      return block(cycle, "holding", "No manufactured stock could be loaded for the selected regional buyer.");
    }
    cycle.saleRoute.phase = "travel";
    record(cycle, `Loaded ${loaded} units for regional buyer station ${destinationStationID}.`);
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  const operations = require("./playerBotOperationRuntime");
  const step = await operations.travelToStation(cycle, bot, destinationStationID, CYCLE_STORE);
  if (step) return step;
  inventory.unloadCargo(bot);
  cycle.stationID = destinationStationID;
  cycle.saleRoute = null;
  record(cycle, `Arrived at regional buyer station ${destinationStationID}; unloading manufactured goods.`);
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

async function stepSell(cycle, bot) {
  if (cycle.deliverTo && Number(cycle.deliverTo.stationID)) return stepDeliverOrder(cycle, bot);
  const economy = require("./playerBotEconomyRuntime");
  if (cycle.pending && cycle.pending.action === "list" && !reconcilePendingListing(cycle)) {
    const recovery = confirmPendingListingNoEffect(cycle);
    if (recovery.ambiguous) {
      return block(cycle, "review", "Unreconciled sell listing changed or cannot prove an unchanged order, inventory, transaction, and wallet state. No retry was issued; operator review is required.");
    }
    if (!recovery.retry) return { delayMs: recovery.delayMs, awaitingListingReconciliation: true };
  }
  if (economy.isJitaStation(cycle.stationID)) {
    // Built in Jita before the hub existed: bots never sell there, so the
    // product moves to the hub and is sold from there.
    const operations = require("./playerBotOperationRuntime");
    const inventory = require("./playerBotInventoryRuntime");
    if (cycle.relocatePhase !== "to-hub") {
      for (const stack of inventory.listHangar(bot, cycle.stationID, cycle.productTypeID)) {
        const result = inventory.loadToCargo(bot, stack.itemID);
        if (!result.success) break;
      }
      cycle.relocatePhase = "to-hub";
      saveCycle(cycle);
    }
    const hubStationID = hubStationFor(bot);
    const step = await operations.travelToStation(cycle, bot, hubStationID, CYCLE_STORE);
    if (step) return step;
    inventory.unloadCargo(bot);
    record(cycle, `Moved the product from Jita to hub ${hubStationID} for sale.`);
    cycle.stationID = hubStationID;
    cycle.relocatePhase = null;
    saveCycle(cycle);
    return { delayMs: STEP_DELAY_MS };
  }
  if (cycle.relistOnly === true) {
    const travel = await require("./playerBotOperationRuntime")
      .travelToStation(cycle, bot, cycle.stationID, CYCLE_STORE);
    if (travel) return travel;
  }
  if (cycle.pending && cycle.pending.action === "sell") {
    const units = countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle);
    cycle.ledger.unitsSold += Math.max(0, Number(cycle.pending.baselineUnits) - units);
    cycle.ledger.proceeds = roundIsk(cycle.ledger.proceeds + Math.max(0, getCycleBalance(cycle) - Number(cycle.pending.baselineBalance)));
    cycle.pending = null;
    record(cycle, "Pending sale reconciled against the hangar and wallet after restart.");
    saveCycle(cycle);
  }
  const stacks = listCycleItems(cycle, cycle.stationID, cycle.productTypeID);
  if (!stacks.length) {
    return finishWithCorpShare(cycle, bot, `Cycle complete: sold ${cycle.ledger.unitsSold} units for ${cycle.ledger.proceeds.toFixed(2)} ISK net; spent ${totalSpend(cycle).toFixed(2)} ISK.`);
  }
  const productType = require("../inventory/itemTypeRegistry").resolveItemByTypeID(cycle.productTypeID);
  if (Object.keys(cycle.ledger.unpricedInputs || {}).length && cycle.ledger.estimatedInputValue === undefined && !cycle.minUnitPrice) {
    let estimated = 0;
    for (const [typeID, quantity] of Object.entries(cycle.ledger.unpricedInputs)) {
      const local = await getTrade().readQuote(bot.characterName, Number(typeID)).catch(() => ({ success: false }));
      const regional = await getTrade().readRegionalMarketQuote(bot.characterName, Number(typeID)).catch(() => ({ success: false }));
      const price = Number(local.success && local.bestAsk?.price) || Number(regional.success && regional.bestAsk?.price) ||
        Number(local.success && local.bestBid?.price) || Number(regional.success && regional.bestBid?.price) || 0;
      if (!(price > 0)) return block(cycle, "holding", `No reference price is available to value existing material ${typeID}.`);
      estimated += Number(quantity) * price;
    }
    cycle.ledger.estimatedInputValue = roundIsk(estimated);
    record(cycle, `Existing materials valued at market prices: ${cycle.ledger.estimatedInputValue.toFixed(2)} ISK (estimate, not cycle spend).`);
    saveCycle(cycle);
  }
  const floor = getSellFloor(cycle);
  const operations = require("./playerBotOperationRuntime");
  if (cycle.saleRoute) return advanceRegionalSaleRoute(cycle, bot);
  if (cycle.assetOwner !== "corporation" && cycle.saleRouteAttempted !== true) {
    const destination = await operations.findBestRegionalSaleStation(bot, cycle.stationID, {
      typeID: cycle.productTypeID,
      minimumUnitPrice: floor,
    }).catch(() => null);
    cycle.saleRouteAttempted = true;
    const economy = require("./playerBotEconomyRuntime");
    const hubStationID = hubStationFor(bot);
    const fallbackStationID = cycle.structureFacility === true &&
      Number(cycle.stationID) === Number(cycle.industryFacilityID) &&
      !economy.isJitaStation(hubStationID) &&
      worldData.getStationByID(hubStationID)
      ? Number(hubStationID)
      : 0;
    const destinationStationID = Number(destination && destination.stationID) || fallbackStationID;
    if (destinationStationID && destinationStationID !== Number(cycle.stationID)) {
      cycle.saleRoute = {
        sourceStationID: Number(cycle.stationID),
        destinationStationID,
        expectedProceeds: Number(destination && destination.expectedProceeds) || 0,
        phase: "load",
      };
      record(cycle, destination
        ? `Regional buyer selected at ${destinationStationID} (${destination.expectedProceeds.toFixed(2)} ISK estimated); routing manufactured goods there.`
        : `The structure has no market service; routing manufactured goods to non-Jita market station ${destinationStationID} for sale or long-duration listing.`);
      saveCycle(cycle);
      return { delayMs: STEP_DELAY_MS };
    }
    saveCycle(cycle);
  }
  let quote;
  try {
    quote = await getTrade().readQuote(bot.characterName, cycle.productTypeID);
  } catch (error) {
    quote = { success: false, message: String(error && error.message || error).slice(0, 160) };
  }
  const bid = quote.success ? quote.bestBid : null;
  if (!bid || bid.price + 0.0001 < floor) {
    cycle.sellAttempts = (Number(cycle.sellAttempts) || 0) + 1;
    const reason = !quote.success
      ? `Local market unavailable: ${quote.message}`
      : bid
        ? `Best local buy order (${bid.price.toFixed(2)} ISK x ${bid.quantity}) is below the ${floor.toFixed(2)} ISK price floor.`
        : `No local buy orders for type ${cycle.productTypeID} at station ${cycle.stationID}.`;
    cycle.ledger.saleReason = reason;
    // No buyer here: list it at the hub so the market can form; never in Jita.
    const localAsk = quote.success ? quote.bestAsk : null;
    let reference = localAsk ? localAsk.price * LIST_UNDERCUT : 0;
    if (!reference) {
      const regional = await getTrade().readRegionalMarketQuote(bot.characterName, cycle.productTypeID).catch(() => ({ success: false }));
      reference = regional.success && regional.bestAsk
        ? regional.bestAsk.price * LIST_UNDERCUT
          : (Number(productType && productType.basePrice) || floor) * 1.1;
    }
    const listPrice = roundIsk(Math.max(floor, reference));
    let listed = 0;
    let soldDuringListing = 0;
    let proceedsDuringListing = 0;
    let listingFailure = "";
    for (const stack of stacks) {
      const ownerID = getCycleAssetOwnerID(cycle);
      const baselineUnits = countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle);
      const baselineBalance = getCycleBalance(cycle);
      const beforeOrders = economy.listOpenSellOrders(ownerID, cycle.stationID, cycle.productTypeID);
      if (!beforeOrders.success) return block(cycle, "holding", `Could not read orders to reconcile the sale: ${beforeOrders.error}.`);
      const baselineOrderIDs = beforeOrders.orders.map((order) => Number(order.order_id));
      const baselineTransactions = getCycleMarketTransactions(cycle);
      const baselineTransactionID = baselineTransactions.reduce((highest, entry) =>
        Math.max(highest, Number(entry.transactionID) || 0), 0);
      const baselineJournal = getCycleWalletJournal(cycle);
      const baselineWalletJournalID = baselineJournal.reduce((highest, entry) =>
        Math.max(highest, Number(entry.transactionID) || 0), 0);
      cycle.pending = { action: "list", itemID: Number(stack.itemID), baselineUnits, baselineBalance,
        baselineOrderIDs,
        baselineOrders: normalizeListingOrderSnapshot(beforeOrders.orders),
        baselineTransactionID, baselineWalletJournalID,
        price: listPrice, startedAt: new Date().toISOString() };
      saveCycle(cycle);
      const result = await getTrade().listSellOrder(bot.characterName, stack.itemID, null, listPrice, 90, getCycleTradeOptions(cycle));
      const removed = Math.max(0, baselineUnits - countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle));
      const balanceAfter = getCycleBalance(cycle);
      if (!result.success && (removed || Math.abs(baselineBalance - balanceAfter) >= 0.01)) {
        return block(cycle, "review", "The listing changed the hangar or wallet without a clear result; check orders and transactions.");
      }
      if (!result.success) {
        cycle.pending = null;
        cycle.lastError = result.message;
        listingFailure = String(result.message || "Market authority rejected the sell listing.").slice(0, 180);
        saveCycle(cycle);
        continue;
      }
      const soldNow = Math.max(0, Number(result.sold) || 0);
      const listedNow = Math.max(0, Number(result.listed) || 0);
      if (removed !== soldNow + listedNow || (!removed && Math.abs(baselineBalance - balanceAfter) >= 0.01)) return block(cycle, "review", "The listing does not match the hangar, wallet, and market transactions; check the orders before continuing.");
      if (listedNow > 0) {
        const afterOrders = economy.listOpenSellOrders(ownerID, cycle.stationID, cycle.productTypeID);
        const known = new Set(baselineOrderIDs);
        const created = afterOrders.success ? afterOrders.orders.filter((order) => !known.has(Number(order.order_id))) : [];
        if (created.length !== 1 || Number(created[0].vol_remaining) !== listedNow ||
            Number(result.orderID) !== Number(created[0].order_id) || Math.abs(Number(created[0].price) - listPrice) >= 0.01) {
          return block(cycle, "review", "The listed order does not match the stock removed; check orders and transactions.");
        }
        cycle.ledger.saleOrders = [...(cycle.ledger.saleOrders || []), { orderID: Number(created[0].order_id), units: listedNow, price: listPrice }];
        rememberCorporateListing(cycle, created[0]);
      }
      listed += listedNow;
      soldDuringListing += soldNow;
      proceedsDuringListing += Number(result.credited) || 0;
      cycle.ledger.unitsListed = (Number(cycle.ledger.unitsListed) || 0) + listedNow;
      cycle.ledger.unitsSold = (Number(cycle.ledger.unitsSold) || 0) + soldNow;
      cycle.ledger.proceeds = roundIsk((Number(cycle.ledger.proceeds) || 0) + (Number(result.credited) || 0));
      cycle.ledger.brokerFees = roundIsk((Number(cycle.ledger.brokerFees) || 0) + Math.max(0, Number(result.fees) || 0));
      if (Number(result.jitaFillUnits) > 0) {
        cycle.ledger.jitaPolicyViolationUnits = (Number(cycle.ledger.jitaPolicyViolationUnits) || 0) + Number(result.jitaFillUnits);
        cycle.ledger.saleReason = `Legacy listing matched ${Number(result.jitaFillUnits)} unit(s) to a Jita-located buyer. The fill is recorded once; the market authority now excludes Jita for playerbot sellers.`;
        record(cycle, `Recorded ${Number(result.jitaFillUnits)} legacy Jita fill(s) from the market transaction ledger; no item will be relisted.`);
      }
      cycle.pending = null;
      saveCycle(cycle);
    }
    if (listed > 0 || soldDuringListing > 0) {
      return finishWithCorpShare(cycle, bot, `Cycle complete: sold ${soldDuringListing} units for ${roundIsk(proceedsDuringListing).toFixed(2)} ISK and listed ${listed} at ${listPrice.toFixed(2)} ISK for ${require("./playerBotTradeRuntime").MAX_PLAYERBOT_SELL_ORDER_DAYS} days at ${cycle.stationID}. Listing is free; unsold revenue remains pending. ${reason}`);
    }
    if (cycle.sellAttempts >= MAX_SELL_ATTEMPTS) {
      cycle.lastError = reason;
      return finishWithCorpShare(cycle, bot, `Cycle closed with unsold output after ${cycle.sellAttempts} attempts: ${reason} The product remains in the personal hangar.`);
    }
    const listingDetail = listingFailure ? ` Market listing rejected: ${listingFailure}.` : "";
    return block(cycle, "holding", `${reason}${listingDetail} Reintento ${cycle.sellAttempts}/${MAX_SELL_ATTEMPTS}.`);
  }
  const stack = stacks[0];
  const stackUnits = Number(stack.singleton) > 0 ? 1 : Math.max(1, Math.trunc(Number(stack.stacksize ?? stack.quantity) || 1));
  const quantity = Math.min(stackUnits, bid.quantity);
  cycle.pending = {
    action: "sell",
    itemID: Number(stack.itemID),
    quantity,
    floor,
    baselineUnits: countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle),
    baselineBalance: getCycleBalance(cycle),
    startedAt: new Date().toISOString(),
  };
  cycle.status = "active";
  saveCycle(cycle);
  const result = await getTrade().sell(bot.characterName, stack.itemID, quantity, floor, getCycleTradeOptions(cycle));
  const units = countUnits(cycle.characterID, cycle.stationID, cycle.productTypeID, cycle);
  const sold = Math.max(0, cycle.pending.baselineUnits - units);
  const credited = roundIsk(Math.max(0, getCycleBalance(cycle) - cycle.pending.baselineBalance));
  cycle.pending = null;
  cycle.ledger.unitsSold += sold;
  cycle.ledger.proceeds = roundIsk(cycle.ledger.proceeds + credited);
  if (!result.success) {
    cycle.ledger.saleReason = result.message;
    return block(cycle, "holding", result.message);
  }
  cycle.ledger.saleReason = null;
  record(cycle, sold
    ? `Sold ${sold} units at ${bid.price.toFixed(2)} ISK (floor ${floor.toFixed(2)}); credited ${credited.toFixed(2)} ISK net.`
    : result.message);
  saveCycle(cycle);
  return { delayMs: STEP_DELAY_MS };
}

const STAGES = {
  travel: stepTravel,
  plan: stepPlan,
  "jita-run": stepJitaRun,
  "acquire-blueprint": stepAcquireBlueprint,
  "acquire-materials": stepAcquireMaterials,
  install: stepInstall,
  manufacturing: stepManufacturing,
  deliver: stepDeliver,
  sell: stepSell,
  "corp-share": settleCorpShare,
};

async function advanceCycle(characterID) {
  if (require("./playerBotLocalDefenseAdapter").hasLease(characterID)) return { delayMs: 1000, busy: true };
  const id = normalizePositiveInteger(characterID);
  const interruptions = require("./playerBotInterruptRuntime");
  if (runningBots.has(id) || interruptions.isBusy(id)) return { delayMs: 1000, busy: true };
  const operations = require("./playerBotOperationRuntime");
  operations.drainInterruptions(id);
  if (interruptions.hasPending(id)) return { delayMs: 1000, interrupted: true };
  if (operations.hasActiveOperation(id)) return { delayMs: 1000, interrupted: true };
  const cycle = getCycle(id);
  const recoverableListingReview = cycle && cycle.status === "review" &&
    cycle.pending && cycle.pending.action === "list" &&
    cycle.pending.listingAutoRecoveryBlocked !== true &&
    Array.isArray(cycle.pending.baselineOrderIDs);
  if (!cycle || (!ACTIVE_STATUSES.has(cycle.status) && !recoverableListingReview)) return { done: true };
  const bot = resolveBotByID(id);
  if (!bot) return block(cycle, "blocked", "The bot is no longer in the roster.");
  if (bot.status === "paused" || bot.autonomyPaused === true) return { delayMs: WAIT_DELAY_MS };
  if (cycle.pending && cycle.pending.action === "supply-contract") {
    return block(cycle, "review", "Supply contract pending after restart; check the contract, inventory, and wallet.");
  }
  if (cycle.pending && cycle.pending.action === "buy") {
    const observed = settlePendingPurchase(cycle);
    if (!observed.bought && !observed.spent) {
      cycle.pending = null;
      return block(cycle, "review", "An unconfirmed purchase was found after restart with no observed changes; it will not be repeated automatically. Review it before using /playerbots industry cycle resume.");
    }
    applyPurchase(cycle, cycle.pending.typeID, observed.bought, observed.spent, cycle.pending.kind);
    markJitaRunPurchase(cycle, cycle.pending.stationID, observed.bought);
    cycle.pending = null;
    if (!observed.transactionReconciled) {
      return block(cycle, "review", `Purchase recovery observed ${observed.bought} units for ${observed.spent.toFixed(2)} ISK, but the market transaction ledger does not exactly match the wallet and hangar. It will not be retried automatically.`);
    }
    record(cycle, `Purchase reconciled after restart: ${observed.bought} units for ${observed.spent.toFixed(2)} ISK.`);
    saveCycle(cycle);
  }
  const handler = STAGES[cycle.stage];
  if (!handler) return block(cycle, "blocked", `Unknown industry stage ${cycle.stage}.`);
  if (cycle.status === "holding") cycle.status = "active";
  const owner = interruptions.acquire(id, "industry", cycle.cycleID);
  if (!owner) return { delayMs: 1000, busy: true };
  runningBots.add(id);
  let result;
  let interrupted = false;
  let handlerFailed = false;
  let capacityReason = "";
  try {
    result = await handler(cycle, bot);
    if (result && result.capacityQueued) capacityReason = String(result.capacityReason || "System actor capacity reached.");
  } catch (error) {
    if (error && error.code === "PLAYERBOT_SYSTEM_CAPACITY") {
      capacityReason = String(error.message || "System actor capacity reached.");
    } else {
      const latest = getCycle(id) || cycle;
      handlerFailed = true;
      result = block(latest, "holding", `Error during ${latest.stage}: ${String(error && error.message || error).slice(0, 200)}`);
    }
  } finally {
    runningBots.delete(id);
    interruptions.release(owner);
    interrupted = operations.drainInterruptions(id);
  }
  if (interrupted) return { delayMs: 1000, interrupted: true };
  if (handlerFailed) return result;
  if (capacityReason) {
    const queued = pauseForCapacity(id, capacityReason);
    return queued.success
      ? { done: true, capacityQueued: true }
      : { delayMs: WAIT_DELAY_MS, capacityQueued: true };
  }
  return result || { delayMs: STEP_DELAY_MS };
}

function describeCycleStage(stage) {
  const labels = {
    "jita-run": "travelling to or buying missing materials in Jita",
    "acquire-materials": "acquiring the blueprint and materials",
    install: "installing the manufacturing job",
    manufacturing: "manufacturing the product",
    sell: "selling or listing the finished product",
    done: "industry cycle completed",
  };
  return labels[stage] || `working on stage ${stage || "unknown"}`;
}

function formatCycle(cycle, includeHistory = false) {
  if (!cycle) return "";
  const definition = getBlueprintDefinitionByTypeID(cycle.blueprintTypeID);
  const ledger = cycle.ledger || {};
  const hasCompletedSale = cycle.status === "completed" &&
    (Number(ledger.unitsListed) > 0 || Number(ledger.unitsSold) > 0);
  const visibleError = hasCompletedSale ? null : cycle.lastError;
  const bot = resolveBotByID(cycle.characterID);
  const location = bot ? getSpace().getBotLocation(bot) : "unknown";
  const rows = [
    `${cycle.characterName} — cycle ${cycle.cycleID} — ${cycle.status}/${cycle.stage} — corp ${cycle.corporationID}, assets ${cycle.assetOwner === "personal" ? "pilot-owned (not corp treasury)" : cycle.assetOwner}.`,
    `Product ${definition ? definition.productName : cycle.productTypeID || "none selected"} ×${cycle.runs} at ${cycle.stationID}; location ${location}; ${cycle.assetOwner === "corporation" ? `corporation wallet ${cycle.walletDivision}` : "personal wallet"} balance ${getCycleBalance(cycle).toFixed(2)} ISK (start ${Number(cycle.startingBalance).toFixed(2)}).`,
    `Blueprint ${cycle.blueprintItemID || "pending"}; job ${cycle.jobID || "pending"}; spend ${totalSpend(cycle).toFixed(2)}/${Number(cycle.maxSpend).toFixed(2)} ISK (blueprint ${Number(ledger.blueprintSpend).toFixed(2)}, materials ${Number(ledger.materialSpend).toFixed(2)}, industry ${Number(ledger.industryFees).toFixed(2)}, broker fees ${Number(ledger.brokerFees || 0).toFixed(2)}).`,
    `Produced ${ledger.unitsProduced || 0}; sold ${ledger.unitsSold || 0} for ${Number(ledger.proceeds || 0).toFixed(2)} ISK net; listed ${ledger.unitsListed || 0}; retained ${ledger.unitsRetained || 0}${ledger.netResult !== undefined ? `; cash flow ${Number(ledger.netResult).toFixed(2)} ISK; in hangar ${ledger.unsoldUnits || 0}${ledger.resultPending || Number(ledger.unitsListed) > 0 || Number(ledger.unsoldUnits) > 0 ? "; result pending reconciliation" : ""}` : ""}.`,
    `Current step: ${visibleError ? "an error was recorded; review the durable task before retrying" : describeCycleStage(cycle.stage)}${visibleError ? "; error details are stored with the task" : ""}.`,
  ];
  if (ledger.saleReason) rows.push(`Sale outcome: ${ledger.saleReason}`);
  if (cycle.planningOutcome) rows.push(`Plan outcome: ${cycle.planningOutcome}`);
  if (Array.isArray(ledger.saleOrders) && ledger.saleOrders.length) {
    rows.push(`Sell orders: ${ledger.saleOrders.map(order => `${order.orderID} (${order.units} units at ${Number(order.price).toFixed(2)} ISK)`).join(", ")}.`);
  }
  if (Object.keys(ledger.unpricedInputs || {}).length) {
    rows.push(`Inputs without historical cost: ${JSON.stringify(ledger.unpricedInputs)}${ledger.estimatedInputValue !== undefined ? `; reference value ${Number(ledger.estimatedInputValue).toFixed(2)} ISK` : ""}.`);
  }
  if (cycle.previousCycle) {
    const previous = cycle.previousCycle;
    rows.push(`Previous cycle ${previous.cycleID}: ${previous.status}/${previous.stage} at ${previous.stationID}, spent ${Number(previous.totalSpend).toFixed(2)} ISK, blueprint ${previous.blueprintItemID || "none"}${previous.lastError ? "; an error was recorded" : ""}.`);
  }
  if (includeHistory) {
    rows.push(...(cycle.history || []).slice(-10).map((entry) => `  ${entry.at} [${entry.stage}] ${describeCycleStage(entry.stage)}.`));
  }
  return rows.join("\n");
}

function getCycleStatus(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique bot found for: ${botQuery}.` };
  const cycle = getCycle(bot.characterID);
  return {
    success: true,
    cycle,
    message: cycle ? formatCycle(cycle, true) : `${bot.characterName} has no recorded industry cycles.`,
  };
}

function formatCyclesSummary() {
  const cycles = listCycles().sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 5);
  if (!cycles.length) return "Industry cycles: none. Start one with /playerbots industry cycle start <bot> <blueprintTypeID> <runs> <maxISK>.";
  return [`Industry cycles (${listActiveCycles().length} active):`, ...cycles.map((cycle) => formatCycle(cycle))].join("\n");
}

// Marks a removed pilot's industry cycle stopped at once.
function retireCycleForRemovedPilot(characterID, reason = "The pilot was removed from the roster.") {
  const current = readCycleRecord(characterID);
  if (!current || ["completed", "stopped", "failed", "cancelled", "canceled", "abandoned"]
    .includes(String(current.status || "").toLowerCase())) return false;
  const cycle = JSON.parse(JSON.stringify(current));
  cycle.status = "stopped";
  cycle.pending = null;
  cycle.lastError = reason;
  saveCycle(cycle);
  return true;
}

module.exports = {
  retireCycleForRemovedPilot,
  _testing: { saveCycle, stepSell, stepJitaRun, stepAcquireMaterials, planMaterialInput, settlePendingPurchase,
    reconcilePendingListing, pendingListingNoEffectFingerprint, confirmPendingListingNoEffect, finish,
    readBestJitaSeedQuote },
  DEFAULT_MARKET_STATION_ID,
  advanceCycle,
  formatCycle,
  formatCyclesSummary,
  getCycle,
  getCycleStatus,
  listActiveCycles,
  listActiveCycleRecords,
  pauseForCapacity,
  PLAN_CANDIDATES,
  listCycles,
  listCycleRecords,
  findExpiredCorporateOutput,
  startExpiredCorporateResale,
  beginSupplyPurchase,
  finishSupplyPurchase,
  resumeCycle,
  startCycle,
  stopCycle,
};

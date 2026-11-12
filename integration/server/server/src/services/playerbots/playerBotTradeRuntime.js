"use strict";

const itemStore = require("../inventory/itemStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { getCharacterWallet } = require("../account/walletState");
const { createTableRepository } = require("../../gameStore/tableRepository");
const { getMachoUserErrorMessage, isUserErrorMachoError } = require("../../common/machoErrors");
const playerBots = require("./playerBotRuntime");
const playerBotSpace = require("./playerBotSpaceRuntime");

const TABLE = "playerBots";
const POLICY_PATH = "/_tradePolicies";
const AUTO_BUY_POLICY_PATH = "/_tradeBuyPolicies";
const SCHEDULE_PATH = "/_tradeSchedule";
const MAX_TRADE_BUDGET_ISK = 1_000_000_000;
const MAX_TRADE_QUANTITY = 100_000;
const MAX_PLAYERBOT_SELL_ORDER_DAYS = 90;
const MAX_TRADE_UNIT_PRICE_ISK = 1_000_000_000;
const activeTradeBots = new Set();
// Jita keeps the only seeded market. Bots buy there only after checking for
// non-Jita stock in the accessible region, but never sell there.
const JITA_SYSTEM_ID = 30000142;

function stationIsInJita(stationID, worldData = require("../../space/worldData")) {
  const station = worldData.getStationByID(Number(stationID));
  if (Number(station && station.solarSystemID) === JITA_SYSTEM_ID) return true;
  let structure = null;
  try {
    if (typeof worldData.getStructureByID === "function") structure = worldData.getStructureByID(Number(stationID));
  } catch (_) {
    // Dynamic structure state may not be initialized; the docked context still
    // supplies its system ID for transaction guards.
  }
  return Number(structure && structure.solarSystemID) === JITA_SYSTEM_ID;
}

function isJitaStation(stationID) {
  return stationIsInJita(stationID);
}

function isJitaTradeContext(context, stationPredicate = isJitaStation) {
  const session = context && context.session || {};
  return stationPredicate(context && context.stationID) ||
    Number(session.solarSystemID || session.solarsystemid2 || session.solarsystemid) === JITA_SYSTEM_ID;
}
const repo = createTableRepository("service:playerbots", { strict: true });

let marketProxy = null;

function getMarketProxy() {
  if (!marketProxy) {
    const MarketProxyService = require("../market/marketProxyService");
    marketProxy = new MarketProxyService();
  }
  return marketProxy;
}

function getMarketAuthorityErrorMessage(error) {
  const wrapped = error && error.machoErrorResponse;
  const payload = wrapped && wrapped.payload;
  const header = payload && Array.isArray(payload.header) ? payload.header : [];
  const args = Array.isArray(header[1]) ? header[1] : [];
  const entries = [args[1], header[2]]
    .filter((value) => value && Array.isArray(value.entries))
    .flatMap((value) => value.entries);
  for (const key of ["info", "notify", "message", "msg"]) {
    const value = entries.find((entry) => Array.isArray(entry) && entry[0] === key)?.[1];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Buffer.isBuffer(value) && value.length) return value.toString("utf8").trim();
  }
  if (isUserErrorMachoError(wrapped)) {
    const userErrorMessage = getMachoUserErrorMessage(wrapped);
    if (userErrorMessage && userErrorMessage !== "CustomInfo") return userErrorMessage;
  }
  const wrappedClass = header[0] && header[0].value;
  const wrappedMessage = Array.isArray(args[0]) ? args[0].find((value) => typeof value === "string") : args[0];
  if (typeof wrappedMessage === "string" && wrappedMessage.trim() && wrappedMessage !== "CustomInfo") {
    return wrappedMessage.trim();
  }
  if (wrappedClass && wrappedClass !== "eveexceptions.UserError") return String(wrappedClass);
  return String(error && error.message || "Market authority rejected the sell order.");
}

function normalizeIsk(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric * 100) / 100;
}

function countHangarUnits(characterID, stationID, typeID) {
  return itemStore.listCharacterItems(characterID, {
    locationID: stationID,
    flagID: itemStore.ITEM_FLAGS.HANGAR,
    typeID,
  }).reduce((total, item) => {
    const units = Number(item && (item.stacksize ?? item.quantity));
    return total + (Number.isFinite(units) && units > 0 ? Math.trunc(units) : 1);
  }, 0);
}

function itemUnitCount(item) {
  if (!item) return 0;
  if (Number(item.singleton) > 0) return 1;
  const units = Number(item.stacksize ?? item.quantity);
  return Number.isFinite(units) && units > 0 ? Math.trunc(units) : 1;
}

function readPolicyMap() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, POLICY_PATH);
  const data = result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
  return JSON.parse(JSON.stringify(data));
}

function savePolicyMap(policies) {
  const result = repo.write(TABLE, POLICY_PATH, policies);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_TRADE_POLICY_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_TRADE_POLICY_FLUSH_FAILED");
  }
  return policies;
}

function readAutoBuyPolicyMap() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, AUTO_BUY_POLICY_PATH);
  const data = result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
  return JSON.parse(JSON.stringify(data));
}

function saveAutoBuyPolicyMap(policies) {
  const result = repo.write(TABLE, AUTO_BUY_POLICY_PATH, policies);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_TRADE_AUTOBUY_POLICY_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_TRADE_AUTOBUY_POLICY_FLUSH_FAILED");
  }
  return policies;
}

function readTradeScheduleMarker() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, SCHEDULE_PATH);
  return result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function saveTradeScheduleMarker(marker) {
  const result = repo.write(TABLE, SCHEDULE_PATH, marker);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_TRADE_SCHEDULE_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_TRADE_SCHEDULE_FLUSH_FAILED");
  }
  return marker;
}

function getDockedTradeContext(botQuery) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) {
    return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  }

  const session = playerBotSpace.getActorSession(bot);
  const stationID = Number(session.stationID || session.structureID) || 0;
  const regionID = Number(session.regionID) || 0;
  if (!stationID || !regionID) {
    return {
      success: false,
      bot,
      message: `${bot.characterName} must be docked at a station or structure with a market to trade. Current location: ${playerBotSpace.getBotLocation(bot)}.`,
    };
  }

  return { success: true, bot, session, stationID, regionID };
}

function validateTradeType(typeID) {
  const normalizedTypeID = Math.trunc(Number(typeID));
  if (!Number.isSafeInteger(normalizedTypeID) || normalizedTypeID <= 0) {
    return { success: false, message: "typeID must be a positive integer." };
  }
  const itemType = resolveItemByTypeID(normalizedTypeID);
  if (!itemType || itemType.published === false) {
    return { success: false, message: `No published market type found for typeID ${normalizedTypeID}.` };
  }
  return { success: true, typeID: normalizedTypeID, itemType };
}

function getCurrentBalance(characterID, assetOwner = null) {
  if (assetOwner && assetOwner.isCorp === true) {
    const balance = Number(require("../corporation/corpWalletState")
      .getCorporationWalletBalance(assetOwner.ownerID, assetOwner.accountKey));
    return Number.isFinite(balance) ? balance : 0;
  }
  const balance = Number(getCharacterWallet(characterID)?.balance);
  return Number.isFinite(balance) ? balance : 0;
}

function resolveTradeAssetOwner(context, options = {}) {
  const corporationID = Math.trunc(Number(options.corporationID) || 0);
  if (!corporationID) {
    return {
      success: true,
      isCorp: false,
      ownerID: Number(context.bot.characterID),
      flagID: itemStore.ITEM_FLAGS.HANGAR,
      accountKey: null,
      session: context.session,
    };
  }
  const sessionCorporationID = Number(context.session.corporationID || context.session.corpid) || 0;
  const hangarDivision = Math.trunc(Number(options.hangarDivision) || 0);
  const walletDivision = Math.trunc(Number(options.walletDivision) || 0);
  if (corporationID !== sessionCorporationID || hangarDivision < 1 || hangarDivision > 7 ||
      walletDivision < 1 || walletDivision > 7) {
    return { success: false, message: "The selected corporation, hangar division, or wallet division is not available to this bot." };
  }
  const constants = require("../industry/industryConstants");
  const accountKey = 999 + walletDivision;
  return {
    success: true,
    isCorp: true,
    ownerID: corporationID,
    flagID: constants.ITEM_FLAG_CORP_HANGAR_1 + hangarDivision - 1,
    accountKey,
    session: { ...context.session, corpAccountKey: accountKey },
  };
}

function getMarketTransactions(assetOwner, characterID) {
  return assetOwner && assetOwner.isCorp === true
    ? require("../corporation/corpWalletState").getCorporationMarketTransactions(assetOwner.ownerID, {
        accountKey: assetOwner.accountKey,
      })
    : require("../account/walletState").getCharacterMarketTransactions(characterID);
}

function rowsFromMarketRowset(rowset) {
  const entries = rowset && rowset.args && rowset.args.type === "dict"
    ? rowset.args.entries
    : [];
  const linesEntry = (Array.isArray(entries) ? entries : []).find(([key]) => key === "lines");
  if (!linesEntry) throw new Error("MARKET_QUOTE_ROWSET_INVALID");
  const lines = linesEntry && linesEntry[1] && linesEntry[1].items;
  return (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      price: Number(line && line[0]) || 0,
      quantity: Number(line && line[1]) || 0,
      stationID: Number(line && line[10]) || 0,
    }))
    .filter((order) => order.price > 0 && order.quantity > 0 && order.stationID > 0);
}

async function readRegionalOrders(context, typeID) {
  const response = await getMarketProxy().Handle_GetOrders([typeID], context.session);
  const rowsets = response && response.args && response.args[1] && response.args[1].value;
  if (!Array.isArray(rowsets) || rowsets.length < 2) {
    throw new Error("MARKET_QUOTE_RESPONSE_SHAPE_INVALID");
  }
  return {
    sells: rowsFromMarketRowset(rowsets[0]).sort((left, right) => left.price - right.price),
    buys: rowsFromMarketRowset(rowsets[1]).sort((left, right) => right.price - left.price),
  };
}

async function readLocalQuote(context, typeID) {
  const orders = await readRegionalOrders(context, typeID);
  const localSells = orders.sells.filter((order) => order.stationID === context.stationID)
    .sort((left, right) => left.price - right.price);
  const localBuys = orders.buys.filter((order) => order.stationID === context.stationID)
    .sort((left, right) => right.price - left.price);
  return { bestAsk: localSells[0] || null, bestBid: localBuys[0] || null };
}

function selectBestAskOutsideJita(orders, minimumQuantity = 1, stationIsJita = isJitaStation, excludedStationID = 0) {
  const excluded = Number(excludedStationID) || 0;
  return (Array.isArray(orders) ? orders : [])
    .filter((order) => Number(order && order.price) > 0 &&
      Number(order.quantity) >= Math.max(1, Number(minimumQuantity) || 1) &&
      Number(order.stationID) !== excluded &&
      !stationIsJita(Number(order.stationID)))
    .sort((left, right) => Number(left.price) - Number(right.price) || Number(left.stationID) - Number(right.stationID))[0] || null;
}

function bidsOutsideJita(orders, stationIsJita = isJitaStation) {
  return (Array.isArray(orders) ? orders : [])
    .filter((order) => Number(order && order.price) > 0 && Number(order.quantity) > 0 &&
      Number(order.stationID) > 0 && !stationIsJita(Number(order.stationID)))
    .sort((left, right) => Number(right.price) - Number(left.price) || Number(left.stationID) - Number(right.stationID));
}

async function readBestAskOutsideJita(botQuery, typeID, minimumQuantity = 1, excludedStationID = 0) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  const type = validateTradeType(typeID);
  if (!type.success) return type;
  try {
    const orders = await readRegionalOrders(context, type.typeID);
    const bestAsk = selectBestAskOutsideJita(orders.sells, minimumQuantity, isJitaStation, excludedStationID);
    return { success: true, bestAsk, regionID: context.regionID };
  } catch (error) {
    return { success: false, message: `Could not verify non-Jita supply: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

// A price reference may use any station in the region, including Jita. This
// only informs the sell-order price: callers still list at the bot's current
// station, and all actual fills are revalidated against that station's book.
async function readRegionalMarketQuote(botQuery, typeID) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  const type = validateTradeType(typeID);
  if (!type.success) return type;
  try {
    const orders = await readRegionalOrders(context, type.typeID);
    const sellOrders = orders.sells;
    const buyOrdersOutsideJita = bidsOutsideJita(orders.buys);
    return {
      success: true,
      regionID: context.regionID,
      bestAsk: sellOrders[0] || null,
      bestBid: orders.buys[0] || null,
      bestBidOutsideJita: buyOrdersOutsideJita[0] || null,
      sellOrders,
      buyOrdersOutsideJita,
    };
  } catch (error) {
    return { success: false, message: `Could not read a regional price reference: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

async function getQuote(botQuery, typeID) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  const type = validateTradeType(typeID);
  if (!type.success) return type;

  try {
    const { bestAsk, bestBid } = await readLocalQuote(context, type.typeID);
    return {
      success: true,
      message: `${context.bot.characterName} — ${type.itemType.name} (${type.typeID}) at ${context.stationID}: best ask ${bestAsk ? `${Number(bestAsk.price).toFixed(2)} ISK x ${Number(bestAsk.quantity)}` : "no orders"}; best bid ${bestBid ? `${Number(bestBid.price).toFixed(2)} ISK x ${Number(bestBid.quantity)}` : "no orders"}. Local quote; the authority will revalidate price, range and balance when the trade executes.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Could not query the market: ${String(error && error.message || error).slice(0, 180)}.`,
    };
  }
}

// Best ask and bid for a type at any station of the bot's region (the market
// answers region-wide orders; this keeps only the requested station's).
async function readQuoteAt(botQuery, typeID, stationID) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const session = playerBotSpace.getActorSession(bot);
  const type = validateTradeType(typeID);
  if (!type.success) return type;
  const { bestAsk, bestBid } = await readLocalQuote({ session, stationID: Number(stationID) }, type.typeID);
  return { success: true, stationID: Number(stationID), bestAsk, bestBid };
}

async function readQuote(botQuery, typeID) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  const type = validateTradeType(typeID);
  if (!type.success) return type;
  const { bestAsk, bestBid } = await readLocalQuote(context, type.typeID);
  return { success: true, stationID: context.stationID, bestAsk, bestBid };
}

function getAutoSellPolicyForBot(bot) {
  if (!bot || !Number(bot.characterID)) return null;
  return readPolicyMap()[Number(bot.characterID)] || null;
}

function listActiveAutoSellPolicies() {
  return Object.values(readPolicyMap()).filter((policy) => policy && policy.enabled === true);
}

function getAutoBuyPolicyForBot(bot) {
  if (!bot || !Number(bot.characterID)) return null;
  return readAutoBuyPolicyMap()[Number(bot.characterID)] || null;
}

function listActiveAutoBuyPolicies() {
  return Object.values(readAutoBuyPolicyMap()).filter((policy) => policy && policy.enabled === true);
}

function getAutoSellPolicy(botQuery) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const policy = getAutoSellPolicyForBot(bot);
  if (!policy || policy.enabled !== true) {
    return { success: true, policy: null, message: `${bot.characterName} has no active auto-sell policy.` };
  }
  const type = resolveItemByTypeID(policy.typeID);
  return {
    success: true,
    policy,
    message: `${bot.characterName}: auto-sell ${type && type.name || policy.typeID} (${policy.typeID}) at ${policy.stationID}; minimum ${Number(policy.minimumUnitPrice).toFixed(2)} ISK; maximum ${Number(policy.maxUnitsPerCycle).toLocaleString("en-US")} units per 5-minute cycle; unsold units are listed free for ${MAX_PLAYERBOT_SELL_ORDER_DAYS} days.`,
  };
}

async function setAutoSellPolicy(botQuery, typeID, minimumUnitPrice, maxUnitsPerCycle, requestedByCharacterID = null) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  if (isJitaTradeContext(context)) return { success: false, message: "Playerbots cannot sell in Jita; configure auto-sell at a non-Jita market station." };
  if (context.bot.specialty !== "trade") {
    return { success: false, message: "Auto-sell can only be configured for trade specialists." };
  }
  const type = validateTradeType(typeID);
  if (!type.success) return type;
  if (Number(type.itemType.categoryID) === 6) {
    return { success: false, message: "The automatic policy cannot sell ships." };
  }
  let normalizedPrice = normalizeIsk(minimumUnitPrice);
  const normalizedQuantity = Math.trunc(Number(maxUnitsPerCycle));
  if (!normalizedPrice || normalizedPrice > MAX_TRADE_UNIT_PRICE_ISK) {
    return { success: false, message: `The minimum price must be between 0.01 and ${MAX_TRADE_UNIT_PRICE_ISK.toLocaleString("en-US")} ISK.` };
  }
  if (!Number.isSafeInteger(normalizedQuantity) || normalizedQuantity <= 0 || normalizedQuantity > MAX_TRADE_QUANTITY) {
    return { success: false, message: `The per-cycle limit must be between 1 and ${MAX_TRADE_QUANTITY.toLocaleString("en-US")} units.` };
  }

  try {
    await getMarketProxy().Handle_GetStationAsks([], context.session);
  } catch (error) {
    return { success: false, message: `Could not validate market access at ${context.stationID}: ${String(error && error.message || error).slice(0, 180)}.` };
  }

  try {
    const policies = readPolicyMap();
    const previous = policies[Number(context.bot.characterID)] || {};
    const policy = {
      characterID: Number(context.bot.characterID),
      stationID: context.stationID,
      typeID: type.typeID,
      minimumUnitPrice: normalizedPrice,
      maxUnitsPerCycle: normalizedQuantity,
      enabled: true,
      version: Math.max(0, Math.trunc(Number(previous.version) || 0)) + 1,
      requestedByCharacterID: Math.trunc(Number(requestedByCharacterID) || 0) || null,
      createdAt: previous.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      disabledAt: null,
    };
    policies[Number(context.bot.characterID)] = policy;
    savePolicyMap(policies);
    return {
      success: true,
      policy,
      message: `Auto-sell enabled for ${context.bot.characterName}: sell ${type.itemType.name} (${type.typeID}) from its hangar at ${context.stationID} when a buyer pays at least ${normalizedPrice.toFixed(2)} ISK; list any unsold units free for ${MAX_PLAYERBOT_SELL_ORDER_DAYS} days, up to ${normalizedQuantity.toLocaleString("en-US")} units every 5 minutes.`,
    };
  } catch (error) {
    return { success: false, message: `Could not save the policy: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

function disableAutoSellPolicy(botQuery) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  if (bot.specialty !== "trade") {
    return { success: false, message: "Auto-sell policies are only available to trade specialists." };
  }
  const policies = readPolicyMap();
  const previous = policies[Number(bot.characterID)];
  if (!previous || previous.enabled !== true) {
    return { success: true, message: `${bot.characterName} had no active auto-sell policy.` };
  }
  policies[Number(bot.characterID)] = {
    ...previous,
    enabled: false,
    version: Math.max(0, Math.trunc(Number(previous.version) || 0)) + 1,
    disabledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    savePolicyMap(policies);
    return { success: true, message: `Auto-sell disabled for ${bot.characterName}. Tasks that have not started will check the policy version and will not sell.` };
  } catch (error) {
    return { success: false, message: `Could not disable the policy: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

function getAutoBuyPolicy(botQuery) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const policy = getAutoBuyPolicyForBot(bot);
  if (!policy || policy.enabled !== true) {
    return { success: true, policy: null, message: `${bot.characterName} has no active auto-buy policy.` };
  }
  const type = resolveItemByTypeID(policy.typeID);
  return {
    success: true,
    policy,
    message: `${bot.characterName}: auto-buy ${type && type.name || policy.typeID} (${policy.typeID}) at ${policy.stationID}; maximum ${Number(policy.maxUnitPrice).toFixed(2)} ISK/unit; target ${Number(policy.targetStock).toLocaleString("en-US")} units; budget ${Number(policy.maxSpendPerCycle).toFixed(2)} ISK per 5-minute cycle.`,
  };
}

async function setAutoBuyPolicy(botQuery, typeID, maxUnitPrice, targetStock, maxSpendPerCycle, requestedByCharacterID = null) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  if (isJitaTradeContext(context)) return { success: false, message: "Jita is a seed-market fallback, so playerbots cannot run speculative auto-buy policies there." };
  if (context.bot.specialty !== "trade") {
    return { success: false, message: "Auto-buy can only be configured for trade specialists." };
  }
  const type = validateTradeType(typeID);
  if (!type.success) return type;
  const normalizedPrice = normalizeIsk(maxUnitPrice);
  const normalizedTargetStock = Math.trunc(Number(targetStock));
  const normalizedBudget = normalizeIsk(maxSpendPerCycle);
  if (!normalizedPrice || normalizedPrice > MAX_TRADE_UNIT_PRICE_ISK) {
    return { success: false, message: `The maximum price must be between 0.01 and ${MAX_TRADE_UNIT_PRICE_ISK.toLocaleString("en-US")} ISK.` };
  }
  if (!Number.isSafeInteger(normalizedTargetStock) || normalizedTargetStock <= 0 || normalizedTargetStock > MAX_TRADE_QUANTITY) {
    return { success: false, message: `Target stock must be between 1 and ${MAX_TRADE_QUANTITY.toLocaleString("en-US")} units.` };
  }
  if (!normalizedBudget || normalizedBudget > MAX_TRADE_BUDGET_ISK || normalizedBudget < normalizedPrice) {
    return { success: false, message: `The per-cycle budget must cover at least one unit at the maximum price and cannot exceed ${MAX_TRADE_BUDGET_ISK.toLocaleString("en-US")} ISK.` };
  }

  try {
    await getMarketProxy().Handle_GetStationAsks([], context.session);
  } catch (error) {
    return { success: false, message: `Could not validate market access at ${context.stationID}: ${String(error && error.message || error).slice(0, 180)}.` };
  }

  try {
    const policies = readAutoBuyPolicyMap();
    const previous = policies[Number(context.bot.characterID)] || {};
    const policy = {
      characterID: Number(context.bot.characterID),
      stationID: context.stationID,
      typeID: type.typeID,
      maxUnitPrice: normalizedPrice,
      targetStock: normalizedTargetStock,
      maxSpendPerCycle: normalizedBudget,
      enabled: true,
      version: Math.max(0, Math.trunc(Number(previous.version) || 0)) + 1,
      requestedByCharacterID: Math.trunc(Number(requestedByCharacterID) || 0) || null,
      createdAt: previous.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      disabledAt: null,
    };
    policies[Number(context.bot.characterID)] = policy;
    saveAutoBuyPolicyMap(policies);
    return {
      success: true,
      policy,
      message: `Auto-buy enabled for ${context.bot.characterName}: maintain up to ${normalizedTargetStock.toLocaleString("en-US")} ${type.itemType.name} (${type.typeID}) at ${context.stationID}, paying at most ${normalizedPrice.toFixed(2)} ISK/unit and ${normalizedBudget.toFixed(2)} ISK per cycle. It uses only the bot’s wallet and does not place open orders.`,
    };
  } catch (error) {
    return { success: false, message: `Could not save the policy: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

function disableAutoBuyPolicyForCharacter(characterID, expectedVersion = null) {
  const policies = readAutoBuyPolicyMap();
  const key = Number(characterID);
  const previous = policies[key];
  if (!previous || previous.enabled !== true) return false;
  if (expectedVersion !== null && Number(previous.version) !== Number(expectedVersion)) return false;
  policies[key] = {
    ...previous,
    enabled: false,
    version: Math.max(0, Math.trunc(Number(previous.version) || 0)) + 1,
    disabledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveAutoBuyPolicyMap(policies);
  return true;
}

function disableAutoBuyPolicy(botQuery) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  if (bot.specialty !== "trade") {
    return { success: false, message: "Auto-buy policies are only available to trade specialists." };
  }
  const policy = getAutoBuyPolicyForBot(bot);
  if (!policy || policy.enabled !== true) {
    return { success: true, message: `${bot.characterName} had no active auto-buy policy.` };
  }
  try {
    disableAutoBuyPolicyForCharacter(bot.characterID, policy.version);
    return { success: true, message: `Auto-buy disabled for ${bot.characterName}. Tasks that have not started will check the policy version and will not buy.` };
  } catch (error) {
    return { success: false, message: `Could not disable the policy: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

async function scheduleTradeTasks(bots, cycleID) {
  const normalizedCycleID = String(cycleID || Date.now());
  const previousMarker = readTradeScheduleMarker();
  if (String(previousMarker.lastCycleID || "") === normalizedCycleID) {
    return { scheduled: 0, autoSellScheduled: 0, autoBuyScheduled: 0, skippedReplay: true, quoteFailures: 0 };
  }
  saveTradeScheduleMarker({
    lastCycleID: normalizedCycleID,
    markedAt: new Date().toISOString(),
  });

  const policies = readPolicyMap();
  const autoBuyPolicies = readAutoBuyPolicyMap();
  const botByID = new Map((Array.isArray(bots) ? bots : []).map((bot) => [Number(bot.characterID), bot]));
  const tasks = require("./playerBotTaskRuntime");
  let autoSellScheduled = 0;
  let autoBuyScheduled = 0;
  let quoteFailures = 0;
  for (const policy of Object.values(policies)) {
    if (!policy || policy.enabled !== true) continue;
    const bot = botByID.get(Number(policy.characterID));
    if (!bot || bot.specialty !== "trade" || bot.status === "paused" || bot.autonomyPaused === true) continue;
    let context;
    try {
      context = getDockedTradeContext(bot.characterName);
    } catch (error) {
      quoteFailures += 1;
      continue;
    }
    if (!context.success || context.stationID !== Number(policy.stationID) || isJitaTradeContext(context)) continue;
    const type = validateTradeType(policy.typeID);
    if (!type.success || Number(type.itemType.categoryID) === 6) continue;
    const inventory = itemStore.listCharacterItems(bot.characterID, {
      locationID: context.stationID,
      flagID: itemStore.ITEM_FLAGS.HANGAR,
      typeID: type.typeID,
    }).filter((item) => Number(item && item.categoryID) !== 6)
      .sort((left, right) => Number(left.itemID) - Number(right.itemID));
    const item = inventory.find((entry) => itemUnitCount(entry) > 0);
    if (!item) continue;
    const quantity = Math.min(
      Number(policy.maxUnitsPerCycle) || 0,
      itemUnitCount(item),
      MAX_TRADE_QUANTITY,
    );
    if (quantity <= 0) continue;

    const task = tasks.enqueueTask({
      kind: "playerbot.trade.autosell",
      capability: "trade",
      resourceOwnerCharacterID: Number(bot.characterID),
      requestedBy: "system",
      dedupeKey: `playerbot.trade.autosell:${Number(bot.characterID)}:${Number(policy.version) || 1}`,
      payload: {
        policyVersion: Math.max(1, Math.trunc(Number(policy.version) || 1)),
        typeID: type.typeID,
        stationID: context.stationID,
        minimumUnitPrice: Number(policy.minimumUnitPrice),
        itemID: Number(item.itemID),
        maxQuantity: quantity,
        initialItemQuantity: itemUnitCount(item),
      },
    });
    if (task.created) autoSellScheduled += 1;
  }

  for (const policy of Object.values(autoBuyPolicies)) {
    if (!policy || policy.enabled !== true) continue;
    const bot = botByID.get(Number(policy.characterID));
    if (!bot || bot.specialty !== "trade" || bot.status === "paused" || bot.autonomyPaused === true) continue;
    let context;
    try {
      context = getDockedTradeContext(bot.characterName);
    } catch (error) {
      quoteFailures += 1;
      continue;
    }
    if (!context.success || context.stationID !== Number(policy.stationID) || isJitaTradeContext(context)) continue;
    const type = validateTradeType(policy.typeID);
    if (!type.success) continue;
    const targetStock = Math.max(0, Math.trunc(Number(policy.targetStock) || 0));
    const maxUnitPrice = normalizeIsk(policy.maxUnitPrice);
    const maxSpendPerCycle = normalizeIsk(policy.maxSpendPerCycle);
    if (!targetStock || !maxUnitPrice || !maxSpendPerCycle) continue;
    const currentStock = countHangarUnits(bot.characterID, context.stationID, type.typeID);
    const balance = getCurrentBalance(bot.characterID);
    const spendable = Math.min(maxSpendPerCycle, balance);
    const affordableQuantity = Math.floor((spendable + 0.0001) / maxUnitPrice);
    const quantity = Math.min(targetStock - currentStock, affordableQuantity, MAX_TRADE_QUANTITY);
    if (quantity <= 0) continue;

    try {
      const quote = await readLocalQuote(context, type.typeID);
      if (!quote.bestAsk || quote.bestAsk.price > maxUnitPrice + 0.0001) continue;
    } catch (error) {
      quoteFailures += 1;
      continue;
    }

    const task = tasks.enqueueTask({
      kind: "playerbot.trade.autobuy",
      capability: "trade",
      resourceOwnerCharacterID: Number(bot.characterID),
      requestedBy: "system",
      dedupeKey: `playerbot.trade.autobuy:${Number(bot.characterID)}:${Math.max(1, Math.trunc(Number(policy.version) || 1))}`,
      payload: {
        policyVersion: Math.max(1, Math.trunc(Number(policy.version) || 1)),
        typeID: type.typeID,
        stationID: context.stationID,
        maxUnitPrice,
        targetStock,
        maxSpendPerCycle,
        plannedQuantity: quantity,
      },
    });
    if (task.created) autoBuyScheduled += 1;
  }
  return {
    scheduled: autoSellScheduled + autoBuyScheduled,
    autoSellScheduled,
    autoBuyScheduled,
    skippedReplay: false,
    quoteFailures,
  };
}

async function executeAutoSellTask(task, provider) {
  const payload = task && task.payload && typeof task.payload === "object" ? task.payload : {};
  const characterID = Number(task && (task.resourceOwnerCharacterID || task.targetCharacterID)) || 0;
  if (!characterID || characterID !== Number(provider && provider.characterID)) {
    throw new Error("PLAYERBOT_TRADE_TASK_OWNER_MISMATCH");
  }
  const taskRuntime = require("./playerBotTaskRuntime");
  const previousProgress = task && task.progress && typeof task.progress === "object" ? task.progress : {};
  if (previousProgress.phase === "settled" && previousProgress.result && typeof previousProgress.result === "object") {
    return previousProgress.result;
  }

  const reconcileListing = (progress = previousProgress) => {
    const marker = progress;
    const stationID = Number(marker.stationID || payload.stationID) || 0;
    const typeID = Number(marker.typeID || payload.typeID) || 0;
    const itemID = Number(marker.itemID || payload.itemID) || 0;
    const baselineQuantity = Math.max(0, Math.trunc(Number(marker.baselineItemQuantity) || 0));
    const requestedQuantity = Math.max(0, Math.trunc(Number(marker.requestedQuantity) || 0));
    if (!stationID || !typeID || !itemID || !baselineQuantity || !requestedQuantity || !Array.isArray(marker.baselineOrderIDs)) {
      return { state: "unknown", result: { success: false, sold: 0, listed: 0, netProceeds: 0, outcomeUnknown: true, requiresReview: true, message: "The recovered auto-sale is missing its market checkpoint and needs manual review." } };
    }
    const economy = require("./playerBotEconomyRuntime");
    const orders = economy.listOpenSellOrders(characterID, stationID, typeID);
    if (!orders.success) {
      return { state: "unknown", result: { success: false, sold: 0, listed: 0, netProceeds: 0, outcomeUnknown: true, requiresReview: true, message: `Could not inspect the market after recovering an auto-sale: ${orders.error}.` } };
    }
    const baselineIDs = new Set(marker.baselineOrderIDs.map(Number));
    const createdOrders = orders.orders.filter((order) => !baselineIDs.has(Number(order.order_id)));
    const listed = createdOrders.reduce((sum, order) => sum + Math.max(0, Number(order.vol_remaining) || 0), 0);
    const transactions = getMarketTransactions({ isCorp: false }, characterID)
      .filter((entry) => Number(entry.transactionID) > Number(marker.baselineTransactionID || 0) &&
        Number(entry.sellerID) === characterID && Number(entry.typeID) === typeID);
    const sold = transactions.reduce((sum, entry) => sum + Math.max(0, Number(entry.quantity) || 0), 0);
    const jitaFillTransactions = transactions.filter((entry) => isJitaStation(Number(entry.stationID)));
    const jitaFillUnits = jitaFillTransactions.reduce((sum, entry) => sum + Math.max(0, Number(entry.quantity) || 0), 0);
    const item = itemStore.findItemById(itemID);
    const currentQuantity = item && Number(item.ownerID) === characterID &&
      Number(item.locationID) === stationID && Number(item.flagID) === itemStore.ITEM_FLAGS.HANGAR
      ? itemUnitCount(item) : 0;
    const moved = Math.min(requestedQuantity, Math.max(0, baselineQuantity - currentQuantity));

    if (moved === 0 && listed === 0 && sold === 0 && currentQuantity === baselineQuantity) {
      return { state: "unchanged" };
    }
    if (moved !== listed + sold) {
      return { state: "unknown", result: {
        success: false,
        sold,
        listed,
        netProceeds: 0,
        outcomeUnknown: true,
        requiresReview: true,
        message: `Recovered auto-sale changed ${moved} hangar units, but only ${sold} sold units and ${listed} open-order units can be confirmed. Review the hangar, market orders, and transactions before re-enabling auto-sell.`,
      } };
    }
    return { state: "settled", result: {
      success: true,
      sold,
      listed,
      // A restarted task can observe fills, but cannot safely isolate the
      // wallet delta from unrelated income. Do not count recovered ISK twice.
      netProceeds: 0,
      typeID,
      itemID,
      minimumUnitPrice: Number(marker.minimumUnitPrice || payload.minimumUnitPrice) || 0,
      durationDays: MAX_PLAYERBOT_SELL_ORDER_DAYS,
      orderID: Number(createdOrders[0] && createdOrders[0].order_id) || null,
      recoveredPriorSale: 0,
      proceedsNotRecounted: sold > 0,
      jitaFillUnits,
      ...(jitaFillUnits ? { policyViolation: "legacy sale matched a Jita-located buy order" } : {}),
    } };
  };

  if (previousProgress.phase === "listing") {
    const reconciled = reconcileListing();
    if (reconciled.state === "settled" || reconciled.state === "unknown") {
      if (reconciled.state === "unknown") {
        try { disableAutoSellPolicy(provider.characterName); } catch (_) { /* keep the review result durable */ }
      }
      const saved = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "settled", result: reconciled.result });
      if (!saved.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
      return reconciled.result;
    }
    const ready = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "ready", result: null });
    if (!ready.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
  }

  const policy = getAutoSellPolicyForBot(provider);
  if (!policy || policy.enabled !== true || Number(policy.version) !== Number(payload.policyVersion)) {
    return { skipped: true, reason: "policy disabled or replaced", sold: 0 };
  }
  const context = getDockedTradeContext(provider.characterName);
  if (!context.success || context.stationID !== Number(payload.stationID)) {
    return { skipped: true, reason: "bot not at policy station", sold: 0 };
  }
  if (isJitaTradeContext(context)) return { skipped: true, reason: "playerbot selling is disabled in Jita", sold: 0 };
  const item = itemStore.findItemById(Number(payload.itemID));
  if (
    !item ||
    Number(item.ownerID) !== characterID ||
    Number(item.locationID) !== context.stationID ||
    Number(item.flagID) !== itemStore.ITEM_FLAGS.HANGAR ||
    Number(item.typeID) !== Number(payload.typeID)
  ) {
    return { skipped: true, reason: "approved stock no longer in the bot's station hangar", sold: 0 };
  }

  const initialItemQuantity = Math.max(0, Math.trunc(Number(payload.initialItemQuantity) || 0));
  const maxQuantity = Math.max(0, Math.trunc(Number(payload.maxQuantity) || 0));
  const currentQuantity = itemUnitCount(item);
  const alreadySold = Math.min(maxQuantity, Math.max(0, initialItemQuantity - currentQuantity));
  const remainingAuthorizedQuantity = Math.max(0, maxQuantity - alreadySold);
  if (remainingAuthorizedQuantity <= 0 || currentQuantity <= 0) {
    return { skipped: true, reason: "sale already settled before task recovery", sold: alreadySold };
  }
  const requestedQuantity = Math.min(remainingAuthorizedQuantity, currentQuantity);
  const economy = require("./playerBotEconomyRuntime");
  const baselineOrders = economy.listOpenSellOrders(characterID, context.stationID, Number(payload.typeID));
  if (!baselineOrders.success) throw new Error(`Could not read existing sell orders before auto-sale: ${baselineOrders.error}.`);
  const transactionsBefore = getMarketTransactions({ isCorp: false }, characterID);
  const baselineTransactionID = transactionsBefore.reduce((highest, entry) =>
    Math.max(highest, Number(entry.transactionID) || 0), 0);
  const marker = {
    phase: "listing",
    stationID: context.stationID,
    typeID: Number(payload.typeID),
    itemID: Number(payload.itemID),
    baselineItemQuantity: currentQuantity,
    requestedQuantity,
    baselineTransactionID,
    baselineOrderIDs: baselineOrders.orders.map((order) => Number(order.order_id)),
    minimumUnitPrice: Number(payload.minimumUnitPrice),
    startedAt: new Date().toISOString(),
  };
  const started = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, marker);
  if (!started.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
  const result = await listSellOrder(
    provider.characterName,
    Number(payload.itemID),
    requestedQuantity,
    Number(payload.minimumUnitPrice),
    MAX_PLAYERBOT_SELL_ORDER_DAYS,
  );
  if (!result.success) {
    const reconciled = reconcileListing(marker);
    if (reconciled.state === "settled" || reconciled.state === "unknown") {
      const settledResult = reconciled.state === "settled"
        ? reconciled.result
        : { ...reconciled.result, message: result.message || reconciled.result.message };
      if (reconciled.state !== "settled") {
        settledResult.outcomeUnknown = true;
        settledResult.requiresReview = true;
        try { disableAutoSellPolicy(provider.characterName); } catch (_) { /* keep the review result durable */ }
      }
      const saved = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "settled", result: settledResult });
      if (!saved.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
      return settledResult;
    }
    const ready = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "ready", result: null });
    if (!ready.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
    throw new Error(result.message || "PLAYERBOT_TRADE_SELL_FAILED");
  }
  const settledResult = {
    ...result,
    typeID: Number(payload.typeID),
    itemID: Number(payload.itemID),
    minimumUnitPrice: Number(payload.minimumUnitPrice),
    recoveredPriorSale: alreadySold,
    netProceeds: Number(result.credited) || 0,
  };
  const saved = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "settled", result: settledResult });
  if (!saved.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
  return settledResult;
}

async function executeAutoBuyTask(task, provider) {
  const payload = task && task.payload && typeof task.payload === "object" ? task.payload : {};
  const characterID = Number(task && (task.resourceOwnerCharacterID || task.targetCharacterID)) || 0;
  if (!characterID || characterID !== Number(provider && provider.characterID)) {
    throw new Error("PLAYERBOT_TRADE_TASK_OWNER_MISMATCH");
  }
  const taskRuntime = require("./playerBotTaskRuntime");
  const previousProgress = task && task.progress && typeof task.progress === "object" ? task.progress : {};
  if (previousProgress.phase === "settled" && previousProgress.result && typeof previousProgress.result === "object") {
    return previousProgress.result;
  }
  if (previousProgress.phase === "buying") {
    const beforeUnits = Math.max(0, Math.trunc(Number(previousProgress.baselineUnits) || 0));
    const beforeBalance = Math.max(0, Number(previousProgress.baselineBalance) || 0);
    const currentUnits = countHangarUnits(characterID, Number(payload.stationID), Number(payload.typeID));
    const currentBalance = getCurrentBalance(characterID);
    const result = {
      success: false,
      outcomeUnknown: true,
      requiresReview: true,
      bought: Math.max(0, currentUnits - beforeUnits),
      spent: Math.max(0, beforeBalance - currentBalance),
      message: "The purchase outcome is uncertain after task recovery; it was not repeated to avoid a duplicate charge. Check the hangar and wallet before re-enabling the policy.",
    };
    try {
      disableAutoBuyPolicyForCharacter(characterID, payload.policyVersion);
    } catch (error) {
      result.policyDisableError = String(error && error.message || error).slice(0, 180);
    }
    const saved = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, {
      phase: "settled",
      result,
    });
    if (!saved.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
    return result;
  }

  const policy = getAutoBuyPolicyForBot(provider);
  if (!policy || policy.enabled !== true || Number(policy.version) !== Number(payload.policyVersion)) {
    return { skipped: true, reason: "policy disabled or replaced", bought: 0, spent: 0 };
  }
  const context = getDockedTradeContext(provider.characterName);
  if (!context.success || context.stationID !== Number(payload.stationID) || context.stationID !== Number(policy.stationID)) {
    return { skipped: true, reason: "bot not at policy station", bought: 0, spent: 0 };
  }
  if (isJitaTradeContext(context)) return { skipped: true, reason: "Jita is reserved for seed-market fallback", bought: 0, spent: 0 };
  const type = validateTradeType(payload.typeID);
  if (!type.success || Number(type.typeID) !== Number(policy.typeID)) {
    return { skipped: true, reason: "policy item is no longer available", bought: 0, spent: 0 };
  }
  const currentStock = countHangarUnits(characterID, context.stationID, type.typeID);
  const balance = getCurrentBalance(characterID);
  const maxUnitPrice = normalizeIsk(policy.maxUnitPrice);
  const maxSpendPerCycle = normalizeIsk(policy.maxSpendPerCycle);
  const targetStock = Math.trunc(Number(policy.targetStock));
  if (
    !maxUnitPrice || maxUnitPrice > MAX_TRADE_UNIT_PRICE_ISK ||
    !maxSpendPerCycle || maxSpendPerCycle > MAX_TRADE_BUDGET_ISK || maxSpendPerCycle < maxUnitPrice ||
    !Number.isSafeInteger(targetStock) || targetStock <= 0 || targetStock > MAX_TRADE_QUANTITY
  ) {
    return { skipped: true, reason: "policy limits are invalid", bought: 0, spent: 0 };
  }
  const remainingStock = Math.max(0, targetStock - currentStock);
  const authorizedBudget = Math.min(maxSpendPerCycle, balance);
  const affordableQuantity = Math.floor((authorizedBudget + 0.0001) / maxUnitPrice);
  const quantity = Math.min(
    remainingStock,
    Math.max(0, Math.trunc(Number(payload.plannedQuantity) || 0)),
    affordableQuantity,
    MAX_TRADE_QUANTITY,
  );
  if (quantity <= 0) {
    return { skipped: true, reason: "target stock reached or wallet cannot cover one unit", bought: 0, spent: 0 };
  }

  let quote;
  try {
    quote = await readLocalQuote(context, type.typeID);
  } catch (error) {
    return { skipped: true, reason: "market quote unavailable", quoteError: String(error && error.message || error).slice(0, 160), bought: 0, spent: 0 };
  }
  if (!quote.bestAsk || quote.bestAsk.price > maxUnitPrice + 0.0001) {
    return { skipped: true, reason: "no local ask meets the configured ceiling", bought: 0, spent: 0 };
  }
  const latestPolicy = getAutoBuyPolicyForBot(provider);
  if (!latestPolicy || latestPolicy.enabled !== true || Number(latestPolicy.version) !== Number(payload.policyVersion)) {
    return { skipped: true, reason: "policy changed before the purchase was submitted", bought: 0, spent: 0 };
  }

  const progress = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, {
    phase: "buying",
    baselineUnits: currentStock,
    baselineBalance: balance,
    authorizedQuantity: quantity,
    maxUnitPrice,
    maxSpend: Math.round(maxUnitPrice * quantity * 100) / 100,
    startedAt: new Date().toISOString(),
  });
  if (!progress.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");

  const trade = await buy(provider.characterName, type.typeID, quantity, maxUnitPrice);
  const result = trade.success
    ? {
        success: true,
        bought: Number(trade.bought) || 0,
        spent: Number(trade.spent) || 0,
        typeID: type.typeID,
        stationID: context.stationID,
        maxUnitPrice,
        targetStock,
        message: trade.message,
      }
    : {
        success: false,
        outcomeUnknown: trade.outcomeUnknown === true,
        requiresReview: trade.outcomeUnknown === true,
        bought: Number(trade.observedBought) || 0,
        spent: Number(trade.observedSpent) || 0,
        typeID: type.typeID,
        stationID: context.stationID,
        maxUnitPrice,
        message: trade.message,
      };
  if (result.outcomeUnknown) {
    try {
      disableAutoBuyPolicyForCharacter(characterID, payload.policyVersion);
    } catch (error) {
      result.policyDisableError = String(error && error.message || error).slice(0, 180);
    }
  }
  const settled = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, {
    phase: "settled",
    result,
    settledAt: new Date().toISOString(),
  });
  if (!settled.success) throw new Error("PLAYERBOT_TRADE_TASK_PROGRESS_STALE");
  return result;
}

async function buy(botQuery, typeID, quantity, maxUnitPrice) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  const type = validateTradeType(typeID);
  if (!type.success) return type;

  if (isJitaTradeContext(context)) {
    const regionalSupply = await readBestAskOutsideJita(context.bot.characterName, type.typeID);
    if (!regionalSupply.success) {
      return { success: false, message: `Jita purchase blocked because non-Jita supply could not be verified: ${regionalSupply.message}` };
    }
    if (regionalSupply.bestAsk) {
      return {
        success: false,
        sourceAvailable: true,
        sourceStationID: Number(regionalSupply.bestAsk.stationID),
        sourcePrice: Number(regionalSupply.bestAsk.price),
        message: `Jita is the seed-market fallback. ${type.itemType.name} is available at non-Jita station ${regionalSupply.bestAsk.stationID} for ${Number(regionalSupply.bestAsk.price).toFixed(2)} ISK; buy it there instead.`,
      };
    }
  }

  const normalizedQuantity = Math.trunc(Number(quantity));
  const normalizedPrice = normalizeIsk(maxUnitPrice);
  if (!Number.isSafeInteger(normalizedQuantity) || normalizedQuantity <= 0 || normalizedQuantity > MAX_TRADE_QUANTITY) {
    return { success: false, message: `Quantity must be between 1 and ${MAX_TRADE_QUANTITY.toLocaleString("en-US")} units.` };
  }
  if (!normalizedPrice || normalizedPrice > MAX_TRADE_UNIT_PRICE_ISK) {
    return { success: false, message: `Maximum unit price must be between 0.01 and ${MAX_TRADE_UNIT_PRICE_ISK.toLocaleString("en-US")} ISK.` };
  }

  const maxBudget = Math.round(normalizedPrice * normalizedQuantity * 100) / 100;
  if (maxBudget > MAX_TRADE_BUDGET_ISK) {
    return { success: false, message: `The maximum budget for this operation is ${MAX_TRADE_BUDGET_ISK.toLocaleString("en-US")} ISK; reduce the quantity or price.` };
  }
  const balanceBefore = getCurrentBalance(context.bot.characterID);
  if (balanceBefore + 0.0001 < maxBudget) {
    return {
      success: false,
      message: `${context.bot.characterName} has ${balanceBefore.toFixed(2)} ISK; the authority requires enough to cover the ${maxBudget.toFixed(2)} ISK limit for this purchase.`,
    };
  }
  const botID = Number(context.bot.characterID);
  if (activeTradeBots.has(botID)) {
    return { success: false, message: `${context.bot.characterName} already has another market operation in progress.` };
  }

  const unitsBefore = countHangarUnits(context.bot.characterID, context.stationID, type.typeID);
  activeTradeBots.add(botID);
  try {
    await getMarketProxy().Handle_BuyMultipleItems(
      [context.stationID, [{ typeID: type.typeID, quantity: normalizedQuantity, price: normalizedPrice, minVolume: 1 }], false],
      context.session,
    );
    const unitsAfter = countHangarUnits(context.bot.characterID, context.stationID, type.typeID);
    const balanceAfter = getCurrentBalance(context.bot.characterID);
    const bought = Math.max(0, unitsAfter - unitsBefore);
    const spent = Math.max(0, balanceBefore - balanceAfter);
    return {
      success: true,
      bought,
      spent,
      message: bought
        ? `${context.bot.characterName} bought ${bought.toLocaleString("en-US")} ${type.itemType.name} (${type.typeID}) for ${spent.toFixed(2)} ISK. Wallet balance: ${balanceAfter.toFixed(2)} ISK.`
        : `No sellers were available at or below ${normalizedPrice.toFixed(2)} ISK. ${context.bot.characterName} bought no units.`,
    };
  } catch (error) {
    const unitsAfter = countHangarUnits(context.bot.characterID, context.stationID, type.typeID);
    const balanceAfter = getCurrentBalance(context.bot.characterID);
    return {
      success: false,
      outcomeUnknown: true,
      observedBought: Math.max(0, unitsAfter - unitsBefore),
      observedSpent: Math.max(0, balanceBefore - balanceAfter),
      message: `Could not confirm whether the market completed ${context.bot.characterName}’s purchase. Check the hangar and wallet before retrying: ${getMarketAuthorityErrorMessage(error).slice(0, 180)}.`,
    };
  } finally {
    activeTradeBots.delete(botID);
  }
}

async function sell(botQuery, itemID, quantity, minimumUnitPrice, options = {}) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  if (isJitaTradeContext(context)) {
    return { success: false, message: "Playerbots do not sell in Jita; they only buy there when other systems are out of stock." };
  }

  const normalizedItemID = Math.trunc(Number(itemID));
  const normalizedPrice = normalizeIsk(minimumUnitPrice);
  if (!Number.isSafeInteger(normalizedItemID) || normalizedItemID <= 0) {
    return { success: false, message: "itemID must be a positive integer." };
  }
  if (!normalizedPrice || normalizedPrice > MAX_TRADE_UNIT_PRICE_ISK) {
    return { success: false, message: `The minimum unit price must be between 0.01 and ${MAX_TRADE_UNIT_PRICE_ISK.toLocaleString("en-US")} ISK.` };
  }

  const assetOwner = resolveTradeAssetOwner(context, options);
  if (!assetOwner.success) return assetOwner;
  const item = itemStore.findItemById(normalizedItemID);
  if (!item || Number(item.ownerID) !== assetOwner.ownerID) {
    return { success: false, message: `${context.bot.characterName} cannot sell item ${normalizedItemID} from the selected asset owner.` };
  }
  if (Number(item.locationID) !== context.stationID || Number(item.flagID) !== assetOwner.flagID) {
    return { success: false, message: `Item ${normalizedItemID} must be in the selected ${assetOwner.isCorp ? "corporation" : "personal"} hangar at ${context.stationID}.` };
  }
  const type = validateTradeType(item.typeID);
  if (!type.success) return type;
  const isShip = Number(item.categoryID) === 6 || Number(type.itemType.categoryID) === 6;
  if (isShip && options.allowShip !== true) {
    return { success: false, message: "Ship sales are not enabled by this command; use the client market to avoid accidentally selling an active ship." };
  }
  if (!assetOwner.isCorp && isShip && Number(item.itemID) === Number(playerBotSpace.getActorSession(context.bot).shipID)) {
    return { success: false, message: "The active ship cannot be sold." };
  }

  const available = Number(item.singleton) > 0
    ? 1
    : Math.max(1, Math.trunc(Number(item.stacksize ?? item.quantity) || 1));
  let requestedQuantity = quantity === null || quantity === undefined
    ? available
    : Math.trunc(Number(quantity));
  let targetOrderID = null;
  if (options.targetOrderID) {
    const order = require("./playerBotEconomyRuntime").getPlayerBuyOrder(options.targetOrderID);
    if (!order || Number(order.type_id) !== Number(type.typeID) || Number(order.station_id) !== Number(context.stationID)) {
      return { success: false, message: `Player buy order ${options.targetOrderID} is no longer open for this item at this station.` };
    }
    const orderRemaining = Math.max(0, Math.trunc(Number(order.vol_remaining) || 0));
    requestedQuantity = Math.min(requestedQuantity, orderRemaining);
    const minVolume = Math.max(1, Math.trunc(Number(order.min_volume) || 1));
    if (requestedQuantity < minVolume && !(orderRemaining < minVolume && requestedQuantity >= orderRemaining)) {
      return { success: false, message: `Player buy order ${options.targetOrderID} requires at least ${minVolume} units.` };
    }
    if (Number(order.price) + 0.0001 < Number(minimumUnitPrice)) {
      return { success: false, message: `Player buy order ${options.targetOrderID} is now below the required ${Number(minimumUnitPrice).toFixed(2)} ISK unit price.` };
    }
    targetOrderID = Number(options.targetOrderID);
    minimumUnitPrice = Number(order.price);
    normalizedPrice = normalizeIsk(order.price);
  }
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0 || requestedQuantity > available || requestedQuantity > MAX_TRADE_QUANTITY) {
    return {
      success: false,
      message: `Invalid quantity for item ${normalizedItemID}: ${available.toLocaleString("en-US")} available, maximum ${MAX_TRADE_QUANTITY.toLocaleString("en-US")} units per operation.`,
    };
  }
  const botID = Number(context.bot.characterID);
  if (activeTradeBots.has(botID)) {
    return { success: false, message: `${context.bot.characterName} already has another market operation in progress.` };
  }
  const balanceBefore = getCurrentBalance(context.bot.characterID, assetOwner);
  const unitsBefore = itemUnitCount(item);
  activeTradeBots.add(botID);
  try {
    const placedOrFilled = await getMarketProxy().Handle_PlaceMultiSellOrder(
      [[{
        typeID: type.typeID,
        stationID: context.stationID,
        price: normalizedPrice,
        quantity: requestedQuantity,
        itemID: normalizedItemID,
        ...(targetOrderID ? { targetOrderID } : {}),
      }], assetOwner.isCorp, 0, null],
      assetOwner.session,
    );
    const balanceAfter = getCurrentBalance(context.bot.characterID, assetOwner);
    const itemAfter = itemStore.findItemById(normalizedItemID);
    const unitsAfter = itemAfter &&
      Number(itemAfter.ownerID) === assetOwner.ownerID &&
      Number(itemAfter.locationID) === context.stationID &&
      Number(itemAfter.flagID) === assetOwner.flagID
      ? itemUnitCount(itemAfter)
      : 0;
    const soldQuantity = Math.max(0, unitsBefore - unitsAfter);
    const credited = Math.max(0, balanceAfter - balanceBefore);
    return {
      success: true,
      sold: soldQuantity,
      credited,
      message: placedOrFilled && soldQuantity > 0
        ? `${context.bot.characterName} sold ${soldQuantity} of ${requestedQuantity} ${type.itemType.name} from item ${normalizedItemID}, with a ${normalizedPrice.toFixed(2)} ISK floor. Net proceeds credited: ${credited.toFixed(2)} ISK.`
        : `No accessible buyers offered at least ${normalizedPrice.toFixed(2)} ISK for ${type.itemType.name}. Nothing was sold or listed.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `${context.bot.characterName}’s sale was rejected by the market: ${String(error && error.message || error).slice(0, 200)}.`,
    };
  } finally {
    activeTradeBots.delete(botID);
  }
}

// Post a standing sell order through the regular market service. Playerbot
// listing fees are waived; transaction tax still applies to filled units.
async function listSellOrder(botQuery, itemID, quantity, unitPrice, _durationDays = MAX_PLAYERBOT_SELL_ORDER_DAYS, options = {}) {
  const context = getDockedTradeContext(botQuery);
  if (!context.success) return context;
  if (isJitaTradeContext(context)) {
    return { success: false, message: "Playerbots do not place sell orders in Jita." };
  }
  const item = itemStore.findItemById(Math.trunc(Number(itemID)));
  const price = normalizeIsk(unitPrice);
  const assetOwner = resolveTradeAssetOwner(context, options);
  if (!assetOwner.success) return assetOwner;
  if (!item || Number(item.ownerID) !== assetOwner.ownerID ||
      Number(item.locationID) !== context.stationID || Number(item.flagID) !== assetOwner.flagID) {
    return { success: false, message: `Item ${itemID} is not in the selected ${assetOwner.isCorp ? "corporation" : "personal"} hangar.` };
  }
  const itemType = resolveItemByTypeID(Number(item.typeID));
  const isShip = Number(item.categoryID) === 6 || Number(itemType && itemType.categoryID) === 6;
  if (!itemType || itemType.published === false) return { success: false, message: `Item type ${item.typeID} is not a published market item.` };
  if (!assetOwner.isCorp && isShip && Number(item.itemID) === Number(playerBotSpace.getActorSession(context.bot).shipID)) {
    return { success: false, message: "The active ship cannot be listed for sale." };
  }
  if (!price || price > MAX_TRADE_UNIT_PRICE_ISK) return { success: false, message: "Invalid order price." };
  const available = itemUnitCount(item);
  const units = Math.min(available, Math.max(1, Math.trunc(Number(quantity) || available)));
  const botID = Number(context.bot.characterID);
  if (activeTradeBots.has(botID)) return { success: false, message: `${context.bot.characterName} already has another market operation in progress.` };
  const balanceBefore = getCurrentBalance(botID, assetOwner);
  const economy = require("./playerBotEconomyRuntime");
  const transactionsBefore = getMarketTransactions(assetOwner, botID);
  const baselineTransactionID = transactionsBefore.reduce((highest, entry) =>
    Math.max(highest, Number(entry.transactionID) || 0), 0);
  const beforeOrders = economy.listOpenSellOrders(assetOwner.ownerID, context.stationID, Number(item.typeID));
  if (!beforeOrders.success) return { success: false, message: `Could not read existing orders before listing: ${beforeOrders.error}.` };
  const baselineOrderIDs = new Set(beforeOrders.orders.map((order) => Number(order.order_id)));
  activeTradeBots.add(botID);
  try {
    const placedOrFilled = await getMarketProxy().Handle_PlaceMultiSellOrder(
      [[{ typeID: Number(item.typeID), stationID: context.stationID, price, quantity: units, itemID: Number(item.itemID) }],
        assetOwner.isCorp, MAX_PLAYERBOT_SELL_ORDER_DAYS, null],
      assetOwner.session,
    );
    const itemAfter = itemStore.findItemById(Number(item.itemID));
    const remaining = itemAfter && Number(itemAfter.ownerID) === assetOwner.ownerID &&
      Number(itemAfter.locationID) === context.stationID && Number(itemAfter.flagID) === assetOwner.flagID
      ? itemUnitCount(itemAfter) : 0;
    const balanceAfter = getCurrentBalance(botID, assetOwner);
    const afterTransactions = getMarketTransactions(assetOwner, botID)
      .filter((entry) => Number(entry.transactionID) > baselineTransactionID &&
        Number(entry.sellerID) === assetOwner.ownerID && Number(entry.typeID) === Number(item.typeID));
    const sold = afterTransactions.reduce((total, entry) => total + Math.max(0, Number(entry.quantity) || 0), 0);
    const jitaFillTransactions = afterTransactions.filter((entry) => isJitaStation(Number(entry.stationID)));
    const jitaFillUnits = jitaFillTransactions.reduce((total, entry) => total + Math.max(0, Number(entry.quantity) || 0), 0);
    const afterOrders = economy.listOpenSellOrders(assetOwner.ownerID, context.stationID, Number(item.typeID));
    if (!afterOrders.success) return { success: false, message: `Could not read the resulting order after listing: ${afterOrders.error}.` };
    const createdOrders = afterOrders.orders.filter((order) => !baselineOrderIDs.has(Number(order.order_id)));
    const orderUnits = createdOrders.reduce((total, order) => total + Math.max(0,
      Number(order.vol_remaining) || 0), 0);
    const moved = Math.max(0, available - remaining);
    const listed = orderUnits;
    if (moved !== listed + sold) {
      return {
        success: false,
        outcomeUnknown: true,
        listed,
        sold,
        jitaFillUnits,
        credited: Math.max(0, balanceAfter - balanceBefore),
        message: `Could not reconcile ${moved} units removed from the hangar against ${sold} sold and ${listed} remaining on new sell orders. Review the order and transaction history before retrying.`,
      };
    }
    if (!placedOrFilled && moved === 0) {
      return { success: false, message: `The market did not accept a sell order for item ${item.itemID}.` };
    }
    return {
      success: true,
      listed,
      sold,
      credited: Math.max(0, balanceAfter - balanceBefore),
      orderID: Number(createdOrders[0] && createdOrders[0].order_id) || null,
      fees: 0,
      durationDays: MAX_PLAYERBOT_SELL_ORDER_DAYS,
      jitaFillUnits,
      ...(jitaFillUnits ? { policyViolation: "legacy sale matched a Jita-located buy order" } : {}),
      message: `${context.bot.characterName} listed ${listed} ${item.typeID} at ${price.toFixed(2)} ISK for ${MAX_PLAYERBOT_SELL_ORDER_DAYS} days. Playerbot sell-order placement fees are waived; sales tax applies only when a buyer fills the order. Sold immediately: ${sold}.`,
    };
  } catch (error) {
    const detail = getMarketAuthorityErrorMessage(error);
    return { success: false, message: `The market rejected ${context.bot.characterName}’s order: ${detail.slice(0, 200)}.` };
  } finally {
    activeTradeBots.delete(botID);
  }
}

async function cancelOrder(botQuery, orderID) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  try {
    await getMarketProxy().Handle_CancelCharOrder([Math.trunc(Number(orderID))], playerBotSpace.getActorSession(bot));
    return { success: true, message: `${bot.characterName} canceled order ${orderID}.` };
  } catch (error) {
    return { success: false, message: `Could not cancel order ${orderID}: ${String(error && error.message || error).slice(0, 160)}.` };
  }
}

module.exports = {
  MAX_TRADE_BUDGET_ISK,
  MAX_PLAYERBOT_SELL_ORDER_DAYS,
  cancelOrder,
  MAX_TRADE_QUANTITY,
  buy,
  disableAutoBuyPolicy,
  disableAutoSellPolicy,
  executeAutoBuyTask,
  executeAutoSellTask,
  getQuote,
  getAutoBuyPolicy,
  isJitaStation,
  listSellOrder,
  readQuoteAt,
  readBestAskOutsideJita,
  readRegionalMarketQuote,
  getAutoSellPolicy,
  listActiveAutoBuyPolicies,
  listActiveAutoSellPolicies,
  readQuote,
  scheduleTradeTasks,
  setAutoBuyPolicy,
  setAutoSellPolicy,
  sell,
  _testing: { selectBestAskOutsideJita, stationIsInJita, isJitaTradeContext },
};

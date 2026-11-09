"use strict";

// Where the playerbot economy trades. Jita holds the only seeded market:
// bots buy there only when the accessible regional market has no non-Jita
// stock, and never sell there.
// Their own market forms at the bot hub, one jump away, from what they mine,
// build and list. Player buy orders anywhere are read from the market
// database (read-only) so bots can fill them by courier or manufacture.

const path = require("path");

const JITA_SYSTEM_ID = 30000142;
// Jita IV - Moon 4: canonical seed station and fallback if its offer is out.
const JITA_BUY_STATION_ID = 60003760;
// New Caldari II - Kaalakiota Corporation Factory: factory, belts in system,
// 0.95 security, one jump from Jita.
const BOT_HUB_STATION_ID = 60014935;

let marketDatabase = null;
const MARKET_SUPPLY_CACHE_MS = 30_000;
const MARKET_SUPPLY_CACHE_MAX_ENTRIES = 256;
const marketSupplyCache = new Map();
const marketSupplyRegionQueryCache = new WeakMap();
let marketSupplyRegionIDs = null;

function readMarketSupplyCache(cache, typeID, now = Date.now()) {
  const entry = cache.get(typeID);
  if (!entry) return null;
  if (now - entry.readAt >= MARKET_SUPPLY_CACHE_MS) {
    cache.delete(typeID);
    return null;
  }
  // Map insertion order is the LRU order: most recently used is last.
  cache.delete(typeID);
  cache.set(typeID, entry);
  return entry.offers;
}

function writeMarketSupplyCache(cache, typeID, offers, readAt = Date.now()) {
  cache.delete(typeID);
  while (cache.size >= MARKET_SUPPLY_CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(typeID, { readAt, offers });
}

function openMarketDatabase() {
  if (marketDatabase) return marketDatabase;
  const { DatabaseSync } = require("node:sqlite");
  const root = process.env.EVEJS_DATA_ROOT || "/var/lib/evejs";
  marketDatabase = new DatabaseSync(path.join(root, "market", "market.sqlite"), { readOnly: true });
  return marketDatabase;
}

function getMarketSupplyRegionIDs() {
  if (marketSupplyRegionIDs) return marketSupplyRegionIDs;
  const systems = require("../../space/worldData").getSolarSystems();
  marketSupplyRegionIDs = [...new Set([
    0,
    ...systems.map((system) => Math.trunc(Number(system.regionID) || 0)).filter((regionID) => regionID > 0),
  ])].sort((left, right) => left - right);
  return marketSupplyRegionIDs;
}

function buildSellOffersQuery(regionIDs) {
  const regions = [...new Set((Array.isArray(regionIDs) ? regionIDs : [])
    .map((regionID) => Math.trunc(Number(regionID)))
    .filter((regionID) => Number.isSafeInteger(regionID) && regionID >= 0))];
  if (!regions.length) {
    return {
      sql: "SELECT station_id AS stationID, solar_system_id AS solarSystemID, region_id AS regionID, " +
        "type_id AS typeID, price, quantity, 0 AS ownerID FROM seed_stock WHERE type_id = ? AND quantity > 0 " +
        "UNION ALL " +
        "SELECT station_id AS stationID, solar_system_id AS solarSystemID, region_id AS regionID, " +
        "type_id AS typeID, price, vol_remaining AS quantity, owner_id AS ownerID FROM market_orders " +
        "WHERE type_id = ? AND bid = 0 AND state = 'open' AND vol_remaining > 0",
      regions,
    };
  }
  const placeholders = regions.map(() => "?").join(",");
  return {
    sql: "SELECT station_id AS stationID, solar_system_id AS solarSystemID, region_id AS regionID, " +
      "type_id AS typeID, price, quantity, 0 AS ownerID FROM seed_stock " +
      `WHERE region_id IN (${placeholders}) AND type_id = ? AND quantity > 0 ` +
      "UNION ALL " +
      "SELECT station_id AS stationID, solar_system_id AS solarSystemID, region_id AS regionID, " +
      "type_id AS typeID, price, vol_remaining AS quantity, owner_id AS ownerID FROM market_orders " +
      `WHERE region_id IN (${placeholders}) AND type_id = ? AND bid = 0 AND state = 'open' AND vol_remaining > 0`,
    regions,
  };
}

function querySellOffers(database, typeID, regionIDs) {
  const numericTypeID = Math.trunc(Number(typeID)) || 0;
  if (!database || !numericTypeID) return [];
  const { sql, regions } = buildSellOffersQuery(regionIDs);
  const cacheKey = regions.join(",");
  let cached = marketSupplyRegionQueryCache.get(database);
  if (!cached || cached.key !== cacheKey) {
    cached = { key: cacheKey, statement: database.prepare(sql) };
    marketSupplyRegionQueryCache.set(database, cached);
  }
  const parameters = regions.length
    ? [...regions, numericTypeID, ...regions, numericTypeID]
    : [numericTypeID, numericTypeID];
  return cached.statement.all(...parameters).map((row) => ({
    stationID: Number(row.stationID) || 0,
    solarSystemID: Number(row.solarSystemID) || 0,
    regionID: Number(row.regionID) || 0,
    typeID: Number(row.typeID) || 0,
    price: Number(row.price) || 0,
    quantity: Number(row.quantity) || 0,
    ownerID: Number(row.ownerID) || 0,
  })).filter((row) => row.stationID && row.price > 0 && row.quantity > 0);
}

function getBotOwnerIDs() {
  const bots = require("./playerBotRuntime").listBots();
  const owners = new Set();
  for (const bot of bots) {
    const characterID = Number(bot.characterID) || 0;
    const corporationID = Number(bot.specialtyCorporationID) || 0;
    const currentCorporationID = Number(bot.corporationID) || 0;
    if (characterID > 0) owners.add(characterID);
    if (corporationID > 0) owners.add(corporationID);
    if (currentCorporationID > 0) owners.add(currentCorporationID);
  }
  return owners;
}

function isJitaStation(stationID) {
  const worldData = require("../../space/worldData");
  const station = worldData.getStationByID(Number(stationID));
  if (Number(station && station.solarSystemID) === JITA_SYSTEM_ID) return true;
  try {
    const structure = worldData.getStructureByID(Number(stationID));
    return Number(structure && structure.solarSystemID) === JITA_SYSTEM_ID;
  } catch (_) {
    return false;
  }
}

// Open buy orders placed by players (not bots) outside Jita.
function listPlayerBuyOrders(limit = 50, typeID = null, regionID = null) {
  try {
    const normalizedLimit = Math.max(1, Math.trunc(Number(limit) || 50));
    const normalizedTypeID = Math.trunc(Number(typeID)) || 0;
    const normalizedRegionID = Math.trunc(Number(regionID)) || 0;
    const typeClause = normalizedTypeID > 0 ? " AND type_id = ?" : "";
    const regionClause = normalizedRegionID > 0 ? " AND region_id = ?" : "";
    const botOwners = [...getBotOwnerIDs()];
    const ownerClause = botOwners.length ? ` AND owner_id NOT IN (${botOwners.map(() => "?").join(",")})` : "";
    const parameters = normalizedTypeID > 0
      ? [JITA_SYSTEM_ID, normalizedTypeID, ...(normalizedRegionID ? [normalizedRegionID] : []), ...botOwners, normalizedLimit]
      : [JITA_SYSTEM_ID, ...(normalizedRegionID ? [normalizedRegionID] : []), ...botOwners, normalizedLimit];
    const rows = openMarketDatabase().prepare(
      "SELECT order_id, owner_id, is_corp, station_id, solar_system_id, region_id, type_id, price, vol_remaining, min_volume " +
      "FROM market_orders WHERE bid = 1 AND state = 'open' AND vol_remaining > 0 AND solar_system_id != ? " +
      typeClause + regionClause + ownerClause + " ORDER BY price DESC, issued_at LIMIT ?",
    ).all(...parameters);
    return rows;
  } catch (error) {
    return [];
  }
}

// Read-only supply used to plan a bot's shopping destination. The trade
// authority still validates the live order when a purchase is submitted; this
// query prevents a pilot from routing to a hub that does not stock its kit.
function listSellOffers(typeID) {
  const numericTypeID = Math.trunc(Number(typeID)) || 0;
  if (!numericTypeID) return [];
  const cached = readMarketSupplyCache(marketSupplyCache, numericTypeID);
  if (cached) return cached;
  try {
    // Market indexes lead with region_id. A type-only scan walks the complete
    // universe-wide seed_stock table for every cold cache entry; querying the
    // same regions present in static space data gives SQLite one bounded index
    // lookup per region while preserving global offer visibility.
    const offers = querySellOffers(openMarketDatabase(), numericTypeID, getMarketSupplyRegionIDs());
    writeMarketSupplyCache(marketSupplyCache, numericTypeID, offers);
    return offers;
  } catch (_) {
    return [];
  }
}

function getListingReferencePrice(options = {}) {
  const targetStationID = Math.trunc(Number(options.stationID)) || 0;
  const targetRegionID = Math.trunc(Number(options.regionID)) || 0;
  const botOwners = options.botOwnerIDs instanceof Set
    ? options.botOwnerIDs
    : new Set(Array.isArray(options.botOwnerIDs) ? options.botOwnerIDs.map(Number) : []);
  const stationIsJita = typeof options.stationIsJita === "function"
    ? options.stationIsJita
    : isJitaStation;
  const eligible = (offer) => {
    const stationID = Math.trunc(Number(offer && offer.stationID)) || 0;
    const regionID = Math.trunc(Number(offer && offer.regionID)) || 0;
    const ownerID = Math.trunc(Number(offer && offer.ownerID)) || 0;
    return stationID > 0 && Number(offer && offer.price) > 0 && Number(offer && offer.quantity) > 0 &&
      !botOwners.has(ownerID) && !stationIsJita(stationID) &&
      (!targetRegionID || !regionID || regionID === targetRegionID);
  };
  const asks = (Array.isArray(options.asks) ? options.asks : []).filter(eligible);
  const bids = (Array.isArray(options.bids) ? options.bids : []).filter(eligible);
  const localAsks = asks.filter((offer) => Number(offer.stationID) === targetStationID);
  const ask = (localAsks.length ? localAsks : asks)
    .sort((left, right) => Number(left.price) - Number(right.price))[0];
  if (ask) return { price: Number(ask.price), side: "ask", stationID: Number(ask.stationID) };

  const localBids = bids.filter((offer) => Number(offer.stationID) === targetStationID);
  const bid = (localBids.length ? localBids : bids)
    .sort((left, right) => Number(right.price) - Number(left.price))[0];
  if (bid) return { price: Number(bid.price), side: "bid", stationID: Number(bid.stationID) };

  const fallbackBid = Number(options.fallbackBid) || 0;
  if (fallbackBid > 0) return { price: fallbackBid, side: "fallback-bid", stationID: targetStationID };
  const basePrice = Number(options.basePrice) || 0;
  if (basePrice > 0) return { price: basePrice, side: "base", stationID: targetStationID };
  return null;
}

function scoreSellStationsForPackage(needs, offersByType, stationIsJita = isJitaStation) {
  const normalizedNeeds = (Array.isArray(needs) ? needs : [])
    .map((need) => ({
      typeID: Math.trunc(Number(need && need.typeID)) || 0,
      quantity: Math.max(1, Math.trunc(Number(need && need.quantity)) || 1),
    }))
    .filter((need) => need.typeID > 0);
  const stations = new Map();
  for (const need of normalizedNeeds) {
    const offers = offersByType instanceof Map
      ? offersByType.get(need.typeID)
      : offersByType && offersByType[need.typeID];
    const byStation = new Map();
    for (const offer of Array.isArray(offers) ? offers : []) {
      const stationID = Number(offer && offer.stationID) || 0;
      const quantity = Number(offer && offer.quantity) || 0;
      const price = Number(offer && offer.price) || 0;
      if (!stationID || quantity <= 0 || price <= 0) continue;
      if (!byStation.has(stationID)) byStation.set(stationID, []);
      byStation.get(stationID).push({ quantity, price });
    }
    for (const [stationID, stationOffers] of byStation) {
      let remaining = need.quantity;
      let cost = 0;
      let available = 0;
      for (const offer of stationOffers.sort((left, right) => left.price - right.price)) {
        const quantity = Math.min(remaining, offer.quantity);
        if (quantity <= 0) break;
        cost += quantity * offer.price;
        remaining -= quantity;
        available += quantity;
      }
      const entry = stations.get(stationID) || {
        stationID,
        coverage: 0,
        completeTypes: 0,
        totalTypes: normalizedNeeds.length,
        estimatedCost: 0,
        isJita: Boolean(stationIsJita(stationID)),
      };
      entry.coverage += Math.min(available, need.quantity);
      entry.completeTypes += remaining <= 0 ? 1 : 0;
      entry.estimatedCost += cost;
      stations.set(stationID, entry);
    }
  }
  const totalUnits = normalizedNeeds.reduce((sum, need) => sum + need.quantity, 0);
  return [...stations.values()].map((entry) => ({
    ...entry,
    totalUnits,
    complete: entry.completeTypes === entry.totalTypes,
  })).sort((left, right) =>
    Number(right.complete) - Number(left.complete) ||
    Number(left.isJita) - Number(right.isJita) ||
    right.coverage - left.coverage ||
    left.estimatedCost - right.estimatedCost ||
    left.stationID - right.stationID);
}

function findSellStationsForPackage(needs) {
  const typeIDs = [...new Set((Array.isArray(needs) ? needs : [])
    .map((need) => Math.trunc(Number(need && need.typeID)) || 0).filter(Boolean))];
  const offersByType = new Map(typeIDs.map((typeID) => [typeID, listSellOffers(typeID)]));
  return scoreSellStationsForPackage(needs, offersByType);
}

function selectBestJitaSeedStation(needs, offersByType, stationIsJita = isJitaStation, excludedStationIDs = []) {
  const normalizedNeeds = (Array.isArray(needs) ? needs : []).map((need) => ({
    ...need,
    // Industry plans use `quantity`; single-item runtime requests may use
    // `units`. Preserve the requested amount when ranking seeded stations.
    quantity: need && need.quantity !== undefined ? need.quantity : need && need.units,
  }));
  const excluded = new Set((Array.isArray(excludedStationIDs) ? excludedStationIDs : [])
    .map((stationID) => Math.trunc(Number(stationID)) || 0).filter(Boolean));
  const candidates = scoreSellStationsForPackage(normalizedNeeds, offersByType, stationIsJita)
    .filter((candidate) => candidate.isJita && !excluded.has(Number(candidate.stationID)));
  candidates.sort((left, right) =>
    Number(right.complete) - Number(left.complete) ||
    right.coverage - left.coverage ||
    left.estimatedCost - right.estimatedCost ||
    left.stationID - right.stationID);
  return candidates[0] || null;
}

// The supported Jita seed preset stocks all 18 NPC stations in the Jita
// system. A bot must be able to fall through to another one when its canonical
// station has been bought out, while still checking non-Jita regional supply
// first at the caller.
function findBestJitaSeedStation(needs, excludedStationIDs = []) {
  const typeIDs = [...new Set((Array.isArray(needs) ? needs : [])
    .map((need) => Math.trunc(Number(need && need.typeID)) || 0).filter(Boolean))];
  const offersByType = new Map(typeIDs.map((typeID) => [typeID, listSellOffers(typeID)]));
  const candidate = selectBestJitaSeedStation(needs, offersByType, isJitaStation, excludedStationIDs);
  return candidate ? Number(candidate.stationID) : 0;
}

// Open sell orders bots still have in Jita (left from before the rule).
function listBotSellOrdersInJita() {
  try {
    const rows = openMarketDatabase().prepare(
      "SELECT order_id, owner_id, station_id, type_id, vol_remaining FROM market_orders " +
      "WHERE bid = 0 AND state = 'open' AND solar_system_id = ?",
    ).all(JITA_SYSTEM_ID);
    // Cleanup may only cancel orders owned by bot characters. A bot can be a
    // member of a human-led corporation; its corporation's orders belong to
    // that corporation and must never be treated as bot-owned cleanup work.
    const bots = new Set(require("./playerBotRuntime").listBots()
      .map((bot) => Number(bot.characterID) || 0)
      .filter((characterID) => characterID > 0));
    return rows.filter((row) => bots.has(Number(row.owner_id)));
  } catch (error) {
    return [];
  }
}

// Snapshot the owner's open orders for durable listing reconciliation.
function listOpenSellOrders(ownerID, stationID, typeID) {
  try {
    const orders = openMarketDatabase().prepare(
      "SELECT order_id, owner_id, station_id, type_id, price, vol_entered, vol_remaining, updated_at " +
      "FROM market_orders WHERE owner_id = ? AND station_id = ? AND type_id = ? AND bid = 0 AND state = 'open'",
    ).all(Number(ownerID), Number(stationID), Number(typeID));
    return { success: true, orders };
  } catch (error) {
    return { success: false, error: String(error && error.message || error).slice(0, 160) };
  }
}

function getOpenOrder(orderID) {
  try {
    return openMarketDatabase().prepare(
      "SELECT order_id, owner_id, station_id, type_id, price, vol_remaining, bid, state FROM market_orders WHERE order_id = ?",
    ).get(Number(orderID)) || null;
  } catch (error) {
    return null;
  }
}

function getPlayerBuyOrder(orderID) {
  try {
    const row = openMarketDatabase().prepare(
      "SELECT order_id, owner_id, is_corp, station_id, solar_system_id, region_id, type_id, price, vol_remaining, min_volume, bid, state " +
      "FROM market_orders WHERE order_id = ?",
    ).get(Number(orderID));
    if (!row || Number(row.bid) !== 1 || row.state !== "open" || Number(row.vol_remaining) <= 0 ||
        Number(row.solar_system_id) === JITA_SYSTEM_ID || getBotOwnerIDs().has(Number(row.owner_id))) return null;
    return row;
  } catch (_) {
    return null;
  }
}

module.exports = {
  BOT_HUB_STATION_ID,
  JITA_BUY_STATION_ID,
  JITA_SYSTEM_ID,
  getOpenOrder,
  getPlayerBuyOrder,
  isJitaStation,
  findSellStationsForPackage,
  findBestJitaSeedStation,
  listSellOffers,
  listBotSellOrdersInJita,
  listOpenSellOrders,
  listPlayerBuyOrders,
  getBotOwnerIDs,
  getListingReferencePrice,
  _testing: {
    scoreSellStationsForPackage,
    selectBestJitaSeedStation,
    getListingReferencePrice,
    readMarketSupplyCache,
    writeMarketSupplyCache,
    getMarketSupplyRegionIDs,
    buildSellOffersQuery,
    querySellOffers,
    MARKET_SUPPLY_CACHE_MAX_ENTRIES,
    MARKET_SUPPLY_CACHE_MS,
  },
};

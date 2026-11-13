"use strict";

// Trade pilots keep real market orders where they work, so the market
// outside Jita has visible bids and asks made by the bots themselves. A
// trader docked at a station outside Jita keeps one standing buy order per
// mineral there, paid from its own wallet into market escrow, and lists what
// those orders bought at the Jita price. Miners and other pilots
// sell into those bids through the normal market. Nothing is created: every
// order is placed and filled by the EveJS market authority.

const MINERAL_TYPE_IDS = Object.freeze([34, 35, 36, 37, 38, 39, 40]);
// Miners sell into a bid only when it is at least 90% of the local ask
// (SELL_TO_BID_RATIO in playerBotOperationRuntime), so the trader's own ask
// at the Jita price keeps its 90% bid acceptable.
const BID_RATIO = 0.9;
const ASK_RATIO = 1.0;
const ORDER_DAYS = 14;
const MAX_TRADERS_PER_PASS = 8;
const MAX_ORDERS_PER_TRADER = MINERAL_TYPE_IDS.length;
const MAX_ESCROW_SHARE = 0.25;
const MAX_ORDER_ISK = 25_000_000;
const MIN_ORDER_ISK = 50_000;
const WALLET_RESERVE_ISK = 20_000_000;

function enabled(env = process.env) {
  return String(env.EVEJS_PLAYER_BOTS_MARKET_MAKING ?? "1").trim() !== "0";
}

function roundIsk(value) {
  return Math.round(Number(value) * 100) / 100;
}

// How many units to bid for, given the wallet and what is already in escrow.
function planBid(referencePrice, balance, escrowed) {
  const price = roundIsk(referencePrice * BID_RATIO);
  if (!(price > 0)) return null;
  const spendable = Math.min(
    MAX_ORDER_ISK,
    Math.max(0, balance - WALLET_RESERVE_ISK),
    Math.max(0, (balance + escrowed) * MAX_ESCROW_SHARE - escrowed),
  );
  if (spendable < MIN_ORDER_ISK) return null;
  const units = Math.floor(spendable / price);
  return units > 0 ? { price, units } : null;
}

function defaultDeps() {
  return {
    playerBots: () => require("./playerBotRuntime"),
    trade: () => require("./playerBotTradeRuntime"),
    economy: () => require("./playerBotEconomyRuntime"),
    inventory: () => require("./playerBotInventoryRuntime"),
    operations: () => require("./playerBotOperationRuntime"),
    space: () => require("./playerBotSpaceRuntime"),
    wallet: () => require("../account/walletState"),
  };
}

let cursor = 0;

// One pass over a few docked traders. Returns counts for the cycle summary.
async function runMarketMakerPass(bots, deps = defaultDeps()) {
  const summary = { traders: 0, buyOrdersPlaced: 0, unitsListed: 0, failures: 0 };
  if (!enabled()) return summary;
  const economy = deps.economy();
  const traders = (bots || []).filter((bot) => bot && bot.specialty === "trade" &&
    bot.status !== "paused" && bot.autonomyPaused !== true);
  if (!traders.length) return summary;
  const start = cursor % traders.length;
  const slice = [...traders.slice(start), ...traders.slice(0, start)].slice(0, MAX_TRADERS_PER_PASS);
  cursor = (start + slice.length) % Math.max(1, traders.length);
  for (const bot of slice) {
    try {
      const operation = deps.operations().getOperation(bot.characterID);
      // Leave pilots alone while they travel or settle another market action.
      if (operation && ["active", "holding"].includes(operation.status) && operation.stage !== "done") continue;
      const session = deps.space().getActorSession(bot);
      const stationID = Number(session && (session.stationID || session.structureID)) || 0;
      if (!stationID || economy.isJitaStation(stationID)) continue;
      summary.traders += 1;
      await listBoughtStock(bot, stationID, deps, summary);
      await keepBids(bot, stationID, deps, summary);
    } catch (error) {
      summary.failures += 1;
      summary.lastError = String(error && error.message || error).slice(0, 180);
    }
  }
  return summary;
}

async function keepBids(bot, stationID, deps, summary) {
  const economy = deps.economy();
  const own = economy.listOpenBuyOrders(bot.characterID);
  if (!own.success) return;
  if (own.orders.length >= MAX_ORDERS_PER_TRADER) return;
  const escrowed = own.orders.reduce((total, order) => total + (Number(order.escrow) || 0), 0);
  const covered = new Set(own.orders.filter((order) => Number(order.station_id) === stationID)
    .map((order) => Number(order.type_id)));
  for (const typeID of MINERAL_TYPE_IDS) {
    if (covered.has(typeID)) continue;
    const reference = economy.getJitaReferencePrice(typeID);
    if (!reference) continue;
    const balance = Number(deps.wallet().getCharacterWallet(bot.characterID)?.balance) || 0;
    const plan = planBid(reference, balance, escrowed);
    if (!plan) return;
    const result = await deps.trade().placeBuyOrder(bot.characterName, typeID, plan.units, plan.price, ORDER_DAYS);
    if (result.success) {
      summary.buyOrdersPlaced += 1;
      // One new order per trader per pass keeps escrow growth gradual.
      return;
    }
    summary.failures += 1;
    summary.lastError = String(result.message || "").slice(0, 180);
    return;
  }
}

async function listBoughtStock(bot, stationID, deps, summary) {
  const economy = deps.economy();
  const inventory = deps.inventory();
  for (const stack of inventory.listHangar(bot, stationID) || []) {
    const typeID = Number(stack.typeID);
    if (!MINERAL_TYPE_IDS.includes(typeID)) continue;
    const reference = economy.getJitaReferencePrice(typeID);
    if (!reference) continue;
    const result = await deps.trade().listSellOrder(bot.characterName, stack.itemID, null, roundIsk(reference * ASK_RATIO), ORDER_DAYS);
    if (result.success) summary.unitsListed += Number(result.listed || 0) + Number(result.sold || 0);
    else {
      summary.failures += 1;
      summary.lastError = String(result.message || "").slice(0, 180);
    }
  }
}

module.exports = {
  ASK_RATIO,
  BID_RATIO,
  MINERAL_TYPE_IDS,
  enabled,
  planBid,
  runMarketMakerPass,
  _testing: { resetCursor: () => { cursor = 0; } },
};

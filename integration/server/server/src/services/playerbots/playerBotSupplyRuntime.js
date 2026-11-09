"use strict";

// Supply from resource bots to industry bots. A miner docked at a market
// station looks for industry cycles there waiting on materials it holds and
// offers them in a private item-exchange contract assigned to that industry
// bot, priced just under the local ask (or a reference price when the market
// has run dry). The industry bot accepts it with its own ISK through the
// regular contract authority, so items and ISK move with normal settlement.

const log = require("../../utils/logger");

const CONTRACT_TYPE_ITEM_EXCHANGE = 1;
const SUPPLY_DISCOUNT = 0.95;
const NO_ASK_MARKUP_OVER_BID = 1.1;

function getInventory() {
  return require("./playerBotInventoryRuntime");
}

function resolveBotByID(characterID) {
  return require("./playerBotRuntime").listBots().find((bot) => Number(bot.characterID) === Number(characterID)) || null;
}

// Materials each waiting cycle at the station still lacks.
function listMaterialDemand(stationID) {
  const cycles = require("./playerBotIndustryCycleRuntime").listActiveCycles()
    .filter((cycle) => Number(cycle.stationID) === Number(stationID) && cycle.stage === "acquire-materials");
  const demand = [];
  for (const cycle of cycles) {
    const buyer = resolveBotByID(cycle.characterID);
    if (!buyer) continue;
    const context = require("./playerBotIndustryRuntime").getManufacturingContext(buyer, cycle.blueprintItemID, cycle.runs);
    const quote = context.quoteResult && context.quoteResult.quote;
    if (!quote || !Array.isArray(quote.materials)) continue;
    const available = quote.availableMaterials || {};
    for (const material of quote.materials) {
      const deficit = Math.max(0, Number(material.quantity) - (Number(available[material.typeID]) || 0));
      if (deficit > 0) demand.push({ cycle, buyer, typeID: Number(material.typeID), deficit });
    }
  }
  return demand;
}

async function referenceUnitPrice(seller, typeID) {
  const quote = await require("./playerBotTradeRuntime").readQuote(seller.characterName, typeID);
  if (quote.success && quote.bestAsk) return Math.round(quote.bestAsk.price * SUPPLY_DISCOUNT * 100) / 100;
  if (quote.success && quote.bestBid) return Math.round(quote.bestBid.price * NO_ASK_MARKUP_OVER_BID * 100) / 100;
  const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(typeID);
  return Math.max(0.01, Math.round((Number(type && type.basePrice) || 1) * 100) / 100);
}

function findCreatedContractID(result) {
  return Number(result && (result.contractIDs?.[0] ?? result.data?.contractID ?? result.contractID)) || 0;
}

// Offer the seller's matching stock to waiting industry bots. Returns totals.
async function supplyIndustryBots(seller, stationID) {
  const summary = { contracts: 0, units: 0, proceeds: 0, notes: [] };
  const inventory = getInventory();
  const contracts = require("../contracts/contractRuntimeState");
  const space = require("./playerBotSpaceRuntime");
  for (const need of listMaterialDemand(stationID)) {
    if (Number(need.buyer.characterID) === Number(seller.characterID)) continue;
    const stack = inventory.listHangar(seller, stationID, need.typeID)
      .sort((left, right) => inventory.unitsOf(right) - inventory.unitsOf(left))[0];
    if (!stack) continue;
    const unitPrice = await referenceUnitPrice(seller, need.typeID);
    const cycles = require("./playerBotIndustryCycleRuntime");
    const reservation = cycles.beginSupplyPurchase(need.buyer.characterID, need.cycle.cycleID, stationID, need.typeID,
      Math.min(inventory.unitsOf(stack), need.deficit), unitPrice, seller.characterID);
    if (!reservation.success) continue;
    const { units, price, token } = reservation;
    let balanceBefore = 0;
    let contractID = null;
    let confirmed = false;
    try {
      balanceBefore = Number(require("../account/walletState").getCharacterWallet(seller.characterID)?.balance) || 0;
      const created = await contracts.createContract({
        contractType: CONTRACT_TYPE_ITEM_EXCHANGE,
        isPrivate: true,
        assignedToID: Number(need.buyer.characterID),
        minutesExpire: 60,
        startStationID: Number(stationID),
        price,
        title: `Material supply ${need.typeID} for ${need.cycle.cycleID}`.slice(0, 200),
        itemList: [[Number(stack.itemID), units]],
      }, space.getActorSession(seller));
      if (!created || created.success !== true || created.rejected === true) throw new Error(created && created.errorMsg || "CONTRACT_CREATE_FAILED");
      contractID = findCreatedContractID(created);
      if (!contractID) throw new Error("CONTRACT_ID_NOT_FOUND");
      const accepted = await contracts.acceptContract(contractID, space.getActorSession(need.buyer), false);
      confirmed = Boolean(accepted && Number(accepted.status) === 4 && Number(accepted.acceptorID) === Number(need.buyer.characterID));
      if (!confirmed) throw new Error("CONTRACT_ACCEPTANCE_UNCONFIRMED");
    } catch (error) {
      summary.notes.push(`${need.typeID}→${need.buyer.characterName}: ${String(error && error.message || error).slice(0, 120)}`);
    }
    const settled = cycles.finishSupplyPurchase(need.buyer.characterID, token, { confirmed, contractID, sellerName: seller.characterName });
    if (!settled.success) continue;
    const received = Math.max(0, (Number(require("../account/walletState").getCharacterWallet(seller.characterID)?.balance) || 0) - balanceBefore);
    summary.contracts += 1;
    summary.units += settled.units;
    summary.proceeds = Math.round((summary.proceeds + received) * 100) / 100;
    log.info(`[PlayerBots] Supply contract ${contractID}: ${seller.characterID} -> ${need.buyer.characterID} ${settled.units}x${need.typeID} for ${settled.spent.toFixed(2)} ISK.`);
  }
  return summary;
}

module.exports = {
  listMaterialDemand,
  supplyIndustryBots,
};

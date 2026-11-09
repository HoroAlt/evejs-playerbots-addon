"use strict";

// Alliance courier work uses only contracts assigned to this character,
// corporation or alliance. The contract service still owns collateral,
// package custody, reward escrow, completion and failure rules.

const MAX_COURIER_COLLATERAL_ISK = 50_000_000;
const MAX_COURIER_ROUTE_HOPS = 48;

function positiveID(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function isAssignedCourierContract(contract, identity = {}) {
  if (!contract || Number(contract.type) !== 3 || Number(contract.status) !== 0) return false;
  const characterID = positiveID(identity.characterID);
  const corporationID = positiveID(identity.corporationID);
  const allianceID = positiveID(identity.allianceID);
  const assigneeID = positiveID(contract.assigneeID);
  return Boolean(assigneeID && [characterID, corporationID, allianceID].includes(assigneeID));
}

function getBotIdentity(bot) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  return {
    characterID: positiveID(bot.characterID),
    corporationID,
    allianceID: positiveID(corporation.allianceID || character.allianceID),
  };
}

function routeForCourier(contract) {
  const worldData = require("../../space/worldData");
  const source = worldData.getStationByID(Number(contract.startStationID)) || worldData.getStructureByID(Number(contract.startStationID));
  const destination = worldData.getStationByID(Number(contract.endStationID)) || worldData.getStructureByID(Number(contract.endStationID));
  const sourceSystemID = positiveID(source && source.solarSystemID || contract.startSolarSystemID);
  const destinationSystemID = positiveID(destination && destination.solarSystemID || contract.endSolarSystemID);
  if (!sourceSystemID || !destinationSystemID) return { success: false, reason: "Contract endpoints must be solar-system stations." };
  const route = require("./playerBotSpaceRuntime").findStargateRoute(sourceSystemID, destinationSystemID);
  if (!route.success) return { success: false, reason: route.message || "No stargate route connects the contract endpoints." };
  const hops = Array.isArray(route.gates) ? route.gates.length : 0;
  if (hops > MAX_COURIER_ROUTE_HOPS) return { success: false, reason: `The ${hops}-jump courier route exceeds the ${MAX_COURIER_ROUTE_HOPS}-jump safety limit.` };
  return { success: true, sourceSystemID, destinationSystemID, hops, risk: route.risk || null };
}

function inspectAssignedCourier(bot, contractID = null) {
  const contractRuntime = require("../contracts/contractRuntimeState");
  const identity = getBotIdentity(bot);
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const candidates = contractID
    ? [contractRuntime.getContractRecord(positiveID(contractID))].filter(Boolean)
    : contractRuntime.searchContracts(session, { availability: null, contractType: 3 }).contracts;
  const available = candidates
    .filter((contract) => isAssignedCourierContract(contract, identity))
    .filter((contract) => contractRuntime.canViewContract(contract, session) &&
      contractRuntime.canAcceptContract(contract, session) &&
      !contractRuntime.isContractExpired(contract))
    .map((contract) => ({ contract, route: routeForCourier(contract) }))
    .filter((entry) => entry.route.success)
    .sort((left, right) => left.route.hops - right.route.hops ||
      Number(right.contract.reward || 0) - Number(left.contract.reward || 0) ||
      positiveID(left.contract.contractID) - positiveID(right.contract.contractID));
  return available[0] || null;
}

function findAssignedCourier(bot) {
  return inspectAssignedCourier(bot);
}

async function postAssignedCourier(issuerQuery, carrierQuery, startStationID, endStationID, itemID, quantity, reward, collateral) {
  const bots = require("./playerBotRuntime");
  const issuer = bots.resolveBot(issuerQuery);
  const carrier = bots.resolveBot(carrierQuery);
  if (!issuer || !carrier) return { success: false, message: "The courier issuer and carrier must each resolve to one playerbot." };
  if (Number(issuer.characterID) === Number(carrier.characterID)) return { success: false, message: "The contract issuer and courier carrier must be different bots." };
  const issuerIdentity = getBotIdentity(issuer);
  const carrierIdentity = getBotIdentity(carrier);
  const sameCorp = issuerIdentity.corporationID > 0 && issuerIdentity.corporationID === carrierIdentity.corporationID;
  const sameAlliance = issuerIdentity.allianceID > 0 && issuerIdentity.allianceID === carrierIdentity.allianceID;
  if (!sameCorp && !sameAlliance) return { success: false, message: "Private bot courier contracts may only be assigned within the same corporation or alliance." };

  const world = require("../../space/worldData");
  const startID = positiveID(startStationID);
  const endID = positiveID(endStationID);
  const itemStore = require("../inventory/itemStore");
  const item = itemStore.findItemById(positiveID(itemID));
  const units = Math.max(1, Math.trunc(Number(quantity) || 0));
  if (!startID || !endID || startID === endID ||
      !(world.getStationByID(startID) || world.getStructureByID(startID)) ||
      !(world.getStationByID(endID) || world.getStructureByID(endID))) {
    return { success: false, message: "Courier endpoints must be two different existing stations or structures." };
  }
  const itemFlags = itemStore.ITEM_FLAGS;
  if (!item || Number(item.ownerID) !== Number(issuer.characterID) || Number(item.locationID) !== startID || Number(item.flagID) !== itemFlags.HANGAR) {
    return { success: false, message: `Item ${itemID} must be in ${issuer.characterName}'s personal hangar at station ${startID}.` };
  }
  const inventory = require("./playerBotInventoryRuntime");
  if (units > inventory.unitsOf(item)) return { success: false, message: `Item ${itemID} has only ${inventory.unitsOf(item)} unit(s) available.` };
  const volume = inventory.getUnitVolume(item) * units;
  if (!Number.isFinite(volume) || volume <= 0 || volume > 1_200_000) {
    return { success: false, message: `Courier package volume ${Number(volume || 0).toFixed(2)} m³ is outside the supported 0–1,200,000 m³ range.` };
  }
  const route = routeForCourier({ startStationID: startID, endStationID: endID });
  if (!route.success) return { success: false, message: route.reason };
  const rewardISK = Math.max(0, Number(reward) || 0);
  const collateralISK = Math.max(0, Number(collateral) || 0);
  if (rewardISK > 50_000_000 || collateralISK > MAX_COURIER_COLLATERAL_ISK) {
    return { success: false, message: `Courier reward is capped at 50,000,000.00 ISK and collateral at ${MAX_COURIER_COLLATERAL_ISK.toFixed(2)} ISK.` };
  }
  const space = require("./playerBotSpaceRuntime");
  let created;
  try {
    created = await require("../contracts/contractRuntimeState").createContract({
      contractType: 3,
      isPrivate: true,
      assignedToID: Number(carrier.characterID),
      minutesExpire: 7 * 24 * 60,
      numDays: 1,
      startStationID: startID,
      destinationID: endID,
      reward: rewardISK,
      collateral: collateralISK,
      title: `Bot logistics ${issuer.characterName} to ${carrier.characterName}`.slice(0, 200),
      description: `Assigned private courier route (${route.hops} jumps).`,
      itemList: [[Number(item.itemID), units]],
      forCorp: false,
      startStationDivision: itemFlags.HANGAR,
    }, space.getActorSession(issuer));
  } catch (error) {
    return { success: false, message: `The contract authority rejected the courier request: ${space.describeError(error)}.` };
  }
  if (!created || created.success !== true || created.rejected === true) {
    return { success: false, message: `The contract authority did not publish the courier contract: ${created && created.errorMsg || "settlement pending"}.` };
  }
  const contractID = positiveID(created.contractIDs && created.contractIDs[0] || created.data && created.data.contractID || created.contractID);
  const contract = contractID && require("../contracts/contractRuntimeState").getContractRecord(contractID);
  if (!contract || Number(contract.status) !== 0 || Number(contract.assigneeID) !== Number(carrier.characterID)) {
    return { success: false, message: `Courier creation needs review: the published contract ${contractID || "unknown"} could not be confirmed for ${carrier.characterName}.` };
  }
  return {
    success: true,
    contract,
    message: `Published courier contract ${contractID}: ${issuer.characterName} assigned ${units} unit(s) (${volume.toFixed(2)} m³) from ${startID} to ${endID} to ${carrier.characterName}; ${route.hops} jumps, ${rewardISK.toFixed(2)} ISK reward, ${collateralISK.toFixed(2)} ISK collateral. The carrier will be picked up by the director.`,
  };
}

function validateCourierCapacity(bot, contract) {
  const collateral = Math.max(0, Number(contract.collateral) || 0);
  const balance = Math.max(0, Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0);
  const collateralLimit = Math.min(MAX_COURIER_COLLATERAL_ISK, balance * 0.2);
  if (collateral > collateralLimit) {
    return { success: false, message: `Courier collateral ${collateral.toFixed(2)} ISK exceeds the bot's 20% wallet reserve or ${MAX_COURIER_COLLATERAL_ISK.toFixed(2)} ISK cap.` };
  }
  const volume = Math.max(0, Number(contract.volume) || 0);
  const cargoFree = Number(require("./playerBotInventoryRuntime").getCargoBayFree(bot)) || 0;
  if (volume > cargoFree + 1e-6) {
    return { success: false, message: `Courier package volume ${volume.toFixed(2)} m³ exceeds current free cargo space ${cargoFree.toFixed(2)} m³.` };
  }
  return { success: true, volume, collateral, balance };
}

function start(botQuery, contractID, options = {}) {
  return require("./playerBotOperationRuntime").startAllianceCourier(botQuery, contractID, options);
}

async function advance(operation, bot, kit) {
  const contracts = require("../contracts/contractRuntimeState");
  const inventory = kit.inventory;
  const session = kit.space.getActorSession(bot);
  const wrapID = positiveID(operation.wrapItemID);
  const getContract = () => contracts.getContractRecord(Number(operation.contractID));
  const accepted = (contract) => contract && Number(contract.status) === contracts.CONTRACT_STATUS.IN_PROGRESS &&
    Number(contract.acceptorID) === Number(bot.characterID);

  if (operation.stage === "cancelled") {
    return kit.finish(operation, `Alliance courier operation ${operation.operationID} stopped before contract acceptance; contract ${operation.contractID} remains outstanding.`);
  }

  if (operation.stage === "accept") {
    let contract = getContract();
    if (accepted(contract)) {
      operation.wrapItemID = positiveID(contract.plasticWrapItemID);
      operation.stage = "to-source";
      kit.record(operation, `Recovered accepted courier contract ${operation.contractID}; continuing package delivery.`);
      kit.save(operation);
    } else {
      if (!contract || !isAssignedCourierContract(contract, getBotIdentity(bot))) {
        return kit.block(operation, "blocked", "The courier contract is no longer assigned and outstanding.");
      }
      if (operation.pendingContractAction) {
        try { await contracts.settleContractOperation(Number(operation.contractID)); } catch (_) { /* reconcile below */ }
        contract = getContract();
        if (accepted(contract)) {
          operation.wrapItemID = positiveID(contract.plasticWrapItemID);
          operation.stage = "to-source";
          operation.pendingContractAction = null;
          kit.record(operation, `Recovered completed acceptance of courier contract ${operation.contractID}.`);
          kit.save(operation);
        } else if (contract && Number(contract.status) === contracts.CONTRACT_STATUS.OUTSTANDING) {
          operation.pendingContractAction = null;
        } else {
          return kit.block(operation, "review", "Courier acceptance is unsettled; no second acceptance was issued.");
        }
      }
      if (operation.stage === "accept") {
        operation.pendingContractAction = { kind: "accept", startedAt: new Date().toISOString() };
        kit.save(operation);
        try {
          contract = await contracts.acceptContract(Number(operation.contractID), session, false);
        } catch (error) {
          try { await contracts.settleContractOperation(Number(operation.contractID)); } catch (_) { /* reconcile below */ }
          contract = getContract();
          if (!accepted(contract)) return kit.block(operation, "review", `Courier contract acceptance needs review: ${String(error && error.message || error).slice(0, 160)}.`);
        }
        contract = getContract() || contract;
        if (!accepted(contract)) return kit.block(operation, "review", "The contract service did not confirm courier acceptance.");
        operation.wrapItemID = positiveID(contract.plasticWrapItemID);
        operation.pendingContractAction = null;
        operation.stage = "to-source";
        kit.record(operation, `Accepted assigned courier contract ${operation.contractID}; ${Number(contract.collateral || 0).toFixed(2)} ISK collateral is held by the contract service.`);
        kit.save(operation);
      }
    }
  }

  if (operation.stage === "to-source") {
    const contract = getContract();
    if (!accepted(contract)) return kit.block(operation, "review", "The assigned courier contract is no longer in progress for this pilot.");
    const step = await kit.travelToStation(operation, bot, Number(contract.startStationID));
    if (step) return step;
    operation.stage = "load-package";
    kit.save(operation);
  }
  if (operation.stage === "load-package") {
    const contract = getContract();
    if (!accepted(contract)) return kit.block(operation, "review", "The courier contract changed before package pickup.");
    const item = require("../inventory/itemStore").findItemById(wrapID || Number(contract.plasticWrapItemID));
    if (!item || Number(item.ownerID) !== Number(bot.characterID)) {
      return kit.block(operation, "review", "The courier package is missing from the bot's inventory.");
    }
    const shipID = Number(session.shipID) || 0;
    if (Number(item.locationID) === shipID) {
      operation.stage = "to-destination";
      kit.save(operation);
    } else {
      if (Number(item.locationID) !== Number(contract.startStationID)) {
        return kit.block(operation, "review", "The intact courier package is not at its contract pickup station or in the active ship.");
      }
      operation.pendingContractAction = { kind: "load-package", itemID: Number(item.itemID), startedAt: new Date().toISOString() };
      kit.save(operation);
      const loaded = inventory.loadToCargo(bot, Number(item.itemID));
      const after = require("../inventory/itemStore").findItemById(Number(item.itemID));
      if (!after || Number(after.locationID) !== shipID) {
        return kit.block(operation, "holding", `The courier package could not be loaded: ${loaded.message || "inventory transfer not confirmed"}.`);
      }
      operation.pendingContractAction = null;
      operation.stage = "to-destination";
      kit.record(operation, `Loaded courier package ${item.itemID} at contract pickup station ${contract.startStationID}.`);
      kit.save(operation);
    }
  }
  if (operation.stage === "to-destination") {
    const contract = getContract();
    if (!accepted(contract)) return kit.block(operation, "review", "The courier contract changed during transit; the package remains in the ship.");
    const step = await kit.travelToStation(operation, bot, Number(contract.endStationID));
    if (step) return step;
    operation.stage = "deliver-package";
    kit.save(operation);
  }
  if (operation.stage === "deliver-package") {
    const contract = getContract();
    const item = require("../inventory/itemStore").findItemById(wrapID || Number(contract && contract.plasticWrapItemID));
    if (!accepted(contract) || !item || Number(item.locationID) !== Number(session.shipID)) {
      return kit.block(operation, "review", "The intact courier package is not present in the destination station's active ship.");
    }
    const wrappers = inventory.listCargo(bot, Number(item.typeID));
    if (wrappers.length !== 1 || Number(wrappers[0].itemID) !== Number(item.itemID)) {
      return kit.block(operation, "review", "The ship contains additional courier packages; delivery was stopped to avoid unloading the wrong contract.");
    }
    operation.pendingContractAction = { kind: "unload-package", itemID: Number(item.itemID), startedAt: new Date().toISOString() };
    kit.save(operation);
    const unloaded = inventory.unloadCargo(bot, Number(item.typeID));
    const delivered = require("../inventory/itemStore").findItemById(Number(item.itemID));
    if (!delivered || Number(delivered.locationID) !== Number(contract.endStationID)) {
      return kit.block(operation, "holding", `The courier package was not confirmed in the destination hangar: ${unloaded.message || "inventory transfer not confirmed"}.`);
    }
    operation.pendingContractAction = null;
    operation.pendingContractAction = { kind: "complete", startedAt: new Date().toISOString() };
    operation.stage = "complete-contract";
    kit.record(operation, `Delivered the intact courier package to station ${contract.endStationID}; requesting contract completion.`);
    kit.save(operation);
  }
  if (operation.stage === "complete-contract") {
    let contract = getContract();
    if (contract && Number(contract.status) === contracts.CONTRACT_STATUS.IN_PROGRESS && operation.pendingContractAction) {
      try {
        await contracts.completeContract(Number(operation.contractID), contracts.CONTRACT_STATUS.FINISHED, session);
      } catch (error) {
        try { await contracts.settleContractOperation(Number(operation.contractID)); } catch (_) { /* reconcile below */ }
        contract = getContract();
        if (!contract || Number(contract.status) === contracts.CONTRACT_STATUS.IN_PROGRESS) {
          return kit.block(operation, "review", `Courier completion needs review: ${String(error && error.message || error).slice(0, 160)}.`);
        }
      }
    }
    contract = getContract();
    if (!contract || ![contracts.CONTRACT_STATUS.FINISHED, contracts.CONTRACT_STATUS.FINISHED_CONTRACTOR].includes(Number(contract.status))) {
      return kit.block(operation, "review", "The contract service has not confirmed delivery and reward settlement.");
    }
    operation.proceeds = Number(contract.reward) || 0;
    operation.collateralReturned = Number(contract.collateral) || 0;
    operation.pendingContractAction = null;
    operation.stage = "corp-share";
    kit.record(operation, `Courier contract ${operation.contractID} completed; reward ${operation.proceeds.toFixed(2)} ISK and collateral return were confirmed by the contract service.`);
    kit.save(operation);
  }
  if (operation.stage === "corp-share") {
    try {
      operation.corpShare = await require("./playerBotCorpEconomyRuntime").payCorpShare(
        bot,
        Math.max(0, (Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0) - Number(operation.startingBalance || 0)),
        `alliance courier contract ${operation.contractID}`,
        `alliance-courier:${operation.contractID}`,
      );
      operation.corpShareSettled = true;
    } catch (error) {
      return kit.block(operation, "holding", `Could not settle the corporation share: ${String(error && error.message || error).slice(0, 160)}.`);
    }
    return kit.finish(operation, `Alliance courier contract ${operation.contractID} completed for ${Number(operation.proceeds || 0).toFixed(2)} ISK reward.`);
  }
  return kit.block(operation, "blocked", `Unknown alliance-courier stage ${operation.stage}.`);
}

module.exports = {
  MAX_COURIER_COLLATERAL_ISK,
  MAX_COURIER_ROUTE_HOPS,
  advance,
  findAssignedCourier,
  inspectAssignedCourier,
  isAssignedCourierContract,
  postAssignedCourier,
  routeForCourier,
  start,
  validateCourierCapacity,
  _testing: { isAssignedCourierContract },
};

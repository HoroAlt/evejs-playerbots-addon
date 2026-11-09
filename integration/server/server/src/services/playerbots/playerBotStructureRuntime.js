"use strict";

// Playerbot structure work delegates placement, corporation roles, ownership,
// anchoring timers, inventory moves, module online state and service access to
// EveJS authorities. This runtime plans travel and reconciles durable
// procurement, deployment, core-install and service-provision operations.

const worldData = require("../../space/worldData");

const MAX_DEPLOYMENT_ROUTE_HOPS = 24;
const POSITION_SEARCH_RADII = Object.freeze([12_000, 25_000, 50_000, 100_000, 250_000, 500_000, 750_000]);
const POSITION_DIRECTIONS = 16;
const MAX_DEPLOYMENT_REPOSITION_TARGETS = 32;
const MIN_DEPLOYMENT_REPOSITION_DISTANCE = 150_000;
const DEPLOYMENT_GRID_CLEARANCE_METERS = 1_250_000;
const AUTONOMOUS_STRUCTURE_TYPE_BY_SPECIALTY = Object.freeze({
  mining: 35835,       // Athanor
  industry: 35825,     // Raitaru
  planetary: 35835,   // Athanor
  trade: 35832,        // Astrahus
  security: 35832,
  piracy: 35832,
  sovereignty: 35832,
});
const MAX_AUTONOMOUS_STRUCTURE_PACKAGE_ISK = 1_000_000_000;
const MIN_STRUCTURE_REINVESTABLE_PROFIT_ISK = 250_000_000;
const STRUCTURE_TRANSPORT_BUDGET_ISK = 25_000_000;
// A bot may bootstrap one structure from its personal seeded wallet once a
// complete package is affordable, while keeping a working balance for regular
// jobs. This path never draws from the corporation wallet.
const MIN_STRUCTURE_WORKING_RESERVE_ISK = 125_000_000;
const INDUSTRY_SERVICE_MODULE_TYPE_ID = 35878;
const STRUCTURE_SERVICE_TARGET_FUEL_DAYS = 7;
const STRUCTURE_MAINTENANCE_FUEL_DAYS = 7;
const STRUCTURE_CARETAKER_ROLE = 2048n;
const STRUCTURE_CARETAKER_CACHE_MS = 30_000;
const structureCaretakerCache = new Map();

function positiveID(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function getStructureType(typeID) {
  return require("../structure/structureState").getStructureTypeByID(positiveID(typeID));
}

function getStructureProcurementNeeds(typeID, type = getStructureType(typeID)) {
  const needs = [{ typeID: positiveID(typeID), quantity: 1 }];
  const coreTypeID = positiveID(type && type.defaultQuantumCoreTypeID);
  if (coreTypeID) needs.push({ typeID: coreTypeID, quantity: 1 });
  return needs.filter((need) => need.typeID > 0);
}

function getOwnedStructureItem(bot, itemID) {
  const item = require("../inventory/itemStore").findItemById(positiveID(itemID));
  if (!item || Number(item.ownerID) !== Number(bot.characterID)) return null;
  return item;
}

function findStructurePackage(bot) {
  if (!bot || !isStructureManager(bot)) return null;
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const shipID = positiveID(session.shipID);
  const inventory = require("../inventory/itemStore");
  const playerInventory = require("./playerBotInventoryRuntime");
  const candidates = inventory.listCharacterItems(bot.characterID)
    .filter((item) => getStructureType(item.typeID)?.dockable === true)
    .filter((item) => {
      const inCargo = positiveID(item.locationID) === shipID &&
        Number(item.flagID) === inventory.ITEM_FLAGS.CARGO_HOLD;
      const inPersonalHangar = Number(item.flagID) === inventory.ITEM_FLAGS.HANGAR &&
        (worldData.getStationByID(positiveID(item.locationID)) || worldData.getStructureByID(positiveID(item.locationID)));
      return inCargo || inPersonalHangar;
    });
  // Most bots never own a structure package. Avoid an inventory-broker bind
  // and capacity read for every ordinary director assignment.
  if (!candidates.length) return null;
  const cargoFree = playerInventory.getCargoBayFree(bot);
  return candidates.sort((left, right) => {
      const leftCargo = positiveID(left.locationID) === shipID ? 0 : 1;
      const rightCargo = positiveID(right.locationID) === shipID ? 0 : 1;
      const leftFits = leftCargo === 0 || playerInventory.getUnitVolume(left) <= cargoFree + 1e-9 ? 0 : 1;
      const rightFits = rightCargo === 0 || playerInventory.getUnitVolume(right) <= cargoFree + 1e-9 ? 0 : 1;
      return leftCargo - rightCargo ||
        leftFits - rightFits ||
        playerInventory.getUnitVolume(left) - playerInventory.getUnitVolume(right) ||
        positiveID(left.itemID) - positiveID(right.itemID);
    })[0] || null;
}

// A bot may spend its personal seed capital on structure logistics while
// preserving the operating and transport reserve. Corporation wallets are
// never used by this autonomous purchase path.
function canFundStructureLogisticsUpgradeWithSeedCapital(bot, upgradeBudget) {
  if (!bot || !positiveID(bot.characterID)) return false;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  if (!corporationID) return false;
  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  const protectedReserve = MIN_STRUCTURE_WORKING_RESERVE_ISK + STRUCTURE_TRANSPORT_BUDGET_ISK;
  return balance >= Math.max(0, Number(upgradeBudget) || 0) + protectedReserve;
}

function decideServiceProvisionFunding(maintenance, maxSpend, profit, balance) {
  const spend = Math.max(0, Number(maxSpend) || 0);
  const realized = Math.max(0, Number(profit) || 0);
  const wallet = Math.max(0, Number(balance) || 0);
  const reserve = MIN_STRUCTURE_WORKING_RESERVE_ISK + STRUCTURE_TRANSPORT_BUDGET_ISK;
  if (maintenance && wallet + 0.0001 < spend + reserve) {
    return { allowed: false, fundingSource: null, reserve };
  }
  if (wallet + 0.0001 < spend) {
    return { allowed: false, fundingSource: null, reserve: 0 };
  }
  if (realized + 0.0001 >= spend) {
    return { allowed: true, fundingSource: "realized-profit", reserve: 0 };
  }
  if (maintenance) {
    return { allowed: true, fundingSource: "seed-capital", reserve };
  }
  return { allowed: false, fundingSource: null, reserve: maintenance ? reserve : 0 };
}

function findAutonomousPurchasePlan(bot) {
  if (!bot || !isStructureManager(bot)) return null;
  const corporationID = positiveID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).corporationID || bot.corporationID);
  if (!corporationID) return null;
  const typeID = positiveID(AUTONOMOUS_STRUCTURE_TYPE_BY_SPECIALTY[String(bot.specialty || "").toLowerCase()]);
  const type = getStructureType(typeID);
  if (!type || type.dockable !== true) return null;
  const packageNeeds = getStructureProcurementNeeds(typeID, type);
  // A medium Upwell hull without its required Quantum Core is only an
  // unpowered shell. Do not start autonomous construction unless the market
  // can supply the complete, type-correct package at one station.
  if (positiveID(type.defaultQuantumCoreTypeID) &&
      !packageNeeds.some((need) => need.typeID === positiveID(type.defaultQuantumCoreTypeID))) return null;

  const state = require("../structure/structureState");
  const existingStructure = state.listStructures().some((structure) =>
    Number(structure && (structure.ownerCorpID || structure.ownerID)) === corporationID &&
    !structure.destroyedAt && !structure.unanchoring);
  if (existingStructure) return null;

  const operations = require("./playerBotOperationRuntime");
  const reserved = operations.listOperations().some((operation) =>
    Number(operation && operation.corporationID) === corporationID &&
    ["structure-procurement", "structure-deployment"].includes(operation.kind) &&
    ["active", "holding", "review"].includes(operation.status),
  );
  if (reserved) return null;

  const itemStore = require("../inventory/itemStore");
  const corporationBots = require("./playerBotRuntime").listBots()
    .filter((candidate) => Number(candidate.corporationID) === corporationID);
  const corporationHasPackage = corporationBots.some((candidate) =>
    itemStore.listCharacterItems(candidate.characterID)
      .some((item) => getStructureType(item.typeID)?.dockable === true),
  );
  if (corporationHasPackage) return null;

  const objective = findDeploymentObjective(bot, typeID);
  // Autonomous acquisition only invests in neutral or allied space. The
  // explicit /build command continues to defer any hostile-system decision
  // to the ordinary structure authority and placement rules.
  if (!objective || Number(objective.priority) > 2) return null;

  const economy = require("./playerBotEconomyRuntime");
  const marketStationID = positiveID(operations.findUpgradeMarketStation(bot, {
    hullTypeID: typeID,
    moduleTypeIDs: positiveID(type.defaultQuantumCoreTypeID)
      ? [positiveID(type.defaultQuantumCoreTypeID)]
      : [],
  }));
  if (!marketStationID) return null;
  const offer = economy.findSellStationsForPackage(packageNeeds)
    .find((candidate) => Number(candidate.stationID) === marketStationID);
  const estimatedCost = Number(offer && offer.estimatedCost);
  if (!offer || offer.complete !== true || !Number.isFinite(estimatedCost) || estimatedCost <= 0 ||
      estimatedCost > MAX_AUTONOMOUS_STRUCTURE_PACKAGE_ISK) return null;

  const inventory = require("./playerBotInventoryRuntime");
  const packageVolume = inventory.getUnitVolume({ typeID });
  if (!(packageVolume > 0)) return null;
  const needsHauler = packageVolume > inventory.getCargoBayCapacity(bot);
  const logisticsBudget = needsHauler ? STRUCTURE_TRANSPORT_BUDGET_ISK : 0;
  const maxSpend = Math.min(MAX_AUTONOMOUS_STRUCTURE_PACKAGE_ISK,
    Math.ceil(Math.max(estimatedCost, estimatedCost * 1.1) * 100) / 100);
  const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
  const reinvestableProfit = Number(require("./playerBotCorpEconomyRuntime")
    .getCumulativeNetProfit(bot).reinvestableProfit) || 0;
  const requiredProfit = Math.max(MIN_STRUCTURE_REINVESTABLE_PROFIT_ISK, maxSpend + logisticsBudget);
  const minimumWalletReserve = MIN_STRUCTURE_WORKING_RESERVE_ISK + logisticsBudget;
  const botCorpEconomy = require("./playerBotCorpEconomyRuntime");
  let fundingSource = "realized-profit";
  if (balance < maxSpend + minimumWalletReserve || reinvestableProfit < requiredProfit) {
    // The initial billion ISK is seed capital, not earned profit. Any bot
    // with enough personal balance may use it above the protected operating
    // reserve, regardless of its corporation's CEO. Do not draw on corp funds.
    if (balance < maxSpend + minimumWalletReserve) return null;
    fundingSource = "seed-capital";
  }

  return {
    typeID,
    coreTypeID: positiveID(type.defaultQuantumCoreTypeID),
    packageNeeds,
    structureName: `${type.name} ${bot.characterName}`.slice(0, 200),
    marketStationID,
    estimatedCost,
    maxSpend,
    logisticsBudget,
    requiredProfit: fundingSource === "realized-profit" ? requiredProfit : 0,
    minimumWalletReserve,
    fundingSource,
    destinationSystemID: objective.systemID,
  };
}

function findCoreInstallPlan(bot) {
  if (!bot) return null;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  if (!corporationID) return null;
  const states = require("../structure/structureConstants").STRUCTURE_STATE;
  const structures = require("../structure/structureState").listStructures()
    .filter((structure) => Number(structure && (structure.ownerCorpID || structure.ownerID)) === corporationID)
    .filter((structure) => !structure.destroyedAt && !structure.unanchoring && structure.hasQuantumCore !== true)
    .filter((structure) => Number(structure.state) === Number(states.ONLINING_VULNERABLE));
  if (!structures.length) return null;

  const activeTargets = new Set(require("./playerBotOperationRuntime").listOperations()
    .filter((operation) => operation && operation.kind === "structure-core-install" &&
      ["active", "holding", "review"].includes(operation.status))
    .map((operation) => Number(operation.structureID)));
  const candidates = structures.filter((structure) => !activeTargets.has(positiveID(structure.structureID)))
    .map((structure) => {
      const type = getStructureType(structure.typeID);
      return { structure, coreTypeID: positiveID(type && type.defaultQuantumCoreTypeID) };
    })
    .filter((candidate) => candidate.coreTypeID > 0);
  if (!candidates.length || !isStructureManager(bot)) return null;

  const itemStore = require("../inventory/itemStore");
  const ownedCores = itemStore.listCharacterItems(bot.characterID)
    .filter((item) => Number(item.ownerID) === Number(bot.characterID));
  if (!ownedCores.length) return null;
  const actorSession = require("./playerBotSpaceRuntime").getActorSession(bot);
  for (const { structure, coreTypeID } of candidates) {
    const structureID = positiveID(structure.structureID);
    if (!structureID) continue;
    const core = ownedCores.find((item) => Number(item.typeID) === coreTypeID &&
      (Number(item.flagID) === Number(itemStore.ITEM_FLAGS.HANGAR) ||
        Number(item.locationID) === Number(actorSession.shipID) &&
        Number(item.flagID) === Number(itemStore.ITEM_FLAGS.CARGO_HOLD)));
    if (!core) continue;
    const sourceStationID = Number(core.locationID) === Number(actorSession.shipID)
      ? positiveID(actorSession.stationID || actorSession.structureID)
      : positiveID(core.locationID);
    const sourceLocation = worldData.getStationByID(sourceStationID) || worldData.getStructureByID(sourceStationID);
    if (!sourceStationID || !sourceLocation) continue;
    return {
      structureID,
      coreTypeID,
      coreItemID: positiveID(core.itemID),
      sourceStationID,
      // Keep the commissioning pilot in the structure's system after the
      // core is installed so its next independent assignment can exploit the
      // corporation's new base and nearby space.
      homeStationID: structureID,
      solarSystemID: positiveID(structure.solarSystemID),
    };
  }
  return null;
}

function startCoreInstall(bot, plan, tools = {}) {
  if (!bot || !plan || typeof tools.baseOperation !== "function" || typeof tools.saveOperation !== "function") {
    return { success: false, message: "Structure core installation must be started through the playerbot operation runtime." };
  }
  if (!isStructureManager(bot)) return { success: false, message: `${bot.characterName} no longer has persisted corporation structure-management authority.` };
  const structure = require("../structure/structureState").getStructureByID(positiveID(plan.structureID));
  if (!structure || structure.destroyedAt || structure.hasQuantumCore === true ||
      Number(structure.state) !== Number(require("../structure/structureConstants").STRUCTURE_STATE.ONLINING_VULNERABLE)) {
    return { success: false, message: `Structure ${plan.structureID} is not awaiting its Quantum Core in the dockable onlining-vulnerable state.` };
  }
  const corporationID = positiveID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).corporationID || bot.corporationID);
  if (Number(structure.ownerCorpID || structure.ownerID) !== corporationID) {
    return { success: false, message: `${bot.characterName}'s persisted corporation does not own structure ${plan.structureID}.` };
  }
  const core = getOwnedStructureItem(bot, plan.coreItemID);
  if (!core || Number(core.typeID) !== Number(plan.coreTypeID)) {
    return { success: false, message: `The required Quantum Core ${plan.coreItemID} is not in ${bot.characterName}'s inventory.` };
  }
  const operation = tools.baseOperation("structure-core-install", bot, {
    stage: "to-core",
    structureID: positiveID(plan.structureID),
    coreTypeID: positiveID(plan.coreTypeID),
    coreItemID: positiveID(plan.coreItemID),
    sourceStationID: positiveID(plan.sourceStationID),
    homeStationID: positiveID(plan.homeStationID || plan.sourceStationID),
    pendingInstall: false,
    autonomous: true,
  });
  if (!operation.structureID || !operation.coreTypeID || !operation.coreItemID || !operation.sourceStationID) {
    return { success: false, message: "The structure ID or Quantum Core custody location is missing." };
  }
  tools.record(operation, `Reserved Quantum Core ${operation.coreItemID} for owned corporation structure ${operation.structureID}.`);
  tools.saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will carry the required Quantum Core to structure ${operation.structureID} and install it through the inventory authority.` };
}

function startProcurement(bot, plan, tools = {}) {
  if (!bot || !plan || typeof tools.baseOperation !== "function" || typeof tools.saveOperation !== "function") {
    return { success: false, message: "Structure procurement must be started through the playerbot operation runtime." };
  }
  if (!isStructureManager(bot)) return { success: false, message: `${bot.characterName} no longer has persisted corporation structure-deployment authority.` };
  const type = getStructureType(plan.typeID);
  if (!type || type.dockable !== true) return { success: false, message: `Structure type ${plan.typeID} is not an eligible dockable Upwell structure.` };
  const operation = tools.baseOperation("structure-procurement", bot, {
    stage: "to-market",
    typeID: Number(plan.typeID),
    coreTypeID: positiveID(plan.coreTypeID) || positiveID(type.defaultQuantumCoreTypeID),
    packageNeeds: getStructureProcurementNeeds(plan.typeID, {
      ...type,
      defaultQuantumCoreTypeID: positiveID(plan.coreTypeID) || positiveID(type.defaultQuantumCoreTypeID),
    }),
    packageItemIDs: {},
    structureName: String(plan.structureName || type.name).slice(0, 200),
    marketStationID: positiveID(plan.marketStationID),
    destinationSystemID: positiveID(plan.destinationSystemID),
    estimatedCost: Number(plan.estimatedCost) || 0,
    requiredProfit: Number(plan.requiredProfit) || 0,
    maxSpend: Number(plan.maxSpend) || 0,
    logisticsBudget: Number(plan.logisticsBudget) || 0,
    minimumWalletReserve: Number(plan.minimumWalletReserve) || MIN_STRUCTURE_WORKING_RESERVE_ISK,
    fundingSource: plan.fundingSource === "seed-capital" ? "seed-capital" : "realized-profit",
    spent: 0,
    pending: null,
    autonomous: true,
  });
  if (!operation.marketStationID || !operation.destinationSystemID || !operation.maxSpend) {
    return { success: false, message: "The structure market quote or null-sec destination is no longer valid." };
  }
  tools.record(operation, `Reserved a ${type.name} purchase at ${operation.marketStationID}; budget ${operation.maxSpend.toFixed(2)} ISK from ${operation.fundingSource}, null-sec destination ${operation.destinationSystemID}.`);
  tools.saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will purchase one ${type.name} with ${operation.fundingSource === "seed-capital" ? "personal seed capital above its protected working reserve" : "realized profit"} and prepare it for deployment.` };
}

function isSafeProcurementStation(bot, stationID) {
  const station = worldData.getStationByID(positiveID(stationID));
  if (!station) return false;
  const systemID = positiveID(station.solarSystemID);
  const system = worldData.getSolarSystemByID(systemID) || {};
  if (!systemID || Number(system.security) < 0.45) return false;
  const route = require("./playerBotSpaceRuntime").previewSystemRoute(bot, systemID);
  return Boolean(route.success && !(route.risk && (
    (Array.isArray(route.risk.lowsecSystemIDs) && route.risk.lowsecSystemIDs.length) ||
    (Array.isArray(route.risk.nullsecSystemIDs) && route.risk.nullsecSystemIDs.length)
  )));
}

async function advanceProcurement(operation, bot, kit) {
  if (operation.pending) {
    return kit.block(operation, "review", `The ${operation.structureName} market purchase is unconfirmed; inspect wallet and hangar before retrying.`);
  }
  if (!isStructureManager(bot)) return kit.block(operation, "blocked", "Persisted corporation authority no longer permits structure procurement.");
  if (operation.stage === "to-market") {
    if (!isSafeProcurementStation(bot, operation.marketStationID)) {
      return kit.block(operation, "blocked", `Market station ${operation.marketStationID} is no longer reachable over the approved high-sec route.`);
    }
    const step = await kit.travelToStation(operation, bot, Number(operation.marketStationID));
    if (step) return step;
    operation.stage = "buy-package";
    kit.save(operation);
  }
  if (operation.stage === "buy-package") {
    const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
    const earnedProfit = Number(require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit) || 0;
    const unspentBudget = Math.max(0, Number(operation.maxSpend) - (Number(operation.spent) || 0));
    const minimumWalletReserve = Math.max(MIN_STRUCTURE_WORKING_RESERVE_ISK,
      Number(operation.minimumWalletReserve) || 0);
    const fundingSource = operation.fundingSource === "seed-capital" ? "seed-capital" : "realized-profit";
    if (fundingSource === "seed-capital") {
      if (balance < unspentBudget + minimumWalletReserve) {
        return kit.block(operation, "blocked", `Structure purchase paused before spending: personal wallet requires ${unspentBudget.toFixed(2)} ISK remaining package budget plus ${minimumWalletReserve.toFixed(2)} ISK working reserve; wallet ${balance.toFixed(2)} ISK.`);
      }
    } else if (balance < unspentBudget + minimumWalletReserve ||
        earnedProfit + (Number(operation.spent) || 0) < Number(operation.requiredProfit)) {
      return kit.block(operation, "blocked", `Structure purchase paused before spending: wallet ${balance.toFixed(2)} ISK, realized reinvestable profit ${earnedProfit.toFixed(2)} ISK; remaining package budget ${unspentBudget.toFixed(2)}, protected reserve ${minimumWalletReserve.toFixed(2)}, required realized profit ${Number(operation.requiredProfit).toFixed(2)} ISK.`);
    }
    const inventory = kit.inventory;
    const structureType = getStructureType(operation.typeID);
    operation.coreTypeID = positiveID(operation.coreTypeID || (structureType && structureType.defaultQuantumCoreTypeID));
    const packageNeeds = Array.isArray(operation.packageNeeds) && operation.packageNeeds.length
      ? operation.packageNeeds
      : getStructureProcurementNeeds(operation.typeID, structureType);
    operation.packageItemIDs = { ...(operation.packageItemIDs || {}) };
    for (const need of packageNeeds) {
      const typeID = positiveID(need && need.typeID);
      const quantity = Math.max(1, Math.trunc(Number(need && need.quantity) || 1));
      if (!typeID) return kit.block(operation, "blocked", "The structure package contains an invalid type ID.");
      const alreadyOwned = inventory.listHangar(bot, Number(operation.marketStationID), typeID)[0];
      if (alreadyOwned) {
        operation.packageItemIDs[String(typeID)] = Number(alreadyOwned.itemID);
        if (typeID === Number(operation.typeID)) operation.itemID = Number(alreadyOwned.itemID);
        if (typeID === Number(operation.coreTypeID)) operation.coreItemID = Number(alreadyOwned.itemID);
        continue;
      }
      const result = await kit.buyMarketUnits(operation, bot, typeID, quantity, Number(operation.marketStationID));
      if (result.review) return kit.block(operation, "review", result.review);
      if ((result.unavailable || result.sourceAvailable) && Number(result.sourceStationID) > 0) {
        const sourceStationID = Number(result.sourceStationID);
        if (sourceStationID === Number(operation.marketStationID)) {
          return kit.block(operation, "holding", result.error || `Structure package type ${typeID} is not currently available at this station.`);
        }
        if (Object.keys(operation.packageItemIDs).length) {
          return kit.block(operation, "holding", `Structure package type ${typeID} is now only available at station ${sourceStationID}, after another package item was purchased at ${operation.marketStationID}; keeping the partial package together and waiting for stock.`);
        }
        if (!isSafeProcurementStation(bot, sourceStationID)) {
          return kit.block(operation, "blocked", `The only verified structure package source, station ${sourceStationID}, is outside the approved safe market route; no purchase was made.`);
        }
        operation.marketStationID = sourceStationID;
        operation.stage = "to-market";
        kit.record(operation, `Structure package stock is at safe non-Jita source ${sourceStationID}; rerouting before purchase.`);
        kit.save(operation);
        return { delayMs: 5000 };
      }
      if (result.unavailable || result.error) return kit.block(operation, "blocked", `${result.error || `Structure package type ${typeID} is unavailable.`} No incomplete structure package was deployed.`);
      if (!(Number(result.bought) >= quantity)) return kit.block(operation, "holding", `The market did not deliver ${quantity}× structure package type ${typeID}; waiting before any retry.`);
      const purchased = inventory.listHangar(bot, Number(operation.marketStationID), typeID)[0];
      if (!purchased) return kit.block(operation, "review", `The market reported a purchase of structure package type ${typeID}, but the item is not in the personal hangar; inspect inventory and wallet before retrying.`);
      operation.packageItemIDs[String(typeID)] = Number(purchased.itemID);
      if (typeID === Number(operation.typeID)) operation.itemID = Number(purchased.itemID);
      if (typeID === Number(operation.coreTypeID)) operation.coreItemID = Number(purchased.itemID);
      kit.record(operation, `Bought ${quantity}× structure package type ${typeID} at ${operation.marketStationID} for ${Number(result.spent || 0).toFixed(2)} ISK; the package remains in the personal hangar until its transport is ready.`);
      kit.save(operation);
      return { delayMs: 5000 };
    }
    if (!operation.itemID || (Number(operation.coreTypeID) > 0 && !operation.coreItemID)) {
      return kit.block(operation, "review", "The structure hull and required Quantum Core are not both reconciled in the personal hangar.");
    }
    const coreSummary = operation.coreItemID ? ` with Quantum Core ${operation.coreItemID}` : "";
    return kit.finish(operation, `${operation.structureName} package ${operation.itemID}${coreSummary} is in the personal hangar. The director will fit a transport when needed and then continue through the normal structure authority.`);
  }
  return kit.block(operation, "blocked", `Unknown structure procurement stage ${operation.stage}.`);
}

function coreInstallIsReconciled(operation, bot) {
  const structureState = require("../structure/structureState");
  const structure = structureState.getStructureByID(positiveID(operation.structureID));
  const item = require("../inventory/itemStore").findItemById(positiveID(operation.coreItemID));
  const corporationID = positiveID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).corporationID || bot.corporationID);
  return Boolean(structure && structure.hasQuantumCore === true && item &&
    Number(item.typeID) === Number(operation.coreTypeID) &&
    Number(item.ownerID) === corporationID &&
    Number(item.locationID) === Number(operation.structureID) &&
    Number(item.flagID) === Number(require("../inventory/itemStore").ITEM_FLAGS.STRUCTURE_DEED));
}

function structureTransportHullTypes(bot, requiredVolume) {
  const operations = require("./playerBotOperationRuntime");
  const skillState = require("../skills/skillState");
  const getSkillMap = skillState.getCachedCharacterSkillMap || skillState.getCharacterSkillMap;
  const skills = getSkillMap(bot.characterID);
  const registry = require("../inventory/itemTypeRegistry");
  return [648, 649]
    .map((typeID) => {
      const type = registry.resolveItemByTypeID(typeID) || {};
      const capacity = Number(type.capacity) || 0;
      const requirements = operations.requiredSkillsForType(typeID);
      const canFly = requirements.every(([skillID, level]) => {
        const record = skills && (skills.get ? skills.get(skillID) : skills[skillID]);
        return (Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0) >= level;
      });
      return { typeID, capacity, canFly };
    })
    .filter((entry) => entry.canFly && entry.capacity + 1e-9 >= requiredVolume)
    .sort((left, right) => left.capacity - right.capacity || left.typeID - right.typeID);
}

function findOwnedCoreTransport(bot, requiredVolume) {
  const itemStore = require("../inventory/itemStore");
  const inventory = require("./playerBotInventoryRuntime");
  const space = require("./playerBotSpaceRuntime");
  const allowedTypes = new Map(structureTransportHullTypes(bot, requiredVolume)
    .map((entry) => [entry.typeID, entry.capacity]));
  const candidates = [];
  for (const item of itemStore.listCharacterItems(bot.characterID)) {
    const typeID = positiveID(item && item.typeID);
    const locationID = positiveID(item && item.locationID);
    if (!allowedTypes.has(typeID) || Number(item.ownerID) !== Number(bot.characterID) ||
        Number(item.flagID) !== Number(itemStore.ITEM_FLAGS.HANGAR) ||
        Number(item.singleton) <= 0 || locationID <= 0) continue;
    const station = worldData.getStationByID(locationID);
    if (!station) continue;
    let route;
    try { route = space.previewSystemRoute(bot, Number(station.solarSystemID)); } catch (_) { route = null; }
    if (!route || route.success !== true || (route.risk && (
      (Array.isArray(route.risk.lowsecSystemIDs) && route.risk.lowsecSystemIDs.length) ||
      (Array.isArray(route.risk.nullsecSystemIDs) && route.risk.nullsecSystemIDs.length)
    ))) continue;
    candidates.push({
      item,
      stationID: locationID,
      capacity: Number(item.capacity) || allowedTypes.get(typeID) || 0,
      hops: Number(route.hops) || 0,
    });
  }
  return candidates.sort((left, right) =>
    right.capacity - left.capacity || left.hops - right.hops || left.stationID - right.stationID ||
    Number(left.item.itemID) - Number(right.item.itemID),
  )[0] || null;
}

async function ensureCoreTransport(operation, bot, kit, core) {
  const inventory = kit.inventory;
  const volume = Number(inventory.getUnitVolume(core)) || Number(core.volume) || 0;
  if (!(volume > 0)) return kit.block(operation, "review", `Quantum Core ${core.itemID} has no verified cargo volume.`);
  if (inventory.getCargoBayFree(bot) + 1e-9 >= volume && !operation.transportShipItemID) return null;

  const itemStore = require("../inventory/itemStore");
  let transport = operation.transportShipItemID
    ? itemStore.findItemById(Number(operation.transportShipItemID))
    : null;
  if (!operation.transportShipItemID) {
    const candidate = findOwnedCoreTransport(bot, volume);
    if (candidate) {
      transport = candidate.item;
      operation.transportShipItemID = Number(transport.itemID);
      operation.transportStationID = candidate.stationID;
      operation.transportHullTypeID = Number(transport.typeID);
      operation.previousShipID = Number(kit.space.getActorSession(bot).shipID) || null;
      kit.record(operation, `The active ship's cargo bay is too small for the ${volume} m³ Quantum Core; using the owned ${transport.itemName || `hauler ${transport.typeID}`} at station ${candidate.stationID}.`);
      kit.save(operation);
    } else {
      const transportTypes = structureTransportHullTypes(bot, volume);
      const selected = transportTypes[0];
      if (!selected) {
        return kit.block(operation, "holding", `No trained Badger or Tayra with enough cargo capacity is available for the ${volume} m³ Quantum Core.`);
      }
      const operations = require("./playerBotOperationRuntime");
      operation.transportHullTypeID = selected.typeID;
      operation.transportStationID = Number(operation.transportMarketStationID) ||
        operations.findUpgradeMarketStation(bot, { hullTypeID: selected.typeID, moduleTypeIDs: [] });
      operation.transportMarketStationID = operation.transportStationID;
      operation.maxSpend = Number(operation.maxSpend) > 0
        ? Math.min(Number(operation.maxSpend), STRUCTURE_TRANSPORT_BUDGET_ISK)
        : STRUCTURE_TRANSPORT_BUDGET_ISK;
      operation.spent = Math.max(0, Number(operation.spent) || 0);
      const purchaseStep = await kit.travelToStation(operation, bot, operation.transportStationID);
      if (purchaseStep) return purchaseStep;
      const alreadyOwned = inventory.listHangar(bot, operation.transportStationID, selected.typeID)[0];
      if (alreadyOwned) {
        transport = alreadyOwned;
      } else {
        // Mark the purchase as reviewable before the market request. Existing
        // pending-purchase reconciliation uses the same wallet, journal, and
        // inventory evidence if a restart interrupts the response.
        operation.status = "review";
        kit.save(operation);
        const bought = await kit.buyMarketUnits(operation, bot, selected.typeID, 1, operation.transportStationID);
        if (bought.review) return kit.block(operation, "review", bought.review);
        operation.status = "active";
        if (bought.unavailable && Number(bought.sourceStationID) > 0 &&
            Number(bought.sourceStationID) !== Number(operation.transportStationID)) {
          operation.transportStationID = Number(bought.sourceStationID);
          operation.transportMarketStationID = operation.transportStationID;
          operation.routeTaskID = null;
          kit.record(operation, `No ${selected.typeID} hauler is for sale at the first safe source; verified market stock is at ${operation.transportStationID}.`);
          kit.save(operation);
          return { delayMs: 5000 };
        }
        if (bought.unavailable || bought.error || Number(bought.bought) < 1) {
          return kit.block(operation, "holding", bought.error || `No ${selected.typeID} hauler is available within the protected ${STRUCTURE_TRANSPORT_BUDGET_ISK.toFixed(0)} ISK logistics budget.`);
        }
        transport = inventory.listHangar(bot, operation.transportStationID, selected.typeID)[0] || null;
        if (!transport) {
          return kit.block(operation, "review", `Market reported a purchase of hauler ${selected.typeID}, but it is not in the personal hangar; inspect inventory before retrying.`);
        }
        operation.transportShipItemID = Number(transport.itemID);
        operation.previousShipID = Number(kit.space.getActorSession(bot).shipID) || null;
        kit.record(operation, `Bought one ${transport.itemName || `hauler ${selected.typeID}`} at safe market station ${operation.transportStationID} for ${Number(bought.spent || 0).toFixed(2)} ISK to carry the Quantum Core.`);
        kit.save(operation);
      }
      if (transport) {
        operation.transportShipItemID = Number(transport.itemID);
        operation.transportHullTypeID = Number(transport.typeID);
        operation.previousShipID = Number(kit.space.getActorSession(bot).shipID) || null;
        kit.save(operation);
      }
    }
  }

  if (!transport || Number(transport.ownerID) !== Number(bot.characterID) ||
      Number(transport.typeID) !== Number(operation.transportHullTypeID)) {
    return kit.block(operation, "review", `Recorded transport hull ${operation.transportShipItemID} is missing or no longer belongs to the bot.`);
  }
  const session = kit.space.getActorSession(bot);
  if (Number(session.shipID) !== Number(operation.transportShipItemID)) {
    const transportStationID = positiveID(transport.locationID) || positiveID(operation.transportStationID);
    if (Number(transport.locationID) !== transportStationID ||
        Number(transport.flagID) !== Number(itemStore.ITEM_FLAGS.HANGAR)) {
      return kit.block(operation, "review", `Transport hull ${transport.itemID} is not in its recorded personal hangar at ${transportStationID}.`);
    }
    const step = await kit.travelToStation(operation, bot, transportStationID);
    if (step) return step;
    const hull = inventory.listHangar(bot, transportStationID, Number(transport.typeID))
      .find((entry) => Number(entry.itemID) === Number(operation.transportShipItemID));
    if (!hull) return kit.block(operation, "review", `Transport hull ${operation.transportShipItemID} disappeared from station ${transportStationID}.`);
    const boarded = kit.boardShip(bot, hull);
    if (boarded && boarded.error) return kit.block(operation, "holding", `Could not board the logistics hull for Quantum Core transport: ${boarded.error}.`);
    operation.routeTaskID = null;
    kit.record(operation, `Boarded the ${hull.itemName || `hauler ${hull.typeID}`} for Quantum Core transport; the previous ship remains in station ${transportStationID}.`);
    kit.save(operation);
    return { delayMs: 3000 };
  }

  if (inventory.getCargoBayFree(bot) + 1e-9 < volume) {
    return kit.block(operation, "holding", `Transport hull ${operation.transportShipItemID} still has insufficient cargo space for the ${volume} m³ Quantum Core.`);
  }
  return null;
}

async function advanceCoreInstall(operation, bot, kit) {
  if (!isStructureManager(bot)) return kit.block(operation, "blocked", "Persisted corporation authority no longer permits Quantum Core installation.");
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  const structureState = require("../structure/structureState");
  const structure = structureState.getStructureByID(positiveID(operation.structureID));
  if (!structure || structure.destroyedAt || structure.unanchoring ||
      Number(structure.ownerCorpID || structure.ownerID) !== corporationID) {
    return kit.block(operation, "blocked", `Structure ${operation.structureID} no longer exists as a usable asset of corporation ${corporationID}.`);
  }
  if (structure.hasQuantumCore === true) {
    if (!coreInstallIsReconciled(operation, bot)) {
      return kit.block(operation, "review", `Structure ${operation.structureID} reports a Quantum Core, but its exact core item is not in the authoritative core slot.`);
    }
    operation.coreInstalled = true;
    operation.stage = "return";
    operation.pendingInstall = false;
    kit.record(operation, `Reconciled Quantum Core ${operation.coreItemID} in structure ${operation.structureID}; no second inventory transfer was issued.`);
    kit.save(operation);
  }
  if (operation.pendingInstall === true) {
    if (coreInstallIsReconciled(operation, bot)) {
      operation.stage = "return";
      operation.pendingInstall = false;
      kit.record(operation, `Recovered the completed Quantum Core move to structure ${operation.structureID} after an uncertain broker response.`);
      kit.save(operation);
    } else {
      return kit.block(operation, "review", `Quantum Core transfer to structure ${operation.structureID} has no matching structure flag and core state; inspect inventory before retrying.`);
    }
  }
  const structureConstants = require("../structure/structureConstants");
  if (Number(structure.state) !== Number(structureConstants.STRUCTURE_STATE.ONLINING_VULNERABLE) &&
      operation.stage !== "return") {
    return kit.block(operation, "holding", `Structure ${operation.structureID} is in state ${structure.state}; core installation waits for the authoritative dockable onlining-vulnerable state.`);
  }

  const itemStore = require("../inventory/itemStore");
  if (operation.stage === "to-core") {
    const cargo = kit.inventory.listCargo(bot, Number(operation.coreTypeID))
      .find((item) => Number(item.itemID) === Number(operation.coreItemID));
    if (cargo) {
      operation.stage = "to-structure";
      kit.save(operation);
    } else {
      const core = getOwnedStructureItem(bot, operation.coreItemID);
      if (!core || Number(core.typeID) !== Number(operation.coreTypeID) ||
          Number(core.flagID) !== Number(itemStore.ITEM_FLAGS.HANGAR) ||
          Number(core.locationID) !== Number(operation.sourceStationID)) {
        return kit.block(operation, "review", `Required Quantum Core ${operation.coreItemID} is not in the bot's recorded source hangar or active ship cargo.`);
      }
      const transport = await ensureCoreTransport(operation, bot, kit, core);
      if (transport) return transport;
      const step = await kit.travelToStation(operation, bot, Number(operation.sourceStationID));
      if (step) return step;
      const loaded = kit.inventory.loadToCargo(bot, Number(core.itemID), 1);
      const loadedItem = itemStore.findItemById(Number(core.itemID));
      const activeShipID = Number(require("./playerBotSpaceRuntime").getActorSession(bot).shipID) || 0;
      if (!loaded.success || !loadedItem || Number(loadedItem.locationID) !== activeShipID ||
          Number(loadedItem.flagID) !== Number(itemStore.ITEM_FLAGS.CARGO_HOLD)) {
        return kit.block(operation, "holding", `Could not load Quantum Core ${core.itemID} into the active ship: ${loaded.message || "inventory transfer was not confirmed"}.`);
      }
      operation.stage = "to-structure";
      kit.record(operation, `Loaded Quantum Core ${core.itemID}; traveling to structure ${operation.structureID} after its anchor timer.`);
      kit.save(operation);
      return { delayMs: 3000 };
    }
  }
  if (operation.stage === "to-structure") {
    const step = await kit.travelToStation(operation, bot, Number(operation.structureID));
    if (step) return step;
    operation.stage = "install-core";
    kit.save(operation);
  }
  if (operation.stage === "install-core") {
    const session = kit.space.getActorSession(bot);
    if (Number(session.stationID || session.structureID) !== Number(operation.structureID)) {
      return kit.block(operation, "holding", `The bot is not docked at structure ${operation.structureID}; the Quantum Core was not moved.`);
    }
    const cargo = kit.inventory.listCargo(bot, Number(operation.coreTypeID))
      .find((item) => Number(item.itemID) === Number(operation.coreItemID));
    if (!cargo) return kit.block(operation, "review", `Quantum Core ${operation.coreItemID} is not aboard; refusing to submit a core-slot transfer.`);
    operation.pendingInstall = true;
    kit.save(operation);
    const moved = kit.inventory.moveCargoToStructure(
      bot,
      Number(operation.coreItemID),
      Number(operation.structureID),
      itemStore.ITEM_FLAGS.STRUCTURE_DEED,
      1,
    );
    if (!moved.success && !coreInstallIsReconciled(operation, bot)) {
      return kit.block(operation, moved.moved > 0 ? "review" : "holding", moved.message || "The inventory authority did not confirm Quantum Core installation.");
    }
    if (!coreInstallIsReconciled(operation, bot)) {
      return kit.block(operation, "review", `Inventory moved Quantum Core ${operation.coreItemID}, but structure ${operation.structureID} did not confirm its core state and core-slot item.`);
    }
    operation.pendingInstall = false;
    operation.coreInstalled = true;
    operation.stage = "return";
    kit.record(operation, `Installed Quantum Core ${operation.coreItemID} into structure ${operation.structureID} through the normal inventory broker; the structure authority started its repair timer.`);
    kit.save(operation);
  }
  if (operation.stage === "return") {
    const step = await kit.travelToStation(operation, bot, Number(operation.homeStationID));
    if (step) return step;
    return kit.finish(operation, `Quantum Core ${operation.coreItemID} is installed and confirmed in corporation structure ${operation.structureID}; the structure's repair timer and service-module provisioning remain in progress.`);
  }
  return kit.block(operation, "blocked", `Unknown Quantum Core installation stage ${operation.stage}.`);
}

function findStructureMaintenancePlan(bot) {
  if (!bot) return null;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  if (!corporationID || !isStructureManager(bot)) return null;
  const caretaker = getStructureCaretakerAssignment(corporationID);
  if (!caretaker || caretaker.characterID !== positiveID(bot.characterID)) return null;

  const structureState = require("../structure/structureState");
  const constants = require("../structure/structureConstants");
  const moduleRuntime = require("../structure/structureServiceModules");
  const itemTypes = require("../inventory/itemTypeRegistry");
  const itemStore = require("../inventory/itemStore");
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const activeTargets = new Set(require("./playerBotOperationRuntime").listOperations()
    .filter((operation) => operation && operation.kind === "structure-service-provision" &&
      ["active", "holding", "review"].includes(operation.status))
    .map((operation) => positiveID(operation.structureID)));
  const structures = structureState.listStructures()
    .filter((structure) => Number(structure && (structure.ownerCorpID || structure.ownerID)) === corporationID)
    .filter((structure) => !structure.destroyedAt && !structure.unanchoring && structure.hasQuantumCore === true)
    .filter((structure) => structureState.isDockingServiceOnline(structure))
    .filter((structure) => !activeTargets.has(positiveID(structure.structureID)))
    .sort((left, right) => {
      const lowPowerFirst = Number(Number(right.upkeepState) === constants.STRUCTURE_UPKEEP_STATE.LOW_POWER) -
        Number(Number(left.upkeepState) === constants.STRUCTURE_UPKEEP_STATE.LOW_POWER);
      return lowPowerFirst || positiveID(left.structureID) - positiveID(right.structureID);
    });
  if (!structures.length) return null;

  const itemTypeByID = new Map(itemTypes.listItemTypes()
    .filter((item) => item && item.published !== false)
    .map((item) => [positiveID(item.typeID), item]));
  const serviceModuleTypes = moduleRuntime.SERVICE_IDS_BY_MODULE_TYPE_ID || {};
  const moduleTypeIDs = Object.keys(serviceModuleTypes).map(positiveID).filter(Boolean);
  const allowedModuleTypes = (structure) => {
    const structureType = structureState.getStructureTypeByID(structure.typeID);
    const allowedServices = new Set(constants.getAllowedServicesForStructureType(
      structure.typeID,
      structureType && structureType.structureFamily,
    ).map(Number));
    return moduleTypeIDs
      .filter((typeID) => (serviceModuleTypes[String(typeID)] || []).some((serviceID) => allowedServices.has(Number(serviceID))))
      .sort((left, right) => (left === INDUSTRY_SERVICE_MODULE_TYPE_ID ? -1 :
        right === INDUSTRY_SERVICE_MODULE_TYPE_ID ? 1 : left - right));
  };
  const readFuel = (structureID, moduleTypeID) => {
    const fuelGroupID = moduleRuntime.getStructureServiceModuleFuelGroupID(moduleTypeID);
    const cycleFuel = moduleRuntime.getStructureServiceModuleCycleFuelNeed(moduleTypeID);
    const onlineFuel = moduleRuntime.getStructureServiceModuleOnlineFuelNeed(moduleTypeID);
    if (fuelGroupID <= 0 || cycleFuel <= 0 || onlineFuel <= 0) return null;
    const fuelTypes = [...itemTypeByID.values()].filter((item) =>
      Number(item.groupID) === fuelGroupID && Number(item.volume) > 0,
    );
    if (!fuelTypes.length) return null;
    const currentFuel = moduleRuntime.getStructureFuelCandidateItems(structureID, moduleTypeID)
      .reduce((total, item) => total + Math.max(0, Math.trunc(Number(item.stacksize ?? item.quantity) || 0)), 0);
    return { fuelGroupID, cycleFuel, onlineFuel, fuelTypes, currentFuel };
  };
  const sessionShipID = positiveID(session.shipID);

  for (const structure of structures) {
    const structureID = positiveID(structure.structureID);
    const fittedModules = moduleRuntime.listFittedStructureServiceModules(structureID);
    const onlineModules = moduleRuntime.listOnlineStructureServiceModules(structureID);
    let module = null;
    let fuel = null;
    let moduleAlreadyInstalled = false;
    let moduleOnline = false;
    let serviceSlotFlagID = 0;

    if (onlineModules.length) {
      // Keep every currently online service fueled. If multiple modules use
      // the same fuel group, budget their combined hourly consumption.
      const groups = new Map();
      for (const fitted of onlineModules) {
        const details = readFuel(structureID, positiveID(fitted.typeID));
        if (!details) continue;
        const group = groups.get(details.fuelGroupID) || { modules: [], ...details, cycleFuel: 0 };
        group.modules.push(fitted);
        group.cycleFuel += details.cycleFuel;
        groups.set(details.fuelGroupID, group);
      }
      for (const group of [...groups.values()].sort((left, right) => left.fuelGroupID - right.fuelGroupID)) {
        const dailyFuel = group.cycleFuel * 24;
        const targetFuel = dailyFuel * STRUCTURE_MAINTENANCE_FUEL_DAYS;
        const fuelUnitsNeeded = Math.max(0, Math.ceil(targetFuel - group.currentFuel));
        if (fuelUnitsNeeded < dailyFuel) continue;
        module = group.modules[0];
        fuel = group;
        moduleAlreadyInstalled = true;
        moduleOnline = true;
        serviceSlotFlagID = Number(module.flagID) || 0;
        break;
      }
      if (!module) continue;
    } else {
      // A low-power structure needs one valid service online. Reuse a fitted
      // service if possible; otherwise choose a supported useful module.
      module = fittedModules.find((item) => readFuel(structureID, positiveID(item.typeID))) || null;
      if (module) {
        moduleAlreadyInstalled = true;
        serviceSlotFlagID = Number(module.flagID) || 0;
      } else {
        const usedSlots = new Set(fittedModules.map((item) => Number(item.flagID)));
        serviceSlotFlagID = moduleRuntime.STRUCTURE_SERVICE_SLOT_FLAGS
          .find((flagID) => !usedSlots.has(Number(flagID))) || 0;
        if (!serviceSlotFlagID) continue;
        for (const typeID of allowedModuleTypes(structure)) {
          const details = readFuel(structureID, typeID);
          if (!details) continue;
          module = { itemID: 0, typeID, flagID: serviceSlotFlagID };
          fuel = details;
          break;
        }
        if (!module) continue;
      }
      fuel = fuel || readFuel(structureID, positiveID(module.typeID));
      if (!fuel) continue;
    }

    const moduleTypeID = positiveID(module.typeID);
    const dailyFuel = fuel.cycleFuel * 24;
    const targetFuel = moduleOnline
      ? dailyFuel * STRUCTURE_MAINTENANCE_FUEL_DAYS
      : fuel.onlineFuel + dailyFuel * 4;
    const fuelUnitsNeeded = Math.max(0, Math.ceil(targetFuel - fuel.currentFuel));
    if (moduleOnline && fuelUnitsNeeded < dailyFuel) continue;

    let ownedModule = null;
    if (!moduleAlreadyInstalled) {
      ownedModule = itemStore.listCharacterItems(bot.characterID).find((item) =>
        Number(item.ownerID) === Number(bot.characterID) && Number(item.typeID) === moduleTypeID &&
        (Number(item.locationID) === sessionShipID && Number(item.flagID) === Number(itemStore.ITEM_FLAGS.CARGO_HOLD) ||
          Number(item.flagID) === Number(itemStore.ITEM_FLAGS.HANGAR) &&
          (worldData.getStationByID(Number(item.locationID)) || worldData.getStructureByID(Number(item.locationID)))),
      ) || null;
      module = { ...module, itemID: positiveID(ownedModule && ownedModule.itemID) };
    }
    const serviceID = (moduleRuntime.getStructureServiceIDsForModuleType(moduleTypeID) || [])[0] || 0;
    const moduleRecord = itemTypeByID.get(moduleTypeID) || {};
    const maximumFuelVolume = Math.max(...fuel.fuelTypes.map((item) => Number(item.volume) || 0));
    const requiredCargoVolume = (moduleAlreadyInstalled || ownedModule ? 0 : Number(moduleRecord.volume) || 0) +
      (fuelUnitsNeeded ? maximumFuelVolume * fuelUnitsNeeded : 0);
    return {
      purpose: "maintenance",
      structureID,
      structureTypeID: positiveID(structure.typeID),
      solarSystemID: positiveID(structure.solarSystemID),
      corporationID,
      moduleTypeID,
      moduleItemID: positiveID(module && module.itemID || ownedModule && ownedModule.itemID),
      moduleAlreadyInstalled,
      serviceSlotFlagID,
      moduleSourceStationID: ownedModule && Number(ownedModule.locationID) !== sessionShipID
        ? positiveID(ownedModule.locationID)
        : positiveID(session.stationID || session.structureID),
      moduleInCargo: Boolean(ownedModule && Number(ownedModule.locationID) === sessionShipID),
      serviceID,
      fuelGroupID: fuel.fuelGroupID,
      fuelTypeIDs: fuel.fuelTypes.map((item) => positiveID(item.typeID)).filter(Boolean),
      fuelUnitsNeeded,
      currentFuelUnits: fuel.currentFuel,
      moduleOnline,
      requiredCargoVolume,
      minimumFuelVolume: Math.min(...fuel.fuelTypes.map((item) => Number(item.volume) || Infinity)),
    };
  }
  return null;
}

function findStructureServiceProvisionPlan(bot) {
  if (!bot || bot.specialty !== "industry") return null;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  if (!corporationID) return null;
  const structureState = require("../structure/structureState");
  const candidates = structureState.listStructures()
    .filter((structure) => Number(structure && (structure.ownerCorpID || structure.ownerID)) === corporationID)
    .filter((structure) => !structure.destroyedAt && !structure.unanchoring && structure.hasQuantumCore === true)
    .filter((structure) => structureState.isDockingServiceOnline(structure));
  if (!candidates.length) return null;
  const activeTargets = new Set(require("./playerBotOperationRuntime").listOperations()
    .filter((operation) => operation && operation.kind === "structure-service-provision" &&
      ["active", "holding", "review"].includes(operation.status))
    .map((operation) => Number(operation.structureID)));
  const authorityCandidates = candidates.filter((structure) => !activeTargets.has(positiveID(structure.structureID)));
  if (!authorityCandidates.length || !isStructureManager(bot)) return null;

  const constants = require("../structure/structureConstants");
  const moduleRuntime = require("../structure/structureServiceModules");
  const itemTypes = require("../inventory/itemTypeRegistry");
  const itemStore = require("../inventory/itemStore");
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const heldModule = itemStore.listCharacterItems(bot.characterID).find((item) =>
    Number(item.ownerID) === Number(bot.characterID) &&
    Number(item.typeID) === INDUSTRY_SERVICE_MODULE_TYPE_ID &&
    (Number(item.locationID) === Number(session.shipID) && Number(item.flagID) === Number(itemStore.ITEM_FLAGS.CARGO_HOLD) ||
      Number(item.flagID) === Number(itemStore.ITEM_FLAGS.HANGAR) &&
      (worldData.getStationByID(Number(item.locationID)) || worldData.getStructureByID(Number(item.locationID)))),
  ) || null;

  for (const structure of authorityCandidates) {
    const structureType = structureState.getStructureTypeByID(structure.typeID);
    const allowedServices = constants.getAllowedServicesForStructureType(
      structure.typeID,
      structureType && structureType.structureFamily,
    );
    const moduleServices = moduleRuntime.getStructureServiceIDsForModuleType(INDUSTRY_SERVICE_MODULE_TYPE_ID);
    const manufacturingServiceID = Number(constants.STRUCTURE_SERVICE_ID.MANUFACTURING_BASIC);
    if (!allowedServices.includes(manufacturingServiceID) || !moduleServices.includes(manufacturingServiceID)) continue;
    const fittedModules = moduleRuntime.listFittedStructureServiceModules(structure.structureID);
    const industryModule = fittedModules.find((item) =>
      moduleRuntime.getStructureServiceIDsForModuleType(item.typeID).includes(manufacturingServiceID),
    ) || null;
    const usedSlots = new Set(fittedModules.map((item) => Number(item.flagID)));
    const serviceSlotFlagID = industryModule ? Number(industryModule.flagID) :
      moduleRuntime.STRUCTURE_SERVICE_SLOT_FLAGS.find((flagID) => !usedSlots.has(Number(flagID)));
    if (!serviceSlotFlagID) continue;
    const moduleTypeID = positiveID(industryModule && industryModule.typeID) || INDUSTRY_SERVICE_MODULE_TYPE_ID;
    const fuelGroupID = moduleRuntime.getStructureServiceModuleFuelGroupID(moduleTypeID);
    const cycleFuel = moduleRuntime.getStructureServiceModuleCycleFuelNeed(moduleTypeID);
    const onlineFuel = moduleRuntime.getStructureServiceModuleOnlineFuelNeed(moduleTypeID);
    if (fuelGroupID <= 0 || cycleFuel <= 0 || onlineFuel <= 0) continue;
    const fuelTypes = itemTypes.listItemTypes().filter((item) =>
      Number(item.groupID) === fuelGroupID && item.published !== false && Number(item.volume) > 0,
    );
    if (!fuelTypes.length) continue;
    const currentFuel = moduleRuntime.getStructureFuelCandidateItems(structure.structureID, moduleTypeID)
      .reduce((total, item) => total + Math.max(0, Math.trunc(Number(item.stacksize ?? item.quantity) || 0)), 0);
    const moduleOnline = Boolean(industryModule && moduleRuntime.listOnlineStructureServiceModules(structure.structureID)
      .some((item) => Number(item.itemID) === Number(industryModule.itemID)));
    const dailyFuel = cycleFuel * 24;
    const targetFuel = moduleOnline
      ? dailyFuel * STRUCTURE_SERVICE_TARGET_FUEL_DAYS
      : onlineFuel + dailyFuel * 4;
    const fuelUnitsNeeded = Math.max(0, Math.ceil(targetFuel - currentFuel));
    if (industryModule && moduleOnline && fuelUnitsNeeded < dailyFuel) continue;
    if (!industryModule && fuelUnitsNeeded <= 0) continue;

    const ownedModule = industryModule ? null : heldModule;
    const moduleItemType = itemTypes.resolveItemByTypeID(moduleTypeID) || {};
    const fuelVolume = Math.max(...fuelTypes.map((item) => Number(item.volume) || 0));
    const requiredCargoVolume = (industryModule || ownedModule ? 0 : Number(moduleItemType.volume) || 0) +
      (fuelUnitsNeeded ? fuelVolume * fuelUnitsNeeded : 0);
    return {
      structureID: positiveID(structure.structureID),
      structureTypeID: positiveID(structure.typeID),
      solarSystemID: positiveID(structure.solarSystemID),
      corporationID,
      moduleTypeID,
      moduleItemID: positiveID(industryModule && industryModule.itemID || ownedModule && ownedModule.itemID),
      moduleAlreadyInstalled: Boolean(industryModule),
      serviceSlotFlagID: Number(serviceSlotFlagID),
      moduleSourceStationID: ownedModule && Number(ownedModule.locationID) !== Number(session.shipID)
        ? positiveID(ownedModule.locationID)
        : positiveID(session.stationID || session.structureID),
      moduleInCargo: Boolean(ownedModule && Number(ownedModule.locationID) === Number(session.shipID)),
      serviceID: manufacturingServiceID,
      fuelGroupID,
      fuelTypeIDs: fuelTypes.map((item) => positiveID(item.typeID)).filter(Boolean),
      fuelUnitsNeeded,
      currentFuelUnits: currentFuel,
      moduleOnline,
      requiredCargoVolume,
      minimumFuelVolume: Math.min(...fuelTypes.map((item) => Number(item.volume) || Infinity)),
    };
  }
  return null;
}

function startStructureServiceProvision(bot, plan, tools = {}) {
  if (!bot || !plan || typeof tools.baseOperation !== "function" || typeof tools.saveOperation !== "function") {
    return { success: false, message: "Structure service provisioning must be started through the playerbot operation runtime." };
  }
  if (!isStructureManager(bot)) return { success: false, message: `${bot.characterName} no longer has persisted corporation structure-management authority.` };
  const structure = require("../structure/structureState").getStructureByID(positiveID(plan.structureID));
  if (!structure || Number(structure.ownerCorpID || structure.ownerID) !== Number(plan.corporationID) ||
      structure.hasQuantumCore !== true || structure.destroyedAt || structure.unanchoring) {
    return { success: false, message: `Structure ${plan.structureID} is not a usable, core-powered asset of corporation ${plan.corporationID}.` };
  }
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const homeStationID = positiveID(session.stationID || session.structureID) ||
    require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID;
  const operation = tools.baseOperation("structure-service-provision", bot, {
    purpose: plan.purpose === "maintenance" ? "maintenance" : "industry",
    stage: "source",
    structureID: positiveID(plan.structureID),
    structureTypeID: positiveID(plan.structureTypeID),
    solarSystemID: positiveID(plan.solarSystemID),
    serviceID: positiveID(plan.serviceID),
    corporationID: positiveID(plan.corporationID),
    moduleTypeID: positiveID(plan.moduleTypeID),
    moduleItemID: positiveID(plan.moduleItemID),
    moduleAlreadyInstalled: plan.moduleAlreadyInstalled === true,
    serviceSlotFlagID: Number(plan.serviceSlotFlagID) || 0,
    moduleInCargo: plan.moduleInCargo === true,
    moduleSourceStationID: positiveID(plan.moduleSourceStationID),
    fuelGroupID: positiveID(plan.fuelGroupID),
    fuelTypeIDs: [...plan.fuelTypeIDs],
    fuelUnitsNeeded: Math.max(0, Math.trunc(Number(plan.fuelUnitsNeeded) || 0)),
    requiredCargoVolume: Number(plan.requiredCargoVolume) || 0,
    purchaseItems: [],
    purchaseIndex: 0,
    homeStationID,
    spent: 0,
    pendingPurchase: null,
    pendingLoad: null,
    pendingStructureMove: null,
    autonomous: true,
  });
  tools.record(operation, operation.purpose === "maintenance"
    ? `Reserved corporation structure ${operation.structureID} for automated power and fuel maintenance.`
    : `Reserved structure ${operation.structureID} to provision its manufacturing service through market and inventory authorities.`);
  tools.saveOperation(operation);
  return { success: true, operation, message: operation.purpose === "maintenance"
    ? `${bot.characterName} will restore or maintain power at corporation structure ${operation.structureID} with a real service module and compatible fuel.`
    : `${bot.characterName} will provision manufacturing service ${operation.serviceID} at structure ${operation.structureID} with a real service module and fuel.` };
}

function canCarryStructureServicePlan(bot, plan) {
  if (!bot || !plan) return false;
  return require("./playerBotInventoryRuntime").getCargoBayFree(bot) + 1e-9 >=
    Number(plan.requiredCargoVolume || 0);
}

function findAccessibleManufacturingFacility(bot) {
  if (!bot || bot.specialty !== "industry") return null;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  if (!corporationID) return null;
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const structureState = require("../structure/structureState");
  const moduleRuntime = require("../structure/structureServiceModules");
  const itemStore = require("../inventory/itemStore");
  const industryStaticData = require("../industry/industryStaticData");
  const activityID = require("../industry/industryConstants").INDUSTRY_ACTIVITY.MANUFACTURING;
  const serviceIDs = moduleRuntime.getStructureServiceIDsForModuleType(INDUSTRY_SERVICE_MODULE_TYPE_ID);
  const candidates = [];
  for (const structure of structureState.listStructures()) {
    if (Number(structure && (structure.ownerCorpID || structure.ownerID)) !== corporationID ||
        structure.hasQuantumCore !== true || structure.destroyedAt || structure.unanchoring ||
        !structureState.isDockingServiceOnline(structure)) continue;
    const allowedService = serviceIDs.find((serviceID) =>
      Number(structure.serviceStates && structure.serviceStates[String(serviceID)]) ===
        Number(require("../structure/structureConstants").STRUCTURE_SERVICE_STATE.ONLINE) &&
      moduleRuntime.listOnlineStructureServiceModules(structure.structureID).some((module) =>
        moduleRuntime.getStructureServiceIDsForModuleType(module.typeID).includes(Number(serviceID))));
    if (!allowedService) continue;
    const dockAccess = structureState.canCharacterDockAtStructure(session, structure, {
      shipTypeID: Number(session.shipTypeID) || undefined,
    });
    if (!dockAccess || dockAccess.success !== true) continue;
    const facility = industryStaticData.getFacilityPayloadByID(Number(structure.structureID), session);
    if (!facility || !facility.activities || !facility.activities[activityID] ||
        !Object.hasOwn(facility.serviceAccess || {}, String(allowedService))) continue;
    candidates.push({
      facilityID: Number(structure.structureID),
      structureID: Number(structure.structureID),
      solarSystemID: Number(structure.solarSystemID) || 0,
      serviceID: Number(allowedService),
      name: String(structure.name || structure.structureName || `Structure ${structure.structureID}`),
      sameSystem: Number(structure.solarSystemID) === Number(character.solarSystemID),
    });
  }
  return candidates.sort((left, right) => Number(right.sameSystem) - Number(left.sameSystem) ||
    left.facilityID - right.facilityID)[0] || null;
}

function countStructureServiceBay(structureID, flagID, typeID) {
  return require("../inventory/itemStore").listContainerItems(null, Number(structureID), Number(flagID))
    .filter((item) => Number(item.typeID) === Number(typeID))
    .reduce((total, item) => total + require("./playerBotInventoryRuntime").unitsOf(item), 0);
}

function reconcileStructureServicePurchase(operation, bot) {
  const pending = operation.pendingPurchase;
  if (!pending) return { state: "none" };
  const inventory = require("./playerBotInventoryRuntime");
  const wallet = require("../account/walletState");
  const nowUnits = inventory.countHangar(bot, pending.stationID, pending.typeID) +
    inventory.countCargo(bot, pending.typeID);
  const bought = Math.max(0, nowUnits - Number(pending.baselineUnits));
  const balance = Number(wallet.getCharacterWallet(bot.characterID)?.balance) || 0;
  const spent = Math.max(0, Number(pending.baselineBalance) - balance);
  const hasTransactionCheckpoint = pending.baselineTransactionID !== null &&
    pending.baselineTransactionID !== undefined;
  const txID = Number(pending.baselineTransactionID);
  const transactions = hasTransactionCheckpoint && Number.isFinite(txID)
    ? wallet.getCharacterMarketTransactions(bot.characterID).filter((entry) =>
      Number(entry.transactionID) > txID && Number(entry.buyerID) === Number(bot.characterID) &&
      Number(entry.typeID) === Number(pending.typeID) && Number(entry.stationID) === Number(pending.stationID))
    : [];
  const transactionUnits = transactions.reduce((total, entry) =>
    total + Math.max(0, Math.trunc(Number(entry.quantity) || 0)), 0);
  const transactionSpend = transactions.reduce((total, entry) =>
    total + Math.max(0, Number(entry.quantity) || 0) * Math.max(0, Number(entry.price) || 0), 0);
  if (bought === Number(pending.quantity) && spent > 0 &&
      (!hasTransactionCheckpoint || transactionUnits === bought && Math.abs(transactionSpend - spent) < 0.02)) {
    const purchase = operation.purchaseItems[Number(pending.itemIndex)];
    if (!purchase) return { state: "review", message: "The market purchase completed but its durable purchase queue entry is missing." };
    purchase.purchased = true;
    purchase.boughtUnits = bought;
    purchase.actualSpend = Math.round(spent * 100) / 100;
    purchase.baselineCargoUnits = inventory.countCargo(bot, purchase.typeID);
    operation.spent = Math.round(((Number(operation.spent) || 0) + spent) * 100) / 100;
    operation.pendingPurchase = null;
    operation.stage = "load";
    return { state: "complete", purchase, bought, spent };
  }
  if (bought === 0 && spent < 0.01 && transactionUnits === 0 && pending.resultWasRejected === true) {
    operation.pendingPurchase = null;
    return { state: "no-effect" };
  }
  if (bought === 0 && spent < 0.01 && transactionUnits === 0 && pending.outcomeUnknown !== true) {
    operation.pendingPurchase = null;
    return { state: "no-effect" };
  }
  return {
    state: "review",
    message: `Market purchase for type ${pending.typeID} is ambiguous: inventory ${bought}/${pending.quantity}, wallet spend ${spent.toFixed(2)} ISK, transaction units ${transactionUnits}.`,
  };
}

function findJitaServiceOffer(fallback, economy, initialExcludedStationIDs = []) {
  const matches = [];
  const excluded = new Set((Array.isArray(initialExcludedStationIDs) ? initialExcludedStationIDs : [])
    .map(Number).filter(Boolean));
  for (const typeID of fallback.typeIDs || []) {
    const candidates = economy.findSellStationsForPackage([{
      typeID: Number(typeID), quantity: Number(fallback.quantity),
    }]).filter((candidate) => candidate.isJita === true && candidate.complete === true &&
      !excluded.has(Number(candidate.stationID)));
    const selected = candidates[0];
    if (!selected) continue;
    matches.push({
      typeID: Number(typeID),
      stationID: Number(selected.stationID),
      estimatedCost: Number(selected.estimatedCost) || 0,
      unitPrice: Number(selected.estimatedCost) / Math.max(1, Number(fallback.quantity) || 1),
    });
  }
  matches.sort((left, right) => left.estimatedCost - right.estimatedCost ||
    left.stationID - right.stationID || left.typeID - right.typeID);
  return matches[0] || null;
}

function findNextJitaServiceOfferForPurchase(purchase, economy) {
  if (!purchase || !economy || typeof economy.isJitaStation !== "function") return null;
  const currentStationID = positiveID(purchase.sourceStationID);
  if (!currentStationID || !economy.isJitaStation(currentStationID)) return null;
  const previouslyChecked = (Array.isArray(purchase.checkedJitaStationIDs)
    ? purchase.checkedJitaStationIDs
    : []).map(positiveID).filter(Boolean);
  return findJitaServiceOffer({
    typeIDs: [positiveID(purchase.typeID)],
    quantity: Math.max(1, Math.trunc(Number(purchase.quantity) || 1)),
  }, economy, [...new Set([...previouslyChecked, currentStationID])]);
}

function shouldRefreshJitaServiceOffer(purchase, quote, economy) {
  if (!purchase || !quote || quote.success !== true || !economy ||
      typeof economy.isJitaStation !== "function" ||
      !economy.isJitaStation(positiveID(purchase.sourceStationID))) return false;
  return !quote.bestAsk || Number(quote.bestAsk.quantity) < Number(purchase.quantity);
}

async function advanceStructureServiceProvision(operation, bot, kit) {
  if (!isStructureManager(bot)) return kit.block(operation, "blocked", "Persisted corporation authority no longer permits structure service provisioning.");
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  const structureState = require("../structure/structureState");
  const structure = structureState.getStructureByID(positiveID(operation.structureID));
  if (!structure || Number(structure.ownerCorpID || structure.ownerID) !== corporationID ||
      structure.hasQuantumCore !== true || structure.destroyedAt || structure.unanchoring) {
    return kit.block(operation, "blocked", `Structure ${operation.structureID} is no longer a core-powered asset of corporation ${corporationID}.`);
  }
  if (!structureState.isDockingServiceOnline(structure)) {
    return kit.block(operation, "holding", `Structure ${operation.structureID} is not currently dockable; provisioning waits for the authoritative structure state.`);
  }
  const trade = require("./playerBotTradeRuntime");
  const inventory = kit.inventory;
  const itemStore = require("../inventory/itemStore");
  const wallet = require("../account/walletState");
  const session = kit.space.getActorSession(bot);
  const dockedID = positiveID(session.stationID || session.structureID);
  const maintenance = operation.purpose === "maintenance";

  if (operation.pendingPurchase) {
    const reconciled = reconcileStructureServicePurchase(operation, bot);
    if (reconciled.state === "review") return kit.block(operation, "review", reconciled.message);
    if (reconciled.state === "complete") {
      kit.record(operation, `Bought and reconciled ${reconciled.bought} unit(s) of type ${reconciled.purchase.typeID} at station ${reconciled.purchase.sourceStationID} for ${reconciled.spent.toFixed(2)} ISK.`);
      kit.save(operation);
      return { delayMs: 3000 };
    }
    if (reconciled.state === "no-effect") {
      kit.save(operation);
      return kit.block(operation, "holding", `No market transfer was recorded for type ${operation.purchaseItems[operation.purchaseIndex]?.typeID || "unknown"}; the operation will refresh its quote before retrying.`);
    }
  }

  if (operation.pendingStructureMove) {
    const pending = operation.pendingStructureMove;
    if (pending.kind === "fuel") {
      const moved = countStructureServiceBay(operation.structureID,
        Number(itemStore.ITEM_FLAGS.STRUCTURE_FUEL_BAY), Number(pending.typeID)) -
        Number(pending.baselineUnits || 0);
      if (moved === Number(pending.quantity)) {
        operation.fuelInstalled = true;
        operation.pendingStructureMove = null;
        kit.record(operation, `Reconciled ${moved} fuel blocks in structure ${operation.structureID} after inventory transfer recovery.`);
        kit.save(operation);
      } else if (moved > 0) {
        return kit.block(operation, "review", `Recovered structure fuel move has ${moved} of ${pending.quantity} blocks; inspect exact cargo and fuel bay quantities.`);
      } else if (inventory.countCargo(bot, Number(pending.typeID)) >= Number(pending.quantity)) {
        operation.pendingStructureMove = null;
        kit.save(operation);
      } else {
        return kit.block(operation, "review", "Fuel transfer has neither the recorded ship-cargo amount nor a matching fuel-bay delta; manual inventory reconciliation is required.");
      }
    } else if (pending.kind === "module") {
      const item = itemStore.findItemById(Number(pending.itemID));
      if (item && Number(item.locationID) === Number(operation.structureID) &&
          Number(item.flagID) === Number(pending.flagID)) {
        operation.pendingStructureMove = null;
        operation.stage = "online-service";
        kit.record(operation, `Reconciled service module ${pending.itemID} in its structure slot after inventory transfer recovery.`);
        kit.save(operation);
      } else if (item && Number(item.locationID) === Number(session.shipID) &&
          Number(item.flagID) === Number(itemStore.ITEM_FLAGS.CARGO_HOLD)) {
        operation.pendingStructureMove = null;
        kit.save(operation);
      } else {
        return kit.block(operation, "review", `Service module ${pending.itemID} is not in the recorded structure slot or ship cargo; manual inventory reconciliation is required.`);
      }
    }
  }

  if (operation.stage === "source") {
    if (!dockedID) {
      const step = await kit.travelToStation(operation, bot, Number(operation.homeStationID));
      if (step) return step;
    }
    const purchases = [];
    const fallbackItems = [];
    if (operation.moduleAlreadyInstalled !== true) {
      const ownedModule = operation.moduleItemID ? itemStore.findItemById(Number(operation.moduleItemID)) : null;
      if (ownedModule && Number(ownedModule.ownerID) === Number(bot.characterID)) {
        const sourceStationID = Number(ownedModule.locationID) === Number(session.shipID)
          ? dockedID
          : Number(ownedModule.locationID);
        purchases.push({
          purpose: "module", typeID: Number(operation.moduleTypeID), quantity: 1,
          sourceStationID, owned: true, itemID: Number(ownedModule.itemID),
          inCargo: Number(ownedModule.locationID) === Number(session.shipID),
        });
      } else {
        const quote = await trade.readBestAskOutsideJita(bot.characterName, Number(operation.moduleTypeID), 1)
          .catch((error) => ({ success: false, message: error.message }));
        if (!quote.success) return kit.block(operation, "holding", `Could not verify safe regional supply for service module ${operation.moduleTypeID}: ${quote.message || "market unavailable"}.`);
        if (quote.bestAsk) {
          purchases.push({ purpose: "module", typeID: Number(operation.moduleTypeID), quantity: 1,
            sourceStationID: Number(quote.bestAsk.stationID), unitPrice: Number(quote.bestAsk.price), owned: false });
        } else {
          fallbackItems.push({ purpose: "module", typeIDs: [Number(operation.moduleTypeID)], quantity: 1 });
        }
      }
    }
    if (Number(operation.fuelUnitsNeeded) > 0) {
      const available = [];
      for (const typeID of operation.fuelTypeIDs || []) {
        const quote = await trade.readBestAskOutsideJita(bot.characterName, Number(typeID), Number(operation.fuelUnitsNeeded))
          .catch((error) => ({ success: false, message: error.message }));
        if (!quote.success) return kit.block(operation, "holding", `Could not verify non-Jita fuel supply for type ${typeID}: ${quote.message || "market unavailable"}.`);
        if (quote.bestAsk) available.push({ typeID: Number(typeID), ask: quote.bestAsk });
      }
      available.sort((left, right) => Number(left.ask.price) - Number(right.ask.price) ||
        Number(left.ask.stationID) - Number(right.ask.stationID) || left.typeID - right.typeID);
      if (available.length) {
        const selected = available[0];
        operation.fuelTypeID = selected.typeID;
        purchases.push({ purpose: "fuel", typeID: selected.typeID, quantity: Number(operation.fuelUnitsNeeded),
          sourceStationID: Number(selected.ask.stationID), unitPrice: Number(selected.ask.price), owned: false });
      } else {
        fallbackItems.push({ purpose: "fuel", typeIDs: (operation.fuelTypeIDs || []).map(Number),
          quantity: Number(operation.fuelUnitsNeeded) });
      }
    }
    operation.purchaseItems = purchases;
    operation.jitaFallbackItems = fallbackItems;
    operation.purchaseIndex = 0;
    if (fallbackItems.length) {
      operation.stage = "to-jita";
      kit.record(operation, `No sufficient non-Jita order for ${fallbackItems.map((entry) => entry.purpose).join(" and ")}; checking the Jita seed market after regional supply was exhausted.`);
      kit.save(operation);
      return { delayMs: 3000 };
    }
    operation.stage = "buy";
    const expected = purchases.filter((entry) => !entry.owned)
      .reduce((total, entry) => total + entry.quantity * entry.unitPrice, 0);
    operation.maxSpend = Math.ceil(expected * 1.05 * 100) / 100;
    const profit = Number(require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit) || 0;
    const balance = Number(wallet.getCharacterWallet(bot.characterID)?.balance) || 0;
    const funding = decideServiceProvisionFunding(maintenance, operation.maxSpend, profit, balance);
    if (!funding.allowed) {
      operation.stage = "source";
      return kit.block(operation, "holding", `Provisioning needs up to ${operation.maxSpend.toFixed(2)} ISK; realized reinvestable profit is ${profit.toFixed(2)} ISK and wallet balance is ${balance.toFixed(2)} ISK${maintenance ? `; maintenance preserves ${funding.reserve.toFixed(2)} ISK of working capital` : "; the initial seed is reserved"}.`);
    }
    operation.fundingSource = funding.fundingSource;
    operation.minimumWalletReserve = funding.reserve;
    kit.save(operation);
    return { delayMs: 3000 };
  }

  if (operation.stage === "to-jita") {
    const economy = require("./playerBotEconomyRuntime");
    for (const fallback of operation.jitaFallbackItems || []) {
      const selected = findJitaServiceOffer(fallback, economy);
      if (!selected) return kit.block(operation, "holding", `No seeded Jita station has sufficient stock for ${fallback.purpose}; no purchase was made.`);
      if (fallback.purpose === "fuel") operation.fuelTypeID = selected.typeID;
      operation.purchaseItems.push({ purpose: fallback.purpose, typeID: selected.typeID,
        quantity: Number(fallback.quantity), sourceStationID: selected.stationID,
        unitPrice: selected.unitPrice, owned: false });
    }
    operation.jitaFallbackItems = [];
    operation.purchaseIndex = 0;
    operation.maxSpend = Math.ceil(operation.purchaseItems.filter((entry) => !entry.owned)
      .reduce((total, entry) => total + entry.quantity * entry.unitPrice, 0) * 1.05 * 100) / 100;
    const profit = Number(require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit) || 0;
    const balance = Number(wallet.getCharacterWallet(bot.characterID)?.balance) || 0;
    const funding = decideServiceProvisionFunding(maintenance, operation.maxSpend, profit, balance);
    if (!funding.allowed) {
      operation.stage = "source";
      return kit.block(operation, "holding", `Jita provision stock needs up to ${operation.maxSpend.toFixed(2)} ISK; realized reinvestable profit is ${profit.toFixed(2)} ISK and wallet balance is ${balance.toFixed(2)} ISK${maintenance ? `; maintenance preserves ${funding.reserve.toFixed(2)} ISK of working capital` : "; the initial seed is reserved"}.`);
    }
    operation.fundingSource = funding.fundingSource;
    operation.minimumWalletReserve = funding.reserve;
    operation.stage = "buy";
    kit.record(operation, `Reconciled regional stock first; sourcing ${operation.purchaseItems.map((entry) => `${entry.purpose} from Jita station ${entry.sourceStationID}`).join(" and ")}.`);
    kit.save(operation);
    return { delayMs: 3000 };
  }

  if (operation.stage === "buy") {
    const purchase = operation.purchaseItems[Number(operation.purchaseIndex)];
    if (!purchase) {
      operation.stage = "to-structure";
      kit.save(operation);
      return { delayMs: 3000 };
    }
    const currentSession = kit.space.getActorSession(bot);
    if (Number(currentSession.stationID || currentSession.structureID) !== Number(purchase.sourceStationID)) {
      const step = await kit.travelToStation(operation, bot, Number(purchase.sourceStationID));
      if (step) return step;
    }
    if (purchase.owned === true) {
      operation.stage = "load";
      kit.save(operation);
      return { delayMs: 1000 };
    }
    const quote = await trade.readQuote(bot.characterName, Number(purchase.typeID)).catch((error) => ({ success: false, message: error.message }));
    if (!quote.success || !quote.bestAsk || Number(quote.bestAsk.quantity) < Number(purchase.quantity)) {
      const regional = await trade.readBestAskOutsideJita(bot.characterName, Number(purchase.typeID),
        Number(purchase.quantity), Number(purchase.sourceStationID))
        .catch(() => ({ success: false }));
      if (regional.success && regional.bestAsk) {
        purchase.sourceStationID = Number(regional.bestAsk.stationID);
        purchase.unitPrice = Number(regional.bestAsk.price);
        kit.record(operation, `Updated source for type ${purchase.typeID} to non-Jita station ${purchase.sourceStationID}.`);
        kit.save(operation);
        return { delayMs: 3000 };
      }
      const economy = require("./playerBotEconomyRuntime");
      if (shouldRefreshJitaServiceOffer(purchase, quote, economy)) {
        const excluded = [...new Set([
          ...(Array.isArray(purchase.checkedJitaStationIDs) ? purchase.checkedJitaStationIDs.map(Number) : []),
          Number(purchase.sourceStationID),
        ].filter(Boolean))];
        const next = findNextJitaServiceOfferForPurchase(purchase, economy);
        if (next && next.stationID !== Number(purchase.sourceStationID)) {
          purchase.checkedJitaStationIDs = excluded;
          purchase.sourceStationID = next.stationID;
          purchase.unitPrice = next.unitPrice;
          kit.record(operation, `Refreshing service-provisioning source for type ${purchase.typeID} to stocked Jita station ${next.stationID}.`);
          kit.save(operation);
          return { delayMs: 3000 };
        }
      }
      return kit.block(operation, "holding", `${quote.message || "No sufficient sell order remains"} for service provisioning type ${purchase.typeID} at ${purchase.sourceStationID}; no duplicate purchase was attempted.`);
    }
    const remainingSpend = operation.purchaseItems.slice(Number(operation.purchaseIndex))
      .filter((entry) => !entry.owned)
      .reduce((total, entry) => total + Number(entry.quantity) * Number(entry.unitPrice), 0) * 1.05;
    const profit = Number(require("./playerBotCorpEconomyRuntime").getCumulativeNetProfit(bot).reinvestableProfit) || 0;
    const balance = Number(wallet.getCharacterWallet(bot.characterID)?.balance) || 0;
    const remainingFunding = decideServiceProvisionFunding(maintenance, remainingSpend, profit, balance);
    if (!remainingFunding.allowed) {
      return kit.block(operation, "holding", `Service provisioning needs ${remainingSpend.toFixed(2)} ISK for the remaining package; realized reinvestable profit is ${profit.toFixed(2)} ISK and wallet balance is ${balance.toFixed(2)} ISK${maintenance ? `; maintenance preserves ${remainingFunding.reserve.toFixed(2)} ISK of working capital` : "; the initial seed is reserved"}.`);
    }
    const transactionRows = wallet.getCharacterMarketTransactions(bot.characterID);
    const baselineTransactionID = transactionRows.reduce((maximum, entry) =>
      Math.max(maximum, Number(entry.transactionID) || 0), 0);
    operation.pendingPurchase = {
      itemIndex: Number(operation.purchaseIndex),
      typeID: Number(purchase.typeID),
      quantity: Number(purchase.quantity),
      stationID: Number(purchase.sourceStationID),
      baselineUnits: inventory.countHangar(bot, purchase.sourceStationID, purchase.typeID) + inventory.countCargo(bot, purchase.typeID),
      baselineBalance: Number(wallet.getCharacterWallet(bot.characterID)?.balance) || 0,
      baselineTransactionID,
      startedAt: new Date().toISOString(),
    };
    kit.save(operation);
    const result = await trade.buy(bot.characterName, purchase.typeID, purchase.quantity, Number(quote.bestAsk.price));
    if (!result.success && result.sourceAvailable) {
      operation.pendingPurchase = null;
      purchase.sourceStationID = Number(result.sourceStationID);
      purchase.unitPrice = Number(result.sourcePrice) || Number(purchase.unitPrice);
      kit.save(operation);
      return { delayMs: 3000 };
    }
    if (!result.success && result.outcomeUnknown) {
      operation.pendingPurchase.outcomeUnknown = true;
      kit.save(operation);
      return kit.block(operation, "review", result.message || `Market response for type ${purchase.typeID} is uncertain; verify it before retrying.`);
    }
    if (!result.success) operation.pendingPurchase.resultWasRejected = true;
    const reconciled = reconcileStructureServicePurchase(operation, bot);
    if (reconciled.state === "complete") {
      kit.record(operation, `Bought and reconciled ${reconciled.bought} unit(s) of type ${purchase.typeID} at station ${purchase.sourceStationID} for ${reconciled.spent.toFixed(2)} ISK.`);
      kit.save(operation);
      return { delayMs: 3000 };
    }
    if (reconciled.state === "no-effect") return kit.block(operation, "holding", result.message || `No market fill was confirmed for service item ${purchase.typeID}.`);
    return kit.block(operation, "review", reconciled.message || `Market purchase for ${purchase.typeID} could not be reconciled.`);
  }

  if (operation.stage === "load") {
    const purchase = operation.purchaseItems[Number(operation.purchaseIndex)];
    if (!purchase) {
      operation.stage = "to-structure";
      kit.save(operation);
      return { delayMs: 3000 };
    }
    if (purchase.inCargo === true || purchase.loaded === true) {
      if (purchase.purpose === "module" && !Number(operation.moduleItemID)) {
        const module = inventory.listCargo(bot, Number(purchase.typeID))[0];
        operation.moduleItemID = Number(module && module.itemID) || Number(purchase.itemID) || 0;
      }
      operation.purchaseIndex = Number(operation.purchaseIndex) + 1;
      operation.stage = "buy";
      kit.save(operation);
      return { delayMs: 1000 };
    }
    const currentSession = kit.space.getActorSession(bot);
    if (Number(currentSession.stationID || currentSession.structureID) !== Number(purchase.sourceStationID)) {
      const step = await kit.travelToStation(operation, bot, Number(purchase.sourceStationID));
      if (step) return step;
    }
    if (!operation.pendingLoad) {
      operation.pendingLoad = {
        itemIndex: Number(operation.purchaseIndex),
        typeID: Number(purchase.typeID),
        stationID: Number(purchase.sourceStationID),
        quantity: Number(purchase.quantity),
        baselineCargoUnits: inventory.countCargo(bot, purchase.typeID),
        startedAt: new Date().toISOString(),
      };
      kit.save(operation);
    }
    const loadedSoFar = Math.max(0, inventory.countCargo(bot, purchase.typeID) -
      Number(operation.pendingLoad.baselineCargoUnits));
    const remaining = Math.max(0, Number(purchase.quantity) - loadedSoFar);
    if (remaining > 0) {
      let moved = 0;
      const stacks = purchase.owned === true && Number(purchase.itemID)
        ? [itemStore.findItemById(Number(purchase.itemID))].filter(Boolean)
        : inventory.listHangar(bot, Number(purchase.sourceStationID), Number(purchase.typeID));
      for (const stack of stacks) {
        if (moved >= remaining) break;
        const result = inventory.loadToCargo(bot, Number(stack.itemID), remaining - moved);
        moved += Number(result.moved) || 0;
        if (!result.success) break;
      }
    }
    const loaded = Math.max(0, inventory.countCargo(bot, purchase.typeID) -
      Number(operation.pendingLoad.baselineCargoUnits));
    if (loaded >= Number(purchase.quantity)) {
      purchase.loaded = true;
      operation.pendingLoad = null;
      if (purchase.purpose === "module") {
        const module = inventory.listCargo(bot, Number(purchase.typeID))[0];
        operation.moduleItemID = Number(module && module.itemID) || Number(purchase.itemID) || 0;
      }
      operation.purchaseIndex = Number(operation.purchaseIndex) + 1;
      operation.stage = "buy";
      kit.record(operation, `Loaded ${purchase.quantity} unit(s) of type ${purchase.typeID} into ship cargo for structure ${operation.structureID}.`);
      kit.save(operation);
      return { delayMs: 1000 };
    }
    if (loaded > 0) {
      purchase.quantity = Math.max(0, Number(purchase.quantity) - loaded);
      operation.pendingLoad = null;
      kit.save(operation);
      return { delayMs: 3000 };
    }
    return kit.block(operation, "holding", `The active ship cannot load type ${purchase.typeID}; the structure service package remains safely in the hangar.`);
  }

  if (operation.stage === "to-structure") {
    const step = await kit.travelToStation(operation, bot, Number(operation.structureID));
    if (step) return step;
    operation.stage = "install-fuel";
    kit.save(operation);
  }

  if (operation.stage === "install-fuel") {
    if (Number(operation.fuelUnitsNeeded) > 0 && operation.fuelInstalled !== true) {
      const fuelPurchase = (operation.purchaseItems || []).find((entry) => entry.purpose === "fuel");
      const typeID = Number(fuelPurchase && fuelPurchase.typeID) || 0;
      if (!typeID || inventory.countCargo(bot, typeID) < Number(operation.fuelUnitsNeeded)) {
        return kit.block(operation, "review", `The required ${operation.fuelUnitsNeeded} service fuel units are not in cargo; refusing a partial bay delivery.`);
      }
      const flagID = Number(itemStore.ITEM_FLAGS.STRUCTURE_FUEL_BAY);
      const before = countStructureServiceBay(operation.structureID, flagID, typeID);
      operation.pendingStructureMove = { kind: "fuel", itemID: 0, typeID,
        quantity: Number(operation.fuelUnitsNeeded), baselineUnits: before };
      kit.save(operation);
      let remaining = Number(operation.fuelUnitsNeeded);
      let moved = 0;
      for (const stack of inventory.listCargo(bot, typeID)) {
        if (remaining <= 0) break;
        const result = inventory.moveCargoToStructure(bot, Number(stack.itemID), Number(operation.structureID), flagID, remaining);
        moved += Number(result.moved) || 0;
        remaining -= Number(result.moved) || 0;
        if (!result.success) break;
      }
      const delivered = countStructureServiceBay(operation.structureID, flagID, typeID) - before;
      if (delivered === Number(operation.fuelUnitsNeeded)) {
        operation.fuelInstalled = true;
        operation.pendingStructureMove = null;
        kit.record(operation, `Loaded ${delivered} matching fuel blocks into structure ${operation.structureID}'s fuel bay.`);
        kit.save(operation);
      } else if (delivered > 0) {
        return kit.block(operation, "review", `Structure fuel bay accepted ${delivered} of ${operation.fuelUnitsNeeded} units; reconcile the exact cargo and bay records before retrying.`);
      } else if (inventory.countCargo(bot, typeID) >= Number(operation.fuelUnitsNeeded)) {
        operation.pendingStructureMove = null;
        kit.save(operation);
        return kit.block(operation, "holding", "The inventory broker rejected the fuel-bay move; no fuel left ship cargo, so it is safe to retry after checking the structure access and bay.");
      } else {
        return kit.block(operation, "review", "Fuel moved ambiguously without matching structure-bay inventory; manual reconciliation is required.");
      }
    } else {
      operation.fuelInstalled = true;
    }
    operation.stage = operation.moduleAlreadyInstalled ? "online-service" : "install-module";
    kit.save(operation);
    return { delayMs: 3000 };
  }

  if (operation.stage === "install-module") {
    const module = itemStore.findItemById(Number(operation.moduleItemID));
    if (module && Number(module.locationID) === Number(operation.structureID) &&
        Number(module.flagID) === Number(operation.serviceSlotFlagID)) {
      operation.stage = "online-service";
      kit.save(operation);
    } else {
      if (!module || Number(module.locationID) !== Number(session.shipID) ||
          Number(module.flagID) !== Number(itemStore.ITEM_FLAGS.CARGO_HOLD)) {
        return kit.block(operation, "review", `Service module ${operation.moduleItemID} is not in active ship cargo or its assigned structure slot.`);
      }
      operation.pendingStructureMove = { kind: "module", itemID: Number(module.itemID),
        typeID: Number(operation.moduleTypeID), flagID: Number(operation.serviceSlotFlagID) };
      kit.save(operation);
      const moved = inventory.moveCargoToStructure(bot, Number(module.itemID), Number(operation.structureID),
        Number(operation.serviceSlotFlagID), 1);
      const after = itemStore.findItemById(Number(module.itemID));
      if (after && Number(after.locationID) === Number(operation.structureID) &&
          Number(after.flagID) === Number(operation.serviceSlotFlagID)) {
        operation.pendingStructureMove = null;
        operation.stage = "online-service";
        kit.record(operation, `Fitted real service module ${after.itemID} into structure slot ${operation.serviceSlotFlagID} through the inventory broker.`);
        kit.save(operation);
      } else if (!moved.success && after && Number(after.locationID) === Number(session.shipID)) {
        operation.pendingStructureMove = null;
        kit.save(operation);
        return kit.block(operation, "holding", moved.message || "The structure inventory broker rejected service-module installation; the module remains aboard.");
      } else {
        return kit.block(operation, "review", `Service module ${module.itemID} moved ambiguously; reconcile its exact structure slot before retrying.`);
      }
    }
  }

  if (operation.stage === "online-service") {
    const moduleRuntime = require("../structure/structureServiceModules");
    let module = itemStore.findItemById(Number(operation.moduleItemID));
    if (!module || Number(module.locationID) !== Number(operation.structureID)) {
      return kit.block(operation, "review", `Service module ${operation.moduleItemID} is not installed in structure ${operation.structureID}.`);
    }
    const online = () => moduleRuntime.listOnlineStructureServiceModules(operation.structureID)
      .some((entry) => Number(entry.itemID) === Number(operation.moduleItemID));
    if (!online()) {
      const result = moduleRuntime.tryAutoOnlineFittedStructureServiceModule(operation.structureID, module);
      if (!result || result.success !== true) {
        return kit.block(operation, "holding", `Service module could not online through the structure service authority: ${result && result.errorMsg || "service requirements were not met"}.`);
      }
      module = itemStore.findItemById(Number(operation.moduleItemID));
    }
    if (!online()) return kit.block(operation, "holding", `Structure ${operation.structureID} did not confirm service module ${operation.moduleTypeID} online.`);
    if (maintenance) {
      const powered = structureState.getStructureByID(positiveID(operation.structureID));
      if (!powered || Number(powered.upkeepState) !== Number(require("../structure/structureConstants").STRUCTURE_UPKEEP_STATE.FULL_POWER)) {
        return kit.block(operation, "holding", `Structure ${operation.structureID} has an online service module, but the structure authority has not confirmed full power yet.`);
      }
      operation.serviceOnline = true;
      operation.stage = "return";
      kit.record(operation, `Structure ${operation.structureID} is confirmed at full power; its service module and fuel state are managed by the normal structure authorities.`);
      kit.save(operation);
    } else {
      const facility = require("../industry/industryStaticData").getFacilityPayloadByID(
        Number(operation.structureID), kit.space.getActorSession(bot),
      );
      const activity = require("../industry/industryConstants").INDUSTRY_ACTIVITY.MANUFACTURING;
      if (!facility || !facility.activities || !facility.activities[activity] ||
          !Object.hasOwn(facility.serviceAccess || {}, String(operation.serviceID))) {
        return kit.block(operation, "review", `Structure ${operation.structureID} has an online module but does not expose manufacturing access to this bot.`);
      }
      operation.serviceOnline = true;
      operation.stage = "return";
      kit.record(operation, `Structure ${operation.structureID} now exposes accessible, online manufacturing service ${operation.serviceID}; fuel and module state were confirmed by the structure authorities.`);
      kit.save(operation);
    }
  }

  if (operation.stage === "return") {
    const step = await kit.travelToStation(operation, bot, Number(operation.homeStationID));
    if (step) return step;
    return kit.finish(operation, maintenance
      ? `Structure ${operation.structureID} is back at full power with its service module online and ${operation.fuelUnitsNeeded} matching fuel blocks delivered through the normal inventory broker.`
      : `Structure ${operation.structureID} has its Quantum Core, a fitted and online manufacturing service module, and ${operation.fuelUnitsNeeded} fuel blocks delivered through the normal inventory broker. A real manufacturing cycle can now use the facility.`);
  }
  return kit.block(operation, "blocked", `Unknown structure service provisioning stage ${operation.stage}.`);
}

function canCarryStructurePackage(bot, item) {
  if (!bot || !item) return false;
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const itemStore = require("../inventory/itemStore");
  if (positiveID(item.locationID) === positiveID(session.shipID) &&
      [itemStore.ITEM_FLAGS.CARGO_HOLD, itemStore.ITEM_FLAGS.FLEET_HANGAR,
        itemStore.ITEM_FLAGS.INFRASTRUCTURE_HOLD].includes(Number(item.flagID))) {
    return true;
  }
  const inventory = require("./playerBotInventoryRuntime");
  return inventory.getCargoBayFree(bot) + 1e-9 >= inventory.getUnitVolume(item);
}

function getExistingDeployment(itemID, systemID = 0) {
  const structures = systemID
    ? worldData.getStructuresForSystem(systemID, { includeDestroyed: true })
    : require("../structure/structureState").listStructures({ includeDestroyed: true });
  return (structures || []).find((structure) =>
    Number(structure && structure.devFlags && structure.devFlags.structureDeploymentSourceItemID) === Number(itemID),
  ) || null;
}

function isStructureManager(bot) {
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const authority = require("../corporation/corporationAuthority").getPersistedCorporationAuthority(session);
  return Boolean(authority && (
    authority.isCEO || authority.isDirector ||
    require("../corporation/corporationAuthority").corporationAuthorityHasRole(authority, STRUCTURE_CARETAKER_ROLE)
  )) || hasDelegatedStructureCaretakerAuthority(bot);
}

function getStructureCaretakerAssignment(corporationID) {
  const numericCorporationID = positiveID(corporationID);
  if (!numericCorporationID) return null;
  const now = Date.now();
  const cached = structureCaretakerCache.get(numericCorporationID);
  if (cached && cached.expiresAt > now) return cached.assignment;

  const structureState = require("../structure/structureState");
  if (typeof structureState.listStructures !== "function" ||
      typeof structureState.getStructureTypeByID !== "function") {
    structureCaretakerCache.set(numericCorporationID, { assignment: null, expiresAt: now + STRUCTURE_CARETAKER_CACHE_MS });
    return null;
  }
  const hasOwnedStructure = structureState.listStructures().some((structure) =>
    Number(structure && (structure.ownerCorpID || structure.ownerID)) === numericCorporationID &&
    !structure.destroyedAt && !structure.unanchoring && structureState.getStructureTypeByID(structure.typeID)?.dockable === true,
  );
  if (!hasOwnedStructure) {
    structureCaretakerCache.set(numericCorporationID, { assignment: null, expiresAt: now + STRUCTURE_CARETAKER_CACHE_MS });
    return null;
  }

  const characterState = require("../character/characterState");
  const candidates = require("./playerBotRuntime").listBots()
    .filter((candidate) => candidate && candidate.status !== "paused" && candidate.autonomyPaused !== true)
    .filter((candidate) => {
      const character = characterState.getCharacterRecord(candidate.characterID) || {};
      return Number(character.corporationID || candidate.corporationID) === numericCorporationID;
    })
    .sort((left, right) => positiveID(left.characterID) - positiveID(right.characterID));
  if (!candidates.length) {
    structureCaretakerCache.set(numericCorporationID, { assignment: null, expiresAt: now + STRUCTURE_CARETAKER_CACHE_MS });
    return null;
  }

  const corporation = require("../corporation/corporationState").getCorporationRecord(numericCorporationID) || {};
  const runtime = require("../corporation/corporationRuntimeState");
  const naturalManagers = candidates.filter((candidate) => {
    const characterID = positiveID(candidate.characterID);
    if (Number(corporation.ceoID) === characterID) return true;
    let roles = 0n;
    try { roles = BigInt(runtime.getCorporationMemberRoleMask(numericCorporationID, characterID) || 0); }
    catch (_) { /* missing membership role means no structure authority */ }
    return (roles & runtime.CORP_ROLE_DIRECTOR) === runtime.CORP_ROLE_DIRECTOR ||
      (roles & STRUCTURE_CARETAKER_ROLE) === STRUCTURE_CARETAKER_ROLE;
  });
  const delegated = naturalManagers.length === 0;
  const selected = naturalManagers[0] || candidates[0];
  const assignment = { characterID: positiveID(selected.characterID), delegated };
  structureCaretakerCache.set(numericCorporationID, { assignment, expiresAt: now + STRUCTURE_CARETAKER_CACHE_MS });
  return assignment;
}

function hasDelegatedStructureCaretakerAuthority(bot) {
  if (!bot || !positiveID(bot.characterID)) return false;
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const corporationID = positiveID(character.corporationID || bot.corporationID);
  if (!corporationID) return false;
  const assignment = getStructureCaretakerAssignment(corporationID);
  return Boolean(assignment && assignment.delegated === true &&
    assignment.characterID === positiveID(bot.characterID));
}

function applyStructureCaretakerRoleToSession(session, bot) {
  if (!session || session.sessionType !== "playerbot" ||
      !hasDelegatedStructureCaretakerAuthority(bot)) return false;
  const roleBit = STRUCTURE_CARETAKER_ROLE;
  const addRole = (value) => {
    try { return BigInt(value || 0) | roleBit; }
    catch (_) { return roleBit; }
  };
  for (const field of ["corprole", "rolesAtAll", "rolesAtBase", "rolesAtHQ", "rolesAtOther"]) {
    session[field] = addRole(session[field]);
  }
  session.playerBotStructureCaretaker = true;
  return true;
}

function extendDeploymentRouteRisk(previous, systemID) {
  const security = Number(worldData.getSolarSystemByID(systemID)?.security);
  const knownSecurity = Number.isFinite(security) ? security : -1;
  const lowsecSystemIDs = previous ? [...previous.lowsecSystemIDs] : [];
  const nullsecSystemIDs = previous ? [...previous.nullsecSystemIDs] : [];
  if (knownSecurity > 0 && knownSecurity < 0.45) lowsecSystemIDs.push(systemID);
  else if (knownSecurity <= 0) nullsecSystemIDs.push(systemID);
  const lowest = previous && previous.lowestSecurity !== null
    ? Math.min(previous.lowestSecurity, knownSecurity)
    : knownSecurity;
  return {
    lowestSecurity: Math.round(lowest * 1000) / 1000,
    lowsecSystemIDs,
    nullsecSystemIDs,
    securityPenalty: lowsecSystemIDs.length * 2 + nullsecSystemIDs.length * 8,
  };
}

function reachableNullSystems(bot, maxHops = MAX_DEPLOYMENT_ROUTE_HOPS) {
  const fromSystemID = positiveID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).solarSystemID);
  if (!fromSystemID) return [];
  // This BFS already proves reachability and supplies a path of at most
  // maxHops. Running the weighted Dijkstra route planner independently for
  // every claimable destination turns one graph walk into thousands of walks.
  // Keep only the informational risk of this shortest-hop path here; actual
  // deployment travel still uses the safer weighted route planner.
  const queue = [{ systemID: fromSystemID, hops: 0, risk: extendDeploymentRouteRisk(null, fromSystemID) }];
  const seen = new Set([fromSystemID]);
  const found = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const system = worldData.getSolarSystemByID(current.systemID);
    if (system && require("../sovereignty/sovSystemRules").isSovereigntyClaimableSolarSystem(system)) {
      found.push({
        system,
        systemID: current.systemID,
        hops: current.hops,
        route: { success: true, hops: current.hops, risk: current.risk },
      });
    }
    if (current.hops >= maxHops) continue;
    // worldData builds these adjacency lists in itemID order once at startup.
    for (const gate of worldData.getStargatesForSystem(current.systemID)) {
      const paired = worldData.getStargateByID(gate.destinationID);
      const next = positiveID(gate.destinationSolarSystemID || paired && paired.solarSystemID);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push({ systemID: next, hops: current.hops + 1, risk: extendDeploymentRouteRisk(current.risk, next) });
    }
  }
  return found;
}

function deploymentDestinationPriority(bot, candidate) {
  const corporationID = positiveID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).corporationID || bot.corporationID);
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  const allianceID = positiveID(corporation.allianceID);
  const state = require("../sovereignty/sovState").getSystemState(candidate.systemID) || {};
  const structures = worldData.getStructuresForSystem(candidate.systemID).filter((structure) => structure && !structure.destroyedAt && !structure.unanchoring);
  if (structures.some((structure) => Number(structure.ownerCorpID || structure.ownerID) === corporationID)) return 0;
  if (allianceID && (Number(state.allianceID) === allianceID || structures.some((structure) => Number(structure.allianceID) === allianceID))) return 1;
  if (!Number(state.allianceID) && !structures.length) return 2;
  if (Number(state.allianceID) && Number(state.allianceID) !== allianceID) return 4;
  return 3;
}

function findDeploymentObjective(bot, typeID) {
  const systems = reachableNullSystems(bot);
  const ownedStructures = require("../structure/structureState").listStructures().filter((structure) =>
    Number(structure.ownerCorpID || structure.ownerID) === Number((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).corporationID || bot.corporationID),
  );
  const candidates = systems
    .filter((candidate) => !ownedStructures.some((structure) => Number(structure.solarSystemID) === candidate.systemID && Number(structure.typeID) === Number(typeID)))
    .map((candidate) => ({ ...candidate, priority: deploymentDestinationPriority(bot, candidate) }))
    .sort((left, right) => left.priority - right.priority || left.hops - right.hops || left.systemID - right.systemID);
  return candidates[0] || null;
}

function deploymentOffsetAt(typeID, solarSystemID, position, scene, session) {
  const placement = require("../structure/structureDeploymentPlacement");
  for (const radius of POSITION_SEARCH_RADII) {
    for (let index = 0; index < POSITION_DIRECTIONS; index += 1) {
      const angle = Math.PI * 2 * index / POSITION_DIRECTIONS;
      const offset = { x: Math.round(Math.cos(angle) * radius), y: 0, z: Math.round(Math.sin(angle) * radius) };
      const deploymentPosition = {
        x: Number(position.x || 0) + offset.x,
        y: Number(position.y || 0),
        z: Number(position.z || 0) + offset.z,
      };
      const validation = placement.validateDeploymentPlacement({
        solarSystemID: Number(solarSystemID),
        typeID: Number(typeID),
        position: deploymentPosition,
        offset,
        scene,
      });
      if (validation.success) {
        return { success: true, offset, position: deploymentPosition, scene, session };
      }
    }
  }
  return { success: false };
}

function chooseDeploymentOffset(bot, typeID) {
  const attached = require("./playerBotSpaceRuntime").getActorSpace(bot);
  const ship = attached && attached.scene && attached.scene.getShipEntityForSession(attached.session);
  if (!ship || !ship.position) return { success: false, reason: "The ship has no authoritative space position." };
  const selected = deploymentOffsetAt(
    typeID,
    Number(attached.session.solarsystemid || attached.session.solarsystemid2),
    ship.position,
    attached.scene,
    attached.session,
  );
  return selected.success
    ? selected
    : { success: false, reason: "No legal deployment position is within 800 km of this ship." };
}

function findDeploymentReposition(bot, typeID, excludedTargetIDs = []) {
  const attached = require("./playerBotSpaceRuntime").getActorSpace(bot);
  const ship = attached && attached.scene && attached.scene.getShipEntityForSession(attached.session);
  if (!ship || !ship.position || !Array.isArray(attached.scene.staticEntities)) return null;
  const placement = require("../structure/structureDeploymentPlacement");
  const excluded = new Set((Array.isArray(excludedTargetIDs) ? excludedTargetIDs : [])
    .map(positiveID).filter(Boolean));
  const candidates = attached.scene.staticEntities
    .filter((entity) => entity && positiveID(entity.itemID) && !excluded.has(positiveID(entity.itemID)))
    .map((entity) => ({
      entity,
      targetID: positiveID(entity.itemID),
      warpInPosition: placement.getDeploymentWarpInPoint(entity),
    }))
    .filter((candidate) => candidate.warpInPosition && candidate.entity.position)
    .map((candidate) => ({
      ...candidate,
      targetPosition: (() => {
        const dx = Number(candidate.warpInPosition.x || 0) - Number(candidate.entity.position.x || 0);
        const dy = Number(candidate.warpInPosition.y || 0) - Number(candidate.entity.position.y || 0);
        const dz = Number(candidate.warpInPosition.z || 0) - Number(candidate.entity.position.z || 0);
        const magnitude = Math.hypot(dx, dy, dz);
        if (!(magnitude > 0)) return null;
        return {
          x: Number(candidate.warpInPosition.x || 0) + (dx / magnitude) * DEPLOYMENT_GRID_CLEARANCE_METERS,
          y: Number(candidate.warpInPosition.y || 0) + (dy / magnitude) * DEPLOYMENT_GRID_CLEARANCE_METERS,
          z: Number(candidate.warpInPosition.z || 0) + (dz / magnitude) * DEPLOYMENT_GRID_CLEARANCE_METERS,
        };
      })(),
    }))
    .filter((candidate) => candidate.targetPosition)
    .map((candidate) => ({
      ...candidate,
      distance: Math.hypot(
        Number(ship.position.x || 0) - Number(candidate.targetPosition.x || 0),
        Number(ship.position.y || 0) - Number(candidate.targetPosition.y || 0),
        Number(ship.position.z || 0) - Number(candidate.targetPosition.z || 0),
      ),
    }))
    .filter((candidate) => candidate.distance >= MIN_DEPLOYMENT_REPOSITION_DISTANCE)
    .sort((left, right) => left.distance - right.distance || left.targetID - right.targetID);
  const solarSystemID = Number(attached.session.solarsystemid || attached.session.solarsystemid2);
  for (const candidate of candidates) {
    const selected = deploymentOffsetAt(
      typeID,
      solarSystemID,
      candidate.targetPosition,
      attached.scene,
      attached.session,
    );
    if (selected.success) {
      return {
        ...selected,
        targetID: candidate.targetID,
        targetName: String(candidate.entity.itemName || candidate.entity.name || candidate.targetID),
        targetPosition: candidate.targetPosition,
      };
    }
  }
  return null;
}

function start(bot, itemID, systemID = null, options = {}) {
  const tools = options.operationTools || {};
  if (!bot) return { success: false, message: "Playerbot not found." };
  if (typeof tools.baseOperation !== "function" || typeof tools.saveOperation !== "function") {
    return { success: false, message: "Structure deployment must be started through the playerbot operation runtime." };
  }
  const refusal = tools.assertCanStart && tools.assertCanStart(bot);
  if (refusal) return { success: false, message: refusal };
  if (!isStructureManager(bot)) return { success: false, message: `${bot.characterName} needs persisted CEO, Director, or Station Manager authority to deploy a corporation structure.` };
  const item = getOwnedStructureItem(bot, itemID);
  const type = item && getStructureType(item.typeID);
  if (!item || !type || type.dockable !== true) return { success: false, message: `Item ${itemID} is not a supported dockable Upwell structure owned by ${bot.characterName}.` };
  const existing = getExistingDeployment(item.itemID);
  if (existing) return { success: false, message: `Item ${item.itemID} already created structure ${existing.structureID} in system ${existing.solarSystemID}.` };
  const locationID = positiveID(item.locationID);
  const shipID = positiveID(require("./playerBotSpaceRuntime").getActorSession(bot).shipID);
  const inCargo = locationID === shipID && Number(item.flagID) === require("../inventory/itemStore").ITEM_FLAGS.CARGO_HOLD;
  const inHangar = Number(item.flagID) === require("../inventory/itemStore").ITEM_FLAGS.HANGAR;
  if (!inCargo && !inHangar) return { success: false, message: `Structure package ${item.itemID} must be in ${bot.characterName}'s active ship cargo or personal station hangar.` };
  const sourceStationID = inHangar ? locationID : positiveID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).stationID);
  if (inHangar && !worldData.getStationByID(sourceStationID) && !worldData.getStructureByID(sourceStationID)) {
    return { success: false, message: `Structure package ${item.itemID} is not in a dockable station or structure hangar.` };
  }
  const inventory = require("./playerBotInventoryRuntime");
  if (inHangar && inventory.getCargoBayCapacity(bot) < inventory.getUnitVolume(item)) {
    return { success: false, message: `The active ship cannot carry this structure package (${inventory.getUnitVolume(item).toFixed(2)} m³ required, ${inventory.getCargoBayCapacity(bot).toFixed(2)} m³ cargo capacity). Use a larger ship before retrying.` };
  }
  const coreTypeID = positiveID(type.defaultQuantumCoreTypeID);
  const core = coreTypeID ? require("../inventory/itemStore").listCharacterItems(bot.characterID).find((candidate) => {
    if (!candidate || Number(candidate.ownerID) !== Number(bot.characterID) || Number(candidate.typeID) !== coreTypeID) return false;
    if (inCargo) return positiveID(candidate.locationID) === shipID && Number(candidate.flagID) === require("../inventory/itemStore").ITEM_FLAGS.CARGO_HOLD;
    return positiveID(candidate.locationID) === locationID && Number(candidate.flagID) === require("../inventory/itemStore").ITEM_FLAGS.HANGAR;
  }) : null;
  if (coreTypeID && !core) {
    return { success: false, message: `Structure type ${item.typeID} requires Quantum Core ${coreTypeID}; carry it with the package or keep it in the same station hangar before deploying.` };
  }
  let objective = positiveID(systemID) ? reachableNullSystems(bot).find((candidate) => candidate.systemID === positiveID(systemID)) : findDeploymentObjective(bot, item.typeID);
  if (!objective) return { success: false, message: positiveID(systemID) ? `System ${systemID} is not a reachable claimable null-sec system within ${MAX_DEPLOYMENT_ROUTE_HOPS} jumps.` : "No reachable null-sec structure deployment system is available." };
  const operation = tools.baseOperation("structure-deployment", bot, {
    stage: inCargo ? "to-system" : "to-source",
    itemID: Number(item.itemID),
    coreTypeID,
    coreItemID: core ? Number(core.itemID) : null,
    typeID: Number(item.typeID),
    structureName: String(item.itemName || type.name || `Structure ${item.typeID}`).slice(0, 200),
    sourceStationID: inHangar ? sourceStationID : null,
    destinationSystemID: objective.systemID,
    plannedRouteHops: objective.hops,
    routeRisk: objective.route.risk || null,
    homeStationID: positiveID((require("../character/characterState").getCharacterRecord(bot.characterID) || {}).stationID || (require("../character/characterState").getCharacterRecord(bot.characterID) || {}).structureID) || require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID,
    pendingDeployment: null,
    structureID: null,
    autonomous: options.autonomous === true,
  });
  tools.record(operation, `Prepared ${type.name} deployment in null-sec system ${objective.systemID}; final placement and corporation access will be checked by the structure authority.`);
  tools.saveOperation(operation);
  return { success: true, operation, message: `${bot.characterName} will carry ${type.name} to null-sec system ${objective.systemID} and submit deployment through the normal corporation structure authority.` };
}

async function advance(operation, bot, kit) {
  const itemStore = require("../inventory/itemStore");
  const structureState = require("../structure/structureState");
  const item = getOwnedStructureItem(bot, operation.itemID);
  const existing = getExistingDeployment(operation.itemID, operation.destinationSystemID);
  if (existing) {
    operation.structureID = Number(existing.structureID);
    operation.anchorState = String(existing.state || "unknown");
    operation.pendingDeployment = null;
    operation.stage = "return";
    kit.record(operation, `Reconciled structure ${existing.structureID} from source package ${operation.itemID}; authoritative state is ${existing.state || "unknown"}.`);
    kit.save(operation);
  } else if (operation.pendingDeployment && !item) {
    return kit.block(operation, "review", `Deployment of package ${operation.itemID} is uncertain: the item is gone but the structure authority has no matching structure record. No second deployment was issued.`);
  }

  if (operation.stage === "to-source") {
    if (!item) return kit.block(operation, "review", `Structure package ${operation.itemID} is no longer available in its source hangar.`);
    const step = await kit.travelToStation(operation, bot, Number(operation.sourceStationID));
    if (step) return step;
    operation.stage = "load";
    kit.save(operation);
  }
  if (operation.stage === "load") {
    const current = getOwnedStructureItem(bot, operation.itemID);
    if (!current) return kit.block(operation, "review", `Structure package ${operation.itemID} disappeared before loading.`);
    const session = kit.space.getActorSession(bot);
    if (Number(current.locationID) !== Number(session.shipID)) {
      if (kit.inventory.getCargoBayFree(bot) < kit.inventory.getUnitVolume(current)) {
        const unloaded = kit.inventory.unloadCargo(bot);
        if (!unloaded.success || kit.inventory.getCargoBayFree(bot) < kit.inventory.getUnitVolume(current)) {
          return kit.block(operation, "blocked", `Structure package ${current.itemID} still does not fit after attempting to unload existing cargo.`);
        }
        kit.record(operation, `Unloaded existing ship cargo through the inventory authority to make room for structure package ${current.itemID}.`);
      }
      const loaded = kit.inventory.loadToCargo(bot, Number(current.itemID));
      const after = itemStore.findItemById(Number(current.itemID));
      if (!loaded.success || !after || Number(after.locationID) !== Number(session.shipID)) {
        return kit.block(operation, "blocked", `Structure package ${current.itemID} could not be loaded: ${loaded.message || "inventory transfer was not confirmed"}.`);
      }
      operation.stage = "to-system";
      kit.record(operation, `Loaded structure package ${current.itemID} using the inventory authority.`);
    }
    if (Number(operation.coreTypeID) > 0) {
      const core = getOwnedStructureItem(bot, operation.coreItemID);
      if (!core || Number(core.typeID) !== Number(operation.coreTypeID)) {
        return kit.block(operation, "review", `Required Quantum Core ${operation.coreTypeID} is no longer in the deployment owner's inventory.`);
      }
      const coreInCargo = Number(core.locationID) === Number(session.shipID) &&
        Number(core.flagID) === Number(itemStore.ITEM_FLAGS.CARGO_HOLD);
      if (!coreInCargo) {
        if (Number(core.locationID) !== Number(operation.sourceStationID) ||
            Number(core.flagID) !== Number(itemStore.ITEM_FLAGS.HANGAR)) {
          return kit.block(operation, "review", `Required Quantum Core ${core.itemID} is not in the source hangar or active ship cargo.`);
        }
        const loadedCore = kit.inventory.loadToCargo(bot, Number(core.itemID));
        const afterCore = itemStore.findItemById(Number(core.itemID));
        if (!loadedCore.success || !afterCore || Number(afterCore.locationID) !== Number(session.shipID) ||
            Number(afterCore.flagID) !== Number(itemStore.ITEM_FLAGS.CARGO_HOLD)) {
          return kit.block(operation, "blocked", `Required Quantum Core ${core.itemID} could not be loaded: ${loadedCore.message || "inventory transfer was not confirmed"}.`);
        }
        kit.record(operation, `Loaded required Quantum Core ${core.itemID} with the structure package.`);
      }
    }
    operation.stage = "to-system";
    kit.save(operation);
  }
  if (operation.stage === "to-system") {
    const step = kit.travelToSystem(operation, bot, Number(operation.destinationSystemID));
    if (step) return step;
    operation.stage = "deploy";
    kit.save(operation);
  }
  if (operation.stage === "deploy") {
    const session = kit.space.getActorSession(bot);
    const location = kit.space.getSpaceState(bot);
    if (!location.inSpace) {
      const undocked = kit.space.undock(bot, { allowOverCapacityDeparture: true });
      if (!undocked.success) return undocked.capacityQueued
        ? { delayMs: 15_000, capacityQueued: true, capacityReason: undocked.message }
        : kit.block(operation, "holding", undocked.message);
      return { delayMs: 15_000 };
    }
    if (location.busy) return { delayMs: 15_000 };
    if (Number(location.systemID) !== Number(operation.destinationSystemID)) return { delayMs: 15_000 };
    if (operation.deploymentReposition) {
      const targetID = positiveID(operation.deploymentReposition.targetID);
      const attached = kit.space.getActorSpace(bot);
      const ship = attached && attached.scene && attached.scene.getShipEntityForSession(attached.session);
      const origin = operation.deploymentReposition.originPosition;
      const movedDistance = ship && ship.position && origin
        ? Math.hypot(
          Number(ship.position.x || 0) - Number(origin.x || 0),
          Number(ship.position.y || 0) - Number(origin.y || 0),
          Number(ship.position.z || 0) - Number(origin.z || 0),
        )
        : 0;
      const orderedAt = Date.parse(operation.deploymentReposition.orderedAt || "") || Date.now();
      if (movedDistance < MIN_DEPLOYMENT_REPOSITION_DISTANCE && Date.now() - orderedAt < 120_000) {
        return { delayMs: 15_000 };
      }
      if (targetID) {
        operation.deploymentRepositionTargetIDs = [...new Set([
          ...(Array.isArray(operation.deploymentRepositionTargetIDs) ? operation.deploymentRepositionTargetIDs : []),
          targetID,
        ])].slice(-MAX_DEPLOYMENT_REPOSITION_TARGETS);
      }
      operation.deploymentReposition = null;
      kit.record(operation, `Reached the alternate deployment grid${targetID ? ` via celestial ${targetID}` : ""}; checking the live placement rules again.`);
      kit.save(operation);
    }
    if (!isStructureManager(bot)) return kit.block(operation, "blocked", "Persisted corporation authority no longer grants CEO, Director, or Station Manager structure-deployment access.");
    const carried = getOwnedStructureItem(bot, operation.itemID);
    if (!carried || Number(carried.locationID) !== Number(session.shipID) || ![
      itemStore.ITEM_FLAGS.CARGO_HOLD,
      itemStore.ITEM_FLAGS.FLEET_HANGAR,
      itemStore.ITEM_FLAGS.INFRASTRUCTURE_HOLD,
    ].includes(Number(carried.flagID))) {
      return kit.block(operation, "review", `Structure package ${operation.itemID} is not in an authorized hold of the active ship.`);
    }
    if (Number(operation.coreTypeID) > 0) {
      const core = getOwnedStructureItem(bot, operation.coreItemID);
      if (!core || Number(core.typeID) !== Number(operation.coreTypeID) ||
          Number(core.locationID) !== Number(session.shipID) ||
          Number(core.flagID) !== Number(itemStore.ITEM_FLAGS.CARGO_HOLD)) {
        return kit.block(operation, "review", `Required Quantum Core ${operation.coreItemID || operation.coreTypeID} is not aboard; refusing to anchor an incomplete structure package.`);
      }
    }
    const selected = chooseDeploymentOffset(bot, operation.typeID);
    if (!selected.success) {
      const excludedTargets = Array.isArray(operation.deploymentRepositionTargetIDs)
        ? operation.deploymentRepositionTargetIDs
        : [];
      const reposition = findDeploymentReposition(bot, operation.typeID, excludedTargets);
      if (!reposition) {
        return kit.block(operation, "holding", `${selected.reason} No unused clear point outside the celestial warp-in exclusion zones currently has a legal anchor position; the operation will keep retrying as the scene changes.`);
      }
      const originSpace = kit.space.getActorSpace(bot);
      const originShip = originSpace && originSpace.scene &&
        originSpace.scene.getShipEntityForSession(originSpace.session);
      const originPosition = originShip && originShip.position ? { ...originShip.position } : null;
      const warp = kit.space.warpToPoint(bot, reposition.targetPosition);
      if (!warp.success) {
        operation.deploymentRepositionTargetIDs = [...new Set([...excludedTargets, reposition.targetID])]
          .slice(-MAX_DEPLOYMENT_REPOSITION_TARGETS);
        kit.save(operation);
        return kit.block(operation, "holding", `Could not warp clear of celestial ${reposition.targetName} (${reposition.targetID}) for structure deployment: ${warp.message || "warp was rejected"}.`);
      }
      operation.deploymentReposition = {
        targetID: reposition.targetID,
        targetName: reposition.targetName,
        targetPosition: reposition.targetPosition,
        originPosition,
        orderedAt: new Date().toISOString(),
      };
      operation.status = "active";
      operation.lastError = null;
      kit.record(operation, `No legal anchor point on the current grid; warping clear of ${reposition.targetName} (${reposition.targetID}) and will recheck deployment placement on arrival.`);
      kit.save(operation);
      return { delayMs: 15_000 };
    }
    operation.deploymentReposition = null;
    operation.deploymentRepositionTargetIDs = [];
    operation.pendingDeployment = {
      itemID: Number(operation.itemID),
      systemID: Number(operation.destinationSystemID),
      position: selected.position,
      offset: selected.offset,
      startedAt: new Date().toISOString(),
    };
    kit.save(operation);
    try {
      const DeploymentService = require("../structure/structureDeploymentService");
      new DeploymentService().Handle_Anchor([
        Number(operation.itemID),
        Number(selected.offset.x),
        Number(selected.offset.z),
        0,
        null,
        String(operation.structureName || "Playerbot Structure"),
        "",
        null,
        null,
        null,
      ], selected.session, {});
    } catch (error) {
      const reconciled = getExistingDeployment(operation.itemID, operation.destinationSystemID);
      if (!reconciled) {
        const stillOwned = getOwnedStructureItem(bot, operation.itemID);
        operation.pendingDeployment = null;
        return kit.block(operation, stillOwned ? "holding" : "review", `Structure deployment was rejected by the server: ${kit.space.describeError(error)}.`);
      }
    }
    const deployed = getExistingDeployment(operation.itemID, operation.destinationSystemID);
    if (!deployed) return kit.block(operation, "review", `The deployment service returned without a matching structure record for source item ${operation.itemID}.`);
    operation.structureID = Number(deployed.structureID);
    operation.anchorState = String(deployed.state || "unknown");
    operation.pendingDeployment = null;
    operation.stage = "return";
    kit.record(operation, `Structure ${deployed.structureID} is anchoring in system ${operation.destinationSystemID}; the server's structure authority owns its anchoring timer and vulnerability state.`);
    kit.save(operation);
  }
  if (operation.stage === "return") {
    const step = await kit.travelToStation(operation, bot, Number(operation.homeStationID));
    if (step) return step;
    if (Number(operation.coreItemID) > 0) {
      const core = getOwnedStructureItem(bot, operation.coreItemID);
      if (core && Number(core.locationID) === Number(kit.space.getActorSession(bot).shipID)) {
        const unloaded = kit.inventory.unloadCargo(bot, Number(core.typeID));
        const returnedCore = itemStore.findItemById(Number(core.itemID));
        if (!unloaded.success || !returnedCore ||
            Number(returnedCore.locationID) !== Number(operation.homeStationID) ||
            Number(returnedCore.flagID) !== Number(itemStore.ITEM_FLAGS.HANGAR)) {
          return kit.block(operation, "holding", `Could not return Quantum Core ${core.itemID} to the home hangar: ${unloaded.message || "inventory transfer was not confirmed"}.`);
        }
        kit.record(operation, `Returned Quantum Core ${core.itemID} to the home hangar; structure activation still requires the normal core-install and service setup.`);
      }
    }
    const structure = structureState.getStructureByID(Number(operation.structureID));
    const coreNote = operation.coreItemID
      ? ` Required Quantum Core ${operation.coreTypeID} was retained at the home hangar; it has not been installed.`
      : "";
    return kit.finish(operation, `${structure && structure.name || operation.structureName} (${operation.structureID}) deployment was confirmed in system ${operation.destinationSystemID}; current structure state: ${structure && structure.state || operation.anchorState || "unknown"}.${coreNote} Service modules, fuel and online state remain governed by the normal structure authorities.`);
  }
  return kit.block(operation, "blocked", `Unknown structure deployment stage ${operation.stage}.`);
}

module.exports = {
  _testing: {
    findJitaServiceOffer,
    findNextJitaServiceOfferForPurchase,
    shouldRefreshJitaServiceOffer,
    findDeploymentReposition,
    reachableNullSystems,
    deploymentOffsetAt,
    decideServiceProvisionFunding,
    getStructureCaretakerAssignment,
  },
  MAX_DEPLOYMENT_ROUTE_HOPS,
  findDeploymentObjective,
  getExistingDeployment,
  findStructurePackage,
  canFundStructureLogisticsUpgradeWithSeedCapital,
  hasDelegatedStructureCaretakerAuthority,
  applyStructureCaretakerRoleToSession,
  canCarryStructurePackage,
  findAutonomousPurchasePlan,
  findCoreInstallPlan,
  findStructureMaintenancePlan,
  findStructureServiceProvisionPlan,
  canCarryStructureServicePlan,
  findAccessibleManufacturingFacility,
  startProcurement,
  advanceProcurement,
  startCoreInstall,
  advanceCoreInstall,
  startStructureServiceProvision,
  advanceStructureServiceProvision,
  start,
  advance,
};

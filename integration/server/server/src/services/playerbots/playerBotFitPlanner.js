"use strict";

const MAX_FIT_ROWS = 512;
const MAX_FIT_CARGO_UNITS = 1_000_000;
const MAX_FIT_BAY_UNITS = 500;

function buildFitPlan(fittingRecord) {
  const fitting = require("../fitting/liveFittingState");
  const itemStore = require("../inventory/itemStore");
  const registry = require("../inventory/itemTypeRegistry");
  const record = fittingRecord && typeof fittingRecord === "object" ? fittingRecord : {};
  const shipTypeID = Math.trunc(Number(record.shipTypeID) || 0);
  const shipType = registry.resolveItemByTypeID(shipTypeID);
  if (!shipType || Number(shipType.categoryID) !== 6) {
    return { success: false, message: "The saved fitting does not identify a valid ship hull." };
  }
  const rows = Array.isArray(record.fitData) ? record.fitData : [];
  if (!rows.length || rows.length > MAX_FIT_ROWS) {
    return { success: false, message: `The fitting must contain 1–${MAX_FIT_ROWS} item rows.` };
  }

  const fitSlotPlan = [];
  const droneCounts = new Map();
  const fighterCounts = new Map();
  const cargoCounts = new Map();
  const usedFlags = new Set();
  let cargoUnits = 0;
  let bayUnits = 0;
  const hullCapacity = Math.max(0, Number(fitting.getTypeAttributeValue(shipTypeID, "capacity")) || 0);
  let remainingCargoVolume = hullCapacity;

  for (const row of rows) {
    const typeID = Math.trunc(Number(row && row[0]) || 0);
    const flagID = Math.trunc(Number(row && row[1]) || 0);
    const quantity = Math.abs(Math.trunc(Number(row && row[2]) || 0));
    const type = registry.resolveItemByTypeID(typeID);
    if (!type || flagID <= 0 || quantity <= 0) {
      return { success: false, message: `The fitting contains an invalid item row (${typeID}/${flagID}/${quantity}).` };
    }

    if (Number(type.categoryID) === 8 && fitting.isShipFittingFlag(flagID)) {
      // Some client saves encode a loaded charge in the module's fitting flag.
      // The operation loads ammunition into cargo; the pilot can load it into
      // each weapon using the normal ship UI after the fit is delivered.
      if (remainingCargoVolume > 0) {
        const unitVolume = Math.max(0, Number(type.volume ?? type.packagedVolume) || 0);
        const loadedQuantity = unitVolume
          ? Math.min(quantity, Math.floor((remainingCargoVolume + 1e-9) / unitVolume))
          : 0;
        if (loadedQuantity > 0) {
          cargoCounts.set(typeID, (cargoCounts.get(typeID) || 0) + loadedQuantity);
          cargoUnits += loadedQuantity;
          remainingCargoVolume -= loadedQuantity * unitVolume;
          if (cargoUnits > MAX_FIT_CARGO_UNITS) {
            return { success: false, message: `The fitting exceeds the ${MAX_FIT_CARGO_UNITS}-unit cargo safety limit.` };
          }
        }
      }
      continue;
    }

    const family = fitting.getRequiredSlotFamily(typeID);
    if (family && fitting.isShipFittingFlag(flagID)) {
      if (quantity !== 1) {
        return { success: false, message: `${type.name} is fitted in a non-stackable ship slot.` };
      }
      if (usedFlags.has(flagID)) {
        return { success: false, message: `The fitting assigns more than one item to slot ${flagID}.` };
      }
      const validFlags = fitting.getSlotFlagsForFamily(family, shipTypeID, []);
      if (!validFlags.includes(flagID)) {
        return { success: false, message: `${type.name} cannot use ${family} slot ${flagID} on ${shipType.name}.` };
      }
      usedFlags.add(flagID);
      fitSlotPlan.push({ typeID, flagID, family });
      continue;
    }

    if (flagID === itemStore.ITEM_FLAGS.DRONE_BAY) {
      droneCounts.set(typeID, (droneCounts.get(typeID) || 0) + quantity);
      bayUnits += quantity;
      if (bayUnits > MAX_FIT_BAY_UNITS) {
        return { success: false, message: `The fitting exceeds the ${MAX_FIT_BAY_UNITS}-unit drone and fighter bay safety limit.` };
      }
      continue;
    }
    if (flagID === itemStore.ITEM_FLAGS.FIGHTER_BAY) {
      fighterCounts.set(typeID, (fighterCounts.get(typeID) || 0) + quantity);
      bayUnits += quantity;
      if (bayUnits > MAX_FIT_BAY_UNITS) {
        return { success: false, message: `The fitting exceeds the ${MAX_FIT_BAY_UNITS}-unit drone and fighter bay safety limit.` };
      }
      continue;
    }
    if (flagID === itemStore.ITEM_FLAGS.CARGO_HOLD) {
      // A saved ship fitting can contain arbitrary killmail cargo. Only copy
      // charges/ammunition, and only the quantity that fits in the hull's
      // standard hold; spare loot and modules are not part of a ship fit.
      if (Number(type.categoryID) !== 8 || remainingCargoVolume <= 0) continue;
      const unitVolume = Math.max(0, Number(type.volume ?? type.packagedVolume) || 0);
      if (!unitVolume) continue;
      const loadedQuantity = Math.min(quantity, Math.floor((remainingCargoVolume + 1e-9) / unitVolume));
      if (!loadedQuantity) continue;
      cargoCounts.set(typeID, (cargoCounts.get(typeID) || 0) + loadedQuantity);
      cargoUnits += loadedQuantity;
      remainingCargoVolume -= loadedQuantity * unitVolume;
      if (cargoUnits > MAX_FIT_CARGO_UNITS) {
        return { success: false, message: `The fitting exceeds the ${MAX_FIT_CARGO_UNITS}-unit cargo safety limit.` };
      }
      continue;
    }
    return { success: false, message: `${type.name} uses unsupported fit location ${flagID}.` };
  }

  return {
    success: true,
    plan: {
      shipTypeID,
      shipName: shipType.name,
      fitSlotPlan,
      moduleTypeIDs: fitSlotPlan.map((entry) => entry.typeID),
      droneTypeIDs: [...droneCounts].flatMap(([typeID, count]) => Array(count).fill(typeID)),
      fighterTypeIDs: [...fighterCounts].flatMap(([typeID, count]) => Array(count).fill(typeID)),
      cargoPlan: [...cargoCounts].map(([typeID, quantity]) => ({ typeID, quantity })),
    },
  };
}

// ---------------------------------------------------------------- catalog

// The community killmail catalog that ships with the addon. Bots fly the
// hand-written ladder hulls, but they train the skills a real fit for that hull
// needs, so the ladder stops being a skill ceiling.
let catalogRecords = null;
const catalogFitsByHull = new Map();
const catalogSkillCache = new Map();

function readCatalog() {
  if (catalogRecords) return catalogRecords;
  try {
    catalogRecords = require("../../../assets/fittings/fitall.json") || [];
  } catch (_) {
    catalogRecords = [];
  }
  return catalogRecords;
}

// Fit indices are stable for a given catalog file, so they double as the
// per-pilot seed. Only hulls the ladder actually flies are planned: 5353
// records, ~107 of them relevant, so slot validation stays cheap.
function catalogFitsForHull(hullTypeID) {
  const hull = Math.trunc(Number(hullTypeID) || 0);
  if (!hull) return [];
  if (catalogFitsByHull.has(hull)) return catalogFitsByHull.get(hull);
  const records = readCatalog();
  const fits = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (Math.trunc(Number(record && record.shipTypeID) || 0) !== hull) continue;
    let planned = null;
    try {
      planned = buildFitPlan(record);
    } catch (_) {
      planned = null;
    }
    if (!planned || !planned.success) continue;
    fits.push({ catalogIndex: index, name: String(record.name || ""), plan: planned.plan });
  }
  catalogFitsByHull.set(hull, fits);
  return fits;
}

function pilotHash(seed) {
  const text = String(seed || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return hash >>> 0;
}

// Stable per pilot: the same character always trains toward the same fit, so
// consecutive training calls cannot churn the queue.
function catalogFitForPilot(hullTypeID, characterID) {
  const fits = catalogFitsForHull(hullTypeID);
  if (!fits.length) return null;
  return fits[pilotHash(characterID) % fits.length];
}

function catalogFitSkillRequirements(fit) {
  if (!fit) return [];
  const cached = catalogSkillCache.get(fit.catalogIndex);
  if (cached) return cached;
  const { requiredSkillsForType } = require("./playerBotOperationRuntime");
  const merged = new Map();
  const typeIDs = [
    fit.plan.shipTypeID,
    ...(fit.plan.moduleTypeIDs || []),
    ...(fit.plan.droneTypeIDs || []),
    ...(fit.plan.fighterTypeIDs || []),
  ];
  for (const typeID of typeIDs) {
    for (const [skillTypeID, level] of requiredSkillsForType(typeID)) {
      merged.set(skillTypeID, Math.max(merged.get(skillTypeID) || 0, Number(level) || 1));
    }
  }
  const requirements = [...merged.entries()];
  catalogSkillCache.set(fit.catalogIndex, requirements);
  return requirements;
}

// Skills a real killmail fit for this hull expects, picked deterministically
// for this pilot. Used to widen the training target beyond the hand-written fit.
function catalogSkillRequirements(hullTypeID, characterID, options = {}) {
  if (options.mining === true) {
    // No ore fit for this hull (Venture) means nothing to train: fall back to
    // the catalogue's gas fits would teach Gas Cloud Harvesting for a job the
    // pilot does not do.
    return catalogFitSkillRequirements(oreFitForPilot(hullTypeID, characterID));
  }
  return catalogFitSkillRequirements(catalogFitForPilot(hullTypeID, characterID));
}

// ---------------------------------------------------------- mining fits

// A fit is an ore fit only if it carries a Mining Laser / Strip Miner and no
// ice harvester or gas scoop: the catalog's Venture fits are gas hacks, and an
// ice harvester produces nothing at an asteroid belt.
const ORE_MODULE_GROUP = /strip miner|mining laser/i;
const NON_ORE_MODULE = /ice harvester|gas cloud/i;

const oreFitsByHull = new Map();

function planMiningYield(plan) {
  const fitting = require("../fitting/liveFittingState");
  let total = 0;
  for (const typeID of plan.moduleTypeIDs || []) {
    const amount = Number(fitting.getTypeAttributeValue(typeID, "miningAmount")) || 0;
    if (amount > 0) total += amount;
  }
  return total;
}

// A fit the hull cannot power would leave its miners offline, which is what
// "no mining modules" looks like to the director. Zero output means the static
// data has no attribute for that hull, so the check is skipped rather than
// dropping every catalog fit.
const FIT_RESOURCE_TOLERANCE = 1.05;

function planResourceLoad(plan) {
  const fitting = require("../fitting/liveFittingState");
  const cpuOutput = Number(fitting.getTypeAttributeValue(plan.shipTypeID, "cpuOutput")) || 0;
  const powerOutput = Number(fitting.getTypeAttributeValue(plan.shipTypeID, "powerOutput")) || 0;
  let cpu = 0;
  let power = 0;
  for (const typeID of plan.moduleTypeIDs || []) {
    cpu += Number(fitting.getTypeAttributeValue(typeID, "cpu")) || 0;
    power += Number(fitting.getTypeAttributeValue(typeID, "power")) || 0;
  }
  const known = cpuOutput > 0 && powerOutput > 0;
  return {
    cpu,
    power,
    cpuOutput,
    powerOutput,
    feasible: !known ||
      (cpu <= cpuOutput * FIT_RESOURCE_TOLERANCE && power <= powerOutput * FIT_RESOURCE_TOLERANCE),
  };
}

function planPriceEstimate(plan) {
  const registry = require("../inventory/itemTypeRegistry");
  let total = 0;
  let unknown = 0;
  for (const typeID of [plan.shipTypeID, ...(plan.moduleTypeIDs || [])]) {
    const type = registry.resolveItemByTypeID(typeID) || {};
    const price = Number(type.basePrice) || 0;
    if (price > 0) total += price;
    else unknown += 1;
  }
  return { total, unknown };
}

function isOreMiningFit(plan) {
  const registry = require("../inventory/itemTypeRegistry");
  let hasOre = false;
  for (const typeID of plan.moduleTypeIDs || []) {
    const type = registry.resolveItemByTypeID(typeID) || {};
    const name = String(type.name || "");
    if (NON_ORE_MODULE.test(name)) return false;
    if (ORE_MODULE_GROUP.test(String(type.groupName || ""))) hasOre = true;
  }
  return hasOre;
}

function oreFitsForHull(hullTypeID) {
  const hull = Math.trunc(Number(hullTypeID) || 0);
  if (!hull) return [];
  if (oreFitsByHull.has(hull)) return oreFitsByHull.get(hull);
  const fits = catalogFitsForHull(hull)
    .filter((fit) => isOreMiningFit(fit.plan))
    .map((fit) => ({
      ...fit,
      miningYield: planMiningYield(fit.plan),
      ...planResourceLoad(fit.plan),
      price: planPriceEstimate(fit.plan),
    }))
    .filter((fit) => fit.miningYield > 0)
    // A fit the hull cannot power would leave its miners offline, which is what
    // "no mining modules" looks like to the director.
    .filter((fit) => fit.feasible);
  oreFitsByHull.set(hull, fits);
  return fits;
}

// Best ore yield for this hull, tie-broken per pilot so the fleet is not all
// on one fit. The same pilot always gets the same fit, so training and
// purchasing agree.
function oreFitForPilot(hullTypeID, characterID, options = {}) {
  const maxISK = Math.max(0, Number(options.maxISK) || 0);
  const fits = oreFitsForHull(hullTypeID).filter((fit) => {
    // Prices are incomplete for many modules in this static data, so only a
    // fully priced fit can be rejected on cost.
    if (!maxISK || !fit.price || fit.price.unknown > 0) return true;
    return fit.price.total <= maxISK;
  });
  if (!fits.length) return null;
  const ranked = fits.slice().sort((left, right) =>
    right.miningYield - left.miningYield ||
    left.cpu - right.cpu ||
    left.catalogIndex - right.catalogIndex);
  const best = ranked[0];
  const tied = ranked.filter((fit) => fit.miningYield === best.miningYield && fit.cpu === best.cpu);
  return tied[pilotHash(characterID) % tied.length];
}

module.exports = {
  buildFitPlan,
  catalogFitsForHull,
  catalogFitForPilot,
  catalogSkillRequirements,
  oreFitsForHull,
  oreFitForPilot,
  _testing: {
    MAX_FIT_ROWS, MAX_FIT_CARGO_UNITS, MAX_FIT_BAY_UNITS, FIT_RESOURCE_TOLERANCE,
    isOreMiningFit, planResourceLoad, planPriceEstimate, pilotHash,
  },
};

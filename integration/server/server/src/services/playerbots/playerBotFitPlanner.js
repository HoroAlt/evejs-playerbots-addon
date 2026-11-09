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

module.exports = { buildFitPlan, _testing: { MAX_FIT_ROWS, MAX_FIT_CARGO_UNITS, MAX_FIT_BAY_UNITS } };

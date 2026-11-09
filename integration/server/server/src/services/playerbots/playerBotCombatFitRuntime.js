"use strict";

const fitting = require("../fitting/liveFittingState");
const itemStore = require("../inventory/itemStore");
const inventory = require("./playerBotInventoryRuntime");

const ATTRIBUTE_FALLBACKS = Object.freeze({
  shieldCapacity: 263,
  shieldRechargeRate: 479,
  armorHP: 265,
  structureHP: 9,
  capacitorCapacity: 482,
  capacitorRechargeRate: 55,
  droneCapacity: 283,
  droneBandwidth: 1271,
  maxActiveDrones: 352,
  droneControlDistance: 458,
  shieldEmDamageResonance: 271,
  shieldExplosiveDamageResonance: 272,
  shieldKineticDamageResonance: 273,
  shieldThermalDamageResonance: 274,
});

function attributeValue(attributes, name, fallback = 0) {
  const id = fitting.getAttributeIDByNames(name) || ATTRIBUTE_FALLBACKS[name];
  const value = id > 0 ? Number(attributes && attributes[String(id)]) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function itemUnits(item) {
  return Math.max(0, Number(inventory.unitsOf(item)) || 0);
}

function listDroneBay(bot, shipID) {
  return itemStore.listCharacterItems(bot.characterID, {
    locationID: Number(shipID) || 0,
    flagID: itemStore.ITEM_FLAGS.DRONE_BAY,
  }).filter((item) => item && Number(item.typeID) > 0 && itemUnits(item) > 0);
}

function calculateCapacitorUse(bot, shipID, modules) {
  let capPerSecond = 0;
  let activatedModules = 0;
  const problems = [];
  for (const module of modules) {
    if (!fitting.isEffectivelyOnlineModule(module)) continue;
    const effects = fitting.getTypeEffectRecords(Number(module.typeID)) || [];
    const activation = effects.filter((effect) =>
      Number(effect && effect.effectCategoryID) === 1 && Number(effect.dischargeAttributeID) > 0);
    for (const effect of activation) {
      const discharge = Number(fitting.getTypeAttributeValue(module.typeID, "capacitorNeed")) || 0;
      const durationMs = Number(fitting.getTypeAttributeValue(module.typeID, "duration", "speed")) || 0;
      if (!(discharge > 0) || !(durationMs > 0)) continue;
      activatedModules += 1;
      capPerSecond += discharge / (durationMs / 1000);
    }
    const offensiveWeapon = fitting.typeHasEffectName(module.typeID, "turretFitted") ||
      fitting.typeHasEffectName(module.typeID, "launcherFitted");
    if (offensiveWeapon) {
      const charge = fitting.getLoadedChargeByFlag(bot.characterID, shipID, module.flagID);
      if (!charge || itemUnits(charge) < 100) {
        problems.push(`weapon module ${module.itemID} needs at least 100 loaded charges`);
      }
    }
  }
  return { capPerSecond, activatedModules, ammunitionReady: problems.length === 0, problems };
}

function buildCombatFitSnapshot(bot, entity, state = {}) {
  const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
  const shipID = Number(entity && entity.itemID || character.shipID) || 0;
  const shipTypeID = Number(entity && entity.typeID || character.shipTypeID) || 0;
  if (!shipID || !shipTypeID) return { success: false, reason: "active-ship-not-found" };

  const fittingRuntime = require("../../_secondary/fitting/fittingRuntime");
  const snapshot = fittingRuntime.getShipFittingSnapshot(bot.characterID, shipID, {
    assumeActiveShipModules: true,
    reason: "playerbot.combat-readiness",
  });
  if (!snapshot || !snapshot.shipAttributes) return { success: false, reason: "dogma-fitting-snapshot-unavailable" };
  const attributes = snapshot.shipAttributes;
  const modules = fitting.getFittedModuleItems(bot.characterID, shipID);
  const droneBay = listDroneBay(bot, shipID);
  // Launched drones leave the bay but remain part of the active ship's fit.
  const deployedDrones = (Array.isArray(state.deployedDrones) ? state.deployedDrones : [])
    .filter((drone) => drone && Number(drone.controllerID) === shipID && Number(drone.typeID) > 0)
    .map((drone) => ({ ...drone, stacksize: 1, quantity: 1 }));
  const availableDrones = [...droneBay, ...deployedDrones];
  const totalDrones = availableDrones.reduce((total, item) => total + itemUnits(item), 0);
  const droneBandwidth = availableDrones.reduce((total, item) => {
    const perDrone = Number(fitting.getTypeAttributeValue(item.typeID, "droneBandwidthUsed", "droneBandwidth")) || 0;
    return total + perDrone * itemUnits(item);
  }, 0);
  const droneVolume = availableDrones.reduce((total, item) => {
    const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(item.typeID)) || {};
    return total + Math.max(0, Number(type.volume) || 0) * itemUnits(item);
  }, 0);
  const droneRanges = availableDrones.map((item) => Math.max(
    Number(fitting.getTypeAttributeValue(item.typeID, "entityAttackRange")) || 0,
    Number(fitting.getTypeAttributeValue(item.typeID, "maxRange")) || 0,
  )).filter((value) => value > 0);
  const cap = calculateCapacitorUse(bot, shipID, modules);
  const capacitorCapacity = attributeValue(attributes, "capacitorCapacity", 0);
  const capacitorRechargeRate = attributeValue(attributes, "capacitorRechargeRate", 0);
  const peakCapacitorRecharge = capacitorCapacity > 0 && capacitorRechargeRate > 0
    ? (2.4 * capacitorCapacity) / capacitorRechargeRate
    : 0;
  const shieldCapacity = attributeValue(attributes, "shieldCapacity", 0);
  const shieldRechargeRate = attributeValue(attributes, "shieldRechargeRate", 0);
  const shieldPeakRecharge = shieldCapacity > 0 && shieldRechargeRate > 0
    ? (2.4 * shieldCapacity) / shieldRechargeRate
    : 0;
  const resistances = {};
  for (const damageType of ["em", "explosive", "kinetic", "thermal"]) {
    const name = `shield${damageType[0].toUpperCase()}${damageType.slice(1)}DamageResonance`;
    const resonance = attributeValue(attributes, name, NaN);
    if (Number.isFinite(resonance)) resistances[damageType] = Math.max(0, Math.min(1, 1 - resonance));
  }
  const fit = {
    shipID,
    shipTypeID,
    modules,
    moduleTypeIDs: modules.map((module) => Number(module.typeID)),
    totalDrones,
    droneBay,
    droneBandwidth,
    droneVolume,
    droneControlRange: attributeValue(attributes, "droneControlDistance", 20_000),
    droneAttackRange: droneRanges.length ? Math.min(...droneRanges) : 0,
    shieldCapacity,
    shieldPeakRecharge,
    armorHP: attributeValue(attributes, "armorHP", 0),
    structureHP: attributeValue(attributes, "structureHP", 0),
    shieldResistances: resistances,
    capacitorCapacity,
    capacitorRechargeRate,
    capacitorRatio: Number(entity && entity.capacitorChargeRatio),
    capacitorUsePerSecond: cap.capPerSecond,
    capacitorStable: cap.capPerSecond <= 0 || peakCapacitorRecharge >= cap.capPerSecond * 1.25,
    ammunitionReady: cap.ammunitionReady,
    ammunitionProblems: cap.problems,
    requiredDrones: Number(state.requiredDrones || 0),
    droneDamageTypeByID: { ...(state.droneDamageTypeByID || {}) },
    maxSiteDifficulty: Number(state.maxSiteDifficulty || 0),
    liveShield: Number(state.shield ?? (entity && entity.conditionState && entity.conditionState.shieldCharge)),
    hullDamage: Number(state.hullDamage ?? (entity && entity.conditionState && entity.conditionState.damage)) || 0,
    armorDamage: Number(state.armorDamage ?? (entity && entity.conditionState && entity.conditionState.armorDamage)) || 0,
    warpScrambleStatus: Number(state.warpScrambleStatus) || 0,
  };

  const availableBandwidth = attributeValue(attributes, "droneBandwidth", 0);
  const droneCapacity = attributeValue(attributes, "droneCapacity", 0);
  const maxActiveDrones = attributeValue(attributes, "maxActiveDrones", 0);
  const requiredDroneTypes = state.requiredDroneTypes instanceof Map
    ? state.requiredDroneTypes
    : new Map(Object.entries(state.requiredDroneTypes || {}).map(([typeID, count]) => [Number(typeID), Number(count)]));
  const requiredDroneVolume = [...requiredDroneTypes].reduce((total, [typeID, count]) => {
    const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(typeID)) || {};
    return total + Math.max(0, Number(type.volume) || 0) * Math.max(0, Number(count) || 0);
  }, 0);
  const requiredDroneBandwidth = [...requiredDroneTypes].reduce((total, [typeID, count]) =>
    total + Math.max(0, Number(fitting.getTypeAttributeValue(typeID, "droneBandwidthUsed", "droneBandwidth")) || 0) * Math.max(0, Number(count) || 0), 0);
  const droneCounts = new Map();
  for (const drone of availableDrones) droneCounts.set(Number(drone.typeID), (droneCounts.get(Number(drone.typeID)) || 0) + itemUnits(drone));
  const droneSetReady = [...requiredDroneTypes].every(([typeID, count]) => (droneCounts.get(Number(typeID)) || 0) >= Number(count));
  fit.droneSetReady = droneSetReady;
  fit.requiredDrones = [...requiredDroneTypes.values()].reduce((total, count) => total + Number(count || 0), 0);
  fit.droneCapacityReady = (!requiredDroneVolume || droneCapacity >= requiredDroneVolume) &&
    (!requiredDroneBandwidth || availableBandwidth >= requiredDroneBandwidth) &&
    (!fit.requiredDrones || maxActiveDrones >= fit.requiredDrones);
  fit.ready = fit.droneSetReady && fit.droneCapacityReady && fit.ammunitionReady && fit.capacitorStable &&
    fit.droneAttackRange > 0 && fit.droneControlRange > 0 && Object.keys(resistances).length === 4;
  fit.readinessProblems = [];
  if (!fit.droneSetReady) fit.readinessProblems.push("required combat drones are missing from the drone bay");
  if (!fit.droneCapacityReady) fit.readinessProblems.push("drone bandwidth, bay volume or active-drone skill is insufficient");
  if (!fit.ammunitionReady) fit.readinessProblems.push(...cap.problems);
  if (!fit.capacitorStable) fit.readinessProblems.push("active module capacitor demand exceeds the ship's conservative peak recharge");
  if (!fit.droneAttackRange) fit.readinessProblems.push("Dogma has no attack range for the fitted combat drones");
  if (!fit.droneControlRange) fit.readinessProblems.push("Dogma has no drone control range for the active ship");
  if (Object.keys(resistances).length !== 4) fit.readinessProblems.push("the ship's shield resistances are incomplete in Dogma");
  return { success: true, fit };
}

module.exports = { buildCombatFitSnapshot };

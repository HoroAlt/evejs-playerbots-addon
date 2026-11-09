"use strict";

// Cargo moves for playerbot actors through the regular invbroker service, so
// capacity, access and custody rules are the ones a docked pilot gets from the
// inventory window. The actor session is bound to the source or destination
// inventory exactly like a client bind before calling Add.

const itemStore = require("../inventory/itemStore");

const FLAG_CARGO = 5;
// Mining output lands in the ore hold on ships that have one (e.g. Venture).
const FLAG_ORE_HOLD = 134;
const FLAG_DRONE_BAY = itemStore.ITEM_FLAGS.DRONE_BAY;
const HOLD_FLAGS = [FLAG_CARGO, FLAG_ORE_HOLD];
const FLAG_HANGAR = itemStore.ITEM_FLAGS.HANGAR;
const STRUCTURE_SERVICE_SLOT_FLAGS = Object.freeze([164, 165, 166, 167, 168, 169, 170, 171]);

let invBroker = null;

function getInvBroker() {
  if (!invBroker) {
    const InvBrokerService = require("../inventory/invBrokerService");
    invBroker = new InvBrokerService();
  }
  return invBroker;
}

function getActorSession(bot) {
  return require("./playerBotSpaceRuntime").getActorSession(bot);
}

function getDockedStationID(session) {
  return Number(session && (session.stationID || session.structureID)) || 0;
}

function unitsOf(item) {
  if (!item) return 0;
  if (Number(item.singleton) > 0) return 1;
  const units = Number(item.stacksize ?? item.quantity);
  return Number.isFinite(units) && units > 0 ? Math.trunc(units) : 1;
}

function withBoundInventory(session, bindCall, action) {
  const broker = getInvBroker();
  const previousBoundObjectID = session.currentBoundObjectID;
  try {
    const bound = bindCall(broker);
    const boundID = bound && bound.value && Array.isArray(bound.value.value) ? bound.value.value[0] : null;
    if (!boundID) throw new Error("PLAYERBOT_INVENTORY_BIND_FAILED");
    session.currentBoundObjectID = boundID;
    return action(broker);
  } finally {
    session.currentBoundObjectID = previousBoundObjectID;
  }
}

function readKeyVal(value, key) {
  const entries = value && value.args && Array.isArray(value.args.entries) ? value.args.entries : [];
  const entry = entries.find(([name]) => name === key);
  return entry ? Number(entry[1]) || 0 : 0;
}

function getCargoCapacity(bot) {
  const session = getActorSession(bot);
  const shipID = Number(session.shipID) || 0;
  if (!shipID) return { capacity: 0, used: 0, free: 0 };
  let capacity = 0;
  let used = 0;
  for (const flagID of HOLD_FLAGS) {
    const info = withBoundInventory(
      session,
      (broker) => broker.Handle_GetInventoryFromId([shipID], session, null),
      (broker) => broker.Handle_GetCapacity([flagID], session, null),
    );
    capacity += readKeyVal(info, "capacity");
    used += readKeyVal(info, "used");
  }
  if (capacity <= 0) {
    // A ship reattached in space after a restart can answer 0/0 here; fall
    // back to the hull's static hold sizes and the volume of what it carries.
    const typeID = Number(session.shipTypeID) || 0;
    const registry = require("../inventory/itemTypeRegistry");
    const fitting = require("../fitting/liveFittingState");
    capacity = (Number(registry.resolveItemByTypeID(typeID)?.capacity) || 0) +
      (Number(fitting.getTypeAttributeValue(typeID, "generalMiningHoldCapacity", "specialOreHoldCapacity")) || 0);
    used = listCargo(bot).reduce((total, item) => total + getUnitVolume(item) * unitsOf(item), 0);
  }
  return { capacity, used, free: Math.max(0, capacity - used) };
}

// Free space in the general cargo bay only (where loaded goods go).
function getCargoBayFree(bot) {
  const session = getActorSession(bot);
  const shipID = Number(session.shipID) || 0;
  if (!shipID) return 0;
  const info = withBoundInventory(
    session,
    (broker) => broker.Handle_GetInventoryFromId([shipID], session, null),
    (broker) => broker.Handle_GetCapacity([FLAG_CARGO], session, null),
  );
  const capacity = readKeyVal(info, "capacity");
  if (capacity > 0) return Math.max(0, capacity - readKeyVal(info, "used"));
  const typeID = Number(session.shipTypeID) || 0;
  const bayCapacity = Number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(typeID)?.capacity) || 0;
  const used = listCargo(bot).filter((item) => Number(item.flagID) === FLAG_CARGO)
    .reduce((total, item) => total + getUnitVolume(item) * unitsOf(item), 0);
  return Math.max(0, bayCapacity - used);
}

function getCargoBayCapacity(bot) {
  const session = getActorSession(bot);
  const shipID = Number(session.shipID) || 0;
  if (!shipID) return 0;
  const info = withBoundInventory(
    session,
    (broker) => broker.Handle_GetInventoryFromId([shipID], session, null),
    (broker) => broker.Handle_GetCapacity([FLAG_CARGO], session, null),
  );
  const capacity = readKeyVal(info, "capacity");
  if (capacity > 0) return capacity;
  return Number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(session.shipTypeID) || 0)?.capacity) || 0;
}

function listCargo(bot, typeID = null) {
  const session = getActorSession(bot);
  const shipID = Number(session.shipID) || 0;
  if (!shipID) return [];
  return itemStore.listCharacterItems(bot.characterID, {
    locationID: shipID,
    ...(typeID ? { typeID } : {}),
  }).filter((item) => HOLD_FLAGS.includes(Number(item.flagID)));
}

function listHangar(bot, stationID, typeID = null) {
  return itemStore.listCharacterItems(bot.characterID, {
    locationID: stationID,
    flagID: FLAG_HANGAR,
    ...(typeID ? { typeID } : {}),
  });
}

// Use the same Stack All inventory command exposed to a docked pilot before a
// market run. Planetary exports and manufacturing can leave many identical
// item stacks in the hangar; one order per stack wastes the pilot's market
// order slots and makes listing needlessly slow.
function stackHangar(bot, stationID) {
  const session = getActorSession(bot);
  const numericStationID = Math.trunc(Number(stationID) || 0);
  if (!numericStationID || getDockedStationID(session) !== numericStationID) {
    return { success: false, mergedStacks: 0, message: "The bot must be docked at that station to stack its hangar." };
  }
  const before = listHangar(bot, numericStationID).length;
  try {
    withBoundInventory(
      session,
      (broker) => broker.Handle_GetInventory([numericStationID], session, null),
      (broker) => broker.Handle_StackAll([], session, null),
    );
  } catch (error) {
    return {
      success: false,
      mergedStacks: 0,
      message: `The inventory service could not stack the hangar: ${String(error && error.message || error).slice(0, 180)}`,
    };
  }
  const after = listHangar(bot, numericStationID).length;
  return {
    success: true,
    mergedStacks: Math.max(0, before - after),
    message: `Stacked hangar inventory at station ${numericStationID}.`,
  };
}

function countHangar(bot, stationID, typeID) {
  return listHangar(bot, stationID, typeID).reduce((total, item) => total + unitsOf(item), 0);
}

function countCargo(bot, typeID) {
  return listCargo(bot, typeID).reduce((total, item) => total + unitsOf(item), 0);
}

function getUnitVolume(item) {
  const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(item && item.typeID));
  const volume = Number(item && item.volume) || Number(type && (type.volume ?? type.packagedVolume)) || 0;
  return volume > 0 ? volume : 0;
}

// Load up to `quantity` units of a hangar item into the active ship's cargo.
function loadToCargo(bot, itemID, quantity = null) {
  const session = getActorSession(bot);
  const stationID = getDockedStationID(session);
  const shipID = Number(session.shipID) || 0;
  const item = itemStore.findItemById(itemID);
  if (!stationID || !shipID) return { success: false, message: "The bot must be docked with an active ship." };
  if (!item || Number(item.ownerID) !== Number(bot.characterID) ||
      Number(item.locationID) !== stationID || Number(item.flagID) !== FLAG_HANGAR) {
    return { success: false, message: `Item ${itemID} is not in ${bot.characterName}’s personal hangar at ${stationID}.` };
  }
  const available = unitsOf(item);
  const unitVolume = getUnitVolume(item);
  const free = getCargoBayFree(bot);
  const fitting = unitVolume > 0 ? Math.floor((free + 1e-9) / unitVolume) : available;
  const requested = quantity === null || quantity === undefined ? available : Math.min(available, Math.trunc(Number(quantity)));
  const moving = Math.min(requested, fitting);
  if (moving <= 0) return { success: false, moved: 0, message: `The item does not fit in the cargo hold (${free.toFixed(2)} m³ free, ${unitVolume} m³ per unit).` };
  const before = countCargo(bot, item.typeID);
  withBoundInventory(
    session,
    (broker) => broker.Handle_GetInventoryFromId([shipID], session, null),
    (broker) => broker.Handle_Add([Number(itemID), stationID], session, { flag: FLAG_CARGO, qty: moving }),
  );
  const moved = Math.max(0, countCargo(bot, item.typeID) - before);
  return {
    success: moved > 0,
    moved,
    typeID: Number(item.typeID),
    message: moved > 0
      ? `Loaded ${moved} units of ${item.typeID} into the cargo hold.`
      : "The inventory service did not move the item.",
  };
}

// Move owned commodities from a nearby space container through invbroker.
function loadFromContainer(bot, containerID) {
  const session = getActorSession(bot);
  const shipID = Number(session.shipID) || 0;
  const numericContainerID = Number(containerID) || 0;
  const stacks = itemStore.listContainerItems(null, numericContainerID);
  if (!stacks.length) {
    try {
      const wreckItems = require("../../space/npc/nativeNpcStore")
        .listNativeWreckItemsForWreck(numericContainerID);
      stacks.push(...wreckItems.map((item) => ({
        ...item,
        itemID: Number(item.wreckItemID) || Number(item.itemID) || 0,
        locationID: numericContainerID,
        flagID: Number(item.flagID) || FLAG_CARGO,
        stacksize: Number(item.quantity) || Number(item.stacksize) || 1,
      })));
    } catch (_) {
      // Ordinary space containers are already covered by itemStore.
    }
  }
  let moved = 0;
  let error = null;
  for (const stack of stacks) {
    const free = getCargoBayFree(bot);
    const volume = getUnitVolume(stack);
    const quantity = Math.min(unitsOf(stack), volume > 0 ? Math.floor((free + 1e-9) / volume) : unitsOf(stack));
    if (quantity <= 0) break;
    const before = countCargo(bot, stack.typeID);
    try {
      withBoundInventory(session,
        (broker) => broker.Handle_GetInventoryFromId([shipID], session, null),
        (broker) => broker.Handle_Add([Number(stack.itemID), numericContainerID], session, { flag: FLAG_CARGO, qty: quantity }));
    } catch (cause) {
      error = String(cause && cause.message || cause).slice(0, 180);
      break;
    }
    moved += Math.max(0, countCargo(bot, stack.typeID) - before);
  }
  const remaining = itemStore.listContainerItems(null, numericContainerID).length ||
    (() => {
      try { return require("../../space/npc/nativeNpcStore").listNativeWreckItemsForWreck(numericContainerID).length; }
      catch (_) { return 0; }
    })();
  if (!error && moved <= 0 && remaining > 0) error = "NO_CARGO_CAPACITY_OR_TRANSFER";
  return { moved, remaining, error };
}

function loadToDroneBay(bot, itemID, quantity = null) {
  const session = getActorSession(bot);
  const stationID = getDockedStationID(session);
  const shipID = Number(session.shipID) || 0;
  const item = itemStore.findItemById(itemID);
  if (!stationID || !shipID) return { success: false, message: "The bot must be docked with an active ship." };
  if (!item || Number(item.ownerID) !== Number(bot.characterID) ||
      Number(item.locationID) !== stationID || Number(item.flagID) !== FLAG_HANGAR) {
    return { success: false, message: `Item ${itemID} is not in ${bot.characterName}'s personal hangar at ${stationID}.` };
  }
  const requested = quantity == null ? unitsOf(item) : Math.min(unitsOf(item), Math.max(1, Math.trunc(Number(quantity) || 0)));
  const before = itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID: FLAG_DRONE_BAY })
    .reduce((total, entry) => total + unitsOf(entry), 0);
  withBoundInventory(session,
    (broker) => broker.Handle_GetInventoryFromId([shipID], session, null),
    (broker) => broker.Handle_Add([Number(itemID), stationID], session, { flag: FLAG_DRONE_BAY, qty: requested }));
  const bay = itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID: FLAG_DRONE_BAY });
  const moved = bay.reduce((total, entry) => total + unitsOf(entry), 0) - before;
  return { success: moved > 0, moved, message: moved > 0 ? `Loaded ${moved} drone(s) into the drone bay.` : "The inventory service did not load the drone bay." };
}

function loadToFighterBay(bot, itemID, quantity = null) {
  const session = getActorSession(bot);
  const stationID = getDockedStationID(session);
  const shipID = Number(session.shipID) || 0;
  const item = itemStore.findItemById(itemID);
  const flagID = itemStore.ITEM_FLAGS.FIGHTER_BAY;
  if (!stationID || !shipID) return { success: false, message: "The bot must be docked with an active ship." };
  if (!item || Number(item.ownerID) !== Number(bot.characterID) ||
      Number(item.locationID) !== stationID || Number(item.flagID) !== FLAG_HANGAR) {
    return { success: false, message: `Item ${itemID} is not in ${bot.characterName}'s personal hangar at ${stationID}.` };
  }
  const requested = quantity == null ? unitsOf(item) : Math.min(unitsOf(item), Math.max(1, Math.trunc(Number(quantity) || 0)));
  const before = itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID })
    .reduce((total, entry) => total + unitsOf(entry), 0);
  withBoundInventory(session,
    (broker) => broker.Handle_GetInventoryFromId([shipID], session, null),
    (broker) => broker.Handle_Add([Number(itemID), stationID], session, { flag: flagID, qty: requested }));
  const bay = itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID });
  const moved = bay.reduce((total, entry) => total + unitsOf(entry), 0) - before;
  return { success: moved > 0, moved, message: moved > 0 ? `Loaded ${moved} fighter(s) into the fighter bay.` : "The inventory service did not load the fighter bay." };
}

function unloadExcessDroneBay(bot, desiredCounts = new Map()) {
  const session = getActorSession(bot);
  const stationID = getDockedStationID(session);
  const shipID = Number(session.shipID) || 0;
  if (!stationID || !shipID) return { success: false, message: "The bot must be docked with an active ship to refit its drone bay." };
  const desired = desiredCounts instanceof Map
    ? desiredCounts
    : new Map(Object.entries(desiredCounts || {}).map(([typeID, count]) => [Number(typeID), Number(count)]));
  let moved = 0;
  for (const item of itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID: FLAG_DRONE_BAY })) {
    const current = unitsOf(item);
    const excess = Math.max(0, current - (Number(desired.get(Number(item.typeID))) || 0));
    if (!excess) continue;
    const before = itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID: FLAG_DRONE_BAY })
      .filter((entry) => Number(entry.typeID) === Number(item.typeID))
      .reduce((total, entry) => total + unitsOf(entry), 0);
    withBoundInventory(session,
      (broker) => broker.Handle_GetInventory([stationID], session, null),
      (broker) => broker.Handle_Add([Number(item.itemID), shipID], session, { flag: FLAG_HANGAR, qty: excess }));
    const after = itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID: FLAG_DRONE_BAY })
      .filter((entry) => Number(entry.typeID) === Number(item.typeID))
      .reduce((total, entry) => total + unitsOf(entry), 0);
    moved += Math.max(0, before - after);
    if (after > (Number(desired.get(Number(item.typeID))) || 0)) {
      return { success: false, moved, message: `Could not remove surplus drones of type ${item.typeID} from the bay.` };
    }
  }
  return { success: true, moved };
}

// Unload every cargo stack (optionally of one type) into the station hangar.
function unloadCargo(bot, typeID = null) {
  const session = getActorSession(bot);
  const stationID = getDockedStationID(session);
  const shipID = Number(session.shipID) || 0;
  if (!stationID || !shipID) return { success: false, unloaded: {}, message: "The bot must be docked to unload." };
  const unloaded = {};
  for (const item of listCargo(bot, typeID)) {
    const before = countHangar(bot, stationID, item.typeID);
    withBoundInventory(
      session,
      (broker) => broker.Handle_GetInventory([stationID], session, null),
      (broker) => broker.Handle_Add([Number(item.itemID), shipID], session, { flag: FLAG_HANGAR, qty: unitsOf(item) }),
    );
    const moved = Math.max(0, countHangar(bot, stationID, item.typeID) - before);
    unloaded[String(item.typeID)] = (unloaded[String(item.typeID)] || 0) + moved;
  }
  return { success: true, unloaded, message: `Unloaded to station ${stationID}: ${JSON.stringify(unloaded)}.` };
}

// Install a carried Quantum Core, service module, or fuel in the docked
// corporation structure through the normal inventory broker. The broker owns
// structure access, core type, fitting-slot, fuel compatibility, capacity,
// module auto-online, and service-fuel checks; this wrapper only reconciles the
// move against inventory records after the authority call.
function moveCargoToStructure(bot, itemID, structureID, destinationFlagID, quantity = null) {
  const session = getActorSession(bot);
  const numericStructureID = Number(structureID) || 0;
  const numericItemID = Number(itemID) || 0;
  const numericFlagID = Number(destinationFlagID) || 0;
  const fuelBayFlag = require("../inventory/fuelBayInventory").STRUCTURE_FUEL_BAY_FLAG;
  const allowedFlags = new Set([
    Number(itemStore.ITEM_FLAGS.STRUCTURE_DEED),
    Number(fuelBayFlag),
    ...STRUCTURE_SERVICE_SLOT_FLAGS,
  ].filter((value) => value > 0));
  if (!numericStructureID || !numericItemID || !allowedFlags.has(numericFlagID)) {
    return { success: false, moved: 0, message: "A valid structure, cargo item, and structure bay are required." };
  }
  if (getDockedStationID(session) !== numericStructureID) {
    return { success: false, moved: 0, message: `The bot must be docked at structure ${numericStructureID} to move items into its bays.` };
  }
  const shipID = Number(session.shipID) || 0;
  const source = itemStore.findItemById(numericItemID);
  if (!source || Number(source.ownerID) !== Number(bot.characterID) ||
      Number(source.locationID) !== shipID || Number(source.flagID) !== FLAG_CARGO) {
    return { success: false, moved: 0, message: `Item ${numericItemID} must be in the bot's active ship cargo.` };
  }
  const available = unitsOf(source);
  const requested = quantity == null
    ? available
    : Math.min(available, Math.max(1, Math.trunc(Number(quantity) || 0)));
  if (requested <= 0) return { success: false, moved: 0, message: `Item ${numericItemID} has no transferable quantity.` };

  const countAtStructure = () => itemStore.listContainerItems(null, numericStructureID, numericFlagID)
    .filter((entry) => Number(entry.typeID) === Number(source.typeID))
    .reduce((total, entry) => total + unitsOf(entry), 0);
  const before = countAtStructure();
  try {
    withBoundInventory(
      session,
      (broker) => broker.Handle_GetInventory([numericStructureID], session, null),
      (broker) => broker.Handle_Add(
        [numericItemID, shipID],
        session,
        { flag: numericFlagID, qty: requested },
      ),
    );
  } catch (error) {
    const moved = Math.max(0, countAtStructure() - before);
    return {
      success: false,
      moved,
      message: moved > 0
        ? `The inventory broker moved ${moved} units but returned an error; reconcile the structure bay before retrying: ${String(error && error.message || error).slice(0, 180)}`
        : `The inventory broker refused the structure transfer: ${String(error && error.message || error).slice(0, 180)}`,
    };
  }
  const moved = Math.max(0, countAtStructure() - before);
  return {
    success: moved === requested,
    moved,
    typeID: Number(source.typeID),
    structureID: numericStructureID,
    flagID: numericFlagID,
    message: moved === requested
      ? `Transferred ${moved} unit(s) of type ${source.typeID} into structure ${numericStructureID}.`
      : `The inventory broker confirmed ${moved} of ${requested} requested unit(s) in structure ${numericStructureID}.`,
  };
}

module.exports = {
  FLAG_CARGO,
  FLAG_DRONE_BAY,
  countCargo,
  countHangar,
  getCargoCapacity,
  getCargoBayCapacity,
  getCargoBayFree,
  loadFromContainer,
  stackHangar,
  loadToDroneBay,
  loadToFighterBay,
  unloadExcessDroneBay,
  getUnitVolume,
  listCargo,
  listHangar,
  loadToCargo,
  moveCargoToStructure,
  unitsOf,
  unloadCargo,
};

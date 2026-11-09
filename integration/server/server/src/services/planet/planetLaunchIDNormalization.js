"use strict";

// Launch IDs are checked while normalizing planet state. Most reads see the
// same in-memory launch map, so remember that a safe map has already passed
// validation instead of scanning every launch on every PI read.
const validatedLaunchMaps = new WeakSet();

// Launch IDs used to be counted up from 910000000000, which does not fit the
// 32-bit launchID column. A store written then holds launches under those IDs
// and a counter past them. Each such launch is given the next free ID that
// fits and is stored under it, with the ID it had kept as legacyLaunchID, and
// the counter is brought back into range without changing its container.

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function storedLaunchID(key, launch) {
  return normalizeInteger((launch && launch.launchID) || key, 0);
}

function invalidateLaunchIDNormalization(launchesByID) {
  if (launchesByID && typeof launchesByID === "object") {
    validatedLaunchMaps.delete(launchesByID);
  }
}

function renumberWideLaunchIDs(state, { maxLaunchID, defaultLaunchID } = {}) {
  const maxID = normalizeInteger(maxLaunchID, 0x7fffffff);
  const fallbackID = normalizeInteger(defaultLaunchID, 910000000);
  const launchesByID = state.launchesByID;
  const storedCounter = normalizeInteger(state.nextIDs.launchID, 0);
  const counterFits = storedCounter > 0 && storedCounter <= maxID;

  if (counterFits && validatedLaunchMaps.has(launchesByID)) {
    return false;
  }

  const wideKeys = Object.keys(launchesByID).filter((key) => (
    launchesByID[key] && typeof launchesByID[key] === "object" &&
    storedLaunchID(key, launchesByID[key]) > maxID
  ));
  if (counterFits && wideKeys.length === 0) {
    validatedLaunchMaps.add(launchesByID);
    return false;
  }

  const usedIDs = new Set();
  for (const [key, launch] of Object.entries(launchesByID)) {
    usedIDs.add(normalizeInteger(key, 0));
    usedIDs.add(storedLaunchID(key, launch));
  }

  let nextID = counterFits ? storedCounter : fallbackID;
  const renumberedByKey = new Map();
  wideKeys.sort((left, right) => (
    storedLaunchID(left, launchesByID[left]) -
    storedLaunchID(right, launchesByID[right])
  ));
  for (const key of wideKeys) {
    const launch = launchesByID[key];
    const previousLaunchID = storedLaunchID(key, launch);
    while (usedIDs.has(nextID)) {
      nextID += 1;
    }
    const launchID = nextID;
    usedIDs.add(launchID);
    nextID += 1;

    const itemID = normalizeInteger(launch.itemID, 0);
    renumberedByKey.set(key, {
      ...launch,
      launchID,
      legacyLaunchID: previousLaunchID,
      itemID: itemID > 0 && itemID !== previousLaunchID ? itemID : launchID,
    });
  }

  const normalizedLaunchesByID = {};
  for (const [key, launch] of Object.entries(launchesByID)) {
    const renumbered = renumberedByKey.get(key);
    if (renumbered) {
      normalizedLaunchesByID[String(renumbered.launchID)] = renumbered;
    } else {
      normalizedLaunchesByID[key] = launch;
    }
  }
  state.launchesByID = normalizedLaunchesByID;
  state.nextIDs = { ...state.nextIDs, launchID: nextID };
  if (nextID > 0 && nextID <= maxID) {
    validatedLaunchMaps.add(normalizedLaunchesByID);
  }
  return true;
}

module.exports = { storedLaunchID, invalidateLaunchIDNormalization, renumberWideLaunchIDs };

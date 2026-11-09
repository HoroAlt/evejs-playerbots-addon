"use strict";

const { createTableRepository } = require("../../gameStore/tableRepository");
const { getCharacterWallet } = require("../account/walletState");
const planetCostCalculator = require("../planet/planetCostCalculator");
const planetRuntime = require("../planet/planetRuntimeStore");
const planetStaticData = require("../planet/planetStaticData");
const playerBots = require("./playerBotRuntime");

const TABLE = "playerBots";
const POLICY_PATH = "/_planetaryExportPolicies";
const SCHEDULE_PATH = "/_planetaryExportSchedule";
const TASK_KIND = "playerbot.planetary.autoexport";
const MAX_UNITS_PER_CYCLE = 100_000;
const MAX_TAX_PER_CYCLE_ISK = 1_000_000_000;
const EXPORT_PRICE_CACHE_MS = 5 * 60 * 1000;
const repo = createTableRepository("service:playerbots", { strict: true });
const exportPriceCache = new Map();

function normalizeID(value) {
  const id = Math.trunc(Number(value));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function readObject(path) {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, path);
  const data = result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
  return path === SCHEDULE_PATH ? data : JSON.parse(JSON.stringify(data));
}

function writeObject(path, value, errorCode) {
  const result = repo.write(TABLE, path, value);
  if (!result.success) throw new Error(result.errorMsg || errorCode);
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || errorCode);
  }
  return value;
}

function readPolicies() {
  return readObject(POLICY_PATH, "PLAYERBOT_PI_EXPORT_POLICY_READ_FAILED");
}

function savePolicies(policies) {
  return writeObject(POLICY_PATH, policies, "PLAYERBOT_PI_EXPORT_POLICY_WRITE_FAILED");
}

function getPolicyForCharacter(characterID, planetID) {
  return readPolicies()[`${normalizeID(characterID)}:${normalizeID(planetID)}`] || null;
}

function listActiveAutoExportPolicies() {
  return Object.values(readPolicies()).filter((policy) => policy && policy.enabled === true);
}

function findCommandPin(colony) {
  return (Array.isArray(colony && colony.pins) ? colony.pins : []).find((pin) =>
    planetStaticData.getPinEntityType(pin && pin.typeID) === "command",
  ) || null;
}

function normalizeContents(contents) {
  const result = {};
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) return result;
  for (const [rawTypeID, rawQuantity] of Object.entries(contents)) {
    const typeID = normalizeID(rawTypeID);
    const quantity = Math.max(0, Math.trunc(Number(rawQuantity) || 0));
    if (typeID && quantity) result[String(typeID)] = quantity;
  }
  return result;
}

function selectCommodities(contents, maxUnits, unitValues = {}, maxVolume = Number.POSITIVE_INFINITY) {
  let remaining = Math.min(MAX_UNITS_PER_CYCLE, Math.max(0, Math.trunc(Number(maxUnits) || 0)));
  let remainingVolume = Number.isFinite(Number(maxVolume))
    ? Math.max(0, Number(maxVolume))
    : Number.POSITIVE_INFINITY;
  const entries = Object.entries(normalizeContents(contents))
    .filter(([typeID]) => planetStaticData.isPlanetaryCommodity(Number(typeID)))
    .map(([typeID, available]) => {
      const unitVolume = require("./playerBotInventoryRuntime").getUnitVolume({ typeID: Number(typeID) });
      const unitValue = Number(unitValues[typeID]) || planetStaticData.getTypeBasePrice(Number(typeID));
      return { typeID, available, unitVolume, unitValue };
    })
    .filter((entry) => entry.unitVolume > 0)
    .sort((left, right) =>
      right.unitValue / right.unitVolume - left.unitValue / left.unitVolume ||
      Number(left.typeID) - Number(right.typeID),
    );
  const selected = {};
  for (const entry of entries) {
    if (remaining <= 0 || remainingVolume <= 0) break;
    const volumeLimit = Number.isFinite(remainingVolume)
      ? Math.floor((remainingVolume + 1e-9) / entry.unitVolume)
      : entry.available;
    const quantity = Math.min(entry.available, remaining, volumeLimit);
    if (quantity > 0) selected[entry.typeID] = quantity;
    remaining -= quantity;
    remainingVolume -= quantity * entry.unitVolume;
  }
  return selected;
}

function countUnits(contents) {
  return Object.values(normalizeContents(contents)).reduce((sum, value) => sum + value, 0);
}

function buildExportPlan(characterID, planetID, maxUnits, unitValues = {}, maxVolume = Number.POSITIVE_INFINITY) {
  const colony = planetRuntime.getColony(planetID, characterID);
  if (!colony) return { success: false, reason: "colony-missing" };
  const commandPin = findCommandPin(colony);
  if (!commandPin) return { success: false, reason: "command-center-missing" };
  const selected = selectCommodities(commandPin.contents, maxUnits, unitValues, maxVolume);
  if (!Object.keys(selected).length) return { success: false, reason: "no-planetary-commodities" };
  const preview = planetRuntime.previewLaunchCommodities({
    planetID,
    ownerID: characterID,
    solarSystemID: Number(colony.solarSystemID) || 0,
    planetTypeID: Number(colony.planetTypeID) || 0,
    commandPinID: Number(commandPin.pinID),
    commodities: selected,
  });
  if (!preview.success) {
    return { success: false, reason: preview.errorMsg || "launch-preview-refused" };
  }
  const commodities = normalizeContents(preview.commoditiesToLaunch);
  if (!Object.keys(commodities).length) return { success: false, reason: "no-launchable-commodities" };
  const tax = planetCostCalculator.calculateExportTax(
    preview.commandPin.typeID,
    commodities,
    planetCostCalculator.DEFAULT_TAX_RATE,
  );
  return {
    success: true,
    colony,
    commandPin: preview.commandPin,
    commodities,
    units: countUnits(commodities),
    tax: Math.max(0, Number(tax) || 0),
  };
}

async function readExportUnitValues(bot, planetID) {
  const colony = planetRuntime.getColony(planetID, bot.characterID);
  const commandPin = findCommandPin(colony);
  if (!commandPin) return {};
  const stationID = Number(require("./playerBotEconomyRuntime").BOT_HUB_STATION_ID) || 0;
  const values = {};
  const trade = require("./playerBotTradeRuntime");
  for (const typeID of Object.keys(normalizeContents(commandPin.contents))) {
    if (!planetStaticData.isPlanetaryCommodity(Number(typeID))) continue;
    const cacheKey = `${stationID}:${typeID}`;
    const cached = exportPriceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      values[typeID] = cached.value;
      continue;
    }
    let value = Number(planetStaticData.getTypeBasePrice(Number(typeID))) || 0;
    try {
      const quote = await trade.readQuoteAt(bot.characterName, Number(typeID), stationID);
      if (quote.success && quote.bestBid && Number(quote.bestBid.price) > 0) value = Number(quote.bestBid.price);
    } catch (_) {
      // Static type value remains a safe fallback when a station quote is unavailable.
    }
    exportPriceCache.set(cacheKey, { value, expiresAt: Date.now() + EXPORT_PRICE_CACHE_MS });
    values[typeID] = value;
  }
  return values;
}

function setAutoExportPolicy(botQuery, planetIDValue, maxUnitsValue, maxTaxValue, requestedByCharacterID = null) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const planetID = normalizeID(planetIDValue);
  const maxUnits = Math.trunc(Number(maxUnitsValue));
  const maxTaxPerCycle = Number(maxTaxValue);
  if (!planetID || !Number.isSafeInteger(maxUnits) || maxUnits < 1 || maxUnits > MAX_UNITS_PER_CYCLE) {
    return { success: false, message: `The planet must exist and the limit must be between 1 and ${MAX_UNITS_PER_CYCLE.toLocaleString("en-US")} units.` };
  }
  if (!Number.isFinite(maxTaxPerCycle) || maxTaxPerCycle < 0 || maxTaxPerCycle > MAX_TAX_PER_CYCLE_ISK) {
    return { success: false, message: `The tax limit must be between 0 and ${MAX_TAX_PER_CYCLE_ISK.toLocaleString("en-US")} ISK.` };
  }
  const colony = planetRuntime.getColony(planetID, bot.characterID);
  if (!colony) return { success: false, message: `${bot.characterName} has no colony on planet ${planetID}.` };
  if (!findCommandPin(colony)) return { success: false, message: `Colony ${planetID} has no Command Center.` };

  const policies = readPolicies();
  const key = `${Number(bot.characterID)}:${planetID}`;
  const previous = policies[key] || {};
  const policy = {
    characterID: Number(bot.characterID),
    planetID,
    maxUnitsPerCycle: maxUnits,
    maxTaxPerCycle: Math.round(maxTaxPerCycle * 100) / 100,
    enabled: true,
    version: Math.max(0, Math.trunc(Number(previous.version) || 0)) + 1,
    requestedByCharacterID: normalizeID(requestedByCharacterID) || null,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    disabledAt: null,
  };
  policies[key] = policy;
  try {
    savePolicies(policies);
    return {
      success: true,
      policy,
      message: `PI export enabled for ${bot.characterName} on planet ${planetID}: up to ${maxUnits.toLocaleString("en-US")} units and ${policy.maxTaxPerCycle.toFixed(2)} ISK tax per 5-minute cycle.`,
    };
  } catch (error) {
    return { success: false, message: `Could not save the PI policy: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

function getAutoExportPolicy(botQuery, planetIDValue) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique bot found for: ${botQuery}.` };
  const planetID = normalizeID(planetIDValue);
  if (!planetID) return { success: false, message: "Enter a valid planetID." };
  const policy = getPolicyForCharacter(bot.characterID, planetID);
  if (!policy || policy.enabled !== true) {
    return { success: true, policy: null, message: `${bot.characterName} has no active PI export policy for planet ${planetID}.` };
  }
  return {
    success: true,
    policy,
    message: `${bot.characterName}: planet ${planetID} export policy, up to ${Number(policy.maxUnitsPerCycle).toLocaleString("en-US")} units and ${Number(policy.maxTaxPerCycle).toFixed(2)} ISK tax every 5 minutes.`,
  };
}

function disableAutoExportPolicy(botQuery, planetIDValue) {
  const bot = playerBots.resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const planetID = normalizeID(planetIDValue);
  const policies = readPolicies();
  const key = `${Number(bot.characterID)}:${planetID}`;
  const previous = policies[key];
  if (!previous || previous.enabled !== true) {
    return { success: true, message: `${bot.characterName} had no active PI export for planet ${planetID}.` };
  }
  policies[key] = {
    ...previous,
    enabled: false,
    disabledReason: "operator-disabled",
    version: Math.max(0, Math.trunc(Number(previous.version) || 0)) + 1,
    disabledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    savePolicies(policies);
    return { success: true, message: `PI export disabled for ${bot.characterName} on planet ${planetID}.` };
  } catch (error) {
    return { success: false, message: `Could not disable the PI policy: ${String(error && error.message || error).slice(0, 180)}.` };
  }
}

function disablePolicyForCharacter(characterID, planetID, expectedVersion = null, reason = "operator-disabled") {
  const policies = readPolicies();
  const key = `${normalizeID(characterID)}:${normalizeID(planetID)}`;
  const policy = policies[key];
  if (!policy || policy.enabled !== true ||
      (expectedVersion !== null && Number(policy.version) !== Number(expectedVersion))) return false;
  policies[key] = {
    ...policy,
    enabled: false,
    disabledReason: String(reason || "operator-disabled"),
    version: Math.max(0, Math.trunc(Number(policy.version) || 0)) + 1,
    disabledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  savePolicies(policies);
  return true;
}

function addMissingPolicies(policies, colonyTargets, now = new Date().toISOString()) {
  let added = 0;
  for (const target of Array.isArray(colonyTargets) ? colonyTargets : []) {
    const characterID = normalizeID(target && target.characterID);
    const planetID = normalizeID(target && target.planetID);
    if (!characterID || !planetID) continue;
    const key = `${characterID}:${planetID}`;
    // An existing disabled policy is an operator decision or a safety hold;
    // only a never-configured colony gets the automatic default.
    if (Object.prototype.hasOwnProperty.call(policies, key)) continue;
    policies[key] = {
      characterID,
      planetID,
      maxUnitsPerCycle: 2000,
      maxTaxPerCycle: 100000,
      enabled: true,
      version: 1,
      requestedByCharacterID: null,
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      automaticallyReconciled: true,
    };
    added += 1;
  }
  return added;
}

function reconcileAutoExportPolicies(bots = []) {
  const policies = readPolicies();
  const targets = [];
  for (const bot of Array.isArray(bots) ? bots : []) {
    const characterID = normalizeID(bot && bot.characterID);
    if (!characterID) continue;
    for (const colony of planetRuntime.listColoniesForCharacter(characterID) || []) {
      if (findCommandPin(colony)) targets.push({ characterID, planetID: colony.planetID });
    }
  }
  const added = addMissingPolicies(policies, targets);
  if (added) savePolicies(policies);
  return { added, enabled: Object.values(policies).filter((policy) => policy && policy.enabled === true).length };
}

async function scheduleAutoExportTasks(bots = [], cycleID = Date.now()) {
  const marker = readObject(SCHEDULE_PATH, "PLAYERBOT_PI_EXPORT_SCHEDULE_READ_FAILED");
  const normalizedCycleID = String(cycleID || Date.now());
  if (String(marker.lastCycleID || "") === normalizedCycleID) {
    return { scheduled: 0, skippedReplay: true, skipped: 0 };
  }
  writeObject(SCHEDULE_PATH, { lastCycleID: normalizedCycleID, markedAt: new Date().toISOString() },
    "PLAYERBOT_PI_EXPORT_SCHEDULE_WRITE_FAILED");

  const botByID = new Map((Array.isArray(bots) ? bots : []).map((bot) => [Number(bot.characterID), bot]));
  const tasks = require("./playerBotTaskRuntime");
  const existingTasks = tasks.listTasks({ limit: 100 });
  let scheduled = 0;
  let skipped = 0;
  for (const policy of listActiveAutoExportPolicies()) {
    const bot = botByID.get(Number(policy.characterID));
    if (!bot || bot.status === "paused" || bot.autonomyPaused === true) continue;
    const operationRuntime = require("./playerBotOperationRuntime");
    const activeOperation = operationRuntime.getOperation(bot.characterID);
    const activeCycle = require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID);
    if ((activeOperation && ["active", "holding", "review"].includes(activeOperation.status)) ||
        (activeCycle && ["active", "holding", "review"].includes(activeCycle.status)) ||
        operationRuntime.nextPlanetaryLaunch(bot)) {
      skipped += 1;
      continue;
    }
    const unresolvedTask = existingTasks.find((task) => {
      const samePolicyTarget = task.kind === TASK_KIND &&
        Number(task.resourceOwnerCharacterID) === Number(policy.characterID) &&
        Number(task.payload && task.payload.planetID) === Number(policy.planetID);
      const uncertainResult = task.result && task.result.outcomeUnknown === true ||
        task.progress && task.progress.result && task.progress.result.outcomeUnknown === true;
      const samePolicyVersion = Number(task.payload && task.payload.policyVersion) === Number(policy.version);
      return samePolicyTarget && (
        task.progress && task.progress.phase === "launching" ||
        uncertainResult && samePolicyVersion
      );
    });
    if (unresolvedTask) {
      skipped += 1;
      continue;
    }
    const unitValues = await readExportUnitValues(bot, policy.planetID);
    const freeCargo = require("./playerBotInventoryRuntime").getCargoBayFree(bot);
    const plan = buildExportPlan(bot.characterID, policy.planetID, policy.maxUnitsPerCycle, unitValues, freeCargo);
    if (!plan.success || plan.units <= 0 || plan.tax > Number(policy.maxTaxPerCycle) + 0.0001) {
      skipped += 1;
      continue;
    }
    const balance = Number(getCharacterWallet(bot.characterID)?.balance) || 0;
    if (balance + 0.0001 < plan.tax) {
      skipped += 1;
      continue;
    }
    const task = tasks.enqueueTask({
      kind: TASK_KIND,
      capability: "planetary",
      resourceOwnerCharacterID: Number(bot.characterID),
      requestedBy: "system",
      dedupeKey: `playerbot.planetary.autoexport:${Number(bot.characterID)}:${Number(policy.planetID)}:${Math.max(1, Math.trunc(Number(policy.version) || 1))}`,
      payload: {
        policyVersion: Math.max(1, Math.trunc(Number(policy.version) || 1)),
        planetID: normalizeID(policy.planetID),
        maxUnitsPerCycle: Math.trunc(Number(policy.maxUnitsPerCycle)),
        maxTaxPerCycle: Number(policy.maxTaxPerCycle),
      },
    });
    if (task.created) scheduled += 1;
  }
  return { scheduled, skippedReplay: false, skipped };
}

function currentCommandCenterContents(characterID, planetID) {
  const colony = planetRuntime.getColony(planetID, characterID);
  const commandPin = findCommandPin(colony);
  return { colony, commandPin, contents: normalizeContents(commandPin && commandPin.contents) };
}

function quantitiesWereRemoved(baseline, current, commodities) {
  return Object.entries(commodities || {}).every(([typeID, quantity]) =>
    Number(baseline[typeID] || 0) - Number(current[typeID] || 0) >= Number(quantity),
  );
}

function quantitiesUnchanged(baseline, current, commodities) {
  return Object.keys(commodities || {}).every((typeID) =>
    Number(baseline[typeID] || 0) === Number(current[typeID] || 0),
  );
}

function latestLaunch(characterID, planetID) {
  return planetRuntime.listLaunchesForCharacter(characterID)
    .filter((launch) => Number(launch.planetID) === Number(planetID))
    .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))[0] || null;
}

async function invokeNormalPlanetLaunch(bot, planetID, commandPinID, commodities, operationID = "") {
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const hadPreviousPlanet = Object.prototype.hasOwnProperty.call(session, "_planetMgrLastPlanetID");
  const previousPlanetID = session._planetMgrLastPlanetID;
  const hadPreviousOperationID = Object.prototype.hasOwnProperty.call(session, "_playerbotPIExportOperationID");
  const previousOperationID = session._playerbotPIExportOperationID;
  // This is the planet context normally retained by planetMgr after MachoBindObject.
  // The handler still performs the ordinary colony, inventory, tax, and wallet checks.
  session._planetMgrLastPlanetID = Number(planetID);
  if (operationID) session._playerbotPIExportOperationID = String(operationID);
  try {
    const PlanetMgrService = require("../planet/planetMgrService");
    return await new PlanetMgrService().Handle_UserLaunchCommodities(
      [Number(commandPinID), commodities],
      session,
    );
  } finally {
    if (hadPreviousPlanet) session._planetMgrLastPlanetID = previousPlanetID;
    else delete session._planetMgrLastPlanetID;
    if (hadPreviousOperationID) session._playerbotPIExportOperationID = previousOperationID;
    else delete session._playerbotPIExportOperationID;
  }
}

async function executeAutoExportTask(task, provider) {
  const payload = task && task.payload && typeof task.payload === "object" ? task.payload : {};
  const characterID = normalizeID(task && (task.resourceOwnerCharacterID || task.targetCharacterID));
  const planetID = normalizeID(payload.planetID);
  if (!characterID || characterID !== Number(provider && provider.characterID) || !planetID) {
    throw new Error("PLAYERBOT_PI_EXPORT_TASK_OWNER_MISMATCH");
  }
  const taskRuntime = require("./playerBotTaskRuntime");
  const operationRuntime = require("./playerBotOperationRuntime");
  const progress = task && task.progress && typeof task.progress === "object" ? task.progress : {};
  if (progress.phase === "settled" && progress.result && typeof progress.result === "object") {
    const prior = progress.result;
    if (Number(prior.launchID) > 0 && operationRuntime.nextPlanetaryLaunch(provider)) {
      const recovery = operationRuntime.startPlanetaryCollection(provider.characterName);
      return {
        ...prior,
        launchedUnits: 0,
        recoveredLaunchQueued: recovery.success === true,
        collectionOperationID: recovery.operation && recovery.operation.operationID || null,
      };
    }
    return prior;
  }
  const policy = getPolicyForCharacter(characterID, planetID);
  const policyStillCurrent = policy && policy.enabled === true &&
    Number(policy.version) === Number(payload.policyVersion);

  if (progress.phase === "launching") {
    const currentState = currentCommandCenterContents(characterID, planetID);
    const current = currentState.contents;
    const currentBalance = Number(getCharacterWallet(characterID)?.balance) || 0;
    if (
      currentState.commandPin &&
      quantitiesWereRemoved(progress.baselineContents || {}, current, progress.commodities || {})
    ) {
      const launch = latestLaunch(characterID, planetID);
      const recovery = operationRuntime.startPlanetaryCollection(provider.characterName);
      if (!recovery.success) {
        const result = {
          launchedUnits: 0,
          scheduledUnits: countUnits(progress.commodities),
          commodities: progress.commodities,
          taxSpent: Math.max(0, Number(progress.baselineBalance) - currentBalance),
          recoveredPriorLaunch: true,
          launchID: Number(launch && launch.launchID) || null,
          recoveredLaunchQueued: false,
          outcomeUnknown: true,
          requiresReview: true,
          message: "PI stock and export tax changed, but no collectible launch container could be queued; the export policy was paused for review.",
        };
        const settled = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "settled", result });
        if (!settled.success) throw new Error("PLAYERBOT_PI_EXPORT_TASK_PROGRESS_STALE");
        disablePolicyForCharacter(characterID, planetID, payload.policyVersion, "uncertain-outcome-review");
        return result;
      }
      const result = {
        launchedUnits: 0,
        scheduledUnits: countUnits(progress.commodities),
        commodities: progress.commodities,
        taxSpent: Math.max(0, Number(progress.baselineBalance) - currentBalance),
        recoveredPriorLaunch: true,
        launchID: Number(launch && launch.launchID) || null,
        recoveredLaunchQueued: true,
        collectionOperationID: recovery.operation && recovery.operation.operationID || null,
      };
      const settled = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "settled", result });
      if (!settled.success) throw new Error("PLAYERBOT_PI_EXPORT_TASK_PROGRESS_STALE");
      return result;
    }
    if (
      currentState.commandPin &&
      quantitiesUnchanged(progress.baselineContents || {}, current, progress.commodities || {}) &&
      Math.abs(Number(progress.baselineBalance) - currentBalance) < 0.01
    ) {
      const ready = taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "ready" });
      if (!ready.success) throw new Error("PLAYERBOT_PI_EXPORT_TASK_PROGRESS_STALE");
    } else {
      const result = {
        launchedUnits: 0,
        taxSpent: Math.max(0, Number(progress.baselineBalance) - currentBalance),
        outcomeUnknown: true,
        requiresReview: true,
        message: "Could not reconcile PI stock and wallet after recovering the launch; the export was not repeated.",
      };
      taskRuntime.updateTaskProgress(task.taskID, task.leaseToken, { phase: "settled", result });
      disablePolicyForCharacter(characterID, planetID, payload.policyVersion, "uncertain-outcome-review");
      return result;
    }
  }

  if (!policyStillCurrent) {
    return { skipped: true, reason: "policy-disabled-or-replaced", launchedUnits: 0, taxSpent: 0 };
  }

  const unitValues = await readExportUnitValues(provider, planetID);
  const freeCargo = require("./playerBotInventoryRuntime").getCargoBayFree(provider);
  const plan = buildExportPlan(characterID, planetID, policy.maxUnitsPerCycle, unitValues, freeCargo);
  if (!plan.success || plan.units <= 0) {
    return { skipped: true, reason: plan.reason || "no-stock", launchedUnits: 0, taxSpent: 0 };
  }
  const balance = Number(getCharacterWallet(characterID)?.balance) || 0;
  if (plan.tax > Number(policy.maxTaxPerCycle) + 0.0001 || balance + 0.0001 < plan.tax) {
    return { skipped: true, reason: "tax-budget-or-wallet-limit", launchedUnits: 0, taxSpent: 0 };
  }

  const operation = operationRuntime.startPlanetaryCollection(provider.characterName, {
    exportRequest: {
      policyVersion: Math.max(1, Math.trunc(Number(payload.policyVersion) || 1)),
      planetID,
      commandPinID: Number(plan.commandPin.pinID),
      maxUnitsPerCycle: Number(policy.maxUnitsPerCycle),
      maxTaxPerCycle: Number(policy.maxTaxPerCycle),
      commodities: plan.commodities,
    },
  });
  if (!operation.success) {
    return { skipped: true, reason: operation.message, launchedUnits: 0, taxSpent: 0 };
  }
  return {
    launchedUnits: 0,
    scheduledUnits: plan.units,
    commodities: plan.commodities,
    taxSpent: 0,
    collectionOperationQueued: true,
    collectionOperationID: operation.operation.operationID,
    solarSystemID: Number(plan.colony.solarSystemID) || 0,
  };
}

module.exports = {
  MAX_TAX_PER_CYCLE_ISK,
  MAX_UNITS_PER_CYCLE,
  TASK_KIND,
  buildExportPlan,
  currentCommandCenterContents,
  disableAutoExportPolicy,
  executeAutoExportTask,
  getAutoExportPolicy,
  invokeNormalPlanetLaunch,
  latestLaunch,
  listActiveAutoExportPolicies,
  reconcileAutoExportPolicies,
  scheduleAutoExportTasks,
  setAutoExportPolicy,
  _testing: { addMissingPolicies, selectCommodities },
};

"use strict";

const { createTableRepository } = require("../../gameStore/tableRepository");
const { getDockedLocationID, isDockedSession } = require("../structure/structureLocation");
const { getBlueprintDefinitionByTypeID } = require("../industry/industryStaticData");
const {
  INDUSTRY_ACTIVITY,
  INDUSTRY_STATUS,
  ITEM_FLAG_HANGAR,
} = require("../industry/industryConstants");

const TABLE = "playerBots";
const POLICY_PATH = "/_industryManufacturingPolicies";
const MANUFACTURE_TASK_KIND = "playerbot.industry.manufacture";
const DELIVER_TASK_KIND = "playerbot.industry.deliver";
const MAX_POLICY_RUNS = 100;
const MAX_POLICY_ISK = 1_000_000_000;
const repo = createTableRepository("service:playerbots", { strict: true });

function readPolicyMap() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, POLICY_PATH);
  return result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function savePolicyMap(policies) {
  const result = repo.write(TABLE, POLICY_PATH, policies);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_INDUSTRY_POLICY_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_INDUSTRY_POLICY_FLUSH_FAILED");
  }
  return policies;
}

function getPlayerBots() {
  return require("./playerBotRuntime");
}

function getIndustry() {
  return require("../industry/industryRuntimeState");
}

function getTaskRuntime() {
  return require("./playerBotTaskRuntime");
}

function getActorSession(bot) {
  return require("./playerBotSpaceRuntime").getActorSession(bot);
}

function normalizePositiveInteger(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeIsk(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0.01 || numeric > MAX_POLICY_ISK) return 0;
  return Math.round(numeric * 100) / 100;
}

function getPolicyForBot(bot) {
  const characterID = normalizePositiveInteger(bot && bot.characterID);
  return characterID ? readPolicyMap()[String(characterID)] || null : null;
}

function listActiveAutoManufacturingPolicies() {
  return Object.values(readPolicyMap()).filter((policy) => policy && policy.enabled === true);
}

function errorName(error) {
  const code = Math.trunc(Number(error && error.code));
  if (!code) return "quote error";
  const constants = require("../industry/industryConstants");
  return constants.INDUSTRY_ERROR_NAME[code] || `error ${code}`;
}

function describeQuoteFailure(result) {
  const errors = Array.isArray(result && result.errors) ? result.errors : [];
  const descriptions = [...new Set(errors.map(errorName))];
  return descriptions.length
    ? `The industry authority rejected the quote: ${descriptions.join(", ")}.`
    : "The industry authority rejected the quote.";
}

function getManufacturingContext(bot, blueprintItemID, runs, options = {}) {
  const characterID = normalizePositiveInteger(bot && bot.characterID);
  if (!characterID) return { success: false, message: "The bot does not have a valid character." };
  if (!bot || bot.specialty !== "industry") {
    return { success: false, message: "Industry automation can only be enabled for an industry specialist." };
  }

  const session = getActorSession(bot);
  if (!isDockedSession(session)) {
    return { success: false, message: `${bot.characterName} must be docked to manufacture.` };
  }
  const facilityID = normalizePositiveInteger(getDockedLocationID(session));
  const blueprintID = normalizePositiveInteger(blueprintItemID);
  if (!facilityID || !blueprintID) {
    return { success: false, message: "A valid blueprint item ID and current facility are required." };
  }

  const industry = getIndustry();
  const blueprint = industry.getBlueprintByItemID(blueprintID, session);
  const corporationID = Number(session.corporationID || session.corpid || bot.corporationID) || 0;
  const corporateAssets = options.assetOwner === "corporation";
  const ownerID = corporateAssets ? corporationID : characterID;
  const hangarDivision = corporateAssets ? Math.trunc(Number(options.hangarDivision)) : 0;
  const walletDivision = corporateAssets ? Math.trunc(Number(options.walletDivision)) : 0;
  if (corporateAssets && (!corporationID || hangarDivision < 1 || hangarDivision > 7 || walletDivision < 1 || walletDivision > 7)) {
    return { success: false, message: "Corporation manufacturing needs a valid member corporation, hangar division 1–7, and wallet division 1–7." };
  }
  if (!blueprint || Number(blueprint.ownerID) !== ownerID) {
    return { success: false, message: `${bot.characterName} cannot use blueprint ${blueprintID} from the selected ${corporateAssets ? "corporation division" : "personal hangar"}.` };
  }
  if (Number(blueprint.facilityID) !== facilityID) {
    return { success: false, message: `Blueprint ${blueprintID} must be in the hangar at the current facility ${facilityID}.` };
  }
  if (blueprint.jobID) {
    return { success: false, message: `Blueprint ${blueprintID} is already in use by job ${blueprint.jobID}.` };
  }
  const definition = getBlueprintDefinitionByTypeID(blueprint.typeID);
  if (!definition || !Number(definition.productTypeID)) {
    return { success: false, message: `No valid manufacturing definition exists for blueprint ${blueprintID}.` };
  }

  const hangarFlag = corporateAssets
    ? require("../industry/industryConstants").ITEM_FLAG_CORP_HANGAR_1 + hangarDivision - 1
    : ITEM_FLAG_HANGAR;
  const locations = industry.resolveFacilityLocations(facilityID, ownerID, blueprint, session);
  const inputLocation = locations.find((location) =>
    Number(location && location.flagID) === hangarFlag &&
    Number(location && location.ownerID) === ownerID &&
    (!corporateAssets || location.canTake === true),
  );
  const outputLocation = inputLocation;
  if (!inputLocation || !outputLocation) {
    return { success: false, message: corporateAssets
      ? `The bot cannot take from corporation hangar division ${hangarDivision} at ${facilityID}; check persisted corporation roles and Factory Manager access.`
      : `Could not find ${bot.characterName}’s personal hangars at ${facilityID}.` };
  }

  const request = {
    blueprintID: blueprint.itemID,
    blueprintTypeID: blueprint.typeID,
    activityID: INDUSTRY_ACTIVITY.MANUFACTURING,
    facilityID,
    solarSystemID: Number(session.solarsystemid2 || session.solarsystemid) || 0,
    characterID,
    corporationID: corporateAssets ? corporationID : (Number(session.corporationID || session.corpid) || 0),
    account: [ownerID, corporateAssets ? 999 + walletDivision : 1000],
    runs: Math.trunc(Number(runs)),
    cost: 0,
    tax: 0,
    time: 0,
    materials: {},
    inputLocation,
    outputLocation,
    licensedRuns: 1,
    productTypeID: Number(definition.productTypeID),
  };
  const quoteResult = industry.quoteManufacturingJob(session, request);
  if (!quoteResult || quoteResult.success !== true) {
    return { success: false, message: describeQuoteFailure(quoteResult), quoteResult, blueprint, definition, facilityID, session, request };
  }
  return {
    success: true,
    bot,
    session,
    blueprint,
    definition,
    assetOwner: corporateAssets ? "corporation" : "personal",
    ownerID,
    hangarDivision,
    walletDivision,
    hangarFlag,
    facilityID,
    request,
    quote: quoteResult.quote,
  };
}

function setAutoManufacturingPolicy(botQuery, blueprintItemID, runs, maxISKPerJob, requestedByCharacterID = null) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const normalizedRuns = Math.trunc(Number(runs));
  if (!Number.isSafeInteger(normalizedRuns) || normalizedRuns < 1 || normalizedRuns > MAX_POLICY_RUNS) {
    return { success: false, message: `Automatic batches are limited to 1–${MAX_POLICY_RUNS} runs per job.` };
  }
  const maxCost = normalizeIsk(maxISKPerJob);
  if (!maxCost) {
    return { success: false, message: `The limit must be between 0.01 and ${MAX_POLICY_ISK.toLocaleString("en-US")} ISK per job.` };
  }
  const context = getManufacturingContext(bot, blueprintItemID, normalizedRuns);
  if (!context.success) return context;
  if (context.quote.totalCost > maxCost) {
    return {
      success: false,
      message: `The quote is ${Number(context.quote.totalCost).toFixed(2)} ISK, above the ${maxCost.toFixed(2)} ISK limit. The policy was not enabled.`,
    };
  }

  const policies = readPolicyMap();
  const characterID = Number(bot.characterID);
  const previous = policies[String(characterID)] || {};
  const policy = {
    characterID,
    enabled: true,
    version: Math.max(0, Math.trunc(Number(previous.version) || 0)) + 1,
    blueprintItemID: Number(context.blueprint.itemID),
    blueprintTypeID: Number(context.blueprint.typeID),
    productTypeID: Number(context.definition.productTypeID),
    facilityID: Number(context.facilityID),
    runs: normalizedRuns,
    maxISKPerJob: maxCost,
    requestedByCharacterID: normalizePositiveInteger(requestedByCharacterID) || null,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastQuotedCost: Number(context.quote.totalCost) || 0,
  };
  policies[String(characterID)] = policy;
  savePolicyMap(policies);
  return {
    success: true,
    policy,
    message: `Industry automation enabled for ${bot.characterName}: blueprint ${policy.blueprintItemID}, ${normalizedRuns} run(s) per job, ${maxCost.toFixed(2)} ISK maximum. Initial quote: ${Number(context.quote.totalCost).toFixed(2)} ISK. It uses only the bot’s personal hangar and wallet; it does not buy or create materials.`,
  };
}

function disableAutoManufacturingPolicy(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const policies = readPolicyMap();
  const characterID = Number(bot.characterID);
  const policy = policies[String(characterID)];
  if (!policy || policy.enabled !== true) {
    return { success: true, policy: policy || null, message: `${bot.characterName} has no active automatic manufacturing policy.` };
  }
  policy.enabled = false;
  policy.updatedAt = new Date().toISOString();
  policies[String(characterID)] = policy;
  savePolicyMap(policies);

  const queued = getTaskRuntime().listTasks({ status: "queued", limit: 100 });
  for (const task of queued) {
    if (
      [MANUFACTURE_TASK_KIND, DELIVER_TASK_KIND].includes(task.kind) &&
      Number(task.resourceOwnerCharacterID) === characterID &&
      Number(task.payload && task.payload.policyVersion) === Number(policy.version)
    ) getTaskRuntime().cancelTask(task.taskID);
  }
  return { success: true, policy, message: `Automatic manufacturing disabled for ${bot.characterName}. Installed jobs will continue.` };
}

function getAutoManufacturingPolicy(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const policy = getPolicyForBot(bot);
  if (!policy || policy.enabled !== true) {
    return { success: true, policy: policy || null, message: `${bot.characterName} has no active automatic manufacturing policy.` };
  }
  const definition = getBlueprintDefinitionByTypeID(policy.blueprintTypeID);
  return {
    success: true,
    policy,
    message: `${bot.characterName}: blueprint ${policy.blueprintItemID} (${definition && definition.blueprintName || policy.blueprintTypeID}), facility ${policy.facilityID}, ${policy.runs} run(s) per job, ${Number(policy.maxISKPerJob).toFixed(2)} ISK cap. Each cycle gets a new quote and requires materials and wallet balance to remain available.`,
  };
}

function listBotBlueprints(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  if (bot.specialty !== "industry") return { success: false, message: `${bot.characterName} is not an industry specialist.` };
  const session = getActorSession(bot);
  const result = getIndustry().listBlueprintInstancesByOwner(bot.characterID, null, session);
  const rows = (result.blueprints || []).slice(0, 30).map((blueprint) => {
    const definition = getBlueprintDefinitionByTypeID(blueprint.typeID);
    const name = definition && definition.blueprintName || `type ${blueprint.typeID}`;
    const mode = blueprint.original ? "original" : `copy (${blueprint.runs} runs)`;
    const status = blueprint.jobID ? `in use by job ${blueprint.jobID}` : `facility ${blueprint.facilityID || "unknown"}`;
    return `itemID ${blueprint.itemID}: ${name}, ${mode}, ${status}`;
  });
  const facilityID = isDockedSession(session) ? getDockedLocationID(session) : 0;
  return {
    success: true,
    blueprints: result.blueprints || [],
    message: rows.length
      ? `${bot.characterName}: showing ${rows.length} blueprint(s); current location ${facilityID || "in space"}.\n${rows.join("\n")}${(result.blueprints || []).length > rows.length ? "\n…" : ""}`
      : `${bot.characterName} has no visible personal blueprints. Automation does not create or use corporation blueprints.`,
  };
}

function listBotIndustryJobs(botQuery) {
  const bot = getPlayerBots().resolveBot(botQuery);
  if (!bot) return { success: false, message: `No unique playerbot found with that name: ${botQuery}.` };
  const jobs = getIndustry().listJobsByOwner(bot.characterID, true).slice(-15).reverse();
  const labels = {
    [INDUSTRY_STATUS.INSTALLED]: "in production",
    [INDUSTRY_STATUS.PAUSED]: "paused",
    [INDUSTRY_STATUS.READY]: "ready to deliver",
    [INDUSTRY_STATUS.COMPLETED]: "completed",
    [INDUSTRY_STATUS.DELIVERED]: "delivered",
    [INDUSTRY_STATUS.CANCELLED]: "canceled",
    [INDUSTRY_STATUS.REVERTED]: "rolled back",
  };
  const rows = jobs.map((job) => {
    const definition = getBlueprintDefinitionByTypeID(job.blueprintTypeID);
    const name = definition && definition.productName || `product ${job.productTypeID}`;
    return `job ${job.jobID}: ${name} ×${job.runs}, ${labels[job.status] || `status ${job.status}`}, blueprint ${job.blueprintID}, facility ${job.facilityID}`;
  });
  return {
    success: true,
    jobs,
    message: rows.length ? `${bot.characterName}:\n${rows.join("\n")}` : `${bot.characterName} has no recorded industry jobs.`,
  };
}

function hasPendingTask(kind, botID, dedupeKey) {
  return getTaskRuntime().listTasks({ limit: 100 }).some((task) =>
    task && task.kind === kind &&
    ["queued", "leased"].includes(task.status) &&
    Number(task.resourceOwnerCharacterID) === Number(botID) &&
    (!dedupeKey || task.dedupeKey === dedupeKey),
  );
}

function enqueueForPolicy(kind, bot, policy, cycleID, payload) {
  const stableKey = kind === MANUFACTURE_TASK_KIND
    ? `${kind}:${bot.characterID}:${policy.version}`
    : `${kind}:${bot.characterID}:${payload.jobID}`;
  if (hasPendingTask(kind, bot.characterID, stableKey)) return { created: false };
  const result = getTaskRuntime().enqueueTask({
    kind,
    capability: "industry",
    resourceOwnerCharacterID: Number(bot.characterID),
    requestedBy: "system",
    dedupeKey: stableKey,
    payload: {
      ...payload,
      policyVersion: Number(policy.version),
      cycleID: String(cycleID || Date.now()),
    },
  });
  return result;
}

function scheduleAutoManufacturingTasks(bots = [], cycleID = Date.now()) {
  const policies = listActiveAutoManufacturingPolicies();
  const byID = new Map((Array.isArray(bots) ? bots : []).map((bot) => [Number(bot.characterID), bot]));
  const summary = {
    activePolicies: policies.length,
    manufactureTasksQueued: 0,
    deliveryTasksQueued: 0,
    waitingJobs: 0,
    quoteFailures: 0,
    overBudget: 0,
    skippedBots: 0,
  };
  for (const policy of policies) {
    const characterID = normalizePositiveInteger(policy && policy.characterID);
    const bot = byID.get(characterID);
    if (!bot || bot.specialty !== "industry" || bot.status === "paused" || bot.autonomyPaused === true) {
      summary.skippedBots += 1;
      continue;
    }

    const activeJob = getIndustry().listJobsByOwner(characterID, false).find((job) =>
      Number(job.blueprintID) === Number(policy.blueprintItemID) &&
      Number(job.facilityID) === Number(policy.facilityID),
    );
    if (activeJob) {
      if (Number(activeJob.status) === INDUSTRY_STATUS.READY) {
        const queued = enqueueForPolicy(DELIVER_TASK_KIND, bot, policy, cycleID, { jobID: Number(activeJob.jobID) });
        if (queued.created) summary.deliveryTasksQueued += 1;
      } else {
        summary.waitingJobs += 1;
      }
      continue;
    }

    const context = getManufacturingContext(bot, policy.blueprintItemID, policy.runs);
    if (!context.success) {
      summary.quoteFailures += 1;
      continue;
    }
    if (Number(context.facilityID) !== Number(policy.facilityID)) {
      summary.quoteFailures += 1;
      continue;
    }
    if (Number(context.quote.totalCost) > Number(policy.maxISKPerJob)) {
      summary.overBudget += 1;
      continue;
    }
    const queued = enqueueForPolicy(MANUFACTURE_TASK_KIND, bot, policy, cycleID, {
      blueprintItemID: Number(policy.blueprintItemID),
      facilityID: Number(policy.facilityID),
      runs: Number(policy.runs),
      maxISKPerJob: Number(policy.maxISKPerJob),
      request: context.request,
      quotedTotalCost: Number(context.quote.totalCost),
    });
    if (queued.created) summary.manufactureTasksQueued += 1;
  }
  return summary;
}

function matchingActiveJob(bot, blueprintItemID, facilityID) {
  return getIndustry().listJobsByOwner(bot.characterID, false).find((job) =>
    Number(job.blueprintID) === Number(blueprintItemID) &&
    Number(job.facilityID) === Number(facilityID),
  ) || null;
}

function policyMatchesTask(task, provider) {
  const policy = getPolicyForBot(provider);
  return policy && policy.enabled === true &&
    Number(policy.version) === Number(task.payload && task.payload.policyVersion)
    ? policy
    : null;
}

async function executeManufacturingTask(task, provider) {
  if (Number(task.resourceOwnerCharacterID) !== Number(provider.characterID)) {
    throw new Error("PLAYERBOT_INDUSTRY_OWNER_MISMATCH");
  }
  const policy = policyMatchesTask(task, provider);
  if (!policy) return { skipped: true, reason: "policy-disabled-or-updated" };
  const payload = task.payload || {};
  const job = matchingActiveJob(provider, payload.blueprintItemID, payload.facilityID);
  if (job) return { recovered: true, jobID: Number(job.jobID), status: Number(job.status) };

  const context = getManufacturingContext(provider, payload.blueprintItemID, payload.runs);
  if (!context.success) throw new Error(context.message || "PLAYERBOT_INDUSTRY_QUOTE_FAILED");
  if (
    Number(context.facilityID) !== Number(policy.facilityID) ||
    Number(payload.facilityID) !== Number(policy.facilityID) ||
    Number(context.quote.totalCost) > Number(policy.maxISKPerJob) ||
    Number(context.quote.totalCost) > Number(payload.maxISKPerJob)
  ) throw new Error("PLAYERBOT_INDUSTRY_POLICY_LIMIT_OR_LOCATION_CHANGED");

  const progress = getTaskRuntime().updateTaskProgress(task.taskID, task.leaseToken, {
    phase: "installing",
    blueprintItemID: Number(payload.blueprintItemID),
    facilityID: Number(payload.facilityID),
    runs: Number(payload.runs),
    quotedTotalCost: Number(context.quote.totalCost),
  });
  if (!progress.success) throw new Error("PLAYERBOT_INDUSTRY_TASK_LEASE_LOST");
  const installed = await getIndustry().installManufacturingJob(context.session, context.request);
  const jobID = Number(installed && installed.data && installed.data.jobID);
  const created = jobID > 0 ? getIndustry().getJobByID(jobID) : null;
  if (!created || Number(created.ownerID) !== Number(provider.characterID)) {
    const recovered = matchingActiveJob(provider, payload.blueprintItemID, payload.facilityID);
    if (recovered) return { recovered: true, jobID: Number(recovered.jobID), status: Number(recovered.status) };
    throw new Error("PLAYERBOT_INDUSTRY_INSTALL_RESULT_MISSING");
  }
  return {
    jobID,
    blueprintItemID: Number(payload.blueprintItemID),
    facilityID: Number(payload.facilityID),
    runs: Number(created.runs),
    totalCost: Number(created.totalCost ?? context.quote.totalCost),
    endDate: String(created.endDate || ""),
  };
}

function executeDeliveryTask(task, provider) {
  if (Number(task.resourceOwnerCharacterID) !== Number(provider.characterID)) {
    throw new Error("PLAYERBOT_INDUSTRY_OWNER_MISMATCH");
  }
  const policy = policyMatchesTask(task, provider);
  if (!policy) return { skipped: true, reason: "policy-disabled-or-updated" };
  const jobID = normalizePositiveInteger(task.payload && task.payload.jobID);
  const job = getIndustry().getJobByID(jobID);
  if (!job || Number(job.ownerID) !== Number(provider.characterID)) {
    return { skipped: true, reason: "job-not-owned-or-already-removed", jobID };
  }
  if (Number(job.blueprintID) !== Number(policy.blueprintItemID) || Number(job.facilityID) !== Number(policy.facilityID)) {
    return { skipped: true, reason: "job-no-longer-matches-policy", jobID };
  }
  if (Number(job.status) >= INDUSTRY_STATUS.COMPLETED) {
    return { recovered: true, jobID, status: Number(job.status) };
  }
  if (Number(job.status) !== INDUSTRY_STATUS.READY) {
    throw new Error("PLAYERBOT_INDUSTRY_JOB_NOT_READY");
  }
  const delivered = getIndustry().deliverIndustryJob(getActorSession(provider), jobID);
  if (!delivered || delivered.success !== true || !delivered.data) {
    throw new Error("PLAYERBOT_INDUSTRY_DELIVERY_FAILED");
  }
  return {
    jobID,
    status: Number(delivered.data.status),
    blueprintItemID: Number(job.blueprintID),
    facilityID: Number(job.facilityID),
    runs: Number(job.runs),
    productTypeID: Number(job.productTypeID),
  };
}

module.exports = {
  DELIVER_TASK_KIND,
  MANUFACTURE_TASK_KIND,
  MAX_POLICY_ISK,
  MAX_POLICY_RUNS,
  disableAutoManufacturingPolicy,
  executeDeliveryTask,
  executeManufacturingTask,
  getAutoManufacturingPolicy,
  getManufacturingContext,
  getPolicyForBot,
  listActiveAutoManufacturingPolicies,
  listBotBlueprints,
  listBotIndustryJobs,
  normalizeIsk,
  scheduleAutoManufacturingTasks,
  setAutoManufacturingPolicy,
};

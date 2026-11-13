"use strict";

/*
 * /bots corp commands for playerbot corporations (also /playerbots corp ...).
 *
 *   /bots corp recall [corporationID] [station|structure <id>]
 *   /bots corp work   [corporationID] [auto|mine|pi|director] [trips <n>] [station|structure <id>]
 *   /bots corp status [corporationID]
 *   /bots corp hq     [corporationID] [list | set <structureOrStationID> | clear]
 *   /bots corp help
 *
 * This file is an add-on. It does not edit any EveJS or Playerbots file: it is
 * loaded by corpCommandsPreload.js and only calls exported runtime functions
 * the /playerbots chat commands already use.
 *
 * Destination ("HQ") resolution, first match wins:
 *   1. station|structure <id> on the command (this order only);
 *   2. the HQ saved with /bots corp hq set (an NPC station or a structure owned by
 *      the corporation with an online docking service);
 *   3. the corporation record's headquarters (always an NPC station).
 *
 * recall to an NPC station: running work is stopped, then the existing durable
 *   "relocate" operation undocks, routes, warps and docks the pilot. The pilot
 *   is paused once docked, so the director does not send it away again.
 * recall to a structure: the relocate operation only accepts NPC stations, so
 *   the pilot's work is stopped and the pilot is paused immediately, then this
 *   file steps it there itself with the same exported helpers the route and
 *   relocation code use (advanceSystemRoute between systems, travelToStation
 *   inside the destination system). Paused pilots skip their own threat
 *   responses, so structure recalls are best used in safe space.
 * work: clears the pause and starts mining (from the HQ when its system has
 *   safe belts, otherwise from the nearest safe belt system) and/or PI colony
 *   setup. Everything else is left to the normal director.
 *
 * Orders live in memory. After a server restart, relocations to NPC stations
 * continue (durable operations) but holds and structure trips are not
 * re-applied: run /bots corp recall again, it is idempotent. Saved HQs persist in
 * hq.json under CORP_COMMANDS_DATA_DIR (default /var/lib/evejs/corp-commands
 * when that directory exists, otherwise ./data beside this file).
 */

const fs = require("fs");
const path = require("path");

// Works from addons/corp-commands/ (server/src is a sibling tree) and from
// server/src/services/playerbots/ (the server tree itself).
const ADDON_RELATIVE_SRC = path.resolve(__dirname, "..", "..", "server", "src");
const SERVER_SRC = process.env.EVEJS_SERVER_SRC ||
  (fs.existsSync(ADDON_RELATIVE_SRC) ? ADDON_RELATIVE_SRC : path.resolve(__dirname, "..", ".."));

const TICK_MS = 2000;
const BATCH_PER_TICK = 25;
const MAX_RETRIES = 8;
const ORDER_TTL_MS = 6 * 60 * 60 * 1000;
const STEP_DELAY_MS = 3000;
const RUNNING_STATUSES = new Set(["active", "holding", "review"]);
const MINING_MIN_SECURITY = 0.45;
const MODES = new Set(["auto", "mine", "pi", "director"]);
const COMBAT_SPECIALTIES = new Set(["security", "piracy", "sovereignty"]);
const LIST_LIMIT = 15;

function load(relativePath) {
  return require(path.join(SERVER_SRC, relativePath));
}

function dataDirectory() {
  if (process.env.CORP_COMMANDS_DATA_DIR) return process.env.CORP_COMMANDS_DATA_DIR;
  if (process.env.EVEJS_DATA_ROOT) return path.join(process.env.EVEJS_DATA_ROOT, "corp-commands");
  return fs.existsSync("/var/lib/evejs")
    ? "/var/lib/evejs/corp-commands"
    : path.join(__dirname, "data");
}

function defaultHqStore() {
  const file = () => path.join(dataDirectory(), "hq.json");
  return {
    read() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (error) {
        return {};
      }
    },
    write(value) {
      fs.mkdirSync(dataDirectory(), { recursive: true });
      const temporary = `${file()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
      fs.renameSync(temporary, file());
    },
  };
}

function defaultDeps() {
  return {
    playerBots: () => load("services/playerbots/playerBotRuntime"),
    operations: () => load("services/playerbots/playerBotOperationRuntime"),
    tasks: () => load("services/playerbots/playerBotTaskRuntime"),
    space: () => load("services/playerbots/playerBotSpaceRuntime"),
    industryCycles: () => load("services/playerbots/playerBotIndustryCycleRuntime"),
    characters: () => load("services/character/characterState"),
    corporations: () => load("services/corporation/corporationState"),
    structures: () => load("services/structure/structureState"),
    worldData: () => load("space/worldData"),
    replies: () => load("services/chat/commands/commandReplies"),
    hasStaffRole: (session) => load("services/chat/commands/commandAccess").hasStaffDebugRole(session),
    log: () => load("utils/logger"),
    hqStore: defaultHqStore,
    now: () => Date.now(),
  };
}

const state = {
  deps: defaultDeps(),
  orders: new Map(),
  jobs: new Map(),
  hq: null,
  timer: null,
};

function configure(overrides = {}) {
  state.deps = { ...defaultDeps(), ...overrides };
  state.hq = null;
}

function reset() {
  stopTimer();
  state.orders.clear();
  state.jobs.clear();
  state.hq = null;
  state.deps = defaultDeps();
}

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function warn(message) {
  try { state.deps.log().warn(`[CorpCommands] ${message}`); } catch (error) { /* logger unavailable */ }
}

function isPaused(bot) {
  return bot.status === "paused" || bot.autonomyPaused === true;
}

function hasOperation(operation) {
  return Boolean(operation && (
    RUNNING_STATUSES.has(operation.status) || operation.pending || operation.loadSheddingPaused === true
  ));
}

function botsOf(corporationID) {
  return state.deps.playerBots().listBots()
    .filter((bot) => positive(bot.corporationID) === corporationID);
}

function characterRecord(bot) {
  return state.deps.characters().getCharacterRecord(bot.characterID) || {};
}

function dockedStationOf(bot) {
  const record = characterRecord(bot);
  return positive(record.stationID || record.structureID);
}

// ------------------------------------------------------- HQ resolution

function savedHeadquarters() {
  if (!state.hq) state.hq = state.deps.hqStore().read() || {};
  return state.hq;
}

function validateStructure(structure, corporationID) {
  if (structure.destroyedAt || structure.unanchoring) return "is destroyed or unanchoring";
  if (positive(structure.ownerCorpID) !== corporationID) return `is not owned by corporation ${corporationID}`;
  if (!state.deps.structures().isDockingServiceOnline(structure)) return "has no online docking service";
  return "";
}

function describeDestination(destinationID, corporationID) {
  const worldData = state.deps.worldData();
  const station = worldData.getStationByID(destinationID);
  if (station) {
    return { kind: "station", stationID: destinationID, systemID: positive(station.solarSystemID), name: "" };
  }
  const structure = state.deps.structures().getStructureByID(destinationID, { refresh: false });
  if (!structure) {
    return { error: `${destinationID} is not an NPC station or a known structure.` };
  }
  const problem = validateStructure(structure, corporationID);
  if (problem) return { error: `Structure ${destinationID} ${problem}.` };
  return {
    kind: "structure",
    stationID: destinationID,
    systemID: positive(structure.solarSystemID),
    name: String(structure.itemName || structure.name || ""),
    hasQuantumCore: structure.hasQuantumCore === true,
  };
}

function resolveHeadquarters(corporationID, overrideID) {
  const explicit = positive(overrideID);
  if (explicit) return describeDestination(explicit, corporationID);
  const saved = positive(savedHeadquarters()[String(corporationID)]);
  if (saved) {
    const described = describeDestination(saved, corporationID);
    return described.error
      ? { error: `The saved HQ is unusable: ${described.error} Run "/bots corp hq ${corporationID} clear" or choose another with "/bots corp hq ${corporationID} set <id>".` }
      : { ...described, saved: true };
  }
  const record = state.deps.corporations().getCorporationRecord(corporationID);
  const stationID = positive(record && record.stationID);
  if (!stationID) {
    return { error: `Corporation ${corporationID} has no headquarters set. Set one in the corporation window, or use "/bots corp hq ${corporationID} set <structureOrStationID>".` };
  }
  return describeDestination(stationID, corporationID);
}

function formatDestination(destination) {
  return destination.kind === "structure"
    ? `structure ${destination.stationID}${destination.name ? ` "${destination.name}"` : ""}`
    : `station ${destination.stationID}`;
}

function canControlCorporation(session, corporationID) {
  if (state.deps.hasStaffRole(session)) return true;
  const own = positive(session && (session.corporationID || session.corpid));
  return own > 0 && own === corporationID;
}

function canManageHeadquarters(session, corporationID) {
  if (state.deps.hasStaffRole(session)) return true;
  const record = state.deps.corporations().getCorporationRecord(corporationID);
  const characterID = positive(session && (session.characterID || session.charID || session.charid));
  return characterID > 0 && characterID === positive(record && record.ceoID);
}

// ----------------------------------------------------------------- recall

function advanceRecallStation(bot, headquarters) {
  const operations = state.deps.operations();
  const tasks = state.deps.tasks();
  const operation = operations.getOperation(bot.characterID);
  const running = hasOperation(operation);
  const toHeadquarters = running && operation.kind === "relocate" &&
    positive(operation.destinationStationID) === headquarters.stationID;
  const paused = isPaused(bot);

  if (dockedStationOf(bot) === headquarters.stationID) {
    // The relocation finishes on its next step; a paused pilot cannot take it.
    if (toHeadquarters) {
      if (paused) tasks.resumeBot(bot);
      return { state: "enRoute" };
    }
    if (running) {
      operations.stopOperation(bot.characterName);
      return { state: "retry", message: "stopping current work" };
    }
    if (!paused) {
      const held = tasks.pauseBot(bot);
      if (!held.success) return { state: "retry", message: held.message || "pause failed" };
    }
    return { state: "held" };
  }

  if (toHeadquarters) {
    if (paused) tasks.resumeBot(bot);
    return { state: "enRoute" };
  }
  if (running) {
    const stopped = operations.stopOperation(bot.characterName);
    if (stopped && stopped.success === false) return { state: "retry", message: stopped.message };
  }
  if (paused) tasks.resumeBot(bot);
  const started = operations.startRelocation(bot.characterName, headquarters.stationID);
  return started.success
    ? { state: "enRoute" }
    : { state: "retry", message: started.message };
}

const TRAVEL_STORE = Object.freeze({
  save() {},
  block(operation, status, reason) {
    return { blocked: true, message: String(reason) };
  },
});

function checkStructureAccess(bot, headquarters) {
  const structures = state.deps.structures();
  const structure = structures.getStructureByID(headquarters.stationID, { refresh: false });
  if (!structure) return "the structure no longer exists";
  const problem = validateStructure(structure, positive(bot.corporationID));
  if (problem) return `the structure ${problem}`;
  const session = state.deps.space().getActorSession(bot);
  const docking = structures.canCharacterDockAtStructure(session, structure, {
    shipTypeID: positive(session && session.shipTypeID) || undefined,
  });
  return docking && docking.success ? "" : `docking is refused (${docking && docking.errorMsg || "no permission"})`;
}

function advanceRecallStructure(bot, headquarters, entry) {
  const operations = state.deps.operations();
  const tasks = state.deps.tasks();
  const now = state.deps.now();

  if (hasOperation(operations.getOperation(bot.characterID))) {
    operations.stopOperation(bot.characterName);
    return { state: "retry", message: "stopping current work" };
  }
  const cycle = state.deps.industryCycles().getCycle(bot.characterID);
  if (cycle && (["active", "holding"].includes(cycle.status) || cycle.pending)) {
    return { state: "retry", message: `is in industry cycle ${cycle.cycleID}; stop it first` };
  }
  if (dockedStationOf(bot) === headquarters.stationID) {
    if (!isPaused(bot)) {
      const held = tasks.pauseBot(bot);
      if (!held.success) return { state: "retry", message: held.message || "pause failed" };
    }
    return { state: "held" };
  }
  if (!entry.accessChecked) {
    const refusal = checkStructureAccess(bot, headquarters);
    if (refusal) return { state: "failed", message: refusal };
    entry.accessChecked = true;
  }
  // Paused pilots are ignored by the director; the steps below do not need
  // route tasks, which are not run for paused pilots.
  if (!isPaused(bot)) {
    const held = tasks.pauseBot(bot);
    if (!held.success) return { state: "retry", message: held.message || "pause failed" };
  }
  if (entry.stepError) {
    const message = entry.stepError;
    entry.stepError = "";
    return { state: "retry", message };
  }
  if (entry.inFlight || Number(entry.nextAtMs) > now) return { state: "enRoute" };
  entry.nextAtMs = now + STEP_DELAY_MS;

  const systemID = positive(characterRecord(bot).solarSystemID);
  if (systemID !== headquarters.systemID) {
    const step = state.deps.space().advanceSystemRoute(bot, headquarters.systemID);
    if (!step || step.success !== true) {
      return { state: "retry", message: step && step.message || "route step failed" };
    }
    entry.nextAtMs = now + (Number(step.delayMs) > 0 ? Number(step.delayMs) : STEP_DELAY_MS);
    return { state: "enRoute" };
  }
  entry.inFlight = true;
  entry.travel = entry.travel || { kind: "corp-recall", stage: "travel", history: [] };
  Promise.resolve()
    .then(() => operations.travelToStation(entry.travel, bot, headquarters.stationID, TRAVEL_STORE))
    .then((step) => {
      if (step && step.blocked) entry.stepError = step.message;
      else if (step && Number(step.delayMs) > 0) entry.nextAtMs = state.deps.now() + Number(step.delayMs);
    })
    .catch((error) => { entry.stepError = error && error.message || String(error); })
    .then(() => { entry.inFlight = false; });
  return { state: "enRoute" };
}

function advanceRecall(bot, headquarters, entry = {}) {
  return headquarters.kind === "structure"
    ? advanceRecallStructure(bot, headquarters, entry)
    : advanceRecallStation(bot, headquarters);
}

function createRecallOrder(corporationID, headquarters, bots, context) {
  const pending = new Map();
  for (const bot of bots) pending.set(Number(bot.characterID), { attempts: 0, message: "" });
  const order = {
    corporationID,
    headquarters,
    createdAt: state.deps.now(),
    pending,
    total: bots.length,
    held: 0,
    failed: 0,
    gone: 0,
    failures: [],
    context,
  };
  state.orders.set(corporationID, order);
  return order;
}

function summarizeFailures(failures) {
  const counts = new Map();
  for (const entry of failures) {
    const reason = String(entry.message || "unknown").replace(/^.*? already has operation/, "already has operation").slice(0, 90);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].slice(0, 3).map(([reason, count]) => `${count} x ${reason}`).join("; ");
}

function notify(context, message) {
  try {
    state.deps.replies().emitChatFeedback(context.chatHub, context.session, context.options, message);
  } catch (error) {
    warn(`Could not deliver progress message: ${error.message}`);
  }
}

function finishOrder(order, reason) {
  state.orders.delete(order.corporationID);
  const detail = order.failed ? ` ${order.failed} could not be recalled (${summarizeFailures(order.failures)}).` : "";
  notify(order.context, reason === "expired"
    ? `Recall for corporation ${order.corporationID} timed out with ${order.pending.size} pilot(s) unfinished. Run /bots corp status ${order.corporationID}.`
    : `Recall complete for corporation ${order.corporationID}: ${order.held} of ${order.total} pilot(s) docked and held at ${formatDestination(order.headquarters)}.${detail}`);
}

function runRecallBatch(order, budget) {
  const roster = new Map(botsOf(order.corporationID).map((bot) => [Number(bot.characterID), bot]));
  const slice = [...order.pending.entries()].slice(0, budget);
  for (const [characterID, entry] of slice) {
    const bot = roster.get(characterID);
    if (!bot) {
      order.pending.delete(characterID);
      order.gone += 1;
      continue;
    }
    let result;
    try {
      result = advanceRecall(bot, order.headquarters, entry);
    } catch (error) {
      result = { state: "retry", message: error.message };
    }
    order.pending.delete(characterID);
    if (result.state === "held") {
      order.held += 1;
    } else if (result.state === "failed") {
      order.failed += 1;
      order.failures.push({ name: bot.characterName, message: result.message });
    } else if (result.state === "retry") {
      entry.attempts += 1;
      entry.message = result.message || "";
      if (entry.attempts >= MAX_RETRIES) {
        order.failed += 1;
        order.failures.push({ name: bot.characterName, message: entry.message });
      } else {
        order.pending.set(characterID, entry);
      }
    } else {
      entry.attempts = 0;
      order.pending.set(characterID, entry);
    }
  }
  return slice.length;
}

// ------------------------------------------------------------------- work

function hqSupportsMining(headquarters) {
  if (!headquarters || headquarters.error) return false;
  if (headquarters.kind === "structure" && headquarters.hasQuantumCore !== true) return false;
  const worldData = state.deps.worldData();
  const system = worldData.getSolarSystemByID(headquarters.systemID) || {};
  return Number(system.security) >= MINING_MIN_SECURITY &&
    (worldData.getAsteroidBeltsForSystem(headquarters.systemID) || []).length > 0;
}

function planFor(bot, mode) {
  if (mode !== "auto") return mode;
  const specialty = String(bot.specialty || "").toLowerCase();
  if (specialty === "planetary") return "pi";
  if (COMBAT_SPECIALTIES.has(specialty)) return "director";
  return "mine";
}

function startMiningFor(bot, job) {
  const operations = state.deps.operations();
  const base = { refine: true, sell: true };
  if (hqSupportsMining(job.headquarters)) {
    const homed = operations.startMining(bot.characterName, job.trips, {
      ...base, stationID: job.headquarters.stationID,
    });
    if (homed && homed.success) return homed;
  }
  // The HQ cannot be a mining home (no belts, low security, no quantum core or
  // no docking right): mine from the nearest safe belt system instead.
  return operations.startMining(bot.characterName, job.trips, base);
}

function startWorkForBot(bot, job) {
  const operations = state.deps.operations();
  if (hasOperation(operations.getOperation(bot.characterID))) return { status: "already" };
  const plan = planFor(bot, job.mode);
  if (plan === "director") return { status: "director" };
  const result = plan === "pi"
    ? operations.startColony(bot.characterName)
    : startMiningFor(bot, job);
  return result && result.success
    ? { status: "started", plan }
    : { status: "failed", message: result && result.message || "start refused" };
}

function runWorkBatch(job, budget) {
  const roster = new Map(botsOf(job.corporationID).map((bot) => [Number(bot.characterID), bot]));
  const slice = job.pending.splice(0, budget);
  for (const characterID of slice) {
    const bot = roster.get(characterID);
    if (!bot) continue;
    let result;
    try {
      result = startWorkForBot(bot, job);
    } catch (error) {
      result = { status: "failed", message: error.message };
    }
    if (result.status === "failed") {
      job.failures.push({ name: bot.characterName, message: result.message });
    } else {
      const key = result.status === "started" ? result.plan : result.status;
      job.counts[key] = (job.counts[key] || 0) + 1;
    }
  }
  return slice.length;
}

function finishJob(job) {
  state.jobs.delete(job.corporationID);
  const parts = [];
  if (job.counts.mine) parts.push(`${job.counts.mine} mining`);
  if (job.counts.pi) parts.push(`${job.counts.pi} PI setup`);
  if (job.counts.already) parts.push(`${job.counts.already} already working`);
  if (job.counts.director) parts.push(`${job.counts.director} left to the director`);
  if (job.failures.length) parts.push(`${job.failures.length} refused (${summarizeFailures(job.failures)})`);
  notify(job.context, `Work order for corporation ${job.corporationID} (${job.mode}): ${parts.join(", ") || "no pilots"}.`);
}

// ----------------------------------------------------------------- ticker

function tick() {
  try {
    const now = state.deps.now();
    let budget = BATCH_PER_TICK;
    for (const order of [...state.orders.values()]) {
      if (now - order.createdAt > ORDER_TTL_MS) {
        finishOrder(order, "expired");
        continue;
      }
      if (budget > 0) budget -= runRecallBatch(order, budget);
      if (!order.pending.size) finishOrder(order, "done");
    }
    for (const job of [...state.jobs.values()]) {
      if (budget > 0) budget -= runWorkBatch(job, budget);
      if (!job.pending.length) finishJob(job);
    }
  } catch (error) {
    warn(`Tick failed: ${error.stack || error.message}`);
  }
  if (!state.orders.size && !state.jobs.size) stopTimer();
}

function ensureTimer() {
  if (state.timer) return;
  state.timer = setInterval(tick, TICK_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ---------------------------------------------------------------- commands

const HELP = [
  "/bots corp recall [corporationID] [station|structure <id>] - send every pilot to the corporation HQ, dock and hold them there",
  "/bots corp work [corporationID] [auto|mine|pi|director] [trips <n>] - release the hold and start mining and PI around the HQ",
  "/bots corp status [corporationID] - show where the corporation's pilots are",
  "/bots corp hq [corporationID] [list | set <structureOrStationID> | clear] - show, list or change the HQ the commands above use (set/clear: CEO or staff)",
  "Omit the corporation ID to use your own corporation. Staff/admin may use any corporation.",
].join("\n");

function parseArguments(argumentText) {
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean)
    .map((token) => token.replace(/^[{<[(]+|[}>\])]+$/g, ""));
  const subcommand = (tokens.shift() || "help").toLowerCase();
  const parsed = {
    subcommand, corporationID: 0, station: 0, mode: "auto", trips: 1,
    hqAction: "", hqTarget: 0, error: "",
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    if (token === "station" || token === "structure") parsed.station = positive(tokens[index += 1]);
    else if (token === "trips") parsed.trips = Math.min(20, positive(tokens[index += 1]) || 1);
    else if (token === "set") { parsed.hqAction = "set"; parsed.hqTarget = positive(tokens[index += 1]); }
    else if (token === "clear" || token === "list") parsed.hqAction = token;
    else if (MODES.has(token)) parsed.mode = token;
    else if (/^\d+$/.test(token) && !parsed.corporationID) parsed.corporationID = positive(token);
    else parsed.error = `Unrecognized argument: ${tokens[index]}.`;
  }
  return parsed;
}

function commandRecall(parsed, corporationID, bots, context) {
  const headquarters = resolveHeadquarters(corporationID, parsed.station);
  if (headquarters.error) return headquarters.error;
  state.orders.delete(corporationID);
  state.jobs.delete(corporationID);
  createRecallOrder(corporationID, headquarters, bots, context);
  ensureTimer();
  const caution = headquarters.kind === "structure"
    ? " Pilots are paused for the trip and travel without their usual threat responses."
    : "";
  return `Recall ordered for ${bots.length} pilot(s) of corporation ${corporationID} to ${formatDestination(headquarters)} (system ${headquarters.systemID}). ` +
    `Pilots stop their current work, travel and dock, then are held.${caution} Progress: /bots corp status ${corporationID}. Release them with /bots corp work ${corporationID}.`;
}

function commandWork(parsed, corporationID, bots, context) {
  state.orders.delete(corporationID);
  const resumed = state.deps.tasks().resumeBotsInCorporation(corporationID);
  if (!resumed.success) {
    return `Could not release the corporation: ${(resumed.errors || []).join("; ") || resumed.message || "error"}.`;
  }
  const resolved = resolveHeadquarters(corporationID, parsed.station);
  const job = {
    corporationID,
    mode: parsed.mode,
    trips: parsed.trips,
    headquarters: resolved.error ? null : resolved,
    pending: bots.map((bot) => Number(bot.characterID)),
    counts: {},
    failures: [],
    context,
  };
  if (parsed.mode === "director") {
    return `Released ${resumed.affected} pilot(s); the director will assign work on its next pass.`;
  }
  state.jobs.set(corporationID, job);
  ensureTimer();
  return `Released ${resumed.affected} pilot(s) of corporation ${corporationID}. Starting ${parsed.mode} work` +
    `${job.headquarters ? ` around ${formatDestination(job.headquarters)}` : ""}; a summary follows.`;
}

function commandStatus(corporationID, bots) {
  const operations = state.deps.operations();
  const headquarters = resolveHeadquarters(corporationID, 0);
  const counts = { atHq: 0, held: 0, travelling: 0, working: 0, idle: 0 };
  const kinds = new Map();
  for (const bot of bots) {
    const operation = operations.getOperation(bot.characterID);
    const running = hasOperation(operation);
    const atHq = !headquarters.error && dockedStationOf(bot) === headquarters.stationID;
    if (atHq) counts.atHq += 1;
    if (isPaused(bot)) counts.held += 1;
    if (running && operation.kind === "relocate") counts.travelling += 1;
    else if (running) {
      counts.working += 1;
      kinds.set(operation.kind, (kinds.get(operation.kind) || 0) + 1);
    } else if (!isPaused(bot)) counts.idle += 1;
  }
  const order = state.orders.get(corporationID);
  if (order) {
    // Structure trips have no operation record: count pilots still pending.
    counts.travelling = Math.max(counts.travelling,
      [...order.pending.keys()].filter((id) => {
        const bot = bots.find((entry) => Number(entry.characterID) === id);
        return bot && dockedStationOf(bot) !== order.headquarters.stationID;
      }).length);
  }
  const work = [...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(", ");
  return [
    `Corporation ${corporationID}: ${bots.length} pilot(s); HQ ${headquarters.error ? "unavailable" : formatDestination(headquarters)}.`,
    `Docked at HQ ${counts.atHq}; held (paused) ${counts.held}; travelling ${counts.travelling}; working ${counts.working}${work ? ` (${work})` : ""}; idle ${counts.idle}.`,
    order ? `Recall in progress: ${order.pending.size} pilot(s) still pending, ${order.held} held, ${order.failed} failed.` : "No recall in progress.",
  ].join("\n");
}

function commandHeadquarters(parsed, session, corporationID) {
  const action = parsed.hqAction;
  if (action === "list") {
    const rows = state.deps.structures().listOwnedStructures(corporationID, { refresh: false })
      .filter((structure) => !structure.destroyedAt && !structure.unanchoring)
      .slice(0, LIST_LIMIT)
      .map((structure) => {
        const usable = !validateStructure(structure, corporationID);
        return `${structure.structureID || structure.itemID} - ${structure.itemName || structure.name || "unnamed"} - system ${structure.solarSystemID} - ${usable ? "docking online" : "docking unavailable"}`;
      });
    return rows.length
      ? `Structures owned by corporation ${corporationID}:\n${rows.join("\n")}\nChoose one with /bots corp hq ${corporationID} set <id>.`
      : `Corporation ${corporationID} owns no active structures.`;
  }
  if (action === "set" || action === "clear") {
    if (!canManageHeadquarters(session, corporationID)) {
      return "Only the corporation's CEO or staff/admin can change the HQ used by /bots corp.";
    }
    const store = state.deps.hqStore();
    const saved = { ...savedHeadquarters() };
    if (action === "clear") {
      delete saved[String(corporationID)];
    } else {
      if (!parsed.hqTarget) return "Usage: /bots corp hq [corporationID] set <structureOrStationID>.";
      const described = describeDestination(parsed.hqTarget, corporationID);
      if (described.error) return described.error;
      saved[String(corporationID)] = parsed.hqTarget;
    }
    try {
      store.write(saved);
    } catch (error) {
      return `Could not save the HQ setting: ${error.message}.`;
    }
    state.hq = saved;
    if (action === "clear") return `Saved HQ cleared for corporation ${corporationID}; /bots corp now uses the corporation's own headquarters.`;
    return `HQ for corporation ${corporationID} set to ${formatDestination(describeDestination(parsed.hqTarget, corporationID))}. It is used by /bots corp recall, work and status.`;
  }
  const record = state.deps.corporations().getCorporationRecord(corporationID);
  const own = positive(record && record.stationID);
  const effective = resolveHeadquarters(corporationID, 0);
  const savedID = positive(savedHeadquarters()[String(corporationID)]);
  return [
    `Corporation ${corporationID} headquarters: ${own ? `NPC station ${own}` : "none set in the corporation window"}.`,
    `Saved /bots corp HQ: ${savedID || "none"}.`,
    `In use: ${effective.error ? effective.error : formatDestination(effective)}.`,
  ].join("\n");
}

// Appended (never substituted) to the existing /bots help text by the preload.
const BOTS_HELP_ADDENDUM = [
  "Corporation commands: /bots corp <recall|work|status|hq|help> ... (also /playerbots corp ...; the shortcuts /corp, /corpbot and /corpbots work when the add-on preload is enabled)",
  "/bots corp recall [corporationID] [station|structure <id>] - stop every pilot's work, send them to the corporation HQ, dock and hold (pause) them there",
  "/bots corp work [corporationID] [auto|mine|pi|director] [trips <n>] [station|structure <id>] - release the hold, then start work. auto: planetary pilots set up PI, security/piracy/sovereignty pilots go back to the director, everyone else mines",
  "/bots corp status [corporationID] - pilots docked at the HQ, held, travelling, working (by operation) and idle, plus recall progress",
  "/bots corp hq [corporationID] - show the corporation's NPC HQ, the saved /bots corp HQ and the one in use",
  "/bots corp hq [corporationID] list - list the corporation's structures with ID, system and whether docking is online",
  "/bots corp hq [corporationID] set <structureOrStationID> - save the HQ that recall, work and status use (CEO or staff only; a structure must be corporation-owned with docking online)",
  "/bots corp hq [corporationID] clear - go back to the corporation's own NPC station HQ (CEO or staff only)",
  "Omit corporationID to use your own corporation. Staff/admin may use any corporation. Braces are accepted, e.g. /bots corp recall {98000123}.",
  "HQ choice, first match wins: station|structure <id> on the command (that order only); the HQ saved with /bots corp hq set; the corporation's headquarters NPC station from the corporation window. A saved HQ that is destroyed, unanchoring, no longer owned or without docking blocks recall with a message instead of diverting pilots.",
  "Recall to an NPC station uses the durable relocate operation (undock, route, warp, dock) and pauses each pilot once docked. Recall to a structure pauses the pilot at once and steps it there with the same stargate-route and dock helpers; docking permission is checked first, and pilots in an industry cycle are reported rather than pulled away.",
  "Paused pilots skip their own threat responses, so use structure recalls in safe space. /bots corp work resumes the corporation and cancels a pending recall; mining uses the HQ as its home only if its system is high-security with belts (and a structure has a quantum core), otherwise the nearest safe belts.",
  "Limits: orders are kept in memory, so after a server restart run /bots corp recall again (it is safe to repeat). Raise EVEJS_PLAYER_BOTS_MAX_PER_SYSTEM (default 30) to at least the largest corporation, or the director will move pilots out of the HQ system after /bots corp work. Progress and results arrive as chat messages.",
  "Per-pilot equivalents: /playerbots route|dock|undock|pause|resume|op stop|mine|colony <bot> ... (listed above). /bots corp applies them to a whole corporation.",
].join("\n");

function withBotsHelp(session, chatHub, options, baseMessage) {
  return state.deps.replies().handledResult(
    chatHub, session, options, `${baseMessage}\n\n${BOTS_HELP_ADDENDUM}`,
  );
}

// Appended (never substituted) to the end of the /bots usage text; /bots help also gets the full section.
function usageSuffix(argumentText) {
  const concise = " | corp recall|work|status|hq|help [corporationID] (whole-corporation orders: recall pilots to the corporation HQ, dock and hold them, then put them to work)";
  return /^\s*help\s*$/i.test(String(argumentText || "")) ? `${concise}\n\n${BOTS_HELP_ADDENDUM}` : concise;
}

function handle(session, argumentText, chatHub, options = {}) {
  const replies = state.deps.replies();
  const reply = (message) => replies.handledResult(chatHub, session, options, message);
  const parsed = parseArguments(argumentText);
  if (parsed.subcommand === "help" || parsed.error) {
    return reply(parsed.error ? `${parsed.error}\n${HELP}` : BOTS_HELP_ADDENDUM);
  }
  if (!["recall", "work", "status", "hq"].includes(parsed.subcommand)) {
    return reply(`Unknown /bots corp subcommand: ${parsed.subcommand}.\n${HELP}`);
  }
  const corporationID = parsed.corporationID ||
    positive(session && (session.corporationID || session.corpid));
  if (!corporationID) return reply("Give a corporationID, or select a character that belongs to a corporation.");
  if (!canControlCorporation(session, corporationID)) {
    return reply("You can only control playerbots in your own corporation; staff/admin can control any corporation.");
  }
  if (parsed.subcommand === "hq") return reply(commandHeadquarters(parsed, session, corporationID));
  const bots = botsOf(corporationID);
  if (!bots.length) return reply(`Corporation ${corporationID} has no playerbots to control.`);
  const context = { session, chatHub, options };
  if (parsed.subcommand === "status") return reply(commandStatus(corporationID, bots));
  if (parsed.subcommand === "recall") return reply(commandRecall(parsed, corporationID, bots, context));
  return reply(commandWork(parsed, corporationID, bots, context));
}

module.exports = {
  handle,
  withBotsHelp,
  usageSuffix,
  BOTS_HELP_ADDENDUM,
  configure,
  reset,
  _testing: {
    parseArguments, advanceRecall, startWorkForBot, tick, state,
    TICK_MS, BATCH_PER_TICK, MAX_RETRIES, STEP_DELAY_MS,
  },
};

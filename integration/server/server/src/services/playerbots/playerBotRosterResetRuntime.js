"use strict";

// "Delete all bots": removes every playerbot so the roster can be seeded
// again from scratch. Autonomous work and seeding are switched off first.
// Each pilot then has its market orders cancelled (returning buy-order
// escrow), its operation and industry cycle closed, its actor session taken
// off line, its roster record removed, and its character deleted through the
// normal EveJS character deletion, which hands its assets to its player
// corporation. Bot-run corporations left without members keep their record
// and assets, but stop being reused, so new bots found new corporations.
// Human characters and human-led corporations are not touched.
//
// Work runs in small batches between server ticks. Progress is stored in the
// playerBots table, and a reset interrupted by a restart resumes when asked
// for its status or started again.

const TABLE = "playerBots";
const STATE_PATH = "/_rosterReset";
const CONFIRMATION = "DELETE ALL BOTS";
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;
const MAX_ATTEMPTS = 5;

let running = false;

function defaultDeps() {
  const repo = require("../../gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true });
  return {
    repo,
    playerBots: () => require("./playerBotRuntime"),
    configuration: () => require("./playerBotConfigurationRuntime"),
    director: () => require("./playerBotDirectorRuntime"),
    operations: () => require("./playerBotOperationRuntime"),
    cycles: () => require("./playerBotIndustryCycleRuntime"),
    space: () => require("./playerBotSpaceRuntime"),
    economy: () => require("./playerBotEconomyRuntime"),
    market: () => new (require("../market/marketProxyService"))(),
    characters: () => require("../character/characterState"),
    deletion: () => require("../character/characterDeletionRuntime"),
    corporations: () => require("../corporation/corporationState"),
    corporationRuntime: () => require("../corporation/corporationRuntimeState"),
    log: () => require("../../utils/logger"),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    now: () => Date.now(),
  };
}

let deps = defaultDeps();

function configure(overrides = {}) {
  deps = { ...defaultDeps(), ...overrides };
  running = false;
}

function readState() {
  deps.repo.ensureTable(TABLE);
  const result = deps.repo.read(TABLE, STATE_PATH);
  return result.success && result.data && typeof result.data === "object" ? { ...result.data } : null;
}

function writeState(state) {
  deps.repo.ensureTable(TABLE);
  deps.repo.write(TABLE, STATE_PATH, state);
  deps.repo.flushTableSync(TABLE);
  return state;
}

function publicState(state) {
  if (!state) return { status: "idle" };
  return {
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt || null,
    total: state.total,
    removed: state.removed,
    remaining: (state.pending || []).length,
    failed: (state.failures || []).length,
    failures: (state.failures || []).slice(-10),
    corporationsReleased: state.corporationsReleased || 0,
    seedAfterReset: state.seedAfterReset === true,
  };
}

function getStatus() {
  const state = readState();
  // A restart interrupted a reset: carry on with what is left.
  if (state && state.status === "running" && !running) scheduleBatch();
  return publicState(state);
}

function startReset(options = {}) {
  if (String(options.confirmation || "").trim() !== CONFIRMATION) {
    return { success: false, message: `Type ${CONFIRMATION} to confirm.` };
  }
  const existing = readState();
  if (existing && existing.status === "running") {
    if (!running) scheduleBatch();
    return { success: true, state: publicState(existing), message: "A roster reset is already running." };
  }
  const configuration = deps.configuration();
  const switchedOff = configuration.updateSettings({ autoworkEnabled: false, rosterSeedEnabled: false });
  if (!switchedOff.success) return { success: false, message: switchedOff.message };
  setDirectorEnabled(false);
  const bots = deps.playerBots().listBots();
  const corporationIDs = [...new Set(bots.map((bot) => Number(bot.corporationID)).filter(Boolean))];
  const state = writeState({
    status: "running",
    startedAt: new Date(deps.now()).toISOString(),
    total: bots.length,
    removed: 0,
    pending: bots.map((bot) => ({ characterID: Number(bot.characterID), characterName: bot.characterName, attempts: 0 })),
    failures: [],
    corporationIDs,
    corporationsReleased: 0,
    seedAfterReset: options.seedAfterReset === true,
  });
  scheduleBatch();
  return { success: true, state: publicState(state), message: `Removing ${bots.length} playerbot(s).` };
}

function setDirectorEnabled(enabled) {
  try {
    const director = deps.director();
    if (typeof director.setEnabled === "function") director.setEnabled(enabled);
  } catch (error) {
    warn(`Roster reset could not ${enabled ? "resume" : "pause"} the director: ${error.message}`);
  }
}

function scheduleBatch() {
  if (running) return;
  running = true;
  deps.schedule(() => { runBatch().catch((error) => warn(`Roster reset batch failed: ${error.message}`)); }, BATCH_DELAY_MS);
}

function warn(message) {
  try { deps.log().warn(`[PlayerBots] ${message}`); } catch (_) { /* logger unavailable */ }
}

async function runBatch() {
  const state = readState();
  if (!state || state.status !== "running") { running = false; return; }
  const batch = state.pending.splice(0, BATCH_SIZE);
  for (const entry of batch) {
    let outcome;
    try {
      outcome = await removePilot(entry.characterID);
    } catch (error) {
      outcome = { success: false, message: String(error && error.message || error).slice(0, 180) };
    }
    if (outcome.success) {
      state.removed += 1;
      continue;
    }
    entry.attempts += 1;
    entry.message = outcome.message;
    if (entry.attempts >= MAX_ATTEMPTS) state.failures.push(entry);
    else state.pending.push(entry);
  }
  if (!state.pending.length) {
    state.corporationsReleased = releaseEmptyCorporations(state.corporationIDs || []);
    state.status = "done";
    state.finishedAt = new Date(deps.now()).toISOString();
    writeState(state);
    running = false;
    if (state.seedAfterReset) {
      deps.configuration().updateSettings({ autoworkEnabled: true, rosterSeedEnabled: true });
      setDirectorEnabled(true);
    }
    try {
      deps.log().info(`[PlayerBots] Roster reset finished: ${state.removed} of ${state.total} pilot(s) removed, ${state.failures.length} failed, ${state.corporationsReleased} corporation(s) released.`);
    } catch (_) { /* logger unavailable */ }
    return;
  }
  writeState(state);
  running = false;
  scheduleBatch();
}

async function removePilot(characterID) {
  const bots = deps.playerBots();
  const bot = (typeof bots.getBotByCharacterID === "function" ? bots.getBotByCharacterID(characterID) : null) ||
    { characterID, characterName: `Bot ${characterID}` };
  const space = deps.space();
  const character = deps.characters().getCharacterRecord(characterID);
  if (character && !character.isDeleted) {
    // Cancel orders while the pilot still has a session to act with.
    const orders = deps.economy().listOpenOrdersForOwner(characterID);
    if (orders.length) {
      const session = space.getActorSession(bot);
      const market = deps.market();
      for (const order of orders) {
        try {
          await market.Handle_CancelCharOrder([Number(order.order_id)], session);
        } catch (error) {
          warn(`Roster reset could not cancel order ${order.order_id} of ${characterID}: ${String(error && error.message || error).slice(0, 120)}`);
        }
      }
    }
  }
  deps.operations().retireOperationForRemovedPilot(characterID, "The pilot was removed by a roster reset.");
  deps.cycles().retireCycleForRemovedPilot(characterID, "The pilot was removed by a roster reset.");
  bots.removeBotRecord(characterID);
  space.releaseActor(characterID);
  if (!character || character.isDeleted) return { success: true };
  // Bots are removed at once; the biomass timer is for human players.
  const update = deps.characters().updateCharacterRecord(characterID, (record) => ({
    ...record,
    deletePrepareDateTime: String((BigInt(deps.now() - 60_000) * 10_000n) + 116_444_736_000_000_000n),
  }));
  if (!update || update.success === false) return { success: false, message: "Could not queue the character for deletion." };
  try {
    deps.deletion().deleteCharacter(characterID, Number(character.accountId) || 0);
  } catch (error) {
    return { success: false, message: String(error && error.message || error).slice(0, 180) };
  }
  return { success: true };
}

// A bot-run corporation with no members left stops being found by its
// founding marker, so the next seeding run founds a new one instead of
// joining a corporation whose CEO no longer exists.
function releaseEmptyCorporations(corporationIDs) {
  let released = 0;
  const corporations = deps.corporations();
  const runtime = deps.corporationRuntime();
  for (const corporationID of corporationIDs) {
    const record = corporations.getCorporationRecord(corporationID);
    if (!record || record.isNPC === true || !record.foundingOperationID) continue;
    const members = typeof runtime.listCorporationMembers === "function"
      ? runtime.listCorporationMembers(corporationID).filter((member) => member && member.deleted !== true && Number(member.deleted) !== 1)
      : [];
    const living = members.filter((member) => {
      const character = deps.characters().getCharacterRecord(member.characterID);
      return character && !character.isDeleted && Number(character.corporationID) === Number(corporationID);
    });
    if (living.length) continue;
    const result = runtime.updateCorporationRecord(corporationID, {
      foundingOperationID: null,
      retiredFoundingOperationID: record.foundingOperationID,
    });
    if (result && result.success !== false) released += 1;
  }
  return released;
}

module.exports = {
  CONFIRMATION,
  configure,
  getStatus,
  startReset,
  _testing: { removePilot, releaseEmptyCorporations, runBatch, readState },
};

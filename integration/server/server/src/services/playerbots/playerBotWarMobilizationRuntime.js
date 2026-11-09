"use strict";

// First-war military funding and active-war recruitment for playerbot corps.
// Every roster change uses the normal corporation invitation/acceptance API;
// every ISK movement goes through the corporation wallet authority and leaves
// an idempotent ledger receipt.

const { createTableRepository } = require("../../gameStore/tableRepository");
const log = require("../../utils/logger");

const TABLE = "playerBots";
const STATE_PATH = "/_warMobilization";
const FIRST_WAR_GRANT_ISK = 5_000_000_000;
const WAR_GRANT_RESERVE_ISK = 200_000_000;
const MAX_PILOT_STIPEND_ISK = 1_000_000_000;
const MAX_FUNDED_COMBAT_PILOTS = 5;
const MAX_MARKET_TRANSACTION_ENTRIES = 2_000;
// A first-war grant is sized to equip five pilots, with the 200M reserve kept
// in the corporation wallet. Cross-train safe local members before recruiting
// from another bot-only corp so a war does not needlessly weaken its donors.
const TARGET_COMBAT_PILOTS_PER_WAR_CORP = 5;
const MIN_SOURCE_COMBAT_PILOTS = 3;
// Queue the T1 combat ladder from the Algos bootstrap through Dominix. The
// director can deploy the best rung already trained while the later skills
// continue, rather than waiting for the entire battleship plan to finish.
const WAR_COMBAT_TRAINING_HULL_TYPE_IDS = Object.freeze([32872, 626, 24700, 645]);
const INVITED_BY_CORPORATION = 8;
const ACCEPTED_BY_CHARACTER = 2;
const CORPORATION_DIRECTOR = 1n;
const repo = createTableRepository("service:playerbots", { strict: true });
let mobilizationQueue = Promise.resolve();

function positiveID(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readState() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, STATE_PATH);
  const data = result.success && result.data && typeof result.data === "object" ? result.data : {};
  return { version: 1, corporations: {}, ...clone(data) };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const result = repo.write(TABLE, STATE_PATH, state);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_WAR_MOBILIZATION_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) {
    throw new Error(flush && flush.errorMsg || "PLAYERBOT_WAR_MOBILIZATION_FLUSH_FAILED");
  }
  return state;
}

function getCorporationEntry(state, corporationID, create = false) {
  const key = String(positiveID(corporationID));
  if (!state.corporations[key] && create) state.corporations[key] = { corporationID: Number(key) };
  return state.corporations[key] || null;
}

function botRoster() {
  return require("./playerBotRuntime").listBots();
}

function getCurrentCorporationID(bot) {
  const character = require("../character/characterState").getCharacterRecord(bot && bot.characterID) || {};
  return positiveID(character.corporationID || bot && bot.corporationID);
}

function activeMembers(corporationID) {
  return require("../corporation/corporationRuntimeState").listCorporationMembers(corporationID)
    .filter((member) => member && member.deleted !== true && Number(member.deleted) !== 1);
}

function configuredTestCorporationID() {
  return positiveID(process.env.EVEJS_PLAYER_BOTS_WAR_TEST_CORPORATION_ID);
}

function qualifiesForFirstWarGrant(corporationID, bots = botRoster()) {
  const id = positiveID(corporationID);
  if (!id) return false;
  const members = activeMembers(id);
  const botIDs = new Set(bots.map((bot) => Number(bot.characterID)));
  const hasBotMember = members.some((member) => botIDs.has(Number(member.characterID)));
  if (!members.length || !hasBotMember) return false;
  if (configuredTestCorporationID() === id) return true;
  return members.every((member) => botIDs.has(Number(member.characterID)));
}

function ownerWars(corporationID) {
  return require("../corporation/warRuntimeState").listWarsForOwner(positiveID(corporationID));
}

function listActiveBotWars(bots = botRoster(), excludedCharacterIDs = new Set()) {
  const corporationIDs = new Set(bots
    .filter((bot) => bot && !excludedCharacterIDs.has(Number(bot.characterID)))
    .map((bot) => getCurrentCorporationID(bot))
    .filter(Boolean));
  const wars = new Map();
  for (const corporationID of corporationIDs) {
    for (const war of ownerWars(corporationID)) {
      // A null finish time includes the normal declaration spool-up and live
      // war. A future finish timestamp is a cooldown, not combat time.
      if (!war || war.timeFinished) continue;
      const warID = positiveID(war.warID);
      if (warID) wars.set(warID, war);
    }
  }
  return wars;
}

function warIsOngoing(war) {
  if (!war || !war.timeFinished) return Boolean(war);
  try {
    const now = BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
    return BigInt(String(war.timeFinished)) > now;
  } catch (_) {
    return true;
  }
}

function findWarFor(corporationID, opponentID, expectedWarID = 0) {
  const matches = ownerWars(corporationID).filter((war) => {
    if (expectedWarID && Number(war.warID) !== expectedWarID) return false;
    const other = Number(war.declaredByID) === Number(corporationID)
      ? Number(war.againstID)
      : Number(war.declaredByID);
    return !opponentID || other === Number(opponentID);
  });
  return matches.sort((left, right) => Number(right.warID) - Number(left.warID))[0] || null;
}

// Called before the regular war API writes a record. This durable intent lets
// the next director pass finish a grant if the server restarts between the war
// declaration and the wallet adjustment.
function prepareWarDeclaration(declaringCorporationID, opposingCorporationID) {
  const declaringID = positiveID(declaringCorporationID);
  const opposingID = positiveID(opposingCorporationID);
  const bots = botRoster();
  const state = readState();
  const preparedCorporationIDs = [];
  for (const [corporationID, opponentID] of [[declaringID, opposingID], [opposingID, declaringID]]) {
    if (!corporationID || !opponentID || ownerWars(corporationID).length !== 0 ||
        !qualifiesForFirstWarGrant(corporationID, bots)) continue;
    const entry = getCorporationEntry(state, corporationID, true);
    if (entry.firstWarGrant) continue;
    entry.firstWarGrant = {
      status: "armed",
      corporationID,
      opponentCorporationID: opponentID,
      amount: FIRST_WAR_GRANT_ISK,
      idempotencyKey: `playerbot:first-war-mobilization:${corporationID}`,
      preparedAt: new Date().toISOString(),
    };
    preparedCorporationIDs.push(corporationID);
  }
  if (preparedCorporationIDs.length) saveState(state);
  return { declaringCorporationID: declaringID, opposingCorporationID: opposingID, preparedCorporationIDs };
}

function resolveGrantWar(corporationID, grant) {
  if (Number(grant.warID) > 0) return findWarFor(corporationID, grant.opponentCorporationID, Number(grant.warID));
  return findWarFor(corporationID, grant.opponentCorporationID);
}

async function creditFirstWarGrant(corporationID, war, grant) {
  const wallet = require("../corporation/corpWalletState");
  const warID = positiveID(war && war.warID);
  const id = positiveID(corporationID);
  if (!id || !warID || !grant || grant.status === "granted") return { success: false, skipped: true };
  const state = readState();
  const entry = getCorporationEntry(state, id, true);
  const current = entry.firstWarGrant;
  if (!current || current.idempotencyKey !== grant.idempotencyKey) return { success: false, skipped: true };
  current.status = "crediting";
  current.warID = warID;
  current.lastAttemptAt = new Date().toISOString();
  current.attempts = (Number(current.attempts) || 0) + 1;
  saveState(state);

  try {
    const result = await wallet.adjustCorporationWalletDivisionBalanceAsync(
      id,
      wallet.CORPORATION_WALLET_KEY_START,
      FIRST_WAR_GRANT_ISK,
      {
        description: `Playerbot first-war mobilization grant for war ${warID}`,
        entryTypeID: require("../account/walletState").JOURNAL_ENTRY_TYPE.GM_CASH_TRANSFER,
        ownerID1: 1,
        ownerID2: id,
        referenceID: warID,
        requireExactCredit: true,
        idempotencyKey: current.idempotencyKey,
      },
      { source: "playerbot-first-war-grant", idempotencyKey: current.idempotencyKey },
    );
    if (!result || result.success !== true) {
      const latest = readState();
      const latestGrant = getCorporationEntry(latest, id, true).firstWarGrant;
      latestGrant.status = "pending-credit";
      latestGrant.lastError = String(result && result.errorMsg || "WALLET_CREDIT_FAILED").slice(0, 180);
      saveState(latest);
      return { success: false, error: latestGrant.lastError };
    }
    const latest = readState();
    const latestGrant = getCorporationEntry(latest, id, true).firstWarGrant;
    latestGrant.status = "granted";
    latestGrant.warID = warID;
    latestGrant.grantedAt = new Date().toISOString();
    latestGrant.lastError = null;
    saveState(latest);
    log.info(`[PlayerBots] First-war mobilization grant credited corp=${id} war=${warID} amount=${FIRST_WAR_GRANT_ISK} ISK.`);
    return { success: true, corporationID: id, warID, amount: FIRST_WAR_GRANT_ISK };
  } catch (error) {
    const latest = readState();
    const latestGrant = getCorporationEntry(latest, id, true).firstWarGrant;
    latestGrant.status = "pending-credit";
    latestGrant.lastError = String(error && error.message || error).slice(0, 180);
    saveState(latest);
    log.warn(`[PlayerBots] First-war grant pending corp=${id} war=${warID}: ${latestGrant.lastError}.`);
    return { success: false, error: latestGrant.lastError };
  }
}

async function processFirstWarGrants() {
  const state = readState();
  const pending = Object.values(state.corporations)
    .map((entry) => entry && entry.firstWarGrant)
    .filter((grant) => grant && ["armed", "pending-credit", "crediting"].includes(grant.status));
  const results = [];
  for (const grant of pending) {
    const corporationID = positiveID(grant.corporationID);
    const war = resolveGrantWar(corporationID, grant);
    if (!war) continue;
    results.push(await creditFirstWarGrant(corporationID, war, grant));
  }
  return results;
}

function memberSecurityBots(corporationID, bots = botRoster(), excludedCharacterIDs = new Set()) {
  const operationRuntime = require("./playerBotOperationRuntime");
  return memberSecurityPilots(corporationID, bots, excludedCharacterIDs)
    .filter((bot) => operationRuntime.hasRoleShipFit(bot, "security"));
}

function activeWarIDForCorporation(corporationID) {
  return ownerWars(corporationID).filter(warIsOngoing)
    .sort((left, right) => Number(left.warID) - Number(right.warID))
    .map((war) => positiveID(war.warID))[0] || 0;
}

function getWarCombatAssignment(corporationID, characterID, warID = 0) {
  const qualified = getGrantAndWar(corporationID);
  if (!qualified || (positiveID(warID) && Number(qualified.war.warID) !== positiveID(warID))) return null;
  const entry = getCorporationEntry(readState(), corporationID);
  const assignment = entry && entry.warCombatAssignments &&
    entry.warCombatAssignments[String(positiveID(characterID))];
  if (!assignment || !positiveID(assignment.warID) ||
      (positiveID(warID) && Number(assignment.warID) !== positiveID(warID)) ||
      ["released", "failed"].includes(assignment.status)) return null;
  return Number(qualified.war.warID) === Number(assignment.warID) &&
    (Number(qualified.war.againstID) === Number(assignment.opponentCorporationID) ||
      Number(qualified.war.declaredByID) === Number(assignment.opponentCorporationID))
    ? assignment : null;
}

function getActiveWarCombatAssignment(bot) {
  const corporationID = getCurrentCorporationID(bot);
  if (!corporationID || !bot) return null;
  const assignment = getWarCombatAssignment(corporationID, bot.characterID);
  if (!assignment) return null;
  return {
    corporationID,
    characterID: Number(bot.characterID),
    warID: Number(assignment.warID),
    opponentCorporationID: Number(assignment.opponentCorporationID),
    status: String(assignment.status || "training"),
  };
}

function memberSecurityPilots(corporationID, bots = botRoster(), excludedCharacterIDs = new Set(), warID = 0) {
  return bots.filter((bot) => {
    const assignment = bot.specialty === "security"
      ? null
      : getWarCombatAssignment(corporationID, bot.characterID, warID);
    return getCurrentCorporationID(bot) === Number(corporationID) &&
      (bot.specialty === "security" || Boolean(assignment)) &&
      bot.status !== "paused" && bot.autonomyPaused !== true &&
      !excludedCharacterIDs.has(Number(bot.characterID));
  });
}

function skillLevel(skillMap, typeID) {
  const record = skillMap && (skillMap.get ? skillMap.get(Number(typeID)) : skillMap[Number(typeID)]);
  return Math.max(0, Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0);
}

function formatWarTrainingError(error, stage = "unknown") {
  const payload = error && error.machoErrorResponse && error.machoErrorResponse.payload;
  const header = payload && Array.isArray(payload.header) ? payload.header : [];
  const token = header[0];
  const className = token && typeof token.value === "string" ? token.value : "";
  const args = header[1];
  let detail = error && error.message ? String(error.message) : String(error || "unknown error");
  if (className) {
    let remoteMessage = "";
    let remoteValues = "";
    if (Array.isArray(args) && args.length) {
      const first = args[0];
      remoteMessage = Buffer.isBuffer(first) ? first.toString("utf8")
        : typeof first === "string" ? first : "";
      const valueEntries = args[1] && Array.isArray(args[1].entries) ? args[1].entries : [];
      remoteValues = valueEntries.slice(0, 3).map(([key, value]) => {
        const normalizedKey = Buffer.isBuffer(key) ? key.toString("utf8") : String(key);
        const normalizedValue = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
        return `${normalizedKey}=${normalizedValue}`;
      }).join(",");
    }
    detail = `${className}${remoteMessage ? `:${remoteMessage}` : ""}${remoteValues ? `:${remoteValues}` : ""}`;
  }
  return `WAR_TRAINING_${String(stage || "unknown").toUpperCase()}:${detail}`.slice(0, 180);
}

async function queueWarCombatTraining(bot) {
  const operations = require("./playerBotOperationRuntime");
  const skillQueue = require("../skills/training/skillQueueRuntime");
  const skillState = require("../skills/skillState");
  const skillbooks = require("../skills/skillbooks/skillbookRuntime");
  const characterID = positiveID(bot && bot.characterID);
  let stage = "fit-requirements";
  try {
    const requirementsByRung = WAR_COMBAT_TRAINING_HULL_TYPE_IDS.map((hullTypeID) =>
      operations.getShipRungSkillRequirements("security", hullTypeID));
    if (!characterID || requirementsByRung.some((requirements) => !requirements.length)) {
      throw new Error("WAR_COMBAT_FIT_REQUIREMENTS_UNAVAILABLE");
    }
    const requirements = requirementsByRung.flat();

    stage = "queue-snapshot";
    const snapshot = skillQueue.getQueueSnapshot(characterID);
    stage = "character-skills";
    let skillMap = skillState.getCharacterSkillMap(characterID);
    const ready = requirements.every(([typeID, level]) => skillLevel(skillMap, typeID) >= Number(level));
    const queue = (Array.isArray(snapshot && snapshot.queueEntries) ? snapshot.queueEntries : [])
      .map((entry) => ({
        typeID: positiveID(entry.typeID || entry.trainingTypeID),
        toLevel: Math.max(0, Math.trunc(Number(entry.toLevel ?? entry.trainingToLevel) || 0)),
      }))
      .filter((entry) => entry.typeID && entry.toLevel > 0);
    const projected = new Map();
    for (const [typeID, record] of skillMap instanceof Map ? skillMap : Object.entries(skillMap || {})) {
      projected.set(Number(typeID), Math.max(0, Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0));
    }
    for (const entry of queue) projected.set(entry.typeID, Math.max(projected.get(entry.typeID) || 0, entry.toLevel));

    const visiting = new Set();
    const planned = new Map();
    function ensureSkill(typeID, targetLevel) {
      const skillID = positiveID(typeID);
      const target = Math.max(0, Math.trunc(Number(targetLevel) || 0));
      if (!skillID || !target || (projected.get(skillID) || 0) >= target) return;
      if (visiting.has(skillID)) throw new Error(`WAR_COMBAT_SKILL_PREREQUISITE_CYCLE:${skillID}`);
      visiting.add(skillID);
      stage = `skill-prerequisites-${skillID}`;
      for (const [prerequisiteID, prerequisiteLevel] of operations.requiredSkillsForType(skillID)) {
        ensureSkill(prerequisiteID, prerequisiteLevel);
      }
      let level = projected.get(skillID) || 0;
      while (level < target) {
        level += 1;
        queue.push({ typeID: skillID, toLevel: level });
        planned.set(skillID, level);
        projected.set(skillID, level);
      }
      visiting.delete(skillID);
    }

    for (const [typeID, level] of requirements) ensureSkill(typeID, level);
    const injectedSkill = (typeID) => {
      const record = skillMap && (skillMap.get ? skillMap.get(Number(typeID)) : skillMap[Number(typeID)]);
      return Boolean(record && record.trainedSkillLevel !== null && record.trainedSkillLevel !== undefined);
    };
    const missingSkillbooks = [...planned.keys()].filter((typeID) => !injectedSkill(typeID));
    if (missingSkillbooks.length) {
      stage = "purchase-skillbooks";
      await skillbooks.purchaseSkills(characterID, missingSkillbooks);
      stage = "refresh-injected-skills";
      skillMap = skillState.getCharacterSkillMap(characterID);
      const stillMissing = missingSkillbooks.filter((typeID) => !injectedSkill(typeID));
      if (stillMissing.length) {
        throw new Error(`WAR_TRAINING_SKILL_INJECTION_INCOMPLETE:${stillMissing.join(",")}`);
      }
    }
    let finalSnapshot = snapshot;
    if (planned.size) {
      stage = "save-queue";
      skillQueue.saveQueue(characterID, queue, { activate: true, emitNotifications: false });
      stage = "refresh-queue-snapshot";
      finalSnapshot = skillQueue.getQueueSnapshot(characterID);
    }
    const outstandingBySkill = new Map();
    for (const [typeID, level] of requirements) {
      if (skillLevel(skillMap, typeID) >= Number(level)) continue;
      outstandingBySkill.set(Number(typeID), Math.max(
        Number(outstandingBySkill.get(Number(typeID)) || 0), Number(level),
      ));
    }
    const outstandingRequirements = [...outstandingBySkill.entries()]
      .map(([typeID, toLevel]) => ({ typeID, toLevel }));
    return {
      queued: planned.size > 0,
      ready,
      requiredSkills: planned.size
        ? [...planned.entries()].map(([typeID, toLevel]) => ({ typeID, toLevel }))
        : outstandingRequirements,
      queueEndTime: finalSnapshot && finalSnapshot.queueEndTime || null,
    };
  } catch (error) {
    throw new Error(formatWarTrainingError(error, stage), { cause: error });
  }
}

function hasManagementRole(corporationID, characterID) {
  const member = require("../corporation/corporationRuntimeState")
    .getCorporationMember(corporationID, characterID) || {};
  for (const field of ["roles", "grantableRoles", "rolesAtHQ", "grantableRolesAtHQ",
    "rolesAtBase", "grantableRolesAtBase", "rolesAtOther", "grantableRolesAtOther", "titleMask"]) {
    try {
      if (BigInt(member[field] || 0) !== 0n) return true;
    } catch (_) {
      if (Number(member[field]) !== 0) return true;
    }
  }
  return false;
}

function canMobilizeOwnCorpMember(corporationID, bot, bots, excludedCharacterIDs = new Set()) {
  const characterID = positiveID(bot && bot.characterID);
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  if (!characterID || getCurrentCorporationID(bot) !== Number(corporationID) ||
      bot.specialty === "security" || bot.status === "paused" || bot.autonomyPaused === true ||
      bot.founder === true || excludedCharacterIDs.has(characterID) ||
      Number(corporation.ceoID) === characterID || hasManagementRole(corporationID, characterID)) return false;
  const assignment = getWarCombatAssignment(corporationID, characterID);
  if (assignment) return false;
  const operations = require("./playerBotOperationRuntime");
  const operation = operations.getOperation(characterID);
  // Queueing the ordinary combat skills does not replace the pilot's current
  // durable operation. The director will wait for active work to complete
  // before it starts the ship upgrade; uncertain and review work stays out of
  // the war roster entirely.
  if (operation && (operation.pending === true || operation.status === "review")) return false;
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(characterID);
  if (cycle && (cycle.status === "review" || cycle.pending)) return false;
  const activeWarAssignment = Object.values(readState().corporations || {})
    .some((entry) => entry && Object.values(entry.warCombatAssignments || {})
      .some((member) => Number(member && member.characterID) === characterID &&
        getWarCombatAssignment(Number(entry.corporationID), characterID)));
  if (activeWarAssignment) return false;
  return true;
}

async function assignOwnCorpWarCombatPilots(corporationID, war, bots, target, excludedCharacterIDs = new Set()) {
  const id = positiveID(corporationID);
  const warID = positiveID(war && war.warID);
  const opponentCorporationID = Number(war && Number(war.declaredByID) === id
    ? war.againstID : war && war.declaredByID) || 0;
  const fundedWar = getGrantAndWar(id);
  if (!id || !warID || !opponentCorporationID || !fundedWar ||
      Number(fundedWar.war.warID) !== warID) return { assigned: [], combatPilots: 0 };
  let state = readState();
  const entry = getCorporationEntry(state, id, true);
  entry.warCombatAssignments = entry.warCombatAssignments || {};
  const refreshed = [];
  for (const bot of bots) {
    const characterID = positiveID(bot && bot.characterID);
    const assignment = entry.warCombatAssignments[String(characterID)];
    if (!assignment || Number(assignment.warID) !== warID ||
        !["training", "training-pending"].includes(assignment.status) ||
        excludedCharacterIDs.has(characterID)) continue;
    try {
      const training = await queueWarCombatTraining(bot);
      assignment.status = training.ready ? "ready" : "training";
      assignment.requiredSkills = training.requiredSkills;
      assignment.queueEndTime = training.queueEndTime;
      assignment.lastError = null;
      assignment.lastAttemptAt = new Date().toISOString();
    } catch (error) {
      assignment.status = "training-pending";
      assignment.lastError = String(error && error.message || error).slice(0, 180);
      assignment.lastAttemptAt = new Date().toISOString();
    }
    entry.warCombatAssignments[String(characterID)] = assignment;
    refreshed.push({ characterID, status: assignment.status, requiredSkills: assignment.requiredSkills || [] });
  }
  if (refreshed.length) saveState(state);
  let combatPilots = memberSecurityPilots(id, bots, excludedCharacterIDs, warID);
  const candidates = bots.filter((bot) => canMobilizeOwnCorpMember(id, bot, bots, excludedCharacterIDs))
    .sort((left, right) => {
      const operations = require("./playerBotOperationRuntime");
      const budget = Number(require("../account/walletBalanceLimit").MAX_WALLET_BALANCE) || MAX_PILOT_STIPEND_ISK;
      const leftReady = operations.nextShipUpgrade(left, "security", { balanceOverride: budget }) ? 1 : 0;
      const rightReady = operations.nextShipUpgrade(right, "security", { balanceOverride: budget }) ? 1 : 0;
      return rightReady - leftReady || Number(left.characterID) - Number(right.characterID);
    });
  const mobilized = [];
  for (const bot of candidates) {
    if (combatPilots.length >= target) break;
    const characterID = positiveID(bot.characterID);
    state = readState();
    const currentEntry = getCorporationEntry(state, id, true);
    currentEntry.warCombatAssignments = currentEntry.warCombatAssignments || {};
    const old = currentEntry.warCombatAssignments[String(characterID)];
    if (old && Number(old.warID) !== warID &&
        getWarCombatAssignment(id, characterID, Number(old.warID))) continue;
    let training = { queued: false, requiredSkills: [] };
    let lastError = null;
    try {
      training = await queueWarCombatTraining(bot);
    } catch (error) {
      lastError = String(error && error.message || error).slice(0, 180);
    }
    const assignment = currentEntry.warCombatAssignments[String(characterID)] || {
      characterID,
      corporationID: id,
      opponentCorporationID,
      warID,
      role: "security",
      createdAt: new Date().toISOString(),
    };
    assignment.status = lastError ? "training-pending" : training.ready ? "ready" : "training";
    assignment.requiredSkills = training.requiredSkills;
    assignment.queueEndTime = training.queueEndTime;
    assignment.lastError = lastError;
    assignment.lastAttemptAt = new Date().toISOString();
    currentEntry.warCombatAssignments[String(characterID)] = assignment;
    saveState(state);
    mobilized.push({ characterID, status: assignment.status, requiredSkills: training.requiredSkills });
    combatPilots.push(bot);
    log.info(`[PlayerBots] War combat pilot assigned within corp=${id} war=${warID} char=${characterID} status=${assignment.status}${lastError ? ` error=${lastError}` : ` queuedSkills=${training.requiredSkills.length}`}.`);
  }
  return { assigned: [...refreshed, ...mobilized], refreshed, mobilized, combatPilots: combatPilots.length };
}

function canLeaveSource(bot, bots) {
  if (bot.status === "paused" || bot.autonomyPaused === true || bot.founder === true) return false;
  const corporations = require("../corporation/corporationState");
  const sourceID = getCurrentCorporationID(bot);
  const source = corporations.getCorporationRecord(sourceID) || {};
  const rosterIDs = new Set(bots.map((candidate) => Number(candidate.characterID)));
  // Recruitment can move idle security bots only between bot-only corps. A
  // mixed corporation, especially a human-CEO test corporation, keeps its own
  // personnel unless its commander explicitly joins the war corporation.
  if (activeMembers(sourceID).some((member) => !rosterIDs.has(Number(member.characterID)))) return false;
  if (typeof corporations.getCharacterIDsInCorporation === "function" &&
      corporations.getCharacterIDsInCorporation(sourceID)
        .some((characterID) => !rosterIDs.has(Number(characterID)))) return false;
  if (Number(source.ceoID) === Number(bot.characterID) || ownerWars(sourceID).some(warIsOngoing)) return false;
  const member = require("../corporation/corporationRuntimeState")
    .getCorporationMember(sourceID, Number(bot.characterID)) || {};
  for (const field of ["roles", "grantableRoles", "rolesAtHQ", "grantableRolesAtHQ",
    "rolesAtBase", "grantableRolesAtBase", "rolesAtOther", "grantableRolesAtOther", "titleMask"]) {
    try { if (BigInt(member[field] || 0) !== 0n) return false; } catch (_) { if (Number(member[field]) !== 0) return false; }
  }
  const operations = require("./playerBotOperationRuntime");
  if (operations.hasActiveOperation(bot.characterID)) return false;
  const cycle = require("./playerBotIndustryCycleRuntime").getCycle(bot.characterID);
  if (cycle && (["active", "holding", "review"].includes(cycle.status) || cycle.pending)) return false;
  const fitMembers = memberSecurityBots(sourceID, bots);
  const candidateHasFit = operations.hasRoleShipFit(bot, "security");
  return fitMembers.length - Number(candidateHasFit) >= MIN_SOURCE_COMBAT_PILOTS;
}

function findCorpRecruiter(corporationID, bots = botRoster()) {
  const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
  const runtimeState = require("../corporation/corporationRuntimeState");
  const authority = require("../corporation/warAuthority");
  const candidates = bots.filter((bot) => getCurrentCorporationID(bot) === Number(corporationID))
    .sort((left, right) => Number(right.characterID === Number(corporation.ceoID)) -
      Number(left.characterID === Number(corporation.ceoID)) || Number(left.characterID) - Number(right.characterID));
  for (const bot of candidates) {
    if (bot.status === "paused" || bot.autonomyPaused === true) continue;
    const session = require("./playerBotSpaceRuntime").getActorSession(bot);
    const roleState = runtimeState.getCorporationSessionRoleState(corporationID, Number(bot.characterID)) || {};
    let roles = 0n;
    try { roles = BigInt(roleState.rolesAtAll || 0); } catch (_) { /* no authority */ }
    if (Number(corporation.ceoID) !== Number(bot.characterID) && (roles & CORPORATION_DIRECTOR) !== CORPORATION_DIRECTOR) continue;
    if (authority.getWarAuthority(session)) return { bot, session };
    // The CEO can manage recruitment even if the war authority helper rejects
    // the corporation for a missing HQ; recruitment itself is separately
    // checked by corpRegistryRuntime.
    if (Number(corporation.ceoID) === Number(bot.characterID)) return { bot, session };
  }
  return null;
}

function findOpenInvitation(corporationID, characterID) {
  const runtime = require("../corporation/corporationRuntimeState").getCorporationRuntime(corporationID) || {};
  return Object.values(runtime.applications || {})
    .filter((application) => application && Number(application.characterID) === Number(characterID) &&
      Number(application.corporationID) === Number(corporationID) &&
      Number(application.status) === INVITED_BY_CORPORATION && application.deleted !== true)
    .sort((left, right) => String(right.applicationDateTime || "").localeCompare(String(left.applicationDateTime || "")) ||
      Number(right.applicationID) - Number(left.applicationID))[0] || null;
}

function recordRecruitmentIntent(corporationID, bot, sourceCorporationID) {
  const state = readState();
  const entry = getCorporationEntry(state, corporationID, true);
  entry.recruitments = entry.recruitments || {};
  const key = String(bot.characterID);
  if (!entry.recruitments[key]) {
    entry.recruitments[key] = {
      characterID: Number(bot.characterID),
      sourceCorporationID: Number(sourceCorporationID),
      status: "inviting",
      invitationKey: `playerbot:war-recruit:${corporationID}:${bot.characterID}`,
      createdAt: new Date().toISOString(),
    };
    saveState(state);
  }
  return entry.recruitments[key];
}

function recordRecruitmentFailure(corporationID, characterID, reason) {
  const state = readState();
  const entry = getCorporationEntry(state, corporationID, true);
  entry.recruitments = entry.recruitments || {};
  const recruitment = entry.recruitments[String(characterID)] || {
    characterID: Number(characterID),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  recruitment.status = "pending";
  recruitment.lastError = String(reason || "RECRUITMENT_NOT_CONFIRMED").slice(0, 160);
  recruitment.lastAttemptAt = new Date().toISOString();
  entry.recruitments[String(characterID)] = recruitment;
  saveState(state);
  log.warn(`[PlayerBots] War recruitment pending corp=${corporationID} char=${characterID}: ${recruitment.lastError}.`);
}

async function recruitOneCombatPilot(corporationID, bot) {
  const characterID = positiveID(bot.characterID);
  const sourceCorporationID = getCurrentCorporationID(bot);
  const intent = recordRecruitmentIntent(corporationID, bot, sourceCorporationID);
  if (sourceCorporationID === Number(corporationID)) {
    const state = readState();
    const joinedIntent = getCorporationEntry(state, corporationID, true).recruitments[String(characterID)];
    if (joinedIntent) {
      joinedIntent.status = "joined";
      joinedIntent.joinedAt = joinedIntent.joinedAt || new Date().toISOString();
      saveState(state);
    }
    return { success: true, alreadyJoined: true };
  }
  const registry = new (require("../corporation/corpRegistryRuntime"))();
  const corpRuntime = require("../corporation/corporationRuntimeState");
  let application = findOpenInvitation(corporationID, characterID);
  if (!application) {
    const recruiter = findCorpRecruiter(corporationID);
    if (!recruiter) {
      recordRecruitmentFailure(corporationID, characterID, "no-persisted-corporation-recruiter");
      return { success: false, reason: "no-persisted-corporation-recruiter" };
    }
    try {
      registry.Handle_InsertInvitation([characterID], recruiter.session);
      application = findOpenInvitation(corporationID, characterID);
    } catch (error) {
      const reason = String(error && error.message || error).slice(0, 160);
      recordRecruitmentFailure(corporationID, characterID, reason);
      return { success: false, reason };
    }
  }
  if (!application) {
    recordRecruitmentFailure(corporationID, characterID, "normal-corporation-invitation-not-persisted");
    return { success: false, reason: "normal-corporation-invitation-not-persisted" };
  }
  try {
    const currentBot = botRoster().find((entry) => Number(entry.characterID) === characterID) || bot;
    const applicantSession = require("./playerBotSpaceRuntime").getActorSession(currentBot);
    registry.Handle_UpdateApplicationOffer(
      [Number(application.applicationID), characterID, Number(corporationID),
        String(application.applicationText || ""), ACCEPTED_BY_CHARACTER,
        "Mobilized for the corporation's null-sec structure war."],
      applicantSession,
    );
  } catch (error) {
    const reason = String(error && error.message || error).slice(0, 160);
    recordRecruitmentFailure(corporationID, characterID, reason);
    return { success: false, reason };
  }
  const joinedCorporationID = getCurrentCorporationID({ characterID, corporationID: sourceCorporationID });
  if (joinedCorporationID !== Number(corporationID)) {
    const afterState = readState();
    const afterIntent = getCorporationEntry(afterState, corporationID, true).recruitments[String(characterID)];
    afterIntent.status = "pending";
    afterIntent.lastError = "normal-application-acceptance-not-confirmed";
    afterIntent.lastAttemptAt = new Date().toISOString();
    saveState(afterState);
    return { success: false, reason: afterIntent.lastError };
  }
  const afterState = readState();
  const afterIntent = getCorporationEntry(afterState, corporationID, true).recruitments[String(characterID)];
  afterIntent.status = "joined";
  afterIntent.joinedAt = new Date().toISOString();
  afterIntent.lastError = null;
  saveState(afterState);
  log.info(`[PlayerBots] Security bot ${characterID} joined war corporation ${corporationID} through its persisted invitation.`);
  // The moveCharacterToCorporation call updates the real affiliation and member
  // state; refresh the repository-backed roster before later candidates run.
  return { success: true, corporationID, characterID, invitationID: Number(application.applicationID) };
}

async function ensureCorpCombatPilots(corporationID, bots = botRoster(), target = TARGET_COMBAT_PILOTS_PER_WAR_CORP,
  excludedCharacterIDs = new Set(), requestedWarID = 0) {
  const id = positiveID(corporationID);
  const corporation = require("../corporation/corporationState").getCorporationRecord(id) || {};
  const limit = Math.max(0, Number(corporation.memberLimit) || 20);
  const warID = positiveID(requestedWarID) || activeWarIDForCorporation(id);
  let currentBots = botRoster();
  let combatPilots = memberSecurityPilots(id, currentBots, excludedCharacterIDs, warID);
  const recruited = [];
  let mobilized = [];
  if (warID) {
    const war = findWarFor(id, 0, warID) || ownerWars(id).find((candidate) => Number(candidate.warID) === warID);
    const local = await assignOwnCorpWarCombatPilots(id, war, currentBots, target, excludedCharacterIDs);
    mobilized = local.mobilized;
    currentBots = botRoster();
    combatPilots = memberSecurityPilots(id, currentBots, excludedCharacterIDs, warID);
  }
  while (combatPilots.length < target) {
    const currentMemberCount = activeMembers(id).length;
    if (currentMemberCount >= limit) break;
    const sources = currentBots.filter((bot) => getCurrentCorporationID(bot) !== id &&
      bot.specialty === "security" && !excludedCharacterIDs.has(Number(bot.characterID)) &&
      canLeaveSource(bot, currentBots))
      .sort((left, right) => Number(left.characterID) - Number(right.characterID));
    if (!sources.length) break;
    let joined = null;
    for (const candidate of sources) {
      const result = await recruitOneCombatPilot(id, candidate);
      if (!result.success) continue;
      joined = result;
      recruited.push(result);
      break;
    }
    if (!joined) break;
    currentBots = botRoster();
    combatPilots = memberSecurityPilots(id, currentBots, excludedCharacterIDs, warID);
  }
  if (combatPilots.length < target && recruited.length === 0 && mobilized.length === 0) {
    log.info(`[PlayerBots] War recruitment deferred corp=${id}: ${combatPilots.length}/${target} security pilots; no safe local candidate, eligible donor, or free member slot is available.`);
  }
  return {
    success: combatPilots.length >= target,
    corporationID: id,
    combatPilots: combatPilots.length,
    target,
    recruited,
    mobilized,
    memberCount: activeMembers(id).length,
    memberLimit: limit,
  };
}

function getGrantAndWar(corporationID) {
  const id = positiveID(corporationID);
  const entry = getCorporationEntry(readState(), id);
  const grant = entry && entry.firstWarGrant;
  if (!grant || grant.status !== "granted") return null;
  const war = findWarFor(id, grant.opponentCorporationID, Number(grant.warID));
  return war && warIsOngoing(war) ? { entry, grant, war } : null;
}

function getStipend(corporationID, characterID) {
  const id = positiveID(corporationID);
  const state = readState();
  const entry = getCorporationEntry(state, id);
  const stipend = entry && entry.combatStipends && entry.combatStipends[String(positiveID(characterID))];
  return stipend ? { state, entry, stipend } : null;
}

function settleUpgradeReservation(bot, stipendRecord) {
  const operationID = String(stipendRecord.stipend.reservedOperationID || "");
  if (!operationID) return stipendRecord;
  const operation = require("./playerBotOperationRuntime").getOperation(bot.characterID);
  if (operation && String(operation.operationID) === operationID &&
      ["active", "holding", "review"].includes(operation.status)) return stipendRecord;
  if (!operation || String(operation.operationID) !== operationID) {
    const wallet = require("../account/walletState");
    const transactions = typeof wallet.getCharacterMarketTransactions === "function"
      ? wallet.getCharacterMarketTransactions(bot.characterID)
      : null;
    const reservation = stipendRecord.stipend;
    const reservedAt = Date.parse(String(reservation.reservedAt || reservation.updatedAt || ""));
    const baselineTransactionID = positiveID(reservation.reservedMarketTransactionID);
    const historyComplete = Array.isArray(transactions) &&
      transactions.length < MAX_MARKET_TRANSACTION_ENTRIES;
    const hasReservationBaseline = baselineTransactionID > 0 ||
      (Number.isFinite(reservedAt) && reservedAt > 0);
    const transactionsAfterReservation = historyComplete && hasReservationBaseline
      ? transactions.filter((transaction) => baselineTransactionID
        ? Number(transaction && transaction.transactionID) > baselineTransactionID
        : journalTimeMs(transaction && transaction.transactionDate) > reservedAt)
      : null;
    const replacementHasUnsettledSpend = Boolean(operation && (
      Number(operation.spent) > 0 || operation.pending ||
      ["review", "holding"].includes(String(operation.status || "").toLowerCase())
    ));
    // A replaced operation may have been lost during capsule recovery or a
    // restart. Release its reservation only when the persisted market ledger
    // is complete and proves that no purchase followed the reservation. If
    // there was any market activity, an incomplete ledger, or uncertain spend,
    // leave the money reserved for explicit reconciliation.
    if (!historyComplete || transactionsAfterReservation === null ||
        transactionsAfterReservation.length || replacementHasUnsettledSpend) {
      return stipendRecord;
    }
    const state = stipendRecord.state;
    const current = getCorporationEntry(state, stipendRecord.entry.corporationID, true)
      .combatStipends[String(bot.characterID)];
    current.reservedOperationID = null;
    current.reservedAmount = 0;
    current.lastUpgradeOperationID = operationID;
    current.lastUpgradeStatus = "superseded-before-market-spend";
    current.reservationReconciledAt = new Date().toISOString();
    delete current.reservedAt;
    delete current.reservedMarketTransactionID;
    current.updatedAt = new Date().toISOString();
    saveState(state);
    log.info("[PlayerBots] Released an orphaned war ship reservation char=" + bot.characterID +
      " corp=" + current.corporationID + "; complete market history confirms no purchase after operation " + operationID + ".");
    return { state, entry: getCorporationEntry(state, current.corporationID), stipend: current };
  }
  const state = stipendRecord.state;
  const current = getCorporationEntry(state, stipendRecord.entry.corporationID, true)
    .combatStipends[String(bot.characterID)];
  current.spent = Math.min(Number(current.amount) || 0,
    (Number(current.spent) || 0) + Math.max(0,
      (Number(operation.spent) || 0) - (Number(operation.warSupportBaselineSpent) || 0)));
  current.reservedOperationID = null;
  current.reservedAmount = 0;
  current.lastUpgradeOperationID = operationID;
  current.lastUpgradeStatus = operation.status;
  delete current.reservedAt;
  delete current.reservedMarketTransactionID;
  current.updatedAt = new Date().toISOString();
  saveState(state);
  return { state, entry: getCorporationEntry(state, current.corporationID), stipend: current };
}

function reconcileOrphanedUpgradeReservation(bot) {
  if (!bot) return { released: false, reason: "missing-pilot" };
  const corporationID = getCurrentCorporationID(bot);
  const record = getStipend(corporationID, bot.characterID);
  if (!record || record.stipend.status !== "funded" ||
      !record.stipend.reservedOperationID) {
    return { released: false, reason: "no-funded-reservation" };
  }
  const previousOperationID = String(record.stipend.reservedOperationID);
  const settled = settleUpgradeReservation(bot, record);
  const released = !settled.stipend.reservedOperationID &&
    settled.stipend.lastUpgradeOperationID === previousOperationID &&
    settled.stipend.lastUpgradeStatus === "superseded-before-market-spend";
  return { released, reason: released ? "proven-no-market-purchase" : "reservation-retained",
    stipend: settled.stipend };
}

function getCombatUpgradeSupport(bot) {
  if (!bot) return null;
  const corporationID = getCurrentCorporationID(bot);
  const qualified = getGrantAndWar(corporationID);
  if (!qualified) return null;
  if (bot.specialty !== "security" &&
      !getWarCombatAssignment(corporationID, bot.characterID, qualified.war.warID)) return null;
  const record = getStipend(corporationID, bot.characterID);
  if (!record || record.stipend.status !== "funded") return null;
  const settled = settleUpgradeReservation(bot, record);
  const stipend = settled.stipend;
  if (stipend.legacyDuplicateRefund && stipend.legacyDuplicateRefund.status !== "refunded") return null;
  const reserved = Number(stipend.reservedAmount) || 0;
  const remainingBudget = Math.max(0, (Number(stipend.amount) || 0) -
    (Number(stipend.spent) || 0) - reserved);
  return remainingBudget > 0 ? {
    supportID: String(stipend.idempotencyKey),
    warID: Number(stipend.warID),
    corporationID,
    availableBudget: remainingBudget,
  } : null;
}

function reserveCombatUpgrade(bot, operation, supportID, maxSpend) {
  const support = getCombatUpgradeSupport(bot);
  if (!support || support.supportID !== String(supportID)) {
    return { success: false, error: "No active first-war ship budget is available." };
  }
  const spend = Math.round(Number(maxSpend) * 100) / 100;
  if (!(spend > 0) || spend > support.availableBudget + 0.0001) {
    return { success: false, error: "The requested ship upgrade exceeds the remaining first-war budget." };
  }
  const record = getStipend(support.corporationID, bot.characterID);
  if (!record || record.stipend.status !== "funded" || record.stipend.reservedOperationID) {
    return { success: false, error: "The first-war ship budget is already reserved." };
  }
  record.stipend.reservedOperationID = String(operation.operationID);
  record.stipend.reservedAmount = spend;
  record.stipend.reservedAt = new Date().toISOString();
  const wallet = require("../account/walletState");
  const transactions = typeof wallet.getCharacterMarketTransactions === "function"
    ? wallet.getCharacterMarketTransactions(bot.characterID)
    : [];
  record.stipend.reservedMarketTransactionID = (Array.isArray(transactions) ? transactions : [])
    .reduce((highest, transaction) =>
      Math.max(highest, Number(transaction && transaction.transactionID) || 0), 0);
  record.stipend.updatedAt = new Date().toISOString();
  saveState(record.state);
  return { success: true, supportID: support.supportID, reservedAmount: spend };
}

function journalTimeMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 100_000_000_000_000_000) {
    // Eve wallet journals store Windows FILETIME in 100ns ticks.
    return numeric / 10_000 - 11_644_473_600_000;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function inspectLegacyStipendTransfer(corporationID, characterID, stipend) {
  const amount = Number(stipend && stipend.amount) || 0;
  const createdAt = Date.parse(String(stipend && stipend.createdAt || ""));
  if (!(amount > 0) || !Number.isFinite(createdAt)) {
    return { status: "absent", completedPairs: 0, debitCount: 0, creditCount: 0 };
  }
  const description = `Corporation wallet transfer to ${Number(characterID)}`;
  const corporationWallet = require("../corporation/corpWalletState");
  const characterWallet = require("../account/walletState");
  const corporationEntries = corporationWallet.getCorporationWalletJournal(corporationID, {
    accountKey: corporationWallet.CORPORATION_WALLET_KEY_START,
  });
  const characterEntries = characterWallet.getCharacterWalletJournal(characterID);
  const afterStipendCreated = (entry) => journalTimeMs(entry && entry.transactionDate) >= createdAt - 5_000;
  const corporationDebits = corporationEntries.filter((entry) =>
    Number(entry.ownerID1) === Number(corporationID) &&
    Number(entry.ownerID2) === Number(characterID) &&
    Math.abs(Number(entry.amount) + amount) < 0.01 &&
    String(entry.description || "") === description && afterStipendCreated(entry));
  const characterCredits = characterEntries.filter((entry) =>
    Number(entry.ownerID1) === Number(corporationID) &&
    Number(entry.ownerID2) === Number(characterID) &&
    Math.abs(Number(entry.amount) - amount) < 0.01 &&
    String(entry.description || "") === description && afterStipendCreated(entry));
  const completedPairs = Math.min(corporationDebits.length, characterCredits.length);
  if (corporationDebits.length !== characterCredits.length) {
    return { status: "partial", completedPairs, debitCount: corporationDebits.length,
      creditCount: characterCredits.length };
  }
  return { status: completedPairs > 0 ? "completed" : "absent", completedPairs,
    debitCount: corporationDebits.length, creditCount: characterCredits.length };
}

async function reconcileLegacyStipendPayments(corporationID, warID, bots = botRoster()) {
  let state = readState();
  let entry = getCorporationEntry(state, corporationID);
  if (!entry || !entry.combatStipends) return 0;
  const botByID = new Map(bots.map((bot) => [Number(bot.characterID), bot]));
  let reconciled = 0;
  for (const [characterKey, initial] of Object.entries(entry.combatStipends)) {
    if (!initial || Number(initial.warID) !== Number(warID)) continue;
    const characterID = positiveID(initial.characterID || characterKey);
    if (!characterID) continue;
    let stipend = entry.combatStipends[characterKey];
    if (["funding", "pending"].includes(stipend.status) && !stipend.legacyTransferReviewRequired) {
      const transfer = inspectLegacyStipendTransfer(corporationID, characterID, stipend);
      if (transfer.status === "completed") {
        stipend.status = "funded";
        stipend.fundedAt = stipend.fundedAt || new Date().toISOString();
        stipend.legacyTransferReconciledAt = stipend.fundedAt;
        stipend.legacyTransferCount = transfer.completedPairs;
        stipend.lastError = null;
        const duplicateCount = Math.max(0, transfer.completedPairs - 1);
        if (duplicateCount > 0 && !stipend.legacyDuplicateRefund) {
          stipend.legacyDuplicateRefund = {
            status: "pending",
            amount: Math.round(duplicateCount * Number(stipend.amount) * 100) / 100,
            transferCount: duplicateCount,
            idempotencyKey: `playerbot:war-stipend-duplicate-refund:${corporationID}:${warID}:${characterID}`,
            createdAt: new Date().toISOString(),
          };
        }
        saveState(state);
        reconciled += 1;
        log.info(`[PlayerBots] Reconciled first-war ship budget corp=${corporationID} char=${characterID} war=${warID} paidTransfers=${transfer.completedPairs}.`);
      } else if (transfer.status === "partial") {
        stipend.legacyTransferReviewRequired = true;
        stipend.lastError = "LEGACY_TRANSFER_PARTIAL_REQUIRES_REVIEW";
        saveState(state);
        log.warn(`[PlayerBots] First-war ship budget requires wallet review corp=${corporationID} char=${characterID} war=${warID}; debit/credit journal counts differ, so no automatic retry will run.`);
      }
    }

    stipend = entry.combatStipends[characterKey];
    const refund = stipend && stipend.legacyDuplicateRefund;
    if (stipend.status !== "funded" || !refund || refund.status !== "pending") continue;
    const bot = botByID.get(characterID);
    const session = bot && require("./playerBotSpaceRuntime").getActorSession(bot);
    if (!session || !(Number(refund.amount) > 0)) {
      refund.lastError = "no-persisted-pilot-session-for-duplicate-refund";
      refund.lastAttemptAt = new Date().toISOString();
      saveState(state);
      continue;
    }
    try {
      const result = await new (require("../account/accountService"))()
        .Handle_GiveCash(
          [Number(corporationID), Number(refund.amount)],
          session,
          {
            reason: `Return duplicate ship stipend for war ${warID}`,
            toAccountKey: require("../corporation/corpWalletState").CORPORATION_WALLET_KEY_START,
            idempotencyKey: refund.idempotencyKey,
          },
        );
      const confirmed = (result && result.success === true && result.debitPending !== true) ||
        (Array.isArray(result) && result.length === 2 &&
          result.every((balance) => Number.isFinite(balance)));
      if (!confirmed) {
        refund.lastError = String(result && (result.errorMsg || result.debitPending && "debit-pending") || "TRANSFER_UNCONFIRMED").slice(0, 160);
        refund.lastAttemptAt = new Date().toISOString();
        saveState(state);
        continue;
      }
      refund.status = "refunded";
      refund.refundedAt = new Date().toISOString();
      refund.lastError = null;
      saveState(state);
      log.info(`[PlayerBots] Returned duplicate first-war ship stipend to corp=${corporationID} char=${characterID} war=${warID} amount=${refund.amount} ISK through the normal wallet authority.`);
    } catch (error) {
      refund.lastError = String(error && error.message || error).slice(0, 160);
      refund.lastAttemptAt = new Date().toISOString();
      saveState(state);
      log.warn(`[PlayerBots] Duplicate ship stipend return pending corp=${corporationID} char=${characterID} war=${warID}: ${refund.lastError}.`);
    }
  }
  return reconciled;
}

async function fundCombatPilots(corporationID, war, grant, bots = botRoster(), excludedCharacterIDs = new Set()) {
  const id = positiveID(corporationID);
  const warID = positiveID(war && war.warID);
  const wallet = require("../corporation/corpWalletState");
  const characterWallet = require("../account/walletState");
  const walletLimit = Number(require("../account/walletBalanceLimit").MAX_WALLET_BALANCE) || 0;
  const operations = require("./playerBotOperationRuntime");
  await reconcileLegacyStipendPayments(id, warID, bots);
  const candidates = memberSecurityPilots(id, bots, excludedCharacterIDs, warID)
    .filter((bot) => {
      const assignment = bot.specialty === "security"
        ? null
        : getWarCombatAssignment(id, bot.characterID, warID);
      // Cross-trained members need their first-war wallet transfer before the
      // normal skillbook-purchase and training authorities can make them
      // eligible for a ship upgrade. This is the same capped, durable ship
      // stipend; it is not an extra payment or a direct skill grant.
      const waitingForTrainingFunds = assignment &&
        ["training", "training-pending"].includes(assignment.status) &&
        (Array.isArray(assignment.requiredSkills) && assignment.requiredSkills.length > 0 ||
          String(assignment.lastError || "").includes("NotEnoughMoney"));
      if (waitingForTrainingFunds) return true;
      const balance = Number(characterWallet.getCharacterWallet(bot.characterID)?.balance) || 0;
      return operations.nextShipUpgrade(bot, "security", {
        balanceOverride: Math.min(walletLimit, balance + MAX_PILOT_STIPEND_ISK),
      });
    })
    // Spend the deployment budget on pilots missing a viable ship fit first;
    // already-fitted veterans can use the usual economy ladder afterward.
    .sort((left, right) => Number(operations.hasRoleShipFit(left, "security")) -
      Number(operations.hasRoleShipFit(right, "security")) || Number(left.characterID) - Number(right.characterID))
    .slice(0, MAX_FUNDED_COMBAT_PILOTS);
  if (!candidates.length) return { funded: 0, waitingForCombatPilots: true };

  let state = readState();
  let corpEntry = getCorporationEntry(state, id, true);
  corpEntry.combatStipends = corpEntry.combatStipends || {};
  const paidOrReserved = Object.values(corpEntry.combatStipends)
    .filter((stipend) => stipend && Number(stipend.warID) === warID &&
      ["funding", "pending", "funded"].includes(stipend.status))
    .reduce((total, stipend) => total + (Number(stipend.amount) || 0), 0);
  let distributable = Math.max(0, FIRST_WAR_GRANT_ISK - WAR_GRANT_RESERVE_ISK - paidOrReserved);
  let funded = 0;
  for (const bot of candidates) {
    state = readState();
    corpEntry = getCorporationEntry(state, id, true);
    corpEntry.combatStipends = corpEntry.combatStipends || {};
    const key = String(bot.characterID);
    let stipend = corpEntry.combatStipends[key];
    if (stipend && Number(stipend.warID) === warID && stipend.status === "funded") continue;
    if (stipend && Number(stipend.warID) === warID && ["funding", "pending"].includes(stipend.status)) {
      // Any old transfer is reconciled before candidate selection. Only a
      // missing wallet entry reaches this idempotent retry path.
      if (stipend.legacyTransferReviewRequired) continue;
    } else {
      const currentPaid = Object.values(corpEntry.combatStipends)
        .filter((entry) => entry && Number(entry.warID) === warID && ["funding", "pending", "funded"].includes(entry.status))
        .reduce((total, entry) => total + (Number(entry.amount) || 0), 0);
      const room = Math.max(0, FIRST_WAR_GRANT_ISK - WAR_GRANT_RESERVE_ISK - currentPaid);
      const personalBalance = Number(characterWallet.getCharacterWallet(bot.characterID)?.balance) || 0;
      const characterRoom = Math.max(0, walletLimit - personalBalance);
      const amount = Math.min(MAX_PILOT_STIPEND_ISK, room, characterRoom);
      if (amount < 60_000_000) continue;
      stipend = {
        corporationID: id,
        characterID: Number(bot.characterID),
        warID,
        amount,
        spent: 0,
        status: "funding",
        idempotencyKey: `playerbot:war-stipend:${id}:${warID}:${bot.characterID}`,
        createdAt: new Date().toISOString(),
      };
      corpEntry.combatStipends[key] = stipend;
      corpEntry.firstWarGrant.distributedAmount = currentPaid + amount;
      corpEntry.firstWarGrant.lastDistributionAt = new Date().toISOString();
      saveState(state);
      distributable = room - amount;
    }
    if (!stipend || !["funding", "pending"].includes(stipend.status)) continue;
    const recruiter = findCorpRecruiter(id, bots);
    if (!recruiter) {
      stipend.status = "pending";
      stipend.lastError = "no-persisted-corporation-wallet-director";
      saveState(state);
      continue;
    }
    try {
      const result = await new (require("../account/accountService"))()
        .Handle_GiveCashFromCorpAccount(
          [Number(bot.characterID), Number(stipend.amount), wallet.CORPORATION_WALLET_KEY_START],
          recruiter.session,
          {
            reason: `First-war ship budget for war ${warID}`,
            idempotencyKey: stipend.idempotencyKey,
          },
        );
      if (!result || result.success !== true || result.debitPending === true) {
        const latest = readState();
        const latestStipend = getCorporationEntry(latest, id, true).combatStipends[key];
        latestStipend.status = "pending";
        latestStipend.lastError = String(result && (result.errorMsg || result.debitPending && "debit-pending") || "TRANSFER_UNCONFIRMED").slice(0, 160);
        saveState(latest);
        continue;
      }
      const latest = readState();
      const latestStipend = getCorporationEntry(latest, id, true).combatStipends[key];
      latestStipend.status = "funded";
      latestStipend.fundedAt = new Date().toISOString();
      latestStipend.lastError = null;
      saveState(latest);
      funded += 1;
      log.info(`[PlayerBots] War ship budget transferred corp=${id} char=${bot.characterID} war=${warID} amount=${latestStipend.amount} ISK.`);
    } catch (error) {
      const latest = readState();
      const latestStipend = getCorporationEntry(latest, id, true).combatStipends[key];
      latestStipend.status = "pending";
      latestStipend.lastError = String(error && error.message || error).slice(0, 160);
      latestStipend.lastAttemptAt = new Date().toISOString();
      saveState(latest);
      log.warn(`[PlayerBots] War ship budget transfer pending corp=${id} char=${bot.characterID} war=${warID}: ${latestStipend.lastError}.`);
    }
  }
  return { funded, distributable: Math.max(0, distributable) };
}

async function runFirstWarMobilization(options = {}) {
  const grants = await processFirstWarGrants();
  let bots = botRoster();
  const excluded = options.humanControlledBotIDs instanceof Set ? options.humanControlledBotIDs : new Set();
  const botCorporationIDs = new Set(bots
    .filter((bot) => bot && !excluded.has(Number(bot.characterID)))
    .map((bot) => getCurrentCorporationID(bot))
    .filter(Boolean));
  const activeWars = listActiveBotWars(bots, excluded);
  let recruitedPilots = 0;
  let mobilizedPilots = 0;
  for (const war of activeWars.values()) {
    for (const corporationID of [positiveID(war.declaredByID), positiveID(war.againstID)]) {
      if (!botCorporationIDs.has(corporationID)) continue;
      const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
      if (corporation.isNPC === true) continue;
      try {
        const recruitment = await ensureCorpCombatPilots(
          corporationID,
          bots,
          TARGET_COMBAT_PILOTS_PER_WAR_CORP,
          excluded,
          war.warID,
        );
        recruitedPilots += (recruitment.recruited || []).length;
        mobilizedPilots += (recruitment.mobilized || []).length;
        if ((recruitment.recruited || []).length) bots = botRoster();
        if (!recruitment.success) {
          log.info(`[PlayerBots] War mobilization is building corp=${corporationID} security roster (${recruitment.combatPilots}/${TARGET_COMBAT_PILOTS_PER_WAR_CORP}); the war remains in its normal lifecycle.`);
        }
      } catch (error) {
        log.warn(`[PlayerBots] War recruitment deferred corp=${corporationID}: ${String(error && error.message || error).slice(0, 180)}.`);
      }
    }
  }
  let fundedPilots = 0;
  const state = readState();
  for (const entry of Object.values(state.corporations)) {
    const grant = entry && entry.firstWarGrant;
    if (!grant || grant.status !== "granted") continue;
    const war = resolveGrantWar(entry.corporationID, grant);
    if (!war || war.timeFinished) continue;
    const result = await fundCombatPilots(entry.corporationID, war, grant, bots, excluded);
    fundedPilots += Number(result.funded) || 0;
  }
  return { grants, recruitedPilots, mobilizedPilots, fundedPilots };
}

function processFirstWarMobilization(options = {}) {
  const next = mobilizationQueue.then(() => runFirstWarMobilization(options));
  mobilizationQueue = next.catch(() => {});
  return next;
}

function getStatusSummary() {
  const state = readState();
  const activeWarIDs = new Set([...listActiveBotWars().keys()]);
  let grants = 0;
  let pendingGrants = 0;
  let fundedPilots = 0;
  let pendingStipends = 0;
  let pendingRecruitments = 0;
  let recruitedPilots = 0;
  let mobilizedPilots = 0;
  let trainingWarPilots = 0;
  for (const entry of Object.values(state.corporations)) {
    const grant = entry && entry.firstWarGrant;
    const war = grant && resolveGrantWar(entry.corporationID, grant);
    const active = Boolean(war && !war.timeFinished && activeWarIDs.has(Number(war.warID)));
    if (grant && grant.status === "granted") grants += 1;
    if (grant && ["armed", "crediting", "pending-credit"].includes(grant.status)) pendingGrants += 1;
    for (const stipend of Object.values(entry && entry.combatStipends || {})) {
      if (active && stipend && stipend.status === "funded") {
        fundedPilots += 1;
        if (stipend.legacyDuplicateRefund && stipend.legacyDuplicateRefund.status !== "refunded") pendingStipends += 1;
      } else if (active && stipend && ["funding", "pending"].includes(stipend.status)) pendingStipends += 1;
    }
    for (const recruitment of Object.values(entry && entry.recruitments || {})) {
      if (!recruitment) continue;
      if (recruitment.status === "joined") recruitedPilots += 1;
      else if (["inviting", "pending"].includes(recruitment.status)) pendingRecruitments += 1;
    }
    for (const assignment of Object.values(entry && entry.warCombatAssignments || {})) {
      if (!assignment || !activeWarIDs.has(Number(assignment.warID))) continue;
      mobilizedPilots += 1;
      if (["training", "training-pending"].includes(assignment.status)) trainingWarPilots += 1;
    }
  }
  return { activeWarCount: activeWarIDs.size, grants, pendingGrants, fundedPilots,
    pendingStipends, pendingRecruitments, recruitedPilots, mobilizedPilots, trainingWarPilots };
}

function _testingState() {
  return readState();
}

module.exports = {
  FIRST_WAR_GRANT_ISK,
  MAX_PILOT_STIPEND_ISK,
  MAX_FUNDED_COMBAT_PILOTS,
  TARGET_COMBAT_PILOTS_PER_WAR_CORP,
  MIN_SOURCE_COMBAT_PILOTS,
  configuredTestCorporationID,
  qualifiesForFirstWarGrant,
  prepareWarDeclaration,
  processFirstWarGrants,
  processFirstWarMobilization,
  getStatusSummary,
  ensureCorpCombatPilots,
  getActiveWarCombatAssignment,
  getCombatUpgradeSupport,
  reconcileOrphanedUpgradeReservation,
  reserveCombatUpgrade,
  _testing: { readState, saveState, activeMembers, findWarFor, warIsOngoing, findOpenInvitation,
    canLeaveSource, memberSecurityBots, memberSecurityPilots, fundCombatPilots,
    getWarCombatAssignment, queueWarCombatTraining, assignOwnCorpWarCombatPilots,
    formatWarTrainingError, journalTimeMs, inspectLegacyStipendTransfer, reconcileLegacyStipendPayments },
};

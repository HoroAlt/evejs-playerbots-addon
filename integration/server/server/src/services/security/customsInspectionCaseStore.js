"use strict";

const { cloneValue } = require("../../common/clone");
const database = require("../../gameStore");
const { createTableRepository } = require("../../gameStore/tableRepository");
const repository = createTableRepository("service:security", { strict: true });
const TABLE_NAME = "customsInspectionCases";
const TERMINAL_STATES = new Set([
  "ineligible", "not-selected", "clean", "surrendered", "evaded", "destroyed", "expired",
]);
let caseIndexByID = null;
let caseIDsByCharacterID = null;
let activeCaseIDs = null;

function readCachedRoot() {
  database.ensureTable(TABLE_NAME);
  const result = repository.read(TABLE_NAME, "/");
  if (!result || !result.success) throw new Error("CUSTOMS_CASE_READ_FAILED");
  return result.data && result.data.byCaseID || {};
}

function getCase(caseID) {
  const record = readCachedRoot()[String(caseID)];
  return record ? cloneValue(record) : null;
}

function removeCaseIndexEntry(caseID) {
  const previous = caseIndexByID.get(caseID);
  if (!previous) return;
  const characterCases = caseIDsByCharacterID.get(previous.characterID);
  characterCases?.delete(caseID);
  if (characterCases?.size === 0) caseIDsByCharacterID.delete(previous.characterID);
  if (previous.active) activeCaseIDs.delete(caseID);
  caseIndexByID.delete(caseID);
}

function addCaseIndexEntry(caseID, record) {
  const characterID = Number.isSafeInteger(record?.characterID) ? record.characterID : 0;
  const active = !TERMINAL_STATES.has(record?.state);
  caseIndexByID.set(caseID, { characterID, active });
  let characterCases = caseIDsByCharacterID.get(characterID);
  if (!characterCases) caseIDsByCharacterID.set(characterID, characterCases = new Set());
  characterCases.add(caseID);
  if (active) activeCaseIDs.add(caseID);
}

function ensureCaseIndex(cases) {
  if (caseIndexByID) return;
  caseIndexByID = new Map();
  caseIDsByCharacterID = new Map();
  activeCaseIDs = new Set();
  for (const [caseID, record] of Object.entries(cases)) addCaseIndexEntry(caseID, record);
}

function listCases({ characterID, activeOnly = false } = {}) {
  const cases = readCachedRoot();
  ensureCaseIndex(cases);
  const filterCharacter = Boolean(characterID);
  const characterKey = Number(characterID);
  const candidates = filterCharacter
    ? caseIDsByCharacterID.get(characterKey) || []
    : activeOnly ? activeCaseIDs : Object.keys(cases);
  const selected = [];
  for (const caseID of candidates) {
    if (activeOnly && !activeCaseIDs.has(caseID)) continue;
    const record = cases[caseID];
    if (record) selected.push(cloneValue(record));
  }
  return selected;
}

function saveCase(record) {
  if (!record || !record.caseID) throw new Error("CUSTOMS_CASE_ID_REQUIRED");
  const caseID = String(record.caseID);
  // Only the root map needs a shallow copy: records are immutable snapshots
  // here, and the new record is cloned before it is installed. Deep-cloning
  // every historical customs case for each new or updated case is wasteful.
  const root = { ...readCachedRoot() };
  root[caseID] = cloneValue(record);
  const written = repository.write(TABLE_NAME, "/", { version: 1, byCaseID: root });
  if (!written || !written.success) throw new Error("CUSTOMS_CASE_WRITE_FAILED");
  if (caseIndexByID) {
    removeCaseIndexEntry(caseID);
    addCaseIndexEntry(caseID, root[caseID]);
  }
  const flushed = database.flushTableSync(TABLE_NAME);
  if (!flushed || !flushed.success) throw new Error("CUSTOMS_CASE_FLUSH_FAILED");
  return cloneValue(record);
}

module.exports = { TABLE_NAME, TERMINAL_STATES, getCase, listCases, saveCase };

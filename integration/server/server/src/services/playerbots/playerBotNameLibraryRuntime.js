"use strict";

const fs = require("node:fs");
const path = require("node:path");
const EMPIRES = Object.freeze({ 1: "caldari", 2: "minmatar", 4: "amarr", 8: "gallente" });
const KEYS = ["amarr", "caldari", "gallente", "minmatar"];

function emptyLibrary() {
  return Object.fromEntries(KEYS.map((key) => [key, { corporations: [], alliances: [] }]));
}

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parseText(text) {
  if (typeof text !== "string") throw invalid("Name library text must be a string.");
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { throw invalid(`Invalid JSON: ${error.message}`); }
  function fields(object, expected, location) {
    if (!object || typeof object !== "object" || Array.isArray(object)) throw invalid(`${location} must be an object.`);
    for (const key of expected) if (!Object.hasOwn(object, key)) throw invalid(`${location}.${key} is required.`);
    for (const key of Object.keys(object)) if (!expected.includes(key)) throw invalid(`${location}.${key} is not a template field.`);
  }
  fields(value, KEYS, "library");
  const result = emptyLibrary();
  for (const empire of KEYS) {
    fields(value[empire], ["corporations", "alliances"], empire);
    for (const type of ["corporations", "alliances"]) {
      const names = value[empire][type];
      if (!Array.isArray(names)) throw invalid(`${empire}.${type} must be an array.`);
      result[empire][type] = names.map((name, index) => {
        if (typeof name !== "string" || !name.trim() || !/^[\x20-\x7E]+$/.test(name)) {
          throw invalid(`${empire}.${type}[${index}] must be a non-empty ASCII name.`);
        }
        // The client shows at most 50 characters for corporation and alliance names.
        if (name.trim().length > 50) throw invalid(`${empire}.${type}[${index}] is longer than 50 characters.`);
        return name.trim();
      });
    }
  }
  return result;
}

// Matches EveJS's natural abbreviation for names made of English words.
function naturalTicker(name) {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/);
  const initials = words.map((word) => word[0] || "").join("").toUpperCase().slice(0, 5);
  if (/^[A-Z]{2,5}$/.test(initials)) return initials;
  return name.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 5);
}

function createNameLibrary(options = {}) {
  const io = options.fs || fs;
  const file = options.file || path.join(require("../../gameStore/storeRoot").resolveStoreRoot(), "playerbots-name-library.json");
  let current = null;
  let warning = "";
  const reported = new Set();
  function load() {
    if (current) return current;
    current = emptyLibrary();
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(io.readFileSync(file));
      current = parseText(text);
    } catch (error) {
      if (error.code !== "ENOENT") warning = "Could not load the name library. Original naming is active; the file was not replaced.";
    }
    return current;
  }
  function getStatus() {
    return { text: JSON.stringify(load(), null, 2) + "\n", warning };
  }
  function saveText(text) {
    const value = parseText(text);
    const serialized = JSON.stringify(value, null, 2) + "\n";
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      io.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      io.renameSync(temporary, file);
    } catch {
      try { io.unlinkSync(temporary); } catch { /* No temporary file, or leave it for filesystem recovery. */ }
      throw new Error("Could not save the name library. Your previous library is still active.");
    }
    current = value;
    warning = "";
    reported.clear();
    return { text: serialized, message: "Saved. Applies to newly created corporations and alliances." };
  }
  function chooseName(raceID, type, authority) {
    const empire = EMPIRES[Number(raceID)];
    const names = load()[empire]?.[type];
    if (!Array.isArray(names) || !names.length) return null;
    const corporations = authority || require("../corporation/corporationState");
    for (const name of names) {
      const ticker = naturalTicker(name);
      if (!/^[A-Z]{2,5}$/.test(ticker)) continue;
      if (corporations.findCorporationByName(name) || corporations.findAllianceByExactName(name) ||
          corporations.findCorporationByTickerName(ticker) || corporations.findAllianceByShortName(ticker)) continue;
      return { name, ticker };
    }
    throw new Error(`No unused ${type === "corporations" ? "corporation" : "alliance"} names remain for ${empire}.`);
  }
  function reportOnce(error) {
    const message = String(error.message || error);
    if (reported.has(message)) return;
    reported.add(message);
    (options.warn || ((text) => require("../../utils/logger").warn(`[PlayerBotsNames] ${text}`)))(message);
  }
  return { getStatus, saveText, chooseName, reportOnce };
}

let runtime;
function getRuntime() { return runtime || (runtime = createNameLibrary()); }

module.exports = { createNameLibrary, emptyLibrary, naturalTicker, parseText, getRuntime };

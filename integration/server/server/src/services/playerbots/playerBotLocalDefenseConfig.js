"use strict";
const defaults = Object.freeze({
  enabled: false,
  aggressive: false,
  miningRescue: true,
  generalRescue: true,
  systemIDs: [],
  responderIDs: [],
  agreements: [],
  perIncident: 2,
  systemLimit: 4,
  globalLimit: 4,
  playerReserve: 2,
  policy: {},
});
const ids = (values) =>
  Array.isArray(values) &&
  new Set(values).size === values.length &&
  values.every((v) => Number.isSafeInteger(v) && v > 0);
function validate(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !Object.hasOwn(defaults, key))
  )
    throw new Error("INVALID_LOCAL_DEFENSE_CONFIG");
  const next = { ...defaults, ...value };
  next.policy = require("./playerBotDefensePolicy").parameters(next.policy);
  if (
    typeof next.enabled !== "boolean" ||
    typeof next.aggressive !== "boolean" ||
    typeof next.miningRescue !== "boolean" ||
    typeof next.generalRescue !== "boolean" ||
    !ids(next.systemIDs) ||
    !ids(next.responderIDs) ||
    !Array.isArray(next.agreements) ||
    next.agreements.some(
      (pair) => !ids(pair) || pair.length !== 2 || pair[0] === pair[1],
    )
  )
    throw new Error("INVALID_LOCAL_DEFENSE_MEMBERSHIP");
  for (const [key, max] of [
    ["perIncident", 5],
    ["systemLimit", 8],
    ["globalLimit", 12],
  ])
    if (!Number.isInteger(next[key]) || next[key] < 1 || next[key] > max)
      throw new Error("INVALID_LOCAL_DEFENSE_LIMIT");
  if (
    !Number.isInteger(next.playerReserve) ||
    next.playerReserve < 1 ||
    next.playerReserve > 4
  )
    throw new Error("INVALID_PLAYER_RESERVE");
  return JSON.parse(JSON.stringify(next));
}
function repo() {
  return require("../../gameStore/tableRepository").createTableRepository(
    "service:playerbots",
    { strict: true },
  );
}
function get() {
  const stored = repo().read("playerBots", "/_localDefenseSettings");
  return validate((stored.success && stored.data) || {});
}
function set(value) {
  const next = validate(value),
    r = repo();
  r.ensureTable("playerBots");
  const result = r.write("playerBots", "/_localDefenseSettings", next);
  if (!result.success) throw new Error("DEFENSE_CONFIG_WRITE_FAILED");
  if (!r.flushTableSync("playerBots")?.success)
    throw new Error("DEFENSE_CONFIG_FLUSH_FAILED");
  return next;
}
module.exports = { get, set, validate };

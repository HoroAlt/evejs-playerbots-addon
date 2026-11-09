"use strict";

const pirateFactionPolicy = require("../../space/npc/pirateFactionPolicy");

const EMPIRE_PIRATE_FACTION_IDS = new Set([500001, 500002, 500004, 500007, 500008]);

function positiveID(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function resolveEntityCharacterID(entity) {
  return positiveID(
    entity && entity.session && entity.session.characterID ||
    entity && (entity.controllerOwnerID ?? entity.ownerID ?? entity.pilotCharacterID ?? entity.characterID),
  );
}

function isPirateNpc(entity) {
  if (!entity || String(entity.kind || "").toLowerCase() !== "ship" ||
      String(entity.npcEntityType || "").toLowerCase() !== "npc") return false;
  // Live NPC ship identities publish their faction through warFactionID.
  const factionID = positiveID(entity.factionID || entity.warFactionID);
  if (pirateFactionPolicy.PIRATE_FACTION_BY_FACTION_ID[factionID] ||
      EMPIRE_PIRATE_FACTION_IDS.has(factionID)) return true;
  const factionKey = pirateFactionPolicy._testing.classifyTextFaction(
    [entity.factionKey, entity.factionName, entity.itemName, entity.name].filter(Boolean).join(" "),
  );
  return Boolean(factionKey && pirateFactionPolicy.isSupportedLocalPirateFactionKey(factionKey));
}

function countNearbyPirateNpcs(entities, origin, radiusMeters) {
  const radius = Number(radiusMeters);
  if (!origin || !Number.isFinite(radius) || radius < 0) return 0;
  const originX = Number(origin.x);
  const originY = Number(origin.y);
  const originZ = Number(origin.z);
  if (![originX, originY, originZ].every(Number.isFinite)) return 0;
  let count = 0;
  for (const entity of entities || []) {
    if (!isPirateNpc(entity) || !entity.position) continue;
    const dx = Number(entity.position.x) - originX;
    const dy = Number(entity.position.y) - originY;
    const dz = Number(entity.position.z) - originZ;
    if (![dx, dy, dz].every(Number.isFinite)) continue;
    const surfaceDistance = Math.max(0, Math.hypot(dx, dy, dz) - Math.max(0, Number(entity.radius) || 0));
    if (surfaceDistance <= radius) count += 1;
  }
  return count;
}

function isEligiblePiracyTarget(entity, context = {}) {
  if (!entity || String(entity.kind || "").toLowerCase() !== "ship" || entity.session == null) return false;
  const targetCharacterID = resolveEntityCharacterID(entity);
  const botCharacterID = positiveID(context.characterID);
  if (!targetCharacterID || targetCharacterID === botCharacterID ||
      positiveID(entity.typeID) === positiveID(context.capsuleTypeID || 670)) return false;

  const corporationID = positiveID(entity.corporationID || entity.corpID);
  const allianceID = positiveID(entity.allianceID);
  if (corporationID && corporationID === positiveID(context.corporationID)) return false;
  if (allianceID && allianceID === positiveID(context.allianceID)) return false;
  if (typeof context.isManagedBot === "function" && context.isManagedBot(targetCharacterID)) return false;
  if (typeof context.isFleetMate === "function" && context.isFleetMate(targetCharacterID)) return false;
  if (typeof context.hasCargo !== "function" || context.hasCargo(entity) !== true) return false;

  const systemSecurity = Number(context.systemSecurity);
  const specialSpace = context.specialSpace === true;
  if (Number.isFinite(systemSecurity) && systemSecurity <= 0 && !specialSpace) return true;

  const status = Number(typeof context.securityStatusFor === "function"
    ? context.securityStatusFor(targetCharacterID) : 0);
  const outlaw = Number.isFinite(status) && status <= -5;
  const suspect = typeof context.isSuspect === "function" && context.isSuspect(targetCharacterID) === true;
  const criminal = typeof context.isCriminal === "function" && context.isCriminal(targetCharacterID) === true;
  const warTarget = typeof context.isWarTarget === "function" && context.isWarTarget(targetCharacterID) === true;
  const limitedEngagement = typeof context.hasLimitedEngagement === "function" &&
    context.hasLimitedEngagement(targetCharacterID) === true;
  return outlaw || suspect || criminal || warTarget || limitedEngagement;
}

function isEligibleWarTarget(entity, context = {}) {
  if (!entity || String(entity.kind || "").toLowerCase() !== "ship" || entity.session == null) return false;
  const characterID = resolveEntityCharacterID(entity);
  if (!characterID || characterID === positiveID(context.characterID) ||
      positiveID(entity.typeID) === positiveID(context.capsuleTypeID || 670)) return false;
  const corporationID = positiveID(entity.corporationID || entity.corpID);
  const allianceID = positiveID(entity.allianceID);
  if (corporationID && corporationID === positiveID(context.corporationID)) return false;
  if (allianceID && allianceID === positiveID(context.allianceID)) return false;
  if (typeof context.isManagedBot === "function" && context.isManagedBot(characterID)) return false;
  if (typeof context.isFleetMate === "function" && context.isFleetMate(characterID)) return false;
  return typeof context.isWarTarget === "function" && context.isWarTarget(characterID) === true;
}

function isEligibleNullsecConflictTarget(entity, context = {}) {
  if (!entity || String(entity.kind || "").toLowerCase() !== "ship" || entity.session == null) return false;
  const characterID = resolveEntityCharacterID(entity);
  if (!characterID || characterID === positiveID(context.characterID) ||
      positiveID(entity.typeID) === positiveID(context.capsuleTypeID || 670)) return false;
  const systemSecurity = Number(context.systemSecurity);
  if (!Number.isFinite(systemSecurity) || systemSecurity > 0 || context.specialSpace === true) return false;
  if (typeof context.isFleetMate === "function" && context.isFleetMate(characterID)) return false;
  if (typeof context.isNullsecConflictTarget !== "function" || context.isNullsecConflictTarget(entity) !== true) return false;
  // Managed bots are normally protected from friendly fire. A live structure
  // rivalry is the narrow exception; the callback above confirms both corps
  // have deployed in this system and do not share an alliance.
  return true;
}

function isEligibleDefensiveTarget(entity, context = {}) {
  if (!entity || String(entity.kind || "").toLowerCase() !== "ship" || entity.session == null) return false;
  const characterID = resolveEntityCharacterID(entity);
  if (!characterID || characterID === positiveID(context.characterID) ||
      positiveID(entity.typeID) === positiveID(context.capsuleTypeID || 670)) return false;
  const corporationID = positiveID(entity.corporationID || entity.corpID || entity.session.corporationID);
  const allianceID = positiveID(entity.allianceID || entity.session.allianceID);
  if (corporationID && corporationID === positiveID(context.corporationID)) return false;
  if (allianceID && allianceID === positiveID(context.allianceID)) return false;
  if (typeof context.isManagedBot === "function" && context.isManagedBot(characterID)) return false;
  if (typeof context.isFleetMate === "function" && context.isFleetMate(characterID)) return false;

  const security = Number(context.systemSecurity);
  const nullsecConflict = typeof context.isNullsecConflictTarget === "function" &&
    context.isNullsecConflictTarget(entity) === true;
  if (nullsecConflict) return true;
  if (Number.isFinite(security) && security <= 0 && context.specialSpace !== true) return true;

  const status = Number(typeof context.securityStatusFor === "function"
    ? context.securityStatusFor(characterID) : 0);
  return (Number.isFinite(status) && status <= -5) ||
    (typeof context.isSuspect === "function" && context.isSuspect(characterID) === true) ||
    (typeof context.isCriminal === "function" && context.isCriminal(characterID) === true) ||
    (typeof context.isWarTarget === "function" && context.isWarTarget(characterID) === true) ||
    (typeof context.hasLimitedEngagement === "function" && context.hasLimitedEngagement(characterID) === true);
}

function selectCombatTarget(entities = [], mode = "security", context = {}) {
  const candidates = (Array.isArray(entities) ? entities : [...(entities || [])])
    .filter((entity) => entity && positiveID(entity.itemID) > 0 && entity.position);
  const pirateNpcs = candidates.filter(isPirateNpc);
  const playerTargets = mode === "piracy"
    ? candidates.filter((entity) => isEligiblePiracyTarget(entity, context))
    : mode === "war"
      ? candidates.filter((entity) => isEligibleWarTarget(entity, context))
      : mode === "nullsec-conflict"
        ? candidates.filter((entity) => isEligibleNullsecConflictTarget(entity, context))
      : [];
  const preferred = mode === "piracy"
    ? playerTargets.length ? playerTargets : pirateNpcs
    : mode === "war" || mode === "nullsec-conflict" ? playerTargets : pirateNpcs;
  const origin = context.position;
  return preferred.sort((left, right) => {
    const cargoLeft = Number(context.cargoScore && context.cargoScore(left)) || 0;
    const cargoRight = Number(context.cargoScore && context.cargoScore(right)) || 0;
    if (mode === "piracy" && playerTargets.length && cargoLeft !== cargoRight) return cargoRight - cargoLeft;
    const distanceLeft = origin ? Math.hypot(left.position.x - origin.x, left.position.y - origin.y, left.position.z - origin.z) : 0;
    const distanceRight = origin ? Math.hypot(right.position.x - origin.x, right.position.y - origin.y, right.position.z - origin.z) : 0;
    return distanceLeft - distanceRight || positiveID(left.itemID) - positiveID(right.itemID);
  })[0] || null;
}

module.exports = {
  isEligiblePiracyTarget,
  isEligibleDefensiveTarget,
  isEligibleNullsecConflictTarget,
  isEligibleWarTarget,
  isPirateNpc,
  countNearbyPirateNpcs,
  resolveEntityCharacterID,
  selectCombatTarget,
};

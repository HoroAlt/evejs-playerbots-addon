"use strict";

// Deterministic combat policy. This consumes authoritative site, Dogma and
// space-state snapshots; it never creates synthetic damage or completion.

const FACTION_DOCTRINES = Object.freeze({
  angel: Object.freeze({ damageTypes: ["explosive", "kinetic"], preferredDroneDamage: "explosive" }),
  blood: Object.freeze({ damageTypes: ["em", "thermal"], preferredDroneDamage: "em" }),
  guristas: Object.freeze({ damageTypes: ["kinetic", "thermal"], preferredDroneDamage: "kinetic" }),
  sansha: Object.freeze({ damageTypes: ["em", "thermal"], preferredDroneDamage: "em" }),
  serpentis: Object.freeze({ damageTypes: ["thermal", "kinetic"], preferredDroneDamage: "thermal" }),
  rogue_drone: Object.freeze({ damageTypes: ["em", "thermal", "kinetic", "explosive"], preferredDroneDamage: "em" }),
});

const MIN_ENGAGE_SHIELD = 0.75;
const MIN_ENGAGE_CAPACITOR = 0.30;
const MIN_SITE_RESIST_BY_TIER = Object.freeze({ 1: 0.15, 2: 0.25, 3: 0.30, 4: 0.35, 5: 0.40 });

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function isPublicCombatAnomaly(instance, template = null) {
  if (!instance || typeof instance !== "object") return false;
  const flags = instance.runtimeFlags || {};
  return flags.universeSeeded === true &&
    flags.missionRuntime !== true &&
    normalized(instance.siteOrigin) === "universe_dungeon" &&
    normalized(instance.siteFamily) === "combat" &&
    normalized(instance.siteKind) === "anomaly" &&
    normalized(instance.lifecycleState) === "active" &&
    number(instance.instanceID) > 0 &&
    number(instance.metadata && instance.metadata.siteID) > 0 &&
    !(template && template.hackingCombatSite === true);
}

function factionDoctrine(site) {
  const key = normalized(site && (site.factionKey || site.siteFactionKey || site.pirateFactionKey));
  if (key.includes("angel")) return FACTION_DOCTRINES.angel;
  if (key.includes("blood")) return FACTION_DOCTRINES.blood;
  if (key.includes("gurista")) return FACTION_DOCTRINES.guristas;
  if (key.includes("sansha")) return FACTION_DOCTRINES.sansha;
  if (key.includes("serpent")) return FACTION_DOCTRINES.serpentis;
  if (key.includes("drone")) return FACTION_DOCTRINES.rogue_drone;
  return null;
}

function summarizeEncounterLoad(populationHints) {
  const encounters = populationHints && Array.isArray(populationHints.encounters)
    ? populationHints.encounters
    : [];
  if (!encounters.length || encounters.some((encounter) => !encounter || encounter.supported === false)) {
    return null;
  }
  let maxWaveHostiles = 0;
  let maxWaveThreatScore = 0;
  let waveCount = encounters.length;
  for (const encounter of encounters) {
    const amount = Number(encounter.amount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    maxWaveHostiles = Math.max(maxWaveHostiles, Math.ceil(amount));
    const hulls = encounter.researchedHullRanges || encounter.hulls || {};
    const hullWeights = { frigate: 1, destroyer: 2, cruiser: 3, battlecruiser: 4, battleship: 6, capital: 20 };
    let profiledHullCount = 0;
    let threatScore = 0;
    for (const [hullClass, range] of Object.entries(hulls)) {
      const weight = hullWeights[normalized(hullClass)];
      if (!weight) continue;
      const rawCount = range && typeof range === "object"
        ? range.max ?? range.min
        : range;
      const count = Math.max(0, Number(rawCount) || 0);
      profiledHullCount += count;
      threatScore += count * weight;
    }
    // Authored amounts can include sentries or site props beyond the ship
    // hull table. Count those conservatively; if there is no hull table, treat
    // each entity as two points rather than trusting the nominal site tier.
    threatScore += profiledHullCount > 0
      ? Math.max(0, Math.ceil(amount) - profiledHullCount) * 2
      : Math.ceil(amount) * 2;
    maxWaveThreatScore = Math.max(maxWaveThreatScore, threatScore);
    waveCount = Math.max(waveCount, Math.trunc(number(encounter.waveIndex, 0)));
  }
  const waveModel = populationHints.waveModel || {};
  waveCount = Math.max(
    waveCount,
    Math.trunc(number(waveModel.guaranteedWaveCount, 0)),
    Math.trunc(number(waveModel.waveCount, 0)),
  );
  if (!maxWaveHostiles || !waveCount) return null;
  return { maxWaveHostiles, maxWaveThreatScore, waveCount };
}

function siteEligibility(site, fit) {
  if (!site || !fit) return { eligible: false, reason: "missing-site-or-fit" };
  if (site.supported !== true) return { eligible: false, reason: "unsupported-site-content" };
  const difficulty = Math.max(1, Math.trunc(number(site.difficulty, 1)));
  if (difficulty > number(fit.maxSiteDifficulty, 0)) {
    return { eligible: false, reason: "site-exceeds-fit-tier", difficulty, maximum: number(fit.maxSiteDifficulty, 0) };
  }
  let encounterLoad = null;
  if (fit.requiresEncounterProfile === true || number(fit.maxWaveHostiles) > 0 || number(fit.maxSiteWaves) > 0) {
    encounterLoad = summarizeEncounterLoad(site.populationHints);
    if (!encounterLoad) return { eligible: false, reason: "site-encounter-load-unknown" };
    if (encounterLoad.maxWaveHostiles > number(fit.maxWaveHostiles, 0) ||
        encounterLoad.maxWaveThreatScore > number(fit.maxWaveThreatScore, 0) ||
        encounterLoad.waveCount > number(fit.maxSiteWaves, 0)) {
      return {
        eligible: false,
        reason: "site-encounter-load-exceeds-fit",
        encounterLoad,
        maximumWaveHostiles: number(fit.maxWaveHostiles, 0),
        maximumWaveThreatScore: number(fit.maxWaveThreatScore, 0),
        maximumWaves: number(fit.maxSiteWaves, 0),
      };
    }
  }
  if (site.capitalOrCommanderThreat === true && fit.allowCommanderThreats !== true) {
    return { eligible: false, reason: "site-has-unvalidated-commander-threat" };
  }
  const doctrine = factionDoctrine(site);
  if (!doctrine && site.requireKnownNpcProfile === true) {
    return { eligible: false, reason: "unknown-npc-damage-profile" };
  }
  if (Array.isArray(fit.supportedFactions) && fit.supportedFactions.length &&
      !fit.supportedFactions.map(normalized).includes(normalized(site.factionKey))) {
    return { eligible: false, reason: "faction-not-covered-by-fit" };
  }
  if (doctrine) {
    const minimumResistance = MIN_SITE_RESIST_BY_TIER[Math.min(5, difficulty)] || MIN_SITE_RESIST_BY_TIER[5];
    const resistances = fit.shieldResistances || {};
    const weakestIncomingResistance = doctrine.damageTypes.reduce((weakest, damageType) => {
      const value = Number(resistances[damageType]);
      return Number.isFinite(value) ? Math.min(weakest, value) : Number.NEGATIVE_INFINITY;
    }, Number.POSITIVE_INFINITY);
    if (weakestIncomingResistance < minimumResistance) {
      return {
        eligible: false,
        reason: "site-damage-exceeds-fitted-resistance",
        minimumResistance,
        weakestIncomingResistance: Number.isFinite(weakestIncomingResistance) ? weakestIncomingResistance : null,
      };
    }
    const droneDamageByTypeID = fit.droneDamageTypeByID || {};
    const preferredDrone = Object.entries(droneDamageByTypeID)
      .find(([, damageType]) => normalized(damageType) === doctrine.preferredDroneDamage);
    if (!preferredDrone) {
      return { eligible: false, reason: "fit-has-no-faction-appropriate-combat-drone" };
    }
    return {
      eligible: true,
      difficulty,
      encounterLoad,
      doctrine,
      selectedDroneTypeID: number(preferredDrone[0]),
      selectedDroneDamageType: doctrine.preferredDroneDamage,
    };
  }
  return { eligible: true, difficulty, encounterLoad, doctrine };
}

function selectCombatAnomaly(instances = [], fit, options = {}) {
  const candidates = (Array.isArray(instances) ? instances : [])
    .filter((instance) => isPublicCombatAnomaly(instance, instance && instance.template))
    .map((instance) => ({ instance, eligibility: siteEligibility({
      supported: true,
      difficulty: instance.difficulty,
      factionKey: instance.factionKey || instance.metadata && instance.metadata.factionKey,
      populationHints: instance.template && instance.template.populationHints,
      capitalOrCommanderThreat: instance.capitalOrCommanderThreat,
      requireKnownNpcProfile: true,
    }, fit) }))
    .filter((entry) => entry.eligibility.eligible)
    .sort((left, right) =>
      right.eligibility.difficulty - left.eligibility.difficulty ||
      number(left.instance.routeHops, Number.MAX_SAFE_INTEGER) - number(right.instance.routeHops, Number.MAX_SAFE_INTEGER) ||
      number(left.instance.instanceID) - number(right.instance.instanceID));
  return candidates[0] || null;
}

function assessSafety(state, fit, liveDroneCount, dronesLaunched = true, options = {}) {
  if (!state || state.inSpace !== true || state.isCapsule === true) {
    return { safe: false, action: "withdraw", reason: "ship-unavailable" };
  }
  if (state.hullDamage > 0 || state.armorDamage > 0) {
    return { safe: false, action: "withdraw", reason: "armor-or-hull-damage" };
  }
  if (state.warpScrambleStatus > 0 &&
      (number(state.shield) < MIN_ENGAGE_SHIELD || number(state.capacitorRatio, 1) < MIN_ENGAGE_CAPACITOR)) {
    return { safe: false, action: "clear-tackle-and-withdraw", reason: "scrambled-under-pressure" };
  }
  if (number(state.shield, 1) < MIN_ENGAGE_SHIELD) {
    return { safe: false, action: "withdraw", reason: "shield-reserve-low" };
  }
  if (number(state.capacitorRatio, 1) < MIN_ENGAGE_CAPACITOR) {
    return { safe: false, action: "withdraw", reason: "capacitor-reserve-low" };
  }
  if (options.siteLootOnly !== true) {
    if (fit && fit.ready === false) {
      return { safe: false, action: "withdraw", reason: (fit.readinessProblems || []).join("; ") || "combat-fit-readiness-failed" };
    }
    if (dronesLaunched && Number.isFinite(Number(fit && fit.requiredDrones)) && liveDroneCount < Number(fit.requiredDrones)) {
      return { safe: false, action: "withdraw", reason: "combat-drone-casualty" };
    }
    if (fit && fit.capacitorStable === false) {
      return { safe: false, action: "withdraw", reason: "fit-not-capacitor-stable" };
    }
    if (fit && fit.ammunitionReady === false) {
      return { safe: false, action: "withdraw", reason: "combat-ammunition-low" };
    }
  }
  return { safe: true, action: "continue", reason: "combat-reserves-healthy" };
}

function decideCombatAction(context = {}) {
  const completedSiteLoot = context.siteLootOnly === true &&
    normalized(context.siteLifecycleState) === "completed";
  const safety = assessSafety(
    context.state,
    context.fit,
    number(context.liveDroneCount),
    context.dronesLaunched !== false,
    { siteLootOnly: completedSiteLoot },
  );
  if (!safety.safe) return safety;
  if (context.withdrawRequested === true) {
    return { safe: false, action: "withdraw", reason: context.withdrawReason || "operator-request" };
  }
  if (normalized(context.siteLifecycleState) === "completed") {
    return { safe: true, action: "site-complete", reason: "authoritative-site-lifecycle-completed" };
  }
  if (context.target) return { safe: true, action: "engage", reason: "eligible-hostile-present" };
  if (context.unlockedGate) return { safe: true, action: "activate-gate", reason: "next-site-room-gate-unlocked" };
  return { safe: true, action: "wait-for-wave", reason: "site-active-with-no-current-hostile" };
}

function decideDefensiveResponse(context = {}) {
  if (context.eligible !== true) return { safe: false, action: "evade", reason: "target-not-legally-engageable" };
  const fit = context.fit || null;
  const safety = assessSafety(
    context.state,
    fit,
    number(context.liveDroneCount),
    context.dronesLaunched === true,
  );
  if (!safety.safe) return { ...safety, action: "evade" };
  if (context.roleFitReady !== true || !fit || fit.ready !== true) {
    return { safe: false, action: "evade", reason: "validated-combat-fit-unavailable" };
  }

  // Static hull mass and base EHP are deliberately conservative indicators,
  // not a promise that the bot can win a player-versus-player fight. Unknown
  // opponent attributes are treated as a reason to disengage.
  const ownMass = number(context.ownMass, NaN);
  const targetMass = number(context.targetMass, NaN);
  const ownEffectiveHP = number(context.ownEffectiveHP, NaN);
  const targetEffectiveHP = number(context.targetEffectiveHP, NaN);
  if (![ownMass, targetMass, ownEffectiveHP, targetEffectiveHP].every(Number.isFinite) ||
      ownMass <= 0 || targetMass <= 0 || ownEffectiveHP <= 0 || targetEffectiveHP <= 0) {
    return { safe: false, action: "evade", reason: "opponent-strength-unknown" };
  }
  if (number(context.state && context.state.warpScrambleStatus) > 0) {
    return { safe: true, action: "engage", reason: "clear-warp-tackle-before-withdrawal" };
  }
  if (number(context.state && context.state.shield, 1) < 0.9 ||
      number(context.state && context.state.capacitorRatio, 1) < 0.6 ||
      number(context.state && context.state.armorDamage) > 0 ||
      number(context.state && context.state.hullDamage) > 0) {
    return { safe: false, action: "evade", reason: "defensive-reserves-below-response-threshold" };
  }
  if (targetMass >= ownMass * 0.7 || targetEffectiveHP >= ownEffectiveHP * 0.7) {
    return { safe: false, action: "evade", reason: "opponent-is-not-clearly-weaker" };
  }
  return { safe: true, action: "engage", reason: "legal-target-is-clearly-weaker-than-ready-combat-hull" };
}

module.exports = {
  FACTION_DOCTRINES,
  MIN_ENGAGE_SHIELD,
  MIN_ENGAGE_CAPACITOR,
  isPublicCombatAnomaly,
  factionDoctrine,
  summarizeEncounterLoad,
  siteEligibility,
  selectCombatAnomaly,
  assessSafety,
  decideCombatAction,
  decideDefensiveResponse,
};

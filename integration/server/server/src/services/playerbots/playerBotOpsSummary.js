"use strict";

const { SYSTEM_MESSAGE_CHUNK_BYTE_LIMIT } = require("../chat/systemMessageChunks");

function formatAutonomyOverview(snapshot) {
  if (!snapshot) {
    return [
      "Playerbot overview: waiting for the first completed automation cycle.",
      "Details: /playerbots ops 1. System distribution: /playerbots ops systems 1.",
    ].join("\n");
  }

  const director = snapshot.director || {};
  const pi = snapshot.planetaryMaintenance || {};
  const piExport = snapshot.planetaryExport || {};
  const trade = snapshot.trade || {};
  const industry = snapshot.industry || {};
  const profitShare = (snapshot.corpEconomy || {}).profitShare || {};
  const specialties = Object.entries(snapshot.specialties || {})
    .map(([name, state]) => `${name} ${Number(state.bots) || 0}`)
    .join(", ") || "none";

  const lines = [
    `Playerbots: ${Number(snapshot.botCount) || 0}; snapshot ${snapshot.lastCycleAt || "unknown"}; next ${snapshot.nextCycleAt || "unknown"}.`,
    `Work: ${Number(director.active) || 0}/${Number(director.capacityLimit) || 100} active; ${Number(director.capacityQueued) || 0} queued; ${Number(director.failures) || 0} rejected; max ${Number(director.perSystemCapacityLimit) || 10}/system.`,
    `PI: ${Number(pi.colonyCount) || 0} colonies; ${Number(pi.failedCount) || 0} failures; ${Number(piExport.collectionOperationsQueued) || 0} collections; ${Number(piExport.unitsLaunched) || 0} units launched; ${Number(piExport.taxSpent) || 0} ISK tax.`,
    `Market: ${Number(trade.unitsSold) || 0} sold for ${Number(trade.netProceeds) || 0} ISK; ${Number(trade.unitsListed) || 0} listed; ${Number(trade.activeSellPolicies) || 0} sell/${Number(trade.activeBuyPolicies) || 0} buy policies.`,
    `Industry: ${Number(industry.jobsStarted) || 0} started, ${Number(industry.jobsDelivered) || 0} delivered, ${Number(industry.unitsManufactured) || 0} produced; corp share ${Number(profitShare.contributions) || 0}/${Number(profitShare.eligibleBots) || 0}, ${Number(profitShare.amount) || 0} ISK.`,
    `Specialties: ${specialties}.`,
    "Details: /playerbots ops 1. Systems: /playerbots ops systems 1. Filter: /playerbots ops system <solarSystemID>.",
  ];
  const message = lines.join("\n");
  if (Buffer.byteLength(message.replace(/\r?\n/g, "<br>"), "utf8") > SYSTEM_MESSAGE_CHUNK_BYTE_LIMIT) {
    throw new Error("Playerbot overview exceeds the EVE chat message limit.");
  }
  return message;
}

module.exports = { formatAutonomyOverview };

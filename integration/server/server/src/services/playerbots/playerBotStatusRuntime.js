"use strict";

const { getCharacterRecord } = require("../character/characterState");
const { getCharacterWallet } = require("../account/walletState");
const itemStore = require("../inventory/itemStore");
const planetRuntime = require("../planet/planetRuntimeStore");
const playerBotTasks = require("./playerBotTaskRuntime");
const playerBotSpace = require("./playerBotSpaceRuntime");

function getBotOperationalStatus(bot) {
  if (!bot || !Number(bot.characterID)) return null;
  const characterID = Number(bot.characterID);
  const character = getCharacterRecord(characterID) || {};
  const wallet = getCharacterWallet(characterID) || { balance: 0, plexBalance: 0 };
  const assets = itemStore.listCharacterItems(characterID);
  const ships = assets.filter((item) => Number(item && item.categoryID) === 6);
  const colonies = planetRuntime.listColoniesForCharacter(characterID);
  const fleet = require("../fleets/fleetRuntime").getFleetForCharacter(characterID);
  const recentTasks = playerBotTasks.listTasks({ limit: 100 });
  const activeTasks = recentTasks.filter((task) =>
    ["queued", "leased"].includes(task.status) &&
    Number(task.targetCharacterID || task.providerCharacterID) === characterID,
  );
  const lastTask = playerBotTasks.listTasks({ status: "completed", limit: 100 }).find((task) =>
    Number(task.targetCharacterID || task.providerCharacterID) === characterID,
  );
  const balance = Number(wallet.balance);
  const activeShipTypeID = Number(character.shipTypeID) || 0;
  const rows = [
    `${bot.characterName} — ${bot.specialty} — ${bot.status === "paused" || bot.autonomyPaused ? "paused" : "active"}`,
    `Corp ${Number(character.corporationID || bot.corporationID) || "?"}; fleet ${fleet ? fleet.fleetID : "none"}; ${playerBotSpace.getBotLocation(bot)}.`,
    `Wallet ${Number.isFinite(balance) ? balance.toFixed(2) : "0.00"} ISK; ${assets.length} assets (${ships.length} ships, active ship type ${activeShipTypeID || "unknown"}); ${colonies.length} PI colonies.`,
    activeTasks.length
      ? `Pending work: ${activeTasks.map((task) => `${task.taskID} ${task.kind} (${task.status})`).join(", ")}.`
      : `Pending work: none; current task ${bot.currentTask || "none"}.`,
  ];
  if (lastTask) {
    rows.push(
      `Last task: ${lastTask.taskID} ${lastTask.kind}, ${lastTask.updatedAt}; outcome recorded.`,
    );
  } else {
    rows.push("Last task: no completed activity recorded.");
  }
  const industryCycle = require("./playerBotIndustryCycleRuntime").getCycle(characterID);
  if (industryCycle) rows.push(require("./playerBotIndustryCycleRuntime").formatCycle(industryCycle));
  const operation = require("./playerBotOperationRuntime").getOperation(characterID);
  if (operation) rows.push(require("./playerBotOperationRuntime").formatOperation(operation));
  return rows.join("\n");
}

module.exports = { getBotOperationalStatus };

"use strict";

// Corporation budgets for the specialist bot corps. Members pay a share of
// their realised profit into the corp wallet through the account service
// (GiveCash), and the corporation's CEO bot funds members that are out of
// capital through GiveCashFromCorpAccount, which enforces the CEO's persisted
// wallet roles. No ISK is created: every transfer has a payer.

const { createTableRepository } = require("../../gameStore/tableRepository");
const {
  JOURNAL_ENTRY_TYPE,
  getCharacterWallet,
  getCharacterWalletJournal,
} = require("../account/walletState");
const { getCharacterRecord } = require("../character/characterState");

const TABLE = "playerBots";
const ECONOMY_PATH = "/_corpEconomy";
const DEFAULT_POLICY = Object.freeze({
  corpShare: 0.10,
  memberMinBalance: 60_000,
  memberGrant: 100_000,
  corpReserve: 50_000,
  maxGrantsPerCycle: 2,
});
const HUMAN_CEO_PROFIT_SHARE = 0.40;
const MAX_LEDGER = 40;
const repo = createTableRepository("service:playerbots", { strict: true });
let profitSettlementQueue = Promise.resolve();
const profitSnapshotCache = new Map();

let accountService = null;

function getAccountService() {
  if (!accountService) {
    const AccountService = require("../account/accountService");
    accountService = new AccountService();
  }
  return accountService;
}

function readState() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, ECONOMY_PATH);
  const data = result.success && result.data && typeof result.data === "object" ? result.data : {};
  return { corporations: {}, ...JSON.parse(JSON.stringify(data)) };
}

function saveState(state) {
  const result = repo.write(TABLE, ECONOMY_PATH, state);
  if (!result.success) throw new Error(result.errorMsg || "PLAYERBOT_CORP_ECONOMY_WRITE_FAILED");
  const flush = repo.flushTableSync(TABLE);
  if (!flush || flush.success !== true) throw new Error(flush && flush.errorMsg || "PLAYERBOT_CORP_ECONOMY_FLUSH_FAILED");
  return state;
}

function getCorpEntry(state, corporationID) {
  const key = String(corporationID);
  if (!state.corporations[key]) {
    state.corporations[key] = { policy: { ...DEFAULT_POLICY }, sharesReceived: 0, grantsPaid: 0, ledger: [], profitTracking: {} };
  }
  if (!state.corporations[key].profitTracking || typeof state.corporations[key].profitTracking !== "object") {
    state.corporations[key].profitTracking = {};
  }
  state.corporations[key].policy = { ...DEFAULT_POLICY, ...(state.corporations[key].policy || {}) };
  return state.corporations[key];
}

function appendLedger(entry, row) {
  entry.ledger = [...(entry.ledger || []), { at: new Date().toISOString(), ...row }].slice(-MAX_LEDGER);
}

function getBalance(characterID) {
  return Number(getCharacterWallet(characterID)?.balance) || 0;
}

function getCorpBalance(corporationID) {
  return Number(require("../corporation/corpWalletState").getCorporationWalletBalance(corporationID, 1000)) || 0;
}

function isBotCorporation(corporationID) {
  return require("./playerBotRuntime").listBots().some((bot) =>
    Number(getCharacterRecord(bot.characterID)?.corporationID || bot.corporationID) === Number(corporationID));
}

function isHumanLedBotCorporation(corporationID, knownBots = null) {
  const corporation = require("../corporation/corporationState").getCorporationRecord(Number(corporationID)) || null;
  const ceoID = Number(corporation && corporation.ceoID) || 0;
  if (!corporation || corporation.isNPC === true || ceoID <= 0 || !getCharacterRecord(ceoID)) return false;
  const bots = knownBots || require("./playerBotRuntime").listBots();
  const members = bots.filter((bot) =>
    Number(getCharacterRecord(bot.characterID)?.corporationID || bot.corporationID) === Number(corporationID));
  if (!members.length) return false;
  return !members.some((bot) => Number(bot.characterID) === ceoID);
}

function roundIsk(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function walletJournalMaxTransactionID(journal) {
  return (Array.isArray(journal) ? journal : []).reduce((highest, row) =>
    Math.max(highest, Number(row && row.transactionID) || 0), 0);
}

function isStartingCapitalCredit(transaction) {
  const description = String(transaction && transaction.description || "").toLowerCase();
  return description.includes("initial character creation isk grant") ||
    description.includes("playerbot starting capital");
}

function isCapitalFundingCredit(transaction, characterID) {
  return Number(transaction && transaction.amount) > 0 &&
    [JOURNAL_ENTRY_TYPE.GM_CASH_TRANSFER, JOURNAL_ENTRY_TYPE.PLAYER_DONATION].includes(Number(transaction.entryTypeID)) &&
    Number(transaction.ownerID2) === Number(characterID) &&
    !isStartingCapitalCredit(transaction);
}

function sumCapitalFundingCredits(journal, characterID) {
  return roundIsk((Array.isArray(journal) ? journal : []).reduce((total, transaction) =>
    total + (isCapitalFundingCredit(transaction, characterID) ? Number(transaction.amount) : 0), 0));
}

function sumShareLedgerPayments(corporationEntry, characterID) {
  return roundIsk((corporationEntry.ledger || []).reduce((total, row) =>
    total + (Number(row.characterID) === Number(characterID) &&
      ["share", "profit-share"].includes(String(row.type)) ? Number(row.amount) || 0 : 0), 0));
}

function sumCorporationWalletPayments(journal, corporationID) {
  return roundIsk((Array.isArray(journal) ? journal : []).reduce((total, transaction) =>
    total + (Number(transaction.entryTypeID) === JOURNAL_ENTRY_TYPE.PLAYER_DONATION &&
      Number(transaction.ownerID2) === Number(corporationID) && Number(transaction.amount) < 0
      ? Math.abs(Number(transaction.amount)) : 0), 0));
}

function sumGrantLedgerFunding(corporationEntry, characterID) {
  return roundIsk((corporationEntry.ledger || []).reduce((total, row) =>
    total + (row.type === "grant" && Number(row.characterID) === Number(characterID)
      ? Number(row.amount) || 0 : 0), 0));
}

function pendingProfitShareAmount(tracking) {
  return roundIsk((tracking.pendingPayments || []).reduce((total, pending) =>
    total + (pending.countsTowardProfit === true ? Math.max(0, Number(pending.amount) || 0) : 0), 0));
}

function getCapitalBaseline(bot) {
  const provisioning = require("./playerBotProvisioningRuntime");
  const record = provisioning.getProvisioningRecord(bot.characterID) || {};
  const startingCapital = Number.isFinite(Number(record.startingCapital))
    ? Math.max(0, Number(record.startingCapital))
    : provisioning.DEFAULT_STARTING_CAPITAL;
  const openingWallet = Number.isFinite(Number(record.startingWalletBalance))
    ? Math.max(0, Number(record.startingWalletBalance))
    : provisioning.DEFAULT_OPENING_WALLET_BALANCE;
  return roundIsk(startingCapital + openingWallet);
}

function getOrCreateProfitTracking(corporationEntry, bot, corporationID, journal) {
  const key = String(bot.characterID);
  let tracking = corporationEntry.profitTracking[key];
  if (!tracking || Number(tracking.version) !== 1) {
    const previousPaid = Math.max(
      sumShareLedgerPayments(corporationEntry, bot.characterID),
      sumCorporationWalletPayments(journal, corporationID),
    );
    const journalFunding = sumCapitalFundingCredits(journal, bot.characterID);
    const ledgerGrants = sumGrantLedgerFunding(corporationEntry, bot.characterID);
    const journalGrantFunding = (Array.isArray(journal) ? journal : []).reduce((total, row) =>
      isCapitalFundingCredit(row, bot.characterID) && String(row.description || "").startsWith("Corp budget for ")
        ? total + Number(row.amount) : total, 0);
    tracking = {
      version: 1,
      capitalBaseline: getCapitalBaseline(bot),
      externalCapital: roundIsk(journalFunding + Math.max(0, ledgerGrants - journalGrantFunding)),
      paidToCorporation: previousPaid,
      lastTransactionID: walletJournalMaxTransactionID(journal),
      pendingPayments: [],
      startedAt: new Date().toISOString(),
    };
    corporationEntry.profitTracking[key] = tracking;
  }
  if (!Array.isArray(tracking.pendingPayments)) tracking.pendingPayments = [];
  if (!Array.isArray(tracking.confirmedPaymentKeys)) tracking.confirmedPaymentKeys = [];
  // Version 1's earlier in-flight field was written only after a successful
  // transfer, with its amount already included in paidToCorporation. Ignore
  // those legacy markers so migration cannot send the donation twice.
  tracking.pendingPayments = tracking.pendingPayments.filter((pending) => pending && pending.countsTowardProfit === true);
  return tracking;
}

function reconcileProfitJournal(tracking, journal, corporationID, characterID, corporationEntry = null) {
  const lastTransactionID = Number(tracking.lastTransactionID) || 0;
  const transactions = (Array.isArray(journal) ? journal : [])
    .filter((row) => Number(row && row.transactionID) > lastTransactionID)
    .sort((left, right) => Number(left.transactionID) - Number(right.transactionID));
  for (const transaction of transactions) {
    const amount = Number(transaction.amount) || 0;
    if (isCapitalFundingCredit(transaction, characterID)) {
      tracking.externalCapital = roundIsk(Number(tracking.externalCapital) + amount);
    }
    if (Number(transaction.entryTypeID) === JOURNAL_ENTRY_TYPE.PLAYER_DONATION &&
        Number(transaction.ownerID2) === Number(corporationID) && amount < 0) {
      const paid = Math.abs(amount);
      const description = String(transaction.description || "");
      const alreadyCounted = tracking.confirmedPaymentKeys.some((key) => description.includes(String(key))) ||
        (corporationEntry && Array.isArray(corporationEntry.ledger) && corporationEntry.ledger.some((row) =>
          row && row.type === "profit-share" && Number(row.characterID) === Number(characterID) &&
          Math.abs(Number(row.amount) - paid) < 0.01 && String(row.idempotencyKey || "") &&
          description.includes(String(row.idempotencyKey))));
      if (alreadyCounted) {
        tracking.lastTransactionID = Math.max(Number(tracking.lastTransactionID) || 0, Number(transaction.transactionID) || 0);
        continue;
      }
      const pendingIndex = (tracking.pendingPayments || []).findIndex((pending) =>
        description.includes(String(pending.idempotencyKey || "")) &&
        Math.abs(Number(pending.amount) - paid) < 0.01);
      // Keep an in-flight, idempotent transfer pending until GiveCash confirms
      // both wallet legs. Its amount is already added back to net profit.
      if (pendingIndex < 0) tracking.paidToCorporation = roundIsk(Number(tracking.paidToCorporation) + paid);
    }
  }
  tracking.lastTransactionID = Math.max(Number(tracking.lastTransactionID) || 0, walletJournalMaxTransactionID(journal));
}

function cumulativeNetProfit(balance, tracking) {
  return roundIsk(Number(balance) - Number(tracking.capitalBaseline) -
    Number(tracking.externalCapital) + Number(tracking.paidToCorporation) + pendingProfitShareAmount(tracking));
}

function getCumulativeNetProfit(bot) {
  const characterID = Number(bot && bot.characterID) || 0;
  const corporationID = Number(getCharacterRecord(characterID)?.corporationID || bot && bot.corporationID) || 0;
  if (!characterID || !corporationID) return { netProfit: 0, balance: 0, capitalBaseline: 0 };
  const balance = getBalance(characterID);
  const journal = getCharacterWalletJournal(characterID);
  const latestTransactionID = walletJournalMaxTransactionID(journal);
  const cacheKey = `${corporationID}:${characterID}`;
  const cached = profitSnapshotCache.get(cacheKey);
  if (cached && cached.balance === balance && cached.latestTransactionID === latestTransactionID) return cached.value;
  const state = readState();
  const corporationEntry = getCorpEntry(state, corporationID);
  const tracking = getOrCreateProfitTracking(corporationEntry, bot, corporationID, journal);
  reconcileProfitJournal(tracking, journal, corporationID, characterID, corporationEntry);
  const netProfit = cumulativeNetProfit(balance, tracking);
  tracking.cumulativeNetProfit = netProfit;
  tracking.updatedAt = new Date().toISOString();
  // Director reads are advisory and may run for every combat bot in one
  // scheduling pass. The settlement path persists this ledger; don't perform
  // a synchronous GameStore flush just to check an upgrade threshold.
  const value = {
    netProfit,
    reinvestableProfit: Math.max(0, netProfit),
    balance,
    capitalBaseline: Number(tracking.capitalBaseline) || 0,
    externalCapital: Number(tracking.externalCapital) || 0,
    paidToCorporation: Number(tracking.paidToCorporation) || 0,
  };
  profitSnapshotCache.set(cacheKey, { balance, latestTransactionID, value });
  return value;
}

async function sendPendingProfitShare(bot, corporationID, state, corporationEntry, tracking, pending) {
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const result = await getAccountService().Handle_GiveCash(
    [corporationID, Number(pending.amount)],
    session,
    {
      reason: `Corp profit share ${pending.idempotencyKey}`.slice(0, 100),
      toAccountKey: 1000,
      idempotencyKey: pending.idempotencyKey,
    },
  );
  if (!result || (!Array.isArray(result) && result.success !== true)) {
    throw new Error(result && result.errorMsg || "PLAYERBOT_CORP_PROFIT_SHARE_TRANSFER_FAILED");
  }
  tracking.pendingPayments = (tracking.pendingPayments || [])
    .filter((row) => row.idempotencyKey !== pending.idempotencyKey);
  tracking.paidToCorporation = roundIsk(Number(tracking.paidToCorporation) + Number(pending.amount));
  tracking.confirmedPaymentKeys = [...new Set([
    ...(tracking.confirmedPaymentKeys || []),
    String(pending.idempotencyKey),
  ])].slice(-100);
  corporationEntry.sharesReceived = roundIsk(Number(corporationEntry.sharesReceived) + Number(pending.amount));
  appendLedger(corporationEntry, {
    type: "profit-share",
    characterID: Number(bot.characterID),
    amount: Number(pending.amount),
    shareRate: HUMAN_CEO_PROFIT_SHARE,
    cumulativeNetProfit: Number(tracking.cumulativeNetProfit) || 0,
    reason: "40% of cumulative net profit after operating costs",
    idempotencyKey: pending.idempotencyKey,
  });
  tracking.updatedAt = new Date().toISOString();
  saveState(state);
  return Number(pending.amount);
}

async function settleHumanLedProfitShare(bot) {
  const characterID = Number(bot && bot.characterID) || 0;
  if (!characterID) return 0;
  const corporationID = Number(getCharacterRecord(characterID)?.corporationID) || 0;
  if (!corporationID || !isHumanLedBotCorporation(corporationID)) return 0;
  const settlement = profitSettlementQueue.catch(() => 0).then(async () => {
    if (Number(getCharacterRecord(characterID)?.corporationID) !== corporationID ||
        !isHumanLedBotCorporation(corporationID)) return 0;
    const balance = getBalance(characterID);
    const journal = getCharacterWalletJournal(characterID);
    const state = readState();
    const corporationEntry = getCorpEntry(state, corporationID);
    const tracking = getOrCreateProfitTracking(corporationEntry, bot, corporationID, journal);
    reconcileProfitJournal(tracking, journal, corporationID, characterID, corporationEntry);
    const profit = cumulativeNetProfit(balance, tracking);
    const targetContribution = Math.floor(Math.max(0, profit) * HUMAN_CEO_PROFIT_SHARE * 100) / 100;
    const amount = roundIsk(targetContribution - Number(tracking.paidToCorporation));
    tracking.cumulativeNetProfit = profit;
    tracking.targetContribution = targetContribution;
    tracking.updatedAt = new Date().toISOString();
    saveState(state);
    const pending = tracking.pendingPayments[0];
    if (pending) return sendPendingProfitShare(bot, corporationID, state, corporationEntry, tracking, pending);
    if (amount < 1 || balance < amount) return 0;

    const idempotencyKey = `playerbot:profit-share:${corporationID}:${characterID}:${Math.round(targetContribution * 100)}`;
    const nextPayment = { amount, idempotencyKey, countsTowardProfit: true, createdAt: new Date().toISOString() };
    tracking.pendingPayments = [nextPayment];
    saveState(state);
    return sendPendingProfitShare(bot, corporationID, state, corporationEntry, tracking, nextPayment);
  });
  profitSettlementQueue = settlement.catch(() => 0);
  return settlement;
}

async function settleProfitShares(bots = require("./playerBotRuntime").listBots()) {
  const summary = { eligibleBots: 0, contributions: 0, amount: 0, failures: 0 };
  for (const bot of bots) {
    const corporationID = Number(getCharacterRecord(bot.characterID)?.corporationID) || 0;
    if (!isHumanLedBotCorporation(corporationID, bots)) continue;
    summary.eligibleBots += 1;
    try {
      const amount = await settleHumanLedProfitShare(bot);
      if (amount > 0) {
        summary.contributions += 1;
        summary.amount = roundIsk(summary.amount + amount);
      }
    } catch (error) {
      summary.failures += 1;
      require("../../utils/logger").warn(`[PlayerBots] Corporation profit share failed char=${bot.characterID}: ${String(error && error.message || error).slice(0, 180)}`);
    }
  }
  return summary;
}

// Bot-led corporations keep the original per-operation share. A human CEO's
// corporation instead receives 40% of each bot's cumulative net profit, based
// on wallet balance less capital and operating spend, with previous donations
// added back so a payout never reduces the profit base.
async function payCorpShare(bot, profit, reason, paymentKey = null) {
  const corporationID = Number(require("../character/characterState").getCharacterRecord(bot.characterID)?.corporationID) || 0;
  if (!corporationID || !isBotCorporation(corporationID)) return 0;
  if (isHumanLedBotCorporation(corporationID)) return settleHumanLedProfitShare(bot);
  if (!(profit > 0)) return 0;
  const state = readState();
  const entry = getCorpEntry(state, corporationID);
  const amount = Math.floor(profit * Number(entry.policy.corpShare) * 100) / 100;
  if (!(amount >= 1) || (!paymentKey && getBalance(bot.characterID) < amount)) return 0;
  const idempotencyKey = paymentKey
    ? `playerbot:corp-share:${Number(bot.characterID)}:${String(paymentKey).replace(/[^a-zA-Z0-9:._-]/g, "-").slice(0, 180)}`
    : null;
  if (idempotencyKey && (entry.ledger || []).some((row) => row && row.idempotencyKey === idempotencyKey)) return amount;
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const result = await getAccountService().Handle_GiveCash(
    [corporationID, amount],
    session,
    {
      reason: `Corp share: ${reason}`.slice(0, 100),
      toAccountKey: 1000,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  );
  if (!result || (!Array.isArray(result) && result.success !== true)) {
    throw new Error(result && result.errorMsg || "PLAYERBOT_CORP_SHARE_TRANSFER_FAILED");
  }
  entry.sharesReceived = Math.round((Number(entry.sharesReceived) + amount) * 100) / 100;
  appendLedger(entry, {
    type: "share", characterID: Number(bot.characterID), amount, reason,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  saveState(state);
  return amount;
}

// The CEO bot funds members below the minimum balance from the corp wallet.
async function fundMembers(bots = []) {
  const summary = { grants: 0, granted: 0, refused: 0 };
  const corporations = new Map();
  for (const bot of bots) {
    const corporationID = Number(bot.corporationID) || 0;
    if (!corporationID) continue;
    if (!corporations.has(corporationID)) corporations.set(corporationID, []);
    corporations.get(corporationID).push(bot);
  }
  const state = readState();
  for (const [corporationID, members] of corporations) {
    const corporation = require("../corporation/corporationState").getCorporationRecord(corporationID) || {};
    // The CEO bot pays grants; when a player holds the CEO seat the founding
    // bot (kept as director) does, still bound by its persisted wallet roles.
    const ceo = members.find((bot) => Number(bot.characterID) === Number(corporation.ceoID)) ||
      members.find((bot) => bot.founder === true);
    if (!ceo) continue;
    const entry = getCorpEntry(state, corporationID);
    const policy = { ...DEFAULT_POLICY, ...entry.policy };
    const needy = members
      .filter((bot) => bot !== ceo && bot.status !== "paused" && getBalance(bot.characterID) < policy.memberMinBalance)
      .sort((left, right) => getBalance(left.characterID) - getBalance(right.characterID))
      .slice(0, policy.maxGrantsPerCycle);
    for (const member of needy) {
      if (getCorpBalance(corporationID) < policy.memberGrant + policy.corpReserve) break;
      const session = require("./playerBotSpaceRuntime").getActorSession(ceo);
      const before = getBalance(member.characterID);
      try {
        await getAccountService().Handle_GiveCashFromCorpAccount(
          [Number(member.characterID), policy.memberGrant, 1000],
          session,
          { reason: `Corp budget for ${member.characterName}`.slice(0, 100) },
        );
      } catch (error) {
        summary.refused += 1;
        appendLedger(entry, { type: "grant-refused", characterID: Number(member.characterID), reason: String(error && error.message || error).slice(0, 160) });
        continue;
      }
      const granted = Math.round((getBalance(member.characterID) - before) * 100) / 100;
      if (granted > 0) {
        summary.grants += 1;
        summary.granted += granted;
        entry.grantsPaid = Math.round((Number(entry.grantsPaid) + granted) * 100) / 100;
        appendLedger(entry, { type: "grant", characterID: Number(member.characterID), amount: granted, by: Number(ceo.characterID) });
      } else {
        summary.refused += 1;
        appendLedger(entry, { type: "grant-refused", characterID: Number(member.characterID), reason: "the wallet authority moved no ISK (CEO roles or balance)" });
      }
    }
  }
  saveState(state);
  return summary;
}

function formatCorpEconomy() {
  const state = readState();
  const bots = require("./playerBotRuntime").listBots();
  const rows = Object.entries(state.corporations).map(([corporationID, entry]) => {
    const humanLed = isHumanLedBotCorporation(corporationID, bots);
    const shareLabel = humanLed ? "40% of cumulative net profit" : `${(Number(entry.policy.corpShare) * 100).toFixed(0)}% per-operation share`;
    const trackedProfit = Object.values(entry.profitTracking || {}).reduce((total, row) =>
      total + (Number(row && row.cumulativeNetProfit) || 0), 0);
    return `Corp ${corporationID}: wallet ${getCorpBalance(corporationID).toFixed(2)} ISK; contributions received ${Number(entry.sharesReceived || 0).toFixed(2)}; ` +
      `member grants ${Number(entry.grantsPaid || 0).toFixed(2)}; ${shareLabel}` +
      (humanLed ? `; tracked cumulative net profit ${roundIsk(trackedProfit).toFixed(2)} ISK.` : ".");
  });
  return rows.length ? `Corporation economy:\n${rows.join("\n")}` : "Corporation economy: no activity yet.";
}

module.exports = {
  DEFAULT_POLICY,
  formatCorpEconomy,
  getCumulativeNetProfit,
  fundMembers,
  isHumanLedBotCorporation,
  payCorpShare,
  settleProfitShares,
};

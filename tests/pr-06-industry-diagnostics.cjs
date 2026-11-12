"use strict";
const fs = require("fs"),
  path = require("path"),
  vm = require("vm"),
  assert = require("assert/strict");
const results = [];
const source = (slug, file = "playerBotOperationRuntime.js") =>
  fs.readFileSync(
    path.join(
      process.env.EVEJS_SOURCE_ROOT ||
        path.resolve(__dirname, "../integration/server"),
      "server/src/services/playerbots",
      file,
    ),
    "utf8",
  );
function extract(s, name) {
  const re = new RegExp("^(?:async )?function " + name + "\\(", "m"),
    m = re.exec(s);
  assert.ok(m, "Missing function " + name);
  const end = s.indexOf("\n}", m.index);
  assert.ok(end > m.index);
  return s.slice(m.index, end + 2);
}
function functions(s, names, context) {
  vm.createContext(context);
  vm.runInContext(names.map((n) => extract(s, n)).join("\n"), context);
  return context;
}
async function test(feature, name, fn) {
  try {
    await fn();
    results.push({ feature, name, passed: true });
  } catch (e) {
    results.push({ feature, name, passed: false, error: e.stack });
  }
}
const record = (o, m) => {
    o.lastAction = m;
  },
  saveOperation = () => {},
  block = (o, status, msg) => {
    o.status = status;
    o.lastError = msg;
    return { blocked: true };
  },
  bot = { characterID: 1, characterName: "fixture" };
async function diagnostics() {
  const s = source(
    "06-industry-diagnostics",
    "playerBotIndustryCycleRuntime.js",
  );
  function c(result, observed) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      ctx: functions(s, ["buyFromBestAsk"], {
        Math,
        Date,
        STEP_DELAY_MS: 5000,
        getTrade: () => ({
          readQuote: async () => ({
            success: true,
            bestAsk: { price: 2, quantity: 10 },
          }),
          buy: async () => {
            calls++;
            return result;
          },
        }),
        remainingBudget: () => 100,
        getBalance: () => 100,
        countUnits: () => 3,
        getCharacterMarketTransactions: () => [{ transactionID: 5 }],
        saveCycle: () => {},
        settlePendingPurchase: (cycle) => {
          cycle.pending = null;
          return observed;
        },
        applyPurchase: () => {},
        markJitaRunPurchase: () => {},
        block,
        record,
      }),
    };
  }
  await test(
    "06-industry-diagnostics",
    "uncertain response retains evidence and stops retry",
    async () => {
      const x = c(
          { success: false, outcomeUnknown: true, message: "Escrow shortage" },
          { bought: 0, spent: 0, transactionReconciled: false },
        ),
        o = { characterID: 1, stationID: 10 };
      await x.ctx.buyFromBestAsk(o, bot, 34, 5, "material");
      assert.equal(o.status, "review");
      assert.equal(o.lastPurchaseReview.quantity, 5);
      assert.equal(o.lastPurchaseReview.baselineUnits, 3);
      assert.equal(o.lastPurchaseReview.authorityMessage, "Escrow shortage");
      assert.equal(x.calls, 1);
    },
  );
  await test(
    "06-industry-diagnostics",
    "reconciled response does not force review",
    async () => {
      const x = c(
          { success: false, outcomeUnknown: true, message: "timeout" },
          { bought: 5, spent: 10, transactionReconciled: true },
        ),
        o = { characterID: 1, stationID: 10 };
      await x.ctx.buyFromBestAsk(o, bot, 34, 5, "material");
      assert.notEqual(o.status, "review");
      assert.equal(o.lastPurchaseReview, undefined);
    },
  );
  await test(
    "06-industry-diagnostics",
    "normal purchase keeps existing path",
    async () => {
      const x = c({ success: true }, { bought: 5, spent: 10 }),
        o = { characterID: 1, stationID: 10 };
      await x.ctx.buyFromBestAsk(o, bot, 34, 5, "material");
      assert.equal(o.lastPurchaseReview, undefined);
      assert.equal(o.lastError, null);
    },
  );
  await test(
    "06-industry-diagnostics",
    "trade failure uses preexisting authority decoder",
    () => {
      const trade = source(
        "06-industry-diagnostics",
        "playerBotTradeRuntime.js",
      );
      assert.ok(
        trade.includes("getMarketAuthorityErrorMessage(error).slice(0, 180)"),
      );
      const c = functions(trade, ["getMarketAuthorityErrorMessage"], {
        Buffer,
      });
      assert.match(
        c.getMarketAuthorityErrorMessage({
          machoErrorResponse: {
            payload: {
              header: [
                null,
                [null, { entries: [["info", "specific failure"]] }],
              ],
            },
          },
        }),
        /specific failure/,
      );
    },
  );
}
(async () => {
  await diagnostics();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

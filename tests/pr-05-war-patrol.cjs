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
async function war() {
  const s = source("05-war-patrol");
  await test(
    "05-war-patrol",
    "waiting war refused before creating operation",
    () => {
      const c = functions(s, ["startCombat"], {
        getPlayerBots: () => ({ resolveBot: () => bot }),
        assertCanStart: () => null,
        require: (p) => {
          assert.ok(p.includes("warRuntimeState"));
          return { hasActiveWarForCharacter: () => false };
        },
      });
      assert.match(c.startCombat("fixture", "war").message, /active war/);
    },
  );
  await test(
    "05-war-patrol",
    "active war without legal target has no belt fallback",
    () => {
      const c = functions(s, ["startCombat"], {
        getPlayerBots: () => ({ resolveBot: () => bot }),
        assertCanStart: () => null,
        hasRoleShipFit: () => true,
        canStartCombatModeForPilot: () => true,
        getRoleShipFitProfile: () => ({}),
        normalizePositiveInteger: (n) => Number(n) || 0,
        getOperation: () => null,
        require: (p) =>
          p.includes("warRuntimeState")
            ? { hasActiveWarForCharacter: () => true }
            : p.includes("CombatRuntime")
              ? {
                  findNearestWarBase: () => ({
                    success: false,
                    message: "no legal opponent",
                  }),
                }
              : { BOT_HUB_STATION_ID: 10 },
      });
      assert.equal(
        c.startCombat("fixture", "war").message,
        "no legal opponent",
      );
    },
  );
  await test(
    "05-war-patrol",
    "legacy waiting patrol returns normally",
    async () => {
      const s2 = source("05-war-patrol", "playerBotCombatRuntime.js"),
        o = { mode: "war", stage: "engage" };
      let returned = false;
      const c = functions(s2, ["advanceCombat"], {
        module: { exports: { requestSafeRetreat: () => (returned = true) } },
        require: (p) => ({ hasActiveWarForCharacter: () => false }),
        isCapsuleBot: () => false,
        getCombatRole: () => "security",
      });
      /* Full handler needs native scene; verify its actual inserted guard as an executable block below. */ const a =
          s2.indexOf("  // Old saves may already contain"),
        b = s2.indexOf("\n  if (capsule &&", a);
      const guard = s2.slice(a, b);
      const f = vm.runInNewContext(
        "(function(operation,bot,kit){" + guard + "})",
        {
          module: c.module,
          require: c.require,
          capsuleSafeStages: new Set(["return", "to-market", "market-sell"]),
          record: () => {},
        },
      );
      assert.equal(f(o, bot, {}).delayMs, 5000);
      assert.equal(returned, true);
    },
  );
}
(async () => {
  await war();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

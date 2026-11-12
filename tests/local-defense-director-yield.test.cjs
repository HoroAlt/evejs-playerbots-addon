"use strict";
function printReport(_path, value) {
  console.log(value);
}
const fs = require("fs"),
  path = require("path"),
  vm = require("vm"),
  assert = require("assert/strict");
const root = path.resolve(__dirname, ".."),
  base = path.join(root, "integration/server/server/src/services/playerbots");
const source = fs.readFileSync(
  path.join(base, "playerBotDirectorRuntime.js"),
  "utf8",
);
const busy = source.slice(
  source.indexOf("function isBusy("),
  source.indexOf("function industryCycleNeedsManualReview("),
);
const begin = source.indexOf(
  "  for (const bot of candidates) {",
  source.indexOf("async function runDirectorInternal("),
);
const end = source.indexOf("    const corporationID =", begin);
const loop = source.slice(begin, end) + " observed.push(bot.characterID); }";
const { createWorkBudget } = require(path.join(base, "playerBotWorkBudget"));
(async () => {
  const result = [];
  for (const change of [
    "none",
    "rescue-lease",
    "pending-retreat",
    "execution-owner",
    "paused",
    "director-disabled",
  ]) {
    let leased = false,
      pending = false,
      owner = false,
      enabled = true;
    const bot = { characterID: 1, status: "active", autonomyPaused: false },
      observed = [];
    const realBudget = createWorkBudget({ budgetMs: 1 });
    const context = {
      observed,
      candidates: [bot],
      assignmentAttempts: 0,
      MAX_DIRECTOR_ASSIGNMENT_ATTEMPTS_PER_PASS: 20,
      isEnabled: () => enabled,
      budget: {
        checkpoint: async () => {
          await realBudget.checkpoint(true);
          if (change === "rescue-lease") leased = true;
          if (change === "pending-retreat") pending = true;
          if (change === "execution-owner") owner = true;
          if (change === "paused") bot.autonomyPaused = true;
          if (change === "director-disabled") enabled = false;
          return true;
        },
      },
      require: (id) => {
        if (id === "./playerBotLocalDefenseAdapter")
          return { hasLease: () => leased };
        if (id === "./playerBotInterruptRuntime")
          return { isBusy: () => owner, hasPending: () => pending };
        if (id === "./playerBotOperationRuntime")
          return { getOperation: () => null, hasActiveOperation: () => false };
        if (id === "./playerBotIndustryCycleRuntime")
          return { getCycle: () => null };
        throw Error(id);
      },
    };
    vm.createContext(context);
    vm.runInContext(
      busy + ";this.initial=isBusy(1);this.run=async()=>{" + loop + "};",
      context,
    );
    assert.equal(context.initial, false);
    await context.run();
    assert.equal(observed.length, change === "none" ? 1 : 0);
    result.push({
      scenario: change,
      passed: true,
      assignmentsAfterYield: observed.length,
      budget: realBudget.finish(),
    });
  }
  printReport(
    path.join(root, "evidence/director-yield-results.json"),
    JSON.stringify(
      {
        scope:
          "Actual source loop and isBusy function; real cooperative yield; controlled dependencies, not full native Director integration",
        cases: result,
      },
      null,
      2,
    ),
  );
  console.log("PASS director yield guards: " + result.length);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

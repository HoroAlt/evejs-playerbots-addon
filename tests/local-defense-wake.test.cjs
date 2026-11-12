"use strict";
function ignoreReportDirectory() {}
function printReport(_path, value) {
  console.log(value);
}
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const src = path.resolve(__dirname, "../integration/server/server/src"),
  schedulerDir = path.join(src, "services/scheduler");
let host,
  rows = {},
  writes = 0;
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const db = {
  ensureTable() {},
  read: (t, k) => ({
    success: true,
    data: k === "/" ? clone(rows) : clone(rows[k.slice(1)]),
  }),
  write: (t, k, v) => {
    rows[k.slice(1)] = clone(v);
    writes++;
    return { success: true };
  },
  flushTableSync: () => ({ success: true }),
  remove: (t, k) => {
    delete rows[k.slice(1)];
    return { success: true };
  },
};
vm.runInNewContext(
  fs.readFileSync(
    path.join(schedulerDir, "durableSchedulerProcess.worker.js"),
    "utf8",
  ),
  {
    __dirname: schedulerDir,
    process: { env: { EVEJS_SCHEDULER_START_PAUSED: "1" } },
    Date,
    structuredClone,
    setTimeout: () => 1,
    clearTimeout() {},
    console,
    require: (id) => {
      if (id.startsWith("node:")) return require(id);
      if (id.endsWith("processLifecycle"))
        return { installProcessLifecycleLogging() {} };
      if (id.endsWith("ownerProcessShutdown"))
        return { installOwnerProcessShutdown() {} };
      if (id.endsWith("orderedProcessHost"))
        return {
          createOrderedProcessHost: (v) => {
            host = v;
          },
        };
      if (id.endsWith("gameStore")) return db;
      return require(id);
    },
  },
);
for (let n = 0; n < 100; n++) {
  rows = {
    job: {
      jobID: "job",
      type: "qa",
      state: "scheduled",
      dueAtMs: 100000,
      payload: { characterID: 1 },
      attempt: 3,
      leaseToken: null,
    },
  };
  const first = host.handleCommand("wakeEarlier", {
    jobID: "job",
    dueAtMs: 50000,
  });
  assert.equal(first.dueAtMs, 50000);
  assert.equal(first.attempt, 3);
  const before = writes;
  host.handleCommand("wakeEarlier", { jobID: "job", dueAtMs: 80000 });
  assert.equal(writes, before, "wake never delays work");
  // Deterministic list/claim interleaving: the owner has acquired a live lease
  // before the caller's wake command arrives at the scheduler process.
  rows.job = {
    ...rows.job,
    state: "running",
    leaseToken: "owned",
    leaseUntilMs: 90000,
  };
  const snapshot = clone(rows.job);
  host.handleCommand("wakeEarlier", { jobID: "job", dueAtMs: 1 });
  assert.deepEqual(rows.job, snapshot);
  assert.equal(
    host.handleCommand("validateLease", { jobID: "job", leaseToken: "owned" }),
    true,
  );
  rows.job.state = "dead-letter";
  host.handleCommand("wakeEarlier", { jobID: "job", dueAtMs: 1 });
  assert.equal(rows.job.state, "dead-letter");
  assert.equal(
    host.handleCommand("wakeEarlier", { jobID: "absent", dueAtMs: 1 }),
    null,
  );
}
const moduleObject = { exports: {} };
let listed = 0,
  woken = 0,
  scheduled = 0;
vm.runInNewContext(
  fs.readFileSync(
    path.join(src, "services/playerbots/playerBotAutonomyRuntime.js"),
    "utf8",
  ) + "\nmodule.exports.bindQA=s=>durableScheduler=s;",
  {
    module: moduleObject,
    Date,
    console,
    require: (id) => {
      if (id === "../../gameStore/tableRepository")
        return { createTableRepository: () => ({}) };
      if (id === "./playerBotOpsSummary") return {};
      throw Error(id);
    },
  },
);
moduleObject.exports.bindQA({
  list: async () => {
    listed++;
    return [
      {
        jobID: "job",
        type: "playerbots.industry.cycle-step",
        payload: { characterID: 1 },
        state: "scheduled",
        dueAtMs: Date.now() + 10000,
      },
    ];
  },
  wakeEarlier: async () => {
    woken++;
    return { state: "running", leaseToken: "owned" };
  },
  schedule: async () => scheduled++,
  cancel: () => assert.fail("wake must not cancel a lease"),
});
Promise.all(
  Array.from({ length: 100 }, () =>
    moduleObject.exports.wakeIndustryCycleStep(1, { immediate: true }),
  ),
)
  .then(() => {
    assert.equal(listed, 1);
    assert.equal(woken, 1);
    assert.equal(scheduled, 0);
    printReport(
      path.resolve(__dirname, "../test-output/P5/wake-regression.json"),
      JSON.stringify(
        {
          passed: true,
          claimInterleavings: 100,
          concurrentWakeRequests: 100,
          listCalls: listed,
          atomicWakeCalls: woken,
          scope:
            "Actual scheduler command handler and autonomy wake function, controlled persistence/IPC",
        },
        null,
        2,
      ),
    );
    console.log("PASS 100 claim interleavings and 100 coalesced wakes");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

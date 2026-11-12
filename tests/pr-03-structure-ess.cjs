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
async function structure() {
  const s = source("03-structure-ess", "playerBotStructureRuntime.js");
  function ctx(actions) {
    const scene = {
      staticEntities: [
        { itemID: 1, position: { x: 1000, y: 0, z: 0 } },
        { itemID: 2, position: { x: 2000, y: 0, z: 0 } },
      ],
      getShipEntityForSession: () => ({ position: { x: 0, y: 0, z: 0 } }),
    };
    return functions(s, ["findDeploymentReposition"], {
      Set,
      positiveID: (n) => Number(n) || 0,
      MIN_DEPLOYMENT_REPOSITION_DISTANCE: 100,
      DEPLOYMENT_GRID_CLEARANCE_METERS: 100,
      deploymentOffsetAt: (t, sys, pos) => ({ success: true, position: pos }),
      require: (p) =>
        p.includes("SpaceRuntime")
          ? { getActorSpace: () => ({ scene, session: { solarsystemid: 1 } }) }
          : p.includes("Placement")
            ? {
                getDeploymentWarpInPoint: (e) => ({
                  ...e.position,
                  x: e.position.x + 100,
                }),
              }
            : {
                evaluateEssDeadspaceWarp: (sc, ship, pos) => ({
                  action: actions[pos.x < 2000 ? 0 : 1],
                }),
              },
    });
  }
  await test("03-structure-ess", "forbidden near warp point is skipped", () => {
    assert.equal(
      ctx(["deny", "allow"]).findDeploymentReposition(bot, 35832).targetID,
      2,
    );
  });
  await test("03-structure-ess", "all forbidden returns no relocation", () => {
    assert.equal(
      ctx(["deny", "deny"]).findDeploymentReposition(bot, 35832),
      null,
    );
  });
  await test(
    "03-structure-ess",
    "normal allowed nearest route retained",
    () => {
      assert.equal(
        ctx(["allow", "allow"]).findDeploymentReposition(bot, 35832).targetID,
        1,
      );
    },
  );
}
(async () => {
  await structure();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

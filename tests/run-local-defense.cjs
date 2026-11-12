"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
let failed = false;
for (const file of fs
  .readdirSync(__dirname)
  .filter((name) => /^local-defense-.*[.]test[.]cjs$/.test(name))
  .sort()) {
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      path.join(__dirname, "engine-checkout.cjs"),
      path.join(__dirname, file),
    ],
    { encoding: "utf8" },
  );
  console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${file}`);
  if (result.status !== 0) {
    failed = true;
    console.error(result.stdout + result.stderr);
  }
}
process.exitCode = failed ? 1 : 0;

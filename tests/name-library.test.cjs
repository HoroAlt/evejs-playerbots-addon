"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNameLibrary, emptyLibrary, parseText, naturalTicker } = require("../integration/server/server/src/services/playerbots/playerBotNameLibraryRuntime");
const fixtureText = fs.readFileSync(path.join(__dirname, "fixtures/name-library/four-empires.json"), "utf8");
const fixture = JSON.parse(fixtureText);
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-names-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "playerbots-name-library.json");
}
const free = { findCorporationByName: () => null, findAllianceByExactName: () => null,
  findCorporationByTickerName: () => null, findAllianceByShortName: () => null };

test("all 220 supplied names persist unchanged, including punctuation, and load in a fresh runtime", (t) => {
  const file = directory(t);
  const names = createNameLibrary({ file });
  assert.deepEqual(JSON.parse(names.getStatus().text), emptyLibrary());
  names.saveText(fixtureText);
  assert.deepEqual(JSON.parse(createNameLibrary({ file }).getStatus().text), fixture);
  assert.equal(Object.values(fixture).flatMap((p) => [...p.corporations, ...p.alliances]).length, 220);
  assert.notEqual(fs.readFileSync(file)[0], 0xef);
});

test("Windows CRLF, UTF-8 BOM and repeated candidates are accepted without a second content policy", () => {
  assert.deepEqual(parseText("\uFEFF" + fixtureText.replace(/\n/g, "\r\n")), fixture);
  const repeated = emptyLibrary();
  repeated.amarr.corporations = ["Thurible & Crown Foundry", "Thurible & Crown Foundry"];
  assert.deepEqual(parseText(JSON.stringify(repeated)), repeated);
});

test("format errors identify the first field and leave the saved configuration intact", (t) => {
  const file = directory(t), names = createNameLibrary({ file });
  names.saveText(fixtureText);
  const before = fs.readFileSync(file);
  assert.throws(() => names.saveText("{"), /Invalid JSON/);
  for (const [mutate, message] of [
    [(v) => { delete v.amarr; }, /library.amarr is required/],
    [(v) => { v.caldari.corporations = "bad"; }, /caldari.corporations must be an array/],
    [(v) => { v.gallente.alliances = [" "]; }, /gallente.alliances\[0\]/],
    [(v) => { v.minmatar.corporations = ["中文"]; }, /ASCII/],
    [(v) => { v.caldari.weight = 2; }, /caldari.weight is not a template field/],
  ]) {
    const value = emptyLibrary(); mutate(value);
    assert.throws(() => names.saveText(JSON.stringify(value)), message);
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

test("a failed atomic replacement preserves the previous file and active library", (t) => {
  const file = directory(t), names = createNameLibrary({ file });
  names.saveText(fixtureText);
  const failing = createNameLibrary({ file, fs: { ...fs, renameSync() { throw Error("read-only volume"); } } });
  const before = failing.getStatus().text;
  assert.throws(() => failing.saveText(JSON.stringify(emptyLibrary())), /previous library is still active/);
  assert.equal(failing.getStatus().text, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), fixture);
});

test("a corrupt or invalid UTF-8 file is visible and never overwritten by loading", (t) => {
  const file = directory(t);
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff, 0xfe, 0x7b, 0])]) {
    fs.writeFileSync(file, bytes);
    const status = createNameLibrary({ file }).getStatus();
    assert.match(status.warning, /Could not load/);
    assert.deepEqual(JSON.parse(status.text), emptyLibrary());
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

test("selection follows race and type, skips actual name/ticker occupancy, and never invents suffixes", (t) => {
  const names = createNameLibrary({ file: directory(t) }); names.saveText(fixtureText);
  for (const [race, empire] of [[1, "caldari"], [2, "minmatar"], [4, "amarr"], [8, "gallente"]]) {
    for (const type of ["corporations", "alliances"]) {
      assert.equal(names.chooseName(race, type, free).name, fixture[empire][type][0]);
    }
  }
  const blocked = fixture.caldari.corporations[0];
  const next = names.chooseName(1, "corporations", { ...free, findAllianceByExactName: (name) => name === blocked });
  assert.equal(next.name, fixture.caldari.corporations[1]);
  assert.match(next.ticker, /^[A-Z]{2,5}$/);
  assert.throws(() => names.chooseName(1, "corporations", { ...free, findCorporationByTickerName: () => true }), /No unused corporation names/);
  assert.equal(naturalTicker("Thurible & Crown Foundry"), "TCF");
});

test("empty arrays restore original naming and normal reads do not keep touching disk", (t) => {
  const file = directory(t); let reads = 0;
  const names = createNameLibrary({ file, fs: { ...fs, readFileSync(...args) { reads++; return fs.readFileSync(...args); } } });
  assert.equal(names.chooseName(1, "corporations", free), null);
  for (let i = 0; i < 100; i++) names.chooseName(1, "alliances", free);
  assert.equal(reads, 1);
  names.saveText(fixtureText);
  names.saveText(JSON.stringify(emptyLibrary()));
  assert.equal(names.chooseName(4, "corporations", free), null);
});

test("real dashboard proxy and private API give visible errors, persist once, and retain access boundaries", async (t) => {
  const names = createNameLibrary({ file: directory(t) }); let saves = 0;
  const { createPlayerBotAddonApiRuntime } = require("../integration/server/server/src/services/playerbots/playerBotAddonApiRuntime");
  const { createDashboardServer } = require("../addons/playerbots/dashboard-server");
  const token = "name-library-test-token-".repeat(2);
  const api = createPlayerBotAddonApiRuntime({ host: "127.0.0.1", port: 0, token,
    nameLibrary: { getStatus: names.getStatus, saveText(text) { saves++; return names.saveText(text); } },
    playerBots: {}, autonomy: {}, dashboard: {}, configuration: { getSettings: () => ({}) }, director: {},
    logger: { info() {}, warn() {} }, telemetry: { start() {}, stop() {} },
  });
  t.after(() => api.shutdown()); await api.start();
  const apiURL = `http://127.0.0.1:${api.getDiagnostics().port}`;
  const dashboard = createDashboardServer({ host: "127.0.0.1", port: 0, token, apiURL });
  await dashboard.start(); t.after(() => dashboard.shutdown());
  const url = `http://127.0.0.1:${dashboard.getDiagnostics().port}`;
  const submit = (text, origin = url) => fetch(`${url}/api/name-library`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ text }),
  });
  assert.equal((await fetch(`${apiURL}/v1/dashboard/name-library`)).status, 401);
  assert.equal((await submit(fixtureText, "http://another-server.invalid")).status, 403);
  const saved = await submit(fixtureText); assert.equal(saved.status, 200);
  assert.match((await saved.json()).message, /Saved/); assert.equal(saves, 1);
  const invalid = await submit("{"); assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Invalid JSON/);
  assert.deepEqual(JSON.parse((await (await fetch(`${url}/api/name-library`)).json()).text), fixture);
  assert.equal((await submit("x".repeat(17 * 1024))).status, 413);
});

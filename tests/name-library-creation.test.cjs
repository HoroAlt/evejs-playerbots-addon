"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../integration/server/server/src/services/playerbots");
const namesModule = require(path.join(root, "playerBotNameLibraryRuntime"));
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/name-library/four-empires.json"), "utf8");

function load(file, dependencies) {
  const module = { exports: {} };
  const actualRequire = createRequire(file);
  const context = vm.createContext({ module, exports: module.exports, process, console, Date, Map, Set,
    setImmediate, Buffer, require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id.startsWith("node:")) return actualRequire(id);
      throw Error(`Unexpected dependency: ${id}`);
    } });
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { api: module.exports, context };
}

function roster(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-creation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = namesModule.createNameLibrary({ file: path.join(dir, "names.json") }); names.saveText(fixture);
  const bots = {}, characters = new Map(), corporations = new Map(); let nextID = 1000;
  const authority = {
    findCorporationByFoundingOperationID: (key) => [...corporations.values()].find((c) => c.foundingOperationID === key),
    findCorporationByName: (name) => [...corporations.values()].find((c) => c.corporationName === name),
    findAllianceByExactName: () => null,
    findCorporationByTickerName: (ticker) => [...corporations.values()].find((c) => c.tickerName === ticker),
    findAllianceByShortName: () => null,
    getCorporationRecord: (id) => corporations.get(Number(id)),
    setCharacterAffiliation(id, corp) { characters.get(id).corporationID = corp; return { success: true }; },
    createCustomCorporation(id, name, options) {
      const corp = { corporationID: 2000 + corporations.size, corporationName: name, ceoID: id, creatorID: id,
        memberLimit: 300, memberCount: 1, description: `Capsuleer corporation ${name}.`, ...options };
      corporations.set(corp.corporationID, corp); characters.get(id).corporationID = corp.corporationID;
      return { success: true, data: { corporationRecord: corp } };
    },
  };
  const repository = { ensureTable() {}, read(_table, key) { return { success: true, data: key === "/" ? bots : bots[key.slice(1)] }; },
    write(_table, key, value) { bots[key.slice(1)] = value; return { success: true }; }, flushTableSync() { return { success: true }; } };
  const { api, context } = load(path.join(root, "playerBotRuntime.js"), {
    "../../gameStore/tableRepository": { createTableRepository: () => repository },
    "../character/characterState": { getCharacterRecord: (id) => characters.get(id), readSharedCharacterRecord: (id) => characters.get(id) },
    "../character/characterNameRuntime": { getValidRandomName: () => `Pilot ${nextID}`, validateCharacterName: () => 0, VALIDATION_CODE: { VALID: 0 } },
    "../corporation/corporationState": authority,
    "../corporation/corporationRuntimeState": { ensureCharacterMemberState() {}, getCorporationSessionRoleState() {},
      updateCorporationRecord(id, changes) { Object.assign(corporations.get(id), changes); return { success: true }; } },
    "./playerBotConfigurationRuntime": { getSettings: () => ({ rosterTarget: 100, rosterCeiling: 100 }) },
    "./playerBotCapacityRuntime": { getBotSystemID: () => 30000142 },
    "./playerBotOriginRuntime": { chooseOrigin: () => ({ raceID: [4, 1, 8, 2][characters.size % 4], bloodlineID: 1, schoolID: 1, stationID: 60000001 }) },
    "./playerBotNameRuntime": { generateBotName: () => `Pilot ${nextID}` },
    "./playerBotNameLibraryRuntime": { getRuntime: () => ({ chooseName: (race, type) => names.chooseName(race, type, authority) }) },
    "../character/charService": { createPlayerBotCharacter(name) {
      const id = nextID++; characters.set(id, { characterID: id, characterName: name });
      return { success: true, data: { characterID: id, characterName: name } };
    } },
    "./playerBotPortraitRuntime": { ensurePortrait() {} },
    "./playerBotEconomyRuntime": { hubStationForRace: () => 60000001 },
    "./playerBotProvisioningRuntime": { reconcileManagedCorporationMemberLimits() {} },
  });
  return { api, context, names, authority, bots, characters, corporations };
}

test("real roster seeding retains all six specialties and founding identities while using custom names", (t) => {
  const h = roster(t);
  const first = h.api.seedRoster(30, 6); assert.equal(first.created, 6, first.error);
  assert.equal(h.corporations.size, 6);
  for (const bot of Object.values(h.bots)) {
    const corp = h.corporations.get(bot.corporationID);
    assert.equal(corp.foundingOperationID, `evejs-playerbots:${bot.specialty}`);
    assert.equal(bot.specialtyCorporationID, corp.corporationID);
    assert.equal(corp.description, h.api.SPECIALTIES.find((s) => s.id === bot.specialty).name);
    assert.ok(!corp.corporationName.startsWith("EVEJS"));
    assert.match(corp.tickerName, /^[A-Z]{2,5}$/);
  }
  const ids = [...h.corporations.keys()];
  h.names.saveText(JSON.stringify(namesModule.emptyLibrary()));
  const next = h.api.seedRoster(30, 6); assert.equal(next.created, 6, next.error);
  assert.deepEqual([...h.corporations.keys()], ids);
  assert.equal(Object.keys(h.bots).length, 12);
});

test("name exhaustion fails before creating a founder character", (t) => {
  const h = roster(t), library = namesModule.emptyLibrary();
  library.amarr.corporations = ["Occupied Name"];
  h.names.saveText(JSON.stringify(library));
  h.corporations.set(999, { corporationID: 999, corporationName: "Occupied Name" });
  const result = h.api.seedRoster(30, 1);
  assert.match(result.error, /No unused corporation names/);
  assert.equal(h.characters.size, 0);
  assert.equal(Object.keys(h.bots).length, 0);
});

test("alliance plans keep existing pending identity after the configured library changes", (t) => {
  const h = roster(t), bot = { characterID: 1, corporationID: 2, specialty: "sovereignty" };
  const corp = { corporationID: 2, creatorID: 1, ceoID: 1, corporationName: "Existing Corporation" };
  let pending = null;
  const { api } = load(path.join(root, "playerBotAllianceRuntime.js"), {
    "../character/characterState": { getCharacterRecord: () => ({ corporationID: 2, raceID: 4 }) },
    "../corporation/corporationState": { getCorporationRecord: () => corp },
    "./playerBotOperationRecords": { listReadOnlyActiveOperations: () => [] },
    "./playerBotOperationRuntime": {},
    "../corporation/allianceFoundingState": { getPendingAllianceFounding: () => pending },
    "../corporation/corporationRuntimeState": { getCorporationMemberRoleMask: () => 0n },
    "../account/walletState": { getCharacterWallet: () => ({ balance: 3_000_000_000 }) },
    "../corporation/allianceFormationEligibility": { checkAllianceFormationEligibility: () => ({ success: true }) },
    "./playerBotRuntime": h.api,
    "./playerBotNameLibraryRuntime": { getRuntime: () => ({ chooseName: (race, type) => h.names.chooseName(race, type, h.authority), reportOnce() {} }) },
  });
  const plan = api.getAllianceFoundingPlan(bot);
  assert.equal(plan.name, "Hallowed Throne Concord");
  assert.equal(plan.description, "Sovereignty");
  pending = { characterID: 1, allianceOptions: { name: plan.name, shortName: plan.shortName, description: plan.description, url: "" } };
  h.names.saveText(JSON.stringify(namesModule.emptyLibrary()));
  assert.equal(api.getAllianceFoundingPlan(bot).name, plan.name);
  pending = null;
  assert.equal(api.getAllianceFoundingPlan(bot).name, "Existing Corporation Alliance");
  assert.equal(api.getAllianceFoundingPlan({ ...bot, specialty: "industry" }), null);
});

test("the unchanged director makes the same six specialty decisions when only the corporation name changes", () => {
  let corporationName = "EVEJS Industrial Union";
  const { api } = load(path.join(root, "playerBotDirectorRuntime.js"), {
    "../../gameStore/tableRepository": { createTableRepository: () => ({ ensureTable() {}, read() { return { success: true, data: {} }; } }) },
    "../character/characterState": { getCharacterRecord: () => ({ corporationID: 2000, corporationName }) },
    "../account/walletState": { getCharacterWallet: () => ({ balance: 100_000 }) },
    "./playerBotCapacityRuntime": {},
    "./playerBotEconomyRuntime": { BOT_HUB_STATION_ID: 60000001 },
    "./playerBotOperationRuntime": { nextPlanetaryLaunch: () => null, getOperation: () => null,
      findSellableGoodsStation: () => null, nextShipUpgrade: () => null, hasRoleShipFit: () => true },
    "./playerBotMiningEscortRuntime": { findPendingMiningEscortRequest: () => null },
    "./playerBotStructureRuntime": { findStructurePackage: () => null },
    "./playerBotWarMobilizationRuntime": { getActiveWarCombatAssignment: () => null, getCombatUpgradeSupport: () => null },
    "../planet/planetRuntimeStore": { listColoniesForCharacter: () => [] },
    "./playerBotColonyRuntime": { hasColonySkill: (bot) => bot.specialty === "planetary" },
    "./playerBotIndustryCycleRuntime": { getCycle: () => null },
    "./playerBotCorpEconomyRuntime": { getCumulativeNetProfit: () => ({ reinvestableProfit: 0 }) },
    "../corporation/warRuntimeState": { hasActiveWarForCharacter: () => true },
    "./playerBotAllianceRuntime": { getAllianceFoundingPlan: () => null },
    "./playerBotSovereigntyRuntime": { findSovereigntyObjective: () => ({ systemID: 42 }) },
  });
  for (const [specialty, expected] of [["trade", "mine"], ["industry", "industry"], ["planetary", "colony"],
    ["security", "combat"], ["piracy", "combat"], ["sovereignty", "sovereignty"]]) {
    const bot = { characterID: 1000, corporationID: 2000, specialtyCorporationID: 2000, specialty };
    corporationName = `EVEJS ${specialty}`;
    const before = JSON.stringify(api._testing.chooseAssignment(bot));
    corporationName = "Wrecker's Banner Cooperative";
    const after = JSON.stringify(api._testing.chooseAssignment(bot));
    assert.equal(after, before, specialty);
    assert.equal(JSON.parse(after).kind, expected);
  }
});

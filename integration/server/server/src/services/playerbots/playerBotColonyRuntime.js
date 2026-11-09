"use strict";

// Planetary colonies built by planetary bots through the same network edit a
// pilot's client submits (planetMgr.UserUpdateNetwork): command center from
// the ship's cargo, an extractor with heads on the richest spot found, a
// basic factory and the routes between them. Construction is paid from the
// bot's wallet by the PI authority; kit purchases use regional stock first and
// the Jita seed market only as a fallback.

const worldData = require("../../space/worldData");

// Keep the original Barren recipe as a fallback for colonies already in flight.
const PLAN = Object.freeze({
  planetTypeID: 2016,
  commandCenterTypeID: 2524,
  extractorTypeID: 2848,
  factoryTypeID: 2473,
  resourceTypeID: 2267,
  schematicID: 126,
  productTypeID: 2398,
  commandCenterLevel: 1,
});
const COMMAND = Object.freeze({ CREATEPIN: 1, CREATELINK: 3, CREATEROUTE: 6, SETSCHEMATIC: 8, UPGRADECC: 9, ADDHEAD: 10, INSTALLPROGRAM: 13 });
const HEAD_COUNT = 5;
const HEAD_RADIUS = 0.01;
const PIN_SPACING = 0.012;
const COMMAND_CENTER_UPGRADES_SKILL = 2505;
const COMMAND_CENTER_LEVEL = 1;
const PLANETARY_INDUSTRY_CATEGORY_ID = 41;
const COMMAND_CENTER_GROUP_ID = 1027;
const BASIC_FACTORY_GROUP_ID = 1028;
const ADVANCED_FACTORY_GROUP_ID = 1028;
const EXTRACTOR_GROUP_ID = 1063;
const FACTORY_TYPE_ID = 2473;
const EXTRACTOR_TYPE_ID = 2848;
const P2_COMMAND_CENTER_LEVEL = 4;
const MAX_PLANETARY_TIER = 4;
const PI_PLAN_VERSION = 3;
// A command center takes 1,000 m³: carried in a Badger bought in Jita.
const HAULER_TYPE_ID = 648;
const MAX_KIT_SPEND = 35_000_000;
let kitPurchaseQueue = Promise.resolve();

function getPlanetRuntime() {
  return require("../planet/planetRuntimeStore");
}

function getPlanetaryStaticData() {
  return require("../planet/planetStaticData");
}

const planetPinTypeIDs = new Map();
function getPlanetRestrictedPinTypeID(planetTypeID, groupID, entityType, processorTier = null) {
  const restriction = Number(planetTypeID) || 0;
  const cacheKey = `${restriction}:${groupID}:${entityType}:${processorTier || ""}`;
  if (planetPinTypeIDs.has(cacheKey)) return planetPinTypeIDs.get(cacheKey);
  const planetStaticData = getPlanetaryStaticData();
  const candidates = require("../inventory/itemTypeRegistry").listItemTypes()
    .filter((type) => Number(type.categoryID) === PLANETARY_INDUSTRY_CATEGORY_ID &&
      Number(type.groupID) === Number(groupID))
    .map((type) => ({ type, info: planetStaticData.getPITypeInfo(Number(type.typeID)) }))
    .filter(({ info }) => info && Number(info.planetRestrictionTypeID) === restriction &&
      info.pinEntityType === entityType &&
      (!processorTier || info.processorTier === processorTier))
    .sort((left, right) =>
      Number(right.type.published === true) - Number(left.type.published === true) ||
      String(left.type.name || "").length - String(right.type.name || "").length);
  const typeID = Number(candidates[0] && candidates[0].type.typeID) || 0;
  planetPinTypeIDs.set(cacheKey, typeID);
  return typeID;
}

function getCommandCenterTypeID(planetTypeID) {
  return getPlanetRestrictedPinTypeID(planetTypeID, COMMAND_CENTER_GROUP_ID, "command");
}

function getExtractorTypeID(planetTypeID) {
  return getPlanetRestrictedPinTypeID(planetTypeID, EXTRACTOR_GROUP_ID, "ecu");
}

function getBasicFactoryTypeID(planetTypeID) {
  return getPlanetRestrictedPinTypeID(planetTypeID, BASIC_FACTORY_GROUP_ID, "process", "basic");
}

function getAdvancedFactoryTypeID(planetTypeID) {
  return getPlanetRestrictedPinTypeID(planetTypeID, ADVANCED_FACTORY_GROUP_ID, "process", "advanced");
}

const p1SchematicsByFactoryAndResource = new Map();
function getP1SchematicForResource(resourceTypeID, factoryTypeID = FACTORY_TYPE_ID) {
  const cacheKey = `${Number(factoryTypeID)}:${Number(resourceTypeID)}`;
  if (p1SchematicsByFactoryAndResource.has(cacheKey)) {
    return p1SchematicsByFactoryAndResource.get(cacheKey);
  }
  const planetStaticData = getPlanetaryStaticData();
  const schematic = planetStaticData.getAllSchematics().find((entry) =>
    Array.isArray(entry.inputs) && entry.inputs.length === 1 &&
    Array.isArray(entry.outputs) && entry.outputs.length === 1 &&
    Array.isArray(entry.pinTypeIDs) && entry.pinTypeIDs.includes(Number(factoryTypeID)) &&
    Number(entry.inputs[0].typeID) === Number(resourceTypeID) &&
    planetStaticData.isPlanetaryResource(entry.inputs[0].typeID),
  ) || null;
  p1SchematicsByFactoryAndResource.set(cacheKey, schematic);
  return schematic;
}

function getP1SchematicForProduct(productTypeID, factoryTypeID) {
  const staticData = getPlanetaryStaticData();
  return staticData.getAllSchematics().find((entry) =>
    Array.isArray(entry.inputs) && entry.inputs.length === 1 &&
    Array.isArray(entry.outputs) && entry.outputs.length === 1 &&
    Array.isArray(entry.pinTypeIDs) && entry.pinTypeIDs.includes(Number(factoryTypeID)) &&
    Number(entry.outputs[0].typeID) === Number(productTypeID) &&
    staticData.isPlanetaryResource(entry.inputs[0].typeID) &&
    Number(staticData.getCommodityTier(entry.outputs[0].typeID)) === 1,
  ) || null;
}

function getCommandCenterUpgradeLevel(characterID) {
  const map = require("../skills/skillState").getCharacterSkillMap(Number(characterID) || 0);
  const record = map && (map.get ? map.get(COMMAND_CENTER_UPGRADES_SKILL) : map[COMMAND_CENTER_UPGRADES_SKILL]);
  return Math.max(0, Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0);
}

function buildP1NetworkPlan(planetTypeID, commandCenterTypeID, extractorTypeID, factoryTypeID, resources, coverage) {
  const p1Recipes = resources.map((resourceTypeID) => ({
    resourceTypeID: Number(resourceTypeID),
    schematic: getP1SchematicForResource(resourceTypeID, factoryTypeID),
  })).filter((entry) => entry.schematic);
  if (!p1Recipes.length) return null;
  p1Recipes.sort((left, right) => {
    const leftCount = Number(coverage && coverage.planetResourceCounts &&
      coverage.planetResourceCounts.get(`${planetTypeID}:${left.resourceTypeID}`)) || 0;
    const rightCount = Number(coverage && coverage.planetResourceCounts &&
      coverage.planetResourceCounts.get(`${planetTypeID}:${right.resourceTypeID}`)) || 0;
    return leftCount - rightCount || left.resourceTypeID - right.resourceTypeID;
  });
  const selected = p1Recipes[0];
  const output = selected.schematic.outputs[0];
  return {
    planVersion: PI_PLAN_VERSION,
    planetTypeID,
    piTier: 1,
    commandCenterTypeID,
    commandCenterLevel: 1,
    extractorTypeID,
    factoryTypeID,
    resourceTypeID: selected.resourceTypeID,
    resourceTypeIDs: [selected.resourceTypeID],
    schematicID: Number(selected.schematic.schematicID),
    productTypeID: Number(output.typeID),
    extractionLines: [{
      resourceTypeID: selected.resourceTypeID,
      extractorTypeID,
      processTypeID: factoryTypeID,
      schematicID: Number(selected.schematic.schematicID),
      productTypeID: Number(output.typeID),
      outputQuantity: Number(output.quantity) || 20,
    }],
    processLines: [{
      processTypeID: factoryTypeID,
      schematicID: Number(selected.schematic.schematicID),
      inputTypeIDs: [selected.resourceTypeID],
      inputQuantities: [Number(selected.schematic.inputs[0].quantity)],
      outputTypeID: Number(output.typeID),
      outputQuantity: Number(output.quantity) || 20,
      cycleTime: Number(selected.schematic.cycleTime) || 0,
    }],
  };
}

function buildAdvancedTierNetworkPlan(planetTypeID, commandCenterTypeID, extractorTypeID,
  factoryTypeID, advancedFactoryTypeID, resources, coverage, maxTier) {
  if (!advancedFactoryTypeID || maxTier < 2) return null;
  const staticData = getPlanetaryStaticData();
  const resourceSet = new Set(resources.map(Number));
  const schematicsByOutput = new Map();
  for (const schematic of staticData.getAllSchematics()) {
    if (!Array.isArray(schematic.inputs) || !schematic.inputs.length ||
        !Array.isArray(schematic.outputs) || schematic.outputs.length !== 1) continue;
    const outputTypeID = Number(schematic.outputs[0].typeID) || 0;
    const tier = Number(staticData.getCommodityTier(outputTypeID)) || 0;
    if (!outputTypeID || tier < 1 || tier > maxTier) continue;
    if (!schematicsByOutput.has(outputTypeID)) schematicsByOutput.set(outputTypeID, []);
    schematicsByOutput.get(outputTypeID).push(schematic);
  }
  for (const choices of schematicsByOutput.values()) {
    choices.sort((left, right) => Number(left.schematicID) - Number(right.schematicID));
  }

  const cloneState = (state) => ({
    processByProduct: new Map(state.processByProduct),
    extractionByResource: new Map(state.extractionByResource),
    visiting: new Set(state.visiting),
  });
  function addProduct(productTypeID, state) {
    const product = Number(productTypeID) || 0;
    const tier = Number(staticData.getCommodityTier(product)) || 0;
    if (tier <= 0 || tier > maxTier || state.visiting.has(product)) return null;
    if (state.processByProduct.has(product)) return state;
    const processTypeID = tier === 1 ? factoryTypeID : advancedFactoryTypeID;
    const choices = (schematicsByOutput.get(product) || []).filter((schematic) =>
      Number(staticData.getCommodityTier(product)) === tier &&
      Array.isArray(schematic.pinTypeIDs) && schematic.pinTypeIDs.includes(Number(processTypeID)),
    );
    for (const schematic of choices) {
      const branch = cloneState(state);
      branch.visiting.add(product);
      let feasible = true;
      if (tier === 1) {
        const rawInput = schematic.inputs.length === 1 ? Number(schematic.inputs[0].typeID) || 0 : 0;
        if (!rawInput || !resourceSet.has(rawInput) || !staticData.isPlanetaryResource(rawInput)) {
          feasible = false;
        } else {
          branch.extractionByResource.set(product, {
            resourceTypeID: rawInput,
            extractorTypeID,
            processTypeID,
            schematicID: Number(schematic.schematicID),
            productTypeID: product,
            outputQuantity: Number(schematic.outputs[0].quantity) || 20,
          });
        }
      } else {
        for (const input of schematic.inputs) {
          const inputTypeID = Number(input.typeID) || 0;
          if (Number(staticData.getCommodityTier(inputTypeID)) < 1) {
            feasible = false;
            break;
          }
          const next = addProduct(inputTypeID, branch);
          if (!next) {
            feasible = false;
            break;
          }
          branch.processByProduct = next.processByProduct;
          branch.extractionByResource = next.extractionByResource;
          branch.visiting = next.visiting;
        }
      }
      branch.visiting.delete(product);
      if (!feasible) continue;
      branch.processByProduct.set(product, {
        processTypeID,
        schematicID: Number(schematic.schematicID),
        inputTypeIDs: schematic.inputs.map((input) => Number(input.typeID)),
        inputQuantities: schematic.inputs.map((input) => Number(input.quantity)),
        outputTypeID: product,
        outputQuantity: Number(schematic.outputs[0].quantity) || 1,
        cycleTime: Number(schematic.cycleTime) || 0,
      });
      return branch;
    }
    return null;
  }

  function hasSustainableRoutes(processLines) {
    return processLines.every((producer) => {
      const requiredPerProducerCycle = processLines.reduce((total, consumer) => {
        const matchingInputs = consumer.inputTypeIDs.map(Number).flatMap((typeID, index) =>
          typeID === Number(producer.outputTypeID) ? [index] : [],
        );
        if (!matchingInputs.length) return total;
        const producerCycle = Number(producer.cycleTime) || 1;
        const consumerCycle = Number(consumer.cycleTime) || producerCycle;
        return total + matchingInputs.reduce((quantity, inputIndex) => quantity + Math.ceil(
          Number(consumer.inputQuantities[inputIndex]) * producerCycle / consumerCycle,
        ), 0);
      }, 0);
      return requiredPerProducerCycle <= Number(producer.outputQuantity);
    });
  }

  for (let tier = Math.min(MAX_PLANETARY_TIER, maxTier); tier >= 2; tier -= 1) {
    const products = [...schematicsByOutput.keys()]
      .filter((productTypeID) => Number(staticData.getCommodityTier(productTypeID)) === tier)
      .sort((left, right) => left - right);
    const candidates = [];
    for (const productTypeID of products) {
      const state = addProduct(productTypeID, {
        processByProduct: new Map(),
        extractionByResource: new Map(),
        visiting: new Set(),
      });
      if (!state) continue;
      const processLines = [...state.processByProduct.values()];
      const extractionLines = [...state.extractionByResource.values()];
      if (!extractionLines.length || !hasSustainableRoutes(processLines)) continue;
      const coverageCount = extractionLines.reduce((total, line) => total +
        (Number(coverage && coverage.planetResourceCounts &&
          coverage.planetResourceCounts.get(`${planetTypeID}:${line.resourceTypeID}`)) || 0), 0);
      candidates.push({ productTypeID, processLines, extractionLines, coverageCount });
    }
    if (!candidates.length) continue;
    candidates.sort((left, right) => left.coverageCount - right.coverageCount ||
      left.extractionLines.length - right.extractionLines.length ||
      left.processLines.length - right.processLines.length ||
      left.productTypeID - right.productTypeID);
    const selected = candidates[0];
    const commandCenterLevel = tier >= 3 ? 5 : P2_COMMAND_CENTER_LEVEL;
    return {
      planVersion: PI_PLAN_VERSION,
      planetTypeID,
      piTier: tier,
      commandCenterTypeID,
      commandCenterLevel,
      extractorTypeID,
      factoryTypeID,
      advancedFactoryTypeID,
      resourceTypeID: selected.extractionLines[0].resourceTypeID,
      resourceTypeIDs: selected.extractionLines.map((line) => line.resourceTypeID),
      schematicID: Number(selected.processLines.find((line) =>
        Number(line.outputTypeID) === Number(selected.productTypeID))?.schematicID) || 0,
      productTypeID: selected.productTypeID,
      extractionLines: selected.extractionLines,
      processLines: selected.processLines,
    };
  }
  return null;
}

function getSystemColonyCoverage(solarSystemID) {
  const planetRuntime = getPlanetRuntime();
  const planetStaticData = getPlanetaryStaticData();
  const coverage = {
    planetCounts: new Map(),
    planetResourceCounts: new Map(),
    colonyCountsByPlanet: new Map(),
  };
  const planets = (worldData.getCelestialsForSystem(solarSystemID) || [])
    .filter((celestial) => Number(celestial.groupID) === 7 &&
      planetStaticData.getPlanetResourceTypeIDs(Number(celestial.typeID)).length > 0 &&
      getCommandCenterTypeID(celestial.typeID) > 0);
  for (const planet of planets) {
    const planetTypeID = Number(planet.typeID);
    const resources = new Set(planetStaticData.getPlanetResourceTypeIDs(planetTypeID));
    const colonies = typeof planetRuntime.listColoniesForPlanet === "function"
      ? planetRuntime.listColoniesForPlanet(Number(planet.itemID))
      : [];
    coverage.colonyCountsByPlanet.set(Number(planet.itemID), colonies.length);
    coverage.planetCounts.set(planetTypeID,
      (coverage.planetCounts.get(planetTypeID) || 0) + colonies.length);
    for (const colony of colonies) {
      if (!colony) continue;
      for (const pin of Array.isArray(colony.pins) ? colony.pins : []) {
        const resourceTypeID = Number(pin.programType ?? pin.programTypeID ?? pin.resourceTypeID) || 0;
        if (!resources.has(resourceTypeID)) continue;
        const key = `${planetTypeID}:${resourceTypeID}`;
        coverage.planetResourceCounts.set(key, (coverage.planetResourceCounts.get(key) || 0) + 1);
      }
    }
  }
  return { planets, coverage };
}

function getNetworkPlan(planet, coverage = null, options = {}) {
  const planetStaticData = getPlanetaryStaticData();
  const planetTypeID = Number(planet && planet.typeID) || 0;
  const commandCenterTypeID = getCommandCenterTypeID(planetTypeID);
  const extractorTypeID = getExtractorTypeID(planetTypeID);
  const factoryTypeID = getBasicFactoryTypeID(planetTypeID);
  if (!planetTypeID || !commandCenterTypeID || !extractorTypeID || !factoryTypeID) return null;
  const resources = planetStaticData.getPlanetResourceTypeIDs(planetTypeID).map(Number);
  const commandCenterUpgradeLevel = Math.max(0, Number(options.commandCenterUpgradeLevel) || 0);
  const skillTier = commandCenterUpgradeLevel >= 5 ? MAX_PLANETARY_TIER
    : commandCenterUpgradeLevel >= P2_COMMAND_CENTER_LEVEL ? 2 : 1;
  const maxTier = Math.min(skillTier, Math.max(1, Number(options.maxPlanetaryTier) || skillTier));
  const advancedPlan = buildAdvancedTierNetworkPlan(
    planetTypeID,
    commandCenterTypeID,
    extractorTypeID,
    factoryTypeID,
    getAdvancedFactoryTypeID(planetTypeID),
    resources,
    coverage,
    maxTier,
  );
  return advancedPlan || buildP1NetworkPlan(
    planetTypeID,
    commandCenterTypeID,
    extractorTypeID,
    factoryTypeID,
    resources,
    coverage,
  );
}

function candidatePlanets(solarSystemID, characterID, options = {}) {
  const planetRuntime = getPlanetRuntime();
  const ownColonies = new Set(planetRuntime.listColoniesForCharacter(characterID)
    .map((colony) => Number(colony.planetID)));
  const { planets, coverage } = getSystemColonyCoverage(solarSystemID);
  return planets
    .filter((celestial) => !ownColonies.has(Number(celestial.itemID)) &&
      getNetworkPlan(celestial, coverage, options))
    // First cover planet classes, then spread extractors across planets of
    // that class. Resource selection balances the P0 recipes within each class.
    .sort((left, right) =>
      (coverage.planetCounts.get(Number(left.typeID)) || 0) -
        (coverage.planetCounts.get(Number(right.typeID)) || 0) ||
      (coverage.colonyCountsByPlanet.get(Number(left.itemID)) || 0) -
        (coverage.colonyCountsByPlanet.get(Number(right.itemID)) || 0) ||
      Number(left.itemID) - Number(right.itemID));
}

function planetMeta(planet) {
  return {
    planetID: Number(planet.itemID),
    typeID: Number(planet.typeID),
    solarSystemID: Number(planet.solarSystemID),
    radius: Number(planet.radius) || 0,
  };
}

// Sample the resource map and return the richest point (radians).
function findBestSpot(planet, resourceTypeID = PLAN.resourceTypeID, options = {}) {
  const runtime = getPlanetRuntime();
  const resourceTypeIDs = getPlanetaryStaticData().getPlanetResourceTypeIDs(Number(planet.typeID));
  runtime.getOrCreatePlanetResources(planetMeta(planet), resourceTypeIDs);
  let best = { value: -1, latitude: Math.PI / 2, longitude: Math.PI };
  const origin = options.near || null;
  const maxAngularDistance = Math.max(0, Number(options.maxAngularDistance) || 0);
  const sample = (latitude, longitude) => {
    latitude = Math.min(Math.PI - 0.2, Math.max(0.2, latitude));
    longitude = (longitude + 2 * Math.PI) % (2 * Math.PI);
    const point = { latitude, longitude };
    if (origin && maxAngularDistance > 0 && angularDistance(origin, point) > maxAngularDistance) return;
    const value = Number(runtime.evaluateResourceValueAt(Number(planet.itemID), Number(resourceTypeID), latitude, longitude)) || 0;
    if (value > best.value) best = { value, latitude, longitude };
  };
  for (let i = 1; i < 24; i += 1) {
    for (let j = 0; j < 48; j += 1) sample((Math.PI * i) / 24, (2 * Math.PI * j) / 48);
  }
  // Refine the strongest sampled area while keeping every structure away from the poles.
  let step = Math.PI / 24;
  for (let pass = 0; pass < 5; pass += 1) {
    const origin = { ...best };
    for (let lat = -1; lat <= 1; lat += 1) {
      for (let lon = -1; lon <= 1; lon += 1) sample(origin.latitude + lat * step, origin.longitude + lon * step);
    }
    step /= 2;
  }
  if (best.value <= 0 && origin) return findBestSpot(planet, resourceTypeID);
  return best;
}

function angularDistance(left, right) {
  const cosine = Math.sin(left.latitude) * Math.sin(right.latitude) +
    Math.cos(left.latitude) * Math.cos(right.latitude) * Math.cos(left.longitude - right.longitude);
  return Math.acos(Math.max(-1, Math.min(1, cosine)));
}

function buildNetworkStream(commandCenterItemID, spotOrSpots, plan = PLAN) {
  const extractionLines = Array.isArray(plan.extractionLines) && plan.extractionLines.length
    ? plan.extractionLines
    : [{ resourceTypeID: plan.resourceTypeID, extractorTypeID: plan.extractorTypeID,
      processTypeID: plan.factoryTypeID, schematicID: plan.schematicID,
      productTypeID: plan.productTypeID, outputQuantity: 20 }];
  const processLines = Array.isArray(plan.processLines) && plan.processLines.length
    ? plan.processLines
    : [{ processTypeID: plan.factoryTypeID, schematicID: plan.schematicID,
      inputTypeIDs: [plan.resourceTypeID], inputQuantities: [3000],
      outputTypeID: plan.productTypeID, outputQuantity: 20 }];
  const spots = Array.isArray(spotOrSpots) ? spotOrSpots : [spotOrSpots];
  const origin = spots[0] || { latitude: Math.PI / 2, longitude: Math.PI };
  const pinIDs = [];
  let nextPinID = 1;
  const stream = [
    [COMMAND.CREATEPIN, [commandCenterItemID, plan.commandCenterTypeID, origin.latitude, origin.longitude]],
    [COMMAND.UPGRADECC, [commandCenterItemID, plan.commandCenterLevel || COMMAND_CENTER_LEVEL]],
  ];
  for (const line of extractionLines) {
    const ecu = [1, nextPinID++];
    const location = spots[pinIDs.length] || origin;
    pinIDs.push(ecu);
    stream.push([COMMAND.CREATEPIN, [ecu, line.extractorTypeID || plan.extractorTypeID,
      location.latitude + PIN_SPACING, location.longitude]]);
    stream.push([COMMAND.CREATELINK, [commandCenterItemID, ecu, 0]]);
  }
  const processorIDs = processLines.map((line) => [1, nextPinID++]);
  for (let index = 0; index < processLines.length; index += 1) {
    const processPin = processorIDs[index];
    const angle = (2 * Math.PI * index) / Math.max(1, processLines.length);
    const latitude = origin.latitude - PIN_SPACING * (1 + Math.cos(angle));
    const longitude = (origin.longitude + PIN_SPACING * Math.sin(angle) + 2 * Math.PI) % (2 * Math.PI);
    stream.push([COMMAND.CREATEPIN, [processPin, processLines[index].processTypeID,
      latitude, longitude]]);
    stream.push([COMMAND.CREATELINK, [commandCenterItemID, processPin, 0]]);
  }
  for (let index = 0; index < extractionLines.length; index += 1) {
    const ecu = pinIDs[index];
    const line = extractionLines[index];
    for (let head = 0; head < HEAD_COUNT; head += 1) {
      const angle = (2 * Math.PI * head) / HEAD_COUNT;
      const headLongitude = (spots[index].longitude + 0.006 * Math.sin(angle) + 2 * Math.PI) % (2 * Math.PI);
      stream.push([COMMAND.ADDHEAD, [ecu, head,
        spots[index].latitude + PIN_SPACING + 0.006 * Math.cos(angle), headLongitude]]);
    }
    stream.push([COMMAND.INSTALLPROGRAM, [ecu, line.resourceTypeID, HEAD_RADIUS]]);
  }
  for (let index = 0; index < processLines.length; index += 1) {
    stream.push([COMMAND.SETSCHEMATIC, [processorIDs[index], processLines[index].schematicID]]);
  }
  let nextRouteID = 1;
  const route = (path, typeID, quantity) => {
    stream.push([COMMAND.CREATEROUTE, [[2, nextRouteID++], path, Number(typeID), Math.max(1, Math.trunc(Number(quantity) || 1))]]);
  };
  for (let index = 0; index < extractionLines.length; index += 1) {
    const ecu = pinIDs[index];
    const line = extractionLines[index];
    const processorIndex = processLines.findIndex((candidate) =>
      Number(candidate.outputTypeID) === Number(line.productTypeID),
    );
    if (processorIndex < 0) {
      throw new Error(`PI extraction for resource ${line.resourceTypeID} has no P1 processor.`);
    }
    route([ecu, commandCenterItemID, processorIDs[processorIndex]], line.resourceTypeID, 3000);
  }
  for (let index = 0; index < processLines.length; index += 1) {
    const line = processLines[index];
    const output = Number(line.outputTypeID) || 0;
    let routedQuantity = 0;
    for (let consumerIndex = 0; consumerIndex < processLines.length; consumerIndex += 1) {
      const consumer = processLines[consumerIndex];
      const matchingInputs = consumer.inputTypeIDs.map(Number).flatMap((typeID, inputIndex) =>
        typeID === output ? [inputIndex] : [],
      );
      if (!matchingInputs.length) continue;
      if (consumerIndex <= index) {
        throw new Error(`PI plan is not topologically ordered for commodity ${output}.`);
      }
      const producerCycle = Number(line.cycleTime) || Number(consumer.cycleTime) || 1;
      const consumerCycle = Number(consumer.cycleTime) || producerCycle;
      const routeQuantity = matchingInputs.reduce((quantity, inputIndex) => quantity + Math.ceil(
        Number(consumer.inputQuantities[inputIndex]) * producerCycle / consumerCycle,
      ), 0);
      if (routedQuantity + routeQuantity > Number(line.outputQuantity)) {
        throw new Error(`PI plan overcommits production of commodity ${output}.`);
      }
      route([processorIDs[index], commandCenterItemID, processorIDs[consumerIndex]], output, routeQuantity);
      routedQuantity += routeQuantity;
    }
    const surplus = Number(line.outputQuantity) - routedQuantity;
    if (surplus > 0) route([processorIDs[index], commandCenterItemID], output, surplus);
  }
  return stream;
}

function hasColonySkill(bot) {
  const map = require("../skills/skillState").getCharacterSkillMap(bot.characterID);
  const record = map && (map.get ? map.get(COMMAND_CENTER_UPGRADES_SKILL) : map[COMMAND_CENTER_UPGRADES_SKILL]);
  return (Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0) >= COMMAND_CENTER_LEVEL;
}

function planForOperation(operation) {
  const planetTypeID = Number(operation && operation.planetTypeID) || 0;
  if (!planetTypeID) return PLAN;
  const savedPlan = operation && operation.piPlan;
  if (savedPlan && [2, PI_PLAN_VERSION].includes(Number(savedPlan.planVersion)) &&
      Number(savedPlan.planetTypeID) === planetTypeID) {
    return JSON.parse(JSON.stringify(savedPlan));
  }
  const dynamicPlan = getNetworkPlan({ typeID: planetTypeID }, null, {
    commandCenterUpgradeLevel: Number(operation && operation.commandCenterUpgradeLevel) || 0,
  });
  if (!dynamicPlan) return PLAN;
  if (Number(dynamicPlan.piTier) > 1) return dynamicPlan;
  const availableResources = getPlanetaryStaticData().getPlanetResourceTypeIDs(planetTypeID);
  const requestedResource = Number(operation.resourceTypeID) || 0;
  const resourceTypeID = availableResources.includes(requestedResource) &&
    getP1SchematicForResource(requestedResource, dynamicPlan.factoryTypeID)
    ? requestedResource
    : dynamicPlan.resourceTypeID;
  const schematic = getP1SchematicForResource(resourceTypeID, dynamicPlan.factoryTypeID);
  return {
    ...dynamicPlan,
    commandCenterLevel: Number(operation.commandCenterLevel) || COMMAND_CENTER_LEVEL,
    resourceTypeID,
    schematicID: Number(schematic && schematic.schematicID) || dynamicPlan.schematicID,
    productTypeID: Number(schematic && schematic.outputs[0].typeID) || dynamicPlan.productTypeID,
  };
}

function saveColonyTarget(operation, bot, solarSystemID, kit) {
  const commandCenterUpgradeLevel = getCommandCenterUpgradeLevel(bot.characterID);
  const planet = candidatePlanets(solarSystemID, bot.characterID, {
    commandCenterUpgradeLevel,
  })[0];
  if (!planet) return null;
  const { coverage } = getSystemColonyCoverage(solarSystemID);
  const plan = getNetworkPlan(planet, coverage, { commandCenterUpgradeLevel });
  if (!plan) return null;
  Object.assign(operation, {
    planetID: Number(planet.itemID),
    solarSystemID: Number(planet.solarSystemID),
    commandCenterUpgradeLevel,
    piPlan: JSON.parse(JSON.stringify(plan)),
    ...plan,
  });
  kit.save(operation);
  return planet;
}

function getTypeName(typeID, fallback = String(typeID)) {
  return require("../inventory/itemTypeRegistry").resolveItemByTypeID(Number(typeID))?.name || fallback;
}

function buyOneWithQuoteRefresh(trade, characterName, typeID, quotedPrice, remainingBudget) {
  const purchase = async () => {
    let result = await trade.buy(characterName, typeID, 1, quotedPrice);
    if (!result.success || Number(result.bought) > 0) return result;

    // A quote can become stale between the read and the market fill. Confirm a
    // fresh ask and allow a small bounded slippage before waiting for a retry.
    const refreshed = await trade.readQuote(characterName, typeID);
    if (!refreshed.success || !refreshed.bestAsk) {
      return { success: false, message: `No ${getTypeName(typeID)} seller is currently available.` };
    }
    const maxPrice = Math.round(Math.min(
      Number(remainingBudget) || 0,
      Number(refreshed.bestAsk.price) * 1.02,
    ) * 100) / 100;
    if (!(maxPrice >= Number(refreshed.bestAsk.price)) || maxPrice <= 0) {
      return { success: false, message: `The refreshed ${getTypeName(typeID)} ask exceeds the remaining PI budget.` };
    }
    result = await trade.buy(characterName, typeID, 1, maxPrice);
    if (result.success && Number(result.bought) < 1) {
      return { success: false, message: `The market did not fill the ${getTypeName(typeID)} purchase.` };
    }
    return result;
  };
  const queuedPurchase = kitPurchaseQueue.then(purchase, purchase);
  kitPurchaseQueue = queuedPurchase.then(() => undefined, () => undefined);
  return queuedPurchase;
}

function recordColonyAction(operation, message) {
  operation.lastAction = String(message).slice(0, 300);
  operation.history = [
    ...(Array.isArray(operation.history) ? operation.history : []),
    { at: new Date().toISOString(), stage: operation.stage, message: operation.lastAction },
  ].slice(-25);
}

function capturePurchaseMarker(bot, inventory, typeID, stationID) {
  const transactions = require("../account/walletState").getCharacterMarketTransactions(bot.characterID);
  return {
    action: "buy",
    typeID: Number(typeID),
    quantity: 1,
    stationID: Number(stationID),
    baselineUnits: inventory.countHangar(bot, stationID, typeID) + inventory.countCargo(bot, typeID),
    baselineTransactionID: transactions.reduce((highest, row) => Math.max(highest, Number(row.transactionID) || 0), 0),
    startedAt: new Date().toISOString(),
  };
}

function fileTimeToMs(value) {
  const ticks = Number(value);
  return Number.isFinite(ticks) ? (ticks - 116444736000000000) / 10_000 : 0;
}

function reconcilePendingPurchase(operation, bot, inventory, fallbackStationID) {
  const pending = operation && operation.pending;
  if (!pending || pending.action !== "buy") return "none";
  const stationID = Number(pending.stationID || fallbackStationID) || 0;
  const typeID = Number(pending.typeID) || 0;
  const expected = Math.max(1, Math.trunc(Number(pending.quantity) || 1));
  const baselineUnits = Math.max(0, Math.trunc(Number(pending.baselineUnits) || 0));
  const presentUnits = inventory.countHangar(bot, stationID, typeID) + inventory.countCargo(bot, typeID);
  const baselineTransactionID = Number(pending.baselineTransactionID) || 0;
  const startedAtMs = Date.parse(pending.startedAt || operation.createdAt || "") || 0;
  const transactions = require("../account/walletState").getCharacterMarketTransactions(bot.characterID).filter((entry) =>
    Number(entry.typeID) === typeID && Number(entry.buyerID) === Number(bot.characterID) &&
    Number(entry.stationID) === stationID &&
    (baselineTransactionID > 0
      ? Number(entry.transactionID) > baselineTransactionID
      : !startedAtMs || fileTimeToMs(entry.transactionDate) >= startedAtMs - 1000),
  );
  const bought = transactions.reduce((total, entry) => total + Math.max(0, Number(entry.quantity) || 0), 0);
  if (bought >= expected && presentUnits >= baselineUnits + expected) {
    const spent = transactions.reduce((total, entry) =>
      total + Math.max(0, Number(entry.quantity) || 0) * Math.max(0, Number(entry.price) || 0), 0);
    operation.spent = Math.round(((Number(operation.spent) || 0) + spent) * 100) / 100;
    operation.pending = null;
    operation.status = "active";
    operation.lastError = null;
    recordColonyAction(operation, `Recovered confirmed purchase of ${expected}× ${typeID} at ${stationID} for ${spent.toFixed(2)} ISK; continuing colony setup.`);
    return "confirmed";
  }
  if (bought === 0 && presentUnits <= baselineUnits) {
    operation.pending = null;
    operation.status = "active";
    operation.lastError = null;
    recordColonyAction(operation, `Confirmed purchase of ${typeID} did not complete; it is safe to retry.`);
    return "not-completed";
  }
  return "unresolved";
}

// One step of the colony operation; `kit` supplies the operation helpers.
async function advanceColony(operation, bot, kit) {
  const economy = require("./playerBotEconomyRuntime");
  const inventory = require("./playerBotInventoryRuntime");
  const trade = require("./playerBotTradeRuntime");
  const jita = economy.JITA_BUY_STATION_ID;
  if (operation.pending && operation.pending.action === "buy") {
    const outcome = reconcilePendingPurchase(
      operation,
      bot,
      inventory,
      Number(operation.purchaseSourceStationID) || jita,
    );
    if (outcome === "unresolved") {
      return kit.block(operation, "review", "Purchase reconciliation is incomplete; verify the matching market transaction and hangar or cargo item before resuming.");
    }
    kit.save(operation);
  }
  if (operation.stage === "to-jita") {
    if (!Number(operation.planetID)) {
      const character = require("../character/characterState").getCharacterRecord(bot.characterID) || {};
      const localSystemID = Number(character.solarSystemID) || 0;
      const jitaSystemID = Number(worldData.getStationByID(jita)?.solarSystemID) || 0;
      const targetSystemID = localSystemID && candidatePlanets(localSystemID, bot.characterID, {
        commandCenterUpgradeLevel: getCommandCenterUpgradeLevel(bot.characterID),
      }).length ? localSystemID : jitaSystemID;
      if (!saveColonyTarget(operation, bot, targetSystemID, kit)) {
        return kit.block(operation, "blocked", "No supported local or Jita PI planet has an available recipe.");
      }
      const localStationID = Number(character.stationID) || 0;
      const station = localStationID && worldData.getStationByID(localStationID);
      operation.colonyStationID = station && Number(station.solarSystemID) === targetSystemID
        ? localStationID
        : Number(worldData.getStationsForSystem(targetSystemID)?.[0]?.stationID) || jita;
      kit.save(operation);
    }
    const step = await kit.travelToStation(operation, bot, jita);
    if (step) return step;
    operation.stage = "buy";
    kit.save(operation);
  }
  if (operation.stage === "to-purchase-source") {
    const sourceStationID = Number(operation.purchaseSourceStationID) || 0;
    const step = await kit.travelToStation(operation, bot, sourceStationID);
    if (step) return step;
    operation.stage = "buy-at-source";
    kit.save(operation);
    return { delayMs: 3000 };
  }
  if (operation.stage === "buy-at-source") {
    const sourceStationID = Number(operation.purchaseSourceStationID) || 0;
    const typeID = Number(operation.purchaseTypeID) || 0;
    const quote = await trade.readQuote(bot.characterName, typeID);
    if (!quote.success) {
      return kit.block(operation, "holding", quote.message || `Could not query market stock for ${typeID} at ${sourceStationID}.`);
    }
    if (!quote.bestAsk) {
      const nextSource = await trade.readBestAskOutsideJita(bot.characterName, typeID);
      if (nextSource.success && nextSource.bestAsk && Number(nextSource.bestAsk.stationID) !== sourceStationID) {
        operation.purchaseSourceStationID = Number(nextSource.bestAsk.stationID);
        operation.stage = "to-purchase-source";
      } else {
        const economy = require("./playerBotEconomyRuntime");
        const isJitaSource = typeof economy.isJitaStation === "function" && economy.isJitaStation(sourceStationID);
        const nextJitaStationID = isJitaSource
          ? Number(economy.findBestJitaSeedStation?.([{ typeID, quantity: 1 }], [sourceStationID])) || 0
          : 0;
        if (nextJitaStationID) {
          operation.purchaseSourceStationID = nextJitaStationID;
          operation.stage = "to-purchase-source";
          kit.record(operation, `Jita station ${sourceStationID} is out of type ${typeID}; trying stocked Jita station ${nextJitaStationID}.`);
        } else if (isJitaSource) {
          return kit.block(operation, "holding", `No Jita seed station has a live sell order for type ${typeID}.`);
        } else {
          operation.purchaseSourceStationID = jita;
          operation.stage = "return-to-jita";
        }
      }
      kit.save(operation);
      return { delayMs: 3000 };
    }
    if (Number(quote.bestAsk.price) > MAX_KIT_SPEND - (Number(operation.spent) || 0)) {
      return kit.block(operation, "holding", "The planetary kit price exceeds the PI budget.");
    }
    operation.pending = capturePurchaseMarker(bot, inventory, typeID, sourceStationID);
    kit.save(operation);
    const bought = await buyOneWithQuoteRefresh(
      trade, bot.characterName, typeID, quote.bestAsk.price,
      MAX_KIT_SPEND - (Number(operation.spent) || 0),
    );
    if (!bought.success && !bought.outcomeUnknown) { operation.pending = null; kit.save(operation); }
    if (!bought.success) return kit.block(operation, bought.outcomeUnknown ? "review" : "holding", bought.message);
    operation.spent = Math.round(((Number(operation.spent) || 0) + Number(bought.spent || 0)) * 100) / 100;
    operation.pending = null;
    const typeIsHauler = typeID === HAULER_TYPE_ID;
    if (typeIsHauler) {
      const hull = inventory.listHangar(bot, sourceStationID, HAULER_TYPE_ID)[0];
      if (!operation.previousShipID) {
        operation.previousShipID = Number(require("./playerBotSpaceRuntime").getActorSession(bot).shipID) || null;
      }
      const boarded = hull ? require("./playerBotOperationRuntime").boardShip(bot, hull) : { error: "the purchased Badger is missing from the hangar" };
      if (boarded.error) return kit.block(operation, "holding", `Could not board the Badger: ${boarded.error}.`);
    } else {
      const stack = inventory.listHangar(bot, sourceStationID, typeID)[0];
      if (!stack) return kit.block(operation, "review", "The purchased Command Center is missing from the source hangar.");
      const loaded = inventory.loadToCargo(bot, stack.itemID, 1);
      if (!loaded.success || Number(loaded.moved) < 1) return kit.block(operation, "holding", `Could not load the Command Center: ${loaded.message || "no cargo moved"}.`);
    }
    // A bought Command Center is already in cargo. It can be planted at the
    // assigned planet directly; only a hauler purchase still needs the next
    // kit purchase at Jita.
    operation.stage = typeIsHauler ? "return-to-jita" : "to-colony-system";
    kit.save(operation);
    return { delayMs: 3000 };
  }
  if (operation.stage === "return-to-jita") {
    const step = await kit.travelToStation(operation, bot, jita);
    if (step) return step;
    operation.purchaseTypeID = null;
    operation.purchaseSourceStationID = null;
    operation.stage = "buy";
    kit.save(operation);
    return { delayMs: 3000 };
  }
  if (operation.stage === "buy") {
    if (!Number(operation.planetID) || !Number(operation.commandCenterTypeID)) {
      const jitaSystemID = Number(worldData.getStationByID(jita)?.solarSystemID) || 0;
      if (!saveColonyTarget(operation, bot, jitaSystemID, kit)) {
        return kit.block(operation, "blocked", "No supported PI planet with a matching Command Center and production recipe is available in Jita.");
      }
    }
    const plan = planForOperation(operation);
    const commandCenterTypeID = plan.commandCenterTypeID;
    const commandCenterName = getTypeName(commandCenterTypeID, "Command Center");
    const ccVolume = Number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(commandCenterTypeID)?.volume) || 1000;
    if (!inventory.countCargo(bot, commandCenterTypeID) && inventory.getCargoBayFree(bot) < ccVolume) {
      // Too small a hold: buy (once) and board a hauler, keeping the old ship.
      const operations = require("./playerBotOperationRuntime");
      if (!inventory.countHangar(bot, jita, HAULER_TYPE_ID)) {
        const regionalSupply = await trade.readBestAskOutsideJita(bot.characterName, HAULER_TYPE_ID);
        if (!regionalSupply.success) return kit.block(operation, "holding", `Could not verify Badger supply outside Jita; purchase paused safely. ${regionalSupply.message}`);
        if (regionalSupply.bestAsk) {
          operation.purchaseTypeID = HAULER_TYPE_ID;
          operation.purchaseSourceStationID = Number(regionalSupply.bestAsk.stationID);
          operation.stage = "to-purchase-source";
          kit.save(operation);
          return { delayMs: 3000 };
        }
        const quote = await trade.readQuote(bot.characterName, HAULER_TYPE_ID);
        if (!quote.success) return kit.block(operation, "holding", quote.message || "Could not query the Jita seed market for Badgers.");
        if (!quote.bestAsk) {
          const seedStationID = economy.findBestJitaSeedStation?.([{ typeID: HAULER_TYPE_ID, quantity: 1 }], [jita]) || 0;
          if (seedStationID) {
            operation.purchaseTypeID = HAULER_TYPE_ID;
            operation.purchaseSourceStationID = Number(seedStationID);
            operation.stage = "to-purchase-source";
            kit.record(operation, `Jita IV - Moon 4 has no Badgers; sourcing one from stocked Jita station ${seedStationID}.`);
            kit.save(operation);
            return { delayMs: 3000 };
          }
          return kit.block(operation, "holding", "No Badgers are available at any seeded Jita station.");
        }
        if (Number(quote.bestAsk.price) > MAX_KIT_SPEND - (Number(operation.spent) || 0)) return kit.block(operation, "holding", "The Badger price exceeds the PI budget.");
        operation.pending = capturePurchaseMarker(bot, inventory, HAULER_TYPE_ID, jita);
        kit.save(operation);
        const bought = await buyOneWithQuoteRefresh(
          trade, bot.characterName, HAULER_TYPE_ID, quote.bestAsk.price,
          MAX_KIT_SPEND - (Number(operation.spent) || 0),
        );
        if (!bought.success && !bought.outcomeUnknown) { operation.pending = null; kit.save(operation); }
        if (!bought.success && bought.sourceAvailable && Number(bought.sourceStationID) > 0) {
          operation.purchaseTypeID = HAULER_TYPE_ID;
          operation.purchaseSourceStationID = Number(bought.sourceStationID);
          operation.stage = "to-purchase-source";
          kit.save(operation);
          return { delayMs: 3000 };
        }
        if (!bought.success) return kit.block(operation, bought.outcomeUnknown ? "review" : "holding", bought.message);
        operation.spent = Math.round(((Number(operation.spent) || 0) + Number(bought.spent || 0)) * 100) / 100;
        operation.pending = null;
        kit.save(operation);
      }
      const hull = inventory.listHangar(bot, jita, HAULER_TYPE_ID)[0];
      if (!operation.previousShipID) {
        operation.previousShipID = Number(require("./playerBotSpaceRuntime").getActorSession(bot).shipID) || null;
        kit.save(operation);
      }
      const boarded = hull ? operations.boardShip(bot, hull) : { error: "Badger not found in the hangar" };
      if (boarded.error) return kit.block(operation, "holding", `Could not board the Badger: ${boarded.error}.`);
      kit.save(operation);
      return { delayMs: 3000 };
    }
    if (!inventory.countCargo(bot, commandCenterTypeID)) {
      if (!inventory.countHangar(bot, jita, commandCenterTypeID)) {
        const regionalSupply = await trade.readBestAskOutsideJita(bot.characterName, commandCenterTypeID);
        if (!regionalSupply.success) return kit.block(operation, "holding", `Could not verify ${commandCenterName} supply outside Jita; purchase paused safely. ${regionalSupply.message}`);
        if (regionalSupply.bestAsk) {
          operation.purchaseTypeID = commandCenterTypeID;
          operation.purchaseSourceStationID = Number(regionalSupply.bestAsk.stationID);
          operation.stage = "to-purchase-source";
          kit.save(operation);
          return { delayMs: 3000 };
        }
        const quote = await trade.readQuote(bot.characterName, commandCenterTypeID);
        if (!quote.success) return kit.block(operation, "holding", quote.message || `Could not query the Jita seed market for ${commandCenterName}s.`);
        if (!quote.bestAsk) {
          const seedStationID = economy.findBestJitaSeedStation?.([{ typeID: commandCenterTypeID, quantity: 1 }], [jita]) || 0;
          if (seedStationID) {
            operation.purchaseTypeID = commandCenterTypeID;
            operation.purchaseSourceStationID = Number(seedStationID);
            operation.stage = "to-purchase-source";
            kit.record(operation, `Jita IV - Moon 4 has no ${commandCenterName}s; sourcing one from stocked Jita station ${seedStationID}.`);
            kit.save(operation);
            return { delayMs: 3000 };
          }
          return kit.block(operation, "holding", `No ${commandCenterName}s are available at any seeded Jita station.`);
        }
        if (Number(quote.bestAsk.price) > MAX_KIT_SPEND - (Number(operation.spent) || 0)) return kit.block(operation, "holding", "The Command Center price exceeds the PI budget.");
        operation.pending = capturePurchaseMarker(bot, inventory, commandCenterTypeID, jita);
        kit.save(operation);
        const bought = await buyOneWithQuoteRefresh(
          trade, bot.characterName, commandCenterTypeID, quote.bestAsk.price,
          MAX_KIT_SPEND - (Number(operation.spent) || 0),
        );
        if (!bought.success && !bought.outcomeUnknown) { operation.pending = null; kit.save(operation); }
        if (!bought.success && bought.sourceAvailable && Number(bought.sourceStationID) > 0) {
          operation.purchaseTypeID = commandCenterTypeID;
          operation.purchaseSourceStationID = Number(bought.sourceStationID);
          operation.stage = "to-purchase-source";
          kit.save(operation);
          return { delayMs: 3000 };
        }
        if (!bought.success) return kit.block(operation, bought.outcomeUnknown ? "review" : "holding", bought.message);
        operation.spent = Math.round(((Number(operation.spent) || 0) + Number(bought.spent || 0)) * 100) / 100;
        operation.pending = null;
        kit.save(operation);
      }
      const stack = inventory.listHangar(bot, jita, commandCenterTypeID)[0];
      if (stack) inventory.loadToCargo(bot, stack.itemID, 1);
    }
    if (!inventory.countCargo(bot, commandCenterTypeID)) return kit.block(operation, "holding", "Could not load the Command Center into the cargo hold.");
    operation.stage = "to-colony-system";
    kit.save(operation);
  }
  if (operation.stage === "to-colony-system") {
    const stationID = Number(operation.colonyStationID) || jita;
    const step = await kit.travelToStation(operation, bot, stationID);
    if (step) return step;
    operation.stage = "plant";
    kit.save(operation);
  }
  if (operation.stage === "plant") {
    const planet = Number(operation.planetID) > 0
      ? worldData.getCelestialByID(Number(operation.planetID))
      : saveColonyTarget(operation, bot, Number(worldData.getStationByID(jita).solarSystemID), kit);
    if (!planet) return kit.block(operation, "blocked", "No supported PI planet with a matching production recipe is available.");
    let plan = planForOperation(operation);
    const commandCenter = inventory.listCargo(bot, plan.commandCenterTypeID)[0];
    if (!commandCenter) return kit.block(operation, "review", "Command Center not found in the cargo hold.");
    const buildCandidate = (candidatePlan) => {
      const lines = candidatePlan.extractionLines || [{ resourceTypeID: candidatePlan.resourceTypeID }];
      const spots = [findBestSpot(planet, lines[0].resourceTypeID)];
      for (let index = 1; index < lines.length; index += 1) {
        spots.push(findBestSpot(planet, lines[index].resourceTypeID, {
          near: spots[0],
          maxAngularDistance: 0.25,
        }));
      }
      const stream = buildNetworkStream(Number(commandCenter.itemID), spots, candidatePlan);
      const quote = require("../planet/planetCostCalculator").quoteNetworkConstructionCost(null, stream);
      return { spots, stream, quote };
    };
    let candidate = buildCandidate(plan);
    const remainingBudget = MAX_KIT_SPEND - (Number(operation.spent) || 0);
    const fallBackToLowerTier = (reason) => {
      const previousTier = Number(plan.piTier) || 1;
      const fallbackPlan = getNetworkPlan(planet,
        getSystemColonyCoverage(Number(planet.solarSystemID)).coverage, {
          commandCenterUpgradeLevel: Number(operation.commandCenterUpgradeLevel) || 0,
          maxPlanetaryTier: previousTier - 1,
        });
      if (!fallbackPlan || Number(fallbackPlan.piTier) >= previousTier) return false;
      plan = fallbackPlan;
      Object.assign(operation, plan, { piPlan: JSON.parse(JSON.stringify(plan)) });
      candidate = buildCandidate(plan);
      kit.save(operation);
      if (typeof kit.record === "function") {
        kit.record(operation, `P${previousTier} PI preflight failed (${reason}); retrying with a supported P${plan.piTier} chain.`);
      }
      return true;
    };
    while (true) {
      if (Number(candidate.quote.amount) > remainingBudget) {
        if (Number(plan.piTier) > 1 && fallBackToLowerTier("construction budget")) continue;
        return kit.block(operation, "holding", "Colony construction exceeds the PI budget.");
      }
      if (Number(plan.piTier) <= 1) break;
      try {
        getPlanetRuntime().previewUserUpdateNetwork({
          planetID: Number(planet.itemID),
          ownerID: Number(bot.characterID),
          solarSystemID: Number(planet.solarSystemID),
          planetTypeID: Number(planet.typeID),
          planetRadius: Number(planet.radius) || 0,
          serializedChanges: candidate.stream,
        });
        break;
      } catch (error) {
        const reason = require("./playerBotSpaceRuntime").describeError(error);
        if (!fallBackToLowerTier(reason)) {
          return kit.block(operation, "holding", `The P${plan.piTier} colony does not fit this planet and no lower supported chain is available: ${reason}.`);
        }
      }
    }
    const stream = candidate.stream;
    const session = require("./playerBotSpaceRuntime").getActorSession(bot);
    const previousPlanet = session._planetMgrBindingPlanetID;
    operation.balanceBeforePlant = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
    operation.stage = "planting";
    kit.save(operation);
    session._planetMgrBindingPlanetID = operation.planetID;
    try {
      const PlanetMgrService = require("../planet/planetMgrService");
      await new PlanetMgrService().Handle_UserUpdateNetwork([stream], session, null);
    } catch (error) {
      if (!getPlanetRuntime().getColony(operation.planetID, bot.characterID)) {
        return kit.block(operation, "review", `PI network edit was not confirmed: ${require("./playerBotSpaceRuntime").describeError(error)}. Check wallet, cargo and planet before retrying.`);
      }
    } finally {
      session._planetMgrBindingPlanetID = previousPlanet;
    }
  }
  if (operation.stage === "planting") {
    const colony = getPlanetRuntime().getColony(operation.planetID, bot.characterID);
    if (!colony) return kit.block(operation, "review", "PI network edit remains unconfirmed after restart; check wallet, cargo and planet.");
    const balanceAfter = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
    operation.spent = Math.round(((Number(operation.spent) || 0) + Math.max(0, Number(operation.balanceBeforePlant) - balanceAfter)) * 100) / 100;
    operation.pins = (colony.pins || []).length;
    operation.stage = "settle";
    kit.save(operation);
  }
  if (operation.stage === "retrieve-previous-ship") {
    const stationID = Number(operation.previousShipStationID) || 0;
    const step = await kit.travelToStation(operation, bot, stationID);
    if (step) return step;
    const previous = require("../inventory/itemStore").findItemById(operation.previousShipID);
    if (!previous) return kit.block(operation, "holding", "The original ship is not currently available; it remains safely stored at its last station.");
    const boarded = require("./playerBotOperationRuntime").boardShip(bot, previous);
    if (boarded.error) return kit.block(operation, "holding", `Colony created, but could not return to the previous ship: ${boarded.error}.`);
    const plan = planForOperation(operation);
    return kit.finish(operation, `Colony established on planet ${operation.planetID}: ${operation.pins} structures; running a P${plan.piTier || 1} planetary production chain for ${getTypeName(plan.productTypeID, "a PI commodity")}; spent ${operation.spent.toFixed(2)} ISK.`);
  }
  if (operation.stage === "settle") {
    const plan = planForOperation(operation);
    const exports = require("./playerBotPlanetaryRuntime");
    if (!exports.getAutoExportPolicy(bot.characterName, operation.planetID).policy) {
      const policy = exports.setAutoExportPolicy(bot.characterName, operation.planetID, 2000, 100000);
      if (!policy.success) return kit.block(operation, "holding", `Colony created, but automatic export could not be enabled: ${policy.message}`);
    }
    if (operation.previousShipID) {
      const previous = require("../inventory/itemStore").findItemById(operation.previousShipID);
      if (previous && Number(require("./playerBotSpaceRuntime").getActorSession(bot).shipID) !== Number(operation.previousShipID)) {
        const session = require("./playerBotSpaceRuntime").getActorSession(bot);
        const currentStationID = Number(session.stationID || session.structureID) || 0;
        if (Number(previous.locationID) !== currentStationID) {
          operation.previousShipStationID = Number(previous.locationID) || 0;
          operation.stage = "retrieve-previous-ship";
          kit.save(operation);
          return { delayMs: 3000 };
        }
        const boarded = require("./playerBotOperationRuntime").boardShip(bot, previous);
        if (boarded.error) return kit.block(operation, "holding", `Colony created, but could not return to the previous ship: ${boarded.error}.`);
      }
    }
    return kit.finish(operation, `Colony established on planet ${operation.planetID}: ${operation.pins} structures; running a P${plan.piTier || 1} planetary production chain for ${getTypeName(plan.productTypeID, "a PI commodity")}; spent ${operation.spent.toFixed(2)} ISK.`);
  }
  return kit.block(operation, "blocked", `Unknown colony stage ${operation.stage}.`);
}

module.exports = {
  PLAN,
  advanceColony,
  buildNetworkStream,
  candidatePlanets,
  getCommandCenterTypeID,
  getNetworkPlan,
  hasColonySkill,
  _testing: { getSystemColonyCoverage, planForOperation, buyOneWithQuoteRefresh },
};

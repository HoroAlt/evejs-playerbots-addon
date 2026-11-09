"use strict";

// Portraits for playerbot characters. A pilot's portrait is a 3D render the
// EVE client makes at character creation and uploads (photoUploadSvc.Upload);
// a server-owned bot has no client to render one. Each bot gets an unused face
// from a local pool of NPC agent portraits while one is available. Once the
// finite pool is exhausted, faces are reused deterministically to avoid
// synchronous render work blocking EveJS during large roster seeds. Without a
// pool, a generated bust derived from its characterID is used. Files go where
// uploads go, so every image request, info window and chat list shows the face.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const {
  findCharacterPortraitPath,
  getCharacterPortraitFilePath,
} = require("../character/portraitImageStore");
const { publishFileAtomicSync } = require("../_shared/atomicFilePublication");

const SIZES = [32, 64, 128, 256, 512];
// EveJS and its clients may ask for the profile-image size separately. The
// portrait store supports all of these sizes, so a partial set must never
// make a pilot appear to have no photo at one of the requested resolutions.
const REQUIRED_SIZES = [32, 64, 128, 256, 512, 1024];
const SKIN = [[241, 204, 177], [224, 172, 135], [198, 134, 94], [141, 85, 58], [94, 59, 39], [233, 190, 160]];
const HAIR = [[30, 24, 20], [74, 46, 28], [140, 96, 52], [196, 160, 98], [120, 120, 125], [160, 40, 30], [20, 20, 30]];
const SUIT = [[40, 52, 70], [70, 40, 40], [36, 60, 48], [60, 60, 66], [84, 66, 36], [30, 30, 36]];
const EYES = [[60, 90, 140], [70, 110, 70], [90, 60, 30], [40, 40, 40], [110, 120, 130]];
const BACKGROUND = [[18, 26, 38], [30, 22, 30], [16, 30, 28], [34, 30, 22], [24, 24, 32]];

function seeded(characterID) {
  let state = (Number(characterID) * 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function pick(random, list) {
  return list[Math.floor(random() * list.length) % list.length];
}

function mix(a, b, t) {
  return [0, 1, 2].map((index) => Math.round(a[index] + (b[index] - a[index]) * t));
}

function buildTraits(characterID) {
  const random = seeded(characterID);
  return {
    skin: pick(random, SKIN),
    hair: pick(random, HAIR),
    suit: pick(random, SUIT),
    eyes: pick(random, EYES),
    background: pick(random, BACKGROUND),
    accent: [Math.floor(80 + random() * 175), Math.floor(80 + random() * 175), Math.floor(80 + random() * 175)],
    hairStyle: Math.floor(random() * 3),
    faceWidth: 0.19 + random() * 0.04,
    faceHeight: 0.25 + random() * 0.03,
  };
}

// Colour of pixel (u, v) in unit coordinates, v growing downwards.
function shade(traits, u, v) {
  const cx = 0.5;
  const headY = 0.42;
  const dx = (u - cx) / traits.faceWidth;
  const dy = (v - headY) / traits.faceHeight;
  const head = dx * dx + dy * dy;
  let color = mix(traits.background, [0, 0, 0], v * 0.6);
  const glow = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.35) * 1.6);
  color = mix(color, traits.accent, glow * 0.18);

  // Shoulders and suit with a collar accent stripe.
  const shoulderTop = 0.74 + Math.pow((u - cx) * 1.6, 2) * 0.35;
  if (v > shoulderTop) {
    color = mix(traits.suit, [0, 0, 0], Math.min(0.5, Math.abs(u - cx) * 0.8));
    if (Math.abs(u - cx) < 0.06 && v < shoulderTop + 0.2) color = mix(traits.accent, traits.suit, 0.4);
  }
  // Neck.
  if (Math.abs(u - cx) < traits.faceWidth * 0.45 && v > headY + traits.faceHeight * 0.7 && v <= shoulderTop + 0.02) {
    color = mix(traits.skin, [0, 0, 0], 0.25);
  }
  if (head <= 1) {
    color = mix(traits.skin, [0, 0, 0], Math.max(0, dx) * 0.22 + Math.max(0, dy) * 0.12);
    // Eyes, brows and mouth.
    const eyeY = headY - traits.faceHeight * 0.05;
    for (const side of [-1, 1]) {
      const ex = cx + side * traits.faceWidth * 0.38;
      const eyeDistance = Math.hypot((u - ex) / 0.035, (v - eyeY) / 0.018);
      if (eyeDistance < 1) color = eyeDistance < 0.55 ? traits.eyes : [235, 235, 230];
      if (Math.abs(v - (eyeY - 0.04)) < 0.008 && Math.abs(u - ex) < 0.04) color = traits.hair;
    }
    if (Math.abs(v - (headY + traits.faceHeight * 0.55)) < 0.008 && Math.abs(u - cx) < 0.045) {
      color = mix(traits.skin, [120, 40, 40], 0.5);
    }
    if (Math.abs(u - cx) < 0.012 && v > eyeY + 0.02 && v < headY + traits.faceHeight * 0.35) {
      color = mix(color, [0, 0, 0], 0.15);
    }
  }
  // Hair cap, with three silhouettes.
  const hairLine = headY - traits.faceHeight * (traits.hairStyle === 1 ? 0.35 : 0.5);
  const hairShape = dx * dx + Math.pow((v - headY) / (traits.faceHeight * 1.12), 2);
  if (hairShape <= 1.18 && v < hairLine) color = traits.hair;
  if (traits.hairStyle === 2 && hairShape <= 1.25 && head > 1 && v < headY + traits.faceHeight * 0.6 && v > hairLine) {
    color = traits.hair;
  }
  return color;
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function renderPortraitPng(characterID, size) {
  const traits = buildTraits(characterID);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = shade(traits, (x + 0.5) / size, (y + 0.5) / size);
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const POOL_SIZES = [32, 64, 128, 256, 512];
const ASSIGNMENT_COMPACT_THRESHOLD = 1_024;
let poolAgentsCache = null;
let poolAgentsDirectoryMtimeMs = null;
let assignmentCacheDirectory = null;
let assignmentCache = null;
let assignedPoolAgents = new Set();
let nextPoolAgentIndex = 0;
let assignmentLogEntries = 0;

function getImagesRoot() {
  return path.dirname(path.dirname(getCharacterPortraitFilePath(1, 64, "jpg")));
}

function getPoolDir() {
  return path.join(getImagesRoot(), "PlayerBotPortraitPool");
}

function listPoolAgents() {
  const poolDir = getPoolDir();
  try {
    const directoryMtimeMs = fs.statSync(poolDir).mtimeMs;
    if (poolAgentsCache && poolAgentsDirectoryMtimeMs === directoryMtimeMs) {
      return poolAgentsCache.slice();
    }
    const files = new Set(fs.readdirSync(poolDir));
    poolAgentsCache = [...new Set([...files].map((name) => (name.match(/^(\d+)_256\.jpg$/) || [])[1]).filter(Boolean))]
      .map(Number)
      .filter((agentID) => POOL_SIZES.every((size) => files.has(`${agentID}_${size}.jpg`)))
      .sort((left, right) => left - right);
    poolAgentsDirectoryMtimeMs = directoryMtimeMs;
    nextPoolAgentIndex = 0;
    return poolAgentsCache.slice();
  } catch (error) {
    poolAgentsCache = null;
    poolAgentsDirectoryMtimeMs = null;
    return [];
  }
}

function readAssignments() {
  const poolDir = getPoolDir();
  if (assignmentCache && assignmentCacheDirectory === poolDir) return assignmentCache;
  const assignmentsPath = path.join(poolDir, "assignments.json");
  try {
    assignmentCache = JSON.parse(fs.readFileSync(assignmentsPath, "utf8"));
  } catch (error) {
    assignmentCache = {};
  }
  if (!assignmentCache || typeof assignmentCache !== "object" || Array.isArray(assignmentCache)) {
    assignmentCache = {};
  }
  let logText = "";
  try { logText = fs.readFileSync(path.join(poolDir, "assignments.log"), "utf8"); } catch (error) { logText = ""; }
  assignmentLogEntries = 0;
  for (const line of logText.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      const characterID = Number(record && record.characterID);
      const agentID = Number(record && record.agentID);
      if (
        Number.isSafeInteger(characterID) && characterID > 0 &&
        Number.isSafeInteger(agentID) && agentID > 0
      ) {
        assignmentCache[String(characterID)] = agentID;
        assignmentLogEntries += 1;
      }
    } catch (error) {
      // Ignore a partial final append after an interrupted process.
    }
  }
  assignmentCacheDirectory = poolDir;
  assignedPoolAgents = new Set(Object.values(assignmentCache).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
  nextPoolAgentIndex = 0;
  return assignmentCache;
}

function persistAssignment(characterID, agentID) {
  const poolDir = getPoolDir();
  const assignments = readAssignments();
  fs.appendFileSync(
    path.join(poolDir, "assignments.log"),
    `${JSON.stringify({ characterID, agentID })}\n`,
  );
  assignments[String(characterID)] = agentID;
  assignedPoolAgents.add(agentID);
  assignmentLogEntries += 1;

  if (assignmentLogEntries >= ASSIGNMENT_COMPACT_THRESHOLD) {
    const assignmentsPath = path.join(poolDir, "assignments.json");
    publishFileAtomicSync(assignmentsPath, JSON.stringify(assignments, null, 2));
    fs.writeFileSync(path.join(poolDir, "assignments.log"), "");
    assignmentLogEntries = 0;
  }
}

// Give the bot an unused pool face while one is available, replacing only a
// portrait this module generated. Once the bundled catalog is exhausted, reuse
// a stable pool face instead of doing expensive synchronous image rendering
// in EveJS's roster-seeding path. Returns true when files were written.
function assignPoolPortrait(characterID) {
  const agents = listPoolAgents();
  if (!agents.length) return false;
  const assignments = readAssignments();
  let agentID = Number(assignments[String(characterID)]) || 0;
  if (!agentID || !agents.includes(agentID)) {
    while (nextPoolAgentIndex < agents.length && assignedPoolAgents.has(agents[nextPoolAgentIndex])) {
      nextPoolAgentIndex += 1;
    }
    if (nextPoolAgentIndex < agents.length) {
      agentID = agents[nextPoolAgentIndex];
      nextPoolAgentIndex += 1;
    } else {
      // The bundled portrait catalog is finite. A profile image is mandatory
      // for every bot, so reuse a deterministic face after all distinct pool
      // portraits have been assigned rather than blocking the game loop to
      // render a new high-resolution PNG for every remaining pilot.
      const random = seeded(characterID);
      agentID = agents[Math.floor(random() * agents.length)] || 0;
      if (!agentID) return false;
    }
    persistAssignment(Number(characterID), agentID);
  }
  for (const size of POOL_SIZES) {
    const target = getCharacterPortraitFilePath(characterID, size, "jpg");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(getPoolDir(), `${agentID}_${size}.jpg`), target);
    const generated = getCharacterPortraitFilePath(characterID, size, "png");
    if (fs.existsSync(generated)) fs.unlinkSync(generated);
  }
  // Pool downloads intentionally stop at 512. Reuse the 512 asset for the
  // 1024 request: clients can scale it, and still receive a real portrait.
  const largestPoolPortrait = getCharacterPortraitFilePath(characterID, 512, "jpg");
  const largestRequestedPortrait = getCharacterPortraitFilePath(characterID, 1024, "jpg");
  publishFileAtomicSync(largestRequestedPortrait, fs.readFileSync(largestPoolPortrait));
  return true;
}

function hasOnlyGeneratedPortrait(characterID) {
  const existing = findCharacterPortraitPath(characterID, 64);
  return Boolean(existing && existing.endsWith(".png") &&
    !fs.existsSync(getCharacterPortraitFilePath(characterID, 64, "jpg")));
}

function hasExactPortrait(characterID, size) {
  for (const root of require("../character/portraitImageStore").listCharacterPortraitRoots()) {
    for (const extension of ["jpg", "png"]) {
      if (fs.existsSync(path.join(root, `${Number(characterID)}_${size}.${extension}`))) return true;
    }
  }
  return false;
}

// Make sure a bot has a portrait. Never overwrites an uploaded (jpg) one.
function ensurePortrait(characterID) {
  const numericCharacterID = Number(characterID);
  if (!Number.isSafeInteger(numericCharacterID) || numericCharacterID <= 0) {
    throw new TypeError("PLAYERBOT_PORTRAIT_INVALID_CHARACTER_ID");
  }

  const missingSizes = () => REQUIRED_SIZES.filter(
    (size) => !hasExactPortrait(numericCharacterID, size),
  );
  let missing = missingSizes();
  if (!missing.length) return false;

  const existing = findCharacterPortraitPath(numericCharacterID);
  if ((!existing || hasOnlyGeneratedPortrait(numericCharacterID)) && assignPoolPortrait(numericCharacterID)) {
    missing = missingSizes();
  }

  // A character can already have one uploaded or generated size. Fill every
  // missing size from that image without replacing the pilot's existing face.
  // This also repairs incomplete portrait sets left by interrupted seeding.
  const sourcePath = [...REQUIRED_SIZES].reverse()
    .map((size) => findCharacterPortraitPath(numericCharacterID, size))
    .find(Boolean);
  if (sourcePath) {
    const sourceBytes = fs.readFileSync(sourcePath);
    const extension = path.extname(sourcePath).slice(1).toLowerCase() || "png";
    for (const size of missing) {
      publishFileAtomicSync(
        getCharacterPortraitFilePath(numericCharacterID, size, extension),
        sourceBytes,
      );
    }
  } else {
    for (const size of SIZES) {
      const filePath = getCharacterPortraitFilePath(numericCharacterID, size, "png");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      publishFileAtomicSync(filePath, renderPortraitPng(numericCharacterID, size));
    }
    // Generate the expensive 1024x1024 render only when it is the sole size
    // available. Reusing the 512 image keeps bulk roster creation bounded.
    publishFileAtomicSync(
      getCharacterPortraitFilePath(numericCharacterID, 1024, "png"),
      fs.readFileSync(getCharacterPortraitFilePath(numericCharacterID, 512, "png")),
    );
  }

  const stillMissing = missingSizes();
  if (stillMissing.length) {
    const error = new Error(`PLAYERBOT_PORTRAIT_INCOMPLETE:${stillMissing.join(",")}`);
    error.code = "PLAYERBOT_PORTRAIT_INCOMPLETE";
    throw error;
  }
  return true;
}

module.exports = {
  ensurePortrait,
  getPoolDir,
  listPoolAgents,
  renderPortraitPng,
};

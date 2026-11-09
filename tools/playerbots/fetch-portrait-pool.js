#!/usr/bin/env node
"use strict";

// Download a pool of NPC agent portraits (3D renders from CCP's public image
// service) for playerbots to use as faces. Agents are CCP's own NPC
// characters, not players. Run once on the server, inside the container:
//
//   docker exec evejs-server-1 node /app/tools/playerbots/fetch-portrait-pool.js [count]
//
// The game server assigns one unused face per bot from this pool when the bot
// comes online; it never downloads anything itself.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const MANIFEST = path.join(REPO_ROOT, "server/src/_secondary/image/generated/agents/manifest.json");
const SIZES = [32, 64, 128, 256, 512];
const DEFAULT_COUNT = 160;

async function download(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 500 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`not a JPEG: ${url}`);
  fs.writeFileSync(target, bytes);
}

async function main() {
  const count = Math.max(1, Math.min(500, Number(process.argv[2]) || DEFAULT_COUNT));
  const { getPoolDir } = require(path.join(REPO_ROOT, "server/src/services/playerbots/playerBotPortraitRuntime"));
  const poolDir = getPoolDir();
  fs.mkdirSync(poolDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const agentIDs = [...new Set(Object.values(manifest.portraits).map((entry) => Number(entry.agentID)).filter(Boolean))]
    .sort((left, right) => left - right);
  // Spread the picks over the whole agent list for varied faces.
  const step = Math.max(1, Math.floor(agentIDs.length / count));
  const picks = agentIDs.filter((_, index) => index % step === 0).slice(0, count);
  let fetched = 0;
  for (const agentID of picks) {
    try {
      for (const size of SIZES) {
        const target = path.join(poolDir, `${agentID}_${size}.jpg`);
        if (fs.existsSync(target)) continue;
        await download(`https://images.evetech.net/characters/${agentID}/portrait?size=${size}`, target);
      }
      fetched += 1;
    } catch (error) {
      console.warn(`agent ${agentID}: ${error.message}`);
      for (const size of SIZES) fs.rmSync(path.join(poolDir, `${agentID}_${size}.jpg`), { force: true });
    }
  }
  console.log(`Pool: ${fetched}/${picks.length} retratos de agentes en ${poolDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

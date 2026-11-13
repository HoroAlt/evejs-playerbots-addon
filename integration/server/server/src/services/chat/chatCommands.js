"use strict";

const path = require("path");
const {
  getActiveShipRecord,
  applyCharacterToSession,
} = require("../character/characterState");
const sessionRegistry = require("./sessionRegistry");
const itemStore = require("../inventory/itemStore");
const {
  getAllItems,
  getCharacterHangarShipItems,
} = itemStore;
const {
  getCharacterWallet,
  setCharacterBalanceAsync,
  adjustCharacterBalanceAsync,
  setCharacterPlexBalanceAsync,
  adjustCharacterPlexBalanceAsync,
} = require("../account/walletState");
const {
  EVERMARK_ISSUER_CORP_ID,
  adjustCharacterWalletLPBalance,
  adjustCorporationWalletLPBalance,
  getCharacterWalletLPBalance,
  getCharacterWalletLPBalances,
  getCorporationWalletLPBalance,
  setCharacterWalletLPBalance,
  setCorporationWalletLPBalance,
} = require("../corporation/lpWalletState");
const {
  PLEX_LOG_CATEGORY,
} = require("../account/plexVaultLogState");
const {
  resolveShipByName,
} = require("./shipTypeRegistry");
const {
  createCustomAllianceForCorporation,
  createCustomCorporation,
  findCorporationByName,
  joinCorporationToAllianceByName,
  getCorporationRecord,
} = require("../corporation/corporationState");
const {
  buildAllianceMemberSnapshot,
  buildAllianceSummary,
  buildCorporationSnapshot,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyCorporationChanged,
} = require("../corporation/corporationNotifications");

// The GM alliance commands change a corporation's alliance outside the normal
// founding/application flows, which tell everyone through these events. Take
// the snapshots before the change, then send the same notifications.
function captureAllianceAffiliationBefore(corporationRecord) {
  const corporationID = Number(corporationRecord && corporationRecord.corporationID) || 0;
  const previousAllianceID = Number(corporationRecord && corporationRecord.allianceID) || 0;
  return {
    corporationID,
    previousAllianceID,
    corporation: corporationID ? buildCorporationSnapshot(corporationID) : null,
    previousAlliance: previousAllianceID ? buildAllianceSummary(previousAllianceID) : null,
    previousMember: previousAllianceID
      ? buildAllianceMemberSnapshot(previousAllianceID, corporationID)
      : null,
  };
}

function notifyAllianceAffiliationChanged(before, allianceID) {
  const nextAllianceID = Number(allianceID) || 0;
  if (!before || !before.corporationID) {
    return;
  }
  if (before.previousAllianceID && before.previousAllianceID !== nextAllianceID) {
    notifyAllianceMemberChanged(before.previousAllianceID, before.corporationID, before.previousMember);
    notifyAllianceChanged(before.previousAllianceID, before.previousAlliance);
  }
  if (nextAllianceID) {
    notifyAllianceChanged(nextAllianceID, null);
    notifyAllianceMemberChanged(nextAllianceID, before.corporationID, null);
  }
  notifyCorporationChanged(before.corporationID, before.corporation);
}
const worldData = require("../../space/worldData");
const spaceRuntime = require("../../space/runtime");
const {
  playPlayableEffect,
} = require("./specialFxRegistry");
const npcService = require("../../space/npc");
const {
  CAPITAL_NPC_CHAT_COMMANDS,
  CAPITAL_NPC_HELP_LINES,
} = require("./capitalNpc");
const {
  WORMHOLE_CHAT_COMMANDS,
  WORMHOLE_HELP_LINES,
  executeWormholeCommand,
} = require("./wormhole");
const {
  TRIG_DRIFTER_CHAT_COMMANDS,
  TRIG_DRIFTER_HELP_LINES,
  executeTrigDrifterCommand,
} = require("./trigDrifter");
const {
  GATE_SKIN_CHAT_COMMANDS,
  GATE_SKIN_HELP_LINES,
  executeGateSkinCommand,
} = require("../../space/gateSkinCommand");
const {
  handleShipDirtCommand,
  handleShipKillmarksCommand,
} = require("../ship/shipAppearanceGmCommands");
const {
  getDockedLocationID,
  getDockedLocationKind,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  executeExtractionGmCommand,
  executeStructureGmCommand,
  executeUpwellCommand,
} = require(path.join(__dirname, "../structure/structureChatCommands"));
const {
  executeUpwellAutoCommand,
} = require(path.join(__dirname, "../structure/structureAutoCommands"));
const {
  POS_HELP_LINES,
  executePosCommand,
} = require(path.join(__dirname, "../starbase/posChatCommands"));
const structureLog = require(path.join(__dirname, "../structure/structureLog"));
const {
  executeSovCommand,
} = require(path.join(__dirname, "../sovereignty/sovChatCommands"));
const {
  executeSovAutoCommand,
} = require(path.join(__dirname, "../sovereignty/sovAutoCommands"));
const sovLog = require(path.join(__dirname, "../sovereignty/sovLog"));
const {
  handleSuperTitanCommand: executeSuperTitanCommand,
  handleSuperTitanShowCommand: executeSuperTitanShowCommand,
} = require(path.join(__dirname, "../superweapons/superweaponCommands"));
const {
  handleMinerCommand: executeMinerCommand,
  handleMiningFleetCommand: executeMiningFleetCommand,
  handleMiningFleetAggroCommand: executeMiningFleetAggroCommand,
  handleMiningFleetClearCommand: executeMiningFleetClearCommand,
  handleMiningFleetStatusCommand: executeMiningFleetStatusCommand,
  handleMiningFleetRetreatCommand: executeMiningFleetRetreatCommand,
  handleMiningFleetResumeCommand: executeMiningFleetResumeCommand,
  handleMiningFleetHaulCommand: executeMiningFleetHaulCommand,
  handleMiningStateStatusCommand: executeMiningStateStatusCommand,
  handleMiningStateResetCommand: executeMiningStateResetCommand,
} = require(path.join(__dirname, "../mining/miningCommandService"));
const {
  handleOrcaCommand: executeOrcaCommand,
  handleProbeCommand: executeProbeCommand,
  handleProbe2Command: executeProbe2Command,
  handleCburstCommand: executeCburstCommand,
  handleGuardianCommand: executeGuardianCommand,
  handleBasiliskCommand: executeBasiliskCommand,
  handleEwarCommand: executeEwarCommand,
  handleTrigCommand: executeTrigCommand,
} = require(path.join(__dirname, "../ship/devCommandShipRuntime"));
const {
  handleRemoteRepairFleetCommand: executeRemoteRepairFleetCommand,
} = require(path.join(__dirname, "../../RemoteRepShow/remoteRepairFleetCommands"));
const {
  executeBlueprintAutoCommand,
  executeBlueprintCommand,
} = require(path.join(__dirname, "../industry/industryChatCommands"));
const {
  executeBookmarkAutoCommand,
} = require(path.join(__dirname, "../bookmark/bookmarkChatCommands"));
const {
  executeCalendarAutoCommand,
} = require(path.join(__dirname, "../calendar/calendarChatCommands"));
const {
  executeReprocessingSmokeCommand,
} = require(path.join(__dirname, "../reprocessing/reprocessingChatCommands"));
const {
  resolveWelcomeSenderID,
  sendMail,
} = require(path.join(__dirname, "../mail/mailState"));

const DEFAULT_MOTD_MESSAGE = [
  "<b><color=0xfff4d35e>Welcome to EveJS Elysian.</color></b><br>",
  "A lot already works, but you <color=0xffff8080>will</color> still find bugs.<br><br>",
  "<b><color=0xff80d8ff>@Icey</color></b> founded this project. Without him, none of this exists.<br><br>",
  "<b><color=0xffffc266>@John Elysian</color></b> is the reason you can undock, warp, fire missiles, use the market, experience time dilation, and touch a long list of other core systems. A lot of this took weeks of 24/7 work to get running against the latest client, and some of it simply had not been done properly before.<br><br>",
  "Big respect as well to <b><color=0xffd7bde2>EvE-MU</color></b> for proving this path was possible long before AI tools existed.<br><br>",
  "<b><color=0xff9be564>@Deer_Hunter</color></b> helped keep development alive when the costs were make-or-break. Thank you.<br><br>",
  "<color=0xffff8080>If you hit a bug, please report it in the EveJS Discord at https://discord.gg/qrdfam8Mz and include exact steps to reproduce it.</color>",
].join(" ");
const DEER_HUNTER_MESSAGE =
  "Thank you, Deer_Hunter on Discord, for helping make EveJS Elysian possible with your contribution to rising AI development costs.";
const DEER_HUNTER_EFFECT_NAME = "microjump";
const {
  handledResult,
} = require(path.join(__dirname, "./commands/commandReplies"));
const {
  normalizeCommandName,
  parseAmount,
  tokenizeQuotedArguments,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commands/commandArguments"));
const {
  levenshteinDistance,
  formatSuggestions,
} = require(path.join(__dirname, "./commands/commandSuggestions"));
const {
  getSessionDockedStationID,
  getSessionCurrentSolarSystemID,
  isConnectedSessionInAbyssalDeadspace,
} = require(path.join(__dirname, "./commands/commandSessionLocation"));
const {
  hasStaffDebugRole,
} = require(path.join(__dirname, "./commands/commandAccess"));
const {
  handleSolarTeleport,
  handleTransportCommand,
  handleFetchCommand,
  handleTeleCommand,
  handleHomeDock,
  handleDeadwarpCommand,
} = require(path.join(__dirname, "./commands/transport"));
const {
  handleGmSkillsCommand,
  handleAllSkillsCommand,
  handleBackInTimeCommand,
  handleExpertSystemCommand,
  handleGiveSkillCommand,
  handleRemoveSkillCommand,
} = require(path.join(__dirname, "./commands/skills"));
const {
  buildCelestialEntity,
  buildLargeCollidableObjectEntity,
  handleCelestialCommand,
  handleLargeCollidableObjectCommand,
  handleJetcanCommand,
  handleDebrisFieldCommand,
  handleTestClearCommand,
  handleSystemJunkClearCommand,
  handleFireCommand,
  handleKeepstarCommand,
  handleFire2Command,
} = require(path.join(__dirname, "./commands/spaceObjects"));
const {
  getContainer1SeedPlan,
  getGmWeaponsSeedPlan,
  getPropulsionCommandItemTypes,
  handleShipSpawn,
  handleGiveItemCommand,
  handleCreateItemCommand,
  handleLoadCommand,
  handleMineralsCommand,
  handleContainer1Command,
  handleGmShipsCommand,
  handlePropCommand,
  handleGmWeaponsCommand,
} = require(path.join(__dirname, "./commands/itemSeeding"));
const {
  resolveSingleRackCommandPreset,
  handlePresetSingleRackCommand,
  handleLesmisCommand,
} = require(path.join(__dirname, "./commands/fittingPresets"));
const { handleFitCommand } = require("./commands/fitModule");
const { handleUnfitCommand } = require("./commands/unfitModule");
const {
  handleSpawnSiteCommand,
  handleNpcCommand,
  handleMissileNpcCommand,
  handleCapitalNpcCommand,
  handleNpcTestCommand,
  handleNpcWarpCommand,
  handleConcordCommand,
  handleNpcClearCommand,
  handleGateOperatorCommand,
} = require(path.join(__dirname, "./commands/npcCommands"));
const {
  handleCrimewatchCommand,
  handleNaughtyCommand,
  handleSecurityStatusCommand,
} = require(path.join(__dirname, "./commands/crimewatch"));
const {
  handleInvuCommand,
  handleHealCommand,
  handleRepairModulesCommand,
  handleNativeHealCommand,
  handleDamageCommand,
} = require(path.join(__dirname, "./commands/shipHealth"));
const {
  handleAbyssalDebugCommand,
  handleAbyssalLayoutCommand,
  handleAbyssalStatusCommand,
  handleAbyssalRescueCommand,
} = require(path.join(__dirname, "./commands/abyssalDebug"));
const {
  resolveAbyssalSuicideAuthority,
  isSessionShipCapsuleBeforeDestruction,
  handleSuicideCommand,
  handleDeathTestCommand,
  handleStructureDeathTestCommand,
} = require(path.join(__dirname, "./commands/deathTests"));
const {
  handleLoadSystemCommand,
  handleLoadAllSystemsCommand,
  handleTimeDilationCommand,
} = require(path.join(__dirname, "./commands/timeDilation"));
const {
  handleGrantShipLogoCommand,
} = require(path.join(__dirname, "./commands/shipLogos"));
const {
  handleSetStandingCommand,
  handleMaxAgentStandingsCommand,
} = require(path.join(__dirname, "./commands/standings"));
const {
  handleChatColorCommand,
} = require(path.join(__dirname, "./commands/chatColors"));

const {
  handleAllSkinsCommand,
} = require(path.join(__dirname, "./commands/shipSkins"));
const {
  handleAllSkinrCommand,
} = require(path.join(__dirname, "./commands/skinrComponents"));
const {
  handleSkinrCommand,
} = require(path.join(__dirname, "./commands/skinrDrafts"));
const {
  handleSigscanCommand,
  handleSigsCommand,
} = require(path.join(__dirname, "./commands/signatures"));
const {
  handleMissionCompleteCommand,
} = require(path.join(__dirname, "./commands/missions"));
const {
  handleOverlayRefreshCommand,
} = require(path.join(__dirname, "./commands/sensorOverlay"));
const {
  handleEffectCommand,
} = require(path.join(__dirname, "./commands/specialEffects"));

const AVAILABLE_SLASH_COMMANDS = [
  "copyship",
  "orbitals",
  "events",
  "addisk",
  "addlp",
  "addevermarks",
  "addcorpevermarks",
  "announce",
  "addplex",
  "allskills",
  "allskins",
  "allskinr",
  "skinr",
  "corpcreate",
  "playerbots",
  "bots",
  "follow",
  "escort",
  "attack",
  "blue",
  "commandlist",
  "commands",
  "deer_hunter",
  "expertsystem",
  "expertsystems",
  "giveme",
  "giveskill",
  "grantshipemblem",
  "grantcorplogo",
  "grantalliancelogo",
  "hangar",
  "dmg",
  "dogma",
  "heal",
  "ceq",
  "interference",
  "help",
  "item",
  "iteminfo",
  "killmark",
  "killmarks",
  "keepstar",
  "pos",
  "upwell",
  "upwellauto",
  "structure",
  "extraction",
  "war",
  "bpauto",
  "bp",
  "bookmarkauto",
  "calauto",
  "reprocesssmoke",
  "laser",
  "lasers",
  "hybrids",
  "railgun",
  "projectiles",
  "removeskill",
  "autocannon",
  "rocket",
  "light",
  "heavy",
  "torp",
  "lesmis",
  "miner",
  "orca",
  "probe",
  "probe2",
  "trig",
  "setstanding",
  "maxagentstandings",
  "fullstandings",
  "sigs",
  "sigscan",
  "missioncomplete",
  "overlayrefresh",
  "cburst",
  "guardian",
  "basilisk",
  "ewar",
  "backintime",
  "dock",
  "dirt",
  "effect",
  "fire",
  "fire2",
  "rr",
  "supertitan",
  "supertitanshow",
  "titansupershow",
  "giveitem",
  "fit",
  "unfit",
  "unload",
  "online",
  "getshipsetup",
  "repairmodules",
  "reportdesync",
  "fetch",
  "spawn",
  "spawnn",
  "entity",
  "unspawn",
  "create",
  "createitem",
  "load",
  "minerals",
  "gmweapons",
  "gmships",
  "gmskills",
  "container",
  "container1",
  "jetcan",
  "motd",
  "mailme",
  "spawnsite",
  "npc",
  "mnpc",
  "npctest",
  "npctest2",
  "npcminer",
  "npcmineraggro",
  "npcminerpanic",
  "npcminerretreat",
  "npcminerresume",
  "npcminerhaul",
  "npcminerclear",
  "npcminerstatus",
  "miningreset",
  "miningstatus",
  "npcclear",
  "joinalliance",
  "loadallsys",
  "loadsys",
  "solar",
  "tele",
  "tr",
  "prop",
  "npcw",
  "wnpc",
  "spawncontainer",
  "spawnwreck",
  "session",
  "setalliance",
  "sov",
  "sovauto",
  "autosov",
  "setplex",
  "setlp",
  "setevermarks",
  "setcorpevermarks",
  "setisk",
  "ship",
  "celestial",
  "lco",
  "suicide",
  "sysjunkclear",
  "testclear",
  "teal",
  "tidi",
  "deathtest",
  "deathstructure",
  "deadwarp",
  "typeinfo",
  "wallet",
  "lp",
  "evermarks",
  "corpevermarks",
  "where",
  "abyssaldebug",
  "abyssallayout",
  "abyssalstatus",
  "abyssalrescue",
  "who",
  ...CAPITAL_NPC_CHAT_COMMANDS,
  ...WORMHOLE_CHAT_COMMANDS,
  ...TRIG_DRIFTER_CHAT_COMMANDS,
  ...GATE_SKIN_CHAT_COMMANDS,
  "wreck",
  "concord",
  "cwatch",
  "naughty",
  "gateconcord",
  "gaterats",
  "invu",
  "secstatus",
  "yellow",
  "red",
];
const COMMANDS_HELP_TEXT = [
  "Commands:",
  "/help",
  "/motd",
  "/mailme",
  "/allskills",
  "/npc [amount] [faction|profile|pool]",
  "/mnpc [amount] [faction|profile|pool]",
  "/celestial <typeID>",
  "/lco <typeID>",
  "/spawnsite <templateID> [offsetMeters]",
  ...CAPITAL_NPC_HELP_LINES,
  ...WORMHOLE_HELP_LINES,
  ...TRIG_DRIFTER_HELP_LINES,
  ...GATE_SKIN_HELP_LINES,
  "/npcminer [amount] [profile|pool|group] | /npcminer ice [amount]",
  "/npcmineraggro [amount] [profile|pool|group]",
  "/npcminerpanic [amount] [profile|pool|group]",
  "/npcminerretreat",
  "/npcminerresume",
  "/npcminerhaul",
  "/npcminerclear",
  "/npcminerstatus",
  "/miningreset",
  "/miningstatus",
  "/npcw [amount] [profile|pool]",
  "/npcclear <system [npc|concord|all]|radius <meters> [npc|concord|all]>",
  "/dock",
  "/dirt <0.0-1.0> [shipID]",
  "/dmg [light|medium|heavy]",
  "/killmarks <count> [shipID]",
  "/heal",
  "/ceq <0-100> (GM only; /ceq 100 refills your CEQ)",
  "/interference reset (GM only; resets signal interference in your current system)",
  "/chowner <containerID> <characterID>",
  "/deer_hunter",
  "/effect <name>",
  "/keepstar",
  ...POS_HELP_LINES,
  "/upwell <subcommand>",
  "/upwellauto <type|structureID>",
  "/upwellauto undock <structureID> [count] [all|unpublished|published]",
  "/structure <state|timer|deploytimer|unanchor|abandontimer> <structureID> [value]",
  "/extraction advance <mid|stop|ready|decay> [structureID]",
  "/war start <warID>",
  "/bpauto <subcommand>",
  "/bp <subcommand>",
  "/bookmarkauto <subcommand>",
  "/calauto <subcommand>",
  "/reprocesssmoke <subcommand>",
  "/backintime [me|characterID|character name]",
  "/expertsystem <list|inspect|status|add|remove|clear|giveitem|consume>",
  "/sov <subcommand>",
  "/sovauto <subcommand>",
  "/botlocal [all] (alias /botlocali) — bot count and locations in your system, or grouped by system",
  "/follow [me|fleet character|stop] and /escort [me|fleet character|stop] — order the playerbots in your fleet to follow or escort an online human fleet member",
  "/attack [all|bot name] — in Fleet chat, order fitted playerbots to attack your most recently locked, legally authorized ship; /attack stop [all|bot name] recalls drones and returns them to base",
  "/playerbots [status|ops [page|systems [page]|system <solarSystemID>]|list|inspect|tasks] | autowork [on|off|status] | orders | haul <bot> <itemID|typeID> <fromStation> <toStation> [qty] | courier post <issuerBot> <carrierBot> <startStation> <endStation> <itemID> <qty> <rewardISK> <collateralISK> | mine <bot> [trips] [station <id>] [norefine] [nosell] | fit <bot> <fittingID|fitting-link> [maxISK] | upgrade <bot> [mining|logistics|security|piracy|sovereignty] [force] | colony <bot> | combat <bot> [security|war|piracy|nullsec-conflict] | sovereignty <bot> | alliance found <CEO bot> | build <bot> <structurePackageItemID> [nullSystemID] | op status|stop|resume <bot> | industry cycle start|status|stop|resume <bot> ... | industry list|jobs <bot> | industry auto set <bot> <blueprintItemID> <runs> <maxISK> | industry auto status|off <bot> | invite|join <bot> | fleet add|join <bot> | fund <bot> <ISK> | pi export ... | undock|warp|route|dock <bot> ... | task pi <bot>|cancel <taskID> | pause|resume <bot> | seed [30-15,000] (staff; enables gradual seeding within configured ceiling)",
  "/bots corp <recall|work|status|hq|help> [corporationID] (alias /playerbots corp) - whole-corporation orders: recall every pilot to the corporation HQ (NPC station or corporation-owned structure), dock and hold them, then put them to work; /bots help lists every form",
  "/fitbot <fittingID|fitting-link> [maxISK] (send this command in the playerbot's private chat)",
  "/fire [ship name|typeID]",
  "/fire2 [count]",
  "/supertitan",
  "/supertitanshow [count]",
  "/titansupershow [count]",
  "/giveitem <item name|typeID> [amount]",
  "/fit me <module name|typeID>",
  "/copyship <activeShipID> 1",
  "/unfit me <module name|typeID|itemID|all>",
  "/dogma <me|activeShipID> <attributeName> = <value> | /dogma me reset",
  "/create <item name|typeID> [amount]",
  "/createitem <item name|typeID> [amount]",
  "/minerals",
  ".container1",
  "/giveskill <target> <skill|all|super> [level]",
  "/allskins [me|characterID|character name]",
  "/allskinr [me|characterID|character name]",
  "/skinr list [target]",
  "/skinr skins [target] | /skinr delete <SKIN hash> [target] | /skinr delete confirm all [target]",
  "/skinr export <draft UUID> [target] | /skinr import <filename.skinr.json> [target]",
  "/skinr store import <filename.skinr.json> [price [ISK|PLEX] [quantity]]",
  "/removeskill <target> <skill|all>",
  "/laser",
  "/lasers",
  "/hybrids",
  "/railgun",
  "/projectiles",
  "/autocannon",
  "/rocket",
  "/light",
  "/heavy",
  "/torp",
  "/lesmis",
  "/miner",
  "/orca",
  "/probe",
  "/probe2",
  "/trig [hull|family]",
  "/setstanding <value> <owner name|id> [target]",
  "/maxagentstandings [target]",
  "/fullstandings [target]",
  "/sigs",
  "/sigscan",
  "/missioncomplete [agentID|all]",
  "/overlayrefresh",
  "/cburst",
  "/guardian",
  "/basilisk",
  "/ewar",
  "/gmweapons",
  "/container [container type] [count]",
  "/jetcan <item name|typeID> [amount]",
  "/gmships",
  "/gmskills",
  "/where",
  "/orbitals [planetID] — list local customs offices and skyhooks, including while docked",
  "/who",
  "/concord [amount] [profile|pool]",
  "/cwatch [status|clear|safety <full|partial|none>|weapon <off|seconds>|pvp <off|seconds>|npc <off|seconds>|criminal <off|seconds>|suspect <off|seconds>|disapproval <off|seconds>]",
  "/naughty",
  "/secstatus [status]",
  "/gateconcord [on|off]",
  "/gaterats [on|off]",
  "/invu [on|off]",
  "/wallet",
  "/lp [npc corp name|corpID]",
  "/addlp <amount> <npc corp name|corpID>",
  "/setlp <amount> <npc corp name|corpID>",
  "/evermarks",
  "/grantshipemblem <corp|alliance|both> [current|ship name|typeID]",
  "/grantcorplogo [current|ship name|typeID]",
  "/grantalliancelogo [current|ship name|typeID]",
  "/corpcreate <corporation name>",
  "/setalliance <alliance name>",
  "/joinalliance <alliance name>",
  "/loadallsys",
  "/loadsys",
  "/tidi [0.1-1.0]",
  "/prop",
  "/solar <system name>",
  "/tele <character name|characterID>",
  "/tr <me|characterID|entityID> <destination|bookmark=bookmarkID|pos=x,y,z|offset=x,y,z>",
  "/suicide",
  "/sysjunkclear",
  "/wreck [wreck type] [count]",
  "/deathtest [ship name|typeID] [count]",
  "/deathstructure <sovhub|skyhook|bloodraiderfob|guristasfob|angelfob|mercden|vigilance|dreamer|astrahus|typeID> [count] [delaySeconds]",
  "/deadwarp",
  "/testclear",
  "/addisk <amount>",
  "/addevermarks <amount>",
  "/addcorpevermarks <amount>",
  "/addplex <amount>",
  "/blue",
  "/setisk <amount>",
  "/setevermarks <amount>",
  "/setcorpevermarks <amount>",
  "/setplex <amount>",
  "/corpevermarks",
  "/red",
  "/ship <ship name|typeID>",
  "/giveme <ship name|typeID>",
  "/hangar",
  "/item <item name|typeID> [amount]",
  "/iteminfo <itemID>",
  "/typeinfo <ship name|typeID>",
  "/session",
  "/announce <message>",
  "/teal",
  "/yellow",
].join("\n");

const ABYSSAL_PLAYER_HELP_TEXT = [
  "Abyssal Deadspace:",
  "Abyssal filaments create a temporary, scannable trace near your ship. Entering it starts a private three-room run with its own isolated space scene.",
  "Current entry supports one cruiser pilot using 1 matching filament, up to two destroyer pilots using 2, or up to three frigate pilots using 3. Eligible small-hull fleet members independently activate the shared Trace.",
  "Destroy each room's hostile wave to unlock its transfer conduit. The third room's exit conduit returns you near the recorded origin trace.",
  "Rooms can award a Bioadaptive Cache after their objective is cleared. Encounter and reward strength scale conservatively by filament tier.",
  "Dark, Electrical, Exotic, Firestorm, and Gamma weather apply their configured ship, resistance, capacitor, scan, or velocity effects for the run.",
  "Inside Abyssals: normal warp out, fleet warp to the runner, cloak, mobile depot, directional scan, the system scanner, and the starmap are blocked. Combat-probe scans remain available, but probes outside the pocket boundary are lost after movement settles.",
  "Timeouts are lethal. Expiry suppresses rewards, destroys the participant ship and capsule through normal destruction handling, and cleans the run.",
  "Current limitations: group ownership, admission, survivor, disconnect, finalization, and recovery semantics are EveJS-authored policy rather than a retail-exact claim. Encounter balance, loot balance, and some environment presentation also remain conservative.",
].join("\n");
const STAFF_ABYSSAL_HELP_TEXT = [
  "Staff/Admin Abyssal:",
  "/abyssaldebug suppressor <on|off|status>",
  "/abyssallayout <list|status|next <layoutID>|clear>",
  "/abyssalstatus [status|weather|fx <effectKey>|scenery <candidateKey|list [category]|next|prev> [near|mid|far]|help]",
  "/abyssalrescue",
  "Use /abyssalstatus outside and inside a run to inspect active-room, origin-return, reward, extraction, restriction, timeout, Calm Dark FX state, and scenery probe state.",
  "Use /abyssalrescue if isolated-scene relog recovery fails and leaves the pilot in an Abyssal host location.",
  "Use /abyssalstatus help for QA notes, server-owned policies, and current placeholder limitations.",
].join("\n");

function suggestCommands(query) {
  const normalizedQuery = normalizeCommandName(query);
  if (!normalizedQuery) {
    return [];
  }

  return [...AVAILABLE_SLASH_COMMANDS]
    .map((commandName) => {
      let score = levenshteinDistance(normalizedQuery, commandName);
      if (commandName.startsWith(normalizedQuery)) {
        score = Math.min(score, 0);
      } else if (commandName.includes(normalizedQuery)) {
        score = Math.min(score, 1);
      }
      return { commandName, score };
    })
    .filter((entry) => entry.score <= Math.max(2, Math.ceil(entry.commandName.length * 0.35)))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.commandName.localeCompare(right.commandName);
    })
    .slice(0, 5)
    .map((entry) => `/${entry.commandName}`);
}

function formatIsk(value) {
  return `${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ISK`;
}

function formatPlex(value) {
  return `${Math.max(0, Math.trunc(Number(value || 0))).toLocaleString("en-US")} PLEX`;
}

function formatEvermarks(value) {
  return `${Math.max(0, Math.trunc(Number(value || 0))).toLocaleString("en-US")} EverMarks`;
}

function formatSignedEvermarks(value) {
  const numeric = Math.trunc(Number(value || 0));
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric.toLocaleString("en-US")} EverMarks`;
}

function formatLoyaltyPoints(value) {
  return `${Math.max(0, Math.trunc(Number(value || 0))).toLocaleString("en-US")} LP`;
}

function formatSignedLoyaltyPoints(value) {
  const numeric = Math.trunc(Number(value || 0));
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric.toLocaleString("en-US")} LP`;
}

function formatSignedPlex(value) {
  const numeric = Math.trunc(Number(value || 0));
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric.toLocaleString("en-US")} PLEX`;
}

function formatCorporationLabel(corporationRecord) {
  if (!corporationRecord) {
    return "corporation";
  }
  const corporationID = normalizePositiveInteger(corporationRecord.corporationID);
  const name = String(corporationRecord.corporationName || "").trim();
  if (name && corporationID) {
    return `${name}(${corporationID})`;
  }
  return corporationID ? `corporation ${corporationID}` : "corporation";
}

function normalizeLpIssuerLookupText(value) {
  return tokenizeQuotedArguments(value).join(" ").trim();
}

function parseLoyaltyPointMutationArgs(argumentText) {
  const tokens = tokenizeQuotedArguments(argumentText);
  if (tokens.length < 2) {
    return {
      amount: null,
      issuerText: "",
    };
  }
  return {
    amount: parseAmount(tokens[0]),
    issuerText: tokens.slice(1).join(" ").trim(),
  };
}

function resolveLoyaltyPointIssuerCorporation(issuerText) {
  const normalizedIssuerText = normalizeLpIssuerLookupText(issuerText);
  if (!normalizedIssuerText) {
    return {
      success: false,
      errorMsg: "ISSUER_REQUIRED",
    };
  }

  let corporationRecord = null;
  if (/^(evermarks?|paragon lp)$/i.test(normalizedIssuerText)) {
    corporationRecord = getCorporationRecord(EVERMARK_ISSUER_CORP_ID);
  } else {
    const corporationID = normalizePositiveInteger(normalizedIssuerText);
    corporationRecord = corporationID
      ? getCorporationRecord(corporationID)
      : findCorporationByName(normalizedIssuerText);
  }

  if (!corporationRecord) {
    return {
      success: false,
      errorMsg: "ISSUER_NOT_FOUND",
    };
  }

  if (corporationRecord.isNPC !== true) {
    return {
      success: false,
      errorMsg: "ISSUER_NOT_NPC",
      data: corporationRecord,
    };
  }

  return {
    success: true,
    data: corporationRecord,
  };
}

function formatLoyaltyPointIssuerError(result, issuerText) {
  if (!result || result.errorMsg === "ISSUER_REQUIRED") {
    return "Usage: /addlp <amount> <npc corp name|corpID>";
  }
  if (result.errorMsg === "ISSUER_NOT_NPC") {
    return `${formatCorporationLabel(result.data)} is not an NPC corporation. LP issuers must be NPC corporations.`;
  }
  return `NPC corporation not found: ${String(issuerText || "").trim()}.`;
}

function getLoyaltyPointSummary(session, issuerText = "") {
  if (!session || !session.characterID) {
    return "Select a character before checking LP.";
  }

  const normalizedIssuerText = normalizeLpIssuerLookupText(issuerText);
  if (normalizedIssuerText) {
    const issuerResult = resolveLoyaltyPointIssuerCorporation(normalizedIssuerText);
    if (!issuerResult.success) {
      return formatLoyaltyPointIssuerError(issuerResult, normalizedIssuerText);
    }
    const amount = getCharacterWalletLPBalance(
      session.characterID,
      issuerResult.data.corporationID,
    );
    return `${formatCorporationLabel(issuerResult.data)} LP: ${formatLoyaltyPoints(amount)}.`;
  }

  const balances = getCharacterWalletLPBalances(session.characterID);
  if (balances.length === 0) {
    return "No LP balances.";
  }

  const summary = balances
    .map((entry) => {
      const corporationRecord = getCorporationRecord(entry.issuerCorpID);
      return `${formatCorporationLabel(corporationRecord || { corporationID: entry.issuerCorpID })}: ${formatLoyaltyPoints(entry.amount)}`;
    })
    .join("; ");
  return `LP balances: ${summary}.`;
}

function handleDeerHunterCommand(session, chatHub, options) {
  const effectResult = playPlayableEffect(session, DEER_HUNTER_EFFECT_NAME);
  const message = effectResult.success
    ? `${DEER_HUNTER_MESSAGE} Your ship celebrates with a brief micro-jump flash.`
    : DEER_HUNTER_MESSAGE;
  return handledResult(chatHub, session, options, message);
}

function handleMailMeCommand(session, argumentText, chatHub, options) {
  const characterID = normalizePositiveInteger(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
  if (!characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /mailme.",
    );
  }

  const extraNote = String(argumentText || "").trim();
  const senderID = resolveWelcomeSenderID();
  const subject = "EveJS Elysian live mail test";
  const bodyLines = [
    "This is a live Eve Mail generated by /mailme.",
    "",
    "If this popped up and landed in your mailbox, the live notify path and the stored mailbox path are both working.",
  ];
  if (extraNote) {
    bodyLines.push("");
    bodyLines.push(`Note: ${extraNote}`);
  }
  bodyLines.push("");
  bodyLines.push(`Generated at: ${new Date().toISOString()}`);

  const sendResult = sendMail({
    senderID,
    toCharacterIDs: [characterID],
    title: subject,
    body: bodyLines.join("<br>"),
    saveSenderCopy: false,
    excludeSession: null,
  });
  if (!sendResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Test mail failed: ${sendResult.errorMsg || "unknown error"}.`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Live Eve Mail sent to your mailbox: "${subject}".`,
  );
}

function refreshAffiliationSessions(characterIDs) {
  const targetCharacterIDs = new Set(
    (Array.isArray(characterIDs) ? characterIDs : [])
      .map((characterID) => normalizePositiveInteger(characterID))
      .filter(Boolean),
  );

  if (targetCharacterIDs.size === 0) {
    return;
  }

  for (const targetSession of sessionRegistry.getSessions()) {
    const characterID = normalizePositiveInteger(
      targetSession && (targetSession.characterID || targetSession.charid),
    );
    if (!characterID || !targetCharacterIDs.has(characterID)) {
      continue;
    }

    // Corporation and alliance changes carry the new corp roles, as TQ's
    // session change on founding a corporation does (golden log "Create Corp").
    applyCharacterToSession(targetSession, characterID, {
      selectionEvent: false,
      emitNotifications: true,
      includeRoleChanges: true,
      logSelection: false,
    });
  }
}

function getWalletSummary(session) {
  const wallet = session && session.characterID
    ? getCharacterWallet(session.characterID)
    : null;
  if (!wallet) {
    return null;
  }

  const deltaText =
    wallet.balanceChange === 0
      ? "0.00 ISK"
      : `${wallet.balanceChange > 0 ? "+" : ""}${formatIsk(wallet.balanceChange)}`;
  const evermarks = getCharacterWalletLPBalance(
    session.characterID,
    EVERMARK_ISSUER_CORP_ID,
  );

  return `Wallet balance: ${formatIsk(wallet.balance)}. PLEX: ${formatPlex(wallet.plexBalance)}. EverMarks: ${formatEvermarks(evermarks)}. Last ISK change: ${deltaText}.`;
}

function getLocationSummary(session) {
  if (!session || !session.characterID) {
    return "No character selected.";
  }

  const dockedLocationID = getDockedLocationID(session);
  if (dockedLocationID) {
    const kind = getDockedLocationKind(session);
    return `Docked in ${kind} ${dockedLocationID}, solar system ${session.solarsystemid2 || session.solarsystemid || "unknown"}.`;
  }

  if (session.solarsystemid2 || session.solarsystemid) {
    return `In space in solar system ${session.solarsystemid2 || session.solarsystemid}.`;
  }

  return "Current location is unknown.";
}

function formatConnectedCharacterLocation(session) {
  if (isConnectedSessionInAbyssalDeadspace(session)) {
    return "Abyssal Deadspace";
  }
  const currentSystemID = getSessionCurrentSolarSystemID(session);
  const currentSystem = worldData.getSolarSystemByID(currentSystemID);
  const systemLabel =
    (currentSystem && currentSystem.solarSystemName) ||
    (currentSystemID ? `system ${currentSystemID}` : "unknown system");

  const dockedLocationID = getSessionDockedStationID(session);
  if (!dockedLocationID) {
    return systemLabel;
  }

  const station = worldData.getStationByID(dockedLocationID);
  const structure = station ? null : worldData.getStructureByID(dockedLocationID);
  const dockedLocationLabel =
    (station && station.stationName) ||
    (structure && (structure.itemName || structure.name)) ||
    `${getDockedLocationKind(session)} ${dockedLocationID}`;

  return `${systemLabel} | Docked: ${dockedLocationLabel}`;
}

function getConnectedCharacterSummary() {
  const preferredSessionsByCharacterID = new Map();
  for (const session of sessionRegistry.getSessions()) {
    const characterID = Number(session && (session.characterID || session.charID || session.charid || 0));
    if (!Number.isInteger(characterID) || characterID <= 0) {
      continue;
    }

    const current = preferredSessionsByCharacterID.get(characterID) || null;
    if (sessionRegistry.isPreferredCharacterSession(session, current)) {
      preferredSessionsByCharacterID.set(characterID, session);
    }
  }

  const connected = Array.from(preferredSessionsByCharacterID.values())
    .sort((left, right) => {
      const leftName = String(left.characterName || left.userName || "Unknown").toLowerCase();
      const rightName = String(right.characterName || right.userName || "Unknown").toLowerCase();
      if (leftName !== rightName) {
        return leftName.localeCompare(rightName);
      }
      return Number(left.characterID || 0) - Number(right.characterID || 0);
    })
    .map((session) => {
      const characterName = session.characterName || session.userName || "Unknown";
      const characterID = Number(session.characterID || session.charID || session.charid || 0) || 0;
      return `${characterName}(${characterID}) - ${formatConnectedCharacterLocation(session)}`;
    });

  if (connected.length === 0) {
    return "No active characters are connected.";
  }

  return `Connected characters (${connected.length}):\n${connected.join("\n")}`;
}

function getSessionSummary(session) {
  if (!session || !session.characterID) {
    return "No active character session.";
  }

  return [
    `char=${session.characterName || "Unknown"}(${session.characterID})`,
    `ship=${session.shipName || "Ship"}(${session.shipID || session.shipid || 0})`,
    `corp=${session.corporationID || 0}`,
    `${getDockedLocationKind(session)}=${getDockedLocationID(session) || 0}`,
    `system=${session.solarsystemid2 || session.solarsystemid || 0}`,
    `wallet=${formatIsk(session.balance || 0)}`,
  ].join(" | ");
}

function getHangarSummary(session) {
  if (!session || !session.characterID) {
    return "No active character session.";
  }

  const stationId = getDockedLocationID(session);
  if (!stationId) {
    return "You must be docked to inspect the ship hangar.";
  }

  const activeShip = getActiveShipRecord(session.characterID);
  const hangarShips = getCharacterHangarShipItems(session.characterID, stationId);
  const shipSummary = hangarShips
    .map((ship) => `${ship.itemName}(${ship.itemID})`)
    .join(", ");

  return [
    `Active ship: ${activeShip ? `${activeShip.itemName}(${activeShip.itemID})` : "none"}.`,
    `Hangar ships (${hangarShips.length}): ${shipSummary || "none"}.`,
  ].join(" ");
}

function getItemSummary(argumentText) {
  const itemID = Number(argumentText);
  if (!Number.isInteger(itemID) || itemID <= 0) {
    return "Usage: /item <itemID>";
  }

  const item = getAllItems()[String(itemID)];
  if (!item) {
    return `Item not found: ${itemID}.`;
  }

  return [
    `Item ${item.itemID}: ${item.itemName || "Unknown"}`,
    `type=${item.typeID}`,
    `owner=${item.ownerID}`,
    `location=${item.locationID}`,
    `flag=${item.flagID}`,
    `singleton=${item.singleton}`,
    `quantity=${item.quantity}`,
  ].join(" | ");
}

function sendAnnouncement(chatHub, session, message) {
  if (!message) {
    return;
  }

  for (const targetSession of sessionRegistry.getSessions()) {
    if (chatHub) {
      chatHub.sendSystemMessage(targetSession, message);
    }
  }
}

function getCommandsHelpText(session) {
  const voidReplayHelp = require("../../config").voidReplayEnabled === true
    ? "\n/voidreplay — replay Ruined Electrical from an expired filament in cargo"
    : "";
  if (!hasStaffDebugRole(session)) {
    return `${COMMANDS_HELP_TEXT}\n\n${ABYSSAL_PLAYER_HELP_TEXT}${voidReplayHelp}`;
  }
  return `${COMMANDS_HELP_TEXT}\n\n${ABYSSAL_PLAYER_HELP_TEXT}${voidReplayHelp}\n\n${STAFF_ABYSSAL_HELP_TEXT}\n/fireshow [count|stop] — temporary native festival formation\n/gate <type> <destination> | /gate stop\n/gateshowcase [destination|stop]`;
}

function canControlPlayerBot(session, bot) {
  if (hasStaffDebugRole(session)) return true;
  const characterID = Number(session && (
    session.characterID || session.charID || session.charid
  )) || 0;
  const corporationID = Number(session && (
    session.corporationID || session.corpid
  )) || 0;
  if (!characterID || !bot) return false;
  if (corporationID > 0 && corporationID === Number(bot.corporationID)) return true;
  const fleetRuntime = require("../fleets/fleetRuntime");
  const playerFleet = fleetRuntime.getFleetForCharacter(characterID);
  const botFleet = fleetRuntime.getFleetForCharacter(bot.characterID);
  return Boolean(
    playerFleet && botFleet && playerFleet.fleetID === botFleet.fleetID &&
    playerFleet.members.has(characterID) && botFleet.members.has(Number(bot.characterID)),
  );
}

function parsePlayerbotFitCommandArgs(value) {
  const text = String(value || "").trim();
  const numeric = text.match(/^(\d+)(?:\s+(\d+(?:\.\d{1,2})?))?$/);
  if (numeric) {
    return { fittingID: Number(numeric[1]) || 0, maxSpend: numeric[2] ? Number(numeric[2]) : null };
  }
  const linked = /(?:fitting\s*id|fittingid|fitid|fitting)\s*(?::\/\/(?:\d+\/)?|[:=#]\s*|\s+)(\d+)/i.exec(text);
  if (!linked) return { fittingID: 0, maxSpend: null };
  const trailing = text.slice(linked.index + linked[0].length).trim();
  const spend = trailing.match(/^(\d+(?:\.\d{1,2})?)$/);
  return { fittingID: Number(linked[1]) || 0, maxSpend: spend ? Number(spend[1]) : null };
}

function formatBotLocalStatus(session, showAllSystems = false) {
  const bots = require("../playerbots/playerBotRuntime").listBots();
  const characterState = require("../character/characterState");
  const locations = bots.map((bot) => {
    const character = characterState.getCharacterRecord(bot.characterID) || {};
    const systemID = Number(character.solarSystemID || bot.solarSystemID) || 0;
    const liveLocation = require("../playerbots/playerBotSpaceRuntime").getBotLocation(bot);
    const inSpace = liveLocation.startsWith("in space");
    const stationID = Number(character.stationID) || 0;
    const structureID = Number(character.structureID) || 0;
    let location = "location unavailable";
    let locationKind = "unknown";
    if (inSpace) {
      location = "in space";
      locationKind = "space";
    } else if (stationID) {
      const station = worldData.getStationByID(stationID);
      location = `docked at ${(station && station.stationName) || `station ${stationID}`}`;
      locationKind = "station";
    } else if (structureID) {
      const structure = worldData.getStructureByID(structureID);
      location = `docked at ${(structure && (structure.itemName || structure.name)) || `structure ${structureID}`}`;
      locationKind = "structure";
    } else if (systemID) {
      location = "in space (actor inactive)";
      locationKind = "space";
    }
    return { bot, systemID, location, locationKind };
  });

  if (showAllSystems) {
    const bySystem = new Map();
    for (const entry of locations) {
      const key = entry.systemID || 0;
      if (!bySystem.has(key)) bySystem.set(key, { count: 0, space: 0, docked: 0, unknown: 0 });
      const summary = bySystem.get(key);
      summary.count += 1;
      if (entry.locationKind === "space") summary.space += 1;
      else if (entry.locationKind === "station" || entry.locationKind === "structure") summary.docked += 1;
      else summary.unknown += 1;
    }
    const rows = [...bySystem.entries()].sort((left, right) =>
      right[1].count - left[1].count || Number(left[0]) - Number(right[0]),
    ).map(([systemID, summary]) => {
      const system = worldData.getSolarSystemByID(Number(systemID));
      const name = (system && system.solarSystemName) || (systemID ? `System ${systemID}` : "Unknown system");
      return `${name}: ${summary.count} bots (${summary.space} in space, ${summary.docked} docked, ${summary.unknown} with unknown location).`;
    });
    return [`Roster: ${bots.length} bots across ${bySystem.size} systems.`, ...rows].join("\n");
  }

  const systemID = Number(getSessionCurrentSolarSystemID(session)) || 0;
  if (!systemID) return "Could not determine your current system. Use /botlocal all to view the global summary.";
  const localBots = locations.filter((entry) => entry.systemID === systemID);
  const system = worldData.getSolarSystemByID(systemID);
  const systemName = (system && system.solarSystemName) || `System ${systemID}`;
  const counts = {
    space: localBots.filter((entry) => entry.locationKind === "space").length,
    station: localBots.filter((entry) => entry.locationKind === "station").length,
    structure: localBots.filter((entry) => entry.locationKind === "structure").length,
    unknown: localBots.filter((entry) => entry.locationKind === "unknown").length,
  };
  const roles = new Map();
  for (const { bot } of localBots) roles.set(bot.specialty, (roles.get(bot.specialty) || 0) + 1);
  const roleSummary = [...roles.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    .map(([role, count]) => `${role} ${count}`).join(", ") || "none";
  const rows = localBots.slice(0, 25).map(({ bot, location }) => {
    const activity = bot.status === "paused" || bot.autonomyPaused
      ? "paused"
      : bot.status === "working" || bot.currentTask
        ? `working${bot.currentTask ? ` (${bot.currentTask})` : ""}`
        : "available";
    return `${bot.characterName} — ${bot.specialty} — ${location} — ${activity}`;
  });
  if (localBots.length > rows.length) rows.push(`… and ${localBots.length - rows.length} more bot(s).`);
  return [
    `${systemName} (${systemID}): ${localBots.length} bot(s): ${counts.space} in space, ${counts.station} at stations, ${counts.structure} in structures, ${counts.unknown} with unknown location.`,
    `Roles: ${roleSummary}.`,
    ...(rows.length ? rows : ["There are no playerbots in this system."]),
    "Use /botlocal all to view the summary for every system.",
  ].join("\n");
}

function executeChatCommand(session, rawMessage, chatHub, options = {}) {
  const trimmed = String(rawMessage || "").trim();
  if (!trimmed.startsWith("/") && !trimmed.startsWith(".")) {
    return { handled: false };
  }

  const commandLine = trimmed.slice(1).trim();
  if (!commandLine) {
    return handledResult(
      chatHub,
      session,
      options,
      "No command supplied. Use /help.",
    );
  }

  const [commandName, ...rest] = commandLine.split(/\s+/);
  const command = normalizeCommandName(commandName);
  const argumentText = rest.join(" ").trim();

  if (
    command === "help" ||
    command === "commands" ||
    command === "commandlist"
  ) {
    return handledResult(chatHub, session, options, getCommandsHelpText(session));
  }

  if (["botlocal", "botlocali"].includes(command)) {
    const scope = argumentText.toLowerCase();
    if (scope && !["all", "global"].includes(scope)) {
      return handledResult(chatHub, session, options, "Usage: /botlocal [all]. Shows playerbot counts and locations.");
    }
    return handledResult(chatHub, session, options, formatBotLocalStatus(session, Boolean(scope)));
  }
  if (command === "copyship") {
    return require("./commands/copyShip").handleCopyShipCommand(session, argumentText, chatHub, options);
  }

  if (command === "motd") {
    return handledResult(chatHub, session, options, DEFAULT_MOTD_MESSAGE);
  }

  if (command === "mailme") {
    return handleMailMeCommand(session, argumentText, chatHub, options);
  }

  if (command === "fitbot") {
    const fitArgs = parsePlayerbotFitCommandArgs(argumentText);
    const targetID = Number(options && options.playerbotPrivateTargetCharacterID) || 0;
    if (!targetID) {
      return handledResult(chatHub, session, options,
        "Open a private chat with a playerbot, then send /fitbot <fittingID|fitting-link> [maxISK].");
    }
    const playerBots = require("../playerbots/playerBotRuntime");
    const bot = playerBots.listBots().find((entry) => Number(entry.characterID) === targetID);
    if (!bot) {
      return handledResult(chatHub, session, options, "This private chat is not addressed to a managed playerbot.");
    }
    if (!canControlPlayerBot(session, bot)) {
      return handledResult(chatHub, session, options, "You can only control playerbots in your corporation or fleet; staff/admin can control any playerbot.");
    }
    if (!fitArgs.fittingID) {
      return handledResult(chatHub, session, options, "Usage: /fitbot <fittingID|fitting-link> [maxISK].");
    }
    const result = require("../playerbots/playerBotOperationRuntime").startSavedFitting(
      bot.characterName,
      fitArgs.fittingID,
      session,
      fitArgs.maxSpend,
    );
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "follow" || command === "escort") {
    if (options.playerbotFleetChat !== true) {
      return handledResult(chatHub, session, options,
        `/${command} is available in fleet chat. Use /${command} me, /${command} <exact fleet character>, or /${command} stop.`);
    }
    const result = require("../playerbots/playerBotOperationRuntime").commandFleetFollow(
      session, command, argumentText,
    );
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "attack") {
    if (options.playerbotFleetChat !== true) {
      return handledResult(chatHub, session, options,
        "/attack is available in Fleet chat. Lock a target first, then use /attack, /attack all, or /attack <exact bot name>; /attack stop [all|bot name] recalls and withdraws.");
    }
    const result = require("../playerbots/playerBotFleetAttackRuntime").commandFleetAttack(
      session, argumentText,
    );
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "playerbots" || command === "bots") {
    const playerBots = require("../playerbots/playerBotRuntime");
    if (!argumentText || /^(status|info)$/i.test(argumentText)) {
      return handledResult(chatHub, session, options, playerBots.getStatusMessage());
    }
    if (/^orders$/i.test(argumentText)) {
      return handledResult(chatHub, session, options, require("../playerbots/playerBotDirectorRuntime").formatPlayerOrders());
    }
    const fittingMatch = argumentText.match(/^fit\s+(.+?)\s+(\S+)(?:\s+(\d+(?:\.\d{1,2})?))?$/i);
    if (fittingMatch) {
      const bot = playerBots.resolveBot(fittingMatch[1]);
      if (!bot) return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${fittingMatch[1]}.`);
      if (!canControlPlayerBot(session, bot)) return handledResult(chatHub, session, options, "You can only control playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      const fitArgs = parsePlayerbotFitCommandArgs(`${fittingMatch[2]}${fittingMatch[3] ? ` ${fittingMatch[3]}` : ""}`);
      if (!fitArgs.fittingID) return handledResult(chatHub, session, options, "Usage: /playerbots fit <bot> <fittingID|fitting-link> [maxISK].");
      const result = require("../playerbots/playerBotOperationRuntime").startSavedFitting(
        bot.characterName,
        fitArgs.fittingID,
        session,
        fitArgs.maxSpend,
      );
      return handledResult(chatHub, session, options, result.message);
    }
    const allianceFoundMatch = argumentText.match(/^alliance\s+found\s+(.+)$/i);
    if (allianceFoundMatch) {
      const bot = playerBots.resolveBot(allianceFoundMatch[1]);
      if (!bot) return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${allianceFoundMatch[1]}.`);
      if (!canControlPlayerBot(session, bot)) return handledResult(chatHub, session, options, "You can only control playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      const result = require("../playerbots/playerBotOperationRuntime").startAllianceFounding(bot.characterName);
      return handledResult(chatHub, session, options, result.message);
    }
    const defenseMatch = argumentText.match(/^defense(?:\s+([\s\S]*))?$/i);
    if (defenseMatch) return handledResult(chatHub, session, options,
      require("../playerbots/playerBotLocalDefenseCommands").handle(defenseMatch[1], hasStaffDebugRole(session)));
    const autoworkMatch = argumentText.match(/^autowork(?:\s+(on|off|status))?$/i);
    if (autoworkMatch) {
      const director = require("../playerbots/playerBotDirectorRuntime");
      const action = (autoworkMatch[1] || "status").toLowerCase();
      if (action !== "status") {
        if (!hasStaffDebugRole(session)) {
          return handledResult(chatHub, session, options, "Enabling or disabling autonomous work requires staff/admin access.");
        }
        director.setEnabled(action === "on");
      }
      return handledResult(chatHub, session, options, director.formatDirectorStatus());
    }
    const courierPostMatch = argumentText.match(/^courier\s+post\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)\s+(\d+(?:\.\d{1,2})?)$/i);
    if (courierPostMatch) {
      const names = courierPostMatch[1].trim();
      const orderedBots = playerBots.listBots().sort((left, right) => String(right.characterName || "").length - String(left.characterName || "").length);
      let issuer = null;
      let carrier = null;
      for (const candidate of orderedBots) {
        const prefix = `${String(candidate.characterName || "").trim()} `;
        if (!prefix.trim() || !names.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const other = playerBots.resolveBot(names.slice(prefix.length).trim());
        if (other) { issuer = candidate; carrier = other; break; }
      }
      if (!issuer || !carrier) return handledResult(chatHub, session, options, "Courier post syntax: courier post <issuerBot> <carrierBot> <startStation> <endStation> <itemID> <qty> <rewardISK> <collateralISK>. Use exact bot names.");
      if (!canControlPlayerBot(session, issuer) || !canControlPlayerBot(session, carrier)) {
        return handledResult(chatHub, session, options, "You can only assign courier work to playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      return require("../playerbots/playerBotAllianceLogisticsRuntime").postAssignedCourier(
        issuer.characterName,
        carrier.characterName,
        Number(courierPostMatch[2]),
        Number(courierPostMatch[3]),
        Number(courierPostMatch[4]),
        Number(courierPostMatch[5]),
        Number(courierPostMatch[6]),
        Number(courierPostMatch[7]),
      ).then((result) => handledResult(chatHub, session, options, result.message));
    }
    const haulMatch = argumentText.match(/^haul\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/i);
    const mineMatch = argumentText.match(/^mine\s+(.+?)(?:\s+(\d+))?(?:\s+station\s+(\d+))?((?:\s+(?:norefine|nosell))*)$/i);
    const operationControlMatch = argumentText.match(/^op\s+(status|stop|resume)\s+(.+)$/i);
    const upgradeMatch = argumentText.match(/^upgrade\s+(.+?)(?:\s+(mining|logistics|security|piracy|sovereignty))?(?:\s+(force))?$/i);
    const colonyMatch = argumentText.match(/^colony\s+(.+)$/i);
    const combatMatch = argumentText.match(/^combat\s+(.+?)(?:\s+(security|war|piracy|nullsec-conflict))?$/i);
    const sovereigntyMatch = argumentText.match(/^sovereignty\s+(.+)$/i);
    const structureDeployMatch = argumentText.match(/^build\s+(.+?)\s+(\d+)(?:\s+(\d+))?$/i);
    if (colonyMatch || combatMatch || sovereigntyMatch || structureDeployMatch || upgradeMatch || haulMatch || (mineMatch && !/^mine\s*$/i.test(argumentText)) || operationControlMatch) {
      const botQuery = (colonyMatch ? colonyMatch[1] : combatMatch ? combatMatch[1] : sovereigntyMatch ? sovereigntyMatch[1] : structureDeployMatch ? structureDeployMatch[1] : upgradeMatch ? upgradeMatch[1] : haulMatch ? haulMatch[1] : mineMatch ? mineMatch[1] : operationControlMatch[2]).trim();
      const bot = playerBots.resolveBot(botQuery);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botQuery}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only control playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const operations = require("../playerbots/playerBotOperationRuntime");
      const action = operationControlMatch ? operationControlMatch[1].toLowerCase() : "start";
      const combatMode = String(combatMatch && combatMatch[2] || bot.specialty || "").toLowerCase();
      const miningFlags = new Set((mineMatch && mineMatch[4] || "").match(/norefine|nosell/gi) || []);
      const result = colonyMatch
        ? operations.startColony(bot.characterName)
        : combatMatch
        ? operations.startCombat(bot.characterName, combatMode)
        : sovereigntyMatch
        ? operations.startSovereignty(bot.characterName)
        : structureDeployMatch
        ? operations.startStructureDeployment(bot.characterName, Number(structureDeployMatch[2]), structureDeployMatch[3] ? Number(structureDeployMatch[3]) : null)
        : upgradeMatch
        ? operations.startShipUpgrade(bot.characterName, String(upgradeMatch[2] || "mining").toLowerCase(), { force: Boolean(upgradeMatch[3]) })
        : haulMatch
        ? operations.startHaul(bot.characterName, Number(haulMatch[2]), Number(haulMatch[3]), Number(haulMatch[4]), haulMatch[5] ? Number(haulMatch[5]) : null)
        : mineMatch
          ? operations.startMining(bot.characterName, mineMatch[2] ? Number(mineMatch[2]) : 1, {
            stationID: mineMatch[3] ? Number(mineMatch[3]) : null,
            refine: !miningFlags.has("norefine"),
            sell: !miningFlags.has("nosell"),
          })
          : action === "stop"
            ? operations.stopOperation(bot.characterName)
            : action === "resume"
              ? operations.resumeOperation(bot.characterName)
              : operations.getOperationStatus(bot.characterName);
      if (!result.success || !["start", "resume"].includes(action)) {
        return handledResult(chatHub, session, options, result.message);
      }
      return require("../playerbots/playerBotAutonomyRuntime").ensureIndustryCycleStep(bot.characterID)
        .then(() => handledResult(chatHub, session, options, result.message))
        .catch((error) => handledResult(chatHub, session, options, `${result.message} The planner is unavailable right now (${error.message}).`));
    }
    const industryCycleStartMatch = argumentText.match(/^industry\s+cycle\s+start\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)(?:\s+station\s+(\d+))?(?:\s+floor\s+(\d+(?:\.\d{1,2})?))?(?:\s+corp\s+([1-7])\s+([1-7]))?$/i);
    const industryCycleControlMatch = argumentText.match(/^industry\s+cycle\s+(status|stop|resume)\s+(.+)$/i);
    if (industryCycleStartMatch || industryCycleControlMatch) {
      const botQuery = (industryCycleStartMatch ? industryCycleStartMatch[1] : industryCycleControlMatch[2]).trim();
      const bot = playerBots.resolveBot(botQuery);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botQuery}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only control playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const cycleRuntime = require("../playerbots/playerBotIndustryCycleRuntime");
      const action = industryCycleStartMatch ? "start" : industryCycleControlMatch[1].toLowerCase();
      const result = action === "start"
        ? cycleRuntime.startCycle(
          bot.characterName,
          Number(industryCycleStartMatch[2]),
          Number(industryCycleStartMatch[3]),
          Number(industryCycleStartMatch[4]),
          {
            stationID: industryCycleStartMatch[5] ? Number(industryCycleStartMatch[5]) : null,
            minUnitPrice: industryCycleStartMatch[6] ? Number(industryCycleStartMatch[6]) : null,
            ...(industryCycleStartMatch[7] ? {
              assetOwner: "corporation",
              hangarDivision: Number(industryCycleStartMatch[7]),
              walletDivision: Number(industryCycleStartMatch[8]),
            } : {}),
            requestedByCharacterID: Number(session && (session.characterID || session.charID || session.charid)) || 0,
          },
        )
        : action === "stop"
          ? cycleRuntime.stopCycle(bot.characterName)
          : action === "resume"
            ? cycleRuntime.resumeCycle(bot.characterName)
            : cycleRuntime.getCycleStatus(bot.characterName);
      if (!result.success || !["start", "resume"].includes(action)) {
        return handledResult(chatHub, session, options, result.message);
      }
      return require("../playerbots/playerBotAutonomyRuntime").ensureIndustryCycleStep(bot.characterID)
        .then(() => handledResult(chatHub, session, options, result.message))
        .catch((error) => handledResult(
          chatHub,
          session,
          options,
          `${result.message} The planner is unavailable right now (${error.message}); the cycle will continue during the next autonomous tick.`,
        ));
    }
    const industryAssetMatch = argumentText.match(/^industry\s+(list|blueprints|jobs)\s+(.+)$/i);
    const industryAutoSetMatch = argumentText.match(/^industry\s+auto\s+set\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)$/i);
    const industryAutoStatusMatch = argumentText.match(/^industry\s+auto\s+status\s+(.+)$/i);
    const industryAutoOffMatch = argumentText.match(/^industry\s+auto\s+off\s+(.+)$/i);
    if (industryAssetMatch || industryAutoSetMatch || industryAutoStatusMatch || industryAutoOffMatch) {
      const botQuery = industryAssetMatch
        ? industryAssetMatch[2].trim()
        : industryAutoSetMatch
          ? industryAutoSetMatch[1].trim()
          : (industryAutoStatusMatch || industryAutoOffMatch)[1].trim();
      const bot = playerBots.resolveBot(botQuery);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botQuery}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only configure playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const industryRuntime = require("../playerbots/playerBotIndustryRuntime");
      try {
        const result = industryAssetMatch
          ? industryAssetMatch[1].toLowerCase() === "jobs"
            ? industryRuntime.listBotIndustryJobs(bot.characterName)
            : industryRuntime.listBotBlueprints(bot.characterName)
          : industryAutoSetMatch
            ? industryRuntime.setAutoManufacturingPolicy(
              bot.characterName,
              Number(industryAutoSetMatch[2]),
              Number(industryAutoSetMatch[3]),
              Number(industryAutoSetMatch[4]),
              Number(session && (session.characterID || session.charID || session.charid)) || 0,
            )
            : industryAutoOffMatch
              ? industryRuntime.disableAutoManufacturingPolicy(bot.characterName)
              : industryRuntime.getAutoManufacturingPolicy(bot.characterName);
        return handledResult(chatHub, session, options, result.message);
      } catch (error) {
        return handledResult(chatHub, session, options, `Could not run the industry operation for ${bot.characterName}: ${String(error && error.message || error).slice(0, 200)}.`);
      }
    }
    if (/^industry(?:\s|$)/i.test(argumentText)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /playerbots industry cycle start <bot> <blueprintTypeID> <runs> <maxISK> [station <stationID>] [floor <ISK>] [corp <hangarDivision 1-7> <walletDivision 1-7>] | cycle status|stop|resume <bot> | list <bot> | jobs <bot> | auto set <bot> <blueprintItemID> <runs 1-100> <maxISK per job> | auto status <bot> | auto off <bot>. Personal cycles may buy missing inputs within budget. Corporation cycles use only stocked shared hangar items and charge fees to the selected wallet division through normal corporation role checks.",
      );
    }
    const piExportSetMatch = argumentText.match(/^pi\s+export\s+set\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)$/i);
    const piExportOffMatch = argumentText.match(/^pi\s+export\s+off\s+(.+?)\s+(\d+)$/i);
    const piExportStatusMatch = argumentText.match(/^pi\s+export\s+status\s+(.+?)\s+(\d+)$/i);
    if (piExportSetMatch || piExportOffMatch || piExportStatusMatch) {
      const match = piExportSetMatch || piExportOffMatch || piExportStatusMatch;
      const botQuery = match[1].trim();
      const bot = playerBots.resolveBot(botQuery);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botQuery}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only configure playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const planetaryRuntime = require("../playerbots/playerBotPlanetaryRuntime");
      const result = piExportSetMatch
        ? planetaryRuntime.setAutoExportPolicy(
          bot.characterName,
          Number(piExportSetMatch[2]),
          Number(piExportSetMatch[3]),
          Number(piExportSetMatch[4]),
          Number(session && (session.characterID || session.charID || session.charid)) || 0,
        )
        : piExportOffMatch
          ? planetaryRuntime.disableAutoExportPolicy(bot.characterName, Number(piExportOffMatch[2]))
          : planetaryRuntime.getAutoExportPolicy(bot.characterName, Number(piExportStatusMatch[2]));
      return handledResult(chatHub, session, options, result.message);
    }
    if (/^pi\s+export(?:\s|$)/i.test(argumentText)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /playerbots pi export set <bot> <planetID> <maxUnits> <maxTaxISK> | status <bot> <planetID> | off <bot> <planetID>.",
      );
    }
    const opsMatch = argumentText.match(/^ops(?:\s+(.*))?$/i);
    if (opsMatch) {
      const opsArguments = String(opsMatch[1] || "").trim();
      let opsOptions = {};
      if (opsArguments) {
        const systemsPageMatch = opsArguments.match(/^systems(?:\s+(\d+))?$/i);
        const pageMatch = opsArguments.match(/^(\d+)$/);
        const systemMatch = opsArguments.match(/^system\s+(\d+)$/i);
        const pageAndSystemMatch = opsArguments.match(/^(\d+)\s+system\s+(\d+)$/i);
        if (systemsPageMatch && (!systemsPageMatch[1] || Number(systemsPageMatch[1]) > 0)) {
          opsOptions.systemsPage = Number(systemsPageMatch[1] || 1);
        } else if (pageAndSystemMatch && Number(pageAndSystemMatch[1]) > 0 && Number(pageAndSystemMatch[2]) > 0) {
          opsOptions.page = Number(pageAndSystemMatch[1]);
          opsOptions.systemID = Number(pageAndSystemMatch[2]);
        } else if (pageMatch && Number(pageMatch[1]) > 0) {
          opsOptions.page = Number(pageMatch[1]);
        } else if (systemMatch && Number(systemMatch[1]) > 0) {
          opsOptions.systemID = Number(systemMatch[1]);
        } else {
          return handledResult(
            chatHub,
            session,
            options,
            "Usage: /playerbots ops | ops [page] | ops systems [page] | ops system <solarSystemID> | ops <page> system <solarSystemID>.",
          );
        }
      }
      return handledResult(
        chatHub,
        session,
        options,
        require("../playerbots/playerBotAutonomyRuntime").formatAutonomyStatus(opsOptions),
      );
    }
    const corporationControlMatch = argumentText.match(/^corp\s+(pause|resume)$/i);
    if (corporationControlMatch) {
      const corporationID = Number(session && (session.corporationID || session.corpid)) || 0;
      if (!corporationID) {
        return handledResult(chatHub, session, options, "Select a character that belongs to a corporation.");
      }
      const corporationBots = playerBots.listBots().filter((bot) =>
        Number(bot.corporationID) === corporationID,
      );
      if (!corporationBots.length) {
        return handledResult(chatHub, session, options, "Your corporation has no playerbots to control.");
      }
      if (!hasStaffDebugRole(session) && corporationBots.some((bot) => !canControlPlayerBot(session, bot))) {
        return handledResult(chatHub, session, options, "You can only control playerbots in your corporation; staff/admin can control any playerbot.");
      }
      const taskRuntime = require("../playerbots/playerBotTaskRuntime");
      const result = corporationControlMatch[1].toLowerCase() === "pause"
        ? taskRuntime.pauseBotsInCorporation(corporationID)
        : taskRuntime.resumeBotsInCorporation(corporationID);
      if (!result.success) {
        return handledResult(chatHub, session, options, `Could not complete corporation control: ${(result.errors || []).join("; ") || result.message || "error"}.`);
      }
      const verb = corporationControlMatch[1].toLowerCase() === "pause" ? "paused" : "resumed";
      const detail = corporationControlMatch[1].toLowerCase() === "pause"
        ? `; ${result.releasedTasks} task(s) returned to the queue`
        : "";
      return handledResult(chatHub, session, options, `${result.affected} playerbot(s) in your corporation ${verb}${detail}.`);
    }
    const corporationOrderMatch = argumentText.match(/^corp\s+(recall|work|status|hq|help)(?:\s+([\s\S]*))?$/i);
    if (corporationOrderMatch) {
      return require("../playerbots/playerBotCorpCommands").handle(
        session,
        `${corporationOrderMatch[1]} ${corporationOrderMatch[2] || ""}`.trim(),
        chatHub,
        options,
      );
    }
    if (/^tasks(?:\s|$)/i.test(argumentText)) {
      const filter = argumentText.replace(/^tasks\s*/i, "").trim().toLowerCase();
      const taskRuntime = require("../playerbots/playerBotTaskRuntime");
      const knownStatuses = new Set(["queued", "leased", "completed", "failed", "canceled"]);
      const tasks = taskRuntime.listTasks({
        status: knownStatuses.has(filter) ? filter : "",
        limit: 15,
      });
      const message = tasks.length
        ? tasks.map((task) => {
            const target = task.targetCharacterID ? ` target ${task.targetCharacterID}` : "";
            const provider = task.providerCharacterID ? ` bot ${task.providerCharacterID}` : "";
            const progress = task.kind === "playerbot.trade.autobuy" && task.progress && task.progress.phase === "buying"
              ? " — purchase reconciliation in progress; do not cancel"
              : "";
            const piExportProgress = task.kind === "playerbot.planetary.autoexport" &&
              task.progress && task.progress.phase === "launching"
              ? " — PI launch reconciliation in progress; do not cancel"
              : "";
            const routeProgress = task.kind === "playerbot.space.route"
              ? ` → system ${Number(task.payload && task.payload.destinationSystemID) || "?"}${task.progress && task.progress.stage ? ` (${task.progress.stage})` : ""}`
              : "";
            const review = task.result && task.result.requiresReview === true ||
              task.progress && task.progress.result && task.progress.result.requiresReview === true
              ? " — review required"
              : "";
            return `${task.taskID} — ${task.kind} — ${task.status}${provider}${target}${routeProgress}${progress}${piExportProgress}${review}`;
          }).join("\n")
        : "No playerbot tasks in that state.";
      return handledResult(chatHub, session, options, message);
    }
    const inspectMatch = argumentText.match(/^inspect\s+(.+)$/i);
    if (inspectMatch) {
      const bot = playerBots.resolveBot(inspectMatch[1]);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${inspectMatch[1]}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only inspect playerbots in your corporation or fleet; staff/admin can inspect any playerbot.");
      }
      const message = require("../playerbots/playerBotStatusRuntime").getBotOperationalStatus(bot);
      return handledResult(chatHub, session, options, message || "Could not read the playerbot status.");
    }
    const fundingMatch = argumentText.match(/^fund\s+(.+?)\s+(\d+(?:\.\d{1,2})?)$/i);
    if (fundingMatch) {
      const bot = playerBots.resolveBot(fundingMatch[1]);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${fundingMatch[1]}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only fund playerbots in your corporation or fleet; staff/admin can fund any playerbot.");
      }
      return playerBots.fundBotFromPlayer(session, fundingMatch[1], Number(fundingMatch[2]))
        .then((result) => handledResult(chatHub, session, options, result.message));
    }
    const autoSellSetMatch = argumentText.match(/^trade\s+autosell\s+set\s+(.+?)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)\s+(\d+)$/i);
    const autoSellOffMatch = argumentText.match(/^trade\s+autosell\s+off\s+(.+)$/i);
    const autoSellStatusMatch = argumentText.match(/^trade\s+autosell\s+status\s+(.+)$/i);
    const autoBuySetMatch = argumentText.match(/^trade\s+autobuy\s+set\s+(.+?)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)$/i);
    const autoBuyOffMatch = argumentText.match(/^trade\s+autobuy\s+off\s+(.+)$/i);
    const autoBuyStatusMatch = argumentText.match(/^trade\s+autobuy\s+status\s+(.+)$/i);
    if (autoSellSetMatch || autoSellOffMatch || autoSellStatusMatch || autoBuySetMatch || autoBuyOffMatch || autoBuyStatusMatch) {
      const match = autoSellSetMatch || autoSellOffMatch || autoSellStatusMatch || autoBuySetMatch || autoBuyOffMatch || autoBuyStatusMatch;
      const botQuery = match[1].trim();
      const bot = playerBots.resolveBot(botQuery);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botQuery}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only configure playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const tradeRuntime = require("../playerbots/playerBotTradeRuntime");
      const result = autoSellSetMatch
        ? tradeRuntime.setAutoSellPolicy(
          bot.characterName,
          Number(autoSellSetMatch[2]),
          Number(autoSellSetMatch[3]),
          Number(autoSellSetMatch[4]),
          Number(session && (session.characterID || session.charID || session.charid)) || 0,
        )
        : autoSellOffMatch
          ? tradeRuntime.disableAutoSellPolicy(bot.characterName)
          : autoSellStatusMatch
            ? tradeRuntime.getAutoSellPolicy(bot.characterName)
            : autoBuySetMatch
              ? tradeRuntime.setAutoBuyPolicy(
                bot.characterName,
                Number(autoBuySetMatch[2]),
                Number(autoBuySetMatch[3]),
                Number(autoBuySetMatch[4]),
                Number(autoBuySetMatch[5]),
                Number(session && (session.characterID || session.charID || session.charid)) || 0,
              )
              : autoBuyOffMatch
                ? tradeRuntime.disableAutoBuyPolicy(bot.characterName)
                : tradeRuntime.getAutoBuyPolicy(bot.characterName);
      if (result && typeof result.then === "function") {
        return result.then((resolved) => handledResult(chatHub, session, options, resolved.message));
      }
      return handledResult(chatHub, session, options, result.message);
    }

    const tradeQuoteMatch = argumentText.match(/^trade\s+quote\s+(.+?)\s+(\d+)$/i);
    const tradeBuyMatch = argumentText.match(/^trade\s+buy\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d{1,2})?)$/i);
    const tradeSellMatch = argumentText.match(/^trade\s+sell\s+(.+?)\s+(\d+)(?:\s+(\d+))?\s+(\d+(?:\.\d{1,2})?)$/i);
    if (tradeQuoteMatch || tradeBuyMatch || tradeSellMatch) {
      const botQuery = (tradeQuoteMatch || tradeBuyMatch || tradeSellMatch)[1].trim();
      const bot = playerBots.resolveBot(botQuery);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botQuery}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only trade with playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const tradeRuntime = require("../playerbots/playerBotTradeRuntime");
      const operation = tradeQuoteMatch
        ? tradeRuntime.getQuote(bot.characterName, Number(tradeQuoteMatch[2]))
        : tradeBuyMatch
          ? tradeRuntime.buy(
            bot.characterName,
            Number(tradeBuyMatch[2]),
            Number(tradeBuyMatch[3]),
            Number(tradeBuyMatch[4]),
          )
          : tradeRuntime.sell(
            bot.characterName,
            Number(tradeSellMatch[2]),
            tradeSellMatch[3] ? Number(tradeSellMatch[3]) : null,
            Number(tradeSellMatch[4]),
          );
      return operation.then((result) => handledResult(chatHub, session, options, result.message));
    }
    if (/^list(?:\s|$)/i.test(argumentText)) {
      const filter = argumentText.replace(/^list\s*/i, "").trim().toLowerCase();
      const bots = playerBots.listBots().filter((bot) =>
        !filter || bot.characterName.toLowerCase().includes(filter) ||
          bot.specialty.toLowerCase().includes(filter),
      );
      const spaceActors = require("../playerbots/playerBotSpaceRuntime");
      const message = bots.length
        ? bots.map((bot) => `${bot.characterName} — ${bot.specialty} — corp ${bot.corporationID} — ${bot.status === "paused" || bot.autonomyPaused ? "paused" : "active"} — ${spaceActors.getBotLocation(bot)}`).join("\n")
        : "No playerbots match that filter.";
      return handledResult(chatHub, session, options, message);
    }
    const seedMatch = argumentText.match(/^seed(?:\s+(\d+))?$/i);
    if (seedMatch) {
      if (!hasStaffDebugRole(session)) {
        return handledResult(chatHub, session, options, "Seeding the playerbot roster requires staff/admin access.");
      }
      const configuration = require("../playerbots/playerBotConfigurationRuntime");
      const result = configuration.updateSettings({
        rosterTarget: seedMatch[1] ? Number(seedMatch[1]) : playerBots.getConfiguredTarget(),
        rosterSeedEnabled: true,
      });
      const message = result.success
        ? `Gradual roster seeding enabled at ${result.settings.rosterTarget} bots. The separate playerbots add-on will create bounded batches and back off when server latency rises; monitor or pause it in the dashboard Settings page.`
        : result.message;
      return handledResult(chatHub, session, options, message);
    }
    const routeCommand = argumentText.match(/^route\s+(.+)$/i);
    if (routeCommand) {
      const routeText = routeCommand[1].trim();
      const systems = require("../../space/worldData").getSolarSystems();
      const botCandidates = playerBots.listBots().sort((left, right) =>
        String(right.characterName || "").length - String(left.characterName || "").length,
      );
      let bot = null;
      let destinationSystemID = 0;
      for (const candidate of botCandidates) {
        const candidateName = String(candidate.characterName || "").trim();
        if (!candidateName || !routeText.toLowerCase().startsWith(`${candidateName.toLowerCase()} `)) continue;
        const targetText = routeText.slice(candidateName.length).trim().replace(/^to\s+/i, "");
        if (/^\d+$/.test(targetText)) {
          destinationSystemID = Number(targetText);
        } else {
          const system = systems.find((entry) =>
            String(entry.solarSystemName || entry.name || "").toLowerCase() === targetText.toLowerCase(),
          );
          destinationSystemID = Number(system && system.solarSystemID) || 0;
        }
        if (destinationSystemID) {
          bot = candidate;
          break;
        }
      }
      if (!bot) {
        return handledResult(chatHub, session, options, "Usage: /playerbots route <bot name> <system ID or exact system name>.");
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only order playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const spaceActors = require("../playerbots/playerBotSpaceRuntime");
      const preview = spaceActors.previewSystemRoute(bot, destinationSystemID);
      if (!preview.success) {
        return handledResult(chatHub, session, options, preview.message || "Could not calculate that route.");
      }
      const taskRuntime = require("../playerbots/playerBotTaskRuntime");
      const existingRoute = taskRuntime.listTasks({ limit: 100 }).find((task) =>
        task.kind === "playerbot.space.route" &&
        ["queued", "leased"].includes(task.status) &&
        Number(task.resourceOwnerCharacterID) === Number(bot.characterID),
      );
      if (existingRoute && Number(existingRoute.payload && existingRoute.payload.destinationSystemID) !== destinationSystemID) {
        return handledResult(
          chatHub,
          session,
          options,
          `${bot.characterName} already has route ${existingRoute.taskID} to system ${existingRoute.payload.destinationSystemID}; cancel it before assigning another.`,
        );
      }
      const queued = taskRuntime.enqueueTask({
        kind: "playerbot.space.route",
        capability: "navigation",
        resourceOwnerCharacterID: Number(bot.characterID),
        requestedByCharacterID: Number(session && (session.characterID || session.charID || session.charid)) || null,
        dedupeKey: `playerbot.space.route:${Number(bot.characterID)}:${destinationSystemID}`,
        payload: {
          destinationSystemID,
          plannedSystemIDs: preview.systemIDs,
          plannedHopCount: preview.hops,
          routeRisk: preview.risk,
        },
      });
      const autonomy = require("../playerbots/playerBotAutonomyRuntime");
      const risk = preview.risk || { lowsecSystemIDs: [], nullsecSystemIDs: [] };
      const riskSummary = `route risk: ${risk.lowsecSystemIDs.length} low-sec and ${risk.nullsecSystemIDs.length} null-sec system(s)`;
      return autonomy.ensureNavigationTask(queued.task.taskID).then(() =>
        handledResult(
          chatHub,
          session,
          options,
          `${bot.characterName} has route ${queued.task.taskID} to system ${destinationSystemID} (${preview.hops} planned jump(s); ${riskSummary}). Cancel it with /playerbots task cancel ${queued.task.taskID}.`,
        ),
      ).catch((error) => handledResult(
        chatHub,
        session,
        options,
        `Route ${queued.task.taskID} was saved, but the planner is unavailable: ${error.message}.`,
      ));
    }
    const actorActionMatch = argumentText.match(/^(undock|warp|dock)\s+(.+)$/i);
    if (actorActionMatch) {
      const action = actorActionMatch[1].toLowerCase();
      let botQuery = actorActionMatch[2].trim();
      let targetID = 0;
      if (action !== "undock") {
        const targetMatch = botQuery.match(/^(.+)\s+(\d+)$/);
        if (!targetMatch) {
          return handledResult(
            chatHub,
            session,
            options,
            action === "warp"
              ? "Usage: /playerbots warp <bot> <entityID>."
              : "Usage: /playerbots dock <bot> <stationID>.",
          );
        }
        botQuery = targetMatch[1].trim();
        targetID = Number(targetMatch[2]);
      }
      const bot = playerBots.resolveBot(botQuery);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botQuery}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(
          chatHub,
          session,
          options,
          "You can only order playerbots in your corporation or fleet; staff/admin can control any playerbot."
        );
      }
      const spaceActors = require("../playerbots/playerBotSpaceRuntime");
      const result = action === "undock"
        ? spaceActors.undock(bot)
        : action === "warp"
          ? spaceActors.warp(bot, targetID)
          : spaceActors.dock(bot, targetID);
      return handledResult(chatHub, session, options, result.message);
    }
    const botStateMatch = argumentText.match(/^(pause|resume)\s+(.+)$/i);
    if (botStateMatch) {
      const bot = playerBots.resolveBot(botStateMatch[2]);
      if (!bot) {
        return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${botStateMatch[2]}.`);
      }
      if (!canControlPlayerBot(session, bot)) {
        return handledResult(chatHub, session, options, "You can only control playerbots in your corporation or fleet; staff/admin can control any playerbot.");
      }
      const taskRuntime = require("../playerbots/playerBotTaskRuntime");
      if (botStateMatch[1].toLowerCase() === "pause") {
        const result = taskRuntime.pauseBot(bot);
        return handledResult(chatHub, session, options, result.success
          ? `${bot.characterName} is paused; ${result.released} task(s) returned to the queue.`
          : `Could not pause ${bot.characterName}: ${result.message || "error"}.`);
      }
      const result = taskRuntime.resumeBot(bot);
      return handledResult(chatHub, session, options, result.success
        ? `${bot.characterName} will resume autonomous tasks on the next tick.`
        : `Could not resume ${bot.characterName}: ${result.message || "error"}.`);
    }
    const taskCommandMatch = argumentText.match(/^task\s+(pi\s+.+|cancel\s+\S+|retry\s+\S+)$/i);
    if (taskCommandMatch) {
      const taskRuntime = require("../playerbots/playerBotTaskRuntime");
      const taskArgument = taskCommandMatch[1].trim();
      const maintenanceMatch = taskArgument.match(/^pi\s+(.+)$/i);
      if (maintenanceMatch) {
        const bot = playerBots.resolveBot(maintenanceMatch[1]);
        if (!bot) {
          return handledResult(chatHub, session, options, `No unique playerbot found with that name: ${maintenanceMatch[1]}.`);
        }
        if (!canControlPlayerBot(session, bot)) {
          return handledResult(chatHub, session, options, "You can only request tasks from playerbots in your corporation or fleet; staff/admin can control any playerbot.");
        }
        try {
          const result = taskRuntime.requestExtractorMaintenance(
            bot,
            Number(session && (session.characterID || session.charID || session.charid)) || 0,
          );
          return handledResult(chatHub, session, options, result.created
            ? `Task ${result.task.taskID} queued for PI maintenance by ${bot.characterName}.`
            : result.task
              ? `${bot.characterName} already has task ${result.task.taskID} ${result.task.status}.`
              : result.message || `${bot.characterName} has no pending PI maintenance.`);
        } catch (error) {
          return handledResult(chatHub, session, options, `Could not queue PI maintenance: ${error.message}`);
        }
      }
      const cancelMatch = taskArgument.match(/^cancel\s+(\S+)$/i);
      if (cancelMatch) {
        const task = taskRuntime.getTask(cancelMatch[1]);
        if (!task) return handledResult(chatHub, session, options, "Playerbot task not found.");
        const controlledBot = playerBots.listBots().find((bot) =>
          Number(bot.characterID) === Number(task.targetCharacterID || task.providerCharacterID),
        );
        if (!hasStaffDebugRole(session) && (!controlledBot || !canControlPlayerBot(session, controlledBot))) {
          return handledResult(chatHub, session, options, "You can only cancel tasks for playerbots in your corporation or fleet; staff/admin can cancel any task.");
        }
        const result = taskRuntime.cancelTask(task.taskID);
        return handledResult(chatHub, session, options, result.success
          ? `Task ${task.taskID} cancelled.`
          : result.message);
      }
      const retryMatch = taskArgument.match(/^retry\s+(\S+)$/i);
      if (retryMatch) {
        const task = taskRuntime.getTask(retryMatch[1]);
        if (!task) return handledResult(chatHub, session, options, "Playerbot task not found.");
        const controlledBot = playerBots.listBots().find((bot) =>
          Number(bot.characterID) === Number(task.resourceOwnerCharacterID || task.targetCharacterID || task.providerCharacterID),
        );
        if (!hasStaffDebugRole(session) && (!controlledBot || !canControlPlayerBot(session, controlledBot))) {
          return handledResult(chatHub, session, options, "You can only retry tasks for playerbots in your corporation or fleet; staff/admin can retry any task.");
        }
        const result = taskRuntime.retryTask(task.taskID);
        return handledResult(chatHub, session, options, result.success
          ? `Tarea ${task.taskID} reencolada.`
          : result.message);
      }
    }
    const fleetMatch = argumentText.match(/^fleet\s+(add|join)\s+(.+)$/i);
    if (fleetMatch) {
      const result = fleetMatch[1].toLowerCase() === "add"
        ? playerBots.addBotToPlayerFleet(session, fleetMatch[2])
        : playerBots.invitePlayerToBotFleet(session, fleetMatch[2]);
      return handledResult(chatHub, session, options, result.message);
    }
    const corporationMatch = argumentText.match(/^(invite|join)\s+(.+)$/i);
    if (corporationMatch) {
      const result = corporationMatch[1].toLowerCase() === "invite"
        ? playerBots.inviteBotToPlayerCorporation(session, corporationMatch[2])
        : playerBots.invitePlayerToBotCorporation(session, corporationMatch[2]);
      return handledResult(chatHub, session, options, result.message);
    }
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /playerbots status | ops | ops [page] | ops systems [page] | ops system <solarSystemID> | list [filter] | inspect <bot> | tasks [status] | autowork [on|off|status] | orders | haul <bot> <itemID|typeID> <fromStation> <toStation> [quantity] | courier post <issuerBot> <carrierBot> <startStation> <endStation> <itemID> <qty> <rewardISK> <collateralISK> | mine <bot> [trips] [station <id>] [norefine] [nosell] | upgrade <bot> [mining|logistics|security|piracy|sovereignty] [force] | colony <bot> | combat <bot> [security|war|piracy|nullsec-conflict] | sovereignty <bot> | alliance found <CEO bot> | build <bot> <structurePackageItemID> [nullSystemID] | op status|stop|resume <bot> | industry cycle start <bot> <blueprintTypeID> <runs> <maxISK> [station <id>] [floor <ISK>] | industry cycle status|stop|resume <bot> | industry list|jobs <bot> | industry auto set <bot> <blueprintItemID> <runs> <maxISK> | industry auto status|off <bot> | invite|join <bot> | fleet add|join <bot> | corp pause|resume | fund <bot> <ISK> | pi export set <bot> <planetID> <maxUnits> <maxTaxISK> | pi export status|off <bot> <planetID> | trade quote <bot> <typeID> | trade buy <bot> <typeID> <quantity> <maxUnitPrice> | trade sell <bot> <itemID> [quantity] <minUnitPrice> | trade autosell set <bot> <typeID> <minUnitPrice> <maxUnits> | trade autosell status|off <bot> | trade autobuy set <bot> <typeID> <maxUnitPrice> <targetStock> <maxSpendPerCycle> | trade autobuy status|off <bot> | undock <bot> | warp <bot> <entityID> | dock <bot> <stationID> | task pi <bot> | task cancel|retry <taskID> | pause|resume <bot> | seed [30-15,000] (staff; enables gradual seeding within configured ceiling)." + (() => {
        try { return require("../playerbots/playerBotCorpCommands").usageSuffix(argumentText); } catch (error) { return ""; }
      })(),
    );
  }

  if (command === "deer_hunter") {
    return handleDeerHunterCommand(session, chatHub, options);
  }

  if (
    command === "blue" ||
    command === "red" ||
    command === "teal" ||
    command === "yellow"
  ) {
    return handleChatColorCommand(session, command, chatHub, options);
  }

  if (command === "where") {
    return handledResult(chatHub, session, options, getLocationSummary(session));
  }
  if (command === "voidreplay") {
    return require("./commands/voidReplay").handleVoidReplayCommand(session, argumentText, chatHub, options);
  }
  if (command === "orbitals") {
    return handledResult(chatHub, session, options,
      require("./commands/orbitalDiscoveryCommand").buildOrbitalDiscoveryMessage(session, argumentText));
  }

  if (command === "abyssaldebug") {
    return handleAbyssalDebugCommand(session, argumentText, chatHub, options);
  }

  if (command === "abyssallayout") {
    return handleAbyssalLayoutCommand(session, argumentText, chatHub, options);
  }

  if (command === "abyssalstatus") {
    return handleAbyssalStatusCommand(session, argumentText, chatHub, options);
  }

  if (command === "abyssalrescue") {
    return handleAbyssalRescueCommand(session, argumentText, chatHub, options);
  }

  if (command === "dock") {
    return handleHomeDock(session, chatHub, options);
  }

  if (command === "dmg") {
    return handleDamageCommand(session, argumentText, chatHub, options);
  }

  if (command === "heal") {
    if (/^\d+\s+0$/.test(argumentText.trim())) {
      return require("./commands/nativeDestroy").handleNativeDestroyCommand(session, argumentText, chatHub, options);
    }
    if (argumentText) return handleNativeHealCommand(session, argumentText, chatHub, options);
    return handleHealCommand(session, chatHub, options);
  }

  if (command === "ceq") {
    const { normalizeRoleValue, ROLE_GML, ROLE_WORLDMOD } = require("../account/accountRoleProfiles");
    const role = normalizeRoleValue(session?.accountRole ?? session?.role, 0n);
    if ((role & (ROLE_GML | ROLE_WORLDMOD)) === 0n) {
      return handledResult(chatHub, session, options, "Only GM accounts can use /ceq.");
    }
    const level = Number(argumentText);
    if (rest.length !== 1 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(argumentText) ||
        !Number.isFinite(level) || level < 0 || level > 100) {
      return handledResult(chatHub, session, options, "Usage: /ceq <0-100> (for example, /ceq 100).");
    }
    const result = require("../character/characterEnergyMgrService").setCharacterEnergyLevel(session, level);
    const message = result.success ? `Set your CEQ to ${level}.`
      : result.errorMsg === "CHARACTER_NOT_FOUND" ? "Select a character before using /ceq."
        : result.errorMsg === "INVALID_CHARACTER_ENERGY_LEVEL" ? "CEQ must be within your character's energy limits (0-100)."
          : `Unable to set CEQ: ${result.errorMsg || "storage failed"}.`;
    return handledResult(chatHub, session, options, message);
  }

  if (command === "interference") {
    const { normalizeRoleValue, ROLE_GML, ROLE_WORLDMOD } = require("../account/accountRoleProfiles");
    const role = normalizeRoleValue(session?.accountRole ?? session?.role, 0n);
    if ((role & (ROLE_GML | ROLE_WORLDMOD)) === 0n) {
      return handledResult(chatHub, session, options, "Only GM accounts can use /interference.");
    }
    if (rest.length !== 1 || argumentText.toLowerCase() !== "reset") {
      return handledResult(chatHub, session, options, "Usage: /interference reset");
    }
    const result = require("../map/solarsystemInterferenceMgrService").resetLocalInterference(session);
    let message;
    if (result.success) {
      const id = result.data.solarSystemID;
      const name = worldData.getSolarSystemByID(id)?.solarSystemName || `system ${id}`;
      message = `Reset signal interference in ${name} to 0%.`;
    } else {
      message = result.errorMsg === "CHARACTER_NOT_FOUND" ? "Select a character before using /interference."
        : result.errorMsg === "SOLAR_SYSTEM_NOT_FOUND" ? "No current public solar system is available."
          : `Unable to reset signal interference: ${result.errorMsg || "storage failed"}.`;
    }
    return handledResult(chatHub, session, options, message);
  }

  if (command === "repairmodules") {
    return handleRepairModulesCommand(session, argumentText, chatHub, options);
  }

  if (command === "chowner") {
    return require("./commands/changeOwner").handleChangeOwnerCommand(session, argumentText, chatHub, options);
  }

  if (command === "effect") {
    return handleEffectCommand(session, argumentText, chatHub, options);
  }

  if (command === "dogma") {
    return require("./commands/dogma").handleDogmaCommand(session, argumentText, chatHub, options);
  }

  if (command === "fireshow") {
    return require("./commands/fireShow").handleFireShowCommand(session, argumentText, chatHub, options);
  }

  if (command === "gate" || command === "gateshowcase") {
    return require("./commands/transientGates").handleTransientGateCommand(session, command, argumentText, chatHub, options);
  }

  if (command === "upwell") {
    const result = executeUpwellCommand(session, argumentText);
    structureLog.logCommand(session, `/upwell ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  // The client's own GM structure menu (eve/client/script/ui/structure/
  // structuremenu.py:74-94) sends /structure state|timer|unanchor|deploytimer|
  // abandontimer through the slash service.
  if (command === "structure") {
    const result = executeStructureGmCommand(session, argumentText);
    structureLog.logCommand(session, `/structure ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "war") {
    const result = require("../corporation/warGmCommands").executeWarGmCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  // The client's moon scheduling window GM buttons (ui/moonmining/scheduling.py:275-278).
  if (command === "extraction") {
    const result = executeExtractionGmCommand(session, argumentText);
    structureLog.logCommand(session, `/extraction ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "pos") {
    const result = executePosCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "upwellauto") {
    const result = executeUpwellAutoCommand(session, argumentText);
    structureLog.logCommand(session, `/upwellauto ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "bpauto") {
    return executeBlueprintAutoCommand(session, argumentText).then((result) =>
      handledResult(chatHub, session, options, result.message));
  }

  if (command === "bp") {
    const result = executeBlueprintCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "bookmarkauto") {
    const result = executeBookmarkAutoCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "calauto") {
    const result = executeCalendarAutoCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "reprocesssmoke") {
    return executeReprocessingSmokeCommand(session, argumentText).then((result) =>
      handledResult(chatHub, session, options, result.message));
  }

  if (command === "sov") {
    const result = executeSovCommand(session, argumentText);
    sovLog.logCommand(session, `/sov ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "sovauto" || command === "autosov") {
    const result = executeSovAutoCommand(session, argumentText, chatHub, options);
    sovLog.logCommand(session, `/${command} ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "jetcan") {
    return handleJetcanCommand(session, argumentText, chatHub, options);
  }

  if (command === "container") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "container");
  }

  if (command === "gmships") {
    return handleGmShipsCommand(session, chatHub, options);
  }

  if (command === "gmweapons") {
    return handleGmWeaponsCommand(session, chatHub, options);
  }

  if (command === "prop") {
    return handlePropCommand(session, chatHub, options);
  }

  if (command === "allskills") {
    return handleAllSkillsCommand(session, chatHub, options);
  }

  if (command === "allskins") {
    return handleAllSkinsCommand(session, argumentText, chatHub, options);
  }

  if (command === "allskinr") {
    return handleAllSkinrCommand(session, argumentText, chatHub, options);
  }

  if (command === "skinr") {
    return handleSkinrCommand(session, argumentText, chatHub, options);
  }

  if (command === "backintime") {
    return handleBackInTimeCommand(session, argumentText, chatHub, options);
  }

  if (command === "expertsystem" || command === "expertsystems") {
    return handleExpertSystemCommand(session, argumentText, chatHub, options);
  }

  if (command === "gmskills") {
    return handleGmSkillsCommand(session, chatHub, options);
  }

  if (command === "giveskill" || command === "giveskills") {
    return handleGiveSkillCommand(session, argumentText, chatHub, options);
  }

  if (command === "removeskill" || command === "removeskills") {
    return handleRemoveSkillCommand(session, argumentText, chatHub, options);
  }

  if (command === "loadsys") {
    return handleLoadSystemCommand(session, chatHub, options);
  }

  if (command === "loadallsys") {
    return handleLoadAllSystemsCommand(session, chatHub, options);
  }

  if (command === "tidi") {
    return handleTimeDilationCommand(session, argumentText, chatHub, options);
  }


  if (command === "spawncontainer") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "container");
  }

  if (command === "spawnwreck") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "wreck");
  }

  if (command === "wreck") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "wreck");
  }

  if (command === "suicide") {
    return handleSuicideCommand(session, chatHub, options);
  }

  if (command === "deathtest") {
    return handleDeathTestCommand(session, argumentText, chatHub, options);
  }

  if (command === "deathstructure") {
    return handleStructureDeathTestCommand(session, argumentText, chatHub, options);
  }

  if (command === "deadwarp") {
    return handleDeadwarpCommand(session, argumentText, chatHub, options);
  }

  if (command === "spawnsite") {
    return handleSpawnSiteCommand(session, argumentText, chatHub, options);
  }

  if (command === "celestial") {
    return handleCelestialCommand(session, argumentText, chatHub, options);
  }

  if (command === "lco") {
    const action = String(argumentText || "").trim().split(/\s+/, 1)[0];
    if (["list", "inspect", "move", "offset", "rotate", "save"].includes(action)) {
      if (!hasStaffDebugRole(session)) {
        return handledResult(chatHub, session, options, "LCO requires a staff/admin role.");
      }
      const transforms = require("../../space/lcoTransforms");
      try {
        return handledResult(chatHub, session, options,
          transforms.execute(spaceRuntime.getSceneForSession(session), argumentText));
      } catch (error) {
        return handledResult(chatHub, session, options, `LCO operation failed: ${error.message}`);
      }
    }
    return handleLargeCollidableObjectCommand(session, argumentText, chatHub, options);
  }

  if (command === "npc") {
    return handleNpcCommand(session, argumentText, chatHub, options);
  }

  if (command === "mnpc") {
    return handleMissileNpcCommand(session, argumentText, chatHub, options);
  }

  if (CAPITAL_NPC_CHAT_COMMANDS.includes(command)) {
    return handleCapitalNpcCommand(session, argumentText, chatHub, options, command);
  }

  if (WORMHOLE_CHAT_COMMANDS.includes(command)) {
    const result = executeWormholeCommand(session, command, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (TRIG_DRIFTER_CHAT_COMMANDS.includes(command)) {
    const result = executeTrigDrifterCommand(session, command, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (GATE_SKIN_CHAT_COMMANDS.includes(command)) {
    const result = executeGateSkinCommand(session, argumentText, options);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "dirt") {
    const result = handleShipDirtCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "killmarks" || command === "killmark") {
    const result = handleShipKillmarksCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npctest") {
    return handleNpcTestCommand(session, argumentText, chatHub, options, "player");
  }

  if (command === "npctest2") {
    return handleNpcTestCommand(session, argumentText, chatHub, options, "ffa");
  }

  if (command === "npcminer") {
    const result = executeMiningFleetCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcmineraggro") {
    const result = executeMiningFleetAggroCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerpanic") {
    const result = executeMiningFleetAggroCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerretreat") {
    const result = executeMiningFleetRetreatCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerresume") {
    const result = executeMiningFleetResumeCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerhaul") {
    const result = executeMiningFleetHaulCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerclear") {
    const result = executeMiningFleetClearCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerstatus") {
    const result = executeMiningFleetStatusCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "miningreset") {
    const result = executeMiningStateResetCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "miningstatus") {
    const result = executeMiningStateStatusCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcw" || command === "wnpc") {
    return handleNpcWarpCommand(session, argumentText, chatHub, options, command);
  }

  if (command === "npcclear") {
    return handleNpcClearCommand(session, argumentText, chatHub, options);
  }

  if (command === "concord") {
    return handleConcordCommand(session, argumentText, chatHub, options);
  }

  if (command === "cwatch") {
    return handleCrimewatchCommand(session, argumentText, chatHub, options);
  }

  if (command === "naughty") {
    return handleNaughtyCommand(session, argumentText, chatHub, options);
  }

  if (command === "secstatus") {
    return handleSecurityStatusCommand(session, argumentText, chatHub, options);
  }

  if (command === "gateconcord") {
    return handleGateOperatorCommand(
      session,
      argumentText,
      chatHub,
      options,
      npcService.GATE_OPERATOR_KIND.CONCORD,
    );
  }

  if (command === "gaterats") {
    return handleGateOperatorCommand(
      session,
      argumentText,
      chatHub,
      options,
      npcService.GATE_OPERATOR_KIND.RATS,
    );
  }

  if (command === "invu") {
    return handleInvuCommand(session, argumentText, chatHub, options);
  }

  if (command === "keepstar") {
    return handleKeepstarCommand(session, chatHub, options);
  }

  if (command === "fire") {
    return handleFireCommand(session, argumentText, chatHub, options);
  }

  if (command === "fire2") {
    return handleFire2Command(session, argumentText, chatHub, options);
  }

  if (command === "supertitan") {
    const result = executeSuperTitanCommand(session, argumentText, options);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "supertitanshow" || command === "titansupershow") {
    const result = executeSuperTitanShowCommand(
      session,
      argumentText,
      options,
    );
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "rr") {
    const result = executeRemoteRepairFleetCommand(
      session,
      argumentText,
      options,
    );
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "testclear") {
    return handleTestClearCommand(session, chatHub, options);
  }

  if (command === "sysjunkclear") {
    return handleSystemJunkClearCommand(session, chatHub, options);
  }

  if (command === "who") {
    return handledResult(
      chatHub,
      session,
      options,
      getConnectedCharacterSummary(),
    );
  }

  if (command === "wallet" || command === "isk") {
    const summary = getWalletSummary(session);
    return handledResult(
      chatHub,
      session,
      options,
      summary || "Select a character before checking wallet balance.",
    );
  }

  if (command === "lp") {
    return handledResult(
      chatHub,
      session,
      options,
      getLoyaltyPointSummary(session, argumentText),
    );
  }

  if (command === "evermarks") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before checking EverMarks.",
      );
    }

    const evermarks = getCharacterWalletLPBalance(
      session.characterID,
      EVERMARK_ISSUER_CORP_ID,
    );
    return handledResult(
      chatHub,
      session,
      options,
      `EverMarks: ${formatEvermarks(evermarks)}.`,
    );
  }

  if (command === "corpevermarks") {
    if (!session || !(session.corporationID || session.corpid)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character in a corporation before checking corporation EverMarks.",
      );
    }

    const corporationID = Number(session.corporationID || session.corpid) || 0;
    const evermarks = getCorporationWalletLPBalance(
      corporationID,
      EVERMARK_ISSUER_CORP_ID,
    );
    return handledResult(
      chatHub,
      session,
      options,
      `Corporation EverMarks: ${formatEvermarks(evermarks)}.`,
    );
  }

  if (
    command === "grantshipemblem" ||
    command === "grantcorplogo" ||
    command === "grantalliancelogo"
  ) {
    return handleGrantShipLogoCommand(
      command,
      session,
      argumentText,
      chatHub,
      options,
    );
  }

  if (command === "corpcreate") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before creating a corporation.",
      );
    }

    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /corpcreate <corporation name>",
      );
    }

    // A corporation's headquarters must be an NPC station. The client's own
    // creation flow takes the station from the session (empty when the founder
    // sits in a player structure); this GM shortcut has no client flow behind
    // it, so it fixes a valid default instead: Jita IV-4, which a director can
    // move later with the normal Move HQ action.
    const GM_CORP_CREATE_STATION_ID = 60003760;
    const result = createCustomCorporation(session.characterID, argumentText, {
      stationID: GM_CORP_CREATE_STATION_ID,
    });
    if (!result.success) {
      const message =
        result.errorMsg === "CORPORATION_NAME_TAKEN"
          ? `Corporation already exists: ${argumentText}.`
          : "Corporation creation failed.";
      return handledResult(chatHub, session, options, message);
    }

    // Announce the new corporation as the client's own create does
    // (corpRegistryRuntime: OnCorporationChanged from None, golden log "Create Corp").
    notifyCorporationChanged(result.data.corporationRecord.corporationID, null);
    refreshAffiliationSessions(result.data.affectedCharacterIDs);
    return handledResult(
      chatHub,
      session,
      options,
      `Created corporation ${result.data.corporationRecord.corporationName} [${result.data.corporationRecord.tickerName}] and moved your character into it.`,
    );
  }

  if (command === "setalliance") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before creating an alliance.",
      );
    }

    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setalliance <alliance name>",
      );
    }

    const corporationRecord = getCorporationRecord(session.corporationID);
    if (!corporationRecord) {
      return handledResult(
        chatHub,
        session,
        options,
        "Current corporation could not be resolved.",
      );
    }

    const affiliationBefore = captureAllianceAffiliationBefore(corporationRecord);
    const result = createCustomAllianceForCorporation(
      session.characterID,
      corporationRecord.corporationID,
      argumentText,
    );
    if (!result.success) {
      let message = "Alliance creation failed.";
      if (result.errorMsg === "CUSTOM_CORPORATION_REQUIRED") {
        message = "You must be in a custom corporation before creating an alliance.";
      } else if (result.errorMsg === "ALLIANCE_NAME_TAKEN") {
        message = `Alliance already exists: ${argumentText}.`;
      }
      return handledResult(chatHub, session, options, message);
    }

    refreshAffiliationSessions(result.data.affectedCharacterIDs);
    notifyAllianceAffiliationChanged(affiliationBefore, result.data.allianceID);
    return handledResult(
      chatHub,
      session,
      options,
      `Created alliance ${result.data.allianceRecord.allianceName} [${result.data.allianceRecord.shortName}] and set your corporation into it.`,
    );
  }

  if (command === "joinalliance") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before joining an alliance.",
      );
    }

    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /joinalliance <alliance name>",
      );
    }

    const corporationRecord = getCorporationRecord(session.corporationID);
    if (!corporationRecord) {
      return handledResult(
        chatHub,
        session,
        options,
        "Current corporation could not be resolved.",
      );
    }

    const affiliationBefore = captureAllianceAffiliationBefore(corporationRecord);
    const result = joinCorporationToAllianceByName(
      corporationRecord.corporationID,
      argumentText,
    );
    if (!result.success) {
      let message = "Alliance join failed.";
      if (result.errorMsg === "CUSTOM_CORPORATION_REQUIRED") {
        message = "You must be in a custom corporation before joining a custom alliance.";
      } else if (result.errorMsg === "ALLIANCE_NOT_FOUND") {
        message = `Alliance not found: ${argumentText}.`;
      } else if (result.errorMsg === "ALREADY_IN_ALLIANCE") {
        message = `Your corporation is already in ${argumentText}.`;
      }
      return handledResult(chatHub, session, options, message);
    }

    refreshAffiliationSessions(result.data.affectedCharacterIDs);
    notifyAllianceAffiliationChanged(affiliationBefore, result.data.allianceID);
    return handledResult(
      chatHub,
      session,
      options,
      `Joined alliance ${result.data.allianceRecord.allianceName} [${result.data.allianceRecord.shortName}].`,
    );
  }

  if (command === "solar") {
    return handleSolarTeleport(session, argumentText, chatHub, options);
  }

  if (command === "tele") {
    return handleTeleCommand(session, argumentText, chatHub, options);
  }

  if (command === "setstanding") {
    return handleSetStandingCommand(session, argumentText, chatHub, options);
  }

  if (command === "maxagentstandings" || command === "fullstandings") {
    return handleMaxAgentStandingsCommand(
      session,
      argumentText,
      chatHub,
      options,
    );
  }

  if (command === "sigscan") {
    return handleSigscanCommand(session, chatHub, options);
  }

  if (command === "sigs") {
    return handleSigsCommand(session, chatHub, options);
  }

  if (command === "missioncomplete") {
    return handleMissionCompleteCommand(
      session,
      argumentText,
      chatHub,
      options,
    );
  }

  if (command === "overlayrefresh") {
    return handleOverlayRefreshCommand(session, chatHub, options);
  }

  if (command === "events") {
    if (!hasStaffDebugRole(session)) return handledResult(chatHub, session, options, "Event inspection requires a staff/admin role.");
    const lifecycle = require("../seasons/eventLifecycle");
    const [id, character] = argumentText.trim().split(/\s+/);
    if (id === "readiness") return handledResult(chatHub, session, options, JSON.stringify(require("../seasons/eventReadiness").inspect()));
    if (character !== undefined) {
      if (id !== "gallente-election-yc128" || !/^\d+$/.test(character) || !Number.isSafeInteger(Number(character)) || Number(character) <= 0) return handledResult(chatHub, session, options, "Usage: /events gallente-election-yc128 [characterID]");
      return handledResult(chatHub, session, options, JSON.stringify(lifecycle.inspectCharacter(Number(character))));
    }
    const rows = lifecycle.inspect().filter(row => !id || row.id === id);
    return handledResult(chatHub, session, options, rows.length ? rows.map(row => {
      const result = row.candidateTotals;
      return `${row.id}: ${row.phase}; starts ${row.startsAt}; ends ${row.endsAt}; trader end ${new Date(row.conclusion?.traderEndsAtMs || row.traderEndsAtMs).toISOString()}` +
        (result ? `; totals ${JSON.stringify(result.totals)}; ${result.outcome}; leaders ${result.leaders.join(", ") || "none"}; ${row.conclusion ? "FINAL" : "provisional"}` : "");
    }).join("<br>") : "Unknown event ID. Use /events to list implemented schedules.");
  }

  if (command === "tr") {
    return handleTransportCommand(session, argumentText, chatHub, options);
  }

  if (command === "addisk") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing wallet balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addisk <amount>",
      );
    }

    return adjustCharacterBalanceAsync(session.characterID, amount, {
      description: `Admin /addisk by ${session.characterName || session.userName || "unknown"}`,
      ownerID1: session.characterID,
      ownerID2: session.characterID,
      referenceID: session.characterID,
    }, { source: "chat.admin.addisk" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          result.errorMsg === "INSUFFICIENT_FUNDS"
            ? "Wallet change failed: insufficient funds."
            : "Wallet change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        result.capped
          ? `Adjusted wallet by ${formatIsk(result.delta)}. New balance: ${formatIsk(result.data.balance)}, the most a wallet can hold.`
          : `Adjusted wallet by ${formatIsk(amount)}. New balance: ${formatIsk(result.data.balance)}.`,
      );
    });
  }

  if (command === "addlp") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing LP.",
      );
    }

    const parsed = parseLoyaltyPointMutationArgs(argumentText);
    if (parsed.amount === null || !parsed.issuerText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addlp <amount> <npc corp name|corpID>",
      );
    }

    const issuerResult = resolveLoyaltyPointIssuerCorporation(parsed.issuerText);
    if (!issuerResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        formatLoyaltyPointIssuerError(issuerResult, parsed.issuerText),
      );
    }

    const result = adjustCharacterWalletLPBalance(
      session.characterID,
      issuerResult.data.corporationID,
      parsed.amount,
      { changeType: "admin_adjust" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "LP change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Adjusted ${formatCorporationLabel(issuerResult.data)} LP by ${formatSignedLoyaltyPoints(parsed.amount)}. New balance: ${formatLoyaltyPoints(result.data.amount)}.`,
    );
  }

  if (command === "addevermarks") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addevermarks <amount>",
      );
    }

    const result = adjustCharacterWalletLPBalance(
      session.characterID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { changeType: "admin_adjust" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Adjusted EverMarks by ${formatSignedEvermarks(amount)}. New balance: ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "addcorpevermarks") {
    if (!session || !(session.corporationID || session.corpid)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character in a corporation before changing corporation EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addcorpevermarks <amount>",
      );
    }

    const corporationID = Number(session.corporationID || session.corpid) || 0;
    const result = adjustCorporationWalletLPBalance(
      corporationID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { reason: "admin_adjust" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "Corporation EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Adjusted corporation EverMarks by ${formatSignedEvermarks(amount)}. New balance: ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "addplex") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing PLEX balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addplex <amount>",
      );
    }

    return adjustCharacterPlexBalanceAsync(session.characterID, amount, {
      categoryMessageID: PLEX_LOG_CATEGORY.CCP,
      reason: `Admin /addplex by ${session.characterName || session.userName || "unknown"}`,
    }, { source: "chat.admin.addplex" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          "PLEX balance change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        `Adjusted PLEX by ${formatSignedPlex(amount)}. New balance: ${formatPlex(result.data.plexBalance)}.`,
      );
    });
  }

  if (command === "setisk") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing wallet balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setisk <amount>",
      );
    }

    return setCharacterBalanceAsync(session.characterID, amount, {
      description: `Admin /setisk by ${session.characterName || session.userName || "unknown"}`,
      ownerID1: session.characterID,
      ownerID2: session.characterID,
      referenceID: session.characterID,
    }, { source: "chat.admin.setisk" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          result.errorMsg === "INSUFFICIENT_FUNDS"
            ? "Wallet change failed: balance cannot be negative."
            : "Wallet change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        result.capped
          ? `Wallet balance set to ${formatIsk(result.data.balance)}, the most a wallet can hold.`
          : `Wallet balance set to ${formatIsk(result.data.balance)}.`,
      );
    });
  }

  if (command === "setlp") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing LP.",
      );
    }

    const parsed = parseLoyaltyPointMutationArgs(argumentText);
    if (parsed.amount === null || !parsed.issuerText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setlp <amount> <npc corp name|corpID>",
      );
    }

    const issuerResult = resolveLoyaltyPointIssuerCorporation(parsed.issuerText);
    if (!issuerResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        formatLoyaltyPointIssuerError(issuerResult, parsed.issuerText),
      );
    }

    const result = setCharacterWalletLPBalance(
      session.characterID,
      issuerResult.data.corporationID,
      parsed.amount,
      { changeType: "admin_set" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "LP change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `${formatCorporationLabel(issuerResult.data)} LP set to ${formatLoyaltyPoints(result.data.amount)}.`,
    );
  }

  if (command === "setevermarks") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setevermarks <amount>",
      );
    }

    const result = setCharacterWalletLPBalance(
      session.characterID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { changeType: "admin_set" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `EverMarks set to ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "setcorpevermarks") {
    if (!session || !(session.corporationID || session.corpid)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character in a corporation before changing corporation EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setcorpevermarks <amount>",
      );
    }

    const corporationID = Number(session.corporationID || session.corpid) || 0;
    const result = setCorporationWalletLPBalance(
      corporationID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { reason: "admin_set" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "Corporation EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Corporation EverMarks set to ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "setplex") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing PLEX balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setplex <amount>",
      );
    }

    return setCharacterPlexBalanceAsync(session.characterID, amount, {
      categoryMessageID: PLEX_LOG_CATEGORY.CCP,
      reason: `Admin /setplex by ${session.characterName || session.userName || "unknown"}`,
    }, { source: "chat.admin.setplex" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          "PLEX balance change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        `PLEX balance set to ${formatPlex(result.data.plexBalance)}.`,
      );
    });
  }

  if (command === "ship" || command === "giveme") {
    return handleShipSpawn(command, session, argumentText, chatHub, options);
  }

  const rackCommandPreset = resolveSingleRackCommandPreset(command);
  if (rackCommandPreset) {
    return handlePresetSingleRackCommand(
      session,
      chatHub,
      options,
      rackCommandPreset,
      command,
    );
  }

  if (command === "lesmis") {
    return handleLesmisCommand(session, chatHub, options);
  }

  if (command === "miner") {
    const result = executeMinerCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "orca") {
    const result = executeOrcaCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "probe") {
    const result = executeProbeCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "probe2") {
    const result = executeProbe2Command(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "trig") {
    const result = executeTrigCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "cburst") {
    const result = executeCburstCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "guardian") {
    const result = executeGuardianCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "basilisk") {
    const result = executeBasiliskCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "ewar") {
    const result = executeEwarCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "container1") {
    return handleContainer1Command(session, chatHub, options);
  }

  if (command === "minerals") {
    return handleMineralsCommand(session, chatHub, options);
  }

  if (command === "create" || command === "createitem") {
    return handleCreateItemCommand(session, argumentText, chatHub, options, command);
  }

  if (command === "load") {
    return handleLoadCommand(session, argumentText, chatHub, options);
  }

  if (command === "giveitem" || command === "item") {
    return handleGiveItemCommand(session, argumentText, chatHub, options);
  }

  if (command === "fit") {
    return handleFitCommand(session, argumentText, chatHub, options);
  }

  if (command === "unfit") {
    return handleUnfitCommand(session, argumentText, chatHub, options);
  }

  // menusvc.py and the GM "Unload All" macro use this spelling for unfitting.
  if (command === "unload") {
    if (!hasStaffDebugRole(session)) {
      return handledResult(chatHub, session, options, "/unload requires a staff/admin role.");
    }
    return handleUnfitCommand(session, argumentText, chatHub, options);
  }

  if (command === "online") {
    return require("./commands/onlineModules").handleOnlineCommand(session, argumentText, chatHub, options);
  }

  if (command === "getshipsetup") {
    return require("./commands/shipSetup").handleGetShipSetupCommand(session, argumentText, chatHub, options);
  }

  if (command === "reportdesync") {
    return require("./commands/reportDesync").handleReportDesyncCommand(session, argumentText, chatHub, options);
  }

  if (command === "fetch") {
    return handleFetchCommand(session, argumentText, chatHub, options);
  }

  if (["spawn", "spawnn", "entity"].includes(command)) {
    return require("./commands/nativeSpawns").handleNativeSpawnCommand(session, command, argumentText, chatHub, options);
  }

  if (command === "unspawn") {
    return require("./commands/unspawn").handleUnspawnCommand(session, argumentText, chatHub, options);
  }

  if (command === "hangar") {
    return handledResult(chatHub, session, options, getHangarSummary(session));
  }

  if (command === "session") {
    return handledResult(chatHub, session, options, getSessionSummary(session));
  }

  if (command === "iteminfo") {
    return handledResult(chatHub, session, options, getItemSummary(argumentText));
  }

  if (command === "typeinfo") {
    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /typeinfo <ship name|typeID>",
      );
    }

    const lookup = resolveShipByName(argumentText);
    if (!lookup.success) {
      const message =
        lookup.errorMsg === "SHIP_NOT_FOUND"
          ? `Ship type not found: ${argumentText}.${formatSuggestions(lookup.suggestions)}`
          : `Ship type name is ambiguous: ${argumentText}.${formatSuggestions(lookup.suggestions)}`;
      return handledResult(chatHub, session, options, message.trim());
    }

    return handledResult(
      chatHub,
      session,
      options,
      `${lookup.match.name}: typeID=${lookup.match.typeID}, groupID=${lookup.match.groupID}, categoryID=${lookup.match.categoryID}, published=${lookup.match.published === false ? "false" : "true"}.`,
    );
  }

  if (command === "announce") {
    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /announce <message>",
      );
    }

    sendAnnouncement(chatHub, session, argumentText);
    return handledResult(
      chatHub,
      session,
      options,
      `Announcement sent: ${argumentText}`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Unknown command: /${command}. Use /help.${formatSuggestions(suggestCommands(command))}`.trim(),
  );
}

module.exports = {
  AVAILABLE_SLASH_COMMANDS,
  COMMANDS_HELP_TEXT,
  DEER_HUNTER_MESSAGE,
  DEFAULT_MOTD_MESSAGE,
  executeChatCommand,
  getContainer1SeedPlan,
  getGmWeaponsSeedPlan,
  getPropulsionCommandItemTypes,
  _testing: {
    buildCelestialEntity,
    buildLargeCollidableObjectEntity,
    handleCelestialCommand,
    handleLargeCollidableObjectCommand,
    handleSuicideCommand,
    isSessionShipCapsuleBeforeDestruction,
    resolveAbyssalSuicideAuthority,
  },
};

"use strict";

const PAGE_SIZE = 50;
const DEFAULT_OPERATIONS_PAGE_SIZE = 100;
const REFRESH_MS = 15_000;
const OPERATIONS_REFRESH_MS = 60_000;
const ACTIVITY_REFRESH_MS = 60_000;
const PERFORMANCE_REFRESH_MS = 15_000;
const state = { performanceLoadedAt: 0, snapshot: null, page: 0, totalPilots: 0, operationPage: 0, operationPageSize: DEFAULT_OPERATIONS_PAGE_SIZE, operationRequestID: 0, totalOperations: 0, operationsLoadedAt: 0, activityPage: 0, activityPageSize: 100, activityRequestID: 0, activityLoadedAt: 0, activityTotal: 0, killboardLoadedAt: 0, view: "overview" };
const $ = (id) => document.getElementById(id);
const number = (value) => Number(value || 0).toLocaleString("en-US");
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const percent = (value, total) => total > 0 ? `${Math.min(100, Math.round(value * 100 / total))}%` : "0%";
function pilotPortrait(characterID, characterName) {
  const id = Math.trunc(Number(characterID) || 0);
  if (id <= 0) return `<span class="pilot-portrait-placeholder" aria-hidden="true">?</span>`;
  return `<img class="pilot-portrait" src="/api/character-portrait?characterID=${id}&amp;size=64" alt="Portrait of ${escapeHTML(characterName || `Pilot ${id}`)}" loading="lazy" width="40" height="40">`;
}
function formatDuration(value) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms < 1_000) return `${number(ms.toFixed(0))} ms`;
  const seconds = Math.floor(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m ${remainder}s` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

async function getJSON(path) {
  const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    let message = `Dashboard request failed (${response.status}).`;
    try { message = (await response.json()).error || message; } catch { /* keep generic error */ }
    throw new Error(message);
  }
  return response.json();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `view-${view}`));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === view));
  const title = ({ overview: "Overview", pilots: "Pilots", corporations: "Corporations", systems: "Systems", operations: "Operations", killboard: "Killboard", territory: "Territory", performance: "Performance", settings: "Settings" })[view] || "Overview";
  $("page-name").textContent = title;
  if (view === "pilots") void loadPilots();
  if (view === "operations") { void loadOperations(true); void loadPilotActivity(true); }
  if (view === "killboard") void loadKillboard(true);
  if (view === "settings") void loadSettings();
  if (view === "performance") void loadPerformance(true);
}

function setError(error) {
  const alert = $("alert");
  alert.textContent = `${error.message || error} The dashboard will retry automatically.`;
  alert.classList.remove("hidden");
  $("connection-state").textContent = "Data source unavailable";
  $("server-status").textContent = "Connection interrupted";
}

function renderSummary(data) {
  state.snapshot = data;
  const roster = data.roster || {};
  const presence = roster.presence || roster;
  const metricRows = [
    ["BOT ROSTER", number(roster.total), `Configured target ${number(roster.target)} · ceiling ${number(roster.operationalCeiling)} / hard cap ${number(roster.hardMaximum)}`, "cyan"],
    ["VIRTUAL PILOTS ONLINE", number(roster.online), `${number(roster.connections?.validatedMaximum)} simultaneous sessions validated · ${number(roster.inSpace)} in space · ${number(presence.dockedAtStation)} station · ${number(presence.dockedAtStructure)} structure · ${number(presence.connectedLocationUnknown)} location unknown`, "green"],
    ["HUMAN PILOTS ONLINE", number(roster.connectedHumans), `${number(roster.humansInSpace)} in space · ${number(data.activity?.humanFleetMembers)} in fleets`, "violet"],
    ["ACTIVE PILOT WORK", number(data.operations?.activeWork ?? data.operations?.active), `Across all ${number(roster.total)} pilots, including docked · ${number(data.operations?.withoutActiveWork ?? data.operations?.withoutActiveRecord)} have no active operation or production cycle now`, "amber"],
    ["PI SETUPS QUEUED", number(data.operations?.queuedColonySetups), `${number(data.operations?.queuedColonySetupsWithoutActiveWork)} are waiting without other active work; queued setups are not counted as active`, "violet"],
  ];
  $("metrics").innerHTML = metricRows.map(([label, value, detail, color]) => `
    <article class="metric ${color}"><div class="metric-label">${escapeHTML(label)}</div><div class="metric-value">${escapeHTML(value)}</div><div class="metric-detail">${escapeHTML(detail)}</div></article>`).join("");

  const specialties = Object.entries(roster.bySpecialty || {}).sort(([a], [b]) => a.localeCompare(b));
  $("specialties").innerHTML = specialties.length ? specialties.map(([name, count]) => `
    <div class="specialty-row"><span class="specialty-mark">${escapeHTML(name.slice(0, 1).toUpperCase())}</span><div class="specialty-name">${escapeHTML(name)}</div><div class="specialty-bar"><i style="width:${Math.max(3, Math.round(count * 100 / Math.max(1, roster.total)))}%"></i></div><strong>${number(count)}</strong></div>`).join("") : `<div class="empty">No playerbots have been seeded.</div>`;

  const operationKinds = Object.entries(data.operations?.activeWorkByKind || data.operations?.byKind || {}).sort((a, b) => b[1] - a[1]);
  $("operation-summary").innerHTML = operationKinds.length ? operationKinds.map(([kind, count]) => `
    <div class="operation-kind"><span class="kind-dot ${escapeHTML(kind)}"></span><span>${escapeHTML(kind.replaceAll("-", " "))}</span><strong>${number(count)}</strong></div>`).join("") : `<div class="empty">No active work is recorded.</div>`;

  const systems = data.systems || [];
  const maxSystemBots = Math.max(1, ...systems.map((entry) => Number(entry.botCount) || 0));
  $("top-systems").innerHTML = systems.slice(0, 8).map((system) => `
    <tr><td><strong>${escapeHTML(system.systemName)}</strong></td><td class="mono">${number(system.systemID)}</td><td class="numeric">${number(system.botCount)}</td><td><div class="mini-bar"><i style="width:${Math.max(2, Math.round(system.botCount * 100 / maxSystemBots))}%"></i></div></td></tr>`).join("") || `<tr><td colspan="4" class="empty">No system locations are available.</td></tr>`;

  renderCorporations(data.corporations || []);
  renderSystems(systems, roster.total || 0);
  renderOperations(data);
  renderTerritory(data);
  const generated = new Date(data.generatedAt);
  $("updated-at").textContent = `Updated ${Number.isNaN(generated.getTime()) ? "just now" : generated.toLocaleTimeString()}`;
  $("connection-state").textContent = "Connected to EveJS";
  $("server-status").textContent = `Online · ${number(data.process?.uptimeSeconds)}s uptime`;
  $("alert").classList.add("hidden");
}

function renderTerritory(data) {
  const activity = data.activity || {};
  const territory = data.territory || {};
  const metrics = [
    ["ACTIVE FLEETS", number(activity.fleets), `${number(activity.fleetMembers)} total members`, "cyan"],
    ["ACTIVE WARS", number(activity.activeWars), `${number((territory.wars || []).length)} shown`, "red"],
    ["UPWELL STRUCTURES", number(activity.structures), `${number(activity.lowPowerStructures)} low power`, "amber"],
    ["SOVEREIGN SYSTEMS", number(activity.claimedSystems), `${number(activity.structuresMissingQuantumCore)} structures missing a core`, "violet"],
  ];
  $("territory-metrics").innerHTML = metrics.map(([label, value, detail, color]) => `
    <article class="metric ${color}"><div class="metric-label">${escapeHTML(label)}</div><div class="metric-value">${escapeHTML(value)}</div><div class="metric-detail">${escapeHTML(detail)}</div></article>`).join("");

  const fleets = territory.fleets || [];
  $("fleet-count").textContent = `${number(activity.fleets)} active fleets · showing ${number(fleets.length)}`;
  $("fleet-rows").innerHTML = fleets.map((fleet) => `<tr><td><strong>${escapeHTML(fleet.name)}</strong></td><td class="mono">${number(fleet.fleetID)}</td><td class="numeric">${number(fleet.memberCount)}</td><td class="numeric">${number(fleet.botMembers)}</td><td class="numeric">${number(fleet.humanMembers)}</td><td class="mono">${fleet.solarSystemID ? number(fleet.solarSystemID) : "—"}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No active fleets are recorded.</td></tr>`;

  const wars = territory.wars || [];
  $("war-count").textContent = `${number(activity.activeWars)} active or ending wars · showing ${number(wars.length)}`;
  $("war-rows").innerHTML = wars.map((war) => `<tr><td class="mono">${number(war.warID)}</td><td><strong>${escapeHTML(war.declaredByName)}</strong><small class="mono">${number(war.declaredByID)}</small></td><td><strong>${escapeHTML(war.againstName)}</strong><small class="mono">${number(war.againstID)}</small></td><td><span class="state-tag ${escapeHTML(war.status)}">${escapeHTML(war.status)}</span></td><td>${war.mutual ? "Mutual" : "Declared"}</td><td class="mono">${war.warHQID ? number(war.warHQID) : "—"}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No wars are recorded.</td></tr>`;

  const structures = territory.structures || [];
  $("structure-count").textContent = `${number(activity.structures)} structures · ${number(activity.lowPowerStructures)} low power · showing ${number(structures.length)}`;
  $("structure-rows").innerHTML = structures.map((structure) => `<tr><td><strong>${escapeHTML(structure.name)}</strong></td><td class="mono">${number(structure.structureID)}</td><td>${escapeHTML(structure.solarSystemName || "—")}<small class="mono">${number(structure.solarSystemID)}</small></td><td class="mono">${number(structure.ownerCorpID)}</td><td><span class="state-tag ${structure.upkeep === "full_power" ? "online" : structure.upkeep === "low_power" ? "holding" : "failed"}">${escapeHTML(structure.upkeep.replaceAll("_", " "))}</span></td><td>${structure.hasQuantumCore ? "Installed" : "Missing"}</td><td>${escapeHTML(structure.state.replaceAll("_", " "))}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">No Upwell structures are recorded.</td></tr>`;

  const systems = territory.sovereignty || [];
  $("sovereignty-count").textContent = `${number(activity.claimedSystems)} claimed systems · showing ${number(systems.length)}`;
  $("sovereignty-rows").innerHTML = systems.map((system) => `<tr><td><strong>${escapeHTML(system.solarSystemName)}</strong></td><td class="mono">${number(system.solarSystemID)}</td><td>${escapeHTML(system.allianceName)}</td><td class="mono">${number(system.allianceID)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No player sovereignty claims are recorded.</td></tr>`;
}

function renderCorporations(corporations) {
  const sorted = [...corporations].sort((a, b) => b.botCount - a.botCount || a.corporationName.localeCompare(b.corporationName));
  $("corporation-count").textContent = `${number(sorted.length)} corporations · ${number(sorted.reduce((sum, corporation) => sum + corporation.botCount, 0))} bots`;
  $("corporation-rows").innerHTML = sorted.map((corporation) => {
    const limit = Number(corporation.memberLimit) || 0;
    const members = Number(corporation.memberCount) || 0;
    const used = limit > 0 ? Math.min(100, Math.round(members * 100 / limit)) : 0;
    return `<tr><td><strong>${escapeHTML(corporation.corporationName)}</strong><small>${escapeHTML(corporation.ticker)}</small></td><td class="mono">${number(corporation.corporationID)}</td><td class="mono">${corporation.allianceID ? number(corporation.allianceID) : "—"}</td><td>${(corporation.specialties || []).map((value) => `<span class="tag">${escapeHTML(value)}</span>`).join(" ")}</td><td class="numeric">${number(corporation.botCount)}</td><td class="numeric">${number(members)} / ${limit ? number(limit) : "unlimited"}</td><td>${limit ? `<div class="capacity"><div class="mini-bar"><i style="width:${used}%"></i></div><small>${used}%</small></div>` : `<span class="muted">Not set</span>`}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">No corporations are represented.</td></tr>`;
}

function renderSystems(systems, totalPilots) {
  const sorted = [...systems].sort((a, b) => b.botCount - a.botCount || a.systemID - b.systemID);
  $("system-count").textContent = `${number(sorted.length)} occupied solar systems`;
  $("system-rows").innerHTML = sorted.map((system) => `
    <tr><td><strong>${escapeHTML(system.systemName)}</strong></td><td class="mono">${number(system.systemID)}</td><td class="numeric">${number(system.botCount)}</td><td>${percent(system.botCount, totalPilots)} <div class="mini-bar inline"><i style="width:${Math.max(2, Math.round(system.botCount * 100 / Math.max(1, totalPilots)))}%"></i></div></td></tr>`).join("") || `<tr><td colspan="4" class="empty">No system locations are available.</td></tr>`;
}

function renderOperations(data) {
  const work = data.work || {};
  const director = work.director || {};
  const currentCycle = work.currentCycle || null;
  const expectedBots = Number(currentCycle?.expectedBots || work.cycleExpectedBots) || 0;
  const completedBots = Number(currentCycle?.completedBots || work.cycleCompletedBots) || 0;
  const cycleElapsedMs = currentCycle ? currentCycle.elapsedMs : work.cycleElapsedMs;
  const active = Number(data.operations?.active) || 0;
  const holding = Number(data.operations?.byStatus?.holding) || 0;
  const metrics = [
    ["ACTIVE PILOT WORK", number(data.operations?.activeWork ?? active), `${number(holding)} holding · includes ${number(data.operations?.activeIndustryCycles)} active industry cycles`],
    ["PILOTS WITHOUT ACTIVE WORK", number(data.operations?.withoutActiveWork ?? data.operations?.withoutActiveRecord), `${number(data.operations?.queuedColonySetupsWithoutActiveWork)} are explicitly queued for PI setup; the rest need an available assignment`],
    ["PI SETUPS QUEUED", number(data.operations?.queuedColonySetups), `${number(data.operations?.queuedColonySetupsWithoutActiveWork)} are waiting without other active work; queue is separate from active work`],
    ["NEW DIRECTOR ASSIGNMENTS", number(director.assigned), "durable operations started in the last completed cycle"],
    ["ADD-ON STEP FAILURES", number(work.addonFailedBots), "pilot steps that failed; separate from director assignment failures"],
    ["DIRECTOR FAILURES", number(director.failures), "failed assignment starts; add-on step failures are not included"],
    [currentCycle ? "CURRENT CYCLE ELAPSED" : "LAST CYCLE ELAPSED", formatDuration(cycleElapsedMs), currentCycle
      ? `${number(completedBots)} / ${number(expectedBots)} pilot steps complete · live wall time`
      : `${number(completedBots)} / ${number(expectedBots)} pilot steps succeeded · accumulated pilot work ${formatDuration(work.cyclePilotWorkMs)}`],
  ];
  $("work-metrics").innerHTML = metrics.map(([label, value, detail], index) => `
    <article class="metric ${["cyan", "amber", "violet", "cyan", "red", "red", "violet"][index]}"><div class="metric-label">${escapeHTML(label)}</div><div class="metric-value">${escapeHTML(value)}</div><div class="metric-detail">${escapeHTML(detail)}</div></article>`).join("");
  const failureRows = Array.isArray(work.addonFailures) ? work.addonFailures : [];
  const failureSummary = failureRows.map((failure) => `${failure.characterName || `Pilot ${failure.characterID}`} (${number(failure.characterID)}): ${failure.message}`).join(" · ");
  const errorDetails = [failureSummary, work.directorError ? `Director: ${work.directorError}` : ""].filter(Boolean);
  const failurePanel = $("work-failures");
  if (errorDetails.length) {
    failurePanel.textContent = errorDetails.join(" · ");
    failurePanel.classList.remove("hidden");
  } else {
    failurePanel.textContent = "";
    failurePanel.classList.add("hidden");
  }
}

function activityLocation(bot) {
  if (bot.inSpace) return `In space · ${bot.solarSystemName || "Unknown system"} [${number(bot.solarSystemID)}]`;
  if (bot.stationID) return `Docked at station ${number(bot.stationID)}`;
  if (bot.structureID) return `Docked at structure ${number(bot.structureID)}`;
  if (bot.connected) return `Online · location unknown${bot.solarSystemID ? ` · system ${number(bot.solarSystemID)}` : ""}`;
  return bot.solarSystemID ? `Offline · last system ${bot.solarSystemName || "Unknown"} [${number(bot.solarSystemID)}]` : "Offline · location unknown";
}

async function loadPilotActivity(force = false) {
  if (!force && Date.now() - state.activityLoadedAt < ACTIVITY_REFRESH_MS) return;
  const requestID = ++state.activityRequestID;
  const query = new URLSearchParams({ offset: String(state.activityPage * state.activityPageSize), limit: String(state.activityPageSize) });
  const search = $("activity-search").value.trim();
  if (search) query.set("search", search);
  try {
    const data = await getJSON(`/api/bots?${query}`);
    if (requestID !== state.activityRequestID) return;
    state.activityLoadedAt = Date.now();
    state.activityTotal = Number(data.total) || 0;
    const pages = Math.max(1, Math.ceil(state.activityTotal / state.activityPageSize));
    if (state.activityPage >= pages) {
      state.activityPage = pages - 1;
      return loadPilotActivity(true);
    }
    const summary = state.snapshot || {};
    const roster = summary.roster || {};
    const presence = roster.presence || roster;
    const activeTasks = Number((summary.work?.taskStatuses || {}).queued || 0) + Number((summary.work?.taskStatuses || {}).leased || 0);
    $("activity-count").textContent = `${number(data.total)} pilots · page ${number(state.activityPage + 1)} of ${number(pages)}`;
    $("activity-summary").textContent = `${number(roster.online)} online (${number(roster.inSpace)} in space, ${number(presence.dockedAtStation)} in stations, ${number(presence.dockedAtStructure)} in structures, ${number(presence.connectedLocationUnknown)} location unknown) · ${number(presence.offline)} offline · ${number(summary.operations?.activeWork ?? summary.operations?.active)} pilots doing active work · ${number(summary.operations?.queuedColonySetups)} PI setups queued (${number(summary.operations?.queuedColonySetupsWithoutActiveWork)} without other active work) · ${number(activeTasks)} queued/leased tasks across the full roster.`;
    $("activity-page").textContent = `Page ${number(state.activityPage + 1)} of ${number(pages)}`;
    $("activity-prev").disabled = state.activityPage <= 0;
    $("activity-next").disabled = state.activityPage + 1 >= pages;
    $("activity-rows").innerHTML = (data.rows || []).map((bot) => {
      const operation = bot.operation;
      const isActiveOperation = operation && ["active", "holding", "review"].includes(String(operation.status).toLowerCase());
      const operationText = isActiveOperation
        ? `${operation.kind} · ${operation.status}${operation.stage ? ` · ${operation.stage}` : ""}`
        : bot.queuedWork ? "Queued · PI colony setup"
          : operation ? `No active work · last ${operation.status} ${operation.kind}` : "No operation record or active production cycle";
      const operationDetail = isActiveOperation ? operation.lastAction
        : bot.queuedWork?.reason || (operation?.updatedAt ? `Updated ${new Date(operation.updatedAt).toLocaleString()}` : "");
      const taskRows = Array.isArray(bot.tasks) ? bot.tasks : [];
      const taskDetails = taskRows.map((task) => `${task.kind} · ${task.status}${task.stage ? ` · ${task.stage}` : ""}`);
      if (bot.queuedWork && isActiveOperation) taskDetails.unshift(`PI setup queued · ${bot.queuedWork.reason}`);
      const tasksText = taskDetails.join("; ") || "No queued or leased task";
      const presenceTag = bot.connected ? "online" : "offline";
      return `<tr><td><div class="pilot-identity">${pilotPortrait(bot.characterID, bot.characterName)}<span><strong>${escapeHTML(bot.characterName)}</strong><small class="mono">${number(bot.characterID)}</small></span></div></td><td>${escapeHTML(bot.corporationName || "—")}<small class="mono">${number(bot.corporationID)}</small></td><td><span class="state-tag ${presenceTag}">${presenceTag}</span><small>${escapeHTML(activityLocation(bot))}</small></td><td><span class="tag">${escapeHTML(bot.specialty)}</span></td><td><strong>${escapeHTML(operationText)}</strong><small>${escapeHTML(operationDetail)}</small></td><td>${escapeHTML(tasksText)}${taskRows.map((task) => `<small class="mono">${escapeHTML(task.taskID)}</small>`).join("")}</td></tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">No pilots match this search.</td></tr>`;
  } catch (error) { setError(error); }
}

async function loadOperations(force = false) {
  if (!force && Date.now() - state.operationsLoadedAt < OPERATIONS_REFRESH_MS) return;
  const requestID = ++state.operationRequestID;
  const query = new URLSearchParams({ offset: String(state.operationPage * state.operationPageSize), limit: String(state.operationPageSize) });
  const status = $("operation-status").value;
  const kind = $("operation-kind").value;
  const search = $("operation-search").value.trim();
  if (status) query.set("status", status);
  if (kind) query.set("kind", kind);
  if (search) query.set("search", search);
  try {
    const data = await getJSON(`/api/operations?${query}`);
    if (requestID !== state.operationRequestID) return;
    state.operationsLoadedAt = Date.now();
    state.totalOperations = Number(data.total) || 0;
    const rows = data.rows || [];
    const pages = Math.max(1, Math.ceil(state.totalOperations / state.operationPageSize));
    if (state.operationPage >= pages) {
      state.operationPage = pages - 1;
      return loadOperations(true);
    }
    const active = Number(data.counts?.active) + Number(data.counts?.holding) || 0;
    $("operation-count").textContent = `${number(state.totalOperations)} matching records · ${number(active)} active · ${number(rows.length)} shown`;
    $("operation-page-input").value = String(state.operationPage + 1);
    $("operation-page-input").max = String(pages);
    $("operation-page-count").textContent = number(pages);
    $("operation-first").disabled = state.operationPage <= 0;
    $("operation-prev").disabled = state.operationPage <= 0;
    $("operation-next").disabled = state.operationPage + 1 >= pages;
    $("operation-last").disabled = state.operationPage + 1 >= pages;
    replaceOptions($("operation-status"), "All statuses", data.counts || {});
    replaceOptions($("operation-kind"), "All operation types", data.kindCounts || {});
    $("operation-rows").innerHTML = rows.map((operation) => {
      const location = operation.systemID ? number(operation.systemID) : "—";
      const planet = operation.planetID ? `<small>Planet ${number(operation.planetID)}</small>` : "";
      const ship = operation.shipTypeID ? number(operation.shipTypeID) : "—";
      const spent = Number(operation.spent) || 0;
      const proceeds = Number(operation.proceeds) || 0;
      const financial = spent || proceeds ? `${spent ? `−${number(spent.toFixed(0))}` : ""}${spent && proceeds ? " / " : ""}${proceeds ? `+${number(proceeds.toFixed(0))}` : ""} ISK` : "—";
      const name = operation.characterName || `Pilot ${operation.characterID}`;
      return `<tr><td><strong>${escapeHTML(name)}</strong><small class="mono">${number(operation.characterID)}</small></td><td class="mono">${operation.corporationID ? number(operation.corporationID) : "—"}</td><td><strong>${escapeHTML(operation.kind)}</strong><small class="mono">${escapeHTML(operation.operationID)}</small></td><td><span class="state-tag ${escapeHTML(operation.status)}">${escapeHTML(operation.status)}</span></td><td>${escapeHTML(operation.stage || "—")}</td><td class="mono">${location}${planet}</td><td class="mono">${ship}</td><td>${escapeHTML(operation.updatedAt ? new Date(operation.updatedAt).toLocaleString() : "—")}</td><td class="last-action">${escapeHTML(operation.lastAction || operation.lastError || "—")}</td><td class="financial">${escapeHTML(financial)}</td><td><button class="operation-details" data-operation-id="${escapeHTML(operation.operationID)}" type="button">Details</button></td></tr>`;
    }).join("") || `<tr><td colspan="11" class="empty">No operations match these filters.</td></tr>`;
  } catch (error) { if (requestID === state.operationRequestID) setError(error); }
}

function goToOperationPage(value) {
  const pages = Math.max(1, Math.ceil(state.totalOperations / state.operationPageSize));
  const requested = Math.trunc(Number(value));
  state.operationPage = Number.isFinite(requested) ? Math.max(0, Math.min(pages - 1, requested - 1)) : 0;
  void loadOperations(true);
}

function replaceOptions(select, allLabel, counts) {
  const current = select.value;
  const options = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  select.innerHTML = `<option value="">${escapeHTML(allLabel)}</option>${options.map(([value, count]) => `<option value="${escapeHTML(value)}">${escapeHTML(value.replaceAll("-", " "))} (${number(count)})</option>`).join("")}`;
  select.value = options.some(([value]) => value === current) ? current : "";
}

function formatDetailValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

async function showOperationDetails(operationID) {
  try {
    const data = await getJSON(`/api/operation?operationID=${encodeURIComponent(operationID)}`);
    const operation = data.operation || {};
    $("operation-dialog-title").textContent = `${operation.kind || "Operation"} · ${operation.operationID || operationID}`;
    const fields = Object.keys(operation).filter((key) => key !== "history" && !key.startsWith("_") && operation[key] !== undefined);
    const detailRows = fields.map((key) => `<div class="detail-row"><span>${escapeHTML(key.replace(/([A-Z])/g, " $1"))}</span><strong>${escapeHTML(formatDetailValue(operation[key]))}</strong></div>`).join("");
    const history = Array.isArray(operation.history) ? operation.history : [];
    const historyRows = history.map((entry) => `<li><time>${escapeHTML(entry.at ? new Date(entry.at).toLocaleString() : "")}</time><strong>${escapeHTML(entry.stage || "")}</strong><span>${escapeHTML(entry.message || "")}</span></li>`).join("");
    $("operation-dialog-content").innerHTML = `<div class="detail-grid">${detailRows || `<div class="empty">No additional details are available.</div>`}</div><section class="history-section"><div class="eyebrow">RECENT STEPS · ${number(history.length)}</div><ol>${historyRows || `<li class="empty">No step history was recorded.</li>`}</ol></section>`;
    $("operation-dialog").showModal();
  } catch (error) { setError(error); }
}

function millisecondsFieldToSeconds(settings, key) { return Math.round(Number(settings[key]) / 1000); }
function millisecondsFieldToHours(settings, key) { return Number((Number(settings[key]) / 3_600_000).toPrecision(8)); }

// Form field values for a settings object (durations shown in the units the
// form uses).
function settingsFormValues(settings) {
  return {
      rosterTarget: settings.rosterTarget,
      rosterCeiling: settings.rosterCeiling,
      maxOnline: settings.maxOnline,
      connectionWindowHours: millisecondsFieldToHours(settings, "connectionWindowMs"),
      maxPerSystem: settings.maxPerSystem,
      maxConcurrentWork: settings.maxConcurrentWork,
      maxConcurrentRelocations: settings.maxConcurrentRelocations,
      maxConcurrentColonySetups: settings.maxConcurrentColonySetups,
      directorThinkMinSeconds: millisecondsFieldToSeconds(settings, "directorThinkMinMs"),
      directorThinkMaxSeconds: millisecondsFieldToSeconds(settings, "directorThinkMaxMs"),
      directorInitialSpreadSeconds: millisecondsFieldToSeconds(settings, "directorInitialSpreadMs"),
      directorSliceBudgetMs: settings.directorSliceBudgetMs,
      addonConcurrency: settings.addonConcurrency,
      addonCycleIntervalSeconds: millisecondsFieldToSeconds(settings, "addonCycleIntervalMs"),
      addonBotDelayMs: settings.addonBotDelayMs,
      addonRequestTimeoutSeconds: millisecondsFieldToSeconds(settings, "addonRequestTimeoutMs"),
      rosterSeedBatchSize: settings.rosterSeedBatchSize,
      rosterSeedIntervalSeconds: millisecondsFieldToSeconds(settings, "rosterSeedIntervalMs"),
      rosterSeedMaxEventLoopP95Ms: settings.rosterSeedMaxEventLoopP95Ms,
      rosterSeedMaxProcessCpuPercent: settings.rosterSeedMaxProcessCpuPercent,
      rosterSeedMaximumSingleBotMs: settings.rosterSeedMaximumSingleBotMs,
  };
}

function fillSettingsForm(settings) {
  const form = $("settings-form");
  for (const [key, value] of Object.entries(settingsFormValues(settings))) form.elements.namedItem(key).value = String(value ?? "");
  form.elements.namedItem("autoworkEnabled").checked = settings.autoworkEnabled === true;
  form.elements.namedItem("rosterSeedEnabled").checked = settings.rosterSeedEnabled === true;
}

// Writes "Default: …" under every field, from the server's defaults.
function showSettingDefaults(defaults) {
  if (!defaults) return;
  const form = $("settings-form");
  const values = settingsFormValues(defaults);
  values.autoworkEnabled = defaults.autoworkEnabled ? "on" : "off";
  values.rosterSeedEnabled = defaults.rosterSeedEnabled ? "on" : "off";
  for (const [key, value] of Object.entries(values)) {
    const field = form.elements.namedItem(key);
    const label = field && field.closest("label");
    if (!label) continue;
    let hint = label.querySelector(".default-hint");
    if (!hint) {
      hint = document.createElement("small");
      hint.className = "default-hint";
      label.appendChild(hint);
    }
    hint.textContent = `Default: ${value}`;
  }
}

let settingDefaults = null;

async function loadSettings() {
  try {
    const [data, seedStatus] = await Promise.all([
      getJSON("/api/settings"),
      getJSON("/api/seed-status"),
    ]);
    const settings = data.settings || {};
    settingDefaults = settings.defaults || null;
    fillSettingsForm(settings);
    showSettingDefaults(settingDefaults);
    const roster = state.snapshot?.roster || {};
    $("settings-metrics").innerHTML = [
      ["BOT ROSTER", `${number(roster.total)} / ${number(settings.rosterTarget)}`, "created / configured target", "cyan"],
      ["ONLINE LIMIT", number(settings.maxOnline), `hard maximum ${number(settings.maximums?.online)}`, "green"],
      ["SYSTEM LIMIT", number(settings.maxPerSystem), `hard maximum ${number(settings.maximums?.perSystem)}`, "violet"],
      ["AUTOWORK", data.effectiveAutoworkEnabled ? "Enabled" : "Paused", settings.autoworkEnabled ? "configured enabled" : "configured paused", data.effectiveAutoworkEnabled ? "amber" : "red"],
      ["ROSTER SEED", seedStatus.running ? "Batch in progress" : seedStatus.enabled ? "Enabled" : "Paused", `${number(roster.total)} / ${number(settings.rosterTarget)} pilots · safety caps ${number(seedStatus.eventLoopSafetyLimitMs)} ms p95 / ${number(seedStatus.processCpuSafetyLimitPercent)}% CPU`, seedStatus.enabled ? "green" : "violet"],
    ].map(([label, value, detail, color]) => `<article class="metric ${color}"><div class="metric-label">${escapeHTML(label)}</div><div class="metric-value">${escapeHTML(value)}</div><div class="metric-detail">${escapeHTML(detail)}</div></article>`).join("");
    const lastBatch = seedStatus.lastBatch;
    $("seed-state").textContent = seedStatus.running ? "Batch in progress" : seedStatus.enabled ? "Seeder enabled" : "Seeder paused";
    $("seed-progress").textContent = `${number(lastBatch?.rosterCount ?? roster.total)} / ${number(lastBatch?.target ?? settings.rosterTarget)} pilots · loop p95 ${Number(seedStatus.eventLoopP95Ms || lastBatch?.eventLoopP95Ms || 0).toFixed(1)} / ${number(seedStatus.eventLoopSafetyLimitMs)} ms · EveJS CPU ${Number(seedStatus.processCpuPercent || lastBatch?.processCpuPercent || 0).toFixed(1)} / ${number(seedStatus.processCpuSafetyLimitPercent)}% · ${seedStatus.loadTelemetryReady ? "load guard ready" : "waiting for load samples"} · work concurrency ${number(seedStatus.effectiveStepConcurrency)}/${number(seedStatus.configuredStepConcurrency)}`;
    $("seed-last-batch").textContent = lastBatch
      ? `Last batch ${lastBatch.created ? `created ${number(lastBatch.created)}` : "created no pilots"}${lastBatch.batchDurationMs ? ` in ${number(lastBatch.batchDurationMs)} ms` : ""}${lastBatch.backpressure ? ` · backed off: ${lastBatch.stopReason || "server load"}` : ""} · ${new Date(lastBatch.at).toLocaleString()}`
      : "No seed batch has run. Seeding waits for two load samples and pauses at its hard event-loop or CPU safety caps.";
    $("settings-updated").textContent = settings.updatedAt ? `Saved ${new Date(settings.updatedAt).toLocaleString()}` : "Showing environment defaults; save to persist dashboard settings";
    $("settings-alert").classList.add("hidden");
  } catch (error) {
    $("settings-alert").textContent = error.message || String(error);
    $("settings-alert").classList.remove("hidden");
  }
}

function isk(value) {
  const amount = Number(value) || 0;
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ISK`;
}

function shipImage(typeID, size = 56) {
  const id = Math.trunc(Number(typeID));
  if (!Number.isSafeInteger(id) || id <= 0) return "";
  const renderSize = [32, 64, 128, 256, 512].includes(Number(size)) ? Number(size) : 64;
  return `<img class="kill-ship-icon" src="/api/ship-render?typeID=${id}&amp;size=${renderSize}" alt="" loading="lazy" onerror="this.hidden=true">`;
}

function killCategory(category) {
  const normalized = String(category || "other").toLowerCase();
  const label = ({ playerbot: "Playerbot", player: "Capsuleer", npc: "NPC / pirate", structure: "Structure", other: "Unknown" })[normalized] || "Unknown";
  return `<span class="kill-category ${escapeHTML(normalized)}">${label}</span>`;
}

async function loadKillboard(force = false) {
  if (!force && Date.now() - state.killboardLoadedAt < 30_000) return;
  try {
    const data = await getJSON("/api/kills");
    state.killboardLoadedAt = Date.now();
    const metrics = [
      ["TOTAL KILLMAILS", data.total, "All recorded combat"],
      ["NPC / PIRATE LOSSES", data.npcDeaths, "NPC corporation or faction victims"],
      ["PLAYERBOT LOSSES", data.playerbotDeaths, "Victims in the playerbot roster"],
      ["CAPSULEER LOSSES", data.playerDeaths, "Known or non-NPC player characters"],
      ["PLAYERBOT FINAL BLOWS", data.playerbotFinalBlows, "Final blow by a playerbot"],
      ["NPC / PIRATE FINAL BLOWS", data.npcFinalBlows, "Final blow attributed to an NPC side"],
      ["KILLS · 24H", data.day, "Last 24 hours"],
      ["KILLS · 7D", data.week, "Last seven days"],
      ["POD LOSSES", data.pods, "Capsule victims"],
    ];
    $("kill-metrics").innerHTML = metrics.map(([label, value, detail]) => `<article class="metric cyan"><div class="metric-label">${escapeHTML(label)}</div><div class="metric-value">${number(value)}</div><div class="metric-detail">${escapeHTML(detail)}</div></article>`).join("");
    const recent = Array.isArray(data.recent) ? data.recent : [];
    $("kill-recent-count").textContent = `${number(data.total)} killmails · showing ${number(recent.length)} latest · NPCs may fly standard capsuleer hulls`;
    const sideDetails = (corporationName, corporationID, factionName, factionID) => [
      corporationName && corporationID ? `${corporationName} (${number(corporationID)})` : corporationName || (corporationID ? `Corp ${number(corporationID)}` : ""),
      factionName && factionID ? `${factionName} (${number(factionID)})` : factionName || (factionID ? `Faction ${number(factionID)}` : ""),
    ].filter(Boolean).join(" · ");
    $("kill-recent-rows").innerHTML = recent.map((kill) => {
      const victimContext = sideDetails(kill.victimCorporationName, kill.victimCorporationID, kill.victimFactionName, kill.victimFactionID);
      const finalContext = sideDetails(kill.finalCorporationName, kill.finalCorporationID, kill.finalFactionName, kill.finalFactionID);
      return `<tr><td>${escapeHTML(kill.time ? new Date(kill.time).toLocaleString() : "—")}</td><td><strong>${escapeHTML(kill.victimName)}</strong><small class="mono">${kill.victimCharacterID ? `Character ${number(kill.victimCharacterID)}` : kill.victimCategory === "npc" ? "NPC entity" : "No character ID"}</small><small>${escapeHTML(victimContext)}</small></td><td>${killCategory(kill.victimCategory)}</td><td class="kill-ship-cell">${shipImage(kill.victimShipTypeID)}<span>${escapeHTML(kill.victimShipName)}<small>Hull type; not pilot identity</small></span></td><td>${escapeHTML(kill.systemName)}<small class="mono">${number(kill.solarSystemID)}</small></td><td>${killCategory(kill.finalCategory)}<strong>${escapeHTML(kill.finalName)}</strong><small class="mono">${kill.finalCharacterID ? `Character ${number(kill.finalCharacterID)}` : kill.finalCategory === "npc" ? "NPC entity" : "No character ID"}</small><small>${escapeHTML(finalContext)}</small></td><td class="numeric">${escapeHTML(isk(kill.iskLost))}</td></tr>`;
    }).join("") || `<tr><td colspan="7" class="empty">No killmails have been recorded.</td></tr>`;
    const pilots = Array.isArray(data.pilots) ? data.pilots : [];
    $("kill-pilot-rows").innerHTML = pilots.map((pilot) => `<tr><td><div class="pilot-identity">${pilotPortrait(pilot.characterID, pilot.name)}<span><strong>${escapeHTML(pilot.name)}</strong><small class="mono">${number(pilot.characterID)}</small></span></div></td><td class="numeric">${number(pilot.kills)}</td><td class="numeric">${number(pilot.losses)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No playerbot killmails yet.</td></tr>`;
    const corporations = Array.isArray(data.corporations) ? data.corporations : [];
    $("kill-corporation-rows").innerHTML = corporations.map((corp) => `<tr><td><strong>${escapeHTML(corp.name)}</strong><small class="mono">${number(corp.corporationID)}</small></td><td class="numeric">${number(corp.kills)}</td><td class="numeric">${number(corp.npcKills)}</td><td class="numeric">${number(corp.losses)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No corporation combat record yet.</td></tr>`;
    const ships = Array.isArray(data.ships) ? data.ships : [];
    $("kill-ship-rows").innerHTML = ships.map((ship) => `<tr><td class="kill-ship-cell">${shipImage(ship.typeID)}<span>${escapeHTML(ship.name)}</span></td><td class="numeric">${number(ship.lost)}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">No ship losses recorded.</td></tr>`;
  } catch (error) { setError(error); }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = $("settings-form");
  const body = {};
  for (const key of ["rosterTarget", "rosterCeiling", "maxOnline", "maxPerSystem", "maxConcurrentWork", "maxConcurrentRelocations", "maxConcurrentColonySetups", "addonConcurrency", "addonBotDelayMs", "directorSliceBudgetMs", "rosterSeedBatchSize", "rosterSeedMaxEventLoopP95Ms", "rosterSeedMaxProcessCpuPercent", "rosterSeedMaximumSingleBotMs"]) {
    body[key] = Number(form.elements.namedItem(key).value);
  }
  body.connectionWindowMs = Math.round(Number(form.elements.namedItem("connectionWindowHours").value) * 3_600_000);
  body.directorThinkMinMs = Number(form.elements.namedItem("directorThinkMinSeconds").value) * 1000;
  body.directorThinkMaxMs = Number(form.elements.namedItem("directorThinkMaxSeconds").value) * 1000;
  body.directorInitialSpreadMs = Number(form.elements.namedItem("directorInitialSpreadSeconds").value) * 1000;
  body.addonCycleIntervalMs = Number(form.elements.namedItem("addonCycleIntervalSeconds").value) * 1000;
  body.addonRequestTimeoutMs = Number(form.elements.namedItem("addonRequestTimeoutSeconds").value) * 1000;
  body.rosterSeedIntervalMs = Number(form.elements.namedItem("rosterSeedIntervalSeconds").value) * 1000;
  body.autoworkEnabled = form.elements.namedItem("autoworkEnabled").checked;
  body.rosterSeedEnabled = form.elements.namedItem("rosterSeedEnabled").checked;
  const button = $("save-settings");
  button.disabled = true;
  const alert = $("settings-alert");
  const show = (message) => { alert.textContent = message; alert.classList.remove("hidden"); };
  let requestError = null;
  try {
    const response = await fetch("/api/settings", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    // A 4xx answer is a refusal; the values were not saved.
    if (response.status >= 400 && response.status < 500) {
      show(data.error || `Settings were refused (${response.status}).`);
      return;
    }
    if (!response.ok) requestError = new Error(data.error || `Settings update failed (${response.status}).`);
  } catch (error) {
    requestError = error;
  }
  try {
    // A busy EveJS can apply the change after the request timed out, so
    // read the saved settings back and compare before reporting.
    if (requestError) show(`EveJS did not confirm the change in time (${requestError.message || requestError}). Checking whether it was saved…`);
    const pending = await confirmSettings(body, requestError ? 6 : 1);
    if (!pending.length) {
      $("settings-updated").textContent = `Saved and confirmed ${new Date().toLocaleString()}`;
      show(body.rosterSeedEnabled
        ? "Settings saved and confirmed. The separate add-on will seed bounded batches and back off automatically when EveJS is busy."
        : "Settings saved and confirmed. Gradual roster seeding is paused.");
    } else {
      show(`These settings are not saved yet: ${pending.join(", ")}. EveJS may still be busy; press Save settings again to retry.`);
    }
    await loadSettings();
  } catch (error) {
    show(`Could not read the settings back: ${error.message || error}. Press Save settings again to retry.`);
  } finally { button.disabled = false; }
}

// Names of submitted settings whose saved value differs, after up to
// `attempts` reads five seconds apart.
async function confirmSettings(body, attempts) {
  let pending = Object.keys(body);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 5_000));
    const data = await getJSON("/api/settings");
    const saved = data.settings || data;
    pending = Object.keys(body).filter((key) => saved[key] !== undefined && String(saved[key]) !== String(body[key]));
    if (!pending.length) return [];
  }
  return pending;
}

function milliseconds(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)} s` : `${ms.toFixed(ms >= 10 ? 0 : 1)} ms`;
}
function megabytes(bytes) { return `${number(Math.round(Number(bytes || 0) / 1_048_576))} MiB`; }
function cpuShare(value) { return value && Number.isFinite(Number(value.totalPercent)) ? `${Number(value.totalPercent).toFixed(0)}%` : "—"; }

function renderPerformance(data) {
  const loop = data.eventLoop || {};
  const current = loop.current || {};
  const recent = loop.recent || {};
  const cpu = data.cpu || {};
  const memory = data.memory || {};
  const gc = (data.gc && data.gc.recent) || {};
  const scene = data.scene || {};
  const guard = data.loadGuard || {};
  const loopState = String(loop.state || "unknown");
  const stateLabel = ({ healthy: "Healthy", constrained: "Constrained", degraded: "Degraded", overloaded: "Overloaded" })[loopState] || "Unknown";
  const stateColor = ({ healthy: "green", constrained: "amber", degraded: "amber", overloaded: "red" })[loopState] || "cyan";
  $("performance-state").textContent = `Event loop: ${stateLabel}`;
  const metricRows = [
    ["EVENT-LOOP DELAY P95", milliseconds(current.p95Ms), `${stateLabel} · longest ${milliseconds(current.maxMs)} in the last ${number(loop.windowSeconds)} s · last ${number(recent.windows)} samples peaked at ${milliseconds(recent.maxOfMaxMs)}`, stateColor],
    ["EVEJS CPU", cpuShare(cpu.process), `Main thread ${cpuShare(cpu.mainThread)} of one core · other threads ${cpu.offMainThreadPercent === null || cpu.offMainThreadPercent === undefined ? "—" : `${Number(cpu.offMainThreadPercent).toFixed(0)}%`} · host ${cpu.host?.busyPercent === null || cpu.host?.busyPercent === undefined ? "—" : `${Number(cpu.host.busyPercent).toFixed(0)}%`} busy across ${number(cpu.host?.logicalCpus)} CPUs`, "cyan"],
    ["MEMORY", megabytes(memory.rssBytes), `Heap ${megabytes(memory.heapUsedBytes)} of ${megabytes(memory.heapSizeLimitBytes)} limit (${Number(memory.heapUsedOfLimitPercent || 0).toFixed(0)}%) · garbage collection p95 ${milliseconds(gc.p95DurationMs)}, longest ${milliseconds(gc.maximumDurationMs)}`, "violet"],
    ["BOT SHIPS IN SPACE", number(scene.botsInSpace), `${number(scene.systemsWithBotsInSpace)} systems · ${number(scene.botsInUnobservedSystems)} in systems with no human pilot in space · ${number(scene.humansInSpace)} human pilots in space${scene.siteUpkeep && scene.siteUpkeep.intervalMs ? ` · site upkeep every ${milliseconds(scene.siteUpkeep.intervalMs)} in those systems (${number(scene.siteUpkeep.unobservedSkips)} passes skipped)` : ""}`, "amber"],
  ];
  $("performance-metrics").innerHTML = metricRows.map(([label, value, detail, color]) => `
    <article class="metric ${color}"><div class="metric-label">${escapeHTML(label)}</div><div class="metric-value">${escapeHTML(value)}</div><div class="metric-detail">${escapeHTML(detail)}</div></article>`).join("");

  const scheduler = data.scheduler || {};
  const queue = scheduler.queue || {};
  const lateness = scheduler.lateness || {};
  const scanned = Boolean(queue.byType);
  const types = [...new Set([...Object.keys(queue.byType || {}), ...Object.keys(lateness)])].sort();
  $("performance-queue-rows").innerHTML = types.map((type) => {
    const row = (queue.byType || {})[type] || {};
    const late = lateness[type] || {};
    return `<tr><td class="mono">${escapeHTML(type)}</td><td class="numeric">${scanned ? number(row.scheduled) : "—"}</td><td class="numeric">${scanned ? number(row.running) : "—"}</td><td class="numeric">${scanned ? number(row.due) : "—"}</td><td class="numeric">${escapeHTML(row.due ? milliseconds(row.oldestOverdueMs) : "—")}</td><td class="numeric">${escapeHTML(late.samples ? milliseconds(late.p95Ms) : "—")}</td><td class="numeric">${escapeHTML(late.samples ? milliseconds(late.maximumMs) : "—")}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">${escapeHTML(queue.error ? `Scheduler queue unavailable: ${queue.error}` : "No scheduled playerbot work has started since EveJS started.")}</td></tr>`;
  const dispatch = scheduler.dispatch;
  $("performance-queue-note").textContent = `${dispatch ? `${number(dispatch.active)} of ${number(dispatch.maxConcurrent)} dispatch slots in use, ${number(dispatch.queued)} waiting · ` : ""}Bot steps in parallel: ${number(guard.effectiveStepConcurrency)} of ${number(guard.configuredStepConcurrency)} configured${queue.sampleDurationMs !== undefined ? ` · queue scan took ${milliseconds(queue.sampleDurationMs)}` : ""}${queue.refreshing ? " · a new scan is still running; the previous one is shown" : ""}${queue.enabled === false ? " · queue counts are off (start delay is always measured)" : ""}`;

  const work = Object.entries(data.work || {})
    .sort((left, right) => Number(right[1].p95Ms || 0) - Number(left[1].p95Ms || 0))
    .slice(0, 25);
  $("performance-work-rows").innerHTML = work.map(([name, row]) => `<tr><td class="mono">${escapeHTML(name)}</td><td class="numeric">${number(row.samples)}</td><td class="numeric">${escapeHTML(milliseconds(row.averageMs))}</td><td class="numeric">${escapeHTML(milliseconds(row.p95Ms))}</td><td class="numeric">${escapeHTML(milliseconds(row.maximumMs))}</td><td class="numeric">${number(row.yields)}</td><td class="numeric">${escapeHTML(row.maximumSliceMs ? milliseconds(row.maximumSliceMs) : "—")}</td><td>${escapeHTML(row.lastAt ? new Date(row.lastAt).toLocaleTimeString() : "—")}</td></tr>`).join("") ||
    `<tr><td colspan="8" class="empty">No playerbot pass has been measured since EveJS started.</td></tr>`;

  const tick = data.spaceTick || {};
  const tickScheduler = tick.scheduler || {};
  $("performance-tick-note").textContent = tick.enabled === false
    ? "The stall watch is switched off."
    : `${number(tick.stalls)} of ${number(tick.ticks)} space ticks since EveJS started held the server for ${milliseconds(tick.thresholdMs)} or longer (${milliseconds(tick.stallMs)} in total, longest ${milliseconds(tick.longestMs)}). Tick timer: ${tickScheduler.mode || "unknown"}${tickScheduler.mode === "deadline" ? `, ${number(tickScheduler.missedPeriods)} slots skipped after late ticks` : ""}.`;
  $("performance-tick-rows").innerHTML = (tick.recent || []).map((row) => `<tr><td>${escapeHTML(String(row.at || "").slice(11, 19))}</td><td class="numeric">${escapeHTML(milliseconds(row.durationMs))}</td><td class="numeric">${escapeHTML(milliseconds(row.startedLateMs))}</td><td class="numeric">${number(row.scenesTicked)}</td><td class="numeric">${escapeHTML(milliseconds(row.outsideScenesMs))}</td><td class="mono">${escapeHTML((row.slowestScenes || []).map((scene) => `${scene.solarSystemID}: ${milliseconds(scene.workMs)} (${number(scene.botSessions)} bots, ${number(scene.humanSessions)} humans)`).join(" · "))}</td></tr>`).join("") ||
    `<tr><td colspan="6" class="empty">No long space tick has been recorded since EveJS started.</td></tr>`;
}

// Telemetry is requested only while the Performance page is open.
async function loadPerformance(force = false) {
  if (!force && Date.now() - state.performanceLoadedAt < PERFORMANCE_REFRESH_MS - 1_000) return;
  const alert = $("performance-alert");
  try {
    const data = await getJSON("/api/telemetry");
    state.performanceLoadedAt = Date.now();
    alert.classList.add("hidden");
    renderPerformance(data);
  } catch (error) {
    alert.textContent = `Performance telemetry is unavailable: ${error.message || error}`;
    alert.classList.remove("hidden");
    $("performance-state").textContent = "Telemetry unavailable";
  }
}

async function loadPilots() {
  const search = $("pilot-search").value.trim();
  const specialty = $("pilot-specialty").value;
  const corporationID = $("pilot-corporation").value.trim();
  const query = new URLSearchParams({ offset: String(state.page * PAGE_SIZE), limit: String(PAGE_SIZE) });
  if (search) query.set("search", search);
  if (specialty) query.set("specialty", specialty);
  if (corporationID) query.set("corporationID", corporationID);
  try {
    const data = await getJSON(`/api/bots?${query}`);
    state.totalPilots = data.total;
    const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    $("pilot-count").textContent = `${number(data.total)} matching pilots`;
    $("pilot-page").textContent = `Page ${state.page + 1} of ${pageCount}`;
    $("pilot-prev").disabled = state.page <= 0;
    $("pilot-next").disabled = (state.page + 1) * PAGE_SIZE >= data.total;
    $("pilot-rows").innerHTML = (data.rows || []).map((bot) => {
      const location = bot.inSpace ? `${bot.solarSystemName} [${number(bot.solarSystemID)}]` : bot.stationID ? `Station ${number(bot.stationID)}` : bot.structureID ? `Structure ${number(bot.structureID)}` : bot.solarSystemID ? `${bot.solarSystemName} [${number(bot.solarSystemID)}]` : "Unknown";
      const operation = bot.operation ? `${bot.operation.kind} · ${bot.operation.stage || bot.operation.status}` : "Idle";
      return `<tr><td><div class="pilot-identity">${pilotPortrait(bot.characterID, bot.characterName)}<span><strong>${escapeHTML(bot.characterName)}</strong><small class="mono">${number(bot.characterID)}</small></span></div></td><td><span class="tag">${escapeHTML(bot.specialty)}</span></td><td>${escapeHTML(bot.corporationName || "—")}<small class="mono">${number(bot.corporationID)}</small></td><td>${escapeHTML(location)}</td><td class="mono">${bot.shipTypeID ? number(bot.shipTypeID) : "—"}</td><td>${escapeHTML(operation)}</td><td><span class="state-tag ${bot.connected ? "online" : "offline"}">${bot.connected ? "online" : "offline"}${bot.paused ? " · paused" : ""}</span></td></tr>`;
    }).join("") || `<tr><td colspan="7" class="empty">No pilots match these filters.</td></tr>`;
  } catch (error) { setError(error); }
}

async function refresh() {
  try {
    const data = await getJSON("/api/summary");
    renderSummary(data);
    const specialties = Object.keys(data.roster?.bySpecialty || {}).sort();
    const select = $("pilot-specialty");
    const current = select.value;
    select.innerHTML = `<option value="">All specialties</option>${specialties.map((specialty) => `<option value="${escapeHTML(specialty)}">${escapeHTML(specialty)}</option>`).join("")}`;
    select.value = current;
    if (state.view === "pilots") await loadPilots();
    if (state.view === "operations") { await loadOperations(); await loadPilotActivity(); }
    if (state.view === "settings") await loadSettings();
    if (state.view === "killboard") await loadKillboard();
    if (state.view === "performance") await loadPerformance();
  } catch (error) { setError(error); }
}

document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  const view = link.dataset.view || "overview";
  history.replaceState(null, "", `#${view}`);
  setView(view);
}));
$("refresh").addEventListener("click", () => { state.operationsLoadedAt = 0; void refresh(); });
$("killboard-refresh").addEventListener("click", () => { state.killboardLoadedAt = 0; void loadKillboard(true); });
$("apply-filters").addEventListener("click", () => { state.page = 0; void loadPilots(); });
$("pilot-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { state.page = 0; void loadPilots(); } });
$("pilot-prev").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); void loadPilots(); });
$("pilot-next").addEventListener("click", () => { state.page += 1; void loadPilots(); });
$("apply-operation-filters").addEventListener("click", () => { state.operationPage = 0; void loadOperations(true); });
$("apply-activity-filters").addEventListener("click", () => { state.activityPage = 0; state.activityLoadedAt = 0; void loadPilotActivity(true); });
$("activity-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { state.activityPage = 0; state.activityLoadedAt = 0; void loadPilotActivity(true); } });
$("activity-page-size").addEventListener("change", (event) => { state.activityPageSize = Math.max(1, Math.min(100, Number(event.target.value) || 100)); state.activityPage = 0; state.activityLoadedAt = 0; void loadPilotActivity(true); });
$("activity-prev").addEventListener("click", () => { state.activityPage = Math.max(0, state.activityPage - 1); state.activityLoadedAt = 0; void loadPilotActivity(true); });
$("activity-next").addEventListener("click", () => { state.activityPage += 1; state.activityLoadedAt = 0; void loadPilotActivity(true); });
$("operation-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { state.operationPage = 0; void loadOperations(true); } });
$("operation-status").addEventListener("change", () => { state.operationPage = 0; void loadOperations(true); });
$("operation-kind").addEventListener("change", () => { state.operationPage = 0; void loadOperations(true); });
$("operation-prev").addEventListener("click", () => { state.operationPage = Math.max(0, state.operationPage - 1); void loadOperations(true); });
$("operation-next").addEventListener("click", () => { state.operationPage += 1; void loadOperations(true); });
$("operation-first").addEventListener("click", () => { state.operationPage = 0; void loadOperations(true); });
$("operation-last").addEventListener("click", () => { state.operationPage = Math.max(0, Math.ceil(state.totalOperations / state.operationPageSize) - 1); void loadOperations(true); });
$("operation-page-input").addEventListener("change", (event) => goToOperationPage(event.target.value));
$("operation-page-input").addEventListener("keydown", (event) => { if (event.key === "Enter") goToOperationPage(event.target.value); });
$("operation-page-size").addEventListener("change", (event) => {
  const size = Number(event.target.value);
  state.operationPageSize = size === 50 ? 50 : DEFAULT_OPERATIONS_PAGE_SIZE;
  state.operationPage = 0;
  void loadOperations(true);
});
$("operation-rows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-operation-id]");
  if (button) void showOperationDetails(button.dataset.operationId);
});
$("operation-dialog-close").addEventListener("click", () => $("operation-dialog").close());
$("settings-form").addEventListener("submit", (event) => void saveSettings(event));
$("reset-settings").addEventListener("click", () => {
  if (!settingDefaults) return;
  if (!window.confirm("Reset every setting on this page to its default and save?")) return;
  fillSettingsForm(settingDefaults);
  $("settings-form").requestSubmit();
});
window.addEventListener("hashchange", () => setView(location.hash.slice(1) || "overview"));

setView(location.hash.slice(1) || "overview");
void refresh();
setInterval(() => void refresh(), REFRESH_MS);

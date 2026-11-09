"use strict";

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function normalizeSet(value) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(entries.map((entry) => String(entry || "").trim()).filter(Boolean));
}

function listScheduledJobs(jobMap, query = {}) {
  const safeQuery = query && typeof query === "object" && !Array.isArray(query) ? query : {};
  const types = normalizeSet(safeQuery.types || safeQuery.type);
  const states = normalizeSet(safeQuery.states || safeQuery.state);
  const payloadFilters = safeQuery.payload && typeof safeQuery.payload === "object" && !Array.isArray(safeQuery.payload)
    ? Object.entries(safeQuery.payload)
    : [];
  const prefix = String(safeQuery.jobIDPrefix || "");
  return Object.values(jobMap && typeof jobMap === "object" ? jobMap : {})
    .filter((job) => {
      if (!job || typeof job !== "object") return false;
      if (types.size && !types.has(String(job.type || ""))) return false;
      if (states.size && !states.has(String(job.state || ""))) return false;
      if (prefix && !String(job.jobID || "").startsWith(prefix)) return false;
      const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
      return payloadFilters.every(([key, value]) => Object.hasOwn(payload, key) && payload[key] === value);
    })
    .map(cloneValue);
}

module.exports = { listScheduledJobs };

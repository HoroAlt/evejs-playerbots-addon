"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const STATIC_ROOT = path.join(__dirname, "dashboard");
const MAX_PROXY_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_SHIP_RENDER_BYTES = 512 * 1024;
const MAX_CHARACTER_PORTRAIT_BYTES = 2 * 1024 * 1024;
const SHIP_RENDER_SIZES = new Set([32, 64, 128, 256, 512]);
const CHARACTER_PORTRAIT_SIZES = new Set([32, 64, 128, 256, 512, 1024]);
const SHIP_RENDER_CACHE_MS = 6 * 60 * 60 * 1000;
const MIN_DASHBOARD_API_TIMEOUT_MS = 10_000;
const MAX_DASHBOARD_API_TIMEOUT_MS = 30_000;

function positiveInteger(value, fallback, maximum) {
  const parsed = Math.trunc(Number(value));
  return Number.isSafeInteger(parsed) ? Math.max(0, Math.min(maximum, parsed)) : fallback;
}

function createDashboardServer(options = {}) {
  const host = String(options.host || process.env.EVEJS_PLAYER_BOTS_DASHBOARD_HOST || "0.0.0.0").trim();
  const portValue = Number(options.port ?? process.env.EVEJS_PLAYER_BOTS_DASHBOARD_CONTAINER_PORT ?? 8080);
  const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65_535 ? portValue : 8080;
  const apiURL = String(options.apiURL || process.env.EVEJS_PLAYER_BOTS_ADDON_URL || "http://127.0.0.1:26004").replace(/\/+$/, "");
  const imageServerURL = String(options.imageServerURL || process.env.EVEJS_PLAYER_BOTS_IMAGE_SERVER_URL || process.env.EVEJS_IMAGE_SERVER_URL || "http://127.0.0.1:26001/").replace(/\/+$/, "");
  const token = String(options.token ?? process.env.EVEJS_PLAYER_BOTS_ADDON_TOKEN ?? "");
  const fetchImpl = options.fetch || fetch;
  const timeoutSignal = options.timeoutSignal || AbortSignal.timeout;
  const staticRoot = options.staticRoot || STATIC_ROOT;
  const logger = options.logger || { info() {}, warn() {} };
  const shipRenderCache = new Map();
  let server = null;

  function proxyTimeoutMs() {
    let configured = MAX_DASHBOARD_API_TIMEOUT_MS;
    try {
      configured = Number(typeof options.getProxyTimeoutMs === "function"
        ? options.getProxyTimeoutMs()
        : options.proxyTimeoutMs ?? process.env.EVEJS_PLAYER_BOTS_DASHBOARD_API_TIMEOUT_MS);
    } catch {
      configured = MAX_DASHBOARD_API_TIMEOUT_MS;
    }
    if (!Number.isFinite(configured) || configured <= 0) configured = MAX_DASHBOARD_API_TIMEOUT_MS;
    return Math.max(MIN_DASHBOARD_API_TIMEOUT_MS,
      Math.min(MAX_DASHBOARD_API_TIMEOUT_MS, Math.trunc(configured)));
  }

  function send(response, statusCode, contentType, payload, extraHeaders = {}) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    response.writeHead(statusCode, {
      "cache-control": "no-store",
      "content-length": body.length,
      "content-type": contentType,
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...extraHeaders,
    });
    response.end(body);
  }

  async function proxyApi(response, pathname, query = "") {
    const startedAtMs = Date.now();
    const timeoutMs = proxyTimeoutMs();
    try {
      const upstream = await fetchImpl(`${apiURL}${pathname}${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: timeoutSignal(timeoutMs),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > MAX_PROXY_BYTES) {
        send(response, 502, "application/json; charset=utf-8", JSON.stringify({ error: "Dashboard response exceeded its size limit." }));
        return;
      }
      send(response, upstream.status, "application/json; charset=utf-8", body);
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Private API request failed after ${Date.now() - startedAtMs}ms (timeout=${timeoutMs}ms): ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "application/json; charset=utf-8", JSON.stringify({ error: "EveJS dashboard data is temporarily unavailable." }));
    }
  }

  async function proxyMutation(response, pathname, method, body) {
    const startedAtMs = Date.now();
    const timeoutMs = proxyTimeoutMs();
    try {
      const upstream = await fetchImpl(`${apiURL}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs),
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      if (payload.length > MAX_PROXY_BYTES) {
        send(response, 502, "application/json; charset=utf-8", JSON.stringify({ error: "Dashboard response exceeded its size limit." }));
        return;
      }
      send(response, upstream.status, "application/json; charset=utf-8", payload);
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Private API update failed after ${Date.now() - startedAtMs}ms (timeout=${timeoutMs}ms): ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "application/json; charset=utf-8", JSON.stringify({ error: "EveJS dashboard update is temporarily unavailable." }));
    }
  }

  async function proxyShipRender(response, request, url) {
    const rawTypeID = Number(url.searchParams.get("typeID"));
    const rawSize = Number(url.searchParams.get("size") || 64);
    const typeID = Math.trunc(rawTypeID);
    const size = Math.trunc(rawSize);
    if (!Number.isSafeInteger(rawTypeID) || typeID <= 0 || typeID > 10_000_000 ||
        !Number.isSafeInteger(rawSize) || !SHIP_RENDER_SIZES.has(size)) {
      send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "A valid ship type and render size are required." }));
      return;
    }
    const cacheKey = `${typeID}:${size}`;
    const cached = shipRenderCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      send(response, 200, cached.contentType, request.method === "HEAD" ? Buffer.alloc(0) : cached.body, {
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      });
      return;
    }
    try {
      const upstream = await fetchImpl(`https://images.evetech.net/types/${typeID}/render?size=${size}`, {
        method: "GET",
        headers: { accept: "image/jpeg, image/png" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!upstream.ok) {
        send(response, upstream.status === 404 ? 404 : 502, "image/svg+xml; charset=utf-8", "");
        return;
      }
      const contentType = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!new Set(["image/jpeg", "image/png"]).has(contentType)) {
        send(response, 502, "image/svg+xml; charset=utf-8", "");
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (!body.length || body.length > MAX_SHIP_RENDER_BYTES) {
        send(response, 502, "image/svg+xml; charset=utf-8", "");
        return;
      }
      if (shipRenderCache.size >= 256) shipRenderCache.delete(shipRenderCache.keys().next().value);
      shipRenderCache.set(cacheKey, { body, contentType, expiresAt: Date.now() + SHIP_RENDER_CACHE_MS });
      send(response, 200, contentType, request.method === "HEAD" ? Buffer.alloc(0) : body, {
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      });
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Official ship render request failed: ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "image/svg+xml; charset=utf-8", "", { "cache-control": "no-store" });
    }
  }

  async function proxyCharacterPortrait(response, request, url) {
    const rawCharacterID = Number(url.searchParams.get("characterID"));
    const rawSize = Number(url.searchParams.get("size") || 64);
    const characterID = Math.trunc(rawCharacterID);
    const size = Math.trunc(rawSize);
    const extension = String(url.searchParams.get("ext") || "jpg").toLowerCase();
    if (!Number.isSafeInteger(rawCharacterID) || characterID <= 0 || characterID > 10_000_000_000 ||
        !Number.isSafeInteger(rawSize) || !CHARACTER_PORTRAIT_SIZES.has(size) ||
        !new Set(["jpg", "png"]).has(extension)) {
      send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "A valid character and portrait size are required." }));
      return;
    }
    try {
      const upstream = await fetchImpl(`${imageServerURL}/Character/${characterID}_${size}.${extension}`, {
        method: request.method,
        headers: { accept: extension === "png" ? "image/png" : "image/jpeg" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!upstream.ok) {
        send(response, upstream.status === 404 ? 404 : 502, "application/json; charset=utf-8", "");
        return;
      }
      const contentType = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!new Set(["image/jpeg", "image/png"]).has(contentType)) {
        send(response, 502, "application/json; charset=utf-8", "");
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (!body.length || body.length > MAX_CHARACTER_PORTRAIT_BYTES) {
        send(response, 502, "application/json; charset=utf-8", "");
        return;
      }
      send(response, 200, contentType, request.method === "HEAD" ? Buffer.alloc(0) : body, {
        "cache-control": "public, max-age=300",
        "content-length": body.length,
      });
    } catch (error) {
      logger.warn(`[PlayerBotsDashboard] Character portrait request failed for ${characterID}: ${String(error && error.message || error).slice(0, 180)}`);
      send(response, 503, "application/json; charset=utf-8", "");
    }
  }

  async function readJsonBody(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
      const error = new Error("Settings must be submitted as JSON.");
      error.statusCode = 415;
      throw error;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        const error = new Error("Request body exceeds the dashboard size limit.");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      const error = new Error("Request body must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const error = new Error("Request body must be a JSON object.");
      error.statusCode = 400;
      throw error;
    }
    return value;
  }

  function isSameOriginRequest(request) {
    const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
    const origin = String(request.headers.origin || "");
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.host.toLowerCase() === String(request.headers.host || "").toLowerCase();
    } catch {
      return false;
    }
  }

  async function route(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, HEAD, POST" });
      return;
    }
    const url = new URL(request.url || "/", "http://playerbots-dashboard.local");
    if (url.pathname === "/api/ship-render") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, HEAD" });
        return;
      }
      return proxyShipRender(response, request, url);
    }
    if (url.pathname === "/api/character-portrait") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, HEAD" });
        return;
      }
      return proxyCharacterPortrait(response, request, url);
    }
    if (url.pathname === "/api/summary") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/summary");
    }
    if (url.pathname === "/api/kills") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/kills");
    }
    if (url.pathname === "/api/operations") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      const offset = positiveInteger(url.searchParams.get("offset"), 0, 10_000_000);
      const limit = positiveInteger(url.searchParams.get("limit"), 50, 100) || 50;
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      for (const key of ["status", "kind", "search"]) {
        const value = String(url.searchParams.get(key) || "").trim().slice(0, 80);
        if (value) query.set(key, value);
      }
      return proxyApi(response, "/v1/dashboard/operations", `?${query}`);
    }
    if (url.pathname === "/api/operation" && request.method === "GET") {
      const operationID = String(url.searchParams.get("operationID") || "").trim().slice(0, 100);
      if (!/^(?:OP|IC)[0-9]+-[0-9]+(?:-[a-z0-9-]+)?$/i.test(operationID)) {
        send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: "A valid operation ID is required." }));
        return;
      }
      const query = new URLSearchParams({ operationID });
      return proxyApi(response, "/v1/dashboard/operation", `?${query}`);
    }
    if (url.pathname === "/api/settings") {
      if (request.method === "GET") return proxyApi(response, "/v1/dashboard/settings");
      if (request.method !== "POST") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET, POST" });
        return;
      }
      if (!isSameOriginRequest(request)) {
        send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin dashboard updates are blocked." }));
        return;
      }
      const body = await readJsonBody(request);
      return proxyMutation(response, "/v1/dashboard/settings", "PATCH", body);
    }
    if (url.pathname === "/api/seed-status") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      return proxyApi(response, "/v1/dashboard/seed-status");
    }
    if (url.pathname === "/api/bots") {
      if (request.method !== "GET") {
        send(response, 405, "text/plain; charset=utf-8", "Method not allowed.", { allow: "GET" });
        return;
      }
      const offset = positiveInteger(url.searchParams.get("offset"), 0, 10_000_000);
      const limit = positiveInteger(url.searchParams.get("limit"), 50, 100) || 50;
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      for (const key of ["specialty", "corporationID", "search"]) {
        const value = String(url.searchParams.get(key) || "").trim().slice(0, 80);
        if (value) query.set(key, value);
      }
      return proxyApi(response, "/v1/dashboard/bots", `?${query}`);
    }

    const assets = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/index.html": ["index.html", "text/html; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
      "/styles.css": ["styles.css", "text/css; charset=utf-8"],
      "/favicon.svg": ["favicon.svg", "image/svg+xml"],
    };
    const asset = assets[url.pathname];
    if (!asset) {
      send(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }
    let body;
    try {
      body = fs.readFileSync(path.join(staticRoot, asset[0]));
    } catch {
      send(response, 503, "text/plain; charset=utf-8", "Dashboard assets are missing from this add-on package.");
      return;
    }
    send(response, 200, asset[1], request.method === "HEAD" ? Buffer.alloc(0) : body);
  }

  return Object.freeze({
    async start() {
      if (server && server.listening) return this.getDiagnostics();
      server = http.createServer((request, response) => {
        void route(request, response).catch((error) => {
          logger.warn(`[PlayerBotsDashboard] Request failed: ${String(error && error.message || error).slice(0, 180)}`);
          if (!response.headersSent) {
            send(response, Number(error && error.statusCode) || 500, "application/json; charset=utf-8", JSON.stringify({ error: String(error && error.message || "Dashboard request failed.") }));
          }
          else response.destroy();
        });
      });
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger.info(`[PlayerBotsDashboard] Dashboard listening on ${host}:${server.address().port}`);
      return this.getDiagnostics();
    },
    async shutdown() {
      if (!server || !server.listening) return;
      const current = server;
      server = null;
      await new Promise((resolve) => current.close(() => resolve()));
    },
    getDiagnostics() {
      return { listening: Boolean(server && server.listening), host, port: server && server.address() && server.address().port || null };
    },
  });
}

module.exports = { createDashboardServer };

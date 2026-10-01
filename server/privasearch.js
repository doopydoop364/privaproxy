"use strict";
const express = require("express");
const { clientKey } = require("./client-key");

/**
 * PrivaSearch search engine integration (server side).
 *
 * The browser never talks to PrivaSearch and never sees its address or credential: it calls `/api/privasearch/*` on this server, which calls the
 * PrivaSearch API configured in the environment and returns a sanitised copy of the answer.
 *
 *   PRIVASEARCH_URL    base URL of the PrivaSearch API, for example http://127.0.0.1:4020 or https://search.example. Unset: the engine is
 *                      reported as not configured and the UI disables it.
 *   PRIVASEARCH_TOKEN  optional bearer token if PrivaSearch has PRIVASEARCH_API_TOKEN set. Sent only from here. A token is refused for a plain
 *                      http address that is not loopback (it would cross the network in the clear).
 *
 * Routes:   GET /api/privasearch/config   -> { enabled }
 *           GET /api/privasearch/search?q=<text>&offset=<n>&limit=<n>
 *
 * The operator chooses the PrivaSearch address; user input only ever becomes the query string. Redirects are not followed, the wait is bounded,
 * the answer size is bounded, and only whitelisted fields of the answer are passed on (page text is untrusted: the UI renders it as plain text).
 * Queries are never logged.
 */
const MAX_QUERY = 200, MAX_BODY = 512 * 1024, TIMEOUT_MS = 8000, MAX_LIMIT = 20, MAX_OFFSET = 300;
const STATES = new Set(["ready", "partial", "empty"]);
const CRAWL_STATES = new Set(["none", "scheduled", "cooldown", "busy", "rate_limited", "no_candidates", "disabled"]);
const isLoopbackHost = (host) => /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i.test(host);

/** Validates the configured address; returns { url } or { error } (a message that names the setting, never its value). */
function readConfig(env = process.env) {
  const raw = env.PRIVASEARCH_URL;
  if (!raw) return { url: null };
  let parsed;
  try { parsed = new URL(raw); } catch { return { error: "PRIVASEARCH_URL is not a valid URL" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "PRIVASEARCH_URL must be http or https" };
  if (parsed.username || parsed.password) return { error: "PRIVASEARCH_URL must not contain credentials; use PRIVASEARCH_TOKEN" };
  const token = env.PRIVASEARCH_TOKEN || null;
  if (token && parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) return { error: "PRIVASEARCH_TOKEN is only sent over https or to a loopback address" };
  parsed.hash = ""; parsed.search = "";
  return { url: parsed.href.replace(/\/+$/, ""), token };
}

const text = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, max) : "";
const number = (value) => Number.isFinite(value) ? value : 0;
function webUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:" ? u.href : null; } catch { return null; }
}
/** Keeps only the fields the UI uses, with bounded, typed values. Everything else PrivaSearch sends is dropped. */
function sanitize(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.hits)) return null;
  const hits = body.hits.flatMap((hit) => { // invalid entries are dropped first, then the page is capped (the body size is already bounded)
    const url = webUrl(hit?.url);
    if (!url) return [];
    return [{ url, title: text(hit.title, 300) || url, snippet: text(hit.snippet, 500), host: text(hit.host, 253), score: number(hit.score), fetchedAt: number(hit.fetchedAt),
      matchedTerms: number(hit.signals?.matchedTerms), totalTerms: number(hit.signals?.totalTerms) }];
  }).slice(0, MAX_LIMIT);
  const crawl = body.crawl && typeof body.crawl === "object" ? body.crawl : {};
  return {
    query: text(body.query, MAX_QUERY), total: Math.max(0, Math.trunc(number(body.total))), offset: Math.max(0, Math.trunc(number(body.offset))), limit: Math.max(0, Math.trunc(number(body.limit))), hits,
    index: { state: STATES.has(body.index?.state) ? body.index.state : "partial", documents: Math.max(0, Math.trunc(number(body.index?.documents))) },
    crawl: { triggered: crawl.triggered === true, state: CRAWL_STATES.has(crawl.state) ? crawl.state : "none", candidates: Math.max(0, Math.trunc(number(crawl.candidates))), retryAfterSec: Math.max(0, Math.trunc(number(crawl.retryAfterSec))) },
  };
}

/** A small in-memory limiter: at most `max` searches per client per minute, so one client cannot turn this route into a crawl or load generator. */
function limiter(max, now = Date.now) {
  const seen = new Map();
  return (key) => {
    const t = now(); const entry = seen.get(key);
    if (!entry || t - entry.start >= 60000) {
      if (seen.size > 2000) { for (const [k, v] of seen) if (t - v.start >= 60000) seen.delete(k); if (seen.size > 2000) seen.clear(); } // drop expired windows first; only a flood of live clients resets everyone
      seen.set(key, { start: t, count: 1 }); return true;
    }
    return ++entry.count <= max;
  };
}

/** Reads at most `max` bytes of a response body; returns null (and cancels the download) as soon as it is exceeded, so a hostile or broken upstream cannot make this process buffer more. */
async function readBounded(response, max) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createRouter(options = {}) {
  const config = options.config ?? readConfig(options.env);
  const fetchImpl = options.fetch ?? fetch;
  const allow = limiter(options.perMinute ?? 30, options.now);
  const router = express.Router();
  router.get("/config", (_req, res) => { res.set("Cache-Control", "no-store").json({ enabled: Boolean(config.url) }); });
  router.get("/search", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!config.url) return res.status(503).json({ error: "NOT_CONFIGURED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q || q.length > MAX_QUERY) return res.status(400).json({ error: "BAD_QUERY" });
    if (!allow(clientKey(req))) return res.status(429).json({ error: "RATE_LIMITED" });
    const int = (name, fallback, min, max) => { const n = Number(req.query[name]); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; };
    const target = new URL(`${config.url}/search`);
    target.searchParams.set("q", q);
    target.searchParams.set("limit", String(int("limit", 10, 1, MAX_LIMIT)));
    target.searchParams.set("offset", String(int("offset", 0, 0, MAX_OFFSET)));
    try {
      const upstream = await fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        headers: { accept: "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) } });
      if (upstream.status === 401 || upstream.status === 403) return res.status(502).json({ error: "UPSTREAM_REFUSED" }); // a configuration problem on this server, not something to show the user a token about
      if (!upstream.ok) return res.status(502).json({ error: "UNAVAILABLE" });
      const raw = await readBounded(upstream, MAX_BODY);
      if (raw === null) return res.status(502).json({ error: "UNAVAILABLE" });
      let body; try { body = JSON.parse(raw); } catch { return res.status(502).json({ error: "UNAVAILABLE" }); }
      const clean = sanitize(body);
      if (!clean) return res.status(502).json({ error: "UNAVAILABLE" });
      return res.json(clean);
    } catch (error) {
      return res.status(error?.name === "TimeoutError" ? 504 : 502).json({ error: error?.name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE" });
    }
  });
  return router;
}

module.exports = { createRouter, readConfig, sanitize, limiter, readBounded };

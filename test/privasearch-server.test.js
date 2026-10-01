"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { createRouter, readConfig, sanitize, limiter } = require("../server/privasearch");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
const TOKEN = "t".repeat(40);

/** A fake PrivaSearch: records every request and answers with whatever the test sets. */
async function upstream(t, answer) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); answer(req, res); });
  const port = await listen(server); t.after(() => close(server));
  return { url: `http://127.0.0.1:${port}`, seen };
}
async function app(t, options) {
  const server = http.createServer(express().use("/api/privasearch", createRouter(options)));
  const port = await listen(server); t.after(() => close(server));
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, headers: r.headers, text }; };
  return { get };
}
const good = (extra = {}) => ({
  apiVersion: 1, query: "rust", total: 2, offset: 0, limit: 10,
  hits: [{ url: "https://a.example/x", title: "Rust", snippet: "A <b>language</b>", host: "a.example", score: 61.2, fetchedAt: 1700000000000, lastChangedAt: 5, signals: { matchedTerms: 1, totalTerms: 1, relevance: 0.4, internal: "drop me" } },
    { url: "https://b.example/y", title: "Rust 2", snippet: "More", host: "b.example", score: 40, fetchedAt: 1700000000001, signals: { matchedTerms: 1, totalTerms: 1 } }],
  index: { state: "ready", documents: 9 }, crawl: { triggered: false, state: "none", candidates: 0 }, secretField: "never forwarded", ...extra });
const json = (body, status = 200) => (_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };

test("config: unset means not configured; invalid values are refused with a message that never contains the value", () => {
  assert.deepEqual(readConfig({}), { url: null });
  assert.equal(readConfig({ PRIVASEARCH_URL: "http://127.0.0.1:4020/" }).url, "http://127.0.0.1:4020");
  assert.equal(readConfig({ PRIVASEARCH_URL: "https://search.example/base/?x=1#y" }).url, "https://search.example/base");
  for (const bad of ["not a url", "ftp://x.example", "https://user:pw@x.example", "file:///etc/passwd"]) { const c = readConfig({ PRIVASEARCH_URL: bad }); assert.ok(c.error, bad); assert.equal(c.error.includes(bad), false); assert.equal(c.error.includes("pw"), false); }
  assert.ok(readConfig({ PRIVASEARCH_URL: "http://search.lan:4020", PRIVASEARCH_TOKEN: TOKEN }).error, "a token is not sent in clear to a non-loopback http address");
  assert.equal(readConfig({ PRIVASEARCH_URL: "https://search.example", PRIVASEARCH_TOKEN: TOKEN }).token, TOKEN);
  assert.equal(readConfig({ PRIVASEARCH_URL: "http://localhost:4020", PRIVASEARCH_TOKEN: TOKEN }).token, TOKEN);
});

test("an unconfigured server says so and never calls out", async (t) => {
  const api = await app(t, { config: { url: null } });
  assert.deepEqual((await api.get("/api/privasearch/config")).body, { enabled: false });
  const search = await api.get("/api/privasearch/search?q=x"); assert.deepEqual([search.status, search.body], [503, { error: "NOT_CONFIGURED" }]);
});

test("search proxies to PrivaSearch with the query encoded and bounded, adds the bearer token server-side, and returns only whitelisted fields", async (t) => {
  const up = await upstream(t, json(good()));
  const api = await app(t, { config: { url: up.url, token: TOKEN } });
  assert.deepEqual((await api.get("/api/privasearch/config")).body, { enabled: true }); // enabled, and nothing else: no address, no token
  const r = await api.get(`/api/privasearch/search?q=${encodeURIComponent("c++ & rust=1?#")}&offset=20&limit=500`);
  assert.equal(r.status, 200);
  const sent = new URL(up.seen[0].url, "http://x");
  assert.deepEqual([sent.pathname, sent.searchParams.get("q"), sent.searchParams.get("offset"), sent.searchParams.get("limit")], ["/search", "c++ & rust=1?#", "20", "20"]); // limit capped at 20
  assert.equal(up.seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(Object.keys(r.body.hits[0]).sort(), ["fetchedAt", "host", "matchedTerms", "score", "snippet", "title", "totalTerms", "url"]);
  assert.equal(r.body.hits[0].snippet, "A <b>language</b>"); // untrusted text passes through as text; the UI never treats it as markup
  assert.equal("secretField" in r.body, false); assert.equal(r.text.includes(TOKEN), false); assert.equal(r.text.includes(up.url), false);
  assert.deepEqual(r.body.index, { state: "ready", documents: 9 });
});

test("without a token configured no authorization header is sent; bad queries and limits are handled before anything is sent", async (t) => {
  const up = await upstream(t, json(good()));
  const api = await app(t, { config: { url: up.url } });
  await api.get("/api/privasearch/search?q=hello&limit=abc&offset=-5"); assert.equal(up.seen[0].headers.authorization, undefined);
  const sent = new URL(up.seen[0].url, "http://x"); assert.deepEqual([sent.searchParams.get("limit"), sent.searchParams.get("offset")], ["10", "0"]);
  for (const bad of ["/api/privasearch/search", "/api/privasearch/search?q=", "/api/privasearch/search?q=%20%20", `/api/privasearch/search?q=${"x".repeat(201)}`]) assert.equal((await api.get(bad)).status, 400, bad);
  assert.equal(up.seen.length, 1);
});

test("failures become small, safe errors: unavailable, refused, timeout, redirect, oversized, not JSON, wrong shape", async (t) => {
  const cases = [
    ["upstream 500", json("{}", 500), 502, "UNAVAILABLE"], ["upstream 401", json("{}", 401), 502, "UPSTREAM_REFUSED"],
    ["not JSON", (_q, res) => { res.writeHead(200); res.end("<html>nope</html>"); }, 502, "UNAVAILABLE"], ["wrong shape", json({ hits: "no" }), 502, "UNAVAILABLE"],
    ["too large", (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"hits":[],"pad":"${"x".repeat(600 * 1024)}"}`); }, 502, "UNAVAILABLE"],
    ["redirect", (_q, res) => { res.writeHead(302, { location: "http://169.254.169.254/latest" }); res.end(); }, 502, "UNAVAILABLE"],
  ];
  for (const [name, answer, status, code] of cases) {
    const up = await upstream(t, answer); const api = await app(t, { config: { url: up.url, token: TOKEN } });
    const r = await api.get("/api/privasearch/search?q=x"); assert.deepEqual([r.status, r.body], [status, { error: code }], name); assert.equal(r.text.includes(TOKEN), false, name);
    assert.equal(up.seen.length, 1, `${name}: a redirect is not followed`);
  }
  const hang = await upstream(t, () => {}); const slow = await app(t, { config: { url: hang.url }, timeoutMs: 150 });
  assert.deepEqual((await slow.get("/api/privasearch/search?q=x")).body, { error: "TIMEOUT" });
  const down = await app(t, { config: { url: "http://127.0.0.1:1" } }); assert.deepEqual((await down.get("/api/privasearch/search?q=x")).body, { error: "UNAVAILABLE" });
});

test("sanitising: only http(s) results survive, strings and numbers are bounded and typed, enums are checked", () => {
  const clean = sanitize({ query: "q", total: 3.9, offset: -4, limit: 10, index: { state: "weird", documents: "NaN" }, crawl: { triggered: "yes", state: "unknown", candidates: 2, retryAfterSec: 30 },
    hits: [{ url: "javascript:alert(1)", title: "x" }, { url: "https://ok.example/", title: "A".repeat(1000), snippet: "\u0000bad\u0007 chars", host: 5, score: "high", fetchedAt: Infinity }, { title: "no url" }, null, ...Array.from({ length: 50 }, (_, i) => ({ url: `https://h${i}.example/` }))] });
  assert.equal(clean.hits.length, 20); assert.equal(clean.hits[0].url, "https://ok.example/"); assert.equal(clean.hits[0].title.length, 300);
  assert.deepEqual([clean.hits[0].snippet, clean.hits[0].host, clean.hits[0].score, clean.hits[0].fetchedAt], [" bad  chars", "", 0, 0]);
  assert.deepEqual([clean.total, clean.offset, clean.index, clean.crawl], [3, 0, { state: "partial", documents: 0 }, { triggered: false, state: "none", candidates: 2, retryAfterSec: 30 }]);
  assert.equal(sanitize(null), null); assert.equal(sanitize({}), null);
});

test("a per-client limit keeps this route from becoming a load generator", async (t) => {
  const up = await upstream(t, json(good())); let now = 1000;
  const api = await app(t, { config: { url: up.url }, perMinute: 3, now: () => now });
  const statuses = []; for (let i = 0; i < 5; i++) statuses.push((await api.get("/api/privasearch/search?q=x")).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]); assert.equal(up.seen.length, 3);
  now += 61000; assert.equal((await api.get("/api/privasearch/search?q=x")).status, 200);
  const allow = limiter(1, () => 0); assert.deepEqual([allow("a"), allow("a"), allow("b")], [true, false, true]);
});

test("the app wires the route after authentication and the credential never appears in any file the browser can load", () => {
  const index = fs.readFileSync(path.join(__dirname, "../server/index.js"), "utf8");
  assert.ok(index.indexOf("auth.mount(app)") < index.indexOf('"/api/privasearch"'), "authentication is mounted first, so the route is protected when a password is set");
  for (const file of ["public/index.html", "public/js/app.js", "public/js/privasearch.js", "public/css/style.css"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.equal(/PRIVASEARCH_(URL|TOKEN)|authorization|Bearer/i.test(text), false, `${file} must not know the PrivaSearch address or credential`);
  }
});

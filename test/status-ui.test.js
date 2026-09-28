"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const vm = require("vm");
const { makeEnv, tick } = require("./helpers/fakeDom");

const IDS = ["view-status", "statusRefresh", "statusAuto", "statusInterval", "statusSummary", "statusUpdateState", "statusUpdated",
  "statusServer", "statusBackends", "statusYoutube", "statusLogout", "statusLogin", "statusEvents", "statusIssues", "statusClearEvents", "statusClearIssues"];
const proxy = (overrides = {}) => ({ id: "primary", name: "Primary", online: true, latencyMs: 12, checkedAt: 1700000000000, ...overrides });
function boot({ active = true, seed = {}, respond } = {}) {
  const calls = [], timers = new Map();
  let nextTimer = 0, observer;
  const env = makeEnv({ seed, respond: async () => ({ status: 404 }) });
  for (const id of IDS) {
    const node = new env.El(id === "statusAuto" ? "input" : id === "statusInterval" ? "select" : "div");
    env.byId.set(id, node); env.root.appendChild(node);
  }
  const get = id => env.byId.get(id);
  get("statusAuto").checked = true;
  if (active) get("view-status").classList.add("is-active");
  env.sandbox.navigator = { onLine: true };
  env.sandbox.performance = { now: () => 100 };
  env.sandbox.AbortSignal = AbortSignal;
  env.sandbox.MutationObserver = class { constructor(fn) { observer = fn; } observe() {} };
  env.sandbox.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  env.sandbox.clearTimeout = id => timers.delete(id);
  env.sandbox.fetch = async (url, options) => {
    calls.push({ url, options });
    const response = respond ? await respond(url, options) : null;
    const body = url.includes("/auth/") ? { enabled: false } : url.includes("/proxies") ? [proxy()] : { ok: true, version: "2026.test", jsRuntimes: ["node"] };
    const r = response || { status: 200, body };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  vm.createContext(env.sandbox);
  vm.runInContext(fs.readFileSync(require.resolve("../public/js/status.js"), "utf8"), env.sandbox);
  return { ...env, get, calls, timers, diagnostics: env.sandbox.privaproxyDiagnostics,
    show(on) { get("view-status").classList.toggle("is-active", on); observer(); },
    event(type) { for (const fn of env.listeners[type] || []) fn(); },
    poll() { const [id, timer] = [...timers][0] || []; assert.ok(timer, "poll timer scheduled"); timers.delete(id); timer.fn(); } };
}

test("Status automatically polls while visible, serializes manual refresh, and pauses on leaving", async () => {
  const env = boot({ active: false });
  assert.equal(env.calls.length, 0);
  env.show(true); await tick();
  assert.equal(env.calls.length, 3);
  assert.equal(env.get("statusSummary").dataset.state, "ok");
  assert.match(env.get("statusBackends").textContent, /Primary: online/);
  assert.match(env.get("statusYoutube").textContent, /2026.test/);
  assert.equal([...env.timers.values()][0].ms, 5000);
  env.poll(); env.diagnostics.refresh(); env.diagnostics.refresh(); await tick();
  assert.equal(env.calls.length, 6, "only one batch despite multiple refresh calls");
  env.show(false);
  assert.equal(env.timers.size, 0);
  env.show(true); await tick();
  assert.equal(env.calls.length, 9);
  assert.ok(env.calls.every(call => call.options.cache === "no-store"));
});

test("Status auto-refresh can pause and change interval without disabling manual checks", async () => {
  const env = boot({ seed: { statusInterval: "corrupt" } }); await tick();
  assert.equal(env.get("statusInterval").value, "5000");
  env.get("statusAuto").checked = false; env.get("statusAuto").dispatch("change");
  assert.equal(env.timers.size, 0);
  assert.match(env.get("statusUpdateState").textContent, /paused/);
  env.get("statusRefresh").click(); await tick();
  assert.equal(env.calls.length, 6);
  assert.equal(env.timers.size, 0);
  env.show(false); env.show(true); await tick();
  assert.equal(env.calls.length, 6, "returning doesn't override the user's pause");
  env.get("statusInterval").value = "15000"; env.get("statusInterval").dispatch("change");
  env.get("statusAuto").checked = true; env.get("statusAuto").dispatch("change"); await tick();
  assert.equal([...env.timers.values()][0].ms, 15000);
  assert.equal(env.store.get("statusInterval"), "15000");
  env.get("statusInterval").value = "1"; env.get("statusInterval").dispatch("change");
  assert.equal([...env.timers.values()][0].ms, 5000);
});

test("Status retains stale results on failure and logs failure/recovery only once", async () => {
  let failing = false;
  const env = boot({ respond: async url => failing && url.includes("/proxies") ? { status: 503 } : null }); await tick();
  failing = true; env.poll(); await tick();
  assert.equal(env.get("statusSummary").dataset.state, "error");
  assert.match(env.get("statusBackends").textContent, /HTTP 503/);
  assert.match(env.get("statusBackends").textContent, /last known results/);
  assert.match(env.get("statusBackends").textContent, /Primary: online \(last known\)/);
  env.poll(); await tick();
  assert.equal(env.get("statusEvents").children.length, 1);
  failing = false; env.poll(); await tick();
  assert.equal(env.get("statusSummary").dataset.state, "ok");
  assert.match(env.get("statusEvents").textContent, /recovered/);
  env.get("statusClearEvents").click();
  assert.match(env.get("statusEvents").textContent, /No service changes/);
});

test("Status reports backend outages and only adds latency samples for distinct probes", async () => {
  let online = true, checkedAt = 1700000000000, latencyMs = 12;
  const env = boot({ respond: async url => url.includes("/proxies") ? { status: 200, body: [proxy({ online, checkedAt, latencyMs })] } : null }); await tick();
  env.poll(); await tick();
  assert.ok(!env.get("statusBackends").textContent.includes("Recent range"), "cached probe isn't counted again");
  checkedAt += 5000; latencyMs = 40; env.poll(); await tick();
  assert.match(env.get("statusBackends").textContent, /12–40 ms · 2 probes/);
  online = false; env.poll(); await tick();
  assert.equal(env.get("statusSummary").dataset.state, "error");
  assert.match(env.get("statusEvents").textContent, /Primary: offline/);
  online = true; env.poll(); await tick();
  assert.match(env.get("statusEvents").textContent, /Primary: recovered/);
});

test("Status suspends requests when offline/hidden and refreshes immediately on return", async () => {
  const env = boot(); await tick();
  env.sandbox.navigator.onLine = false; env.event("offline");
  assert.equal(env.timers.size, 0);
  assert.equal(env.get("statusRefresh").disabled, true);
  assert.match(env.get("statusSummary").textContent, /offline/);
  await env.diagnostics.refresh(); assert.equal(env.calls.length, 3);
  env.sandbox.navigator.onLine = true; env.event("online"); await tick();
  assert.equal(env.calls.length, 6);
  env.sandbox.document.hidden = true; env.event("visibilitychange");
  assert.equal(env.timers.size, 0);
  env.sandbox.document.hidden = false; env.event("visibilitychange"); await tick();
  assert.equal(env.calls.length, 9);
  env.event("pagehide"); assert.equal(env.timers.size, 0);
  env.event("pageshow"); await tick(); assert.equal(env.calls.length, 12);
});

test("Status aborts abandoned checks, suppresses their results, and waits before resuming", async () => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  let first = true;
  const env = boot({ respond: async url => { if (url.includes("/proxies") && first) { first = false; await held; return { status: 200, body: [proxy({ name: "Stale response" })] }; } } });
  await tick();
  assert.equal(env.get("statusRefresh").disabled, true);
  env.show(false);
  assert.ok(env.calls.every(call => call.options.signal.aborted));
  env.show(true);
  assert.equal(env.calls.length, 3, "aborted requests must settle before a new batch starts");
  finish(); await tick();
  assert.equal(env.calls.length, 6);
  assert.ok(!env.get("statusBackends").textContent.includes("Stale response"));
  assert.equal(env.get("statusSummary").dataset.state, "ok");
});

test("Status handles malformed responses and expired sessions with an actionable sign-in link", async () => {
  let mode = "bad";
  const env = boot({ respond: async url => url.includes("/auth/") ? { status: mode === "expired" ? 401 : 200, body: mode === "bad" ? { enabled: "yes" } : { enabled: true } } : null }); await tick();
  assert.match(env.get("statusServer").textContent, /invalid status response/);
  mode = "expired"; env.poll(); await tick();
  assert.equal(env.get("statusLogin").hidden, false);
  assert.match(env.get("statusServer").textContent, /Sign in again/);
  mode = "ok"; env.poll(); await tick();
  assert.equal(env.get("statusLogin").hidden, true);
  assert.equal(env.get("statusLogout").hidden, false);
});

test("Status playback messages are bounded, rendered as text, grouped and clearable", () => {
  const env = boot({ active: false });
  env.diagnostics.record("<script>unsafe()</script>"); env.diagnostics.record("<script>unsafe()</script>");
  assert.equal(env.get("statusIssues").children.length, 1);
  assert.match(env.get("statusIssues").textContent, /×2/);
  assert.match(env.get("statusIssues").textContent, /<script>/);
  assert.equal(env.get("statusIssues").querySelector("script"), null);
  for (let i = 0; i < 30; i++) env.diagnostics.record(`Issue ${i}`);
  assert.equal(env.get("statusIssues").children.length, 20);
  env.get("statusClearIssues").click();
  assert.match(env.get("statusIssues").textContent, /No playback messages/);
});

test("Status rejects malformed metadata without breaking the dashboard or its retry timer", async () => {
  const env = boot({ respond: async url => {
    if (url.includes("/proxies")) return { status: 200, body: [proxy({ name: { toString: null } })] };
    if (url.includes("/youtube/")) return { status: 200, body: { ok: true, jsRuntimes: [{ toString: null }] } };
  } });
  await tick();
  assert.match(env.get("statusBackends").textContent, /invalid status response/);
  assert.match(env.get("statusYoutube").textContent, /invalid status response/);
  assert.equal(env.timers.size, 1);
  assert.equal(env.get("statusSummary").dataset.state, "error");
});

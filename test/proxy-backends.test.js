"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");

const tick = () => new Promise(resolve => setImmediate(resolve));
function load(relative, mocks, extra = {}) {
  const file = path.resolve(__dirname, relative);
  const realRequire = createRequire(file);
  const requireMock = name => name in mocks ? mocks[name] : realRequire(name);
  requireMock.resolve = realRequire.resolve;
  const context = vm.createContext({ require: requireMock, module: { exports: {} },
    __dirname: path.dirname(file), URL, AbortController, performance,
    setTimeout, clearTimeout, process: { env: {} }, console, ...extra });
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  return context;
}

test("remote bare endpoints are listed without creating or routing a local server", () => {
  const created = [];
  const context = load("../server/proxies/ultraviolet.js", {
    fs: { readFileSync: () => JSON.stringify([{ id: "local", bareEndpoint: "/bare/" }, { id: "remote", bareEndpoint: "https://remote.example/bare/" }]) },
    "@tomphttp/bare-server-node": { createBareServer: endpoint => {
      created.push(endpoint); return { shouldRoute: () => false };
    } },
  });
  const provider = context.module.exports;
  assert.deepEqual(created, ["/bare/"]);
  assert.equal(provider.bareServers[1].server, null);
  const middleware = [];
  let upgrade;
  provider.mount({ use: (...args) => middleware.push(args) }, { on: (_event, fn) => { upgrade = fn; } });
  let continued = false, destroyed = false;
  middleware.at(-1)[0]({}, {}, () => { continued = true; });
  upgrade({}, { destroy() { destroyed = true; } });
  assert.equal(continued, true);
  assert.equal(destroyed, true);
});

test("registry starts one set of checks containing all providers' backends", () => {
  const calls = [];
  const context = load("../server/proxies/registry.js", {
    "./ultraviolet": { bareServers: [{ id: "a" }] },
    "./scramjet": { bareServers: [{ id: "b" }] },
    "./latency": { start: (...args) => calls.push(args) },
  });
  context.module.exports.startLatencyChecks("http://127.0.0.1:3000");
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0][0], entry => entry.id), ["a", "b"]);
});

test("latency checks cancel response bodies and resolve remote endpoint URLs correctly", async () => {
  let endpoint, canceled = false;
  class Client {
    constructor(url) { endpoint = url; }
    async init() {}
    async request() { return { body: { async cancel() { canceled = true; } } }; }
  }
  const context = load("../server/proxies/latency.js", {}, { Client, setInterval() {} });
  vm.runInContext("clientV3Promise = Promise.resolve(Client); module.exports.measure = measureOne;", context);
  await context.module.exports.measure({ bareEndpoint: "https://remote.example/bare/", testUrl: "https://example.com/" }, "http://127.0.0.1:3000", new AbortController().signal);
  assert.equal(endpoint, "https://remote.example/bare/");
  assert.equal(canceled, true);
});

test("timed-out latency work retains its slot until cancellation settles", async () => {
  let interval, finish, calls = 0;
  const context = load("../server/proxies/latency.js", {}, { setInterval: fn => { interval = fn; } });
  context.module.exports.start([{ id: "a" }], "http://localhost", { timeoutMs: 10,
    measure: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(context.module.exports.getStatus("a").online, false);
  interval(); await tick();
  assert.equal(calls, 1);
  finish(20); await tick();
  interval(); await tick();
  assert.equal(calls, 2);
  finish(1); await tick();
});

test("invalid latency settings use safe defaults instead of millisecond polling", async () => {
  let intervalMs, timeoutMs;
  const context = load("../server/proxies/latency.js", {}, {
    process: { env: { LATENCY_INTERVAL_MS: "Infinity", LATENCY_TIMEOUT_MS: "-10" } },
    setInterval: (_fn, ms) => { intervalMs = ms; },
    setTimeout: (_fn, ms) => { timeoutMs = ms; return 1; },
    clearTimeout() {},
  });
  context.module.exports.start([{ id: "a" }], "http://localhost", { measure: async () => 1 });
  await tick();
  assert.equal(intervalMs, 5000);
  assert.equal(timeoutMs, 8000);
});

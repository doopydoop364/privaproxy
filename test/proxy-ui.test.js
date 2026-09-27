"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { El, tick } = require("./helpers/fakeDom");
const A = { id: "a", name: "A", bareEndpoint: "/bare/", online: true };
const B = { id: "b", name: "B", bareEndpoint: "/bare2/", online: true };

async function boot() {
  const elements = new Map(["proxyPicker", "proxyDot", "enginePicker"].map(id => [id, new El("select")]));
  const calls = [];
  const context = vm.createContext({
    document: { querySelectorAll: () => [], getElementById: id => elements.get(id), createElement: tag => new El(tag) },
    location: { origin: "http://localhost:3000" }, URL, AbortSignal, setTimeout, setInterval() {},
    console: { error() {} },
    fetch: async () => ({ ok: true, json: async () => [A, B] }),
    BareMuxConnection: class {
      async setTransport(_module, args) { calls.push(args[0]); if (context.hold) await context.hold; }
    },
  });
  const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8")
    .replace(/^import[^\n]*\n/, "").split("// Registration can resolve")[0];
  vm.runInContext(source + "\nglobalThis.api = { switchToProxy, refreshProxies };", context);
  await tick();
  calls.length = 0;
  return { context, calls, elements };
}

test("proxy transport changes are serialized and a later selection remains applied", async () => {
  const { context, calls } = await boot();
  let release;
  context.hold = new Promise(resolve => { release = resolve; });
  const first = context.api.switchToProxy(B);
  const last = context.api.switchToProxy(A);
  await tick();
  assert.deepEqual(calls, ["http://localhost:3000/bare2/"]);
  context.hold = null;
  release();
  await Promise.all([first, last]);
  assert.deepEqual(calls, ["http://localhost:3000/bare2/", "http://localhost:3000/bare/"]);
  await context.api.switchToProxy({ id: "remote", bareEndpoint: "https://remote.example/bare/" });
  assert.equal(calls.at(-1), "https://remote.example/bare/");
});

test("an older proxy-list response cannot replace the newest selection", async () => {
  const { context, calls, elements } = await boot();
  let release, count = 0;
  const old = new Promise(resolve => { release = resolve; });
  context.fetch = async () => ++count === 1 ? old : { ok: true, json: async () => [B] };
  const first = context.api.refreshProxies();
  await context.api.refreshProxies();
  release({ ok: true, json: async () => [A] });
  await first;
  assert.equal(elements.get("proxyPicker").value, "b");
  assert.deepEqual(calls, ["http://localhost:3000/bare2/"]);
});

test("malformed address-bar URLs become valid searches for either engine", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  const normalize = "function normalizeUrl(raw) {" + source.split("function normalizeUrl(raw) {")[1].split("\nfunction hostnameOf")[0];
  const context = vm.createContext({ URL, encodeURIComponent });
  vm.runInContext(normalize + "\nglobalThis.normalize = normalizeUrl;", context);
  for (const raw of ["http://", "https://[broken]", "example.com:invalid"]) {
    const url = new URL(context.normalize(raw));
    assert.equal(url.hostname, "duckduckgo.com");
    assert.equal(url.searchParams.get("q"), raw);
  }
  assert.equal(context.normalize("HTTPS://Example.com"), "https://example.com/");
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function start(env = {}) {
  let binding, checkOrigin;
  const app = { use() {}, get() {} };
  const express = () => app;
  express.static = () => {};
  const server = {
    listen(port, host, callback) { binding = { port, host }; callback(); },
    address() { return { port: 3000, address: binding.host, family: binding.host.includes(":") ? "IPv6" : "IPv4" }; },
  };
  const modules = {
    http: { createServer: () => server }, path, express, cors: () => {},
    "./proxies/registry": { mountAll() {}, listWithStatus: () => [], startLatencyChecks: origin => checkOrigin = origin },
    "./youtube/routes": {},
    "./auth": { createAuth: () => ({ enabled: false, mount() {}, setBareEndpoints() {} }) },
  };
  const requireMock = name => modules[name];
  requireMock.resolve = require.resolve;
  const file = path.resolve(__dirname, "../server/index.js");
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    require: requireMock, module: { exports: {} }, __dirname: path.dirname(file),
    process: { env }, console: { log() {} },
  });
  return { binding, checkOrigin };
}

test("server defaults to loopback and latency checks use the bound address", () => {
  const { binding, checkOrigin } = start();
  assert.deepEqual(binding, { port: 3000, host: "127.0.0.1" });
  assert.equal(checkOrigin, "http://127.0.0.1:3000");
});

test("explicit IPv4 and IPv6 wildcard bindings retain loopback latency checks", () => {
  for (const [host, loopback] of [["0.0.0.0", "127.0.0.1"], ["::", "[::1]"]]) {
    const { binding, checkOrigin } = start({ HOST: host });
    assert.equal(binding.host, host);
    assert.equal(checkOrigin, `http://${loopback}:3000`);
  }
  assert.equal(start({ HOST: "::1" }).checkOrigin, "http://[::1]:3000");
});

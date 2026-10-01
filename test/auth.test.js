"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createAuth } = require("../server/auth");

test("optional sign-in protects API and proxy paths, and checks WebSocket origin", async () => {
  const auth = createAuth("test-password");
  auth.setBareEndpoints(["/bare/"]);
  const app = express();
  auth.mount(app);
  app.get("/api/private", (_req, res) => res.send("private"));
  app.get("/api/proxies", (req, res) => res.json({ endpoint: auth.bareEndpoint(req, "/bare/") }));
  app.get("/bare/v3/", (_req, res) => res.send("bare transport"));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/private`)).status, 401);
    assert.equal((await fetch(`${origin}/bare/v3/`)).status, 401);
    assert.equal((await fetch(`${origin}/login`)).status, 200);
    const post = (password, headers = {}) => fetch(`${origin}/login`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ password }),
    });
    assert.equal((await post("test-password", { "x-forwarded-for": "203.0.113.7" })).status, 403);
    assert.equal((await post("test-password", { origin: "https://other.example" })).status, 403);
    assert.equal((await post("wrong")).status, 401);
    const signed = await post("test-password");
    assert.equal(signed.status, 303);
    const cookie = signed.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.equal((await fetch(`${origin}/api/private`, { headers: { cookie } })).status, 200);
    const { endpoint } = await (await fetch(`${origin}/api/proxies`, { headers: { cookie } })).json();
    assert.match(endpoint, /^\/bare\/_auth\/[a-f0-9]{64}\/$/);
    assert.equal((await fetch(`${origin}${endpoint}v3/`)).status, 200, "bare transport omits cookies");
    assert.equal((await fetch(`${origin}/bare/_auth/${"0".repeat(64)}/v3/`)).status, 401);
    const upgrade = { url: `${endpoint}v3/`, headers: { upgrade: "websocket", origin, host: new URL(origin).host } };
    assert.equal(auth.rewriteBare(upgrade), true);
    assert.equal(upgrade.url, "/bare/v3/");
    const foreignUpgrade = { url: `${endpoint}v3/`, headers: { upgrade: "websocket", origin: "https://other.example", host: new URL(origin).host } };
    assert.equal(auth.rewriteBare(foreignUpgrade), false);
    assert.equal(auth.authorized({ headers: { cookie, upgrade: "websocket", origin: "https://other.example", host: new URL(origin).host } }), false);
    assert.equal(auth.authorized({ headers: { cookie, upgrade: "websocket", origin, host: new URL(origin).host } }), true);
    const signedOut = await fetch(`${origin}/logout`, { method: "POST", redirect: "manual", headers: { cookie, origin } });
    assert.equal(signedOut.status, 303);
    assert.equal((await fetch(`${origin}/api/private`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${origin}${endpoint}v3/`)).status, 401);
    assert.equal((await fetch(`${origin}${auth.internalBareEndpoint("/bare/")}v3/`)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("behind a reverse proxy on this machine, failed sign-ins are counted per client, so one client cannot lock everyone (the owner included) out", async () => {
  const auth = createAuth("test-password");
  const app = express(); auth.mount(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // What the operator's TLS proxy sends: the connection is from loopback, with the scheme and the client address it saw.
    const post = (password, client) => fetch(`${origin}/login`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https", "x-forwarded-for": client }, body: new URLSearchParams({ password }) });
    for (let i = 0; i < 10; i++) assert.equal((await post("wrong", "203.0.113.9")).status, 401);
    assert.equal((await post("wrong", "203.0.113.9")).status, 429, "the attacker is locked out");
    assert.equal((await post("test-password", "203.0.113.9")).status, 429, "even with the right password while locked out");
    assert.equal((await post("test-password", "198.51.100.4")).status, 303, "the owner, from another address behind the same proxy, can still sign in");
    assert.equal((await post("wrong", "9.9.9.9, 203.0.113.9")).status, 429, "a client-supplied leading address does not give the locked-out client a fresh allowance");
    assert.equal((await post("test-password", "198.51.100.4")).status, 303, "and the owner's success does not reset the attacker's count");
    assert.equal((await post("test-password", "203.0.113.9")).status, 429);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

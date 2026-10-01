"use strict";
const crypto = require("node:crypto");
const express = require("express");
const { clientKey } = require("./client-key");

function createAuth(password = process.env.PRIVAPROXY_PASSWORD) {
  const enabled = typeof password === "string" && password.length > 0;
  const sessions = new Map();
  const bareTokens = new Map();
  // Only the server's latency client receives this process-lifetime credential.
  const internalBareToken = crypto.randomBytes(32).toString("hex");
  let bareEndpoints = [];
  const attempts = new Map();
  const COOKIE = "privaproxy_session";
  const isLoopback = (address) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(address || "");
  const secureRequest = (req) => req.socket.encrypted ||
    (isLoopback(req.socket.remoteAddress) && req.headers["x-forwarded-proto"] === "https");
  const canLogin = (req) => secureRequest(req) || isLoopback(req.socket.remoteAddress) &&
    !req.headers["x-forwarded-for"];
  const validOrigin = (req) => {
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; }
    catch { return false; }
  };
  function sessionToken(req) {
    return /(?:^|;\s*)privaproxy_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || "")?.[1];
  }
  function authorized(req) {
    if (!enabled) return true;
    if (!validOrigin(req)) return false;
    const token = sessionToken(req);
    const session = sessions.get(token);
    if (!session) return false;
    if (session.expiry < Date.now()) {
      sessions.delete(token); bareTokens.delete(session.bareToken); return false;
    }
    return true;
  }
  function setBareEndpoints(endpoints) {
    bareEndpoints = endpoints.filter((p) => typeof p === "string" && /^\/[A-Za-z0-9_-]+\/$/.test(p));
  }
  function bareEndpoint(req, endpoint) {
    if (!enabled || !bareEndpoints.includes(endpoint)) return endpoint;
    const session = sessions.get(sessionToken(req));
    return session ? `${endpoint}_auth/${session.bareToken}/` : endpoint;
  }
  function internalBareEndpoint(endpoint) {
    return enabled && bareEndpoints.includes(endpoint) ? `${endpoint}_auth/${internalBareToken}/` : endpoint;
  }
  function rewriteBare(req) {
    if (!enabled || !validOrigin(req)) return false;
    for (const endpoint of bareEndpoints) {
      const prefix = `${endpoint}_auth/`;
      if (!req.url.startsWith(prefix)) continue;
      const rest = req.url.slice(prefix.length);
      const match = /^([a-f0-9]{64})\/(.*)$/.exec(rest);
      if (!match) return false;
      if (match[1] === internalBareToken) { req.url = endpoint + match[2]; return true; }
      const sessionTokenValue = bareTokens.get(match[1]);
      const session = sessions.get(sessionTokenValue);
      if (!session || session.expiry < Date.now()) return false;
      req.url = endpoint + match[2];
      return true;
    }
    return false;
  }
  function mount(app) {
    if (!enabled) return;
    app.get("/login", (_req, res) => res.type("html").set("Cache-Control", "no-store").send(
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>privaproxy sign in</title><style>body{font:1rem system-ui;background:#16191f;color:#eee;max-width:22rem;margin:12vh auto;padding:1rem}input,button{display:block;width:100%;box-sizing:border-box;padding:.7rem;margin:.7rem 0;font:inherit}</style><h1>privaproxy</h1><form method="post" action="/login"><label>Password<input type="password" name="password" required autocomplete="current-password"></label><button>Sign in</button></form>'
    ));
    app.post("/login", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
      if (!canLogin(req)) return res.status(403).type("text").send("Use HTTPS to sign in from another device.");
      const origin = req.headers.origin;
      if (origin) {
        try { if (new URL(origin).host !== req.headers.host) return res.sendStatus(403); }
        catch { return res.sendStatus(403); }
      }
      const ip = clientKey(req);
      const now = Date.now();
      const state = attempts.get(ip) || { count: 0, since: now };
      if (attempts.size > 1000) attempts.delete(attempts.keys().next().value);
      if (now - state.since > 15 * 60_000) { state.count = 0; state.since = now; }
      if (state.count >= 10) return res.status(429).type("text").send("Too many sign-in attempts. Try later.");
      const supplied = typeof req.body?.password === "string" ? req.body.password : "";
      const a = crypto.createHash("sha256").update(supplied).digest();
      const b = crypto.createHash("sha256").update(password).digest();
      if (!crypto.timingSafeEqual(a, b)) {
        state.count++; attempts.set(ip, state);
        return res.status(401).type("text").send("Invalid password.");
      }
      attempts.delete(ip);
      if (sessions.size >= 100) {
        const oldest = sessions.keys().next().value;
        bareTokens.delete(sessions.get(oldest).bareToken);
        sessions.delete(oldest);
      }
      const token = crypto.randomBytes(32).toString("hex");
      const bareToken = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { expiry: now + 7 * 24 * 60 * 60_000, bareToken });
      bareTokens.set(bareToken, token);
      res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: !!secureRequest(req), path: "/", maxAge: 7 * 24 * 60 * 60_000 });
      res.redirect(303, "/");
    });
    app.post("/logout", (req, res) => {
      if (!authorized(req)) return res.sendStatus(401);
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return res.sendStatus(403); }
        catch { return res.sendStatus(403); }
      }
      const token = sessionToken(req);
      bareTokens.delete(sessions.get(token).bareToken);
      sessions.delete(token);
      res.clearCookie(COOKIE, { path: "/", sameSite: "strict", secure: !!secureRequest(req) });
      res.redirect(303, "/login");
    });
    app.use((req, res, next) => {
      if (rewriteBare(req) || authorized(req)) return next();
      if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/bare")) return res.redirect(303, "/login");
      res.status(401).json({ error: "unauthorized", message: "Sign in first." });
    });
  }
  return { enabled, authorized, bareEndpoint, internalBareEndpoint, rewriteBare, setBareEndpoints, mount };
}
module.exports = { createAuth };

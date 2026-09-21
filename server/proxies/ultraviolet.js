const path = require("path");
const fs = require("fs");
const express = require("express");
const { createBareServer } = require("@tomphttp/bare-server-node");

// Starting with v3, Ultraviolet delegates the actual HTTP fetching to
// bare-mux, which itself needs a SharedWorker script served statically,
// plus a "transport" module that implements the fetch/connect logic.
// We use bare-as-module3, the legacy TompHTTP-compatible transport.
//
// Resolve by joining node_modules directly rather than require.resolve --
// both packages restrict subpath access via "exports" in ways that make
// require.resolve land in the wrong folder (e.g. bare-as-module3's "node"
// condition points at ./lib, not the browser-facing ./dist we need to serve).
const nodeModules = path.join(__dirname, "../../node_modules");
const bareMuxDist = path.join(nodeModules, "@mercuryworkshop/bare-mux/dist");
const bareModDist = path.join(nodeModules, "@mercuryworkshop/bare-as-module3/dist");

const uvDistPath = path.dirname(
  require.resolve("@titaniumnetwork-dev/ultraviolet/package.json")
) + "/dist";

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../config/proxies.json"), "utf-8")
);

// One bare-server-node instance per configured endpoint. The frontend's
// proxy dropdown switches between these at runtime by calling bare-mux's
// setTransport() with a different bareEndpoint -- see public/js/app.js.
// (Currently both entries are local; pointing one at a genuinely remote
// server later is just a matter of hosting a compatible bare server there
// and changing that entry's bareEndpoint to its full URL instead of
// mounting one here.)
const bareServers = config.map((entry) => ({
  ...entry,
  server: createBareServer(entry.bareEndpoint, {
    // By default this rate-limits to 10 concurrent keep-alive connections
    // per IP -- meant to stop abuse on a public deployment, but way too low
    // here: a single page load fires off many parallel sub-requests (HTML,
    // CSS, JS, images...) that all appear to come from the same local
    // address. Raised generously since this is a single-user, local proxy.
    connectionLimiter: {
      maxConnectionsPerIP: 1000,
      windowDuration: 60,
      blockDuration: 10,
    },
  }),
}));

module.exports = {
  id: "uv-local",
  name: "Ultraviolet (built-in)",
  bareServers, // exposed so registry.js can list them + latency.js can test them

  mount(app, server) {
    // Serve our own uv.config.js override FIRST (tells UV where the bare
    // server is). This must come before the dist folder below, because
    // the package ships its own generic uv.config.js (prefix: "/service/")
    // and Express serves whichever static middleware matches the file
    // first — if the dist one were checked first it would shadow ours,
    // and UV's sw.js (which does importScripts('uv.config.js')) would
    // silently load the wrong prefix.
    app.use("/uv/", express.static(path.join(__dirname, "../../public/uv")));

    // Serve Ultraviolet's client bundle (service worker, handler, etc.)
    app.use("/uv/", express.static(uvDistPath));

    // Serve bare-mux's SharedWorker script and the transport module it
    // loads. Required as of Ultraviolet v3 -- without these, uv.sw.js
    // throws while constructing its BareClient because there's no
    // transport connection for it to use.
    app.use("/baremux/", express.static(bareMuxDist));
    app.use("/baremod/", express.static(bareModDist));

    // Route each request to whichever bare server instance actually owns
    // its path (e.g. "/bare/..." vs "/bare2/..."); let anything else fall
    // through to Express normally.
    app.use((req, res, next) => {
      const match = bareServers.find((b) => b.server.shouldRoute(req));
      if (match) return match.server.routeRequest(req, res);
      next();
    });

    // Bare servers also need to intercept WebSocket upgrade requests
    // (used for sites that hold live connections).
    server.on("upgrade", (req, socket, head) => {
      const match = bareServers.find((b) => b.server.shouldRoute(req));
      if (match) match.server.routeUpgrade(req, socket, head);
      else socket.destroy(); // nobody owns this upgrade; don't leave the socket open forever
    });
  },

  async healthCheck() {
    // Local provider, so "healthy" just means the process is up. Per-
    // backend health/latency is handled separately by latency.js.
    return true;
  },
};

const ultraviolet = require("./ultraviolet");
const scramjet = require("./scramjet");
const latency = require("./latency");

// Engines available. Ultraviolet internally manages multiple bare-server
// backends (see ultraviolet.js's `bareServers`); Scramjet has none of its
// own -- it shares whichever backend is currently active via bare-mux.
const providers = [ultraviolet, scramjet];

function mountAll(app, server, auth) {
  for (const provider of providers) {
    provider.mount(app, server, auth);
    console.log(`Mounted proxy provider: ${provider.name} (${provider.id})`);
  }
}

// Kicks off the periodic latency/health checks for every bare backend
// across all providers. Call once, after the server starts listening (it
// needs the server's own origin to test against itself over loopback).
function startLatencyChecks(origin, auth) {
  const entries = providers.flatMap(provider => provider.bareServers || []);
  latency.start(auth?.enabled ? entries.map(entry => ({
    ...entry, bareEndpoint: auth.internalBareEndpoint(entry.bareEndpoint),
  })) : entries, origin);
}

// What the frontend's proxy dropdown renders: one entry per bare backend
// (not per engine) -- currently only Ultraviolet has any.
function listWithStatus() {
  const entries = [];
  for (const provider of providers) {
    for (const b of provider.bareServers || []) {
      const stat = latency.getStatus(b.id);
      entries.push({
        id: b.id,
        name: b.name,
        description: b.description,
        bareEndpoint: b.bareEndpoint,
        online: stat.online,
        latencyMs: stat.latencyMs,
        checkedAt: stat.checkedAt,
      });
    }
  }
  return entries;
}

module.exports = { mountAll, startLatencyChecks, listWithStatus };

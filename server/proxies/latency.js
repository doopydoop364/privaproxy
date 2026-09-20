const path = require("path");

// Reuse the SAME client code the browser uses (bare-as-module3's transport
// class), so a measurement here exercises the exact same request logic a
// real proxied request would -- not a generic ping. We import the raw
// browser bundle file directly rather than the package specifier, because
// the package's "node" export condition points at an unrelated path helper,
// not the actual client class.
const bareClientPath = path.resolve(
  __dirname,
  "../../node_modules/@mercuryworkshop/bare-as-module3/dist/index.mjs"
);

let clientV3Promise = null;
function loadClientV3() {
  if (!clientV3Promise) {
    clientV3Promise = import("file://" + bareClientPath).then((m) => m.default);
  }
  return clientV3Promise;
}

// In-memory cache of the latest measurement per bare endpoint id.
const status = new Map(); // id -> { online, latencyMs, checkedAt }

async function measureOne(entry, origin) {
  try {
    const ClientV3 = await loadClientV3();
    const client = new ClientV3(origin + entry.bareEndpoint);
    await client.init();

    const start = performance.now();
    // We only care whether the round trip through THIS backend completes at
    // all and how long it takes -- even a non-2xx from the test URL still
    // proves the proxy path itself is working, so we don't check res.status.
    await client.request(new URL(entry.testUrl), "GET", null, {}, undefined);
    const latencyMs = Math.round(performance.now() - start);

    status.set(entry.id, { online: true, latencyMs, checkedAt: Date.now() });
  } catch (err) {
    status.set(entry.id, { online: false, latencyMs: null, checkedAt: Date.now() });
  }
}

let started = false;
function start(bareServerEntries, origin, intervalMs = 1000) {
  if (started) return; // only run one set of intervals regardless of how many times this is called
  started = true;

  const runAll = () => {
    bareServerEntries.forEach((entry) => measureOne(entry, origin));
  };
  runAll();
  setInterval(runAll, intervalMs);
}

function getStatus(id) {
  return status.get(id) || { online: null, latencyMs: null, checkedAt: null };
}

module.exports = { start, getStatus };

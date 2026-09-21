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

// How often each backend is checked, and how long one check may take before
// the backend is reported offline. Both can be overridden with environment
// variables (LATENCY_INTERVAL_MS / LATENCY_TIMEOUT_MS).
//
// Why not check more often: every check is a real request to a third-party
// URL from this machine, and every request through a bare server spends a
// point from its per-IP rate limit (see connectionLimiter in ultraviolet.js),
// a budget that real browsing shares with these checks.
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 8000;

// In-memory cache of the latest measurement per bare endpoint id.
const status = new Map(); // id -> { online, latencyMs, checkedAt }

// ids with a check currently running -- at most one per backend at a time.
const inFlight = new Set();

// One timed round trip through THIS backend's real code path. Resolves to the
// latency in ms, or throws. `signal` aborts the request: the bare server
// cancels its upstream connection when the client goes away, so aborting here
// also frees the far side.
async function measureOne(entry, origin, signal) {
  const ClientV3 = await loadClientV3();
  const client = new ClientV3(origin + entry.bareEndpoint);
  await client.init();

  const start = performance.now();
  // We only care whether the round trip through THIS backend completes at
  // all and how long it takes -- even a non-2xx from the test URL still
  // proves the proxy path itself is working, so we don't check res.status.
  await client.request(new URL(entry.testUrl), "GET", null, {}, signal);
  return Math.round(performance.now() - start);
}

// Runs one check and records its outcome.
//
//  - Skipped if the previous check for this backend hasn't finished, so a slow
//    backend never accumulates a pile of overlapping requests.
//  - Bounded by `timeoutMs`: on timeout the request is aborted and the backend
//    is recorded as offline (instead of staying "checking..." forever).
//  - Only the race winner is ever recorded. A measurement that finishes after
//    its timeout is simply never looked at, so a stale result can't overwrite
//    a newer one.
async function checkOne(entry, origin, timeoutMs, measure) {
  if (inFlight.has(entry.id)) return;
  inFlight.add(entry.id);

  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  try {
    const latencyMs = await Promise.race([
      Promise.resolve()
        .then(() => measure(entry, origin, controller.signal))
        .catch(() => null), // any failure (even a synchronous throw) -> offline
      timedOut,
    ]);
    status.set(
      entry.id,
      latencyMs === null
        ? { online: false, latencyMs: null, checkedAt: Date.now() }
        : { online: true, latencyMs, checkedAt: Date.now() }
    );
  } finally {
    clearTimeout(timer);
    inFlight.delete(entry.id);
  }
}

let started = false;
// options: { intervalMs, timeoutMs, measure } (a bare number is taken as
// intervalMs). `measure` exists so tests can substitute a fake measurement.
function start(bareServerEntries, origin, options = {}) {
  if (started) return; // only run one set of intervals regardless of how many times this is called
  started = true;

  const opts = typeof options === "number" ? { intervalMs: options } : options;
  const intervalMs = opts.intervalMs ?? (Number(process.env.LATENCY_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.LATENCY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const measure = opts.measure || measureOne;

  const runAll = () => {
    bareServerEntries.forEach((entry) => checkOne(entry, origin, timeoutMs, measure));
  };
  runAll();
  setInterval(runAll, intervalMs);
}

function getStatus(id) {
  return status.get(id) || { online: null, latencyMs: null, checkedAt: null };
}

module.exports = { start, getStatus };

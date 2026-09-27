const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");

const proxyRegistry = require("./proxies/registry");
const youtubeRoutes = require("./youtube/routes");
const auth = require("./auth").createAuth();
auth.setBareEndpoints(proxyRegistry.listWithStatus().map((entry) => entry.bareEndpoint));

const app = express();
const server = http.createServer(app);

auth.mount(app);
if (!auth.enabled) app.use(cors());

// --- API routes ---
app.get("/api/auth/status", (_req, res) => res.json({ enabled: auth.enabled }));
app.get("/api/proxies", (req, res) => {
  if (auth.enabled) res.set("Cache-Control", "no-store");
  res.json(proxyRegistry.listWithStatus().map((entry) => auth.enabled ? {
    ...entry, bareEndpoint: auth.bareEndpoint(req, entry.bareEndpoint),
  } : entry));
});

app.use("/api/youtube", youtubeRoutes);

// --- Proxy providers (Ultraviolet etc.) mount themselves here ---
proxyRegistry.mountAll(app, server, auth);

// --- hls.js (adaptive YouTube playback), served from node_modules ---
// Joined path, not require.resolve: the package's "exports" map doesn't expose dist/.
app.use("/vendor/hls/", express.static(path.join(__dirname, "../node_modules/hls.js/dist")));

// --- Static frontend ---
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  const address = server.address();
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  console.log(`privaproxy running at http://${host}:${address.port}`);
  // Latency checks hit the server's own bare endpoints over loopback, so
  // this has to start after we're actually listening.
  const loopback = address.family === "IPv6" ? "[::1]" : "127.0.0.1";
  const checkHost = address.address === "0.0.0.0" || address.address === "::" ? loopback : host;
  proxyRegistry.startLatencyChecks(`http://${checkHost}:${address.port}`, auth);
});

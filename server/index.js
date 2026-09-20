const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");

const proxyRegistry = require("./proxies/registry");
const youtubeRoutes = require("./youtube/routes");

const app = express();
const server = http.createServer(app);

app.use(cors());

// --- API routes ---
app.get("/api/proxies", (_req, res) => {
  res.json(proxyRegistry.listWithStatus());
});

app.use("/api/youtube", youtubeRoutes);

// --- Proxy providers (Ultraviolet etc.) mount themselves here ---
proxyRegistry.mountAll(app, server);

// --- hls.js (adaptive YouTube playback), served from node_modules ---
// Joined path, not require.resolve: the package's "exports" map doesn't expose dist/.
app.use("/vendor/hls/", express.static(path.join(__dirname, "../node_modules/hls.js/dist")));

// --- Static frontend ---
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`privaproxy running at http://localhost:${PORT}`);
  // Latency checks hit the server's own bare endpoints over loopback, so
  // this has to start after we're actually listening.
  proxyRegistry.startLatencyChecks(`http://localhost:${PORT}`);
});

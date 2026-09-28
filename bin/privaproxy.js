#!/usr/bin/env node
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { version } = require("../package.json");

const help = `privaproxy ${version} — private browser and YouTube client

Usage: privaproxy [options]

  --port <number>   Listening port (default: PORT or 3000; 0 picks a free port)
  --host <address>  Bind address (default: HOST or 127.0.0.1)
  --ytdlp <path>    yt-dlp executable (default: YTDLP_PATH or yt-dlp on PATH)
  --check          Check runtime and installed assets without starting a server
  --help, -h       Show this help
  --version, -v    Show the app version

Open the printed local URL in your browser. Press Ctrl+C to stop.
Node.js 22+ is required. YouTube also needs yt-dlp; the proxy works without it.
Existing environment settings, including PRIVAPROXY_PASSWORD, are supported.
`;

function options(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: {
    port: { type: "string" }, host: { type: "string" }, ytdlp: { type: "string" },
    check: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  } });
  if (values.help || values.version) return values;
  const port = values.port ?? env.PORT ?? "3000";
  if (!/^\d+$/.test(String(port)) || Number(port) > 65535) throw new Error("Port must be an integer from 0 to 65535.");
  const host = values.host ?? env.HOST ?? "127.0.0.1";
  if (!host || host.startsWith("-") || /[\s/\\\x00-\x1f]/.test(host) || host.length > 253) throw new Error("Host must be an IP address or hostname, without a URL or port.");
  const binary = values.ytdlp ?? env.YTDLP_PATH ?? "yt-dlp";
  if (!binary || binary.startsWith("-") || /[\x00\r\n]/.test(binary)) throw new Error("Specify a valid yt-dlp executable path.");
  return { ...values, port: String(Number(port)), host,
    ytdlp: /[/\\]/.test(binary) ? path.resolve(binary) : binary };
}

function check(binary) {
  console.log(`privaproxy ${version}; Node.js ${process.version}`);
  let ok = true;
  const assets = [
    path.join(__dirname, "../public/index.html"),
    path.join(__dirname, "../server/config/proxies.json"),
    path.join(require("@mercuryworkshop/bare-mux/node").baremuxPath, "worker.js"),
    path.join(require("@mercuryworkshop/bare-as-module3").bareModulePath, "index.mjs"),
    path.join(require("@mercuryworkshop/scramjet/path").scramjetPath, "scramjet.all.js"),
    path.join(path.dirname(require.resolve("hls.js")), "hls.min.js"),
  ];
  for (const asset of assets) if (!fs.existsSync(asset)) { console.error(`Missing installed asset: ${asset}`); ok = false; }
  if (ok) console.log("Frontend and proxy assets: installed");
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10000, maxBuffer: 65536, windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    console.error("yt-dlp could not run. Install yt-dlp, or use --ytdlp /path/to/yt-dlp.");
    ok = false;
  } else console.log(`yt-dlp: ${result.stdout.trim().slice(0, 200)}`);
  return ok;
}

function run(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.help) { console.log(help); return; }
  if (args.version) { console.log(version); return; }
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required.");
  process.env.PORT = args.port;
  process.env.HOST = args.host;
  process.env.YTDLP_PATH = args.ytdlp;
  // This also works when Node is bundled and absent from the user's PATH.
  process.env.YTDLP_JS_RUNTIMES ??= `node:${process.execPath}`;
  if (args.check) { process.exitCode = check(args.ytdlp) ? 0 : 1; return; }
  const { server } = require("../server/index.js");
  server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? `Port ${args.port} is already in use. Try --port with another port.` :
      error.code === "EACCES" ? `Cannot listen on ${args.host}:${args.port}. Try a higher port.` : `Could not start privaproxy: ${error.message}`);
    process.exit(1);
  });
}

if (require.main === module) {
  try { run(); } catch (error) { console.error(`privaproxy: ${error.message}\nUse --help for usage.`); process.exitCode = 1; }
}
module.exports = { options, run };

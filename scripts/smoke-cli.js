"use strict";
// Tests a locally installed CLI or portable launcher, never an external site.
// node scripts/smoke-cli.js /path/to/privaproxy [--without-host-runtimes]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

async function main() {
  const executable = path.resolve(process.argv[2]);
  const isolated = process.argv.includes("--without-host-runtimes");
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "privaproxy-cli-smoke-"));
  let child;
  try {
    const env = { ...process.env, PRIVAPROXY_PASSWORD: "", LATENCY_INTERVAL_MS: "60000", LATENCY_TIMEOUT_MS: "100" };
    if (isolated) {
      const tools = path.join(folder, "tools");
      await fs.mkdir(tools);
      await fs.symlink("/usr/bin/dirname", path.join(tools, "dirname"));
      env.PATH = tools; // No node, npm, Python or yt-dlp available by name.
      delete env.YTDLP_PATH;
      delete env.YTDLP_JS_RUNTIMES;
    }
    child = spawn(executable, ["--host", "127.0.0.1", "--port", "0"], { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; });
    child.stderr.on("data", b => { stderr += b; });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 10000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error(`Launcher stopped: ${stderr}`)); });
      child.stdout.on("data", () => { const match = stdout.match(/running at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    for (const asset of ["/", "/js/app.js", "/js/youtube.js", "/js/ytlearning.js", "/uv/uv.config.js", "/uv/uv.bundle.js", "/uv/uv.sw.js",
      "/baremux/worker.js", "/baremod/index.mjs", "/scramjet/sw.js", "/scramjet/scramjet.all.js", "/scramjet/scramjet.wasm.wasm", "/vendor/hls/hls.min.js"]) {
      const response = await fetch(url + asset);
      assert.equal(response.status, 200, asset);
      await response.body.cancel();
    }
    const status = await fetch(url + "/api/youtube/status").then(async response => ({ code: response.status, body: await response.json() }));
    assert.equal(status.code, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.match(status.body.jsRuntimes[0], /^node:/);
    console.log(`PASS: ${executable} serves all engine/player assets from an unrelated directory.`);
    console.log(`PASS: yt-dlp ${status.body.version} uses the CLI's absolute Node path${isolated ? " with no host runtimes on PATH" : ""}.`);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await fs.rm(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

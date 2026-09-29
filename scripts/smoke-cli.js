"use strict";
// Tests a locally installed CLI or portable launcher, never an external site.
// node scripts/smoke-cli.js /path/to/privaproxy [--without-host-runtimes]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { launchSpec, stopChild } = require("./process-utils");
const exec = promisify(execFile);

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
      if (process.platform !== "win32") await fs.symlink("/usr/bin/dirname", path.join(tools, "dirname"));
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
      env.PATH = tools; // No node, npm, Python or yt-dlp available by name.
      delete env.YTDLP_PATH;
      delete env.YTDLP_JS_RUNTIMES;
    }
    for (const flag of ["--version", "--check"]) {
      const spec = launchSpec(executable, [flag]);
      const result = await exec(spec.file, spec.args, { ...spec.options, cwd: folder, env, timeout: 30000 });
      assert.ok(result.stdout.trim(), `Launcher returned no output for ${flag}`);
    }
    const invalid = launchSpec(executable, ["--port", "invalid"]);
    await assert.rejects(exec(invalid.file, invalid.args, { ...invalid.options, cwd: folder, env, timeout: 10000 }), error =>
      error.code === 1 && /Port must be/.test(error.stderr), "Launcher did not preserve the CLI's failure exit code");
    const spec = launchSpec(executable, ["--host", "127.0.0.1", "--port", "0"]);
    child = spawn(spec.file, spec.args, { ...spec.options, cwd: folder, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; });
    child.stderr.on("data", b => { stderr += b; });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 10000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error(`Launcher stopped: ${stderr}`)); });
      child.stdout.on("data", () => { const match = stdout.match(/running at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const occupied = launchSpec(executable, ["--host", "127.0.0.1", "--port", new URL(url).port]);
    await assert.rejects(exec(occupied.file, occupied.args, { ...occupied.options, cwd: folder, env, timeout: 10000 }), error =>
      error.code === 1 && /already in use/.test(error.stderr), "Occupied port did not produce the expected CLI error");
    for (const asset of ["/", "/js/app.js", "/js/youtube.js", "/js/ytlearning.js", "/uv/uv.config.js", "/uv/uv.bundle.js", "/uv/uv.sw.js",
      "/baremux/worker.js", "/baremod/index.mjs", "/scramjet/sw.js", "/scramjet/scramjet.all.js", "/scramjet/scramjet.wasm.wasm", "/vendor/hls/hls.min.js"]) {
      const response = await fetch(url + asset, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, asset);
      await response.body.cancel();
    }
    const status = await fetch(url + "/api/youtube/status", { signal: AbortSignal.timeout(30000) }).then(async response => ({ code: response.status, body: await response.json() }));
    assert.equal(status.code, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.match(status.body.jsRuntimes[0], /^node:/);
    console.log(`PASS: ${executable} serves all engine/player assets from an unrelated directory.`);
    console.log(`PASS: yt-dlp ${status.body.version} uses the CLI's absolute Node path${isolated ? " with no host runtimes on PATH" : ""}.`);
    await stopChild(child);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }), "Server remained reachable after stopping its process tree");
    console.log("PASS: stopping the launcher closes its server.");
  } finally {
    await stopChild(child);
    await fs.rm(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

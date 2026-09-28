"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { options } = require("../bin/privaproxy");
const CLI = path.resolve(__dirname, "../bin/privaproxy.js");

test("CLI validates bind options and preserves environment defaults", () => {
  assert.deepEqual(options([], {}), { port: "3000", host: "127.0.0.1", ytdlp: "yt-dlp" });
  assert.equal(options(["--port", "0", "--host", "::1"], { PORT: "8080", HOST: "0.0.0.0" }).port, "0");
  assert.equal(options([], { PORT: "8080", YTDLP_PATH: "tools/yt-dlp" }).ytdlp, path.resolve("tools/yt-dlp"));
  for (const value of ["-1", "65536", "1.5", "Infinity", "3000/path", ""]) assert.throws(() => options(["--port", value], {}));
  for (const value of ["", "http://localhost", "a\nb", "--inspect"]) assert.throws(() => options(["--host", value], {}));
  assert.throws(() => options(["--unknown"], {}));
  assert.throws(() => options(["extra"], {}));
  assert.throws(() => options(["--ytdlp", "--shell"], {}));
});

test("CLI help and version work without starting the server or requiring yt-dlp", () => {
  for (const flag of ["--help", "-h", "--version", "-v"]) {
    const result = spawnSync(process.execPath, [CLI, flag], { cwd: path.parse(process.cwd()).root, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(require("../package.json").version.replace(/\./g, "\\.")));
    assert.doesNotMatch(result.stdout, /Mounted proxy|running at/);
  }
});

test("CLI rejects invalid arguments before mounting providers", () => {
  const result = spawnSync(process.execPath, [CLI, "--port", "wat"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Port must be/);
  assert.doesNotMatch(result.stdout, /Mounted proxy/);
});

test("CLI check reports a missing yt-dlp without starting a server", () => {
  const result = spawnSync(process.execPath, [CLI, "--check", "--ytdlp", path.join(__dirname, "missing-ytdlp")], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Frontend and proxy assets: installed/);
  assert.match(result.stderr, /yt-dlp could not run/);
  assert.doesNotMatch(result.stdout, /running at/);
});

test("CLI starts from an unrelated directory and reports the actual ephemeral port", async t => {
  const child = spawn(process.execPath, [CLI, "--port", "0", "--host", "127.0.0.1"], { cwd: path.parse(process.cwd()).root,
    env: { ...process.env, PRIVAPROXY_PASSWORD: "", LATENCY_INTERVAL_MS: "60000", LATENCY_TIMEOUT_MS: "100" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const url = await Promise.race([
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${stderr}`)), 5000);
      timer.unref();
      child.stdout.on("data", () => { const match = stdout.match(/running at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.on("exit", () => { clearTimeout(timer); reject(new Error(`CLI stopped: ${stderr}`)); });
    }),
  ]);
  for (const asset of ["/", "/baremux/worker.js", "/baremod/index.mjs", "/scramjet/scramjet.all.js", "/vendor/hls/hls.min.js"]) {
    const response = await fetch(url + asset);
    assert.equal(response.status, 200, asset);
    await response.body.cancel();
  }
  child.kill(); await once(child, "exit");
});

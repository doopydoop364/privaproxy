"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { target, launcherScript, validateArchivePaths, checksum, download } = require("../scripts/build-portable");
const { launchSpec } = require("../scripts/process-utils");

test("portable targets use standalone yt-dlp binaries rather than Python scripts", () => {
  assert.equal(target("linux", "x64").ytAsset, "yt-dlp_linux");
  assert.equal(target("linux", "arm64").ytAsset, "yt-dlp_linux_aarch64");
  assert.equal(target("darwin", "arm64").ytAsset, "yt-dlp_macos");
  assert.equal(target("win32", "x64").ytAsset, "yt-dlp.exe");
  assert.equal(target("win32", "arm64").ytAsset, "yt-dlp_arm64.exe");
  assert.equal(target("win32", "x64").archiveExtension, "zip");
  assert.equal(target("win32", "x64").nodeRelative, "node.exe");
  assert.equal(target("win32", "x64").npmRelative, "node_modules/npm/bin/npm-cli.js");
  assert.throws(() => target("freebsd", "x64"), /currently support/);
  assert.throws(() => target("linux", "ia32"), /currently support/);
});

test("Windows smoke commands quote spaces/metacharacters without exposing request inputs to a shell", () => {
  const file = "C:\\portable build & test!\\privaproxy.cmd";
  const spec = launchSpec(file, ["--port", "0"], "win32");
  assert.match(spec.file, /\\cmd\.exe$/);
  assert.equal(spec.args[3], `""${file}" "--port" "0""`);
  assert.equal(spec.options.windowsVerbatimArguments, true);
  for (const bad of ['bad"path.cmd', "bad%PATH%.cmd", "bad\npath.cmd"]) assert.throws(() => launchSpec(bad, [], "win32"));
  assert.deepEqual(launchSpec("node.exe", ["script.js"], "win32"), { file: "node.exe", args: ["script.js"], options: {} });
  assert.match(launcherScript("win32"), /DisableDelayedExpansion\r\n/);
  assert.match(launcherScript("win32"), /exit \/b %errorlevel%\r\n$/);
});

test("ZIP/tar entry validation accepts CRLF listings and rejects escaping paths", () => {
  validateArchivePaths("node-root/\r\nnode-root/node.exe\r\nnode-root/node_modules/npm/\r\n", "node-root");
  for (const entry of ["", "../evil", "/node-root/file", "node-root/../../evil", "node-root\\file", "node-root-other/file", "C:/node-root/file"]) {
    assert.throws(() => validateArchivePaths(entry, "node-root"));
  }
});

test("runtime checksum lookup requires an exact filename and valid SHA-256", () => {
  const hash = "a".repeat(64);
  assert.equal(checksum(`${hash}  node.tar.gz\n${"b".repeat(64)} *other.tar.gz`, "node.tar.gz"), hash);
  assert.throws(() => checksum(`${hash} node.tar.gz.old`, "node.tar.gz"));
  assert.throws(() => checksum("invalid node.tar.gz", "node.tar.gz"));
});

test("runtime downloads verify bytes, reject changed content and bound response sizes", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "privaproxy-download-test-"));
  const server = http.createServer((_req, res) => res.end("runtime fixture"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await fs.rm(folder, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const hash = createHash("sha256").update("runtime fixture").digest("hex");
  assert.equal(await download(url, path.join(folder, "valid"), hash), hash);
  await assert.rejects(download(url, path.join(folder, "bad"), "0".repeat(64)), /verification failed/);
  await assert.rejects(download(url, path.join(folder, "oversize"), hash, 2), /size limit/);
});

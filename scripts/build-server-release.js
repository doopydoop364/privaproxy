"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

async function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return exec(process.execPath, [npmCli, ...args], options);
  return exec(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  if (process.platform === "win32") throw new Error("Managed server releases are built on Unix-like systems.");
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid package version.");

  const output = path.join(ROOT, "dist", "server");
  await fs.mkdir(output, { recursive: true });
  const archive = path.join(output, `privaproxy-${pkg.version}.tar.gz`);
  const sums = path.join(output, "SHA256SUMS.txt");
  await fs.rm(archive, { force: true });
  await fs.rm(sums, { force: true });

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "privaproxy-server-release-"));
  try {
    const packed = await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
    const metadata = JSON.parse(packed.stdout);
    const item = Array.isArray(metadata) ? metadata[0] : Object.values(metadata)[0];
    if (!item || path.basename(item.filename) !== item.filename) throw new Error("Unexpected npm pack output.");

    await exec("tar", ["-xzf", path.join(temp, item.filename), "-C", temp]);
    const releaseName = `privaproxy-${pkg.version}`;
    const releaseRoot = path.join(temp, releaseName);
    await fs.rename(path.join(temp, "package"), releaseRoot);
    await fs.copyFile(path.join(ROOT, "package-lock.json"), path.join(releaseRoot, "package-lock.json"));

    for (const required of [
      "package.json",
      "package-lock.json",
      "bin/privaproxy.js",
      "deploy/systemd/privaproxy.service",
      "deploy/env/privaproxy.env.example",
      "deploy/install/install-server.sh",
    ]) {
      const stat = await fs.stat(path.join(releaseRoot, required));
      if (!stat.isFile()) throw new Error(`Missing server-release file: ${required}`);
    }

    await exec("tar", ["-czf", archive, "-C", temp, releaseName]);
    const digest = await sha256(archive);
    await fs.writeFile(sums, `${digest}  ${path.basename(archive)}\n`, "ascii");
    console.log(`Server release ready: ${archive}`);
    console.log(`Checksum manifest: ${sums}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Managed server release failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, sha256 };

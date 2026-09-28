"use strict";
// Creates a local portable folder. Publishing is a separate, manual operation.
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFile } = require("node:child_process");
const { promisify, parseArgs } = require("node:util");
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const NODE_VERSION = "24.21.0";
const MAX_DOWNLOAD = 180 * 1024 * 1024;

function target(platform = process.platform, arch = process.arch) {
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error("Portable builds currently support Linux/macOS x64 and arm64. Build on the target OS and architecture.");
  }
  return { platform, arch, ytAsset: platform === "darwin" ? "yt-dlp_macos" : arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux" };
}

function checksum(text, filename) {
  const entry = String(text).split(/\r?\n/).map(line => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).find(m => m && m[2] === filename);
  if (!entry) throw new Error(`No official SHA-256 checksum for ${filename}.`);
  return entry[1].toLowerCase();
}

async function download(url, filename, expectedHash, limit = MAX_DOWNLOAD) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000), headers: { "User-Agent": "privaproxy-portable-builder" } });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Download returned ${res.status}: ${url}`); }
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(Readable.fromWeb(res.body), new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > limit) return done(new Error("Runtime download exceeded its size limit."));
    hash.update(chunk); done(null, chunk);
  } }), createWriteStream(filename, { flags: "wx" }));
  const actual = hash.digest("hex");
  if (expectedHash && actual !== expectedHash) throw new Error(`SHA-256 verification failed for ${path.basename(filename)}.`);
  return actual;
}

async function textDownload(url, folder, name) {
  const file = path.join(folder, name);
  await download(url, file, null, 4 * 1024 * 1024);
  return fs.readFile(file, "utf8");
}

async function extract(archive, folder, prefix) {
  const { stdout } = await exec("tar", ["-tzf", archive], { maxBuffer: 8 * 1024 * 1024 });
  for (const name of stdout.trim().split("\n")) {
    if (!name.startsWith(`${prefix}/`) || name.includes("\\") || name.split("/").includes("..")) throw new Error("Unsafe runtime archive path.");
  }
  await exec("tar", ["-xzf", archive, "-C", folder], { maxBuffer: 8 * 1024 * 1024 });
}

async function build(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    output: { type: "string" }, "node-version": { type: "string", default: NODE_VERSION },
    "ytdlp-version": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: npm run build:portable -- [--output <new-folder>] [--node-version <version>] [--ytdlp-version <release-tag>]\nDownloads official runtimes, verifies SHA-256 checksums, and installs locked production dependencies.\nRequires Node.js 22+, npm, tar and network access on the target Linux/macOS system.");
    return;
  }
  const t = target();
  const nodeVersion = values["node-version"];
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion) || Number(nodeVersion.split(".")[0]) < 22) throw new Error("Use a stable Node.js version >=22, such as 24.21.0.");
  if (values["ytdlp-version"] && !/^\d{4}\.\d{2}\.\d{2}$/.test(values["ytdlp-version"])) throw new Error("Use a stable yt-dlp release tag (YYYY.MM.DD).");
  const output = path.resolve(values.output || path.join(ROOT, "dist", `privaproxy-${t.platform}-${t.arch}`));
  // Never replace an existing folder; it may contain a user's unrelated files.
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "privaproxy-build-"));
  try {
    console.log(`Building ${t.platform}-${t.arch} in ${output}`);
    const nodeName = `node-v${nodeVersion}-${t.platform}-${t.arch}`;
    const nodeArchive = `${nodeName}.tar.gz`;
    const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`;
    const sums = await textDownload(`${nodeBase}/SHASUMS256.txt`, temporary, "node-checksums.txt");
    const nodeHash = checksum(sums, nodeArchive);
    console.log(`Downloading and verifying Node.js ${nodeVersion}…`);
    await download(`${nodeBase}/${nodeArchive}`, path.join(temporary, nodeArchive), nodeHash);
    await extract(path.join(temporary, nodeArchive), temporary, nodeName);

    let ytVersion = values["ytdlp-version"];
    if (!ytVersion) {
      const release = JSON.parse(await textDownload("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", temporary, "yt-release.json"));
      ytVersion = release.tag_name;
    }
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(ytVersion)) throw new Error("Unexpected yt-dlp release tag.");
    const ytBase = `https://github.com/yt-dlp/yt-dlp/releases/download/${ytVersion}`;
    const ytSums = await textDownload(`${ytBase}/SHA2-256SUMS`, temporary, "yt-checksums.txt");
    const ytHash = checksum(ytSums, t.ytAsset);
    const runtime = path.join(output, "runtime");
    await fs.mkdir(runtime);
    await fs.copyFile(path.join(temporary, nodeName, "bin/node"), path.join(runtime, "node"));
    console.log(`Downloading and verifying standalone yt-dlp ${ytVersion}…`);
    await download(`${ytBase}/${t.ytAsset}`, path.join(runtime, "yt-dlp"), ytHash);
    await fs.chmod(path.join(runtime, "node"), 0o755);
    await fs.chmod(path.join(runtime, "yt-dlp"), 0o755);

    const cache = path.join(temporary, "npm-cache");
    const npmArgs = ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary, "--cache", cache];
    const packed = process.env.npm_execpath ? await exec(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd: ROOT }) : await exec("npm", npmArgs, { cwd: ROOT });
    const metadata = JSON.parse(packed.stdout);
    const pkg = Array.isArray(metadata) ? metadata[0] : Object.values(metadata)[0];
    if (!pkg || path.basename(pkg.filename) !== pkg.filename) throw new Error("Unexpected npm package filename.");
    await extract(path.join(temporary, pkg.filename), temporary, "package");
    const app = path.join(output, "app");
    await fs.rename(path.join(temporary, "package"), app);
    await fs.copyFile(path.join(ROOT, "package-lock.json"), path.join(app, "package-lock.json"));
    console.log("Installing locked production dependencies (installation scripts disabled)…");
    await exec(path.join(runtime, "node"), [path.join(temporary, nodeName, "lib/node_modules/npm/bin/npm-cli.js"), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache],
      { cwd: app, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });

    const notices = path.join(output, "licenses");
    await fs.mkdir(notices);
    await fs.copyFile(path.join(temporary, nodeName, "LICENSE"), path.join(notices, "NODE-LICENSE"));
    await textDownload(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${ytVersion}/LICENSE`, notices, "YTDLP-LICENSE");
    await textDownload(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${ytVersion}/THIRD_PARTY_LICENSES.txt`, notices, "YTDLP-THIRD-PARTY-LICENSES.txt");
    // Keep component identity, checksums and licensing metadata with the artifact.
    const lock = JSON.parse(await fs.readFile(path.join(app, "package-lock.json"), "utf8"));
    const packages = Object.entries(lock.packages).filter(([name, p]) => name && !p.dev).map(([name, p]) => ({ name, version: p.version, license: p.license, resolved: p.resolved, integrity: p.integrity }));
    await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify({ version: require("../package.json").version, ...t,
      node: { version: nodeVersion, archive: nodeArchive, sha256: nodeHash, source: `${nodeBase}/node-v${nodeVersion}.tar.gz` },
      ytdlp: { version: ytVersion, asset: t.ytAsset, sha256: ytHash, source: `${ytBase}/yt-dlp.tar.gz` }, packages }, null, 2) + "\n");
    await fs.writeFile(path.join(output, "privaproxy"), `#!/bin/sh\nset -eu\nPRIVAPROXY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport YTDLP_PATH="\${YTDLP_PATH:-$PRIVAPROXY_DIR/runtime/yt-dlp}"\nexec "$PRIVAPROXY_DIR/runtime/node" "$PRIVAPROXY_DIR/app/bin/privaproxy.js" "$@"\n`, { mode: 0o755 });
    await fs.writeFile(path.join(output, "README.txt"), "Run ./privaproxy, then open the printed local URL. No Node.js, npm, Python or yt-dlp installation is needed.\nUse ./privaproxy --check to verify the bundled runtime. This build is for the OS/architecture in manifest.json.\nKeep the complete folder together. To use the plain command, add this folder to PATH.\nRuntime/dependency notices are in licenses/ and app/node_modules/. yt-dlp standalone components include GPLv3+ code; consult the upstream distribution terms and provide corresponding sources when redistributing.\nNo auto-update or external publication occurs. Build a new folder to update; browser-local data is unaffected at the same origin.\n");
    const verified = await exec(path.join(output, "privaproxy"), ["--check"], { cwd: temporary, timeout: 30000 });
    console.log(verified.stdout.trim());
    console.log(`Portable build ready: ${output}\nLaunch: ${path.join(output, "privaproxy")}`);
  } catch (error) {
    throw new Error(`${error.message}\nThe incomplete folder remains at ${output}; choose a new output folder when retrying.`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) build().catch(error => { console.error(`Portable build failed: ${error.message}`); process.exitCode = 1; });
module.exports = { target, checksum, download, build };

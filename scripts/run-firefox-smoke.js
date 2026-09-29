"use strict";
// Starts an isolated headless Firefox, runs the local fixture checks, then cleans up.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { stopChild } = require("./process-utils");

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "privaproxy-firefox-"));
  const executable = process.env.FIREFOX_PATH || (process.platform === "win32"
    ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Mozilla Firefox", "firefox.exe") : "firefox");
  let browser, checks;
  try {
    browser = spawn(executable, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = await new Promise((resolve, reject) => {
      let log = "";
      const timer = setTimeout(() => reject(new Error(`Firefox startup timed out: ${log}`)), 30000);
      const read = chunk => {
        log = (log + chunk).slice(-8192);
        const match = log.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1].replace(/\/$/, "") + (match[1].endsWith("/session") ? "" : "/session")); }
      };
      browser.stdout.on("data", read); browser.stderr.on("data", read);
      browser.on("error", error => { clearTimeout(timer); reject(error); });
      browser.on("exit", () => { clearTimeout(timer); reject(new Error(`Firefox stopped: ${log}`)); });
    });
    const args = [path.join(__dirname, "smoke-firefox.js"), endpoint];
    if (process.argv[2]) args.push(path.resolve(process.argv[2]));
    checks = spawn(process.execPath, args, { stdio: "inherit" });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Firefox checks timed out.")), 180000);
      checks.on("error", error => { clearTimeout(timer); reject(error); });
      checks.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Firefox checks exited ${code}`)); });
    });
  } finally {
    await stopChild(checks);
    await stopChild(browser);
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

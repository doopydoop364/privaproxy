"use strict";
const path = require("node:path");
const { execFile } = require("node:child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");
const exec = promisify(execFile);

// Used only by local verification scripts, never for remote/user request inputs.
function launchSpec(file, args, platform = process.platform) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { file, args, options: {} };
  for (const value of [file, ...args]) {
    if (/["%\r\n]/.test(value)) throw new Error("Unsupported quote, percent sign or newline in smoke-test command.");
  }
  const cmd = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const command = `"${[file, ...args].map(value => `"${value}"`).join(" ")}"`;
  return { file: cmd, args: ["/d", "/s", "/c", command], options: { windowsVerbatimArguments: true } };
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (process.platform === "win32") {
    // Killing cmd.exe alone can orphan the Node server; terminate our own tree.
    const taskkill = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    await exec(taskkill, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(error => {
      if (child.exitCode === null && child.signalCode === null) throw error;
    });
  } else child.kill();
  await closed;
}

module.exports = { launchSpec, stopChild };

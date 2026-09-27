"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const path = require("path");

function harness(env = {}) {
  const file = path.resolve(__dirname, "../server/youtube/ytdlp.js");
  const realRequire = createRequire(file);
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null));
    };
    children.push(child);
    return child;
  };
  const context = vm.createContext({
    require: name => name === "child_process" ? { spawn } : realRequire(name),
    module: { exports: {} }, Buffer, setTimeout, clearTimeout,
    process: { env: { YTDLP_CONCURRENCY: "1", YTDLP_MAX_QUEUE: "2", ...env } },
  });
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const finish = (child, id) => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({ id, title: id, formats: [] })));
    child.emit("close", 0);
  };
  return { yt: context.module.exports, children, finish };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const A = "aaaaaaaaaaa", B = "bbbbbbbbbbb", C = "ccccccccccc", D = "ddddddddddd";

test("yt-dlp caps waiting jobs and releases slots to queued work", async () => {
  const { yt, children, finish } = harness();
  const a = yt.getVideo(A), b = yt.getVideo(B), c = yt.getVideo(C);
  await assert.rejects(yt.getVideo(D), err => err.code === "busy");
  assert.equal(children.length, 1);
  finish(children[0], A);
  await a; await tick();
  finish(children[1], B);
  await b; await tick();
  finish(children[2], C);
  await c;
});

test("yt-dlp waiting jobs expire without spawning a process", async () => {
  const { yt, children, finish } = harness({ YTDLP_QUEUE_TIMEOUT_MS: "20" });
  const active = yt.getVideo(A);
  await assert.rejects(yt.getVideo(B), err => err.code === "busy");
  finish(children[0], A);
  await active; await tick();
  assert.equal(children.length, 1);
});

test("disconnected requests are removed from the yt-dlp queue", async () => {
  const { yt, children, finish } = harness();
  const active = yt.getVideo(A);
  const ac = new AbortController();
  const queued = yt.withSignal(ac.signal, () => yt.getVideo(B));
  await tick();
  const rejected = assert.rejects(queued, err => err.name === "AbortError");
  ac.abort();
  await rejected;
  finish(children[0], A);
  await active; await tick();
  assert.equal(children.length, 1);
});

test("one disconnected subscriber cannot cancel a shared video lookup", async () => {
  const { yt, children, finish } = harness();
  const ac = new AbortController();
  const first = yt.withSignal(ac.signal, () => yt.getVideo(A));
  const second = yt.getVideo(A);
  await tick();
  const rejected = assert.rejects(first, err => err.name === "AbortError");
  ac.abort(); await rejected;
  assert.equal(children[0].killed, undefined);
  finish(children[0], A);
  assert.equal((await second).id, A);
  assert.equal(children.length, 1);
});

test("abandoning the last subscriber kills its process and permits a fresh lookup", async () => {
  const { yt, children, finish } = harness();
  const ac = new AbortController();
  const first = yt.withSignal(ac.signal, () => yt.getVideo(A));
  await tick();
  const rejected = assert.rejects(first, err => err.name === "AbortError");
  ac.abort(); await rejected; await tick();
  assert.equal(children[0].killed, true);
  const next = yt.getVideo(A);
  await tick();
  finish(children[1], A);
  assert.equal((await next).id, A);
});

test("already-disconnected requests do not start orphaned work", async () => {
  const { yt, children } = harness();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(yt.withSignal(ac.signal, () => yt.getVideo(A)), err => err.name === "AbortError");
  await tick();
  assert.equal(children.length, 0);
});

test("shared upload-date batches remain active for their remaining subscribers", async () => {
  const { yt, children } = harness();
  const ac = new AbortController();
  const first = yt.withSignal(ac.signal, () => yt.uploadDates([A, B]));
  const second = yt.uploadDates([B]);
  await tick();
  const rejected = assert.rejects(first, err => err.name === "AbortError");
  ac.abort(); await rejected;
  assert.equal(children[0].killed, undefined);
  children[0].stdout.emit("data", Buffer.from(`${A}|1700000000|20231114\n${B}|1700000001|20231114\n`));
  children[0].emit("close", 0);
  assert.equal((await second)[B], 1700000001);
  assert.equal(children.length, 1);
});

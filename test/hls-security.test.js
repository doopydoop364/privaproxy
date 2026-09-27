"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("dns");
const https = require("https");
const { PassThrough } = require("stream");
const { EventEmitter } = require("events");
const hls = require("../server/youtube/hls");
const upstream = require("../server/youtube/hlsUpstream");
const thumbnail = require("../server/youtube/thumbnail");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");

test("HLS rejects private hosts, foreign hosts, credentials and non-HTTPS URLs", () => {
  for (const url of [
    "http://127.0.0.1/private", "https://[::1]/private", "https://localhost/seg.ts",
    "https://10.0.0.1/seg.ts", "https://googlevideo.com.evil.test/seg.ts",
    "https://evil.test/seg.ts", "http://r1.googlevideo.com/seg.ts",
    "https://user:pass@r1.googlevideo.com/seg.ts", "https://r1.googlevideo.com:9000/seg.ts",
  ]) {
    assert.throws(() => hls.register(url, {}), hls.PlaylistError, url);
    assert.throws(() => hls.rewritePlaylist(`#EXTM3U\n${url}`, "https://manifest.googlevideo.com/m.m3u8", {}), hls.PlaylistError, url);
  }
});

test("HLS only connects to public IPv4 and IPv6 addresses", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"])
    assert.equal(upstream.isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "142.250.1.1", "2607:f8b0:4005:809::200e"])
    assert.equal(upstream.isPublicAddress(ip), true, ip);
});

test("HLS validates redirects and DNS inside the connection lookup", async () => {
  const savedGet = https.get, savedLookup = dns.lookup;
  let address = "142.250.1.1", redirect, redirectOnce = false, calls = 0;
  const ranges = [];
  dns.lookup = (_host, _options, callback) => callback(null, [{ address, family: 4 }]);
  https.get = (url, options, callback) => {
    calls++;
    ranges.push(options.headers.Range);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    queueMicrotask(() => options.lookup(url.hostname, { all: true }, (err) => {
      if (err) return req.emit("error", err);
      const res = new PassThrough();
      res.statusCode = redirect ? 302 : options.headers.Range ? 206 : 200;
      res.headers = redirect ? { location: redirect } : { "content-type": "video/mp2t", "content-range": "bytes 10-16/100" };
      if (redirectOnce) { redirect = undefined; redirectOnce = false; }
      callback(res);
      res.end("segment");
    }));
    return req;
  };
  try {
    const up = await hls.fetchHls("https://r1.googlevideo.com/seg.ts");
    assert.equal(up.status, 200);
    await up.body.cancel();
    redirect = "https://r2.googlevideo.com/seg.ts";
    redirectOnce = true;
    ranges.length = 0;
    const partial = await hls.fetchHls("https://r1.googlevideo.com/seg.ts", { headers: { Range: "bytes=10-16" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.url, "https://r2.googlevideo.com/seg.ts");
    assert.equal(partial.headers.get("content-range"), "bytes 10-16/100");
    assert.deepEqual(ranges, ["bytes=10-16", "bytes=10-16"]);
    assert.equal(await new Response(partial.body).text(), "segment");
    for (redirect of ["http://127.0.0.1/private", "https://evil.test/seg.ts"]) {
      calls = 0;
      await assert.rejects(hls.fetchHls("https://r1.googlevideo.com/seg.ts"), hls.PlaylistError);
      assert.equal(calls, 1, "the rejected redirect was never requested");
    }
    redirect = undefined;
    address = "127.0.0.1";
    await assert.rejects(hls.fetchHls("https://r1.googlevideo.com/seg.ts"), hls.PlaylistError);
    address = "142.250.1.1";
    redirect = "/loop";
    calls = 0;
    await assert.rejects(hls.fetchHls("https://r1.googlevideo.com/seg.ts"), hls.PlaylistError);
    assert.equal(calls, 6, "redirect loops are bounded");
  } finally {
    https.get = savedGet;
    dns.lookup = savedLookup;
  }
});

test("HLS times out connections stalled before a socket is available", async () => {
  let expire, idleTimeout;
  const request = new EventEmitter();
  request.setTimeout = (_ms, callback) => { idleTimeout = callback; };
  request.destroy = error => request.emit("error", error);
  const file = path.resolve(__dirname, "../server/youtube/hlsUpstream.js");
  const realRequire = createRequire(file);
  const context = vm.createContext({
    require: name => name === "https" ? { get: () => request } : realRequire(name),
    module: { exports: {} }, URL, Headers, clearTimeout() {},
    setTimeout: fn => { expire = fn; return { unref() {} }; },
  });
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const pending = context.module.exports.fetchHls("https://r1.googlevideo.com/file");
  assert.equal(typeof idleTimeout, "function");
  const rejected = assert.rejects(pending, /timed out/);
  expire();
  await rejected;
});

test("thumbnail fetch uses a fixed host, rejects private DNS, and caps response size", async () => {
  const savedGet = https.get, savedLookup = dns.lookup;
  let address = "142.250.1.1", calls = 0, bytes = "image", type = "image/jpeg";
  dns.lookup = (_host, _options, callback) => callback(null, [{ address, family: 4 }]);
  https.get = (url, options, callback) => {
    calls++;
    assert.equal(url.hostname, "i.ytimg.com");
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = err => req.emit("error", err);
    queueMicrotask(() => options.lookup(url.hostname, { all: true }, err => {
      if (err) return req.emit("error", err);
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = { "content-type": type, "content-length": String(bytes.length) };
      callback(res);
      res.end(bytes);
    }));
    return req;
  };
  try {
    assert.equal(await thumbnail.fetchThumbnail("invalid", "mqdefault"), null);
    assert.equal(await thumbnail.fetchThumbnail("aaaaaaaaaaa", "bad"), null);
    assert.equal(calls, 0);
    assert.equal((await thumbnail.fetchThumbnail("aaaaaaaaaaa", "mqdefault")).body.toString(), "image");
    address = "127.0.0.1";
    await assert.rejects(thumbnail.fetchThumbnail("aaaaaaaaaaa", "mqdefault"));
    address = "142.250.1.1";
    type = "text/html";
    await assert.rejects(thumbnail.fetchThumbnail("aaaaaaaaaaa", "mqdefault"), /not an image/);
    type = "image/jpeg";
    bytes = "x".repeat(2 * 1024 * 1024 + 1);
    await assert.rejects(thumbnail.fetchThumbnail("aaaaaaaaaaa", "mqdefault"), /too large/);
  } finally {
    https.get = savedGet;
    dns.lookup = savedLookup;
  }
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readCapped } = require("../server/youtube/upstream");
const sb = require("../server/youtube/sponsorblock");
const express = require("express");
const yt = require("../server/youtube/ytdlp");
const routes = require("../server/youtube/routes");

test("capped reads cancel oversized bodies before reading their advertised size", async () => {
  let canceled = false;
  const up = new Response(new ReadableStream({ cancel() { canceled = true; } }), {
    headers: { "content-length": "1000" },
  });
  assert.equal(await readCapped(up, 10), null);
  assert.equal(canceled, true);
});

test("capped reads stop chunked responses at the limit and preserve small bodies", async () => {
  let chunks = 0, canceled = false;
  const up = new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { canceled = true; },
  }));
  assert.equal(await readCapped(up, 2048), null);
  assert.equal(canceled, true);
  assert.ok(chunks < 30, "did not buffer the unbounded source");
  assert.equal((await readCapped(new Response("WEBVTT\n"), 20)).toString(), "WEBVTT\n");
});

test("SponsorBlock enforces its limit while streaming and cancels unused error bodies", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let canceled = false;
  global.fetch = async () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(256 * 1024)); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(sb.segmentsFor("limitvideo1"), /too large/);
  assert.equal(canceled, true);
  for (const status of [404, 503]) {
    canceled = false;
    global.fetch = async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { status });
    if (status === 404) assert.deepEqual(await sb.segmentsFor("emptyvideo1"), []);
    else await assert.rejects(sb.segmentsFor("errorvideo1"), /503/);
    assert.equal(canceled, true);
  }
});

test("channel images accept valid content types with parameters", async t => {
  const originalFetch = global.fetch, originalImage = yt.channelImageUrl;
  yt.channelImageUrl = async () => "https://yt3.googleusercontent.com/fixture";
  global.fetch = (url, options) => String(url).startsWith("https://yt3.")
    ? Promise.resolve(new Response("image bytes", { headers: { "content-type": "image/jpeg; charset=binary" } }))
    : originalFetch(url, options);
  const app = express();
  app.use("/api/youtube", routes);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => {
    global.fetch = originalFetch;
    yt.channelImageUrl = originalImage;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const res = await originalFetch(`http://127.0.0.1:${server.address().port}/api/youtube/channel-image/UC${"a".repeat(22)}/avatar`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(await res.text(), "image bytes");
});

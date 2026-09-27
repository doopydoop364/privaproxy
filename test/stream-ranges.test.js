"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const yt = require("../server/youtube/ytdlp");
const routes = require("../server/youtube/routes");

async function fixture(t, respond) {
  const originalFetch = global.fetch;
  const originalResolve = yt.resolveStream;
  yt.resolveStream = async () => ({ url: "https://media.example/file", headers: {}, adaptive: true });
  global.fetch = (url, options) => String(url).startsWith("https://media.example/")
    ? respond(options) : originalFetch(url, options);
  const app = express();
  app.use("/api/youtube", routes);
  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    global.fetch = originalFetch;
    yt.resolveStream = originalResolve;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return options => originalFetch(`http://127.0.0.1:${server.address().port}/api/youtube/stream/aaaaaaaaaaa`, options);
}

test("adaptive suffix and multipart ranges reach upstream unchanged", async t => {
  const seen = [];
  const request = await fixture(t, async options => {
    seen.push(options.headers.Range);
    return new Response("ef", { status: 206, headers: { "content-range": "bytes 4-5/6" } });
  });
  for (const range of ["bytes=-2", "bytes=0-1,4-5"]) {
    const res = await request({ headers: { Range: range } });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), "ef");
  }
  assert.deepEqual(seen, ["bytes=-2", "bytes=0-1,4-5"]);
});

test("whole adaptive downloads advance by the actual upstream window size", async t => {
  const ranges = [];
  const request = await fixture(t, async options => {
    ranges.push(options.headers.Range);
    const start = Number(/^bytes=(\d+)-/.exec(options.headers.Range)[1]);
    return new Response("abcdef".slice(start, start + 2), {
      status: 206, headers: { "content-range": `bytes ${start}-${start + 1}/6` },
    });
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "6");
  assert.equal(await res.text(), "abcdef");
  assert.deepEqual(ranges, ["bytes=0-10485759", "bytes=2-5", "bytes=4-5"]);
});

test("inconsistent upstream ranges terminate the download rather than corrupt it", async t => {
  let calls = 0, canceled = false;
  const request = await fixture(t, async () => {
    if (++calls === 1) return new Response("ab", { status: 206, headers: { "content-range": "bytes 0-1/6" } });
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), {
      status: 206, headers: { "content-range": "bytes 0-1/6" },
    });
  });
  const res = await request();
  await assert.rejects(res.arrayBuffer());
  assert.equal(canceled, true);
});

test("unsafe integer ranges are never rounded into different byte offsets", () => {
  assert.equal(routes._boundRange("bytes=9007199254740993-", 100), null);
  assert.equal(routes._boundRange("bytes=0-9007199254740993", 100), null);
});

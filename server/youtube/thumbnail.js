"use strict";
const https = require("https");
const { Readable } = require("stream");
const { lookup } = require("./hlsUpstream");
const { readCapped } = require("./upstream");

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SIZES = new Set(["mqdefault", "hqdefault", "maxresdefault"]);
const MAX_BYTES = 2 * 1024 * 1024;

async function fetchThumbnail(id, size, signal) {
  if (!ID_RE.test(id) || !SIZES.has(size)) return null;
  const url = new URL(`https://i.ytimg.com/vi/${id}/${size}.jpg`);
  const up = await new Promise((resolve, reject) => {
    let deadline;
    const req = https.get(url, {
      signal, lookup, agent: false, headers: { "accept-encoding": "identity" },
    }, res => {
      clearTimeout(deadline);
      resolve({ status: res.statusCode, headers: new Headers(res.headers), body: Readable.toWeb(res) });
    });
    req.on("error", err => { clearTimeout(deadline); reject(err); });
    deadline = setTimeout(() => req.destroy(new Error("Thumbnail request timed out.")), 10000);
    deadline.unref();
    req.setTimeout(10000, () => req.destroy(new Error("Thumbnail request timed out.")));
  });
  if (up.status !== 200) {
    await up.body.cancel().catch(() => {});
    return { status: up.status };
  }
  const type = (up.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) {
    await up.body.cancel().catch(() => {});
    throw new Error("Thumbnail response was not an image.");
  }
  const body = await readCapped(up, MAX_BYTES);
  if (!body) throw new Error("Thumbnail response was too large.");
  return { status: 200, type, body };
}

module.exports = { fetchThumbnail, ID_RE, SIZES };

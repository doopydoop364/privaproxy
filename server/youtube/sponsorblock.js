"use strict";
// SponsorBlock lookups (https://sponsor.ajay.app).
//
// Privacy: we use the API's hash-prefix form, so SponsorBlock only ever sees the
// first 4 hex chars of sha256(videoId), never the video id itself. The host is a
// constant -- nothing from the client picks where this request goes.

const crypto = require("crypto");

const HOST = "https://sponsor.ajay.app";
const CATEGORIES = ["sponsor", "selfpromo", "interaction", "intro", "outro"];
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_BYTES = 1024 * 1024;

const cache = new Map(); // id -> { at, segments }

// Keeps only well-formed skip segments for `id`: [{ start, end, category }].
function pickSegments(payload, id) {
  if (!Array.isArray(payload)) return [];
  const entry = payload.find((e) => e && e.videoID === id);
  if (!entry || !Array.isArray(entry.segments)) return [];
  return entry.segments
    .filter((s) => s && s.actionType === "skip" && CATEGORIES.includes(s.category) && Array.isArray(s.segment))
    .map((s) => ({ start: Number(s.segment[0]), end: Number(s.segment[1]), category: s.category }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.start >= 0)
    .sort((a, b) => a.start - b.start);
}

async function segmentsFor(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.segments;

  const prefix = crypto.createHash("sha256").update(id).digest("hex").slice(0, 4);
  const url = `${HOST}/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(CATEGORIES))}&actionTypes=${encodeURIComponent('["skip"]')}`;
  const up = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: "error" });
  let segments = [];
  if (up.status === 404) {
    segments = []; // nothing submitted for any video with this prefix
  } else if (up.ok) {
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("SponsorBlock response too large");
    segments = pickSegments(JSON.parse(buf.toString("utf8")), id);
  } else {
    throw new Error(`SponsorBlock returned ${up.status}`);
  }
  cache.set(id, { at: Date.now(), segments });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return segments;
}

module.exports = { segmentsFor, pickSegments, CATEGORIES };

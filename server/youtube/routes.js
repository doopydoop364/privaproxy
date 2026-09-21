"use strict";
const express = require("express");
const { Readable } = require("stream");
const yt = require("./ytdlp");
const hlsLib = require("./hls");
const sponsorblock = require("./sponsorblock");

const router = express.Router();

const FORMAT_RE = /^[A-Za-z0-9._-]{1,40}$/;

// YouTube throttles open-ended requests for its video-only/audio-only files, so
// for those we cap every upstream request to a bounded byte window (the browser
// simply asks for the next window as it plays, like yt-dlp's own chunked download).
const ADAPTIVE_CHUNK = 10 * 1024 * 1024;

// "bytes=a-b" / "bytes=a-" -> a bounded range, or null for anything we don't rewrite.
function boundRange(header, chunk) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header || "").trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === "" ? start + chunk - 1 : Math.min(Number(m[2]), start + chunk - 1);
  return end >= start ? `bytes=${start}-${end}` : null;
}

const STATUS_BY_CODE = {
  bad_id: 400,
  bad_page: 400,
  bad_request: 400,
  unavailable: 404,
  not_installed: 503,
  timeout: 504,
  bot_check: 502,
  js_runtime: 502,
  network: 502,
  bad_flag: 500,
  failed: 502,
};

function sendError(res, err) {
  if (err instanceof yt.YtdlpError) {
    return res.status(STATUS_BY_CODE[err.code] || 502).json({
      error: err.code,
      message: err.message,
      detail: err.detail || undefined,
    });
  }
  console.error("YouTube route error:", err);
  return res.status(500).json({ error: "internal", message: "Unexpected server error." });
}

// ---------- shared upstream helpers ----------

const cancelBody = (up) => up.body && up.body.cancel().catch(() => {});

// Abort upstream work as soon as the browser goes away (seek, tab change, navigation).
function abortOnClose(res) {
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  return ac;
}

// Copy the useful upstream headers and stream the body to the client.
function pipeUpstream(req, res, up, fallbackType) {
  res.status(up.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!res.getHeader("accept-ranges")) res.setHeader("accept-ranges", "bytes");
  if (!res.getHeader("content-type")) res.setHeader("content-type", fallbackType);
  res.setHeader("cache-control", "private, max-age=0");

  if (req.method === "HEAD" || !up.body) {
    cancelBody(up);
    return res.end();
  }
  Readable.fromWeb(up.body)
    .on("error", () => res.destroy())
    .pipe(res);
}

// A client that sent no Range wants the whole file, but for adaptive files we only ever ask
// YouTube for one window at a time. Answer 200 with the full length and stitch the windows
// together as the body is read. `first` is the (206) response for the first window.
function pipeWhole(req, res, first, target, ac) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(first.headers.get("content-range") || "");
  if (!m || Number(m[1]) !== 0) return pipeUpstream(req, res, first, target.mime || "video/mp4"); // unexpected shape: pass through
  const total = Number(m[3]);
  res.status(200);
  res.setHeader("content-type", first.headers.get("content-type") || target.mime || "video/mp4");
  res.setHeader("content-length", String(total));
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("cache-control", "private, max-age=0");
  if (req.method === "HEAD") {
    cancelBody(first);
    return res.end();
  }
  async function* windows() {
    yield* Readable.fromWeb(first.body);
    for (let start = Number(m[2]) + 1; start < total; start += ADAPTIVE_CHUNK) {
      const end = Math.min(total - 1, start + ADAPTIVE_CHUNK - 1);
      const up = await fetch(target.url, { headers: { ...target.headers, Range: `bytes=${start}-${end}` }, signal: ac.signal, redirect: "follow" });
      if (up.status !== 206) {
        cancelBody(up);
        throw new Error(`upstream returned ${up.status} mid-stream`);
      }
      yield* Readable.fromWeb(up.body);
    }
  }
  Readable.from(windows())
    .on("error", () => res.destroy())
    .pipe(res);
}

// Read an upstream body into memory, refusing anything over `max` bytes.
async function readCapped(up, max) {
  const chunks = [];
  let n = 0;
  for await (const chunk of Readable.fromWeb(up.body)) {
    n += chunk.length;
    if (n > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Rewrite an upstream m3u8 so every URL in it comes back through /hls/seg/.
async function sendPlaylist(res, up, requestedUrl, headers) {
  const buf = up.body ? await readCapped(up, hlsLib.MAX_PLAYLIST_BYTES) : Buffer.alloc(0);
  if (!buf) return res.status(502).json({ error: "playlist_too_large", message: "YouTube returned an unexpectedly large playlist." });
  const text = buf.toString("utf8");
  if (!text.trimStart().startsWith("#EXTM3U"))
    return res.status(502).json({ error: "invalid_playlist", message: "YouTube didn't return a valid HLS playlist." });
  let body;
  try {
    body = hlsLib.rewritePlaylist(text, up.url || requestedUrl, headers);
  } catch (err) {
    if (err instanceof hlsLib.PlaylistError)
      return res.status(502).json({ error: "invalid_playlist", message: "The HLS playlist contained something we won't proxy." });
    throw err;
  }
  res.status(200).set({ "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" }).send(body);
}

// ---- GET /api/youtube/status ----
router.get("/status", async (req, res) => {
  try {
    res.json(await yt.status());
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /api/youtube/search?q=...&page=1&limit=20 ----
// One page of results (limit 1-30 per page, up to 10 pages): { results, hasMore }.
router.get("/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.status(400).json({ error: "bad_request", message: "Missing ?q=" });
  if (q.length > 200) return res.status(400).json({ error: "bad_request", message: "Query too long." });
  try {
    const r = await yt.search(q, req.query.limit, req.query.page);
    res.json({ results: r.items, hasMore: r.hasMore });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /api/youtube/related/:id?page=1 ----
// Videos related to :id, 20 per page (up to 10 pages): { results, hasMore }.
router.get("/related/:id", async (req, res) => {
  try {
    const r = await yt.related(req.params.id, req.query.page, 20);
    res.json({ results: r.items, hasMore: r.hasMore });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /api/youtube/home?seeds=id1,id2,...&page=1 ----
// The "recommended" feed, built from the caller's own watch history (the
// browser sends its most recent video ids; the server keeps no history).
// Each seed contributes its related videos; the lists are interleaved
// round-robin and de-duplicated. Seeds that fail are skipped unless all fail.
const MAX_SEEDS = 5;
router.get("/home", async (req, res) => {
  const seeds = [...new Set(String(req.query.seeds || "").split(",").map((x) => x.trim()).filter(Boolean))];
  if (!seeds.length) return res.status(400).json({ error: "bad_request", message: "Missing ?seeds=" });
  if (seeds.length > MAX_SEEDS) return res.status(400).json({ error: "bad_request", message: `At most ${MAX_SEEDS} seeds.` });
  if (!seeds.every((id) => yt.ID_RE.test(id))) return res.status(400).json({ error: "bad_id", message: "Invalid video id in seeds." });

  const outcomes = await Promise.allSettled(seeds.map((id) => yt.related(id, req.query.page, 8)));
  const ok = outcomes.filter((o) => o.status === "fulfilled").map((o) => o.value);
  if (!ok.length) return sendError(res, outcomes[0].reason);

  const seen = new Set(seeds); // never recommend the videos we seeded from
  const results = [];
  const longest = Math.max(...ok.map((r) => r.items.length));
  for (let i = 0; i < longest; i++) {
    for (const r of ok) {
      const item = r.items[i];
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        results.push(item);
      }
    }
  }
  res.json({ results, hasMore: ok.some((r) => r.hasMore) });
});

// ---- GET /api/youtube/video/:id ----
// Metadata + the directly playable qualities (`streams`) + whether adaptive
// HLS playback is available (`hls`). Never exposes YouTube URLs.
router.get("/video/:id", async (req, res) => {
  try {
    res.json(await yt.getVideo(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /api/youtube/stream/:id?f=<formatId> ----
// Proxies a combined audio+video file with Range support. yt-dlp's URLs can
// depend on the headers it used, so we fetch them server-side with those.
// If YouTube rejects a cached URL (expired), we refresh it once and retry.
router.get("/stream/:id", async (req, res) => {
  const { id } = req.params;
  const f = req.query.f;
  if (!yt.ID_RE.test(id)) return res.status(400).json({ error: "bad_id", message: "Invalid video id." });
  if (f !== undefined && (typeof f !== "string" || !FORMAT_RE.test(f)))
    return res.status(400).json({ error: "bad_request", message: "Invalid format." });

  const ac = abortOnClose(res);

  for (let attempt = 0; attempt < 2; attempt++) {
    let target;
    try {
      target = await yt.resolveStream(id, f);
    } catch (err) {
      return sendError(res, err);
    }
    if (!target)
      return res.status(404).json({ error: "no_such_format", message: "That quality isn't available for this video." });

    let up;
    try {
      const headers = { ...target.headers };
      if (target.adaptive) headers.Range = boundRange(req.headers.range, ADAPTIVE_CHUNK) || `bytes=0-${ADAPTIVE_CHUNK - 1}`;
      else if (req.headers.range) headers.Range = req.headers.range;
      up = await fetch(target.url, { headers, signal: ac.signal, redirect: "follow" });
    } catch {
      if (ac.signal.aborted) return;
      return res.status(502).json({ error: "upstream_unreachable", message: "Couldn't reach YouTube's video servers." });
    }

    if ([403, 404, 410].includes(up.status) && attempt === 0) {
      cancelBody(up);
      yt.invalidateVideo(id); // cached URL likely expired: re-run yt-dlp once
      continue;
    }
    if (!up.ok && up.status !== 416) {
      cancelBody(up);
      return res.status(502).json({ error: "upstream_error", message: `YouTube's video servers returned ${up.status}.` });
    }
    if (target.adaptive && !req.headers.range && up.status === 206) return pipeWhole(req, res, up, target, ac);
    return pipeUpstream(req, res, up, target.mime || "video/mp4");
  }
});

// ---- GET /api/youtube/hls/:id/master.m3u8 ----
// The adaptive-stream entry point for hls.js. Fetches YouTube's master playlist
// and rewrites it so every further request comes back through /hls/seg/.
router.get("/hls/:id/master.m3u8", async (req, res) => {
  const { id } = req.params;
  if (!yt.ID_RE.test(id)) return res.status(400).json({ error: "bad_id", message: "Invalid video id." });
  const ac = abortOnClose(res);

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let hls;
      try {
        hls = await yt.resolveHls(id);
      } catch (err) {
        return sendError(res, err);
      }
      if (!hls) return res.status(404).json({ error: "no_hls", message: "No adaptive (HLS) stream is available for this video." });

      let up;
      try {
        up = await fetch(hls.url, { headers: hls.headers, signal: ac.signal, redirect: "follow" });
      } catch {
        if (ac.signal.aborted) return;
        return res.status(502).json({ error: "upstream_unreachable", message: "Couldn't reach YouTube's servers." });
      }
      if ([403, 404, 410].includes(up.status) && attempt === 0) {
        cancelBody(up);
        yt.invalidateVideo(id); // expired manifest URL: refresh once
        continue;
      }
      if (!up.ok) {
        cancelBody(up);
        return res.status(502).json({ error: "upstream_error", message: `YouTube returned ${up.status} for the stream list.` });
      }
      return await sendPlaylist(res, up, hls.url, hls.headers);
    }
  } catch (err) {
    if (ac.signal.aborted) return;
    sendError(res, err);
  }
});

// ---- GET /api/youtube/hls/seg/:token ----
// Serves anything reachable from a master playlist: variant playlists (rewritten
// again) and media segments (streamed, Range-aware). Tokens only exist for URLs
// we found inside a manifest, so this can't be used to fetch arbitrary URLs.
router.get("/hls/seg/:token", async (req, res) => {
  const entry = hlsLib.lookup(req.params.token);
  if (!entry) return res.status(404).json({ error: "unknown_segment", message: "Unknown or expired stream reference." });
  const ac = abortOnClose(res);

  try {
    const headers = { ...entry.headers };
    if (req.headers.range && !hlsLib.isPlaylist("", entry.url)) headers.Range = req.headers.range;

    let up;
    try {
      up = await fetch(entry.url, { headers, signal: ac.signal, redirect: "follow" });
    } catch {
      if (ac.signal.aborted) return;
      return res.status(502).json({ error: "upstream_unreachable", message: "Couldn't reach YouTube's servers." });
    }
    if (!up.ok && up.status !== 416) {
      cancelBody(up);
      return res.status(502).json({ error: "upstream_error", message: `YouTube returned ${up.status}.` });
    }
    if (hlsLib.isPlaylist(up.headers.get("content-type"), entry.url)) {
      return await sendPlaylist(res, up, entry.url, entry.headers);
    }
    return pipeUpstream(req, res, up, "application/octet-stream");
  } catch (err) {
    if (ac.signal.aborted) return;
    sendError(res, err);
  }
});

// ---- GET /api/youtube/channel/:id?page=1 ----
// A channel's uploads, newest first: { channel: {id, name}, results, hasMore }.
router.get("/channel/:id", async (req, res) => {
  try {
    const r = await yt.channel(req.params.id, req.query.page, 20);
    res.json({ channel: r.channel, results: r.items, hasMore: r.hasMore });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /api/youtube/playlist/:id?page=1 ----
router.get("/playlist/:id", async (req, res) => {
  try {
    const r = await yt.playlist(req.params.id, req.query.page, 20);
    res.json({ playlist: r.playlist, results: r.items, hasMore: r.hasMore });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /api/youtube/subscriptions?channels=UC...,UC...&page=1 ----
// A feed built from the caller's own subscriptions (the browser keeps the list; the
// server keeps nothing). Each channel contributes its newest uploads, interleaved
// round-robin. Capped like /home so it can't monopolise yt-dlp; failing channels
// are skipped unless every one fails.
const MAX_CHANNELS = 6;
router.get("/subscriptions", async (req, res) => {
  const channels = [...new Set(String(req.query.channels || "").split(",").map((x) => x.trim()).filter(Boolean))];
  if (!channels.length) return res.status(400).json({ error: "bad_request", message: "Missing ?channels=" });
  if (channels.length > MAX_CHANNELS) return res.status(400).json({ error: "bad_request", message: `At most ${MAX_CHANNELS} channels.` });
  if (!channels.every((id) => yt.CHANNEL_RE.test(id))) return res.status(400).json({ error: "bad_id", message: "Invalid channel id." });

  const outcomes = await Promise.allSettled(channels.map((id) => yt.channel(id, req.query.page, 6)));
  const ok = outcomes.filter((o) => o.status === "fulfilled").map((o) => o.value);
  if (!ok.length) return sendError(res, outcomes[0].reason);

  const seen = new Set();
  const results = [];
  const longest = Math.max(...ok.map((r) => r.items.length));
  for (let i = 0; i < longest; i++) {
    for (const r of ok) {
      const item = r.items[i];
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        results.push(item);
      }
    }
  }
  res.json({ results, hasMore: ok.some((r) => r.hasMore) });
});

// ---- GET /api/youtube/captions/:id/:lang.vtt ----
// WebVTT for one of the languages listed in the video's `captions`. The upstream
// URL is looked up from yt-dlp's output for this video, never taken from the caller.
router.get("/captions/:id/:lang.vtt", async (req, res) => {
  const { id, lang } = req.params;
  if (!yt.ID_RE.test(id)) return res.status(400).json({ error: "bad_id", message: "Invalid video id." });
  try {
    const text = await yt.captionText(id, lang);
    if (text === null) return res.status(404).json({ error: "no_captions", message: "No captions in that language." });
    res.set({ "content-type": "text/vtt; charset=utf-8", "cache-control": "private, max-age=3600" }).send(text);
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /api/youtube/sponsorblock/:id ----
// Skippable segments [{start, end, category}] from SponsorBlock. Off the critical path:
// any failure is reported as "none" so playback never depends on a third party.
router.get("/sponsorblock/:id", async (req, res) => {
  if (!yt.ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad_id", message: "Invalid video id." });
  try {
    res.json({ segments: await sponsorblock.segmentsFor(req.params.id) });
  } catch {
    res.json({ segments: [] });
  }
});

module.exports = router;
module.exports._boundRange = boundRange;

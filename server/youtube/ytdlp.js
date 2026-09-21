"use strict";
// Thin wrapper around the `yt-dlp` command-line tool.
//
// Design notes:
//  - yt-dlp is spawned with an argument ARRAY (never a shell), and user input
//    only ever appears inside a single argument that can't be read as an
//    option ("ytsearchN:<query>", or a URL after a `--` separator).
//  - yt-dlp exits non-zero on failure but may STILL print JSON to stdout, so the
//    exit code is checked before stdout is trusted.
//  - Video info is cached with in-flight de-duplication: a <video> element fires
//    several range requests at once and each must not spawn its own yt-dlp.
//
// Environment overrides (read at call time):
//   YTDLP_PATH          path to the binary                  (default "yt-dlp")
//   YTDLP_JS_RUNTIMES   comma list passed as --js-runtimes  (default "node";
//                       set to "" to pass none, e.g. "deno,node" for both)
//   YTDLP_TIMEOUT_MS    per-invocation timeout              (default 45000)
//   YTDLP_CONCURRENCY   max simultaneous yt-dlp processes   (default 3)

const { spawn } = require("child_process");

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Channel ids are always "UC" + 22 chars; playlists are "PL"/"UU"/"OLAK5uy_" + a body.
// Anything else is rejected, so we only ever build youtube.com URLs from ids we validated.
const CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_RE = /^(PL|UU|OLAK5uy_)[A-Za-z0-9_-]{10,60}$/;
const LANG_RE = /^[A-Za-z0-9-]{1,20}$/;
const MAX_STDOUT_BYTES = 30 * 1024 * 1024;
const VIDEO_TTL_MS = 20 * 60 * 1000; // stream URLs live ~6h; refresh well before
const SEARCH_TTL_MS = 5 * 60 * 1000;
const STATUS_TTL_MS = 60 * 1000;
const RELATED_TTL_MS = 10 * 60 * 1000;
const LIST_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = { search: 10, related: 10, channel: 10, playlist: 10 };
const MAX_CAPTION_BYTES = 2 * 1024 * 1024;

const cfg = () => ({
  bin: process.env.YTDLP_PATH || "yt-dlp",
  jsRuntimes: (process.env.YTDLP_JS_RUNTIMES ?? "node")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  timeoutMs: Number(process.env.YTDLP_TIMEOUT_MS) || 45000,
  concurrency: Math.max(1, Number(process.env.YTDLP_CONCURRENCY) || 3),
});

class YtdlpError extends Error {
  constructor(code, message, detail = "") {
    super(message);
    this.name = "YtdlpError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------- error classification ----------

function lastErrorLines(stderr) {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => l.startsWith("ERROR:"));
  return (errs.length ? errs : lines).slice(-2).join(" ").slice(0, 400);
}

function classify(stderr) {
  const detail = lastErrorLines(stderr);
  const has = (re) => re.test(stderr);
  if (has(/no such option/i))
    return new YtdlpError("bad_flag", "This yt-dlp version rejected one of the options we pass. Update yt-dlp, or set YTDLP_JS_RUNTIMES to an empty value.", detail);
  if (has(/Sign in to confirm/i))
    return new YtdlpError("bot_check", "YouTube is asking for bot verification / sign-in for this request.", detail);
  if (has(/Private video|Video unavailable|has been removed|no longer available|not available in your country|This video is (not available|unavailable)|account associated with this video has been terminated/i))
    return new YtdlpError("unavailable", "That video is unavailable (private, removed or region-blocked).", detail);
  if (has(/JavaScript runtime|js-runtimes|\bEJS\b/i))
    return new YtdlpError("js_runtime", "yt-dlp couldn't use a JavaScript runtime. Install deno or node (22+) and check YTDLP_JS_RUNTIMES.", detail);
  if (has(/Unable to download|getaddrinfo|Temporary failure|Network is unreachable|timed out|CERTIFICATE|Connection (refused|reset)|SSL/i))
    return new YtdlpError("network", "yt-dlp couldn't reach YouTube. Check your connection.", detail);
  return new YtdlpError("failed", "yt-dlp failed.", detail);
}

function spawnError(e) {
  if (e && e.code === "ENOENT")
    return new YtdlpError("not_installed", "yt-dlp isn't installed or isn't on PATH. On Arch/CachyOS: sudo pacman -S yt-dlp (or set YTDLP_PATH).", String(e.message));
  if (e && e.code === "EACCES")
    return new YtdlpError("not_installed", "yt-dlp exists but isn't executable.", String(e.message));
  return new YtdlpError("failed", "Couldn't start yt-dlp.", String((e && e.message) || e));
}

// ---------- process running (concurrency-capped) ----------

let active = 0;
const waiting = []; // normal-priority waiters (playback, lists the viewer asked for)
const waitingLow = []; // background work (upload dates, channel images): only when nothing else waits

function acquire(low = false) {
  if (active < cfg().concurrency) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => (low ? waitingLow : waiting).push(resolve));
}

function release() {
  const next = waiting.shift() || waitingLow.shift();
  if (next) next(); // hand our slot straight to the next waiter
  else active--;
}

function runOnce(c, args, timeoutMs, tolerant = false) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(c.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(spawnError(e));
    }

    const out = [];
    let outBytes = 0;
    let err = "";
    let done = false;
    let timedOut = false;
    let tooBig = false;
    let timer = null;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        tooBig = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(d);
    });
    child.stderr.on("data", (d) => {
      if (err.length < 20000) err += d;
    });
    child.on("error", (e) => finish(reject, spawnError(e)));
    child.on("close", (code) => {
      if (timedOut)
        return finish(reject, new YtdlpError("timeout", `yt-dlp took longer than ${+(timeoutMs / 1000).toFixed(1)}s and was stopped.`));
      if (tooBig)
        return finish(reject, new YtdlpError("failed", "yt-dlp produced unexpectedly large output."));
      // `tolerant`: several inputs, some may fail (yt-dlp exits non-zero but still prints the rest)
      if (code !== 0 && !(tolerant && out.length)) return finish(reject, classify(err));
      finish(resolve, { stdout: Buffer.concat(out).toString("utf8"), stderr: err });
    });
  });
}

async function run(args, timeoutMs, { low = false, tolerant = false } = {}) {
  const c = cfg();
  await acquire(low);
  try {
    return await runOnce(c, args, timeoutMs ?? c.timeoutMs, tolerant);
  } finally {
    release();
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new YtdlpError("failed", "yt-dlp returned output we couldn't read.", text.slice(0, 200));
  }
}

// Flat lists carry no upload dates unless asked; this gives day-precision (approximate) ones
// for search, playlists and channel tabs (YouTube Mixes still have none).
const FLAT_DATE_ARGS = ["--extractor-args", "youtubetab:approximate_date"];

const commonArgs = (c) => [
  "--socket-timeout", "15",
  ...c.jsRuntimes.flatMap((r) => ["--js-runtimes", r]),
];

// ---------- memo with TTL + in-flight de-duplication ----------

function makeMemo(ttlMs, maxEntries) {
  const map = new Map(); // key -> { at, promise }
  return {
    get(key, fn) {
      const hit = map.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
      const promise = fn();
      const entry = { at: Date.now(), promise };
      map.set(key, entry);
      promise.catch(() => {
        if (map.get(key) === entry) map.delete(key); // never cache failures
      });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
      return promise;
    },
    // The cached (possibly still-pending) promise for `key`, without starting work.
    peek(key) {
      const hit = map.get(key);
      return hit && Date.now() - hit.at < ttlMs ? hit.promise : undefined;
    },
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

const searchMemo = makeMemo(SEARCH_TTL_MS, 100);
const relatedMemo = makeMemo(RELATED_TTL_MS, 200);
const videoMemo = makeMemo(VIDEO_TTL_MS, 50);
const statusMemo = makeMemo(STATUS_TTL_MS, 1);
const channelMemo = makeMemo(LIST_TTL_MS, 100);
const playlistMemo = makeMemo(LIST_TTL_MS, 100);

// ---------- public API ----------

const thumbFor = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function normalizeEntry(e) {
  if (!e || typeof e.id !== "string" || !ID_RE.test(e.id)) return null;
  return {
    id: e.id,
    title: String(e.title || "Untitled"),
    author: String(e.channel || e.uploader || ""),
    channelId: CHANNEL_RE.test(e.channel_id || "") ? e.channel_id : null,
    duration: Number.isFinite(e.duration) ? e.duration : null,
    views: Number.isFinite(e.view_count) ? e.view_count : null,
    isLive: e.live_status === "is_live",
    // Flat-list dates are approximate (rounded to the day); null for YouTube Mixes.
    uploadedAt: Number.isFinite(e.timestamp) ? e.timestamp : null,
    uploadedApprox: Number.isFinite(e.timestamp),
    thumbnail: thumbFor(e.id),
  };
}

// ---------- channel art ----------

// Only ever hand the browser image URLs on YouTube's own avatar hosts, with a plain path.
const CHANNEL_IMG_RE = /^https:\/\/(yt3\.googleusercontent\.com|yt3\.ggpht\.com)\/[A-Za-z0-9_-]+(=[A-Za-z0-9_=,.-]*)?$/;

// { avatar, banner } from a channel's `thumbnails`: the avatar re-sized to 96px, and the
// banner variant closest to 1700px wide. Either may be null.
function pickChannelArt(thumbnails) {
  const list = Array.isArray(thumbnails) ? thumbnails.filter((t) => t && CHANNEL_IMG_RE.test(t.url || "")) : [];
  const avatarSrc = list.find((t) => t.id === "avatar_uncropped") || list.find((t) => t.width && t.width === t.height);
  const base = avatarSrc && avatarSrc.url.split("=")[0];
  const banners = list.filter((t) => t.width && t.height && t.width / t.height > 3);
  banners.sort((a, b) => Math.abs(a.width - 1707) - Math.abs(b.width - 1707));
  return {
    avatar: base ? `${base}=s96-c-k-c0x00ffffff-no-rj` : null,
    banner: banners[0] ? banners[0].url : null,
  };
}

const clampSize = (n, fallback) => Math.min(30, Math.max(1, Math.floor(Number(n)) || fallback));

// Non-numeric / <1 pages mean page 1; pages beyond `max` are an error.
function clampPage(page, max) {
  const n = Math.floor(Number(page));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > max) throw new YtdlpError("bad_page", "That page is out of range.");
  return n;
}

// yt-dlp's inclusive 1-based item range for a page: page 2 of 20 -> "21:40".
const pageRange = (page, size) => [(page - 1) * size + 1, page * size];

// One page of search results: { items, hasMore }.
// (`ytsearchN:` gets N = the last item we want; -I selects just this page.)
async function search(query, limit = 20, page = 1) {
  const size = clampSize(limit, 20);
  const p = clampPage(page, MAX_PAGES.search);
  return searchMemo.get(`${p}:${size}:${query}`, async () => {
    const c = cfg();
    const [start, end] = pageRange(p, size);
    const { stdout } = await run(["--flat-playlist", "-J", "-I", `${start}:${end}`, ...FLAT_DATE_ARGS, ...commonArgs(c), `ytsearch${end}:${query}`]);
    const data = parseJson(stdout);
    // Failed lookups can still yield `entries: [null]`; drop anything unusable.
    const raw = Array.isArray(data.entries) ? data.entries : [];
    return { items: raw.map(normalizeEntry).filter(Boolean), hasMore: raw.length >= size && p < MAX_PAGES.search };
  });
}

const isProgressive = (f) =>
  f && f.url && /^https?$/.test(f.protocol || "") &&
  f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" &&
  (f.ext === "mp4" || f.ext === "webm");

// Video-only / audio-only files served over plain https (YouTube's DASH files). They
// support Range requests, so <video>/<audio> can play them directly; the client plays
// one of each side by side. (The m3u8_native variants are HLS and handled separately.)
const isHttps = (f) => f && f.url && /^https?$/.test(f.protocol || "");
const isAdaptiveVideo = (f) =>
  isHttps(f) && f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") &&
  (f.ext === "mp4" || f.ext === "webm") && f.height > 0;
const isAdaptiveAudio = (f) =>
  isHttps(f) && f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") &&
  (f.ext === "m4a" || f.ext === "webm") && !/drc/i.test(String(f.format_id));
const mimeFor = (f, kind) => `${kind}/${f.ext === "m4a" ? "mp4" : f.ext}`;

// Manual subtitles plus (only the original-language) automatic captions, as WebVTT.
// The caption URLs stay server-side; the client asks for a language and we look it up.
function collectCaptions(info) {
  const out = new Map(); // lang -> { lang, name, auto, url }
  const add = (dict, auto) => {
    for (const [lang, tracks] of Object.entries(dict || {})) {
      if (out.size >= 25 || !LANG_RE.test(lang) || out.has(lang) || !Array.isArray(tracks)) continue;
      const vtt = tracks.find((t) => t && t.ext === "vtt" && /^https:\/\/www\.youtube\.com\/api\/timedtext\?/.test(t.url || ""));
      if (vtt) out.set(lang, { lang, name: String(vtt.name || lang).slice(0, 60), auto, url: vtt.url });
    }
  };
  add(info.subtitles, false);
  const autos = info.automatic_captions || {};
  const origOnly = {};
  for (const k of Object.keys(autos)) if (/-orig$/.test(k)) origOnly[k] = autos[k];
  add(origOnly, true);
  return out;
}

const isHls = (f) => f && String(f.protocol || "").startsWith("m3u8") && f.vcodec && f.vcodec !== "none";

// Headers we must not forward from yt-dlp's per-format set; we control these.
const DROP_HEADERS = new Set(["host", "range", "content-length", "connection", "accept-encoding"]);

function cleanHeaders(raw) {
  const headers = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
  }
  return headers;
}

// One video can list HLS variants from several clients, each with its own
// master playlist (`manifest_url`, shared by all of that client's variants).
// Pick the master offering the tallest video, then the most variants.
function pickHlsMaster(formats) {
  const masters = new Map();
  for (const f of formats) {
    if (!isHls(f) || !/^https?:\/\//.test(f.manifest_url || "")) continue;
    const g = masters.get(f.manifest_url) || { url: f.manifest_url, headers: cleanHeaders(f.http_headers), maxHeight: 0, count: 0 };
    g.maxHeight = Math.max(g.maxHeight, f.height || 0);
    g.count++;
    masters.set(f.manifest_url, g);
  }
  const best = [...masters.values()].sort((a, b) => b.maxHeight - a.maxHeight || b.count - a.count)[0];
  return best ? { url: best.url, headers: best.headers } : null;
}

// Precise upload time (epoch seconds) from full video info; falls back to the upload date.
function uploadedAtOf(info) {
  const ts = info.release_timestamp || info.timestamp;
  if (Number.isFinite(ts)) return ts;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(info.upload_date || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 : null;
}

function buildVideo(info, stderr) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const progressive = formats.filter(isProgressive);

  const streams = progressive
    .map((f) => ({
      formatId: String(f.format_id),
      label: f.height ? `${f.height}p${f.fps > 30 ? Math.round(f.fps) : ""}` : String(f.format_note || f.format_id),
      height: f.height || 0,
      fps: f.fps || null,
      ext: f.ext,
      filesize: f.filesize || f.filesize_approx || null,
    }))
    .sort((a, b) => b.height - a.height || (b.ext === "mp4") - (a.ext === "mp4"));

  const adaptiveVideo = formats.filter(isAdaptiveVideo).map((f) => ({
    formatId: String(f.format_id),
    height: f.height,
    fps: f.fps || null,
    ext: f.ext,
    mime: mimeFor(f, "video"),
    vcodec: f.vcodec,
    tbr: f.tbr || 0,
  }));
  const adaptiveAudio = formats.filter(isAdaptiveAudio).map((f) => ({
    formatId: String(f.format_id),
    ext: f.ext,
    mime: mimeFor(f, "audio"),
    acodec: f.acodec,
    abr: f.abr || f.tbr || 0,
  }));
  adaptiveVideo.sort((a, b) => b.height - a.height || b.tbr - a.tbr);
  adaptiveAudio.sort((a, b) => b.abr - a.abr);

  const internal = new Map();
  for (const f of progressive) {
    internal.set(String(f.format_id), { url: f.url, headers: cleanHeaders(f.http_headers), ext: f.ext, mime: `video/${f.ext}`, adaptive: false });
  }
  for (const f of formats.filter(isAdaptiveVideo)) {
    internal.set(String(f.format_id), { url: f.url, headers: cleanHeaders(f.http_headers), ext: f.ext, mime: mimeFor(f, "video"), adaptive: true });
  }
  for (const f of formats.filter(isAdaptiveAudio)) {
    internal.set(String(f.format_id), { url: f.url, headers: cleanHeaders(f.http_headers), ext: f.ext, mime: mimeFor(f, "audio"), adaptive: true });
  }
  const captions = collectCaptions(info);
  const hls = pickHlsMaster(formats);

  const warnings = stderr
    .split("\n")
    .filter((l) => l.startsWith("WARNING:"))
    .slice(0, 3)
    .map((l) => l.slice(0, 240));

  return {
    pub: {
      id: info.id,
      title: String(info.title || "Untitled"),
      author: String(info.channel || info.uploader || ""),
      channelId: CHANNEL_RE.test(info.channel_id || "") ? info.channel_id : null,
      duration: Number.isFinite(info.duration) ? info.duration : null,
      views: Number.isFinite(info.view_count) ? info.view_count : null,
      uploadedAt: uploadedAtOf(info),
      uploadedApprox: false,
      description: String(info.description || "").slice(0, 1500),
      isLive: !!info.is_live,
      thumbnail: thumbFor(info.id),
      streams,
      adaptive: { video: adaptiveVideo.slice(0, 40), audio: adaptiveAudio.slice(0, 6) },
      captions: [...captions.values()].map(({ lang, name, auto }) => ({ lang, name, auto })),
      defaultFormatId: streams[0] ? streams[0].formatId : null,
      hls: !!hls, // adaptive playback is possible via /api/youtube/hls/:id/master.m3u8
      // What YouTube actually offered; lets us see why a video may not be playable yet.
      available: {
        progressive: progressive.length,
        adaptiveVideo: adaptiveVideo.length,
        adaptiveAudio: adaptiveAudio.length,
        hls: formats.filter(isHls).length,
        videoOnly: formats.filter((f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none")).length,
        audioOnly: formats.filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")).length,
      },
      warnings,
    },
    internal,
    captions,
    hls,
  };
}

function loadVideo(id) {
  if (!ID_RE.test(id)) throw new YtdlpError("bad_id", "Invalid video id.");
  return videoMemo.get(id, async () => {
    const c = cfg();
    const { stdout, stderr } = await run([
      "-J", "--no-playlist", "--ignore-no-formats-error", ...commonArgs(c),
      "--", `https://www.youtube.com/watch?v=${id}`,
    ]);
    return buildVideo(parseJson(stdout), stderr);
  });
}

async function getVideo(id) {
  return (await loadVideo(id)).pub;
}

// Returns {url, headers, ext} for a progressive format, or null if unknown.
async function resolveStream(id, formatId) {
  const v = await loadVideo(id);
  const fid = formatId || v.pub.defaultFormatId;
  return (fid && v.internal.get(String(fid))) || null;
}

// The WebVTT text for one caption language of a video, or null if there isn't one.
// The upstream URL comes from yt-dlp's own output for this video, never from the caller.
async function captionText(id, lang) {
  if (!LANG_RE.test(lang)) throw new YtdlpError("bad_request", "Invalid language.");
  const track = (await loadVideo(id)).captions.get(lang);
  if (!track) return null;
  const up = await fetch(track.url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!up.ok) throw new YtdlpError("failed", `YouTube returned ${up.status} for the captions.`);
  const buf = Buffer.from(await up.arrayBuffer());
  if (buf.length > MAX_CAPTION_BYTES) throw new YtdlpError("failed", "Captions were unexpectedly large.");
  const text = buf.toString("utf8");
  if (!text.trimStart().startsWith("WEBVTT")) throw new YtdlpError("failed", "YouTube didn't return WebVTT captions.");
  return text;
}

// Returns {url, headers} for the chosen HLS master playlist, or null.
async function resolveHls(id) {
  return (await loadVideo(id)).hls;
}

function invalidateVideo(id) {
  videoMemo.delete(id);
}

async function cachedTitle(id) {
  const hit = videoMemo.peek(id);
  if (!hit) return null;
  try {
    return (await hit).pub.title;
  } catch {
    return null;
  }
}

// Videos related to `id`, one page: { items, hasMore }.
//
// Source: YouTube's auto-generated "Mix" for the video (list=RD<id>). yt-dlp
// walks it as an endless generator and stops after the range we request, so
// paging is just a wider -I window. Item 1 is the seed video itself (dropped).
// If the Mix is unavailable (or empty), fall back to searching the video's
// title, which needs the video's info to already be cached (it is, once it plays).
async function related(id, page = 1, size = 20) {
  if (!ID_RE.test(id)) throw new YtdlpError("bad_id", "Invalid video id.");
  const s = clampSize(size, 20);
  const p = clampPage(page, MAX_PAGES.related);
  return relatedMemo.get(`${id}:${p}:${s}`, async () => {
    const c = cfg();
    const [start, end] = pageRange(p, s);
    let raw = null;
    let mixError = null;
    try {
      const { stdout } = await run([
        "--flat-playlist", "-J", "-I", `${start}:${end}`, ...FLAT_DATE_ARGS, ...commonArgs(c),
        "--", `https://www.youtube.com/watch?v=${id}&list=RD${id}`,
      ]);
      const data = parseJson(stdout);
      raw = Array.isArray(data.entries) ? data.entries : [];
    } catch (err) {
      if (!(err instanceof YtdlpError) || !["failed", "unavailable"].includes(err.code)) throw err;
      mixError = err;
    }

    const emptyMix = raw !== null && p === 1 && raw.filter((e) => e && e.id !== id).length === 0;
    if (raw === null || emptyMix) {
      const title = await cachedTitle(id);
      if (!title) {
        if (mixError) throw mixError;
        return { items: [], hasMore: false };
      }
      const r = await search(title, s, p);
      return { items: r.items.filter((i) => i.id !== id), hasMore: r.hasMore };
    }
    return {
      items: raw.map(normalizeEntry).filter(Boolean).filter((i) => i.id !== id),
      hasMore: raw.length >= s && p < MAX_PAGES.related,
    };
  });
}

// Shared by channels and playlists: one page of a flat playlist page at `url`.
async function flatPage(url, p, size, opts) {
  const c = cfg();
  const [start, end] = pageRange(p, size);
  const { stdout } = await run(["--flat-playlist", "-J", "-I", `${start}:${end}`, ...FLAT_DATE_ARGS, ...commonArgs(c), "--", url], undefined, opts);
  const data = parseJson(stdout);
  const raw = Array.isArray(data.entries) ? data.entries : [];
  return {
    title: String(data.title || "").replace(/ - Videos$/, ""),
    author: String(data.channel || data.uploader || ""),
    channelId: CHANNEL_RE.test(data.channel_id || "") ? data.channel_id : null,
    followers: Number.isFinite(data.channel_follower_count) ? data.channel_follower_count : null,
    verified: !!data.channel_is_verified,
    handle: /^@[A-Za-z0-9._-]{1,60}$/.test(data.uploader_id || "") ? data.uploader_id : "",
    description: String(data.description || "").slice(0, 300),
    art: pickChannelArt(data.thumbnails),
    items: raw.map(normalizeEntry).filter(Boolean),
    hasMore: raw.length >= size,
  };
}

// ---------- channel images (served through our own route) ----------

const channelImagePath = (id, kind) => `/api/youtube/channel-image/${id}/${kind}`;
const artCache = new Map(); // channel id -> { avatar, banner } (validated upstream URLs, server-side only)
function rememberArt(id, art) {
  artCache.delete(id);
  artCache.set(id, art);
  while (artCache.size > 1000) artCache.delete(artCache.keys().next().value);
}

// The upstream image URL for a channel's avatar or banner, or null. Looked up from what
// yt-dlp told us about that channel (never from the caller), and re-validated on the way out.
async function channelImageUrl(id, kind) {
  if (!CHANNEL_RE.test(id)) throw new YtdlpError("bad_id", "Invalid channel id.");
  if (kind !== "avatar" && kind !== "banner") return null;
  if (!artCache.has(id)) await channel(id, 1, 20, { low: true }); // fills artCache
  const url = (artCache.get(id) || {})[kind];
  return url && CHANNEL_IMG_RE.test(url) ? url : null;
}

// ---------- upload dates for videos that only appeared in a list ----------

const dateCache = new Map(); // video id -> Promise<epoch seconds | null>
const DATE_BATCH = 12;

// { id: epochSeconds } for the ids we could find out. One yt-dlp process per batch, at low
// priority so it never delays playback; results (including "unknown") are cached.
async function uploadDates(ids) {
  const unique = [...new Set(ids)];
  if (!unique.every((id) => ID_RE.test(id))) throw new YtdlpError("bad_id", "Invalid video id.");
  if (unique.length > DATE_BATCH) throw new YtdlpError("bad_request", `At most ${DATE_BATCH} ids.`);

  const missing = unique.filter((id) => !dateCache.has(id));
  if (missing.length) {
    const c = cfg();
    const batch = run([
      "--skip-download", "--no-warnings", "--ignore-errors", "--no-playlist",
      "--print", "%(id)s|%(timestamp)s|%(upload_date)s",
      "--extractor-args", "youtube:player_skip=js,configs",
      ...commonArgs(c),
      "--", ...missing.map((id) => `https://www.youtube.com/watch?v=${id}`),
    ], undefined, { low: true, tolerant: true }).catch((err) => {
      // A batch of only private/removed videos is not an error worth surfacing: they just have no date.
      if (err instanceof YtdlpError && ["unavailable", "failed"].includes(err.code)) return { stdout: "" };
      throw err;
    }).then(({ stdout }) => {
      const found = new Map();
      for (const line of stdout.split("\n")) {
        const [id, ts, ud] = line.trim().split("|");
        if (!ID_RE.test(id || "")) continue;
        const t = Number(ts);
        const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ud || "");
        found.set(id, Number.isFinite(t) && ts !== "NA" ? t : m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 : null);
      }
      return found;
    });
    for (const id of missing) {
      const p = batch.then((found) => found.get(id) ?? null);
      dateCache.set(id, p);
      p.catch(() => dateCache.get(id) === p && dateCache.delete(id)); // never cache failures
    }
    while (dateCache.size > 4000) dateCache.delete(dateCache.keys().next().value);
  }
  const out = {};
  await Promise.all(unique.map(async (id) => {
    const t = await dateCache.get(id);
    if (Number.isFinite(t)) out[id] = t;
  }));
  return out;
}

// One page of a channel's uploads (newest first): { channel: {id, name}, items, hasMore }.
async function channel(id, page = 1, size = 20, opts) {
  if (!CHANNEL_RE.test(id)) throw new YtdlpError("bad_id", "Invalid channel id.");
  const s = clampSize(size, 20);
  const p = clampPage(page, MAX_PAGES.channel);
  return channelMemo.get(`${id}:${p}:${s}`, async () => {
    const r = await flatPage(`https://www.youtube.com/channel/${id}/videos`, p, s, opts);
    const name = r.title || r.author;
    rememberArt(id, r.art);
    // Flat channel entries carry no author of their own; fill it in from the channel.
    const items = r.items.map((i) => ({ ...i, author: i.author || name, channelId: i.channelId || id }));
    return {
      channel: {
        id, name,
        // Served by our own /channel-image route, so the browser never contacts Google's image hosts.
        avatar: r.art.avatar ? channelImagePath(id, "avatar") : null,
        banner: r.art.banner ? channelImagePath(id, "banner") : null,
        followers: r.followers, verified: r.verified, handle: r.handle, description: r.description,
      },
      items,
      hasMore: r.hasMore && p < MAX_PAGES.channel,
    };
  });
}

// One page of a playlist: { playlist: {id, title, author}, items, hasMore }.
async function playlist(id, page = 1, size = 20) {
  if (!PLAYLIST_RE.test(id)) throw new YtdlpError("bad_id", "Invalid playlist id.");
  const s = clampSize(size, 20);
  const p = clampPage(page, MAX_PAGES.playlist);
  return playlistMemo.get(`${id}:${p}:${s}`, async () => {
    const r = await flatPage(`https://www.youtube.com/playlist?list=${id}`, p, s);
    return {
      playlist: { id, title: r.title, author: r.author },
      items: r.items,
      hasMore: r.hasMore && p < MAX_PAGES.playlist,
    };
  });
}

async function status() {
  return statusMemo.get("v", async () => {
    const c = cfg();
    const { stdout } = await run(["--version"], 10000);
    return { ok: true, version: stdout.trim(), jsRuntimes: c.jsRuntimes };
  });
}

module.exports = {
  YtdlpError, ID_RE, CHANNEL_RE, PLAYLIST_RE,
  search, related, channel, playlist, channelImageUrl, uploadDates, DATE_BATCH, getVideo, resolveStream, resolveHls, captionText, invalidateVideo, status,
  _channelImagePath: channelImagePath, _CHANNEL_IMG_RE: CHANNEL_IMG_RE, _buildVideo: buildVideo, _pickChannelArt: pickChannelArt, _normalizeEntry: normalizeEntry,
  _clearCaches: () => { searchMemo.clear(); relatedMemo.clear(); videoMemo.clear(); statusMemo.clear(); channelMemo.clear(); playlistMemo.clear(); },
};

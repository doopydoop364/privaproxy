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
const MAX_STDOUT_BYTES = 30 * 1024 * 1024;
const VIDEO_TTL_MS = 20 * 60 * 1000; // stream URLs live ~6h; refresh well before
const SEARCH_TTL_MS = 5 * 60 * 1000;
const STATUS_TTL_MS = 60 * 1000;

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
const waiting = [];

function acquire() {
  if (active < cfg().concurrency) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next(); // hand our slot straight to the next waiter
  else active--;
}

function runOnce(c, args, timeoutMs) {
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
      if (code !== 0) return finish(reject, classify(err));
      finish(resolve, { stdout: Buffer.concat(out).toString("utf8"), stderr: err });
    });
  });
}

async function run(args, timeoutMs) {
  const c = cfg();
  await acquire();
  try {
    return await runOnce(c, args, timeoutMs ?? c.timeoutMs);
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
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

const searchMemo = makeMemo(SEARCH_TTL_MS, 50);
const videoMemo = makeMemo(VIDEO_TTL_MS, 50);
const statusMemo = makeMemo(STATUS_TTL_MS, 1);

// ---------- public API ----------

const thumbFor = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function normalizeEntry(e) {
  if (!e || typeof e.id !== "string" || !ID_RE.test(e.id)) return null;
  return {
    id: e.id,
    title: String(e.title || "Untitled"),
    author: String(e.channel || e.uploader || ""),
    duration: Number.isFinite(e.duration) ? e.duration : null,
    views: Number.isFinite(e.view_count) ? e.view_count : null,
    isLive: e.live_status === "is_live",
    thumbnail: thumbFor(e.id),
  };
}

async function search(query, limit = 20) {
  const n = Math.min(30, Math.max(1, Math.floor(Number(limit)) || 20));
  return searchMemo.get(`${n}:${query}`, async () => {
    const c = cfg();
    const { stdout } = await run(["--flat-playlist", "-J", ...commonArgs(c), `ytsearch${n}:${query}`]);
    const data = parseJson(stdout);
    // Failed lookups can still yield `entries: [null]`; drop anything unusable.
    return (Array.isArray(data.entries) ? data.entries : []).map(normalizeEntry).filter(Boolean);
  });
}

const isProgressive = (f) =>
  f && f.url && /^https?$/.test(f.protocol || "") &&
  f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" &&
  (f.ext === "mp4" || f.ext === "webm");

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

  const internal = new Map();
  for (const f of progressive) {
    internal.set(String(f.format_id), { url: f.url, headers: cleanHeaders(f.http_headers), ext: f.ext });
  }
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
      duration: Number.isFinite(info.duration) ? info.duration : null,
      views: Number.isFinite(info.view_count) ? info.view_count : null,
      description: String(info.description || "").slice(0, 1500),
      isLive: !!info.is_live,
      thumbnail: thumbFor(info.id),
      streams,
      defaultFormatId: streams[0] ? streams[0].formatId : null,
      hls: !!hls, // adaptive playback is possible via /api/youtube/hls/:id/master.m3u8
      // What YouTube actually offered; lets us see why a video may not be playable yet.
      available: {
        progressive: progressive.length,
        hls: formats.filter(isHls).length,
        videoOnly: formats.filter((f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none")).length,
        audioOnly: formats.filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")).length,
      },
      warnings,
    },
    internal,
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

// Returns {url, headers} for the chosen HLS master playlist, or null.
async function resolveHls(id) {
  return (await loadVideo(id)).hls;
}

function invalidateVideo(id) {
  videoMemo.delete(id);
}

async function status() {
  return statusMemo.get("v", async () => {
    const c = cfg();
    const { stdout } = await run(["--version"], 10000);
    return { ok: true, version: stdout.trim(), jsRuntimes: c.jsRuntimes };
  });
}

module.exports = {
  YtdlpError, ID_RE,
  search, getVideo, resolveStream, resolveHls, invalidateVideo, status,
  _clearCaches: () => { searchMemo.clear(); videoMemo.clear(); statusMemo.clear(); },
};

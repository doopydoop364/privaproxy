// Pure helpers for the YouTube view: no DOM, no network, no storage. Kept apart from
// youtube.js so they can be unit tested with `npm test` (node --test) and reused as-is
// in the browser (they attach to window.YtPure there).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YtPure = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
  const PLAYLIST_ID_RE = /^(PL|UU|OLAK5uy_)[A-Za-z0-9_-]{10,60}$/;

  // ---------- formatting ----------

  function fmtTime(s) {
    s = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  // 1234 -> "1.2K", 518000000 -> "518M".
  function fmtCompact(n) {
    if (!Number.isFinite(n)) return "";
    const short = (x, unit) => `${x.toFixed(x >= 10 ? 0 : 1).replace(/\.0$/, "")}${unit}`;
    // Thresholds sit just under each unit so rounding can't print "1000K".
    if (n >= 999.5e6) return short(n / 1e9, "B");
    if (n >= 999.5e3) return short(n / 1e6, "M");
    if (n >= 1e3) return short(n / 1e3, "K");
    return String(n);
  }

  function fmtViews(n) {
    return Number.isFinite(n) ? `${fmtCompact(n)} views` : "";
  }

  function fmtSubscribers(n) {
    return Number.isFinite(n) ? `${fmtCompact(n)} ${n === 1 ? "subscriber" : "subscribers"}` : "";
  }

  // "3 weeks ago", like YouTube. `ts` is epoch seconds. Flat-list dates are only accurate to
  // the day (`approx`), so anything under 2 days there says "Today"/"Yesterday" rather than
  // pretending to know the hour. Unknown or future (scheduled) times give "".
  function timeAgo(ts, nowMs = Date.now(), approx = false) {
    if (!Number.isFinite(ts)) return "";
    const sec = nowMs / 1000 - ts;
    if (sec < 0) return "";
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    const days = Math.floor(sec / 86400);
    if (approx && days < 2) return days < 1 ? "Today" : "Yesterday";
    if (sec < 60) return "just now";
    if (sec < 3600) return plural(Math.floor(sec / 60), "minute");
    if (sec < 86400) return plural(Math.floor(sec / 3600), "hour");
    if (days < 7) return plural(days, "day");
    if (days < 30) return plural(Math.floor(days / 7), "week");
    if (days < 365) return plural(Math.max(1, Math.floor(days / 30.44)), "month"); // day 30 is already a month
    return plural(Math.max(1, Math.floor(sec / 31557600)), "year"); // 365 days old already counts as 1 year
  }

  // Image URLs we'll put in an <img>: YouTube's own thumbnail and channel-art hosts only.
  const IMAGE_RE = /^https:\/\/(i\.ytimg\.com|yt3\.googleusercontent\.com|yt3\.ggpht\.com)\//;
  const safeImageUrl = (url) => (IMAGE_RE.test(url || "") ? url : "");

  // ---------- subtitle appearance ----------

  const CAPTION_CHOICES = {
    size: [50, 75, 100, 125, 150, 200, 300],
    color: { white: "#ffffff", yellow: "#ffeb3b", green: "#4caf50", cyan: "#00e5ff", pink: "#ff4081", black: "#000000" },
    bg: [0, 25, 50, 75, 100], // background opacity, percent
    font: {
      sans: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      serif: 'Georgia, "Times New Roman", serif',
      mono: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
      casual: '"Comic Sans MS", "Comic Neue", cursive',
    },
    edge: {
      none: "none",
      outline: "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000",
      shadow: "2px 2px 3px rgba(0, 0, 0, 0.9)",
    },
    position: ["bottom", "raised", "top"],
  };
  const DEFAULT_CAPTION_STYLE = { size: 100, color: "white", bg: 75, font: "sans", edge: "none", position: "bottom" };

  // Saved settings are untrusted (localStorage): anything not on the allow-list is reset,
  // so nothing from storage ever reaches a stylesheet unchecked.
  function normalizeCaptionStyle(x) {
    const d = DEFAULT_CAPTION_STYLE;
    const o = x && typeof x === "object" ? x : {};
    const c = CAPTION_CHOICES;
    return {
      size: c.size.includes(o.size) ? o.size : d.size,
      color: Object.hasOwn(c.color, o.color) ? o.color : d.color,
      bg: c.bg.includes(o.bg) ? o.bg : d.bg,
      font: Object.hasOwn(c.font, o.font) ? o.font : d.font,
      edge: Object.hasOwn(c.edge, o.edge) ? o.edge : d.edge,
      position: c.position.includes(o.position) ? o.position : d.position,
    };
  }

  // The concrete CSS values for a (normalised) style.
  function captionDeclarations(style) {
    const st = normalizeCaptionStyle(style);
    const c = CAPTION_CHOICES;
    return {
      fontSize: `${st.size}%`,
      color: c.color[st.color],
      backgroundColor: `rgba(0, 0, 0, ${st.bg / 100})`,
      fontFamily: c.font[st.font],
      textShadow: c.edge[st.edge],
    };
  }

  // A rule for the browser's caption pseudo-element, e.g. captionCss(style, "video::cue").
  function captionCss(style, selector = "video::cue") {
    const d = captionDeclarations(style);
    return `${selector} { font-size: ${d.fontSize}; color: ${d.color}; background-color: ${d.backgroundColor}; font-family: ${d.fontFamily}; text-shadow: ${d.textShadow}; }`;
  }

  // Where cues sit: VTTCue.line (negative counts up from the bottom, 0 is the top line).
  function cueLine(position) {
    return position === "top" ? 0 : position === "raised" ? -4 : "auto";
  }

  // ---------- what to type into the search box ----------

  // Recognises pasted YouTube links / ids so the search box can open them directly.
  // Returns { type: "channel" | "playlist" | "video", id } or { type: "search" }.
  function parseYoutubeInput(raw) {
    const text = String(raw || "").trim();
    if (PLAYLIST_ID_RE.test(text)) return { type: "playlist", id: text };
    if (CHANNEL_ID_RE.test(text)) return { type: "channel", id: text };
    let url;
    try {
      url = new URL(text);
    } catch {
      return { type: "search" };
    }
    const host = url.hostname.replace(/^(www|m|music)\./, "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return { type: "search" };
    if (host === "youtu.be") {
      const id = url.pathname.slice(1);
      return VIDEO_ID_RE.test(id) ? { type: "video", id } : { type: "search" };
    }
    if (host !== "youtube.com") return { type: "search" };
    const list = url.searchParams.get("list");
    const v = url.searchParams.get("v");
    if (url.pathname === "/playlist" && PLAYLIST_ID_RE.test(list || "")) return { type: "playlist", id: list };
    if (url.pathname === "/watch" && VIDEO_ID_RE.test(v || "")) return { type: "video", id: v };
    const ch = /^\/channel\/([^/]+)/.exec(url.pathname);
    if (ch && CHANNEL_ID_RE.test(ch[1])) return { type: "channel", id: ch[1] };
    const short = /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname);
    if (short && VIDEO_ID_RE.test(short[1])) return { type: "video", id: short[1] };
    return { type: "search" };
  }

  // ---------- quality menu ----------

  const CODEC_RANK = (vcodec) => (/^avc1/.test(vcodec) ? 0 : /^vp0?9/.test(vcodec) ? 1 : /^av01/.test(vcodec) ? 2 : 3);

  // The best playable audio-only file: AAC in mp4 first (widest support), then opus.
  function pickAudio(audioList, canPlay) {
    const playable = (audioList || []).filter((a) => canPlay(a.mime, a.acodec));
    const rank = (a) => (a.mime === "audio/mp4" ? 0 : 1);
    return playable.sort((a, b) => rank(a) - rank(b) || b.abr - a.abr)[0] || null;
  }

  // One entry per height: combined (audio+video in one file) where YouTube offers it,
  // otherwise a video-only file paired with the best playable audio-only file.
  // `canPlay(mime, codec)` says whether this browser can decode a track.
  // Returns entries best-first: { value, label, height, kind, videoId, audioId }.
  function buildQualityList(info, canPlay) {
    const byHeight = new Map();
    const label = (h, fps) => `${h}p${fps > 30 ? Math.round(fps) : ""}`;

    for (const s of (info && info.streams) || []) {
      if (!byHeight.has(s.height || 0)) {
        byHeight.set(s.height || 0, { value: `c:${s.formatId}`, label: s.label, height: s.height || 0, kind: "combined", videoId: s.formatId, audioId: null });
      }
    }

    const adaptive = (info && info.adaptive) || { video: [], audio: [] };
    const audio = pickAudio(adaptive.audio, canPlay);
    if (audio) {
      const best = new Map(); // height -> best playable video-only entry
      for (const v of adaptive.video || []) {
        if (!canPlay(v.mime, v.vcodec)) continue;
        const cur = best.get(v.height);
        const better = !cur || CODEC_RANK(v.vcodec) < CODEC_RANK(cur.vcodec) || (CODEC_RANK(v.vcodec) === CODEC_RANK(cur.vcodec) && (v.fps || 0) > (cur.fps || 0));
        if (better) best.set(v.height, v);
      }
      for (const [h, v] of best) {
        if (byHeight.has(h)) continue; // a combined file at this height is simpler and just as good
        byHeight.set(h, { value: `a:${v.formatId}`, label: label(h, v.fps), height: h, kind: "adaptive", videoId: v.formatId, audioId: audio.formatId });
      }
    }
    return [...byHeight.values()].sort((a, b) => b.height - a.height);
  }

  // The best entry at or under the wanted height (else the lowest available).
  function choosePreferred(list, wantHeight) {
    return list.find((o) => o.height <= wantHeight) || list[list.length - 1] || null;
  }

  // ---------- keeping a separate <audio> in step with the <video> ----------

  // New audio position if it has drifted past `threshold` seconds from the video, else null.
  function driftCorrection(videoTime, audioTime, threshold = 0.3) {
    if (!Number.isFinite(videoTime) || !Number.isFinite(audioTime)) return null;
    return Math.abs(videoTime - audioTime) > threshold ? videoTime : null;
  }

  // ---------- SponsorBlock ----------

  // The segment we're currently inside (and haven't skipped yet), else null.
  // Segments must be sorted by start; a tiny tail margin avoids skipping at the very end.
  function segmentToSkip(segments, t, skipped = new Set()) {
    for (const seg of segments || []) {
      if (seg.start > t) break;
      if (t >= seg.start && t < seg.end - 0.25 && !skipped.has(`${seg.start}-${seg.end}`)) return seg;
    }
    return null;
  }

  // ---------- resume position ----------

  // Only resume if the viewer was meaningfully in and not almost done.
  function resumePoint(map, id, duration) {
    const t = Number(map && map[id]);
    if (!Number.isFinite(t) || t < 10) return 0;
    if (duration && t > duration - 15) return 0;
    return t;
  }

  // New resume map with `id` at `t` (most recent last, oldest dropped past `max`);
  // a finished / barely started video is removed instead.
  function updateResume(map, id, t, duration, max = 200) {
    const next = { ...(map || {}) };
    delete next[id];
    if (Number.isFinite(t) && t >= 10 && !(duration && t > duration - 15)) next[id] = Math.floor(t);
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete next[k];
    return next;
  }

  // ---------- watch history import ----------

  // Merges imported history into the existing one (newest first, unique ids, capped),
  // keeping only well-formed entries: imported files are untrusted input.
  function mergeHistory(existing, imported, max = 100) {
    const clean = [];
    for (const x of Array.isArray(imported) ? imported : []) {
      if (!x || typeof x.id !== "string" || !VIDEO_ID_RE.test(x.id) || typeof x.title !== "string") continue;
      clean.push({
        id: x.id,
        title: x.title.slice(0, 200),
        author: typeof x.author === "string" ? x.author.slice(0, 100) : "",
        thumbnail: /^https:\/\/i\.ytimg\.com\//.test(x.thumbnail || "") ? x.thumbnail : "",
        duration: Number.isFinite(x.duration) ? x.duration : null,
      });
    }
    const seen = new Set();
    return [...(existing || []), ...clean].filter((h) => (seen.has(h.id) ? false : seen.add(h.id))).slice(0, max);
  }

  return {
    fmtTime, fmtViews, fmtCompact, fmtSubscribers, timeAgo, safeImageUrl,
    CAPTION_CHOICES, DEFAULT_CAPTION_STYLE, normalizeCaptionStyle, captionDeclarations, captionCss, cueLine,
    parseYoutubeInput,
    pickAudio, buildQualityList, choosePreferred,
    driftCorrection, segmentToSkip,
    resumePoint, updateResume, mergeHistory,
  };
});

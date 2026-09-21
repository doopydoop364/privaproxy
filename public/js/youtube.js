// YouTube view: search, a custom player, and a simple queue.
// Talks only to our own server (/api/youtube/*), which runs yt-dlp locally.
// All user/remote text is inserted with textContent (never innerHTML).
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const view = $("view-youtube");
  const form = $("ytSearchForm");
  const input = $("ytSearchInput");
  const banner = $("ytBanner");
  const feedTabs = $("ytFeedTabs");
  const feedsEl = $("ytFeeds");
  const clearHistoryBtn = $("ytClearHistory");
  const playerWrap = $("ytPlayerWrap");
  const player = $("ytPlayer");
  const video = $("ytVideo");
  const spinner = $("ytSpinner");
  const playerMsg = $("ytPlayerMsg");
  const seek = $("ytSeek");
  const playBtn = $("ytPlayBtn");
  const nextBtn = $("ytNextBtn");
  const muteBtn = $("ytMuteBtn");
  const volume = $("ytVolume");
  const timeEl = $("ytTime");
  const speedSel = $("ytSpeed");
  const qualitySel = $("ytQuality");
  const fsBtn = $("ytFullscreen");
  const titleEl = $("ytTitle");
  const channelEl = $("ytChannel");
  const queueWrap = $("ytQueue");
  const queueList = $("ytQueueList");
  const queueClear = $("ytQueueClear");

  // ---------- small helpers ----------

  const ICONS = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    next: '<path d="M6 6l8.5 6L6 18zM16 6h2v12h-2z"/>',
    volume: '<path d="M3 9v6h4l5 4V5L7 9zM16.5 12a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>',
    muted: '<path d="M3 9v6h4l5 4V5L7 9zM16 9.4 17.4 8l2.1 2.1L21.6 8 23 9.4l-2.1 2.1L23 13.6 21.6 15l-2.1-2.1L17.4 15 16 13.6l2.1-2.1z"/>',
    fullscreen: '<path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z"/>',
    exitFullscreen: '<path d="M8 4h2v6H4V8h4zM14 4h2v4h4v2h-6zM4 14h6v6H8v-4H4zM14 14h6v2h-4v4h-2z"/>',
  };
  const setIcon = (btn, name) => {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
  };

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage unavailable: preferences just won't persist */
      }
    },
  };

  function fmtTime(s) {
    s = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function fmtViews(n) {
    if (!Number.isFinite(n)) return "";
    const short = (x, unit) => `${x.toFixed(x >= 10 ? 0 : 1).replace(/\.0$/, "")}${unit} views`;
    // Thresholds sit just under each unit so rounding can't print "1000K".
    if (n >= 999.5e6) return short(n / 1e9, "B");
    if (n >= 999.5e3) return short(n / 1e6, "M");
    if (n >= 1e3) return short(n / 1e3, "K");
    return `${n} views`;
  }

  const safeThumb = (url) => (/^https:\/\/i\.ytimg\.com\//.test(url || "") ? url : "");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  class ApiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function api(path) {
    let res;
    try {
      res = await fetch(path);
    } catch {
      throw new ApiError("network", "Couldn't reach the privaproxy server.");
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) throw new ApiError((body && body.error) || `http_${res.status}`, (body && body.message) || `Server returned ${res.status}.`);
    return body;
  }

  function showBanner(text) {
    banner.textContent = text;
    banner.dataset.kind = "error";
    banner.hidden = false;
  }
  const hideBanner = () => {
    banner.hidden = true;
  };

  // ---------- watch history (stays in this browser; the server keeps none) ----------

  const HISTORY_KEY = "ytHistory";
  const HISTORY_MAX = 100;
  const HOME_SEEDS = 4; // how many recent videos the Home feed is built from
  const HOME_EMPTY_TEXT = "Recommendations appear here once you've watched a few videos. Search for something to get started.";

  function readHistory() {
    const h = store.get(HISTORY_KEY, []);
    return Array.isArray(h) ? h.filter((x) => x && typeof x.id === "string") : [];
  }
  function recordHistory(entry) {
    const item = {
      id: entry.id,
      title: entry.title,
      author: entry.author || "",
      thumbnail: entry.thumbnail || "",
      duration: entry.duration == null ? null : entry.duration,
    };
    store.set(HISTORY_KEY, [item, ...readHistory().filter((h) => h.id !== item.id)].slice(0, HISTORY_MAX));
  }
  const homeSeeds = () => readHistory().slice(0, HOME_SEEDS).map((h) => h.id);

  // ---------- infinite feeds: Home / Results / Related ----------
  // Each feed pages through `fetchPage(n)` -> { results, hasMore } as its sentinel
  // (an empty div under the grid) scrolls into view.

  const feeds = {};
  const feedBySentinel = new Map();
  let activeFeed = "home";

  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const feed = feedBySentinel.get(entry.target);
              if (feed) loadMore(feed);
            }
          },
          { root: view, rootMargin: "0px 0px 800px 0px" } // start loading before the end is reached
        )
      : null;

  function createFeed(name) {
    const section = el("section", "yt-feed");
    section.dataset.feed = name;
    section.hidden = name !== activeFeed;
    const grid = el("div", "yt-grid");
    const status = el("div", "yt-feed-status");
    const sentinel = el("div", "yt-sentinel");
    section.append(grid, status, sentinel);
    feedsEl.appendChild(section);

    const feed = {
      name, section, grid, status, sentinel,
      fetchPage: null, exclude: null, emptyText: "",
      page: 0, loading: false, done: true, seen: new Set(),
      gen: 0, stale: true, sig: null, videoId: null,
    };
    feedBySentinel.set(sentinel, feed);
    if (observer) observer.observe(sentinel);
    feeds[name] = feed;
    return feed;
  }

  function setStatus(feed, text, { error = false, button = "" } = {}) {
    feed.status.replaceChildren();
    feed.status.classList.toggle("is-error", error);
    if (text) feed.status.append(document.createTextNode(text));
    if (button) {
      const b = el("button", "", button);
      b.type = "button";
      b.addEventListener("click", () => loadMore(feed));
      feed.status.appendChild(b);
    }
  }

  // Start (or restart) a feed from page 1. `autoload: false` waits for the sentinel
  // to come into view, so a feed nobody is looking at costs nothing.
  function resetFeed(feed, { fetchPage, exclude = null, emptyText, autoload = true }) {
    feed.gen++; // any request still in flight for the old contents is now stale
    feed.fetchPage = fetchPage;
    feed.exclude = exclude;
    feed.emptyText = emptyText || "";
    feed.page = 0;
    feed.loading = false;
    feed.done = !fetchPage;
    feed.stale = false;
    feed.seen.clear();
    feed.grid.replaceChildren();
    setStatus(feed, "");
    if (!fetchPage) return;
    if (autoload) loadMore(feed);
    else if (!observer) setStatus(feed, "", { button: "Load more" });
  }

  async function loadMore(feed) {
    if (feed.loading || feed.done || !feed.fetchPage) return;
    feed.loading = true;
    const gen = feed.gen;
    try {
      // A page can be all duplicates / already-watched; try a couple more before giving up.
      let added = 0;
      for (let attempt = 0; attempt < 3 && !feed.done && added === 0; attempt++) {
        setStatus(feed, feed.grid.childElementCount ? "Loading more…" : "Loading…");
        const page = feed.page + 1;
        const data = await feed.fetchPage(page);
        if (gen !== feed.gen) return; // the feed was reset while we waited
        const fresh = (Array.isArray(data.results) ? data.results : []).filter(
          (item) => !feed.seen.has(item.id) && !(feed.exclude && feed.exclude(item))
        );
        for (const item of fresh) {
          feed.seen.add(item.id);
          feed.grid.appendChild(makeCard(item));
        }
        added = fresh.length;
        feed.page = page;
        feed.done = !data.hasMore;
      }
      if (added === 0) feed.done = true; // nothing new after several pages: stop rather than loop
      if (!feed.grid.childElementCount) setStatus(feed, feed.emptyText);
      else if (feed.done) setStatus(feed, "That's everything.");
      else setStatus(feed, "", observer ? {} : { button: "Load more" });
    } catch (err) {
      if (gen !== feed.gen) return;
      setStatus(feed, (err && err.message) || "Couldn't load videos.", { error: true, button: "Retry" });
      return;
    } finally {
      if (gen === feed.gen) feed.loading = false;
    }
    // If the sentinel is still on screen the observer won't fire again by itself
    // (it only reports changes), so re-check to keep filling a tall window.
    if (observer && !feed.done && !feed.section.hidden) {
      observer.unobserve(feed.sentinel);
      observer.observe(feed.sentinel);
    }
  }

  function ensureHome() {
    const feed = feeds.home;
    const seeds = homeSeeds();
    const sig = seeds.join(",");
    if (feed.sig === sig) return; // nothing watched since we last built it
    feed.sig = sig;
    if (!seeds.length) {
      resetFeed(feed, { fetchPage: null });
      setStatus(feed, HOME_EMPTY_TEXT);
      return;
    }
    const watched = new Set(readHistory().map((h) => h.id));
    resetFeed(feed, {
      fetchPage: (page) => api(`/api/youtube/home?seeds=${seeds.map(encodeURIComponent).join(",")}&page=${page}`),
      exclude: (item) => watched.has(item.id),
      emptyText: "Nothing to recommend right now.",
      autoload: false,
    });
  }

  function startRelated() {
    const feed = feeds.related;
    const id = feed.videoId;
    if (!id) return;
    resetFeed(feed, {
      fetchPage: (page) => api(`/api/youtube/related/${encodeURIComponent(id)}?page=${page}`),
      exclude: (item) => item.id === id,
      emptyText: "No related videos found.",
    });
  }

  function showFeed(name) {
    activeFeed = name;
    for (const tab of feedTabs.querySelectorAll(".yt-feed-tab")) {
      const on = tab.dataset.feed === name;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
    }
    for (const feed of Object.values(feeds)) feed.section.hidden = feed.name !== name;
    if (name === "home") ensureHome();
    if (name === "related" && feeds.related.stale) startRelated();
    clearHistoryBtn.hidden = !(name === "home" && readHistory().length);
    const feed = feeds[name];
    if (observer && feed.fetchPage && !feed.done) {
      observer.unobserve(feed.sentinel); // re-observing reports the current visibility
      observer.observe(feed.sentinel);
    }
  }

  feedTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".yt-feed-tab");
    if (tab && !tab.hidden) showFeed(tab.dataset.feed);
  });

  clearHistoryBtn.addEventListener("click", () => {
    store.set(HISTORY_KEY, []);
    feeds.home.sig = null;
    ensureHome();
    clearHistoryBtn.hidden = true;
  });

  // ---------- search ----------

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    hideBanner();
    const tab = feedTabs.querySelector('[data-feed="results"]');
    tab.hidden = false;
    tab.title = `Results for “${q}”`;
    resetFeed(feeds.results, {
      fetchPage: (page) => api(`/api/youtube/search?q=${encodeURIComponent(q)}&page=${page}`),
      emptyText: "No results.",
    });
    showFeed("results");
  });

  // Called once a video has actually started loading: remember it, and point
  // the Related tab at it. From Home/Related we jump to Related (like YouTube's
  // watch page); from Results we stay put so you can keep browsing the list.
  function afterPlay(entry) {
    recordHistory(entry);
    const related = feeds.related;
    related.videoId = entry.id;
    related.stale = true;
    feedTabs.querySelector('[data-feed="related"]').hidden = false;
    if (activeFeed !== "results") showFeed("related");
    else clearHistoryBtn.hidden = true;
  }

  function makeCard(item) {
    const card = el("div", "yt-card");

    const main = el("button", "yt-card-main");
    main.type = "button";

    const thumbWrap = el("span", "yt-thumb");
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = safeThumb(item.thumbnail);
    thumbWrap.appendChild(img);
    if (item.isLive) thumbWrap.appendChild(el("span", "yt-badge is-live", "LIVE"));
    else if (item.duration) thumbWrap.appendChild(el("span", "yt-badge", fmtTime(item.duration)));

    const body = el("span", "yt-card-body");
    body.appendChild(el("span", "yt-card-title", item.title));
    body.appendChild(el("span", "yt-card-channel", item.author || ""));
    const views = fmtViews(item.views);
    if (views) body.appendChild(el("span", "yt-card-meta", views));

    main.append(thumbWrap, body);
    main.addEventListener("click", () => play(item));

    const add = el("button", "yt-card-queue", "+");
    add.type = "button";
    add.title = "Add to queue";
    add.setAttribute("aria-label", "Add to queue");
    add.addEventListener("click", () => {
      addToQueue(item);
      add.classList.add("is-added");
      add.textContent = "✓";
    });

    card.append(main, add);
    return card;
  }

  // ---------- playback ----------

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const current = { entry: null, info: null, formatId: null };
  let playToken = 0; // guards against out-of-order responses when clicking quickly
  let pendingResume = 0;
  let hls = null; // active hls.js instance (adaptive playback), if any
  let hlsNetRetries = 0;
  let hlsMediaRecoveries = 0;

  function setMessage(text) {
    playerMsg.textContent = text || "";
    playerMsg.hidden = !text;
  }
  const setBuffering = (on) => {
    spinner.hidden = !on;
  };
  const hasMedia = () => !!video.getAttribute("src") || !!hls;

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  async function play(entry) {
    const token = ++playToken;
    current.entry = entry;
    current.info = null;
    current.formatId = null;

    playerWrap.hidden = false;
    titleEl.textContent = entry.title;
    channelEl.textContent = entry.author || "";
    setMessage("");
    setBuffering(true);
    pendingResume = 0;
    destroyHls();
    video.pause();
    video.removeAttribute("src");
    video.load(); // stops any in-flight download from the previous video
    fillQuality([]);
    syncPlayIcon();
    updateProgress();
    if (playerWrap.scrollIntoView) playerWrap.scrollIntoView({ behavior: "smooth", block: "start" });

    let info;
    try {
      info = await api(`/api/youtube/video/${encodeURIComponent(entry.id)}`);
    } catch (err) {
      if (token !== playToken) return;
      setBuffering(false);
      setMessage(err.message);
      return;
    }
    if (token !== playToken) return;

    current.info = info;
    titleEl.textContent = info.title || entry.title;
    channelEl.textContent = info.author || entry.author || "";

    const streams = Array.isArray(info.streams) ? info.streams : [];
    if (streams.length) {
      // A combined audio+video file is the simplest, most reliable path.
      fillQuality(streams);
      loadStream(choosePreferred(streams).formatId, { autoplay: true, resumeAt: 0 });
      afterPlay(entry);
    } else if (info.hls) {
      startHls(entry.id);
      afterPlay(entry);
    } else {
      setBuffering(false);
      setMessage(noStreamMessage(info));
    }
  }

  function noStreamMessage(info) {
    const a = info.available || {};
    let msg = "YouTube offered no stream this player can use for this video.";
    msg += ` (Offered: ${a.progressive || 0} combined, ${a.hls || 0} HLS, ${a.videoOnly || 0} video-only, ${a.audioOnly || 0} audio-only.)`;
    if (info.warnings && info.warnings.length) msg += ` yt-dlp said: ${info.warnings[0]}`;
    return msg;
  }

  // streams arrive best-first; honor the user's last chosen height as a ceiling
  function choosePreferred(streams) {
    const want = store.get("ytHeight", Infinity);
    return streams.find((s) => s.height <= want) || streams[streams.length - 1];
  }

  function fillQuality(streams) {
    qualitySel.replaceChildren();
    for (const s of streams) {
      const opt = el("option", "", s.ext && s.ext !== "mp4" ? `${s.label} (${s.ext})` : s.label);
      opt.value = s.formatId;
      qualitySel.appendChild(opt);
    }
    qualitySel.disabled = streams.length < 2;
    if (current.formatId) qualitySel.value = current.formatId;
  }

  function loadStream(formatId, { autoplay = true, resumeAt = 0 } = {}) {
    current.formatId = formatId;
    qualitySel.value = formatId;
    pendingResume = resumeAt;
    setMessage("");
    setBuffering(true);
    video.src = `/api/youtube/stream/${encodeURIComponent(current.entry.id)}?f=${encodeURIComponent(formatId)}`;
    if (autoplay) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {}); // autoplay policy may refuse; the controls still work
    }
  }

  qualitySel.addEventListener("change", () => {
    if (hls) {
      if (qualitySel.value === "auto") {
        hls.currentLevel = -1;
        store.set("ytHlsChoice", "auto");
      } else {
        const idx = Number(qualitySel.value);
        hls.currentLevel = idx;
        store.set("ytHlsChoice", hls.levels[idx].height);
      }
      qualitySel.blur();
      return;
    }
    const stream = current.info && current.info.streams.find((s) => s.formatId === qualitySel.value);
    if (!stream) return;
    store.set("ytHeight", stream.height);
    loadStream(stream.formatId, { autoplay: !video.paused, resumeAt: video.currentTime });
    qualitySel.blur();
  });

  // ---------- adaptive playback (HLS via hls.js) ----------

  // One menu entry per height: the highest-bitrate level at that height.
  function hlsQualityOptions(levels) {
    const byHeight = new Map();
    levels.forEach((lvl, index) => {
      const h = lvl.height || 0;
      if (!h) return; // skip audio-only variants
      const cur = byHeight.get(h);
      if (!cur || (lvl.bitrate || 0) > (levels[cur.index].bitrate || 0)) byHeight.set(h, { height: h, index });
    });
    return [...byHeight.values()].sort((a, b) => b.height - a.height);
  }

  function startHls(id) {
    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) {
      setBuffering(false);
      setMessage("This browser can't play adaptive (HLS) streams.");
      return;
    }
    hlsNetRetries = 0;
    hlsMediaRecoveries = 0;
    current.formatId = "hls";
    const h = new Hls({ maxBufferLength: 30 });
    hls = h;

    h.on(Hls.Events.MANIFEST_PARSED, () => {
      if (hls !== h) return;
      const options = hlsQualityOptions(h.levels);
      qualitySel.replaceChildren();
      const auto = el("option", "", "Auto");
      auto.value = "auto";
      qualitySel.appendChild(auto);
      for (const o of options) {
        const opt = el("option", "", `${o.height}p`);
        opt.value = String(o.index);
        qualitySel.appendChild(opt);
      }
      qualitySel.disabled = options.length === 0;

      const choice = store.get("ytHlsChoice", "auto");
      const pick = typeof choice === "number" && options.length ? options.find((o) => o.height <= choice) || options[options.length - 1] : null;
      if (pick) {
        h.currentLevel = pick.index;
        qualitySel.value = String(pick.index);
      } else {
        qualitySel.value = "auto";
      }
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    });
    h.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      if (hls !== h || !h.autoLevelEnabled || qualitySel.value !== "auto") return;
      const lvl = h.levels[data.level];
      if (lvl && lvl.height) qualitySel.options[0].textContent = `Auto (${lvl.height}p)`;
    });
    h.on(Hls.Events.FRAG_LOADED, () => {
      hlsNetRetries = 0; // things are flowing again
    });
    h.on(Hls.Events.ERROR, (_e, data) => handleHlsError(h, data));

    h.loadSource(`/api/youtube/hls/${encodeURIComponent(id)}/master.m3u8`);
    h.attachMedia(video);
  }

  function handleHlsError(h, data) {
    if (hls !== h || !data || !data.fatal) return; // stale instance, or hls.js already recovering
    const Hls = window.Hls;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && hlsNetRetries < 2) {
      hlsNetRetries++;
      h.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hlsMediaRecoveries < 2) {
      hlsMediaRecoveries++;
      h.recoverMediaError();
      return;
    }
    setBuffering(false);
    setMessage(hlsErrorMessage(data));
  }

  function hlsErrorMessage(data) {
    const Hls = window.Hls;
    const code = data.response && data.response.code;
    // Our server answers failures with {message}; show it instead of a generic error.
    let serverMsg = "";
    try {
      serverMsg = JSON.parse(data.response.text).message || "";
    } catch {
      /* not JSON */
    }
    if (serverMsg) return serverMsg;
    if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR)
      return `Couldn't load the video's stream list${code ? ` (server returned ${code})` : ""}.`;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR)
      return `The connection dropped while loading video data${code ? ` (server returned ${code})` : ""}.`;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return "The browser couldn't decode this stream.";
    return `Playback failed (${data.details || "unknown error"}).`;
  }

  video.addEventListener("loadedmetadata", () => {
    if (pendingResume > 0) {
      try {
        video.currentTime = pendingResume;
      } catch {
        /* ignore: not seekable yet */
      }
    }
    pendingResume = 0;
    updateProgress();
  });
  video.addEventListener("playing", () => {
    setBuffering(false);
    syncPlayIcon();
    wake();
  });
  video.addEventListener("waiting", () => setBuffering(true));
  video.addEventListener("canplay", () => setBuffering(false));
  video.addEventListener("seeked", () => setBuffering(false));
  video.addEventListener("play", syncPlayIcon);
  video.addEventListener("pause", () => {
    syncPlayIcon();
    wake();
  });
  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("progress", updateProgress);
  video.addEventListener("durationchange", updateProgress);
  video.addEventListener("ended", () => {
    syncPlayIcon();
    if (queue.length) playNext();
  });
  video.addEventListener("error", () => {
    if (!hasMedia() || hls) return; // fired by us clearing the source, or hls.js owns error handling
    setBuffering(false);
    const code = video.error && video.error.code;
    setMessage(
      code === 2
        ? "The connection dropped while loading the video."
        : code === 3
        ? "The browser couldn't decode this stream. Try another quality."
        : "This stream couldn't be played (unsupported format or YouTube refused it). Try another quality."
    );
  });

  // ---------- controls ----------

  function syncPlayIcon() {
    const paused = video.paused;
    setIcon(playBtn, paused ? "play" : "pause");
    playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
  }

  function togglePlay() {
    if (!hasMedia()) return;
    if (video.paused) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      video.pause();
    }
  }

  let scrubbing = false;

  function updateProgress() {
    const t = video.currentTime || 0;
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (current.info && current.info.duration) || 0;
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    if (!scrubbing) seek.value = Math.round(pct * 10);
    seek.style.setProperty("--played", `${pct}%`);
    timeEl.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;

    let end = 0;
    const b = video.buffered;
    if (b && b.length) {
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t + 0.5 && b.end(i) > end) end = b.end(i);
      }
    }
    seek.style.setProperty("--buffered", `${d ? Math.min(100, (end / d) * 100) : 0}%`);
  }

  const seekDuration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);

  seek.addEventListener("pointerdown", () => {
    scrubbing = true;
  });
  seek.addEventListener("input", () => {
    scrubbing = true;
    const d = seekDuration();
    const pct = Number(seek.value) / 10;
    seek.style.setProperty("--played", `${pct}%`);
    timeEl.textContent = `${fmtTime((pct / 100) * d)} / ${fmtTime(d)}`;
  });
  seek.addEventListener("change", () => {
    const d = seekDuration();
    if (d) video.currentTime = (Number(seek.value) / 1000) * d;
    scrubbing = false;
    seek.blur(); // hand keyboard shortcuts back to the page
  });

  function seekBy(delta) {
    const d = seekDuration();
    let t = video.currentTime + delta;
    t = Math.max(0, d ? Math.min(d, t) : t);
    video.currentTime = t;
    updateProgress();
  }

  function syncVolumeUI() {
    const level = video.muted ? 0 : Math.round(video.volume * 100);
    volume.value = String(level);
    setIcon(muteBtn, level === 0 ? "muted" : "volume");
    muteBtn.setAttribute("aria-label", level === 0 ? "Unmute" : "Mute");
  }

  volume.addEventListener("input", () => {
    const v = Number(volume.value) / 100;
    video.volume = v;
    video.muted = v === 0;
  });
  volume.addEventListener("change", () => volume.blur());
  video.addEventListener("volumechange", () => {
    syncVolumeUI();
    store.set("ytVolume", video.volume);
    store.set("ytMuted", video.muted);
  });

  function toggleMute() {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else {
      video.muted = true;
    }
  }

  function changeVolume(delta) {
    video.muted = false;
    video.volume = Math.min(1, Math.max(0, Math.round((video.volume + delta) * 100) / 100));
  }

  for (const s of SPEEDS) {
    const opt = el("option", "", `${s}x`);
    opt.value = String(s);
    speedSel.appendChild(opt);
  }
  speedSel.value = "1";

  function setSpeed(rate) {
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    speedSel.value = String(rate);
  }
  speedSel.addEventListener("change", () => {
    setSpeed(Number(speedSel.value));
    speedSel.blur();
  });
  function stepSpeed(dir) {
    const i = SPEEDS.indexOf(Number(speedSel.value));
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))];
    setSpeed(next);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else if (player.requestFullscreen) {
      player.requestFullscreen().catch(() => {});
    }
  }
  document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    setIcon(fsBtn, on ? "exitFullscreen" : "fullscreen");
    fsBtn.setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
  });

  playBtn.addEventListener("click", togglePlay);
  nextBtn.addEventListener("click", () => playNext());
  muteBtn.addEventListener("click", toggleMute);
  fsBtn.addEventListener("click", toggleFullscreen);
  video.addEventListener("click", togglePlay);
  video.addEventListener("dblclick", toggleFullscreen);

  // hide the controls after a moment of mouse inactivity while playing
  let idleTimer = null;
  function wake() {
    player.classList.remove("is-idle");
    clearTimeout(idleTimer);
    if (!video.paused) idleTimer = setTimeout(() => player.classList.add("is-idle"), 2500);
  }
  player.addEventListener("mousemove", wake);
  player.addEventListener("mouseleave", () => {
    clearTimeout(idleTimer);
    if (!video.paused) idleTimer = setTimeout(() => player.classList.add("is-idle"), 800);
  });

  // ---------- queue ----------

  const queue = [];

  function addToQueue(item) {
    if (queue.some((q) => q.id === item.id)) return;
    queue.push(item);
    renderQueue();
  }

  function removeFromQueue(id) {
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) queue.splice(i, 1);
    renderQueue();
  }

  function playNext() {
    const next = queue.shift();
    renderQueue();
    if (next) play(next);
  }

  function renderQueue() {
    queueWrap.hidden = queue.length === 0;
    nextBtn.disabled = queue.length === 0;
    queueList.replaceChildren();
    for (const item of queue) {
      const li = el("li");
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = safeThumb(item.thumbnail);

      const text = el("div", "yt-queue-text");
      text.append(el("p", "yt-queue-title", item.title), el("p", "yt-queue-author", item.author || ""));

      const playNow = el("button", "yt-mini-btn");
      playNow.type = "button";
      playNow.title = "Play now";
      playNow.setAttribute("aria-label", "Play now");
      setIcon(playNow, "play");
      playNow.addEventListener("click", () => {
        removeFromQueue(item.id);
        play(item);
      });

      const remove = el("button", "yt-mini-btn", "×");
      remove.type = "button";
      remove.title = "Remove from queue";
      remove.setAttribute("aria-label", "Remove from queue");
      remove.addEventListener("click", () => removeFromQueue(item.id));

      li.append(img, text, playNow, remove);
      queueList.appendChild(li);
    }
  }

  queueClear.addEventListener("click", () => {
    queue.length = 0;
    renderQueue();
  });

  // ---------- keyboard shortcuts ----------

  document.addEventListener("keydown", (e) => {
    if (!view.classList.contains("is-active")) return; // only while the YouTube view is showing
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (tag === "BUTTON" && (e.key === " " || e.key === "Enter")) return; // let the button act

    if (e.key === "/") {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }
    if (e.key === "n" || e.key === "N") {
      if (queue.length) {
        e.preventDefault();
        playNext();
      }
      return;
    }
    if (!hasMedia()) return;

    let handled = true;
    switch (e.key) {
      case " ":
      case "k":
      case "K":
        togglePlay();
        break;
      case "ArrowLeft":
        seekBy(-5);
        break;
      case "ArrowRight":
        seekBy(5);
        break;
      case "j":
      case "J":
        seekBy(-10);
        break;
      case "l":
      case "L":
        seekBy(10);
        break;
      case "ArrowUp":
        changeVolume(0.05);
        break;
      case "ArrowDown":
        changeVolume(-0.05);
        break;
      case "m":
      case "M":
        toggleMute();
        break;
      case "f":
      case "F":
        toggleFullscreen();
        break;
      case "<":
        stepSpeed(-1);
        break;
      case ">":
        stepSpeed(1);
        break;
      default:
        if (/^[0-9]$/.test(e.key)) {
          const d = seekDuration();
          if (d) video.currentTime = (Number(e.key) / 10) * d;
          updateProgress();
        } else {
          handled = false;
        }
    }
    if (handled) e.preventDefault();
  });

  // ---------- startup ----------

  // Read both saved values BEFORE applying either: setting one fires
  // `volumechange`, whose handler would otherwise overwrite the other.
  const savedVolume = Math.min(1, Math.max(0, Number(store.get("ytVolume", 1))));
  const savedMuted = !!store.get("ytMuted", false);
  video.volume = savedVolume;
  video.muted = savedMuted;
  setIcon(playBtn, "play");
  setIcon(nextBtn, "next");
  setIcon(fsBtn, "fullscreen");
  syncVolumeUI();
  for (const name of ["home", "results", "related"]) createFeed(name);
  showFeed("home");

  // Tell the user up front if yt-dlp is missing, instead of on their first search.
  (async () => {
    try {
      await api("/api/youtube/status");
    } catch (err) {
      if (err.code === "not_installed") showBanner(`${err.message} Then reload this page.`);
    }
  })();
})();

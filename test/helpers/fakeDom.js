"use strict";
// A tiny DOM stand-in, just big enough to run public/js/youtube.js in Node.
// It is NOT a browser: it can't decode media or lay anything out. It exists to catch
// exceptions and wrong wiring (which request is made, which src is set, what gets shown).

function matches(node, sel) {
  if (sel.includes(",")) return sel.split(",").some((one) => matches(node, one.trim())); // selector lists
  const parts = sel.match(/(\.[\w-]+|\[[^\]]+\]|^[a-z]+)/gi) || [];
  return parts.every((p) => {
    if (p[0] === ".") return node.classList.contains(p.slice(1));
    if (p[0] === "[") {
      const m = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(p); // [data-x] or [data-x="y"]
      if (!m) return false;
      const v = node.dataset[m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())];
      return m[2] === undefined ? v !== undefined : v === m[2];
    }
    return node.tagName === p.toUpperCase();
  });
}

class El {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.dataset = {};
    this.attrs = {};
    this.style = { setProperty() {} };
    this._classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      toggle: (c, on) => {
        const want = on === undefined ? !this._classes.has(c) : on;
        want ? this._classes.add(c) : this._classes.delete(c);
        return want;
      },
      contains: (c) => this._classes.has(c),
    };
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this._text = "";
    this.paused = true;
    this.muted = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.currentTime = 0;
    this.duration = NaN;
    this.loop = false;
    this.buffered = { length: 0 };
    this.plays = 0;
    if (tag === "track") this.track = { mode: "disabled" }; // HTMLTrackElement.track
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(" "); }
  set src(v) { this.attrs.src = String(v); }
  get src() { return this.attrs.src || ""; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { this._text = ""; this.children = []; }
  get selectedOptions() { return this.children.filter((c) => c.tagName === "OPTION" && c.value === this.value).slice(0, 1).concat([new El("option")]).slice(0, 1); }
  get options() { return this.children.filter((c) => c.tagName === "OPTION"); }
  get childElementCount() { return this.children.length; }
  get nextSibling() { return null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener() {}
  // Dispatches like a bubbling DOM event (click, change, ... reach ancestors' listeners too).
  dispatch(t, ev = {}) {
    let stopped = false;
    const event = { target: this, preventDefault() {}, stopPropagation() { stopped = true; }, key: "", ...ev };
    for (let n = this; n && !stopped; n = n.parent) {
      for (const f of n.listeners[t] || []) f(event);
      if (t === "click" && typeof n.onclick === "function") n.onclick(event); // the `onclick` property, like a browser
    }
    // the event then reaches document-level listeners, as in a browser
    if (!stopped && El.documentListeners) for (const f of El.documentListeners[t] || []) f(event);
  }
  click() { this.dispatch("click"); }
  append(...n) { n.forEach((x) => this.appendChild(x)); }
  appendChild(n) {
    if (typeof n === "string") n = Object.assign(new El("#text"), { _text: n });
    n.parent = this;
    this.children.push(n);
    return n;
  }
  replaceChildren(...n) { this.children = []; this._text = ""; n.forEach((x) => this.appendChild(x)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((n) => n.tagName !== "#text" && matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.tagName !== "#text" && matches(n, sel)) return n; return null; }
  focus() {} blur() {} select() {} load() {} scrollIntoView() {}
  // Like a real media element: state flips at once, the event follows asynchronously.
  pause() {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.dispatch("pause"));
  }
  play() {
    this.plays++;
    if (this.paused) {
      this.paused = false;
      queueMicrotask(() => this.dispatch("play"));
    }
    return Promise.resolve();
  }
  canPlayType() { return "probably"; }
  requestPictureInPicture() { return Promise.resolve(); }
  requestFullscreen() { return Promise.resolve(); }
  getBoundingClientRect() { return { left: 0, width: 0 }; }
}

function makeEnv({ respond, seed = {} }) {
  const byId = new Map();
  const root = new El("body");
  const ids = ["view-youtube", "ytSearchForm", "ytSearchInput", "ytBanner", "ytFeedTabs", "ytFeeds", "ytClearHistory", "ytPlayerWrap", "ytPlayer", "ytVideo",
    "ytSpinner", "ytPlayerMsg", "ytSeek", "ytPlayBtn", "ytNextBtn", "ytMuteBtn", "ytVolume", "ytTime", "ytSpeed", "ytQuality", "ytFullscreen", "ytTitle", "ytChannel",
    "ytQueue", "ytQueueList", "ytQueueClear", "ytCaptions", "ytLoop", "ytPip", "ytTheater", "ytSponsor", "ytSubBtn", "ytChannelIcon", "ytMeta", "ytCaptionStyleBtn", "ytCaptionPanel", "ytClose"];
  for (const id of ids) {
    const e = new El(id === "ytVideo" ? "video" : id === "ytSearchInput" ? "input" : "div");
    byId.set(id, e);
    root.appendChild(e);
  }
  byId.get("ytFeedTabs").children = [];
  for (const [name, hidden] of [["home", false], ["results", true], ["related", true], ["subs", false], ["channel", true], ["playlist", true], ["history", false]]) {
    const b = new El("button");
    b.className = "yt-feed-tab";
    b.dataset.feed = name;
    b.hidden = hidden;
    b.textContent = name;
    byId.get("ytFeedTabs").appendChild(b);
  }
  byId.get("view-youtube").classList.add("is-active");
  byId.get("ytPlayerWrap").hidden = true;
  byId.get("ytSubBtn").classList.add("yt-sub-btn"); // classes index.html gives these buttons
  byId.get("ytClose").classList.add("yt-action-btn");
  byId.get("ytSubBtn").hidden = true;
  byId.get("ytChannelIcon").hidden = true;
  byId.get("ytCaptionStyleBtn").classList.add("yt-cc-style"); // classes the page's selectors rely on
  byId.get("ytCaptionPanel").classList.add("yt-cc-panel");
  byId.get("ytCaptionStyleBtn").hidden = true;
  byId.get("ytCaptionPanel").hidden = true;

  const store = new Map(Object.entries(seed));
  const requests = [];
  const audios = []; // every `new Audio()` the page made
  const listeners = {};
  const sandbox = {
    console, URL, Blob, AbortController, Promise, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, Set, Map, Number, String, Error, encodeURIComponent, decodeURIComponent,
    document: {
      getElementById: (id) => byId.get(id) || null,
      head: new El("head"),
      createElement: (t) => new El(t),
      createTextNode: (t) => Object.assign(new El("#text"), { _text: String(t) }),
      querySelectorAll: (sel) => root.querySelectorAll(sel),
      addEventListener: (t, f) => (listeners[t] ||= []).push(f),
      fullscreenElement: null,
      pictureInPictureEnabled: true,
      pictureInPictureElement: null,
    },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    Audio: class extends El { constructor() { super("audio"); audios.push(this); } },
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; this.n = new Map(); }
      observe(t) { const c = this.n.get(t) || 0; if (c >= 3) return; this.n.set(t, c + 1); queueMicrotask(() => this.cb([{ isIntersecting: true, target: t }])); }
      unobserve() {}
    },
    fetch: async (url) => {
      requests.push(url);
      const r = await respond(url);
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    },
    URLSearchParams,
    Hls: undefined,
  };
  El.documentListeners = listeners;
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (t, f) => (listeners[t] ||= []).push(f);
  return { sandbox, byId, root, store, requests, audios, listeners, El };
}

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

module.exports = { makeEnv, tick, El };

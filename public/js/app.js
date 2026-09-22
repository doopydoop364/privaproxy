import { BareMuxConnection } from "/baremux/index.mjs";

// ---------- Tab switching ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
    tab.classList.add("is-active");
    document.getElementById(`view-${tab.dataset.view}`).classList.add("is-active");
  });
});

// ---------- Proxy dropdown + bare-mux setup ----------
// As of Ultraviolet v3, the service worker doesn't talk to a bare server
// directly -- it goes through bare-mux's SharedWorker, which needs a
// transport set *before* the service worker tries to use it. This is also
// what makes the proxy dropdown actually DO something: switching the
// selection just calls setTransport() again with a different backend.
const proxyPicker = document.getElementById("proxyPicker");
const proxyDot = document.getElementById("proxyDot");
const enginePicker = document.getElementById("enginePicker");

let bareMuxConnection = null;
let scramjetController = null;

const PROXY_REFRESH_MS = 5000;

function formatProxyLabel(p) {
  if (p.online === false) return `${p.name} (offline)`;
  if (typeof p.latencyMs === "number") return `${p.name} — ${p.latencyMs}ms`;
  return `${p.name} — checking…`;
}

async function fetchProxies() {
  const res = await fetch("/api/proxies");
  return res.json();
}

// Renders the dropdown from the latest proxy list and returns whichever
// entry ends up selected (keeps the current selection if it's still
// online, otherwise falls back to the first online entry).
function renderProxyOptions(proxies) {
  const previousValue = proxyPicker.value;

  const sameBackends =
    proxyPicker.options.length === proxies.length &&
    proxies.every((p, i) => proxyPicker.options[i].value === p.id);

  if (sameBackends) {
    // Same backends as last time: just refresh the labels in place. Rebuilding
    // the <select> on every refresh would snap it shut if the person had it
    // open when one landed -- and refreshes now come every few seconds.
    proxies.forEach((p, i) => {
      const opt = proxyPicker.options[i];
      opt.textContent = formatProxyLabel(p);
      opt.disabled = p.online === false;
    });
  } else {
    proxyPicker.innerHTML = "";
    proxies.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = formatProxyLabel(p);
      opt.disabled = p.online === false;
      proxyPicker.appendChild(opt);
    });
  }

  const stillGood = proxies.some((p) => p.id === previousValue && p.online !== false);
  const wanted = stillGood
    ? previousValue
    : (proxies.find((p) => p.online !== false) || proxies[0] || {}).id;
  if (wanted !== undefined && proxyPicker.value !== wanted) proxyPicker.value = wanted;

  const anyOnline = proxies.some((p) => p.online);
  proxyDot.className = "proxy-dot " + (anyOnline ? "online" : "offline");

  return proxies.find((p) => p.id === proxyPicker.value) || null;
}

// id of the backend bare-mux is actually using right now. The dropdown can
// change without the person touching it (a backend going offline, or the
// first list load failing), so every refresh re-syncs the transport to
// whatever ends up selected instead of assuming the two agree.
let appliedProxyId = null;

async function switchToProxy(proxy) {
  if (!bareMuxConnection || !proxy || proxy.id === appliedProxyId) return;
  await bareMuxConnection.setTransport("/baremod/index.mjs", [
    location.origin + proxy.bareEndpoint,
  ]);
  appliedProxyId = proxy.id;
}

async function refreshProxies() {
  try {
    const selected = renderProxyOptions(await fetchProxies());
    await switchToProxy(selected);
    return selected;
  } catch (err) {
    console.error("Failed to load proxy list:", err);
    proxyDot.className = "proxy-dot offline";
    return null;
  }
}

proxyPicker.addEventListener("change", () => refreshProxies());

async function setupProxy() {
  await refreshProxies(); // renders the list; can't switch yet, bare-mux isn't connected

  bareMuxConnection = new BareMuxConnection("/baremux/worker.js");
  await refreshProxies(); // now applies the selected backend

  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker
      .register("/uv/sw.js", { scope: __uv$config.prefix })
      .catch((err) => console.error("Service worker registration failed:", err));
  }

  // Keeps the latency figures fresh, and moves the transport if the selected
  // backend went offline and the dropdown fell back to another one. Matches how often
  // the server re-measures (DEFAULT_INTERVAL_MS in server/proxies/latency.js).
  setInterval(refreshProxies, PROXY_REFRESH_MS);
}
setupProxy();

// ---------- Scramjet engine setup ----------
// Scramjet is a genuinely different rewriting engine (Rust/WASM instead of
// Ultraviolet's pure JS), but it uses the same bare-mux transport, so
// switchToProxy() above already covers it too -- no separate backend
// selection needed here.
// The option stays disabled until the controller is ready: a tab created
// earlier would otherwise silently fall back to Ultraviolet.
const scramjetOption = enginePicker.querySelector('option[value="scramjet"]');
scramjetOption.disabled = true;
scramjetOption.textContent = "Scramjet (loading…)";

async function setupScramjet() {
  try {
    const { ScramjetController } = $scramjetLoadController();
    scramjetController = new ScramjetController({
      prefix: "/scramjet/service/",
      files: {
        wasm: "/scramjet/scramjet.wasm.wasm",
        all: "/scramjet/scramjet.all.js",
        sync: "/scramjet/scramjet.sync.js",
      },
    });
    await scramjetController.init();

    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker
        .register("/scramjet/sw.js", { scope: "/scramjet/service/" })
        .catch((err) => console.error("Scramjet service worker registration failed:", err));
    }
    scramjetOption.disabled = false;
    scramjetOption.textContent = "Scramjet";
  } catch (err) {
    console.error("Scramjet setup failed:", err);
    scramjetOption.textContent = "Scramjet (unavailable)";
  }
}
const scramjetReady = setupScramjet(); // awaited before restoring a saved Scramjet tab (see restoreTabs)

// ---------- Address bar / tabs -> proxied iframes ----------
const browseForm = document.getElementById("browseForm");
const urlInput = document.getElementById("urlInput");
const frameWrap = document.getElementById("frameWrap");
const browserEmpty = document.getElementById("browserEmpty");
const emptyDefault = document.getElementById("emptyDefault");
const bookmarksPanel = document.getElementById("bookmarksPanel");
const bookmarksGrid = document.getElementById("bookmarksGrid");
const bookmarkBtn = document.getElementById("bookmarkBtn");
const tabStrip = document.getElementById("tabStrip");
const newTabBtn = document.getElementById("newTabBtn");

function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A space means a search phrase ("what is node.js"), never a URL.
  const looksLikeUrl = !/\s/.test(trimmed) && (/^https?:\/\//i.test(trimmed) || /^[\w-]+(\.[\w-]+)+/.test(trimmed));
  if (looksLikeUrl) {
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  // Treat it as a search query if it doesn't look like a URL.
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Reads the CURRENT url the proxied page is actually on. Works because
// everything Ultraviolet loads is rewritten to live on our own origin, so
// the iframe is same-origin with us -- no CORS issue reading its location.
function decodeFrameUrl(win) {
  try {
    const { pathname } = win.location;
    if (!pathname.startsWith(__uv$config.prefix)) return null;
    const encodedPart = pathname.slice(__uv$config.prefix.length);
    return __uv$config.decodeUrl(encodedPart);
  } catch {
    return null;
  }
}

// A neutral placeholder shown until a tab's real favicon (if any) loads.
const DEFAULT_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6.3' fill='none' stroke='%238592a0' stroke-width='1.3'/%3E%3Cline x1='2' y1='8' x2='14' y2='8' stroke='%238592a0' stroke-width='0.9'/%3E%3Cellipse cx='8' cy='8' rx='2.8' ry='6.3' fill='none' stroke='%238592a0' stroke-width='0.9'/%3E%3C/svg%3E";

let tabs = []; // { id, tabEl, iframeEl, realUrl, history, historyIndex, suppressHistoryPush }
let activeTabId = null;
let tabCounter = 0;
let draggedTabId = null;

function getTab(id) {
  return tabs.find((t) => t.id === id);
}

// ---------- Drag-to-reorder tabs ----------
function attachDragHandlers(tabEl, id) {
  tabEl.addEventListener("dragstart", (e) => {
    draggedTabId = id;
    tabEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  tabEl.addEventListener("dragend", () => {
    tabEl.classList.remove("dragging");
    draggedTabId = null;
    tabStrip
      .querySelectorAll(".browser-tab")
      .forEach((el) => el.classList.remove("drag-over"));
  });
  tabEl.addEventListener("dragover", (e) => {
    if (draggedTabId === null || draggedTabId === id) return;
    e.preventDefault(); // required to allow a drop
    tabEl.classList.add("drag-over");
  });
  tabEl.addEventListener("dragleave", () => {
    tabEl.classList.remove("drag-over");
  });
  tabEl.addEventListener("drop", (e) => {
    e.preventDefault();
    tabEl.classList.remove("drag-over");
    if (draggedTabId === null || draggedTabId === id) return;

    const draggedEl = tabStrip.querySelector(`[data-tab-id="${draggedTabId}"]`);
    if (!draggedEl) return;

    // Drop on the left half of the target -> insert before it;
    // right half -> insert after it.
    const rect = tabEl.getBoundingClientRect();
    const insertAfter = e.clientX > rect.left + rect.width / 2;
    tabStrip.insertBefore(draggedEl, insertAfter ? tabEl.nextSibling : tabEl);

    syncTabOrderFromDom();
  });
}

// Keeps our `tabs` array's order matching the pills' actual DOM order after
// a drag-and-drop reorder (used e.g. by closeTab to pick a sensible
// neighboring tab).
function syncTabOrderFromDom() {
  const orderedIds = Array.from(tabStrip.querySelectorAll(".browser-tab")).map(
    (el) => el.dataset.tabId
  );
  tabs.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
  saveTabs();
}

// ---------- Restoring tabs after a reload ----------
// Just engine + URL per tab, in order, plus which one was active -- not the
// full back/forward history (a fresh load on restore is a fine trade for the
// simplicity, same as goHistory's fresh loads within a session).
const TABS_KEY = "browserTabs";
const TABS_MAX = 20;

function saveTabs() {
  try {
    const snapshot = tabs.filter((t) => t.realUrl).slice(-TABS_MAX);
    localStorage.setItem(
      TABS_KEY,
      JSON.stringify({
        tabs: snapshot.map((t) => ({ engine: t.engine, url: t.realUrl })),
        activeIndex: snapshot.findIndex((t) => t.id === activeTabId),
      })
    );
  } catch {
    /* storage unavailable: tabs just won't persist */
  }
}

function readSavedTabs() {
  try {
    const data = JSON.parse(localStorage.getItem(TABS_KEY) || "null");
    if (!data || !Array.isArray(data.tabs)) return null;
    const rawActiveIndex = Number.isInteger(data.activeIndex) ? data.activeIndex : -1;
    // Track the active tab's position THROUGH the filter below: our own writes never
    // produce an invalid entry, but a future schema change or a tampered/corrupted
    // value could, and dropping one would otherwise shift every later index without
    // shifting activeIndex to match, pointing it at the wrong (or no) restored tab.
    let activeIndex = -1;
    const list = [];
    data.tabs.forEach((t, i) => {
      if (!t || typeof t.url !== "string" || (t.engine !== "uv" && t.engine !== "scramjet")) return;
      if (i === rawActiveIndex) activeIndex = list.length;
      list.push(t);
    });
    const tabs = list.slice(0, TABS_MAX);
    if (!tabs.length) return null;
    return { tabs, activeIndex: activeIndex < tabs.length ? activeIndex : -1 };
  } catch {
    return null;
  }
}

// Recreates the tabs open at the end of the last session, or -- if there's
// nothing saved, storage is unavailable, or it's the first visit -- falls
// back to the usual single empty tab.
async function restoreTabs() {
  const saved = readSavedTabs();
  if (!saved) {
    createTab();
    return;
  }
  // A saved Scramjet tab needs the controller ready first, or (see the
  // comment by scramjetOption above) it would silently open as Ultraviolet
  // instead. Restoring is the one place a tab's engine isn't the person's own
  // live choice, so this wait is worth it here even though picking Scramjet
  // from the dropdown itself doesn't block on it.
  if (saved.tabs.some((t) => t.engine === "scramjet")) await scramjetReady;

  const restored = saved.tabs.map((t) => {
    // Scramjet failed to set up since this was saved: fall back to Ultraviolet
    // rather than lose the tab.
    const engine = t.engine === "scramjet" && scramjetOption.disabled ? "uv" : t.engine;
    return createTab(t.url, engine);
  });

  const active = restored[saved.activeIndex];
  if (active) setActiveTab(active.id);
}

function applyDecodedUrl(tab, decoded) {
  tab.realUrl = decoded;
  tab.tabEl.querySelector(".browser-tab-title").textContent = hostnameOf(decoded);
  if (tab.id === activeTabId) {
    urlInput.value = decoded;
    updateBookmarkBtn();
  }
  loadFavicon(tab, decoded); // fire-and-forget; updates the pill once it resolves
}

// ---------- Bookmarks + new-tab page ----------
// { url, title, favicon } per entry; favicon is whatever data: URI the tab was
// showing when bookmarked (DEFAULT_FAVICON, or a same-origin one loadFavicon()
// already fetched through the proxy -- never an external image URL, same as
// tab pills already only ever hold data: URIs here).
const BOOKMARKS_KEY = "browserBookmarks";
const BOOKMARKS_MAX = 200;

function readBookmarks() {
  try {
    const list = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((b) => b && typeof b.url === "string") : [];
  } catch {
    return [];
  }
}

function writeBookmarks(list) {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list.slice(0, BOOKMARKS_MAX)));
  } catch {
    /* storage unavailable: bookmarks just won't persist */
  }
}

const isBookmarked = (url) => !!url && readBookmarks().some((b) => b.url === url);

function toggleBookmark(tab) {
  if (!tab || !tab.realUrl) return;
  const list = readBookmarks();
  const idx = list.findIndex((b) => b.url === tab.realUrl);
  if (idx === -1) {
    list.unshift({
      url: tab.realUrl,
      title: tab.tabEl.querySelector(".browser-tab-title").textContent || hostnameOf(tab.realUrl),
      favicon: tab.tabEl.querySelector(".browser-tab-favicon").src,
    });
  } else {
    list.splice(idx, 1);
  }
  writeBookmarks(list);
  updateBookmarkBtn();
  if (!browserEmpty.hidden) renderBookmarks(); // the new-tab page is showing right now: keep it live
}

function updateBookmarkBtn() {
  const tab = getTab(activeTabId);
  bookmarkBtn.disabled = !(tab && tab.realUrl);
  const on = !!(tab && isBookmarked(tab.realUrl));
  bookmarkBtn.classList.toggle("is-bookmarked", on);
  bookmarkBtn.textContent = on ? "★" : "☆"; // filled / outline star
  bookmarkBtn.title = on ? "Remove bookmark" : "Bookmark this page";
}

// The empty-state page shown for a tab with nothing loaded: your bookmarks if
// you have any (click to open, × to remove), or the plain hint otherwise.
function renderBookmarks() {
  const list = readBookmarks();
  emptyDefault.hidden = list.length > 0;
  bookmarksPanel.hidden = list.length === 0;
  if (!list.length) return;

  bookmarksGrid.replaceChildren();
  for (const b of list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "bookmark-card";
    card.title = b.url;

    const icon = document.createElement("img");
    icon.className = "bookmark-favicon";
    icon.alt = "";
    icon.src = b.favicon || DEFAULT_FAVICON;
    card.appendChild(icon);

    const text = document.createElement("span");
    text.className = "bookmark-text";
    const title = document.createElement("span");
    title.className = "bookmark-title";
    title.textContent = b.title || hostnameOf(b.url); // never innerHTML: page titles are untrusted
    const host = document.createElement("span");
    host.className = "bookmark-host";
    host.textContent = hostnameOf(b.url);
    text.append(title, host);
    card.appendChild(text);

    card.addEventListener("click", () => navigateTab(activeTabId, b.url));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "bookmark-remove";
    remove.textContent = "×";
    remove.title = "Remove bookmark";
    remove.setAttribute("aria-label", "Remove bookmark");
    remove.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger the card's own click (navigate)
      writeBookmarks(readBookmarks().filter((x) => x.url !== b.url));
      updateBookmarkBtn();
      renderBookmarks();
    });
    card.appendChild(remove);

    bookmarksGrid.appendChild(card);
  }
}

function createTab(initialTarget, engine) {
  const id = `tab-${++tabCounter}`;
  engine = engine || enginePicker.value; // "uv" or "scramjet" -- fixed for this tab's life

  const tabEl = document.createElement("div");
  tabEl.className = "browser-tab tab-enter"; // starts hidden, animates in below
  tabEl.dataset.tabId = id;
  tabEl.draggable = true;
  tabEl.innerHTML =
    `<img class="browser-tab-favicon" src="${DEFAULT_FAVICON}" alt="" />` +
    `<span class="browser-tab-title">New Tab</span>` +
    `<button class="browser-tab-close" type="button" title="Close tab">&times;</button>`;
  tabEl.addEventListener("click", (e) => {
    if (e.target.closest(".browser-tab-close")) return;
    setActiveTab(id);
  });
  tabEl.querySelector(".browser-tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  attachDragHandlers(tabEl, id);
  tabStrip.insertBefore(tabEl, newTabBtn);

  // Two rAFs: first lets the "enter" (hidden) state actually paint, second
  // removes it so the transition to normal state is what animates -- doing
  // this in one frame would skip straight to the end state with no animation.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => tabEl.classList.remove("tab-enter"));
  });

  let iframeEl;
  let scramjetFrame = null;

  if (engine === "scramjet" && scramjetController) {
    // Scramjet manages its own iframe creation/navigation/history via this
    // frame object -- .frame is the real underlying <iframe>, which we
    // treat the same as a plain UV iframe everywhere else (hide/show,
    // favicon lookup, removal).
    scramjetFrame = scramjetController.createFrame();
    iframeEl = scramjetFrame.frame;
    iframeEl.className = "browser-frame";
    iframeEl.title = "Proxied browser tab (Scramjet)";
    iframeEl.hidden = true;
    frameWrap.appendChild(iframeEl);
    scramjetFrame.addEventListener("urlchange", (e) => onScramjetUrlChange(id, e.url));
  } else {
    iframeEl = document.createElement("iframe");
    iframeEl.className = "browser-frame";
    iframeEl.title = "Proxied browser tab";
    iframeEl.hidden = true;
    iframeEl.addEventListener("load", () => onFrameLoad(id));
    frameWrap.appendChild(iframeEl);
  }

  const tab = {
    id,
    tabEl,
    iframeEl,
    engine: scramjetFrame ? "scramjet" : "uv",
    scramjetFrame,
    realUrl: null,
    history: [],
    historyIndex: -1,
    suppressHistoryPush: false,
    loading: false,
  };
  tabs.push(tab);
  setActiveTab(id);

  if (initialTarget) navigateTab(id, initialTarget);
  return tab;
}

function setActiveTab(id) {
  activeTabId = id;
  tabs.forEach((t) => {
    const isActive = t.id === id;
    t.tabEl.classList.toggle("is-active", isActive);
    t.iframeEl.hidden = !isActive;
  });

  const tab = getTab(id);
  if (tab && tab.realUrl) {
    urlInput.value = tab.realUrl;
    browserEmpty.hidden = true;
    browserEmpty.style.display = "none";
  } else {
    urlInput.value = "";
    browserEmpty.hidden = false;
    browserEmpty.style.display = "";
    renderBookmarks();
  }
  updateNavButtons();
  updateBookmarkBtn();
  saveTabs();
}

bookmarkBtn.addEventListener("click", () => toggleBookmark(getTab(activeTabId)));

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const [tab] = tabs.splice(idx, 1); // remove from state immediately
  saveTabs();

  // Animate the pill out, then actually remove the DOM nodes once the
  // transition finishes (with a timeout fallback in case it doesn't fire).
  tab.tabEl.classList.add("tab-exit");
  const cleanup = () => {
    tab.tabEl.remove();
    tab.iframeEl.remove();
  };
  tab.tabEl.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 220);

  if (tabs.length === 0) {
    createTab(); // always keep at least one tab open
    return;
  }
  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1];
    setActiveTab(next.id);
  }
}

function setTabFavicon(tab, src) {
  const img = tab.tabEl.querySelector(".browser-tab-favicon");
  if (img) img.src = src;
}

// Marks a tab as loading (or not): drives the spinner ring around its favicon
// (pure CSS, see .browser-tab.is-loading) and, for the active tab, the
// Reload/Stop button. Only our own navigations (address bar, back/forward,
// reload) set this -- a link clicked *inside* a proxied page still updates the
// address bar and history once it lands (see onFrameLoad/onScramjetUrlChange),
// it just doesn't show a transient spinner for that step, the same for both
// engines.
function setTabLoading(tab, loading) {
  tab.loading = loading;
  tab.tabEl.classList.toggle("is-loading", loading);
  if (tab.id === activeTabId) updateNavButtons();
}

function reloadTab(tab) {
  if (!tab || !tab.realUrl) return;
  setTabLoading(tab, true);
  if (tab.engine === "scramjet") {
    tab.scramjetFrame.reload();
  } else {
    try {
      // Same-origin (UV proxies everything onto our own origin), and unlike
      // re-assigning iframeEl.src to the same string, this reliably reloads.
      tab.iframeEl.contentWindow.location.reload();
    } catch {
      // contentWindow was somehow inaccessible: re-assigning src to the SAME
      // encoded URL string is a no-op in most browsers (no navigation, no
      // 'load' event), which would leave setTabLoading(true) above stuck
      // forever. Force an actual navigation via a real URL change first.
      tab.iframeEl.src = "about:blank";
      setTimeout(() => {
        setTabLoading(tab, true); // the about:blank load already cleared it
        tab.iframeEl.src = __uv$config.prefix + __uv$config.encodeUrl(tab.realUrl);
      }, 0);
    }
  }
}

function stopTab(tab) {
  if (!tab) return;
  try {
    tab.iframeEl.contentWindow.stop();
  } catch {
    // Cross-origin or already gone; nothing more we can do.
  }
  setTabLoading(tab, false);
}

// Fetches the page's favicon from *inside* the already-proxied iframe
// context (not the parent page) so the request goes through the proxy
// like everything else, rather than the browser hitting the real site
// directly and leaking that the person is visiting it.
async function loadFavicon(tab, decodedUrl) {
  try {
    const doc = tab.iframeEl.contentDocument;
    const win = tab.iframeEl.contentWindow;
    if (!doc || !win) return;

    // Ultraviolet already rewrites <link rel="icon"> hrefs found in the
    // page to same-origin proxied URLs -- if one exists, it just works.
    let iconHref = doc.querySelector('link[rel~="icon"]')?.href;

    if (!iconHref) {
      // No explicit <link>; fall back to the conventional /favicon.ico,
      // encoding it the way whichever engine this tab uses expects.
      const fallbackReal = new URL("/favicon.ico", decodedUrl).href;
      if (tab.engine === "scramjet" && scramjetController) {
        iconHref = new URL(scramjetController.encodeUrl(fallbackReal), win.location.origin).href;
      } else {
        iconHref = new URL(
          __uv$config.prefix + __uv$config.encodeUrl(fallbackReal),
          win.location.origin
        ).href;
      }
    }

    const res = await win.fetch(iconHref);
    if (!res.ok) return;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return;

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    // Guard against a slow fetch resolving after the tab already moved on
    // to a different page.
    if (tab.realUrl === decodedUrl) setTabFavicon(tab, dataUrl);
  } catch {
    // No favicon, blocked, or failed to fetch -- just keep the default.
  }
}

function navigateTab(id, rawTarget) {
  const tab = getTab(id);
  if (!tab) return;
  const target = normalizeUrl(rawTarget);
  if (!target) return;

  tab.tabEl.querySelector(".browser-tab-title").textContent = hostnameOf(target);
  setTabFavicon(tab, DEFAULT_FAVICON);
  // Set before setTabLoading()/pushHistory() below (both can call updateNavButtons(),
  // which reads tab.realUrl to decide whether Reload/Stop is enabled): a brand-new
  // tab's realUrl is still null at this point otherwise, so the very first
  // navigation would show a Stop button the person can't actually click.
  tab.realUrl = target; // optimistic; corrected once the navigation actually resolves
  setTabLoading(tab, true);

  if (tab.engine === "scramjet") {
    tab.scramjetFrame.go(target); // urlchange listener handles the rest
  } else {
    tab.iframeEl.src = __uv$config.prefix + __uv$config.encodeUrl(target);
    pushHistory(tab, target);
  }

  if (tab.id === activeTabId) {
    urlInput.value = target;
    browserEmpty.hidden = true;
    browserEmpty.style.display = "none";
    updateBookmarkBtn();
  }
}

// Our own per-tab history stack -- deliberately NOT using either engine's
// native back()/forward(). Browsers merge iframe navigations into the
// tab's overall "joint session history", so calling those natively bleeds
// past the proxy once a tab's own steps run out and starts navigating the
// real browser tab -- true for a raw iframe's history.back(), and equally
// true for Scramjet's ScramjetFrame.back()/forward(), which (checked in
// its source) just calls the same native contentWindow.history APIs under
// the hood. Tracking it ourselves avoids that entirely for both engines,
// at the minor cost of a fresh load (no scroll/state restore) each time
// you go back or forward.
function pushHistory(tab, url) {
  if (tab.history[tab.historyIndex] === url) return; // no-op re-navigation
  tab.history = tab.history.slice(0, tab.historyIndex + 1);
  tab.history.push(url);
  tab.historyIndex = tab.history.length - 1;
  if (tab.id === activeTabId) updateNavButtons();
  saveTabs();
}

function goHistory(tab, direction) {
  const newIndex = tab.historyIndex + direction;
  if (newIndex < 0 || newIndex >= tab.history.length) return;
  tab.historyIndex = newIndex;

  const target = tab.history[newIndex];
  tab.suppressHistoryPush = true;
  tab.tabEl.querySelector(".browser-tab-title").textContent = hostnameOf(target);
  setTabFavicon(tab, DEFAULT_FAVICON);
  setTabLoading(tab, true);

  if (tab.engine === "scramjet") {
    tab.scramjetFrame.go(target); // NOT .back()/.forward() -- see comment above
  } else {
    tab.iframeEl.src = __uv$config.prefix + __uv$config.encodeUrl(target);
  }
  tab.realUrl = target;

  if (tab.id === activeTabId) {
    urlInput.value = target;
    updateNavButtons();
    updateBookmarkBtn();
  }
}

function updateNavButtons() {
  const tab = getTab(activeTabId);
  backBtn.disabled = !(tab && tab.historyIndex > 0);
  forwardBtn.disabled = !(tab && tab.historyIndex < tab.history.length - 1);

  reloadBtn.disabled = !(tab && tab.realUrl);
  const loading = !!(tab && tab.loading);
  reloadBtn.textContent = loading ? "✕" : "↻"; // stop (✕) / reload (↻)
  reloadBtn.title = loading ? "Stop" : "Reload";
}

// Fires on every navigation inside a UV-proxied page too (not just the
// first load), since the iframe re-fires "load" on internal navigation --
// this is what keeps the address bar in sync as the person clicks around.
function onFrameLoad(id) {
  const tab = getTab(id);
  if (!tab) return;
  setTabLoading(tab, false);

  const decoded = decodeFrameUrl(tab.iframeEl.contentWindow);
  if (decoded) {
    applyDecodedUrl(tab, decoded);

    if (tab.suppressHistoryPush) {
      // This load was caused by our own goHistory(), not a real new
      // navigation -- don't push another entry for it.
      tab.suppressHistoryPush = false;
    } else {
      // Covers link clicks made *inside* the proxied page, which never go
      // through navigateTab() -- this is what makes in-page browsing
      // history work, not just address-bar navigations.
      pushHistory(tab, decoded);
    }
  }

  try {
    const title = tab.iframeEl.contentDocument?.title;
    if (title) tab.tabEl.querySelector(".browser-tab-title").textContent = title;
  } catch {
    // Some pages briefly land on about:blank mid-navigation; ignore.
  }

  if (tab.id === activeTabId) updateNavButtons();
}

// Scramjet's equivalent of onFrameLoad -- it tells us the real URL
// directly via the event, so there's no manual decoding step. It also
// fires for programmatic navigation we triggered ourselves via goHistory(),
// so it needs the same suppressHistoryPush guard the UV path uses to
// avoid double-pushing into our own history stack (see the comment on
// pushHistory for why we maintain this ourselves rather than trusting
// Scramjet's native back()/forward()).
function onScramjetUrlChange(id, url) {
  const tab = getTab(id);
  if (!tab || !url) return;
  setTabLoading(tab, false);

  applyDecodedUrl(tab, url);

  if (tab.suppressHistoryPush) {
    tab.suppressHistoryPush = false;
  } else {
    pushHistory(tab, url);
  }

  try {
    const title = tab.iframeEl.contentDocument?.title;
    if (title) tab.tabEl.querySelector(".browser-tab-title").textContent = title;
  } catch {
    // Ignore -- same mid-navigation edge case as the UV path.
  }

  if (tab.id === activeTabId) updateNavButtons();
}

newTabBtn.addEventListener("click", () => createTab());

const backBtn = document.getElementById("backBtn");
const forwardBtn = document.getElementById("forwardBtn");
const reloadBtn = document.getElementById("reloadBtn");

backBtn.addEventListener("click", () => {
  const tab = getTab(activeTabId);
  if (tab) goHistory(tab, -1);
});
forwardBtn.addEventListener("click", () => {
  const tab = getTab(activeTabId);
  if (tab) goHistory(tab, 1);
});
reloadBtn.addEventListener("click", () => {
  const tab = getTab(activeTabId);
  if (!tab) return;
  if (tab.loading) stopTab(tab);
  else reloadTab(tab);
});

browseForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!activeTabId) {
    createTab(urlInput.value);
    return;
  }
  navigateTab(activeTabId, urlInput.value);
});

restoreTabs(); // the tabs open at the end of the last session, or one empty tab

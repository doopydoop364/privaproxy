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
  proxyPicker.innerHTML = "";

  proxies.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = formatProxyLabel(p);
    opt.disabled = p.online === false;
    proxyPicker.appendChild(opt);
  });

  const stillGood = proxies.some((p) => p.id === previousValue && p.online !== false);
  if (stillGood) {
    proxyPicker.value = previousValue;
  } else {
    const firstOnline = proxies.find((p) => p.online !== false) || proxies[0];
    if (firstOnline) proxyPicker.value = firstOnline.id;
  }

  const anyOnline = proxies.some((p) => p.online);
  proxyDot.className = "proxy-dot " + (anyOnline ? "online" : "offline");

  return proxies.find((p) => p.id === proxyPicker.value) || null;
}

async function refreshProxies() {
  try {
    return renderProxyOptions(await fetchProxies());
  } catch (err) {
    console.error("Failed to load proxy list:", err);
    proxyDot.className = "proxy-dot offline";
    return null;
  }
}

async function switchToProxy(proxy) {
  if (!bareMuxConnection || !proxy) return;
  await bareMuxConnection.setTransport("/baremod/index.mjs", [
    location.origin + proxy.bareEndpoint,
  ]);
}

proxyPicker.addEventListener("change", async () => {
  const proxies = await fetchProxies();
  const selected = proxies.find((p) => p.id === proxyPicker.value);
  if (selected) await switchToProxy(selected);
});

async function setupProxy() {
  const initial = await refreshProxies();

  bareMuxConnection = new BareMuxConnection("/baremux/worker.js");
  await switchToProxy(initial);

  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker
      .register("/uv/sw.js", { scope: __uv$config.prefix })
      .catch((err) => console.error("Service worker registration failed:", err));
  }

  // Keeps the latency figures fresh; doesn't change the active transport
  // unless the person picks a different entry themselves.
  setInterval(refreshProxies, 20000);
}
setupProxy();

// ---------- Scramjet engine setup ----------
// Scramjet is a genuinely different rewriting engine (Rust/WASM instead of
// Ultraviolet's pure JS), but it uses the same bare-mux transport, so
// switchToProxy() above already covers it too -- no separate backend
// selection needed here.
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
  } catch (err) {
    console.error("Scramjet setup failed:", err);
  }
}
setupScramjet();

// ---------- Address bar / tabs -> proxied iframes ----------
const browseForm = document.getElementById("browseForm");
const urlInput = document.getElementById("urlInput");
const frameWrap = document.getElementById("frameWrap");
const browserEmpty = document.getElementById("browserEmpty");
const tabStrip = document.getElementById("tabStrip");
const newTabBtn = document.getElementById("newTabBtn");

function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const looksLikeUrl = /^https?:\/\//i.test(trimmed) || /^[\w-]+(\.[\w-]+)+/.test(trimmed);
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
}

function applyDecodedUrl(tab, decoded) {
  tab.realUrl = decoded;
  tab.tabEl.querySelector(".browser-tab-title").textContent = hostnameOf(decoded);
  if (tab.id === activeTabId) urlInput.value = decoded;
  loadFavicon(tab, decoded); // fire-and-forget; updates the pill once it resolves
}

function createTab(initialTarget) {
  const id = `tab-${++tabCounter}`;
  const engine = enginePicker.value; // "uv" or "scramjet" -- fixed for this tab's life

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
  }
  updateNavButtons();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const [tab] = tabs.splice(idx, 1); // remove from state immediately

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

  if (tab.engine === "scramjet") {
    tab.scramjetFrame.go(target); // urlchange listener handles the rest
  } else {
    tab.iframeEl.src = __uv$config.prefix + __uv$config.encodeUrl(target);
    pushHistory(tab, target);
  }
  tab.realUrl = target; // optimistic; corrected once the navigation actually resolves

  if (tab.id === activeTabId) {
    urlInput.value = target;
    browserEmpty.hidden = true;
    browserEmpty.style.display = "none";
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
}

function goHistory(tab, direction) {
  const newIndex = tab.historyIndex + direction;
  if (newIndex < 0 || newIndex >= tab.history.length) return;
  tab.historyIndex = newIndex;

  const target = tab.history[newIndex];
  tab.suppressHistoryPush = true;
  tab.tabEl.querySelector(".browser-tab-title").textContent = hostnameOf(target);
  setTabFavicon(tab, DEFAULT_FAVICON);

  if (tab.engine === "scramjet") {
    tab.scramjetFrame.go(target); // NOT .back()/.forward() -- see comment above
  } else {
    tab.iframeEl.src = __uv$config.prefix + __uv$config.encodeUrl(target);
  }
  tab.realUrl = target;

  if (tab.id === activeTabId) {
    urlInput.value = target;
    updateNavButtons();
  }
}

function updateNavButtons() {
  const tab = getTab(activeTabId);
  backBtn.disabled = !(tab && tab.historyIndex > 0);
  forwardBtn.disabled = !(tab && tab.historyIndex < tab.history.length - 1);
}

// Fires on every navigation inside a UV-proxied page too (not just the
// first load), since the iframe re-fires "load" on internal navigation --
// this is what keeps the address bar in sync as the person clicks around.
function onFrameLoad(id) {
  const tab = getTab(id);
  if (!tab) return;

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

backBtn.addEventListener("click", () => {
  const tab = getTab(activeTabId);
  if (tab) goHistory(tab, -1);
});
forwardBtn.addEventListener("click", () => {
  const tab = getTab(activeTabId);
  if (tab) goHistory(tab, 1);
});

browseForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!activeTabId) {
    createTab(urlInput.value);
    return;
  }
  navigateTab(activeTabId, urlInput.value);
});

createTab(); // start with one empty tab

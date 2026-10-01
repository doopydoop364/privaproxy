"use strict";
// Search engine choice and the PrivaSearch results view.
//
// The dropdown (here and in the browser toolbar, kept in sync) picks the engine for typed searches. DuckDuckGo keeps its existing path: the
// phrase goes to the proxied browser exactly as before. PrivaSearch is queried through THIS server (`/api/privasearch/search`), which holds the
// PrivaSearch address and credential; nothing in this file knows either. Results are plain text built with textContent (page text is untrusted),
// and opening a result always goes through the proxied browser (`window.privaproxyBrowse`), never a direct navigation.
(() => {
  const ENGINE_KEY = "privaproxy.searchEngine";
  const ENGINES = ["duckduckgo", "privasearch"];
  const POLL_MS = 4000, MAX_POLLS = 8, PAGE = 10;

  /** True for what the address bar treats as a search phrase rather than an address (the same rule as normalizeUrl in app.js). */
  function isSearchPhrase(raw) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return false;
    const looksLikeUrl = !/\s/.test(trimmed) && (/^https?:\/\//i.test(trimmed) || /^[\w-]+(\.[\w-]+)+/.test(trimmed));
    if (looksLikeUrl) { try { new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`); return false; } catch { /* malformed: a search */ } }
    return true;
  }
  const clamp = (value, max) => String(value ?? "").slice(0, max);
  function age(ms, now = Date.now()) {
    if (!ms) return "";
    const days = Math.floor((now - ms) / 86400000);
    return days < 1 ? "fetched today" : days === 1 ? "fetched yesterday" : days < 60 ? `fetched ${days} days ago` : `fetched ${Math.round(days / 30)} months ago`;
  }
  function statusFor(data, loading) {
    if (loading) return { kind: "info", message: "Searching PrivaSearch…" };
    const { crawl, index, total } = data;
    if (total === 0) {
      if (crawl.state === "scheduled") return { kind: "info", message: "No indexed results yet. PrivaSearch started crawling for this query; results will appear here as pages are indexed." };
      if (crawl.state === "cooldown") return { kind: "info", message: "No indexed results yet. PrivaSearch is already crawling for this query or tried recently; results will appear here as pages are indexed." };
      if (crawl.state === "disabled") return { kind: "info", message: "No indexed results for this query, and crawling is turned off on this PrivaSearch server." };
      return { kind: "info", message: "No indexed results yet for this query." };
    }
    if (crawl.state === "scheduled") return { kind: "info", message: "Expanding the PrivaSearch index for this query." };
    if (index.state === "partial" && crawl.state === "cooldown") return { kind: "info", message: "Only a few results are indexed so far; PrivaSearch is still expanding its index." };
    return null;
  }
  const errorMessage = (code) => ({
    NOT_CONFIGURED: "PrivaSearch is not configured on this server.", RATE_LIMITED: "Too many searches in a short time. Wait a minute and try again.",
    UPSTREAM_REFUSED: "This server could not authenticate to PrivaSearch. Check its PrivaSearch settings.", TIMEOUT: "PrivaSearch took too long to answer. Try again in a moment.",
  })[code] || "PrivaSearch is temporarily unavailable. Try again in a moment.";

  const $ = (id) => document.getElementById(id);
  const form = $("psForm"), input = $("psInput"), status = $("psStatus"), list = $("psResults"), more = $("psMore"), view = $("view-search");
  const pickers = [$("psEngine"), $("searchEnginePicker")].filter(Boolean);

  let engine = "duckduckgo", enabled = false, sequence = 0, polls = 0, pollTimer = null, current = null;
  const saved = () => { try { const v = localStorage.getItem(ENGINE_KEY); return ENGINES.includes(v) ? v : null; } catch { return null; } };
  const remember = (value) => { try { localStorage.setItem(ENGINE_KEY, value); } catch { /* the choice just is not remembered */ } };

  function setEngine(value, persist = true) {
    engine = ENGINES.includes(value) && (value !== "privasearch" || enabled) ? value : "duckduckgo";
    for (const picker of pickers) picker.value = engine;
    if (persist) remember(engine);
  }
  function setStatus(message, kind) {
    if (!status) return;
    status.hidden = !message; status.textContent = message || ""; if (kind) status.dataset.kind = kind; else delete status.dataset.kind;
  }
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function renderHit(hit) {
    const item = element("li", "ps-hit");
    const title = element("a", "ps-title", clamp(hit.title, 300) || hit.url);
    title.href = "#"; title.rel = "noopener noreferrer"; title.dataset.url = hit.url;
    title.addEventListener("click", (event) => { event.preventDefault(); window.privaproxyBrowse?.(hit.url); });
    let where = hit.url; try { const u = new URL(hit.url); where = `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`; } catch { /* show it whole */ }
    const meta = [hit.totalTerms > 1 && hit.matchedTerms < hit.totalTerms ? `matches ${hit.matchedTerms} of ${hit.totalTerms} words` : "", age(hit.fetchedAt)].filter(Boolean).join(" · ");
    item.append(title, element("div", "ps-url", clamp(where, 200)), element("p", "ps-snippet", clamp(hit.snippet, 500)), ...(meta ? [element("div", "ps-meta", meta)] : []));
    return item;
  }
  function render(data, append) {
    if (!append) list.replaceChildren();
    for (const hit of data.hits) list.appendChild(renderHit(hit));
    more.hidden = !(data.offset + data.hits.length < data.total);
  }

  async function request(query, offset) {
    let response;
    try { response = await fetch(`/api/privasearch/search?q=${encodeURIComponent(query)}&offset=${offset}&limit=${PAGE}`); }
    catch { return { error: "UNAVAILABLE" }; }
    let body = null; try { body = await response.json(); } catch { /* not JSON */ }
    if (!response.ok || !body || !Array.isArray(body.hits)) return { error: (body && body.error) || "UNAVAILABLE" };
    return { data: body };
  }

  async function search(query, { offset = 0, poll = false } = {}) {
    const mine = ++sequence;
    clearTimeout(pollTimer);
    if (!poll && offset === 0) { current = null; polls = 0; setStatus(statusFor(null, true).message, "info"); }
    const result = await request(query, offset);
    if (mine !== sequence) return; // a newer search replaced this one
    if (result.error) {
      setStatus(errorMessage(result.error), "error"); // earlier results (if any) stay on screen
      return;
    }
    const data = result.data;
    if (offset === 0) { const changed = !current || current.total !== data.total; current = data; if (!poll || changed) render(data, false); else more.hidden = !(data.offset + data.hits.length < data.total); }
    else { current = { ...data, hits: (current?.hits || []).concat(data.hits) }; render(data, true); }
    const note = statusFor(data, false);
    setStatus(note ? note.message : "", note?.kind);
    // While PrivaSearch is still crawling for this query, look again a few times, gently; never indefinitely.
    if (offset === 0 && data.index.state !== "ready" && ["scheduled", "cooldown"].includes(data.crawl.state) && polls < MAX_POLLS) {
      polls++;
      pollTimer = setTimeout(() => { if (view?.classList.contains("is-active") && input.value.trim() === query) search(query, { poll: true }); }, POLL_MS);
    }
  }

  function run(query) {
    const q = String(query ?? "").trim().slice(0, 200);
    if (!q) return;
    if (engine === "privasearch") { input.value = q; list.replaceChildren(); more.hidden = true; search(q); }
    else window.privaproxyBrowse?.(q); // the existing path: the proxied DuckDuckGo results page
  }

  /** The browser address bar calls this; true means it handled the input (a search phrase with PrivaSearch selected). */
  function handleAddressBar(value) {
    if (engine !== "privasearch" || !isSearchPhrase(value)) return false;
    document.querySelector('.tab[data-view="search"]')?.click();
    run(value);
    return true;
  }

  form?.addEventListener("submit", (event) => { event.preventDefault(); run(input.value); });
  more?.addEventListener("click", () => { if (current) search(input.value.trim(), { offset: current.hits.length }); });
  for (const picker of pickers) picker.addEventListener("change", () => setEngine(picker.value));

  // Whether PrivaSearch is configured decides if its option can be chosen; the option is disabled, never removed.
  async function init() {
    setEngine(saved() || "duckduckgo", false);
    try {
      const response = await fetch("/api/privasearch/config");
      enabled = response.ok && (await response.json()).enabled === true;
    } catch { enabled = false; }
    for (const picker of pickers) {
      const option = [...picker.children].find((o) => o.value === "privasearch");
      if (option) { option.disabled = !enabled; option.textContent = enabled ? "PrivaSearch" : "PrivaSearch (not configured)"; }
    }
    setEngine(saved() || "duckduckgo", false);
  }

  globalThis.privasearchUi = { handleAddressBar, isSearchPhrase, setEngine, run, get engine() { return engine; }, ready: init() };
})();

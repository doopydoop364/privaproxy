"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { El, tick } = require("./helpers/fakeDom");

const SOURCE = fs.readFileSync(path.join(__dirname, "../public/js/privasearch.js"), "utf8");
const hit = (n, extra = {}) => ({ url: `https://h${n}.example/p`, title: `Result ${n}`, snippet: `snippet ${n}`, host: `h${n}.example`, score: 50 - n, fetchedAt: Date.now() - 3 * 86400000, matchedTerms: 2, totalTerms: 2, ...extra });
const answer = (hits, extra = {}) => ({ query: "q", total: hits.length, offset: 0, limit: 10, hits, index: { state: "ready", documents: 5 }, crawl: { triggered: false, state: "none", candidates: 0 }, ...extra });

/** Boots public/js/privasearch.js in a fake page: the form, both dropdowns, the results list, and the two top tabs it can click. */
async function boot({ config = { enabled: true }, respond, store = {} } = {}) {
  const byId = new Map(), calls = [], timers = new Map(), browse = [], clicks = [];
  const make = (id, tag = "div") => { const e = new El(tag); byId.set(id, e); return e; };
  const form = make("psForm", "form"), input = make("psInput", "input"), status = make("psStatus", "p"), list = make("psResults", "ol"), more = make("psMore", "button"), view = make("view-search");
  status.hidden = true; more.hidden = true;
  const pickers = ["psEngine", "searchEnginePicker"].map((id) => {
    const select = make(id, "select");
    for (const value of ["duckduckgo", "privasearch"]) { const o = new El("option"); o.value = value; o.textContent = value; select.appendChild(o); }
    select.value = "duckduckgo"; return select;
  });
  const searchTab = new El("button"); searchTab.addEventListener("click", () => { clicks.push("search"); view.classList.add("is-active"); });
  let nextTimer = 0;
  const storage = new Map(Object.entries(store));
  const window_ = {
    document: { getElementById: (id) => byId.get(id) || null, createElement: (tag) => new El(tag), querySelector: (sel) => (sel === '.tab[data-view="search"]' ? searchTab : null) },
    URL, Date, Math, JSON, Array, String, Number, Object, Set, encodeURIComponent, clearTimeout: (id) => timers.delete(id),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    fetch: async (url) => {
      calls.push(url);
      const r = url.startsWith("/api/privasearch/config") ? { status: 200, body: config } : (respond ? await respond(url) : { status: 200, body: answer([hit(1)]) });
      return { ok: r.status < 400, status: r.status, json: async () => { if (r.body === undefined) throw new Error("not json"); return r.body; } };
    },
    privaproxyBrowse: (target) => browse.push(target),
  };
  window_.window = window_; window_.globalThis = window_;
  vm.createContext(window_); vm.runInContext(SOURCE, window_);
  await window_.privasearchUi.ready; await tick();
  return { ui: window_.privasearchUi, calls, timers, browse, clicks, storage, form, input, status, list, more, view, pickers, searchTab,
    searchCalls: () => calls.filter((c) => c.startsWith("/api/privasearch/search")),
    submit(q) { input.value = q; form.dispatch("submit"); }, flush: async () => { for (let i = 0; i < 5; i++) await tick(); },
    runTimer() { const [id, t] = [...timers][0] || []; assert.ok(t, "a timer is scheduled"); timers.delete(id); t.fn(); } };
}

test("the dropdown offers DuckDuckGo and PrivaSearch, defaults to the existing engine, remembers the choice and keeps both selectors in sync", async () => {
  const ui = await boot();
  assert.deepEqual(ui.pickers.map((p) => p.value), ["duckduckgo", "duckduckgo"]);
  assert.equal(ui.pickers[0].children.find((o) => o.value === "privasearch").disabled, false);
  ui.pickers[1].value = "privasearch"; ui.pickers[1].dispatch("change");
  assert.deepEqual([ui.pickers[0].value, ui.ui.engine, ui.storage.get("privaproxy.searchEngine")], ["privasearch", "privasearch", "privasearch"]);
  const again = await boot({ store: { "privaproxy.searchEngine": "privasearch" } }); assert.equal(again.ui.engine, "privasearch"); assert.equal(again.pickers[1].value, "privasearch");
});

test("when PrivaSearch is not configured its option is disabled, not removed, and a remembered choice falls back to the existing engine", async () => {
  const ui = await boot({ config: { enabled: false }, store: { "privaproxy.searchEngine": "privasearch" } });
  const option = ui.pickers[0].children.find((o) => o.value === "privasearch");
  assert.deepEqual([option.disabled, option.textContent, ui.ui.engine, ui.pickers[0].value], [true, "PrivaSearch (not configured)", "duckduckgo", "duckduckgo"]);
  ui.ui.setEngine("privasearch"); assert.equal(ui.ui.engine, "duckduckgo"); // it cannot be selected
  const failing = await boot({ config: undefined }); assert.equal(failing.ui.engine, "duckduckgo"); // an unreadable config also disables it
});

test("DuckDuckGo keeps its existing path: the phrase goes to the proxied browser and PrivaSearch is never called", async () => {
  const ui = await boot(); ui.submit("rust language"); await ui.flush();
  assert.deepEqual(ui.browse, ["rust language"]); assert.equal(ui.searchCalls().length, 0);
});

test("PrivaSearch: the query is encoded, results are rendered as plain text, and opening one goes through the proxied browser", async () => {
  const ui = await boot({ respond: async () => ({ status: 200, body: answer([hit(1, { title: '<img src=x onerror=alert(1)>', snippet: "<script>steal()</script> text" }), hit(2)]) }) });
  ui.ui.setEngine("privasearch"); ui.submit("c++ & rust? #1"); await ui.flush();
  assert.equal(ui.searchCalls()[0], "/api/privasearch/search?q=c%2B%2B%20%26%20rust%3F%20%231&offset=0&limit=10");
  const items = ui.list.children; assert.equal(items.length, 2);
  const [title, where, snippet] = items[0].children;
  assert.equal(title.textContent, "<img src=x onerror=alert(1)>"); assert.equal(snippet.textContent, "<script>steal()</script> text"); // text, never markup
  assert.equal(items[0].all().some((n) => n.tagName === "IMG" || n.tagName === "SCRIPT"), false);
  assert.equal(where.textContent, "h1.example/p"); assert.equal(title.href, "#"); // no real address to navigate to directly
  let prevented = false; title.dispatch("click", { preventDefault() { prevented = true; } });
  assert.deepEqual([prevented, ui.browse], [true, ["https://h1.example/p"]]);
});

test("the address bar hands a typed search to PrivaSearch only when it is selected and the text is a search phrase, never an address", async () => {
  const ui = await boot();
  assert.equal(ui.ui.handleAddressBar("rust language"), false); // DuckDuckGo selected: the browser handles it as before
  ui.ui.setEngine("privasearch");
  for (const address of ["example.com", "http://x.example/path", "sub.example.org/page?q=1", "localhost.example", "  "]) assert.equal(ui.ui.handleAddressBar(address), false, address);
  assert.equal(ui.searchCalls().length, 0);
  assert.equal(ui.ui.handleAddressBar("what is node.js"), true); await ui.flush();
  assert.deepEqual([ui.clicks, ui.input.value, ui.searchCalls().length], [["search"], "what is node.js", 1]);
});

test("the search-phrase rule is the same one app.js uses to decide between an address and a search", async () => {
  const { ui: { isSearchPhrase } } = await boot();
  const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  const normalize = "function normalizeUrl(raw) {" + app.split("function normalizeUrl(raw) {")[1].split("\nfunction hostnameOf")[0];
  const context = vm.createContext({ URL, encodeURIComponent }); vm.runInContext(normalize + "\nglobalThis.normalize = normalizeUrl;", context);
  for (const raw of ["rust language", "what is node.js", "example.com", "https://example.com", "http://", "https://[broken]", "example.com:invalid", "foo", "a.b", "tomato soup recipe", "ftp://x", "HTTPS://Example.com", "x y.z"])
    assert.equal(isSearchPhrase(raw), new URL(context.normalize(raw)).hostname === "duckduckgo.com" && new URL(context.normalize(raw)).searchParams.get("q") === raw.trim(), raw);
});

test("states: empty with crawling started, results with the index expanding, partial, and plain results", async () => {
  const empty = await boot({ respond: async () => ({ status: 200, body: answer([], { index: { state: "empty", documents: 0 }, crawl: { triggered: true, state: "scheduled", candidates: 3 } }) }) });
  empty.ui.setEngine("privasearch"); empty.submit("quantum widgets"); await empty.flush();
  assert.match(empty.status.textContent, /No indexed results yet\. PrivaSearch started crawling/); assert.equal(empty.status.hidden, false); assert.equal(empty.list.children.length, 0);
  const expanding = await boot({ respond: async () => ({ status: 200, body: answer([hit(1)], { index: { state: "partial", documents: 3 }, crawl: { triggered: true, state: "scheduled", candidates: 2 } }) }) });
  expanding.ui.setEngine("privasearch"); expanding.submit("x y"); await expanding.flush();
  assert.equal(expanding.status.textContent, "Expanding the PrivaSearch index for this query."); assert.equal(expanding.list.children.length, 1);
  const ready = await boot(); ready.ui.setEngine("privasearch"); ready.submit("x"); await ready.flush(); assert.equal(ready.status.hidden, true);
  const off = await boot({ respond: async () => ({ status: 200, body: answer([], { index: { state: "empty", documents: 0 }, crawl: { triggered: false, state: "disabled", candidates: 0 } }) }) });
  off.ui.setEngine("privasearch"); off.submit("x"); await off.flush(); assert.match(off.status.textContent, /crawling is turned off/);
});

test("errors are friendly and keep earlier results; nothing technical (addresses, tokens, codes) is shown", async () => {
  let fail = false;
  const ui = await boot({ respond: async () => (fail ? { status: 502, body: { error: "UNAVAILABLE" } } : { status: 200, body: answer([hit(1)]) }) });
  ui.ui.setEngine("privasearch"); ui.submit("first"); await ui.flush(); assert.equal(ui.list.children.length, 1);
  fail = true; ui.submit("second"); await ui.flush();
  assert.equal(ui.status.textContent, "PrivaSearch is temporarily unavailable. Try again in a moment."); assert.equal(ui.status.dataset.kind, "error");
  for (const [code, text] of [["NOT_CONFIGURED", /not configured/], ["RATE_LIMITED", /Too many searches/], ["TIMEOUT", /too long/], ["UPSTREAM_REFUSED", /could not authenticate/], ["WHATEVER", /temporarily unavailable/]]) {
    const e = await boot({ respond: async () => ({ status: 502, body: { error: code } }) }); e.ui.setEngine("privasearch"); e.submit("x"); await e.flush(); assert.match(e.status.textContent, text, code);
  }
  const broken = await boot({ respond: async () => ({ status: 200, body: undefined }) }); broken.ui.setEngine("privasearch"); broken.submit("x"); await broken.flush(); assert.match(broken.status.textContent, /temporarily unavailable/);
});

test("while crawling is in progress the view re-checks a few times, gently, and then stops; a new search cancels the old one", async () => {
  const scheduled = answer([], { index: { state: "empty", documents: 0 }, crawl: { triggered: true, state: "scheduled", candidates: 1 } });
  const ui = await boot({ respond: async () => ({ status: 200, body: scheduled }) });
  ui.ui.setEngine("privasearch"); ui.submit("slow topic"); await ui.flush(); ui.view.classList.add("is-active");
  let polls = 0; while (ui.timers.size > 0 && polls < 20) { assert.equal([...ui.timers.values()][0].ms, 4000); ui.runTimer(); await ui.flush(); polls++; }
  assert.equal(polls, 8); assert.equal(ui.searchCalls().length, 9); // the first search and eight re-checks, never more
  // results arriving during a re-check replace the empty list
  let phase = 0; const arriving = await boot({ respond: async () => ({ status: 200, body: phase++ === 0 ? scheduled : answer([hit(1), hit(2)], { index: { state: "ready", documents: 4 } }) }) });
  arriving.ui.setEngine("privasearch"); arriving.submit("topic"); await arriving.flush(); arriving.view.classList.add("is-active"); assert.equal(arriving.list.children.length, 0);
  arriving.runTimer(); await arriving.flush(); assert.equal(arriving.list.children.length, 2); assert.equal(arriving.timers.size, 0); assert.equal(arriving.status.hidden, true);
  // a re-check does not run for a page the person has left, or for a query they replaced
  const left = await boot({ respond: async () => ({ status: 200, body: scheduled }) }); left.ui.setEngine("privasearch"); left.submit("a"); await left.flush();
  left.runTimer(); await left.flush(); assert.equal(left.searchCalls().length, 1, "the view is not active");
});

test("a newer search always wins over a slower older one", async () => {
  const resolvers = []; const ui = await boot({ respond: (url) => new Promise((resolve) => resolvers.push({ url, resolve })) });
  ui.ui.setEngine("privasearch"); ui.submit("old"); ui.submit("new"); await ui.flush();
  resolvers[1].resolve({ status: 200, body: answer([hit(2)]) }); await ui.flush(); resolvers[0].resolve({ status: 200, body: answer([hit(1)]) }); await ui.flush();
  assert.deepEqual(ui.list.children.map((c) => c.children[0].textContent), ["Result 2"]);
});

test("more results are appended page by page until the end", async () => {
  const ui = await boot({ respond: async (url) => { const offset = Number(new URL(url, "http://x").searchParams.get("offset")); return { status: 200, body: answer(offset === 0 ? [hit(1), hit(2)] : [hit(3)], { total: 3, offset }) }; } });
  ui.ui.setEngine("privasearch"); ui.submit("many"); await ui.flush(); assert.deepEqual([ui.list.children.length, ui.more.hidden], [2, false]);
  ui.more.click(); await ui.flush(); assert.deepEqual([ui.list.children.length, ui.more.hidden], [3, true]);
  assert.match(ui.searchCalls()[1], /offset=2/);
});

test("the frontend only ever calls this server's own /api/privasearch routes and holds no credential", async () => {
  const ui = await boot(); ui.ui.setEngine("privasearch"); ui.submit("anything"); await ui.flush();
  assert.equal(ui.calls.every((c) => c.startsWith("/api/privasearch/")), true, ui.calls.join(", "));
  assert.equal(/PRIVASEARCH_|authorization|bearer/i.test(SOURCE), false); // no setting name, no credential header
  assert.equal(/["'`]https?:\/\/(?!\$\{)/.test(SOURCE), false, "no absolute address is built in (the one template literal only re-prefixes what the person typed)"); // only same-origin /api/privasearch routes
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  assert.ok(html.includes('id="psEngine"') && html.includes('id="searchEnginePicker"') && html.includes('data-view="search"') && html.includes("/js/privasearch.js"));
});

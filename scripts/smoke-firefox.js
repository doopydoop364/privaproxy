"use strict";
// Real Firefox smoke checks using WebDriver BiDi, without a browser automation dependency.
// Start an isolated Firefox first (see README), then:
//   node scripts/smoke-firefox.js [ws://127.0.0.1:9222/session] [optional test MP4]
// The fixture server only listens on loopback. Its service workers serve local
// fixture pages, so these checks do not contact YouTube or external websites.
const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert/strict");
const express = require("express");
const registry = require("../server/proxies/registry");

const A = "aaaaaaaaaaa", B = "bbbbbbbbbbb";
const CH = "UC" + "a".repeat(22), OTHER = "UC" + "b".repeat(22);
const item = id => ({ id, title: id, author: "Fixture", duration: 60, uploadedAt: 1700000000, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });
let rawNavigations = 0;
let failScramjet = false;
let adaptiveFixture = false;
let proxyFailures = 0;
let fixtureScramjet = false;
let recommendationFixture = false;
let statusChecks = 0, backendOnline = true, toolsUnavailable = false;
const app = express();
const server = http.createServer(app);
app.get("/api/proxies", (_req, res) => {
  if (proxyFailures > 0) { proxyFailures--; return res.status(503).json({ error: "temporary" }); }
  res.json([{ id: "bare-primary", name: "Primary", bareEndpoint: "/bare/", online: backendOnline, latencyMs: backendOnline ? 15 : null, checkedAt: Date.now() }]);
});
app.get("/api/auth/status", (_req, res) => { statusChecks++; res.json({ enabled: false }); });
app.get("/api/youtube/status", (_req, res) => toolsUnavailable ? res.status(503).json({ error: "unavailable" }) : res.json({ ok: true }));
app.get("/api/youtube/thumbnail/:id/:size.jpg", (_req, res) => res.type("png").send(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64")));
app.get("/api/youtube/playlist/:id", (_req, res) => res.json({ playlist: { title: "Fixture" }, results: [item(A), item(B)], hasMore: false }));
app.get("/api/youtube/video/:id", (req, res) => res.json({ ...item(req.params.id), streams: [{ formatId: "18", height: 360, label: "360p", ext: "mp4" }], captions: [], adaptive: adaptiveFixture ? {
  video: [{ formatId: "137", height: 1080, mime: "video/mp4", vcodec: "avc1.640028" }],
  audio: [{ formatId: "140", mime: "audio/mp4", acodec: "mp4a.40.2", ext: "m4a" }],
} : { video: [], audio: [] } }));
app.get("/api/youtube/stream/:id", (_req, res) => {
  if (process.argv[3]) res.sendFile(path.resolve(process.argv[3]));
  else res.status(404).end();
});
app.get("/api/youtube/related/:id", (_req, res) => res.json({ results: [], hasMore: false }));
app.get("/api/youtube/home", (_req, res) => res.json(recommendationFixture ? {
  groups: [{ seedId: "ccccccccccc", items: [{ ...item("hhhhhhhhhh1"), channelId: CH }, { ...item("hhhhhhhhhh2"), channelId: OTHER }], hasMore: false }], hasMore: false,
} : { results: [], hasMore: false }));
app.get("/api/youtube/search", (_req, res) => res.json({ results: recommendationFixture ? [item("ttttttttttt")] : [], hasMore: false }));
app.get("/api/youtube/subscriptions", (_req, res) => res.json({ results: [item(A)], hasMore: false }));
app.get("/scramjet/sw.js", (req, res, next) => {
  if (failScramjet) res.status(404).end();
  else if (fixtureScramjet) res.type("application/javascript").send(`
    self.addEventListener('fetch', event => {
      const html = '<!doctype html><script>const el=window.frameElement; const frame=Object.getOwnPropertySymbols(el).map(s=>el[s]).find(v=>v&&v.frame===el); const event=new Event("urlchange"); event.url=decodeURIComponent(location.pathname.slice("/scramjet/service/".length)); frame.dispatchEvent(event);<\\/script><title>Scramjet fixture title</title><p>Local frame fixture</p>';
      event.respondWith(Promise.resolve(new Response(html, {headers:{'content-type':'text/html'}})));
    });
  `);
  else next();
});
app.get("/uv/sw.js", (_req, res) => res.type("application/javascript").send(`
  self.addEventListener('install', event => event.waitUntil(new Promise(resolve => setTimeout(resolve, 500))));
  self.addEventListener('fetch', event => {
    event.respondWith(Promise.resolve(new Response('<!doctype html><title>Fixture page</title><p>Loaded through an active worker</p>', {headers: {'content-type':'text/html'}})));
  });
`));
app.use("/uv/service/", (_req, res) => { rawNavigations++; res.status(418).send("Worker was not ready"); });
registry.mountAll(app, server);
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
app.get("/", (req, res) => {
  const bootstrap = `<script>
    const NativeAudio = window.Audio;
    window.Audio = function(...args) { const audio = new NativeAudio(...args); window.fixtureAudio = audio; return audio; };
    if (location.search.includes('seed=1')) {
      localStorage.clear();
      localStorage.setItem('browserTabs', JSON.stringify({tabs:[{engine:'uv',url:'https://one.example/'}],activeIndex:0}));
      localStorage.setItem('ytSubs', JSON.stringify([{id:'${CH}',name:'A'},{id:'${OTHER}',name:'B'}]));
      localStorage.setItem('ytResume', JSON.stringify({'${B}':35}));
    }
  </script>`;
  res.type("html").send(html.replace("<head>", "<head>" + bootstrap));
});
app.use("/vendor/hls/", express.static(path.join(__dirname, "../node_modules/hls.js/dist")));
app.use(express.static(path.join(__dirname, "../public")));

async function main() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ws = new WebSocket(process.argv[2] || "ws://127.0.0.1:9222/session");
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error("Cannot connect to Firefox BiDi.")), { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    message.type === "error" ? waiter.reject(new Error(message.message)) : waiter.resolve(message.result);
  });
  const command = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timed out: ${method}`)); }, 20000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  let context;
  try {
    await command("session.new", { capabilities: { alwaysMatch: {} } });
    ({ context } = await command("browsingContext.create", { type: "tab" }));
    const evaluate = async expression => {
      const result = await command("script.evaluate", { expression: `(async()=>{${expression}})().then(value=>JSON.stringify(value ?? null))`, target: { context }, awaitPromise: true });
      if (result.type === "exception") throw new Error(JSON.stringify(result.exceptionDetails));
      return JSON.parse(result.result.value || "null");
    };
    const wait = async expression => {
      const start = Date.now();
      while (!await evaluate(`return !!(${expression});`)) {
        if (Date.now() - start > 15000) throw new Error(`Browser condition timed out: ${expression}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const navigate = url => command("browsingContext.navigate", { context, url, wait: "complete" });
    await navigate(origin + "/?seed=1");
    await wait(`document.querySelector('#enginePicker option[value="uv"]').textContent === 'Ultraviolet' && document.querySelector('.browser-frame')?.contentDocument?.title === 'Fixture page'`);
    assert.equal(rawNavigations, 0, "saved tab navigated before its worker activated");
    assert.equal(await evaluate("return document.querySelector('#urlInput').value;"), "https://one.example/");
    await wait(`document.querySelector('#enginePicker option[value="scramjet"]').textContent === 'Scramjet'`);
    console.log("PASS: real Firefox activates both engine workers; restored UV tab waits for installation.");

    for (const url of ["https://two.example/", "https://three.example/"]) {
      await evaluate(`document.querySelector('#urlInput').value=${JSON.stringify(url)}; document.querySelector('#browseForm').dispatchEvent(new Event('submit',{cancelable:true})); return true;`);
      await wait(`JSON.parse(localStorage.getItem('browserTabs')).tabs[0].url === ${JSON.stringify(url)} && document.querySelector('.browser-frame').contentDocument?.title === 'Fixture page'`);
    }
    await evaluate("document.querySelector('#backBtn').click(); return true;");
    await wait("JSON.parse(localStorage.getItem('browserTabs')).tabs[0].url === 'https://two.example/'");
    await navigate(origin + "/");
    await wait("document.querySelector('#urlInput').value === 'https://two.example/' && document.querySelector('.browser-frame')?.contentDocument?.title === 'Fixture page'");
    assert.equal(await evaluate("return document.querySelector('#forwardBtn').disabled;"), false, "forward history was lost on reload");
    await evaluate("document.querySelector('#forwardBtn').click(); return true;");
    await wait("document.querySelector('#urlInput').value === 'https://three.example/'");
    await evaluate("document.querySelector('.browser-tab.is-active .browser-tab-close').click(); return true;");
    await wait("!document.querySelector('#reopenTabBtn').disabled");
    await evaluate("document.querySelector('#reopenTabBtn').click(); return true;");
    await wait("document.querySelector('#urlInput').value === 'https://three.example/' && !document.querySelector('#backBtn').disabled");
    console.log("PASS: Firefox restores forward history and reopens a closed tab with its history.");
    await evaluate("document.querySelector('#urlInput').value='https://three.example/'; document.querySelector('#browseForm').dispatchEvent(new Event('submit',{cancelable:true})); return true;");
    await wait("!document.querySelector('#backBtn').disabled");
    await evaluate("document.querySelector('#backBtn').click(); document.querySelector('#forwardBtn').click(); return true;");
    await wait("JSON.parse(localStorage.getItem('browserTabs')).tabs[0].url === 'https://three.example/'");
    console.log("PASS: Back/Forward saves the current URL and browser reload restores it.");

    await wait("__uv$config.decodeUrl(document.querySelector('.browser-frame:not([hidden])').contentWindow.location.pathname.slice(__uv$config.prefix.length)) === 'https://three.example/' && !document.querySelector('#reloadBtn').title.includes('Stop')");
    await evaluate("document.querySelector('.browser-frame:not([hidden])').contentWindow.location.hash='section'; return true;");
    await wait("document.querySelector('#urlInput').value === 'https://three.example/#section' && JSON.parse(localStorage.getItem('browserTabs')).tabs[0].url.endsWith('#section')");
    console.log("PASS: in-page fragment navigation updates the address bar and saved tab.");

    await evaluate("document.querySelector('.tab[data-view=\"youtube\"]').click(); document.querySelector('[data-feed=\"subs\"]').click(); return true;");
    await wait("document.querySelector('.yt-feed[data-feed=\"subs\"] .yt-card')");
    await evaluate("document.querySelector('.yt-chip-remove').click(); return true;");
    await wait("document.querySelector('.yt-feed[data-feed=\"subs\"] .yt-card') && document.querySelectorAll('.yt-chip').length === 1");
    console.log("PASS: unsubscribing reloads the visible subscription feed.");
    await evaluate("document.querySelector('.tab[data-view=\"status\"]').click(); return true;");
    await wait("document.querySelector('#statusSummary').textContent === 'All checks passed.' && document.querySelector('#statusYoutube').textContent.includes('yt-dlp')");
    backendOnline = false; toolsUnavailable = true;
    await wait("document.querySelector('#statusBackends').textContent.includes('Primary: offline') && document.querySelector('#statusYoutube').textContent.includes('Showing last known results')");
    assert.equal(await evaluate("return document.querySelector('#statusSummary').dataset.state;"), "error");
    backendOnline = true; toolsUnavailable = false;
    await wait("document.querySelector('#statusSummary').textContent === 'All checks passed.' && document.querySelector('#statusEvents').textContent.includes('recovered')");
    console.log("PASS: status automatically detects outages, marks stale results and reports recovery.");
    await evaluate("const auto=document.querySelector('#statusAuto'); auto.checked=false; auto.dispatchEvent(new Event('change')); return true;");
    const pausedChecks = statusChecks;
    await evaluate("await new Promise(resolve=>setTimeout(resolve,5500)); return true;");
    assert.equal(statusChecks, pausedChecks, "paused status page kept polling");
    await evaluate("document.querySelector('#statusRefresh').click(); return true;");
    await wait("document.querySelector('#view-status').getAttribute('aria-busy') === 'false'");
    assert.equal(statusChecks, pausedChecks + 1, "manual refresh didn't work while auto refresh was paused");
    await evaluate("const interval=document.querySelector('#statusInterval'); interval.value='15000'; interval.dispatchEvent(new Event('change')); return true;");
    assert.equal(await evaluate("return localStorage.getItem('statusInterval');"), "15000");
    await evaluate("const interval=document.querySelector('#statusInterval'); interval.value='5000'; interval.dispatchEvent(new Event('change')); const auto=document.querySelector('#statusAuto'); auto.checked=true; auto.dispatchEvent(new Event('change')); return true;");
    await wait("document.querySelector('#view-status').getAttribute('aria-busy') === 'false'");
    await evaluate("document.querySelector('.tab[data-view=\"youtube\"]').click(); return true;");
    const hiddenChecks = statusChecks;
    await evaluate("await new Promise(resolve=>setTimeout(resolve,5500)); return true;");
    assert.equal(statusChecks, hiddenChecks, "hidden status page kept polling");
    console.log("PASS: status pause, manual refresh, interval preference and hidden-page suspension work in Firefox.");

    recommendationFixture = true;
    await evaluate("localStorage.setItem('ytHistory',JSON.stringify([{id:'ccccccccccc',title:'Space science',channelId:'" + CH + "'}])); document.querySelector('[data-feed=\"home\"]').click(); const select=document.querySelector('#ytHomeAlgo'); select.value='complex'; select.dispatchEvent(new Event('change')); return true;");
    await wait("document.querySelectorAll('.yt-feed[data-feed=\"home\"] .yt-card-feedback').length >= 3");
    assert.equal(await evaluate("return document.querySelector('#ytHomeAlgo option[value=\"complex\"]').textContent;"), "Complex");
    await wait("Object.values(JSON.parse(localStorage.getItem('ytRecommendations')).stats).some(s=>s.impressions>0)");
    const dismissed = await evaluate("const card=document.querySelector('.yt-feed[data-feed=\"home\"] .yt-card'); const id=card.querySelector('.yt-card-meta').dataset.id; [...card.querySelectorAll('.yt-card-feedback button')].find(b=>b.textContent==='Not interested').click(); return id;");
    await wait(`!document.querySelector('.yt-feed[data-feed="home"] .yt-card-meta[data-id="${dismissed}"]') && document.querySelector('.yt-feed[data-feed="home"] .yt-card-feedback')`);
    await navigate(origin + "/");
    await evaluate("document.querySelector('.tab[data-view=\"youtube\"]').click(); return true;");
    await wait("document.querySelector('.yt-feed[data-feed=\"home\"] .yt-card-feedback')");
    assert.equal(await evaluate(`return !!document.querySelector('.yt-feed[data-feed="home"] .yt-card-meta[data-id="${dismissed}"]');`), false);
    await evaluate("document.querySelector('.yt-feed[data-feed=\"home\"] .yt-action-btn').click(); return true;");
    await wait(`document.querySelector('.yt-feed[data-feed="home"] .yt-card-meta[data-id="${dismissed}"]')`);
    console.log("PASS: Complex combines candidates, counts visible impressions, persists feedback and resets it in real Firefox.");
    await evaluate("const select=document.querySelector('#ytHomeAlgo'); select.value='balanced'; select.dispatchEvent(new Event('change')); return true;");
    recommendationFixture = false;

    if (process.argv[3]) {
      await evaluate("document.querySelector('#ytSearchInput').value='https://www.youtube.com/playlist?list=PLabcdefghij'; document.querySelector('#ytSearchForm').dispatchEvent(new Event('submit',{cancelable:true})); return true;");
      await wait("document.querySelectorAll('.yt-feed[data-feed=\"playlist\"] .yt-card').length === 2");
      assert.equal(await evaluate("return document.querySelector('.yt-feed[data-feed=\"playlist\"] .yt-card img')?.src.startsWith(location.origin + '/api/youtube/thumbnail/');"), true);
      await evaluate("const cards=document.querySelectorAll('.yt-feed[data-feed=\"playlist\"] .yt-card'); cards[1].querySelector('.yt-card-queue').click(); cards[0].querySelector('.yt-card-main').click(); document.querySelector('#ytVideo').muted=true; return true;");
      await wait("!document.querySelector('#ytSaveVideo').hidden");
      await evaluate("document.querySelector('#ytSaveVideo').click(); document.querySelector('[data-feed=\"saved\"]').click(); return true;");
      await wait("document.querySelector('.yt-feed[data-feed=\"saved\"] .yt-card')");
      console.log("PASS: thumbnails stay on the local origin and Watch Later saves videos.");
      await wait("document.querySelector('#ytVideo').readyState >= 2");
      await evaluate("const video=document.querySelector('#ytVideo'); video.currentTime=video.duration-0.15; await video.play(); return true;");
      await wait(`document.querySelector('#ytVideo').getAttribute('src')?.includes('/${B}?') && document.querySelector('#ytVideo').currentTime >= 35`);
      assert.equal(await evaluate(`return JSON.parse(localStorage.getItem('ytResume'))['${B}'] >= 35;`), true);
      console.log("PASS: real media playback reaches ended, advances the queue and resumes the next video at 35 seconds.");

      await evaluate("const seek=document.querySelector('#ytSeek'); seek.dispatchEvent(new PointerEvent('pointerdown')); seek.dispatchEvent(new PointerEvent('pointerup')); const video=document.querySelector('#ytVideo'); video.currentTime=20; return true;");
      await wait("Number(document.querySelector('#ytSeek').value) >= 330 && Number(document.querySelector('#ytSeek').value) < 500");
      console.log("PASS: an unchanged seek gesture releases the progress slider.");

      await evaluate("const video=document.querySelector('#ytVideo'); video.loop=false; video.currentTime=5; await video.play(); return true;");
      await wait(`(JSON.parse(localStorage.getItem('ytRecommendations'))?.stats['${B}']?.seconds || 0) >= 5`);
      const beforeSeek = await evaluate(`return JSON.parse(localStorage.getItem('ytRecommendations')).stats['${B}'].seconds;`);
      await evaluate("const video=document.querySelector('#ytVideo'); video.currentTime=50; video.pause(); return true;");
      const afterSeek = await evaluate(`return JSON.parse(localStorage.getItem('ytRecommendations')).stats['${B}'].seconds;`);
      assert.ok(afterSeek - beforeSeek < 2, "seek counted as watch time");
      console.log("PASS: real playback records elapsed viewing without counting a seek jump.");

      adaptiveFixture = true;
      await evaluate("document.querySelector('#ytClose').click(); document.querySelector('#ytSearchInput').value='https://youtu.be/aaaaaaaaaaa'; document.querySelector('#ytSearchForm').dispatchEvent(new Event('submit',{cancelable:true})); return true;");
      await wait("document.querySelector('#ytQuality').value === 'a:137' && document.querySelector('#ytVideo').readyState >= 2 && window.fixtureAudio.readyState >= 2");
      await evaluate("const video=document.querySelector('#ytVideo'); video.muted=true; video.loop=true; video.currentTime=video.duration-0.15; await video.play(); return true;");
      await wait("document.querySelector('#ytVideo').currentTime < 3 && !document.querySelector('#ytVideo').paused && !window.fixtureAudio.paused");
      assert.equal(await evaluate("return window.fixtureAudio.paused;"), false, "looped video left its separate audio paused");
      console.log("PASS: real adaptive playback keeps its audio playing across a loop.");
    }

    await evaluate("localStorage.setItem('ytVolume',JSON.stringify('corrupt')); return true;");
    proxyFailures = 1;
    await navigate(origin + "/");
    await wait("document.querySelector('#enginePicker option[value=\"uv\"]').textContent === 'Ultraviolet' && document.querySelector('#ytVideo').volume === 1");
    console.log("PASS: corrupt saved volume is handled, and a failed proxy-list startup recovers automatically.");

    // Keep the real controller/frame, but serve a local document that emits
    // urlchange before its title is parsed, matching the client injection order.
    await evaluate("for(const registration of await navigator.serviceWorker.getRegistrations()) if(registration.scope.includes('/scramjet/service/')) await registration.unregister(); return true;");
    fixtureScramjet = true;
    await navigate(origin + "/");
    await wait("document.querySelector('#enginePicker option[value=\"scramjet\"]').textContent === 'Scramjet'");
    await evaluate("document.querySelector('#enginePicker').value='scramjet'; document.querySelector('#newTabBtn').click(); document.querySelector('#urlInput').value='https://scramjet.example/'; document.querySelector('#browseForm').dispatchEvent(new Event('submit',{cancelable:true})); return true;");
    await wait("document.querySelector('.browser-tab.is-active .browser-tab-title')?.textContent === 'Scramjet fixture title'");
    console.log("PASS: Scramjet refreshes its tab title after the document loads.");
    await evaluate("document.querySelector('#urlInput').value='http://'; document.querySelector('#browseForm').dispatchEvent(new Event('submit',{cancelable:true})); return true;");
    await wait("document.querySelector('#urlInput').value === 'https://duckduckgo.com/html/?q=http%3A%2F%2F' && document.querySelector('#reloadBtn').title === 'Reload'");
    console.log("PASS: malformed address-bar input does not leave Scramjet stuck loading.");

    // Remove the active Scramjet registration so reload must register again.
    await evaluate("for(const registration of await navigator.serviceWorker.getRegistrations()) if(registration.scope.includes('/scramjet/service/')) await registration.unregister(); return true;");
    failScramjet = true;
    await navigate(origin + "/");
    await wait("document.querySelector('#enginePicker option[value=\"scramjet\"]').textContent === 'Scramjet (unavailable)'");
    assert.equal(await evaluate("return document.querySelector('#enginePicker option[value=\"scramjet\"]').disabled;"), true);
    console.log("PASS: a rejected worker registration keeps Scramjet disabled and marks it unavailable.");
    await command("browsingContext.close", { context });
    context = null;
  } finally {
    if (context) await command("browsingContext.close", { context }).catch(() => {});
    await command("session.end", {}).catch(() => {});
    ws.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const entry of require("../server/proxies/ultraviolet").bareServers) entry.server?.close();
  }
}
main().catch(err => {
  console.error(err);
  server.closeAllConnections();
  server.close();
  for (const entry of require("../server/proxies/ultraviolet").bareServers) entry.server?.close();
  process.exitCode = 1;
});

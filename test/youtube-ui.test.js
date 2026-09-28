"use strict";
// Runs the real public/js/youtube.js against a fake DOM and canned API responses.
// It checks wiring and error-free execution, not media decoding: real playback needs a browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeEnv, tick } = require("./helpers/fakeDom");

const CH = "UC4QobU6STFB0P71PMvOGN5A";
const PL = "PLF3eNE6vR-4WsBf8qnJLqBywqX39QczxJ";
const AVATAR = `/api/youtube/channel-image/${CH}/avatar`;
const BANNER = `/api/youtube/channel-image/${CH}/banner`;
const WEEKS = (n) => Math.floor(Date.now() / 1000) - n * 7 * 86400;
const item = (id, title) => ({ id, title, author: "Someone", channelId: CH, duration: 100, views: 5, isLive: false, uploadedAt: WEEKS(3), uploadedApprox: true, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });
const CHANNEL_META = {
  id: CH, name: "Someone", avatar: `/api/youtube/channel-image/${CH}/avatar`, banner: `/api/youtube/channel-image/${CH}/banner`,
  followers: 518000000, verified: true, handle: "@someone", description: "About this channel",
};

const VIDEO = {
  id: "aaaaaaaaaaa", title: "Video A", author: "Someone", channelId: CH, duration: 100, hls: false, views: 1500, uploadedAt: WEEKS(2), uploadedApprox: false,
  streams: [{ formatId: "18", label: "360p", height: 360, ext: "mp4" }],
  adaptive: {
    video: [{ formatId: "137", height: 1080, fps: 30, ext: "mp4", mime: "video/mp4", vcodec: "avc1.640028", tbr: 4000 }],
    audio: [{ formatId: "140", ext: "m4a", mime: "audio/mp4", acodec: "mp4a.40.2", abr: 129 }],
  },
  captions: [{ lang: "en", name: "English", auto: false }],
  available: {}, warnings: [],
};

function boot(seed, override, setup) {
  const timers = [];
  const env = makeEnv({
    seed,
    respond: async (url) => {
      if (override) {
        const response = await override(url);
        if (response) return response;
      }
      if (url.startsWith("/api/youtube/status")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/api/youtube/playlist/")) return { status: 200, body: { playlist: { id: PL, title: "My list", author: "Me" }, results: [item("aaaaaaaaaaa", "Video A"), item("bbbbbbbbbbb", "Video B"), item("ccccccccccc", "Video C")], hasMore: false } };
      if (url.startsWith("/api/youtube/channel/")) return { status: 200, body: { channel: CHANNEL_META, results: [item("aaaaaaaaaaa", "Video A")], hasMore: false } };
      if (url.startsWith("/api/youtube/subscriptions")) return { status: 200, body: { results: [item("bbbbbbbbbbb", "Video B")], hasMore: false } };
      if (url.startsWith("/api/youtube/video/")) return { status: 200, body: { ...VIDEO, id: url.split("/").pop() } };
      if (url.startsWith("/api/youtube/sponsorblock/")) return { status: 200, body: { segments: [{ start: 10, end: 20, category: "sponsor" }] } };
      if (url.startsWith("/api/youtube/related/")) return { status: 200, body: { results: [{ ...item("rrrrrrrrrrr", "Mix video"), uploadedAt: null, uploadedApprox: false }, { ...item("sssssssssss", "Mix video 2"), uploadedAt: null, uploadedApprox: false }], hasMore: false } };
      if (url.startsWith("/api/youtube/dates")) return { status: 200, body: { dates: { rrrrrrrrrrr: Math.floor(Date.now() / 1000) - 2 * 365.25 * 86400 - 5 * 86400 } } };
      if (url.startsWith("/api/youtube/home")) {
        if (/[?&]group=1\b/.test(url)) {
          return {
            status: 200,
            body: {
              groups: [
                { seedId: "aaaaaaaaaaa", items: [item("hhhhhhhhhh1", "Home A"), item("hhhhhhhhhh2", "Home A2")], hasMore: false },
                { seedId: "bbbbbbbbbbb", items: [item("hhhhhhhhhh3", "Home B")], hasMore: false },
              ],
              hasMore: false,
            },
          };
        }
        return { status: 200, body: { results: [item("hhhhhhhhhh1", "Home A"), item("hhhhhhhhhh3", "Home B")], hasMore: false } };
      }
      return { status: 404, body: { error: "nope", message: "unexpected request " + url } };
    },
  });
  env.sandbox.YtPure = require("../public/js/ytpure.js");
  env.sandbox.YtRecommendations = require("../public/js/recommendations.js");
  if (setup) setup(env);
  // record long timers (the audio-hold watchdog) so tests can fire them without waiting
  const realSetTimeout = env.sandbox.setTimeout;
  env.sandbox.setTimeout = (fn, ms, ...a) => (ms >= 5000 ? (timers.push({ fn, ms }), timers.length) : realSetTimeout(fn, ms, ...a));
  env.timers = timers;
  vm.createContext(env.sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/js/youtube.js"), "utf8"), env.sandbox, { filename: "youtube.js" });
  return env;
}

const tabBtn = (env, name) => env.byId.get("ytFeedTabs").querySelector(`[data-feed="${name}"]`);
const feedSection = (env, name) => env.byId.get("ytFeeds").querySelector(`[data-feed="${name}"]`);
const cards = (env, name) => feedSection(env, name).querySelectorAll(".yt-card");
const submit = async (env, text) => {
  env.byId.get("ytSearchInput").value = text;
  env.byId.get("ytSearchForm").dispatch("submit");
  await tick();
};

test("Complex shows the watch-first prompt after startup and after clearing an in-flight feed", async () => {
  const empty = boot({ ytHomeAlgo: JSON.stringify("complex") });
  await tick();
  assert.match(feedSection(empty, "home").querySelector(".yt-feed-status").textContent, /once you've watched/);
  assert.equal(empty.requests.some(u => u.startsWith("/api/youtube/home")), false);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Space science")]) },
    async url => url.startsWith("/api/youtube/home") ? (await gate, { status: 200, body: { groups: [{ items: [item("hhhhhhhhhh1", "Late result")] }], hasMore: false } }) : null);
  await tick();
  env.byId.get("ytClearHistory").click();
  assert.match(feedSection(env, "home").querySelector(".yt-feed-status").textContent, /once you've watched/);
  release();
  await tick();
  assert.equal(cards(env, "home").length, 0);
  assert.deepEqual(JSON.parse(env.store.get("ytRecommendations")), {});
  assert.equal(env.requests.some(u => u.startsWith("/api/youtube/channel/")), false, "abandoned results must not start discovery work after data is cleared");
});

test("removing the last history item immediately clears hidden Complex results and training records", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Video A")]),
    ytRecommendations: JSON.stringify({ examples: [{ id: "aaaaaaaaaaa", features: Array(8).fill(0.5), watchReward: 1 }] }) });
  await tick();
  assert.ok(cards(env, "home").length > 0);
  tabBtn(env, "history").click();
  await tick();
  cards(env, "history")[0].querySelector(".yt-card-remove").click();
  assert.equal(cards(env, "home").length, 0);
  assert.match(feedSection(env, "home").querySelector(".yt-feed-status").textContent, /once you've watched/);
  assert.equal(JSON.parse(env.store.get("ytRecommendations")).examples.some(e => e.id === "aaaaaaaaaaa"), false);
  tabBtn(env, "home").click();
  await tick();
  assert.equal(cards(env, "home").length, 0);
});

test("normal searches refresh Complex interests without inventing watch history, and can be cleared", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex") }, async url => url.startsWith("/api/youtube/search") ?
    { status: 200, body: { results: [item("ttttttttttt", "New search result")], hasMore: false } } : null);
  await submit(env, "astronomy telescopes");
  assert.equal(JSON.parse(env.store.get("ytRecommendations")).searches[0].query, "astronomy telescopes");
  assert.equal(env.store.has("ytHistory"), false);
  assert.equal(cards(env, "results")[0].querySelector(".yt-avatar-sm").src, AVATAR);
  assert.equal(cards(env, "results")[0].querySelector(".yt-avatar-sm").loading, "lazy");
  tabBtn(env, "home").click();
  await tick();
  assert.ok(env.requests.some(u => u.includes("q=astronomy%20telescopes&limit=12")));
  assert.ok(cards(env, "home").length > 0);
  feedSection(env, "home").querySelectorAll("button").find(b => b.textContent === "Clear search interests").click();
  await tick();
  assert.match(feedSection(env, "home").querySelector(".yt-feed-status").textContent, /once you've watched/);
});

test("cross-tab data clearing restores Complex's empty state", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Video A")]) });
  await tick();
  for (const key of ["ytHistory", "ytRecommendations", "ytSubs", "ytSavedLists"]) env.store.delete(key);
  for (const handler of env.listeners.storage) handler({ key: null, storageArea: env.sandbox.localStorage });
  await tick();
  assert.equal(cards(env, "home").length, 0);
  assert.match(feedSection(env, "home").querySelector(".yt-feed-status").textContent, /once you've watched/);
});

test("impression writes from another tab do not cause a recommendation refresh loop", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Video A")]) });
  await tick();
  const before = env.requests.filter(u => u.startsWith("/api/youtube/home")).length;
  const state = require("../public/js/recommendations").recordImpression(JSON.parse(env.store.get("ytRecommendations")), "hhhhhhhhhh1");
  env.store.set("ytRecommendations", JSON.stringify(state));
  for (const handler of env.listeners.storage) handler({ key: "ytRecommendations", newValue: JSON.stringify(state), storageArea: env.sandbox.localStorage });
  await tick();
  assert.equal(env.requests.filter(u => u.startsWith("/api/youtube/home")).length, before);
  assert.ok(cards(env, "home").length > 0);
});

test("Complex settings can undo blocked channels and feedback, while learning stays gated", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Video A")]) });
  await tick();
  const settings = feedSection(env, "home").querySelector(".yt-recommendation-settings");
  assert.equal(settings.querySelectorAll("input").every(c => c.disabled && !c.checked), true);
  cards(env, "home")[0].querySelector(".yt-card-feedback").querySelectorAll("button").find(b => b.textContent === "Block channel").click();
  await tick();
  feedSection(env, "home").querySelectorAll("button").find(b => b.textContent.startsWith("Unblock ")).click();
  await tick();
  assert.equal(JSON.parse(env.store.get("ytRecommendations")).blockedChannels.length, 0);
  cards(env, "home")[0].querySelector(".yt-card-feedback").querySelectorAll("button").find(b => b.textContent === "Not interested").click();
  await tick();
  feedSection(env, "home").querySelectorAll("button").find(b => b.textContent === "Clear video feedback").click();
  await tick();
  assert.equal(Object.keys(JSON.parse(env.store.get("ytRecommendations")).feedback).length, 0);
  assert.ok(cards(env, "home").length > 0);
});

test("creator discovery adds one unfamiliar channel's uploads and stops paging it when exhausted", async () => {
  const other = "UC" + "b".repeat(22);
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Video A")]) }, async url => {
    if (url.startsWith("/api/youtube/home")) return { status: 200, body: { groups: [{ items: [{ ...item("hhhhhhhhhh1", "Discovery"), channelId: other }] }], hasMore: false } };
    if (url.startsWith(`/api/youtube/channel/${other}`)) return { status: 200, body: { results: [{ ...item("ddddddddddd", "Creator upload"), channelId: other }], hasMore: false } };
  });
  await tick();
  assert.ok(cards(env, "home").some(c => c.textContent.includes("Creator upload")));
  assert.equal(env.requests.filter(u => u.startsWith("/api/youtube/channel/")).length, 1);
});

test("history imports rebuild hidden Home and include imported seeds when shown", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex") });
  await tick();
  tabBtn(env, "history").click();
  await tick();
  const file = feedSection(env, "history").querySelector("input");
  file.files = [{ size: 100, text: async () => JSON.stringify([item("aaaaaaaaaaa", "Imported astronomy")]) }];
  file.dispatch("change");
  await tick();
  assert.doesNotMatch(feedSection(env, "home").querySelector(".yt-feed-status").textContent, /once you've watched/);
  assert.equal(env.requests.some(u => u.startsWith("/api/youtube/home")), false, "hidden Home defers retrieval");
  tabBtn(env, "home").click();
  await tick();
  assert.ok(env.requests.some(u => u.startsWith("/api/youtube/home?seeds=aaaaaaaaaaa")));
  assert.ok(cards(env, "home").length > 0);
});

test("new watches and subscription changes invalidate hidden Home immediately", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex") });
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  assert.doesNotMatch(feedSection(env, "home").querySelector(".yt-feed-status").textContent, /once you've watched/);
  assert.equal(env.requests.some(u => u.startsWith("/api/youtube/home")), false);
  env.byId.get("ytSubBtn").click();
  tabBtn(env, "home").click();
  await tick();
  assert.ok(env.requests.some(u => u.startsWith(`/api/youtube/subscriptions?channels=${CH}`)));
  const count = env.requests.filter(u => u.startsWith("/api/youtube/home")).length;
  env.byId.get("ytSubBtn").click();
  await tick();
  assert.ok(env.requests.filter(u => u.startsWith("/api/youtube/home")).length > count);
});

test("learning controls unlock at the data goal and enabling a model persists explicit consent", async () => {
  const state = { stats: {}, feedback: {}, examples: [] };
  for (let i = 0; i < 120; i++) {
    const id = String(i).padStart(11, "0");
    state.stats[id] = { seconds: 40, duration: 60, impressions: 5 };
    if (i < 20) state.feedback[id] = { value: i % 2 ? "more" : "less" };
    state.examples.push({ id, features: [0.5, i % 2, 0.2, 0, 0, 0.3, 0, 1], watchReward: i % 2 });
  }
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytRecommendations: JSON.stringify(state) });
  await tick();
  let settings = feedSection(env, "home").querySelector(".yt-recommendation-settings");
  settings.open = true;
  const checkbox = settings.querySelectorAll("input")[0];
  assert.equal(checkbox.disabled, false);
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.dispatch("change");
  await tick();
  assert.equal(JSON.parse(env.store.get("ytRecommendations")).models.bandit, true);
  settings = feedSection(env, "home").querySelector(".yt-recommendation-settings");
  assert.equal(settings.open, true);
  assert.match(settings.textContent, /active locally/);
  feedSection(env, "home").querySelectorAll("button").find(b => b.textContent === "Reset recommendation data").click();
  await tick();
  assert.equal(require("../public/js/recommendations").localLearningStatus(JSON.parse(env.store.get("ytRecommendations"))).active, false);
});

test("Complex combines grouped Mixes, bounded subscription uploads and topic searches locally", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Space science planets")]),
    ytSubs: JSON.stringify([1, 2, 3].map(n => ({ id: "UC" + String(n).repeat(22), name: `Channel ${n}` }))) },
  async url => url.startsWith("/api/youtube/search") ? { status: 200, body: { results: [item("ttttttttttt", "Topic result")], hasMore: false } } : null);
  await tick();
  assert.ok(env.requests.some(u => u.startsWith("/api/youtube/home") && u.includes("group=1")));
  const subscriptions = new URL(env.requests.find(u => u.startsWith("/api/youtube/subscriptions")), "http://localhost");
  assert.equal(subscriptions.searchParams.get("channels").split(",").length, 2);
  const search = new URL(env.requests.find(u => u.startsWith("/api/youtube/search")), "http://localhost");
  assert.equal(search.searchParams.get("limit"), "12");
  assert.match(search.searchParams.get("q"), /science|space|planets/);
  assert.ok(cards(env, "home").some(c => c.textContent.includes("Topic result")));
  assert.ok(cards(env, "home").every(c => c.querySelector(".yt-card-reason")));
  assert.ok(Object.values(JSON.parse(env.store.get("ytRecommendations")).stats).some(s => s.impressions > 0));
  assert.ok(!env.requests.some(u => /seconds|feedback|blockedChannels/.test(u)), "private profile isn't sent to the server");
});

test("Complex feedback survives reloads, hides unwanted videos and blocks channels", async () => {
  const seed = { ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Video A")]) };
  const env = boot(seed);
  await tick();
  const first = cards(env, "home")[0];
  first.querySelector(".yt-card-feedback").querySelectorAll("button").find(b => b.textContent === "Not interested").click();
  await tick();
  const state = JSON.parse(env.store.get("ytRecommendations"));
  const dismissed = Object.keys(state.feedback)[0];
  assert.equal(state.feedback[dismissed].value, "less");
  assert.ok(!cards(env, "home").some(c => c.querySelector(".yt-card-meta").dataset.id === dismissed));
  const reload = boot(Object.fromEntries(env.store));
  await tick();
  assert.ok(!cards(reload, "home").some(c => c.querySelector(".yt-card-meta").dataset.id === dismissed));
  cards(reload, "home")[0].querySelector(".yt-card-feedback").querySelectorAll("button").find(b => b.textContent === "Block channel").click();
  await tick();
  assert.deepEqual(JSON.parse(reload.store.get("ytRecommendations")).blockedChannels, [CH]);
  assert.equal(cards(reload, "home").length, 0);
  feedSection(reload, "home").querySelector(".yt-action-btn").click();
  await tick();
  assert.ok(cards(reload, "home").length > 0, "reset restores blocked creators");
});

test("More like this supplies an explicit seed without inventing a watch", async () => {
  const env = boot({ ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "A")]) });
  await tick();
  const card = cards(env, "home")[0], id = card.querySelector(".yt-card-meta").dataset.id;
  card.querySelector(".yt-card-feedback").querySelectorAll("button").find(b => b.textContent === "More like this").click();
  await tick();
  assert.equal(JSON.parse(env.store.get("ytRecommendations")).feedback[id].value, "more");
  assert.ok(env.requests.some(u => u.startsWith("/api/youtube/home") && u.includes(id)));
  assert.equal(JSON.parse(env.store.get("ytHistory")).length, 1);
});

test("Complex can start with subscriptions alone and tolerate failed candidate sources", async () => {
  const seed = { ytHomeAlgo: JSON.stringify("complex"), ytSubs: JSON.stringify([{ id: CH, name: "Someone" }]) };
  const emptyHistory = boot(seed);
  await tick();
  assert.equal(cards(emptyHistory, "home").length, 1);
  assert.ok(!emptyHistory.requests.some(u => u.startsWith("/api/youtube/home") || u.startsWith("/api/youtube/search")));
  const partial = boot({ ...seed, ytHistory: JSON.stringify([item("aaaaaaaaaaa", "A")]) }, async url =>
    url.startsWith("/api/youtube/home") || url.startsWith("/api/youtube/search") ? { status: 503, body: { message: "Unavailable" } } : null);
  await tick();
  assert.equal(cards(partial, "home").length, 1);
});

test("Complex stops exhausted sources and offers Retry when all sources fail", async () => {
  const seed = { ytHomeAlgo: JSON.stringify("complex"), ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Space science")]) };
  const env = boot(seed, async url => {
    if (url.startsWith("/api/youtube/search")) return { status: 200, body: { results: [], hasMore: false } };
    if (url.startsWith("/api/youtube/home")) {
      const page = Number(new URL(url, "http://localhost").searchParams.get("page"));
      return { status: 200, body: { groups: [{ seedId: "aaaaaaaaaaa", items: [item(`hhhhhhhhhh${page}`, "Home")], hasMore: page < 2 }], hasMore: page < 2 } };
    }
  });
  await tick();
  assert.equal(env.requests.filter(u => u.startsWith("/api/youtube/search")).length, 1);
  assert.equal(env.requests.filter(u => u.startsWith("/api/youtube/home")).length, 2);
  assert.equal(cards(env, "home").length, 2);
  let fail = true;
  const retry = boot(seed, async url => fail && (url.startsWith("/api/youtube/home") || url.startsWith("/api/youtube/search")) ?
    { status: 503, body: { message: "Try again" } } : null);
  await tick();
  assert.match(feedSection(retry, "home").textContent, /Try again/);
  fail = false;
  feedSection(retry, "home").querySelector(".yt-feed-status").querySelector("button").click();
  await tick();
  assert.ok(cards(retry, "home").length > 0);
});

test("local watch accounting excludes starts, seek jumps, buffering and pauses, and clears with history", async () => {
  let clock = 0;
  const env = boot({}, null, ({ sandbox }) => { sandbox.performance = { now: () => clock }; });
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  assert.equal(env.store.has("ytRecommendations"), false, "starting a video isn't a satisfied watch");
  const video = env.byId.get("ytVideo");
  video.duration = 100;
  video.dispatch("playing");
  for (let i = 0; i < 6; i++) { clock += 1000; video.currentTime += 1; video.dispatch("timeupdate"); }
  video.currentTime = 70; clock += 1000; video.dispatch("timeupdate");
  video.dispatch("waiting");
  clock += 1000; video.currentTime = 71; video.dispatch("timeupdate");
  video.dispatch("pause");
  assert.equal(JSON.parse(env.store.get("ytRecommendations")).stats.aaaaaaaaaaa.seconds, 6);
  tabBtn(env, "home").click();
  env.byId.get("ytClearHistory").click();
  video.dispatch("playing"); clock += 1000; video.currentTime += 1; video.dispatch("timeupdate");
  assert.deepEqual(JSON.parse(env.store.get("ytRecommendations")), {});
  assert.deepEqual(JSON.parse(env.store.get("ytHistory")), []);
});

test("loads without errors and shows the home empty state", async () => {
  const env = boot();
  await tick();
  assert.ok(env.requests.includes("/api/youtube/status"));
  assert.match(feedSection(env, "home").textContent, /Recommendations appear here/);
  assert.equal(env.byId.get("ytPip").hidden, false);
});

test("live HLS takes priority, seeks within its DVR window, and returns to live edge", async () => {
  let player;
  class HlsFixture {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: "manifest", LEVEL_SWITCHED: "level", FRAG_LOADED: "fragment", ERROR: "error" };
    constructor(config) { this.config = config; this.levels = []; this.liveSyncPosition = 90; player = this; }
    on() {}
    loadSource(url) { this.source = url; }
    attachMedia() {}
    destroy() {}
  }
  const env = boot({}, async url => url.startsWith("/api/youtube/video/") ? {
    status: 200, body: { ...VIDEO, isLive: true, hls: true, duration: null },
  } : null, ({ sandbox, byId }) => {
    sandbox.Hls = HlsFixture;
    byId.get("ytVideo").seekable = { length: 1, start: () => 50, end: () => 95 };
  });
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  assert.equal(player.config.lowLatencyMode, true);
  assert.match(player.source, /\/api\/youtube\/hls\/aaaaaaaaaaa\/master\.m3u8/);
  const video = env.byId.get("ytVideo");
  video.currentTime = 70;
  video.dispatch("timeupdate");
  assert.match(env.byId.get("ytTime").textContent, /LIVE/);
  assert.equal(env.byId.get("ytGoLive").hidden, false);
  env.byId.get("ytGoLive").click();
  assert.equal(video.currentTime, 90);
  const seek = env.byId.get("ytSeek");
  seek.value = "0";
  seek.dispatch("change");
  assert.equal(video.currentTime, 50);
  assert.equal(env.store.has("ytResume"), false);
});

test("queue advance preserves the next video's saved resume position", async () => {
  const env = boot({ ytResume: JSON.stringify({ bbbbbbbbbbb: 35 }) });
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  const list = cards(env, "playlist");
  list[0].querySelector(".yt-card-main").click();
  list[1].querySelector(".yt-card-queue").click();
  await tick();
  const video = env.byId.get("ytVideo");
  video.duration = 100;
  video.currentTime = 100;
  video.paused = true;
  video.dispatch("ended");
  await tick();
  assert.match(video.src, /stream\/bbbbbbbbbbb/);
  assert.equal(JSON.parse(env.store.get("ytResume")).bbbbbbbbbbb, 35);
  video.currentTime = 0;
  video.dispatch("loadedmetadata");
  assert.equal(video.currentTime, 35);
});

test("unsubscribing in Subscriptions reloads the remaining channels", async () => {
  const other = "UC" + "b".repeat(22);
  const env = boot({ ytSubs: JSON.stringify([{ id: CH, name: "Someone" }, { id: other, name: "Other" }]) });
  tabBtn(env, "subs").click();
  await tick();
  assert.equal(cards(env, "subs").length, 1);
  feedSection(env, "subs").querySelector(".yt-chip-remove").click();
  await tick();
  assert.equal(cards(env, "subs").length, 1);
  const requests = env.requests.filter(url => url.startsWith("/api/youtube/subscriptions"));
  assert.equal(requests.length, 2);
  assert.match(requests[1], new RegExp(`channels=${other}`));
});

test("Home feed ordering dropdown: hidden outside Home, switches to group=1 for Diverse", async () => {
  const env = boot({
    ytHistory: JSON.stringify([
      { id: "aaaaaaaaaaa", title: "A", author: "", thumbnail: "", duration: null },
      { id: "bbbbbbbbbbb", title: "B", author: "", thumbnail: "", duration: null },
    ]),
  });
  await tick();
  const sel = env.byId.get("ytHomeAlgo");
  assert.equal(sel.hidden, false, "shown while Home is the active tab");
  assert.equal(sel.value, "balanced", "default before any change");
  assert.equal(env.requests.some((u) => u.startsWith("/api/youtube/home") && !u.includes("group=1")), true);
  assert.equal(env.requests.some((u) => u.includes("group=1")), false);
  assert.ok(cards(env, "home").length > 0, "balanced results rendered");

  sel.value = "diverse";
  sel.dispatch("change");
  await tick();
  assert.equal(JSON.parse(env.store.get("ytHomeAlgo")), "diverse", "choice is persisted");
  assert.equal(env.requests.some((u) => u.startsWith("/api/youtube/home") && u.includes("group=1")), true, "Diverse asks the server for per-seed groups instead of its own interleave");
  assert.ok(cards(env, "home").length > 0, "still renders results after switching algorithm");

  tabBtn(env, "subs").dispatch("click");
  assert.equal(sel.hidden, true, "hidden away from Home");
  tabBtn(env, "home").dispatch("click");
  assert.equal(sel.hidden, false);
});

test("pasting a playlist link opens it, lists videos and offers Play all", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  assert.ok(env.requests.some((u) => u.startsWith(`/api/youtube/playlist/${PL}?page=1`)));
  assert.equal(cards(env, "playlist").length, 3);
  assert.equal(tabBtn(env, "playlist").hidden, false);
  assert.match(tabBtn(env, "playlist").textContent, /My list/);
  assert.equal(feedSection(env, "playlist").hidden, false);
  const playAll = feedSection(env, "playlist").querySelectorAll(".yt-action-btn").find((b) => b.textContent === "Play all");
  playAll.click();
  await tick();
  assert.equal(env.byId.get("ytQueueList").children.length, 2, "the other two videos are queued");
  assert.match(env.byId.get("ytVideo").src, /\/api\/youtube\/stream\/aaaaaaaaaaa\?f=/);
});

test("playing uses 1080p video-only + separate audio, and falls back on error", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  cards(env, "playlist")[0].querySelector(".yt-card-main").click();
  await tick();
  const video = env.byId.get("ytVideo");
  const q = env.byId.get("ytQuality");
  assert.equal(video.src, "/api/youtube/stream/aaaaaaaaaaa?f=137");
  assert.equal(q.value, "a:137");
  assert.deepEqual(q.options.map((o) => o.textContent), ["1080p", "360p"]);
  assert.equal(video.plays > 0, true);

  // the separate audio element gets its own file, and follows the video's play/seek/pause
  const audio = env.audios[0];
  assert.equal(audio.src, "/api/youtube/stream/aaaaaaaaaaa?f=140");
  video.paused = false;
  video.currentTime = 42;
  video.dispatch("play");
  assert.equal(audio.currentTime, 42);
  assert.equal(audio.plays > 0, true);
  video.currentTime = 90;
  video.dispatch("seeking");
  assert.equal(audio.currentTime, 90);
  video.currentTime = 90.2;
  audio.currentTime = 90.1; // small drift: left alone
  video.dispatch("timeupdate");
  assert.equal(audio.currentTime, 90.1);
  audio.currentTime = 95; // big drift: pulled back
  video.dispatch("timeupdate");
  assert.equal(audio.currentTime, 90.2);
  video.volume = 0.4;
  video.muted = true;
  video.dispatch("volumechange");
  assert.deepEqual([audio.volume, audio.muted], [0.4, true]);
  video.dispatch("pause");
  assert.equal(audio.paused, true);

  // a decode failure on the video-only file drops to the combined 360p stream
  video.dispatch("error");
  await tick();
  assert.equal(video.src, "/api/youtube/stream/aaaaaaaaaaa?f=18");
  assert.equal(q.value, "c:18");
  assert.equal(audio.src, "", "combined streams carry their own audio: the separate one is cleared");
  assert.match(env.byId.get("ytPlayerMsg").textContent, /Switched to 360p/);
});

test("an old saved 360p preference doesn't hide the higher qualities", async () => {
  const env = boot({ ytHeight: "360" }); // the old key only ever held combined-stream heights
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  assert.equal(env.byId.get("ytQuality").value, "a:137");
  assert.equal(env.byId.get("ytVideo").src, "/api/youtube/stream/aaaaaaaaaaa?f=137");
  env.byId.get("ytQuality").value = "c:18";
  env.byId.get("ytQuality").dispatch("change");
  assert.equal(JSON.parse(env.store.get("ytQuality")), 360, "a chosen quality is remembered under the new key");
});

test("a slow-starting audio never stops the video, and starts once the video is playing", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo");
  const audio = env.audios[0];
  await tick();
  assert.equal(video.paused, false);
  // real-browser order at startup: the video reports "waiting" (nothing buffered yet)...
  video.dispatch("waiting");
  audio.dispatch("waiting"); // ...and so does the audio; neither may pause the video
  await tick();
  assert.equal(video.paused, false, "the video is never held for the audio");
  // data arrives: the video is "playing" and drags the audio along
  video.currentTime = 0.4;
  video.dispatch("playing");
  await tick();
  assert.equal(audio.currentTime, 0.4);
  assert.equal(audio.paused, false);
  assert.equal(env.byId.get("ytSpinner").hidden, true);
});

test("pause, resume and user pause keep the audio in step", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo");
  const audio = env.audios[0];
  await tick();
  env.byId.get("ytPlayBtn").click(); // user pauses
  await tick();
  assert.equal(video.paused, true);
  assert.equal(audio.paused, true, "audio follows a real pause");
  audio.dispatch("playing");
  await tick();
  assert.equal(video.paused, true, "audio events never resume a video the user paused");
  env.byId.get("ytPlayBtn").click(); // user resumes
  await tick();
  assert.equal(video.paused, false);
  assert.equal(audio.paused, false);
});

test("an audio load error falls back to the combined stream", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo");
  await tick();
  env.audios[0].dispatch("error");
  await tick();
  assert.equal(video.src, "/api/youtube/stream/aaaaaaaaaaa?f=18");
  assert.match(env.byId.get("ytPlayerMsg").textContent, /Switched to 360p/);
});

test("channel link, subscribe, and the subscriptions feed", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/channel/${CH}`);
  assert.equal(cards(env, "channel").length, 1);
  const subBtn = feedSection(env, "channel").querySelector(".yt-sub-btn");
  assert.equal(subBtn.textContent, "Subscribe");
  subBtn.click();
  assert.equal(subBtn.textContent, "Subscribed ✓");
  assert.deepEqual(JSON.parse(env.store.get("ytSubs")).map((c) => c.id), [CH]);

  tabBtn(env, "subs").dispatch("click");
  await tick();
  assert.ok(env.requests.some((u) => u.startsWith(`/api/youtube/subscriptions?channels=${CH}&page=1`)));
  assert.equal(cards(env, "subs").length, 1);
  assert.equal(feedSection(env, "subs").querySelectorAll(".yt-chip").length, 1);

  // unsubscribing empties the feed
  feedSection(env, "subs").querySelector(".yt-chip-remove").click();
  await tick();
  assert.equal(cards(env, "subs").length, 0);
  assert.match(feedSection(env, "subs").textContent, /Subscribe to a channel/);
});

test("SponsorBlock is off by default and skips a segment once when enabled", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  assert.equal(env.requests.some((u) => u.includes("/sponsorblock/")), false, "no third-party lookup unless opted in");

  const box = env.byId.get("ytSponsor");
  box.checked = true;
  box.dispatch("change");
  await tick();
  assert.ok(env.requests.some((u) => u.startsWith("/api/youtube/sponsorblock/aaaaaaaaaaa")));
  const video = env.byId.get("ytVideo");
  video.currentTime = 12;
  video.dispatch("timeupdate");
  assert.equal(video.currentTime, 20);
  video.currentTime = 15; // user seeks back into it
  video.dispatch("timeupdate");
  assert.equal(video.currentTime, 15, "not skipped a second time");
  assert.equal(JSON.parse(env.store.get("ytSponsor")), true);
});

test("captions: language list appears and choosing one adds a <track>", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const sel = env.byId.get("ytCaptions");
  assert.equal(sel.hidden, false);
  assert.deepEqual(sel.options.map((o) => o.value), ["off", "en"]);
  assert.equal(env.byId.get("ytVideo").querySelectorAll("track").length, 0);
  sel.value = "en";
  sel.dispatch("change");
  const tracks = env.byId.get("ytVideo").querySelectorAll("track");
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].src, "/api/youtube/captions/aaaaaaaaaaa/en.vtt");
  assert.equal(JSON.parse(env.store.get("ytCaptionLang")), "en");
});

test("resume position, history page, loop, theater and speed memory", async () => {
  const env = boot({ ytResume: JSON.stringify({ aaaaaaaaaaa: 50 }), ytSpeed: "1.5" });
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo");
  assert.equal(video.defaultPlaybackRate, 1.5, "saved speed restored");
  video.dispatch("loadedmetadata");
  assert.equal(video.currentTime, 50, "resumed where it was left");

  video.currentTime = 70;
  video.dispatch("pause");
  assert.equal(JSON.parse(env.store.get("ytResume")).aaaaaaaaaaa, 70);

  env.byId.get("ytLoop").click();
  assert.equal(video.loop, true);
  env.byId.get("ytTheater").click();
  assert.equal(env.byId.get("ytPlayerWrap").classList.contains("is-theater"), true);
  assert.equal(JSON.parse(env.store.get("ytTheater")), true);

  tabBtn(env, "history").dispatch("click");
  await tick();
  assert.equal(cards(env, "history").length, 1);
  cards(env, "history")[0].querySelector(".yt-card-remove").click();
  assert.equal(JSON.parse(env.store.get("ytHistory")).length, 0);
});

test("cards show views, upload time and avatars for both new and known channels", async () => {
  const env = boot({ ytChannelInfo: JSON.stringify({ [CH]: { name: "Someone", icon: AVATAR } }) });
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  const card = cards(env, "playlist")[0];
  assert.match(card.querySelector(".yt-card-meta").textContent, /^5 views • 3 weeks ago$/);
  assert.equal(card.querySelector(".yt-avatar-sm").src, AVATAR);
  // an unknown channel gets no icon (flat lists don't carry one)
  const env2 = boot();
  await submit(env2, `https://www.youtube.com/playlist?list=${PL}`);
  assert.equal(cards(env2, "playlist")[0].querySelector(".yt-avatar-sm").src, AVATAR);
});

test("channel page shows banner, avatar, handle, subscribers and remembers the icon", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/channel/${CH}`);
  const head = feedSection(env, "channel");
  assert.equal(head.querySelector(".yt-channel-banner").src, BANNER);
  assert.equal(head.querySelector(".yt-avatar-lg").src, AVATAR);
  assert.equal(head.querySelector(".yt-feed-title").textContent, "Someone✓");
  assert.equal(head.querySelector(".yt-channel-sub").textContent, "@someone • 518M subscribers");
  assert.equal(head.querySelector(".yt-channel-desc").textContent, "About this channel");
  assert.equal(JSON.parse(env.store.get("ytChannelInfo"))[CH].icon, AVATAR);
  // subscribing keeps the icon for the Subscriptions chips
  head.querySelector(".yt-sub-btn").click();
  assert.equal(JSON.parse(env.store.get("ytSubs"))[0].icon, AVATAR);
  tabBtn(env, "subs").dispatch("click");
  await tick();
  assert.equal(feedSection(env, "subs").querySelector(".yt-avatar-sm").src, AVATAR);
});

test("only our own channel-image route (or YouTube thumbnails) is ever rendered as an image", async () => {
  const env = boot();
  env.sandbox.fetch = async (url) => {
    env.requests.push(url);
    const body = url.startsWith("/api/youtube/channel/")
      ? { channel: { ...CHANNEL_META, avatar: "https://evil.example/a.png", banner: "https://yt3.googleusercontent.com/direct=s0" }, results: [], hasMore: false }
      : { results: [], hasMore: false };
    return { ok: true, status: 200, json: async () => body };
  };
  await submit(env, `https://www.youtube.com/channel/${CH}`);
  assert.equal(feedSection(env, "channel").querySelector(".yt-channel-banner"), null);
  assert.equal(feedSection(env, "channel").querySelector(".yt-avatar-lg"), null);
});

test("the player shows views, upload time and the channel icon (fetched once, then remembered)", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  await tick();
  assert.equal(env.byId.get("ytMeta").textContent, "1.5K views • 2 weeks ago");
  const icon = env.byId.get("ytChannelIcon");
  assert.equal(icon.hidden, false);
  assert.equal(icon.src, AVATAR);
  assert.equal(env.requests.filter((u) => u.startsWith(`/api/youtube/channel/${CH}`)).length, 1);
  // a second video from the same channel already knows the icon: no extra channel request
  await submit(env, "https://youtu.be/bbbbbbbbbbb");
  await tick();
  assert.equal(env.requests.filter((u) => u.startsWith(`/api/youtube/channel/${CH}`)).length, 1);
  assert.equal(env.byId.get("ytChannelIcon").hidden, false);
});

test("caption style panel: changes apply to the ::cue rule, persist, and reset", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const btn = env.byId.get("ytCaptionStyleBtn");
  const panel = env.byId.get("ytCaptionPanel");
  assert.equal(btn.hidden, false, "shown when the video has captions");
  assert.equal(panel.hidden, true);
  btn.click();
  assert.equal(panel.hidden, false);

  const cueCss = () => env.sandbox.document.head.children.map((c) => c.textContent).join("\n");
  assert.match(cueCss(), /#ytVideo::cue \{ font-size: 100%; color: #ffffff; background-color: rgba\(0, 0, 0, 0\.75\)/);
  const select = (label) => panel.querySelectorAll(".yt-cc-row").find((r) => r.children[0].textContent === label).children[1];
  const set = (label, value) => { const s = select(label); s.value = value; s.dispatch("change"); };
  set("Size", "200");
  set("Colour", "yellow");
  set("Background", "0");
  set("Font", "serif");
  set("Outline", "outline");
  assert.match(cueCss(), /font-size: 200%; color: #ffeb3b; background-color: rgba\(0, 0, 0, 0\); font-family: Georgia/);
  assert.match(cueCss(), /text-shadow: -1px -1px 0 #000/);
  assert.deepEqual(JSON.parse(env.store.get("ytCaptionStyle")), { size: 200, color: "yellow", bg: 0, font: "serif", edge: "outline", position: "bottom" });
  assert.equal(panel.querySelector(".yt-cc-preview").style.color, "#ffeb3b", "preview follows the style");

  panel.querySelector(".yt-link-btn").click(); // reset
  assert.match(cueCss(), /font-size: 100%; color: #ffffff/);
  assert.equal(select("Size").value, "100");
  // clicking elsewhere closes the panel
  env.byId.get("ytTitle").dispatch("click");
  assert.equal(panel.hidden, true);
});

test("caption style and position are applied to cues, and saved styles are validated on load", async () => {
  const env = boot({ ytCaptionStyle: JSON.stringify({ size: 300, color: "x; evil", bg: 25, font: "constructor", edge: "shadow", position: "top" }) });
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const css = env.sandbox.document.head.children.map((c) => c.textContent).join("");
  assert.match(css, /font-size: 300%; color: #ffffff; background-color: rgba\(0, 0, 0, 0\.25\); font-family: system-ui/, "bad fields reset, good ones kept");
  assert.equal(css.includes("evil"), false);
  // cues get the saved position once the track's cues exist
  const video = env.byId.get("ytVideo");
  const cues = [{ line: "auto", snapToLines: false }, { line: "auto", snapToLines: false }];
  video.textTracks = [{ cues }];
  const sel = env.byId.get("ytCaptions");
  sel.value = "en";
  sel.dispatch("change");
  const track = video.querySelectorAll("track")[0];
  video.textTracks = [{ cues }];
  track.dispatch("load");
  assert.deepEqual(cues.map((c) => [c.line, c.snapToLines]), [[0, true], [0, true]]);
  // horizontal layout is pinned explicitly on every cue too -- some browsers drift a
  // cue off-center once .line is touched at all, unless align/position/size are set
  // alongside it (this is what was behind captions sticking to one side of the screen)
  assert.deepEqual(cues.map((c) => [c.align, c.position, c.size]), [
    ["center", "auto", 100],
    ["center", "auto", 100],
  ]);
});

test("turning captions off disables the old track before removing it", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo");
  const sel = env.byId.get("ytCaptions");
  sel.value = "en";
  sel.dispatch("change");
  const track = video.querySelectorAll("track")[0].track;
  assert.equal(track.mode, "showing");

  sel.value = "off";
  sel.dispatch("change");
  // Just removing the element isn't enough: some browsers keep the last active cue
  // painted on screen until something else repaints the text-track layer (we saw it
  // linger until the next quality change). Disabling it first forces an immediate clear.
  assert.equal(track.mode, "disabled");
  assert.equal(video.querySelectorAll("track").length, 0);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const type of ["channel", "playlist"]) {
  test(`late ${type} responses cannot replace a newer header or its videos`, async () => {
    const first = type === "channel" ? CH : PL;
    const second = type === "channel" ? "UC" + "b".repeat(22) : "PLabcdefghij";
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const env = boot({}, async url => {
      if (!url.startsWith(`/api/youtube/${type}/`)) return;
      const old = url.includes(first);
      if (old) await gate;
      const meta = type === "channel" ? { id: old ? first : second, name: old ? "Old" : "New" } : { title: old ? "Old" : "New" };
      return { status: 200, body: { [type]: meta, results: [item(old ? "aaaaaaaaaaa" : "bbbbbbbbbbb", old ? "Old video" : "New video")], hasMore: false } };
    });
    await submit(env, `https://www.youtube.com/${type === "channel" ? "channel/" : "playlist?list="}${first}`);
    await submit(env, `https://www.youtube.com/${type === "channel" ? "channel/" : "playlist?list="}${second}`);
    release();
    await tick();
    assert.match(feedSection(env, type).querySelector(".yt-feed-title").textContent, /New/);
    assert.match(tabBtn(env, type).textContent, /New/);
    assert.equal(cards(env, type).length, 1);
    assert.match(cards(env, type)[0].textContent, /New video/);
  });
}

test("feed pages deduplicate repeated video ids within the same response", async () => {
  const env = boot({}, async url => url.startsWith("/api/youtube/playlist/") ? {
    status: 200, body: { playlist: { title: "Duplicates" }, results: [item("aaaaaaaaaaa", "First"), item("aaaaaaaaaaa", "Again")], hasMore: false },
  } : undefined);
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  assert.equal(cards(env, "playlist").length, 1);
});

test("Watch Later and named playlists save, queue, remove and persist videos", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  cards(env, "playlist")[0].querySelector(".yt-card-save").click();
  tabBtn(env, "saved").click();
  await tick();
  assert.equal(cards(env, "saved").length, 1);
  assert.equal(JSON.parse(env.store.get("ytSavedLists"))[0].items[0].id, "aaaaaaaaaaa");

  const saved = feedSection(env, "saved");
  const name = saved.querySelector(".yt-list-name");
  name.value = "Favorites";
  saved.querySelectorAll(".yt-action-btn").find(button => button.textContent === "Create").click();
  await tick();
  assert.equal(saved.querySelector(".yt-select").value.startsWith("list-"), true);
  assert.equal(JSON.parse(env.store.get("ytSavedLists"))[1].name, "Favorites");
  tabBtn(env, "playlist").click();
  cards(env, "playlist")[1].querySelector(".yt-card-main").click();
  await tick();
  env.byId.get("ytSaveVideo").click();
  assert.equal(JSON.parse(env.store.get("ytSavedLists"))[1].items[0].id, "bbbbbbbbbbb");

  tabBtn(env, "saved").click();
  await tick();
  saved.querySelectorAll(".yt-action-btn").find(button => button.textContent === "Play all").click();
  await tick();
  assert.match(env.byId.get("ytVideo").src, /\/bbbbbbbbbbb\?/);
  cards(env, "saved")[0].querySelector(".yt-card-save").click();
  await tick();
  assert.equal(JSON.parse(env.store.get("ytSavedLists"))[1].items.length, 0);
});

test("media controls receive local artwork and control play, seek and next", async () => {
  const handlers = new Map();
  const session = { playbackState: "none", setActionHandler: (name, fn) => handlers.set(name, fn), setPositionState(state) { this.position = state; } };
  const env = boot({}, null, ({ sandbox }) => {
    sandbox.navigator = { mediaSession: session };
    sandbox.MediaMetadata = class { constructor(data) { Object.assign(this, data); } };
  });
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  await tick();
  assert.equal(session.metadata.title, "Video A");
  assert.equal(session.metadata.artwork[0].src, "/api/youtube/thumbnail/aaaaaaaaaaa/mqdefault.jpg");
  const video = env.byId.get("ytVideo");
  video.duration = 100;
  video.currentTime = 40;
  handlers.get("seekbackward")({ seekOffset: 5 });
  assert.equal(video.currentTime, 35);
  handlers.get("seekto")({ seekTime: 50 });
  assert.equal(video.currentTime, 50);
  handlers.get("pause")();
  assert.equal(video.paused, true);
  handlers.get("play")();
  assert.equal(video.paused, false);
  video.dispatch("timeupdate");
  assert.equal(session.position.position, 50);
  tabBtn(env, "related").click();
  await tick();
  cards(env, "related")[0].querySelector(".yt-card-queue").click();
  handlers.get("nexttrack")();
  await tick();
  assert.equal(session.metadata.artwork[0].src, "/api/youtube/thumbnail/rrrrrrrrrrr/mqdefault.jpg");
  env.byId.get("ytClose").click();
  assert.equal(session.metadata, null);
  assert.equal(session.playbackState, "none");
});

test("empty filtered pages leave later unseen videos reachable", async () => {
  const env = boot({ ytHistory: JSON.stringify([item("aaaaaaaaaaa", "Watched")]) }, async url => {
    if (!url.startsWith("/api/youtube/home")) return;
    const page = Number(new URL(url, "http://test").searchParams.get("page"));
    return { status: 200, body: { results: [item(page <= 3 ? "aaaaaaaaaaa" : "bbbbbbbbbbb", "Result")], hasMore: page < 4 } };
  });
  await tick();
  const button = feedSection(env, "home").querySelector("button");
  assert.equal(button.textContent, "Load more");
  button.click();
  await tick();
  assert.equal(cards(env, "home").length, 1);
});

test("invalid stored volume and history do not break startup or recommendations", async () => {
  const env = boot({ ytVolume: JSON.stringify("broken"), ytHistory: JSON.stringify([item("invalid", "Bad"), item("aaaaaaaaaaa", "Good")]) });
  await tick();
  assert.equal(env.byId.get("ytVideo").volume, 1);
  assert.ok(env.requests.some(url => url.startsWith("/api/youtube/home?seeds=aaaaaaaaaaa&")));
});

test("releasing or canceling an unchanged seek resumes progress updates", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo"), seek = env.byId.get("ytSeek");
  video.duration = 100;
  for (const event of ["pointerup", "pointercancel", "blur"]) {
    seek.dispatch("pointerdown");
    seek.dispatch(event);
    video.currentTime += 10;
    video.dispatch("timeupdate");
    assert.equal(Number(seek.value), video.currentTime * 10);
  }
});

test("switching or closing videos aborts abandoned metadata requests", async () => {
  const env = boot();
  const requests = [];
  const realFetch = env.sandbox.fetch;
  env.sandbox.fetch = (url, options) => {
    if (!url.startsWith("/api/youtube/video/")) return realFetch(url, options);
    requests.push(options.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  await submit(env, "https://youtu.be/bbbbbbbbbbb");
  assert.equal(requests[0].aborted, true);
  assert.equal(requests[1].aborted, false);
  env.byId.get("ytClose").click();
  await tick();
  assert.equal(requests[1].aborted, true);
  assert.equal(env.byId.get("ytPlayerWrap").hidden, true);
});

test("cards without a date (YouTube Mixes) get one looked up in the background", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa"); // playing shows Related, a Mix: no dates
  await tick();
  const related = cards(env, "related");
  assert.equal(related.length, 2);
  assert.equal(related[0].querySelector(".yt-card-meta").textContent, "5 views", "no date yet");
  await sleep(450); // the lookup is batched after a short delay
  const asked = env.requests.filter((u) => u.startsWith("/api/youtube/dates"));
  assert.equal(asked.length, 1, "one batched request for both cards");
  assert.equal(asked[0], "/api/youtube/dates?ids=rrrrrrrrrrr,sssssssssss");
  assert.equal(related[0].querySelector(".yt-card-meta").textContent, "5 views • 2 years ago");
  assert.equal(related[1].querySelector(".yt-card-meta").textContent, "5 views", "unknown stays blank rather than wrong");
  // the same videos are never asked about twice
  tabBtn(env, "home").dispatch("click");
  tabBtn(env, "related").dispatch("click");
  await sleep(450);
  assert.equal(env.requests.filter((u) => u.startsWith("/api/youtube/dates")).length, 1);
});

test("cards that already have dates don't trigger any lookup", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  await sleep(450);
  assert.equal(env.requests.some((u) => u.startsWith("/api/youtube/dates")), false);
});

test("the Close button stops the video and goes back to Home", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  await tick();
  const video = env.byId.get("ytVideo");
  assert.equal(env.byId.get("ytPlayerWrap").hidden, false);
  assert.ok(video.src);
  video.currentTime = 42;
  env.byId.get("ytClose").click();
  assert.equal(env.byId.get("ytPlayerWrap").hidden, true, "player hidden");
  assert.equal(video.getAttribute("src"), null, "media source released");
  assert.equal(video.paused, true);
  assert.equal(env.audios[0].getAttribute("src"), null, "separate audio released too");
  assert.equal(feedSection(env, "home").hidden, false, "back on Home");
  assert.equal(feedSection(env, "related").hidden, true);
  assert.equal(tabBtn(env, "related").hidden, true, "the Related tab belonged to that video");
  assert.equal(JSON.parse(env.store.get("ytResume")).aaaaaaaaaaa, 42, "position saved before closing");
  // closing while a video is still loading must not let it start afterwards
  let release;
  const gate = new Promise((r) => (release = r));
  const realFetch = env.sandbox.fetch;
  env.sandbox.fetch = async (url) => {
    if (url.startsWith("/api/youtube/video/bbbbbbbbbbb")) await gate; // hold this lookup open
    return realFetch(url);
  };
  await submit(env, "https://youtu.be/bbbbbbbbbbb");
  assert.equal(env.byId.get("ytPlayerWrap").hidden, false, "loading state is shown");
  env.byId.get("ytClose").click();
  release(); // the lookup now completes, after the viewer closed the player
  await tick(10);
  assert.equal(env.byId.get("ytPlayerWrap").hidden, true, "still closed");
  assert.equal(video.getAttribute("src"), null, "the late response must not start playback");
  assert.equal(tabBtn(env, "related").hidden, true, "nor bring the Related tab back");
});

test("a channel image that fails to load is removed instead of shown broken", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/channel/${CH}`);
  const sec = feedSection(env, "channel");
  const banner = sec.querySelector(".yt-channel-banner");
  const avatar = sec.querySelector(".yt-avatar-lg");
  assert.ok(banner && avatar);
  banner.dispatch("error");
  avatar.dispatch("error");
  assert.equal(sec.querySelector(".yt-channel-banner"), null);
  assert.equal(sec.querySelector(".yt-avatar-lg"), null);
});

test("icons saved by older versions (direct Google URLs) are shown via our route", async () => {
  const env = boot({ ytChannelInfo: JSON.stringify({ [CH]: { name: "Someone", icon: "https://yt3.googleusercontent.com/old=s96-c" } }) });
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  assert.equal(cards(env, "playlist")[0].querySelector(".yt-avatar-sm").src, AVATAR, "never the direct Google URL");
});

test("subscribing never rewrites other buttons (Close, Play all, Export...)", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  await tick();
  env.byId.get("ytSubBtn").click(); // subscribe from the player: re-syncs every Subscribe button
  assert.equal(env.byId.get("ytSubBtn").textContent, "Subscribed ✓");
  env.byId.get("ytClose").textContent = "✕ Close"; // (the fake DOM doesn't parse the label from index.html)
  env.byId.get("ytSubBtn").click(); // and back
  assert.equal(env.byId.get("ytClose").textContent, "✕ Close");

  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  tabBtn(env, "history").dispatch("click");
  await tick();
  env.byId.get("ytSubBtn").click();
  const labels = feedSection(env, "history").querySelectorAll(".yt-action-btn").map((b) => b.textContent);
  assert.deepEqual(labels, ["Export JSON", "Import JSON"]);
  const html = require("fs").readFileSync(require("path").join(__dirname, "../public/index.html"), "utf8");
  assert.match(html, /<button id="ytClose" class="yt-action-btn"[^>]*>✕ Close<\/button>/, "the real page uses the plain button class");
});

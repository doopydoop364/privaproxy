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
const item = (id, title) => ({ id, title, author: "Someone", channelId: CH, duration: 100, views: 5, isLive: false, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });

const VIDEO = {
  id: "aaaaaaaaaaa", title: "Video A", author: "Someone", channelId: CH, duration: 100, hls: false,
  streams: [{ formatId: "18", label: "360p", height: 360, ext: "mp4" }],
  adaptive: {
    video: [{ formatId: "137", height: 1080, fps: 30, ext: "mp4", mime: "video/mp4", vcodec: "avc1.640028", tbr: 4000 }],
    audio: [{ formatId: "140", ext: "m4a", mime: "audio/mp4", acodec: "mp4a.40.2", abr: 129 }],
  },
  captions: [{ lang: "en", name: "English", auto: false }],
  available: {}, warnings: [],
};

function boot(seed) {
  const timers = [];
  const env = makeEnv({
    seed,
    respond: async (url) => {
      if (url.startsWith("/api/youtube/status")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/api/youtube/playlist/")) return { status: 200, body: { playlist: { id: PL, title: "My list", author: "Me" }, results: [item("aaaaaaaaaaa", "Video A"), item("bbbbbbbbbbb", "Video B"), item("ccccccccccc", "Video C")], hasMore: false } };
      if (url.startsWith("/api/youtube/channel/")) return { status: 200, body: { channel: { id: CH, name: "Someone" }, results: [item("aaaaaaaaaaa", "Video A")], hasMore: false } };
      if (url.startsWith("/api/youtube/subscriptions")) return { status: 200, body: { results: [item("bbbbbbbbbbb", "Video B")], hasMore: false } };
      if (url.startsWith("/api/youtube/video/")) return { status: 200, body: { ...VIDEO, id: url.split("/").pop() } };
      if (url.startsWith("/api/youtube/sponsorblock/")) return { status: 200, body: { segments: [{ start: 10, end: 20, category: "sponsor" }] } };
      if (url.startsWith("/api/youtube/related/") || url.startsWith("/api/youtube/home")) return { status: 200, body: { results: [], hasMore: false } };
      return { status: 404, body: { error: "nope", message: "unexpected request " + url } };
    },
  });
  env.sandbox.YtPure = require("../public/js/ytpure.js");
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

test("loads without errors and shows the home empty state", async () => {
  const env = boot();
  await tick();
  assert.ok(env.requests.includes("/api/youtube/status"));
  assert.match(feedSection(env, "home").textContent, /Recommendations appear here/);
  assert.equal(env.byId.get("ytPip").hidden, false);
});

test("pasting a playlist link opens it, lists videos and offers Play all", async () => {
  const env = boot();
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  assert.ok(env.requests.some((u) => u.startsWith(`/api/youtube/playlist/${PL}?page=1`)));
  assert.equal(cards(env, "playlist").length, 3);
  assert.equal(tabBtn(env, "playlist").hidden, false);
  assert.match(tabBtn(env, "playlist").textContent, /My list/);
  assert.equal(feedSection(env, "playlist").hidden, false);
  const playAll = feedSection(env, "playlist").querySelectorAll(".yt-sub-btn").find((b) => b.textContent === "Play all");
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

test("audio that is slow to start does not deadlock playback", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo");
  const audio = env.audios[0];
  await tick(); // the initial video.play() has fired its "play" event; audio.play() was called
  assert.equal(video.paused, false);
  assert.ok(audio.plays > 0, "audio was started alongside the video");

  // audio has nothing buffered yet: browsers report "waiting" on it
  audio.dispatch("waiting");
  await tick();
  assert.equal(video.paused, true, "video is held while audio buffers");
  assert.equal(audio.paused, false, "...but the audio must keep loading/playing, or nothing can ever resume");

  audio.dispatch("playing"); // audio has data now
  await tick();
  assert.equal(video.paused, false, "video resumes once audio is ready");
  assert.equal(env.byId.get("ytSpinner").hidden, true, "no spinner left over");
});

test("if the audio never starts, the video is not held forever", async () => {
  const env = boot();
  await submit(env, "https://youtu.be/aaaaaaaaaaa");
  const video = env.byId.get("ytVideo");
  const audio = env.audios[0];
  await tick();
  audio.dispatch("waiting"); // ...and "playing" never comes (e.g. autoplay blocked)
  await tick();
  assert.equal(video.paused, true);
  const watchdog = env.timers.find((t) => t.ms === 5000);
  assert.ok(watchdog, "a watchdog is armed while holding");
  watchdog.fn();
  await tick();
  assert.equal(video.src, "/api/youtube/stream/aaaaaaaaaaa?f=18", "gave up on the separate audio and switched to the combined stream");
  assert.equal(video.paused, false);
});

test("a user pause is not undone by the audio-stall logic", async () => {
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

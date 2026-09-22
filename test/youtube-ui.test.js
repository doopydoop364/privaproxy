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

function boot(seed) {
  const timers = [];
  const env = makeEnv({
    seed,
    respond: async (url) => {
      if (url.startsWith("/api/youtube/status")) return { status: 200, body: { ok: true } };
      if (url.startsWith("/api/youtube/playlist/")) return { status: 200, body: { playlist: { id: PL, title: "My list", author: "Me" }, results: [item("aaaaaaaaaaa", "Video A"), item("bbbbbbbbbbb", "Video B"), item("ccccccccccc", "Video C")], hasMore: false } };
      if (url.startsWith("/api/youtube/channel/")) return { status: 200, body: { channel: CHANNEL_META, results: [item("aaaaaaaaaaa", "Video A")], hasMore: false } };
      if (url.startsWith("/api/youtube/subscriptions")) return { status: 200, body: { results: [item("bbbbbbbbbbb", "Video B")], hasMore: false } };
      if (url.startsWith("/api/youtube/video/")) return { status: 200, body: { ...VIDEO, id: url.split("/").pop() } };
      if (url.startsWith("/api/youtube/sponsorblock/")) return { status: 200, body: { segments: [{ start: 10, end: 20, category: "sponsor" }] } };
      if (url.startsWith("/api/youtube/related/")) return { status: 200, body: { results: [{ ...item("rrrrrrrrrrr", "Mix video"), uploadedAt: null, uploadedApprox: false }, { ...item("sssssssssss", "Mix video 2"), uploadedAt: null, uploadedApprox: false }], hasMore: false } };
      if (url.startsWith("/api/youtube/dates")) return { status: 200, body: { dates: { rrrrrrrrrrr: Math.floor(Date.now() / 1000) - 2 * 365.25 * 86400 - 5 * 86400 } } };
      if (url.startsWith("/api/youtube/home")) return { status: 200, body: { results: [], hasMore: false } };
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

test("cards show views and time since upload, plus an icon for channels we know", async () => {
  const env = boot({ ytChannelInfo: JSON.stringify({ [CH]: { name: "Someone", icon: AVATAR } }) });
  await submit(env, `https://www.youtube.com/playlist?list=${PL}`);
  const card = cards(env, "playlist")[0];
  assert.match(card.querySelector(".yt-card-meta").textContent, /^5 views • 3 weeks ago$/);
  assert.equal(card.querySelector(".yt-avatar-sm").src, AVATAR);
  // an unknown channel gets no icon (flat lists don't carry one)
  const env2 = boot();
  await submit(env2, `https://www.youtube.com/playlist?list=${PL}`);
  assert.equal(cards(env2, "playlist")[0].querySelector(".yt-avatar-sm"), null);
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

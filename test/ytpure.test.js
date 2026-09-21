"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/js/ytpure.js");

const CH = "UC4QobU6STFB0P71PMvOGN5A";
const PL = "PLF3eNE6vR-4WsBf8qnJLqBywqX39QczxJ";

test("fmtViews never prints 1000K/1000M", () => {
  assert.equal(P.fmtViews(999), "999 views");
  assert.equal(P.fmtViews(1500), "1.5K views");
  assert.equal(P.fmtViews(999400), "999K views");
  assert.equal(P.fmtViews(999600), "1M views");
  assert.equal(P.fmtViews(435000000), "435M views");
  assert.equal(P.fmtViews(999.9e6), "1B views");
  assert.equal(P.fmtViews(null), "");
});

test("fmtTime", () => {
  assert.equal(P.fmtTime(65), "1:05");
  assert.equal(P.fmtTime(3661), "1:01:01");
  assert.equal(P.fmtTime(NaN), "0:00");
});

test("parseYoutubeInput recognises links and ids", () => {
  assert.deepEqual(P.parseYoutubeInput(PL), { type: "playlist", id: PL });
  assert.deepEqual(P.parseYoutubeInput(CH), { type: "channel", id: CH });
  assert.deepEqual(P.parseYoutubeInput(`https://www.youtube.com/playlist?list=${PL}`), { type: "playlist", id: PL });
  assert.deepEqual(P.parseYoutubeInput(`https://www.youtube.com/channel/${CH}/videos`), { type: "channel", id: CH });
  assert.deepEqual(P.parseYoutubeInput("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=" + PL), { type: "video", id: "jNQXAC9IVRw" });
  assert.deepEqual(P.parseYoutubeInput("https://youtu.be/jNQXAC9IVRw"), { type: "video", id: "jNQXAC9IVRw" });
  assert.deepEqual(P.parseYoutubeInput("https://m.youtube.com/shorts/jNQXAC9IVRw"), { type: "video", id: "jNQXAC9IVRw" });
});

test("parseYoutubeInput never turns other input into an id", () => {
  for (const bad of ["lofi beats", "https://evil.example/watch?v=jNQXAC9IVRw", "https://youtube.com.evil.example/watch?v=jNQXAC9IVRw",
    "javascript:alert(1)", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/playlist?list=evil", "https://www.youtube.com/@handle", ""]) {
    assert.deepEqual(P.parseYoutubeInput(bad), { type: "search" }, bad);
  }
});

const canPlayAll = () => true;
const info = {
  streams: [{ formatId: "18", label: "360p", height: 360 }],
  adaptive: {
    video: [
      { formatId: "137", height: 1080, fps: 30, mime: "video/mp4", vcodec: "avc1.640028", tbr: 4000 },
      { formatId: "248", height: 1080, fps: 30, mime: "video/webm", vcodec: "vp9", tbr: 2500 },
      { formatId: "313", height: 2160, fps: 30, mime: "video/webm", vcodec: "vp9", tbr: 9000 },
      { formatId: "134", height: 360, fps: 30, mime: "video/mp4", vcodec: "avc1.4d401e", tbr: 600 },
      { formatId: "299", height: 1080, fps: 60, mime: "video/mp4", vcodec: "avc1.64002a", tbr: 6000 },
    ],
    audio: [
      { formatId: "251", ext: "webm", mime: "audio/webm", acodec: "opus", abr: 160 },
      { formatId: "140", ext: "m4a", mime: "audio/mp4", acodec: "mp4a.40.2", abr: 129 },
    ],
  },
};

test("buildQualityList merges combined and adaptive, best first", () => {
  const list = P.buildQualityList(info, canPlayAll);
  assert.deepEqual(list.map((o) => [o.height, o.kind]), [[2160, "adaptive"], [1080, "adaptive"], [360, "combined"]]);
  const hd = list.find((o) => o.height === 1080);
  assert.equal(hd.videoId, "299"); // avc1 preferred over vp9; 60fps beats 30fps within a codec
  assert.equal(hd.label, "1080p60");
  assert.equal(hd.audioId, "140"); // AAC preferred
  assert.equal(list.find((o) => o.height === 360).value, "c:18"); // combined wins at equal height
});

test("buildQualityList honours what the browser can decode", () => {
  const noVp9 = (mime, codec) => !/vp9/.test(codec);
  assert.deepEqual(P.buildQualityList(info, noVp9).map((o) => o.height), [1080, 360]);
  const noAudio = (mime) => !mime.startsWith("audio/");
  assert.deepEqual(P.buildQualityList(info, noAudio).map((o) => o.kind), ["combined"]); // no audio => no adaptive
  assert.deepEqual(P.buildQualityList({ streams: [], adaptive: { video: [], audio: [] } }, canPlayAll), []);
  assert.deepEqual(P.buildQualityList(null, canPlayAll), []);
});

test("choosePreferred picks the best at or under the ceiling", () => {
  const list = P.buildQualityList(info, canPlayAll);
  assert.equal(P.choosePreferred(list, 1080).height, 1080);
  assert.equal(P.choosePreferred(list, 720).height, 360);
  assert.equal(P.choosePreferred(list, 100).height, 360); // lowest when nothing fits
  assert.equal(P.choosePreferred([], 1080), null);
});

test("driftCorrection only moves audio past the threshold", () => {
  assert.equal(P.driftCorrection(10, 10.2), null);
  assert.equal(P.driftCorrection(10, 10.5), 10);
  assert.equal(P.driftCorrection(NaN, 1), null);
});

test("segmentToSkip finds the active segment once", () => {
  const segs = [{ start: 10, end: 20, category: "sponsor" }, { start: 50, end: 60, category: "intro" }];
  assert.equal(P.segmentToSkip(segs, 5), null);
  assert.equal(P.segmentToSkip(segs, 10).end, 20);
  assert.equal(P.segmentToSkip(segs, 19.9), null); // within the tail margin: don't bother
  assert.equal(P.segmentToSkip(segs, 55).category, "intro");
  assert.equal(P.segmentToSkip(segs, 12, new Set(["10-20"])), null); // already skipped
});

test("resume points ignore the very start and the very end", () => {
  assert.equal(P.resumePoint({ a: 120 }, "a", 600), 120);
  assert.equal(P.resumePoint({ a: 5 }, "a", 600), 0);
  assert.equal(P.resumePoint({ a: 595 }, "a", 600), 0);
  assert.equal(P.resumePoint({}, "a", 600), 0);
  assert.deepEqual(P.updateResume({}, "a", 120.7, 600), { a: 120 });
  assert.deepEqual(P.updateResume({ a: 120 }, "a", 598, 600), {}); // finished: forgotten
  assert.deepEqual(P.updateResume({ a: 1, b: 2 }, "c", 50, 0, 2), { b: 2, c: 50 }); // capped, oldest dropped
});

test("mergeHistory keeps only well-formed entries and de-duplicates", () => {
  const existing = [{ id: "aaaaaaaaaaa", title: "A", author: "", thumbnail: "", duration: null }];
  const imported = [
    { id: "bbbbbbbbbbb", title: "B", author: "x", thumbnail: "https://i.ytimg.com/vi/b/1.jpg", duration: 5 },
    { id: "aaaaaaaaaaa", title: "dup" },
    { id: "bad", title: "bad id" },
    { id: "ccccccccccc", title: 5 },
    { id: "ddddddddddd", title: "D", thumbnail: "https://evil.example/x.jpg" },
    null,
  ];
  const out = P.mergeHistory(existing, imported, 100);
  assert.deepEqual(out.map((h) => h.id), ["aaaaaaaaaaa", "bbbbbbbbbbb", "ddddddddddd"]);
  assert.equal(out[2].thumbnail, ""); // non-YouTube thumbnail stripped
  assert.equal(P.mergeHistory(existing, "not an array").length, 1);
  assert.equal(P.mergeHistory(existing, imported, 2).length, 2);
});

test("timeAgo reads like YouTube", () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  const ago = (sec, approx) => P.timeAgo(now / 1000 - sec, now, approx);
  assert.equal(ago(30), "just now");
  assert.equal(ago(60), "1 minute ago");
  assert.equal(ago(59 * 60), "59 minutes ago");
  assert.equal(ago(3600), "1 hour ago");
  assert.equal(ago(23 * 3600), "23 hours ago");
  assert.equal(ago(86400), "1 day ago");
  assert.equal(ago(6 * 86400), "6 days ago");
  assert.equal(ago(7 * 86400), "1 week ago");
  assert.equal(ago(21 * 86400), "3 weeks ago");
  assert.equal(ago(29 * 86400), "4 weeks ago");
  assert.equal(ago(30 * 86400), "1 month ago", "never \"0 months ago\"");
  assert.equal(ago(45 * 86400), "1 month ago");
  assert.equal(ago(364 * 86400), "11 months ago");
  assert.equal(ago(365 * 86400), "1 year ago");
  assert.equal(ago(3 * 365.25 * 86400), "3 years ago");
  assert.equal(ago(-3600), "", "future (scheduled) times show nothing");
  assert.equal(P.timeAgo(null, now), "");
  assert.equal(P.timeAgo(NaN, now), "");
});

test("timeAgo doesn't fake hour precision for day-rounded dates", () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  const ago = (sec) => P.timeAgo(now / 1000 - sec, now, true);
  assert.equal(ago(5 * 3600), "Today");
  assert.equal(ago(30 * 3600), "Yesterday");
  assert.equal(ago(3 * 86400), "3 days ago");
  assert.equal(ago(21 * 86400), "3 weeks ago");
});

test("fmtSubscribers / fmtCompact", () => {
  assert.equal(P.fmtSubscribers(518000000), "518M subscribers");
  assert.equal(P.fmtSubscribers(1), "1 subscriber");
  assert.equal(P.fmtSubscribers(1250), "1.3K subscribers");
  assert.equal(P.fmtSubscribers(null), "");
  assert.equal(P.fmtCompact(999.7e3), "1M");
});

test("safeImageUrl allows only YouTube thumbnails and our own channel-image route", () => {
  const CH = "UC4QobU6STFB0P71PMvOGN5A";
  assert.equal(P.safeImageUrl("https://i.ytimg.com/vi/x/mqdefault.jpg"), "https://i.ytimg.com/vi/x/mqdefault.jpg");
  assert.equal(P.safeImageUrl(`/api/youtube/channel-image/${CH}/avatar`), `/api/youtube/channel-image/${CH}/avatar`);
  assert.equal(P.safeImageUrl(`/api/youtube/channel-image/${CH}/banner`), `/api/youtube/channel-image/${CH}/banner`);
  for (const bad of ["https://yt3.googleusercontent.com/abc=s96-c", "http://i.ytimg.com/x", "https://i.ytimg.com.evil.example/x",
    "https://evil.example/i.ytimg.com/x", "javascript:alert(1)", "data:image/png;base64,AA", "//evil.example/x.png",
    `/api/youtube/channel-image/${CH}/evil`, `/api/youtube/channel-image/${CH}/avatar?x=1`, "/api/youtube/channel-image/short/avatar", "", null, undefined])
    assert.equal(P.safeImageUrl(bad), "", String(bad));
  assert.equal(P.channelImagePath(CH, "avatar"), `/api/youtube/channel-image/${CH}/avatar`);
  assert.equal(P.channelImagePath("nope", "avatar"), "");
});

test("caption style: defaults, allow-list and CSS", () => {
  assert.deepEqual(P.normalizeCaptionStyle(null), P.DEFAULT_CAPTION_STYLE);
  assert.deepEqual(P.normalizeCaptionStyle("junk"), P.DEFAULT_CAPTION_STYLE);
  const custom = P.normalizeCaptionStyle({ size: 150, color: "yellow", bg: 0, font: "mono", edge: "outline", position: "raised" });
  assert.deepEqual(custom, { size: 150, color: "yellow", bg: 0, font: "mono", edge: "outline", position: "raised" });
  const css = P.captionCss(custom, "#v::cue");
  assert.match(css, /^#v::cue \{ font-size: 150%; color: #ffeb3b; background-color: rgba\(0, 0, 0, 0\); font-family: ui-monospace/);
  assert.match(css, /text-shadow: -1px -1px 0 #000/);
  assert.equal(P.captionDeclarations(P.DEFAULT_CAPTION_STYLE).backgroundColor, "rgba(0, 0, 0, 0.75)");
});

test("caption style: nothing off the allow-list can reach the stylesheet", () => {
  const evil = { size: "150%; } body { display:none", color: "red; background:url(//evil.example)", bg: 9999, font: "constructor", edge: "__proto__", position: "left" };
  assert.deepEqual(P.normalizeCaptionStyle(evil), P.DEFAULT_CAPTION_STYLE);
  const css = P.captionCss(evil);
  assert.equal(/evil|display:none|url\(/.test(css), false);
  // prototype keys must not count as valid choices
  assert.equal(P.normalizeCaptionStyle({ font: "toString" }).font, "sans");
  assert.equal(P.normalizeCaptionStyle({ color: "hasOwnProperty" }).color, "white");
});

test("cueLine maps position to a VTT line", () => {
  assert.equal(P.cueLine("bottom"), "auto");
  assert.equal(P.cueLine("raised"), -4);
  assert.equal(P.cueLine("top"), 0);
});

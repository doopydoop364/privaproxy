"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const yt = require("../server/youtube/ytdlp");
const hls = require("../server/youtube/hls");
const routes = require("../server/youtube/routes");
const sb = require("../server/youtube/sponsorblock");

test("id validators accept real ids and reject everything else", () => {
  assert.ok(yt.CHANNEL_RE.test("UC4QobU6STFB0P71PMvOGN5A"));
  assert.ok(yt.PLAYLIST_RE.test("PLF3eNE6vR-4WsBf8qnJLqBywqX39QczxJ"));
  assert.ok(yt.PLAYLIST_RE.test("OLAK5uy_kAbCdEfGhIjKlMnOpQ"));
  for (const bad of ["", "UC123", "UC4QobU6STFB0P71PMvOGN5A/../x", "UC4QobU6STFB0P71PMvOGN5A?x=1", "https://youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A", "--flag"])
    assert.equal(yt.CHANNEL_RE.test(bad), false, bad);
  for (const bad of ["PL", "evil", "PLxxxxxxxxxx/../..", "PLxxxxxxxxxx&list=a", "-PLxxxxxxxxxxxxx", "PLxxxxxxxxxx\nfoo"])
    assert.equal(yt.PLAYLIST_RE.test(bad), false, bad);
});

test("channel()/playlist() reject bad ids before spawning anything", async () => {
  await assert.rejects(yt.channel("nope"), (e) => e.code === "bad_id");
  await assert.rejects(yt.playlist("nope"), (e) => e.code === "bad_id");
  await assert.rejects(yt.captionText("jNQXAC9IVRw", "../x"), (e) => e.code === "bad_request");
});

const fixture = {
  id: "jNQXAC9IVRw", title: "T", channel: "C", channel_id: "UC4QobU6STFB0P71PMvOGN5A", duration: 19,
  subtitles: {
    en: [{ ext: "srv3", url: "https://www.youtube.com/api/timedtext?v=x&fmt=srv3" }, { ext: "vtt", name: "English", url: "https://www.youtube.com/api/timedtext?v=x&fmt=vtt" }],
    bad: [{ ext: "vtt", url: "https://evil.example/x.vtt" }],
    "../x": [{ ext: "vtt", url: "https://www.youtube.com/api/timedtext?v=x" }],
  },
  automatic_captions: {
    "en-orig": [{ ext: "vtt", name: "English (Original)", url: "https://www.youtube.com/api/timedtext?v=x&kind=asr" }],
    de: [{ ext: "vtt", url: "https://www.youtube.com/api/timedtext?v=x&tlang=de" }],
  },
  formats: [
    { format_id: "18", url: "https://g/18", protocol: "https", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360 },
    { format_id: "137", url: "https://g/137", protocol: "https", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 30, tbr: 4000 },
    { format_id: "140", url: "https://g/140", protocol: "https", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129 },
    { format_id: "140-drc", url: "https://g/140d", protocol: "https", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129 },
    { format_id: "233", url: "https://g/233", protocol: "m3u8_native", ext: "mp4", vcodec: "none", acodec: "mp4a" },
    { format_id: "sb0", url: "https://g/sb0", protocol: "mhtml", ext: "mhtml", vcodec: "none", acodec: "none" },
  ],
};

test("buildVideo separates combined, adaptive video/audio and captions", () => {
  const v = yt._buildVideo(fixture, "");
  assert.equal(v.pub.channelId, "UC4QobU6STFB0P71PMvOGN5A");
  assert.deepEqual(v.pub.streams.map((s) => s.formatId), ["18"]);
  assert.deepEqual(v.pub.adaptive.video.map((x) => [x.formatId, x.height, x.mime]), [["137", 1080, "video/mp4"]]);
  assert.deepEqual(v.pub.adaptive.audio.map((x) => [x.formatId, x.mime]), [["140", "audio/mp4"]]); // -drc and HLS excluded
  assert.equal(v.internal.get("137").adaptive, true);
  assert.equal(v.internal.get("18").adaptive, false);
  assert.equal(v.internal.has("233"), false);
  assert.equal(v.internal.has("sb0"), false);
  assert.equal(JSON.stringify(v.pub).includes("https://g/"), false, "stream URLs must never reach the client");
  assert.equal(JSON.stringify(v.pub).includes("timedtext"), false, "caption URLs must never reach the client");
  // manual subs + original-language auto captions only; foreign hosts / odd language codes dropped
  assert.deepEqual(v.pub.captions, [{ lang: "en", name: "English", auto: false }, { lang: "en-orig", name: "English (Original)", auto: true }]);
});

test("boundRange caps open-ended and oversized ranges", () => {
  const b = routes._boundRange;
  assert.equal(b("bytes=0-", 100), "bytes=0-99");
  assert.equal(b("bytes=500-", 100), "bytes=500-599");
  assert.equal(b("bytes=10-19", 100), "bytes=10-19");
  assert.equal(b("bytes=10-9999", 100), "bytes=10-109");
  assert.equal(b("bytes=-500", 100), null); // suffix ranges aren't rewritten
  assert.equal(b("bytes=0-1,5-9", 100), null); // multi-range isn't rewritten
  assert.equal(b(undefined, 100), null);
  assert.equal(b("bytes=20-10", 100), null);
});

test("sponsorblock keeps only well-formed skip segments for the requested video", () => {
  const payload = [
    { videoID: "otherVideo11", segments: [{ category: "sponsor", actionType: "skip", segment: [1, 2] }] },
    { videoID: "jNQXAC9IVRw", segments: [
      { category: "outro", actionType: "skip", segment: [50, 60] },
      { category: "sponsor", actionType: "skip", segment: [10, 20] },
      { category: "sponsor", actionType: "mute", segment: [30, 40] },
      { category: "music_offtopic", actionType: "skip", segment: [1, 2] },
      { category: "sponsor", actionType: "skip", segment: [9, 3] },
      { category: "sponsor", actionType: "skip", segment: ["a", "b"] },
    ] },
  ];
  assert.deepEqual(sb.pickSegments(payload, "jNQXAC9IVRw"), [
    { start: 10, end: 20, category: "sponsor" },
    { start: 50, end: 60, category: "outro" },
  ]);
  assert.deepEqual(sb.pickSegments(payload, "zzzzzzzzzzz"), []);
  assert.deepEqual(sb.pickSegments("junk", "x"), []);
});

test("hls playlists are rewritten through tokens and refuse non-http URLs", () => {
  const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"\nseg1.ts\nhttps://cdn.example/seg2.ts\n';
  const out = hls.rewritePlaylist(text, "https://host.example/a/b.m3u8", {});
  assert.equal(out.includes("host.example"), false);
  assert.equal(out.includes("cdn.example"), false);
  const tokens = [...out.matchAll(/\/api\/youtube\/hls\/seg\/([A-Za-z0-9_-]{24})/g)].map((m) => m[1]);
  assert.equal(tokens.length, 3);
  assert.equal(hls.lookup(tokens[0]).url, "https://host.example/a/init.mp4");
  assert.equal(hls.lookup(tokens[2]).url, "https://cdn.example/seg2.ts");
  assert.equal(hls.lookup("A".repeat(24)), null);
  assert.equal(hls.lookup("short"), null);
  assert.throws(() => hls.rewritePlaylist("#EXTM3U\nfile:///etc/passwd\n", "https://h.example/x.m3u8", {}), hls.PlaylistError);
});

test("channel art: avatar resized, banner chosen, foreign hosts dropped", () => {
  const thumbs = [
    { id: "0", width: 1060, height: 175, url: "https://yt3.googleusercontent.com/BANNERBASE=w1060-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj" },
    { id: "2", width: 1707, height: 283, url: "https://yt3.googleusercontent.com/BANNERBASE=w1707-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj" },
    { id: "5", width: 2560, height: 424, url: "https://yt3.googleusercontent.com/BANNERBASE=w2560-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj" },
    { id: "banner_uncropped", url: "https://yt3.googleusercontent.com/BANNERBASE=s0" },
    { id: "7", width: 900, height: 900, url: "https://yt3.googleusercontent.com/AVATARBASE=s900-c-k-c0x00ffffff-no-rj" },
    { id: "avatar_uncropped", url: "https://yt3.googleusercontent.com/AVATARBASE=s0" },
  ];
  const art = yt._pickChannelArt(thumbs);
  // The real URL Google gave us for the avatar, unmodified -- never one reconstructed by hand
  // (an earlier version rewrote the size suffix itself, which some CDN edges rejected).
  assert.equal(art.avatar, "https://yt3.googleusercontent.com/AVATARBASE=s0");
  assert.match(art.banner, /BANNERBASE=w1707-/);
  assert.deepEqual(yt._pickChannelArt([{ id: "avatar_uncropped", url: "https://evil.example/x=s0" }]), { avatar: null, banner: null });
  assert.deepEqual(yt._pickChannelArt([{ id: "avatar_uncropped", url: "https://yt3.googleusercontent.com/x/../y=s0" }]), { avatar: null, banner: null });
  assert.deepEqual(yt._pickChannelArt(undefined), { avatar: null, banner: null });
});

test("upload times: flat entries are approximate, video info is precise", () => {
  const flat = yt._normalizeEntry({ id: "jNQXAC9IVRw", title: "T", timestamp: 1789862400 });
  assert.deepEqual([flat.uploadedAt, flat.uploadedApprox], [1789862400, true]);
  const mix = yt._normalizeEntry({ id: "jNQXAC9IVRw", title: "T" });
  assert.deepEqual([mix.uploadedAt, mix.uploadedApprox], [null, false]);
  const precise = yt._buildVideo({ ...fixture, timestamp: 1256453853 }, "").pub;
  assert.deepEqual([precise.uploadedAt, precise.uploadedApprox], [1256453853, false]);
  assert.equal(yt._buildVideo({ ...fixture, upload_date: "20091025" }, "").pub.uploadedAt, Date.UTC(2009, 9, 25) / 1000);
  assert.equal(yt._buildVideo(fixture, "").pub.uploadedAt, null);
});

test("uploadDates: one batched lookup, tolerant of failures, cached, validated", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ytdlp-"));
  const log = path.join(dir, "calls.log");
  const bin = path.join(dir, "yt-dlp");
  // Fake yt-dlp: logs each call, prints a line per video it "knows" and exits 1 like yt-dlp does
  // when one of several videos fails.
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
const urls = process.argv.filter((a) => a.startsWith("https://www.youtube.com/watch?v="));
const ids = urls.map((u) => u.split("=")[1]);
const table = { fakeidAAAAA: "1700000000|20231114", fakeidBBBBB: "NA|20231115" };
for (const id of ids) if (table[id]) console.log(id + "|" + table[id]);
process.exit(ids.every((id) => table[id]) ? 0 : 1);
`);
  fs.chmodSync(bin, 0o755);
  const saved = process.env.YTDLP_PATH;
  process.env.YTDLP_PATH = bin;
  try {
    const got = await yt.uploadDates(["fakeidAAAAA", "fakeidBBBBB", "fakeidCCCCC", "fakeidAAAAA"]);
    assert.deepEqual(got, { fakeidAAAAA: 1700000000, fakeidBBBBB: Date.UTC(2023, 10, 15) / 1000 }); // NA timestamp -> upload date; unknown omitted
    const calls = () => fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls().length, 1, "a single yt-dlp process for the whole batch");
    assert.match(calls()[0], /--skip-download/);
    assert.match(calls()[0], /--print %\(id\)s\|%\(timestamp\)s\|%\(upload_date\)s/);
    // asking again (even mixed with a new id) only looks up what isn't known yet
    await yt.uploadDates(["fakeidAAAAA", "fakeidBBBBB", "fakeidCCCCC"]);
    assert.equal(calls().length, 1, "cached, including 'unknown'");
    await yt.uploadDates(["fakeidAAAAA", "fakeidDDDDD"]);
    assert.equal(calls().length, 2);
    assert.equal(calls()[1].includes("fakeidAAAAA"), false, "known ids aren't asked again");
  } finally {
    if (saved === undefined) delete process.env.YTDLP_PATH; else process.env.YTDLP_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(yt.uploadDates(["bad"]), (e) => e.code === "bad_id");
  await assert.rejects(yt.uploadDates(Array.from({ length: yt.DATE_BATCH + 1 }, (_, i) => `abcdefghi${String(i).padStart(2, "0")}`)), (e) => e.code === "bad_request");
});

test("channel images are served from our own route, never a direct Google URL", () => {
  assert.equal(yt._channelImagePath("UC4QobU6STFB0P71PMvOGN5A", "avatar"), "/api/youtube/channel-image/UC4QobU6STFB0P71PMvOGN5A/avatar");
  assert.ok(yt._CHANNEL_IMG_RE.test("https://yt3.googleusercontent.com/abc=s96-c"));
  for (const bad of ["https://evil.example/x", "http://yt3.googleusercontent.com/x", "https://yt3.googleusercontent.com.evil.example/x", "https://yt3.googleusercontent.com/a/../b", "https://yt3.googleusercontent.com/x?y=1"])
    assert.equal(yt._CHANNEL_IMG_RE.test(bad), false, bad);
});

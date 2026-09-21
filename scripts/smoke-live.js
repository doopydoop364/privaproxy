"use strict";
// Manual check against a RUNNING server (default http://localhost:3000) with live YouTube:
// runs the real public/js/youtube.js on the fake DOM from test/helpers, but with real API responses.
//   node server/index.js &   then   node scripts/smoke-live.js [http://localhost:3000] [search terms]
// Not part of `npm test` (it needs network + yt-dlp). It shows what the client wires up;
// it can't prove media actually decodes -- that needs a real browser.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeEnv, tick } = require("../test/helpers/fakeDom");

const base = process.argv[2] || "http://localhost:3000";
const query = process.argv[3] || "me at the zoo";

(async () => {
  const env = makeEnv({
    respond: async (url) => {
      const res = await fetch(base + url);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  });
  env.sandbox.YtPure = require("../public/js/ytpure.js");
  vm.createContext(env.sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/js/youtube.js"), "utf8"), env.sandbox);
  const feedCards = (name) => env.byId.get("ytFeeds").querySelector(`[data-feed="${name}"]`).querySelectorAll(".yt-card");
  const wait = async (fn, ms = 60000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 200)); return fn(); };

  env.byId.get("ytSearchInput").value = query;
  env.byId.get("ytSearchForm").dispatch("submit");
  console.log("search results shown:", await wait(() => feedCards("results").length > 0), feedCards("results").length);

  feedCards("results")[0].querySelector(".yt-card-main").click();
  const video = env.byId.get("ytVideo");
  await wait(() => video.src);
  console.log("title:", env.byId.get("ytTitle").textContent, "| channel:", env.byId.get("ytChannel").textContent);
  console.log("video src:", video.src, "| audio src:", env.audios[0] && env.audios[0].src || "(none: single combined file)");
  console.log("quality menu:", env.byId.get("ytQuality").options.map((o) => o.textContent).join(", "));
  console.log("captions:", env.byId.get("ytCaptions").options.map((o) => o.value).join(", ") || "(none)");
  console.log("requests:", env.requests.map((u) => u.split("?")[0]).join("\n          "));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

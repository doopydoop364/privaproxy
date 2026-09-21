# privaproxy

A self-hosted web proxy with a pluggable proxy backend and a custom, ad-free
YouTube client.

## Stack

- **Backend**: Node.js + Express
- **Proxy engine**: [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) (service-worker based) + [`@tomphttp/bare-server-node`](https://github.com/tomphttp/bare-server-node) for the actual outbound fetches
- **YouTube client**: search and playback powered by a locally installed [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), with your own custom UI/player on top; adaptive quality via [hls.js](https://github.com/video-dev/hls.js) (served from `node_modules` at `/vendor/hls/`)

## Running it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

The YouTube view additionally needs **`yt-dlp`** installed on the machine
running the server (on Arch/CachyOS: `sudo pacman -S yt-dlp`). Current
`yt-dlp` needs a JavaScript runtime to get full YouTube support; the server
passes `--js-runtimes node` by default (Node 22+ works), and Deno also works
(set `YTDLP_JS_RUNTIMES=deno,node`). If `yt-dlp` is missing, the YouTube view
shows a banner saying so.

## Project structure

```
server/
  index.js              # Express app entrypoint
  proxies/
    registry.js          # loads config/proxies.json, mounts every provider
    providerInterface.js # documents the interface every provider implements
    ultraviolet.js        # the Ultraviolet + bare-server provider
  youtube/
    ytdlp.js              # spawns yt-dlp safely (no shell), caches, caps concurrency
    hls.js                 # HLS proxy helpers: opaque-token URL registry + m3u8 rewriting
    routes.js              # /api/youtube/* routes, incl. the stream + HLS proxies
  config/
    proxies.json           # list of available proxy providers (shown in the UI dropdown)
public/
  index.html               # single-page shell: Browser tab + YouTube tab
  css/style.css
  js/app.js                 # proxy picker, service worker registration, address bar
  js/youtube.js              # search, custom player + shortcuts, queue
  uv/uv.config.js             # tells Ultraviolet's client where the bare server is
```

## Proxy engines

There are now two genuinely different rewriting engines to choose between
(the leftmost dropdown), independent of which bare backend is selected (the
one next to it):

- **Ultraviolet** -- pure-JS rewriter, the original engine this project
  started with.
- **Scramjet** -- a newer engine from the same team behind `bare-mux`,
  using a Rust/WASM rewriter instead. It shares the same bare-mux
  transport Ultraviolet uses, so switching the "Primary/Secondary" backend
  affects both engines' tabs.

The engine picker determines which engine a **new** tab uses at creation
time; existing tabs keep whichever engine they were opened with, since
switching engines under an already-loaded page would mean discarding it
anyway.

Known limitation: Scramjet's `ScramjetFrame` doesn't expose how many
back/forward steps are available, so unlike Ultraviolet tabs (which grey
out the buttons correctly), Scramjet tabs always show both nav buttons
enabled. Clicking one with nothing to go to is a harmless no-op.

We evaluated Rammerhead as a second engine first, but its dependency tree
currently has 6 high-severity `npm audit` findings (last released Oct
2023), so we went with Scramjet instead.

**Bare backends**: The proxy dropdown shows available bare server instances
from `server/config/proxies.json`. Currently three are configured:

- **Primary** (`/bare/`) — default local bare server, tests via `gstatic.com`
- **Secondary** (`/bare2/`) — a second local instance for switching demo
- **Tertiary** (`/bare/`) — third test URL via `cloudflare.com/cdn-cgi/trace`

## Backend latency checks

The backend dropdown shows a live latency next to each of the entries above.
Note that "Tertiary" is served by the same `/bare/` server as "Primary", so it
differs only in which URL it measures.

`server/proxies/latency.js` makes a real timed request through each backend's
actual code path (the same bare client the browser uses) and the page shows
the latest result:

- **Every 5 s per backend** (`DEFAULT_INTERVAL_MS`), and the page re-fetches
  at the same rate (`PROXY_REFRESH_MS` in `public/js/app.js`).
- **8 s timeout** (`DEFAULT_TIMEOUT_MS`): a check that takes longer is aborted
  and the backend shows as offline, instead of staying "checking..." forever.
  Aborting also frees the bare server's upstream connection.
- **One check at a time per backend**: a slow backend never accumulates
  overlapping requests, and only a check's own outcome is recorded, so a
  result that arrives after its timeout can't overwrite a newer one.
- Override with the `LATENCY_INTERVAL_MS` / `LATENCY_TIMEOUT_MS` environment
  variables. Any HTTP response from the test URL counts as online; the check
  only proves the proxy path works.

**Why not faster:** each check is a real request to a third-party URL from this
machine, and every request through a bare server spends a point from its
per-IP rate limit (1000 per minute, `connectionLimiter` in `ultraviolet.js`),
a budget real browsing shares. The checker uses about 25 points/minute of
`/bare/` at 5 s. At a 1 s interval it used 120, and simulated browsing at 15
requests/second (which fits comfortably at 5 s) then got requests refused
with HTTP 429 and the checker itself flipped a backend to a false "offline".

## Adding another proxy provider

The proxy system is intentionally pluggable, since you mentioned wanting to
choose between several proxies (and eventually VPNs) later:

1. Create `server/proxies/yourProvider.js` exporting `{ id, name, mount(app, server), healthCheck() }` — see `providerInterface.js` for the exact contract.
2. Register it in `server/proxies/registry.js`'s `PROVIDER_MODULES` map.
3. Add an entry for it in `server/config/proxies.json`.

The dropdown in the UI and the `/api/proxies` health-check endpoint pick up
new providers automatically — no frontend changes needed.

**Ideas for a second provider**: point Ultraviolet's client at a *second*,
remotely-hosted bare server (gives you multiple "exit points" without a new
engine), or wire in [Rammerhead](https://github.com/binary-person/rammerhead)
as a genuinely different proxy engine.

**Latency checks**: see [Backend latency checks](#backend-latency-checks) above for
how often each bare backend is measured and how to change it.

## Adding VPN support later

A website can only proxy traffic made *from inside the browser tab* — a real
VPN needs to tunnel system-level traffic, which requires a companion app, not
just more JS. When you're ready for that phase:

- **WireGuard**: generate per-user configs server-side (e.g. with
  [`wg-easy`](https://github.com/wg-easy/wg-easy) as an admin layer), let
  users import a `.conf` file or scan a QR code into the WireGuard app.
- **Outline / Shadowsocks**: similar model, a bit easier to self-host and
  manage multiple exit locations from one dashboard.

This would live as a separate service alongside this repo, with its own
onboarding flow (download config / app), rather than inside the browser tool.

## YouTube client notes

The YouTube view is its own area (not part of the browser tab system) and is
backed by a local `yt-dlp`, not by a public site or third-party API.

**Endpoints** (`server/youtube/routes.js`):

- `GET /api/youtube/status` -- yt-dlp version, or `503 not_installed`.
- `GET /api/youtube/search?q=&page=&limit=` -- one page: `{ results, hasMore }`
  (limit 1-30 per page, up to 10 pages).
- `GET /api/youtube/related/:id?page=` -- videos related to `:id`, 20 per page
  (up to 10 pages): `{ results, hasMore }`.
- `GET /api/youtube/home?seeds=id1,id2,...&page=` -- the "recommended" feed,
  built from up to 5 video ids the *browser* sends (its own watch history);
  the server keeps no history. Related lists for each seed are interleaved
  and de-duplicated; seeds that fail are skipped unless all fail.
- `GET /api/youtube/video/:id` -- metadata, playable combined `streams`, and an
  `hls` flag (adaptive playback available). Never exposes YouTube URLs. Includes `available` counts (combined / HLS /
  video-only / audio-only) and any yt-dlp `warnings`, which is how you can
  tell *why* a video has no playable stream (e.g. no JS runtime).
- `GET /api/youtube/stream/:id?f=<formatId>` -- proxies the media bytes with
  `Range` support, using the headers yt-dlp says that URL needs. If YouTube
  rejects a cached URL (expired) it re-runs yt-dlp once and retries. Only
  for *combined* audio+video formats.
- `GET /api/youtube/hls/:id/master.m3u8` -- adaptive playback entry point for
  hls.js. Fetches YouTube's master playlist and rewrites every URL in it.
- `GET /api/youtube/hls/seg/:token` -- serves variant playlists (rewritten
  again) and media segments (streamed, Range-aware).

**Behavior worth knowing:**

- yt-dlp is spawned with an argument array (never a shell). Search text only
  ever appears inside one `ytsearchN:<query>` argument, and video ids are
  validated (`[A-Za-z0-9_-]{11}`) and placed after a `--` separator.
- yt-dlp exits non-zero on failure but can *still* print JSON to stdout
  (e.g. `entries: [null]`), so the exit code is checked first.
- HLS proxying: browsers can't fetch YouTube's HLS directly (CORS, and the
  headers yt-dlp says the URLs need), so every URL inside a playlist is
  rewritten to `/hls/seg/<token>`. Tokens are opaque handles to URLs *we saw
  inside a manifest*; there is no endpoint that fetches a caller-supplied
  URL. Playlists over 8 MB, playlists containing non-http(s) URLs, and
  "playlists" that are really HTML error pages are refused. When a video
  has HLS variants from several clients, the master offering the tallest
  video is used.
- Related videos come from YouTube's auto-generated *Mix* for a video
  (`watch?v=ID&list=RDID`), which yt-dlp walks as an endless generator; it
  stops after the `-I start:end` window we ask for, so paging is just a wider
  window (page *k* re-walks pages 1..k, so pages are cached ~10 min). Item 1
  of a Mix is the seed itself and is dropped. If a video has no Mix (or an
  empty one) we fall back to searching its title, which needs the video's info
  to be cached, as it is once it has played.
- Video info is cached ~20 min with in-flight de-duplication: a `<video>`
  element fires several range requests at once and they must share one
  yt-dlp run. Processes are capped (default 3) and killed on timeout.
- Environment overrides: `YTDLP_PATH`, `YTDLP_JS_RUNTIMES` (default `node`,
  empty = pass none), `YTDLP_TIMEOUT_MS` (default 45000),
  `YTDLP_CONCURRENCY` (default 3).

**Player** (`public/js/youtube.js`): custom controls, quality picker, speed,
volume/mute (persisted), fullscreen, an "Up next" queue with autoplay, and
keyboard shortcuts while the YouTube view is showing: Space/K play, J/L
+-10s, arrows +-5s / volume, M mute, F fullscreen, 0-9 jump, `<` `>` speed,
N next, `/` focus search.

**Lists** (Home / Results / Related tabs, all infinite-scrolling): each list
loads a page whenever its bottom sentinel nears the screen
(`IntersectionObserver`), ignores responses that arrive after the list was
reset, de-duplicates, and shows an inline error with Retry on failure. Without
`IntersectionObserver` it falls back to a "Load more" button.

- **Results** -- your search, paged.
- **Related** -- appears once a video plays; playing from Home or Related jumps
  to it (like YouTube's watch page), playing from Results stays put.
- **Home** -- YouTube's real personalised home feed needs a signed-in account
  (yt-dlp's `:ytrec` needs login cookies, and Trending no longer exists), so
  this is *local*: what you watch is recorded in this browser (`localStorage`
  key `ytHistory`, newest first, max 100), and Home shows related videos for
  your 4 most recent watches, minus anything you've already watched. It loads
  lazily (only when the YouTube view is showing). "Clear watch history" wipes
  it.

Playback picks the simplest path available: a *combined* audio+video file
if YouTube offers one, otherwise adaptive HLS through hls.js (quality menu
gets an **Auto** entry plus one entry per resolution; your last choice is
remembered). If neither exists the player says what YouTube did offer.

**Not built yet:** separate video-only + audio-only playback (DASH-style), a
live-stream-specific path (HLS live may or may not work; untested), and
trending (yt-dlp has no reliable equivalent). The old Invidious backend was
removed: in testing, every public instance either disabled the API, put it
behind a bot check/auth, or returned empty video info to programmatic
clients, so it can't back a server-side player.

**Privacy note:** watch history lives only in this browser's `localStorage`;
the server is stateless and just receives the few video ids it needs to build
Home. yt-dlp contacts YouTube from the machine running this
server, using that machine's own IP -- it does not go through the bare
backends. Result thumbnails are also loaded by the browser directly from
`i.ytimg.com`.

## A note on responsible use

A general-purpose proxy is a legitimate privacy tool, but it's also commonly
used to get around network restrictions set by a school, employer, or ISP.
Make sure however you deploy and share this complies with the terms of
whatever network it's used on, and with your local laws around
circumventing network controls.

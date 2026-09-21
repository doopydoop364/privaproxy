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
    sponsorblock.js        # SponsorBlock lookups (hash-prefix API, fixed host)
  config/
    proxies.json           # list of available proxy providers (shown in the UI dropdown)
public/
  index.html               # single-page shell: Browser tab + YouTube tab
  css/style.css
  js/app.js                 # proxy picker, service worker registration, address bar
  js/youtube.js              # search, custom player + shortcuts, queue, feeds
  js/ytpure.js               # DOM-free player logic (unit tested)
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

The Scramjet entry is disabled (labelled "loading…") until its controller has
initialised, so a tab can never silently fall back to Ultraviolet; if setup
fails it shows "(unavailable)". The engine picker determines which engine a
**new** tab uses at creation time; existing tabs keep whichever engine they were opened with, since
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
from `server/config/proxies.json`. If the selected backend goes offline the
dropdown falls back to the first online one, and the page re-applies the
bare-mux transport on every refresh so the backend in use always matches
the selection. WebSocket upgrade requests that no bare server owns are
closed immediately. Currently three are configured:

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

1. Create `server/proxies/yourProvider.js` exporting `{ id, name, mount(app, server), healthCheck() }` — see `providerInterface.js` for the exact contract. (Per-backend status in the dropdown comes from `latency.js` for providers that expose `bareServers`; `healthCheck()` isn't called by `/api/proxies` yet.)
2. Register it in `server/proxies/registry.js`'s `PROVIDER_MODULES` map.
3. Add an entry for it in `server/config/proxies.json`.

The dropdown in the UI and the `/api/proxies` endpoint pick up
new bare backends automatically — no frontend changes needed.

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
  rejects a cached URL (expired) it re-runs yt-dlp once and retries. Works for
  combined audio+video formats and for the video-only / audio-only files
  (`adaptive` in the video info); for those, every upstream request is capped
  to a 10 MB byte window because YouTube throttles open-ended ones. A request
  with no `Range` header gets a normal `200` with the full length, stitched
  together from those windows.
- `GET /api/youtube/channel/:id?page=` -- a channel's uploads (`UC...` id), 20
  per page (up to 10 pages): `{ channel, results, hasMore }`.
- `GET /api/youtube/playlist/:id?page=` -- a playlist (`PL...`, `UU...` or
  `OLAK5uy_...` id), same paging: `{ playlist, results, hasMore }`.
- `GET /api/youtube/subscriptions?channels=UC..,UC..&page=` -- a feed built from
  up to 6 channel ids the *browser* sends (its own subscription list; the
  server keeps none), interleaved like Home.
- `GET /api/youtube/captions/:id/:lang.vtt` -- WebVTT for one language listed in
  the video's `captions` (manual subtitles, plus the original-language
  auto-captions). The upstream URL comes from yt-dlp's output, never the caller.
- `GET /api/youtube/sponsorblock/:id` -- skippable segments from SponsorBlock;
  any failure returns an empty list.
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

**Playback** builds one quality menu from everything YouTube offers: a
*combined* audio+video file where one exists (usually 360p), and above that a
*video-only* file paired with an *audio-only* file. The latter plays as a
`<video>` plus a hidden `<audio>` kept in step (play/pause/seek/rate/volume,
and any drift over 0.3 s is corrected). The browser's `canPlayType` picks the
codecs (H.264 first, then VP9, then AV1; AAC audio first, then Opus), and the
default is the best quality up to 1080p (your last choice is remembered). If a
separate-audio quality fails, the player drops to the best combined stream.
Only when there is nothing of that kind does it use adaptive HLS through
hls.js (an **Auto** entry plus one per resolution). If nothing works the
player says what YouTube did offer.

**More player and library features:**

- **Channel pages, playlists, subscriptions** -- paste a video, channel or
  playlist link into the search box to open it; click the channel name under
  the player to open its page; Subscribe keeps channel ids in `localStorage`
  (`ytSubs`; the Subscriptions tab mixes your 6 most recently added channels).
- **Captions** -- a CC menu appears when the video has subtitles or original
  auto-captions; the choice is remembered.
- **SponsorBlock** (opt-in checkbox, off by default) -- skips sponsor / self-promo
  / interaction / intro / outro segments, once per segment so you can seek back.
- **Watch history page** -- remove single entries, export or import JSON
  (imports are validated entry by entry).
- **Resume position** (`ytResume`), **loop** (R), **picture-in-picture** (I),
  **theater mode** (T), and a remembered **playback speed**.

**Not built yet:** local (saved) playlists, a live-stream-specific path (HLS
live may or may not work; untested), and trending (yt-dlp has no reliable
equivalent). The old Invidious backend was
removed: in testing, every public instance either disabled the API, put it
behind a bot check/auth, or returned empty video info to programmatic
clients, so it can't back a server-side player.

**Privacy note:** watch history, subscriptions and resume positions live only
in this browser's `localStorage`; the server is stateless and just receives the
few video / channel ids it needs to build Home and Subscriptions. SponsorBlock
is opt-in: when enabled, this server asks `sponsor.ajay.app` using the
hash-prefix API, so only the first 4 hex characters of the video id's SHA-256
leave the server, never the id itself. yt-dlp contacts YouTube from the machine running this
server, using that machine's own IP -- it does not go through the bare
backends. Result thumbnails are also loaded by the browser directly from
`i.ytimg.com`.

## Tests

```bash
npm test
```

Runs `node --test test/` (no extra dependencies): id validators, yt-dlp
output parsing, HLS rewriting, SponsorBlock filtering, range capping, the pure
player logic in `public/js/ytpure.js`, and the real `public/js/youtube.js`
executed against a small fake DOM with canned API responses. The fake DOM
checks wiring and error-free execution; it cannot decode media, so real
playback still needs checking in a browser. With a server running, you can also
try `node scripts/smoke-live.js http://localhost:3000` to drive the client
against live YouTube.

## A note on responsible use

A general-purpose proxy is a legitimate privacy tool, but it's also commonly
used to get around network restrictions set by a school, employer, or ISP.
Make sure however you deploy and share this complies with the terms of
whatever network it's used on, and with your local laws around
circumventing network controls.

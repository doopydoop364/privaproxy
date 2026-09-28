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

### Run the `privaproxy` command

Requires Node.js 22+ and npm. From a checkout:

```bash
npm install -g . --ignore-scripts
privaproxy
```

The command works from any directory. It prints the URL to open; Ctrl+C stops
it. `privaproxy --port 8080`, `--host ::1`, `--ytdlp /path/to/yt-dlp`,
`--help` and `--version` are supported. Existing environment settings continue
to work. `privaproxy --check` verifies installed frontend/proxy assets and runs
`yt-dlp --version`; it exits nonzero when YouTube's dependency is unavailable,
without starting a server. The proxy itself can run without yt-dlp. The CLI
passes its own Node executable path to yt-dlp unless `YTDLP_JS_RUNTIMES` is
explicitly set, so a globally installed or bundled runtime works without an
additional `node` on PATH. Defaults remain local-only (`127.0.0.1:3000`).

To inspect/build an installable npm release locally:

```bash
npm pack --dry-run
npm pack
npm install -g ./privaproxy-1.1.0.tgz --ignore-scripts
```

The dependencies ship their browser assets already built; installation scripts
are unnecessary. These commands do not publish to any registry. Only selected runtime code,
frontend assets and the default proxy configuration are packaged. Development
files, dependency folders, `.env` files and portable builds are excluded. Review
the package file list and configuration before publishing. The npm package does
not include Node or yt-dlp; the portable distribution below does.

### Portable download with bundled runtimes

The builder creates a portable folder containing the app, locked production npm
packages, an official Node.js runtime and the official standalone yt-dlp binary
(which includes Python). Users unpack the folder and run `./privaproxy`; they
do not need to install Node.js, npm, Python or yt-dlp separately. This is a
folder/archive distribution, rather than a single executable that contains all
assets. Keep the folder together; add that folder to PATH to use the plain
`privaproxy` command elsewhere.

Build on the target Linux/macOS system (x64 or arm64), with Node.js 22+, npm,
`tar` and network access:

```bash
npm run build:portable
./dist/privaproxy-linux-x64/privaproxy --check
./dist/privaproxy-linux-x64/privaproxy
```

Use `--output /path/to/a/new/folder` to choose a destination. Existing folders
are never overwritten. The default Node runtime is 24.21.0 LTS; use
`--node-version 24.21.0` and `--ytdlp-version YYYY.MM.DD` to select releases.
Without a yt-dlp version, the builder resolves the latest stable release and
records its exact tag. Official Node/yt-dlp downloads are bounded, time-limited
and verified against their release SHA-256 manifests before use. Dependency
installation uses the lockfile with lifecycle scripts disabled. Each build
records runtime checksums, versions and dependency identities in `manifest.json`,
keeps runtime license notices, and runs the bundled command's dependency check
before reporting success. No runtime files are downloaded at app startup.

The builder supports Linux/macOS x64 and arm64; Linux x64 has been tested here.
Windows portable builds are not implemented yet; the npm command is designed
for npm's platform-specific executable links. Linux portable builds use the
standard glibc Node distribution, rather than an Alpine/musl build. OS libraries
still need to meet the bundled runtimes' requirements. ffmpeg is not bundled;
this app streams existing formats and plays separate video/audio directly, rather
than merging downloaded files.

Build folders stay outside Git. The builder does not upload artifacts, create
GitHub releases or publish npm packages. Node/yt-dlp and dependencies retain their
own licenses; standalone yt-dlp includes GPLv3+ components. The manifest points
to upstream sources, but redistribution must also satisfy the corresponding
source and notice requirements. See [yt-dlp's distribution notes](https://github.com/yt-dlp/yt-dlp#licensing).
Build a new folder to update the runtime; keep the same app origin to retain
browser-local history and preferences.


The server binds to `127.0.0.1` by default. Set `HOST` explicitly to change the
bind address (for example, `HOST=::1` for IPv6 loopback). Binding to a LAN or
wildcard address makes the unauthenticated proxy accessible to that network;
only do that when you intend to share it and have appropriate access controls.

For a private LAN deployment, set `PRIVAPROXY_PASSWORD` to enable a sign-in
page. All HTTP routes and proxy WebSocket upgrades then require a session;
the password is never stored in the browser. Sign-in from another device
requires HTTPS, normally provided by a reverse proxy. Do not expose this
service to the public internet solely on the strength of the built-in
password gate. The Status page offers Sign out, which also invalidates the
browser's proxy transport credential. Internal latency checks use a separate
server-only credential.

The YouTube view offers local Watch Later and named lists, export/import,
system media controls, and a live-HLS DVR/Go live control where the stream
has a seekable window. The browser view saves each tab's last 50 history
entries and can reopen recently closed tabs with Ctrl+Shift+T. The Status
tab updates server, proxy and yt-dlp health automatically while visible. It
checks again five seconds after each completed refresh; choose 15 or 30 seconds,
pause auto refresh, or use Refresh now. Polling stops while hidden or offline,
cancels abandoned requests, and resumes when you return or reconnect. Checks
never overlap. Failed requests retain clearly marked last-known results, with
automatic recovery checks and a sign-in link when the session has expired.
The dashboard shows overall health, API response times, backend probe ages and
recent latency ranges (up to 20 distinct probes per backend). Service changes
and playback messages stay in memory, capped at 20 entries each, with Clear
controls. The YouTube check reports installed tools, not guaranteed playback
availability. Polling reuses existing endpoints and their caching; it does not
launch extra backend health probes or expose proxy credentials in the page.

YouTube work is limited to three concurrent yt-dlp processes and 24 waiting
jobs. Jobs waiting longer than 10 seconds return `503 busy`; disconnected
requests cancel work once no other request needs it. Configure these limits
with `YTDLP_CONCURRENCY`, `YTDLP_MAX_QUEUE` (0 disables waiting), and
`YTDLP_QUEUE_TIMEOUT_MS`. Limits and timeouts must be finite integers;
invalid settings fall back to their defaults.

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

We evaluated Rammerhead as a second engine first, but its dependency tree
currently has 6 high-severity `npm audit` findings (last released Oct
2023), so we went with Scramjet instead.

Back/forward is tracked ourselves per tab (see the comment on `pushHistory`
in `app.js`) rather than trusting either engine's native history, precisely
so the Back/Forward buttons grey out correctly for **both** engines --
including Scramjet, whose `ScramjetFrame` doesn't expose how many
back/forward steps are available natively. (An earlier version of this
note said Scramjet's buttons always showed enabled; verified against the
current code, in both directions through real navigations, that this no
longer holds -- the shared history stack the tabs already use was the fix.)

**Reload / Stop**: the button next to Forward reloads the active tab
(`ScramjetFrame.reload()`, or `contentWindow.location.reload()` for
Ultraviolet -- same-origin, since both engines proxy everything onto our
own origin) and turns into a Stop button (`contentWindow.stop()`) while a
navigation is in flight, for either engine. Each tab's pill also shows a
spinner ring around its favicon while it's loading.

**Reopening tabs**: the tabs you have open (engine + URL, and which one was
active) are saved to `localStorage` (`browserTabs`) as you browse and
restored the next time you load the page -- not the full back/forward
history of each tab, just where it currently is, the same trade-off
`goHistory` already makes for a single session. A saved Scramjet tab waits
for the controller to finish initialising before it's restored (same
reason the engine picker's Scramjet option stays disabled until then); if
Scramjet fails to set up at all, that tab is restored under Ultraviolet
instead of being dropped.

**Bookmarks / new-tab page**: the star button in the address bar bookmarks
the active tab's page (title, URL, and whatever favicon the tab was
currently showing -- always a `data:` URI already fetched through the proxy,
same as tab pills, never an external image URL). Bookmarks are saved to
`localStorage` (`browserBookmarks`) and shown as a grid on a tab with
nothing loaded, replacing the plain "Nothing loaded yet" hint once you have
at least one; click a card to open it in that tab, or the &times; to remove
it. Titles come from proxied pages, so they're rendered with `textContent`
only, never `innerHTML`.

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
  and de-duplicated; seeds that fail are skipped unless all fail. `&group=1`
  returns the same per-seed lists unmixed (`{ groups: [{ seedId, items,
  hasMore }], hasMore }`) for a client that wants to combine them itself --
  used by the "Diverse" Home ordering.
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
  per page (up to 10 pages): `{ channel, results, hasMore }`. `channel` has
  `name`, `avatar`, `banner`, `followers`, `verified`, `handle` and a short
  `description`; image URLs are only passed through if they're on YouTube's
  avatar hosts. Each result also has `uploadedAt` (epoch seconds) and
  `uploadedApprox`.
- `GET /api/youtube/channel-image/:id/(avatar|banner)` -- a channel's avatar or
  banner, fetched server-side. The upstream URL comes from what yt-dlp reported
  for that channel and is checked against a fixed host list; there is no way to
  pass a URL. Responses must be images under 5 MB.
- `GET /api/youtube/dates?ids=a,b,...` -- upload times (epoch seconds) for up to
  12 videos, looked up with one `yt-dlp --skip-download` per batch and cached.
  Ids that can't be resolved are simply absent.
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
  URL. Destinations and redirects must use HTTPS on `googlevideo.com`
  hosts; each connection rejects non-public DNS addresses.
  Playlists over 8 MB, playlists containing unsupported URLs, and
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
  it. A dropdown next to it picks how those related videos get combined:
  **For You** is the plain round-robin across your 4 seeds (the original,
  and still the default); **Diverse** asks the server for the same per-seed
  candidates unmixed (`&group=1`) and reorders them client-side by
  round-robining across *channels* instead of seeds, so a channel that
  dominates several seeds' related lists doesn't crowd out the rest (see
  `diversify()` in `public/js/ytpure.js`). Both read the identical yt-dlp
  output through the same cache, so switching does no extra work server-side.
  The choice is remembered (`localStorage` key `ytHomeAlgo`).

  **Complex** adds a local hybrid recommender (`public/js/recommendations.js`):
  up to four recent/satisfying watches and older favourites seed Mix candidates,
  with at most two subscribed channels chosen by affinity, one unfamiliar
  creator's uploads and one recent-search/title-derived topic search per page.
  These use the existing endpoints, yt-dlp caches and concurrency limits.
  Sources that finish stop paging; a failed source does not discard successful
  ones. Subscriptions or recent searches without watch history can also supply
  a first feed; an empty profile shows the watch-first prompt.
  Weighted reciprocal rank fusion combines the pools; TF-IDF/cosine title
  similarity, time-decayed channel/topic interests, real watch time and partial
  completion, saved videos, subscriptions, known upload dates and recent exposure
  rank them locally. MMR spreads similar titles and repeated creators across
  page boundaries, with roughly one slot in eight exploring an unfamiliar creator
  when available. These are tunable heuristics, not YouTube's proprietary model.
  Already-watched videos are excluded, as in the other Home modes.

  Complex cards explain their recommendation and offer **More like this**,
  **Not interested** and **Block channel** (when its ID is known). Feedback only
  filters/ranks Complex. **Reset recommendation data** clears watch statistics,
  impressions, recent searches, training records and feedback, including blocked
  channels and model preferences, while preserving history and saved lists. **Clear watch history** also clears recommendation data;
  removing a history item removes its watch statistics, training records and video
  feedback. Recommendations rebuild after feedback, searches, watches, history
  imports/removals, subscription changes and saved-video changes. Hidden Home
  feeds defer retrieval until shown; changes in another tab also invalidate them.
  **Recommendation settings** lets you unblock creators, clear video feedback or
  search interests separately, and inspect learning progress.
  `ytRecommendations` stores at most 400 video-stat entries, 200 video-feedback
  entries, 100 blocked channels, 20 search interests and 600 feature records in
  this browser. Search interests decay with a seven-day half-life; after two weeks
  the retrieval query falls back to watch topics. Watch time compares media
  progress with elapsed real time, excluding seek jumps, buffering, pauses and
  long sample gaps; selecting or autoplaying a video alone supplies no watch-time
  reward. Content progress is stored separately for completion credit at different
  playback speeds. Impressions are counted once per feed build when a card enters the
  visible view. Only the selected IDs and topic query are sent for retrieval;
  the full history, scores, watch-time statistics and feedback stay local.
  Old watch-history exports still work; new exports preserve channel IDs and
  watch dates, but do not include the separate recommendation statistics.

  Experimental contextual bandit and neural models are bundled in
  `public/js/ytlearning.js`, **off by default**. They run entirely in this browser
  without dependencies, model downloads or telemetry. The bandit uses a shared
  ridge-regression prediction plus an uncertainty bonus, inspired by
  [LinUCB](https://arxiv.org/abs/1003.0146). The neural ranker is a small eight-input,
  six-hidden-unit network. Both use retrieval consensus, topic/channel affinity,
  subscriptions, saves, freshness, exposure and creator novelty. Training labels
  come from actual watch progress or explicit feedback; an unwatched impression
  alone is never treated as dislike. Repeated views of the same video cannot
  inflate the distinct training-example count.

  Controls unlock after 100 distinct qualified watches, 500 visible impressions,
  20 explicit video-feedback entries and 100 distinct labeled feature records,
  including at least ten positive and ten negative examples. A qualified watch
  is half the video duration, capped at 30 seconds and floored at five seconds
  (30 seconds for unknown durations). **Enablement still requires opting in** in
  Recommendation settings. The neural model additionally must beat a constant
  predictor on the newest 20% of labeled records, with both positive and negative
  examples in that holdout. This prediction check does not prove better
  recommendation quality; the models remain experimental. Falling below a data
  goal suspends learning; resetting recommendation data disables it and clears
  training records and the in-memory model cache. Learned score changes are
  bounded to ±0.2 and always retain the heuristic candidate filters and MMR.

  `rankComplex` also retains its optional `learnedRanker(candidates, { history,
  state })` adapter, guarded by `enableLearning: true` and the original
  `learningStatus(state).ready` usage gate. Combined built-in/custom adjustments
  stay bounded; failures fall back to the heuristic pipeline.

**Playback** builds one quality menu from everything YouTube offers: a
*combined* audio+video file where one exists (usually 360p), and above that a
*video-only* file paired with an *audio-only* file. The latter plays as a
`<video>` plus a hidden `<audio>` kept in step (play/pause/seek/rate/volume,
and any drift over 0.3 s is corrected). The browser's `canPlayType` picks the
codecs (H.264 first, then VP9, then AV1; AAC audio first, then Opus), and the
default is the best quality up to 1080p (your last choice is remembered). If a
separate-audio quality fails, the player drops to the best combined stream.
Channels using YouTube's auto-dub feature can list 15-20 near-identical-
bitrate audio tracks per quality tier, one per language -- only the original
is ever offered for playback (picked via yt-dlp's `language_preference`),
never a same-bitrate foreign dub a plain sort couldn't otherwise tell apart.
Only when there is nothing of that kind does it use adaptive HLS through
hls.js (an **Auto** entry plus one per resolution). If nothing works the
player says what YouTube did offer.

**More player and library features:**

- **Channel pages, playlists, subscriptions** -- paste a video, channel or
  playlist link into the search box to open it; click the channel name under
  the player to open its page; Subscribe keeps channel ids in `localStorage`
  (`ytSubs`; the Subscriptions tab mixes your 6 most recently added channels).
- **Captions** -- a CC menu appears when the video has subtitles or original
  auto-captions; the choice is remembered. The **Aa** button opens a style
  panel: size (50-300%), colour, background opacity, font, outline and
  position (bottom / raised / top), with a live preview and a reset. Settings
  are stored in `localStorage` (`ytCaptionStyle`) and checked against an
  allow-list on load, so nothing stored can inject CSS.
- **Channel icons and banners** -- channel pages show the banner, avatar,
  handle, verified mark and subscriber count; the player shows the channel's
  icon; Subscribe chips and video cards show icons for channels you've already
  seen (`ytChannelInfo`, max 300). YouTube's flat lists don't carry avatars, so
  a card only gets an icon once its channel is known. Images are fetched by this
  server (`/api/youtube/channel-image/:id/(avatar|banner)`), so the browser never
  contacts Google's image hosts and blockers can't break them; one that still
  fails to load is simply removed.
- **Time since upload** ("3 weeks ago") on cards and under the player title.
  Search, playlist and channel lists use yt-dlp's `youtubetab:approximate_date`,
  which is only accurate to the day (so recent uploads read "Today" /
  "Yesterday"); the player uses the exact time. YouTube Mix lists (Related and
  Home) and watch history arrive without dates, so the page asks for them in
  the background (`/api/youtube/dates`, batches of 10, low priority so it never
  delays playback) and fills them in a few seconds later.
- **Close** button (top right of the player) stops the video and returns to Home.
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

**Privacy note:** video thumbnails are loaded by the browser directly from
`i.ytimg.com`; channel avatars and banners go through this server instead. Watch history, subscriptions and resume positions live only
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

For Firefox checks, start an isolated headless browser in a separate terminal:

```bash
mkdir -p /tmp/privaproxy-firefox
firefox --headless --no-remote --profile /tmp/privaproxy-firefox --remote-debugging-port 9222 about:blank
```

Then run `node scripts/smoke-firefox.js`. It uses WebDriver BiDi and a temporary
loopback fixture server to check worker activation, restored tabs, history
persistence, fragment navigation, subscriptions, startup recovery, saved
settings, Scramjet titles, and failed worker registration without external
requests. Add a local MP4 of at least 50 seconds to check actual playback,
queue advance, resume, seeking, and separate audio across a loop:

```bash
node scripts/smoke-firefox.js ws://127.0.0.1:9222/session /path/to/test-video.mp4
```

## A note on responsible use

A general-purpose proxy is a legitimate privacy tool, but it's also commonly
used to get around network restrictions set by a school, employer, or ISP.
Make sure however you deploy and share this complies with the terms of
whatever network it's used on, and with your local laws around
circumventing network controls.

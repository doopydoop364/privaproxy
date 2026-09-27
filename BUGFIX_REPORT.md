# Bug review and fixes

Reviewed the Express routes, yt-dlp process/cache handling, HLS URL and DNS
validation, proxy providers and latency checks, browser tab navigation,
YouTube feeds/player, stored settings, and verification scripts.

## Fixed findings

1. Adaptive suffix and multipart byte ranges were replaced with the first
   window of the file. These headers now reach upstream unchanged.
2. Unsafe integer byte offsets could be rounded to different positions.
   Only safe integer offsets are rewritten.
3. Complete adaptive downloads could skip bytes when upstream returned
   smaller windows than requested. Downloads now advance by the returned end
   offset and reject inconsistent ranges or truncated/oversized bodies.
4. Delayed channel and playlist responses could overwrite a newer page's
   header. Header updates now check the feed generation.
5. Duplicate video IDs within one feed page produced duplicate cards.
   Deduplication now happens as each item is processed.
6. Three fully filtered pages permanently ended a feed despite more results.
   A Load more button now preserves access to later pages while bounding
   automatic retries.
7. Corrupt saved volume could throw during startup and disable the YouTube UI.
   Non-finite values now use the default volume.
8. Invalid saved history IDs broke recommendation requests. History reads now
   validate IDs and enforce the storage limit.
9. Unchanged or canceled seek gestures could freeze the progress slider.
   Pointer release, cancellation, and blur now release scrubbing state.
10. Unsupported combined-stream codecs could hide a playable adaptive stream
    at the same resolution. Combined streams now include codec metadata and
    are checked for browser support.
11. Switching or closing videos left abandoned metadata requests running.
    The frontend now aborts those requests.
12. Caption and SponsorBlock size checks happened after buffering entire
    responses. Shared capped reads now enforce limits during streaming and
    cancel oversized or unused error bodies.
13. Caption, SponsorBlock, and channel-image fetches did not stop on client
    disconnect. They now combine request cancellation with their timeouts.
14. Valid image content types with parameters were rejected. Image validation
    now checks the media type separately.
15. HLS socket timeouts did not cover stalled DNS/connection setup. A separate
    deadline now bounds setup and response headers.
16. Invalid yt-dlp or latency settings could defeat limits or trigger rapid
    timer execution. Invalid values now fall back to finite integer defaults.
17. Overlapping proxy changes and older list responses could leave the wrong
    transport selected. Changes are serialized and stale lists are ignored.
18. A temporary proxy-list failure during startup disabled browsing until
    reload. Startup now retries while engine registration waits.
19. Configured remote bare endpoints were treated as local mount paths and
    concatenated with the application's origin. Remote endpoints now retain
    their URLs and do not create local server instances.
20. Latency checks left response bodies unread and could overlap after a slow
    cancellation. Bodies are canceled and checks retain their slot until
    the work settles. The registry also starts checks for all providers together.
21. Ultraviolet fragment navigation left the address bar and saved tab stale.
    Fragment/history events now synchronize them, including query/fragment decoding.
22. Scramjet tab titles and favicons were read before the page finished loading.
    Its iframe now also refreshes them on document load.
23. Malformed URL-shaped address-bar input could throw inside Scramjet and leave
    a tab stuck loading. URLs are now parsed and normalized before navigation;
    invalid input becomes a search.

## Verification

- `npm test`: all 103 automated regression tests passed, covering request ranges, streamed response limits,
  cancellation, concurrency, timeouts, proxy switching, feed races, codecs,
  settings, HLS destination validation, and existing player behavior.
- Headless Firefox with local fixtures checks worker activation, restored tabs,
  Back/Forward persistence, fragment navigation, subscriptions, failed startup
  recovery, corrupt volume, Scramjet titles, and failed worker registration.
- A local 60-second MP4 verifies actual playback, queue advance with resume,
  seeking, and separate audio across a video loop. Looping passed without an
  additional production change.
- Changes preserve the existing engine/provider architecture, API routes,
  HLS destination restrictions, and yt-dlp caching/concurrency protections.

Browser checks use local fixtures; they do not establish that every external
website or live YouTube stream works. No review can prove the absence of all bugs.

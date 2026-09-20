"use strict";
// HLS proxy helpers.
//
// The browser must never talk to YouTube's servers directly for HLS (CORS, and
// the headers yt-dlp says each URL needs). So every URL inside a playlist we
// serve is rewritten to /api/youtube/hls/seg/<token>, where <token> is an
// opaque handle to a URL WE saw inside a manifest fetched from YouTube.
//
// SSRF note: the segment route only resolves tokens found in this registry, so
// there is no way to ask the server to fetch an arbitrary URL.

const crypto = require("crypto");

const SEG_PREFIX = "/api/youtube/hls/seg/";
const TTL_MS = 6 * 60 * 60 * 1000; // YouTube manifest URLs live ~6h
const MAX_ENTRIES = 60000; // a long video is ~1-2k segments per rendition
const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

const registry = new Map(); // token -> { url, headers, exp }

// Deterministic: the same URL always gets the same token, so re-fetching a
// playlist doesn't grow the registry, and tokens reveal nothing about the URL.
const tokenFor = (url) => crypto.createHash("sha256").update(url).digest("base64url").slice(0, 24);

function register(url, headers) {
  const token = tokenFor(url);
  registry.delete(token); // re-insert so eviction order is least-recently-registered
  registry.set(token, { url, headers, exp: Date.now() + TTL_MS });
  while (registry.size > MAX_ENTRIES) registry.delete(registry.keys().next().value);
  return token;
}

function lookup(token) {
  if (!TOKEN_RE.test(token)) return null;
  const entry = registry.get(token);
  if (!entry) return null;
  if (entry.exp < Date.now()) {
    registry.delete(token);
    return null;
  }
  return entry;
}

class PlaylistError extends Error {}

function absolute(ref, baseUrl) {
  const u = new URL(ref, baseUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new PlaylistError(`unsupported URL scheme in playlist: ${u.protocol}`);
  return u.toString();
}

// Rewrites every URI in an m3u8 (segment/variant lines and URI="..." attributes
// on tags like EXT-X-MAP / EXT-X-MEDIA / EXT-X-KEY) to go through our proxy.
function rewritePlaylist(text, baseUrl, headers) {
  const proxied = (ref) => SEG_PREFIX + register(absolute(ref, baseUrl), headers);
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]*)"/g, (whole, ref) => {
          if (!ref || /^data:/i.test(ref)) return whole; // inline data (e.g. a key): leave alone
          return `URI="${proxied(ref)}"`;
        });
      }
      return proxied(t);
    })
    .join("\n");
}

// Is this upstream response an m3u8 playlist (vs a media segment)?
function isPlaylist(contentType, url) {
  if (/mpegurl/i.test(contentType || "")) return true;
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

module.exports = {
  SEG_PREFIX, MAX_PLAYLIST_BYTES, PlaylistError,
  register, lookup, rewritePlaylist, isPlaylist,
  _size: () => registry.size,
};

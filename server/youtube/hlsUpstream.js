"use strict";
const dns = require("dns");
const https = require("https");
const { BlockList, isIP } = require("net");
const { Readable } = require("stream");

class PlaylistError extends Error {}

function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new PlaylistError("Invalid HLS URL."); }
  // YouTube serves its HLS manifests, renditions and keys from googlevideo.
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/(^|\.)googlevideo\.com$/.test(url.hostname))
    throw new PlaylistError("Unsupported HLS destination.");
  return url;
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
]) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16]])
  blocked.addSubnet(address, prefix, "ipv6");

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

// Validation happens inside the connection's lookup, not in a separate DNS
// preflight that could be defeated by rebinding between validation and fetch.
function lookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
      return callback(new PlaylistError("HLS destination resolved to a non-public address."));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function request(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { ...headers, "accept-encoding": "identity" }, signal, lookup,
      // Do not reuse sockets across lookups: every new request validates DNS.
      agent: false,
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: responseHeaders, body: Readable.toWeb(res), url: url.href });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("HLS upstream timed out.")));
  });
}

async function fetchHls(raw, options = {}) {
  let url = validateUrl(raw);
  for (let redirects = 0; ; redirects++) {
    const up = await request(url, options);
    if (![301, 302, 303, 307, 308].includes(up.status)) return up;
    await up.body.cancel();
    if (redirects >= 5 || !up.headers.get("location")) throw new PlaylistError("Invalid HLS redirect.");
    url = validateUrl(new URL(up.headers.get("location"), url).href);
  }
}

module.exports = { PlaylistError, validateUrl, fetchHls, isPublicAddress, lookup };

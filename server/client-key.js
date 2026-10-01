"use strict";
const LOOPBACK_PEER = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i;

/**
 * Who is making this request, for rate limits and sign-in attempt counting.
 *
 * Behind a reverse proxy on the same machine every request arrives from the loopback address, so keying on the socket would put all users in one bucket:
 * one client could lock everyone (the owner included) out of signing in, and the owner's own successful sign-in would reset the counter of whoever was
 * guessing. A loopback peer is the operator's own proxy, which this app already trusts for X-Forwarded-Proto (auth.js); the address that proxy appended,
 * the LAST entry of X-Forwarded-For, names the real client. Earlier entries are client-supplied and are ignored, and a peer that is not loopback is
 * never believed about its headers.
 */
function clientKey(req) {
  const peer = req.socket?.remoteAddress || "unknown";
  if (!LOOPBACK_PEER.test(peer)) return peer;
  const forwarded = req.headers?.["x-forwarded-for"];
  const last = typeof forwarded === "string" ? forwarded.split(",").pop().trim() : "";
  return last && last.length <= 64 ? last : peer;
}

module.exports = { clientKey };

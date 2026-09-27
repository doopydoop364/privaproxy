"use strict";
const { Readable } = require("stream");

async function cancelBody(up) {
  if (up.body) await up.body.cancel().catch(() => {});
}

// Enforce the limit while reading, rather than after allocating the entire body.
async function readCapped(up, max) {
  if (Number(up.headers.get("content-length")) > max) {
    await cancelBody(up);
    return null;
  }
  const chunks = [];
  let size = 0;
  if (up.body) {
    for await (const chunk of Readable.fromWeb(up.body)) {
      size += chunk.length;
      if (size > max) return null; // iterator cleanup destroys/cancels the upstream
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

module.exports = { cancelBody, readCapped };

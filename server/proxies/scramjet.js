const path = require("path");
const express = require("express");

// Scramjet is a genuinely different proxy engine from Ultraviolet -- a
// Rust/WASM-based rewriter instead of pure JS -- but it uses the SAME
// bare-mux transport system Ultraviolet does. That means it needs no bare
// server of its own: whichever backend the person has selected via
// setTransport() (see public/js/app.js) is automatically what Scramjet
// tabs use too. This module only has static files to serve.
const scramjetDist = path.join(
  __dirname,
  "../../node_modules/@mercuryworkshop/scramjet/dist"
);

module.exports = {
  id: "scramjet",
  name: "Scramjet",

  mount(app) {
    // Our own sw.js (public/scramjet/sw.js) first, then the package's
    // static runtime files it imports (scramjet.all.js, the wasm rewriter,
    // scramjet.sync.js).
    app.use("/scramjet/", express.static(path.join(__dirname, "../../public/scramjet")));
    app.use("/scramjet/", express.static(scramjetDist));
  },

  async healthCheck() {
    return true;
  },
};

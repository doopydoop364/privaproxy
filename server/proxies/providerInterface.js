/**
 * Every proxy provider module must export an object matching this shape:
 *
 * {
 *   id: string              // unique id, matches config/proxies.json entry
 *   name: string            // display name shown in the UI dropdown
 *   mount(app, server)      // attach routes/middleware to the Express app.
 *                           // `server` is the raw http.Server, needed if the
 *                           // provider has to handle WebSocket upgrades.
 *   healthCheck(): Promise<boolean>  // used by /api/proxies to report status
 * }
 *
 * To add a new proxy type later:
 *   1. Create server/proxies/yourProxy.js implementing this interface
 *   2. Register it in server/proxies/registry.js
 *   3. Add an entry for it in server/config/proxies.json
 * The frontend dropdown and backend routing pick it up automatically.
 */
module.exports = {};

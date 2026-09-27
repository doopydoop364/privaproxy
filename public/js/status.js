"use strict";
(() => {
  const backends = document.getElementById("statusBackends");
  const youtube = document.getElementById("statusYoutube");
  const issues = document.getElementById("statusIssues");
  const recent = [];
  function record(message) {
    if (typeof message !== "string" || !message.trim()) return;
    recent.unshift({ message: message.slice(0, 300), time: new Date().toLocaleTimeString() });
    recent.length = Math.min(recent.length, 10);
    issues.replaceChildren(...recent.map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.time}: ${item.message}`;
      return li;
    }));
  }
  async function refresh() {
    fetch("/api/auth/status", { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).then((data) => { document.getElementById("statusLogout").hidden = !data.enabled; })
      .catch(() => {});
    const results = await Promise.allSettled([
      fetch("/api/proxies", { signal: AbortSignal.timeout(10000) }).then((r) => { if (!r.ok) throw Error(); return r.json(); }),
      fetch("/api/youtube/status", { signal: AbortSignal.timeout(12000) }).then((r) => { if (!r.ok) throw Error(); return r.json(); }),
    ]);
    if (results[0].status === "fulfilled" && Array.isArray(results[0].value)) {
      backends.replaceChildren(...results[0].value.map((p) => {
        const line = document.createElement("p");
        line.textContent = `${p.name}: ${p.online === true ? "online" : p.online === false ? "offline" : "checking"}${Number.isFinite(p.latencyMs) ? ` · ${p.latencyMs} ms` : ""}`;
        return line;
      }));
      if (!results[0].value.length) backends.textContent = "No backends configured.";
    } else backends.textContent = "Could not check proxy backends.";
    if (results[1].status === "fulfilled" && results[1].value?.ok) {
      const status = results[1].value;
      youtube.textContent = `yt-dlp ${status.version}${status.jsRuntimes?.length ? ` · JavaScript: ${status.jsRuntimes.join(", ")}` : ""}`;
    } else youtube.textContent = "yt-dlp is unavailable or timed out.";
  }
  document.getElementById("statusRefresh").addEventListener("click", refresh);
  document.querySelector('[data-view="status"]').addEventListener("click", refresh);
  window.privaproxyDiagnostics = { record, refresh };
})();

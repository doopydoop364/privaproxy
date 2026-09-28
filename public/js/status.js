"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const view = $("view-status");
  const refreshButton = $("statusRefresh"), auto = $("statusAuto"), interval = $("statusInterval");
  const summary = $("statusSummary"), updateState = $("statusUpdateState");
  const sections = { server: $("statusServer"), proxies: $("statusBackends"), youtube: $("statusYoutube") };
  const records = {}, transitions = new Map(), latency = new Map();
  const events = [], issues = [];
  const INTERVALS = [5000, 15000, 30000];
  let timer = null, job = null, resumePending = false, lastAttempt = null, pageAway = false;
  let lastVisible = false;
  try { interval.value = String(INTERVALS.includes(Number(localStorage.getItem("statusInterval"))) ? Number(localStorage.getItem("statusInterval")) : 5000); }
  catch { interval.value = "5000"; }

  const visible = () => !pageAway && !document.hidden && view.classList.contains("is-active");
  const online = () => navigator.onLine !== false;
  const stamp = ms => new Date(ms).toLocaleTimeString();
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function renderLog(list, target, empty) {
    target.replaceChildren(...(list.length ? list.map(item => element("li", "", `${stamp(item.time)} · ${item.message}${item.count > 1 ? ` (×${item.count})` : ""}`)) : [element("li", "status-muted", empty)]));
  }
  function log(list, message, target, empty) {
    if (typeof message !== "string" || !message.trim()) return;
    const clean = message.trim().slice(0, 300);
    if (list[0]?.message === clean) { list[0].count++; list[0].time = Date.now(); }
    else list.unshift({ message: clean, count: 1, time: Date.now() });
    list.length = Math.min(list.length, 20);
    renderLog(list, target, empty);
  }
  function record(message) { log(issues, message, $("statusIssues"), "No playback messages yet."); }
  function transition(key, state, label) {
    const prev = transitions.get(key);
    if (prev !== state && (prev !== undefined || state === "error" || state === "offline")) {
      log(events, `${label}: ${state === "ok" ? prev === "checking" ? "online" : "recovered" : state === "offline" ? "offline" : state === "checking" ? "checking" : "check failed"}.`, $("statusEvents"), "No service changes yet.");
    }
    transitions.set(key, state);
  }
  function statusLine(target, state, label) {
    target.dataset.state = state;
    target.appendChild(element("p", `status-badge is-${state}`, label));
  }
  function detail(target, message) { target.appendChild(element("p", "status-muted", message)); }

  function renderSection(name) {
    const target = sections[name], record = records[name];
    target.replaceChildren();
    if (!record) { statusLine(target, "checking", "Checking…"); return; }
    const { data, error, successAt, responseMs } = record;
    if (error) {
      statusLine(target, "error", error);
      if (successAt) detail(target, `Showing last known results from ${stamp(successAt)}.`);
    }
    if (name === "server" && data) {
      if (!error) statusLine(target, "ok", "Reachable");
      detail(target, data.enabled ? "Password protection enabled" : "Password protection not configured");
      $("statusLogout").hidden = !data.enabled;
    }
    if (name === "proxies" && data) {
      if (!data.length) { if (error) detail(target, "No backends configured at the last successful check."); else statusLine(target, "checking", "No backends configured."); }
      else {
        const counts = { ok: 0, offline: 0, checking: 0 };
        for (const proxy of data) counts[proxy.online === true ? "ok" : proxy.online === false ? "offline" : "checking"]++;
        if (!error) statusLine(target, counts.offline ? "error" : counts.checking ? "checking" : "ok", `${counts.ok} online · ${counts.offline} offline · ${counts.checking} checking`);
        for (const proxy of data) {
          const row = element("div", "status-backend");
          row.dataset.state = error ? "stale" : proxy.online === true ? "ok" : proxy.online === false ? "error" : "checking";
          const state = proxy.online === true ? "online" : proxy.online === false ? "offline" : "checking";
          row.appendChild(element("p", "status-backend-name", `${proxy.name || proxy.id || "Backend"}: ${state}${error ? " (last known)" : ""}`));
          if (proxy.description) detail(row, String(proxy.description).slice(0, 300));
          if (Number.isFinite(proxy.latencyMs) && proxy.latencyMs >= 0) detail(row, `Backend latency: ${Math.round(proxy.latencyMs)} ms`);
          if (Number.isFinite(proxy.checkedAt) && proxy.checkedAt > 0) detail(row, `Last probe: ${stamp(proxy.checkedAt)} (${Math.max(0, Math.floor((Date.now() - proxy.checkedAt) / 1000))} seconds ago)`);
          else detail(row, "Waiting for the first backend probe.");
          const samples = latency.get(proxy.id)?.samples || [];
          if (samples.length > 1) detail(row, `Recent range: ${Math.round(Math.min(...samples))}–${Math.round(Math.max(...samples))} ms · ${samples.length} probes`);
          target.appendChild(row);
        }
      }
    }
    if (name === "youtube" && data) {
      if (!error) statusLine(target, data.ok ? "ok" : "error", data.ok ? "yt-dlp available" : "yt-dlp is unavailable.");
      if (data.ok) {
        detail(target, `yt-dlp ${typeof data.version === "string" ? data.version : "(version not reported)"}`);
        detail(target, `Configured JavaScript runtimes: ${data.jsRuntimes?.length ? data.jsRuntimes.join(", ") : "none reported"}`);
      }
    }
    if (successAt && !error) detail(target, `Checked ${stamp(successAt)} · API response ${responseMs} ms`);
  }
  function overview() {
    let state = "checking", message = "Checking services…";
    if (!online()) { state = "error"; message = "Your browser is offline. Showing last known results."; }
    else if (Object.values(records).some(r => r.error)) { state = "error"; message = "Some checks failed. Previous results may be stale."; }
    else if (records.proxies?.data?.some(p => p.online === false) || records.youtube?.data?.ok === false) { state = "error"; message = "Some services need attention."; }
    else if (records.server && records.proxies && records.youtube && records.proxies.data.length && records.proxies.data.every(p => p.online === true)) {
      state = "ok"; message = "All checks passed.";
    } else if (lastAttempt) message = "Waiting for backend health checks or configuration.";
    summary.dataset.state = state;
    text(summary, message);
    $("statusLogin").hidden = !Object.values(records).some(r => r.error === "Sign in again to check services.");
    text($("statusUpdated"), lastAttempt ? `Last update attempt: ${stamp(lastAttempt)}` : "No checks yet.");
    const mode = !online() ? "Updates resume when your connection returns." : !visible() ? "Updates paused while this page is hidden." : job ? "Checking services…" : !auto.checked ? "Auto refresh paused." : `Updates every ${Number(interval.value) / 1000} seconds after each check.`;
    text(updateState, mode);
    refreshButton.disabled = !!job || !online();
    view.setAttribute("aria-busy", String(!!job));
  }

  function validate(name, data) {
    const optionalText = value => value === undefined || typeof value === "string";
    if (name === "proxies") return Array.isArray(data) && data.every(p => p && typeof p.id === "string" &&
      optionalText(p.name) && optionalText(p.description) && [true, false, null, undefined].includes(p.online) &&
      (p.latencyMs == null || Number.isFinite(p.latencyMs) && p.latencyMs >= 0) && (p.checkedAt == null || Number.isFinite(p.checkedAt)));
    if (name === "server") return data && typeof data.enabled === "boolean";
    return data && typeof data.ok === "boolean" && optionalText(data.version) &&
      (data.jsRuntimes === undefined || Array.isArray(data.jsRuntimes) && data.jsRuntimes.every(r => typeof r === "string"));
  }
  async function request(path, name, timeout, signal) {
    const start = performance.now();
    const res = await fetch(path, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "Sign in again to check services." : `Check failed (HTTP ${res.status}).`);
    const data = await res.json();
    if (!validate(name, data)) throw new Error("The server returned an invalid status response.");
    return { data, responseMs: Math.max(0, Math.round(performance.now() - start)) };
  }
  function clearTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
  function schedule() {
    clearTimer();
    if (visible() && online() && auto.checked) timer = setTimeout(() => { timer = null; refresh(); }, Number(interval.value));
  }
  function refresh() {
    clearTimer();
    if (!visible() || !online()) { overview(); return Promise.resolve(); }
    if (job) { if (job.controller.signal.aborted) resumePending = true; return job.promise; }
    const run = { controller: new AbortController(), promise: null };
    job = run;
    overview();
    run.promise = (async () => {
      const checks = [["server", "/api/auth/status", 5000], ["proxies", "/api/proxies", 10000], ["youtube", "/api/youtube/status", 12000]];
      const results = await Promise.allSettled(checks.map(([name, path, timeout]) => request(path, name, timeout, run.controller.signal)));
      if (run.controller.signal.aborted || !visible()) return;
      lastAttempt = Date.now();
      results.forEach((result, i) => {
        const name = checks[i][0], prev = records[name];
        if (result.status === "fulfilled") {
          records[name] = { ...result.value, error: null, successAt: lastAttempt };
          const state = name === "youtube" && !result.value.data.ok ? "error" : "ok";
          transition(name, state, name === "server" ? "Server" : name === "proxies" ? "Proxy status API" : "YouTube tools");
          if (name === "proxies") {
            const ids = new Set();
            for (const p of result.value.data) {
              ids.add(p.id);
              transition(`backend:${p.id}`, p.online === true ? "ok" : p.online === false ? "offline" : "checking", String(p.name || p.id).slice(0, 100));
              if (p.online === true && Number.isFinite(p.latencyMs) && p.latencyMs >= 0 && Number.isFinite(p.checkedAt)) {
                const entry = latency.get(p.id) || { samples: [], checkedAt: null };
                if (entry.checkedAt !== p.checkedAt) { entry.samples.push(p.latencyMs); entry.samples = entry.samples.slice(-20); entry.checkedAt = p.checkedAt; }
                latency.set(p.id, entry);
              }
            }
            for (const id of latency.keys()) if (!ids.has(id)) latency.delete(id);
            for (const key of transitions.keys()) if (key.startsWith("backend:") && !ids.has(key.slice(8))) transitions.delete(key);
          }
        } else {
          // Keep useful previous results, clearly labelled as stale.
          const error = result.reason?.message === "Sign in again to check services." ? result.reason.message :
            result.reason?.message?.startsWith("Check failed (HTTP") || result.reason?.message === "The server returned an invalid status response." ? result.reason.message : "Could not check this service (connection failed or timed out).";
          records[name] = { ...prev, error };
          transition(name, "error", name === "server" ? "Server" : name === "proxies" ? "Proxy status API" : "YouTube tools");
        }
        renderSection(name);
      });
    })().finally(() => {
      if (job !== run) return;
      job = null;
      const resume = resumePending; resumePending = false;
      overview();
      if (resume && visible() && online()) refresh(); else schedule();
    });
    return run.promise;
  }
  function sync() {
    const nowVisible = visible();
    if (!nowVisible || !online()) {
      clearTimer(); resumePending = false; job?.controller.abort();
    } else if (!lastVisible && (auto.checked || !lastAttempt)) refresh();
    lastVisible = nowVisible;
    overview();
  }
  refreshButton.addEventListener("click", refresh);
  auto.addEventListener("change", () => { if (auto.checked) refresh(); else { clearTimer(); resumePending = false; } overview(); });
  interval.addEventListener("change", () => {
    if (!INTERVALS.includes(Number(interval.value))) interval.value = "5000";
    try { localStorage.setItem("statusInterval", interval.value); } catch { /* optional preference */ }
    if (!job) schedule();
    overview();
  });
  for (const [id, list, target, empty] of [["statusClearEvents", events, "statusEvents", "No service changes yet."], ["statusClearIssues", issues, "statusIssues", "No playback messages yet."]]) {
    $(id).addEventListener("click", () => { list.length = 0; renderLog(list, $(target), empty); });
    renderLog(list, $(target), empty);
  }
  new MutationObserver(sync).observe(view, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("offline", sync);
  window.addEventListener("online", () => { lastVisible = false; sync(); });
  window.addEventListener("pagehide", () => { pageAway = true; sync(); });
  window.addEventListener("pageshow", () => { pageAway = false; lastVisible = false; sync(); });
  window.privaproxyDiagnostics = { record, refresh };
  sync();
})();

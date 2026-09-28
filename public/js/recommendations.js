// Local, deterministic recommendation stages. No network or DOM dependency.
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./ytlearning") : root.YtLearning);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YtRecommendations = api;
})(typeof self !== "undefined" ? self : this, function (learning) {
  "use strict";
  const VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
  const DAY = 86400000;
  const LIMIT = 400;
  // Readiness is a starting data goal, not evidence that a learned model is better.
  const LEARNING_GOAL = Object.freeze({ qualifiedVideos: 100, impressions: 500, feedback: 20 });
  const bounded = (n, max) => Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
  const channelKey = item => item.channelId || (item.author ? `author:${item.author.toLowerCase()}` : `video:${item.id}`);
  const STOP = new Set("the and for with from this that your you how what why are was into video official full new a an of to in on is it at by or as be my we our".split(" "));
  const tokens = title => [...new Set((String(title || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter(t => !STOP.has(t)))].slice(0, 30);

  function normalizeState(raw) {
    const x = raw && typeof raw === "object" ? raw : {};
    const stats = {}, feedback = {};
    for (const [id, v] of Object.entries(x.stats || {}).slice(-LIMIT)) {
      if (!VIDEO.test(id) || !v || typeof v !== "object") continue;
      stats[id] = { seconds: bounded(v.seconds, 1e7), mediaSeconds: bounded(v.mediaSeconds ?? v.seconds, 1e7), duration: bounded(v.duration, 86400),
        lastWatchedAt: bounded(v.lastWatchedAt, 1e13), impressions: bounded(v.impressions, 10000),
        lastShownAt: bounded(v.lastShownAt, 1e13) };
    }
    for (const [id, v] of Object.entries(x.feedback || {}).slice(-200)) {
      if (!VIDEO.test(id) || !v || !["more", "less"].includes(v.value)) continue;
      feedback[id] = { value: v.value, at: bounded(v.at, 1e13),
        title: String(v.title || "").slice(0, 200), author: String(v.author || "").slice(0, 100),
        channelId: CHANNEL.test(v.channelId || "") ? v.channelId : "" };
    }
    const searches = [];
    for (const s of (Array.isArray(x.searches) ? x.searches : []).slice(0, 20)) {
      if (!s || typeof s.query !== "string" || !s.query.trim()) continue;
      const query = s.query.trim().slice(0, 200);
      if (!searches.some(v => v.query.toLowerCase() === query.toLowerCase())) searches.push({ query, at: bounded(s.at, 1e13) });
    }
    const examples = [];
    for (const e of (Array.isArray(x.examples) ? x.examples : []).slice(-600)) {
      const features = learning.normalizeFeatures(e?.features);
      if (!features || !VIDEO.test(e.id || "")) continue;
      examples.push({ id: e.id, features, channelId: CHANNEL.test(e.channelId || "") ? e.channelId : "",
        at: bounded(e.at, 1e13), watchReward: Number.isFinite(e.watchReward) ? bounded(e.watchReward, 1) : null });
    }
    return { version: 2, stats, feedback, searches, examples,
      models: { bandit: x.models?.bandit === true, neural: x.models?.neural === true },
      blockedChannels: [...new Set((Array.isArray(x.blockedChannels) ? x.blockedChannels : []).filter(id => CHANNEL.test(id)))].slice(-100) };
  }

  function recordSearch(raw, query, now = Date.now()) {
    const state = normalizeState(raw);
    if (typeof query !== "string" || !query.trim()) return state;
    query = query.trim().slice(0, 200);
    state.searches = [{ query, at: now }, ...state.searches.filter(s => s.query.toLowerCase() !== query.toLowerCase())].slice(0, 20);
    return state;
  }

  function addExample(state, id, features, channelId, now) {
    const clean = learning.normalizeFeatures(features);
    if (clean && VIDEO.test(id || "")) state.examples.push({ id, features: clean, channelId: CHANNEL.test(channelId || "") ? channelId : "", at: now, watchReward: null });
    state.examples = state.examples.slice(-600);
  }

  function trainingExamples(raw) {
    const state = normalizeState(raw);
    return learning.cleanExamples(state.examples.map(e => ({ ...e, reward: state.blockedChannels.includes(e.channelId) ? 0 :
      state.feedback[e.id]?.value === "more" ? 1 : state.feedback[e.id]?.value === "less" ? 0 : e.watchReward })));
  }

  function updateStats(raw, id, change) {
    const state = normalizeState(raw);
    if (!VIDEO.test(id || "")) return state;
    const prev = state.stats[id] || {};
    delete state.stats[id];
    state.stats[id] = { ...prev, ...change(prev) };
    return normalizeState(state);
  }

  function recordWatch(raw, id, seconds, duration, now = Date.now(), mediaSeconds = seconds, features, channelId) {
    if (!(seconds > 0) || !Number.isFinite(seconds)) return normalizeState(raw);
    const state = updateStats(raw, id, prev => ({ seconds: (prev.seconds || 0) + seconds,
      mediaSeconds: (prev.mediaSeconds || 0) + bounded(mediaSeconds, 1e7),
      duration: bounded(duration, 86400), lastWatchedAt: now }));
    let example = [...state.examples].reverse().find(e => e.id === id);
    if (!example) { addExample(state, id, features, channelId, now); example = state.examples.at(-1); }
    if (example?.id === id && state.stats[id]?.seconds >= 5) {
      const s = state.stats[id];
      example.watchReward = 0.6 * (s.duration > 0 ? Math.min(1, s.mediaSeconds / s.duration) : 0) + 0.4 * Math.min(1, s.seconds / 180);
    }
    return state;
  }
  function recordImpression(raw, id, now = Date.now(), features, channelId) {
    const state = updateStats(raw, id, prev => ({ impressions: (prev.impressions || 0) + 1, lastShownAt: now }));
    addExample(state, id, features, channelId, now);
    return state;
  }
  function setFeedback(raw, item, value, now = Date.now()) {
    const state = normalizeState(raw);
    if (!VIDEO.test(item?.id || "")) return state;
    if (!state.examples.some(e => e.id === item.id)) addExample(state, item.id, item.recommendationFeatures, item.channelId, now);
    if (value === "block" && CHANNEL.test(item.channelId || "")) {
      state.blockedChannels.push(item.channelId);
    } else if (["more", "less"].includes(value)) {
      delete state.feedback[item.id];
      state.feedback[item.id] = { ...item, value, at: now };
    }
    return normalizeState(state);
  }

  // Unknown/legacy watches have weak affinity. Starting/autoplay alone adds no reward.
  function satisfaction(item, state) {
    const feedback = state.feedback[item.id]?.value;
    if (feedback === "less" || state.blockedChannels.includes(item.channelId)) return 0;
    if (feedback === "more") return 1;
    const stat = state.stats[item.id];
    if (!stat?.seconds) return 0.12;
    const duration = stat.duration || item.duration;
    const completion = duration > 0 ? Math.min(1, stat.mediaSeconds / duration) : 0;
    return Math.min(1, 0.12 + 0.45 * completion + 0.43 * Math.min(1, stat.seconds / 180));
  }
  function interest(item, state, now, index = 0) {
    const timestamp = state.stats[item.id]?.lastWatchedAt || state.feedback[item.id]?.at || item.watchedAt;
    const decay = timestamp > 0 ? Math.pow(0.5, Math.max(0, now - timestamp) / (30 * DAY)) : 1 / (1 + index * 0.1);
    return satisfaction(item, state) * (0.25 + 0.75 * decay);
  }
  function profileItems(history, state) {
    const items = new Map(history.map(h => [h.id, h]));
    for (const [id, f] of Object.entries(state.feedback)) if (f.value === "more" && !items.has(id)) items.set(id, { id, ...f });
    return [...items.values()].filter(h => satisfaction(h, state) > 0);
  }

  function selectSeeds(history, raw, now = Date.now(), max = 4) {
    const state = normalizeState(raw);
    const pool = profileItems(history, state);
    const chosen = [], counts = new Map();
    const take = item => {
      const key = channelKey(item);
      if (chosen.some(x => x.id === item.id) || (counts.get(key) || 0) >= 2) return;
      counts.set(key, (counts.get(key) || 0) + 1);
      chosen.push(item);
    };
    // Recent, satisfying watches plus an older favourite. Preserve a useful cold start.
    const recent = pool.slice(0, 12).sort((a, b) => interest(b, state, now, pool.indexOf(b)) - interest(a, state, now, pool.indexOf(a)));
    for (const item of recent) { if (chosen.length >= Math.max(1, max - 1)) break; take(item); }
    const favourites = [...pool].sort((a, b) => satisfaction(b, state) - satisfaction(a, state) || interest(b, state, now) - interest(a, state, now));
    for (const item of favourites) { if (chosen.length >= max) break; take(item); }
    return chosen.slice(0, max);
  }

  function topicQuery(history, raw, now = Date.now()) {
    const state = normalizeState(raw), weights = new Map();
    if (state.searches[0]?.at > now - 14 * DAY) return state.searches[0].query.slice(0, 100);
    profileItems(history, state).forEach((item, i) => {
      for (const t of tokens(item.title)) weights.set(t, (weights.get(t) || 0) + interest(item, state, now, i));
    });
    return [...weights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(x => x[0]).join(" ").slice(0, 100);
  }

  function learningStatus(raw) {
    const state = normalizeState(raw);
    const stats = Object.values(state.stats);
    const progress = { qualifiedVideos: stats.filter(s => s.seconds >= Math.max(5, Math.min(30, (s.duration || 60) / 2))).length,
      impressions: stats.reduce((n, s) => n + s.impressions, 0), feedback: Object.keys(state.feedback).length };
    return { progress, goal: LEARNING_GOAL, ready: Object.keys(LEARNING_GOAL).every(k => progress[k] >= LEARNING_GOAL[k]),
      active: false }; // Data goal only; model readiness is checked separately.
  }

  function localLearningStatus(raw) {
    const state = normalizeState(raw), base = learningStatus(state), examples = trainingExamples(state);
    const positive = examples.filter(e => e.reward >= 0.6).length, negative = examples.filter(e => e.reward <= 0.25).length;
    const ready = base.ready && examples.length >= learning.MIN_EXAMPLES && positive >= 10 && negative >= 10;
    let model = null;
    try { if (ready && (state.models.bandit || state.models.neural)) model = learning.train(examples); }
    catch { /* Keep the heuristic pipeline if local training cannot finish. */ }
    return { ...base, ready, samples: examples.length, positive, negative, minSamples: learning.MIN_EXAMPLES,
      active: !!model && (state.models.bandit && !!model.bandit || state.models.neural && !!model.neural),
      neuralValidated: !!model?.neural, model };
  }

  function selectSubscriptions(subscriptions, history, raw, max = 2) {
    const state = normalizeState(raw), weights = new Map();
    profileItems(history, state).forEach((h, i) => weights.set(h.channelId, (weights.get(h.channelId) || 0) + interest(h, state, Date.now(), i)));
    return subscriptions.filter(s => !state.blockedChannels.includes(s.id)).sort((a, b) => (weights.get(b.id) || 0) - (weights.get(a.id) || 0)).slice(0, max);
  }

  // Compare media advance with monotonic wall time; seeks, buffering and long gaps
  // cannot masquerade as viewing. Seconds here mean real time, independent of speed.
  function watchedDelta(previous, next) {
    if (!previous || !next || !previous.playing || !next.playing) return 0;
    const wall = (next.wall - previous.wall) / 1000;
    const advance = next.time - previous.time;
    if (!(wall > 0 && wall <= 5 && advance > 0)) return 0;
    if (advance > wall * (next.rate || 1) + 0.5) return 0;
    return Math.min(wall, advance / (next.rate || 1));
  }

  function rankComplex(groups, context = {}, seen = new Set()) {
    const state = normalizeState(context.state);
    const history = Array.isArray(context.history) ? context.history : [];
    const now = context.now || Date.now();
    const profile = profileItems(history, state);
    const watched = new Set(history.map(h => h.id));
    const subs = new Set((context.subscriptions || []).map(c => c.id));
    const saved = new Set((context.saved || []).map(c => c.id));
    const pool = new Map();
    for (const group of groups || []) {
      const sourceSeed = profile.find(h => h.id === group.seedId);
      const sourceWeight = sourceSeed ? 0.5 + interest(sourceSeed, state, now) : group.source === "subscriptions" ? 0.8 : 0.6;
      const unique = new Set();
      (group.items || []).slice(0, 100).forEach((item, index) => {
        if (!item || !VIDEO.test(item.id || "") || seen.has(item.id) || watched.has(item.id) || unique.has(item.id) ||
            state.feedback[item.id]?.value === "less" || state.blockedChannels.includes(item.channelId)) return;
        unique.add(item.id);
        const candidate = pool.get(item.id) || { item, fusion: 0, sources: new Set() };
        candidate.fusion += sourceWeight / (60 + index + 1); // weighted reciprocal rank fusion
        candidate.sources.add(group.source || "related");
        pool.set(item.id, candidate);
      });
    }
    const candidates = [...pool.values()].slice(0, 300);
    if (!candidates.length) return [];
    // Small TF-IDF corpus from available titles; never requires a per-card lookup.
    const previous = (context.previous || []).slice(-8);
    const docs = [...profile, ...candidates.map(c => c.item), ...previous, ...state.searches.map(s => ({ title: s.query }))].map(h => tokens(h.title));
    const df = new Map();
    for (const doc of docs) for (const t of doc) df.set(t, (df.get(t) || 0) + 1);
    const vector = doc => new Map(doc.map(t => [t, Math.log((docs.length + 1) / ((df.get(t) || 0) + 1)) + 1]));
    const cosine = (a, b) => {
      let dot = 0, na = 0, nb = 0;
      for (const [t, v] of a) { dot += v * (b.get(t) || 0); na += v * v; }
      for (const v of b.values()) nb += v * v;
      return na && nb ? dot / Math.sqrt(na * nb) : 0;
    };
    const affinity = new Map(), topics = new Map();
    let total = 0;
    profile.forEach((item, i) => {
      const w = interest(item, state, now, i); total += w;
      const key = channelKey(item); affinity.set(key, (affinity.get(key) || 0) + w);
      for (const [t, v] of vector(docs[i])) topics.set(t, (topics.get(t) || 0) + w * v);
    });
    state.searches.forEach((s, i) => {
      const w = 0.65 * Math.pow(0.5, Math.max(0, now - s.at) / (7 * DAY)) / (1 + i * 0.5);
      for (const [t, v] of vector(docs[profile.length + candidates.length + previous.length + i])) topics.set(t, (topics.get(t) || 0) + w * v);
    });
    const maxFusion = Math.max(...candidates.map(c => c.fusion));
    candidates.forEach((c, i) => {
      c.vector = vector(docs[profile.length + i]);
      const topic = cosine(c.vector, topics);
      const channel = total ? (affinity.get(channelKey(c.item)) || 0) / total : 0;
      const timestamp = c.item.uploadedAt * 1000;
      const fresh = timestamp > 0 && timestamp <= now ? Math.pow(0.5, (now - timestamp) / (60 * DAY)) : 0;
      const exposure = state.stats[c.item.id];
      const penalty = exposure ? Math.min(0.2, exposure.impressions * 0.025) * Math.pow(0.5, Math.max(0, now - exposure.lastShownAt) / (7 * DAY)) : 0;
      c.score = 0.4 * c.fusion / maxFusion + 0.25 * topic + 0.15 * channel + 0.08 * Number(subs.has(c.item.channelId)) +
        0.06 * Number(saved.has(c.item.id)) + 0.06 * fresh - penalty + (state.feedback[c.item.id]?.value === "more" ? 0.2 : 0);
      c.reason = subs.has(c.item.channelId) ? "From a subscription" : topic > 0.2 ? "Matches your interests" : c.sources.has("related") ? "Related to your watches" : "Discover something new";
      c.discovery = !affinity.has(channelKey(c.item)) && !subs.has(c.item.channelId);
      c.features = [c.fusion / maxFusion, topic, channel, Number(subs.has(c.item.channelId)), Number(saved.has(c.item.id)), fresh,
        Math.min(1, (exposure?.impressions || 0) / 8), Number(c.discovery)];
    });
    for (const c of candidates) c.baseScore = c.score;
    const local = localLearningStatus(state);
    if (local.active) for (const c of candidates) c.score += learning.score(local.model, c.features, state.models);
    // Optional custom local adapter: same candidates, bounded score adjustment,
    // explicit enable flag, and useful-data gate. The deterministic pipeline remains.
    if (context.enableLearning === true && learningStatus(state).ready && typeof context.learnedRanker === "function") {
      try {
        const adjustments = context.learnedRanker(candidates.map(c => ({ ...c.item, score: c.score })), { history, state });
        for (const c of candidates) if (Number.isFinite(adjustments?.[c.item.id])) c.score += Math.max(-0.2, Math.min(0.2, adjustments[c.item.id]));
      } catch { /* A future model failure must not break Home. */ }
    }
    for (const c of candidates) c.score = c.baseScore + Math.max(-0.2, Math.min(0.2, c.score - c.baseScore));
    const prior = previous.map((item, i) => ({ item, vector: vector(docs[profile.length + candidates.length + i]) }));
    const selected = [], remaining = [...candidates];
    // Maximal marginal relevance. About one slot in eight explores a new creator;
    // the rest balance affinity against title/channel repetition.
    while (remaining.length) {
      const explore = ((context.offset || 0) + selected.length + 1) % 8 === 0 && remaining.some(c => c.discovery);
      let best = null, bestScore = -Infinity;
      const recent = [...prior, ...selected].slice(-8);
      for (const c of remaining) {
        if (explore && !c.discovery) continue;
        const repetition = Math.max(0, ...recent.map(s => Math.max(cosine(c.vector, s.vector), channelKey(c.item) === channelKey(s.item) ? 0.95 : 0)));
        const value = 0.75 * c.score - 0.25 * repetition;
        if (value > bestScore) { best = c; bestScore = value; }
      }
      selected.push(best);
      remaining.splice(remaining.indexOf(best), 1);
    }
    return selected.map(c => ({ ...c.item, recommendationReason: c.reason, recommendationFeatures: c.features }));
  }
  return { LEARNING_GOAL, normalizeState, recordSearch, recordWatch, recordImpression, setFeedback, selectSeeds, selectSubscriptions, topicQuery,
    clearLearningCache: learning.clearCache, trainingExamples, learningStatus, localLearningStatus, watchedDelta, rankComplex };
});

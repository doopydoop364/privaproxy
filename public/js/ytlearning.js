// Small local learning models; no downloads, telemetry, or external libraries.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YtLearning = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const FEATURES = 8, HIDDEN = 6, MIN_EXAMPLES = 100;
  let cachedKey = null, cachedModel = null;
  const clamp = x => Math.max(0, Math.min(1, x));
  function normalizeFeatures(x) {
    return Array.isArray(x) && x.length === FEATURES && x.every(Number.isFinite) ? x.map(clamp) : null;
  }
  const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
  const vector = features => [1, ...features];
  const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

  function cleanExamples(raw) {
    const latest = new Map();
    for (const e of (Array.isArray(raw) ? raw : []).slice(-600)) {
      const features = normalizeFeatures(e?.features);
      if (!features || typeof e.id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(e.id) || !Number.isFinite(e.reward)) continue;
      latest.delete(e.id);
      latest.set(e.id, { id: e.id, features, reward: clamp(e.reward) });
    }
    return [...latest.values()];
  }

  // Ridge regression with an upper confidence bound (shared linear contextual
  // model). Invert a positive-definite 9x9 matrix with pivoted elimination.
  function inverse(matrix) {
    const n = matrix.length;
    const rows = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))]);
    for (let i = 0; i < n; i++) {
      let pivot = i;
      for (let j = i + 1; j < n; j++) if (Math.abs(rows[j][i]) > Math.abs(rows[pivot][i])) pivot = j;
      [rows[i], rows[pivot]] = [rows[pivot], rows[i]];
      const divisor = rows[i][i];
      if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-10) return null;
      rows[i] = rows[i].map(v => v / divisor);
      for (let j = 0; j < n; j++) if (j !== i) {
        const factor = rows[j][i];
        rows[j] = rows[j].map((v, k) => v - factor * rows[i][k]);
      }
    }
    return rows.map(row => row.slice(n));
  }
  function trainBandit(examples) {
    const n = FEATURES + 1;
    const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 2 : 0));
    const b = Array(n).fill(0);
    for (const e of examples) {
      const x = vector(e.features);
      for (let i = 0; i < n; i++) {
        b[i] += e.reward * x[i];
        for (let j = 0; j < n; j++) a[i][j] += x[i] * x[j];
      }
    }
    const inv = inverse(a);
    return inv ? { inverse: inv, weights: inv.map(row => dot(row, b)) } : null;
  }
  function banditPrediction(model, features) {
    const x = vector(features);
    const uncertainty = Math.sqrt(Math.max(0, dot(x, model.inverse.map(row => dot(row, x)))));
    return { mean: clamp(dot(model.weights, x)), uncertainty: Math.min(1, uncertainty) };
  }

  function neuralPrediction(model, features) {
    const x = vector(features);
    const hidden = model.hidden.map(w => Math.tanh(dot(w, x)));
    return { x, hidden, mean: sigmoid(model.bias + dot(hidden, model.output)) };
  }
  function trainNeural(examples) {
    // Deterministic initialization and shuffling make diagnosis/tests repeatable.
    let seed = 719;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const mean = examples.reduce((n, e) => n + e.reward, 0) / examples.length;
    const model = { hidden: Array.from({ length: HIDDEN }, () => Array.from({ length: FEATURES + 1 }, () => (random() - 0.5) * 0.6)),
      output: Array.from({ length: HIDDEN }, () => (random() - 0.5) * 0.2), bias: Math.log((mean + 0.01) / (1.01 - mean)) };
    const order = [...examples];
    for (let epoch = 0; epoch < 35; epoch++) {
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const rate = 0.06 / (1 + epoch / 35);
      for (const e of order) {
        const p = neuralPrediction(model, e.features), error = p.mean - e.reward;
        const oldOutput = [...model.output];
        model.bias -= rate * error;
        for (let h = 0; h < HIDDEN; h++) {
          model.output[h] -= rate * (error * p.hidden[h] + 0.001 * model.output[h]);
          const delta = error * oldOutput[h] * (1 - p.hidden[h] * p.hidden[h]);
          for (let j = 0; j <= FEATURES; j++) model.hidden[h][j] -= rate * (delta * p.x[j] + 0.001 * model.hidden[h][j]);
        }
      }
    }
    return model;
  }

  function train(raw) {
    const examples = cleanExamples(raw);
    const key = JSON.stringify(examples);
    if (key === cachedKey) return cachedModel;
    const positive = examples.filter(e => e.reward >= 0.6).length;
    const negative = examples.filter(e => e.reward <= 0.25).length;
    if (examples.length < MIN_EXAMPLES || positive < 10 || negative < 10) return null;
    const bandit = trainBandit(examples);
    // Keep the newest fifth out of training for a chronological prediction check.
    // This is not an unbiased estimate of recommendation-policy improvement.
    const cut = Math.floor(examples.length * 0.8), fit = examples.slice(0, cut), holdout = examples.slice(cut);
    const neural = trainNeural(fit);
    const baselineMean = fit.reduce((n, e) => n + e.reward, 0) / fit.length;
    const brier = holdout.reduce((n, e) => n + (neuralPrediction(neural, e.features).mean - e.reward) ** 2, 0) / holdout.length;
    const baseline = holdout.reduce((n, e) => n + (baselineMean - e.reward) ** 2, 0) / holdout.length;
    const diverseHoldout = holdout.filter(e => e.reward >= 0.6).length >= 3 && holdout.filter(e => e.reward <= 0.25).length >= 3;
    cachedKey = key;
    cachedModel = { bandit, neural: diverseHoldout && Number.isFinite(brier) && brier + 0.002 < baseline ? neural : null,
      validation: { brier, baseline, count: holdout.length } };
    return cachedModel;
  }

  function score(model, rawFeatures, options = {}) {
    const features = normalizeFeatures(rawFeatures);
    if (!features || !model) return 0;
    let adjustment = 0;
    if (options.bandit === true && model.bandit) {
      const p = banditPrediction(model.bandit, features);
      adjustment += 0.12 * (p.mean - 0.5) + 0.08 * p.uncertainty;
    }
    if (options.neural === true && model.neural) adjustment += 0.12 * (neuralPrediction(model.neural, features).mean - 0.5);
    return Number.isFinite(adjustment) ? Math.max(-0.2, Math.min(0.2, adjustment)) : 0;
  }
  function clearCache() { cachedKey = null; cachedModel = null; }
  return { MIN_EXAMPLES, normalizeFeatures, cleanExamples, train, score, clearCache };
});

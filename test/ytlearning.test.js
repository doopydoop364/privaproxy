"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../public/js/ytlearning");
const R = require("../public/js/recommendations");

const features = good => [0.5, Number(good), 0.2, 0, 0, 0.3, 0, 1];
const examples = Array.from({ length: 160 }, (_, i) => ({ id: String(i).padStart(11, "0"), features: features(i % 2), reward: i % 2 }));

test("learning requires distinct, valid labeled videos with both positive and negative signals", () => {
  assert.equal(L.train(examples.slice(0, 99)), null);
  assert.equal(L.train(examples.map(e => ({ ...e, id: examples[0].id }))), null);
  assert.equal(L.train(examples.map(e => ({ ...e, reward: 1 }))), null);
  assert.equal(L.normalizeFeatures([Infinity, 0, 0, 0, 0, 0, 0, 0]), null);
  assert.equal(L.normalizeFeatures([1, 2]), null);
  assert.deepEqual(L.cleanExamples([null, { ...examples[0], reward: null }, { ...examples[0], id: "invalid" }]), []);
  assert.deepEqual(L.normalizeFeatures([-1, 2, 0, 0, 0, 0, 0, 0]), [0, 1, 0, 0, 0, 0, 0, 0]);
});

test("local bandit and neural predictions learn a predictive pattern and require opt-in", () => {
  const model = L.train(examples);
  assert.ok(model.bandit);
  assert.ok(model.neural, "the neural model beats its constant baseline on unseen examples");
  assert.ok(model.validation.brier < model.validation.baseline);
  assert.equal(L.score(model, features(true)), 0);
  for (const options of [{ bandit: true }, { neural: true }, { bandit: true, neural: true }]) {
    const good = L.score(model, features(true), options), bad = L.score(model, features(false), options);
    assert.ok(Number.isFinite(good) && Number.isFinite(bad));
    assert.ok(good > bad);
    assert.ok(Math.abs(good) <= 0.2 && Math.abs(bad) <= 0.2);
  }
  assert.equal(L.score(model, [NaN], { bandit: true }), 0);
  assert.equal(L.train(examples), model, "unchanged records reuse the trained model");
  L.clearCache();
  assert.notEqual(L.train(examples), model);
});

test("neural validation rejects an uninformative feature set", () => {
  const model = L.train(examples.map(e => ({ ...e, features: features(false) })));
  assert.ok(model.bandit);
  assert.equal(model.neural, null);
  assert.equal(L.score(model, features(true), { neural: true }), 0);
});

test("usage goals, real training data and opt-in independently gate local learning", () => {
  const stats = Object.fromEntries(examples.map(e => [e.id, { seconds: 40, duration: 60, impressions: 5 }]));
  const feedback = Object.fromEntries(examples.slice(0, 20).map(e => [e.id, { value: e.reward ? "more" : "less" }]));
  const state = { stats, feedback, examples: examples.map(e => ({ ...e, watchReward: e.reward })) };
  assert.equal(R.localLearningStatus(state).ready, true);
  assert.equal(R.localLearningStatus(state).active, false);
  assert.equal(R.localLearningStatus({ ...state, models: { bandit: true, neural: true } }).active, true);
  assert.equal(R.localLearningStatus({ ...state, stats: {}, models: { bandit: true } }).active, false);
  assert.equal(R.localLearningStatus({ ...state, examples: [], models: { bandit: true } }).active, false);
  assert.equal(R.localLearningStatus({}).ready, false);
});

test("visible impressions alone are unlabeled; actual watches and feedback supply rewards", () => {
  const e = examples[0], item = { id: e.id, channelId: "UC" + "a".repeat(22), recommendationFeatures: e.features };
  let state = R.recordImpression({}, e.id, Date.now(), e.features, item.channelId);
  assert.equal(R.trainingExamples(state).length, 0);
  state = R.recordWatch(state, e.id, 4, 60);
  assert.equal(R.trainingExamples(state).length, 0);
  state = R.recordWatch(state, e.id, 56, 60);
  assert.ok(R.trainingExamples(state)[0].reward > 0.6);
  state = R.setFeedback(state, item, "less");
  assert.equal(R.trainingExamples(state)[0].reward, 0);
  state = R.setFeedback(state, item, "more");
  assert.equal(R.trainingExamples(state)[0].reward, 1);
  state = R.setFeedback(state, item, "block");
  assert.equal(R.trainingExamples(state)[0].reward, 0);
});

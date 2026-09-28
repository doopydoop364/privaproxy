"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../public/js/recommendations");
const P = require("../public/js/ytpure");
const now = 1800000000000;
const ch = n => "UC" + String(n).padStart(22, "0");
const item = (n, title = "Space science planets", channel = n) => ({ id: String(n).padStart(11, "0"), title, channelId: ch(channel), duration: 120 });
const ids = items => items.map(i => i.id);

test("state validation bounds storage, discards invalid feedback and unsafe channel IDs", () => {
  const stats = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [item(i).id, { seconds: Infinity, duration: -2, impressions: 2 }]));
  const state = R.normalizeState({ stats, feedback: { bad: { value: "more" }, [item(1).id]: { value: "less", title: "x".repeat(1000), channelId: "bad" } }, blockedChannels: [ch(1), ch(1), "bad"] });
  assert.equal(Object.keys(state.stats).length, 400);
  assert.equal(state.stats[item(449).id].seconds, 0);
  assert.equal(state.stats[item(449).id].duration, 0);
  assert.equal(state.feedback[item(1).id].title.length, 200);
  assert.equal(state.feedback[item(1).id].channelId, "");
  assert.deepEqual(state.blockedChannels, [ch(1)]);
  assert.doesNotThrow(() => R.normalizeState({ stats: "corrupt", feedback: null, blockedChannels: {} }));
});

test("watch deltas count real playing time and reject seeks, stalls, gaps and pauses", () => {
  const start = { wall: 0, time: 10, rate: 1, playing: true };
  const next = changes => ({ wall: 1000, time: 11, rate: 1, playing: true, ...changes });
  assert.equal(R.watchedDelta(start, next()), 1);
  assert.equal(R.watchedDelta(start, next({ rate: 2, time: 12 })), 1);
  assert.equal(R.watchedDelta(start, next({ time: 70 })), 0);
  assert.equal(R.watchedDelta(start, next({ time: 5 })), 0);
  assert.equal(R.watchedDelta(start, next({ time: 10 })), 0);
  assert.equal(R.watchedDelta(start, next({ playing: false })), 0);
  assert.equal(R.watchedDelta(start, next({ wall: 6000, time: 16 })), 0);
  assert.equal(R.watchedDelta(null, next()), 0);
});

test("watch statistics separate elapsed time from content progress at faster playback", () => {
  const state = R.recordWatch({}, item(1).id, 60, 120, now, 120);
  assert.equal(state.stats[item(1).id].seconds, 60);
  assert.equal(state.stats[item(1).id].mediaSeconds, 120);
  assert.equal(R.normalizeState({ stats: { [item(2).id]: { seconds: 30 } } }).stats[item(2).id].mediaSeconds, 30);
});

test("MMR also considers the preceding page's last creators", () => {
  const a = item(2, "Space science", 1), b = item(3, "Space science", 2);
  assert.equal(R.rankComplex([{ items: [a, b] }], { previous: [item(1, "Earlier music video", 1)], now })[0].id, b.id);
});

test("seed selection blends satisfying watches and favourites, caps channels, and handles legacy history", () => {
  const history = [item(1, "Recent", 1), item(2, "Recent 2", 1), item(3, "Recent 3", 1), item(4, "Recent 4", 2),
    ...Array.from({ length: 10 }, (_, i) => item(i + 5)), item(20, "Older favourite", 20)];
  let state = R.recordWatch({}, item(20).id, 120, 120, now - 60 * 86400000);
  state = R.setFeedback(state, history[0], "less", now);
  const seeds = R.selectSeeds(history, state, now);
  assert.equal(seeds.length, 4);
  assert.ok(ids(seeds).includes(item(20).id));
  assert.ok(!ids(seeds).includes(item(1).id));
  assert.ok(seeds.filter(s => s.channelId === ch(1)).length <= 2);
  assert.equal(R.selectSeeds([], {}, now).length, 0);
  assert.equal(R.selectSeeds([item(1)], {}, now)[0].id, item(1).id);
  assert.equal(R.selectSeeds(history, {}, now, 1).length, 1);
});

test("title profiles support Unicode and decay old interests without discarding favourites", () => {
  const science = { ...item(1, "Space science planets"), watchedAt: now };
  const old = { ...item(2, "Cooking recipes pasta"), watchedAt: now - 365 * 86400000 };
  assert.match(R.topicQuery([science, old], {}, now), /space|science|planets/);
  assert.ok(!R.topicQuery([science, old], {}, now).includes("pasta"));
  assert.match(R.topicQuery([item(3, "宇宙 探索 विज्ञान")], {}, now), /宇宙|探索/);
  assert.equal(R.topicQuery([], {}, now), "");
});

test("search interests are bounded, deduplicated and decay back to watch topics", () => {
  let state = {};
  for (let i = 0; i < 25; i++) state = R.recordSearch(state, `Topic ${i}`, now);
  state = R.recordSearch(state, "  TOPIC 24  ", now);
  assert.equal(state.searches.length, 20);
  assert.equal(state.searches[0].query, "TOPIC 24");
  assert.equal(R.topicQuery([], state, now), "TOPIC 24");
  assert.match(R.topicQuery([item(1)], state, now + 15 * 86400000), /space|science|planets/);
  const recent = R.recordSearch({}, "astronomy telescopes", now);
  assert.equal(R.rankComplex([{ items: [item(2, "Cooking pasta"), item(3, "Astronomy telescopes")] }], { state: recent, now })[0].id, item(3).id);
});

test("subscription source selection follows affinity and excludes blocked creators", () => {
  const subs = [1, 2, 3].map(n => ({ id: ch(n) }));
  const history = [item(1, "Space", 3)];
  let state = R.recordWatch({}, item(1).id, 120, 120);
  assert.equal(R.selectSubscriptions(subs, history, state)[0].id, ch(3));
  state = R.setFeedback(state, history[0], "block");
  assert.deepEqual(R.selectSubscriptions(subs, history, state).map(s => s.id), [ch(1), ch(2)]);
});

test("fusion rewards consensus, de-duplicates each source, and filters watched/disliked/blocked videos", () => {
  const a = item(1), b = item(2), watched = item(3), disliked = item(4), blocked = item(5);
  const groups = [{ items: [a, b, watched, disliked, blocked] }, { items: [b] }];
  let state = R.setFeedback({}, disliked, "less", now);
  state = R.setFeedback(state, blocked, "block", now);
  const context = { history: [watched], state, now };
  assert.deepEqual(ids(R.rankComplex(groups, context)), [b.id, a.id]);
  assert.deepEqual(ids(R.rankComplex([{ items: [a, a] }, { items: [b] }], { now })), [a.id, b.id]);
  assert.deepEqual(ids(R.rankComplex(groups, context, new Set([b.id]))), [a.id]);
});

test("personal ranking uses topic affinity, subscriptions, saved videos, and impression fatigue", () => {
  const unrelated = item(2, "Cooking pasta"), match = item(3), history = [item(1)];
  let state = R.recordWatch({}, history[0].id, 120, 120, now);
  const groups = [{ seedId: history[0].id, items: [unrelated, match] }];
  assert.equal(R.rankComplex(groups, { history, state, now })[0].id, match.id);
  const a = item(4, "A"), b = item(5, "B");
  assert.equal(R.rankComplex([{ items: [a, b] }], { subscriptions: [{ id: b.channelId }], now })[0].id, b.id);
  assert.equal(R.rankComplex([{ items: [a, b] }], { saved: [b], now })[0].id, b.id);
  for (let i = 0; i < 10; i++) state = R.recordImpression(state, a.id, now);
  assert.equal(R.rankComplex([{ items: [a, b] }], { state, now })[0].id, b.id);
  assert.ok(R.rankComplex(groups, { history, state, now })[0].recommendationReason);
});

test("MMR spreads repetitive channels, and exploration includes unfamiliar creators", () => {
  const known = Array.from({ length: 10 }, (_, i) => item(i + 2, "Space planets science", 1));
  const discovery = item(20, "Astronomy telescopes", 2);
  const history = [item(1, "Space planets science", 1)];
  const ranked = R.rankComplex([{ items: [...known, discovery] }], { history, now });
  assert.ok(ids(ranked).indexOf(discovery.id) < 8);
  assert.equal(new Set(ids(ranked)).size, 11);
  assert.equal(R.rankComplex([{ items: [...known, discovery] }], { history, now, offset: 7 })[0].id, discovery.id);
});

test("future learned adapters require both explicit enablement and useful data, and cannot break Home", () => {
  const stats = {}, feedback = {};
  for (let i = 0; i < 100; i++) {
    stats[item(i).id] = { seconds: 40, duration: 60, impressions: 5 };
    if (i < 20) feedback[item(i).id] = { value: "more", title: "History" };
  }
  const state = { stats, feedback }, groups = [{ items: [item(150), item(151)] }];
  let calls = 0;
  const learnedRanker = () => { calls++; return { [item(151).id]: 1000 }; };
  assert.equal(R.learningStatus({}).ready, false);
  assert.equal(R.learningStatus(state).ready, true);
  assert.equal(R.learningStatus(state).active, false);
  R.rankComplex(groups, { learnedRanker, enableLearning: true, now });
  R.rankComplex(groups, { state, learnedRanker, now });
  assert.equal(calls, 0);
  assert.equal(R.rankComplex(groups, { state, learnedRanker, enableLearning: true, now })[0].id, item(151).id);
  assert.equal(calls, 1);
  assert.deepEqual(R.rankComplex(groups, { state, learnedRanker: () => { throw Error("broken"); }, enableLearning: true, now }), R.rankComplex(groups, { state, now }));
});

test("history import preserves validated channel and watch dates while old exports remain valid", () => {
  const date = Date.now() - 1000;
  const out = P.mergeHistory([], [{ ...item(1), watchedAt: date }, { ...item(2), channelId: "bad", watchedAt: Infinity }]);
  assert.equal(out[0].channelId, ch(1));
  assert.equal(out[0].watchedAt, date);
  assert.equal(out[1].channelId, undefined);
  assert.equal(out[1].watchedAt, undefined);
});

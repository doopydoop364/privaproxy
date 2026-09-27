"use strict";
const { AsyncLocalStorage } = require("async_hooks");

// Request cancellation is scoped through async calls, including nested feed lookups.
const scope = new AsyncLocalStorage();

function createWork(fn) {
  const controller = new AbortController();
  const work = { controller, consumers: 0, settled: false };
  work.promise = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return scope.run(controller.signal, fn);
  });
  work.promise.then(() => { work.settled = true; }, () => { work.settled = true; });
  return work;
}

// A cache entry may serve several requests. Disconnecting one subscriber must
// not kill the shared process while another subscriber still needs its result.
function subscribe(work, promise = work.promise) {
  const signal = scope.getStore();
  if (signal?.aborted) {
    if (!work.settled && work.consumers === 0) work.controller.abort();
    return Promise.reject(signal.reason);
  }
  work.consumers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", cancel);
      work.consumers--;
      if (!work.settled && work.consumers === 0) work.controller.abort();
      fn(value);
    };
    const cancel = () => finish(reject, signal.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    promise.then(value => finish(resolve, value), err => finish(reject, err));
  });
}

module.exports = { scope, createWork, subscribe };

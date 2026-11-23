import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, DEFAULTS } from '../content/store.js';

function fakeArea() {
  const data = {};
  return {
    data,
    async get(keys) { return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])); },
    async set(patch) { Object.assign(data, patch); },
  };
}

test('get returns defaults merged with saved values', async () => {
  const area = fakeArea();
  const store = createStore(area);
  assert.deepEqual(await store.get(), DEFAULTS);
  await store.set({ handle: 'alice', confirmed: true });
  assert.deepEqual(await store.get(), { ...DEFAULTS, handle: 'alice', confirmed: true });
});

test('reviewAsked defaults to false', () => {
  assert.equal(DEFAULTS.reviewAsked, false);
});

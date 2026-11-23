import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../content/runner.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeUnliker(entries, script = {}) {
  const queue = entries.map((e) => (typeof e === 'string' ? { id: e, reverted: false } : e));
  const u = {
    calls: [],
    restarted: 0,
    onRestart: () => {},
    async next() { return queue.shift() ?? null; },
    async unlike(item) {
      u.calls.push(item.id);
      const r = script[item.id];
      return typeof r === 'function' ? r(u.calls.length) : (r ?? 'ok');
    },
    requeued: [],
    requeue(item) { u.requeued.push(item.id); queue.unshift({ id: item.id, reverted: false }); },
    async restart() { u.restarted++; u.onRestart(queue); },
  };
  return u;
}

function harness(unliker, { neverWakeLongSleeps = false } = {}) {
  const clock = { t: 0 };
  const sleep = (ms) => {
    if (neverWakeLongSleeps && ms >= 60_000) return new Promise(() => {});
    clock.t += ms;
    return Promise.resolve();
  };
  const runner = createRunner({ unliker, sleep, now: () => clock.t, random: () => 0 });
  const statuses = [];
  runner.on((s) => statuses.push(s.status));
  return { runner, clock, statuses };
}

test('unlikes everything then finishes with endReason end', async () => {
  const u = fakeUnliker(['a', 'b', 'c']);
  const { runner } = harness(u);
  await runner.start();
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  assert.equal(runner.state.status, 'done');
  assert.equal(runner.state.endReason, 'end');
  assert.equal(runner.state.removed, 3);
});

test('respects the limit', async () => {
  const u = fakeUnliker(Array.from({ length: 20 }, (_, i) => String(i)));
  const { runner } = harness(u);
  await runner.start({ limit: 10 });
  assert.equal(runner.state.removed, 10);
  assert.equal(runner.state.endReason, 'limit');
  assert.equal(u.calls.length, 10);
});

test('limit counts from the starting removed total', async () => {
  const u = fakeUnliker(['a', 'b', 'c']);
  const { runner } = harness(u);
  await runner.start({ limit: 2, removed: 100 });
  assert.equal(runner.state.removed, 102);
});

test('failed results are counted separately', async () => {
  const u = fakeUnliker(['a', 'b', 'c'], { b: 'failed' });
  const { runner } = harness(u);
  await runner.start();
  assert.equal(runner.state.removed, 2);
  assert.equal(runner.state.failed, 1);
});

test('rate-limited requeues the item and backs off for 2 minutes', async () => {
  const u = fakeUnliker(['a', 'b', 'c'], { b: (n) => (n === 2 ? 'rate-limited' : 'ok') });
  const { runner, clock, statuses } = harness(u);
  await runner.start();
  assert.deepEqual(u.calls, ['a', 'b', 'b', 'c']);
  assert.equal(runner.state.removed, 3);
  assert.ok(statuses.includes('backing-off'));
  assert.ok(clock.t >= 120_000);
});

test('reverted items are subtracted; given-up items count as failed', async () => {
  const u = fakeUnliker(['a', 'b', { id: 'a', reverted: true }, { id: 'b', reverted: true, giveUp: true }]);
  const { runner } = harness(u);
  await runner.start();
  assert.deepEqual(u.calls, ['a', 'b', 'a']);
  assert.equal(runner.state.removed, 1);
  assert.equal(runner.state.failed, 1);
});

test('stop ends the run', async () => {
  let runner;
  const u = fakeUnliker(['a', 'b', 'c'], { b: () => { runner.stop(); return 'ok'; } });
  ({ runner } = harness(u));
  await runner.start();
  assert.deepEqual(u.calls, ['a', 'b']);
  assert.equal(runner.state.status, 'stopped');
  assert.equal(runner.state.removed, 2);
});

test('pause blocks until resume', async () => {
  let runner;
  const u = fakeUnliker(['a', 'b', 'c'], { a: () => { runner.pause('user'); return 'ok'; } });
  ({ runner } = harness(u));
  const done = runner.start();
  await tick();
  assert.equal(runner.state.status, 'paused');
  assert.equal(runner.state.pauseReason, 'user');
  assert.deepEqual(u.calls, ['a']);
  runner.resume();
  await done;
  assert.equal(runner.state.removed, 3);
});

test('resumeNow skips the back-off wait', async () => {
  const u = fakeUnliker(['a'], { a: (n) => (n === 1 ? 'rate-limited' : 'ok') });
  const { runner, clock } = harness(u, { neverWakeLongSleeps: true });
  const done = runner.start();
  await tick();
  assert.equal(runner.state.status, 'backing-off');
  assert.equal(runner.state.waitKind, 'backoff');
  assert.equal(runner.state.waitUntil, clock.t + 120_000);
  runner.resumeNow();
  await done;
  assert.equal(runner.state.removed, 1);
});

test('pausing during back-off does not skip the back-off', async () => {
  const u = fakeUnliker(['a'], { a: (n) => (n === 1 ? 'rate-limited' : 'ok') });
  const { runner } = harness(u, { neverWakeLongSleeps: true });
  runner.start();
  await tick();
  runner.pause('hidden');
  await tick();
  assert.equal(runner.state.status, 'paused');
  runner.resume();
  await tick();
  assert.equal(runner.state.status, 'backing-off');
  runner.stop();
});

test('a pause during next() discards its result and asks again', async () => {
  let runner;
  let nextCalls = 0;
  const u = fakeUnliker([]);
  u.next = async () => {
    nextCalls++;
    if (nextCalls === 1) { runner.pause('hidden'); return null; }
    return nextCalls === 2 ? { id: 'a', reverted: false } : null;
  };
  ({ runner } = harness(u));
  const done = runner.start();
  await tick();
  assert.equal(runner.state.status, 'paused');
  runner.resume();
  await done;
  assert.deepEqual(u.calls, ['a']);
  assert.equal(runner.state.endReason, 'end');
});

test('selector breakage ends in an error state', async () => {
  const u = fakeUnliker([]);
  u.next = async () => { const e = new Error('x'); e.name = 'SelectorsBrokenError'; throw e; };
  const { runner } = harness(u);
  await runner.start();
  assert.equal(runner.state.status, 'error');
  assert.equal(runner.state.error, 'selectors');
});

test('unexpected errors end in an error state', async () => {
  const u = fakeUnliker([]);
  u.next = async () => { throw new TypeError('boom'); };
  const { runner } = harness(u);
  await runner.start();
  assert.equal(runner.state.error, 'unexpected');
});

test('retry restarts the unliker and keeps the removed total', async () => {
  const u = fakeUnliker(['a', 'b', 'c'], { b: (n) => (n === 2 ? 'failed' : 'ok') });
  u.onRestart = (queue) => queue.push({ id: 'b', reverted: false });
  const { runner } = harness(u);
  await runner.start();
  assert.equal(runner.state.failed, 1);
  await runner.retry();
  assert.equal(u.restarted, 1);
  assert.equal(runner.state.removed, 3);
  assert.equal(runner.state.failed, 0);
});

test('start is ignored while a run is active', async () => {
  let runner;
  const u = fakeUnliker(['a', 'b'], { a: () => { runner.pause('user'); return 'ok'; } });
  ({ runner } = harness(u));
  const done = runner.start();
  await tick();
  await runner.start({ limit: 1 });
  assert.equal(runner.state.limit, Infinity);
  runner.resume();
  await done;
});

test('a stopped run does not interfere after a new run starts', async () => {
  let release;
  let runner;
  const u = fakeUnliker(['a', 'b', 'c'], { b: () => { runner.pause('user'); return 'ok'; } });
  const original = u.unlike;
  u.unlike = (item) => (item.id === 'a'
    ? new Promise((resolve) => { u.calls.push('a'); release = resolve; })
    : original(item));
  ({ runner } = harness(u));
  runner.start();
  await tick();
  runner.stop();
  const second = runner.start();
  await tick();
  release('ok');
  await tick();
  runner.resume();
  await Promise.race([
    second,
    new Promise((_, reject) => setTimeout(() => reject(new Error('second run stranded')), 500)),
  ]);
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  assert.equal(runner.state.removed, 3);
  assert.equal(runner.state.status, 'done');
});

test('a CancelledError from the unliker leaves the state unchanged', async () => {
  const u = fakeUnliker([]);
  u.next = async () => { const e = new Error('c'); e.name = 'CancelledError'; throw e; };
  const { runner } = harness(u);
  await runner.start();
  assert.equal(runner.state.status, 'running');
  assert.equal(runner.state.error, null);
});

test('an item fetched while stop lands is requeued', async () => {
  let runner;
  const u = fakeUnliker([]);
  u.next = async () => { runner.stop(); return { id: 'a', reverted: false }; };
  ({ runner } = harness(u));
  await runner.start();
  assert.deepEqual(u.requeued, ['a']);
  assert.deepEqual(u.calls, []);
});

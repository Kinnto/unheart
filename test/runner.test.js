import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../content/runner.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeUnliker(entries, script = {}) {
  const queue = entries.map((e) => (typeof e === 'string' ? { id: e, reverted: false } : e));
  const u = {
    queue,
    calls: [],
    restarted: 0,
    onRestart: () => {},
    async next() { return queue.shift() ?? null; },
    async click(item) {
      u.calls.push(item.id);
      return 'clicked';
    },
    async verify(item) {
      const r = script[item.id];
      return typeof r === 'function' ? r(u.calls.length) : (r ?? 'ok');
    },
    requeued: [],
    requeue(item) { u.requeued.push(item.id); queue.unshift({ id: item.id, reverted: false }); },
    async restart() { u.restarted++; u.onRestart(queue); },
  };
  return u;
}

// Verifications for the given ids stay pending until resolve(id, result).
function manualVerify(u, ids) {
  const waiting = new Map();
  const auto = u.verify;
  u.verify = (item) => (ids.includes(item.id) && !waiting.has(item.id)
    ? new Promise((resolve) => waiting.set(item.id, resolve))
    : auto(item));
  return {
    pending: () => [...waiting.keys()],
    resolve(id, result) {
      const resolve = waiting.get(id);
      assert.ok(resolve, `no pending verification for ${id}`);
      waiting.delete(id);
      ids = ids.filter((x) => x !== id);
      resolve(result);
    },
  };
}

function harness(unliker, { neverWakeLongSleeps = false } = {}) {
  const clock = { t: 0 };
  const sleep = (ms) => {
    if (neverWakeLongSleeps && ms >= 30_000) return new Promise(() => {});
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
  const { runner, clock } = harness(u);
  await runner.start();
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  assert.equal(runner.state.status, 'done');
  assert.equal(runner.state.endReason, 'end');
  assert.equal(runner.state.removed, 3);
  assert.equal(runner.state.slowdowns, 0);
  assert.equal(runner.state.finishedAt, clock.t);
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

test('rate-limited requeues the item and backs off for 30 seconds', async () => {
  const u = fakeUnliker(['a', 'b', 'c'], { b: (n) => (n === 2 ? 'rate-limited' : 'ok') });
  const { runner, clock, statuses } = harness(u);
  await runner.start();
  assert.deepEqual(u.calls, ['a', 'b', 'b', 'c']);
  assert.equal(runner.state.removed, 3);
  assert.ok(statuses.includes('backing-off'));
  assert.ok(clock.t >= 30_000);
  assert.equal(runner.state.slowdowns, 1);
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
  assert.equal(runner.state.waitUntil, clock.t + 30_000);
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
  const u = fakeUnliker(['a']);
  const verifies = manualVerify(u, ['a']);
  const { runner } = harness(u);
  const first = runner.start();
  await tick();
  assert.deepEqual(u.calls, ['a']);
  runner.stop();
  u.queue.push({ id: 'b', reverted: false }, { id: 'c', reverted: false });
  const second = runner.start();
  await second;
  assert.equal(runner.state.status, 'done');
  verifies.resolve('a', 'ok');
  await first;
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

test('loadLimited from next() backs off like a rate limit, then the run completes', async () => {
  const u = fakeUnliker(['a', 'b']);
  const items = [{ loadLimited: true }, { id: 'a', reverted: false }, { id: 'b', reverted: false }];
  u.next = async () => items.shift() ?? null;
  const { runner, clock, statuses } = harness(u);
  await runner.start();
  assert.ok(statuses.includes('backing-off'));
  assert.ok(clock.t >= 30_000);
  assert.equal(runner.state.slowdowns, 1);
  assert.deepEqual(u.calls, ['a', 'b']);
  assert.equal(runner.state.removed, 2);
  assert.equal(runner.state.status, 'done');
});

test('pacing memory survives stop and start: a second limit soon after is a 2 minute back-off', async () => {
  const u = fakeUnliker(['a'], { a: () => 'rate-limited' });
  const { runner, clock } = harness(u, { neverWakeLongSleeps: true });
  runner.start();
  await tick();
  assert.equal(runner.state.waitUntil - clock.t, 30_000);
  runner.stop();
  await tick();
  runner.start();
  await tick();
  assert.equal(runner.state.status, 'backing-off');
  assert.equal(runner.state.waitUntil - clock.t, 120_000);
  runner.stop();
});

test('a loadLimited marker is never requeued when the run is stopped', async () => {
  let runner;
  const u = fakeUnliker([]);
  u.next = async () => { runner.stop(); return { loadLimited: true }; };
  ({ runner } = harness(u));
  await runner.start();
  assert.deepEqual(u.requeued, [undefined].slice(1));
});

test('pipelining: the next heart is clicked before the previous verification settles', async () => {
  const u = fakeUnliker(['a', 'b']);
  const verifies = manualVerify(u, ['a', 'b']);
  const { runner } = harness(u);
  const done = runner.start();
  await tick();
  assert.deepEqual(u.calls, ['a', 'b']);
  assert.deepEqual(verifies.pending(), ['a', 'b']);
  assert.equal(runner.state.removed, 0);
  verifies.resolve('a', 'ok');
  verifies.resolve('b', 'ok');
  await done;
  assert.equal(runner.state.removed, 2);
});

test('at most 3 verifications are in flight; a settled one makes room for the next click', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const u = fakeUnliker(ids);
  const verifies = manualVerify(u, ids);
  const { runner } = harness(u);
  const done = runner.start();
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  verifies.resolve('b', 'ok');
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c', 'd']);
  assert.equal(runner.state.removed, 1);
  for (const id of ['a', 'c', 'd']) verifies.resolve(id, 'ok');
  await tick();
  verifies.resolve('e', 'ok');
  await done;
  assert.equal(runner.state.removed, 5);
  assert.equal(runner.state.status, 'done');
});

test('a rate-limited verification stops clicking, drains the rest, then backs off', async () => {
  const ids = ['a', 'b', 'c', 'd'];
  const u = fakeUnliker(ids);
  const verifies = manualVerify(u, ids);
  const { runner } = harness(u, { neverWakeLongSleeps: true });
  const done = runner.start();
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  verifies.resolve('b', 'rate-limited');
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c'], 'no click after a rate limit');
  assert.equal(runner.state.status, 'running', 'drains before backing off');
  verifies.resolve('a', 'ok');
  await tick();
  assert.equal(runner.state.status, 'running');
  verifies.resolve('c', 'failed');
  await tick();
  assert.equal(runner.state.status, 'backing-off');
  assert.equal(runner.state.removed, 1);
  assert.equal(runner.state.failed, 1);
  assert.equal(runner.state.slowdowns, 1);
  assert.deepEqual(u.requeued, ['b']);
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  runner.resumeNow();
  await tick();
  verifies.resolve('d', 'ok');
  await done;
  assert.deepEqual(u.calls, ['a', 'b', 'c', 'b', 'd']);
  assert.equal(runner.state.removed, 3);
});

test('two rate limits in the same drain take a single short back-off', async () => {
  const u = fakeUnliker(['a', 'b', 'c']);
  const verifies = manualVerify(u, ['a', 'b', 'c']);
  const { runner, clock } = harness(u, { neverWakeLongSleeps: true });
  runner.start();
  await tick();
  verifies.resolve('a', 'rate-limited');
  verifies.resolve('b', 'rate-limited');
  verifies.resolve('c', 'ok');
  await tick();
  assert.equal(runner.state.status, 'backing-off');
  assert.equal(runner.state.waitUntil - clock.t, 30_000);
  assert.equal(runner.state.slowdowns, 1);
  runner.stop();
});

test('the limit counts in-flight unlikes: never over-clicks, refills after a failure', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const u = fakeUnliker(ids);
  const verifies = manualVerify(u, ids);
  const { runner } = harness(u);
  const done = runner.start({ limit: 2 });
  await tick();
  assert.deepEqual(u.calls, ['a', 'b']);
  verifies.resolve('a', 'failed');
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  verifies.resolve('b', 'ok');
  await tick();
  assert.equal(runner.state.status, 'running', 'waits for c before finishing');
  verifies.resolve('c', 'ok');
  await done;
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  assert.equal(runner.state.removed, 2);
  assert.equal(runner.state.endReason, 'limit');
});

test('stop with pending verifications: their ok still counts, nothing else happens', async () => {
  const ids = ['a', 'b', 'c', 'd'];
  const u = fakeUnliker(ids);
  const verifies = manualVerify(u, ids);
  const { runner, statuses } = harness(u);
  const done = runner.start();
  await tick();
  runner.stop();
  verifies.resolve('a', 'ok');
  verifies.resolve('b', 'rate-limited');
  verifies.resolve('c', 'ok');
  await done;
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  assert.equal(runner.state.status, 'stopped');
  assert.equal(runner.state.removed, 2);
  assert.equal(runner.state.slowdowns, 0);
  assert.ok(!statuses.includes('backing-off'));
});

test('pause with pending verifications: counts update while paused, no new clicks until resume', async () => {
  const ids = ['a', 'b', 'c', 'd'];
  const u = fakeUnliker(ids);
  const verifies = manualVerify(u, ids);
  const { runner } = harness(u);
  const done = runner.start();
  await tick();
  runner.pause('hidden');
  verifies.resolve('a', 'ok');
  verifies.resolve('b', 'ok');
  await tick();
  assert.equal(runner.state.status, 'paused');
  assert.equal(runner.state.removed, 2);
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  runner.resume();
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c', 'd']);
  verifies.resolve('c', 'ok');
  verifies.resolve('d', 'ok');
  await done;
  assert.equal(runner.state.removed, 4);
});

test('the run finishes only after every pending verification has settled', async () => {
  const u = fakeUnliker(['a', 'b']);
  const verifies = manualVerify(u, ['a', 'b']);
  const { runner } = harness(u);
  let finished = false;
  const done = runner.start().then(() => { finished = true; });
  await tick();
  verifies.resolve('a', 'ok');
  await tick();
  assert.equal(runner.state.status, 'running');
  assert.equal(finished, false);
  verifies.resolve('b', 'ok');
  await done;
  assert.equal(runner.state.status, 'done');
  assert.equal(runner.state.removed, 2);
});

test('a heart that vanished before the click counts as failed without verifying', async () => {
  const u = fakeUnliker(['a', 'b']);
  u.click = async (item) => { u.calls.push(item.id); return item.id === 'a' ? 'failed' : 'clicked'; };
  const verified = [];
  const verify = u.verify;
  u.verify = (item) => { verified.push(item.id); return verify(item); };
  const { runner } = harness(u);
  await runner.start();
  assert.deepEqual(verified, ['b']);
  assert.equal(runner.state.failed, 1);
  assert.equal(runner.state.removed, 1);
});

test('a CancelledError from click stops clicking; a pending ok still counts', async () => {
  const u = fakeUnliker(['a', 'b']);
  const verifies = manualVerify(u, ['a']);
  const click = u.click;
  u.click = async (item) => {
    if (item.id === 'b') { const e = new Error('c'); e.name = 'CancelledError'; throw e; }
    return click(item);
  };
  const { runner } = harness(u);
  const done = runner.start();
  await tick();
  verifies.resolve('a', 'ok');
  await done;
  await tick();
  assert.deepEqual(u.calls, ['a']);
  assert.equal(runner.state.removed, 1);
  assert.equal(runner.state.error, null);
});

test('a new run resets slowdowns and finishedAt', async () => {
  const u = fakeUnliker(['a'], { a: (n) => (n === 1 ? 'rate-limited' : 'ok') });
  const { runner } = harness(u);
  await runner.start();
  assert.equal(runner.state.slowdowns, 1);
  u.queue.push({ id: 'z', reverted: false });
  const states = [];
  runner.on((s) => states.push({ slowdowns: s.slowdowns, finishedAt: s.finishedAt }));
  await runner.start();
  assert.deepEqual(states[0], { slowdowns: 0, finishedAt: null });
});

test('repeated limits with oks in between climb the ladder: 30 s, 2 min, 4 min', async () => {
  let aTries = 0;
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const u = fakeUnliker(ids, { a: () => (++aTries <= 3 ? 'rate-limited' : 'ok') });
  const { runner, clock } = harness(u, { neverWakeLongSleeps: true });
  const done = runner.start();
  const waits = [];
  for (let i = 0; i < 3; i++) {
    await tick();
    assert.equal(runner.state.status, 'backing-off');
    waits.push(runner.state.waitUntil - clock.t);
    runner.resumeNow();
  }
  await done;
  assert.deepEqual(waits, [30_000, 120_000, 240_000]);
  assert.equal(runner.state.slowdowns, 3);
  assert.equal(runner.state.removed, ids.length);
});

test('with a verification pending and no visible post, it drains before a scrolling next()', async () => {
  const u = fakeUnliker([]);
  const verifies = manualVerify(u, ['a']);
  const log = [];
  let served = false;
  u.next = async ({ allowScroll } = {}) => {
    log.push({ allowScroll, pending: verifies.pending().length });
    if (!served) { served = true; return { id: 'a', reverted: false }; }
    return allowScroll ? null : { needsScroll: true };
  };
  const { runner } = harness(u);
  const done = runner.start();
  await tick();
  assert.deepEqual(log, [{ allowScroll: true, pending: 0 }, { allowScroll: false, pending: 1 }]);
  assert.equal(runner.state.status, 'running');
  verifies.resolve('a', 'ok');
  await done;
  assert.deepEqual(log[2], { allowScroll: true, pending: 0 });
  assert.deepEqual(u.calls, ['a']);
  assert.deepEqual(u.requeued, []);
  assert.equal(runner.state.removed, 1);
  assert.equal(runner.state.endReason, 'end');
});

test("a stopped run's late ok counts in the total but not toward the next run's limit", async () => {
  const u = fakeUnliker(['a']);
  const verifies = manualVerify(u, ['a', 'b', 'c']);
  const { runner } = harness(u);
  const first = runner.start();
  await tick();
  runner.stop();
  u.queue.push(...['b', 'c', 'd'].map((id) => ({ id, reverted: false })));
  const second = runner.start({ limit: 2 });
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c']);
  verifies.resolve('a', 'ok');
  await first;
  verifies.resolve('b', 'failed');
  await tick();
  assert.deepEqual(u.calls, ['a', 'b', 'c', 'd'], 'the failure leaves room for one more');
  verifies.resolve('c', 'ok');
  await second;
  assert.equal(runner.state.endReason, 'limit');
  assert.equal(runner.state.removed, 3);
  assert.equal(runner.state.removed - runner.state.removedAtStart, 2);
});

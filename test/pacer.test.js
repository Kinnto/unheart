import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPacer, onClick, onResult, onLimit, onLoadError, nextWait, waited, limitDue,
  START, FLOOR, CEILING, COURTESY_EVERY, COURTESY_PAUSE_MS, BACKOFF_START_MS, BACKOFF_MAX_MS,
} from '../content/pacer.js';

const MIN = 60_000;

const apply = (state, result, times, now = 0) => {
  for (let i = 0; i < times; i++) state = onResult(state, result, now);
  return state;
};

// Clicks every `every` ms from `from` to `to` (exclusive).
const clicks = (s, from, to, every) => {
  for (let t = from; t < to; t += every) s = onClick(s, t);
  return s;
};

const backoff = (s) => {
  const wait = nextWait(s, () => 0);
  assert.equal(wait.kind, 'backoff');
  return { s: waited(s), ms: wait.ms };
};

const mean = (s) => (s.min + s.max) / 2;

test('starts in the 0.3–0.6 s start range and waits within it', () => {
  const s = createPacer();
  assert.deepEqual({ ...START }, { min: 300, max: 600 });
  assert.equal(nextWait(s, () => 0).ms, 300);
  assert.equal(nextWait(s, () => 1).ms, 600);
  assert.equal(nextWait(s, () => 0).kind, 'pace');
});

test('before any limit, speeds up by 10% after every 10 consecutive ok', () => {
  const s = apply(createPacer(), 'ok', 10);
  assert.equal(s.min, 270);
  assert.equal(s.max, 540);
  assert.equal(apply(createPacer(), 'ok', 9).min, START.min);
});

test('never goes below the 0.15–0.3 s floor', () => {
  const s = apply(createPacer(), 'ok', 1000);
  assert.deepEqual({ ...FLOOR }, { min: 150, max: 300 });
  assert.equal(s.min, FLOOR.min);
  assert.equal(s.max, FLOOR.max);
});

test('failed widens the range by 30% and resets the streak, capped at the ceiling', () => {
  const once = onResult(apply(createPacer(), 'ok', 5), 'failed');
  assert.equal(once.min, 390);
  assert.equal(once.max, 780);
  assert.equal(once.streak, 0);
  const many = apply(createPacer(), 'failed', 20);
  assert.equal(many.min, CEILING.min);
  assert.equal(many.max, CEILING.max);
});

test('an isolated rejection is soft: no back-off, pace widened ×1.5, streak reset', () => {
  const s = onResult(apply(createPacer(), 'ok', 5), 'rate-limited', 0);
  assert.equal(limitDue(s), false);
  assert.equal(nextWait(s, () => 0).kind, 'pace');
  assert.equal(s.min, 450);
  assert.equal(s.max, 900);
  assert.equal(s.streak, 0);
});

test('a soft slowdown is temporary: 10 consecutive oks restore the pace from before the glitch', () => {
  let s = apply(createPacer(), 'ok', 5);
  const before = { min: s.min, max: s.max };
  s = onResult(s, 'rate-limited', 0);
  s = onResult(s, 'rate-limited', 0);
  assert.equal(s.min, Math.round(before.min * 2.25));
  s = apply(s, 'ok', 9);
  assert.ok(s.min > before.min);
  s = onResult(s, 'ok', 0);
  assert.deepEqual({ min: s.min, max: s.max }, before);
});

test('isolated 3% rejections do not ratchet the pace up, even after a limit', () => {
  for (const afterLimit of [false, true]) {
    let s = createPacer();
    if (afterLimit) s = waited(onLimit(s, 0));
    const start = { min: s.min, max: s.max };
    for (let i = 0; i < 330; i++) s = onResult(s, i % 33 === 32 ? 'rate-limited' : 'ok', 0);
    s = apply(s, 'ok', 10);
    assert.ok(s.max <= start.max, `afterLimit=${afterLimit}: ${s.min}-${s.max} vs ${start.min}-${start.max}`);
  }
});

test('a limit drops any pending soft-slowdown restore', () => {
  let s = clicks(createPacer(), 0, 30_000, 1000);
  s = onResult(s, 'rate-limited', 30_000);
  s = backoff(onLimit(s, 30_000)).s;
  const limited = { min: s.min, max: s.max };
  s = apply(s, 'ok', 10);
  assert.deepEqual({ min: s.min, max: s.max }, limited);
});

test('two rejections in the last 10 outcomes are soft; a third is a limit with a 60 s back-off', () => {
  let s = apply(createPacer(), 'ok', 20);
  s = onResult(s, 'rate-limited', 0);
  s = apply(s, 'ok', 3);
  s = onResult(s, 'rate-limited', 0);
  s = apply(s, 'ok', 3);
  assert.equal(limitDue(s), false);
  s = onResult(s, 'rate-limited', 0);
  assert.equal(limitDue(s), true);
  assert.equal(BACKOFF_START_MS, 60_000);
  assert.deepEqual(nextWait(s, () => 0), { ms: 60_000, kind: 'backoff' });
});

test('rejections more than 10 outcomes apart never add up to a limit', () => {
  let s = createPacer();
  for (let i = 0; i < 20; i++) {
    s = onResult(s, 'rate-limited', 0);
    s = apply(s, 'ok', 9);
    assert.equal(limitDue(s), false, `round ${i}`);
  }
});

test('onLimit (timeline load error) forces a 60 s back-off', () => {
  const s = onLimit(createPacer(), 0);
  assert.equal(limitDue(s), true);
  assert.deepEqual(nextWait(s, () => 0), { ms: 60_000, kind: 'backoff' });
  assert.equal(limitDue(waited(s)), false);
  assert.equal(nextWait(waited(s), () => 0).kind, 'pace');
});

test('after a limit the pace is set to half the click rate seen in the last 30 s', () => {
  let s = clicks(createPacer(), 0, 60_000, 400);
  s = onLimit(s, 60_000);
  assert.equal(mean(s), 800);
  assert.ok(s.min < s.max);
});

test('the post-limit pace is never faster than the start range', () => {
  let s = clicks(createPacer(), 0, 30_000, 100);
  s = onLimit(s, 30_000);
  assert.ok(s.min >= START.min && s.max >= START.max, `${s.min}-${s.max}`);
});

test('without recent clicks a limit keeps the pace but not faster than start', () => {
  const fast = apply(createPacer(), 'ok', 1000);
  const s = onLimit(fast, 0);
  assert.equal(s.min, START.min);
  assert.equal(s.max, START.max);
});

test('after a limit, speed-up is gentle: ×0.95 every 20 consecutive ok', () => {
  let s = clicks(createPacer(), 0, 30_000, 500);
  s = backoff(onLimit(s, 30_000)).s;
  const before = { min: s.min, max: s.max };
  s = apply(s, 'ok', 19);
  assert.deepEqual({ min: s.min, max: s.max }, before);
  s = onResult(s, 'ok', 0);
  assert.equal(s.min, Math.round(before.min * 0.95));
  assert.equal(s.max, Math.round(before.max * 0.95));
  assert.equal(apply(s, 'ok', 10_000).min, FLOOR.min);
});

test('a rejected first verification after a back-off is a limit, and W doubles', () => {
  let { s, ms } = backoff(onLimit(createPacer(), 0));
  assert.equal(ms, 60_000);
  s = onResult(s, 'rate-limited', 61_000);
  assert.equal(limitDue(s), true);
  ({ s, ms } = backoff(s));
  assert.equal(ms, 120_000);
});

test('a rejection after the first verification post-back-off is soft again', () => {
  let { s } = backoff(onLimit(createPacer(), 0));
  s = onResult(s, 'ok', 0);
  s = onResult(s, 'rate-limited', 0);
  assert.equal(limitDue(s), false);
});

test('a limit before 10 oks since the last back-off doubles W, up to 15 min', () => {
  let s = createPacer();
  const waits = [];
  for (let i = 0; i < 7; i++) {
    const r = backoff(onLimit(s, 0));
    waits.push(r.ms);
    s = apply(r.s, 'ok', 5);
  }
  assert.equal(BACKOFF_MAX_MS, 15 * MIN);
  assert.deepEqual(waits, [1, 2, 4, 8, 15, 15, 15].map((m) => m * MIN));
});

test('10 oks after a back-off reset W to 60 s', () => {
  let s = backoff(onLimit(createPacer(), 0)).s;
  s = backoff(onLimit(apply(s, 'ok', 3), 0)).s;
  s = backoff(onLimit(apply(s, 'ok', 3), 0)).s; // W is now 4 min
  s = apply(s, 'ok', 10);
  assert.equal(backoff(onLimit(s, 0)).ms, 60_000);
});

test('results while a back-off is already due (the drain) do not escalate it', () => {
  let s = onLimit(createPacer(), 0);
  s = apply(s, 'rate-limited', 5);
  assert.deepEqual(nextWait(s, () => 0), { ms: 60_000, kind: 'backoff' });
});

test('the back-off resets the rejection window', () => {
  let s = apply(createPacer(), 'rate-limited', 3);
  s = backoff(s).s;
  s = onResult(s, 'ok', 0);
  s = apply(s, 'rate-limited', 2);
  assert.equal(limitDue(s), false);
});

test('takes a 30 s courtesy pause after every 500 ok, once, without hiding a due back-off', () => {
  assert.equal(COURTESY_EVERY, 500);
  assert.equal(COURTESY_PAUSE_MS, 30_000);
  assert.equal(nextWait(apply(createPacer(), 'ok', 499), () => 0).kind, 'pace');
  const s = apply(createPacer(), 'ok', 500);
  assert.deepEqual(nextWait(s, () => 0), { ms: 30_000, kind: 'courtesy' });
  assert.equal(nextWait(waited(s), () => 0).kind, 'pace');
  assert.equal(nextWait(onResult(s, 'ok'), () => 0).kind, 'courtesy', 'a due courtesy pause survives a later ok');
  const limited = onResult(onLimit(apply(createPacer(), 'ok', 499), 0), 'ok', 0);
  assert.equal(nextWait(limited, () => 0).kind, 'backoff');
});

test("'uncertain' (a toast someone else claimed) changes nothing", () => {
  const s = onResult(apply(createPacer(), 'rate-limited', 2), 'ok', 0);
  assert.deepEqual(onResult(s, 'uncertain', 0), s);
});

test('a single timeline load error is a glitch; a second before any ok is a limit', () => {
  let s = onLoadError(apply(createPacer(), 'ok', 5), 0);
  assert.equal(limitDue(s), false);
  assert.deepEqual({ min: s.min, max: s.max }, { min: START.min, max: START.max });
  assert.equal(limitDue(onLoadError(s, 0)), true);
  s = onResult(s, 'ok', 0);
  assert.equal(limitDue(onLoadError(s, 0)), false, 'an ok in between makes it isolated again');
});

test('load errors stay out of the rejection window', () => {
  let s = apply(createPacer(), 'rate-limited', 2);
  s = onLoadError(s, 0);
  assert.equal(limitDue(s), false);
});

test('a load error as the first event after a back-off is a limit, and W doubles', () => {
  const { s } = backoff(onLimit(createPacer(), 0));
  const again = onLoadError(s, 0);
  assert.equal(limitDue(again), true);
  assert.equal(nextWait(again, () => 0).ms, 120_000);
});

test('rejects unknown results', () => {
  assert.throws(() => onResult(createPacer(), 'weird'), /Unknown result/);
});

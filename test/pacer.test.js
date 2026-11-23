import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPacer, onResult, nextWait, waited, START, FLOOR, CEILING, COURTESY_EVERY, COURTESY_PAUSE_MS, SHORT_BACKOFF_MS,
} from '../content/pacer.js';

const MIN = 60_000;

const apply = (state, result, times, now = 0) => {
  for (let i = 0; i < times; i++) state = onResult(state, result, now);
  return state;
};

const limitAt = (s, now) => {
  s = onResult(s, 'rate-limited', now);
  const wait = nextWait(s, () => 0);
  return { s: waited(s), wait };
};

test('starts in the 0.6–1.1 s start range and waits within it', () => {
  const s = createPacer();
  assert.deepEqual({ ...START }, { min: 600, max: 1100 });
  assert.equal(nextWait(s, () => 0).ms, 600);
  assert.equal(nextWait(s, () => 1).ms, 1100);
  assert.equal(nextWait(s, () => 0).kind, 'pace');
});

test('speeds up by 10% after every 10 consecutive ok', () => {
  const s = apply(createPacer(), 'ok', 10);
  assert.equal(s.min, 540);
  assert.equal(s.max, 990);
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
  assert.equal(once.min, 780);
  assert.equal(once.max, 1430);
  assert.equal(once.streak, 0);
  const many = apply(createPacer(), 'failed', 20);
  assert.equal(many.min, CEILING.min);
  assert.equal(many.max, CEILING.max);
});

test('a first rate limit takes a short 30 s back-off', () => {
  const { wait } = limitAt(createPacer(), 0);
  assert.equal(SHORT_BACKOFF_MS, 30_000);
  assert.deepEqual(wait, { ms: 30_000, kind: 'backoff' });
});

test('rate limits close together escalate 30 s, 2, 4, 8, 16, 30, 30 min; a lone one later is short again', () => {
  let s = createPacer();
  const waits = [];
  let t = 0;
  for (let i = 0; i < 7; i++) {
    const r = limitAt(s, t);
    s = r.s;
    waits.push(r.wait.ms);
    t += 4 * MIN;
  }
  assert.deepEqual(waits, [30_000, 2 * MIN, 4 * MIN, 8 * MIN, 16 * MIN, 30 * MIN, 30 * MIN]);
  const lastAt = t - 4 * MIN;
  assert.equal(limitAt(s, lastAt + 6 * MIN).wait.ms, 30_000);
});

test('sequence: first limit 30 s, second within 5 min 2 min, third within 5 min 4 min, one 6 min later 30 s', () => {
  let s = createPacer();
  const seq = [];
  for (const t of [0, 1 * MIN, 4 * MIN, 10 * MIN]) {
    const r = limitAt(s, t);
    s = r.s;
    seq.push(r.wait.ms);
  }
  assert.deepEqual(seq, [30_000, 2 * MIN, 4 * MIN, 30_000]);
});

test('an ok between close limits resets the ladder level but a close limit is still long', () => {
  let s = limitAt(createPacer(), 0).s;
  s = limitAt(s, 1 * MIN).s;
  s = onResult(s, 'ok', 2 * MIN);
  assert.equal(s.backoffLevel, 0);
  assert.equal(limitAt(s, 3 * MIN).wait.ms, 2 * MIN);
});

test('a rate limit halves the speed (doubles the range), at least the start range', () => {
  const fast = apply(createPacer(), 'ok', 1000);
  const slowed = onResult(fast, 'rate-limited', 0);
  assert.equal(slowed.min, START.min);
  assert.equal(slowed.max, START.max);
  const twice = onResult(slowed, 'rate-limited', 1000);
  assert.equal(twice.min, 1200);
  assert.equal(twice.max, 2200);
  assert.equal(apply(createPacer(), 'rate-limited', 20, 0).max, CEILING.max);
});

test('the back-off wait is only returned once; after waited() pacing resumes', () => {
  const s = onResult(createPacer(), 'rate-limited', 0);
  assert.equal(nextWait(s, () => 0).kind, 'backoff');
  assert.equal(nextWait(waited(s), () => 0).kind, 'pace');
});

test('takes a 30 s courtesy pause after every 500 ok, once', () => {
  assert.equal(COURTESY_EVERY, 500);
  assert.equal(COURTESY_PAUSE_MS, 30_000);
  assert.equal(nextWait(apply(createPacer(), 'ok', 499), () => 0).kind, 'pace');
  const s = apply(createPacer(), 'ok', 500);
  assert.deepEqual(nextWait(s, () => 0), { ms: 30_000, kind: 'courtesy' });
  assert.equal(nextWait(waited(s), () => 0).kind, 'pace');
  assert.equal(nextWait(onResult(s, 'ok'), () => 0).kind, 'courtesy', 'a due courtesy pause survives a later ok');
});

test('rejects unknown results', () => {
  assert.throws(() => onResult(createPacer(), 'weird'), /Unknown result/);
});

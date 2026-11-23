import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPacer, onResult, nextWait, waited, backoffEnded, START, FLOOR, CEILING, COURTESY_EVERY, COURTESY_PAUSE_MS, SHORT_BACKOFF_MS,
} from '../content/pacer.js';

const MIN = 60_000;

const apply = (state, result, times, now = 0) => {
  for (let i = 0; i < times; i++) state = onResult(state, result, now);
  return state;
};

// A rate limit at `now`, its back-off taken in full: returns the state after the
// back-off, the wait, and the time the back-off ended.
const limitAt = (s, now) => {
  s = onResult(s, 'rate-limited', now);
  const wait = nextWait(s, () => 0);
  const endedAt = now + wait.ms;
  return { s: waited(s, endedAt), wait, endedAt };
};

test('starts in the 0.3–0.6 s start range and waits within it', () => {
  const s = createPacer();
  assert.deepEqual({ ...START }, { min: 300, max: 600 });
  assert.equal(nextWait(s, () => 0).ms, 300);
  assert.equal(nextWait(s, () => 1).ms, 600);
  assert.equal(nextWait(s, () => 0).kind, 'pace');
});

test('speeds up by 10% after every 10 consecutive ok', () => {
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

test('a first rate limit takes a short 30 s back-off', () => {
  const { wait } = limitAt(createPacer(), 0);
  assert.equal(SHORT_BACKOFF_MS, 30_000);
  assert.deepEqual(wait, { ms: 30_000, kind: 'backoff' });
});

test('limits soon after a back-off ends escalate 30 s, 2, 4, 8, 16, 30, 30 min even with oks between', () => {
  let s = createPacer();
  const waits = [];
  let t = 0;
  for (let i = 0; i < 7; i++) {
    const r = limitAt(s, t);
    waits.push(r.wait.ms);
    s = apply(r.s, 'ok', 50, r.endedAt + 30_000);
    t = r.endedAt + 1 * MIN;
  }
  assert.deepEqual(waits, [30_000, 2 * MIN, 4 * MIN, 8 * MIN, 16 * MIN, 30 * MIN, 30 * MIN]);
});

test('a limit more than 5 min after the last back-off ended is short again', () => {
  let s = createPacer();
  let r = limitAt(s, 0);
  r = limitAt(apply(r.s, 'ok', 50), r.endedAt + 1 * MIN);
  assert.equal(r.wait.ms, 2 * MIN);
  r = limitAt(apply(r.s, 'ok', 50), r.endedAt + 4 * MIN);
  assert.equal(r.wait.ms, 4 * MIN);
  r = limitAt(apply(r.s, 'ok', 500), r.endedAt + 6 * MIN);
  assert.equal(r.wait.ms, 30_000);
  r = limitAt(apply(r.s, 'ok', 5), r.endedAt + 1 * MIN);
  assert.equal(r.wait.ms, 2 * MIN, 'the ladder restarts from the bottom');
});

test('sequence: first limit 30 s, second within 5 min 2 min, third within 5 min 4 min, one 6 min after that back-off 30 s', () => {
  let s = createPacer();
  const seq = [];
  // Back-offs end at 0:30, 3:00 and 8:00; the last limit is 6 min after 8:00.
  for (const t of [0, 1 * MIN, 4 * MIN, 14 * MIN]) {
    const r = limitAt(s, t);
    s = r.s;
    seq.push(r.wait.ms);
  }
  assert.deepEqual(seq, [30_000, 2 * MIN, 4 * MIN, 30_000]);
});

test('closeness is measured from when the back-off ended, not when it started', () => {
  let s = createPacer();
  let r = limitAt(s, 0);
  r = limitAt(r.s, r.endedAt + 1 * MIN);
  r = limitAt(r.s, r.endedAt + 1 * MIN);
  r = limitAt(r.s, r.endedAt + 1 * MIN);
  assert.equal(r.wait.ms, 8 * MIN);
  // Started more than 5 min before this limit, but ended only 1 min before it.
  r = limitAt(r.s, r.endedAt + 1 * MIN);
  assert.equal(r.wait.ms, 16 * MIN);
});

test('ok does not reset the back-off level', () => {
  const r = limitAt(limitAt(createPacer(), 0).s, 31_000);
  const s = apply(r.s, 'ok', 100);
  assert.equal(s.backoffLevel, r.s.backoffLevel);
  assert.equal(s.backoffLevel, 1);
});

test('waited() after a courtesy pause does not count as a back-off ending', () => {
  let s = apply(createPacer(), 'ok', 500);
  assert.equal(nextWait(s, () => 0).kind, 'courtesy');
  s = waited(s, 1000);
  assert.equal(limitAt(s, 2000).wait.ms, 30_000);
});

test('a rate limit halves the speed (doubles the range), at least the start range', () => {
  const fast = apply(createPacer(), 'ok', 1000);
  const slowed = onResult(fast, 'rate-limited', 0);
  assert.equal(slowed.min, START.min);
  assert.equal(slowed.max, START.max);
  const twice = onResult(slowed, 'rate-limited', 1000);
  assert.equal(twice.min, 600);
  assert.equal(twice.max, 1200);
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

test('backoffEnded only moves the back-off end later (a pause stretched it)', () => {
  const r = limitAt(createPacer(), 0);
  assert.equal(backoffEnded(r.s, 10_000).lastBackoffEndedAt, 30_000);
  const stretched = backoffEnded(r.s, 8 * MIN);
  assert.equal(stretched.lastBackoffEndedAt, 8 * MIN);
  assert.equal(limitAt(stretched, 12 * MIN).wait.ms, 2 * MIN);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer, onResult, nextWait, START, FLOOR, CEILING, COURTESY_PAUSE_MS } from '../content/pacer.js';

const apply = (state, result, times) => {
  for (let i = 0; i < times; i++) state = onResult(state, result);
  return state;
};

test('starts in the start range and waits within it', () => {
  const s = createPacer();
  assert.equal(nextWait(s, () => 0).ms, START.min);
  assert.equal(nextWait(s, () => 1).ms, START.max);
  assert.equal(nextWait(s, () => 0).kind, 'pace');
});

test('speeds up by 15% after every 10 consecutive ok', () => {
  const s = apply(createPacer(), 'ok', 10);
  assert.equal(s.min, 680);
  assert.equal(s.max, 1275);
  assert.deepEqual(apply(createPacer(), 'ok', 9).min, START.min);
});

test('never goes below the floor', () => {
  const s = apply(createPacer(), 'ok', 1000);
  assert.equal(s.min, FLOOR.min);
  assert.equal(s.max, FLOOR.max);
});

test('failed widens the range by 50% and resets the streak, capped at the ceiling', () => {
  const once = onResult(apply(createPacer(), 'ok', 5), 'failed');
  assert.equal(once.min, 1200);
  assert.equal(once.max, 2250);
  assert.equal(once.streak, 0);
  const many = apply(createPacer(), 'failed', 20);
  assert.equal(many.min, CEILING.min);
  assert.equal(many.max, CEILING.max);
});

test('rate-limited backs off 2, 4, 8, 16, 30, 30 minutes', () => {
  let s = createPacer();
  const minutes = [];
  for (let i = 0; i < 6; i++) {
    s = onResult(s, 'rate-limited');
    const wait = nextWait(s, () => 0);
    assert.equal(wait.kind, 'backoff');
    minutes.push(wait.ms / 60_000);
  }
  assert.deepEqual(minutes, [2, 4, 8, 16, 30, 30]);
});

test('rate-limited resets pace to start; next ok resets back-off level', () => {
  let s = apply(createPacer(), 'ok', 100);
  s = onResult(s, 'rate-limited');
  assert.equal(s.min, START.min);
  assert.equal(s.max, START.max);
  s = onResult(s, 'ok');
  assert.equal(s.backoffLevel, 0);
  assert.equal(nextWait(s, () => 0).kind, 'pace');
});

test('takes a courtesy pause after every 300 ok', () => {
  const s = apply(createPacer(), 'ok', 300);
  assert.deepEqual(nextWait(s, () => 0), { ms: COURTESY_PAUSE_MS, kind: 'courtesy' });
  assert.equal(nextWait(onResult(s, 'ok'), () => 0).kind, 'pace');
});

test('rejects unknown results', () => {
  assert.throws(() => onResult(createPacer(), 'weird'), /Unknown result/);
});

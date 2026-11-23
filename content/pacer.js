export const START = Object.freeze({ min: 800, max: 1500 });
export const FLOOR = Object.freeze({ min: 300, max: 600 });
export const CEILING = Object.freeze({ min: 4000, max: 8000 });
export const SPEED_UP_EVERY = 10;
export const BACKOFF_MINUTES = Object.freeze([2, 4, 8, 16, 30]);
export const COURTESY_EVERY = 300;
export const COURTESY_PAUSE_MS = 60_000;

export function createPacer() {
  return { min: START.min, max: START.max, streak: 0, okTotal: 0, backoffLevel: 0, last: null };
}

export function onResult(s, result) {
  if (result === 'ok') {
    const streak = s.streak + 1;
    const speedUp = streak % SPEED_UP_EVERY === 0;
    return {
      ...s,
      last: 'ok',
      streak,
      okTotal: s.okTotal + 1,
      backoffLevel: 0,
      min: speedUp ? Math.max(FLOOR.min, Math.round(s.min * 0.85)) : s.min,
      max: speedUp ? Math.max(FLOOR.max, Math.round(s.max * 0.85)) : s.max,
    };
  }
  if (result === 'failed') {
    return {
      ...s,
      last: 'failed',
      streak: 0,
      min: Math.min(CEILING.min, Math.round(s.min * 1.5)),
      max: Math.min(CEILING.max, Math.round(s.max * 1.5)),
    };
  }
  if (result === 'rate-limited') {
    return { ...s, last: 'rate-limited', streak: 0, min: START.min, max: START.max, backoffLevel: s.backoffLevel + 1 };
  }
  throw new Error(`Unknown result: ${result}`);
}

export function nextWait(s, random = Math.random) {
  if (s.last === 'rate-limited') {
    const minutes = BACKOFF_MINUTES[Math.min(s.backoffLevel, BACKOFF_MINUTES.length) - 1];
    return { ms: minutes * 60_000, kind: 'backoff' };
  }
  if (s.last === 'ok' && s.okTotal % COURTESY_EVERY === 0) {
    return { ms: COURTESY_PAUSE_MS, kind: 'courtesy' };
  }
  return { ms: Math.round(s.min + random() * (s.max - s.min)), kind: 'pace' };
}

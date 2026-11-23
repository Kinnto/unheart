export const START = Object.freeze({ min: 600, max: 1100 });
export const FLOOR = Object.freeze({ min: 150, max: 300 });
export const CEILING = Object.freeze({ min: 4000, max: 8000 });
export const SPEED_UP_EVERY = 10;
export const SPEED_UP = 0.9;
export const SLOW_DOWN = 1.3;
export const SHORT_BACKOFF_MS = 30_000;
export const CLOSE_LIMITS_MS = 5 * 60_000;
export const BACKOFF_MINUTES = Object.freeze([2, 4, 8, 16, 30]);
export const COURTESY_EVERY = 500;
export const COURTESY_PAUSE_MS = 30_000;

// Pure pacing state. `due` holds a one-off wait ('backoff' | 'courtesy') that
// nextWait returns until the caller marks it taken with waited().
export function createPacer() {
  return {
    min: START.min,
    max: START.max,
    streak: 0,
    okTotal: 0,
    backoffLevel: 0,
    lastLimitAt: null,
    due: null,
    last: null,
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, Math.round(value)));

export function onResult(s, result, now) {
  if (result === 'ok') {
    const streak = s.streak + 1;
    const okTotal = s.okTotal + 1;
    const speedUp = streak % SPEED_UP_EVERY === 0;
    return {
      ...s,
      last: 'ok',
      streak,
      okTotal,
      backoffLevel: 0,
      due: okTotal % COURTESY_EVERY === 0 ? 'courtesy' : s.due,
      min: speedUp ? clamp(s.min * SPEED_UP, FLOOR.min, CEILING.min) : s.min,
      max: speedUp ? clamp(s.max * SPEED_UP, FLOOR.max, CEILING.max) : s.max,
    };
  }
  if (result === 'failed') {
    return {
      ...s,
      last: 'failed',
      streak: 0,
      min: clamp(s.min * SLOW_DOWN, FLOOR.min, CEILING.min),
      max: clamp(s.max * SLOW_DOWN, FLOOR.max, CEILING.max),
    };
  }
  if (result === 'rate-limited') {
    const close = s.lastLimitAt !== null && now - s.lastLimitAt <= CLOSE_LIMITS_MS;
    return {
      ...s,
      last: 'rate-limited',
      streak: 0,
      lastLimitAt: now,
      backoffLevel: close ? s.backoffLevel + 1 : 0,
      due: 'backoff',
      min: clamp(s.min * 2, START.min, CEILING.min),
      max: clamp(s.max * 2, START.max, CEILING.max),
    };
  }
  throw new Error(`Unknown result: ${result}`);
}

export function nextWait(s, random = Math.random) {
  if (s.due === 'backoff') {
    if (s.backoffLevel === 0) return { ms: SHORT_BACKOFF_MS, kind: 'backoff' };
    const minutes = BACKOFF_MINUTES[Math.min(s.backoffLevel, BACKOFF_MINUTES.length) - 1];
    return { ms: minutes * 60_000, kind: 'backoff' };
  }
  if (s.due === 'courtesy') return { ms: COURTESY_PAUSE_MS, kind: 'courtesy' };
  return { ms: Math.round(s.min + random() * (s.max - s.min)), kind: 'pace' };
}

export function waited(s) {
  return s.due === null ? s : { ...s, due: null };
}

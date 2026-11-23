export const START = Object.freeze({ min: 300, max: 600 });
export const FLOOR = Object.freeze({ min: 150, max: 300 });
export const CEILING = Object.freeze({ min: 4000, max: 8000 });
export const SPEED_UP_EVERY = 10;
export const SPEED_UP = 0.9;
export const GENTLE_EVERY = 20;
export const GENTLE_SPEED_UP = 0.95;
export const SLOW_DOWN = 1.3;
export const SOFT_SLOW_DOWN = 1.5;
export const OUTCOME_WINDOW = 10;
export const LIMIT_REJECTIONS = 3;
export const SOFT_RECOVER_OKS = 10;
export const RATE_WINDOW_MS = 30_000;
export const BACKOFF_START_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const OKS_TO_RESET_BACKOFF = 10;
export const COURTESY_EVERY = 500;
export const COURTESY_PAUSE_MS = 30_000;

// Pure pacing state.
// - `due` holds a one-off wait ('backoff' | 'courtesy') that nextWait returns
//   until the caller marks it taken with waited().
// - `outcomes` is the last OUTCOME_WINDOW verification results (true = X
//   rejected it). A lone rejection is a glitch; several close together, or a
//   rejected first try after a back-off, mean X is limiting us.
// - `clicks` are recent click times, so a limit can halve the rate we had.
// - `softFrom` is the pace before a glitch widened it; SOFT_RECOVER_OKS
//   consecutive oks restore it, so isolated glitches cannot ratchet the pace.
export function createPacer() {
  return {
    min: START.min,
    max: START.max,
    streak: 0,
    okTotal: 0,
    due: null,
    last: null,
    outcomes: [],
    clicks: [],
    backoffMs: BACKOFF_START_MS,
    okSinceBackoff: null,
    probing: false,
    gentle: false,
    softFrom: null,
    loadErrorStreak: 0,
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, Math.round(value)));
const scale = (s, factor) => ({
  min: clamp(s.min * factor, FLOOR.min, CEILING.min),
  max: clamp(s.max * factor, FLOOR.max, CEILING.max),
});
const remember = (outcomes, rejected) => [...outcomes, rejected].slice(-OUTCOME_WINDOW);

export const limitDue = (s) => s.due === 'backoff';

export function onClick(s, now) {
  return { ...s, clicks: [...s.clicks.filter((t) => t > now - RATE_WINDOW_MS), now] };
}

// Half the click rate of the last RATE_WINDOW_MS, never faster than START and
// never faster than the current pace.
function slowedPace(s, now) {
  const recent = s.clicks.filter((t) => t > now - RATE_WINDOW_MS);
  let { min, max } = s;
  if (recent.length >= 2) {
    const interval = (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
    const target = 2 * interval;
    min = Math.max(min, target * (2 / 3));
    max = Math.max(max, target * (4 / 3));
  }
  return {
    min: clamp(min, START.min, CEILING.min),
    max: clamp(max, START.max, CEILING.max),
  };
}

// X is limiting us: schedule a back-off, halve the rate, speed up gently after.
export function onLimit(s, now) {
  if (limitDue(s)) return s;
  const soonAfterBackoff = s.okSinceBackoff !== null && s.okSinceBackoff < OKS_TO_RESET_BACKOFF;
  return {
    ...s,
    ...slowedPace(s, now),
    last: 'rate-limited',
    streak: 0,
    due: 'backoff',
    gentle: true,
    softFrom: null,
    backoffMs: soonAfterBackoff ? Math.min(BACKOFF_MAX_MS, s.backoffMs * 2) : BACKOFF_START_MS,
  };
}

export function onResult(s, result, now) {
  // A toast another verification already claimed: no signal either way.
  if (result === 'uncertain') return s;
  if (result === 'ok') {
    const streak = s.streak + 1;
    const okTotal = s.okTotal + 1;
    const every = s.gentle ? GENTLE_EVERY : SPEED_UP_EVERY;
    const factor = s.gentle ? GENTLE_SPEED_UP : SPEED_UP;
    const courtesy = okTotal % COURTESY_EVERY === 0 && !limitDue(s);
    const recovered = s.softFrom !== null && streak >= SOFT_RECOVER_OKS;
    let pace = streak % every === 0 ? scale(s, factor) : {};
    if (recovered) pace = { ...s.softFrom };
    return {
      ...s,
      ...pace,
      softFrom: recovered ? null : s.softFrom,
      last: 'ok',
      streak,
      okTotal,
      outcomes: remember(s.outcomes, false),
      okSinceBackoff: s.okSinceBackoff === null ? null : s.okSinceBackoff + 1,
      probing: false,
      loadErrorStreak: 0,
      due: courtesy ? 'courtesy' : s.due,
    };
  }
  if (result === 'failed') {
    return {
      ...s,
      ...scale(s, SLOW_DOWN),
      last: 'failed',
      streak: 0,
      outcomes: remember(s.outcomes, false),
      probing: false,
    };
  }
  if (result === 'rate-limited') {
    const outcomes = remember(s.outcomes, true);
    const next = { ...s, last: 'rejected', streak: 0, outcomes, probing: false };
    if (limitDue(s)) return next;
    const rejections = outcomes.filter(Boolean).length;
    if (s.probing || rejections >= LIMIT_REJECTIONS) return onLimit(next, now);
    return { ...next, ...scale(s, SOFT_SLOW_DOWN), softFrom: s.softFrom ?? { min: s.min, max: s.max } };
  }
  throw new Error(`Unknown result: ${result}`);
}

// A timeline load error: X's Retry. Once is a glitch; failing again before any
// verification succeeds (Retry failed), or right after a back-off, is a limit.
export function onLoadError(s, now) {
  if (limitDue(s)) return s;
  if (s.loadErrorStreak > 0 || s.probing) return { ...onLimit(s, now), loadErrorStreak: 0, probing: false };
  return { ...s, loadErrorStreak: 1 };
}

export function nextWait(s, random = Math.random) {
  if (s.due === 'backoff') return { ms: s.backoffMs, kind: 'backoff' };
  if (s.due === 'courtesy') return { ms: COURTESY_PAUSE_MS, kind: 'courtesy' };
  return { ms: Math.round(s.min + random() * (s.max - s.min)), kind: 'pace' };
}

// Marks the due wait as taken. Taking a back-off starts a fresh window: the
// next verification is a probe, and oks since the back-off are counted.
export function waited(s) {
  if (s.due === null) return s;
  if (s.due === 'backoff') return { ...s, due: null, outcomes: [], okSinceBackoff: 0, probing: true };
  return { ...s, due: null };
}

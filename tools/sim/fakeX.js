// Dev-only simulator of X's Likes timeline, driven by a fake clock.
// Not part of the extension: nothing under content/ or manifest.json uses it.
import { makeDoc, addPost, showToast, showTimelineRetry } from '../../test/helpers/xdom.js';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) so runs are reproducible.
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fake clock with a timer scheduler. Timers only fire when the driver
// advances the clock; between timers every pending microtask runs, so promise
// chains in the code under test settle just as they would in a browser.
export function createClock() {
  let t = 0;
  let seq = 0;
  let timers = [];
  let fired = 0;

  function setTimer(ms, fn) {
    const timer = { at: t + Math.max(0, ms), seq: seq++, fn, cancelled: false };
    timers.push(timer);
    return timer;
  }

  function cancel(timer) {
    if (timer) timer.cancelled = true;
  }

  function popNext() {
    timers = timers.filter((x) => !x.cancelled);
    if (!timers.length) return null;
    let best = 0;
    for (let i = 1; i < timers.length; i++) {
      const x = timers[i];
      const b = timers[best];
      if (x.at < b.at || (x.at === b.at && x.seq < b.seq)) best = i;
    }
    return timers.splice(best, 1)[0];
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // Fire the next timer (after letting microtasks settle).
  async function step(limitAt = Infinity) {
    await flush();
    const peek = timers.filter((x) => !x.cancelled);
    if (!peek.length) return 'idle';
    const next = popNext();
    if (next.at > limitAt) {
      timers.push(next);
      t = Math.max(t, limitAt);
      return 'limit';
    }
    t = next.at;
    fired++;
    next.fn();
    return 'fired';
  }

  // Drive the clock until `promise` settles. Detects hangs: no timers left
  // while still pending (deadlock), simulated-time cap, real wall-time cap.
  async function runUntil(promise, { maxSimMs = 12 * 3600_000, maxWallMs = 120_000 } = {}) {
    let settled = false;
    let error = null;
    promise.then(() => { settled = true; }, (e) => { settled = true; error = e; });
    const wallStart = Date.now();
    const simCap = t + maxSimMs;
    for (let i = 0; ; i++) {
      await flush();
      if (settled) return error ? { outcome: 'threw', error } : { outcome: 'settled' };
      if (i % 2000 === 0 && Date.now() - wallStart > maxWallMs) return { outcome: 'wall-timeout' };
      const r = await step(simCap);
      if (settled) return error ? { outcome: 'threw', error } : { outcome: 'settled' };
      if (r === 'idle') return { outcome: 'deadlock' };
      if (r === 'limit') return { outcome: 'sim-timeout' };
    }
  }

  // Let simulated time pass (e.g. so in-flight server responses land).
  async function advance(ms) {
    const until = t + ms;
    while ((await step(until)) === 'fired');
    t = Math.max(t, until);
    await flush();
  }

  return {
    now: () => t,
    setTimer,
    cancel,
    sleep: (ms) => new Promise((resolve) => setTimer(ms, resolve)),
    runUntil,
    advance,
    get fired() { return fired; },
  };
}

// ---------------------------------------------------------------------------
export const DEFAULTS = Object.freeze({
  posts: 300,
  initialWindow: 20,
  pageSize: 10,
  maxDom: 40,
  loadLatencyMs: [150, 600],
  renderDelayMs: [16, 50],
  confirmLatencyMs: [100, 400],
  toastMs: 3000,
  revertRate: 0,
  toastRate: 0,
  loadErrorRate: 0,
  reuseToastNode: false, // one persistent toast element, hidden/shown per error
  toastRevertsHeart: true, // false: X refuses with a toast but leaves the heart grey
  limit: null, // { max, windowMs } sliding window of accepted unlikes
  burst: null, // { max, windowMs } short-term sliding window
});

export const SCENARIOS = Object.freeze({
  default: {},
  noisy: { revertRate: 0.02, toastRate: 0.01, loadErrorRate: 0.02 },
  limited: { burst: { max: 50, windowMs: 60_000 }, limit: { max: 900, windowMs: 15 * 60_000 } },
  // X reusing a single toast node (hidden between errors, text varying):
  // a limit must still be detected and backed off.
  reuse: {
    reuseToastNode: true,
    toastRevertsHeart: false,
    toastRate: 0.02,
    revertRate: 0.01,
    burst: { max: 50, windowMs: 60_000 },
    limit: { max: 900, windowMs: 15 * 60_000 },
  },
  harsh: {
    revertRate: 0.05,
    toastRate: 0.03,
    loadErrorRate: 0.06,
    loadLatencyMs: [200, 1500],
    confirmLatencyMs: [150, 900],
    burst: { max: 40, windowMs: 60_000 },
    limit: { max: 600, windowMs: 15 * 60_000 },
  },
});

export const hasHardLimits = (opts) => Boolean(opts.limit || opts.burst);

export const TOAST_TEXT = 'Something went wrong. Try reloading.';
export const TOAST_TEXTS = Object.freeze([TOAST_TEXT, 'Something went wrong, but don’t fret — let’s give it another shot.']);

// A simulated Likes page. Server truth: `serverLiked`. Client: a cache of
// fetched posts (with what each heart shows) and a rendered window of at most
// maxDom articles.
export function createFakeX({ clock, random, ...options }) {
  const o = { ...DEFAULTS, ...options };
  const between = ([lo, hi]) => lo + Math.round(random() * (hi - lo));
  const ids = Array.from({ length: o.posts }, (_, i) => String(1_000_000 + i));
  const serverLiked = new Set(ids);
  const accepted = []; // times of accepted unlikes (for sliding windows)
  const stats = {
    clicks: 0,
    unlikeRequests: 0,
    accepted: 0,
    rejectedRevert: 0,
    rejectedToast: 0,
    rejectedLimit: 0,
    relikes: 0,
    pageLoads: 0,
    loadErrors: 0,
    retryClicks: 0,
    maxDomArticles: 0,
    reloads: 0,
  };

  const doc = makeDoc({ posts: [] });
  const main = doc.querySelector('main');

  let page; // per page-load client state
  let toast = null;
  let toastTimer = null;

  function newPage() {
    return {
      cursor: 0, // next index into ids the server will look from
      cache: [], // fetched ids, in timeline order
      client: new Map(), // id -> { liked, article, button, gen }
      start: 0,
      end: 0,
      fetching: false,
      retryBox: null,
      exhausted: false,
    };
  }

  function render() {
    const p = page;
    const articles = p.cache.slice(p.start, p.end).map((id) => p.client.get(id).article);
    main.replaceChildren(...articles, ...(p.retryBox ? [p.retryBox] : []));
    stats.maxDomArticles = Math.max(stats.maxDomArticles, articles.length);
  }

  function trim() {
    if (page.end - page.start > o.maxDom) page.start = page.end - o.maxDom;
  }

  function setHeart(c) {
    c.button.setAttribute('data-testid', c.liked ? 'unlike' : 'like');
  }

  let reusedToast = null;
  let toastShows = 0;

  function showErrorToast() {
    if (o.reuseToastNode) {
      if (!reusedToast) {
        reusedToast = showToast(doc, '');
        reusedToast.hidden = true;
      }
      clock.cancel(toastTimer);
      reusedToast.textContent = TOAST_TEXTS[toastShows++ % TOAST_TEXTS.length];
      reusedToast.hidden = false;
      toastTimer = clock.setTimer(o.toastMs, () => { reusedToast.hidden = true; });
      return;
    }
    if (toast) toast.remove();
    clock.cancel(toastTimer);
    toast = showToast(doc, TOAST_TEXT);
    const mine = toast;
    toastTimer = clock.setTimer(o.toastMs, () => {
      mine.remove();
      if (toast === mine) toast = null;
    });
  }

  const inWindow = (timesArr, windowMs) => {
    const from = clock.now() - windowMs;
    let n = 0;
    for (let i = timesArr.length - 1; i >= 0 && timesArr[i] > from; i--) n++;
    return n;
  };

  function overLimit() {
    if (o.burst && inWindow(accepted, o.burst.windowMs) >= o.burst.max) return true;
    if (o.limit && inWindow(accepted, o.limit.windowMs) >= o.limit.max) return true;
    return false;
  }

  function onHeartClick(p, id) {
    const c = p.client.get(id);
    stats.clicks++;
    const gen = ++c.gen;
    const wantLiked = !c.liked;
    c.liked = wantLiked; // optimistic
    setHeart(c);
    if (wantLiked) {
      // Clicking a grey heart likes the post again. Unheart must never do this.
      stats.relikes++;
      clock.setTimer(between(o.confirmLatencyMs), () => serverLiked.add(id));
      return;
    }
    stats.unlikeRequests++;
    clock.setTimer(between(o.confirmLatencyMs), () => {
      let outcome;
      if (!serverLiked.has(id)) outcome = 'ok';
      else if (overLimit()) outcome = 'limit';
      else if (random() < o.toastRate) outcome = 'toast';
      else if (random() < o.revertRate) outcome = 'revert';
      else outcome = 'ok';
      if (outcome === 'ok') {
        if (serverLiked.delete(id)) {
          stats.accepted++;
          accepted.push(clock.now());
        }
        return;
      }
      if (outcome === 'limit') stats.rejectedLimit++;
      else if (outcome === 'toast') stats.rejectedToast++;
      else stats.rejectedRevert++;
      if (outcome !== 'revert') showErrorToast();
      if (page === p && c.gen === gen && (outcome === 'revert' || o.toastRevertsHeart)) {
        c.liked = true;
        setHeart(c);
      }
    });
  }

  function materialise(p, id) {
    const article = addPost(doc, { id, liked: true });
    article.remove();
    const button = article.querySelector('[role="group"] button');
    const c = { liked: true, article, button, gen: 0 };
    button.addEventListener('click', () => onHeartClick(p, id));
    p.client.set(id, c);
  }

  function showRetry(p, count) {
    const button = showTimelineRetry(doc);
    p.retryBox = button.parentElement;
    button.addEventListener('click', () => {
      if (page !== p || !p.retryBox) return;
      stats.retryClicks++;
      p.retryBox = null;
      render();
      fetchPage(p, count);
    });
    render();
  }

  function fetchPage(p, count) {
    if (p.fetching || p.retryBox || p.exhausted) return;
    p.fetching = true;
    clock.setTimer(between(o.loadLatencyMs), () => {
      if (page !== p) return;
      p.fetching = false;
      stats.pageLoads++;
      if (random() < o.loadErrorRate) {
        stats.loadErrors++;
        showRetry(p, count);
        return;
      }
      const fresh = [];
      while (p.cursor < ids.length && fresh.length < count) {
        const id = ids[p.cursor++];
        if (serverLiked.has(id) && !p.client.has(id)) fresh.push(id);
      }
      if (p.cursor >= ids.length) p.exhausted = true;
      const atBottom = p.end === p.cache.length;
      for (const id of fresh) {
        materialise(p, id);
        p.cache.push(id);
      }
      if (atBottom) p.end = p.cache.length;
      trim();
      render();
    });
  }

  // Injected into createClickUnliker: bring the bottom into view.
  function scroll() {
    const p = page;
    if (p.end < p.cache.length) {
      clock.setTimer(between(o.renderDelayMs), () => {
        if (page !== p) return;
        p.end = Math.min(p.cache.length, p.end + o.pageSize);
        trim();
        render();
      });
      return;
    }
    fetchPage(p, o.pageSize);
  }

  // Cached posts re-render from the top with their client-side heart state.
  function scrollToTop() {
    const p = page;
    p.start = 0;
    p.end = Math.min(p.cache.length, o.initialWindow);
    render();
  }

  // A full page reload: client state is gone, the server is asked again.
  function reload() {
    stats.reloads++;
    page = newPage();
    if (toast) toast.remove();
    toast = null;
    render();
    fetchPage(page, o.initialWindow);
  }

  page = newPage();
  fetchPage(page, o.initialWindow);

  return {
    doc,
    options: o,
    ids,
    stats,
    scroll,
    scrollToTop,
    reload,
    serverLiked,
    likedCount: () => serverLiked.size,
    unlikedCount: () => ids.length - serverLiked.size,
  };
}

import * as sel from './selectors.js';

const VERIFY_STEP_MS = 100;
const FLIP_TIMEOUT_MS = 3000;
const STABLE_MS = 400;
const VERIFY_TOTAL_MS = 4000;
const LOAD_WAIT_MS = 800;
const GIVE_UP_MS = 10_000;

export class SelectorsBrokenError extends Error {
  constructor() {
    super('X page structure not recognised');
    this.name = 'SelectorsBrokenError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'CancelledError';
  }
}

export function createClickUnliker({
  doc = document,
  scroll = () => window.scrollBy(0, window.innerHeight * 0.9),
  scrollToTop = () => window.scrollTo(0, 0),
  sleep,
  now = Date.now,
  shouldContinue = () => true,
  initialSucceeded = [],
}) {
  const tried = new Set();
  const succeeded = new Set(initialSucceeded);
  let retryReported = false;
  const revertedOnce = new Set();

  function pick() {
    for (const post of sel.listPosts(doc)) {
      if (post.liked !== true) continue;
      if (succeeded.has(post.id)) {
        succeeded.delete(post.id);
        if (revertedOnce.has(post.id)) return { id: post.id, reverted: true, giveUp: true };
        revertedOnce.add(post.id);
        return { id: post.id, reverted: true };
      }
      if (!tried.has(post.id)) return { id: post.id, reverted: false };
    }
    return null;
  }

  async function next() {
    const seen = new Set();
    let lastGrowth = now();
    let brokenSince = null;
    for (;;) {
      if (!shouldContinue()) throw new CancelledError();
      const item = pick();
      if (item) {
        tried.add(item.id);
        return item;
      }
      const retry = sel.findTimelineRetry(doc);
      if (retry) {
        if (!retryReported) {
          retryReported = true;
          return { loadLimited: true };
        }
        retryReported = false;
        retry.click();
        lastGrowth = now();
      } else {
        retryReported = false;
      }
      if (sel.looksBroken(doc)) {
        brokenSince ??= now();
        if (now() - brokenSince >= GIVE_UP_MS) throw new SelectorsBrokenError();
      } else {
        brokenSince = null;
      }
      for (const post of sel.listPosts(doc)) seen.add(post.id);
      const before = seen.size;
      scroll();
      await sleep(LOAD_WAIT_MS);
      for (const post of sel.listPosts(doc)) seen.add(post.id);
      if (seen.size > before) lastGrowth = now();
      else if (now() - lastGrowth >= GIVE_UP_MS) {
        if (brokenSince !== null) throw new SelectorsBrokenError();
        return null;
      }
    }
  }

  // id -> { toastBefore, clickedAt }, recorded at click time so that each
  // in-flight verification judges error toasts against its own baseline.
  const clicked = new Map();

  async function click(item) {
    const post = sel.findPost(item.id, doc);
    const button = post && sel.likedButtonOf(post.article);
    if (!button) return 'failed';
    const toastBefore = sel.findErrorToast(doc);
    button.scrollIntoView?.({ block: 'center' });
    if (!shouldContinue()) throw new CancelledError();
    button.click();
    clicked.set(item.id, { toastBefore, clickedAt: now() });
    return 'clicked';
  }

  async function unlike(item) {
    if ((await click(item)) !== 'clicked') return 'failed';
    return verify(item);
  }

  async function verify(item) {
    const record = clicked.get(item.id);
    if (!record) return 'failed';
    clicked.delete(item.id);
    const { toastBefore, clickedAt: start } = record;
    let flippedAt = null;
    while (now() - start < VERIFY_TOTAL_MS) {
      await sleep(VERIFY_STEP_MS);
      if (!toastBefore && sel.findErrorToast(doc)) return 'rate-limited';
      const liked = sel.findPost(item.id, doc)?.liked ?? null;
      if (liked === false) {
        flippedAt ??= now();
        if (now() - flippedAt >= STABLE_MS) {
          succeeded.add(item.id);
          return 'ok';
        }
      } else if (liked === true && flippedAt !== null) {
        return 'rate-limited';
      } else if (liked === null && flippedAt !== null) {
        succeeded.add(item.id);
        return 'ok';
      }
      if (flippedAt === null && now() - start >= FLIP_TIMEOUT_MS) return 'failed';
    }
    return 'failed';
  }

  function requeue(item) {
    tried.delete(item.id);
  }

  function restart() {
    for (const id of tried) if (!succeeded.has(id)) tried.delete(id);
    scrollToTop();
  }

  const succeededIds = () => [...succeeded];

  return { next, click, verify, unlike, requeue, restart, succeededIds };
}

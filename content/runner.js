import { createPacer, onClick, onResult, onLoadError, nextWait, waited, limitDue } from './pacer.js';

const ACTIVE = new Set(['running', 'paused', 'backing-off']);
export const MAX_IN_FLIGHT = 3;

export function createRunner({ unliker, sleep, now = Date.now, random = Math.random }) {
  const listeners = new Set();
  let state = {
    status: 'idle',
    removed: 0,
    failed: 0,
    limit: Infinity,
    removedAtStart: 0,
    startedAt: null,
    finishedAt: null,
    slowdowns: 0,
    pauseReason: null,
    waitUntil: null,
    waitKind: null,
    endReason: null,
    error: null,
  };
  let pacer = createPacer();
  let wake = () => {};
  let pauses = 0;
  let runId = 0;

  function set(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function nap(ms) {
    return new Promise((resolve) => {
      wake = resolve;
      sleep(ms).then(() => resolve('slept'));
    });
  }

  async function checkpoint(id) {
    while (state.status === 'paused' && id === runId) await new Promise((resolve) => { wake = resolve; });
    return id === runId && (state.status === 'running' || state.status === 'backing-off');
  }

  async function waitFor(id, ms, kind) {
    const until = now() + ms;
    while (now() < until) {
      if (!(await checkpoint(id))) return false;
      set({ status: kind === 'backoff' ? 'backing-off' : 'running', waitUntil: until, waitKind: kind });
      if ((await nap(until - now())) === 'resume-now') break;
    }
    if (!(await checkpoint(id))) return false;
    set({ status: 'running', waitUntil: null, waitKind: null });
    return true;
  }

  function takeWait() {
    const wait = nextWait(pacer, random);
    pacer = waited(pacer);
    return wait;
  }

  const finish = (endReason) => set({ status: 'done', endReason, finishedAt: now(), waitUntil: null, waitKind: null });

  async function loop(id) {
    // Verifications started by this run that have not settled yet.
    const pending = new Set();
    let failure = null;
    const limited = () => limitDue(pacer);
    const live = () => id === runId && ACTIVE.has(state.status);
    const requeue = (item) => { if (item?.id && !item.giveUp) unliker.requeue(item); };

    // A settled verification always counts a real 'ok'; anything else only
    // matters while this run is still the live one.
    function settle(item, result) {
      if (result === 'ok' && id !== runId) {
        // A newer run is going: keep the total honest without using its limit.
        set({ removed: state.removed + 1, removedAtStart: state.removedAtStart + 1 });
      } else if (result === 'ok') {
        set({ removed: state.removed + 1 });
      }
      if (result === 'rate-limited' || result === 'uncertain') unliker.requeue(item);
      if (!live()) return;
      // The pacer decides whether a rejection is a glitch or a limit.
      pacer = onResult(pacer, result, now());
      if (result === 'failed') set({ failed: state.failed + 1 });
    }

    function track(item) {
      const settled = (async () => unliker.verify(item))()
        .then((result) => settle(item, result), (error) => { failure ??= error; })
        .finally(() => pending.delete(settled));
      pending.add(settled);
    }

    async function drain() {
      while (pending.size) await Promise.all(pending);
      if (failure) throw failure;
    }

    async function backOff() {
      await drain();
      if (!(await checkpoint(id))) return false;
      set({ slowdowns: state.slowdowns + 1 });
      const wait = takeWait();
      return waitFor(id, wait.ms, wait.kind);
    }

    const atLimit = () => state.removed - state.removedAtStart + pending.size >= state.limit;

    try {
      while (await checkpoint(id)) {
        if (failure) throw failure;
        if (limited()) {
          if (!(await backOff())) return;
          continue;
        }
        if (atLimit() && !pending.size) return finish('limit');
        // Right after a back-off, one probe click until X answers it.
        const capacity = pacer.probing ? 1 : MAX_IN_FLIGHT;
        if (atLimit() || pending.size >= capacity) {
          await Promise.race(pending);
          continue;
        }
        const pausesBefore = pauses;
        const item = await unliker.next({ allowScroll: pending.size === 0 });
        if (id !== runId) return requeue(item);
        if (item?.reverted) {
          set({ removed: state.removed - 1, failed: state.failed + (item.giveUp ? 1 : 0) });
        }
        if (!(await checkpoint(id))) return requeue(item);
        if (pauses !== pausesBefore || limited()) {
          requeue(item);
          continue;
        }
        if (item?.loadLimited) {
          // X's timeline failed to load: a rejection like any other. Once is
          // a glitch (the next call clicks Retry); repeatedly is a limit.
          pacer = onLoadError(pacer, now());
          continue;
        }
        if (item?.needsScroll) {
          // Let every pending verification finish before the page scrolls.
          await drain();
          continue;
        }
        if (!item) {
          await drain();
          if (!limited() && (await checkpoint(id))) return finish('end');
          continue;
        }
        if (item.giveUp) continue;
        if ((await unliker.click(item)) === 'clicked') {
          if (live()) pacer = onClick(pacer, now());
          track(item);
        } else if (live()) {
          pacer = onResult(pacer, 'failed', now());
          set({ failed: state.failed + 1 });
        }
        if (!live()) return;
        if (limited()) continue;
        const wait = takeWait();
        if (!(await waitFor(id, wait.ms, wait.kind))) return;
      }
    } catch (error) {
      if (id !== runId || error?.name === 'CancelledError') return;
      set({
        status: 'error',
        error: error?.name === 'SelectorsBrokenError' ? 'selectors' : 'unexpected',
        waitUntil: null,
        waitKind: null,
      });
    } finally {
      // Whatever ended the loop, let clicks already made finish verifying so
      // the run settles with its final count. Settled promises never reject.
      while (pending.size) await Promise.all(pending);
    }
  }

  function start({ limit = Infinity, removed = state.removed } = {}) {
    if (ACTIVE.has(state.status)) return Promise.resolve();
    const id = ++runId;
    set({
      status: 'running',
      limit,
      removed,
      removedAtStart: removed,
      failed: 0,
      startedAt: now(),
      finishedAt: null,
      slowdowns: 0,
      pauseReason: null,
      waitUntil: null,
      waitKind: null,
      endReason: null,
      error: null,
    });
    return loop(id);
  }

  return {
    get state() {
      return state;
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    pause(reason = 'user') {
      if (state.status !== 'running' && state.status !== 'backing-off') return;
      pauses++;
      set({ status: 'paused', pauseReason: reason });
      wake();
    },
    resume() {
      if (state.status !== 'paused') return;
      set({ status: 'running', pauseReason: null });
      wake();
    },
    resumeNow() {
      if (state.status === 'backing-off') wake('resume-now');
    },
    stop() {
      if (!ACTIVE.has(state.status)) return;
      set({ status: 'stopped', pauseReason: null, waitUntil: null, waitKind: null });
      wake();
    },
    async retry() {
      if (ACTIVE.has(state.status)) return;
      await unliker.restart();
      return start({ limit: Infinity });
    },
  };
}

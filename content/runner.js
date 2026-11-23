import { createPacer, onResult, nextWait } from './pacer.js';

const ACTIVE = new Set(['running', 'paused', 'backing-off']);

export function createRunner({ unliker, sleep, now = Date.now, random = Math.random }) {
  const listeners = new Set();
  let state = {
    status: 'idle',
    removed: 0,
    failed: 0,
    limit: Infinity,
    removedAtStart: 0,
    startedAt: null,
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

  const reachedLimit = () => state.removed - state.removedAtStart >= state.limit;
  const finish = (endReason) => set({ status: 'done', endReason, waitUntil: null, waitKind: null });

  async function loop(id) {
    try {
      while (await checkpoint(id)) {
        if (reachedLimit()) return finish('limit');
        const pausesBefore = pauses;
        const item = await unliker.next();
        if (id !== runId) {
          if (item && !item.giveUp && !item.loadLimited) unliker.requeue(item);
          return;
        }
        if (item?.reverted) {
          set({ removed: state.removed - 1, failed: state.failed + (item.giveUp ? 1 : 0) });
        }
        if (!(await checkpoint(id))) {
          if (item && !item.giveUp && !item.loadLimited) unliker.requeue(item);
          return;
        }
        if (pauses !== pausesBefore) {
          if (item && !item.giveUp && !item.loadLimited) unliker.requeue(item);
          continue;
        }
        if (item?.loadLimited) {
          pacer = onResult(pacer, 'rate-limited');
          const wait = nextWait(pacer, random);
          if (!(await waitFor(id, wait.ms, wait.kind))) return;
          continue;
        }
        if (!item) return finish('end');
        if (item.giveUp) continue;
        const result = await unliker.unlike(item);
        if (id !== runId) {
          if (result === 'ok') set({ removed: state.removed + 1 });
          return;
        }
        pacer = onResult(pacer, result);
        if (result === 'ok') set({ removed: state.removed + 1 });
        else if (result === 'failed') set({ failed: state.failed + 1 });
        else unliker.requeue(item);
        if (state.status === 'stopped') return;
        if (reachedLimit()) return finish('limit');
        const wait = nextWait(pacer, random);
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

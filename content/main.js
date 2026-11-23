import { getOwnHandle, isOwnLikesPage, LIKES_PATH } from './selectors.js';
import { createClickUnliker } from './clickUnliker.js';
import { createRunner } from './runner.js';
import { createStore } from './store.js';
import { view } from './view.js';
import { createPanel, createPill } from './panel.js';
import { STORE_URL, WEB3FORMS_KEY } from './config.js';

const ACTIVE = new Set(['running', 'paused', 'backing-off']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const store = createStore();

let panel = null;
let pill = null;
let runner = null;
let ticker = null;
let ctx = { confirmed: false, confirming: null, resumable: null, reviewAsked: false };
const feedbackEnabled = Boolean(WEB3FORMS_KEY);
let lastSaved = null;
let lastSavedAt = 0;
let saveTimer = null;
const SAVE_EVERY_MS = 3000;
const MAX_SAVED_IDS = 5000;
let unliker = null;
let lastKey = null;
let syncing = false;

function render() {
  if (!panel || !runner) return;
  panel.render(view(runner.state, { now: Date.now(), confirming: ctx.confirming, resumable: ctx.resumable, feedback: feedbackEnabled, reviewAsked: ctx.reviewAsked }));
}

function save(state) {
  clearTimeout(saveTimer);
  saveTimer = null;
  lastSaved = state.removed;
  lastSavedAt = Date.now();
  store.set({ progress: { removed: state.removed, ids: unliker.succeededIds().slice(-MAX_SAVED_IDS) } });
}

// While running, write progress at most every SAVE_EVERY_MS, with a trailing
// write for the last change; pauses and back-offs save straight away.
function persist(state) {
  if (state.status === 'done') {
    clearTimeout(saveTimer);
    saveTimer = null;
    lastSaved = null;
    store.set({ progress: null });
    return;
  }
  if (!ACTIVE.has(state.status) || state.removed === lastSaved) return;
  const wait = lastSavedAt + SAVE_EVERY_MS - Date.now();
  if (state.status !== 'running' || wait <= 0) {
    save(state);
  } else {
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      const latest = runner?.state;
      if (latest && ACTIVE.has(latest.status) && latest.removed !== lastSaved) save(latest);
    }, wait);
  }
}

function begin(limit, removed = runner.state.removed) {
  ctx.resumable = null;
  runner.start({ limit, removed });
}

function onAction(id) {
  switch (id) {
    case 'start-all':
    case 'start-10': {
      const limit = id === 'start-10' ? 10 : Infinity;
      if (ctx.confirmed) begin(limit);
      else ctx.confirming = limit;
      break;
    }
    case 'confirm': {
      const limit = ctx.confirming;
      ctx.confirming = null;
      ctx.confirmed = true;
      store.set({ confirmed: true });
      begin(limit);
      break;
    }
    case 'cancel':
      ctx.confirming = null;
      break;
    case 'resume-run':
      begin(Infinity, ctx.resumable);
      break;
    case 'pause':
      runner.pause('user');
      break;
    case 'resume':
      runner.resume();
      break;
    case 'resume-now':
      runner.resumeNow();
      break;
    case 'stop':
      runner.stop();
      clearTimeout(saveTimer);
      saveTimer = null;
      lastSaved = null;
      store.set({ progress: null });
      break;
    case 'retry':
      runner.retry();
      break;
    case 'rate':
      ctx.reviewAsked = true;
      store.set({ reviewAsked: true });
      window.open(`${STORE_URL}/reviews`, '_blank', 'noopener');
      break;
    case 'share': {
      const text = `I just removed ${runner.state.removed.toLocaleString('en-US')} likes on X with Unheart 💔 https://kinnto.github.io/unheart-site/`;
      window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      break;
    }
  }
  render();
}

async function sendFeedback({ choice, message }) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'feedback', choice, message });
    return reply?.ok === true;
  } catch {
    return false;
  }
}

function mountPanel(saved, handle) {
  unliker = createClickUnliker({
    sleep,
    initialSucceeded: saved.progress?.ids ?? [],
    shouldContinue: () => runner === current && ACTIVE.has(current.state.status) && isOwnLikesPage(location.pathname, handle),
  });
  const current = createRunner({ unliker, sleep });
  runner = current;
  ctx = { confirmed: saved.confirmed, confirming: null, resumable: saved.progress?.removed ?? null, reviewAsked: saved.reviewAsked };
  panel = createPanel({ layout: saved.panel, onAction, onLayout: (layout) => store.set({ panel: layout }), onFeedbackSend: sendFeedback });
  runner.on((state) => {
    persist(state);
    render();
  });
  ticker = setInterval(render, 1000);
  render();
}

function unmountPanel() {
  if (!panel) return;
  clearInterval(ticker);
  panel.destroy();
  panel = null;
  const leaving = runner;
  if (ACTIVE.has(leaving.state.status) && leaving.state.removed !== lastSaved) save(leaving.state);
  runner = null;
  leaving.stop();
}

function mountPill() {
  pill = createPill({
    onOpen: () => location.assign(LIKES_PATH),
    onDismiss: () => {
      store.set({ pillDismissed: true });
      removePill();
    },
  });
}

function removePill() {
  pill?.destroy();
  pill = null;
}

async function sync() {
  if (!chrome.runtime?.id) {
    clearInterval(poller);
    unmountPanel();
    removePill();
    return;
  }
  if (syncing) return;
  const handle = getOwnHandle();
  const onLikes = isOwnLikesPage(location.pathname, handle);
  const key = `${handle}|${location.pathname}`;
  if ((!handle && !onLikes) || key === lastKey) return;
  syncing = true;
  try {
    lastKey = key;
    const saved = await store.get();
    if (handle && saved.handle !== handle) store.set({ handle });
    if (onLikes) {
      removePill();
      if (!panel) mountPanel(saved, handle);
    } else {
      unmountPanel();
      if (handle && !pill && !saved.pillDismissed) mountPill();
    }
  } finally {
    syncing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!runner) return;
  if (document.hidden) runner.pause('hidden');
  else if (runner.state.pauseReason === 'hidden') runner.resume();
});

const poller = setInterval(sync, 500);
sync();

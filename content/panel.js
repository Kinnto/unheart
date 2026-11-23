import { createFeedbackForm } from './feedback.js';

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .light { --fg: #0f1419; --muted: #536471; --bg: #ffffff; --border: #cfd9de; --hover: #f7f9f9; }
  .dark { --fg: #e7e9ea; --muted: #8b98a5; --bg: #000000; --border: #2f3336; --hover: #16181c; }
  .light, .dark { --accent: #ff4d6d; --accent-fg: #ffffff; }
  .panel, .badge, .pill { position: fixed; z-index: 2147483647; color: var(--fg); background: var(--bg); border: 1px solid var(--border); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2); }
  .panel { width: 320px; border-radius: 20px; overflow: hidden; }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 12px 20px; cursor: grab; user-select: none; border-bottom: 1px solid var(--border); touch-action: none; }
  .title { font-weight: 700; font-size: 18px; }
  .icon-btn { border: 0; background: transparent; color: var(--fg); font-size: 22px; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; }
  .icon-btn:hover { background: var(--hover); }
  .body { padding: 18px 20px 20px; display: flex; flex-direction: column; gap: 16px; }
  .lines { display: flex; flex-direction: column; gap: 4px; }
  .line { font-size: 16px; line-height: 1.4; }
  .line.big { font-size: 28px; font-weight: 700; }
  .line.muted { color: var(--muted); font-size: 14px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .actions:empty { display: none; }
  .btn { border-radius: 9999px; padding: 12px 22px; font-size: 16px; font-weight: 700; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--fg); }
  .btn:hover { background: var(--hover); }
  .btn.primary { flex: 1; background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.primary:hover { filter: brightness(0.95); }
  .btn.link { flex-basis: 100%; border: 0; padding: 4px 0; font-size: 15px; font-weight: 400; color: var(--muted); text-decoration: underline; text-align: center; }
  .btn:focus-visible, .icon-btn:focus-visible, .badge:focus-visible, .pill button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .badge { right: 24px; top: 16px; border-radius: 9999px; padding: 12px 20px; font-size: 18px; font-weight: 700; cursor: pointer; }
  .pill { right: 24px; top: 16px; border-radius: 9999px; display: flex; align-items: center; overflow: hidden; }
  .pill button { border: 0; background: transparent; color: var(--fg); cursor: pointer; padding: 12px 16px; font-size: 17px; }
  .pill button:hover { background: var(--hover); }
  .pill .open { font-weight: 700; padding-left: 20px; }
  .feedback-link { align-self: flex-start; border: 0; background: transparent; padding: 0; font-size: 13px; color: var(--muted); text-decoration: underline; cursor: pointer; }
  .fb { display: flex; flex-direction: column; gap: 12px; }
  .fb-title { font-weight: 700; font-size: 17px; }
  .fb-choices { display: flex; gap: 8px; }
  .fb-choice { flex: 1; padding: 10px 8px; font-size: 14px; }
  .fb-choice.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--hover); }
  .fb-text { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; font-size: 15px; color: var(--fg); background: var(--bg); }
  .fb-text:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .fb-status:empty { display: none; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  [hidden] { display: none !important; }
`;

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function theme(doc) {
  const values = doc.defaultView.getComputedStyle(doc.body).backgroundColor.match(/[\d.]+/g);
  if (!values || (values.length === 4 && Number(values[3]) === 0)) return 'light';
  const [r, g, b] = values.map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128 ? 'dark' : 'light';
}

function mount(doc) {
  const host = el(doc, 'div', { 'data-unheart': '' });
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new doc.defaultView.CSSStyleSheet();
  sheet.replaceSync(STYLE);
  root.adoptedStyleSheets = [sheet];
  const wrap = el(doc, 'div', { class: theme(doc) });
  root.append(wrap);
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (event) => event.stopPropagation());
  doc.body.append(host);
  return { host, wrap };
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

export function createPanel({ doc = document, layout = {}, onAction, onLayout, onFeedbackSend }) {
  const { host, wrap } = mount(doc);
  const state = { x: layout.x ?? null, y: layout.y ?? null, minimized: Boolean(layout.minimized) };

  const panel = el(doc, 'div', { class: 'panel', role: 'region', 'aria-label': 'Unheart' });
  const header = el(doc, 'div', { class: 'header' });
  const minimize = el(doc, 'button', { class: 'icon-btn', 'aria-label': 'Minimize', title: 'Minimize' }, '–');
  header.append(el(doc, 'span', { class: 'title' }, 'Unheart'), minimize);
  const lines = el(doc, 'div', { class: 'lines', 'aria-live': 'polite' });
  const actions = el(doc, 'div', { class: 'actions' });
  const feedbackLink = el(doc, 'button', { class: 'feedback-link', 'data-fb': 'open', type: 'button' }, 'Feedback');
  feedbackLink.hidden = true;
  const body = el(doc, 'div', { class: 'body' });
  body.append(lines, actions, feedbackLink);
  panel.append(header, body);
  const badge = el(doc, 'button', { class: 'badge', 'aria-label': 'Expand Unheart' });
  wrap.append(panel, badge);

  function place() {
    if (state.x === null) {
      Object.assign(panel.style, { right: '24px', top: '16px', left: '', bottom: '' });
    } else {
      const win = doc.defaultView;
      state.x = clamp(state.x, 0, win.innerWidth - panel.offsetWidth);
      state.y = clamp(state.y, 0, win.innerHeight - panel.offsetHeight);
      Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px`, right: '', bottom: '' });
    }
    panel.hidden = state.minimized;
    badge.hidden = !state.minimized;
  }

  function setMinimized(minimized) {
    state.minimized = minimized;
    place();
    onLayout({ ...state });
  }

  minimize.addEventListener('click', () => setMinimized(true));
  badge.addEventListener('click', () => setMinimized(false));
  actions.addEventListener('click', (event) => {
    const id = event.target.closest('button')?.dataset.action;
    if (id) onAction(id);
  });

  let form = null;
  let feedbackAllowed = false;
  const showMain = (visible) => {
    lines.hidden = !visible;
    actions.hidden = !visible;
    feedbackLink.hidden = !visible || !feedbackAllowed;
  };
  function closeFeedback() {
    form?.destroy();
    form = null;
    showMain(true);
  }
  feedbackLink.addEventListener('click', () => {
    form = createFeedbackForm({ doc, onSend: onFeedbackSend, onClose: closeFeedback });
    body.append(form.el);
    showMain(false);
  });

  let drag = null;
  header.addEventListener('pointerdown', (event) => {
    if (event.target === minimize) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
  });
  header.addEventListener('pointermove', (event) => {
    if (!drag) return;
    state.x = event.clientX - drag.dx;
    state.y = event.clientY - drag.dy;
    place();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    onLayout({ ...state });
  };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
  doc.defaultView.addEventListener('resize', place);

  place();

  let lastLines = null;
  let lastActions = null;
  return {
    render(vm) {
      const linesKey = JSON.stringify(vm.lines);
      if (linesKey !== lastLines) {
        lastLines = linesKey;
        lines.replaceChildren(...vm.lines.map((l) => el(doc, 'div', { class: `line ${l.kind}` }, l.text)));
      }
      const actionsKey = JSON.stringify(vm.actions);
      if (actionsKey !== lastActions) {
        lastActions = actionsKey;
        actions.replaceChildren(
          ...vm.actions.map((a) => el(doc, 'button', { class: `btn ${a.style}`, 'data-action': a.id }, a.label)),
        );
      }
      feedbackAllowed = Boolean(vm.feedback && onFeedbackSend);
      if (!form) feedbackLink.hidden = !feedbackAllowed;
      badge.textContent = vm.badge ? `♡ ${vm.badge}` : '♡';
    },
    destroy() {
      form?.destroy();
      doc.defaultView.removeEventListener('resize', place);
      host.remove();
    },
  };
}

export function createPill({ doc = document, onOpen, onDismiss }) {
  const { host, wrap } = mount(doc);
  const pill = el(doc, 'div', { class: 'pill' });
  const open = el(doc, 'button', { class: 'open' }, '♡ Unlike your likes');
  const dismiss = el(doc, 'button', { 'aria-label': 'Dismiss', title: 'Dismiss' }, '×');
  open.addEventListener('click', onOpen);
  dismiss.addEventListener('click', onDismiss);
  pill.append(open, dismiss);
  wrap.append(pill);
  return {
    destroy() {
      host.remove();
    },
  };
}

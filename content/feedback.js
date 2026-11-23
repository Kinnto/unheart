import { MAX_MESSAGE } from './feedbackPayload.js';

const CHOICES = [
  ['works', '👍 Works great'],
  ['broken', "🐞 Something's wrong"],
];
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createFeedbackForm({ doc, onSend, onClose, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  const root = el(doc, 'div', { class: 'fb' });
  const title = el(doc, 'div', { class: 'fb-title' }, "How's Unheart working for you?");
  const choices = el(doc, 'div', { class: 'fb-choices' });
  const buttons = CHOICES.map(([value, label]) =>
    el(doc, 'button', { class: 'btn fb-choice', 'data-choice': value, 'aria-pressed': 'false', type: 'button' }, label),
  );
  choices.append(...buttons);
  const area = el(doc, 'textarea', { class: 'fb-text', placeholder: 'Tell us more (optional)', maxlength: String(MAX_MESSAGE), rows: '4' });
  const status = el(doc, 'div', { class: 'fb-status line muted', role: 'status' });
  const cancel = el(doc, 'button', { class: 'btn', 'data-fb': 'cancel', type: 'button' }, 'Cancel');
  const send = el(doc, 'button', { class: 'btn primary', 'data-fb': 'send', type: 'button' }, 'Send');
  const row = el(doc, 'div', { class: 'actions' });
  row.append(cancel, send);
  root.append(title, choices, area, status, row);

  let choice = null;
  let busy = false;
  let closed = false;

  const sync = () => {
    send.disabled = choice === null || busy;
    for (const b of buttons) {
      const on = b.dataset.choice === choice;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  sync();

  for (const type of KEY_EVENTS) area.addEventListener(type, (event) => event.stopPropagation());
  choices.addEventListener('click', (event) => {
    const value = event.target.closest('button')?.dataset.choice;
    if (!value || busy) return;
    choice = value;
    sync();
  });
  cancel.addEventListener('click', () => onClose());
  send.addEventListener('click', async () => {
    if (choice === null || busy) return;
    busy = true;
    status.textContent = 'Sending…';
    sync();
    let ok = false;
    try {
      ok = (await onSend({ choice, message: area.value })) === true;
    } catch {
      ok = false;
    }
    if (closed) return;
    if (ok) {
      status.textContent = 'Thanks! We read every message.';
      send.disabled = true;
      cancel.hidden = true;
      setTimer(() => {
        if (!closed) onClose();
      }, 3000);
    } else {
      busy = false;
      status.textContent = "Couldn't send. Please try again.";
      sync();
    }
  });

  return {
    el: root,
    destroy() {
      closed = true;
      root.remove();
    },
  };
}

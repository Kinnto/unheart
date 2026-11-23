import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFeedbackForm } from '../content/feedback.js';
import { createPanel } from '../content/panel.js';

const newDoc = () => new JSDOM('<!doctype html><html><body></body></html>').window.document;
const rootOf = (doc) => doc.querySelector('[data-unheart]').shadowRoot;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(onSend = async () => true) {
  const doc = newDoc();
  const closed = [];
  const timers = [];
  const form = createFeedbackForm({
    doc,
    onSend,
    onClose: () => closed.push(1),
    setTimer: (fn, ms) => timers.push([fn, ms]),
  });
  doc.body.append(form.el);
  const $ = (sel) => form.el.querySelector(sel);
  return { doc, form, closed, timers, $ };
}

test('shows the title, choices, textarea limited to 1000 chars', () => {
  const { $ } = setup();
  assert.equal($('.fb-title').textContent, "How's Unheart working for you?");
  assert.equal($('[data-choice="works"]').textContent, '👍 Works great');
  assert.equal($('[data-choice="broken"]').textContent, "🐞 Something's wrong");
  assert.equal($('textarea').getAttribute('placeholder'), 'Tell us more (optional)');
  assert.equal($('textarea').maxLength, 1000);
});

test('Send is disabled until a choice is selected, selection is highlighted', () => {
  const { $ } = setup();
  assert.equal($('[data-fb="send"]').disabled, true);
  $('[data-choice="broken"]').click();
  assert.equal($('[data-fb="send"]').disabled, false);
  assert.equal($('[data-choice="broken"]').classList.contains('selected'), true);
  assert.equal($('[data-choice="broken"]').getAttribute('aria-pressed'), 'true');
  $('[data-choice="works"]').click();
  assert.equal($('[data-choice="broken"]').classList.contains('selected'), false);
  assert.equal($('[data-choice="works"]').classList.contains('selected'), true);
});

test('Send passes choice and message, then shows thanks and auto-closes', async () => {
  const calls = [];
  const { $, closed, timers } = setup(async (payload) => { calls.push(payload); return true; });
  $('[data-choice="works"]').click();
  $('textarea').value = 'nice';
  $('[data-fb="send"]').click();
  assert.equal($('.fb-status').textContent, 'Sending…');
  assert.equal($('[data-fb="send"]').disabled, true);
  await flush();
  assert.deepEqual(calls, [{ choice: 'works', message: 'nice' }]);
  assert.equal($('.fb-status').textContent, 'Thanks! We read every message.');
  assert.equal(timers[0][1], 3000);
  assert.equal(closed.length, 0);
  timers[0][0]();
  assert.equal(closed.length, 1);
});

test('failure shows an error and re-enables Send', async () => {
  const { $ } = setup(async () => false);
  $('[data-choice="broken"]').click();
  $('[data-fb="send"]').click();
  await flush();
  assert.equal($('.fb-status').textContent, "Couldn't send. Please try again.");
  assert.equal($('[data-fb="send"]').disabled, false);
});

test('a rejected send is treated as failure', async () => {
  const { $ } = setup(async () => { throw new Error('x'); });
  $('[data-choice="broken"]').click();
  $('[data-fb="send"]').click();
  await flush();
  assert.equal($('.fb-status').textContent, "Couldn't send. Please try again.");
});

test('Cancel calls onClose', () => {
  const { $, closed } = setup();
  $('[data-fb="cancel"]').click();
  assert.equal(closed.length, 1);
});

test('keystrokes in the textarea never reach the page', () => {
  const doc = newDoc();
  const panel = createPanel({ doc, onAction: () => {}, onLayout: () => {}, onFeedbackSend: async () => true });
  panel.render({ badge: '', lines: [], actions: [], feedback: true });
  const root = rootOf(doc);
  root.querySelector('[data-fb="open"]').click();
  const seen = [];
  for (const type of ['keydown', 'keyup', 'keypress']) doc.addEventListener(type, () => seen.push(type));
  const area = root.querySelector('textarea');
  for (const type of ['keydown', 'keyup', 'keypress']) {
    area.dispatchEvent(new doc.defaultView.KeyboardEvent(type, { key: 'l', bubbles: true, composed: true }));
  }
  assert.deepEqual(seen, []);
});

test('keystrokes anywhere in the panel host are isolated from the page', () => {
  const doc = newDoc();
  const panel = createPanel({ doc, onAction: () => {}, onLayout: () => {} });
  panel.render({ badge: '', lines: [], actions: [{ id: 'pause', label: 'Pause', style: 'secondary' }] });
  let seen = 0;
  doc.addEventListener('keydown', () => seen++);
  rootOf(doc).querySelector('[data-action="pause"]').dispatchEvent(
    new doc.defaultView.KeyboardEvent('keydown', { key: 'n', bubbles: true, composed: true }),
  );
  assert.equal(seen, 0);
});

test('feedback link is hidden unless vm.feedback, and opens the form', () => {
  const doc = newDoc();
  const panel = createPanel({ doc, onAction: () => {}, onLayout: () => {}, onFeedbackSend: async () => true });
  const vm = { badge: '', lines: [{ text: 'a', kind: 'normal' }], actions: [] };
  panel.render(vm);
  assert.equal(rootOf(doc).querySelector('[data-fb="open"]').hidden, true);
  panel.render({ ...vm, feedback: true });
  const link = rootOf(doc).querySelector('[data-fb="open"]');
  assert.equal(link.hidden, false);
  assert.equal(link.textContent, 'Feedback');
  link.click();
  assert.ok(rootOf(doc).querySelector('.fb'));
  assert.equal(rootOf(doc).querySelector('.lines').hidden, true);
});

test('typed text and choice survive repeated render() calls', () => {
  const doc = newDoc();
  const panel = createPanel({ doc, onAction: () => {}, onLayout: () => {}, onFeedbackSend: async () => true });
  const vm = { badge: '1', lines: [{ text: '1 unliked', kind: 'big' }], actions: [], feedback: true };
  panel.render(vm);
  const root = rootOf(doc);
  root.querySelector('[data-fb="open"]').click();
  root.querySelector('[data-choice="works"]').click();
  const area = root.querySelector('textarea');
  area.value = 'half-typed';
  panel.render({ ...vm, badge: '2', lines: [{ text: '2 unliked', kind: 'big' }] });
  panel.render({ ...vm, badge: '3', lines: [{ text: '3 unliked', kind: 'big' }] });
  assert.equal(root.querySelector('textarea'), area);
  assert.equal(area.value, 'half-typed');
  assert.equal(root.querySelector('[data-choice="works"]').classList.contains('selected'), true);
});

test('Cancel returns to the normal view', () => {
  const doc = newDoc();
  const panel = createPanel({ doc, onAction: () => {}, onLayout: () => {}, onFeedbackSend: async () => true });
  panel.render({ badge: '', lines: [], actions: [], feedback: true });
  const root = rootOf(doc);
  root.querySelector('[data-fb="open"]').click();
  root.querySelector('[data-fb="cancel"]').click();
  assert.equal(root.querySelector('.fb'), null);
  assert.equal(root.querySelector('.lines').hidden, false);
});

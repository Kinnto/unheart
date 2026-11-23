import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPanel, createPill } from '../content/panel.js';

const newDoc = () => new JSDOM('<!doctype html><html><body></body></html>').window.document;
const rootOf = (doc) => doc.querySelector('[data-unheart]').shadowRoot;
const vm = {
  badge: '5',
  lines: [{ text: '5 unliked', kind: 'big' }],
  actions: [{ id: 'pause', label: 'Pause', style: 'secondary' }],
};

test('renders lines and forwards action clicks', () => {
  const doc = newDoc();
  const clicked = [];
  const panel = createPanel({ doc, onAction: (id) => clicked.push(id), onLayout: () => {} });
  panel.render(vm);
  const root = rootOf(doc);
  assert.equal(root.querySelector('.line.big').textContent, '5 unliked');
  root.querySelector('[data-action="pause"]').click();
  assert.deepEqual(clicked, ['pause']);
});

test('re-rendering identical actions keeps the same buttons', () => {
  const doc = newDoc();
  const panel = createPanel({ doc, onAction: () => {}, onLayout: () => {} });
  panel.render(vm);
  const button = rootOf(doc).querySelector('[data-action="pause"]');
  panel.render({ ...vm, lines: [{ text: '6 unliked', kind: 'big' }] });
  assert.equal(rootOf(doc).querySelector('[data-action="pause"]'), button);
});

test('minimize and expand report layout and toggle the badge', () => {
  const doc = newDoc();
  const layouts = [];
  const panel = createPanel({ doc, onAction: () => {}, onLayout: (l) => layouts.push(l) });
  panel.render(vm);
  const root = rootOf(doc);
  root.querySelector('.icon-btn').click();
  assert.equal(layouts.at(-1).minimized, true);
  assert.equal(root.querySelector('.panel').hidden, true);
  assert.equal(root.querySelector('.badge').hidden, false);
  assert.equal(root.querySelector('.badge').textContent, '♡ 5');
  root.querySelector('.badge').click();
  assert.equal(layouts.at(-1).minimized, false);
});

test('restores a saved position', () => {
  const doc = newDoc();
  createPanel({ doc, layout: { x: 10, y: 20, minimized: false }, onAction: () => {}, onLayout: () => {} });
  const panel = rootOf(doc).querySelector('.panel');
  assert.equal(panel.style.left, '10px');
  assert.equal(panel.style.top, '20px');
});

test('destroy removes the panel', () => {
  const doc = newDoc();
  createPanel({ doc, onAction: () => {}, onLayout: () => {} }).destroy();
  assert.equal(doc.querySelector('[data-unheart]'), null);
});

test('pill opens and dismisses', () => {
  const doc = newDoc();
  const events = [];
  createPill({ doc, onOpen: () => events.push('open'), onDismiss: () => events.push('dismiss') });
  const root = rootOf(doc);
  root.querySelector('.open').click();
  root.querySelector('[aria-label="Dismiss"]').click();
  assert.deepEqual(events, ['open', 'dismiss']);
});

test('clamps a saved position that is off-screen', () => {
  const doc = newDoc();
  createPanel({ doc, layout: { x: 5000, y: 5000, minimized: false }, onAction: () => {}, onLayout: () => {} });
  const panel = rootOf(doc).querySelector('.panel');
  const win = doc.defaultView;
  assert.equal(panel.style.left, `${win.innerWidth - panel.offsetWidth}px`);
  assert.equal(panel.style.top, `${win.innerHeight - panel.offsetHeight}px`);
});

test('re-rendering identical lines keeps the same line nodes', () => {
  const doc = newDoc();
  const panel = createPanel({ doc, onAction: () => {}, onLayout: () => {} });
  panel.render(vm);
  const line = rootOf(doc).querySelector('.line');
  panel.render({ ...vm, lines: [{ text: '5 unliked', kind: 'big' }] });
  assert.equal(rootOf(doc).querySelector('.line'), line);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { view } from '../content/view.js';

const base = {
  status: 'idle', removed: 0, failed: 0, limit: Infinity, removedAtStart: 0, startedAt: 0,
  finishedAt: null, slowdowns: 0, pauseReason: null, waitUntil: null, waitKind: null, endReason: null, error: null,
};
const ids = (vm) => vm.actions.map((a) => a.id);
const texts = (vm) => vm.lines.map((l) => l.text);

test('idle offers Unlike all and try 10', () => {
  const vm = view(base, { now: 0 });
  assert.deepEqual(ids(vm), ['start-all', 'start-10']);
  assert.equal(vm.actions[0].style, 'primary');
  assert.equal(vm.actions[1].style, 'link');
  assert.deepEqual(texts(vm), ['Tip: keep this tab visible — put its window side by side with your other work.']);
});

test('idle with saved progress offers Resume', () => {
  const vm = view(base, { now: 0, resumable: 1234 });
  assert.deepEqual(ids(vm), ['resume-run']);
  assert.deepEqual(texts(vm), ['1,234 removed so far.']);
});

test('confirming shows an irreversible warning', () => {
  const all = view(base, { now: 0, confirming: Infinity });
  assert.deepEqual(ids(all), ['cancel', 'confirm']);
  assert.equal(all.actions[1].label, 'Unlike all');
  assert.equal(view(base, { now: 0, confirming: 10 }).actions[1].label, 'Unlike 10');
});

test('running shows count and rate', () => {
  const state = { ...base, status: 'running', removed: 1040, removedAtStart: 1000, startedAt: 0 };
  const vm = view(state, { now: 60_000 });
  assert.deepEqual(texts(vm), ['1,040 unliked', '~40 / min']);
  assert.deepEqual(ids(vm), ['pause', 'stop']);
  assert.equal(vm.badge, '1,040');
});

test('running shows Starting before a rate exists', () => {
  const vm = view({ ...base, status: 'running', startedAt: 0 }, { now: 1000 });
  assert.equal(texts(vm)[1], 'Starting…');
});

test('courtesy break shows a countdown', () => {
  const state = { ...base, status: 'running', waitKind: 'courtesy', waitUntil: 61_000 };
  assert.equal(texts(view(state, { now: 1000 }))[1], 'Taking a short break — 1:00');
});

test('backing off shows a countdown and Resume now', () => {
  const state = { ...base, status: 'backing-off', removed: 312, waitKind: 'backoff', waitUntil: 222_000 };
  const vm = view(state, { now: 0 });
  assert.deepEqual(texts(vm), ['312 unliked', 'X is limiting requests.', 'Resuming in 3:42']);
  assert.deepEqual(ids(vm), ['resume-now', 'stop']);
});

test('paused by user vs paused because the tab is hidden', () => {
  assert.deepEqual(ids(view({ ...base, status: 'paused', pauseReason: 'user' }, { now: 0 })), ['resume', 'stop']);
  const hidden = view({ ...base, status: 'paused', pauseReason: 'hidden' }, { now: 0 });
  assert.deepEqual(ids(hidden), ['stop']);
  assert.match(texts(hidden)[1], /come back to this tab/);
});

test('done states', () => {
  assert.deepEqual(texts(view({ ...base, status: 'done', endReason: 'end' }, { now: 0 })), ['You have no likes to remove.']);
  const one = view({ ...base, status: 'done', endReason: 'end', removed: 1 }, { now: 0 });
  assert.equal(texts(one)[0], 'Done — 1 like removed.');
  assert.match(texts(one)[1], /Reload the page/);
  const withFailures = view({ ...base, status: 'done', endReason: 'end', removed: 1271, failed: 13 }, { now: 0, reviewAsked: true });
  assert.deepEqual(texts(withFailures).slice(0, 2), ['Done — 1,271 likes removed.', "13 didn't stick."]);
  assert.deepEqual(ids(withFailures), ['retry', 'share']);
  const limited = view({ ...base, status: 'done', endReason: 'limit', removed: 10 }, { now: 0 });
  assert.deepEqual(ids(limited), ['start-all', 'share']);
  assert.equal(limited.actions[0].label, 'Unlike the rest');
});

test('done offers Share on X only from 10 removed, not when stopped or empty', () => {
  const big = view({ ...base, status: 'done', endReason: 'end', removed: 1284 }, { now: 0, reviewAsked: true });
  assert.deepEqual(ids(big), ['share']);
  assert.equal(big.actions[0].label, 'Share on X');
  assert.deepEqual(ids(view({ ...base, status: 'done', endReason: 'end', removed: 5 }, { now: 0 })), []);
  assert.deepEqual(ids(view({ ...base, status: 'stopped', removed: 50 }, { now: 0 })), ['start-all']);
});

test('stopped offers Continue', () => {
  const vm = view({ ...base, status: 'stopped', removed: 5 }, { now: 0 });
  assert.deepEqual(texts(vm), ['Stopped — 5 likes removed.']);
  assert.deepEqual(ids(vm), ['start-all']);
});

const finished = (patch) => view({ ...base, status: 'done', endReason: 'end', startedAt: 1_000, ...patch }, { now: 0 });

test('done says how long the run took', () => {
  assert.equal(texts(finished({ removed: 1284, finishedAt: 1_000 + 14 * 60_000 + 20_000 }))[0], 'Done — 1,284 likes removed in 14 min.');
  assert.equal(texts(finished({ removed: 40, finishedAt: 1_000 + 89_000 }))[0], 'Done — 40 likes removed in 1 min.');
  assert.equal(texts(finished({ removed: 3, finishedAt: 1_000 + 59_000 }))[0], 'Done — 3 likes removed in under a minute.');
  assert.equal(texts(finished({ removed: 1, finishedAt: 1_000 + 61_000 }))[0], 'Done — 1 like removed in 1 min.');
});

test('done mentions X slowdowns only when there were any', () => {
  const none = finished({ removed: 50, finishedAt: 120_000, slowdowns: 0 });
  assert.ok(!texts(none).some((t) => /slowed/.test(t)));
  const once = finished({ removed: 50, finishedAt: 120_000, slowdowns: 1 });
  assert.ok(once.lines.some((l) => l.text === 'X slowed us down 1 time.' && l.kind === 'muted'));
  const twice = finished({ removed: 50, finishedAt: 120_000, slowdowns: 2, failed: 3 });
  assert.deepEqual(texts(twice), [
    'Done — 50 likes removed in 2 min.',
    "3 didn't stick.",
    'X slowed us down 2 times.',
    'X may hide some older likes. Reload the page and run again to catch them.',
  ]);
  assert.deepEqual(ids(twice), ['retry', 'share', 'rate']);
});

test('done combines duration, slowdowns, Share and a one-time Rate request', () => {
  const state = { ...base, status: 'done', endReason: 'end', startedAt: 0, finishedAt: 9 * 60_000, removed: 812, slowdowns: 3 };
  const vm = view(state, { now: 0, feedback: true });
  assert.deepEqual(texts(vm), [
    'Done — 812 likes removed in 9 min.',
    'X slowed us down 3 times.',
    'X may hide some older likes. Reload the page and run again to catch them.',
  ]);
  assert.deepEqual(ids(vm), ['share', 'rate']);
  assert.equal(vm.feedback, true);
  const asked = view(state, { now: 0, feedback: true, reviewAsked: true });
  assert.deepEqual(texts(asked), texts(vm));
  assert.deepEqual(ids(asked), ['share']);
  const limited = view({ ...state, endReason: 'limit' }, { now: 0 });
  assert.deepEqual(ids(limited), ['start-all', 'share', 'rate']);
  assert.ok(!texts(limited).some((t) => /Reload the page/.test(t)));
});

test('error states', () => {
  const broken = view({ ...base, status: 'error', error: 'selectors' }, { now: 0 });
  assert.match(texts(broken)[0], /needs an update/);
  assert.deepEqual(ids(broken), []);
  assert.deepEqual(ids(view({ ...base, status: 'error', error: 'unexpected' }, { now: 0 })), ['retry']);
});

test('feedback flag is passed through to the view model', () => {
  assert.equal(view(base, { now: 0 }).feedback, false);
  assert.equal(view(base, { now: 0, feedback: true }).feedback, true);
  assert.equal(view({ ...base, status: 'running' }, { now: 0, feedback: true }).feedback, true);
});

const done = (removed) => ({ ...base, status: 'done', removed, endReason: 'end' });

test('done offers a one-time review request at 50+ removed', () => {
  const vm = view(done(50), { now: 0 });
  const rate = vm.actions.find((a) => a.id === 'rate');
  assert.equal(rate.label, 'Rate Unheart ★');
  assert.equal(rate.style, 'link');
});

test('no review request below 50 or once already asked', () => {
  assert.equal(ids(view(done(49), { now: 0 })).includes('rate'), false);
  assert.equal(ids(view(done(500), { now: 0, reviewAsked: true })).includes('rate'), false);
});

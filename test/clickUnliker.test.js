import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClickUnliker, SelectorsBrokenError, CancelledError } from '../content/clickUnliker.js';
import { makeDoc, addPost, heart, showToast, showTimelineRetry } from './helpers/xdom.js';

function setup(posts, { onScroll = () => {}, hooks = [], shouldContinue } = {}) {
  const doc = makeDoc({ posts });
  const clock = { t: 0 };
  const calls = { scroll: 0, top: 0 };
  const unliker = createClickUnliker({
    doc,
    scroll: () => { calls.scroll++; onScroll(doc); },
    scrollToTop: () => { calls.top++; },
    sleep: async (ms) => { clock.t += ms; for (const hook of hooks) hook(clock.t, doc); },
    now: () => clock.t,
    ...(shouldContinue && { shouldContinue }),
  });
  return { doc, clock, calls, unliker };
}

const flipOnClick = (doc, id) =>
  heart(doc, id).addEventListener('click', (e) => e.currentTarget.setAttribute('data-testid', 'like'));

test('next returns liked posts in order, skipping unliked and already tried', async () => {
  const { unliker } = setup([{ id: '1' }, { id: '2', liked: false }, { id: '3' }]);
  assert.deepEqual(await unliker.next(), { id: '1', reverted: false });
  assert.deepEqual(await unliker.next(), { id: '3', reverted: false });
});

test('next scrolls to load more posts', async () => {
  let added = false;
  const { unliker, calls } = setup([], {
    onScroll: (doc) => { if (!added) { addPost(doc, { id: '9' }); added = true; } },
  });
  assert.deepEqual(await unliker.next(), { id: '9', reverted: false });
  assert.equal(calls.scroll, 1);
});

test('next returns null after 10s without new posts', async () => {
  const { unliker, clock } = setup([{ id: '1', liked: false }]);
  assert.equal(await unliker.next(), null);
  assert.ok(clock.t >= 10_000);
});

test('next throws SelectorsBrokenError when hearts are unrecognisable for 10s', async () => {
  const { unliker } = setup([{ id: '1', buttons: false }]);
  await assert.rejects(unliker.next(), SelectorsBrokenError);
});

test('unlike returns ok once the heart stays off for 0.4s', async () => {
  const { doc, unliker, clock } = setup([{ id: '1' }]);
  flipOnClick(doc, '1');
  const item = await unliker.next();
  assert.equal(await unliker.unlike(item), 'ok');
  assert.ok(clock.t >= 400 && clock.t < 600);
});

test('unlike returns failed when nothing happens', async () => {
  const { unliker } = setup([{ id: '1' }]);
  assert.equal(await unliker.unlike(await unliker.next()), 'failed');
});

test('unlike returns failed when the post is gone', async () => {
  const { unliker } = setup([]);
  assert.equal(await unliker.unlike({ id: '404', reverted: false }), 'failed');
});

test('unlike returns rate-limited when an error toast appears', async () => {
  const { doc, unliker } = setup([{ id: '1' }]);
  heart(doc, '1').addEventListener('click', () => showToast(doc, 'Something went wrong. Try reloading.'));
  assert.equal(await unliker.unlike(await unliker.next()), 'rate-limited');
});

test('unlike ignores an error toast that was already showing', async () => {
  const { doc, unliker } = setup([{ id: '1' }]);
  showToast(doc, 'Something went wrong.');
  flipOnClick(doc, '1');
  assert.equal(await unliker.unlike(await unliker.next()), 'ok');
});

test('unlike returns rate-limited when the heart reverts', async () => {
  let clickedAt = null;
  const { doc, unliker, clock } = setup([{ id: '1' }], {
    hooks: [(t, d) => { if (clickedAt !== null && t - clickedAt >= 500) heart(d, '1').setAttribute('data-testid', 'unlike'); }],
  });
  heart(doc, '1').addEventListener('click', (e) => { e.currentTarget.setAttribute('data-testid', 'like'); clickedAt = clock.t; });
  assert.equal(await unliker.unlike(await unliker.next()), 'rate-limited');
});

test('a counted unlike that reappears liked is returned as reverted, then given up', async () => {
  const { doc, unliker } = setup([{ id: '1' }]);
  flipOnClick(doc, '1');
  const item = await unliker.next();
  assert.equal(await unliker.unlike(item), 'ok');
  heart(doc, '1').setAttribute('data-testid', 'unlike');
  assert.deepEqual(await unliker.next(), { id: '1', reverted: true });
  assert.equal(await unliker.unlike({ id: '1' }), 'ok');
  heart(doc, '1').setAttribute('data-testid', 'unlike');
  assert.deepEqual(await unliker.next(), { id: '1', reverted: true, giveUp: true });
  assert.equal(await unliker.next(), null);
});

test('requeue makes an item available again', async () => {
  const { unliker } = setup([{ id: '1' }, { id: '2' }]);
  const first = await unliker.next();
  unliker.requeue(first);
  assert.equal((await unliker.next()).id, '1');
});

test('restart forgets unsuccessful attempts and scrolls to top', async () => {
  const { doc, unliker, calls } = setup([{ id: '1' }, { id: '2' }]);
  flipOnClick(doc, '1');
  await unliker.unlike(await unliker.next());
  await unliker.unlike(await unliker.next());
  assert.equal(await unliker.next(), null);
  unliker.restart();
  assert.equal(calls.top, 1);
  assert.equal((await unliker.next()).id, '2');
});

test('next rejects with CancelledError and never scrolls when shouldContinue is false', async () => {
  const { unliker, calls } = setup([{ id: '1', liked: false }], { shouldContinue: () => false });
  await assert.rejects(unliker.next(), CancelledError);
  assert.equal(calls.scroll, 0);
});

test('unlike rejects with CancelledError without clicking when shouldContinue is false', async () => {
  let go = true;
  const { doc, unliker } = setup([{ id: '1' }], { shouldContinue: () => go });
  let clicks = 0;
  heart(doc, '1').addEventListener('click', () => { clicks++; });
  const item = await unliker.next();
  go = false;
  await assert.rejects(unliker.unlike(item), CancelledError);
  assert.equal(clicks, 0);
});

test('a flipped heart whose post leaves the DOM before 0.4 s of stable un-like is failed, not ok', async () => {
  let clickedAt = null;
  const { doc, unliker } = setup([{ id: '1' }], {
    hooks: [(t, d) => { if (clickedAt !== null && t - clickedAt >= 300) heart(d, '1')?.closest('article').remove(); }],
  });
  heart(doc, '1').addEventListener('click', (e) => { e.currentTarget.setAttribute('data-testid', 'like'); clickedAt = 0; });
  assert.equal(await unliker.unlike(await unliker.next()), 'failed');
  assert.deepEqual(unliker.succeededIds(), []);
});

test('a post that leaves the DOM resets stability; back and stable for 0.4 s is ok', async () => {
  let clickedAt = null;
  let article = null;
  const { doc, unliker, clock } = setup([{ id: '1' }], {
    hooks: [(t, d) => {
      if (clickedAt === null) return;
      if (t - clickedAt === 300) { article = heart(d, '1').closest('article'); article.remove(); }
      if (t - clickedAt === 600) d.querySelector('main').append(article);
    }],
  });
  heart(doc, '1').addEventListener('click', (e) => { e.currentTarget.setAttribute('data-testid', 'like'); clickedAt = clock.t; });
  assert.equal(await unliker.unlike(await unliker.next()), 'ok');
  assert.ok(clock.t >= 1000, `ok only after 0.4 s stable since the post came back (t=${clock.t})`);
});

test('next({ allowScroll: false }) returns needsScroll instead of scrolling when no post is pickable', async () => {
  const { unliker, calls, clock } = setup([{ id: '1', liked: false }]);
  assert.deepEqual(await unliker.next({ allowScroll: false }), { needsScroll: true });
  assert.equal(calls.scroll, 0);
  assert.equal(clock.t, 0);
});

test('next({ allowScroll: false }) still returns a visible liked post', async () => {
  const { unliker } = setup([{ id: '1' }]);
  assert.deepEqual(await unliker.next({ allowScroll: false }), { id: '1', reverted: false });
});

test('next({ allowScroll: true }) scrolls to load more', async () => {
  let added = false;
  const { unliker, calls } = setup([], {
    onScroll: (doc) => { if (!added) { addPost(doc, { id: '9' }); added = true; } },
  });
  assert.deepEqual(await unliker.next({ allowScroll: true }), { id: '9', reverted: false });
  assert.equal(calls.scroll, 1);
});

test('next reports loadLimited on first sight of the timeline Retry button, without clicking', async () => {
  const { doc, unliker } = setup([{ id: '1', liked: false }]);
  let clicks = 0;
  showTimelineRetry(doc).addEventListener('click', () => { clicks++; });
  assert.deepEqual(await unliker.next(), { loadLimited: true });
  assert.equal(clicks, 0);
});

test('next clicks Retry when called again after a back-off, then returns new posts', async () => {
  const { doc, unliker } = setup([{ id: '1', liked: false }]);
  const retry = showTimelineRetry(doc);
  const clicks = [];
  retry.addEventListener('click', () => { clicks.push(1); addPost(doc, { id: '7' }); });
  assert.deepEqual(await unliker.next(), { loadLimited: true });
  assert.deepEqual(await unliker.next(), { id: '7', reverted: false });
  assert.equal(clicks.length, 1);
});

test('seeded succeeded ids are treated as reverted when still liked', async () => {
  const doc = makeDoc({ posts: [{ id: '1' }] });
  const unliker = createClickUnliker({ doc, scroll() {}, sleep: async () => {}, now: () => 0, initialSucceeded: ['1'] });
  assert.deepEqual(await unliker.next(), { id: '1', reverted: true });
});

test('succeededIds lists ids after successful unlikes', async () => {
  const { doc, unliker } = setup([{ id: '1' }]);
  flipOnClick(doc, '1');
  assert.equal(await unliker.unlike(await unliker.next()), 'ok');
  assert.deepEqual(unliker.succeededIds(), ['1']);
});

test('click clicks the heart and returns clicked; verify then returns ok', async () => {
  const { doc, unliker } = setup([{ id: '1' }]);
  let clicks = 0;
  heart(doc, '1').addEventListener('click', () => { clicks++; });
  flipOnClick(doc, '1');
  const item = await unliker.next();
  assert.equal(await unliker.click(item), 'clicked');
  assert.equal(clicks, 1);
  assert.equal(await unliker.verify(item), 'ok');
  assert.deepEqual(unliker.succeededIds(), ['1']);
});

test('click returns failed when the post or its heart is gone, and verify of it is failed', async () => {
  const { unliker } = setup([]);
  const item = { id: '404', reverted: false };
  assert.equal(await unliker.click(item), 'failed');
  assert.equal(await unliker.verify(item), 'failed');
});

test('click rejects with CancelledError without clicking when shouldContinue is false', async () => {
  let go = true;
  const { doc, unliker } = setup([{ id: '1' }], { shouldContinue: () => go });
  let clicks = 0;
  heart(doc, '1').addEventListener('click', () => { clicks++; });
  const item = await unliker.next();
  go = false;
  await assert.rejects(unliker.click(item), CancelledError);
  assert.equal(clicks, 0);
});

test('several items can be clicked before any is verified', async () => {
  const { doc, unliker } = setup([{ id: '1' }, { id: '2' }, { id: '3' }]);
  for (const id of ['1', '2', '3']) flipOnClick(doc, id);
  const items = [await unliker.next(), await unliker.next(), await unliker.next()];
  for (const item of items) assert.equal(await unliker.click(item), 'clicked');
  assert.deepEqual(await Promise.all(items.map((item) => unliker.verify(item))), ['ok', 'ok', 'ok']);
});

test('the toast baseline is taken at click time, per item', async () => {
  const { doc, unliker } = setup([{ id: '1' }, { id: '2' }]);
  flipOnClick(doc, '1');
  flipOnClick(doc, '2');
  const first = await unliker.next();
  const second = await unliker.next();
  assert.equal(await unliker.click(first), 'clicked');
  showToast(doc, 'Something went wrong. Try reloading.');
  assert.equal(await unliker.click(second), 'clicked');
  const results = await Promise.all([unliker.verify(first), unliker.verify(second)]);
  assert.deepEqual(results, ['rate-limited', 'ok']);
});

test('verify times its 3 s flip timeout from the click, not from the verify call', async () => {
  const { unliker, clock } = setup([{ id: '1' }]);
  const item = await unliker.next();
  await unliker.click(item);
  clock.t += 3000;
  assert.equal(await unliker.verify(item), 'failed');
  assert.ok(clock.t <= 3200, `verify kept polling until ${clock.t}`);
});

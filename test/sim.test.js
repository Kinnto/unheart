import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../tools/sim/simulate.js';
import { createClock, createFakeX, seeded } from '../tools/sim/fakeX.js';
import * as sel from '../content/selectors.js';

const POSTS = 300;

function assertHonest(r) {
  for (const p of r.phases) {
    assert.ok(p.removed <= p.actuallyUnliked, `${r.scenario}/${p.name}: removed ${p.removed} > unliked ${p.actuallyUnliked}`);
  }
  assert.ok(r.totalRemoved <= r.totalUnliked, `${r.scenario}: over-count ${r.totalRemoved} > ${r.totalUnliked}`);
  assert.equal(r.stats.relikes, 0, 'never re-likes a post');
}

const perMinute = (p) => p.actuallyUnliked / (p.simMs / 60_000);

function assertTerminated(r) {
  for (const p of r.phases) assert.equal(p.drive, 'settled', `${r.scenario}/${p.name} did not terminate: ${p.drive}`);
  assert.deepEqual(r.problems, []);
}

test('sim: the fake page speaks the markup selectors.js understands', async () => {
  const clock = createClock();
  const sim = createFakeX({ clock, random: seeded(1), posts: 100 });
  await clock.advance(1000);
  const posts = sel.listPosts(sim.doc);
  assert.equal(posts.length, 20);
  assert.ok(posts.every((p) => p.liked === true));
  for (let i = 0; i < 5; i++) {
    sim.scroll();
    await clock.advance(1000);
  }
  assert.ok(sel.listPosts(sim.doc).length <= 40, 'virtualised to at most 40 articles');
  sel.likedButtonOf(sel.listPosts(sim.doc)[0].article).click();
  assert.equal(sel.listPosts(sim.doc)[0].liked, false, 'optimistic flip');
  await clock.advance(1000);
  assert.equal(sim.likedCount(), 99);
});

test('sim default: everything unliked, counted exactly, nothing left', async () => {
  const r = await simulate({ posts: POSTS, scenario: 'default', seed: 1 });
  assertTerminated(r);
  assertHonest(r);
  assert.equal(r.remaining, 0);
  assert.equal(r.phases[0].removed, POSTS);
  assert.equal(r.phases[0].endReason, 'end');
  assert.equal(r.phases[0].slowdowns, 0);
});

test('sim noisy: isolated glitches cost no back-off; fast, honest, finishes the job', async () => {
  const r = await simulate({ posts: POSTS, scenario: 'noisy', seed: 1 });
  assertTerminated(r);
  assertHonest(r);
  assert.equal(r.remaining, 0);
  assert.equal(r.phases[0].slowdowns, 0);
  assert.ok(perMinute(r.phases[0]) >= 120, `noisy ran at ${perMinute(r.phases[0]).toFixed(1)}/min`);
});

test('sim limited: backs off at least once and never over-counts', async () => {
  const r = await simulate({ posts: POSTS, scenario: 'limited', seed: 1 });
  assertTerminated(r);
  assertHonest(r);
  assert.ok(r.phases[0].slowdowns >= 1);
  assert.ok(r.stats.rejectedLimit >= 1);
  assert.equal(r.remaining, 0);
  assert.ok(perMinute(r.phases[0]) >= 30, `limited ran at ${perMinute(r.phases[0]).toFixed(1)}/min`);
});

test('sim harsh: terminates and never over-counts', async () => {
  const r = await simulate({ posts: POSTS, scenario: 'harsh', seed: 1 });
  assertTerminated(r);
  assertHonest(r);
});

test('sim reuse: X reusing one toast node and leaving hearts grey still backs off, never over-counts', async () => {
  const r = await simulate({ posts: POSTS, scenario: 'reuse', seed: 1 });
  assertTerminated(r);
  assertHonest(r);
  assert.ok(r.phases[0].slowdowns >= 1);
  assert.ok(r.stats.rejectedLimit <= 40, `X refused ${r.stats.rejectedLimit} clicks`);
});

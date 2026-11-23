import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sel from '../content/selectors.js';
import { makeDoc, addPost, showToast, showTimelineRetry } from './helpers/xdom.js';

test('getOwnHandle reads the sidebar profile link', () => {
  assert.equal(sel.getOwnHandle(makeDoc({ handle: 'alice_99' })), 'alice_99');
  assert.equal(sel.getOwnHandle(makeDoc({ handle: null })), null);
});

test('isOwnLikesPage matches /i/history/likes or /<handle>/likes, case-insensitively', () => {
  assert.equal(sel.isOwnLikesPage('/i/history/likes', 'alice'), true);
  assert.equal(sel.isOwnLikesPage('/i/history/likes/', 'alice'), true);
  assert.equal(sel.isOwnLikesPage('/i/history', 'alice'), false);
  assert.equal(sel.isOwnLikesPage('/alice/likes', 'alice'), true);
  assert.equal(sel.isOwnLikesPage('/Alice/likes/', 'alice'), true);
  assert.equal(sel.isOwnLikesPage('/bob/likes', 'alice'), false);
  assert.equal(sel.isOwnLikesPage('/alice', 'alice'), false);
  assert.equal(sel.isOwnLikesPage('/alice/likes', null), false);
});

test('getPostId returns the main post id, not a quoted one', () => {
  const doc = makeDoc();
  const article = addPost(doc, { id: '111', quoted: { id: '222', author: 'carol' } });
  assert.equal(sel.getPostId(article), '111');
});

test('listPosts reports liked state per post', () => {
  const doc = makeDoc({ posts: [{ id: '1', liked: true }, { id: '2', liked: false }, { id: '3', buttons: false }] });
  assert.deepEqual(
    sel.listPosts(doc).map(({ id, liked }) => ({ id, liked })),
    [{ id: '1', liked: true }, { id: '2', liked: false }, { id: '3', liked: null }],
  );
});

test('findPost and likedButtonOf locate a post heart', () => {
  const doc = makeDoc({ posts: [{ id: '1' }, { id: '2' }] });
  const post = sel.findPost('2', doc);
  assert.equal(post.id, '2');
  assert.equal(sel.likedButtonOf(post.article).getAttribute('data-testid'), 'unlike');
  assert.equal(sel.findPost('404', doc), null);
});

test('findErrorToast only reports error-looking toasts', () => {
  const doc = makeDoc();
  assert.equal(sel.findErrorToast(doc), null);
  const toast = showToast(doc, 'Your post was sent.');
  assert.equal(sel.findErrorToast(doc), null);
  toast.textContent = 'Something went wrong. Try reloading.';
  assert.equal(sel.findErrorToast(doc), 'Something went wrong. Try reloading.');
});

test('looksBroken when posts exist but no hearts are recognised', () => {
  assert.equal(sel.looksBroken(makeDoc()), false);
  assert.equal(sel.looksBroken(makeDoc({ posts: [{ id: '1' }] })), false);
  assert.equal(sel.looksBroken(makeDoc({ posts: [{ id: '1', liked: false }] })), false);
  assert.equal(sel.looksBroken(makeDoc({ posts: [{ id: '1', buttons: false }] })), true);
});

test('findTimelineRetry finds the Retry button inside main', () => {
  const doc = makeDoc();
  const button = showTimelineRetry(doc);
  assert.equal(sel.findTimelineRetry(doc), button);
});

test('findTimelineRetry ignores other buttons and returns null when absent', () => {
  const doc = makeDoc({ posts: [{ id: '1' }] });
  assert.equal(sel.findTimelineRetry(doc), null);
  const other = doc.createElement('div');
  other.setAttribute('role', 'button');
  other.textContent = 'Retry later';
  doc.querySelector('main').append(other);
  assert.equal(sel.findTimelineRetry(doc), null);
});

test('lastArticle returns the last loaded post article, or null', () => {
  assert.equal(sel.lastArticle(makeDoc()), null);
  const doc = makeDoc({ posts: [{ id: '1' }, { id: '2' }] });
  const last = addPost(doc, { id: '3' });
  assert.equal(sel.lastArticle(doc), last);
});

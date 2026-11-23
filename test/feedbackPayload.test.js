import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedbackPayload, MAX_MESSAGE } from '../content/feedbackPayload.js';

const ok = { key: 'k', choice: 'works', message: ' hi ', version: '1.2.3' };

test('builds the Web3Forms payload with trimmed message', () => {
  assert.deepEqual(buildFeedbackPayload(ok), {
    access_key: 'k',
    subject: 'Unheart feedback: works',
    from_name: 'Unheart',
    choice: 'works',
    message: 'hi',
    version: '1.2.3',
    source: 'panel',
  });
});

test('rejects an empty key or unknown choice', () => {
  assert.equal(buildFeedbackPayload({ ...ok, key: '' }), null);
  assert.equal(buildFeedbackPayload({ ...ok, choice: 'spam' }), null);
  assert.equal(buildFeedbackPayload({ ...ok, choice: undefined }), null);
});

test('accepts the broken choice and caps the message', () => {
  const payload = buildFeedbackPayload({ ...ok, choice: 'broken', message: 'x'.repeat(5000) });
  assert.equal(payload.choice, 'broken');
  assert.equal(payload.message.length, MAX_MESSAGE);
});

test('non-string message becomes empty', () => {
  assert.equal(buildFeedbackPayload({ ...ok, message: { a: 1 } }).message, '');
});

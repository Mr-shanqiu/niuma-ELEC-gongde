import test from 'node:test';
import assert from 'node:assert/strict';
import { DownloadCountRateLimit } from '../dist/downloads/count-rate-limit.js';

test('limits one client without suppressing other clients and resets at the window boundary', () => {
  const limit = new DownloadCountRateLimit(1000, 2, 10, 5);
  assert.equal(limit.allow('a', 0), true);
  assert.equal(limit.allow('a', 1), true);
  assert.equal(limit.allow('a', 2), false);
  assert.equal(limit.allow('b', 2), true);
  assert.equal(limit.allow('a', 999), false);
  assert.equal(limit.allow('a', 1000), true);
});

test('bounds global writes and tracked identities without blocking later windows', () => {
  const limit = new DownloadCountRateLimit(1000, 5, 3, 2);
  assert.equal(limit.allow('a', 0), true);
  assert.equal(limit.allow('b', 1), true);
  assert.equal(limit.allow('c', 2), false, 'a full live map rejects new identities');
  assert.equal(limit.allow('a', 3), true);
  assert.equal(limit.allow('b', 4), false, 'global event budget is exhausted');
  assert.equal(limit.allow('c', 1001), true, 'expired identities make room');
});

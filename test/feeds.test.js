import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFeedAccess } from '../src/feeds.js';

test('passes when headers arrive, even for an HTTP error status', async () => {
  assert.equal(await checkFeedAccess('https://x', { fetchImpl: async () => ({ ok: true, status: 200 }) }), true);
  assert.equal(await checkFeedAccess('https://x', { fetchImpl: async () => ({ ok: false, status: 404 }) }), true);
});

test('fails on a network-level error (missing CORS looks like this)', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await checkFeedAccess('https://x', { fetchImpl }), false);
});

test('fails when no headers arrive within the timeout', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  assert.equal(await checkFeedAccess('https://x', { fetchImpl, timeoutMs: 20 }), false);
});

test('aborts the request after headers so the body is not downloaded', async () => {
  let signal;
  await checkFeedAccess('https://x', { fetchImpl: async (u, o) => ((signal = o.signal), { ok: true }) });
  assert.equal(signal.aborted, true);
});

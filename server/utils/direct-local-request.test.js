/** B-1699: /health publishes host-local details only to direct local callers. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isDirectLocalRequest, PROXY_HEADERS } from './direct-local-request.js';

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('a loopback peer without proxy headers is direct', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isDirectLocalRequest(req(peer)), true, peer);
  }
});

test('a loopback peer with any proxy header is not direct', () => {
  assert.deepEqual([...PROXY_HEADERS].sort(),
    ['cf-connecting-ip', 'forwarded', 'true-client-ip', 'via', 'x-forwarded-for', 'x-real-ip']);
  for (const name of PROXY_HEADERS) {
    assert.equal(isDirectLocalRequest(req('127.0.0.1', { [name]: '203.0.113.7' })), false, name);
  }
});

test('a non-loopback peer is never direct', () => {
  for (const peer of ['10.0.0.5', '100.64.1.2', '::ffff:192.168.1.4', undefined]) {
    assert.equal(isDirectLocalRequest(req(peer)), false, String(peer));
  }
  assert.equal(isDirectLocalRequest(null), false);
});

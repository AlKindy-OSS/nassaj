/**
 * client-ip — B-500: X-Forwarded-For is honoured only with a configured trusted
 * proxy hop count and a loopback peer; the default (tunnel) behaviour is unchanged.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { clientIp, trustedProxyHops } from './client-ip.js';

const ENV_KEY = 'NASSAJ_TRUSTED_PROXY_HOPS';
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

function req(remoteAddress: string, headers: Record<string, string | string[]> = {}) {
  return { socket: { remoteAddress }, headers };
}

test('default (no hops): XFF is ignored, cf-connecting-ip trusted only behind loopback', () => {
  delete process.env[ENV_KEY];
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientIp(req('192.0.2.5', { 'cf-connecting-ip': '198.51.100.7' })), '192.0.2.5');
});

test('one trusted hop behind loopback: the entry the proxy appended wins over spoofed ones', () => {
  process.env[ENV_KEY] = '1';
  // The client sent "XFF: 6.6.6.6"; nginx appended the real peer 203.0.113.9.
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(req('::1', { 'x-forwarded-for': ['6.6.6.6', '203.0.113.9'] })), '203.0.113.9');
  // A local proxy passes cf-connecting-ip through from the client: not trusted in proxy mode.
  assert.equal(
    clientIp(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '6.6.6.6' })),
    '203.0.113.9',
  );
});

test('two hops (edge LB then local nginx) read the client two entries from the right', () => {
  process.env[ENV_KEY] = '2';
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' })), '203.0.113.9');
});

test('spoofed XFF from an untrusted (non-loopback) hop is ignored even in proxy mode', () => {
  process.env[ENV_KEY] = '1';
  assert.equal(clientIp(req('192.0.2.5', { 'x-forwarded-for': '6.6.6.6' })), '192.0.2.5');
});

test('missing or non-IP forwarded entries fall back to the peer', () => {
  process.env[ENV_KEY] = '1';
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, not-an-ip' })), '127.0.0.1');
});

test('trustedProxyHops accepts 1..10 only; anything else is the default 0', () => {
  assert.equal(trustedProxyHops({}), 0);
  assert.equal(trustedProxyHops({ [ENV_KEY]: '' }), 0);
  assert.equal(trustedProxyHops({ [ENV_KEY]: '1' }), 1);
  assert.equal(trustedProxyHops({ [ENV_KEY]: ' 2 ' }), 2);
  assert.equal(trustedProxyHops({ [ENV_KEY]: '11' }), 0);
  assert.equal(trustedProxyHops({ [ENV_KEY]: '-1' }), 0);
  assert.equal(trustedProxyHops({ [ENV_KEY]: '1.5' }), 0);
  assert.equal(trustedProxyHops({ [ENV_KEY]: 'true' }), 0);
});

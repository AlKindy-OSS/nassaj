/**
 * ADR-227 / T-2098 stage 3a — the routing guard's local-engine ORIGIN rule.
 *
 * A caller-owned local model server is authorized by its full normalized origin
 * (scheme + host + explicit port, empty path), never by host alone, and the
 * operator escape hatch (NASSAJ_ALLOWED_ANTHROPIC_HOSTS, exempt from B-1541) can
 * no longer name a loopback/private host or a broad private suffix.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAnthropicBaseUrlAllowed,
  assertSettingsRoutingAllowed,
  isAnthropicHostAllowed,
  isUnsafeAllowedHostEntry,
  normalizeAuthorizedOrigin,
} from './anthropic-base-url-guard.js';
import { isEngineRoutedEnv } from './engine-anthropic-credential-guard.js';

const refused = (err) => err.code === 'ANTHROPIC_BASE_URL_NOT_ALLOWED';
const origins = (...raw) => new Set(raw.map((value) => normalizeAuthorizedOrigin(value)));

test('normalizeAuthorizedOrigin makes the port explicit and agrees across spellings', () => {
  assert.equal(normalizeAuthorizedOrigin('http://192.168.8.137:8080'), 'http://192.168.8.137:8080');
  assert.equal(normalizeAuthorizedOrigin('http://127.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normalizeAuthorizedOrigin('http://2130706433:8080/'), 'http://127.0.0.1:8080');
  assert.equal(normalizeAuthorizedOrigin('http://[0:0::1]:8080'), 'http://[::1]:8080');
  assert.equal(normalizeAuthorizedOrigin('http://[::ffff:127.0.0.1]:8080'), 'http://[::ffff:7f00:1]:8080');
  assert.equal(normalizeAuthorizedOrigin('https://box.example.ts.net'), 'https://box.example.ts.net:443');
  assert.equal(normalizeAuthorizedOrigin('http://localhost.:8080'), 'http://localhost:8080');
  assert.equal(normalizeAuthorizedOrigin('HTTP://LocalHost:80'), 'http://localhost:80');
});

test('normalizeAuthorizedOrigin refuses paths, credentials, queries and other schemes', () => {
  for (const raw of ['http://127.0.0.1:8080/v1', 'http://u:p@127.0.0.1:8080', 'http://127.0.0.1:8080/?a=1',
    'http://127.0.0.1:8080/#x', 'ftp://127.0.0.1', 'unix:///tmp/s', 'not a url', '', null]) {
    assert.equal(normalizeAuthorizedOrigin(raw), null, String(raw));
  }
});

test('the authorized local origin passes; the same host on another port does not', () => {
  const ctx = { engineOrigins: origins('http://127.0.0.1:18080') };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080' }, ctx));
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://127.1:18080/' }, ctx));
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://2130706433:18080' }, ctx));
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:18081' }, ctx), refused);
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://127.0.0.1:18080' }, ctx), refused);
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080/x' }, ctx), refused);
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://[::ffff:127.0.0.1]:18080' }, ctx),
    refused,
    'an IPv4-mapped spelling is a different origin string, so it is refused',
  );
});

test('IPv6 loopback origins match only their own normalized form and port', () => {
  const ctx = { engineOrigins: origins('http://[::1]:8080') };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://[0:0::1]:8080' }, ctx));
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://[::1]:8081' }, ctx), refused);
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080' }, ctx), refused);
});

test('default ports are explicit on both sides', () => {
  const ctx = { engineOrigins: origins('http://box.lan.example') };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://box.lan.example:80' }, ctx));
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://box.lan.example:8080' }, ctx), refused);
  const tls = { engineOrigins: origins('https://box.lan.example:443') };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://box.lan.example' }, tls));
});

test('an engine origin never authorizes the cloud routing vars or another *_BASE_URL', () => {
  const ctx = { engineOrigins: origins('http://127.0.0.1:18080') };
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_FOUNDRY_BASE_URL: 'http://127.0.0.1:18080' }, ctx), refused);
  assert.throws(() => assertAnthropicBaseUrlAllowed({ OPENAI_BASE_URL: 'http://127.0.0.1:18080' }, ctx), refused);
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({}, { ...ctx, extraValues: ['http://127.0.0.1:18080'] }),
    refused,
    'settings-file base URLs are never covered by the spawn origin',
  );
});

test('without an engine origin a loopback base URL stays refused', () => {
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080' }), refused);
});

test('NASSAJ_ALLOWED_ANTHROPIC_HOSTS ignores loopback, private and broad private entries', () => {
  for (const entry of ['localhost', 'foo.localhost', '127.0.0.1', '127.1', '2130706433', '10.0.0.5', '172.20.1.1',
    '192.168.8.137', '100.101.102.103', '169.254.1.1', '[::1]', '::1', '[0:0::1]', 'fd7a:115c:a1e0::1',
    '[fe80::1]', '[::ffff:127.0.0.1]', 'ts.net', 'example.ts.net', 'local', 'lan', 'home.arpa', 'llamabox']) {
    assert.equal(isUnsafeAllowedHostEntry(entry), true, entry);
  }
  for (const entry of ['proxy.example.com', 'gw.corp.example', 'other.host', 'box.example.ts.net', '8.8.8.8']) {
    assert.equal(isUnsafeAllowedHostEntry(entry), false, entry);
  }
  const env = { NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'localhost, 192.168.8.137, ts.net, proxy.example.com' };
  assert.equal(isAnthropicHostAllowed('localhost', env), false);
  assert.equal(isAnthropicHostAllowed('192.168.8.137', env), false);
  assert.equal(isAnthropicHostAllowed('box.example.ts.net', env), false);
  assert.equal(isAnthropicHostAllowed('proxy.example.com', env), true);
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ...env, ANTHROPIC_BASE_URL: 'http://localhost:8080' }), refused);
});

test('isEngineRoutedEnv treats a local origin as routed, even if the operator lists the host', () => {
  const local = origins('http://127.0.0.1:18080');
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080', NASSAJ_ALLOWED_ANTHROPIC_HOSTS: '127.0.0.1' };
  assert.equal(isEngineRoutedEnv(env, local), true);
  assert.equal(isEngineRoutedEnv(env), true);
  assert.equal(isEngineRoutedEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, local), false);
});

test('on a local-engine spawn no settings file may route, not even to Anthropic', () => {
  const local = { localEngine: true };
  assert.throws(
    () => assertSettingsRoutingAllowed({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, {}, 'project', local),
    refused,
  );
  assert.throws(() => assertSettingsRoutingAllowed({ env: { ANTHROPIC_UNIX_SOCKET: '/run/a.sock' } }, {}, 'p', local), refused);
  assert.throws(() => assertSettingsRoutingAllowed({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, {}, 'p', local), refused);
  assert.doesNotThrow(() => assertSettingsRoutingAllowed({ env: { CLAUDE_CODE_USE_BEDROCK: '0' } }, {}, 'p', local));
  assert.doesNotThrow(() => assertSettingsRoutingAllowed({ env: { FOO: 'bar' } }, {}, 'p', local));
  // The official path keeps its existing rule.
  assert.doesNotThrow(() => assertSettingsRoutingAllowed({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, {}, 'p'));
});

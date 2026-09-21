import assert from 'node:assert/strict';
import test from 'node:test';

import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';
import { wafeqAuthorizationValue } from '../../../shared/connector-api-key-auth.js';

import { probeConnectorApiKeyCandidate } from './connector-api-key-probe.js';
import type { SafeFetchResponse, SafeFetchTransport } from './connector-auth-safe-fetch.js';

const apiSpec = (service: string) => {
  const spec = providerAuthSpecFor(service);
  assert.ok(spec && spec.method === 'api_key');
  return spec;
};

const response = (value: unknown, status = 200): SafeFetchResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: (async function* body() { yield Buffer.from(JSON.stringify(value)); }()),
});

const CASES = [
  {
    service: 'github', url: 'https://api.github.com/user', method: 'GET',
    header: 'authorization', credential: 'Bearer secret', value: { id: 7, login: 'octocat' },
    subject: '7', kind: 'user',
  },
  {
    service: 'slack', url: 'https://slack.com/api/auth.test', method: 'POST',
    header: 'authorization', credential: 'Bearer secret',
    value: { ok: true, team_id: 'T123', user_id: 'U123' },
    subject: 'T123:U123', kind: 'user',
  },
  {
    service: 'figma', url: 'https://api.figma.com/v1/me', method: 'GET',
    header: 'x-figma-token', credential: 'secret', value: { id: '7', handle: 'designer' },
    subject: '7', kind: 'user',
  },
  {
    service: 'wafeq', url: 'https://api.wafeq.com/v1/organization/', method: 'GET',
    header: 'authorization', credential: 'Api-Key secret', value: { id: '7', name: 'Company' },
    subject: '7', kind: 'account',
  },
  {
    service: 'stripe', url: 'https://api.stripe.com/v1/account', method: 'GET',
    header: 'authorization', credential: 'Bearer secret',
    value: { id: 'acct_123', object: 'account' },
    subject: 'acct_123', kind: 'account',
  },
] as const;

test('every certified API-key probe pins its exact read-only request and parses identity', async () => {
  for (const item of CASES) {
    let calls = 0;
    const transport: SafeFetchTransport = async input => {
      calls += 1;
      assert.equal(input.url.href, new URL(item.url).href, item.service);
      assert.equal(input.method, item.method, item.service);
      assert.equal(input.headers[item.header], item.credential, item.service);
      if (item.service === 'github') {
        assert.equal(input.headers.accept, 'application/vnd.github+json');
        assert.equal(input.headers['user-agent'], 'nassaj-connector-probe');
        assert.equal(input.headers['x-github-api-version'], '2022-11-28');
      }
      assert.equal(input.body, null, item.service);
      assert.ok(input.timeoutMs <= 5_000, item.service);
      return response(item.value);
    };
    const evidence = await probeConnectorApiKeyCandidate({ spec: apiSpec(item.service), apiKey: 'secret' }, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
    });
    assert.deepEqual(evidence, { providerSubject: item.subject, identityKind: item.kind });
    assert.equal(calls, 1, item.service);
  }
});

test('Wafeq probe uses the exact authentication contract used by the shipped MCP client', async () => {
  const transport: SafeFetchTransport = async input => {
    assert.equal(input.headers.authorization, wafeqAuthorizationValue('secret'));
    assert.equal(input.headers['api-key'], undefined);
    return response({ id: '7', name: 'Company' });
  };
  await probeConnectorApiKeyCandidate({ spec: apiSpec('wafeq'), apiKey: 'secret' }, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport,
  });
});

test('malformed 2xx provider identities are rejected', async () => {
  const malformed = [
    ['github', { id: 0, login: 'octocat' }],
    ['github', { id: -1, login: 'octocat' }],
    ['github', { id: 1.5, login: 'octocat' }],
    ['github', { id: '7', login: 'octocat' }],
    ['github', { id: 7, login: '   ' }],
    ['slack', { ok: true, team_id: ' ', user_id: 'U123' }],
    ['slack', { ok: true, team_id: 'T123', user_id: '\t' }],
    ['figma', { id: '\n', handle: 'designer' }],
    ['figma', { id: '7', handle: '  ' }],
    ['wafeq', { id: ' ', name: 'Company' }],
    ['wafeq', { id: '7', name: '\t' }],
    ['stripe', { id: 'acct_', object: 'account' }],
    ['stripe', { id: 'acct_bad-id', object: 'account' }],
    ['stripe', { id: ' acct_123', object: 'account' }],
  ] as const;
  for (const [service, value] of malformed) {
    await assert.rejects(() => probeConnectorApiKeyCandidate(
      { spec: apiSpec(service), apiKey: 'secret' },
      {
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => response(value),
      },
    ), /candidate_rejected/u, service);
  }
});

test('2xx without the provider identity contract is rejected and oversized bodies stay bounded', async () => {
  for (const item of CASES) {
    await assert.rejects(() => probeConnectorApiKeyCandidate(
      { spec: apiSpec(item.service), apiKey: 'secret' },
      {
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => response({}),
      },
    ), /candidate_rejected/u, item.service);
  }
  await assert.rejects(() => probeConnectorApiKeyCandidate(
    { spec: apiSpec('github'), apiKey: 'secret' },
    {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => response({ id: 7, login: 'x'.repeat(40_000) }),
    },
  ), /body_too_large/u);
});

test('pending providers never reach DNS or transport', async () => {
  for (const service of [
    'salla', 'infomaniak-mail', 'infomaniak-contacts', 'viator',
    'getyourguide', 'tamara', 'geidea',
  ]) {
    let called = false;
    await assert.rejects(() => probeConnectorApiKeyCandidate(
      { spec: apiSpec(service), apiKey: 'unused' },
      {
        resolver: async () => { called = true; return []; },
        transport: async () => { called = true; return response({}); },
      },
    ), /not_certified/u, service);
    assert.equal(called, false, service);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  providerAuthSpecFor,
  type ByoAppSpec,
  type DcrPkceSpec,
} from '../../../shared/connector-auth-registry.js';

import {
  fetchCertifiedProviderMetadata,
  safeFetchProviderJson,
  type SafeFetchResolver,
  type SafeFetchResponse,
  type SafeFetchTransport,
} from './connector-auth-safe-fetch.js';

const notion = providerAuthSpecFor('notion') as DcrPkceSpec;
const google = providerAuthSpecFor('gmail') as ByoAppSpec;
const publicResolver: SafeFetchResolver = async () => [{ address: '93.184.216.34', family: 4 }];

const response = (
  status: number,
  value: string | Record<string, unknown>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): SafeFetchResponse => ({
  status,
  headers,
  body: (async function* body() {
    yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  }()),
});

const protectedMetadata = () => ({
  resource: notion.metadataExpectations.resource,
  authorization_servers: [notion.metadataExpectations.authorizationServer],
});

const authorizationMetadata = () => ({
  issuer: notion.metadataExpectations.issuer,
  authorization_endpoint: notion.metadataExpectations.authorizationEndpoint,
  token_endpoint: notion.metadataExpectations.tokenEndpoint,
  registration_endpoint: notion.metadataExpectations.registrationEndpoint,
  revocation_endpoint: notion.metadataExpectations.revocationEndpoint,
  scopes_supported: notion.minimumScopes,
  code_challenge_methods_supported: [notion.metadataExpectations.codeChallengeMethod],
  token_endpoint_auth_methods_supported: [notion.metadataExpectations.tokenEndpointAuthMethod],
});

test('certification fetch pins public DNS and validates every exact metadata expectation', async () => {
  const calls: Array<{ url: string; address: string }> = [];
  const transport: SafeFetchTransport = async input => {
    calls.push({ url: input.url.href, address: input.address });
    if (input.url.href === new URL(notion.endpoints.protectedResourceMetadata).href) {
      return response(200, protectedMetadata());
    }
    if (input.url.href === new URL(notion.endpoints.authorizationServerMetadata).href) {
      return response(200, authorizationMetadata(), { 'content-type': 'application/json; charset=utf-8' });
    }
    throw new Error('unexpected_test_endpoint');
  };
  const result = await fetchCertifiedProviderMetadata(notion, {
    resolver: publicResolver,
    transport,
  });
  assert.equal(result.authorizationServerMetadata.issuer, notion.expectedIssuer);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.address === '93.184.216.34'));
});

test('revocation reaches only the certified exact endpoint and accepts an empty success body', async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  await safeFetchProviderJson({
    spec: google,
    endpoint: 'revocation',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from('token=opaque-token'),
    responseMode: 'discard',
  }, {
    resolver: publicResolver,
    transport: async input => {
      calls.push({ url: input.url.href, method: input.method, body: input.body?.toString() ?? '' });
      return response(200, '', {});
    },
  });
  assert.deepEqual(calls, [{
    url: google.endpoints.revocation,
    method: 'POST',
    body: 'token=opaque-token',
  }]);
});

test('DCR revocation is pinned to the exact endpoint declared by verified metadata', async () => {
  let calls = 0;
  await safeFetchProviderJson({
    spec: notion,
    endpoint: 'revocation',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from('token=opaque-token'),
    responseMode: 'discard',
  }, {
    resolver: publicResolver,
    transport: async input => {
      calls += 1;
      assert.equal(input.url.href, new URL(notion.metadataExpectations.revocationEndpoint).href);
      assert.equal(input.method, 'POST');
      return response(200, '', { 'content-type': 'text/plain' });
    },
  });
  assert.equal(calls, 1);
});

test('private, loopback, link-local, multicast, and mapped-private addresses never reach transport', async () => {
  for (const address of [
    '10.0.0.1', '127.0.0.1', '169.254.2.3', '192.88.99.1', '224.0.0.1',
    '::1', '::10.0.0.1', '::ffff:127.0.0.1',
    '64:ff9b::a00:1', '64:ff9b:1:a00:0:100::',
    '100::1', '2001::1', '2001:2::1', '2001:db8::1', '2002:a00:1::1',
    '3fff::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1',
  ]) {
    let connected = false;
    await assert.rejects(() => safeFetchProviderJson({
      spec: notion,
      endpoint: 'protectedResourceMetadata',
    }, {
      resolver: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      transport: async () => {
        connected = true;
        return response(200, {});
      },
    }), /address_forbidden/);
    assert.equal(connected, false, address);
  }
});

test('global IPv6 and NAT64-wrapped public IPv4 may reach the exact endpoint', async () => {
  for (const address of ['2606:4700:4700::1111', '64:ff9b::5db8:d822', '::ffff:93.184.216.34']) {
    let connected = false;
    await safeFetchProviderJson({
      spec: notion,
      endpoint: 'protectedResourceMetadata',
    }, {
      resolver: async () => [{ address, family: 6 }],
      transport: async () => {
        connected = true;
        return response(200, {});
      },
    });
    assert.equal(connected, true, address);
  }
});

test('a DNS family mismatch fails closed before transport', async () => {
  let connected = false;
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: async () => [{ address: '93.184.216.34', family: 6 }],
    transport: async () => {
      connected = true;
      return response(200, {});
    },
  }), /address_forbidden/);
  assert.equal(connected, false);
});

test('redirect targets must be an exact registry endpoint and allowed origin', async () => {
  let resolutions = 0;
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: async () => {
      resolutions += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
    transport: async () => response(302, '', {
      location: 'https://evil.example/steal',
      'content-type': 'application/json',
    }),
  }), /redirect_not_allowed/);
  assert.equal(resolutions, 1, 'the escaped hostname is rejected before its DNS can be queried');
});

test('authorization is never forwarded to another origin', async () => {
  let calls = 0;
  let resolutions = 0;
  await assert.rejects(() => safeFetchProviderJson({
    spec: google,
    endpoint: 'token',
    method: 'POST',
    headers: { authorization: 'Basic secret' },
    body: Buffer.from('{}'),
  }, {
    resolver: async () => {
      resolutions += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
    transport: async () => {
      calls += 1;
      return response(307, '', {
        location: google.endpoints.authorization,
        'content-type': 'application/json',
      });
    },
  }), /endpoint_not_allowed/);
  assert.equal(calls, 1, 'cross-origin endpoint is rejected before a second request');
  assert.equal(resolutions, 1, 'cross-origin endpoint is rejected before another DNS lookup');
});

test('changed DNS answers across exact redirect hops fail as rebinding before reconnect', async () => {
  let resolution = 0;
  let connections = 0;
  const resolver: SafeFetchResolver = async () => [{
    address: resolution++ === 0 ? '93.184.216.34' : '93.184.216.35',
    family: 4,
  }];
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver,
    transport: async () => {
      connections += 1;
      return response(302, '', {
        location: notion.endpoints.authorizationServerMetadata,
        'content-type': 'application/json',
      });
    },
  }), /dns_rebinding/);
  assert.equal(connections, 1);
});

test('exact redirect cycles stop at the configured limit', async () => {
  let calls = 0;
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: publicResolver,
    maxRedirects: 1,
    transport: async input => {
      calls += 1;
      const location = input.url.href === new URL(notion.endpoints.protectedResourceMetadata).href
        ? notion.endpoints.authorizationServerMetadata
        : notion.endpoints.protectedResourceMetadata;
      return response(302, '', { location, 'content-type': 'application/json' });
    },
  }), /redirect_limit/);
  assert.equal(calls, 2);
});

test('oversized JSON bodies are rejected while streaming', async () => {
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: publicResolver,
    maxResponseBytes: 16,
    transport: async () => response(200, { oversized: 'x'.repeat(64) }),
  }), /body_too_large/);
});

test('content type and JSON object shape are strict', async t => {
  await t.test('rejects non-JSON content type', async () => {
    await assert.rejects(() => safeFetchProviderJson({
      spec: notion,
      endpoint: 'protectedResourceMetadata',
    }, {
      resolver: publicResolver,
      transport: async () => response(200, '{}', { 'content-type': 'text/html' }),
    }), /content_type_invalid/);
  });
  await t.test('rejects malformed JSON', async () => {
    await assert.rejects(() => safeFetchProviderJson({
      spec: notion,
      endpoint: 'protectedResourceMetadata',
    }, {
      resolver: publicResolver,
      transport: async () => response(200, '{bad-json'),
    }), /json_invalid/);
  });
  await t.test('rejects JSON arrays', async () => {
    await assert.rejects(() => safeFetchProviderJson({
      spec: notion,
      endpoint: 'protectedResourceMetadata',
    }, {
      resolver: publicResolver,
      transport: async () => response(200, '[]'),
    }), /json_invalid/);
  });
});

test('transport and body failures expose stable redacted codes only', async () => {
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: publicResolver,
    transport: async () => { throw new Error('secret provider socket detail'); },
  }), error => error instanceof Error
    && error.message === 'connector_fetch_transport_failed'
    && !error.message.includes('secret'));

  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: publicResolver,
    transport: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: (async function* body() {
        throw new Error('secret response detail');
      }()),
    }),
  }), error => error instanceof Error
    && error.message === 'connector_fetch_body_failed'
    && !error.message.includes('secret'));
});

test('timeout is enforced even when an injected transport never settles', async () => {
  let abortObserved = false;
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: publicResolver,
    timeoutMs: 10,
    transport: async input => new Promise<SafeFetchResponse>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => {
        abortObserved = true;
        reject(new Error('underlying transport aborted'));
      }, { once: true });
    }),
  }), /fetch_timeout/);
  assert.equal(abortObserved, true, 'central timeout aborts the underlying transport');
});

test('deadline also aborts a response body that stalls after headers', async () => {
  let cancelled = false;
  const stalledResponse: SafeFetchResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: (async function* body() {
      yield Buffer.from('{');
      await new Promise(() => undefined);
    }()),
    cancel: () => {
      cancelled = true;
      throw new Error('provider socket detail must stay redacted');
    },
  };
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
  }, {
    resolver: publicResolver,
    timeoutMs: 10,
    transport: async () => stalledResponse,
  }), /fetch_timeout/);
  assert.equal(cancelled, true);
});

test('metadata activation rejects exact issuer/auth/token/register drift', async () => {
  const transport: SafeFetchTransport = async input => response(200,
    input.url.href === new URL(notion.endpoints.protectedResourceMetadata).href
      ? protectedMetadata()
      : { ...authorizationMetadata(), token_endpoint: 'https://mcp.notion.com/token-v2' });
  await assert.rejects(() => fetchCertifiedProviderMetadata(notion, {
    resolver: publicResolver,
    transport,
  }), /metadata_expectations_failed/);
});

test('method and header allowlists reject unsafe caller-controlled transport options', async () => {
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
    method: 'POST',
  }, { resolver: publicResolver, transport: async () => response(200, {}) }), /endpoint_not_allowed/);
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
    headers: { cookie: 'secret=value' },
  }, { resolver: publicResolver, transport: async () => response(200, {}) }), /header_not_allowed/);
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'protectedResourceMetadata',
    headers: { authorization: 'Bearer secret' },
  }, { resolver: publicResolver, transport: async () => response(200, {}) }), /header_not_allowed/);
  await assert.rejects(() => safeFetchProviderJson({
    spec: notion,
    endpoint: 'token',
    method: 'POST',
    headers: { authorization: 'Bearer secret\r\nX-Leak: yes' },
  }, { resolver: publicResolver, transport: async () => response(200, {}) }), /header_not_allowed/);
});

test('a forged provider spec cannot turn the transport into a user-selected URL fetcher', async () => {
  const forged = {
    ...notion,
    endpoints: { ...notion.endpoints, protectedResourceMetadata: 'https://evil.example/meta' },
  } as DcrPkceSpec;
  await assert.rejects(() => safeFetchProviderJson({
    spec: forged,
    endpoint: 'protectedResourceMetadata',
  }, { resolver: publicResolver, transport: async () => response(200, {}) }), /untrusted_provider_spec/);
});

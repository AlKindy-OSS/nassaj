import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  pinnedFetchJson,
  pinnedFetchLogFields,
  PinnedFetchError,
  safeOauthError,
  type PinnedFetchDependencies,
  type PinnedFetchInput,
} from './pinned-fetch.js';
import {
  createDefaultTransport,
  sniServername,
  type PinnedResponse,
  type PinnedTransport,
} from './pinned-transport.js';

const PUBLIC_ADDRESS = '93.184.216.34';
const noInterfaces = () => new Set<string>();

const response = (
  status: number,
  value: string | Record<string, unknown>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): PinnedResponse => ({
  status,
  headers,
  body: (async function* body() {
    yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  }()),
});

type Call = { url: string; address: string; method: string; headers: Record<string, string>; body: string };

function harness(answers: Array<{ address: string; family: 4 | 6 }>, reply: (call: Call) => PinnedResponse) {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const deps: PinnedFetchDependencies = {
    resolver: async (hostname) => {
      lookups.push(hostname);
      return answers;
    },
    transport: async (input) => {
      const call = {
        url: input.url.href, address: input.address, method: input.method,
        headers: { ...input.headers }, body: input.body?.toString() ?? '',
      };
      calls.push(call);
      return reply(call);
    },
    interfaceAddresses: noInterfaces,
  };
  return { calls, lookups, deps };
}

const base = (overrides: Partial<PinnedFetchInput> = {}): PinnedFetchInput => ({
  url: 'https://idp.example/.well-known/openid-configuration',
  method: 'GET', addressPolicy: 'public', maxBytes: 64 * 1024, ...overrides,
});

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => error instanceof PinnedFetchError && error.code === code);
};

test('a public JSON fetch connects to the pinned address with the original hostname', async () => {
  const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, { issuer: 'https://idp.example' }));
  const result = await pinnedFetchJson(base(), h.deps);
  assert.deepEqual(result, { status: 200, json: { issuer: 'https://idp.example' } });
  assert.equal(h.calls[0].address, PUBLIC_ADDRESS);
  assert.equal(h.calls[0].headers.accept, 'application/json');
  assert.deepEqual(h.lookups, ['idp.example']);
});

test('every A/AAAA answer must pass: one blocked address refuses the whole host', async () => {
  const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }, { address: '::1', family: 6 }], () => response(200, {}));
  await rejectsWith(pinnedFetchJson(base(), h.deps), 'fetch_address_blocked:loopback');
  assert.equal(h.calls.length, 0);
});

test('policy matrix through the fetch: private reach needs private_allowed; transition forms never pass', async () => {
  for (const [address, family, code] of [
    ['10.1.2.3', 4, 'fetch_address_blocked:private'], ['100.80.1.1', 4, 'fetch_address_blocked:cgnat'],
    ['fd12::1', 6, 'fetch_address_blocked:ula'],
  ] as const) {
    const h = harness([{ address, family }], () => response(200, {}));
    await rejectsWith(pinnedFetchJson(base(), h.deps), code);
    const allowed = await pinnedFetchJson(base({ addressPolicy: 'private_allowed' }), h.deps);
    assert.equal(allowed.status, 200, address);
  }
  for (const [address, category] of [
    ['2002:a00:1::1', '6to4'], ['2001::5', 'teredo'], ['64:ff9b::a00:1', 'nat64'],
    ['100.100.100.100', 'tailnet_resolver'], ['fd7a:115c:a1e0::53', 'tailnet_resolver'],
  ] as const) {
    const h = harness([{ address, family: address.includes(':') ? 6 : 4 }], () => response(200, {}));
    for (const addressPolicy of ['public', 'private_allowed'] as const) {
      await rejectsWith(pinnedFetchJson(base({ addressPolicy }), h.deps), `fetch_address_blocked:${category}`);
    }
    assert.equal(h.calls.length, 0, address);
  }
});

test('this host\'s own interface addresses are blocked under both policies', async () => {
  const deps = {
    ...harness([{ address: '100.105.15.56', family: 4 }], () => response(200, {})).deps,
    interfaceAddresses: () => new Set(['v4:100.105.15.56']),
  };
  for (const addressPolicy of ['public', 'private_allowed'] as const) {
    await rejectsWith(pinnedFetchJson(base({ addressPolicy }), deps), 'fetch_address_blocked:own_interface');
  }
});

test('a DNS family mismatch, an empty answer and a resolver failure fail closed', async () => {
  const mismatch = harness([{ address: PUBLIC_ADDRESS, family: 6 }], () => response(200, {}));
  await rejectsWith(pinnedFetchJson(base(), mismatch.deps), 'fetch_address_blocked:family_mismatch');
  const empty = harness([], () => response(200, {}));
  await rejectsWith(pinnedFetchJson(base(), empty.deps), 'fetch_dns_failed');
  await rejectsWith(pinnedFetchJson(base(), {
    ...empty.deps, resolver: async () => { throw new Error('ENOTFOUND secret.host'); },
  }), 'fetch_dns_failed');
});

test('ports: private_allowed accepts 443 or the single explicit port only; nassaj\'s port is always blocked', async () => {
  const h = harness([{ address: '10.0.0.5', family: 4 }], () => response(200, {}));
  const priv = { addressPolicy: 'private_allowed' as const };
  assert.equal((await pinnedFetchJson(base({ ...priv, url: 'https://idp.lan/x' }), h.deps)).status, 200);
  await rejectsWith(pinnedFetchJson(base({ ...priv, url: 'https://idp.lan:8443/x' }), h.deps), 'fetch_port_blocked');
  assert.equal((await pinnedFetchJson(base({ ...priv, url: 'https://idp.lan:8443/x', allowedPort: 8443 }), h.deps))
    .status, 200);
  await rejectsWith(pinnedFetchJson(base({ ...priv, url: 'https://idp.lan/x', allowedPort: 8443 }), h.deps),
    'fetch_port_blocked');
  const pub = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, {}));
  assert.equal((await pinnedFetchJson(base({ url: 'https://idp.example:8443/x' }), pub.deps)).status, 200);
  const nassajPort = Number(process.env.PORT || 3004);
  await rejectsWith(pinnedFetchJson(base({ url: `https://idp.example:${nassajPort}/x` }), pub.deps),
    'fetch_port_blocked');
  await rejectsWith(pinnedFetchJson(base({ url: 'https://idp.example:9000/x', blockedPorts: [9000] }), pub.deps),
    'fetch_port_blocked');
  await rejectsWith(pinnedFetchJson(base({ allowedPort: 8443 }), pub.deps), 'fetch_request_invalid');
});

test('the metadata hostname is refused before any DNS lookup', async () => {
  const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, {}));
  await rejectsWith(pinnedFetchJson(base({ url: 'https://METADATA.google.internal./x' }), h.deps),
    'fetch_address_blocked:metadata');
  assert.equal(h.lookups.length, 0);
});

test('IP literals are classified directly (brackets stripped) and need no DNS name', async () => {
  const h = harness([{ address: '::1', family: 6 }], () => response(200, {}));
  await rejectsWith(pinnedFetchJson(base({ url: 'https://[::1]/x' }), h.deps), 'fetch_address_blocked:loopback');
  assert.deepEqual(h.lookups, ['::1']);
});

test('input validation: https only, no userinfo or fragment, bounded body, known headers', async () => {
  const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, {}));
  for (const input of [
    base({ url: 'http://idp.example/x' }), base({ url: 'https://u:p@idp.example/x' }),
    base({ url: 'https://idp.example/x#frag' }), base({ url: 'not a url' }),
    base({ body: 'x' }), base({ method: 'POST', body: 'x'.repeat(64 * 1024 + 1) }),
    base({ headers: { cookie: 'a' } as never }), base({ headers: { authorization: 'a\r\nb' } }),
    base({ timeoutMs: 5001 }), base({ timeoutMs: 0 }), base({ maxRedirects: 4 as never }),
    base({ maxBytes: 0 }), base({ maxBytes: 2 * 1024 * 1024 }), base({ method: 'PUT' as never }),
    base({ addressPolicy: 'any' as never }), base({ blockedPorts: [70000] }),
    base({ addressPolicy: 'private_allowed', allowedPort: 0 }),
  ]) {
    await rejectsWith(pinnedFetchJson(input, h.deps), 'fetch_request_invalid');
  }
  assert.equal(h.calls.length, 0);
});

test('POST sends the body and allowed headers', async () => {
  const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, { access_token: 'x' }));
  await pinnedFetchJson(base({
    url: 'https://idp.example/token', method: 'POST', body: 'grant_type=authorization_code',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic abc' },
  }), h.deps);
  assert.equal(h.calls[0].body, 'grant_type=authorization_code');
  assert.equal(h.calls[0].headers.authorization, 'Basic abc');
});

test('redirects: refused at maxRedirects 0; each followed hop is re-validated', async () => {
  const redirect = (location: string) => response(302, '', { location });
  const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => redirect('https://idp.example/next'));
  await rejectsWith(pinnedFetchJson(base(), h.deps), 'fetch_redirect_refused');
  assert.equal(h.calls.length, 1);

  let hop = 0;
  const two = harness([{ address: PUBLIC_ADDRESS, family: 4 }],
    () => (hop++ === 0 ? redirect('/second') : response(200, { ok: true })));
  assert.deepEqual((await pinnedFetchJson(base({ maxRedirects: 1 }), two.deps)).json, { ok: true });
  assert.equal(two.calls[1].url, 'https://idp.example/second');

  for (const location of ['http://idp.example/x', 'https://idp.example:3004/x', 'https://a:b@idp.example/']) {
    const bad = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => redirect(location));
    await assert.rejects(pinnedFetchJson(base({ maxRedirects: 3 }), bad.deps),
      (error: unknown) => error instanceof PinnedFetchError
        && ['fetch_redirect_refused', 'fetch_port_blocked'].includes(error.code));
    assert.equal(bad.calls.length, 1, location);
  }
});

test('redirect to a host that resolves to a blocked address is refused before connecting', async () => {
  let hop = 0;
  const deps: PinnedFetchDependencies = {
    resolver: async (hostname) => [{ address: hostname === 'idp.example' ? PUBLIC_ADDRESS : '10.0.0.1', family: 4 }],
    transport: async () => {
      hop += 1;
      return response(302, '', { location: 'https://internal.example/' });
    },
    interfaceAddresses: noInterfaces,
  };
  await rejectsWith(pinnedFetchJson(base({ maxRedirects: 2 }), deps), 'fetch_address_blocked:private');
  assert.equal(hop, 1);
});

test('authorization is dropped across origins and POST follows only same-origin 307/308', async () => {
  let hop = 0;
  const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => (hop++ === 0
    ? response(302, '', { location: 'https://other.example/keys' })
    : response(200, {})));
  await pinnedFetchJson(base({ headers: { authorization: 'Basic x' }, maxRedirects: 1 }), h.deps);
  assert.equal(h.calls[1].headers.authorization, undefined, 'GET across origins drops authorization');

  // S9 L1: a POST body (a token request with the client secret) never crosses origins.
  for (const status of [307, 308]) {
    const cross = harness([{ address: PUBLIC_ADDRESS, family: 4 }],
      () => response(status, '', { location: 'https://other.example/token' }));
    await rejectsWith(pinnedFetchJson(base({
      method: 'POST', body: 'a=b', headers: { authorization: 'Basic x' }, maxRedirects: 1,
    }), cross.deps), 'fetch_redirect_refused');
    assert.equal(cross.calls.length, 1, `cross-origin ${status} POST is never sent`);
  }
  let sameHop = 0;
  const same = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => (sameHop++ === 0
    ? response(308, '', { location: '/token2' })
    : response(200, {})));
  await pinnedFetchJson(base({
    method: 'POST', body: 'a=b', headers: { authorization: 'Basic x' }, maxRedirects: 1,
  }), same.deps);
  assert.equal(same.calls[1].headers.authorization, 'Basic x', 'same-origin 308 keeps the request');
  const see = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(303, '', { location: '/x' }));
  await rejectsWith(pinnedFetchJson(base({ method: 'POST', body: 'a', maxRedirects: 1 }), see.deps),
    'fetch_redirect_refused');
  const missing = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(302, '', {}));
  await rejectsWith(pinnedFetchJson(base({ maxRedirects: 1 }), missing.deps), 'fetch_redirect_refused');
});

test('DNS answers that change between hops of the same host are refused', async () => {
  let n = 0;
  const deps: PinnedFetchDependencies = {
    resolver: async () => [{ address: n++ === 0 ? PUBLIC_ADDRESS : '93.184.216.35', family: 4 }],
    transport: async () => response(302, '', { location: '/again' }),
    interfaceAddresses: noInterfaces,
  };
  await rejectsWith(pinnedFetchJson(base({ maxRedirects: 2 }), deps), 'fetch_address_blocked:dns_rebinding');
});

test('oauthError: only a safe error token from a non-2xx JSON body, nothing else echoed', async () => {
  const ok = harness([{ address: PUBLIC_ADDRESS, family: 4 }],
    () => response(400, { error: 'invalid_grant', error_description: 'secret detail' }));
  const result = await pinnedFetchJson(base(), ok.deps);
  assert.deepEqual(result, { status: 400, json: null, oauthError: { error: 'invalid_grant' } });
  assert.deepEqual(pinnedFetchLogFields(result), { status: 400, oauth_error_present: true });
  assert.equal(JSON.stringify(pinnedFetchLogFields(result)).includes('invalid_grant'), false);
  for (const body of [
    { error: 'bad error with spaces' }, { error: 'x'.repeat(65) }, { error: 'émoji' }, { error: 7 },
    { other: 'x' }, 'not json',
  ]) {
    const h = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(401, body));
    await rejectsWith(pinnedFetchJson(base(), h.deps), 'fetch_http_4xx');
  }
  const server = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(503, 'down', {}));
  await rejectsWith(pinnedFetchJson(base(), server.deps), 'fetch_http_5xx');
  const odd = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(99, {}));
  await rejectsWith(pinnedFetchJson(base(), odd.deps), 'fetch_http_other');
  assert.equal(safeOauthError(['error']), null);
  assert.equal(safeOauthError(Object.create({ error: 'inherited' })), null);
  assert.equal(pinnedFetchLogFields({ status: 200, json: {} }).oauth_error_present, false);
});

test('body bounds: oversize, non-JSON content type, non-object JSON', async () => {
  const big = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, { k: 'x'.repeat(100) }));
  await rejectsWith(pinnedFetchJson(base({ maxBytes: 16 }), big.deps), 'fetch_too_large');
  const html = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, '{}', { 'content-type': 'text/html' }));
  await rejectsWith(pinnedFetchJson(base(), html.deps), 'fetch_not_json');
  const arr = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => response(200, '[1]'));
  await rejectsWith(pinnedFetchJson(base(), arr.deps), 'fetch_not_json');
  const custom = harness([{ address: PUBLIC_ADDRESS, family: 4 }],
    () => response(200, '{}', { 'content-type': 'application/jwk-set+json' }));
  assert.equal((await pinnedFetchJson(base(), custom.deps)).status, 200);
  await rejectsWith(pinnedFetchJson(base({ acceptJsonTypes: /^application\/json$/u }), custom.deps),
    'fetch_not_json');
});

test('timeout: a transport that never settles is aborted', async () => {
  let aborted = false;
  const transport: PinnedTransport = async (input) => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  });
  await rejectsWith(pinnedFetchJson(base({ timeoutMs: 10 }), {
    resolver: async () => [{ address: PUBLIC_ADDRESS, family: 4 }], transport, interfaceAddresses: noInterfaces,
  }), 'fetch_timeout');
  assert.equal(aborted, true);
});

test('transport failures are redacted to fixed codes', async () => {
  const deps = (error: Error): PinnedFetchDependencies => ({
    resolver: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    transport: async () => { throw error; },
    interfaceAddresses: noInterfaces,
  });
  await rejectsWith(pinnedFetchJson(base(), deps(new Error('ECONNREFUSED 93.184.216.34'))), 'fetch_connect_failed');
  const stream = harness([{ address: PUBLIC_ADDRESS, family: 4 }], () => ({
    status: 200, headers: { 'content-type': 'application/json' },
    body: (async function* broken() { throw new Error('socket detail'); }()),
  }));
  await rejectsWith(pinnedFetchJson(base(), stream.deps), 'fetch_connect_failed');
});

test('default transport: pins the given address, keeps Host, ignores proxy env, maps TLS errors', async (t) => {
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.host);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const savedProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  t.after(() => {
    if (savedProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = savedProxy;
  });
  const errors = { fail: (failure: string) => new Error(failure), owns: () => false };
  const transport = createDefaultTransport(errors as never);
  const reply = await transport({
    url: new URL(`http://unresolvable.invalid:${port}/x`), address: '127.0.0.1', family: 4, method: 'GET',
    headers: {}, body: null, timeoutMs: 2000, signal: new AbortController().signal,
  });
  assert.equal(reply.status, 200);
  reply.cancel?.();
  assert.equal(seen[0], `unresolvable.invalid:${port}`);
  await assert.rejects(transport({
    url: new URL(`https://localhost:${port}/x`), address: '127.0.0.1', family: 4, method: 'POST',
    headers: {}, body: Buffer.from('{}'), timeoutMs: 2000, signal: new AbortController().signal,
  }), (error: unknown) => error instanceof Error && ['tls_failed', 'transport_failed'].includes(error.message));
});

test('S9 L2: SNI is the DNS name and is omitted for IP literals', () => {
  assert.equal(sniServername('idp.example'), 'idp.example');
  assert.equal(sniServername('93.184.216.34'), undefined);
  assert.equal(sniServername('[2001:db8::1]'), undefined);
  assert.equal(sniServername('2001:db8::1'), undefined);
});

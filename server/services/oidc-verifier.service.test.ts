import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import {
  OIDC_LIMITS,
  OidcVerificationError,
  createOidcVerifier,
  idTokenAuthTimeMs,
  inspectDiscoveryDocument,
  parseExactHttpsIssuer,
} from './oidc-verifier.service.js';

const ISSUER = 'https://identity.example.test';
const CLIENT_ID = 'synthetic-client';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URL = `${ISSUER}/keys`;

type KeyFixture = {
  alg: 'RS256' | 'PS256' | 'ES256';
  kid: string;
  privateKey: crypto.KeyObject;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
};

function keyFixture(alg: KeyFixture['alg'], kid: string): KeyFixture {
  const pair = alg === 'ES256'
    ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    alg,
    kid,
    privateKey: pair.privateKey,
    jwk: {
      ...(pair.publicKey.export({ format: 'jwk' }) as JsonWebKey),
      kid,
      alg,
      use: 'sig',
    },
  };
}

const rsa = keyFixture('RS256', 'rsa-key');
const pss = keyFixture('PS256', 'pss-key');
const ec = keyFixture('ES256', 'ec-key');

function discovery(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: JWKS_URL,
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function verifierWith(keys: KeyFixture[], overrides: {
  discovery?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? (async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.redirect, 'error');
    const href = String(url);
    if (href === DISCOVERY_URL) return jsonResponse(overrides.discovery ?? discovery());
    if (href === JWKS_URL) return jsonResponse({ keys: keys.map((key) => key.jwk) });
    throw new Error('unexpected synthetic URL');
  }) as typeof fetch;
  return createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, fetchImpl });
}

function sign(fixture: KeyFixture, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'subject-synthetic',
    iat: now,
    exp: now + 300,
    nonce: 'nonce-synthetic',
    ...overrides,
  }, fixture.privateKey, {
    algorithm: fixture.alg,
    keyid: fixture.kid,
  });
}

test('accepts only exact HTTPS issuer configuration and discovery metadata', async () => {
  assert.equal(parseExactHttpsIssuer(ISSUER), ISSUER);
  for (const invalid of [
    'http://identity.example.test',
    ' https://identity.example.test',
    'https://user@identity.example.test',
    'https://identity.example.test?tenant=x',
    'https://identity.example.test/#fragment',
  ]) {
    assert.throws(() => parseExactHttpsIssuer(invalid), /invalid_issuer_config/);
  }

  await assert.rejects(
    verifierWith([rsa], { discovery: discovery({ issuer: `${ISSUER}/other` }) }).getDiscovery(),
    /invalid_discovery/,
  );
  await assert.rejects(
    verifierWith([rsa], { discovery: discovery({ jwks_uri: 'http://identity.example.test/keys' }) }).getDiscovery(),
    /invalid_discovery_jwks_uri/,
  );
  await assert.rejects(
    verifierWith([rsa], { discovery: discovery({ jwks_uri: 'https://attacker.example/keys' }) }).getDiscovery(),
    /invalid_discovery_jwks_uri/,
  );
  await assert.rejects(
    verifierWith([rsa], { discovery: discovery({ token_endpoint: 'https://attacker.example/token' }) }).getDiscovery(),
    /invalid_discovery_token_endpoint/,
  );
});

test('verifies RS256, PS256 and ES256 signatures with exact kid and caches metadata', async () => {
  let requests = 0;
  const keys = [rsa, pss, ec];
  const fetchImpl = (async (url: string | URL | Request, options?: RequestInit) => {
    requests += 1;
    assert.equal(options?.redirect, 'error');
    return String(url) === DISCOVERY_URL
      ? jsonResponse(discovery())
      : jsonResponse({ keys: keys.map((key) => key.jwk) });
  }) as typeof fetch;
  const verifier = verifierWith(keys, { fetchImpl });

  for (const fixture of keys) {
    const claims = await verifier.verifyIdToken(sign(fixture), 'nonce-synthetic');
    assert.equal(claims.sub, 'subject-synthetic');
  }
  assert.equal(requests, 2, 'discovery and JWKS are each cached after one bounded fetch');
});

test('rejects signature, kid, issuer, audience, azp, time and nonce claim attacks', async () => {
  const verifier = verifierWith([rsa]);
  const attacker = keyFixture('RS256', rsa.kid);
  const now = Math.floor(Date.now() / 1000);
  const rejected = [
    sign(attacker),
    jwt.sign({ iss: ISSUER, aud: CLIENT_ID, sub: 'subject', iat: now, exp: now + 60, nonce: 'nonce-synthetic' }, rsa.privateKey, { algorithm: 'RS256', keyid: 'unknown' }),
    sign(rsa, { iss: `${ISSUER}/other` }),
    sign(rsa, { aud: 'other-client' }),
    sign(rsa, { aud: [CLIENT_ID, 'other-client'], azp: 'other-client' }),
    sign(rsa, { exp: now - 1 }),
    sign(rsa, { iat: now + 120, exp: now + 300 }),
    sign(rsa, { nonce: 'wrong-nonce' }),
  ];
  for (const token of rejected) {
    await assert.rejects(verifier.verifyIdToken(token, 'nonce-synthetic'));
  }
});

function unsignedToken(header: Record<string, unknown>, payload: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part(header)}.${part(payload)}.`;
}

test('T-961 negative matrix: each attack fails with its specific stable code', async () => {
  const verifier = verifierWith([rsa]);
  const now = Math.floor(Date.now() / 1000);
  const basePayload = {
    iss: ISSUER, aud: CLIENT_ID, sub: 'subject-synthetic', iat: now, exp: now + 300, nonce: 'nonce-synthetic',
  };
  const rsaPublicPem = crypto.createPublicKey(rsa.privateKey).export({ format: 'pem', type: 'spki' });
  const cases: Array<[string, string, RegExp]> = [
    ['forged signature (attacker key, trusted kid)', sign(keyFixture('RS256', rsa.kid)), /signature_or_registered_claim_invalid/],
    ['alg=none', unsignedToken({ alg: 'none', kid: rsa.kid }, basePayload), /invalid_algorithm/],
    ['HS256 keyed with the public key', jwt.sign(basePayload, rsaPublicPem, { algorithm: 'HS256', keyid: rsa.kid }), /invalid_algorithm/],
    ['missing kid', jwt.sign(basePayload, rsa.privateKey, { algorithm: 'RS256' }), /invalid_kid/],
    ['wrong audience', sign(rsa, { aud: 'other-client' }), /signature_or_registered_claim_invalid/],
    ['wrong issuer', sign(rsa, { iss: 'https://attacker.example' }), /signature_or_registered_claim_invalid/],
    ['expired', sign(rsa, { iat: now - 600, exp: now - 60 }), /signature_or_registered_claim_invalid/],
    ['not yet valid (nbf)', sign(rsa, { nbf: now + 120 }), /signature_or_registered_claim_invalid/],
    ['missing exp', jwt.sign({ iss: ISSUER, aud: CLIENT_ID, sub: 'subject-synthetic', iat: now, nonce: 'nonce-synthetic' }, rsa.privateKey, { algorithm: 'RS256', keyid: rsa.kid }), /invalid_time_claims/],
    ['foreign azp', sign(rsa, { azp: 'other-client' }), /invalid_authorized_party/],
    ['different nonce', sign(rsa, { nonce: 'replayed-nonce' }), /invalid_nonce/],
  ];
  for (const [name, token, code] of cases) {
    await assert.rejects(verifier.verifyIdToken(token, 'nonce-synthetic'), code, name);
  }
  await assert.rejects(verifier.verifyIdToken(sign(rsa), undefined), /invalid_nonce/, 'nonce is mandatory');
});

test('JWKS rotation: an unseen kid refreshes the key set, rate-capped by the cooldown', async () => {
  const rotated = keyFixture('RS256', 'rotated-key');
  let published = [rsa];
  let jwksFetches = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url) === DISCOVERY_URL) return jsonResponse(discovery());
    jwksFetches += 1;
    return jsonResponse({ keys: published.map((key) => key.jwk) });
  }) as typeof fetch;

  const rotating = createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, fetchImpl, jwksRefreshCooldownMs: 0 });
  await rotating.verifyIdToken(sign(rsa), 'nonce-synthetic');
  published = [rsa, rotated];
  const claims = await rotating.verifyIdToken(sign(rotated), 'nonce-synthetic');
  assert.equal(claims.sub, 'subject-synthetic');
  assert.equal(jwksFetches, 2, 'the rotated kid forced exactly one refresh inside the cache TTL');

  jwksFetches = 0;
  published = [rsa];
  const capped = createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, fetchImpl });
  await capped.verifyIdToken(sign(rsa), 'nonce-synthetic');
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      capped.verifyIdToken(sign(keyFixture('RS256', `forged-kid-${i}`)), 'nonce-synthetic'),
      /unknown_or_ambiguous_kid/,
    );
  }
  assert.equal(jwksFetches, 1, 'unknown kids inside the cooldown never re-fetch the JWKS');
});

test('rejects redirects and oversized discovery, JWKS and tokens', async () => {
  const redirecting = verifierWith([rsa], {
    fetchImpl: (async () => new Response('', {
      status: 302,
      headers: { location: 'https://redirect.example.test' },
    })) as typeof fetch,
  });
  await assert.rejects(redirecting.getDiscovery(), /discovery_unavailable/);

  const oversizedDiscovery = verifierWith([rsa], {
    fetchImpl: (async () => new Response('x', {
      status: 200,
      headers: { 'content-length': String(OIDC_LIMITS.discoveryBytes + 1) },
    })) as typeof fetch,
  });
  await assert.rejects(oversizedDiscovery.getDiscovery(), /discovery_unavailable/);

  const oversizedJwks = verifierWith([rsa], {
    fetchImpl: (async (url: string | URL | Request) => String(url) === DISCOVERY_URL
      ? jsonResponse(discovery())
      : new Response('x', {
          status: 200,
          headers: { 'content-length': String(OIDC_LIMITS.jwksBytes + 1) },
        })) as typeof fetch,
  });
  await assert.rejects(
    oversizedJwks.verifyIdToken(sign(rsa), 'nonce-synthetic'),
    /jwks_unavailable/,
  );

  await assert.rejects(
    verifierWith([rsa]).verifyIdToken(`x.${'a'.repeat(OIDC_LIMITS.tokenBytes + 1)}.x`, 'nonce-synthetic'),
    /invalid_token/,
  );
});

test('logout requires a verified event, sub and unique jti; sid-only is fail-closed', async () => {
  const verifier = verifierWith([rsa]);
  const logoutClaims = {
    nonce: undefined,
    jti: 'logout-synthetic-1',
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
  };
  const valid = sign(rsa, logoutClaims);
  const claims = await verifier.verifyLogoutToken(valid);
  assert.equal(claims.sub, 'subject-synthetic');
  await assert.rejects(verifier.verifyLogoutToken(valid), /logout_replay/);

  await assert.rejects(verifier.verifyLogoutToken(sign(rsa, {
    ...logoutClaims,
    jti: 'logout-synthetic-2',
    sub: undefined,
    sid: 'sid-synthetic',
  })), /subject_required/);
  await assert.rejects(verifier.verifyLogoutToken(sign(rsa, {
    ...logoutClaims,
    jti: 'logout-synthetic-3',
    events: {},
  })), /logout_event_required/);
});

test('the OIDC route logs only stable codes, never raw tokens or provider diagnostics', () => {
  const source = fs.readFileSync(new URL('../routes/oidc.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /jwt\.decode|console\.error|error\?\.message/);
  assert.match(source, /process\.stderr\.write.*JSON\.stringify/);
  assert.doesNotMatch(source, /process\.stderr\.write.*logoutToken/);
  assert.doesNotMatch(source, /metadata:\s*\{\s*sub:/);
});

test('T-1939 slice 5: auth_time is exposed when valid and rejected when malformed or future', async () => {
  const verifier = verifierWith([rsa]);
  const now = Math.floor(Date.now() / 1000);
  const claims = await verifier.verifyIdToken(sign(rsa, { auth_time: now - 30 }), 'nonce-synthetic');
  assert.equal(idTokenAuthTimeMs(claims), (now - 30) * 1000);
  const withoutAuthTime = await verifier.verifyIdToken(sign(rsa), 'nonce-synthetic');
  assert.equal(idTokenAuthTimeMs(withoutAuthTime), null, 'absent auth_time is reported, not invented');
  for (const authTime of ['1700000000', now + 600, 0, -5, 1.5, null]) {
    await assert.rejects(
      verifier.verifyIdToken(sign(rsa, { auth_time: authTime }), 'nonce-synthetic'),
      /invalid_auth_time/,
      String(authTime),
    );
  }
  assert.equal(idTokenAuthTimeMs({}), null);
  assert.equal(idTokenAuthTimeMs(null as never), null);
});

// ---------------------------------------------------------------------------
// ADR-194 S3: pinned endpoints, drift, confidential clients, I10 inspection
// ---------------------------------------------------------------------------

const PINS = Object.freeze({
  authorization_endpoint: 'https://login.other.example/authorize',
  token_endpoint: 'https://tokens.other.example/token',
  jwks_uri: 'https://keys.other.example/jwks',
});

type FetchCall = { url: string; method?: string; headers?: Record<string, string>; body?: string;
  addressPolicy: string; allowedPort?: number; maxRedirects?: number };

/** A fake pinnedFetchJson recording every call; `routes` maps URL → response. */
function pinnedFake(routes: Record<string, unknown>) {
  const calls: FetchCall[] = [];
  const fetchJson = async (input: FetchCall) => {
    calls.push(input);
    if (!(input.url in routes)) throw new Error('fetch_dns_failed');
    const value = routes[input.url];
    return typeof value === 'function' ? (value as (call: FetchCall) => unknown)(input) : { status: 200, json: value };
  };
  return { calls, fetchJson };
}

function pinnedVerifier(routes: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const fake = pinnedFake(routes);
  const verifier = createOidcVerifier({
    issuer: ISSUER, clientId: CLIENT_ID, endpoints: PINS,
    network: { addressPolicy: 'public', fetchJson: fake.fetchJson }, ...options,
  });
  return { verifier, calls: fake.calls };
}

const pinnedDiscovery = (overrides: Record<string, unknown> = {}) => ({ issuer: ISSUER, ...PINS, ...overrides });

test('pinned mode: cross-origin pinned endpoints are used; discovery is never fetched to verify', async () => {
  const { verifier, calls } = pinnedVerifier({ [PINS.jwks_uri]: { keys: [rsa.jwk] } });
  assert.equal(await verifier.authorizationEndpoint(), PINS.authorization_endpoint);
  const claims = await verifier.verifyIdToken(sign(rsa), 'nonce-synthetic');
  assert.equal(claims.sub, 'subject-synthetic');
  assert.deepEqual(calls.map((call) => call.url), [PINS.jwks_uri]);
  assert.equal(calls[0]?.maxRedirects, 0, 'OIDC never follows redirects');
  assert.equal(calls[0]?.addressPolicy, 'public');
});

test('pinned mode: drift in any pinned URL or the issuer is reported once and fails closed', async () => {
  for (const drifted of [
    pinnedDiscovery({ token_endpoint: 'https://tokens.other.example/v2/token' }),
    pinnedDiscovery({ jwks_uri: 'https://attacker.example/jwks' }),
    pinnedDiscovery({ issuer: `${ISSUER}/other` }),
    'not-an-object',
  ]) {
    const drifts: string[] = [];
    const { verifier } = pinnedVerifier({ [DISCOVERY_URL]: drifted }, { onDiscoveryDrift: (code: string) => drifts.push(code) });
    await assert.rejects(verifier.checkDiscoveryDrift(), /discovery_endpoint_changed/);
    assert.deepEqual(drifts, ['discovery_endpoint_changed']);
  }
  const { verifier, calls } = pinnedVerifier({ [DISCOVERY_URL]: pinnedDiscovery() });
  assert.equal(await verifier.checkDiscoveryDrift(), 'ok');
  assert.equal(await verifier.checkDiscoveryDrift(), 'ok');
  assert.equal(calls.length, 1, 'the drift check is cached for the TTL');
  const unreachable = pinnedVerifier({});
  assert.equal(await unreachable.verifier.checkDiscoveryDrift(), 'unverified', 'an unreachable discovery is not drift');
});

test('pinned mode: private_allowed passes the row port; a verify-only verifier refuses the other endpoints', async () => {
  const fake = pinnedFake({ [PINS.jwks_uri]: { keys: [rsa.jwk] } });
  const privateVerifier = createOidcVerifier({
    issuer: ISSUER, clientId: CLIENT_ID, endpoints: { jwks_uri: PINS.jwks_uri },
    network: { addressPolicy: 'private_allowed', allowedPort: 8443, fetchJson: fake.fetchJson },
  });
  await privateVerifier.verifyIdToken(sign(rsa), 'nonce-synthetic');
  assert.equal(fake.calls[0]?.addressPolicy, 'private_allowed');
  assert.equal(fake.calls[0]?.allowedPort, 8443);
  await assert.rejects(privateVerifier.authorizationEndpoint(), /endpoint_unpinned/);
  await assert.rejects(privateVerifier.exchangeAuthorizationCode({ code: 'c', redirectUri: 'r', codeVerifier: 'v' }),
    /endpoint_unpinned/);
  const publicPort = pinnedFake({ [PINS.jwks_uri]: { keys: [rsa.jwk] } });
  await createOidcVerifier({
    issuer: ISSUER, clientId: CLIENT_ID, endpoints: { jwks_uri: PINS.jwks_uri },
    network: { addressPolicy: 'public', allowedPort: 8443, fetchJson: publicPort.fetchJson },
  }).verifyIdToken(sign(rsa), 'nonce-synthetic');
  assert.equal(publicPort.calls[0]?.allowedPort, undefined, 'a port is never passed under the public policy');
  assert.throws(() => createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, endpoints: { token_endpoint: PINS.token_endpoint } }),
    /invalid_pinned_endpoints/);
  assert.throws(() => createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, network: { addressPolicy: 'open' } }),
    /invalid_network_policy/);
});

test('token request: public, client_secret_basic and client_secret_post; the secret is read per request', async () => {
  const tokenRoute = (call: FetchCall) => ({ status: 200, json: { id_token: 'x', echo: call } });
  const exchange = async (clientAuth: string, readClientSecret?: () => string) => {
    const { verifier, calls } = pinnedVerifier({ [PINS.token_endpoint]: tokenRoute }, { clientAuth, readClientSecret });
    await verifier.exchangeAuthorizationCode({ code: 'c0de', redirectUri: 'https://app.example/cb', codeVerifier: 'pkce' });
    const call = calls[0] as FetchCall;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, PINS.token_endpoint);
    return { headers: call.headers ?? {}, params: new URLSearchParams(call.body) };
  };
  const none = await exchange('none');
  assert.equal(none.params.get('client_id'), CLIENT_ID);
  assert.equal(none.params.get('code_verifier'), 'pkce');
  assert.equal(none.headers.authorization, undefined);

  let reads = 0;
  const basic = await exchange('client_secret_basic', () => { reads += 1; return 'p@ss word:1'; });
  const expected = Buffer.from(`${CLIENT_ID}:p%40ss+word%3A1`).toString('base64');
  assert.equal(basic.headers.authorization, `Basic ${expected}`, 'RFC 6749 2.3.1 form-encoded credentials');
  assert.equal(basic.params.get('client_secret'), null);
  assert.equal(basic.params.get('client_id'), null);

  const post = await exchange('client_secret_post', () => { reads += 1; return 'p@ss'; });
  assert.equal(post.params.get('client_secret'), 'p@ss');
  assert.equal(post.params.get('client_id'), CLIENT_ID);
  assert.equal(post.headers.authorization, undefined);
  assert.equal(reads, 2, 'the secret is read once per token request');

  for (const reader of [() => { throw new Error('key lost'); }, () => '']) {
    const { verifier } = pinnedVerifier({ [PINS.token_endpoint]: tokenRoute }, { clientAuth: 'client_secret_post', readClientSecret: reader });
    await assert.rejects(verifier.exchangeAuthorizationCode({ code: 'c', redirectUri: 'r', codeVerifier: 'v' }),
      /client_secret_unavailable/);
  }
  assert.throws(() => createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, clientAuth: 'client_secret_basic' }),
    /invalid_client_auth/);
  assert.throws(() => createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, clientAuth: 'private_key_jwt' }),
    /invalid_client_auth/);
});

test('token request: an OAuth error token rides along for the owner; transport failures carry no detail', async () => {
  const { verifier } = pinnedVerifier({
    [PINS.token_endpoint]: () => ({ status: 400, json: null, oauthError: { error: 'invalid_grant' } }),
  });
  const error = await verifier.exchangeAuthorizationCode({ code: 'c', redirectUri: 'r', codeVerifier: 'v' })
    .then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof OidcVerificationError);
  assert.equal(error.code, 'token_exchange_failed');
  assert.equal(error.oauthError, 'invalid_grant');
  const down = pinnedVerifier({});
  const failure = await down.verifier.exchangeAuthorizationCode({ code: 'c', redirectUri: 'r', codeVerifier: 'v' })
    .then(() => null, (caught: unknown) => caught) as OidcVerificationError;
  assert.equal(failure.code, 'token_exchange_failed');
  assert.equal(failure.oauthError, undefined);
});

test('I10 discovery inspection: absent auth methods mean basic; absent S256 list is a warning', () => {
  const base = {
    issuer: ISSUER, ...PINS, response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
  };
  const basic = inspectDiscoveryDocument(base, { issuer: ISSUER, clientAuth: 'client_secret_basic' });
  assert.equal(basic.failure, null);
  assert.deepEqual(basic.warnings, ['discovery_pkce_methods_unadvertised']);
  assert.deepEqual(basic.endpoints, PINS);
  assert.equal(inspectDiscoveryDocument(base, { issuer: ISSUER, clientAuth: 'client_secret_post' }).failure,
    'discovery_client_auth_unsupported');
  assert.equal(inspectDiscoveryDocument(base, { issuer: ISSUER, clientAuth: 'none' }).failure,
    'discovery_client_auth_unsupported');
  const full = inspectDiscoveryDocument({
    ...base, token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true, backchannel_logout_supported: true,
  }, { issuer: ISSUER, clientAuth: 'none' });
  assert.equal(full.failure, null);
  assert.deepEqual(full.warnings, []);
  assert.equal(full.flags?.authorization_response_iss_parameter_supported, true);
  assert.equal(full.flags?.backchannel_logout_supported, true);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...base, issuer: `${ISSUER}/x` }, 'discovery_issuer_mismatch'],
    [{ ...base, jwks_uri: 'http://keys.other.example/jwks' }, 'discovery_endpoint_invalid'],
    [{ ...base, response_types_supported: ['token'] }, 'discovery_code_flow_unsupported'],
    [{ ...base, id_token_signing_alg_values_supported: ['HS256'] }, 'discovery_signing_alg_unsupported'],
    [{ ...base, code_challenge_methods_supported: ['plain'] }, 'discovery_pkce_s256_unsupported'],
  ];
  for (const [raw, failure] of cases) {
    assert.equal(inspectDiscoveryDocument(raw, { issuer: ISSUER, clientAuth: 'client_secret_basic' }).failure, failure);
  }
  assert.equal(inspectDiscoveryDocument(null, { issuer: ISSUER, clientAuth: 'none' }).failure, 'discovery_issuer_mismatch');
});

test('fetchDiscoveryForPinning: discovery plus a usable JWKS, through the pinned transport', async () => {
  const discoveryDoc = {
    issuer: ISSUER, ...PINS, response_types_supported: ['code'], id_token_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
  };
  const ok = pinnedFake({ [DISCOVERY_URL]: discoveryDoc, [PINS.jwks_uri]: { keys: [rsa.jwk, ec.jwk] } });
  const fresh = createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, network: { fetchJson: ok.fetchJson } });
  const pinned = await fresh.fetchDiscoveryForPinning();
  assert.equal(pinned.failure, null);
  assert.equal(pinned.jwksKeyCount, 2);
  const empty = pinnedFake({ [DISCOVERY_URL]: discoveryDoc, [PINS.jwks_uri]: { keys: [{ kty: 'oct', kid: 'k' }] } });
  const noKeys = createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, network: { fetchJson: empty.fetchJson } });
  assert.equal((await noKeys.fetchDiscoveryForPinning()).failure, 'jwks_no_usable_key');
  const bad = pinnedFake({ [DISCOVERY_URL]: { ...discoveryDoc, response_types_supported: [] } });
  const refused = createOidcVerifier({ issuer: ISSUER, clientId: CLIENT_ID, network: { fetchJson: bad.fetchJson } });
  assert.equal((await refused.fetchDiscoveryForPinning()).failure, 'discovery_code_flow_unsupported');
  assert.equal(bad.calls.length, 1, 'no JWKS fetch after a failed discovery check');
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import {
  OIDC_LIMITS,
  createOidcVerifier,
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

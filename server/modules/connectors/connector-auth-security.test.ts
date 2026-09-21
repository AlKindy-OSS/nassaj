import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type express from 'express';

import {
  canonicalConnectorPublicOrigin,
  connectorOAuthCallbackUrl,
  createRequireRecentConnectorOwner,
  RECENT_AUTH_MAX_AGE_MS,
  validateConnectorAuthBootstrapCapability,
  type RecentAuthSession,
} from './connector-auth-security.js';

test('canonical public origin normalizes IDNA, case, default port, and trailing slash', () => {
  const env = { NASSAJ_PUBLIC_ORIGIN: 'https://BÜCHER.example:443/' };
  assert.equal(canonicalConnectorPublicOrigin(env), 'https://xn--bcher-kva.example');
  assert.equal(
    connectorOAuthCallbackUrl(env),
    'https://xn--bcher-kva.example/connectors/oauth/callback',
  );
});

test('canonical public origin rejects malformed or non-origin values', () => {
  for (const value of [
    '', 'not a url', '//nassaj.example', 'https://user@nassaj.example',
    'https://nassaj.example/path', 'https://nassaj.example/?q=1',
    'https://nassaj.example/#fragment', 'http://nassaj.example',
  ]) {
    assert.throws(() => canonicalConnectorPublicOrigin({ NASSAJ_PUBLIC_ORIGIN: value }));
  }
  assert.equal(canonicalConnectorPublicOrigin({
    NASSAJ_PUBLIC_ORIGIN: 'http://localhost:3004/',
    NODE_ENV: 'development',
  }), 'http://localhost:3004');
});

test('spoofed Host and forwarding headers cannot influence the configured callback', () => {
  assert.equal(
    connectorOAuthCallbackUrl({
      NASSAJ_PUBLIC_ORIGIN: 'https://nassaj.example',
      HOST: 'attacker.example',
      X_FORWARDED_HOST: 'attacker.example',
      X_FORWARDED_PROTO: 'http',
    }),
    'https://nassaj.example/connectors/oauth/callback',
  );
});

test('bootstrap capability must carry a stable id and the exact canonical configured origin', () => {
  const env = { NASSAJ_PUBLIC_ORIGIN: 'https://nassaj.example' };
  assert.equal(validateConnectorAuthBootstrapCapability(null, env), null);
  assert.equal(validateConnectorAuthBootstrapCapability({
    installationId: 'short', canonicalOrigin: 'https://nassaj.example',
  }, env), null);
  assert.equal(validateConnectorAuthBootstrapCapability({
    installationId: 'installation-test-0001', canonicalOrigin: 'https://attacker.example',
  }, env), null);
  assert.deepEqual(validateConnectorAuthBootstrapCapability({
    installationId: 'installation-test-0001', canonicalOrigin: 'https://nassaj.example',
  }, env), {
    installationId: 'installation-test-0001', canonicalOrigin: 'https://nassaj.example',
  });
});

type GateResult = Readonly<{ status: number; body: Record<string, unknown>; next: boolean }>;

const runGate = async (input: Readonly<{
  role: string;
  origin?: string;
  csrf?: string;
  session: RecentAuthSession | null;
  jwtIat?: number;
  jwtAuthTime?: number;
}>): Promise<GateResult> => {
  let status = 200;
  let body: Record<string, unknown> = {};
  let nextCalled = false;
  const headers = new Map<string, string>();
  if (input.origin) headers.set('origin', input.origin);
  if (input.csrf !== undefined) headers.set('x-csrf-token', input.csrf);
  const req = {
    user: { id: 7, role: input.role, iat: input.jwtIat, auth_time: input.jwtAuthTime },
    get: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as express.Request;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (value: Record<string, unknown>) => {
      body = value;
      return res;
    },
  } as unknown as express.Response;
  const middleware = createRequireRecentConnectorOwner(
    () => input.session,
    { env: { NASSAJ_PUBLIC_ORIGIN: 'https://nassaj.example' }, now: () => 1_000_000 },
  );
  await middleware(req, res, () => { nextCalled = true; });
  return { status, body, next: nextCalled };
};

const recentSession = (csrf: string, authTime = 1_000_000): RecentAuthSession => ({
  userId: 7,
  authTime,
  authMethod: 'webauthn',
  csrfTokenHash: createHash('sha256').update(csrf).digest('hex'),
  cookieSameSite: 'strict',
});

const VALID_CSRF = 'c'.repeat(32);

test('recent-auth middleware cannot be built without a production server-session adapter', () => {
  assert.throws(
    () => createRequireRecentConnectorOwner(undefined),
    /server-session adapter is unavailable/,
  );
});

test('recent-auth gate rejects admin even with a fresh server session', async () => {
  const result = await runGate({
    role: 'admin', origin: 'https://nassaj.example', csrf: VALID_CSRF, session: recentSession(VALID_CSRF),
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CONNECTOR_OWNER_REQUIRED');
  assert.equal(result.next, false);
});

test('recent-auth gate rejects old sessions and never treats JWT iat as auth_time', async () => {
  const old = await runGate({
    role: 'owner', origin: 'https://nassaj.example', csrf: VALID_CSRF,
    session: recentSession(VALID_CSRF, 1_000_000 - RECENT_AUTH_MAX_AGE_MS - 1),
  });
  assert.equal(old.body.code, 'CONNECTOR_RECENT_AUTH_REQUIRED');
  const jwtOnly = await runGate({
    role: 'owner', origin: 'https://nassaj.example', csrf: VALID_CSRF, session: null,
    jwtIat: 1_000_000, jwtAuthTime: 1_000_000,
  });
  assert.equal(jwtOnly.body.code, 'CONNECTOR_RECENT_AUTH_REQUIRED');
});

test('recent-auth gate binds trusted origin, strict session cookie policy, and CSRF', async () => {
  const wrongOrigin = await runGate({
    role: 'owner', origin: 'https://attacker.example', csrf: VALID_CSRF, session: recentSession(VALID_CSRF),
  });
  assert.equal(wrongOrigin.body.code, 'CONNECTOR_ORIGIN_REJECTED');
  const wrongCsrf = await runGate({
    role: 'owner', origin: 'https://nassaj.example', csrf: 'short', session: recentSession(VALID_CSRF),
  });
  assert.equal(wrongCsrf.body.code, 'CONNECTOR_RECENT_AUTH_REQUIRED');
  const emptyCsrf = await runGate({
    role: 'owner', origin: 'https://nassaj.example', csrf: '', session: recentSession(VALID_CSRF),
  });
  assert.equal(emptyCsrf.body.code, 'CONNECTOR_RECENT_AUTH_REQUIRED');
  const laxCookie = await runGate({
    role: 'owner', origin: 'https://nassaj.example', csrf: VALID_CSRF,
    session: { ...recentSession(VALID_CSRF), cookieSameSite: 'lax' } as unknown as RecentAuthSession,
  });
  assert.equal(laxCookie.body.code, 'CONNECTOR_RECENT_AUTH_REQUIRED');
  const accepted = await runGate({
    role: 'owner', origin: 'https://nassaj.example', csrf: VALID_CSRF, session: recentSession(VALID_CSRF),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.next, true);
});

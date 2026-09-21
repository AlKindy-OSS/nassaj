import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type express from 'express';

import { RECENT_AUTH_MAX_AGE_MS } from './connector-auth-security.js';
import { createConnectorOwnerAuthSessionAdapter } from './connector-owner-auth-session.js';
import {
  connectorCsrfCookieName,
  connectorRecentAuthCookieName,
} from './connector-owner-operation-gate.js';

const INSTALLATION_ID = '10000000-0000-4000-8000-000000000001';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('records verifier-time auth_time, rotates old sessions, and emits split secure cookies', () => {
  const writes: unknown[] = [];
  const rotations: unknown[] = [];
  const cookies: unknown[] = [];
  const token = 'c'.repeat(64);
  const csrf = 'd'.repeat(64);
  const adapter = createConnectorOwnerAuthSessionAdapter({
    repository: {
      recordOwnerAuthSession: input => { writes.push(input); },
      revokeOwnerAuthSessions: input => { rotations.push(input); return 1; },
      revokeOwnerAuthSession: () => true,
    },
    installationId: INSTALLATION_ID,
    canonicalOrigin: 'https://nassaj.example',
    now: () => 1_000_000,
    randomToken: () => token,
    randomCsrfToken: () => csrf,
    sessionId: () => '50000000-0000-4000-8000-000000000001',
  });
  const res = {
    cookie: (...args: unknown[]) => { cookies.push(args); }, clearCookie: () => undefined,
  } as unknown as express.Response;

  adapter.record(res, 7, 'webauthn');

  assert.deepEqual(rotations, [{ installationId: INSTALLATION_ID, userId: 7, nowMs: 1_000_000 }]);
  assert.deepEqual(writes, [{
    sessionId: '50000000-0000-4000-8000-000000000001',
    installationId: INSTALLATION_ID,
    sessionTokenHash: sha256(token),
    csrfTokenHash: sha256(csrf),
    userId: 7,
    authMethod: 'webauthn',
    authTimeMs: 1_000_000,
    expiresAtMs: 1_000_000 + RECENT_AUTH_MAX_AGE_MS,
  }]);
  assert.deepEqual(cookies, [
    [connectorRecentAuthCookieName, token, {
      httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: RECENT_AUTH_MAX_AGE_MS,
    }],
    [connectorCsrfCookieName, csrf, {
      httpOnly: false, sameSite: 'strict', secure: true,
      path: '/api/connectors', maxAge: RECENT_AUTH_MAX_AGE_MS,
    }],
  ]);
});

test('logout hashes the presented root-path cookie, revokes it, and clears both cookies', () => {
  const revoked: unknown[] = [];
  const cleared: unknown[] = [];
  const token = 'e'.repeat(64);
  const adapter = createConnectorOwnerAuthSessionAdapter({
    repository: {
      recordOwnerAuthSession: () => undefined,
      revokeOwnerAuthSessions: () => 0,
      revokeOwnerAuthSession: input => { revoked.push(input); return true; },
    },
    installationId: INSTALLATION_ID,
    canonicalOrigin: 'https://nassaj.example',
    now: () => 1_100_000,
  });
  const req = { headers: { cookie: `${connectorRecentAuthCookieName}=${token}` } } as express.Request;
  const res = {
    cookie: () => undefined,
    clearCookie: (...args: unknown[]) => { cleared.push(args); },
  } as unknown as express.Response;

  assert.equal(adapter.revoke(req, res, 7), true);
  assert.deepEqual(revoked, [{
    sessionTokenHash: sha256(token), installationId: INSTALLATION_ID, userId: 7, nowMs: 1_100_000,
  }]);
  assert.equal(cleared.length, 2);
  assert.deepEqual(cleared[0], [connectorRecentAuthCookieName, {
    httpOnly: true, sameSite: 'strict', secure: true, path: '/',
  }]);
});

test('rejects invalid identities before rotation or session write', () => {
  let writes = 0;
  const adapter = createConnectorOwnerAuthSessionAdapter({
    repository: {
      recordOwnerAuthSession: () => { writes += 1; },
      revokeOwnerAuthSessions: () => { writes += 1; return 0; },
      revokeOwnerAuthSession: () => false,
    },
    installationId: INSTALLATION_ID,
    canonicalOrigin: 'https://nassaj.example',
  });
  const res = { cookie: () => undefined, clearCookie: () => undefined } as unknown as express.Response;
  assert.throws(() => adapter.record(res, 0, 'password'), /session_invalid/);
  assert.equal(writes, 0);
});

test('production-style writer fails closed before cookies when the runtime fence is unavailable', () => {
  let writes = 0;
  let cookies = 0;
  const adapter = createConnectorOwnerAuthSessionAdapter({
    repository: {
      recordOwnerAuthSession: () => { writes += 1; },
      revokeOwnerAuthSessions: () => { writes += 1; return 0; },
      revokeOwnerAuthSession: () => false,
    },
    installationId: INSTALLATION_ID,
    canonicalOrigin: 'https://nassaj.example',
    executeWrite: () => false,
  });
  const res = {
    cookie: () => { cookies += 1; }, clearCookie: () => undefined,
  } as unknown as express.Response;
  assert.throws(() => adapter.record(res, 7, 'password'), /write_fence_unavailable/u);
  assert.equal(writes, 0);
  assert.equal(cookies, 0);
});

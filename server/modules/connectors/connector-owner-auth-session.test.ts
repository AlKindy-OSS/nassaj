import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type express from 'express';

import { RECENT_AUTH_MAX_AGE_MS } from './connector-auth-security.js';
import {
  configureConnectorOwnerAuthSessionProduction,
  connectorOwnerSessionAvailable,
  connectorOwnerSessionOrigin,
  createConnectorOwnerAuthSessionAdapter,
  createRecentAuthOriginSource,
  recordConnectorOwnerAuthentication,
} from './connector-owner-auth-session.js';
import {
  connectorLegacyCsrfCookieName,
  connectorSecureCsrfCookieName,
  connectorHostRecentAuthCookieName,
  connectorLegacyRecentAuthCookieName,
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
    resolveOrigin: () => 'https://nassaj.example',
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
    [connectorHostRecentAuthCookieName, token, {
      httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: RECENT_AUTH_MAX_AGE_MS,
    }],
    [connectorSecureCsrfCookieName, csrf, {
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
    resolveOrigin: () => 'https://nassaj.example',
    now: () => 1_100_000,
  });
  const req = { headers: { cookie: `${connectorHostRecentAuthCookieName}=${token}` } } as express.Request;
  const res = {
    cookie: () => undefined,
    clearCookie: (...args: unknown[]) => { cleared.push(args); },
  } as unknown as express.Response;

  assert.equal(adapter.revoke(req, res, 7), true);
  assert.deepEqual(revoked, [{
    sessionTokenHash: sha256(token), installationId: INSTALLATION_ID, userId: 7, nowMs: 1_100_000,
  }]);
  assert.equal(cleared.length, 2);
  assert.deepEqual(cleared[0], [connectorHostRecentAuthCookieName, {
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
    resolveOrigin: () => 'https://nassaj.example',
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
    resolveOrigin: () => 'https://nassaj.example',
    executeWrite: () => false,
  });
  const res = {
    cookie: () => { cookies += 1; }, clearCookie: () => undefined,
  } as unknown as express.Response;
  assert.throws(() => adapter.record(res, 7, 'password'), /write_fence_unavailable/u);
  assert.equal(writes, 0);
  assert.equal(cookies, 0);
});

const recordingRepository = (log: string[]) => ({
  recordOwnerAuthSession: () => { log.push('write'); },
  revokeOwnerAuthSessions: () => { log.push('rotate'); return 0; },
  revokeOwnerAuthSession: () => { log.push('revoke'); return true; },
});

const cookieJar = (log: string[]) => ({
  cookie: (name: string) => { log.push(`cookie:${name}`); },
  clearCookie: (name: string) => { log.push(`clear:${name}`); },
}) as unknown as express.Response;

test('no configured origin: nothing is written and no cookie is set', () => {
  const log: string[] = [];
  for (const resolveOrigin of [() => null, () => { throw new Error('store down'); }, () => 'not a url']) {
    const adapter = createConnectorOwnerAuthSessionAdapter({
      repository: recordingRepository(log), installationId: INSTALLATION_ID, resolveOrigin,
    });
    assert.throws(() => adapter.record(cookieJar(log), 7, 'oidc'), /origin_unavailable/u);
  }
  assert.deepEqual(log, []);
});

test('the origin is read per call: the cookie name follows a later origin change', () => {
  let origin: string | null = 'http://localhost:3001';
  const log: string[] = [];
  const adapter = createConnectorOwnerAuthSessionAdapter({
    repository: recordingRepository(log), installationId: INSTALLATION_ID, resolveOrigin: () => origin,
  });
  adapter.record(cookieJar(log), 7, 'password');
  origin = 'https://nassaj.example';
  adapter.record(cookieJar(log), 7, 'oidc');
  assert.deepEqual(log.filter(entry => entry.startsWith('cookie:')), [
    `cookie:${connectorLegacyRecentAuthCookieName}`, `cookie:${connectorLegacyCsrfCookieName}`,
    `cookie:${connectorHostRecentAuthCookieName}`, `cookie:${connectorSecureCsrfCookieName}`,
  ]);
});

test('logout with a duplicated recent-auth cookie revokes nothing but still clears both cookies', () => {
  const log: string[] = [];
  const adapter = createConnectorOwnerAuthSessionAdapter({
    repository: recordingRepository(log), installationId: INSTALLATION_ID,
    resolveOrigin: () => 'https://nassaj.example',
  });
  const name = connectorHostRecentAuthCookieName;
  const req = { headers: { cookie: `${name}=${'a'.repeat(64)}; ${name}=${'b'.repeat(64)}` } } as express.Request;
  assert.equal(adapter.revoke(req, cookieJar(log), 7), false);
  assert.deepEqual(log, [`clear:${name}`, `clear:${connectorSecureCsrfCookieName}`]);
});

test('production entry point reports ok only when the session and both cookies were set', () => {
  const log: string[] = [];
  assert.equal(connectorOwnerSessionAvailable(), false);
  assert.equal(connectorOwnerSessionOrigin(), null);
  assert.equal(recordConnectorOwnerAuthentication(cookieJar(log), 7, 'password'), 'unavailable');
  let origin: string | null = null;
  let fenceOpen = true;
  configureConnectorOwnerAuthSessionProduction({
    repository: recordingRepository(log), installationId: INSTALLATION_ID,
    resolveOrigin: () => origin,
    executeWrite: effect => { if (!fenceOpen) return false; effect(); return true; },
  });
  assert.equal(connectorOwnerSessionAvailable(), true);
  assert.equal(recordConnectorOwnerAuthentication(cookieJar(log), 7, 'oidc'), 'unavailable');
  assert.deepEqual(log, [], 'no origin: no row and no cookie');
  origin = 'https://nassaj.example';
  assert.equal(connectorOwnerSessionOrigin(), 'https://nassaj.example');
  fenceOpen = false;
  assert.equal(recordConnectorOwnerAuthentication(cookieJar(log), 7, 'oidc'), 'unavailable');
  assert.deepEqual(log, [], 'fence refused: no row and no cookie');
  fenceOpen = true;
  assert.equal(recordConnectorOwnerAuthentication(cookieJar(log), 7, 'oidc'), 'ok');
  assert.deepEqual(log, ['rotate', 'write', `cookie:${connectorHostRecentAuthCookieName}`,
    `cookie:${connectorSecureCsrfCookieName}`]);
});

test('recent-auth origin: persisted wins, environment only when none is persisted, a read error fails closed', () => {
  let persisted: () => string | null = () => 'https://stored.example';
  let proposal: () => string | null = () => 'https://env.example';
  const source = createRecentAuthOriginSource({ readPersisted: () => persisted(), readProposal: () => proposal() });
  assert.equal(source(), 'https://stored.example');
  persisted = () => null;
  assert.equal(source(), 'https://env.example', 'pre-origin bootstrap uses the environment proposal');
  proposal = () => { throw new Error('connector_origin_invalid'); };
  assert.equal(source(), null, 'an invalid proposal is no origin');
  proposal = () => 'https://env.example';
  persisted = () => { throw new Error('connector_origin_database_tampered'); };
  assert.equal(source(), null, 'a tampered persisted origin never falls back to the environment');
});

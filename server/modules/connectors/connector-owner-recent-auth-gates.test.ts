import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type express from 'express';

import {
  connectorCsrfCookieNameFor,
  connectorHostRecentAuthCookieName,
  connectorLegacyRecentAuthCookieName,
  connectorRecentAuthCookieNameFor,
  createConnectorOwnerOperationGate,
  createConnectorOwnerReadGate,
  runtimeOriginSource,
  validatedConnectorCsrfToken,
} from './connector-owner-operation-gate.js';

const ORIGIN = 'https://nassaj.example';
const TOKEN = 'a'.repeat(64);
const CSRF = 'c'.repeat(64);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const fakeRepository = () => {
  const reads: string[] = [];
  return {
    reads,
    readOwnerAuthSession: (input: { sessionTokenHash: string }) => {
      reads.push(input.sessionTokenHash);
      return input.sessionTokenHash === sha256(TOKEN)
        ? { sessionId: 'session', csrfTokenHash: sha256(CSRF), authTime: 1, expiresAt: 600_001 }
        : null;
    },
    issueOwnerOperation: () => ({ sessionId: 'session', authTime: 1, expiresAt: 30_010 }),
    consumeOwnerOperation: () => true,
  };
};

const request = (cookie: string | undefined, origin: string | undefined, role = 'owner') => ({
  user: { id: 7, role },
  headers: cookie === undefined ? {} : { cookie },
  get: (name: string) => (name.toLowerCase() === 'origin' ? origin
    : name.toLowerCase() === 'x-csrf-token' ? CSRF : undefined),
}) as unknown as express.Request;

type Outcome = Readonly<{ admitted: boolean; status?: number; code?: string }>;

const run = (gate: express.RequestHandler, req: express.Request): Outcome => {
  let status: number | undefined;
  let code: string | undefined;
  let admitted = false;
  const res = {
    locals: {},
    status(value: number) { status = value; return this; },
    json(body: { code?: string }) { code = body.code; return this; },
  } as unknown as express.Response;
  gate(req, res, () => { admitted = true; });
  return { admitted, status, code };
};

const hostCookie = `${connectorHostRecentAuthCookieName}=${TOKEN}`;

test('cookie name follows the origin scheme and is null without a usable origin', () => {
  assert.equal(connectorRecentAuthCookieNameFor(ORIGIN), '__Host-nassaj_connector_recent_auth');
  assert.equal(connectorRecentAuthCookieNameFor('http://localhost:3001'), connectorLegacyRecentAuthCookieName);
  assert.equal(connectorRecentAuthCookieNameFor(null), null);
  assert.equal(connectorRecentAuthCookieNameFor(''), null);
  assert.equal(connectorRecentAuthCookieNameFor('not a url'), null);
});

test('operation gate: origin problems and missing step-up carry distinct codes', () => {
  const repository = fakeRepository();
  const gate = (origin: string | null | (() => string | null)) => createConnectorOwnerOperationGate({
    repository, installationId: 'installation', canonicalOrigin: origin ?? (() => null),
    operation: 'upsert_byo', now: () => 10,
  });

  assert.deepEqual(run(gate(null), request(hostCookie, ORIGIN)),
    { admitted: false, status: 503, code: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
  assert.deepEqual(run(gate(() => { throw new Error('store down'); }), request(hostCookie, ORIGIN)),
    { admitted: false, status: 503, code: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
  assert.deepEqual(run(gate(ORIGIN), request(hostCookie, 'https://attacker.example')),
    { admitted: false, status: 403, code: 'CONNECTOR_ORIGIN_REJECTED' });
  assert.deepEqual(run(gate(ORIGIN), request(hostCookie, undefined)),
    { admitted: false, status: 403, code: 'CONNECTOR_ORIGIN_REJECTED' });
  assert.deepEqual(repository.reads, [], 'origin refusals never touch the session store');

  assert.deepEqual(run(gate(ORIGIN), request(undefined, ORIGIN)),
    { admitted: false, status: 403, code: 'CONNECTOR_RECENT_AUTH_REQUIRED' });
  assert.deepEqual(run(gate(ORIGIN), request(`${hostCookie.replace(TOKEN, 'b'.repeat(64))}`, ORIGIN)),
    { admitted: false, status: 403, code: 'CONNECTOR_RECENT_AUTH_REQUIRED' }, 'expired/unknown session');
  assert.deepEqual(run(gate(ORIGIN), request(hostCookie, ORIGIN)).admitted, true);
});

test('a duplicated or wrongly named recent-auth cookie fails closed without a lookup', () => {
  const repository = fakeRepository();
  const gate = createConnectorOwnerOperationGate({
    repository, installationId: 'installation', canonicalOrigin: ORIGIN, operation: 'upsert_byo', now: () => 10,
  });
  const duplicated = `${hostCookie}; ${hostCookie}`;
  const shadowed = `${hostCookie}; ${connectorHostRecentAuthCookieName}=${'f'.repeat(64)}`;
  const legacyUnderHttps = `${connectorLegacyRecentAuthCookieName}=${TOKEN}`;
  for (const cookie of [duplicated, shadowed, legacyUnderHttps]) {
    assert.deepEqual(run(gate, request(cookie, ORIGIN)),
      { admitted: false, status: 403, code: 'CONNECTOR_RECENT_AUTH_REQUIRED' }, cookie);
  }
  assert.deepEqual(repository.reads, []);
});

test('the gate origin is read per request, so a changed origin applies without a restart', () => {
  let origin: string | null = ORIGIN;
  const gate = createConnectorOwnerOperationGate({
    repository: fakeRepository(), installationId: 'installation',
    canonicalOrigin: runtimeOriginSource({ canonicalOrigin: 'https://boot-time.example', resolveOrigin: () => origin }),
    operation: 'upsert_byo', now: () => 10,
  });
  assert.equal(run(gate, request(hostCookie, ORIGIN)).admitted, true);
  origin = 'https://moved.example';
  assert.deepEqual(run(gate, request(hostCookie, ORIGIN)),
    { admitted: false, status: 403, code: 'CONNECTOR_ORIGIN_REJECTED' });
  assert.equal(run(gate, request(hostCookie, 'https://moved.example')).admitted, true);
  origin = null;
  assert.equal(run(gate, request(hostCookie, 'https://moved.example')).code,
    'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED');
  assert.equal(runtimeOriginSource({ canonicalOrigin: ORIGIN }), ORIGIN, 'test runtimes keep a fixed origin');
});

test('read gate: unconfigured origin is 503, a duplicated cookie is a missing step-up', () => {
  const repository = fakeRepository();
  const gate = (canonicalOrigin: string | (() => string | null)) => createConnectorOwnerReadGate({
    repository, installationId: 'installation', canonicalOrigin, now: () => 10,
  });
  assert.deepEqual(run(gate(() => null), request(hostCookie, undefined)),
    { admitted: false, status: 503, code: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
  assert.deepEqual(run(gate(ORIGIN), request(`${hostCookie}; ${hostCookie}`, undefined)),
    { admitted: false, status: 403, code: 'CONNECTOR_RECENT_AUTH_REQUIRED' });
  assert.deepEqual(run(gate(ORIGIN), request(hostCookie, undefined, 'user')),
    { admitted: false, status: 403, code: 'CONNECTOR_OWNER_REQUIRED' });
  assert.equal(run(gate(ORIGIN), request(hostCookie, undefined)).admitted, true);
});

test('CSRF double-submit value is withheld when either cookie is ambiguous', () => {
  const repository = fakeRepository();
  const csrfCookie = `__Secure-nassaj_connector_csrf=${CSRF}`;
  const token = (cookie: string, origin: string | null = ORIGIN) =>
    validatedConnectorCsrfToken(request(cookie, undefined), repository, 'installation', 7, origin, 10);
  assert.equal(token(`${hostCookie}; ${csrfCookie}`), CSRF);
  assert.equal(token(`${hostCookie}; ${csrfCookie}; ${csrfCookie}`), null);
  assert.equal(token(`${hostCookie}; ${hostCookie}; ${csrfCookie}`), null);
  assert.equal(token(`${hostCookie}; ${csrfCookie}`, null), null);
  assert.equal(token(`${hostCookie}; nassaj_connector_csrf=${CSRF}`), null,
    'under https only the __Secure- name counts, so a non-Secure sibling cookie cannot stand in');
});

test('CSRF cookie name follows the origin scheme like the recent-auth cookie', () => {
  assert.equal(connectorCsrfCookieNameFor(ORIGIN), '__Secure-nassaj_connector_csrf');
  assert.equal(connectorCsrfCookieNameFor('http://localhost:3001'), 'nassaj_connector_csrf');
  assert.equal(connectorCsrfCookieNameFor(null), null);
  assert.equal(connectorCsrfCookieNameFor('not a url'), null);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';
import type express from 'express';

// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real session schema.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- integration test exercises real revocation queries.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';

import { RECENT_AUTH_MAX_AGE_MS } from './connector-auth-security.js';
import { createConnectorOwnerAuthSessionAdapter } from './connector-owner-auth-session.js';
import {
  connectorHostRecentAuthCookieName as connectorRecentAuthCookieName,
  createConnectorOwnerReadGate,
} from './connector-owner-operation-gate.js';

const ORIGIN = 'https://nassaj.example';

const OLD_TOKEN = '1'.repeat(64);
const NEW_TOKEN = '2'.repeat(64);

test('a stolen old cookie fails after new login and the current cookie fails after logout', () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (7, 'owner')");
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  let now = 1_000_000;
  let token = OLD_TOKEN;
  let sessionSequence = 1;
  const adapter = createConnectorOwnerAuthSessionAdapter({
    repository,
    installationId,
    resolveOrigin: () => ORIGIN,
    now: () => now,
    randomToken: () => token,
    randomCsrfToken: () => '3'.repeat(64),
    sessionId: () => `50000000-0000-4000-8000-${String(sessionSequence++).padStart(12, '0')}`,
  });
  const cookieResponse = { cookie: () => undefined, clearCookie: () => undefined } as unknown as express.Response;

  const accepted = (candidate: string): boolean => {
    const req = {
      user: { id: 7, role: 'owner' },
      headers: { cookie: `${connectorRecentAuthCookieName}=${candidate}` },
    } as unknown as express.Request;
    const res = { status: () => res, json: () => res } as unknown as express.Response;
    let next = false;
    createConnectorOwnerReadGate({ repository, installationId, canonicalOrigin: ORIGIN, now: () => now })(
      req, res, () => { next = true; },
    );
    return next;
  };

  try {
    adapter.record(cookieResponse, 7, 'password');
    assert.equal(accepted(OLD_TOKEN), true);

    now += 1;
    token = NEW_TOKEN;
    adapter.record(cookieResponse, 7, 'webauthn');
    assert.equal(accepted(OLD_TOKEN), false, 'rotation revokes the stolen old cookie');
    assert.equal(accepted(NEW_TOKEN), true);

    now += 1;
    const logoutReq = {
      headers: { cookie: `${connectorRecentAuthCookieName}=${NEW_TOKEN}` },
    } as express.Request;
    assert.equal(adapter.revoke(logoutReq, cookieResponse, 7), true);
    assert.equal(accepted(NEW_TOKEN), false, 'logout revokes before clearing the browser cookie');

    // An OIDC step-up session lives exactly RECENT_AUTH_MAX_AGE_MS (10 minutes).
    now += 1;
    token = '4'.repeat(64);
    adapter.record(cookieResponse, 7, 'oidc');
    const stored = database.prepare(
      'SELECT auth_method, expires_at_ms - auth_time_ms AS window FROM connector_owner_auth_sessions WHERE session_token_hash = ?',
    ).get(createHash('sha256').update(token).digest('hex')) as { auth_method: string; window: number };
    assert.deepEqual(stored, { auth_method: 'oidc', window: 10 * 60 * 1_000 });
    assert.equal(RECENT_AUTH_MAX_AGE_MS, 10 * 60 * 1_000);
    assert.equal(accepted(token), true);
    now += RECENT_AUTH_MAX_AGE_MS - 1;
    assert.equal(accepted(token), true, 'still inside the ten-minute window');
    now += 1;
    assert.equal(accepted(token), false, 'expired at exactly ten minutes');
  } finally {
    database.close();
  }
});

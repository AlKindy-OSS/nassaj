import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real auth schema.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real repository adapter.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';

import { RECENT_AUTH_MAX_AGE_MS } from './connector-auth-security.js';
import { createConnectorAuthReadinessRoutes } from './connector-auth-readiness.routes.js';
import { createConnectorOwnerAuthSessionAdapter } from './connector-owner-auth-session.js';
import {
  authorizedOwnerOperation,
  consumeAuthorizedOwnerOperation,
  createConnectorOwnerOperationGate,
} from './connector-owner-operation-gate.js';

const ORIGIN = 'https://nassaj.example';
const USER_ID = 7;

const cookieHeader = (headers: Headers): string => {
  const setCookies = (headers as Headers & { getSetCookie(): string[] }).getSetCookie();
  return setCookies.map(value => value.slice(0, value.indexOf(';'))).join('; ');
};

test('real login session drives readiness and POST, while rotation, logout, and expiry fail closed', async () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO users (id, username) VALUES (${USER_ID}, 'member');
  `);
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  let nowMs = 1_000_000;
  let sessionToken = '1'.repeat(64);
  let csrfToken = '2'.repeat(64);
  const sessionAdapter = createConnectorOwnerAuthSessionAdapter({
    repository,
    installationId,
    canonicalOrigin: ORIGIN,
    now: () => nowMs,
    randomToken: () => sessionToken,
    randomCsrfToken: () => csrfToken,
    sessionId: randomUUID,
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number; role: string } }).user = {
      id: USER_ID,
      role: 'user',
    };
    next();
  });
  app.post('/login', (_req, res) => {
    sessionAdapter.record(res, USER_ID, 'password');
    res.status(204).end();
  });
  app.post('/logout', (req, res) => {
    sessionAdapter.revoke(req, res, USER_ID);
    res.status(204).end();
  });
  app.use('/api/connectors/auth-readiness', createConnectorAuthReadinessRoutes({
    env: { NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1' },
    now: () => nowMs,
    runtime: () => ({ canonicalOrigin: ORIGIN, installationId, repository }),
  }));
  app.post('/api/connectors/protected', createConnectorOwnerOperationGate({
    repository,
    installationId,
    canonicalOrigin: ORIGIN,
    operation: 'upsert_personal_api_key',
    ownerOnly: false,
    now: () => nowMs,
  }), (_req, res) => {
    consumeAuthorizedOwnerOperation(authorizedOwnerOperation(res), 'upsert_personal_api_key', {
      repository,
      installationId,
      now: () => nowMs,
    });
    res.status(204).end();
  });

  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const readiness = async (cookie: string) => {
    const response = await fetch(`${baseUrl}/api/connectors/auth-readiness`, { headers: { cookie } });
    return {
      status: response.status,
      body: await response.json() as { csrfToken: string | null; recentAuthRequired: boolean },
    };
  };
  const protectedPost = (cookie: string, csrf: string) => fetch(`${baseUrl}/api/connectors/protected`, {
    method: 'POST', headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf },
  });

  try {
    const firstLogin = await fetch(`${baseUrl}/login`, { method: 'POST' });
    const firstCookies = cookieHeader(firstLogin.headers);
    const firstReadiness = await readiness(firstCookies);
    assert.equal(firstReadiness.status, 200);
    assert.equal(firstReadiness.body.csrfToken, csrfToken);
    assert.equal(firstReadiness.body.recentAuthRequired, false);
    assert.equal((await protectedPost(firstCookies, firstReadiness.body.csrfToken!)).status, 204);

    sessionToken = '3'.repeat(64);
    csrfToken = '4'.repeat(64);
    nowMs += 1_000;
    const rotatedLogin = await fetch(`${baseUrl}/login`, { method: 'POST' });
    const rotatedCookies = cookieHeader(rotatedLogin.headers);
    const stale = await readiness(firstCookies);
    assert.equal(stale.body.csrfToken, null);
    assert.equal(stale.body.recentAuthRequired, true);
    assert.equal((await protectedPost(firstCookies, '2'.repeat(64))).status, 403);
    assert.equal((await readiness(rotatedCookies)).body.csrfToken, csrfToken);
    assert.equal((await protectedPost(rotatedCookies, csrfToken)).status, 204);

    assert.equal((await fetch(`${baseUrl}/logout`, {
      method: 'POST', headers: { cookie: rotatedCookies },
    })).status, 204);
    const loggedOut = await readiness(rotatedCookies);
    assert.equal(loggedOut.body.csrfToken, null);
    assert.equal(loggedOut.body.recentAuthRequired, true);
    assert.equal((await protectedPost(rotatedCookies, csrfToken)).status, 403);

    sessionToken = '5'.repeat(64);
    csrfToken = '6'.repeat(64);
    const expiringLogin = await fetch(`${baseUrl}/login`, { method: 'POST' });
    const expiringCookies = cookieHeader(expiringLogin.headers);
    nowMs += RECENT_AUTH_MAX_AGE_MS + 1;
    const expired = await readiness(expiringCookies);
    assert.equal(expired.body.csrfToken, null);
    assert.equal(expired.body.recentAuthRequired, true);
    assert.equal((await protectedPost(expiringCookies, csrfToken)).status, 403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    database.close();
  }
});

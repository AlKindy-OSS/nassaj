/**
 * T-1946 — owner-only GET/PUT /api/settings/api-key-sso-window.
 *
 * The real settings router runs against a throwaway database with an injected
 * authenticated user (the server mounts authenticateToken before it). Checks
 * validation, owner-only access, the audit record and that a change reaches
 * API key authentication on the next check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import express from 'express';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { writeDisabledRecordOn } from '@/modules/database/repositories/sso-oidc-config.js';
import { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';

import settingsRouter from './settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PATH = '/api/settings/api-key-sso-window';

let currentUser: { id: number; role: string } = { id: 0, role: 'user' };
let server: Server;
let baseUrl = '';
let dbDir = '';
let ownerId = 0;
let memberId = 0;

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-sso-window-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();
  // ADR-194 S8 Q1: these tests pin the plain T-1946 window, which applies when SSO
  // is owner-disabled; the refusal while SSO is enforced but unavailable is in the
  // D1 matrices (sso-config.service and sso-credential-matrix tests).
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  ownerId = userDb.createUser('window-owner', 'hash', 'owner').id;
  memberId = userDb.createUser('window-member', 'hash', 'admin').id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = currentUser;
    next();
  });
  app.use('/api/settings', settingsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'PUT', body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${PATH}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function windowAudits(): Array<{ user_id: number | null; metadata: string }> {
  return getConnection()
    .prepare("SELECT user_id, metadata FROM audit_log WHERE action = 'api_key_sso_window_changed' ORDER BY id")
    .all() as Array<{ user_id: number | null; metadata: string }>;
}

test('owner reads the default window with its bounds', async () => {
  currentUser = { id: ownerId, role: 'owner' };
  const res = await call('GET');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { windowDays: 7, defaultDays: 7, minDays: 1, maxDays: 365 });
});

test('a non-owner can neither read nor change the window', async () => {
  currentUser = { id: memberId, role: 'admin' };
  assert.equal((await call('GET')).status, 403);
  const put = await call('PUT', { windowDays: 30 });
  assert.equal(put.status, 403);
  currentUser = { id: ownerId, role: 'owner' };
  assert.equal((await call('GET')).body.windowDays, 7, 'unchanged');
  assert.equal(windowAudits().length, 0);
});

test('invalid windowDays is rejected with invalid_window_days and changes nothing', async () => {
  currentUser = { id: ownerId, role: 'owner' };
  const invalid: unknown[] = [0, -3, 366, 7.5, '7', null, true, [7], {}];
  for (const windowDays of invalid) {
    const res = await call('PUT', { windowDays });
    assert.equal(res.status, 400, JSON.stringify(windowDays));
    assert.equal(res.body.code, 'invalid_window_days');
  }
  const missing = await call('PUT', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'invalid_window_days');
  assert.equal((await call('GET')).body.windowDays, 7);
  assert.equal(windowAudits().length, 0);
});

/** 'ok' when the key authenticates, else the refusal reason. */
function refusal(apiKey: string): string {
  const resolution = apiKeysDb.resolveApiKey(apiKey);
  return resolution.ok ? 'ok' : resolution.reason;
}

test('owner changes the window: audited once, applied to the next key check', async () => {
  currentUser = { id: ownerId, role: 'owner' };
  const member = userDb.createUser('window-linked', 'hash', 'user');
  const linkId = userIdentitiesDb.link(member.id, 'https://idp.example', 'sub-window');
  userIdentitiesDb.markAttested(linkId, member.id, Date.now() - 10 * DAY_MS);
  const key = apiKeysDb.createApiKey(member.id, 'window');
  assert.equal(refusal(key.apiKey), 'sso_attestation_expired', '10 days > default 7');

  const res = await call('PUT', { windowDays: 30 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, windowDays: 30, defaultDays: 7, minDays: 1, maxDays: 365 });
  assert.equal(refusal(key.apiKey), 'ok', 'revived by the wider window');

  const audits = windowAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.user_id, ownerId);
  assert.deepEqual(JSON.parse(audits[0]!.metadata), { from: 7, to: 30 });

  assert.equal((await call('PUT', { windowDays: 30 })).status, 200);
  assert.equal(windowAudits().length, 1, 'an unchanged value is not audited again');

  assert.equal((await call('PUT', { windowDays: 1 })).status, 200);
  assert.equal(refusal(key.apiKey), 'sso_attestation_expired', 'narrowed immediately');
  assert.equal((await call('GET')).body.windowDays, 1);
});

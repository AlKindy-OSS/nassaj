/**
 * B-464 — POST /api/settings/api-keys is limited to owner/admin.
 *
 * A member could previously mint a durable API key (which authenticates agent
 * calls that may run with bypassPermissions). The real settings router runs
 * against a throwaway database with an injected authenticated user.
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
import { userDb } from '@/modules/database/repositories/users.js';

import settingsRouter from './settings.js';

const PATH = '/api/settings/api-keys';

let currentUser: { id: number; role: string } = { id: 0, role: 'user' };
let server: Server;
let baseUrl = '';
let dbDir = '';
let ownerId = 0;
let adminId = 0;
let memberId = 0;

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-api-keys-role-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  ownerId = userDb.createUser('keys-owner', 'hash', 'owner').id;
  adminId = userDb.createUser('keys-admin', 'hash', 'admin').id;
  memberId = userDb.createUser('keys-member', 'hash', 'user').id;

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

async function call(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  suffix = '',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${PATH}${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function insufficientRoleAudits(userId: number): number {
  const row = getConnection()
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'insufficient_role' AND user_id = ?")
    .get(userId) as { n: number };
  return row.n;
}

test('a member cannot create an API key and nothing is stored', async () => {
  currentUser = { id: memberId, role: 'user' };
  const res = await call('POST', '', { keyName: 'sneaky' });
  assert.equal(res.status, 403);
  assert.equal(res.body.apiKey, undefined);
  assert.equal(apiKeysDb.getApiKeys(memberId).length, 0);
  assert.equal(insufficientRoleAudits(memberId), 1);
});

test('a missing or unknown role is refused (fail closed)', async () => {
  currentUser = { id: memberId, role: 'superuser' };
  assert.equal((await call('POST', '', { keyName: 'x' })).status, 403);
  currentUser = { id: memberId } as { id: number; role: string };
  assert.equal((await call('POST', '', { keyName: 'x' })).status, 403);
  assert.equal(apiKeysDb.getApiKeys(memberId).length, 0);
});

test('owner and admin can create API keys', async () => {
  for (const [id, role] of [[ownerId, 'owner'], [adminId, 'admin']] as const) {
    currentUser = { id, role };
    const res = await call('POST', '', { keyName: `${role}-key` });
    assert.equal(res.status, 200, role);
    assert.equal(res.body.success, true);
    assert.equal(apiKeysDb.getApiKeys(id).length, 1);
  }
});

test('creation still validates the key name for privileged roles', async () => {
  currentUser = { id: ownerId, role: 'owner' };
  assert.equal((await call('POST', '', { keyName: '   ' })).status, 400);
});

test('a member can still list, toggle and revoke only their own keys', async () => {
  // Seed a legacy member key directly (as minted before B-464).
  const legacy = apiKeysDb.createApiKey(memberId, 'legacy') as { id: number };
  currentUser = { id: memberId, role: 'user' };
  const list = await call('GET');
  assert.equal(list.status, 200);
  assert.equal((list.body.apiKeys as unknown[]).length, 1);

  const ownerKeyId = (apiKeysDb.getApiKeys(ownerId)[0] as { id: number }).id;
  assert.equal((await call('PATCH', `/${ownerKeyId}/toggle`, { isActive: false })).status, 404);
  assert.equal((await call('DELETE', `/${ownerKeyId}`)).status, 404);
  assert.equal(apiKeysDb.getApiKeys(ownerId).length, 1, 'owner key untouched');

  assert.equal((await call('PATCH', `/${legacy.id}/toggle`, { isActive: false })).status, 200);
  assert.equal((await call('DELETE', `/${legacy.id}`)).status, 200);
  assert.equal(apiKeysDb.getApiKeys(memberId).length, 0);
});

test('a member cannot re-enable a key, but owner/admin can', async () => {
  const legacy = apiKeysDb.createApiKey(memberId, 'legacy-2') as { id: number };
  currentUser = { id: memberId, role: 'user' };
  assert.equal((await call('PATCH', `/${legacy.id}/toggle`, { isActive: false })).status, 200);
  const enable = await call('PATCH', `/${legacy.id}/toggle`, { isActive: true });
  assert.equal(enable.status, 403);
  assert.equal(apiKeysDb.getApiKeys(memberId)[0].is_active, 0, 'still disabled');

  currentUser = { id: adminId, role: 'admin' };
  const adminKeyId = (apiKeysDb.getApiKeys(adminId)[0] as { id: number }).id;
  assert.equal((await call('PATCH', `/${adminKeyId}/toggle`, { isActive: false })).status, 200);
  assert.equal((await call('PATCH', `/${adminKeyId}/toggle`, { isActive: true })).status, 200);
  apiKeysDb.deleteApiKey(memberId, legacy.id);
});

test('authentication checks the key owner\'s CURRENT role on every use', () => {
  // A member key minted before B-464 never authenticates.
  const memberKey = apiKeysDb.createApiKey(memberId, 'pre-fix') as { id: number; apiKey: string };
  assert.deepEqual(apiKeysDb.resolveApiKey(memberKey.apiKey), { ok: false, reason: 'invalid' });
  apiKeysDb.deleteApiKey(memberId, memberKey.id);

  // An admin key works until the admin is demoted, then stops at once.
  const demotable = userDb.createUser('keys-demoted', 'hash', 'admin');
  const adminKey = apiKeysDb.createApiKey(demotable.id, 'admin-key') as { id: number; apiKey: string };
  const before = apiKeysDb.resolveApiKey(adminKey.apiKey);
  assert.equal(before.ok, true);
  const generation = (before as { user: { authorization_generation: number } }).user.authorization_generation;
  assert.equal(apiKeysDb.authenticationPrincipalState(adminKey.id, demotable.id, generation), 'current');

  getConnection().prepare("UPDATE users SET role = 'user' WHERE id = ?").run(demotable.id);
  assert.deepEqual(apiKeysDb.resolveApiKey(adminKey.apiKey), { ok: false, reason: 'invalid' });
  const afterGeneration = (getConnection().prepare('SELECT authorization_generation AS g FROM users WHERE id = ?')
    .get(demotable.id) as { g: number }).g;
  // In-flight revalidation refuses too, whichever generation the caller holds.
  assert.equal(apiKeysDb.authenticationPrincipalState(adminKey.id, demotable.id, afterGeneration), 'invalid');

  // The owner's key keeps working.
  const ownerKey = apiKeysDb.createApiKey(ownerId, 'owner-key-2') as { apiKey: string };
  assert.equal(apiKeysDb.resolveApiKey(ownerKey.apiKey).ok, true);
});

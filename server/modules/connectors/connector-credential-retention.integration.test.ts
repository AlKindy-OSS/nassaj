/**
 * T-1939 6B (round 3 veto): recent-auth retention on the PRODUCTION
 * composition. initializeDatabase installs the real runtime fence, so the
 * owner-session tables carry real BEFORE DELETE triggers; the startup hook
 * must purge through the fence and must never throw into server boot.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

/* eslint-disable boundaries/dependencies -- integration test boots the real database. */
import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';
/* eslint-enable boundaries/dependencies */

import { OWNER_AUTH_SESSION_RETENTION_MS } from './connector-credential-retention.js';
import { executeConnectorPolicyV2LifecycleWrite } from './connector-substrate-only.production.js';
import { runConnectorCredentialRetentionAtStartup } from './connector-user-grant.production.js';

const HOUR_MS = 60 * 60 * 1_000;
const hash = () => randomBytes(32).toString('hex');

let tempDirectory = '';
let previousDatabasePath: string | undefined;
let previousPublicOrigin: string | undefined;

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  previousPublicOrigin = process.env.NASSAJ_PUBLIC_ORIGIN;
  process.env.NASSAJ_PUBLIC_ORIGIN = 'https://nassaj.example';
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'connector-retention-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  stopReconcileScheduler();
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousPublicOrigin === undefined) delete process.env.NASSAJ_PUBLIC_ORIGIN;
  else process.env.NASSAJ_PUBLIC_ORIGIN = previousPublicOrigin;
  await rm(tempDirectory, { recursive: true, force: true });
});

const sessionExists = (sessionId: string): boolean => getConnection().prepare(
  'SELECT 1 FROM connector_owner_auth_sessions WHERE session_id = ?',
).get(sessionId) !== undefined;

const nonceCount = (sessionId: string): number => (getConnection().prepare(
  'SELECT count(*) AS n FROM connector_owner_operation_nonces WHERE session_id = ?',
).get(sessionId) as { n: number }).n;

test('the fresh production database fences both owner-session tables', () => {
  const triggers = (table: string) => (getConnection().prepare(`SELECT count(*) AS n FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = ? AND name LIKE 'connector_runtime_fence_%'`).get(table) as { n: number }).n;
  assert.equal(triggers('connector_owner_auth_sessions'), 3);
  assert.equal(triggers('connector_owner_operation_nonces'), 3);
});

test('startup retention purges old recent-auth sessions through the real fence and never throws', () => {
  const database = getConnection();
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  const userId = userDb.createUser('retention-member', 'x', 'user').id;
  const nowMs = Date.now();
  const expired = randomUUID();
  const revoked = randomUUID();
  const live = randomUUID();
  const revokedToken = hash();
  const record = (sessionId: string, authTimeMs: number, sessionTokenHash = hash()) =>
    repository.recordOwnerAuthSession({ sessionId, installationId, sessionTokenHash, csrfTokenHash: hash(),
      userId, authMethod: 'password', authTimeMs, expiresAtMs: authTimeMs + 10 * 60_000 });
  assert.equal(executeConnectorPolicyV2LifecycleWrite(() => {
    record(expired, nowMs - OWNER_AUTH_SESSION_RETENTION_MS - 2 * HOUR_MS);
    record(revoked, nowMs - 60_000, revokedToken);
    assert.ok(repository.issueOwnerOperation({ sessionId: revoked, requestId: randomUUID(), nonceHash: hash(),
      installationId, userId, operation: 'upsert_personal_api_key', nowMs, ttlMs: 60_000 }));
    assert.equal(repository.revokeOwnerAuthSession({ sessionTokenHash: revokedToken, installationId, userId,
      nowMs: nowMs - OWNER_AUTH_SESSION_RETENTION_MS - HOUR_MS }), true);
    record(live, nowMs);
  }), true, 'seeded through the fence');
  assert.equal(nonceCount(revoked), 1);

  // The reviewer's reproduction: a raw delete on these tables is refused.
  assert.throws(() => database.prepare('DELETE FROM connector_owner_auth_sessions WHERE session_id = ?')
    .run(expired), /connector_runtime_fence_required/u);
  assert.throws(() => database.prepare('DELETE FROM connector_owner_operation_nonces WHERE session_id = ?')
    .run(revoked), /connector_runtime_fence_required/u);

  assert.doesNotThrow(() => runConnectorCredentialRetentionAtStartup());
  assert.equal(sessionExists(expired), false, 'expired beyond retention: purged');
  assert.equal(sessionExists(revoked), false, 'revoked beyond retention: purged');
  assert.equal(nonceCount(revoked), 0, 'its nonces are purged with it');
  assert.equal(sessionExists(live), true, 'a live session is kept');
});

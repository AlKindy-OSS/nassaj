import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';
import type express from 'express';

// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real auth schema.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real fenced repository adapter.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';

import { createConnectorProfileManagementService } from './connector-auth-profile-management.js';
import {
  authorizedOwnerOperation,
  createConnectorOwnerOperationGate,
  type ConnectorOwnerOperation,
} from './connector-owner-operation-gate.js';
import type { ConnectorKekKeyring } from './connector-auth-vault.crypto.js';

const ORIGIN = 'https://nassaj.example';
const SESSION_TOKEN = 'b'.repeat(64);
const CSRF_TOKEN = 'f'.repeat(64);
const keyring: ConnectorKekKeyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 9),
};

const openDatabase = () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO users (id, username) VALUES (7, 'owner');
  `);
  migrateConnectorAuthSchema(database);
  return database;
};

const setup = (database: Database.Database, testCandidate: () => Promise<void> = async () => undefined) => {
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  repository.recordOwnerAuthSession({
    sessionId: randomUUID(),
    installationId,
    sessionTokenHash: createHash('sha256').update(SESSION_TOKEN).digest('hex'),
    csrfTokenHash: createHash('sha256').update(CSRF_TOKEN).digest('hex'),
    userId: 7,
    authMethod: 'password',
    authTimeMs: 999_000,
    expiresAtMs: 1_300_000,
  });
  const service = createConnectorProfileManagementService({
    installation: {
      installationId,
      canonicalOrigin: ORIGIN,
      callbackUrl: `${ORIGIN}/connectors/oauth/callback`,
    },
    repository,
    keyring,
    now: () => 1_000_000,
    env: {
      NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
      NASSAJ_CONNECTOR_AUTH_CERT_GOOGLE_WORKSPACE: '1',
    },
    testByoCandidate: testCandidate,
    testApiKeyCandidate: async () => undefined,
  });
  return { installationId, repository, service };
};

const authority = (
  repository: ReturnType<typeof createConnectorAuthDb>,
  installationId: string,
  operation: ConnectorOwnerOperation,
) => {
  const req = {
    user: { id: 7, role: 'owner' },
    headers: {
      cookie: `nassaj_connector_recent_auth=${SESSION_TOKEN}`,
      'x-csrf-token': CSRF_TOKEN,
    },
    get: (name: string) => name.toLowerCase() === 'origin' ? ORIGIN
      : name.toLowerCase() === 'x-csrf-token' ? CSRF_TOKEN : undefined,
  } as unknown as express.Request;
  const res = { locals: {}, status: () => res, json: () => res } as unknown as express.Response;
  let next = false;
  createConnectorOwnerOperationGate({
    repository, installationId, canonicalOrigin: ORIGIN, operation, now: () => 1_000_000,
  })(req, res, () => { next = true; });
  assert.equal(next, true);
  return authorizedOwnerOperation(res);
};

const expireLeases = (database: Database.Database) => {
  database.prepare(
    "UPDATE connector_auth_leases SET expires_at = datetime('now', '-1 second')",
  ).run();
};

const activeBindings = (database: Database.Database) => database.prepare(
  `SELECT field_purpose, secret_ref, status
   FROM connector_auth_profile_secret_bindings
   WHERE status = 'active' ORDER BY field_purpose`,
).all() as Array<{ field_purpose: string; secret_ref: string; status: string }>;

test('real repository activates two independently encrypted BYO fields atomically', async () => {
  const database = openDatabase();
  try {
    const { repository, service } = setup(database);
    const dto = await service.upsertByo(authority(repository, repository.getOrCreateInstallation(), 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'client-id', clientSecret: 'client-secret',
    });
    assert.equal(dto.configured, true);
    const profile = repository.listProfiles(repository.getOrCreateInstallation())[0];
    assert.deepEqual(Object.keys(profile.secretRefs).sort(), ['client_id', 'client_secret']);
    assert.equal(profile.secretRefs.client_id === profile.secretRefs.client_secret, false);
    assert.deepEqual(activeBindings(database).map(row => row.field_purpose), ['client_id', 'client_secret']);
    await service.upsertByo(authority(repository, repository.getOrCreateInstallation(), 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'replacement-id', clientSecret: 'replacement-secret',
    });
    assert.equal(activeBindings(database).length, 2, 'released lease permits an immediate retry');
    const inactive = database.prepare(
      "SELECT count(*) AS count FROM connector_auth_profile_secret_bindings WHERE status = 'inactive'",
    ).get() as { count: number };
    assert.equal(inactive.count, 2);
  } finally {
    database.close();
  }
});

test('candidate failure preserves the prior active binding set and leaves new rows inert', async () => {
  const database = openDatabase();
  try {
    const first = setup(database);
    await first.service.upsertByo(authority(first.repository, first.installationId, 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'old-client', clientSecret: 'old-secret',
    });
    const oldBindings = activeBindings(database);
    expireLeases(database);
    const failing = setup(database, async () => { throw new Error('provider rejected'); });
    await assert.rejects(() => failing.service.upsertByo(
      authority(failing.repository, failing.installationId, 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'new-client', clientSecret: 'new-secret',
    }), /candidate_test_failed/);
    assert.deepEqual(activeBindings(database), oldBindings);
    const candidates = database.prepare(
      "SELECT count(*) AS count FROM connector_auth_profile_secret_bindings WHERE status = 'candidate'",
    ).get() as { count: number };
    assert.equal(candidates.count, 2);
    const retry = setup(database);
    await retry.service.upsertByo(authority(retry.repository, retry.installationId, 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'retry-client', clientSecret: 'retry-secret',
    });
    assert.equal(activeBindings(database).length, 2, 'failed candidate releases its exact lease');
  } finally {
    database.close();
  }
});

test('provider-scoped DB lease permits only one concurrent BYO writer', async () => {
  const database = openDatabase();
  try {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = setup(database, async () => blocked);
    const second = setup(database);
    const pending = first.service.upsertByo(authority(first.repository, first.installationId, 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'one', clientSecret: 'secret-one',
    });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => second.service.upsertByo(
      authority(second.repository, second.installationId, 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'two', clientSecret: 'secret-two',
    }), /write_in_progress/);
    release();
    await pending;
    assert.equal(activeBindings(database).length, 2);
  } finally {
    database.close();
  }
});

test('stale fencing cannot replace an existing active binding set', async () => {
  const database = openDatabase();
  try {
    const initial = setup(database);
    await initial.service.upsertByo(authority(initial.repository, initial.installationId, 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'old-client', clientSecret: 'old-secret',
    });
    const oldBindings = activeBindings(database);
    expireLeases(database);
    const stale = setup(database, async () => {
      database.prepare(
        `UPDATE connector_auth_leases SET owner_token = ?, fencing_token = fencing_token + 1,
             expires_at = datetime('now', '+60 seconds')`,
      ).run('40000000-0000-4000-8000-000000000001');
    });
    await assert.rejects(() => stale.service.upsertByo(
      authority(stale.repository, stale.installationId, 'upsert_byo'), {
      providerId: 'google-workspace', clientId: 'stale-client', clientSecret: 'stale-secret',
    }), /fence_stale/);
    assert.deepEqual(activeBindings(database), oldBindings);
  } finally {
    database.close();
  }
});

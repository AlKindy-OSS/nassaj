import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import BetterSqlite3 from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import {
  CONNECTORS_TABLE_SCHEMA_SQL,
  CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL,
  INIT_SCHEMA_SQL,
} from '@/modules/database/schema.js';

import { createConnectorPlacementsDb } from './connector-placements.db.js';

const KEY = {
  connectorId: 'google-drive-u1',
  memberUserId: 1,
  bodyProvider: 'codex' as const,
  contractVersion: 'mcp-user-v1' as const,
};
const OWNER_A = '11111111-2222-7333-8444-555555555555';
const OWNER_B = '22222222-3333-7444-8555-666666666666';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const PROOF_A = { version: 2 as const, fingerprint: FINGERPRINT_A };
const PROOF_B = { version: 2 as const, fingerprint: FINGERPRINT_B };

async function withDatabase(run: (file: string) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp('/var/tmp/connector-placement-repo-');
  const file = path.join(directory, 'db.sqlite');
  process.env.DATABASE_PATH = file;
  await writeFile(file, '');
  closeConnection();
  const db = getConnection();
  db.pragma('foreign_keys = ON');
  db.exec(INIT_SCHEMA_SQL);
  db.exec(CONNECTORS_TABLE_SCHEMA_SQL);
  db.exec(CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'member', 'hash', 'member')").run();
  db.prepare(
    `INSERT INTO connectors (
       id, service, display_name, credential_mode, owner_user_id, created_by
     ) VALUES (?, 'google-drive', 'Drive', 'per_member', 1, 1)`,
  ).run(KEY.connectorId);
  try {
    await run(file);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('desired generations are monotonic and repository output exposes no fingerprints', async () => {
  await withDatabase(() => {
    const repository = createConnectorPlacementsDb(getConnection());
    assert.equal(repository.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_A, true), true);
    assert.equal(repository.getStatus(KEY)?.desiredGeneration, 1);
    assert.equal(repository.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_A, true), true);
    assert.equal(repository.getStatus(KEY)?.desiredGeneration, 1);
    assert.equal(repository.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_B, true), true);
    const changed = repository.getStatus(KEY)!;
    assert.equal(changed.desiredGeneration, 2);
    assert.equal(repository.stageDesiredIfConnectorCurrent(
      KEY, 0, { version: 1, fingerprint: FINGERPRINT_B }, true,
    ), true);
    assert.equal(
      repository.getStatus(KEY)?.desiredGeneration,
      3,
      'proof format rotation is a new desired generation even when the digest text matches',
    );
    const rendered = JSON.stringify(changed);
    assert.equal(rendered.includes(FINGERPRINT_A), false);
    assert.equal(rendered.includes(FINGERPRINT_B), false);
    assert.equal(rendered.includes('fingerprint'), false);
  });
});

test('leases are UUID-owned, expiry-fenced, and stale generation CAS cannot publish', async () => {
  await withDatabase(() => {
    const repository = createConnectorPlacementsDb(getConnection());
    repository.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_A, true);
    assert.throws(
      () => repository.acquireLease(KEY, { ownerId: 'worker-a', nowMs: 1_000, leaseMs: 500 }),
      /connector_placement_lease_invalid/,
    );
    const first = repository.acquireLease(KEY, { ownerId: OWNER_A, nowMs: 1_000, leaseMs: 500 });
    assert.ok(first);
    assert.equal(first.desiredGeneration, 1);
    assert.equal(first.expiresAtMs, 1_500);

    repository.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_B, true);
    assert.equal(
      repository.markHealthy(first, PROOF_A, 1_100),
      false,
      'changed desired material invalidates the old lease',
    );
    const second = repository.acquireLease(KEY, { ownerId: OWNER_B, nowMs: 1_100, leaseMs: 500 });
    assert.ok(second);
    assert.equal(second.desiredGeneration, 2);
    assert.ok(second.fencingToken > first.fencingToken);
    assert.deepEqual(repository.getConfigWriteProof(second, 1_200), {
      desiredProof: PROOF_B,
      priorAppliedProof: null,
    });
    assert.equal(repository.markHealthy(second, PROOF_B, 1_200), true);
    assert.equal(repository.getStatus(KEY)?.state, 'healthy');

    repository.stageDesiredIfConnectorCurrent(
      KEY, 0, { version: 1, fingerprint: FINGERPRINT_A }, true,
    );
    const rotation = repository.acquireLease(KEY, { ownerId: OWNER_A, nowMs: 1_300, leaseMs: 500 });
    assert.ok(rotation);
    assert.deepEqual(repository.getConfigWriteProof(rotation, 1_301), {
      desiredProof: { version: 1, fingerprint: FINGERPRINT_A },
      priorAppliedProof: PROOF_B,
    });
    assert.equal(
      repository.getConfigWriteProof({ ...rotation, connectorId: 'other' }, 1_301),
      null,
      'the config-write proof uses the complete placement key',
    );
  });
});

test('two connections contend safely and backoff is stored without holding a transaction over I/O', async () => {
  await withDatabase((file) => {
    const firstDb = getConnection();
    const secondDb = new BetterSqlite3(file);
    secondDb.pragma('foreign_keys = ON');
    secondDb.pragma('busy_timeout = 1000');
    try {
      const first = createConnectorPlacementsDb(firstDb);
      const second = createConnectorPlacementsDb(secondDb);
      first.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_A, true);
      const lease = first.acquireLease(KEY, { ownerId: OWNER_A, nowMs: 5_000, leaseMs: 100 });
      assert.ok(lease);
      assert.equal(second.acquireLease(KEY, { ownerId: OWNER_B, nowMs: 5_050, leaseMs: 100 }), null);

      let providerIoObservedTransaction = true;
      const mockedProviderIo = (): void => {
        providerIoObservedTransaction = firstDb.inTransaction || secondDb.inTransaction;
      };
      mockedProviderIo();
      assert.equal(providerIoObservedTransaction, false);

      assert.equal(first.markFailure(lease, {
        nowMs: 5_050,
        retryAfterMs: 2_000,
        errorCode: 'provider_timeout',
      }), true);
      const status = second.getStatus(KEY);
      assert.equal(status?.state, 'degraded');
      assert.equal(status?.attemptCount, 1);
      assert.equal(status?.nextRetryAt, new Date(7_050).toISOString());
      assert.equal(status?.lastErrorCode, 'provider_timeout');

      assert.equal(
        second.acquireLease(KEY, { ownerId: OWNER_B, nowMs: 7_049, leaseMs: 100 }),
        null,
        'persisted backoff prevents early reacquisition',
      );

      const replacement = second.acquireLease(KEY, { ownerId: OWNER_B, nowMs: 7_050, leaseMs: 100 });
      assert.ok(replacement);
      assert.ok(replacement.fencingToken > lease.fencingToken);
      assert.equal(
        first.markHealthy(lease, PROOF_A, 7_060),
        false,
        'the old token cannot overwrite the new owner',
      );
      assert.throws(
        () => second.acquireLease(KEY, {
          ownerId: OWNER_A,
          nowMs: Number.MAX_SAFE_INTEGER,
          leaseMs: 1,
        }),
        /connector_placement_deadline_invalid/,
      );
      assert.throws(
        () => second.markFailure(replacement, {
          nowMs: Number.MAX_SAFE_INTEGER,
          retryAfterMs: 1,
          errorCode: 'provider_timeout',
        }),
        /connector_placement_deadline_invalid/,
      );
    } finally {
      secondDb.close();
    }
  });
});

test('blocked failures have no retry date', async () => {
  await withDatabase(() => {
    const repository = createConnectorPlacementsDb(getConnection());
    repository.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_A, true);
    const lease = repository.acquireLease(KEY, { ownerId: OWNER_A, nowMs: 8_000, leaseMs: 100 });
    assert.ok(lease);
    assert.equal(repository.markFailure(lease, {
      nowMs: 8_050,
      retryAfterMs: 2_000,
      errorCode: 'credential_revoked',
      blocked: true,
    }), true);
    const status = repository.getStatus(KEY);
    assert.equal(status?.state, 'blocked');
    assert.equal(status?.nextRetryAt, null);
    assert.equal(
      repository.acquireLease(KEY, { ownerId: OWNER_B, nowMs: 20_000, leaseMs: 100 }),
      null,
    );
  });
});

test('source revision fences stale writes and absence requires the disabled lifecycle', async () => {
  await withDatabase(() => {
    const db = getConnection();
    const repository = createConnectorPlacementsDb(db);
    assert.equal(repository.stageDesiredIfConnectorCurrent(KEY, 0, PROOF_A, true), true);
    const staleLease = repository.acquireLease(KEY, {
      ownerId: OWNER_A, nowMs: 10_000, leaseMs: 1_000,
    });
    assert.ok(staleLease);

    db.prepare('UPDATE connectors SET source_revision = 2 WHERE id = ?').run(KEY.connectorId);
    assert.equal(repository.getConfigWriteProof(staleLease, 10_100), null);
    assert.equal(repository.markHealthy(staleLease, PROOF_A, 10_100), false);
    assert.equal(repository.getStatus(KEY)?.state, 'pending');
    db.prepare('UPDATE connectors SET source_revision = 1 WHERE id = ?').run(KEY.connectorId);
    assert.equal(
      repository.acquireLease(KEY, { ownerId: OWNER_B, nowMs: 12_000, leaseMs: 500 }),
      null,
    );
    assert.equal(repository.listPublicStatuses([KEY.connectorId], 1)[0]?.desiredAppliedMatch, false);
    assert.throws(
      () => repository.stageDesiredIfConnectorCurrent(KEY, 1, PROOF_A, true),
      /connector_placement_source_revision_invalid/,
    );
    db.prepare('UPDATE connectors SET source_revision = 2 WHERE id = ?').run(KEY.connectorId);
    assert.equal(repository.stageDesiredIfConnectorCurrent(KEY, 2, PROOF_A, true), true);
    assert.equal(repository.getStatus(KEY)?.desiredGeneration, 2);

    db.prepare(
      'UPDATE connectors SET enabled = 0, source_revision = 4 WHERE id = ?',
    ).run(KEY.connectorId);
    assert.equal(repository.stageDesiredIfConnectorCurrent(KEY, 4, PROOF_B, true), false);
    assert.equal(repository.stageDesiredIfConnectorCurrent(KEY, 4, PROOF_B, false), true);
    assert.ok(repository.acquireLease(KEY, { ownerId: OWNER_B, nowMs: 20_000, leaseMs: 500 }));
  });
});

test('legacy unbound desired rows cannot acquire a config-write lease', async () => {
  await withDatabase(() => {
    const repository = createConnectorPlacementsDb(getConnection());
    repository.upsertDesired(KEY, PROOF_A);
    assert.equal(
      repository.acquireLease(KEY, { ownerId: OWNER_A, nowMs: 30_000, leaseMs: 500 }),
      null,
    );
    assert.equal(repository.getStatus(KEY)?.state, 'pending');
  });
});

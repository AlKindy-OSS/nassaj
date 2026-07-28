/**
 * auth-rejection-audit.test.ts — noise policy for `auth_rejected` rows (T-182,
 * qa-critic ح-2/ح-3/ح-4).
 *
 * Verifies, against a real migrated SQLite database (isolated temp file):
 *  1. RARE reasons (pwd_iat_stale, user_missing, bad_signature, verify_error)
 *     are recorded as ONE row immediately, carrying reason + transport + the
 *     unverified userId + metadata.unverified.
 *  2. NOISY reasons (no_token, expired) are NOT one row per event: repeated
 *     events with the same reason+userId+ip aggregate into a single row with
 *     metadata.count on flush.
 *  3. No token (or token-shaped value) is ever written into a recorded row.
 *
 * Runner: Node built-in test runner (node:test + node:assert) via tsx.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import {
  recordAuthRejection,
  __flushAuthRejectionAggregatesForTest,
} from '@/middleware/auth-rejection-audit.js';

type Row = {
  action: string;
  user_id: number | null;
  metadata: string | null;
  ip_address: string | null;
  user_agent: string | null;
};

function allAuthRejected(): Row[] {
  const db = getConnection();
  return db
    .prepare(
      "SELECT action, user_id, metadata, ip_address, user_agent FROM audit_log WHERE action = 'auth_rejected' ORDER BY id ASC"
    )
    .all() as Row[];
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-rejection-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();

  try {
    await runTest();
  } finally {
    // Drain any pending aggregates so they don't leak into the next test's DB.
    __flushAuthRejectionAggregatesForTest();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('rare reasons are recorded immediately, one row each, with unverified userId', async () => {
  await withIsolatedDatabase(() => {
    for (const reason of ['pwd_iat_stale', 'user_missing', 'bad_signature', 'verify_error']) {
      recordAuthRejection({
        reason,
        transport: 'rest',
        userId: 7,
        ipAddress: '203.0.113.5',
        userAgent: 'ua',
        unverified: true,
      });
    }

    const rows = allAuthRejected();
    assert.equal(rows.length, 4, 'each rare reason yields exactly one row immediately');

    for (const row of rows) {
      // Unverified id never populates the FK column (would fail the FK / be lost).
      assert.equal(row.user_id, null);
      assert.equal(row.ip_address, '203.0.113.5');
      const meta = JSON.parse(row.metadata as string);
      assert.equal(meta.transport, 'rest');
      assert.equal(meta.unverified, true);
      assert.equal(meta.claimedUserId, 7);
      assert.ok(typeof meta.reason === 'string');
      // Not aggregated → no count field.
      assert.equal('count' in meta, false);
    }
  });
});

test('noisy reasons aggregate into a single counted row per key', async () => {
  await withIsolatedDatabase(() => {
    // 5 identical expired events + 3 identical no_token events.
    for (let i = 0; i < 5; i += 1) {
      recordAuthRejection({
        reason: 'expired',
        transport: 'rest',
        userId: 9,
        ipAddress: '198.51.100.2',
        userAgent: 'ua',
        unverified: true,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      recordAuthRejection({
        reason: 'no_token',
        transport: 'ws',
        ipAddress: '198.51.100.3',
        userAgent: 'ua',
      });
    }

    // Nothing written yet — aggregated reasons wait for the flush window.
    assert.equal(allAuthRejected().length, 0, 'noisy reasons are not written per-event');

    __flushAuthRejectionAggregatesForTest();

    const rows = allAuthRejected();
    assert.equal(rows.length, 2, 'two aggregation keys → two rows');

    const byReason = new Map(rows.map((r) => [JSON.parse(r.metadata as string).reason, r]));

    const expiredMeta = JSON.parse(byReason.get('expired')!.metadata as string);
    assert.equal(expiredMeta.count, 5);
    assert.equal(expiredMeta.aggregated, true);
    assert.equal(expiredMeta.transport, 'rest');

    const noTokenMeta = JSON.parse(byReason.get('no_token')!.metadata as string);
    assert.equal(noTokenMeta.count, 3);
    assert.equal(noTokenMeta.aggregated, true);
    assert.equal(noTokenMeta.transport, 'ws');
  });
});

test('a recorded rejection never contains a token-shaped value', async () => {
  await withIsolatedDatabase(() => {
    recordAuthRejection({
      reason: 'bad_signature',
      transport: 'rest',
      userId: 1,
      ipAddress: '203.0.113.10',
      userAgent: 'ua',
      unverified: true,
    });

    const rows = allAuthRejected();
    assert.equal(rows.length, 1);
    const serialized = JSON.stringify(rows[0]);
    // No JWT-looking substring anywhere in the persisted row.
    assert.equal(/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(serialized), false);
  });
});

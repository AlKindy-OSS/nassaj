/**
 * audit-log.test.ts — repository behaviour for the T-182 enrichment.
 *
 * Verifies, against a real migrated SQLite database (isolated temp file):
 *  1. record() persists user_agent and truncates it to MAX_USER_AGENT_LEN (512).
 *  2. record() never throws even when the audit_log table is structurally broken
 *     (the request path must never break because auditing failed).
 *  3. record() never writes a token (or any caller secret) into metadata — it
 *     stores exactly the metadata object given and nothing the caller did not
 *     pass.
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
import { auditLogDb } from '@/modules/database/repositories/audit-log.js';

type Row = {
  action: string;
  metadata: string | null;
  ip_address: string | null;
  user_agent: string | null;
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'audit-log-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('record persists the user_agent string', async () => {
  await withIsolatedDatabase(() => {
    auditLogDb.record('login_success', {
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (TestRunner)',
    });

    const db = getConnection();
    const row = db
      .prepare('SELECT action, metadata, ip_address, user_agent FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as Row;

    assert.equal(row.action, 'login_success');
    assert.equal(row.ip_address, '203.0.113.7');
    assert.equal(row.user_agent, 'Mozilla/5.0 (TestRunner)');
  });
});

test('record truncates an over-length user_agent to 512 chars', async () => {
  await withIsolatedDatabase(() => {
    const longUa = 'A'.repeat(1000);
    auditLogDb.record('auth_rejected', { userAgent: longUa, metadata: { reason: 'expired' } });

    const db = getConnection();
    const row = db
      .prepare('SELECT user_agent FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as Row;

    assert.equal(row.user_agent?.length, 512);
    assert.equal(row.user_agent, 'A'.repeat(512));
  });
});

test('record stores null user_agent when not provided', async () => {
  await withIsolatedDatabase(() => {
    auditLogDb.record('logout', { userId: null });

    const db = getConnection();
    const row = db
      .prepare('SELECT user_agent FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as Row;

    assert.equal(row.user_agent, null);
  });
});

test('record does not throw when the audit_log table is broken', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    // Structurally break the table so the INSERT cannot succeed.
    db.exec('DROP TABLE audit_log');

    // Must swallow the error internally and return normally.
    assert.doesNotThrow(() => {
      auditLogDb.record('login_failure', {
        ipAddress: '198.51.100.1',
        userAgent: 'broken-table-client',
        metadata: { reason: 'bad_password' },
      });
    });
  });
});

test('record never writes a token into metadata (stores only what the caller passes)', async () => {
  await withIsolatedDatabase(() => {
    // Caller passes ONLY a sanitized reason — no token field anywhere. userId is
    // null here (the repo does not enforce caller policy; FK-safe id handling is
    // the recorder's job, exercised in auth-rejection-audit.test.ts).
    auditLogDb.record('auth_rejected', {
      userId: null,
      ipAddress: '203.0.113.9',
      userAgent: 'agent',
      metadata: { reason: 'bad_signature', unverified: true },
    });

    const db = getConnection();
    const row = db
      .prepare('SELECT metadata FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as Row;

    assert.ok(row.metadata, 'metadata should be present');
    const parsed = JSON.parse(row.metadata as string);
    assert.deepEqual(parsed, { reason: 'bad_signature', unverified: true });
    // Defensive: no JWT-looking field leaked in.
    assert.equal('token' in parsed, false);
    assert.equal(/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(row.metadata as string), false);
  });
});

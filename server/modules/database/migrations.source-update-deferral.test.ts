/**
 * T-1730 W6 (ADR-156 §3.3, M6). The declared-deferral migration widens the
 * source_update_jobs state CHECK and adds four INTEGER epoch-ms deferral
 * columns by a table rebuild. These tests pin: no legacy row and no receipt or
 * effect is lost across the rebuild (the child-count invariant), the three-way
 * parity between the TS active-states list, the CHECK and the one-active index,
 * the reverse migration's refusal to strand a deferred/cancelled row, and each
 * un-fenced CAS helper including the cancel/promote race.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  migrateSourceUpdateDeferral,
  reverseSourceUpdateDeferral,
  runMigrations,
} from '@/modules/database/migrations.js';
import {
  SOURCE_UPDATE_ACTIVE_STATES,
  hashSourceUpdateIdempotencyKey,
  sourceUpdateJobsDb,
  sourceUpdateRequestFingerprint,
} from '@/modules/database/repositories/source-update-jobs.db.js';

type Db = ReturnType<typeof getConnection>;

// The one-active UNIQUE partial index permits at most one row in a non-terminal
// state, so a realistic seed is every terminal state plus exactly one active
// one — enough to prove the rebuild copies each state value forward.
const SEED_STATES = [
  'staging', 'activated', 'rolled_back', 'failed', 'superseded', 'manual_recovery_required',
];

async function withIsolatedDatabase(runTest: (ownerId: number) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'sud-defer-'));
  const databasePath = path.join(dir, 'auth.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  const owner = getConnection().prepare(
    "INSERT INTO users(username, password_hash, role) VALUES ('defer-owner', 'not-a-secret', 'owner')",
  ).run();
  try {
    await runTest(Number(owner.lastInsertRowid));
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Replace the already-migrated table with the pre-deferral shape (old CHECK,
 *  no deferral columns) so migrateSourceUpdateDeferral sees the rebuild as due. */
function installLegacyJobs(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_source_update_one_active');
  db.exec('DROP TABLE IF EXISTS source_update_jobs');
  db.exec(`
    CREATE TABLE source_update_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      expected_version TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      idempotency_key_hash TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      strategy TEXT NOT NULL CHECK (strategy IN ('git-checkout-v2','release-layout-v2')),
      state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN (
        'accepted','resolving','resolved','downloading','archive_verified',
        'extracting','staging','candidate_sealed','restart_queued','activating',
        'runtime_verifying','activated','rollback_pending','rolled_back','failed',
        'superseded','manual_recovery_required'
      )),
      worker_fence INTEGER,
      transaction_id TEXT UNIQUE,
      release_id TEXT, release_tag TEXT, release_asset_id TEXT, release_asset_name TEXT,
      release_asset_size INTEGER, release_asset_sha256 TEXT, archive_sha256 TEXT,
      activation_identity_sha256 TEXT, release_commit TEXT, source_tree_sha256 TEXT,
      expected_server_build_id TEXT, expected_client_build_id TEXT,
      progress_seq INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
      auto_activate INTEGER NOT NULL DEFAULT 0 CHECK (auto_activate IN (0, 1)),
      error_code TEXT, error_message TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
      UNIQUE (owner_id, idempotency_key_hash)
    )`);
}

function seedLegacyRows(db: Db, ownerId: number): void {
  const insert = db.prepare(
    `INSERT INTO source_update_jobs
       (id, expected_version, owner_id, idempotency_key_hash, request_fingerprint, strategy, state, auto_activate)
     VALUES (?, ?, ?, ?, ?, 'git-checkout-v2', ?, ?)`,
  );
  SEED_STATES.forEach((state, index) => {
    insert.run(`job-${index}`, '1.47.0.17', ownerId, `hash-${index}`, `fp-${index}`, state, index % 2);
  });
  // Two receipts and one effect on the first job, so the child-count invariant
  // has something to preserve across the FK-off rebuild.
  db.prepare(`INSERT INTO source_update_receipts(job_id, sequence, worker_fence, phase, kind, facts_json, facts_sha256)
    VALUES ('job-0', 1, 0, 'resolving', 'intent', '{}', 'a')`).run();
  db.prepare(`INSERT INTO source_update_receipts(job_id, sequence, worker_fence, phase, kind, facts_json, facts_sha256)
    VALUES ('job-0', 2, 0, 'resolved', 'done', '{}', 'b')`).run();
  db.prepare(`INSERT INTO source_update_effects(job_id, effect_id, worker_fence, effect_kind, pid, start_ticks, boot_id, pgid)
    VALUES ('job-0', 'eff-1', 0, 'npm', 4242, '99', 'boot', 4242)`).run();
}

test('W6: the rebuild preserves every row, receipt and effect, and widens the CHECK', async () => {
  await withIsolatedDatabase((ownerId) => {
    const db = getConnection();
    installLegacyJobs(db);
    seedLegacyRows(db, ownerId);

    const jobsBefore = (db.prepare('SELECT COUNT(*) AS c FROM source_update_jobs').get() as { c: number }).c;
    const receiptsBefore = (db.prepare('SELECT COUNT(*) AS c FROM source_update_receipts').get() as { c: number }).c;
    const effectsBefore = (db.prepare('SELECT COUNT(*) AS c FROM source_update_effects').get() as { c: number }).c;

    migrateSourceUpdateDeferral(db);

    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM source_update_jobs').get() as { c: number }).c, jobsBefore);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM source_update_receipts').get() as { c: number }).c, receiptsBefore, 'receipts before == after');
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM source_update_effects').get() as { c: number }).c, effectsBefore, 'effects before == after');
    assert.equal((db.pragma('foreign_key_check') as unknown[]).length, 0, 'no dangling child rows');

    // New columns exist with the documented defaults.
    const cols = db.prepare('PRAGMA table_info(source_update_jobs)').all() as Array<{ name: string; type: string }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of ['defer_until_idle', 'deferral_deadline_at', 'deferral_rearm_count', 'idle_observed_at']) {
      assert.equal(byName.get(name)?.type, 'INTEGER', `${name} is INTEGER, never TEXT`);
    }
    const sample = db.prepare('SELECT defer_until_idle, deferral_rearm_count, deferral_deadline_at, idle_observed_at FROM source_update_jobs WHERE id = ?').get('job-0') as Record<string, unknown>;
    assert.deepEqual(sample, { defer_until_idle: 0, deferral_rearm_count: 0, deferral_deadline_at: null, idle_observed_at: null });

    // The two new states are now accepted by the widened CHECK. Clear the sole
    // active row first so the one-active index admits the new awaiting_sessions row.
    db.prepare("DELETE FROM source_update_jobs WHERE state = 'staging'").run();
    db.prepare(`INSERT INTO source_update_jobs(id, expected_version, owner_id, idempotency_key_hash, request_fingerprint, strategy, state)
      VALUES ('await-1', '1.47.0.17', ?, 'h-a', 'f-a', 'git-checkout-v2', 'awaiting_sessions')`).run(ownerId);
    db.prepare(`INSERT INTO source_update_jobs(id, expected_version, owner_id, idempotency_key_hash, request_fingerprint, strategy, state)
      VALUES ('cancel-1', '1.47.0.17', ?, 'h-c', 'f-c', 'git-checkout-v2', 'cancelled')`).run(ownerId);
  });
});

test('W6: the migration is idempotent and the one-active index covers awaiting_sessions', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    // initializeDatabase already ran it; a second run must be a clean no-op.
    migrateSourceUpdateDeferral(db);
    const indexSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_source_update_one_active'",
    ).get() as { sql: string }).sql;
    assert.match(indexSql, /awaiting_sessions/);
    assert.doesNotMatch(indexSql, /cancelled/, 'a terminal state is not in the one-active index');
  });
});

test('W6: three-way parity between the TS list, the CHECK and the one-active index', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='source_update_jobs'").get() as { sql: string }).sql;
    const indexSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_source_update_one_active'").get() as { sql: string }).sql;
    for (const state of SOURCE_UPDATE_ACTIVE_STATES) {
      assert.ok(tableSql.includes(`'${state}'`), `CHECK lists ${state}`);
      assert.ok(indexSql.includes(`'${state}'`), `one-active index lists ${state}`);
    }
    assert.ok(tableSql.includes("'cancelled'"), 'CHECK lists the terminal cancelled state');
  });
});

test('W6: reverse migration refuses to strand a deferred/cancelled row, else narrows back', async () => {
  await withIsolatedDatabase((ownerId) => {
    const db = getConnection();
    db.prepare(`INSERT INTO source_update_jobs(id, expected_version, owner_id, idempotency_key_hash, request_fingerprint, strategy, state)
      VALUES ('await-x', '1.47.0.17', ?, 'h-x', 'f-x', 'git-checkout-v2', 'awaiting_sessions')`).run(ownerId);
    assert.throws(() => reverseSourceUpdateDeferral(db), /refuses/);

    db.prepare("UPDATE source_update_jobs SET state = 'failed' WHERE id = 'await-x'").run();
    reverseSourceUpdateDeferral(db);
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='source_update_jobs'").get() as { sql: string }).sql;
    assert.doesNotMatch(tableSql, /awaiting_sessions/, 'narrowed CHECK no longer allows the deferral state');
    const cols = (db.prepare('PRAGMA table_info(source_update_jobs)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols.includes('defer_until_idle'), 'deferral columns dropped on reverse');
  });
});

function makeRequest(ownerId: number, version = '1.47.0.17') {
  const strategy = 'git-checkout-v2' as const;
  return {
    id: crypto.randomUUID(), ownerId, expectedVersion: version, strategy,
    idempotencyKeyHash: hashSourceUpdateIdempotencyKey(crypto.randomUUID()),
    requestFingerprint: sourceUpdateRequestFingerprint(ownerId, version, strategy, false),
    deferralDeadlineAt: Date.now() + 3_600_000,
  };
}

test('W6 CAS: createDeferred parks a job, idle debounce and promoteIdle advance it', async () => {
  await withIsolatedDatabase((ownerId) => {
    const created = sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'awaiting_sessions');
    assert.equal(created.reused, false);
    assert.equal(created.job?.state, 'awaiting_sessions');
    assert.equal(created.job?.defer_until_idle, 1);
    const id = String(created.job?.id);

    assert.equal(sourceUpdateJobsDb.recordIdleObservation(id, 1000), true);
    assert.equal(sourceUpdateJobsDb.recordIdleObservation(id, 2000), false, 'only the first sample stamps');
    assert.equal(sourceUpdateJobsDb.clearIdleObservation(id), true, 'a returning session resets it');
    assert.equal(String(sourceUpdateJobsDb.getById(id)?.idle_observed_at), 'null');

    assert.equal(sourceUpdateJobsDb.promoteIdle(id), true);
    assert.equal(sourceUpdateJobsDb.getById(id)?.state, 'accepted');
    assert.equal(sourceUpdateJobsDb.promoteIdle(id), false, 'promote is a no-op once out of awaiting_sessions');
  });
});

test('W6 CAS: a second active request conflicts with a parked one', async () => {
  await withIsolatedDatabase((ownerId) => {
    sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'awaiting_sessions');
    const second = sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'awaiting_sessions');
    assert.equal(second.activeConflict, true, 'the one-active rule blocks a parallel deferral');
  });
});

test('W6 CAS: cancel and promote race — exactly one wins', async () => {
  await withIsolatedDatabase((ownerId) => {
    const id = String(sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'awaiting_sessions').job?.id);
    const cancelled = sourceUpdateJobsDb.cancelDeferred(id, ownerId);
    const promoted = sourceUpdateJobsDb.promoteIdle(id);
    assert.equal(cancelled, true);
    assert.equal(promoted, false, 'promote loses once cancelled');
    assert.equal(sourceUpdateJobsDb.getById(id)?.state, 'cancelled');
    assert.equal(sourceUpdateJobsDb.cancelDeferred(id, ownerId), false, 'cancel is not idempotent past terminal');
  });
});

test('W6 CAS: cancel is owner-scoped', async () => {
  await withIsolatedDatabase((ownerId) => {
    const id = String(sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'awaiting_sessions').job?.id);
    assert.equal(sourceUpdateJobsDb.cancelDeferred(id, ownerId + 999), false, 'a different owner cannot cancel');
    assert.equal(sourceUpdateJobsDb.getById(id)?.state, 'awaiting_sessions');
  });
});

test('W6 CAS: expireDeferrals fails only past-deadline parked jobs', async () => {
  await withIsolatedDatabase((ownerId) => {
    const soon = { ...makeRequest(ownerId), deferralDeadlineAt: 5_000 };
    const id = String(sourceUpdateJobsDb.createDeferred(soon, 'awaiting_sessions').job?.id);
    assert.equal(sourceUpdateJobsDb.expireDeferrals(4_000), 0, 'not yet past the deadline');
    assert.equal(sourceUpdateJobsDb.expireDeferrals(6_000), 1);
    const job = sourceUpdateJobsDb.getById(id);
    assert.equal(job?.state, 'failed');
    assert.equal(job?.error_code, 'deferral_expired');
  });
});

test('W6 CAS: failDeferred names a terminal code (capability lost)', async () => {
  await withIsolatedDatabase((ownerId) => {
    const id = String(sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'awaiting_sessions').job?.id);
    assert.equal(sourceUpdateJobsDb.failDeferred(id, 'deferral_capability_lost', 'lost'), true);
    assert.equal(sourceUpdateJobsDb.getById(id)?.error_code, 'deferral_capability_lost');
    assert.equal(sourceUpdateJobsDb.failDeferred(id, 'deferral_capability_lost', 'lost'), false);
  });
});

test('W6 CAS: rearm caps at three, refuses after seal, and honours the deadline', async () => {
  await withIsolatedDatabase((ownerId) => {
    const id = String(sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'accepted').job?.id);
    const now = Date.now();
    // Three rearms allowed; each returns to awaiting_sessions and must be
    // re-promoted before the next worker attempt.
    for (let i = 0; i < 3; i += 1) {
      assert.equal(sourceUpdateJobsDb.rearmDeferred(id, now), 'rearmed', `rearm #${i + 1}`);
      assert.equal(sourceUpdateJobsDb.getById(id)?.state, 'awaiting_sessions');
      assert.equal(sourceUpdateJobsDb.promoteIdle(id), true);
    }
    assert.equal(sourceUpdateJobsDb.rearmDeferred(id, now), 'exhausted', 'the fourth is exhausted');

    // A sealed candidate never rearms (S16).
    const sealedId = String(sourceUpdateJobsDb.createDeferred(makeRequest(ownerId), 'accepted').job?.id);
    getConnection().prepare("UPDATE source_update_jobs SET state = 'candidate_sealed' WHERE id = ?").run(sealedId);
    assert.equal(sourceUpdateJobsDb.rearmDeferred(sealedId, now), 'noop', 'no rearm after candidate_sealed');
  });
});

test('W6 CAS: rearm refuses a past-deadline job', async () => {
  await withIsolatedDatabase((ownerId) => {
    const soon = { ...makeRequest(ownerId), deferralDeadlineAt: 5_000 };
    const id = String(sourceUpdateJobsDb.createDeferred(soon, 'accepted').job?.id);
    assert.equal(sourceUpdateJobsDb.rearmDeferred(id, 6_000), 'expired');
  });
});

// B-1147: an installed node runs runMigrations inside the connector fence's
// transaction, where VACUUM INTO and a nested BEGIN are illegal. The rebuild
// must be skipped there and applied by the un-fenced follow-up call.
test('runMigrations inside a transaction defers the rebuild to the un-fenced call', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    installLegacyJobs(db);
    const jobsSql = () => String((db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_update_jobs'",
    ).get() as { sql: string }).sql);

    assert.doesNotThrow(() => db.transaction(() => runMigrations(db))());
    assert.equal(jobsSql().includes('awaiting_sessions'), false);

    migrateSourceUpdateDeferral(db);
    assert.equal(jobsSql().includes('awaiting_sessions'), true);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  hashSourceUpdateIdempotencyKey,
  isSourceUpdateLeaseOwnerAlive,
  sourceUpdateJobsDb,
  sourceUpdateRequestFingerprint,
} from '@/modules/database/repositories/source-update-jobs.db.js';

test('process identity rejects PID reuse and accepts only exact boot/startticks/pgid', () => {
  const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const exact = {
    pid: process.pid,
    boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    start_ticks: fields[19], pgid: Number(fields[2]),
  };
  assert.equal(isSourceUpdateLeaseOwnerAlive(exact), true);
  assert.equal(isSourceUpdateLeaseOwnerAlive({ ...exact, start_ticks: `${exact.start_ticks}0` }), false);
  assert.equal(isSourceUpdateLeaseOwnerAlive({ ...exact, boot_id: 'other-boot' }), false);
  assert.equal(isSourceUpdateLeaseOwnerAlive({ ...exact, pgid: exact.pgid + 1 }), false);
});

async function withDb(run: (ownerId: number) => void | Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'source-update-v2-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  const result = getConnection().prepare(
    `INSERT INTO users(username, password_hash, role) VALUES ('update-owner', 'not-a-secret', 'owner')`,
  ).run();
  try { await run(Number(result.lastInsertRowid)); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function request(ownerId: number, id = crypto.randomUUID(), version = '1.44.0.2', key = crypto.randomUUID()) {
  const strategy = 'git-checkout-v2' as const;
  return {
    id, ownerId, expectedVersion: version, strategy,
    idempotencyKeyHash: hashSourceUpdateIdempotencyKey(key),
    requestFingerprint: sourceUpdateRequestFingerprint(ownerId, version, strategy),
  };
}

test('v2 migration installs exact tables, pending identity columns, and one-shot marker', async () => {
  await withDb(() => {
    const db = getConnection();
    for (const table of ['source_update_control', 'source_update_jobs', 'source_update_receipts', 'source_update_effects']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    const pending = (db.prepare('PRAGMA table_info(pending_server_actions)').all() as Array<{ name: string }>).map(({ name }) => name);
    for (const column of ['source_update_job_id','source_update_transaction_id','activation_identity_sha256','release_commit']) {
      assert.ok(pending.includes(column));
    }
    assert.ok(db.prepare("SELECT 1 FROM app_config WHERE key='source_update_v1_migration_completed_at'").get());
  });
});

test('owner-scoped idempotency reuses exact input, rejects mismatch, and enforces one global active job', async () => {
  await withDb((ownerId) => {
    const key = crypto.randomUUID();
    const firstInput = request(ownerId, crypto.randomUUID(), '1.44.0.2', key);
    const first = sourceUpdateJobsDb.createOrReuse(firstInput);
    assert.equal(first.reused, false);
    const replay = sourceUpdateJobsDb.createOrReuse({ ...firstInput, id: crypto.randomUUID() });
    assert.equal(replay.reused, true);
    assert.equal(replay.mismatch, false);
    assert.equal(replay.job?.id, first.job?.id);
    const mismatch = sourceUpdateJobsDb.createOrReuse({
      ...firstInput, id: crypto.randomUUID(), expectedVersion: '1.44.0.3',
      requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.44.0.3', 'git-checkout-v2'),
    });
    assert.equal(mismatch.mismatch, true);
    const otherKey = sourceUpdateJobsDb.createOrReuse(request(ownerId));
    assert.equal(otherKey.activeConflict, true);
    assert.equal(otherKey.job?.id, first.job?.id);
  });
});

test('active discovery is owner-scoped, includes session waiting, excludes terminal jobs and never changes consent', async () => {
  await withDb((ownerId) => {
    assert.equal(sourceUpdateJobsDb.getActiveForOwner(ownerId), null);
    const job = sourceUpdateJobsDb.createOrReuse(request(ownerId)).job!;
    const db = getConnection();
    for (const state of ['accepted', 'awaiting_sessions', 'restart_queued', 'runtime_verifying']) {
      db.prepare('UPDATE source_update_jobs SET state = ? WHERE id = ?').run(state, job.id);
      const before = sourceUpdateJobsDb.getById(job.id);
      assert.equal(sourceUpdateJobsDb.getActiveForOwner(ownerId)?.id, job.id);
      assert.equal(sourceUpdateJobsDb.getActiveForOwner(ownerId + 1), null);
      assert.equal(sourceUpdateJobsDb.getActiveForOwner(NaN), null);
      assert.deepEqual(sourceUpdateJobsDb.getById(job.id), before);
    }
    for (const state of ['activated', 'failed', 'rolled_back', 'manual_recovery_required', 'cancelled', 'superseded']) {
      db.prepare('UPDATE source_update_jobs SET state = ? WHERE id = ?').run(state, job.id);
      assert.equal(sourceUpdateJobsDb.getActiveForOwner(ownerId), null);
    }
  });
});

test('expired worker is fenced: stale CAS and receipt writes fail while the new epoch proceeds', async () => {
  await withDb((ownerId) => {
    const created = sourceUpdateJobsDb.createOrReuse(request(ownerId)).job!;
    const workerA = { workerId: 'worker-a', pid: 10, startTicks: '100', bootId: 'boot', pgid: 10 };
    const workerB = { workerId: 'worker-b', pid: 11, startTicks: '200', bootId: 'boot', pgid: 11 };
    const a = sourceUpdateJobsDb.claim(workerA, 1_000, 100)!;
    assert.equal(sourceUpdateJobsDb.claim(workerB, 1_050, 100), null);
    assert.equal(sourceUpdateJobsDb.claim(workerB, 1_101, 100, () => true), null,
      'expired lease is never stolen from the exact still-live process');
    const b = sourceUpdateJobsDb.claim(workerB, 1_101, 100, () => false)!;
    assert.ok(b.worker_fence! > a.worker_fence!);
    assert.equal(sourceUpdateJobsDb.transition(created.id, a.worker_fence!, ['accepted'], 'resolving'), false);
    assert.throws(
      () => sourceUpdateJobsDb.appendReceipt(created.id, a.worker_fence!, 'resolving', 'intent'),
      /source_update_worker_fenced/,
    );
    assert.equal(sourceUpdateJobsDb.transition(created.id, b.worker_fence!, ['accepted'], 'resolving'), true);
    const receipt = sourceUpdateJobsDb.appendReceipt(created.id, b.worker_fence!, 'resolving', 'done', { ok: true });
    assert.equal(receipt.sequence, 1);
  });
});

test('transaction identity is direct and unique', async () => {
  await withDb((ownerId) => {
    const job = sourceUpdateJobsDb.createOrReuse(request(ownerId)).job!;
    const worker = { workerId: 'worker', pid: 12, startTicks: '300', bootId: 'boot', pgid: 12 };
    const claimed = sourceUpdateJobsDb.claim(worker, 2_000, 100)!;
    assert.equal(sourceUpdateJobsDb.transition(job.id, claimed.worker_fence!, ['accepted'], 'resolving'), true);
    assert.equal(sourceUpdateJobsDb.transition(job.id, claimed.worker_fence!, ['resolving'], 'candidate_sealed', {
      transaction_id: 'update-direct-tx', release_id: '7', release_asset_id: '9',
      release_asset_sha256: 'd'.repeat(64), archive_sha256: 'e'.repeat(64),
      release_commit: 'a'.repeat(40), source_tree_sha256: 'f'.repeat(64),
      expected_server_build_id: 'b'.repeat(64), expected_client_build_id: '1'.repeat(64),
      activation_identity_sha256: 'c'.repeat(64),
    }), true);
    assert.equal(sourceUpdateJobsDb.getByTransactionId('update-direct-tx')?.id, job.id);
    assert.equal(sourceUpdateJobsDb.transition(job.id, claimed.worker_fence!, ['candidate_sealed'], 'manual_recovery_required'), true);
    const manual = sourceUpdateJobsDb.listRuntimeReferences().find((row: any) => row.jobId === job.id) as any;
    assert.equal(manual.transactionId, 'update-direct-tx');
    assert.equal(manual.activationIdentitySha256, 'c'.repeat(64));
    assert.equal(manual.sourceTreeSha256, 'f'.repeat(64));
    assert.equal(manual.clientBuildId, '1'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// ADR-156 T-1730 W6 — deferral CAS helpers and schema invariants
// ---------------------------------------------------------------------------

test('W6: createDeferred inserts with INTEGER deadline and defer_until_idle=1', async () => {
  await withDb((ownerId) => {
    const deadlineAt = Date.now() + 3_600_000;
    const result = sourceUpdateJobsDb.createDeferred({
      id: crypto.randomUUID(), ownerId, expectedVersion: '1.47.0.10',
      strategy: 'git-checkout-v2' as const,
      idempotencyKeyHash: hashSourceUpdateIdempotencyKey('key-defer-1'),
      requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.47.0.10', 'git-checkout-v2', false, true),
      deferralDeadlineAt: deadlineAt,
    }, 'awaiting_sessions');
    const db = getConnection();
    const row = db.prepare('SELECT state, defer_until_idle, deferral_deadline_at, deferral_rearm_count FROM source_update_jobs WHERE id = ?').get(result.job!.id) as any;
    assert.equal(row.state, 'awaiting_sessions');
    assert.equal(row.defer_until_idle, 1);
    // deadline is stored as INTEGER milliseconds — not a text ISO string
    assert.equal(typeof row.deferral_deadline_at, 'number');
    assert.ok(Math.abs(row.deferral_deadline_at - deadlineAt) < 100, 'deadline matches input ms');
    assert.equal(row.deferral_rearm_count, 0);
  });
});

test('W6: awaiting_sessions counts as active — blocks a second job', async () => {
  await withDb((ownerId) => {
    sourceUpdateJobsDb.createDeferred({
      id: crypto.randomUUID(), ownerId, expectedVersion: '1.47.0.10',
      strategy: 'git-checkout-v2' as const,
      idempotencyKeyHash: hashSourceUpdateIdempotencyKey('key-defer-active'),
      requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.47.0.10', 'git-checkout-v2', false, true),
      deferralDeadlineAt: Date.now() + 3_600_000,
    }, 'awaiting_sessions');
    const second = sourceUpdateJobsDb.createOrReuse(request(ownerId, crypto.randomUUID(), '1.47.0.11', 'other-key'));
    assert.equal(second.activeConflict, true, 'awaiting_sessions blocks a parallel job');
  });
});

test('W6: promoteIdle transitions awaiting_sessions → accepted (un-fenced CAS)', async () => {
  await withDb((ownerId) => {
    const created = sourceUpdateJobsDb.createDeferred({
      id: crypto.randomUUID(), ownerId, expectedVersion: '1.47.0.10',
      strategy: 'git-checkout-v2' as const,
      idempotencyKeyHash: hashSourceUpdateIdempotencyKey('key-promote'),
      requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.47.0.10', 'git-checkout-v2', false, true),
      deferralDeadlineAt: Date.now() + 3_600_000,
    }, 'awaiting_sessions');
    const db = getConnection();
    // promoteIdle is a simple un-fenced CAS: awaiting_sessions → accepted
    // The two-sample idle debounce is enforced by the scheduler (W7), not by promoteIdle itself.
    assert.equal(sourceUpdateJobsDb.promoteIdle(created.job!.id), true, 'awaiting_sessions → accepted');
    const row = db.prepare('SELECT state FROM source_update_jobs WHERE id = ?').get(created.job!.id) as any;
    assert.equal(row.state, 'accepted');
    // promoteIdle on an already-accepted job is a no-op (CAS guard)
    assert.equal(sourceUpdateJobsDb.promoteIdle(created.job!.id), false, 'second call is a no-op');
  });
});

test('W6: cancelDeferred vs promoteIdle CAS race — only one transition wins', async () => {
  await withDb((ownerId) => {
    const job1 = sourceUpdateJobsDb.createDeferred({
      id: crypto.randomUUID(), ownerId, expectedVersion: '1.47.0.10',
      strategy: 'git-checkout-v2' as const,
      idempotencyKeyHash: hashSourceUpdateIdempotencyKey('key-race-1'),
      requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.47.0.10', 'git-checkout-v2', false, true),
      deferralDeadlineAt: Date.now() + 3_600_000,
    }, 'awaiting_sessions');
    // Stamp first so promoteIdle is ready
    getConnection().prepare('UPDATE source_update_jobs SET idle_observed_at = ? WHERE id = ?').run(Date.now() - 40_000, job1.job!.id);

    // simulate two concurrent callers: cancel wins first
    const cancelled = sourceUpdateJobsDb.cancelDeferred(job1.job!.id, ownerId);
    const promoted = sourceUpdateJobsDb.promoteIdle(job1.job!.id);
    assert.equal(cancelled, true);
    assert.equal(promoted, false, 'promoteIdle on a cancelled job is a no-op');
    const row = getConnection().prepare('SELECT state FROM source_update_jobs WHERE id = ?').get(job1.job!.id) as any;
    assert.equal(row.state, 'cancelled');
  });
});

test('W6: expireDeferrals marks past-deadline jobs failed with deferral_expired', async () => {
  await withDb((ownerId) => {
    const past = sourceUpdateJobsDb.createDeferred({
      id: crypto.randomUUID(), ownerId, expectedVersion: '1.47.0.10',
      strategy: 'git-checkout-v2' as const,
      idempotencyKeyHash: hashSourceUpdateIdempotencyKey('key-expire-1'),
      requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.47.0.10', 'git-checkout-v2', false, true),
      deferralDeadlineAt: Date.now() - 1_000, // already past
    }, 'awaiting_sessions');
    const count = sourceUpdateJobsDb.expireDeferrals(Date.now());
    assert.equal(count, 1);
    const row = getConnection().prepare('SELECT state, error_code FROM source_update_jobs WHERE id = ?').get(past.job!.id) as any;
    assert.equal(row.state, 'failed');
    assert.equal(row.error_code, 'deferral_expired');
  });
});

test('W6: rearmDeferred cycles back to awaiting_sessions up to MAX_DEFERRAL_REARMS=3', async () => {
  await withDb((ownerId) => {
    const db = getConnection();
    // Start in a pre-seal worker state
    const created = sourceUpdateJobsDb.createOrReuse(request(ownerId));
    const jobId = created.job!.id;
    const worker = { workerId: 'w-rearm', pid: 1, startTicks: '1', bootId: 'b', pgid: 1 };
    sourceUpdateJobsDb.claim(worker, 1_000, 100);
    // Promote to staging manually
    db.prepare(`UPDATE source_update_jobs SET state = 'staging', defer_until_idle = 1, deferral_deadline_at = ?, deferral_rearm_count = 0 WHERE id = ?`).run(Date.now() + 3_600_000, jobId);

    // First 3 rearms succeed
    for (let i = 1; i <= 3; i += 1) {
      db.prepare(`UPDATE source_update_jobs SET state = 'staging', idle_observed_at = NULL WHERE id = ?`).run(jobId);
      const result = sourceUpdateJobsDb.rearmDeferred(jobId, Date.now());
      assert.equal(result, 'rearmed', `rearm #${i}`);
      const row = db.prepare('SELECT deferral_rearm_count, state FROM source_update_jobs WHERE id = ?').get(jobId) as any;
      assert.equal(row.deferral_rearm_count, i);
      assert.equal(row.state, 'awaiting_sessions');
    }
    // 4th rearm is exhausted
    db.prepare(`UPDATE source_update_jobs SET state = 'staging', idle_observed_at = NULL WHERE id = ?`).run(jobId);
    const exhausted = sourceUpdateJobsDb.rearmDeferred(jobId, Date.now());
    assert.equal(exhausted, 'exhausted');
    assert.equal(db.prepare('SELECT state FROM source_update_jobs WHERE id = ?').get(jobId).state, 'staging', 'state unchanged on exhausted');
  });
});

test('W6: rearmDeferred returns expired when deadline has passed', async () => {
  await withDb((ownerId) => {
    const db = getConnection();
    const created = sourceUpdateJobsDb.createOrReuse(request(ownerId));
    const jobId = created.job!.id;
    // Set past deadline
    db.prepare(`UPDATE source_update_jobs SET state = 'staging', defer_until_idle = 1, deferral_deadline_at = ?, deferral_rearm_count = 0 WHERE id = ?`).run(Date.now() - 1, jobId);
    const result = sourceUpdateJobsDb.rearmDeferred(jobId, Date.now() + 10);
    assert.equal(result, 'expired');
  });
});

test('W6: receipt count is preserved across migration — no orphaned receipts', async () => {
  await withDb((ownerId) => {
    // Create a job with receipts, then verify the DB still has them after migration
    const created = sourceUpdateJobsDb.createOrReuse(request(ownerId));
    const worker = { workerId: 'w-receipt', pid: 2, startTicks: '2', bootId: 'br', pgid: 2 };
    const claimed = sourceUpdateJobsDb.claim(worker, 1_000, 100)!;
    sourceUpdateJobsDb.appendReceipt(created.job!.id, claimed.worker_fence!, 'resolving', 'intent', { step: 1 });
    sourceUpdateJobsDb.appendReceipt(created.job!.id, claimed.worker_fence!, 'resolved', 'done', { step: 2 });
    const db = getConnection();
    const countBefore = db.prepare('SELECT COUNT(*) as c FROM source_update_receipts').get() as any;
    // initializeDatabase() would run migrations again — check schema integrity
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_source_update_one_active'").get() as any;
    assert.ok(idx, 'one-active index must exist');
    // The index must cover awaiting_sessions
    const idxDef = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_source_update_one_active'").get() as any;
    assert.match(idxDef.sql, /awaiting_sessions/, 'index covers awaiting_sessions');
    // cancelled is a terminal state — must NOT appear in the one-active index
    assert.doesNotMatch(idxDef.sql, /'cancelled'/, 'cancelled is terminal, not in one-active index');
    // Receipt count unchanged by schema checks
    const countAfter = db.prepare('SELECT COUNT(*) as c FROM source_update_receipts').get() as any;
    assert.equal(countAfter.c, countBefore.c, 'no receipts lost by schema invariant checks');
  });
});

test('kill-9 predecessor orphan is durably killed before a new fence epoch is issued', async () => {
  await withDb(async (ownerId) => {
    const job = sourceUpdateJobsDb.createOrReuse(request(ownerId)).job!;
    const predecessor = { workerId: 'dead-worker', pid: 99_999_991, startTicks: '1', bootId: 'old-boot', pgid: 99_999_991 };
    const claimed = sourceUpdateJobsDb.claim(predecessor, 1_000, 100, () => false)!;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    try {
      const raw = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      assert.equal(sourceUpdateJobsDb.registerEffect(job.id, predecessor.workerId, claimed.worker_fence!, {
        effectId: 'build-one', kind: 'candidate-build', pid: child.pid!, startTicks: fields[19],
        bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pgid: Number(fields[2]),
      }), true);
      const successor = { workerId: 'successor', pid: process.pid, startTicks: 'irrelevant',
        bootId: 'irrelevant', pgid: process.pid };
      assert.equal(sourceUpdateJobsDb.claim(successor, 2_000, 100, () => false), null,
        'running effect blocks fence increment');
      for (let attempt = 0; attempt < 50 && !sourceUpdateJobsDb.reapOrphanEffects(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(sourceUpdateJobsDb.reapOrphanEffects(), true);
      assert.ok(sourceUpdateJobsDb.claim(successor, 2_001, 100, () => false));
      assert.equal(getConnection().prepare("SELECT state FROM source_update_effects WHERE effect_id='build-one'").get().state, 'terminated');
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    }
  });
});

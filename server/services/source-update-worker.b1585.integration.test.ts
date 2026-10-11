/**
 * B-1585: the update worker against the real job store — a lease that lapsed
 * during a blocked step, and a stranded job re-claimed after an out-of-band
 * install of its own target.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  hashSourceUpdateIdempotencyKey,
  sourceUpdateJobsDb,
  sourceUpdateRequestFingerprint,
} from '@/modules/database/repositories/source-update-jobs.db.js';

import { createSourceUpdateWorker } from './source-update-worker.js';

async function withDb(run: (ownerId: number) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(process.env.TMPDIR || '/var/tmp', 'source-update-b1585-'));
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

function request(ownerId: number) {
  const strategy = 'git-checkout-v2' as const;
  return {
    id: crypto.randomUUID(), ownerId, expectedVersion: '1.44.0.2', strategy,
    idempotencyKeyHash: hashSourceUpdateIdempotencyKey(crypto.randomUUID()),
    requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.44.0.2', strategy),
  };
}

test('a stranded staging job whose target is already loaded is re-claimed and settled superseded, never rebuilt', async () => {
  await withDb(async (ownerId) => {
    const job = sourceUpdateJobsDb.createOrReuse(request(ownerId)).job!;
    const target = 'b'.repeat(40);
    const dead = { workerId: 'dead-worker', pid: 99_999_991, startTicks: '1', bootId: 'old-boot', pgid: 99_999_991 };
    sourceUpdateJobsDb.claim(dead, 1_000, 100, () => false);
    getConnection().prepare(`UPDATE source_update_jobs SET state = 'staging', release_id = '7', release_tag = 'v1.44.0.2',
      release_asset_id = '9', release_asset_name = 'nassaj.tar.gz', release_asset_size = 1,
      release_asset_sha256 = ?, release_commit = ? WHERE id = ?`).run('c'.repeat(64), target, job.id);
    let built = false;
    const worker = createSourceUpdateWorker({
      jobs: sourceUpdateJobsDb,
      identity: { workerId: 'successor', pid: process.pid, startTicks: 'x', bootId: 'x', pgid: process.pid },
      resolveRelease: async () => { throw new Error('must not resolve'); },
      runUpdate: async () => { built = true; throw new Error('must not build'); },
      loadedRuntimeCommit: () => target,
    });
    assert.equal(await worker.processOne(), false);
    assert.equal(built, false);
    const row = sourceUpdateJobsDb.getById(job.id)!;
    assert.equal(row.state, 'superseded');
    assert.equal(row.error_code, 'source_update_target_already_loaded');
    const kinds = (sourceUpdateJobsDb.listReceipts(job.id) as { kind: string; facts_json: string }[])
      .map((r) => [r.kind, JSON.parse(r.facts_json).code ?? null]);
    assert.ok(kinds.some(([kind, code]) => kind === 'recovery' && code === 'source_update_target_already_loaded'));
    const control = getConnection().prepare('SELECT * FROM source_update_control WHERE singleton = 1').get() as Record<string, unknown>;
    assert.equal(control.active_job_id, null);
    assert.equal(sourceUpdateJobsDb.createOrReuse(request(ownerId)).reused, false, 'the one-active slot is free again');
    assert.equal(await worker.processOne(), false, 'idempotent: nothing left to claim');
  });
});

test('incident replay: a lease lapsed during a blocked step no longer strands staging with the lease held', async () => {
  await withDb(async (ownerId) => {
    const job = sourceUpdateJobsDb.createOrReuse(request(ownerId)).job!;
    let clock = 10_000;
    const lines: string[] = [];
    const worker = createSourceUpdateWorker({
      jobs: sourceUpdateJobsDb, now: () => clock, leaseMs: 30_000,
      identity: { workerId: 'live-worker', pid: process.pid, startTicks: 'x', bootId: 'x', pgid: process.pid },
      jobLog: { line: (_id: string, message: string) => { lines.push(message); }, append: () => undefined },
      resolveRelease: async () => ({ release: {
        releaseId: 7, version: '1.44.0.2', tagName: 'v1.44.0.2', commit: 'b'.repeat(40),
        assetId: 9, assetName: 'nassaj.tar.gz', assetSize: 1, assetSha256: 'c'.repeat(64),
      } }),
      runUpdate: async (_job: unknown, _release: unknown, context: { assertFence: () => boolean }) => {
        clock += 30_046; // the event loop was blocked past the lease, and nobody else claimed it
        context.assertFence();
        throw new Error('unreachable');
      },
    });
    assert.equal(await worker.processOne(), false);
    const row = sourceUpdateJobsDb.getById(job.id)!;
    assert.equal(row.state, 'failed');
    assert.equal(row.error_code, 'source_update_worker_lease_lost');
    assert.ok(lines.includes('✗ source_update_worker_fenced'));
    const control = getConnection().prepare('SELECT * FROM source_update_control WHERE singleton = 1').get() as Record<string, unknown>;
    assert.equal(control.worker_id, null, 'the lease is released, so nothing blocks the next claim');
    assert.equal(sourceUpdateJobsDb.createOrReuse(request(ownerId)).reused, false, 'the owner can retry at once');
  });
});

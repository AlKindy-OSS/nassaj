import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { migrateSourceUpdateAutoActivate } from '@/modules/database/migrations.js';
import {
  hashSourceUpdateIdempotencyKey,
  sourceUpdateJobsDb,
  sourceUpdateRequestFingerprint,
} from '@/modules/database/repositories/source-update-jobs.db.js';

async function withDb(run: (ownerId: number) => void | Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'source-update-auto-'));
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

function request(ownerId: number, autoActivate: boolean) {
  const strategy = 'git-checkout-v2' as const;
  const version = '1.47.0.17';
  return {
    id: crypto.randomUUID(), ownerId, expectedVersion: version, strategy, autoActivate,
    idempotencyKeyHash: hashSourceUpdateIdempotencyKey(crypto.randomUUID()),
    requestFingerprint: sourceUpdateRequestFingerprint(ownerId, version, strategy, autoActivate),
  };
}

const setState = (id: string, state: string) =>
  getConnection().prepare('UPDATE source_update_jobs SET state = ? WHERE id = ?').run(state, id);

test('T-1751: consent is a constrained column that defaults to the manual confirmation', async () => {
  await withDb((ownerId) => {
    const db = getConnection();
    const column = (db.prepare('PRAGMA table_info(source_update_jobs)').all() as Array<{
      name: string; notnull: number; dflt_value: unknown;
    }>).find((entry) => entry.name === 'auto_activate');
    assert.ok(column, 'auto_activate column exists');
    assert.equal(column.notnull, 1);
    assert.equal(String(column.dflt_value), '0');

    const manual = sourceUpdateJobsDb.createOrReuse(request(ownerId, false));
    assert.equal(manual.job?.auto_activate, 0);
    assert.throws(() => db.prepare('UPDATE source_update_jobs SET auto_activate = 2 WHERE id = ?').run(manual.job?.id));
  });
});

test('T-1751: only consented jobs in restart_queued are listed for activation', async () => {
  await withDb((ownerId) => {
    const consented = sourceUpdateJobsDb.createOrReuse(request(ownerId, true)).job;
    assert.equal(consented?.auto_activate, 1);
    assert.deepEqual(sourceUpdateJobsDb.listAutoActivatable(), [], 'not before the restart is queued');
    setState(String(consented?.id), 'restart_queued');
    assert.deepEqual(sourceUpdateJobsDb.listAutoActivatable().map((job) => job.id), [consented?.id]);

    setState(String(consented?.id), 'activated');
    const manual = sourceUpdateJobsDb.createOrReuse(request(ownerId, false)).job;
    setState(String(manual?.id), 'restart_queued');
    assert.deepEqual(sourceUpdateJobsDb.listAutoActivatable(), [], 'a job without consent keeps the button');
  });
});

test('T-1751: consent is part of the request fingerprint, and false keeps the old one', () => {
  const base = sourceUpdateRequestFingerprint(1, '1.47.0.17', 'git-checkout-v2');
  assert.equal(sourceUpdateRequestFingerprint(1, '1.47.0.17', 'git-checkout-v2', false), base);
  assert.notEqual(sourceUpdateRequestFingerprint(1, '1.47.0.17', 'git-checkout-v2', true), base);
});

test('T-1751: the migration adds the column to a table created before it existed', async () => {
  await withDb(() => {
    const db = getConnection();
    db.exec('ALTER TABLE source_update_jobs DROP COLUMN auto_activate');
    const before = (db.prepare('PRAGMA table_info(source_update_jobs)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!before.includes('auto_activate'));
    migrateSourceUpdateAutoActivate(db);
    migrateSourceUpdateAutoActivate(db);
    const after = (db.prepare('PRAGMA table_info(source_update_jobs)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(after.includes('auto_activate'), 'added once, and a second run is a no-op');
  });
});

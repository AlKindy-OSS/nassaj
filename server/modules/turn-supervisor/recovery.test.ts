import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  RECOVERY_SCHEMA_SQL,
  reconcileOnStartup,
  SqliteRecoveryStore,
  WriterEpochFence,
} from './recovery.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE turn_supervisor_runs (
    run_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  db.exec(RECOVERY_SCHEMA_SQL);
  const insert = db.prepare(
    'INSERT INTO turn_supervisor_runs (run_id, turn_id, state, created_at) VALUES (?, ?, ?, ?)',
  );
  insert.run('claimed', 'root-a', 'claimed', '1');
  insert.run('running', 'root-b', 'running', '2');
  insert.run('unknown', 'root-c', 'dispatching', '3');
  return { db, store: new SqliteRecoveryStore(db) };
}

test('startup fences writers then classifies safe, orphan, and uncertain runs', async () => {
  const { db, store } = fixture();
  const result = await reconcileOnStartup(store, (run) => {
    if (run.runId === 'claimed') return 'not_dispatched';
    if (run.runId === 'running') return 'alive';
    return 'unknown';
  });
  assert.deepEqual(result.recoverable.map((run) => [run.runId, run.writerEpoch]), [['claimed', 1]]);
  assert.deepEqual(result.quarantined, ['running']);
  assert.deepEqual(result.uncertain, ['unknown']);
  assert.deepEqual(
    db.prepare('SELECT run_id, writer_epoch, disposition FROM turn_supervisor_recovery ORDER BY run_id').all(),
    [
      { run_id: 'claimed', writer_epoch: 1, disposition: 'active' },
      { run_id: 'running', writer_epoch: 1, disposition: 'quarantined' },
      { run_id: 'unknown', writer_epoch: 1, disposition: 'uncertain' },
    ],
  );
  db.close();
});

test('restart reconciliation is idempotent for quarantined and uncertain runs', async () => {
  const { db, store } = fixture();
  await reconcileOnStartup(store, () => 'unknown');
  const second = await reconcileOnStartup(store, () => { throw new Error('must not probe disposed rows'); });
  assert.deepEqual(second, { recoverable: [], uncertain: [], quarantined: [] });
  db.close();
});

test('writer epoch rejects stale and post-terminal events', () => {
  const fence = new WriterEpochFence();
  fence.open('run', 1);
  assert.equal(fence.accepts('run', 1), true);
  fence.open('run', 2);
  assert.equal(fence.accepts('run', 1), false, 'late pre-restart event');
  assert.equal(fence.accepts('run', 2), true);
  assert.equal(fence.close('run', 2), true);
  assert.equal(fence.accepts('run', 2), false, 'late post-terminal event');
});

test('durable writer claims monotonically fence prior process epochs', () => {
  const { db, store } = fixture();
  assert.equal(store.claimWriter('claimed'), 1);
  assert.equal(store.claimWriter('claimed'), 2);
  db.close();
});

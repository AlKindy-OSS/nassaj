import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  CANCELLATION_SCHEMA_SQL,
  CancellationCascade,
  releaseRecoveredCancellationLease,
  resumePendingCancellations,
  SqliteCancellationStore,
} from './cancel-cascade.js';
import { AdapterTerminalProofAuthority } from './resource-admission.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CANCELLATION_SCHEMA_SQL);
  return { db, store: new SqliteCancellationStore(db) };
}

function addLeaseTable(db: Database.Database): void {
  db.exec(`CREATE TABLE turn_resource_leases (
    lease_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, cpu_reserved REAL NOT NULL,
    memory_reserved REAL NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL, exit_proof_at_ms INTEGER, exit_proof_kind TEXT,
    released_at_ms INTEGER,
    CHECK (status = 'active' OR (exit_proof_at_ms IS NOT NULL AND released_at_ms IS NOT NULL))
  );`);
}

function addLease(db: Database.Database, turnId: string, pid: number): void {
  db.prepare(`INSERT INTO turn_resource_leases (
    lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved, memory_reserved,
    status, created_at_ms, heartbeat_at_ms
  ) VALUES (?, ?, 1, 'crashed-owner', ?, 1, 1, 'active', 0, 0)`).run(
    `${turnId}-lease`, turnId, pid,
  );
}

test('cancel persists root-to-runs, aborts and reaps before releasing capacity', async () => {
  const { db, store } = fixture();
  store.createRoot('root');
  store.registerRun('root', 'run-a', 'adapter');
  store.registerRun('root', 'run-b', 'adapter');
  const order: string[] = [];
  const cascade = new CancellationCascade(store, {
    adapters: new Map([['adapter', {
      cancel(runId: string) { order.push(`cancel:${runId}`); },
      reap(runId: string) { order.push(`reap:${runId}`); },
    }]]),
    releaseLease() { order.push('release'); },
  });
  cascade.registerController('run-a', new AbortController());
  await cascade.cancel('root');
  assert.equal(order.at(-1), 'release');
  assert.deepEqual(order, ['cancel:run-a', 'reap:run-a', 'cancel:run-b', 'reap:run-b', 'release']);
  const rows = db.prepare('SELECT state FROM turn_cancellation_runs ORDER BY run_id').all();
  assert.deepEqual(rows, [{ state: 'reaped' }, { state: 'reaped' }]);
  assert.equal((db.prepare('SELECT state FROM turn_cancellation_roots').get() as { state: string }).state, 'cancelled');
  db.close();
});

test('adapter failure retains lease and durable cancel_requested state', async () => {
  const { db, store } = fixture();
  store.createRoot('root');
  store.registerRun('root', 'run', 'adapter');
  let released = false;
  const cascade = new CancellationCascade(store, {
    adapters: new Map([['adapter', {
      cancel() {},
      reap() { throw new Error('still alive'); },
    }]]),
    releaseLease() { released = true; },
  });
  await assert.rejects(cascade.cancel('root'), /still alive/);
  assert.equal(released, false);
  assert.equal((db.prepare('SELECT state FROM turn_cancellation_runs').get() as { state: string }).state, 'cancel_requested');
  db.close();
});

test('cancel wins atomically against completion and future spawn', () => {
  const { db, store } = fixture();
  store.createRoot('root');
  store.registerRun('root', 'run', 'adapter');
  const [cancelled] = store.requestRootCancellation('root', 'stop');
  assert.equal(cancelled.epoch, 1);
  assert.equal(store.completeRun('run', 0), false, 'late completion is fenced');
  assert.throws(() => store.registerRun('root', 'late', 'adapter'), /not accepting/);
  db.close();
});

test('completion that wins first is not retroactively cancelled', () => {
  const { db, store } = fixture();
  store.createRoot('root');
  store.registerRun('root', 'run', 'adapter');
  assert.equal(store.completeRun('run', 0), true);
  assert.deepEqual(store.requestRootCancellation('root', 'stop'), []);
  db.close();
});

test('startup resumes a durable cascade interrupted before reap', async () => {
  const { db, store } = fixture();
  store.createRoot('root');
  store.registerRun('root', 'run', 'adapter');
  store.requestRootCancellation('root', 'crash');
  let released = false;
  const cascade = new CancellationCascade(store, {
    adapters: new Map([['adapter', { cancel() {}, reap() {} }]]),
    releaseLease() { released = true; },
  });
  assert.deepEqual(await resumePendingCancellations(store, cascade), ['root']);
  assert.equal(released, true);
  assert.deepEqual(store.listPendingRootIds(), []);
  db.close();
});

test('cancel recovery releases a dead CLI owner but retains live and unknown owners', () => {
  const { db } = fixture();
  addLeaseTable(db);
  addLease(db, 'dead', 101);
  addLease(db, 'live', 102);
  addLease(db, 'unknown', 103);

  assert.equal(releaseRecoveredCancellationLease(db, 'dead', {
    probeProcess: () => 'dead', now: () => 5_000,
  }), true);
  assert.throws(() => releaseRecoveredCancellationLease(db, 'live', {
    probeProcess: () => 'alive',
  }), /without dead-owner proof/);
  assert.throws(() => releaseRecoveredCancellationLease(db, 'unknown', {
    probeProcess: () => 'unknown',
  }), /without dead-owner proof/);
  assert.deepEqual(db.prepare(
    'SELECT turn_id, status, exit_proof_kind FROM turn_resource_leases ORDER BY turn_id',
  ).all(), [
    { turn_id: 'dead', status: 'released', exit_proof_kind: 'process_dead' },
    { turn_id: 'live', status: 'active', exit_proof_kind: null },
    { turn_id: 'unknown', status: 'active', exit_proof_kind: null },
  ]);
  db.close();
});

test('cancel recovery accepts terminal proof only from its issuing authority', () => {
  const { db } = fixture();
  addLeaseTable(db);
  addLease(db, 'terminal', 101);
  const authority = new AdapterTerminalProofAuthority();
  const issue = authority.bindIssuer();
  const proof = issue({
    adapterId: 'codex-cli-ephemeral', runId: 'run', writerEpoch: 1,
    observedAtMs: 5_000, settled: true,
  });
  const wrongAuthority = new AdapterTerminalProofAuthority();

  assert.throws(() => releaseRecoveredCancellationLease(db, 'terminal', {
    probeProcess: () => 'alive', terminalProof: proof,
    terminalProofAuthority: wrongAuthority,
  }), /not authoritative/);
  assert.equal(releaseRecoveredCancellationLease(db, 'terminal', {
    probeProcess: () => 'alive', terminalProof: proof,
    terminalProofAuthority: authority,
  }), true);
  db.close();
});

import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DELETION_PREPARATION_SQL } from './deletion-schema.js';
import { DELETION_OPERATION_EXPANSION_SQL } from './deletion-operation.schema.js';
import { createDeletionOperationRepository } from './deletion-operation.repository.js';
import type { CleanupCounts, DeleteCommand } from './deletion-operation.contract.js';

const zero: CleanupCounts = { pending: 0, leased: 0, retry: 0, succeeded: 0, blocked: 0, retained: 0 };
const command: DeleteCommand = { operationId: 'op', actorId: 1, targetKind: 'project', targetId: 'p', scope: 'nassaj_only' };
function fixture() {
  const queries: string[] = [];
  const db = new Database(':memory:', { verbose: sql => queries.push(String(sql)) });
  db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1);');
  db.exec(DELETION_PREPARATION_SQL); db.exec(DELETION_OPERATION_EXPANSION_SQL);
  const operation = (id = 'op', state = 'committed') => db.prepare(`INSERT INTO project_deletion_records
    (operation_id,project_id,generation,request_hash,scope,database_state,cleanup_state,created_at,actor_id,target_kind,target_id)
    VALUES(?,'p','g','hash','nassaj_only',?,'pending','now',1,'project','p')`).run(id, state);
  let sequence = 0;
  const job = (state: string, id = 'op') => {
    const key = `job-${++sequence}`;
    db.prepare(`INSERT INTO session_artifact_cleanup_outbox
      (job_id,operation_id,project_id,generation,store_identity,target_identity,target_kind,state,lease_token,lease_until)
      VALUES(?,?,'p','g','store',?,'provider_session',?,?,?)`)
      .run(key, id, key, state, state === 'leased' ? 'token' : null, state === 'leased' ? 100 : null);
  };
  return { db, queries, operation, job, repository: createDeletionOperationRepository(db) };
}

for (const [states, summary] of [
  [[], 'not_applicable'], [['succeeded', 'succeeded'], 'succeeded'], [['pending'], 'pending'],
  [['leased'], 'pending'], [['retry'], 'pending'], [['retained'], 'retained'], [['blocked'], 'blocked'],
  [['succeeded', 'retained'], 'retained'], [['retained', 'retry', 'succeeded'], 'pending'],
  [['pending', 'leased', 'retry', 'succeeded', 'blocked', 'retained'], 'blocked'],
] as const) {
  test(`persisted cleanup ${states.join('+') || 'no jobs'} yields ${summary} with explicit six-state counts`, () => {
    const f = fixture();
    try {
      f.operation(); for (const state of states) f.job(state);
      f.operation('other'); f.job('blocked', 'other');
      const expected = { ...zero }; for (const state of states) expected[state]++;
      f.queries.length = 0;
      const result = f.repository.result('op');
      assert.equal(result.artifactCleanup, summary); assert.deepEqual(result.cleanupCounts, expected);
      assert.equal(result.databaseDeletion, 'committed'); assert.equal(result.status, 202);
      assert.deepEqual(result.retainedClasses, ['deletion_markers', 'audit', 'cost_ledger', 'existing_backups']);
      assert.equal(f.queries.length, 1); // Existence, commit state and counts share one SQLite statement.
    } finally { f.db.close(); }
  });
}

test('absent result is an error while absent replay means no previous receipt, never no-job success', () => {
  const f = fixture();
  try {
    f.job('succeeded'); // Orphan work cannot manufacture an operation receipt.
    assert.throws(() => f.repository.result('op'), { code: 'DELETION_NOT_FOUND' });
    assert.equal(f.repository.readReplay(command, 'hash'), null);
  } finally { f.db.close(); }
});

test('prepared and unknown operation states cannot return committed results', () => {
  const f = fixture();
  try {
    f.operation('op', 'prepared');
    for (const state of ['prepared', 'unknown']) {
      f.db.pragma('ignore_check_constraints=ON');
      f.db.prepare('UPDATE project_deletion_records SET database_state=?').run(state);
      assert.throws(() => f.repository.result('op'), { code: 'DELETION_OPERATION_INCOMPLETE' });
      assert.throws(() => f.repository.readReplay(command, 'hash'), { code: 'DELETION_OPERATION_INCOMPLETE' });
    }
  } finally { f.db.close(); }
});

test('unknown persisted job state and query failure fail closed rather than report success', () => {
  const f = fixture();
  try {
    f.operation(); f.db.pragma('ignore_check_constraints=ON'); f.job('unknown');
    assert.throws(() => f.repository.result('op'), { code: 'DELETION_CLEANUP_UNPROVEN' });
    assert.throws(() => f.repository.readReplay(command, 'hash'), { code: 'DELETION_CLEANUP_UNPROVEN' });
    f.db.exec('DROP TABLE session_artifact_cleanup_outbox');
    assert.throws(() => f.repository.result('op'), { code: 'DELETION_CLEANUP_UNAVAILABLE' });
    assert.throws(() => f.repository.readReplay(command, 'hash'), { code: 'DELETION_CLEANUP_UNAVAILABLE' });
  } finally { f.db.close(); }
});

test('replay reports current cleanup and preserves actor, request hash and canonical target checks', () => {
  const f = fixture();
  try {
    f.operation(); f.job('pending');
    assert.equal(f.repository.readReplay(command, 'hash')?.artifactCleanup, 'pending');
    f.db.exec("UPDATE session_artifact_cleanup_outbox SET state='succeeded'");
    f.queries.length = 0;
    const replay = f.repository.readReplay(command, 'hash');
    assert.equal(replay?.artifactCleanup, 'succeeded'); assert.deepEqual(replay?.cleanupCounts, { ...zero, succeeded: 1 });
    assert.equal(f.queries.length, 1);
    assert.throws(() => f.repository.readReplay({ ...command, actorId: 2 }, 'hash'), { code: 'DELETION_NOT_FOUND' });
    assert.throws(() => f.repository.readReplay(command, 'wrong'), { code: 'DELETION_OPERATION_CONFLICT' });
    assert.throws(() => f.repository.readReplay({ ...command, targetKind: 'session' }, 'hash'), { code: 'DELETION_OPERATION_CONFLICT' });
    assert.throws(() => f.repository.readReplay({ ...command, targetId: 'other' }, 'hash'), { code: 'DELETION_OPERATION_CONFLICT' });
  } finally { f.db.close(); }
});

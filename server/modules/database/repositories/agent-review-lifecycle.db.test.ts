import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { applyAgentReviewSchema } from '../agent-review-lifecycle.migration.js';

import { AgentReviewRepository, type ReviewTransition, type ReviewAuthorization } from './agent-review-lifecycle.db.js';
import { AgentReviewError, assertReviewSession } from './agent-review-validation.js';

const SHA = 'a'.repeat(64);
const NEXT = 'b'.repeat(64);
const NOW = '2026-09-24T00:00:00.000Z';
const LATER = '2026-09-24T00:00:00.001Z';
const command: ReviewTransition = { sessionId: 's', source: 'workflow', agentId: 'a', resultGeneration: SHA,
  action: 'start_review', expectedRevision: 0, idempotencyKey: 'request-1' };

function fixture(filename = ':memory:'): Database.Database {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  db.exec(`CREATE TABLE session_participants(session_id TEXT,user_id INTEGER,role TEXT,attribution TEXT);
    INSERT INTO session_participants VALUES ('s',1,'owner','spawn')`);
  seed(db);
  return db;
}

function seed(db: Database.Database, source = 'workflow', generation = SHA, sequence = 2): void {
  db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('s', source, 'a', generation, SHA, sequence, SHA, generation, SHA, NOW);
  db.prepare("INSERT INTO agent_review_states VALUES (?,?,?,?,'awaiting_review',0,NULL,NULL,NULL)")
    .run('s', source, 'a', generation);
  db.prepare(`INSERT INTO agent_review_events (session_id,source,agent_id,result_generation,event_sequence,
    event_type,new_status,new_revision,server_time) VALUES (?,?,?,?,0,'completed','awaiting_review',0,?)`)
    .run('s', source, 'a', generation, NOW);
  db.prepare('INSERT INTO agent_review_current VALUES (?,?,?,?,?,?,0,?)')
    .run('s', source, 'a', generation, SHA, sequence, NOW);
}

function repository(db: Database.Database, actor = 1, guard: ReviewAuthorization['assertCurrent'] = () => true): AgentReviewRepository {
  return new AgentReviewRepository(db, { actorUserId: actor, assertCurrent: guard });
}

function rejected(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof AgentReviewError && error.code === code);
}

function changes(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

test('C4-06: guard executes inside transaction; no/multiple/provenance-only owner fails closed', () => {
  const db = fixture();
  try {
    let calls = 0;
    const repo = repository(db, 1, (received, session) => {
      assert.equal(received, db); assert.equal(db.inTransaction, true); assert.equal(session, 's'); calls++; return true;
    });
    for (const sql of [
      'DELETE FROM session_participants',
      "INSERT INTO session_participants VALUES ('s',1,'owner','provenance')",
      "UPDATE session_participants SET attribution='spawn'; INSERT INTO session_participants VALUES ('s',2,'owner','spawn')",
    ]) {
      db.exec(sql);
      rejected(() => repo.transition(command), 'forbidden');
    }
    assert.equal(calls, 3);
    assert.equal((db.prepare('SELECT revision FROM agent_review_states').get() as { revision: number }).revision, 0);
  } finally { db.close(); }
});

test('C4-06: missing, nontrue, async and revoked guards deny before writes', () => {
  const db = fixture();
  try {
    assert.throws(() => new AgentReviewRepository(db, undefined as unknown as ReviewAuthorization));
    for (const value of [false, undefined, 1, Promise.resolve(true)]) {
      const repo = repository(db, 1, (() => value) as ReviewAuthorization['assertCurrent']);
      const before = changes(db);
      rejected(() => repo.transition(command), 'forbidden');
      assert.equal(changes(db), before);
    }
    rejected(() => repository(db, 2).transition(command), 'forbidden');
    rejected(() => repository(db, 1, () => { throw new AgentReviewError('identity_changed'); }).transition(command), 'identity_changed');
  } finally { db.close(); }
});

test('C4-07/08: legal CAS winner, stale/conflicting requests and exact idempotent replay', () => {
  const db = fixture();
  try {
    const repo = repository(db);
    const started = repo.transition(command);
    assert.equal(started.status, 'reviewing');
    assert.equal(started.revision, 1);
    const before = changes(db);
    assert.deepEqual(repo.transition(command), started);
    assert.equal(changes(db), before);
    rejected(() => repo.transition({ ...command, idempotencyKey: 'loser' }), 'stale_revision');
    for (const change of [{ action: 'reject' }, { expectedRevision: 1 }, { agentId: 'different' },
      { resultGeneration: NEXT }, { source: 'agent' }]) {
      rejected(() => repo.transition({ ...command, ...change } as ReviewTransition), 'idempotency_conflict');
    }
    const approved = repo.transition({ ...command, action: 'approve', expectedRevision: 1, idempotencyKey: 'request-2' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.revision, 2);
    rejected(() => repo.transition({ ...command, action: 'reject', expectedRevision: 2, idempotencyKey: 'request-3' }), 'invalid_transition');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get() as { n: number }).n, 3);
  } finally { db.close(); }
});

test('C4-19: replay survives newer state and generation, but not controller loss/change', () => {
  const db = fixture();
  try {
    const repo = repository(db);
    const original = repo.transition(command);
    db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('s', 'workflow', 'a', NEXT, SHA, 4, SHA, NEXT, SHA, LATER);
    db.prepare("INSERT INTO agent_review_states VALUES ('s','workflow','a',?,'awaiting_review',0,NULL,NULL,NULL)").run(NEXT);
    db.prepare('UPDATE agent_review_current SET result_generation=?,source_sequence=4,pointer_revision=1,selected_at=?').run(NEXT, LATER);
    assert.deepEqual(repo.transition(command), original);
    rejected(() => repo.transition({ ...command, idempotencyKey: 'new' }), 'stale_generation');
    db.exec('UPDATE session_participants SET user_id=2');
    rejected(() => repo.transition(command), 'forbidden');
    rejected(() => repository(db, 2).transition(command), 'idempotency_conflict');
  } finally { db.close(); }
});

test('C4-07/16: external is immutable and container/identity quarantine prevents new transitions', () => {
  const db = fixture();
  try {
    const repo = repository(db);
    seed(db, 'external');
    rejected(() => repo.transition({ ...command, source: 'external' }), 'immutable_source');
    db.prepare(`INSERT INTO agent_review_quarantine_incidents
      (session_id,source,scope,scope_agent_id,source_container_id,incident_generation,state,reason,evidence_sha256,revision,quarantined_at)
      VALUES ('s','workflow','container','',?,1,'active','prefix_changed',?,0,?)`).run(SHA, SHA, NOW);
    rejected(() => repo.transition(command), 'unavailable');
    const before = changes(db);
    assert.deepEqual(repo.listCurrent('s', { limit: 1, offset: 1 }), [{ source: 'workflow', agentId: 'a',
      resultGeneration: SHA, status: 'awaiting_review', revision: 0, unavailable: 1 }]);
    assert.equal(changes(db), before);
  } finally { db.close(); }
});

test('C4-09: failed receipt insertion rolls state and event back together', () => {
  const db = fixture();
  try {
    db.exec(`CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON agent_review_receipts
      BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END`);
    assert.throws(() => repository(db).transition(command), /injected_receipt_failure/);
    assert.deepEqual(db.prepare('SELECT status,revision FROM agent_review_states').get(), { status: 'awaiting_review', revision: 0 });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_receipts').get() as { n: number }).n, 0);
    assert.equal(db.inTransaction, false);
  } finally { db.close(); }
});

test('C4 domains: exact request keys, safe integers, Unicode scalars and bounded pagination', () => {
  const db = fixture();
  try {
    const repo = repository(db);
    for (const change of [{ expectedRevision: NaN }, { expectedRevision: 2 ** 53 }, { expectedRevision: -1 },
      { agentId: 'a/b' }, { resultGeneration: SHA.toUpperCase() }, { idempotencyKey: 'bad key' }, { extra: true }]) {
      rejected(() => repo.transition({ ...command, ...change } as ReviewTransition), 'invalid_input');
    }
    assertReviewSession('😀'.repeat(128));
    assert.throws(() => assertReviewSession('😀'.repeat(129)));
    assert.throws(() => assertReviewSession('\uD800'));
    rejected(() => repo.listCurrent('s', { limit: 101, offset: 0 }), 'invalid_input');
    rejected(() => repo.listCurrent('s', { limit: 1, offset: 0.5 }), 'invalid_input');
    const before = changes(db);
    repo.listCurrent('s', { limit: 10, offset: 0 });
    assert.equal(changes(db), before);
  } finally { db.close(); }
});

test('C4-10/16: quarantine with no result is visible and all read methods perform zero writes', () => {
  const db = fixture();
  try {
    const repo = repository(db);
    db.prepare(`INSERT INTO agent_review_quarantine_incidents
      (session_id,source,scope,scope_agent_id,source_container_id,incident_generation,state,reason,evidence_sha256,revision,quarantined_at)
      VALUES ('new-session','agent','container','',?,1,'active','invalid_shape',?,0,?)`).run(SHA, SHA, NOW);
    const before = changes(db);
    assert.deepEqual(repo.listCurrent('new-session', { limit: 10, offset: 0 }), []);
    assert.deepEqual(repo.readSummary('new-session'), { total: 0, approved: 0, rejected: 0,
      awaitingReview: 0, reviewing: 0, activeIncidents: 1 });
    const incidents = repo.listActiveIncidents('new-session', { limit: 10, afterId: 0 }) as Array<{ reason: string }>;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].reason, 'invalid_shape');
    assert.equal(changes(db), before);
  } finally { db.close(); }
});

test('C4-07: exhausted revision is a stale_revision conflict before any UPDATE or write', () => {
  const db = fixture();
  try {
    // A legal stored shape can contain the upper integer bound (for example an imported source).
    db.exec('DROP TRIGGER agent_review_state_transition_guard');
    db.prepare(`UPDATE agent_review_states SET status='reviewing',revision=?,review_started_at=?,reviewed_by_user_id=1`)
      .run(Number.MAX_SAFE_INTEGER, NOW);
    db.exec(`CREATE TRIGGER fixture_update_must_not_run BEFORE UPDATE ON agent_review_states
      BEGIN SELECT RAISE(ABORT,'unexpected_update'); END`);
    const before = changes(db);
    rejected(() => repository(db).transition({ ...command, action: 'approve', expectedRevision: Number.MAX_SAFE_INTEGER }), 'stale_revision');
    assert.equal(changes(db), before);
    assert.equal((db.prepare('SELECT revision FROM agent_review_states').get() as { revision: number }).revision, Number.MAX_SAFE_INTEGER);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_receipts').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

type WorkerResult = { kind: string; code?: string; revision?: number; writes?: number; inTransaction?: boolean };

function contender(filename: string, key: string, barrier?: SharedArrayBuffer): {
  worker: Worker; locked: Promise<void>; result: Promise<WorkerResult>; exited: Promise<number>;
} {
  const worker = new Worker(new URL('./agent-review-race.worker.mjs', import.meta.url), {
    workerData: { filename, command: { ...command, idempotencyKey: key }, barrier },
  });
  const locked = new Promise<void>((resolve, reject) => {
    worker.on('message', (message: WorkerResult) => { if (message.kind === 'locked') resolve(); });
    worker.once('error', reject);
    worker.once('exit', () => resolve());
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    worker.on('message', (message: WorkerResult) => { if (message.kind !== 'locked') resolve(message); });
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`review_worker_exit_${code}`)); });
  });
  const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
  return { worker, locked, result, exited };
}

test('C4-07: real file-backed concurrent connections produce one winner and zero-write busy/stale loser', { timeout: 20_000 }, async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const artifacts = path.join(root, '.artifacts');
  mkdirSync(artifacts, { recursive: true });
  const scratch = mkdtempSync(path.join(artifacts, 'c4-concurrency-'));
  const filename = path.join(scratch, 'reviews.sqlite');
  const db = fixture(filename);
  const barrier = new SharedArrayBuffer(4);
  const running: Worker[] = [];
  try {
    const winner = contender(filename, 'winner', barrier); running.push(winner.worker);
    await winner.locked; // Real BEGIN IMMEDIATE is held while the second connection attempts admission.
    const loser = contender(filename, 'loser'); running.push(loser.worker);
    assert.deepEqual(await loser.result, { kind: 'error', code: 'SQLITE_BUSY', writes: 0, inTransaction: false });
    assert.equal(await loser.exited, 0);
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    assert.deepEqual(await winner.result, { kind: 'success', revision: 1, writes: 3, inTransaction: false });
    assert.equal(await winner.exited, 0);
    const retry = contender(filename, 'loser'); running.push(retry.worker);
    assert.deepEqual(await retry.result, { kind: 'error', code: 'stale_revision', writes: 0, inTransaction: false });
    assert.equal(await retry.exited, 0);
    assert.deepEqual(db.prepare('SELECT status,revision FROM agent_review_states').get(), { status: 'reviewing', revision: 1 });
    assert.deepEqual(db.prepare("SELECT event_type,idempotency_key FROM agent_review_events WHERE event_type<>'completed'").all(),
      [{ event_type: 'review_started', idempotency_key: 'winner' }]);
    assert.deepEqual(db.prepare('SELECT idempotency_key,resulting_revision FROM agent_review_receipts').all(),
      [{ idempotency_key: 'winner', resulting_revision: 1 }]);
  } finally {
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    await Promise.all(running.map(worker => worker.terminate()));
    db.close(); rmSync(scratch, { recursive: true, force: true });
  }
});

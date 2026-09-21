import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { HOSTED_RESULT_SCHEMA_SQL, HostedResultStore } from './hosted-result-store.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE turn_supervisor_turns (turn_id TEXT PRIMARY KEY);
    CREATE TABLE turn_supervisor_runs (run_id TEXT PRIMARY KEY);
    INSERT INTO turn_supervisor_turns VALUES ('turn');
    INSERT INTO turn_supervisor_runs VALUES ('run');`);
  db.exec(HOSTED_RESULT_SCHEMA_SQL);
  db.prepare(`INSERT INTO turn_supervisor_hosted_results (
    turn_id, run_id, provider, model, session_id, is_new_session, text,
    transcript_state, created_at, updated_at
  ) VALUES ('turn', 'run', 'kimi', 'model', 'session', 1, 'answer', 'pending', 'a', 'a')`).run();
  return db;
}

test('transcript outbox has exclusive owner and only that owner may acknowledge', () => {
  const db = fixture();
  const owner = new HostedResultStore(db, { id: 'owner', pid: 11 }, () => 'b');
  const other = new HostedResultStore(db, { id: 'other', pid: 12 }, () => 'c');
  assert.equal(owner.claimTranscript('turn')?.transcriptState, 'writing');
  assert.equal(other.claimTranscript('turn'), null);
  assert.equal(other.markTranscriptWritten('turn'), false);
  assert.equal(owner.markTranscriptWritten('turn'), true);
  assert.equal(owner.get('turn')?.transcriptState, 'written');
  db.close();
});

test('startup recovers only outbox writers whose process is proven dead', () => {
  const db = fixture();
  const old = new HostedResultStore(db, { id: 'old', pid: 21 });
  old.claimTranscript('turn');
  const next = new HostedResultStore(db, { id: 'next', pid: 22 });
  assert.equal(next.recoverInterruptedTranscriptWrites((pid) => pid === 99), 0);
  assert.equal(next.claimTranscript('turn'), null, 'live writer remains fenced');
  assert.equal(next.recoverInterruptedTranscriptWrites((pid) => pid === 21), 1);
  assert.equal(next.claimTranscript('turn')?.transcriptState, 'writing');
  db.close();
});

test('pre-dispatch retry reuses durable session assignment', () => {
  const db = fixture();
  const store = new HostedResultStore(db);
  const first = store.getOrCreateContext({
    turnId: 'turn', provider: 'kimi', model: 'model', sessionId: 'session-a', isNewSession: true,
  });
  const retry = store.getOrCreateContext({
    turnId: 'turn', provider: 'kimi', model: 'model', sessionId: 'session-b', isNewSession: true,
  });
  assert.equal(first.sessionId, 'session-a');
  assert.equal(retry.sessionId, 'session-a');
  assert.throws(() => store.getOrCreateContext({
    turnId: 'turn', provider: 'kimi', model: 'different', sessionId: 'session-a', isNewSession: true,
  }), /context mismatch/);
  db.close();
});

test('crash recovery routes pending transcript outboxes to their owning harness only', () => {
  const db = fixture();
  db.prepare(`INSERT INTO turn_supervisor_turns VALUES ('codex-turn')`).run();
  db.prepare(`INSERT INTO turn_supervisor_runs VALUES ('codex-run')`).run();
  db.prepare(`INSERT INTO turn_supervisor_hosted_results (
    turn_id, run_id, provider, model, session_id, is_new_session, text,
    transcript_state, created_at, updated_at
  ) VALUES ('codex-turn', 'codex-run', 'codex', 'gpt', 'codex-session', 1,
    'durable answer', 'pending', 'a', 'a')`).run();
  const restarted = new HostedResultStore(db, { id: 'restarted', pid: 33 });
  assert.deepEqual(restarted.listPending(['codex']).map(({ turnId }) => turnId), ['codex-turn']);
  assert.deepEqual(restarted.listPending(['kimi']).map(({ turnId }) => turnId), ['turn']);
  const claimed = restarted.claimTranscript('codex-turn');
  assert.equal(claimed?.text, 'durable answer');
  assert.equal(restarted.markTranscriptWritten('codex-turn'), true);
  assert.equal(restarted.get('codex-turn')?.transcriptState, 'written');
  db.close();
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import { AGENT_REVIEW_SCHEMA_DDL, applyAgentReviewSchema } from './agent-review-lifecycle.migration.js';

const SHA = 'a'.repeat(64);
const NOW = '2026-09-24T00:00:00.000Z';
const LATER = '2026-09-24T00:00:00.001Z';

function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  return db;
}

function result(db: Database.Database, source = 'workflow'): void {
  db.prepare(`INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('s', source, 'a', SHA, SHA, 2, SHA, SHA, SHA, NOW);
}

function state(db: Database.Database, source = 'workflow'): void {
  result(db, source);
  db.prepare(`INSERT INTO agent_review_states VALUES (?,?,?,?, 'awaiting_review',0,NULL,NULL,NULL)`)
    .run('s', source, 'a', SHA);
}

test('C4-14: exact approved DDL, nine tables, eight indexes and nineteen triggers', () => {
  assert.equal(AGENT_REVIEW_SCHEMA_DDL.length, 36);
  assert.equal(createHash('sha256').update(JSON.stringify(AGENT_REVIEW_SCHEMA_DDL)).digest('hex'),
    'aabff28957c87e88b160e2a68e9f27c2bde1ee765dec672727f29b245161e309');
  const db = fixture();
  try {
    const counts = db.prepare(`SELECT type,COUNT(*) AS n FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type`).all();
    assert.deepEqual(counts, [{ type: 'index', n: 8 }, { type: 'table', n: 9 }, { type: 'trigger', n: 19 }]);
    const before = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    db.transaction(() => applyAgentReviewSchema(db)).immediate();
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('C4-14: migration requires caller transaction and rollback leaves no objects', () => {
  const db = new Database(':memory:');
  try {
    assert.throws(() => applyAgentReviewSchema(db), /transaction_required/);
    db.exec('BEGIN IMMEDIATE');
    applyAgentReviewSchema(db);
    db.exec('ROLLBACK');
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema').all(), []);
  } finally { db.close(); }
});

test('C4-12: result/event identities survive volatile session and user deletion', () => {
  const db = fixture();
  try {
    db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY); CREATE TABLE users(id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO sessions VALUES (?)').run('s');
    db.prepare('INSERT INTO users VALUES (?)').run(1);
    result(db);
    db.prepare(`INSERT INTO agent_review_events
      (session_id,source,agent_id,result_generation,event_sequence,event_type,new_status,new_revision,server_time)
      VALUES ('s','workflow','a',?,0,'completed','awaiting_review',0,?)`).run(SHA, NOW);
    db.exec('DELETE FROM sessions; DELETE FROM users');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_results').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get() as { n: number }).n, 1);
    for (const table of ['agent_review_results', 'agent_review_events']) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable|append_only/);
    }
    assert.throws(() => db.prepare('UPDATE agent_review_results SET observed_at=?').run(LATER), /immutable/);
    assert.throws(() => db.prepare('UPDATE agent_review_events SET server_time=?').run(LATER), /append_only/);
  } finally { db.close(); }
});

test('C4-07/23: only revision-incrementing legal state transitions; external cannot change', () => {
  const db = fixture();
  try {
    state(db);
    assert.throws(() => db.prepare(`UPDATE agent_review_states SET status='approved',revision=2,
      review_started_at=?,resolved_at=?,reviewed_by_user_id=1`).run(NOW, NOW), /transition_invalid/);
    db.prepare(`UPDATE agent_review_states SET status='reviewing',revision=1,
      review_started_at=?,reviewed_by_user_id=1`).run(NOW);
    assert.throws(() => db.exec('UPDATE agent_review_states SET revision=0'), /transition_invalid/);
    db.prepare(`UPDATE agent_review_states SET status='approved',revision=2,resolved_at=?`).run(LATER);
    assert.throws(() => db.exec("UPDATE agent_review_states SET status='reviewing',revision=3"), /transition_invalid/);
    state(db, 'external');
    assert.throws(() => db.exec("DELETE FROM agent_review_states WHERE source='external'"), /external_immutable/);
    assert.throws(() => db.prepare(`UPDATE agent_review_states SET status='reviewing',revision=1,
      review_started_at=?,reviewed_by_user_id=1 WHERE source='external'`).run(NOW), /external_immutable/);
  } finally { db.close(); }
});

test('C4-20: quarantine recovery is exact, one-way and retryable reasons only', () => {
  const db = fixture();
  try {
    const insert = db.prepare(`INSERT INTO agent_review_quarantine_incidents
      (session_id,source,scope,scope_agent_id,source_container_id,incident_generation,state,reason,
       evidence_sha256,revision,quarantined_at) VALUES ('s','workflow','container','',?,?,'active',?,?,0,?)`);
    insert.run(SHA, 1, 'unstable_read', SHA, NOW);
    assert.throws(() => insert.run(SHA, 2, 'source_grew', SHA, NOW), /UNIQUE/);
    db.prepare(`UPDATE agent_review_quarantine_incidents SET state='recovered',revision=1,
      recovered_at=?,recovery_evidence_sha256=?,recovery_observation_count=0,recovery_observation_chain_sha256=? WHERE incident_id=1`).run(LATER, SHA, SHA);
    assert.throws(() => db.exec("UPDATE agent_review_quarantine_incidents SET state='active',revision=2"), /recovery_forbidden/);
    insert.run(SHA, 2, 'invalid_sequence', SHA, NOW);
    assert.throws(() => db.prepare(`UPDATE agent_review_quarantine_incidents SET state='recovered',revision=1,
      recovered_at=?,recovery_evidence_sha256=?,recovery_observation_count=0,recovery_observation_chain_sha256=? WHERE incident_id=2`).run(LATER, SHA, SHA), /recovery_forbidden/);
    assert.throws(() => db.exec("UPDATE agent_review_quarantine_incidents SET reason='read_timeout'"), /immutable|recovery_forbidden/);
    assert.throws(() => db.exec('DELETE FROM agent_review_quarantine_incidents'), /append_only/);
  } finally { db.close(); }
});

test('C4-22/23: binding fills matching task once, advances sequence and cannot reopen', () => {
  const db = fixture();
  try {
    db.prepare(`INSERT INTO agent_review_agent_bindings VALUES
      ('s',?,'tool',NULL,'a',1,2,?,?,'active',NULL,NULL,0,?,?)`).run(SHA, SHA, SHA, NOW, NOW);
    assert.throws(() => db.prepare(`UPDATE agent_review_agent_bindings SET task_id='wrong',
      last_completion_sequence=3,last_completion_evidence_sha256=?,revision=1,updated_at=?`).run(SHA, LATER));
    db.prepare(`UPDATE agent_review_agent_bindings SET task_id='a',last_completion_sequence=3,
      last_completion_evidence_sha256=?,revision=1,updated_at=?`).run(SHA, LATER);
    assert.throws(() => db.prepare(`UPDATE agent_review_agent_bindings SET last_completion_sequence=3,
      revision=2,updated_at=?`).run(NOW), /nonmonotonic/);
    db.prepare(`UPDATE agent_review_agent_bindings SET lifecycle='closed',revision=2,updated_at=?`).run(NOW);
    assert.throws(() => db.prepare(`UPDATE agent_review_agent_bindings SET lifecycle='active',revision=3,
      updated_at=?`).run(LATER), /nonmonotonic/);
    assert.throws(() => db.exec("UPDATE agent_review_agent_bindings SET tool_use_id='other'"), /immutable|nonmonotonic/);
  } finally { db.close(); }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applyAgentReviewSchema } from '../agent-review-lifecycle.migration.js';

import { AgentReviewGroupClaimStore, captureReviewGroup } from './agent-review-group-claim.db.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const container = { sessionId: 's', source: 'workflow' as const, sourceContainerId: sha('container') };
const FILE = '/synthetic/p/s.jsonl';
const NOW = '2026-09-24T00:00:00.000Z';
function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY,provider TEXT,jsonl_path TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('s', 'claude', FILE);
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  const insert = db.prepare(`INSERT INTO agent_review_quarantine_incidents
    (session_id,source,source_container_id,scope,scope_agent_id,incident_generation,state,reason,evidence_sha256,revision,quarantined_at)
    VALUES ('s','workflow',?,?,?,1,'active',?,?,0,?)`);
  const incident = (scope: 'identity' | 'container', agent: string, reason = 'read_timeout') =>
    Number(insert.run(container.sourceContainerId, scope, agent, reason, sha(`base-${scope}-${agent}`), NOW).lastInsertRowid);
  const child = db.prepare('INSERT INTO agent_review_quarantine_observations VALUES (?,?,?,?,?)');
  return { db, incident, child, capture: () => db.transaction(() => captureReviewGroup(db, container, FILE))(),
    store: new AgentReviewGroupClaimStore(db) };
}

test('empty and multi-active captures freeze full canonical evidence without selecting a winner or writing', () => {
  const f = fixture();
  try {
    assert.equal(f.capture().mode, 'fresh');
    f.incident('identity', 'A'); f.incident('container', ''); f.incident('identity', 'B');
    const before = f.db.prepare('SELECT total_changes() AS n').get();
    const capture = f.capture();
    assert.equal(capture.mode, 'recovery'); assert.equal(capture.active.length, 3);
    assert.deepEqual(capture.active.map(row => row.scopeAgentId), ['A', '', 'B']);
    for (const value of [capture, capture.container, capture.active, ...capture.active]) assert.equal(Object.isFrozen(value), true);
    assert.equal(f.capture().bindingSha256, capture.bindingSha256);
    assert.deepEqual(f.db.prepare('SELECT total_changes() AS n').get(), before);
    f.child.run(1, 1, 'source_grew', sha('child'), NOW);
    assert.notEqual(f.capture().bindingSha256, capture.bindingSha256);
  } finally { f.db.close(); }
});

test('opaque claims are distinct and one-shot across repository instances, clones and nesting', () => {
  const f = fixture();
  try {
    const a = f.store.capture(container, FILE); const b = f.store.capture(container, FILE);
    assert.notEqual(a, b); assert.equal(Object.isFrozen(a), true); assert.deepEqual(Object.keys(a), []);
    const other = new AgentReviewGroupClaimStore(f.db);
    assert.throws(() => other.consume(a), /stale_group_claim/);
    assert.throws(() => f.store.consume(JSON.parse(JSON.stringify(a))), /stale_group_claim/);
    assert.equal(f.store.consume(a).mode, 'fresh');
    assert.throws(() => f.store.consume(a), /stale_group_claim/);
    f.db.exec('BEGIN');
    assert.throws(() => f.store.consume(b), /stale_group_claim/);
    assert.throws(() => f.store.capture(container, FILE), /nested_transaction/);
    f.db.exec('ROLLBACK');
    assert.throws(() => f.store.consume(b), /stale_group_claim/);
  } finally { f.db.close(); }
});

test('valid maximum is exactly 1024 identities plus one container with 63550 children', () => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      f.incident('container', '');
      for (let i = 0; i < 1024; i++) f.incident('identity', `a${i}`);
      for (let id = 1; id <= 1025; id++) {
        for (let sequence = 1; sequence <= 62; sequence++) f.child.run(id, sequence, 'source_grew', sha(`child-${sequence}`), NOW);
      }
    }).immediate();
    const capture = f.capture();
    assert.equal(capture.active.length, 1025);
    assert.equal(capture.active.reduce((sum, row) => sum + row.observationCount, 0), 63550);
    f.child.run(1, 63, 'source_grew', sha('63'), NOW);
    assert.throws(() => f.capture(), /unavailable/);
    f.db.transaction(() => {
      for (let id = 2; id <= 1025; id++) f.child.run(id, 63, 'source_grew', sha('63'), NOW);
    }).immediate();
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM agent_review_quarantine_observations').get() as { n: number }).n, 64575);
    assert.throws(() => f.capture(), /unavailable/);
    f.db.exec('DROP TRIGGER agent_review_quarantine_observation_insert_guard');
    f.db.pragma('ignore_check_constraints=ON');
    f.child.run(1, 64, 'source_grew', sha('overflow'), NOW);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM agent_review_quarantine_observations').get() as { n: number }).n, 64576);
    assert.throws(() => f.capture(), /unavailable/);
  } finally { f.db.close(); }
});

test('1025 identities and 1026 total reject instead of being mistaken for the valid maximum', () => {
  const f = fixture();
  try {
    f.db.transaction(() => { for (let i = 0; i < 1025; i++) f.incident('identity', `a${i}`); }).immediate();
    assert.throws(() => f.capture(), /unavailable/);
    f.incident('container', '');
    assert.throws(() => f.capture(), /unavailable/);
  } finally { f.db.close(); }
});

test('two container rows or duplicate identity scopes are corrupt even if their total is small', () => {
  for (const scope of ['identity', 'container'] as const) {
    const f = fixture();
    try {
      f.db.exec('DROP INDEX idx_agent_review_quarantine_one_active; DROP INDEX idx_agent_review_quarantine_generation');
      f.incident(scope, scope === 'identity' ? 'A' : ''); f.incident(scope, scope === 'identity' ? 'A' : '');
      assert.throws(() => f.capture(), /chain_invalid|unavailable/);
    } finally { f.db.close(); }
  }
});

test('structural child, saturation and dense-chain corruption all reject group capture', () => {
  for (const scenario of ['structural', 'saturated', 'gap']) {
    const f = fixture();
    try {
      const id = f.incident('identity', 'A');
      if (scenario === 'structural') f.child.run(id, 1, 'invalid_shape', sha('child'), NOW);
      if (scenario === 'saturated') {
        f.db.transaction(() => { for (let i = 1; i <= 63; i++) f.child.run(id, i, 'source_grew', sha(`child${i}`), NOW); }).immediate();
      }
      if (scenario === 'gap') { f.db.exec('DROP TRIGGER agent_review_quarantine_observation_insert_guard'); f.child.run(id, 2, 'source_grew', sha('child'), NOW); }
      assert.throws(() => f.capture(), /unavailable|chain_invalid/);
    } finally { f.db.close(); }
  }
});

test('session rebind is rejected and head mutation changes the captured binding', () => {
  const f = fixture();
  try {
    const before = f.capture();
    f.db.prepare('INSERT INTO agent_review_ingestion_heads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('s', 'workflow', container.sourceContainerId, '1', '2', 0, 0, 0, sha(''), 0, 0, NOW);
    assert.notEqual(f.capture().bindingSha256, before.bindingSha256);
    f.db.exec("UPDATE sessions SET provider='codex'");
    assert.throws(() => f.capture(), /untrusted_provenance/);
  } finally { f.db.close(); }
});

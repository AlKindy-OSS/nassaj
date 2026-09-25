import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applyAgentReviewSchema } from '../agent-review-lifecycle.migration.js';

import { AgentReviewIngestionRepository } from './agent-review-ingestion.db.js';
import { type ReviewIncident, type ReviewIncidentInput } from './agent-review-ingestion-types.js';
import { readIncidentObservationChain } from './agent-review-observation-chain.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const EMPTY = sha('');
const FILE = '/synthetic/projects/p/s.jsonl';
const container = { sessionId: 's', source: 'workflow' as const, sourceContainerId: sha('container') };
const input: ReviewIncidentInput = { ...container, scope: 'container', scopeAgentId: '', reason: 'read_timeout',
  lastCommittedOffset: 0, lastCommittedPrefixSha256: EMPTY, attemptEvidenceSha256: sha('base'),
  observation: { phase: 'preopen', failure: 'read_timeout' } };
function fixture() {
  const directory = mkdtempSync(path.join(process.cwd(), '.test-review-probe-'));
  const file = path.join(directory, 'synthetic.sqlite');
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  const a = new Database(file, { timeout: 0 });
  a.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY,provider TEXT,jsonl_path TEXT)');
  a.prepare('INSERT INTO sessions VALUES (?,?,?)').run('s', 'claude', FILE);
  a.transaction(() => applyAgentReviewSchema(a)).immediate();
  const b = new Database(file, { timeout: 0 });
  const first = new AgentReviewIngestionRepository(a); const second = new AgentReviewIngestionRepository(b);
  return { a, b, first, second, close: () => { a.close(); b.close(); rmSync(directory, { recursive: true }); } };
}
function recover(db: Database.Database, repo: AgentReviewIngestionRepository, incident: ReviewIncident) {
  const chain = readIncidentObservationChain(db, incident.incidentId);
  db.transaction(() => repo.recoverIncident({ incidentId: incident.incidentId, incidentGeneration: incident.incidentGeneration,
    incidentEvidenceSha256: incident.evidenceSha256, expectedRevision: incident.revision,
    observationCount: chain.observationCount, observationChainSha256: chain.observationChainSha256,
    stableFileDev: '1', stableFileIno: '2', stableSize: 1, stablePrefixSha256: sha('stable'),
    committedPrefixSha256: EMPTY, uniqueRelationEvidenceSha256: sha('relation') })).immediate();
}
function counts(db: Database.Database) {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM agent_review_quarantine_incidents) AS incidents,
    (SELECT COUNT(*) FROM agent_review_quarantine_observations) AS observations`).get();
}

test('fresh admission creates once; forged, serialized, reused and cross-instance tokens write nothing', () => {
  const f = fixture();
  try {
    const token = f.first.captureProbeAdmission(container, FILE);
    assert.equal(Object.isFrozen(token), true); assert.deepEqual(Object.keys(token), []);
    assert.throws(() => f.second.recordAdmittedIncident(input, FILE, token), /stale_probe/);
    f.first.recordAdmittedIncident(input, FILE, token);
    for (const candidate of [token, {}, JSON.parse(JSON.stringify(token))]) {
      assert.throws(() => f.first.recordAdmittedIncident(input, FILE, candidate), /stale_probe/);
    }
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 0 });
  } finally { f.close(); }
});

test('distinct retryable and structural observations append; exact base and child replay are zero-write', () => {
  const f = fixture();
  try {
    const base = f.first.recordIncident(input);
    const next = { ...input, attemptEvidenceSha256: sha('next') };
    for (const failure of [input, next, next, input]) {
      f.first.recordAdmittedIncident(failure, FILE, f.first.captureProbeAdmission(container, FILE));
    }
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 1 });
    f.first.recordAdmittedIncident({ ...input, reason: 'invalid_shape' }, FILE, f.first.captureProbeAdmission(container, FILE));
    assert.equal(readIncidentObservationChain(f.a, base.incidentId).reason, 'invalid_shape');
    assert.throws(() => f.first.captureProbeAdmission(container, FILE), /unavailable/);
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 2 });
  } finally { f.close(); }
});

test('recovery-first race rejects old failure in same or different scope without generation fallback', () => {
  const f = fixture();
  try {
    const base = f.first.recordIncident(input);
    const same = f.first.captureProbeAdmission(container, FILE);
    const other = f.first.captureProbeAdmission(container, FILE);
    recover(f.b, f.second, base);
    assert.throws(() => f.first.recordAdmittedIncident({ ...input, reason: 'invalid_shape' }, FILE, same), /stale_probe/);
    assert.throws(() => f.first.recordAdmittedIncident({ ...input, scope: 'identity', scopeAgentId: 'agent', reason: 'invalid_shape' }, FILE, other), /stale_probe/);
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 0 });
    const fresh = f.first.captureProbeAdmission(container, FILE);
    const next = f.first.recordAdmittedIncident({ ...input, reason: 'invalid_shape' }, FILE, fresh);
    assert.equal(next.incidentGeneration, 2);
  } finally { f.close(); }
});

test('append-first race invalidates concurrent token even for another failure scope', () => {
  const f = fixture();
  try {
    f.first.recordIncident(input);
    const token = f.first.captureProbeAdmission(container, FILE);
    f.second.recordAdmittedIncident({ ...input, attemptEvidenceSha256: sha('B') }, FILE, f.second.captureProbeAdmission(container, FILE));
    assert.throws(() => f.first.recordAdmittedIncident({ ...input, scope: 'identity', scopeAgentId: 'agent' }, FILE, token), /stale_probe/);
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 1 });
  } finally { f.close(); }
});

test('fresh-before-create/recover ABA remains stale even when head and active set return to empty', () => {
  const f = fixture();
  try {
    const old = f.first.captureProbeAdmission(container, FILE);
    const base = f.second.recordIncident(input); recover(f.b, f.second, base);
    assert.throws(() => f.first.recordAdmittedIncident(input, FILE, old), /stale_probe/);
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 0 });
  } finally { f.close(); }
});

test('path/provider rebinding and BEGIN-busy consume tokens without effects or automatic retry', () => {
  const f = fixture();
  try {
    const rebound = f.first.captureProbeAdmission(container, FILE);
    f.b.exec("UPDATE sessions SET provider='codex'");
    assert.throws(() => f.first.recordAdmittedIncident(input, FILE, rebound), /untrusted_provenance/);
    f.b.exec("UPDATE sessions SET provider='claude'");
    assert.throws(() => f.first.recordAdmittedIncident(input, FILE, rebound), /stale_probe/);
    const busy = f.first.captureProbeAdmission(container, FILE);
    f.b.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.first.recordAdmittedIncident(input, FILE, busy), /locked/);
    f.b.exec('ROLLBACK');
    assert.throws(() => f.first.recordAdmittedIncident(input, FILE, busy), /stale_probe/);
    assert.deepEqual(counts(f.a), { incidents: 0, observations: 0 });
  } finally { f.close(); }
});

test('append fault rolls back and retires token; no new generation, head, or receipt appears', () => {
  const f = fixture();
  try {
    f.first.recordIncident(input);
    const token = f.first.captureProbeAdmission(container, FILE);
    f.a.exec("CREATE TRIGGER fault AFTER INSERT ON agent_review_quarantine_observations BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => f.first.recordAdmittedIncident({ ...input, reason: 'invalid_shape' }, FILE, token), /injected/);
    f.a.exec('DROP TRIGGER fault');
    assert.throws(() => f.first.recordAdmittedIncident(input, FILE, token), /stale_probe/);
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 0 });
  } finally { f.close(); }
});

test('recovered chain corruption denies new probes before any artifact access or repair', () => {
  const f = fixture();
  try {
    const base = f.first.recordIncident(input); recover(f.a, f.first, base);
    f.a.exec('DROP TRIGGER agent_review_quarantine_observation_insert_guard');
    f.a.prepare('INSERT INTO agent_review_quarantine_observations VALUES (?,?,?,?,?)')
      .run(base.incidentId, 1, 'source_grew', sha('corrupt'), '2026-09-24T00:00:00.000Z');
    const before = counts(f.a);
    assert.throws(() => f.first.captureProbeAdmission(container, FILE), /chain_invalid/);
    assert.deepEqual(counts(f.a), before);
  } finally { f.close(); }
});

test('head advancement invalidates admission before new incident or different-scope creation', () => {
  const f = fixture();
  try {
    const token = f.first.captureProbeAdmission(container, FILE);
    f.b.transaction(() => f.second.advanceHead(null, { ...container, fileDev: '1', fileIno: '2',
      lastCompleteOrdinal: 1, lastCompleteOffset: 5, stableSize: 5, rollingPrefixSha256: sha('new-prefix'),
      lastResultSequence: 1, revision: 0 }, EMPTY)).immediate();
    assert.throws(() => f.first.recordAdmittedIncident(input, FILE, token), /stale_probe/);
    assert.deepEqual(counts(f.a), { incidents: 0, observations: 0 });
  } finally { f.close(); }
});

test('closed watermark query uses exact covering index without temporary sorting', () => {
  const f = fixture();
  try {
    const plan = f.a.prepare(`EXPLAIN QUERY PLAN SELECT incident_id FROM agent_review_quarantine_incidents
      INDEXED BY idx_agent_review_quarantine_session_state
      WHERE session_id=? AND state='recovered' AND source=? AND source_container_id=?
      ORDER BY incident_id DESC LIMIT 1`).all('s', 'workflow', container.sourceContainerId) as { detail: string }[];
    assert.match(plan.map(row => row.detail).join('\n'), /SEARCH .*COVERING INDEX idx_agent_review_quarantine_session_state/);
    assert.equal(plan.some(row => /TEMP B-TREE|SCAN /.test(row.detail)), false);
  } finally { f.close(); }
});

test('last admitted observation reaches saturation and blocks all subsequent probes', () => {
  const f = fixture();
  try {
    const incident = f.first.recordIncident(input);
    for (let sequence = 1; sequence <= 63; sequence++) {
      f.first.recordAdmittedIncident({ ...input, attemptEvidenceSha256: sha(`attempt-${sequence}`) }, FILE,
        f.first.captureProbeAdmission(container, FILE));
    }
    assert.equal(readIncidentObservationChain(f.a, incident.incidentId).reason, 'quarantine_observation_cap');
    assert.throws(() => f.first.captureProbeAdmission(container, FILE), /unavailable/);
    assert.deepEqual(counts(f.a), { incidents: 1, observations: 63 });
  } finally { f.close(); }
});

for (const original of [input, { ...input, scope: 'identity' as const, scopeAgentId: 'agentA' }]) {
  test(`stable recovery selection ${original.scope}/${original.scopeAgentId} cannot create identity B`, () => {
    const f = fixture();
    try {
      f.first.recordIncident(original);
      const token = f.first.captureProbeAdmission(container, FILE);
      const before = counts(f.a);
      const changes = f.a.prepare('SELECT total_changes() AS n').get();
      assert.throws(() => f.first.recordAdmittedIncident({ ...input, scope: 'identity', scopeAgentId: 'agentB' }, FILE, token), /stale_probe/);
      assert.deepEqual(counts(f.a), before);
      assert.deepEqual(f.a.prepare('SELECT total_changes() AS n').get(), changes);
      assert.throws(() => f.first.recordAdmittedIncident(original, FILE, token), /stale_probe/);
    } finally { f.close(); }
  });
}

test('multiple active incidents require explicit selection; exact chosen scope alone accepts append or replay', () => {
  const f = fixture();
  try {
    const a = { ...input, scope: 'identity' as const, scopeAgentId: 'agentA' };
    const b = { ...input, scope: 'identity' as const, scopeAgentId: 'agentB' };
    const baseA = f.first.recordIncident(a); const baseB = f.first.recordIncident(b);
    assert.throws(() => f.first.captureProbeAdmission(container, FILE), /probe_selection_required/);
    assert.throws(() => f.first.captureProbeAdmission(container, FILE, { scope: 'identity', scopeAgentId: 'absent' }), /probe_selection_required/);
    assert.throws(() => f.first.captureProbeAdmission(container, FILE, { scopeAgentId: 'agentB' } as never), /invalid_input/);
    const selection = { scope: 'identity' as const, scopeAgentId: 'agentB' };
    const rejected = f.first.captureProbeAdmission(container, FILE, selection);
    assert.throws(() => f.first.recordAdmittedIncident(a, FILE, rejected), /stale_probe/);
    const first = f.first.captureProbeAdmission(container, FILE, selection);
    // Mutating the caller's selector does not retarget an already captured opaque token.
    selection.scopeAgentId = 'agentA';
    f.first.recordAdmittedIncident({ ...b, attemptEvidenceSha256: sha('B-child') }, FILE, first);
    assert.equal(readIncidentObservationChain(f.a, baseA.incidentId).observationCount, 0);
    assert.equal(readIncidentObservationChain(f.a, baseB.incidentId).observationCount, 1);
    const before = f.a.prepare('SELECT total_changes() AS n').get();
    for (const replay of [b, { ...b, attemptEvidenceSha256: sha('B-child') }]) {
      f.first.recordAdmittedIncident(replay, FILE, f.first.captureProbeAdmission(container, FILE,
        { scope: 'identity', scopeAgentId: 'agentB' }));
    }
    assert.deepEqual(f.a.prepare('SELECT total_changes() AS n').get(), before);
    assert.deepEqual(counts(f.a), { incidents: 2, observations: 1 });
  } finally { f.close(); }
});

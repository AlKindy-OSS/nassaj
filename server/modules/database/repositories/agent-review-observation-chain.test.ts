import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applyAgentReviewSchema } from '../agent-review-lifecycle.migration.js';

import { AgentReviewIngestionRepository } from './agent-review-ingestion.db.js';
import { REVIEW_INCIDENT_REASONS, type ReviewRecovery } from './agent-review-ingestion-types.js';
import { AgentReviewRepository } from './agent-review-lifecycle.db.js';
import { readIncidentObservationChain, projectIncidentObservationChain, validateIncidentObservationChain,
  type IncidentChainBase } from './agent-review-observation-chain.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const NOW = '2026-09-24T00:00:00.000Z';
const EMPTY = sha('');
function fixture(reason = 'read_timeout') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  const repo = new AgentReviewIngestionRepository(db);
  const incident = repo.recordIncident({ sessionId: 's', source: 'workflow', sourceContainerId: sha('container'),
    scope: 'container', scopeAgentId: '', reason: reason as 'read_timeout', lastCommittedOffset: 0,
    lastCommittedPrefixSha256: EMPTY, attemptEvidenceSha256: sha('attempt'), observation: { phase: 'preopen', failure: 'read_timeout' } });
  const insert = db.prepare('INSERT INTO agent_review_quarantine_observations VALUES (?,?,?,?,?)');
  const append = (sequence: number, childReason = 'source_grew', evidence = sha(String(sequence))) =>
    insert.run(incident.incidentId, sequence, childReason, evidence, NOW);
  const recovery = (): ReviewRecovery => {
    const chain = readIncidentObservationChain(db, incident.incidentId);
    return { incidentId: incident.incidentId, incidentGeneration: incident.incidentGeneration,
      incidentEvidenceSha256: incident.evidenceSha256, expectedRevision: incident.revision,
      observationCount: chain.observationCount, observationChainSha256: chain.observationChainSha256,
      stableFileDev: '1', stableFileIno: '2', stableSize: 12, stablePrefixSha256: sha('full'),
      committedPrefixSha256: EMPTY, uniqueRelationEvidenceSha256: sha('relation') };
  };
  return { db, repo, incident, append, recovery };
}

for (const reason of REVIEW_INCIDENT_REASONS.filter(value => !['unstable_read', 'source_grew', 'read_timeout'].includes(value))) {
  test(`structural child ${reason} is durable, projects its evidence, and closes append/recovery`, () => {
    const { db, repo, incident, append, recovery } = fixture();
    try {
      append(1, reason);
      const chain = readIncidentObservationChain(db, incident.incidentId);
      assert.equal(chain.effectivelyStructural, true); assert.equal(chain.reason, reason);
      assert.equal(chain.evidenceSha256, sha('1'));
      assert.throws(() => append(2), /observation_closed/);
      assert.throws(() => db.transaction(() => repo.recoverIncident(recovery())).immediate(), /recovery_forbidden/);
      assert.throws(() => db.prepare(`UPDATE agent_review_quarantine_incidents SET state='recovered',revision=1,
        recovered_at=?,recovery_evidence_sha256=?,recovery_observation_count=1,recovery_observation_chain_sha256=?`)
        .run(NOW, sha('recovery'), chain.observationChainSha256), /recovery_forbidden/);
      assert.equal(projectIncidentObservationChain(db, incident.incidentId).reason, reason);
    } finally { db.close(); }
  });
}

test('retryable recovery seals exact chain, rejects stale evidence, and closes raw append', () => {
  const { db, repo, incident, append, recovery } = fixture();
  try {
    const old = recovery(); append(1);
    assert.throws(() => db.transaction(() => repo.recoverIncident(old)).immediate(), /stale_incident/);
    const exact = recovery();
    db.transaction(() => repo.recoverIncident(exact)).immediate();
    assert.equal(readIncidentObservationChain(db, incident.incidentId).observationChainSha256, exact.observationChainSha256);
    assert.throws(() => append(2), /observation_closed/);
    assert.throws(() => db.exec('UPDATE agent_review_quarantine_observations SET observation_sequence=2'), /append_only/);
    assert.throws(() => db.exec('DELETE FROM agent_review_quarantine_observations'), /append_only/);
    db.exec('DROP TRIGGER agent_review_quarantine_observation_insert_guard');
    append(2); // Corrupt storage fixture: a child after closure must never validate as recovered.
    assert.throws(() => readIncidentObservationChain(db, incident.incidentId), /chain_invalid/);
    assert.equal(projectIncidentObservationChain(db, incident.incidentId).reason, 'quarantine_chain_invalid');
  } finally { db.close(); }
});

test('sequence 63 saturates retryable ledger and disallows further append or recovery', () => {
  const { db, incident, append } = fixture();
  try {
    for (let sequence = 1; sequence <= 63; sequence++) append(sequence);
    const chain = readIncidentObservationChain(db, incident.incidentId);
    assert.equal(chain.effectivelyStructural, true); assert.equal(chain.reason, 'quarantine_observation_cap');
    assert.equal(chain.evidenceSha256, chain.observationChainSha256);
    assert.throws(() => append(64), /observation_closed/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_quarantine_observations').get() as { n: number }).n, 63);
  } finally { db.close(); }
});

test('insert guard denies gap, duplicate base, duplicate child, structural base, and synthetic stored reasons', () => {
  const { db, incident, append } = fixture();
  try {
    assert.throws(() => append(2), /observation_closed/);
    assert.throws(() => append(1, 'read_timeout', incident.evidenceSha256), /observation_closed/);
    append(1);
    assert.throws(() => append(2, 'read_timeout', sha('1')), /UNIQUE/);
    for (const reason of ['quarantine_observation_cap', 'quarantine_chain_invalid']) assert.throws(() => append(2, reason), /CHECK/);
    db.exec('DROP TRIGGER agent_review_quarantine_observation_insert_guard');
    append(3);
    assert.throws(() => readIncidentObservationChain(db, incident.incidentId), /chain_invalid/);
  } finally { db.close(); }
  const structural = fixture('invalid_shape');
  try { assert.throws(() => structural.append(1), /observation_closed/); } finally { structural.db.close(); }
});

test('validator rejects order, duplicates, post-structural, unknown reason, and closed hash drift', () => {
  const base: IncidentChainBase = { incidentId: 1, incidentGeneration: 1, reason: 'read_timeout', evidenceSha256: sha('base'),
    state: 'active', recoveryObservationCount: null, recoveryObservationChainSha256: null };
  const child = { sequence: 1, reason: 'source_grew' as const, evidenceSha256: sha('child') };
  for (const children of [[{ ...child, sequence: 2 }], [child, { ...child, sequence: 2 }],
    [{ ...child, reason: 'invalid_shape' as const }, { ...child, sequence: 2, evidenceSha256: sha('next') }]]) {
    assert.throws(() => validateIncidentObservationChain(base, children), /chain_invalid/);
  }
  assert.throws(() => validateIncidentObservationChain({ ...base, reason: 'unknown' as never }, []), /chain_invalid/);
  assert.throws(() => validateIncidentObservationChain({ ...base, state: 'recovered', recoveryObservationCount: 0,
    recoveryObservationChainSha256: sha('wrong') }, []), /chain_invalid/);
});

test('GET effective projection is bounded and zero-write; unknown stored reason never escapes', () => {
  const { db, incident, append } = fixture();
  try {
    append(1, 'invalid_shape');
    const repository = new AgentReviewRepository(db, { actorUserId: 1, assertCurrent: () => true });
    const before = db.prepare('SELECT total_changes() AS n').get();
    const [row] = repository.listActiveIncidents('s', { limit: 10, afterId: 0 }) as { reason: string; observationChainSha256: string }[];
    assert.equal(row.reason, 'invalid_shape'); assert.match(row.observationChainSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
    db.exec('DROP TRIGGER agent_review_quarantine_observation_no_update'); db.pragma('ignore_check_constraints=ON');
    db.prepare('UPDATE agent_review_quarantine_observations SET reason=?').run('legacy_unknown');
    const projected = projectIncidentObservationChain(db, incident.incidentId);
    assert.equal(projected.reason, 'quarantine_chain_invalid');
    assert.equal(JSON.stringify(projected).includes('legacy_unknown'), false);
    assert.deepEqual(projectIncidentObservationChain(db, incident.incidentId), projected);
  } finally { db.close(); }
});

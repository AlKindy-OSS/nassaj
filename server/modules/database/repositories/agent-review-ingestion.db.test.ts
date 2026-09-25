import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { applyAgentReviewSchema } from '../agent-review-lifecycle.migration.js';

import { AgentReviewIngestionRepository } from './agent-review-ingestion.db.js';
import { type ReviewHead, type ReviewIncidentInput, type ReviewRecovery } from './agent-review-ingestion-types.js';
import { AgentReviewError, hashReviewTuple } from './agent-review-validation.js';

const EMPTY_SHA = createHash('sha256').update('').digest('hex');
const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const container = { sessionId: 's', source: 'workflow' as const, sourceContainerId: SHA };
const head: ReviewHead = { ...container, fileDev: '123', fileIno: '9007199254740992', lastCompleteOrdinal: 2,
  lastCompleteOffset: 42, stableSize: 42, rollingPrefixSha256: SHA, lastResultSequence: 2, revision: 0 };
const incident: ReviewIncidentInput = { ...container, scope: 'container', scopeAgentId: '', reason: 'read_timeout',
  lastCommittedOffset: 0, lastCommittedPrefixSha256: EMPTY_SHA, attemptEvidenceSha256: SHA,
  observation: { phase: 'preopen', failure: 'read_timeout' } };

function fixture(filename = ':memory:'): { db: Database.Database; repo: AgentReviewIngestionRepository } {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  return { db, repo: new AgentReviewIngestionRepository(db) };
}

function rejected(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof AgentReviewError && error.code === code);
}

function changes(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

function recovery(created: ReturnType<AgentReviewIngestionRepository['recordIncident']>): ReviewRecovery {
  return { incidentId: created.incidentId, incidentGeneration: created.incidentGeneration,
    incidentEvidenceSha256: created.evidenceSha256, expectedRevision: created.revision,
    observationCount: 0, observationChainSha256: hashReviewTuple({ schema: 'nassaj-agent-review-observation-chain/v1',
      incidentId: created.incidentId, incidentGeneration: created.incidentGeneration, baseEvidenceSha256: created.evidenceSha256, observations: [] }),
    stableFileDev: '123', stableFileIno: '9007199254740992', stableSize: 42,
    stablePrefixSha256: SHA, committedPrefixSha256: EMPTY_SHA, uniqueRelationEvidenceSha256: OTHER };
}

test('head read and exact replay are zero-write; caller transaction rollback leaves no committed prefix', () => {
  const { db, repo } = fixture();
  try {
    rejected(() => repo.advanceHead(null, head, EMPTY_SHA), 'ingestion_transaction_required');
    db.exec('BEGIN IMMEDIATE');
    assert.equal(repo.advanceHead(null, head, EMPTY_SHA), true);
    db.exec('ROLLBACK');
    assert.equal(repo.readHead(container), null);
    db.transaction(() => repo.advanceHead(null, head, EMPTY_SHA)).immediate();
    const before = changes(db);
    assert.deepEqual(repo.readHead(container), head);
    assert.equal(db.transaction(() => repo.advanceHead({ ...head }, { ...head }, SHA)).immediate(), false);
    assert.equal(changes(db), before);
  } finally { db.close(); }
});

test('head CAS rejects stale prefix, inode replacement, revision/sequence regression and unsafe values', () => {
  const { db, repo } = fixture();
  try {
    db.transaction(() => repo.advanceHead(null, head, EMPTY_SHA)).immediate();
    const next = { ...head, lastCompleteOrdinal: 3, lastCompleteOffset: 64, stableSize: 64, revision: 1 };
    rejected(() => db.transaction(() => repo.advanceHead(null, next, SHA)).immediate(), 'stale_ingestion_head');
    rejected(() => db.transaction(() => repo.advanceHead(head, next, OTHER)).immediate(), 'prefix_changed');
    for (const altered of [{ fileIno: '2' }, { revision: 0 }, { lastCompleteOrdinal: 2 }, { lastResultSequence: 1 }]) {
      rejected(() => db.transaction(() => repo.advanceHead(head, { ...next, ...altered }, SHA)).immediate(), 'invalid_sequence');
    }
    rejected(() => db.transaction(() => repo.advanceHead(head, { ...next, stableSize: 67_108_865 }, SHA)).immediate(), 'invalid_input');
    assert.deepEqual(repo.readHead(container), head);
    db.transaction(() => repo.advanceHead(head, next, SHA)).immediate();
    assert.deepEqual(repo.readHead(container), next);
  } finally { db.close(); }
});

test('C4-16/17: canonical preopen/postopen observations are exact tagged unions and never advance a head', () => {
  const { db, repo } = fixture();
  try {
    for (const observation of [
      { phase: 'preopen', failure: 'read_timeout', fileDev: '0' },
      { phase: 'preopen', failure: 'read_timeout', capturedSize: null },
      { phase: 'postopen', fileDev: '1', fileIno: '2' },
      { phase: 'postopen', fileDev: '1', fileIno: '2', capturedSize: 2 ** 53 },
    ]) rejected(() => repo.recordIncident({ ...incident, observation } as ReviewIncidentInput), 'invalid_input');
    const first = repo.recordIncident(incident);
    const before = changes(db);
    assert.deepEqual(repo.recordIncident({ ...incident, observation: { failure: 'read_timeout', phase: 'preopen' } }), first);
    assert.equal(changes(db), before);
    const second = repo.recordIncident({ ...incident, scope: 'identity', scopeAgentId: 'a',
      observation: { phase: 'postopen', fileDev: '123', fileIno: '9007199254740992', capturedSize: 64 } });
    assert.notEqual(second.evidenceSha256, first.evidenceSha256);
    assert.equal(repo.readHead(container), null);
    rejected(() => db.transaction(() => repo.advanceHead(null, head, EMPTY_SHA)).immediate(), 'unavailable');
  } finally { db.close(); }
});

test('C4-16/20: active evidence cannot be replaced; exact retryable recovery is one-way, next incident gets next generation', () => {
  const { db, repo } = fixture();
  try {
    const first = repo.recordIncident(incident);
    rejected(() => repo.recordIncident({ ...incident, attemptEvidenceSha256: OTHER }), 'quarantine_active_conflict');
    rejected(() => repo.recoverIncident(recovery(first)), 'ingestion_transaction_required');
    for (const altered of [{ incidentId: 999 }, { incidentGeneration: 2 }, { incidentEvidenceSha256: OTHER }, { expectedRevision: 1 }]) {
      rejected(() => db.transaction(() => repo.recoverIncident({ ...recovery(first), ...altered })).immediate(), 'stale_incident');
    }
    db.transaction(() => repo.recoverIncident(recovery(first))).immediate();
    rejected(() => db.transaction(() => repo.recoverIncident(recovery(first))).immediate(), 'stale_incident');
    const second = repo.recordIncident(incident);
    assert.equal(second.incidentGeneration, 2);
    assert.notEqual(second.incidentId, first.incidentId);
    assert.deepEqual(db.prepare('SELECT state,revision FROM agent_review_quarantine_incidents ORDER BY incident_id').all(),
      [{ state: 'recovered', revision: 1 }, { state: 'active', revision: 0 }]);
    assert.equal(repo.readHead(container), null);
  } finally { db.close(); }
});

test('C4-20: structural incident never auto-recovers; all evidence must match the still-committed head', () => {
  const { db, repo } = fixture();
  try {
    const structural = repo.recordIncident({ ...incident, reason: 'prefix_changed' });
    rejected(() => db.transaction(() => repo.recoverIncident(recovery(structural))).immediate(), 'recovery_forbidden');
    const other = { ...head, sourceContainerId: OTHER };
    db.transaction(() => repo.advanceHead(null, other, EMPTY_SHA)).immediate();
    rejected(() => repo.recordIncident({ ...incident, sourceContainerId: OTHER }), 'stale_ingestion_head');
    const retryable = repo.recordIncident({ ...incident, sourceContainerId: OTHER,
      lastCommittedOffset: head.lastCompleteOffset, lastCommittedPrefixSha256: SHA });
    for (const altered of [{ committedPrefixSha256: OTHER }, { stableFileIno: '2' }, { stableSize: 41 }]) {
      rejected(() => db.transaction(() => repo.recoverIncident({ ...recovery(retryable), committedPrefixSha256: SHA, ...altered })).immediate(),
        'stale_ingestion_head');
    }
    db.transaction(() => repo.recoverIncident({ ...recovery(retryable), committedPrefixSha256: SHA })).immediate();
    assert.deepEqual(repo.readHead({ ...container, sourceContainerId: OTHER }), other);
  } finally { db.close(); }
});

test('C4-21: identity incident cap escalates to container quarantine without unbounded rows', () => {
  const { db, repo } = fixture();
  try {
    for (let i = 0; i < 1024; i++) repo.recordIncident({ ...incident, scope: 'identity', scopeAgentId: `agent_${i}` });
    const exceeded = repo.recordIncident({ ...incident, scope: 'identity', scopeAgentId: 'overflow' });
    assert.equal(exceeded.scope, 'container'); assert.equal(exceeded.scopeAgentId, '');
    assert.equal(exceeded.reason, 'quarantine_identity_cap');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_quarantine_incidents').get() as { n: number }).n, 1025);
    const before = changes(db);
    repo.recordIncident({ ...incident, scope: 'identity', scopeAgentId: 'agent_0' });
    repo.recordIncident({ ...incident, scope: 'identity', scopeAgentId: 'another_overflow' });
    assert.equal(changes(db), before);
    assert.equal(repo.readHead(container), null);
  } finally { db.close(); }
});

test('C4-16: file-backed close/reopen and read cannot clear durable quarantine', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const artifacts = path.join(root, '.artifacts'); mkdirSync(artifacts, { recursive: true });
  const scratch = mkdtempSync(path.join(artifacts, 'c4-ingestion-'));
  const filename = path.join(scratch, 'reviews.sqlite');
  const first = fixture(filename);
  try { first.repo.recordIncident(incident); } finally { first.db.close(); }
  const db = new Database(filename);
  try {
    const repo = new AgentReviewIngestionRepository(db);
    const before = changes(db);
    assert.equal(repo.readHead(container), null);
    assert.equal(changes(db), before);
    rejected(() => db.transaction(() => repo.advanceHead(null, head, EMPTY_SHA)).immediate(), 'unavailable');
    assert.deepEqual(db.prepare('SELECT state,incident_generation FROM agent_review_quarantine_incidents').get(),
      { state: 'active', incident_generation: 1 });
  } finally { db.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test('C4-09/20: recovery and head advancement roll back together on a later ingestion failure', () => {
  const { db, repo } = fixture();
  try {
    const created = repo.recordIncident(incident);
    assert.throws(() => db.transaction(() => {
      repo.recoverIncident(recovery(created));
      repo.advanceHead(null, head, EMPTY_SHA);
      throw new Error('injected_ingestion_failure');
    }).immediate(), /injected_ingestion_failure/);
    assert.equal(repo.readHead(container), null);
    assert.deepEqual(db.prepare('SELECT state,revision FROM agent_review_quarantine_incidents').get(),
      { state: 'active', revision: 0 });
  } finally { db.close(); }
});

test('ingestion boundary rejects malformed scopes, stat identities, unsafe integers and evidence extras', () => {
  const { db, repo } = fixture();
  try {
    const before = changes(db);
    for (const changed of [{ source: 'external' }, { scope: 'container', scopeAgentId: 'a' },
      { scope: 'identity', scopeAgentId: '' }, { lastCommittedOffset: 2 ** 53 }, { reason: 'unknown' },
      { extra: 'data' }, { observation: { phase: 'preopen', failure: 'unknown' } },
      { observation: { phase: 'postopen', fileDev: '-1', fileIno: '2', capturedSize: 1 } }]) {
      rejected(() => repo.recordIncident({ ...incident, ...changed } as ReviewIncidentInput), 'invalid_input');
    }
    assert.equal(changes(db), before);
    const created = repo.recordIncident(incident);
    for (const changed of [{ expectedRevision: Number.MAX_SAFE_INTEGER }, { stableSize: 67_108_865 },
      { uniqueRelationEvidenceSha256: '' }, { stableFileIno: 123 }, { extra: 'data' }]) {
      rejected(() => db.transaction(() => repo.recoverIncident({ ...recovery(created), ...changed } as ReviewRecovery)).immediate(), 'invalid_input');
    }
    assert.deepEqual(db.prepare('SELECT state,revision FROM agent_review_quarantine_incidents').get(),
      { state: 'active', revision: 0 });
  } finally { db.close(); }
});

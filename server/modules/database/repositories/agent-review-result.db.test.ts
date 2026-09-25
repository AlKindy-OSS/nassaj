import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applyAgentReviewSchema } from '../agent-review-lifecycle.migration.js';

import { AgentReviewIngestionRepository } from './agent-review-ingestion.db.js';
import type { ReviewHead } from './agent-review-ingestion-types.js';
import { AgentReviewRepository } from './agent-review-lifecycle.db.js';
import { AgentReviewResultRepository } from './agent-review-result.db.js';
import type { ReviewBindingEvidence, ReviewCompletionEvidence, ReviewResultFold } from './agent-review-result-types.js';
import { AgentReviewError } from './agent-review-validation.js';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const EMPTY = digest('');
const container = { sessionId: 's', source: 'workflow' as const, sourceContainerId: digest('container') };
const binding: ReviewBindingEvidence = { toolUseId: 'tool-1', agentId: 'agent-1', launchSequence: 1, bindingSequence: 2,
  launchEvidenceSha256: digest('launch'), bindingEvidenceSha256: digest('binding') };

function completion(sequence: number, source: 'workflow' | 'agent' = 'workflow'): ReviewCompletionEvidence {
  return { agentId: 'agent-1', toolUseId: source === 'agent' ? 'tool-1' : null,
    taskId: source === 'agent' ? 'agent-1' : null, sourceSequence: sequence,
    launchEvidenceSha256: source === 'agent' ? binding.launchEvidenceSha256 : digest(`started-${sequence - 1}`),
    completionEvidenceSha256: digest(`result-${sequence}`), resultPayloadSha256: digest('payload') };
}

function head(ordinal: number, source: 'workflow' | 'agent' = 'workflow'): ReviewHead {
  return { ...container, source, fileDev: '1', fileIno: '2', lastCompleteOrdinal: ordinal,
    lastCompleteOffset: ordinal * 10, stableSize: ordinal * 10, rollingPrefixSha256: digest(`prefix-${ordinal}`),
    lastResultSequence: ordinal, revision: 0 };
}

function fixture(): { db: Database.Database; repo: AgentReviewResultRepository } {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  db.exec(`CREATE TABLE session_participants(session_id TEXT,user_id INTEGER,role TEXT,attribution TEXT);
    INSERT INTO session_participants VALUES ('s',1,'owner','spawn')`);
  // Storage-only tests inject an assertion; production must supply the later raw-provenance validator.
  return { db, repo: new AgentReviewResultRepository(db, () => true) };
}

function initial(source: 'workflow' | 'agent' = 'workflow'): ReviewResultFold {
  const sequence = source === 'agent' ? 3 : 2;
  return { expectedHead: null, nextHead: head(sequence, source), committedPrefixSha256: EMPTY,
    bindings: source === 'agent' ? [binding] : [], completions: [completion(sequence, source)] };
}

function rejected(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof AgentReviewError && error.code === code);
}

function rows(db: Database.Database): { results: number; states: number; events: number; current: number; bindings: number; heads: number } {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM agent_review_results) AS results,
    (SELECT COUNT(*) FROM agent_review_states) AS states,(SELECT COUNT(*) FROM agent_review_events) AS events,
    (SELECT COUNT(*) FROM agent_review_current) AS current,(SELECT COUNT(*) FROM agent_review_agent_bindings) AS bindings,
    (SELECT COUNT(*) FROM agent_review_ingestion_heads) AS heads`).get() as ReturnType<typeof rows>;
}

test('C4-01/09 storage: result/state/event/current/head commit together and exact evidence reread writes nothing', () => {
  const { db, repo } = fixture();
  try {
    const fold = initial();
    rejected(() => repo.applyFold(fold), 'ingestion_transaction_required');
    assert.deepEqual(db.transaction(() => repo.applyFold(fold)).immediate(), { bindings: 0, completions: 1, headAdvanced: true });
    assert.deepEqual(rows(db), { results: 1, states: 1, events: 1, current: 1, bindings: 0, heads: 1 });
    const before = db.prepare('SELECT total_changes() AS n').get();
    assert.deepEqual(db.transaction(() => repo.applyFold({ ...fold, expectedHead: fold.nextHead,
      committedPrefixSha256: fold.nextHead.rollingPrefixSha256 })).immediate(), { bindings: 0, completions: 0, headAdvanced: false });
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
  } finally { db.close(); }
});

test('C4-02 storage: later workflow launch/result creates independent awaiting_review generation after approval', () => {
  const { db, repo } = fixture();
  try {
    const first = initial(); db.transaction(() => repo.applyFold(first)).immediate();
    const review = new AgentReviewRepository(db, { actorUserId: 1, assertCurrent: () => true });
    const resultGeneration = (db.prepare('SELECT result_generation AS generation FROM agent_review_current').get() as { generation: string }).generation;
    const request = { sessionId: 's', source: 'workflow' as const, agentId: 'agent-1', resultGeneration,
      action: 'start_review' as const, expectedRevision: 0, idempotencyKey: 'start' };
    review.transition(request); review.transition({ ...request, action: 'approve', expectedRevision: 1, idempotencyKey: 'approve' });
    const second: ReviewResultFold = { ...first, expectedHead: first.nextHead,
      nextHead: { ...head(4), revision: 1 }, committedPrefixSha256: first.nextHead.rollingPrefixSha256,
      completions: [completion(2), completion(4)] };
    db.transaction(() => repo.applyFold(second)).immediate();
    assert.deepEqual(review.listCurrent('s', { limit: 10, offset: 0 }).map(row => {
      const value = row as { status: string; revision: number }; return [value.status, value.revision];
    }), [['awaiting_review', 0]]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_states').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_receipts').get() as { n: number }).n, 2);
  } finally { db.close(); }
});

test('C4-03/18 storage: a workflow launch cannot be consumed twice and cross-container agent collision rolls back', () => {
  const { db, repo } = fixture();
  try {
    const first = initial(); db.transaction(() => repo.applyFold(first)).immediate();
    const reused = { ...completion(4), launchEvidenceSha256: completion(2).launchEvidenceSha256 };
    rejected(() => db.transaction(() => repo.applyFold({ ...first, expectedHead: first.nextHead,
      nextHead: { ...head(4), revision: 1 }, committedPrefixSha256: first.nextHead.rollingPrefixSha256,
      completions: [reused] })).immediate(), 'reused_launch');
    rejected(() => db.transaction(() => repo.applyFold({ ...first,
      nextHead: { ...first.nextHead, sourceContainerId: digest('other-container') } })).immediate(), 'conflicting_binding');
    assert.deepEqual(rows(db), { results: 1, states: 1, events: 1, current: 1, bindings: 0, heads: 1 });
  } finally { db.close(); }
});

test('C4-04/22 storage: binding starts NULL task; first matching completion CAS-fills task and later result advances it', () => {
  const { db, repo } = fixture();
  try {
    const pending: ReviewResultFold = { ...initial('agent'), nextHead: { ...head(2, 'agent'), lastResultSequence: 0 }, completions: [] };
    db.transaction(() => repo.applyFold(pending)).immediate();
    assert.deepEqual(db.prepare('SELECT task_id,revision,last_completion_sequence FROM agent_review_agent_bindings').get(),
      { task_id: null, revision: 0, last_completion_sequence: null });
    const first = { ...initial('agent'), expectedHead: pending.nextHead, nextHead: { ...head(3, 'agent'), revision: 1 },
      committedPrefixSha256: pending.nextHead.rollingPrefixSha256 };
    db.transaction(() => repo.applyFold(first)).immediate();
    assert.deepEqual(db.prepare('SELECT task_id,revision,last_completion_sequence FROM agent_review_agent_bindings').get(),
      { task_id: 'agent-1', revision: 1, last_completion_sequence: 3 });
    const second = { ...first, expectedHead: first.nextHead, nextHead: { ...head(4, 'agent'), revision: 2 },
      committedPrefixSha256: first.nextHead.rollingPrefixSha256, completions: [completion(3, 'agent'), completion(4, 'agent')] };
    db.transaction(() => repo.applyFold(second)).immediate();
    assert.deepEqual(db.prepare('SELECT task_id,revision,last_completion_sequence FROM agent_review_agent_bindings').get(),
      { task_id: 'agent-1', revision: 2, last_completion_sequence: 4 });
    assert.deepEqual(rows(db), { results: 2, states: 2, events: 2, current: 1, bindings: 1, heads: 1 });
  } finally { db.close(); }
});

test('C4-22/23 storage: task mismatch, missing binding, conflicting tool reuse and closed-binding resume are denied', () => {
  const { db, repo } = fixture();
  try {
    const first = initial('agent');
    rejected(() => db.transaction(() => repo.applyFold({ ...first, completions: [{ ...first.completions[0], taskId: 'wrong' }] })).immediate(), 'conflicting_binding');
    rejected(() => db.transaction(() => repo.applyFold({ ...first, bindings: [] })).immediate(), 'conflicting_binding');
    assert.deepEqual(rows(db), { results: 0, states: 0, events: 0, current: 0, bindings: 0, heads: 0 });
    db.transaction(() => repo.applyFold(first)).immediate();
    const later = { ...first, expectedHead: first.nextHead, nextHead: { ...head(4, 'agent'), revision: 1 },
      committedPrefixSha256: first.nextHead.rollingPrefixSha256, completions: [completion(4, 'agent')] };
    rejected(() => db.transaction(() => repo.applyFold({ ...later, bindings: [{ ...binding, agentId: 'different' }] })).immediate(), 'conflicting_binding');
    db.exec("UPDATE agent_review_agent_bindings SET lifecycle='closed',revision=revision+1,updated_at='2026-01-01T00:00:00Z'");
    rejected(() => db.transaction(() => repo.applyFold(later)).immediate(), 'conflicting_binding');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_results').get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test('C4-09 storage: late head CAS failure rolls back inserted binding, result, state, event and current pointer', () => {
  const { db, repo } = fixture();
  try {
    const fold = initial('agent');
    rejected(() => db.transaction(() => repo.applyFold({ ...fold, committedPrefixSha256: digest('wrong-prefix') })).immediate(), 'prefix_changed');
    assert.deepEqual(rows(db), { results: 0, states: 0, events: 0, current: 0, bindings: 0, heads: 0 });
    assert.equal(db.inTransaction, false);
    new AgentReviewIngestionRepository(db).recordIncident({ ...container, source: 'agent', scope: 'identity',
      scopeAgentId: 'agent-1', reason: 'prefix_changed', lastCommittedOffset: 0, lastCommittedPrefixSha256: EMPTY,
      attemptEvidenceSha256: digest('attempt'), observation: { phase: 'preopen', failure: 'open_failed' } });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_review_quarantine_incidents').get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test('provenance assertion must be explicit synchronous true before any storage effect; caps and ordering reject', () => {
  const { db } = fixture();
  try {
    for (const result of [false, undefined, Promise.resolve(true)]) {
      const repo = new AgentReviewResultRepository(db, (() => result) as () => true);
      const before = db.prepare('SELECT total_changes() AS n').get();
      rejected(() => db.transaction(() => repo.applyFold(initial())).immediate(), 'untrusted_provenance');
      assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
    }
    const repo = new AgentReviewResultRepository(db, () => true);
    rejected(() => db.transaction(() => repo.applyFold({ ...initial(), completions: Array(4097).fill(completion(2)) })).immediate(), 'completion_cap');
    rejected(() => db.transaction(() => repo.applyFold({ ...initial(), completions: [completion(2), completion(2)] })).immediate(), 'invalid_sequence');
    assert.deepEqual(rows(db), { results: 0, states: 0, events: 0, current: 0, bindings: 0, heads: 0 });
  } finally { db.close(); }
});

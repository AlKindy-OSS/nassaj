import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import type { ContextWatermarks } from './contracts.js';
import { isProviderObservation } from './contracts.js';
import {
  ConversationFoundationRepository,
  ConversationRepositoryError,
  type AcceptRunCommandInput,
} from './repository.js';
import { initializeConversationFoundationSchema } from './schema.js';
import { ShadowConversationOrchestrator } from './shadow-orchestrator.js';

const ZERO_MARKS: ContextWatermarks = {
  projectedThrough: { runSeq: 0, eventSeq: 0 },
  submittedThrough: { runSeq: 0, eventSeq: 0 },
  confirmedThrough: { runSeq: 0, eventSeq: 0 },
};

function setup(): {
  db: Database.Database;
  repository: ConversationFoundationRepository;
  writerEpoch: number;
} {
  const db = new Database(':memory:');
  initializeConversationFoundationSchema(db);
  const repository = new ConversationFoundationRepository(db);
  repository.createConversation({ conversationId: 'conv-1', projectId: 'project-1', createdBy: 'user-1' });
  const writerEpoch = repository.acquireWriterEpoch('conv-1', 'instance-1');
  repository.markWriterRecovered('conv-1', 'instance-1', writerEpoch);
  return { db, repository, writerEpoch };
}

function runInput(writerEpoch: number): AcceptRunCommandInput {
  return {
    commandId: 'command-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    principalId: 'user-1',
    clientMsgId: 'client-message-1',
    requestDigest: 'digest-1',
    requestedHarness: 'fake',
    requestedModel: 'fake-model',
    writerEpoch,
  };
}

function insertSegment(db: Database.Database): void {
  db.prepare(
    `INSERT INTO conversation_segments
      (segment_id, conversation_id, harness_id, user_id, credential_scope_id,
       credential_binding_id, compatibility_generation, credential_epoch, writer_epoch)
     VALUES ('segment-1', 'conv-1', 'fake', 'user-1', 'scope-1', 'binding-1', 'gen-1', 1,
             (SELECT writer_epoch FROM conversations WHERE conversation_id = 'conv-1'))`,
  ).run();
}

function assertCode(error: unknown, code: string): boolean {
  return error instanceof ConversationRepositoryError && error.code === code;
}

describe('Universal Conversation Foundation', () => {
  it('deduplicates commands and rejects idempotency-key content changes', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      const first = repository.acceptRunCommand(runInput(writerEpoch));
      const duplicate = repository.acceptRunCommand({ ...runInput(writerEpoch), commandId: 'ignored', runId: 'ignored' });
      assert.equal(first.runSeq, 1);
      assert.equal(duplicate.reused, true);
      assert.equal(duplicate.runId, 'run-1');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_runs').get().count, 1);
      assert.throws(
        () => repository.acceptRunCommand({ ...runInput(writerEpoch), requestDigest: 'changed' }),
        (error) => assertCode(error, 'IDEMPOTENCY_CONFLICT'),
      );
    } finally {
      db.close();
    }
  });

  it('fences stale writers and prevents terminal run resurrection', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.acceptRunCommand(runInput(writerEpoch));
      repository.transitionRun({
        runId: 'run-1',
        conversationId: 'conv-1',
        expected: 'accepted',
        next: 'failed',
        writerEpoch,
      });
      assert.throws(
        () =>
          repository.transitionRun({
            runId: 'run-1',
            conversationId: 'conv-1',
            expected: 'failed',
            next: 'running',
            writerEpoch,
          }),
        (error) => assertCode(error, 'INVALID_RUN_TRANSITION'),
      );
      repository.releaseWriter('conv-1', 'instance-1', writerEpoch);
      const newerEpoch = repository.acquireWriterEpoch('conv-1', 'instance-2');
      repository.markWriterRecovered('conv-1', 'instance-2', newerEpoch);
      assert.throws(
        () => repository.assertActiveWriter('conv-1', writerEpoch),
        (error) => assertCode(error, 'NOT_ACTIVE_WRITER'),
      );
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO conversation_commands
              (command_id, conversation_id, principal_id, operation, idempotency_key,
               request_digest, state, writer_epoch)
             VALUES ('stale', 'conv-1', 'user-1', 'stop', 'stale', 'digest', 'prepared', ?)`,
          ).run(writerEpoch),
        /STALE_WRITER_EPOCH/,
      );
    } finally {
      db.close();
    }
  });

  it('quarantines rewritten source identity and treats exact repeats as idempotent', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      insertSegment(db);
      const base = {
        sourceId: 'source-1',
        segmentId: 'segment-1',
        conversationId: 'conv-1',
        sourceGeneration: 1,
        observedExtent: 100,
        adapterVersion: '1.0.0',
        runtimeVersion: '1.0.0',
        writerEpoch,
      };
      const first = repository.recordSourceObservation({
        ...base,
        observationId: 'observation-1',
        sourceEventId: 'provider-event-1',
        sourceOrdinal: 1,
        rawDigest: 'raw-a',
      });
      const duplicate = repository.recordSourceObservation({
        ...base,
        observationId: 'observation-duplicate',
        sourceEventId: 'provider-event-1',
        sourceOrdinal: 1,
        rawDigest: 'raw-a',
      });
      const mutation = repository.recordSourceObservation({
        ...base,
        observationId: 'observation-mutation',
        sourceEventId: 'provider-event-1',
        sourceOrdinal: 1,
        rawDigest: 'raw-b',
      });
      assert.equal(first.classification, 'initial');
      assert.equal(duplicate.status, 'idempotent');
      assert.equal(mutation.classification, 'rewritten');
      assert.equal(mutation.quarantined, true);
      assert.equal(
        (db.prepare("SELECT state FROM conversation_segments WHERE segment_id = 'segment-1'").get() as { state: string }).state,
        'quarantined',
      );
    } finally {
      db.close();
    }
  });

  it('advances three watermarks only through an authorized projection with evidence', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.acceptRunCommand(runInput(writerEpoch));
      insertSegment(db);
      db.prepare(
        `INSERT INTO conversation_attempts
          (attempt_id, run_id, conversation_id, attempt_no, segment_id, harness_id,
           adapter_version, runtime_version, model_id, credential_scope_id,
           destination_endpoint, credential_binding_id, credential_epoch, state, writer_epoch)
         VALUES ('attempt-1', 'run-1', 'conv-1', 1, 'segment-1', 'fake',
                 '1.0.0', '1.0.0', 'fake-model', 'scope-1', 'local', 'binding-1', 1,
                 'scheduled', ?)`,
      ).run(writerEpoch);
      db.prepare(
        `INSERT INTO context_projections
          (projection_id, conversation_id, run_id, attempt_id, segment_id, requested_by,
           destination_harness, destination_adapter, destination_runtime,
           destination_account_scope, destination_model, destination_endpoint,
           policy_version, policy_epoch, policy_digest, decision, reason_codes_json,
           from_run_seq, from_event_seq, projected_run_seq, projected_event_seq,
           event_ids_json, omissions_json, content_digest, credential_binding_id,
           credential_epoch, state, writer_epoch)
         VALUES
          ('projection-1', 'conv-1', 'run-1', 'attempt-1', 'segment-1', 'user-1',
           'fake', '1.0.0', '1.0.0', 'scope-1', 'fake-model', 'local',
           'policy-1', 1, 'policy-digest', 'allowed', '[]',
           0, 0, 1, 1, '["event-1"]', '[]', 'projection-digest',
           'binding-1', 1, 'prepared', ?)`,
      ).run(writerEpoch);
      const next: ContextWatermarks = {
        projectedThrough: { runSeq: 1, eventSeq: 1 },
        submittedThrough: { runSeq: 1, eventSeq: 1 },
        confirmedThrough: { runSeq: 1, eventSeq: 1 },
      };
      assert.throws(
        () =>
          repository.advanceSegmentWatermarks({
            advanceIdPrefix: 'advance-missing-evidence',
            conversationId: 'conv-1',
            segmentId: 'segment-1',
            projectionId: 'projection-1',
            projectionDigest: 'projection-digest',
            expected: ZERO_MARKS,
            next,
            writerEpoch,
          }),
        (error) => assertCode(error, 'SUBMISSION_EVIDENCE_REQUIRED'),
      );
      repository.advanceSegmentWatermarks({
        advanceIdPrefix: 'advance-1',
        conversationId: 'conv-1',
        segmentId: 'segment-1',
        projectionId: 'projection-1',
        projectionDigest: 'projection-digest',
        expected: ZERO_MARKS,
        next,
        submittedEvidenceDigest: 'transport-evidence',
        confirmedEvidenceDigest: 'checkpoint-evidence',
        writerEpoch,
      });
      assert.equal(
        (db.prepare("SELECT confirmed_run_seq FROM conversation_segments WHERE segment_id = 'segment-1'").get() as { confirmed_run_seq: number }).confirmed_run_seq,
        1,
      );
    } finally {
      db.close();
    }
  });

  it('keeps shadow writes disabled by default and rejects forged legal fields', () => {
    let calls = 0;
    const shadow = new ShadowConversationOrchestrator(
      {
        acceptRunCommand() {
          calls += 1;
          return { commandId: 'x', runId: 'y', runSeq: 1, reused: false };
        },
      },
      {},
    );
    assert.deepEqual(shadow.recordAcceptedRun(runInput(1)), { enabled: false, recorded: false });
    assert.equal(calls, 0);
    assert.equal(
      isProviderObservation({
        observationId: 'obs',
        attemptCorrelationToken: 'attempt-token',
        providerSequence: 1,
        kind: 'assistant_completed',
        payload: {},
        observedAt: new Date().toISOString(),
        conversationId: 'forged-conversation',
      }),
      false,
    );
  });
});

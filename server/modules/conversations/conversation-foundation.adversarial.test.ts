import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import type { ContextWatermarks } from './contracts.js';
import { isProviderObservation } from './contracts.js';
import {
  ConversationFoundationRepository,
  ConversationRepositoryError,
  type AcceptRunCommandInput,
  type SourceObservationInput,
} from './repository.js';
import { initializeConversationFoundationSchema } from './schema.js';
import {
  ShadowConversationOrchestrator,
  UNIVERSAL_CONVERSATION_SHADOW_FLAG,
} from './shadow-orchestrator.js';

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
  repository.createConversation({
    conversationId: 'conv-1',
    projectId: 'project-1',
    createdBy: 'user-1',
  });
  const writerEpoch = repository.acquireWriterEpoch('conv-1', 'instance-1');
  repository.markWriterRecovered('conv-1', 'instance-1', writerEpoch);
  return { db, repository, writerEpoch };
}

function runInput(
  writerEpoch: number,
  overrides: Partial<AcceptRunCommandInput> = {},
): AcceptRunCommandInput {
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
    ...overrides,
  };
}

function insertSegment(db: Database.Database): void {
  db.prepare(
    `INSERT INTO conversation_segments
      (segment_id, conversation_id, harness_id, user_id, credential_scope_id,
       credential_binding_id, compatibility_generation, credential_epoch, writer_epoch)
     VALUES ('segment-1', 'conv-1', 'fake', 'user-1', 'scope-1',
             'binding-1', 'gen-1', 1,
             (SELECT writer_epoch FROM conversations WHERE conversation_id = 'conv-1'))`,
  ).run();
}

function insertAttempt(db: Database.Database, writerEpoch: number): void {
  db.prepare(
    `INSERT INTO conversation_attempts
      (attempt_id, run_id, conversation_id, attempt_no, segment_id, harness_id,
       adapter_version, runtime_version, model_id, credential_scope_id,
       destination_endpoint, credential_binding_id, credential_epoch, state, writer_epoch)
     VALUES ('attempt-1', 'run-1', 'conv-1', 1, 'segment-1', 'fake',
             '1.0.0', '1.0.0', 'fake-model', 'scope-1', 'local', 'binding-1', 1,
             'scheduled', ?)`,
  ).run(writerEpoch);
}

function insertProjection(
  db: Database.Database,
  writerEpoch: number,
  overrides: {
    projectionId?: string;
    fromRunSeq?: number;
    fromEventSeq?: number;
    projectedRunSeq?: number;
    projectedEventSeq?: number;
    contentDigest?: string;
    decision?: 'allowed' | 'denied';
    state?: 'prepared' | 'invalidated' | 'denied';
    destinationAdapter?: string;
    destinationRuntime?: string;
    destinationModel?: string;
    destinationEndpoint?: string;
  } = {},
): void {
  const decision = overrides.decision ?? 'allowed';
  const state = overrides.state ?? (decision === 'denied' ? 'denied' : 'prepared');
  const attempt = db.prepare("SELECT 1 FROM conversation_attempts WHERE attempt_id = 'attempt-1'").get();
  if (!attempt) insertAttempt(db, writerEpoch);
  db.prepare(
    `INSERT INTO context_projections
      (projection_id, conversation_id, run_id, attempt_id, segment_id, requested_by,
       destination_harness, destination_adapter, destination_runtime,
       destination_account_scope, destination_model, destination_endpoint,
       policy_version, policy_epoch, policy_digest, decision, reason_codes_json,
       from_run_seq, from_event_seq, projected_run_seq, projected_event_seq,
       event_ids_json, omissions_json, content_digest, credential_binding_id,
       credential_epoch, state, writer_epoch)
     VALUES (?, 'conv-1', 'run-1', 'attempt-1', 'segment-1', 'user-1',
             'fake', ?, ?, 'scope-1', ?, ?,
             'policy-1', 1, 'policy-digest', ?, '[]', ?, ?, ?, ?,
             '[]', '[]', ?, 'binding-1', 1, ?, ?)`,
  ).run(
    overrides.projectionId ?? 'projection-1',
    overrides.destinationAdapter ?? '1.0.0',
    overrides.destinationRuntime ?? '1.0.0',
    overrides.destinationModel ?? 'fake-model',
    overrides.destinationEndpoint ?? 'local',
    decision,
    overrides.fromRunSeq ?? 0,
    overrides.fromEventSeq ?? 0,
    overrides.projectedRunSeq ?? 1,
    overrides.projectedEventSeq ?? 1,
    overrides.contentDigest ?? 'projection-digest',
    state,
    writerEpoch,
  );
}

function sourceInput(
  writerEpoch: number,
  overrides: Partial<SourceObservationInput> = {},
): SourceObservationInput {
  return {
    observationId: 'observation-1',
    sourceId: 'source-1',
    segmentId: 'segment-1',
    conversationId: 'conv-1',
    sourceGeneration: 1,
    sourceEventId: 'provider-event-1',
    sourceOrdinal: 1,
    observedExtent: 100,
    rawDigest: 'raw-1',
    adapterVersion: '1.0.0',
    runtimeVersion: '1.0.0',
    writerEpoch,
    ...overrides,
  };
}

function assertCode(error: unknown, code: string): boolean {
  return error instanceof ConversationRepositoryError && error.code === code;
}

function segmentState(db: Database.Database): string {
  return (
    db.prepare("SELECT state FROM conversation_segments WHERE segment_id = 'segment-1'").get() as {
      state: string;
    }
  ).state;
}

describe('Universal Conversation Foundation adversarial contract', () => {
  it('scopes idempotency by conversation, principal, and operation', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      const first = repository.acceptRunCommand(runInput(writerEpoch));
      const sameTuple = repository.acceptRunCommand(
        runInput(writerEpoch, { commandId: 'ignored-command', runId: 'ignored-run' }),
      );
      repository.addParticipant({
        conversationId: 'conv-1',
        principalId: 'user-2',
        writerEpoch,
      });
      const otherPrincipal = repository.acceptRunCommand(
        runInput(writerEpoch, {
          commandId: 'command-2',
          runId: 'run-2',
          principalId: 'user-2',
        }),
      );

      db.prepare(
        `INSERT INTO conversation_commands
          (command_id, conversation_id, principal_id, operation, idempotency_key,
           request_digest, state, writer_epoch)
         VALUES ('command-stop', 'conv-1', 'user-1', 'stop',
                 'client-message-1', 'digest-stop', 'prepared', ?)`,
      ).run(writerEpoch);

      assert.deepEqual(first, {
        commandId: 'command-1',
        runId: 'run-1',
        runSeq: 1,
        reused: false,
      });
      assert.equal(sameTuple.reused, true);
      assert.equal(sameTuple.runId, first.runId);
      assert.equal(otherPrincipal.reused, false);
      assert.equal(otherPrincipal.runSeq, 2);
      assert.equal(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM conversation_commands
                WHERE idempotency_key = 'client-message-1'`,
            )
            .get() as { count: number }
        ).count,
        3,
      );
    } finally {
      db.close();
    }
  });

  it('rejects a changed digest only within the same idempotency tuple', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.acceptRunCommand(runInput(writerEpoch));
      assert.throws(
        () =>
          repository.acceptRunCommand(
            runInput(writerEpoch, {
              commandId: 'command-conflict',
              runId: 'run-conflict',
              requestDigest: 'different-digest',
            }),
          ),
        (error) => assertCode(error, 'IDEMPOTENCY_CONFLICT'),
      );

      repository.addParticipant({
        conversationId: 'conv-1',
        principalId: 'user-2',
        writerEpoch,
      });
      const independentPrincipal = repository.acceptRunCommand(
        runInput(writerEpoch, {
          commandId: 'command-2',
          runId: 'run-2',
          principalId: 'user-2',
          requestDigest: 'different-digest',
        }),
      );
      assert.equal(independentPrincipal.reused, false);
    } finally {
      db.close();
    }
  });

  it('fences stale epochs on repository commands and direct canonical writes', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.releaseWriter('conv-1', 'instance-1', writerEpoch);
      const currentEpoch = repository.acquireWriterEpoch('conv-1', 'instance-2');
      repository.markWriterRecovered('conv-1', 'instance-2', currentEpoch);

      assert.throws(
        () => repository.acceptRunCommand(runInput(writerEpoch)),
        (error) => assertCode(error, 'NOT_ACTIVE_WRITER'),
      );
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO conversation_runs
              (run_id, conversation_id, run_seq, client_msg_id, principal_id,
               requested_harness, status, writer_epoch)
             VALUES ('stale-run', 'conv-1', 1, 'stale-client', 'user-1',
                     'fake', 'accepted', ?)`,
          ).run(writerEpoch),
        /STALE_WRITER_EPOCH/,
      );
      assert.equal(currentEpoch, writerEpoch + 1);
    } finally {
      db.close();
    }
  });

  it('uses CAS for run transitions and rejects terminal resurrection', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.acceptRunCommand(runInput(writerEpoch));
      assert.throws(
        () =>
          repository.transitionRun({
            runId: 'run-1',
            conversationId: 'conv-1',
            expected: 'queued',
            next: 'running',
            writerEpoch,
          }),
        (error) => assertCode(error, 'RUN_TRANSITION_CAS_FAILED'),
      );
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
    } finally {
      db.close();
    }
  });

  it('rejects illegal attempt transitions before the CAS write', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.acceptRunCommand(runInput(writerEpoch));
      insertSegment(db);
      insertAttempt(db, writerEpoch);

      assert.throws(
        () =>
          repository.transitionAttempt({
            attemptId: 'attempt-1',
            conversationId: 'conv-1',
            expected: 'scheduled',
            next: 'recovering',
            writerEpoch,
          }),
        (error) => assertCode(error, 'INVALID_ATTEMPT_TRANSITION'),
      );
    } finally {
      db.close();
    }
  });

  it('rejects every adapter-supplied legal identity, actor, approval, or visibility field', () => {
    const base = {
      observationId: 'observation-1',
      attemptCorrelationToken: 'correlation-1',
      providerSequence: 1,
      kind: 'assistant_completed',
      payload: { text: 'safe provider payload' },
      observedAt: '2026-08-09T00:00:00.000Z',
    };
    const forgedFields: Readonly<Record<string, unknown>> = {
      conversationId: 'forged-conversation',
      runId: 'forged-run',
      attemptId: 'forged-attempt',
      segmentId: 'forged-segment',
      principalId: 'forged-principal',
      actorId: 'forged-actor',
      actorType: 'user',
      visibility: 'public',
      approval: { granted: true },
      writerEpoch: 999,
      credentialEpoch: 999,
      legalIdentity: { principalId: 'forged-principal' },
    };

    const acceptedForgeries = Object.entries(forgedFields)
      .filter(([field, value]) => isProviderObservation({ ...base, [field]: value }))
      .map(([field]) => field);
    assert.deepEqual(
      acceptedForgeries,
      [],
      `adapter legal fields crossed the observation boundary: ${acceptedForgeries.join(', ')}`,
    );
  });

  it('rejects watermark order violations, range leaps, and missing evidence', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.acceptRunCommand(runInput(writerEpoch));
      insertSegment(db);
      insertProjection(db, writerEpoch);

      assert.throws(
        () =>
          repository.advanceSegmentWatermarks({
            advanceIdPrefix: 'invalid-order',
            conversationId: 'conv-1',
            segmentId: 'segment-1',
            projectionId: 'projection-1',
            projectionDigest: 'projection-digest',
            expected: ZERO_MARKS,
            next: {
              projectedThrough: { runSeq: 1, eventSeq: 1 },
              submittedThrough: { runSeq: 1, eventSeq: 2 },
              confirmedThrough: { runSeq: 0, eventSeq: 0 },
            },
            submittedEvidenceDigest: 'transport-evidence',
            writerEpoch,
          }),
        (error) => assertCode(error, 'INVALID_WATERMARK_ORDER'),
      );

      assert.throws(
        () =>
          repository.advanceSegmentWatermarks({
            advanceIdPrefix: 'range-leap',
            conversationId: 'conv-1',
            segmentId: 'segment-1',
            projectionId: 'projection-1',
            projectionDigest: 'projection-digest',
            expected: ZERO_MARKS,
            next: {
              projectedThrough: { runSeq: 1, eventSeq: 2 },
              submittedThrough: { runSeq: 0, eventSeq: 0 },
              confirmedThrough: { runSeq: 0, eventSeq: 0 },
            },
            writerEpoch,
          }),
        (error) => assertCode(error, 'PROJECTION_RANGE_MISMATCH'),
      );

      assert.throws(
        () =>
          repository.advanceSegmentWatermarks({
            advanceIdPrefix: 'missing-submission-evidence',
            conversationId: 'conv-1',
            segmentId: 'segment-1',
            projectionId: 'projection-1',
            projectionDigest: 'projection-digest',
            expected: ZERO_MARKS,
            next: {
              projectedThrough: { runSeq: 1, eventSeq: 1 },
              submittedThrough: { runSeq: 1, eventSeq: 1 },
              confirmedThrough: { runSeq: 0, eventSeq: 0 },
            },
            writerEpoch,
          }),
        (error) => assertCode(error, 'SUBMISSION_EVIDENCE_REQUIRED'),
      );

      assert.throws(
        () =>
          repository.advanceSegmentWatermarks({
            advanceIdPrefix: 'missing-confirmation-evidence',
            conversationId: 'conv-1',
            segmentId: 'segment-1',
            projectionId: 'projection-1',
            projectionDigest: 'projection-digest',
            expected: ZERO_MARKS,
            next: {
              projectedThrough: { runSeq: 1, eventSeq: 1 },
              submittedThrough: { runSeq: 1, eventSeq: 1 },
              confirmedThrough: { runSeq: 1, eventSeq: 1 },
            },
            submittedEvidenceDigest: 'transport-evidence',
            writerEpoch,
          }),
        (error) => assertCode(error, 'CONFIRMATION_EVIDENCE_REQUIRED'),
      );
    } finally {
      db.close();
    }
  });

  it('rejects denied, invalidated, and digest-mismatched projections', () => {
    for (const scenario of ['denied', 'invalidated', 'digest'] as const) {
      const { db, repository, writerEpoch } = setup();
      try {
        repository.acceptRunCommand(runInput(writerEpoch));
        insertSegment(db);
        insertProjection(db, writerEpoch, {
          decision: scenario === 'denied' ? 'denied' : 'allowed',
          state:
            scenario === 'denied'
              ? 'denied'
              : scenario === 'invalidated'
                ? 'invalidated'
                : 'prepared',
        });
        assert.throws(
          () =>
            repository.advanceSegmentWatermarks({
              advanceIdPrefix: scenario,
              conversationId: 'conv-1',
              segmentId: 'segment-1',
              projectionId: 'projection-1',
              projectionDigest: scenario === 'digest' ? 'forged-digest' : 'projection-digest',
              expected: ZERO_MARKS,
              next: {
                projectedThrough: { runSeq: 1, eventSeq: 1 },
                submittedThrough: { runSeq: 0, eventSeq: 0 },
                confirmedThrough: { runSeq: 0, eventSeq: 0 },
              },
              writerEpoch,
            }),
          (error) =>
            assertCode(
              error,
              scenario === 'digest' ? 'PROJECTION_DIGEST_MISMATCH' : 'PROJECTION_NOT_AUTHORIZED',
            ),
        );
      } finally {
        db.close();
      }
    }
  });

  it('treats an exact source repeat as idempotent without adding a second observation', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      insertSegment(db);
      const first = repository.recordSourceObservation(sourceInput(writerEpoch));
      const duplicate = repository.recordSourceObservation(
        sourceInput(writerEpoch, { observationId: 'observation-duplicate' }),
      );

      assert.equal(first.status, 'accepted');
      assert.deepEqual(duplicate, {
        observationId: 'observation-1',
        classification: 'duplicate',
        status: 'idempotent',
        quarantined: false,
      });
      assert.equal(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM source_observations WHERE source_id = 'source-1'")
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(segmentState(db), 'active');
    } finally {
      db.close();
    }
  });

  it('quarantines rewritten source identities', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      insertSegment(db);
      repository.recordSourceObservation(sourceInput(writerEpoch));
      const result = repository.recordSourceObservation(
        sourceInput(writerEpoch, {
          observationId: 'observation-rewritten',
          rawDigest: 'rewritten-raw',
        }),
      );
      assert.equal(result.classification, 'rewritten');
      assert.equal(result.status, 'mutation');
      assert.equal(result.quarantined, true);
      assert.equal(segmentState(db), 'quarantined');
    } finally {
      db.close();
    }
  });

  it('quarantines source truncation', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      insertSegment(db);
      repository.recordSourceObservation(sourceInput(writerEpoch));
      const result = repository.recordSourceObservation(
        sourceInput(writerEpoch, {
          observationId: 'observation-truncated',
          sourceEventId: 'provider-event-2',
          sourceOrdinal: 2,
          observedExtent: 99,
          rawDigest: 'raw-2',
        }),
      );
      assert.equal(result.classification, 'truncated');
      assert.equal(result.quarantined, true);
      assert.equal(segmentState(db), 'quarantined');
    } finally {
      db.close();
    }
  });

  it('quarantines reordered source ordinals', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      insertSegment(db);
      repository.recordSourceObservation(sourceInput(writerEpoch));
      const result = repository.recordSourceObservation(
        sourceInput(writerEpoch, {
          observationId: 'observation-reordered',
          sourceEventId: 'provider-event-other',
          sourceOrdinal: 1,
          observedExtent: 101,
          rawDigest: 'raw-other',
        }),
      );
      assert.equal(result.classification, 'reordered');
      assert.equal(result.quarantined, true);
      assert.equal(segmentState(db), 'quarantined');
    } finally {
      db.close();
    }
  });

  it('quarantines a source ordinal gap as missing history', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      insertSegment(db);
      repository.recordSourceObservation(sourceInput(writerEpoch));
      const result = repository.recordSourceObservation(
        sourceInput(writerEpoch, {
          observationId: 'observation-gap',
          sourceEventId: 'provider-event-3',
          sourceOrdinal: 3,
          observedExtent: 120,
          rawDigest: 'raw-3',
        }),
      );
      assert.equal(result.classification, 'missing');
      assert.equal(result.quarantined, true);
      assert.equal(segmentState(db), 'quarantined');
    } finally {
      db.close();
    }
  });

  it('appends immutable high-water extent evidence before detecting a later truncation', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      insertSegment(db);
      repository.recordSourceObservation(sourceInput(writerEpoch));
      const extension = repository.recordSourceObservation(
        sourceInput(writerEpoch, {
          observationId: 'observation-extent-150',
          observedExtent: 150,
        }),
      );
      assert.equal(extension.classification, 'append_only');
      assert.equal(extension.status, 'accepted');
      assert.deepEqual(
        db.prepare(
          `SELECT observed_extent FROM source_observations
            WHERE source_event_id = 'provider-event-1' ORDER BY observed_extent`,
        ).all(),
        [{ observed_extent: 100 }, { observed_extent: 150 }],
      );
      const truncation = repository.recordSourceObservation(
        sourceInput(writerEpoch, {
          observationId: 'observation-after-extent-truncation',
          observedExtent: 120,
        }),
      );
      assert.equal(truncation.classification, 'truncated');
      assert.equal(segmentState(db), 'quarantined');
      assert.equal(
        (db.prepare(
          "SELECT observed_extent FROM source_observations WHERE observation_id = 'observation-1'",
        ).get() as { observed_extent: number }).observed_extent,
        100,
      );
    } finally {
      db.close();
    }
  });

  it('keeps a confirmed watermark no-op byte-for-byte stable', () => {
    const { db, repository, writerEpoch } = setup();
    try {
      repository.acceptRunCommand(runInput(writerEpoch));
      insertSegment(db);
      insertProjection(db, writerEpoch);
      const confirmed: ContextWatermarks = {
        projectedThrough: { runSeq: 1, eventSeq: 1 },
        submittedThrough: { runSeq: 1, eventSeq: 1 },
        confirmedThrough: { runSeq: 1, eventSeq: 1 },
      };
      repository.advanceSegmentWatermarks({
        advanceIdPrefix: 'initial-confirmation',
        conversationId: 'conv-1',
        segmentId: 'segment-1',
        projectionId: 'projection-1',
        projectionDigest: 'projection-digest',
        expected: ZERO_MARKS,
        next: confirmed,
        submittedEvidenceDigest: 'transport-evidence',
        confirmedEvidenceDigest: 'checkpoint-evidence',
        writerEpoch,
      });
      const before = db.prepare(
        `SELECT p.state, p.submitted_run_seq, p.confirmed_run_seq,
                a.checkpoint_evidence_digest,
                (SELECT COUNT(*) FROM context_watermark_advances) AS evidence_count
           FROM context_projections p JOIN conversation_attempts a
             ON a.attempt_id = p.attempt_id
          WHERE p.projection_id = 'projection-1'`,
      ).get();
      repository.advanceSegmentWatermarks({
        advanceIdPrefix: 'must-not-be-written',
        conversationId: 'conv-1',
        segmentId: 'segment-1',
        projectionId: 'projection-1',
        projectionDigest: 'projection-digest',
        expected: confirmed,
        next: confirmed,
        writerEpoch,
      });
      const after = db.prepare(
        `SELECT p.state, p.submitted_run_seq, p.confirmed_run_seq,
                a.checkpoint_evidence_digest,
                (SELECT COUNT(*) FROM context_watermark_advances) AS evidence_count
           FROM context_projections p JOIN conversation_attempts a
             ON a.attempt_id = p.attempt_id
          WHERE p.projection_id = 'projection-1'`,
      ).get();
      assert.deepEqual(after, before);
      assert.deepEqual(after, {
        state: 'confirmed',
        submitted_run_seq: 1,
        confirmed_run_seq: 1,
        checkpoint_evidence_digest: 'checkpoint-evidence',
        evidence_count: 3,
      });
    } finally {
      db.close();
    }
  });

  it('fails closed when any projection destination coordinate differs from the attempt', () => {
    for (const overrides of [
      { destinationAdapter: 'other-adapter' },
      { destinationRuntime: 'other-runtime' },
      { destinationModel: 'other-model' },
      { destinationEndpoint: 'other-endpoint' },
    ]) {
      const { db, repository, writerEpoch } = setup();
      try {
        repository.acceptRunCommand(runInput(writerEpoch));
        insertSegment(db);
        assert.throws(
          () => insertProjection(db, writerEpoch, overrides),
          /PROJECTION_DESTINATION_MISMATCH/,
        );
      } finally {
        db.close();
      }
    }
  });

  it('does not call the repository when the shadow flag is absent or explicitly disabled', () => {
    for (const env of [{}, { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '0' }]) {
      let calls = 0;
      const shadow = new ShadowConversationOrchestrator(
        {
          acceptRunCommand() {
            calls += 1;
            return { commandId: 'command', runId: 'run', runSeq: 1, reused: false };
          },
        },
        env,
      );
      assert.deepEqual(shadow.recordAcceptedRun(runInput(1)), {
        enabled: false,
        recorded: false,
      });
      assert.equal(calls, 0);
    }
  });
});

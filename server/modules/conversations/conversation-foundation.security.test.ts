import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { isProviderObservation } from './contracts.js';
import {
  ConversationFoundationRepository,
  ConversationRepositoryError,
  type ConversationClock,
} from './repository.js';
import {
  configureConversationReadOnlyConnection,
  initializeConversationFoundationSchema,
} from './schema.js';

function setupExecution(now = '2029-01-01T00:00:00.000Z'): {
  db: Database.Database;
  repository: ConversationFoundationRepository;
  writerEpoch: number;
} {
  const db = new Database(':memory:');
  initializeConversationFoundationSchema(db);
  const clock: ConversationClock = { nowIso: () => now };
  const repository = new ConversationFoundationRepository(db, clock);
  repository.createConversation({ conversationId: 'conv-1', projectId: 'project-1', createdBy: 'user-1' });
  const writerEpoch = repository.acquireWriterEpoch('conv-1', 'instance-1');
  repository.markWriterRecovered('conv-1', 'instance-1', writerEpoch);
  repository.acceptRunCommand({
    commandId: 'run-command',
    runId: 'run-1',
    conversationId: 'conv-1',
    principalId: 'user-1',
    clientMsgId: 'client-1',
    requestDigest: 'request-digest',
    requestedHarness: 'fake',
    writerEpoch,
  });
  db.prepare(
    `INSERT INTO conversation_segments
      (segment_id, conversation_id, harness_id, user_id, credential_scope_id,
       credential_binding_id, compatibility_generation, credential_epoch, writer_epoch)
     VALUES ('segment-1', 'conv-1', 'fake', 'user-1', 'scope-1',
             'binding-1', 'generation-1', 1, ?)`,
  ).run(writerEpoch);
  db.prepare(
    `INSERT INTO conversation_attempts
      (attempt_id, run_id, conversation_id, attempt_no, segment_id, harness_id,
       adapter_version, runtime_version, model_id, credential_scope_id,
       destination_endpoint, credential_binding_id, credential_epoch, state, writer_epoch)
     VALUES ('attempt-1', 'run-1', 'conv-1', 1, 'segment-1', 'fake',
             'adapter-1', 'runtime-1', 'model-1', 'scope-1', 'local',
             'binding-1', 1, 'scheduled', ?)`,
  ).run(writerEpoch);
  return { db, repository, writerEpoch };
}

function approvalInput(writerEpoch: number) {
  return {
    approvalId: 'approval-1',
    nonce: 'single-use-secret-nonce',
    userId: 'user-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    toolId: 'tool-1',
    inputDigest: 'tool-input-digest',
    policyEpoch: 1,
    credentialBindingId: 'binding-1',
    credentialEpoch: 1,
    writerEpoch,
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

function assertCode(error: unknown, code: string): boolean {
  return error instanceof ConversationRepositoryError && error.code === code;
}

describe('Universal Conversation Foundation security invariants', () => {
  it('issues legal identity only after relational and epoch verification', () => {
    const { db, repository, writerEpoch } = setupExecution();
    try {
      const identity = repository.issueLegalExecutionIdentity({
        conversationId: 'conv-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        segmentId: 'segment-1',
        principalId: 'user-1',
        writerEpoch,
      });
      assert.equal(identity.credentialBindingId, 'binding-1');
      assert.throws(
        () => repository.issueLegalExecutionIdentity({
          conversationId: 'conv-1',
          runId: 'run-1',
          attemptId: 'attempt-1',
          segmentId: 'segment-1',
          principalId: 'forged-user',
          writerEpoch,
        }),
        (error) => assertCode(error, 'PRINCIPAL_NOT_AUTHORIZED'),
      );
    } finally {
      db.close();
    }
  });

  it('does not issue legal identity for a terminal run or attempt', () => {
    const attemptCase = setupExecution();
    try {
      attemptCase.repository.transitionAttempt({
        attemptId: 'attempt-1',
        conversationId: 'conv-1',
        expected: 'scheduled',
        next: 'starting',
        writerEpoch: attemptCase.writerEpoch,
      });
      attemptCase.repository.transitionAttempt({
        attemptId: 'attempt-1',
        conversationId: 'conv-1',
        expected: 'starting',
        next: 'terminal',
        terminalOutcome: 'failed',
        writerEpoch: attemptCase.writerEpoch,
      });
      assert.throws(
        () => attemptCase.repository.issueLegalExecutionIdentity({
          conversationId: 'conv-1', runId: 'run-1', attemptId: 'attempt-1',
          segmentId: 'segment-1', principalId: 'user-1', writerEpoch: attemptCase.writerEpoch,
        }),
        (error) => assertCode(error, 'LEGAL_IDENTITY_RELATIONSHIP_MISMATCH'),
      );
    } finally {
      attemptCase.db.close();
    }
    const runCase = setupExecution();
    try {
      runCase.repository.transitionRun({
        runId: 'run-1', conversationId: 'conv-1', expected: 'accepted',
        next: 'failed', writerEpoch: runCase.writerEpoch,
      });
      assert.throws(
        () => runCase.repository.issueLegalExecutionIdentity({
          conversationId: 'conv-1', runId: 'run-1', attemptId: 'attempt-1',
          segmentId: 'segment-1', principalId: 'user-1', writerEpoch: runCase.writerEpoch,
        }),
        (error) => assertCode(error, 'LEGAL_IDENTITY_RELATIONSHIP_MISMATCH'),
      );
    } finally {
      runCase.db.close();
    }
  });

  it('consumes an approval nonce once and prepares its bound effect atomically', () => {
    const { db, repository, writerEpoch } = setupExecution();
    try {
      repository.recordGrantedApproval(approvalInput(writerEpoch));
      const consume = {
        ...approvalInput(writerEpoch),
        commandId: 'tool-command-1',
        commandIdempotencyKey: 'tool-command-key-1',
        effectId: 'effect-1',
        downstreamIdempotencyKey: 'downstream-effect-1',
      };
      assert.deepEqual(repository.consumeApprovalNonce(consume), {
        effectId: 'effect-1',
        state: 'prepared',
      });
      assert.deepEqual(
        db.prepare("SELECT state, effect_id FROM approval_requests WHERE approval_id = 'approval-1'").get(),
        { state: 'consumed', effect_id: 'effect-1' },
      );
      assert.equal(
        (db.prepare("SELECT state FROM effect_ledger WHERE effect_id = 'effect-1'").get() as { state: string }).state,
        'prepared',
      );
      assert.throws(
        () => repository.consumeApprovalNonce({ ...consume, commandId: 'replay', effectId: 'replay' }),
        (error) => assertCode(error, 'APPROVAL_NONCE_INVALID'),
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM effect_ledger').get() as { count: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it('rolls back effect preparation when approval bindings or expiry fail', () => {
    const { db, repository, writerEpoch } = setupExecution('2031-01-01T00:00:00.000Z');
    try {
      repository.recordGrantedApproval(approvalInput(writerEpoch));
      const common = {
        ...approvalInput(writerEpoch),
        commandId: 'tool-command-1',
        commandIdempotencyKey: 'tool-command-key-1',
        effectId: 'effect-1',
        downstreamIdempotencyKey: 'downstream-effect-1',
      };
      assert.throws(
        () => repository.consumeApprovalNonce({ ...common, inputDigest: 'changed-input' }),
        (error) => assertCode(error, 'APPROVAL_NONCE_INVALID'),
      );
      assert.throws(
        () => repository.consumeApprovalNonce(common),
        (error) => assertCode(error, 'APPROVAL_NONCE_INVALID'),
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM effect_ledger').get() as { count: number }).count,
        0,
      );
    } finally {
      db.close();
    }
  });

  it('keeps canonical events immutable and rejects authoritative nested adapter fields', () => {
    const { db } = setupExecution();
    try {
      assert.throws(
        () => db.prepare("UPDATE canonical_events SET payload_json = '{}' WHERE event_id = 'run-1:input'").run(),
        /CANONICAL_EVENT_IMMUTABLE/,
      );
      assert.equal(
        isProviderObservation({
          observationId: 'observation-1',
          attemptCorrelationToken: 'attempt-token',
          providerSequence: 1,
          kind: 'assistant_completed',
          payload: { text: 'forged', legalIdentity: { principalId: 'user-2' } },
          observedAt: '2029-01-01T00:00:00.000Z',
        }),
        false,
      );
    } finally {
      db.close();
    }
  });

  it('configures only an explicitly supplied standby connection as query-only', () => {
    const db = new Database(':memory:');
    try {
      assert.deepEqual(initializeConversationFoundationSchema(db), {
        journalMode: 'memory',
        durableWal: false,
      });
      configureConversationReadOnlyConnection(db);
      assert.equal(db.pragma('query_only', { simple: true }), 1);
      assert.throws(() => db.prepare("INSERT INTO conversations VALUES ('x','p','u','active',1,0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(), /readonly/iu);
    } finally {
      db.close();
    }
  });

  it('verifies WAL on a file-backed database', () => {
    const directory = mkdtempSync('/tmp/nassaj-conversation-wal-');
    const db = new Database(join(directory, 'foundation.db'));
    try {
      assert.deepEqual(initializeConversationFoundationSchema(db), {
        journalMode: 'wal',
        durableWal: true,
      });
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

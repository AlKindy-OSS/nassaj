import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type {
  AttemptId,
  CanonicalPosition,
  ContextWatermarks,
  ConversationId,
  CredentialBindingId,
  LegalExecutionIdentity,
  PrincipalId,
  RunId,
  RunStatus,
  SegmentId,
  WriterEpoch,
} from './contracts.js';

const TERMINAL_RUN_STATES = new Set<RunStatus>(['completed', 'failed', 'aborted', 'uncertain']);
const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  accepted: ['queued', 'failed', 'aborted', 'uncertain'],
  queued: ['running', 'failed', 'aborted', 'uncertain'],
  running: ['completed', 'failed', 'aborted', 'uncertain'],
  completed: [],
  failed: [],
  aborted: [],
  uncertain: [],
};
const ATTEMPT_TRANSITIONS = {
  scheduled: ['starting'],
  starting: ['running', 'terminal'],
  running: ['recovering', 'terminal'],
  recovering: ['running', 'terminal'],
} as const;

export class ConversationRepositoryError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ConversationRepositoryError';
  }
}

export interface AcceptedRunCommand {
  commandId: string;
  runId: string;
  runSeq: number;
  reused: boolean;
}

export interface AcceptRunCommandInput {
  commandId: string;
  runId: string;
  conversationId: string;
  principalId: string;
  clientMsgId: string;
  requestDigest: string;
  requestedHarness: string;
  requestedModel?: string | null;
  inputEventId?: string;
  inputPayload?: unknown;
  writerEpoch: number;
}

export interface SourceObservationInput {
  observationId: string;
  sourceId: string;
  segmentId: string;
  conversationId: string;
  sourceGeneration: number;
  sourceEventId: string;
  sourceOrdinal: number;
  observedExtent: number;
  rawDigest: string;
  adapterVersion: string;
  runtimeVersion: string;
  writerEpoch: number;
}

export interface SourceObservationResult {
  observationId: string;
  classification: 'initial' | 'append_only' | 'duplicate' | 'truncated' | 'rewritten' | 'reordered' | 'missing';
  status: 'accepted' | 'idempotent' | 'mutation';
  quarantined: boolean;
}

export interface GrantedApprovalInput {
  approvalId: string;
  nonce: string;
  userId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  toolId: string;
  inputDigest: string;
  policyEpoch: number;
  credentialBindingId: string;
  credentialEpoch: number;
  writerEpoch: number;
  expiresAt: string;
}

export interface ConsumeApprovalInput extends Omit<GrantedApprovalInput, 'approvalId' | 'expiresAt'> {
  commandId: string;
  commandIdempotencyKey: string;
  effectId: string;
  downstreamIdempotencyKey: string;
}

export interface ConversationClock {
  nowIso(): string;
}

const SYSTEM_CLOCK: ConversationClock = {
  nowIso: () => new Date().toISOString(),
};

type StoredCommand = {
  command_id: string;
  run_id: string | null;
  request_digest: string;
};

type StoredSourceKey = {
  source_event_id: string;
  source_ordinal: number;
  raw_digest: string;
  accepted_observation_id: string;
};

type StoredObservation = {
  observation_id: string;
  source_ordinal: number;
  observed_extent: number;
  prefix_chain_digest: string;
};

type SegmentMarksRow = {
  projected_run_seq: number;
  projected_event_seq: number;
  submitted_run_seq: number;
  submitted_event_seq: number;
  confirmed_run_seq: number;
  confirmed_event_seq: number;
};

type ProjectionRow = {
  decision: 'allowed' | 'denied';
  state: string;
  run_id: string;
  attempt_id: string;
  destination_harness: string;
  destination_adapter: string;
  destination_runtime: string;
  destination_account_scope: string;
  destination_model: string;
  destination_endpoint: string;
  credential_binding_id: string;
  credential_epoch: number;
  from_run_seq: number;
  from_event_seq: number;
  projected_run_seq: number;
  projected_event_seq: number;
  content_digest: string;
};

function position(runSeq: number, eventSeq: number): CanonicalPosition {
  return { runSeq, eventSeq };
}

function comparePosition(left: CanonicalPosition, right: CanonicalPosition): number {
  if (left.runSeq !== right.runSeq) return left.runSeq - right.runSeq;
  return left.eventSeq - right.eventSeq;
}

function assertValidWatermarks(marks: ContextWatermarks): void {
  const values = [
    marks.projectedThrough.runSeq,
    marks.projectedThrough.eventSeq,
    marks.submittedThrough.runSeq,
    marks.submittedThrough.eventSeq,
    marks.confirmedThrough.runSeq,
    marks.confirmedThrough.eventSeq,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ConversationRepositoryError('INVALID_WATERMARK');
  }
  if (
    comparePosition(marks.submittedThrough, marks.projectedThrough) > 0 ||
    comparePosition(marks.confirmedThrough, marks.submittedThrough) > 0
  ) {
    throw new ConversationRepositoryError('INVALID_WATERMARK_ORDER');
  }
}

function marksFromRow(row: SegmentMarksRow): ContextWatermarks {
  return {
    projectedThrough: position(row.projected_run_seq, row.projected_event_seq),
    submittedThrough: position(row.submitted_run_seq, row.submitted_event_seq),
    confirmedThrough: position(row.confirmed_run_seq, row.confirmed_event_seq),
  };
}

function watermarksEqual(left: ContextWatermarks, right: ContextWatermarks): boolean {
  return (
    comparePosition(left.projectedThrough, right.projectedThrough) === 0 &&
    comparePosition(left.submittedThrough, right.submittedThrough) === 0 &&
    comparePosition(left.confirmedThrough, right.confirmedThrough) === 0
  );
}

function hashChain(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

/** Minimal trusted repositories for the isolated Foundation schema. */
export class ConversationFoundationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: ConversationClock = SYSTEM_CLOCK,
  ) {}

  createConversation(input: {
    conversationId: string;
    projectId: string;
    createdBy: string;
    schemaVersion?: number;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversations
            (conversation_id, project_id, created_by, schema_version)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.conversationId, input.projectId, input.createdBy, input.schemaVersion ?? 1);
      this.db
        .prepare(
          `INSERT INTO conversation_participants (conversation_id, principal_id, role, writer_epoch)
           VALUES (?, ?, 'owner', 0)`,
        )
        .run(input.conversationId, input.createdBy);
    })();
  }

  addParticipant(input: {
    conversationId: string;
    principalId: string;
    role?: 'participant' | 'viewer';
    writerEpoch: number;
  }): void {
    this.assertActiveWriter(input.conversationId, input.writerEpoch);
    this.db
      .prepare(
        `INSERT INTO conversation_participants (conversation_id, principal_id, role, writer_epoch)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, principal_id) DO UPDATE SET
           role = excluded.role, state = 'active', writer_epoch = excluded.writer_epoch,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(input.conversationId, input.principalId, input.role ?? 'participant', input.writerEpoch);
  }

  acquireWriterEpoch(
    conversationId: string,
    instanceId: string,
    options: { allowCrashTakeover?: boolean } = {},
  ): number {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT owner_instance_id, state FROM conversation_writer_state WHERE conversation_id = ?')
        .get(conversationId) as { owner_instance_id: string | null; state: string } | undefined;
      if (
        existing
        && existing.state !== 'released'
        && existing.owner_instance_id !== instanceId
        && options.allowCrashTakeover !== true
      ) {
        throw new ConversationRepositoryError('WRITER_ALREADY_OWNED');
      }
      const row = this.db
        .prepare(
          `UPDATE conversations
              SET writer_epoch = writer_epoch + 1, updated_at = CURRENT_TIMESTAMP
            WHERE conversation_id = ?
        RETURNING writer_epoch`,
        )
        .get(conversationId) as { writer_epoch: number } | undefined;
      if (!row) throw new ConversationRepositoryError('CONVERSATION_NOT_FOUND');
      this.db
        .prepare(
          `INSERT INTO conversation_writer_state
            (conversation_id, owner_instance_id, writer_epoch, state, acquired_at, recovered_at)
           VALUES (?, ?, ?, 'recovering', CURRENT_TIMESTAMP, NULL)
           ON CONFLICT(conversation_id) DO UPDATE SET
             owner_instance_id = excluded.owner_instance_id,
             writer_epoch = excluded.writer_epoch,
             state = 'recovering',
             acquired_at = CURRENT_TIMESTAMP,
             recovered_at = NULL,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(conversationId, instanceId, row.writer_epoch);
      return row.writer_epoch;
    })();
  }

  markWriterRecovered(conversationId: string, instanceId: string, writerEpoch: number): void {
    const result = this.db
      .prepare(
        `UPDATE conversation_writer_state
            SET state = 'active', recovered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE conversation_id = ? AND owner_instance_id = ?
            AND writer_epoch = ? AND state = 'recovering'`,
      )
      .run(conversationId, instanceId, writerEpoch);
    if (result.changes !== 1) throw new ConversationRepositoryError('WRITER_RECOVERY_CAS_FAILED');
  }

  releaseWriter(conversationId: string, instanceId: string, writerEpoch: number): void {
    const result = this.db
      .prepare(
        `UPDATE conversation_writer_state
            SET state = 'released', owner_instance_id = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE conversation_id = ? AND owner_instance_id = ?
            AND writer_epoch = ? AND state IN ('recovering', 'active')`,
      )
      .run(conversationId, instanceId, writerEpoch);
    if (result.changes !== 1) throw new ConversationRepositoryError('WRITER_RELEASE_CAS_FAILED');
  }

  assertActiveWriter(conversationId: string, writerEpoch: number): void {
    const row = this.db
      .prepare(
        `SELECT 1
           FROM conversations c
           JOIN conversation_writer_state w USING (conversation_id)
          WHERE c.conversation_id = ? AND c.writer_epoch = ?
            AND w.writer_epoch = ? AND w.state = 'active'`,
      )
      .get(conversationId, writerEpoch, writerEpoch);
    if (!row) throw new ConversationRepositoryError('NOT_ACTIVE_WRITER');
  }

  acceptRunCommand(input: AcceptRunCommandInput): AcceptedRunCommand {
    return this.acceptRunCommandWithRelated(input, () => undefined);
  }

  /** Persists the accepted run and a caller-owned related row atomically. */
  acceptRunCommandWithRelated(
    input: AcceptRunCommandInput,
    persistRelated: (accepted: AcceptedRunCommand) => void,
  ): AcceptedRunCommand {
    return this.db.transaction(() => {
      this.assertActiveWriter(input.conversationId, input.writerEpoch);
      this.assertPrincipalAuthorized(input.conversationId, input.principalId, true);
      const existing = this.findCommand(input);
      if (existing) {
        const accepted = this.resolveExistingRunCommand(existing, input.requestDigest);
        persistRelated(accepted);
        return accepted;
      }
      const runSeq = this.allocateRunSeq(input.conversationId);
      this.insertAcceptedRun(input, runSeq);
      this.insertCanonicalUserEvent(input, runSeq);
      this.insertRunCommand(input);
      const accepted = { commandId: input.commandId, runId: input.runId, runSeq, reused: false };
      persistRelated(accepted);
      return accepted;
    })();
  }

  private findCommand(input: AcceptRunCommandInput): StoredCommand | undefined {
    return this.db
      .prepare(
        `SELECT command_id, run_id, request_digest
           FROM conversation_commands
          WHERE conversation_id = ? AND principal_id = ?
            AND operation = 'submit_run' AND idempotency_key = ?`,
      )
      .get(input.conversationId, input.principalId, input.clientMsgId) as StoredCommand | undefined;
  }

  private resolveExistingRunCommand(command: StoredCommand, digest: string): AcceptedRunCommand {
    if (command.request_digest !== digest) {
      throw new ConversationRepositoryError('IDEMPOTENCY_CONFLICT');
    }
    const run = this.db
      .prepare('SELECT run_seq FROM conversation_runs WHERE run_id = ?')
      .get(command.run_id) as { run_seq: number } | undefined;
    if (!run || !command.run_id) throw new ConversationRepositoryError('IDEMPOTENCY_RECORD_CORRUPT');
    return { commandId: command.command_id, runId: command.run_id, runSeq: run.run_seq, reused: true };
  }

  private allocateRunSeq(conversationId: string): number {
    const row = this.db
      .prepare(
        `UPDATE conversations
            SET next_run_seq = next_run_seq + 1, updated_at = CURRENT_TIMESTAMP
          WHERE conversation_id = ?
      RETURNING next_run_seq - 1 AS run_seq`,
      )
      .get(conversationId) as { run_seq: number } | undefined;
    if (!row) throw new ConversationRepositoryError('CONVERSATION_NOT_FOUND');
    return row.run_seq;
  }

  private insertAcceptedRun(input: AcceptRunCommandInput, runSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO conversation_runs
          (run_id, conversation_id, run_seq, client_msg_id, principal_id, input_event_id,
           requested_harness, requested_model, status, writer_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
      )
      .run(
        input.runId,
        input.conversationId,
        runSeq,
        input.clientMsgId,
        input.principalId,
        input.inputEventId ?? `${input.runId}:input`,
        input.requestedHarness,
        input.requestedModel ?? null,
        input.writerEpoch,
      );
  }

  private insertCanonicalUserEvent(input: AcceptRunCommandInput, runSeq: number): void {
    const payload = JSON.stringify(input.inputPayload ?? { unavailableInShadow: true });
    if (Buffer.byteLength(payload, 'utf8') > 1024 * 1024) {
      throw new ConversationRepositoryError('INPUT_EVENT_TOO_LARGE');
    }
    this.db
      .prepare(
        `INSERT INTO canonical_events
          (event_id, conversation_id, run_id, run_seq, event_seq, event_type,
           actor_type, actor_id, visibility, payload_json, payload_digest, writer_epoch)
         VALUES (?, ?, ?, ?, 1, 'message.user.accepted', 'user', ?,
                 'participant', ?, ?, ?)`,
      )
      .run(
        input.inputEventId ?? `${input.runId}:input`,
        input.conversationId,
        input.runId,
        runSeq,
        input.principalId,
        payload,
        input.requestDigest,
        input.writerEpoch,
      );
  }

  private insertRunCommand(input: AcceptRunCommandInput): void {
    this.db
      .prepare(
        `INSERT INTO conversation_commands
          (command_id, conversation_id, run_id, principal_id, operation,
           idempotency_key, request_digest, state, writer_epoch)
         VALUES (?, ?, ?, ?, 'submit_run', ?, ?, 'prepared', ?)`,
      )
      .run(
        input.commandId,
        input.conversationId,
        input.runId,
        input.principalId,
        input.clientMsgId,
        input.requestDigest,
        input.writerEpoch,
      );
  }

  transitionRun(input: {
    runId: string;
    conversationId: string;
    expected: RunStatus;
    next: RunStatus;
    writerEpoch: number;
  }): void {
    if (!RUN_TRANSITIONS[input.expected].includes(input.next)) {
      throw new ConversationRepositoryError('INVALID_RUN_TRANSITION');
    }
    this.assertActiveWriter(input.conversationId, input.writerEpoch);
    const outcome = TERMINAL_RUN_STATES.has(input.next) ? input.next : null;
    const result = this.db
      .prepare(
        `UPDATE conversation_runs
            SET status = ?, terminal_outcome = ?, writer_epoch = ?, updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ? AND conversation_id = ? AND status = ?`,
      )
      .run(input.next, outcome, input.writerEpoch, input.runId, input.conversationId, input.expected);
    if (result.changes !== 1) throw new ConversationRepositoryError('RUN_TRANSITION_CAS_FAILED');
  }

  transitionAttempt(input: {
    attemptId: string;
    conversationId: string;
    expected: 'scheduled' | 'starting' | 'running' | 'recovering';
    next: 'starting' | 'running' | 'recovering' | 'terminal';
    terminalOutcome?: 'completed' | 'failed' | 'aborted' | 'uncertain';
    writerEpoch: number;
  }): void {
    this.assertActiveWriter(input.conversationId, input.writerEpoch);
    if (!(ATTEMPT_TRANSITIONS[input.expected] as readonly string[]).includes(input.next)) {
      throw new ConversationRepositoryError('INVALID_ATTEMPT_TRANSITION');
    }
    if ((input.next === 'terminal') !== Boolean(input.terminalOutcome)) {
      throw new ConversationRepositoryError('INVALID_ATTEMPT_OUTCOME');
    }
    const result = this.db
      .prepare(
        `UPDATE conversation_attempts
            SET state = ?, terminal_outcome = ?, writer_epoch = ?, updated_at = CURRENT_TIMESTAMP
          WHERE attempt_id = ? AND conversation_id = ? AND state = ?`,
      )
      .run(
        input.next,
        input.terminalOutcome ?? null,
        input.writerEpoch,
        input.attemptId,
        input.conversationId,
        input.expected,
      );
    if (result.changes !== 1) throw new ConversationRepositoryError('ATTEMPT_TRANSITION_CAS_FAILED');
  }

  issueLegalExecutionIdentity(input: {
    conversationId: string;
    runId: string;
    attemptId: string;
    segmentId: string;
    principalId: string;
    writerEpoch: number;
  }): LegalExecutionIdentity {
    this.assertActiveWriter(input.conversationId, input.writerEpoch);
    this.assertPrincipalAuthorized(input.conversationId, input.principalId, true);
    const row = this.db
      .prepare(
        `SELECT a.credential_binding_id, a.credential_epoch
           FROM conversation_attempts a
           JOIN conversation_runs r
             ON r.run_id = a.run_id AND r.conversation_id = a.conversation_id
           JOIN conversation_segments s
             ON s.segment_id = a.segment_id AND s.conversation_id = a.conversation_id
          WHERE a.conversation_id = ? AND a.run_id = ? AND a.attempt_id = ?
            AND a.segment_id = ? AND r.principal_id = ? AND s.user_id = ?
            AND a.writer_epoch = ? AND s.writer_epoch = ? AND s.state = 'active'
            AND r.status IN ('accepted', 'queued', 'running')
            AND a.state IN ('scheduled', 'starting', 'running', 'recovering')
            AND a.credential_binding_id = s.credential_binding_id
            AND a.credential_epoch = s.credential_epoch`,
      )
      .get(
        input.conversationId,
        input.runId,
        input.attemptId,
        input.segmentId,
        input.principalId,
        input.principalId,
        input.writerEpoch,
        input.writerEpoch,
      ) as { credential_binding_id: string; credential_epoch: number } | undefined;
    if (!row) throw new ConversationRepositoryError('LEGAL_IDENTITY_RELATIONSHIP_MISMATCH');
    return Object.freeze({
      conversationId: input.conversationId as ConversationId,
      runId: input.runId as RunId,
      attemptId: input.attemptId as AttemptId,
      segmentId: input.segmentId as SegmentId,
      principalId: input.principalId as PrincipalId,
      writerEpoch: input.writerEpoch as WriterEpoch,
      credentialBindingId: row.credential_binding_id as CredentialBindingId,
      credentialEpoch: row.credential_epoch,
    }) as LegalExecutionIdentity;
  }

  private assertPrincipalAuthorized(
    conversationId: string,
    principalId: string,
    requireWrite: boolean,
  ): void {
    const row = this.db
      .prepare(
        `SELECT role FROM conversation_participants
          WHERE conversation_id = ? AND principal_id = ? AND state = 'active'`,
      )
      .get(conversationId, principalId) as { role: string } | undefined;
    if (!row || (requireWrite && row.role === 'viewer')) {
      throw new ConversationRepositoryError('PRINCIPAL_NOT_AUTHORIZED');
    }
  }

  recordGrantedApproval(input: GrantedApprovalInput): void {
    this.assertActiveWriter(input.conversationId, input.writerEpoch);
    this.assertPrincipalAuthorized(input.conversationId, input.userId, true);
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      throw new ConversationRepositoryError('INVALID_APPROVAL_EXPIRY');
    }
    this.db
      .prepare(
        `INSERT INTO approval_requests
          (approval_id, nonce_digest, user_id, conversation_id, run_id, attempt_id,
           tool_id, input_digest, policy_epoch, credential_binding_id,
           credential_epoch, writer_epoch, state, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'granted', ?)`,
      )
      .run(
        input.approvalId,
        hashChain(['approval-nonce-v1', input.nonce]),
        input.userId,
        input.conversationId,
        input.runId,
        input.attemptId,
        input.toolId,
        input.inputDigest,
        input.policyEpoch,
        input.credentialBindingId,
        input.credentialEpoch,
        input.writerEpoch,
        input.expiresAt,
      );
  }

  consumeApprovalNonce(input: ConsumeApprovalInput): { effectId: string; state: 'prepared' } {
    return this.db.transaction(() => {
      this.assertActiveWriter(input.conversationId, input.writerEpoch);
      this.assertPrincipalAuthorized(input.conversationId, input.userId, true);
      const now = this.clock.nowIso();
      if (!Number.isFinite(Date.parse(now))) throw new ConversationRepositoryError('INVALID_CLOCK');
      const approval = this.readConsumableApproval(input, now);
      if (!approval) throw new ConversationRepositoryError('APPROVAL_NONCE_INVALID');
      this.insertToolEffectCommand(input);
      this.insertPreparedEffect(input);
      const consumed = this.db
        .prepare(
          `UPDATE approval_requests
              SET state = 'consumed', consumed_at = ?, effect_id = ?,
                  writer_epoch = ?, updated_at = CURRENT_TIMESTAMP
            WHERE approval_id = ? AND state = 'granted' AND nonce_digest = ?
              AND julianday(expires_at) > julianday(?)`,
        )
        .run(
          now,
          input.effectId,
          input.writerEpoch,
          approval.approval_id,
          hashChain(['approval-nonce-v1', input.nonce]),
          now,
        );
      if (consumed.changes !== 1) throw new ConversationRepositoryError('APPROVAL_NONCE_RACE');
      return { effectId: input.effectId, state: 'prepared' as const };
    })();
  }

  private readConsumableApproval(
    input: ConsumeApprovalInput,
    now: string,
  ): { approval_id: string } | undefined {
    return this.db
      .prepare(
        `SELECT ar.approval_id
           FROM approval_requests ar
           JOIN conversation_attempts a
             ON a.attempt_id = ar.attempt_id AND a.conversation_id = ar.conversation_id
            AND a.run_id = ar.run_id
           JOIN conversation_segments s
             ON s.segment_id = a.segment_id AND s.conversation_id = a.conversation_id
          WHERE ar.nonce_digest = ? AND ar.state = 'granted'
            AND julianday(ar.expires_at) > julianday(?)
            AND ar.user_id = ? AND ar.conversation_id = ? AND ar.run_id = ?
            AND ar.attempt_id = ? AND ar.tool_id = ? AND ar.input_digest = ?
            AND ar.policy_epoch = ? AND ar.credential_binding_id = ?
            AND ar.credential_epoch = ? AND ar.writer_epoch = ?
            AND a.writer_epoch = ? AND a.credential_binding_id = ?
            AND a.credential_epoch = ? AND s.state = 'active'
            AND s.writer_epoch = ? AND s.credential_binding_id = ?
            AND s.credential_epoch = ?`,
      )
      .get(
        hashChain(['approval-nonce-v1', input.nonce]),
        now,
        input.userId,
        input.conversationId,
        input.runId,
        input.attemptId,
        input.toolId,
        input.inputDigest,
        input.policyEpoch,
        input.credentialBindingId,
        input.credentialEpoch,
        input.writerEpoch,
        input.writerEpoch,
        input.credentialBindingId,
        input.credentialEpoch,
        input.writerEpoch,
        input.credentialBindingId,
        input.credentialEpoch,
      ) as { approval_id: string } | undefined;
  }

  private insertToolEffectCommand(input: ConsumeApprovalInput): void {
    this.db
      .prepare(
        `INSERT INTO conversation_commands
          (command_id, conversation_id, run_id, principal_id, operation,
           idempotency_key, request_digest, state, writer_epoch,
           credential_binding_id, credential_epoch)
         VALUES (?, ?, ?, ?, 'tool_effect', ?, ?, 'prepared', ?, ?, ?)`,
      )
      .run(
        input.commandId,
        input.conversationId,
        input.runId,
        input.userId,
        input.commandIdempotencyKey,
        input.inputDigest,
        input.writerEpoch,
        input.credentialBindingId,
        input.credentialEpoch,
      );
  }

  private insertPreparedEffect(input: ConsumeApprovalInput): void {
    this.db
      .prepare(
        `INSERT INTO effect_ledger
          (effect_id, command_id, conversation_id, run_id, attempt_id, effect_kind,
           input_digest, state, downstream_idempotency_key, writer_epoch,
           credential_binding_id, credential_epoch)
         VALUES (?, ?, ?, ?, ?, 'tool', ?, 'prepared', ?, ?, ?, ?)`,
      )
      .run(
        input.effectId,
        input.commandId,
        input.conversationId,
        input.runId,
        input.attemptId,
        input.inputDigest,
        input.downstreamIdempotencyKey,
        input.writerEpoch,
        input.credentialBindingId,
        input.credentialEpoch,
      );
  }

  advanceSegmentWatermarks(input: {
    advanceIdPrefix: string;
    conversationId: string;
    segmentId: string;
    attemptId?: string;
    projectionId: string;
    projectionDigest: string;
    credentialBindingId?: string;
    credentialEpoch?: number;
    expected: ContextWatermarks;
    next: ContextWatermarks;
    submittedEvidenceDigest?: string;
    confirmedEvidenceDigest?: string;
    writerEpoch: number;
  }): void {
    assertValidWatermarks(input.next);
    this.db.transaction(() => {
      this.assertActiveWriter(input.conversationId, input.writerEpoch);
      const current = this.readSegmentMarks(input.segmentId, input.conversationId);
      if (!current || JSON.stringify(current) !== JSON.stringify(input.expected)) {
        throw new ConversationRepositoryError('WATERMARK_CAS_FAILED');
      }
      const projection = this.validateWatermarkAdvance(input, current);
      if (watermarksEqual(current, input.next)) return;
      this.updateSegmentMarks(input);
      this.updateProjectionAndAttempt(input, projection);
      this.recordWatermarkAdvances(input, current, projection);
    })();
  }

  private readSegmentMarks(segmentId: string, conversationId: string): ContextWatermarks | null {
    const row = this.db
      .prepare(
        `SELECT projected_run_seq, projected_event_seq, submitted_run_seq,
                submitted_event_seq, confirmed_run_seq, confirmed_event_seq
           FROM conversation_segments WHERE segment_id = ? AND conversation_id = ?`,
      )
      .get(segmentId, conversationId) as SegmentMarksRow | undefined;
    return row ? marksFromRow(row) : null;
  }

  private validateWatermarkAdvance(
    input: Parameters<ConversationFoundationRepository['advanceSegmentWatermarks']>[0],
    current: ContextWatermarks,
  ): ProjectionRow {
    for (const key of ['projectedThrough', 'submittedThrough', 'confirmedThrough'] as const) {
      if (comparePosition(input.next[key], current[key]) < 0) {
        throw new ConversationRepositoryError('WATERMARK_REGRESSION');
      }
    }
    const projection = this.db
      .prepare(
        `SELECT decision, state, run_id, attempt_id, destination_harness,
                destination_adapter, destination_runtime, destination_account_scope,
                destination_model, destination_endpoint,
                credential_binding_id, credential_epoch,
                from_run_seq, from_event_seq, projected_run_seq,
                projected_event_seq, content_digest
           FROM context_projections
          WHERE projection_id = ? AND segment_id = ? AND conversation_id = ?`,
      )
      .get(input.projectionId, input.segmentId, input.conversationId) as ProjectionRow | undefined;
    if (!projection || projection.decision !== 'allowed' || projection.state === 'invalidated') {
      throw new ConversationRepositoryError('PROJECTION_NOT_AUTHORIZED');
    }
    if (projection.content_digest !== input.projectionDigest) {
      throw new ConversationRepositoryError('PROJECTION_DIGEST_MISMATCH');
    }
    const segment = this.db
      .prepare(
        `SELECT harness_id, credential_scope_id, credential_binding_id, credential_epoch, state
           FROM conversation_segments WHERE segment_id = ? AND conversation_id = ?`,
      )
      .get(input.segmentId, input.conversationId) as
      | {
          harness_id: string;
          credential_scope_id: string;
          credential_binding_id: string;
          credential_epoch: number;
          state: string;
        }
      | undefined;
    if (!segment || segment.state !== 'active') {
      throw new ConversationRepositoryError('SEGMENT_NOT_ACTIVE');
    }
    const attempt = this.db
      .prepare(
        `SELECT adapter_version, runtime_version, model_id, destination_endpoint,
                credential_scope_id, credential_binding_id, credential_epoch
           FROM conversation_attempts
          WHERE attempt_id = ? AND conversation_id = ? AND run_id = ?
            AND segment_id = ? AND state != 'terminal'`,
      )
      .get(
        projection.attempt_id,
        input.conversationId,
        projection.run_id,
        input.segmentId,
      ) as
      | {
          adapter_version: string;
          runtime_version: string;
          model_id: string;
          destination_endpoint: string;
          credential_scope_id: string;
          credential_binding_id: string;
          credential_epoch: number;
        }
      | undefined;
    if (
      !attempt ||
      (input.attemptId !== undefined && projection.attempt_id !== input.attemptId) ||
      projection.destination_harness !== segment.harness_id ||
      projection.destination_adapter !== attempt.adapter_version ||
      projection.destination_runtime !== attempt.runtime_version ||
      projection.destination_account_scope !== segment.credential_scope_id ||
      projection.destination_account_scope !== attempt.credential_scope_id ||
      projection.destination_model !== attempt.model_id ||
      projection.destination_endpoint !== attempt.destination_endpoint ||
      projection.credential_binding_id !== segment.credential_binding_id ||
      projection.credential_binding_id !== attempt.credential_binding_id ||
      projection.credential_epoch !== segment.credential_epoch ||
      projection.credential_epoch !== attempt.credential_epoch ||
      (input.credentialBindingId !== undefined &&
        input.credentialBindingId !== segment.credential_binding_id) ||
      (input.credentialEpoch !== undefined && input.credentialEpoch !== segment.credential_epoch)
    ) {
      throw new ConversationRepositoryError('PROJECTION_DESTINATION_MISMATCH');
    }
    const noOp = watermarksEqual(current, input.next);
    if (
      (!noOp &&
        comparePosition(
          position(projection.from_run_seq, projection.from_event_seq),
          current.confirmedThrough,
        ) !== 0) ||
      comparePosition(
        position(projection.projected_run_seq, projection.projected_event_seq),
        input.next.projectedThrough,
      ) !== 0
    ) {
      throw new ConversationRepositoryError('PROJECTION_RANGE_MISMATCH');
    }
    if (
      comparePosition(input.next.submittedThrough, current.submittedThrough) > 0 &&
      !input.submittedEvidenceDigest
    ) {
      throw new ConversationRepositoryError('SUBMISSION_EVIDENCE_REQUIRED');
    }
    if (
      comparePosition(input.next.confirmedThrough, current.confirmedThrough) > 0 &&
      !input.confirmedEvidenceDigest
    ) {
      throw new ConversationRepositoryError('CONFIRMATION_EVIDENCE_REQUIRED');
    }
    return projection;
  }

  private updateSegmentMarks(
    input: Parameters<ConversationFoundationRepository['advanceSegmentWatermarks']>[0],
  ): void {
    const result = this.db
      .prepare(
        `UPDATE conversation_segments
            SET projected_run_seq = ?, projected_event_seq = ?,
                submitted_run_seq = ?, submitted_event_seq = ?,
                confirmed_run_seq = ?, confirmed_event_seq = ?, writer_epoch = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE segment_id = ? AND conversation_id = ?
            AND projected_run_seq = ? AND projected_event_seq = ?
            AND submitted_run_seq = ? AND submitted_event_seq = ?
            AND confirmed_run_seq = ? AND confirmed_event_seq = ?`,
      )
      .run(
        input.next.projectedThrough.runSeq,
        input.next.projectedThrough.eventSeq,
        input.next.submittedThrough.runSeq,
        input.next.submittedThrough.eventSeq,
        input.next.confirmedThrough.runSeq,
        input.next.confirmedThrough.eventSeq,
        input.writerEpoch,
        input.segmentId,
        input.conversationId,
        input.expected.projectedThrough.runSeq,
        input.expected.projectedThrough.eventSeq,
        input.expected.submittedThrough.runSeq,
        input.expected.submittedThrough.eventSeq,
        input.expected.confirmedThrough.runSeq,
        input.expected.confirmedThrough.eventSeq,
      );
    if (result.changes !== 1) throw new ConversationRepositoryError('WATERMARK_CAS_FAILED');
  }

  private updateProjectionAndAttempt(
    input: Parameters<ConversationFoundationRepository['advanceSegmentWatermarks']>[0],
    projection: ProjectionRow,
  ): void {
    const submittedAdvanced = comparePosition(input.next.submittedThrough, input.expected.submittedThrough) > 0;
    const confirmedAdvanced = comparePosition(input.next.confirmedThrough, input.expected.confirmedThrough) > 0;
    const origin = position(0, 0);
    const state =
      comparePosition(input.next.confirmedThrough, origin) > 0
        ? 'confirmed'
        : comparePosition(input.next.submittedThrough, origin) > 0
          ? 'submitted'
          : 'prepared';
    const projectionResult = this.db
      .prepare(
        `UPDATE context_projections SET
           submitted_run_seq = CASE WHEN ? THEN ? ELSE submitted_run_seq END,
           submitted_event_seq = CASE WHEN ? THEN ? ELSE submitted_event_seq END,
           confirmed_run_seq = CASE WHEN ? THEN ? ELSE confirmed_run_seq END,
           confirmed_event_seq = CASE WHEN ? THEN ? ELSE confirmed_event_seq END,
           state = ?, writer_epoch = ?, updated_at = CURRENT_TIMESTAMP
         WHERE projection_id = ? AND conversation_id = ? AND segment_id = ?
           AND attempt_id = ? AND content_digest = ? AND decision = 'allowed'
           AND state != 'invalidated'`,
      )
      .run(
        Number(submittedAdvanced),
        input.next.submittedThrough.runSeq,
        Number(submittedAdvanced),
        input.next.submittedThrough.eventSeq,
        Number(confirmedAdvanced),
        input.next.confirmedThrough.runSeq,
        Number(confirmedAdvanced),
        input.next.confirmedThrough.eventSeq,
        state,
        input.writerEpoch,
        input.projectionId,
        input.conversationId,
        input.segmentId,
        projection.attempt_id,
        input.projectionDigest,
      );
    if (projectionResult.changes !== 1) throw new ConversationRepositoryError('PROJECTION_UPDATE_CAS_FAILED');
    const attemptResult = this.db
      .prepare(
        `UPDATE conversation_attempts SET
           projected_run_seq = ?, projected_event_seq = ?,
           submitted_run_seq = ?, submitted_event_seq = ?,
           confirmed_run_seq = ?, confirmed_event_seq = ?,
           projection_digest = ?,
           checkpoint_evidence_digest = CASE WHEN ? THEN ? ELSE checkpoint_evidence_digest END,
           writer_epoch = ?, updated_at = CURRENT_TIMESTAMP
         WHERE attempt_id = ? AND conversation_id = ? AND segment_id = ?
           AND credential_binding_id = ? AND credential_epoch = ?
           AND state != 'terminal'`,
      )
      .run(
        input.next.projectedThrough.runSeq,
        input.next.projectedThrough.eventSeq,
        input.next.submittedThrough.runSeq,
        input.next.submittedThrough.eventSeq,
        input.next.confirmedThrough.runSeq,
        input.next.confirmedThrough.eventSeq,
        input.projectionDigest,
        Number(confirmedAdvanced),
        input.confirmedEvidenceDigest ?? null,
        input.writerEpoch,
        projection.attempt_id,
        input.conversationId,
        input.segmentId,
        projection.credential_binding_id,
        projection.credential_epoch,
      );
    if (attemptResult.changes !== 1) throw new ConversationRepositoryError('ATTEMPT_EVIDENCE_MISMATCH');
  }

  private recordWatermarkAdvances(
    input: Parameters<ConversationFoundationRepository['advanceSegmentWatermarks']>[0],
    current: ContextWatermarks,
    projection: ProjectionRow,
  ): void {
    const changes = [
      ['projected', current.projectedThrough, input.next.projectedThrough, input.projectionDigest],
      ['submitted', current.submittedThrough, input.next.submittedThrough, input.submittedEvidenceDigest],
      ['confirmed', current.confirmedThrough, input.next.confirmedThrough, input.confirmedEvidenceDigest],
    ] as const;
    const statement = this.db.prepare(
      `INSERT INTO context_watermark_advances
        (advance_id, segment_id, conversation_id, projection_id, attempt_id, mark,
         through_run_seq, through_event_seq, projection_digest, evidence_digest, writer_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [mark, previous, next, evidence] of changes) {
      if (comparePosition(next, previous) === 0) continue;
      statement.run(
        `${input.advanceIdPrefix}:${mark}`,
        input.segmentId,
        input.conversationId,
        input.projectionId,
        projection.attempt_id,
        mark,
        next.runSeq,
        next.eventSeq,
        input.projectionDigest,
        evidence ?? input.projectionDigest,
        input.writerEpoch,
      );
    }
  }

  recordSourceObservation(input: SourceObservationInput): SourceObservationResult {
    return this.db.transaction(() => {
      this.assertActiveWriter(input.conversationId, input.writerEpoch);
      const exact = this.findSourceKey(input);
      const previous = this.findLastAcceptedObservation(input);
      const highWater = this.findSourceHighWater(input);
      if (exact?.raw_digest === input.rawDigest) {
        const accepted = this.findAcceptedObservation(exact.accepted_observation_id, input);
        if (!accepted) throw new ConversationRepositoryError('SOURCE_KEY_CORRUPT');
        if (input.sourceOrdinal !== exact.source_ordinal) {
          return this.recordSourceMutation(input, 'reordered', previous);
        }
        if (input.observedExtent < highWater.observed_extent || input.observedExtent < accepted.observed_extent) {
          return this.recordSourceMutation(input, 'truncated', highWater);
        }
        if (input.observedExtent > highWater.observed_extent) {
          return this.recordSourceExtentAdvance(input, highWater);
        }
        return this.sourceResult(exact.accepted_observation_id, 'duplicate', 'idempotent', false);
      }
      if (exact) return this.recordSourceMutation(input, 'rewritten', highWater);
      const ordinal = this.findSourceOrdinal(input);
      if (ordinal) return this.recordSourceMutation(input, 'reordered', highWater);
      const mutation = this.classifySourceMutation(input, previous, highWater);
      if (mutation) return this.recordSourceMutation(input, mutation, highWater);
      return this.recordAcceptedSourceObservation(input, previous);
    })();
  }

  private findSourceKey(input: SourceObservationInput): StoredSourceKey | undefined {
    return this.db
      .prepare(
        `SELECT source_event_id, source_ordinal, raw_digest, accepted_observation_id
           FROM source_event_keys
          WHERE conversation_id = ? AND segment_id = ? AND source_id = ?
            AND source_generation = ? AND source_event_id = ?`,
      )
      .get(
        input.conversationId,
        input.segmentId,
        input.sourceId,
        input.sourceGeneration,
        input.sourceEventId,
      ) as StoredSourceKey | undefined;
  }

  private findSourceOrdinal(input: SourceObservationInput): StoredSourceKey | undefined {
    return this.db
      .prepare(
        `SELECT source_event_id, source_ordinal, raw_digest, accepted_observation_id
           FROM source_event_keys
          WHERE conversation_id = ? AND segment_id = ? AND source_id = ?
            AND source_generation = ? AND source_ordinal = ?`,
      )
      .get(
        input.conversationId,
        input.segmentId,
        input.sourceId,
        input.sourceGeneration,
        input.sourceOrdinal,
      ) as StoredSourceKey | undefined;
  }

  private findLastAcceptedObservation(input: SourceObservationInput): StoredObservation | undefined {
    return this.db
      .prepare(
        `SELECT o.observation_id, o.source_ordinal, o.observed_extent, o.prefix_chain_digest
           FROM source_observations o
          WHERE o.conversation_id = ? AND o.segment_id = ? AND o.source_id = ?
            AND o.source_generation = ? AND o.status = 'accepted'
          ORDER BY o.source_ordinal DESC, o.observed_extent DESC LIMIT 1`,
      )
      .get(input.conversationId, input.segmentId, input.sourceId, input.sourceGeneration) as
      | StoredObservation
      | undefined;
  }

  private findSourceHighWater(input: SourceObservationInput): StoredObservation {
    const result = this.db
      .prepare(
        `SELECT observation_id, source_ordinal, observed_extent, prefix_chain_digest
           FROM source_observations
          WHERE conversation_id = ? AND segment_id = ? AND source_id = ?
            AND source_generation = ? AND status = 'accepted'
          ORDER BY observed_extent DESC, source_ordinal DESC LIMIT 1`,
      )
      .get(input.conversationId, input.segmentId, input.sourceId, input.sourceGeneration) as
      | StoredObservation
      | undefined;
    return result ?? {
      observation_id: 'GENESIS',
      source_ordinal: 0,
      observed_extent: 0,
      prefix_chain_digest: 'GENESIS',
    };
  }

  private findAcceptedObservation(
    observationId: string,
    input: SourceObservationInput,
  ): StoredObservation | undefined {
    return this.db
      .prepare(
        `SELECT observation_id, source_ordinal, observed_extent, prefix_chain_digest
           FROM source_observations
          WHERE observation_id = ? AND conversation_id = ? AND segment_id = ?
            AND source_id = ? AND source_generation = ? AND status = 'accepted'`,
      )
      .get(
        observationId,
        input.conversationId,
        input.segmentId,
        input.sourceId,
        input.sourceGeneration,
      ) as StoredObservation | undefined;
  }

  private classifySourceMutation(
    input: SourceObservationInput,
    previous: StoredObservation | undefined,
    highWater: StoredObservation,
  ): 'truncated' | 'reordered' | 'missing' | null {
    if (!previous) return input.sourceOrdinal === 1 ? null : 'missing';
    if (input.observedExtent < highWater.observed_extent) return 'truncated';
    if (input.sourceOrdinal <= previous.source_ordinal) return 'reordered';
    if (input.sourceOrdinal !== previous.source_ordinal + 1) return 'missing';
    return null;
  }

  private recordSourceExtentAdvance(
    input: SourceObservationInput,
    highWater: StoredObservation,
  ): SourceObservationResult {
    const chain = hashChain([
      highWater.prefix_chain_digest,
      input.sourceId,
      input.sourceGeneration,
      input.sourceOrdinal,
      input.rawDigest,
      input.observedExtent,
    ]);
    this.insertSourceObservation(input, 'append_only', 'accepted', chain, highWater.observation_id);
    return this.sourceResult(input.observationId, 'append_only', 'accepted', false);
  }

  private recordAcceptedSourceObservation(
    input: SourceObservationInput,
    previous: StoredObservation | undefined,
  ): SourceObservationResult {
    const classification = previous ? 'append_only' : 'initial';
    const chain = hashChain([
      previous?.prefix_chain_digest ?? 'GENESIS',
      input.sourceId,
      input.sourceGeneration,
      input.sourceOrdinal,
      input.rawDigest,
    ]);
    this.insertSourceObservation(input, classification, 'accepted', chain, previous?.observation_id ?? null);
    this.db
      .prepare(
        `INSERT INTO source_event_keys
          (conversation_id, segment_id, source_id, source_generation, source_event_id,
           source_ordinal, raw_digest, accepted_observation_id, writer_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.segmentId,
        input.sourceId,
        input.sourceGeneration,
        input.sourceEventId,
        input.sourceOrdinal,
        input.rawDigest,
        input.observationId,
        input.writerEpoch,
      );
    return this.sourceResult(input.observationId, classification, 'accepted', false);
  }

  private recordSourceMutation(
    input: SourceObservationInput,
    classification: 'truncated' | 'rewritten' | 'reordered' | 'missing',
    previous?: StoredObservation,
  ): SourceObservationResult {
    const chain = hashChain([
      previous?.prefix_chain_digest ?? 'MUTATION',
      input.sourceId,
      input.sourceGeneration,
      input.sourceOrdinal,
      input.rawDigest,
      classification,
    ]);
    this.insertSourceObservation(input, classification, 'mutation', chain, previous?.observation_id ?? null);
    this.db
      .prepare(
        `UPDATE conversation_segments
            SET state = 'quarantined', writer_epoch = ?, updated_at = CURRENT_TIMESTAMP
          WHERE segment_id = ? AND conversation_id = ?`,
      )
      .run(input.writerEpoch, input.segmentId, input.conversationId);
    return this.sourceResult(input.observationId, classification, 'mutation', true);
  }

  private insertSourceObservation(
    input: SourceObservationInput,
    classification: SourceObservationResult['classification'],
    status: SourceObservationResult['status'],
    prefixChainDigest: string,
    predecessorId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO source_observations
          (observation_id, source_id, segment_id, conversation_id, source_generation,
           source_event_id, source_ordinal, observed_extent, raw_digest,
           prefix_chain_digest, predecessor_id, classification, status,
           adapter_version, runtime_version, writer_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.observationId,
        input.sourceId,
        input.segmentId,
        input.conversationId,
        input.sourceGeneration,
        input.sourceEventId,
        input.sourceOrdinal,
        input.observedExtent,
        input.rawDigest,
        prefixChainDigest,
        predecessorId,
        classification,
        status,
        input.adapterVersion,
        input.runtimeVersion,
        input.writerEpoch,
      );
  }

  private sourceResult(
    observationId: string,
    classification: SourceObservationResult['classification'],
    status: SourceObservationResult['status'],
    quarantined: boolean,
  ): SourceObservationResult {
    return { observationId, classification, status, quarantined };
  }
}

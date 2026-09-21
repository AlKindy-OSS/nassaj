import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';
import {
  assertRunTransition,
  assertTurnTransition,
  classifyDuplicateRun,
} from '@/modules/turn-supervisor/state-machine.js';
import type {
  AdoptIngressInput,
  ClaimTurnInput,
  ClaimTurnResult,
  FinishExecutionInput,
  RunRecord,
  StartExecutionInput,
  TransitionRunInput,
  TransitionTurnInput,
  TurnRecord,
  TurnWithRun,
} from '@/modules/turn-supervisor/types.js';

import { HOSTED_RESULT_SCHEMA_SQL } from './hosted-result-store.js';

type TurnDbRow = {
  turn_id: string;
  user_id: number;
  client_msg_id: string;
  request_fingerprint: string;
  session_id: string | null;
  state: TurnRecord['state'];
  epoch: number;
  terminal_outcome: TurnRecord['terminalOutcome'];
  created_at: string;
  updated_at: string;
};

type RunDbRow = {
  run_id: string;
  turn_id: string;
  attempt: number;
  state: RunRecord['state'];
  epoch: number;
  terminal_outcome: RunRecord['terminalOutcome'];
  created_at: string;
  updated_at: string;
};

export class TurnSupervisorRepositoryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CAS_FAILED' | 'INGRESS_NOT_FOUND') {
    super(code);
    this.name = 'TurnSupervisorRepositoryError';
  }
}

function toTurn(row: TurnDbRow): TurnRecord {
  return {
    turnId: row.turn_id,
    userId: row.user_id,
    clientMsgId: row.client_msg_id,
    requestFingerprint: row.request_fingerprint,
    sessionId: row.session_id,
    state: row.state,
    epoch: row.epoch,
    terminalOutcome: row.terminal_outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunDbRow): RunRecord {
  return {
    runId: row.run_id,
    turnId: row.turn_id,
    attempt: row.attempt,
    state: row.state,
    epoch: row.epoch,
    terminalOutcome: row.terminal_outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readTurn(db: Database, turnId: string): TurnRecord {
  const row = db.prepare('SELECT * FROM turn_supervisor_turns WHERE turn_id = ?').get(turnId) as
    | TurnDbRow
    | undefined;
  if (!row) throw new TurnSupervisorRepositoryError('NOT_FOUND');
  return toTurn(row);
}

function readLatestRun(db: Database, turnId: string): RunRecord {
  const row = db.prepare(
    `SELECT * FROM turn_supervisor_runs
     WHERE turn_id = ? ORDER BY attempt DESC LIMIT 1`,
  ).get(turnId) as RunDbRow | undefined;
  if (!row) throw new TurnSupervisorRepositoryError('NOT_FOUND');
  return toRun(row);
}

function validateClaim(input: ClaimTurnInput): void {
  if (
    !Number.isInteger(input.userId)
    || input.userId <= 0
    || !input.clientMsgId.trim()
    || !input.requestFingerprint.trim()
  ) {
    throw new TurnSupervisorRepositoryError('INVALID_INPUT');
  }
}

export function createTurnSupervisorRepository(options: {
  getDatabase?: () => Database;
  generateId?: () => string;
  now?: () => string;
} = {}) {
  const getDatabase = options.getDatabase ?? getConnection;
  const generateId = options.generateId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const claimInDatabase = (db: Database, input: ClaimTurnInput): ClaimTurnResult => {
    validateClaim(input);
    const stamp = now();
    const turnId = generateId();
    const runId = generateId();
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO turn_supervisor_turns
        (turn_id, user_id, client_msg_id, request_fingerprint, session_id,
         state, epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'accepted', 0, ?, ?)`,
    ).run(
      turnId,
      input.userId,
      input.clientMsgId,
      input.requestFingerprint,
      input.sessionId ?? null,
      stamp,
      stamp,
    );
    if (inserted.changes === 1) {
      db.prepare(
        `INSERT INTO turn_supervisor_runs
          (run_id, turn_id, attempt, state, epoch, created_at, updated_at)
         VALUES (?, ?, 1, 'claimed', 0, ?, ?)`,
      ).run(runId, turnId, stamp, stamp);
      return {
        action: 'dispatch',
        turn: readTurn(db, turnId),
        run: readLatestRun(db, turnId),
      };
    }

    const existing = db.prepare(
      `SELECT * FROM turn_supervisor_turns
       WHERE user_id = ? AND client_msg_id = ?`,
    ).get(input.userId, input.clientMsgId) as TurnDbRow | undefined;
    // INSERT OR IGNORE can only lose here to the scoped unique key (UUID
    // collision is vanishingly unlikely and still fails closed as NOT_FOUND).
    if (!existing) throw new TurnSupervisorRepositoryError('NOT_FOUND');
    const turn = toTurn(existing);
    if (turn.requestFingerprint !== input.requestFingerprint) {
      return { action: 'fingerprint_mismatch', turn };
    }
    const run = readLatestRun(db, turn.turnId);
    return { action: classifyDuplicateRun(run.state), turn, run };
  };

  return {
    /** Atomically allocates turnId/runId/attempt=1 or classifies a duplicate. */
    claim(input: ClaimTurnInput): ClaimTurnResult {
      const db = getDatabase();
      return db.transaction(() => claimInDatabase(db, input))();
    },

    /**
     * Temporary T-1453 bridge. It adopts immutable metadata already stored in
     * message_coordination_ingress without changing the legacy row or dispatch
     * behaviour. Removal is safe once every harness claims through supervisor.
     */
    adoptMessageCoordinationIngress(input: AdoptIngressInput): ClaimTurnResult {
      if (!Number.isInteger(input.userId) || input.userId <= 0 || !input.clientMsgId.trim()) {
        throw new TurnSupervisorRepositoryError('INVALID_INPUT');
      }
      const db = getDatabase();
      return db.transaction(() => {
        const ingress = db.prepare(
          `SELECT request_fingerprint AS requestFingerprint, session_id AS sessionId
           FROM message_coordination_ingress
           WHERE user_id = ? AND client_msg_id = ?`,
        ).get(input.userId, input.clientMsgId) as {
          requestFingerprint: string;
          sessionId: string | null;
        } | undefined;
        if (!ingress) throw new TurnSupervisorRepositoryError('INGRESS_NOT_FOUND');
        return claimInDatabase(db, {
          userId: input.userId,
          clientMsgId: input.clientMsgId,
          requestFingerprint: ingress.requestFingerprint,
          sessionId: ingress.sessionId,
        });
      })();
    },

    get(turnId: string): TurnWithRun | null {
      const db = getDatabase();
      const row = db.prepare('SELECT * FROM turn_supervisor_turns WHERE turn_id = ?').get(turnId) as
        | TurnDbRow
        | undefined;
      if (!row) return null;
      const turn = toTurn(row);
      return { turn, run: readLatestRun(db, turn.turnId) };
    },

    /**
     * Cross-aggregate execution boundary. Either both records become running,
     * or neither changes; no crash/fault may strand a dispatching-only run.
     */
    startExecution(input: StartExecutionInput): TurnWithRun {
      const db = getDatabase();
      return db.transaction(() => {
        const stamp = now();
        const runChanged = db.prepare(
          `UPDATE turn_supervisor_runs
           SET state = 'running', epoch = epoch + 1, updated_at = ?
           WHERE run_id = ? AND turn_id = ? AND state = 'claimed' AND epoch = ?`,
        ).run(stamp, input.runId, input.turnId, input.expectedRunEpoch).changes;
        if (runChanged !== 1) throw new TurnSupervisorRepositoryError('CAS_FAILED');
        const turnChanged = db.prepare(
          `UPDATE turn_supervisor_turns
           SET state = 'running', epoch = epoch + 1, updated_at = ?
           WHERE turn_id = ? AND state = 'accepted' AND epoch = ?`,
        ).run(stamp, input.turnId, input.expectedTurnEpoch).changes;
        if (turnChanged !== 1) throw new TurnSupervisorRepositoryError('CAS_FAILED');
        return { turn: readTurn(db, input.turnId), run: readLatestRun(db, input.turnId) };
      }).immediate();
    },

    /** Atomic terminalization prevents a terminal run with a running turn. */
    finishExecution(input: FinishExecutionInput): TurnWithRun {
      const db = getDatabase();
      return db.transaction(() => {
        const stamp = now();
        if (input.cancellationEpoch !== undefined && input.terminalOutcome !== 'cancelled') {
          const cancellationChanged = db.prepare(
            `UPDATE turn_cancellation_runs SET state = 'completed', epoch = epoch + 1
             WHERE run_id = ? AND state = 'active' AND epoch = ?`,
          ).run(input.runId, input.cancellationEpoch).changes;
          if (cancellationChanged !== 1) throw new TurnSupervisorRepositoryError('CAS_FAILED');
        }
        const runChanged = db.prepare(
          `UPDATE turn_supervisor_runs
           SET state = 'terminal', terminal_outcome = ?, epoch = epoch + 1, updated_at = ?
           WHERE run_id = ? AND turn_id = ? AND state = 'running' AND epoch = ?`,
        ).run(input.terminalOutcome, stamp, input.runId, input.turnId, input.expectedRunEpoch).changes;
        if (runChanged !== 1) throw new TurnSupervisorRepositoryError('CAS_FAILED');
        const turnChanged = db.prepare(
          `UPDATE turn_supervisor_turns
           SET state = 'terminal', terminal_outcome = ?, epoch = epoch + 1, updated_at = ?
           WHERE turn_id = ? AND state = 'running' AND epoch = ?`,
        ).run(input.terminalOutcome, stamp, input.turnId, input.expectedTurnEpoch).changes;
        if (turnChanged !== 1) throw new TurnSupervisorRepositoryError('CAS_FAILED');
        if (input.terminalOutcome === 'succeeded' && input.hostedResult) {
          db.exec(HOSTED_RESULT_SCHEMA_SQL);
          db.prepare(
            `INSERT INTO turn_supervisor_hosted_results (
              turn_id, run_id, provider, model, session_id, is_new_session,
              text, project_path, transcript_state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            input.turnId, input.runId, input.hostedResult.provider, input.hostedResult.model,
            input.hostedResult.sessionId, input.hostedResult.isNewSession ? 1 : 0,
            input.hostedResult.text, input.hostedResult.projectPath ?? null,
            input.hostedResult.transcriptState ?? 'pending', stamp, stamp,
          );
        }
        return { turn: readTurn(db, input.turnId), run: readLatestRun(db, input.turnId) };
      }).immediate();
    },

    /** CAS transition; a stale epoch or state is fenced with CAS_FAILED. */
    transitionRun(input: TransitionRunInput): RunRecord {
      assertRunTransition(input);
      const stamp = now();
      const result = getDatabase().prepare(
        `UPDATE turn_supervisor_runs
         SET state = ?, epoch = epoch + 1, terminal_outcome = ?, updated_at = ?
         WHERE run_id = ? AND state = ? AND epoch = ?`,
      ).run(
        input.nextState,
        input.terminalOutcome ?? null,
        stamp,
        input.runId,
        input.expectedState,
        input.expectedEpoch,
      );
      if (result.changes !== 1) throw new TurnSupervisorRepositoryError('CAS_FAILED');
      const row = getDatabase().prepare('SELECT * FROM turn_supervisor_runs WHERE run_id = ?').get(
        input.runId,
      ) as RunDbRow;
      return toRun(row);
    },

    /** CAS transition for the durable turn aggregate. */
    transitionTurn(input: TransitionTurnInput): TurnRecord {
      assertTurnTransition(input);
      const stamp = now();
      const result = getDatabase().prepare(
        `UPDATE turn_supervisor_turns
         SET state = ?, epoch = epoch + 1, terminal_outcome = ?, updated_at = ?
         WHERE turn_id = ? AND state = ? AND epoch = ?`,
      ).run(
        input.nextState,
        input.terminalOutcome ?? null,
        stamp,
        input.turnId,
        input.expectedState,
        input.expectedEpoch,
      );
      if (result.changes !== 1) throw new TurnSupervisorRepositoryError('CAS_FAILED');
      return readTurn(getDatabase(), input.turnId);
    },
  };
}

export const turnSupervisorRepository = createTurnSupervisorRepository();

/**
 * Pending server-action queue repository (ADR-066, T-944).
 *
 * Persistence for privileged host actions a Claude coordinator requests and the
 * platform owner executes from the web UI. See PENDING_SERVER_ACTIONS_TABLE_SCHEMA_SQL
 * for the security model: `action_type` is a symbolic allowlist key only — this
 * repository never stores or resolves a command/argv. Callers resolve the real
 * argv from server/services/server-actions.js at execution time.
 *
 * Lifecycle (status): pending → executing (CAS claim) → a TERMINAL state
 * ('succeeded' on proven success, 'failed' on error/unresolved, 'superseded'
 * when a newer generation or an equivalent request replaced it), or back to
 * pending on a deferred gate. A 'failed' row is RETRYABLE: the CAS claim accepts
 * it too (B-200) — see claimForExecution. All access is parameterized; state
 * transitions are CAS-guarded (WHERE status=...) so a duplicate/racing execute
 * cannot double-run an action.
 *
 * QUEUE vs HISTORY (T-1684). A successful execution no longer DELETES its row:
 * it settles to 'succeeded' and stamps `settled_at`, so every command the owner
 * pressed — succeeded, failed, or unresolved — is readable for one hour and then
 * pruned by pruneHistory(). Consequences that are load-bearing elsewhere:
 *   • the QUEUE is 'pending' (+ a live 'executing' row) — listVisible();
 *   • HISTORY is the three terminal states — listHistory();
 *   • countActionable() (and therefore /health.hasPendingActions, the yellow
 *     badge) counts 'pending' ONLY, so a terminal row can never re-raise it.
 * 'succeeded' is deliberately NOT claimable: the work it describes happened.
 */

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type PendingServerActionStatus =
  | 'pending' | 'executing' | 'succeeded' | 'failed' | 'superseded';

/** The three settled states. A row in one of these is HISTORY, never the queue. */
export const TERMINAL_STATUSES: readonly PendingServerActionStatus[] =
  Object.freeze(['succeeded', 'failed', 'superseded']);

/**
 * The `error` codes that mean DEFERRED — the action was declined before it ran,
 * so nothing was executed and no outcome exists. A NULL/empty error belongs to
 * the same group (an unqualified deferral) and is matched separately in SQL.
 *
 * This set is the ONLY thing boot may settle on a row that still carries an
 * attempt nonce (ADR-156 WI-1 / م-5). The invariant it protects is the one
 * d98c4855 introduced: BOOT CANNOT PROVE AN EXECUTION OUTCOME. A row whose
 * error records a real verdict — 'oid_manual_recovery_required' above all — is
 * evidence about an attempt that happened, and a server start is not evidence
 * that overturns it. Widening this list is therefore a correctness decision,
 * not a convenience: add a code only when it provably means "never ran".
 *
 * 'oid_control_deferred' qualifies and is included. It is produced by the SAME
 * deferral branch of oidReceiptOutcome that produces 'live_work' and
 * 'live_sessions' — the control receipt said the restart was declined — so it
 * means "never ran" by exactly the same argument. It reaches a row through
 * settleExecution rather than moveToPending, which does NOT clear the nonce, so
 * without this entry such a row can never be settled by anything: it is the
 * eternally-pending shape of B-1057 arriving by the other path.
 */
export const RESTART_DEFERRAL_REASON_CODES: readonly string[] =
  Object.freeze(['live_sessions', 'live_work', 'proc_not_in_pm2', 'oid_control_deferred']);

export type PendingServerActionRow = {
  id: string;
  actionType: string;
  sessionId: string | null;
  reason: string | null;
  requestedBy: string | null;
  expectedServerBuildId: string | null;
  executionAttemptNonce: string | null;
  sourceUpdateJobId: string | null;
  sourceUpdateTransactionId: string | null;
  activationIdentitySha256: string | null;
  releaseCommit: string | null;
  status: PendingServerActionStatus;
  error: string | null;
  requestedAt: string;
  executedAt: string | null;
  settledAt: string | null;
};

export type InsertPendingServerAction = {
  id: string;
  actionType: string;
  sessionId?: string | null;
  reason?: string | null;
  requestedBy?: string | null;
  expectedServerBuildId?: string | null;
  sourceUpdateJobId?: string | null;
  sourceUpdateTransactionId?: string | null;
  activationIdentitySha256?: string | null;
  releaseCommit?: string | null;
};

export type GenerationBoundEnqueueResult = {
  row: PendingServerActionRow;
  inserted: boolean;
  superseded: number;
};

type PendingServerActionDbRow = {
  id: string;
  action_type: string;
  session_id: string | null;
  reason: string | null;
  requested_by: string | null;
  expected_server_build_id: string | null;
  execution_attempt_nonce: string | null;
  source_update_job_id: string | null;
  source_update_transaction_id: string | null;
  activation_identity_sha256: string | null;
  release_commit: string | null;
  status: string;
  error: string | null;
  requested_at: string;
  executed_at: string | null;
  settled_at: string | null;
};

/** Hard cap on a stored error string so a verbose failure cannot bloat the row. */
const MAX_ERROR_LEN = 500;
/** Cap for a collapsed reason: several requests merge into one row's reason. */
const MAX_REASON_LEN = 2000;

/**
 * Retention horizon (ms) for HISTORY — the three terminal states (T-1684).
 *
 * The owner's rule is one hour from the moment the row settled: long enough to
 * come back to a restart that ran while they were away, short enough that the
 * history tab is the recent past rather than an audit archive. The durable
 * forensic record is audit_log, which this never touches. There is no feature
 * flag: unlike the old 90-day pruneTerminal, deletion here is the STATED
 * contract of the history tab, not an optional cleanup.
 */
const HISTORY_RETENTION_MS = 60 * 60 * 1000;

/**
 * Age (ms) after which an 'executing' row is considered ABANDONED and settled to
 * an UNRESOLVED terminal state by reapStaleExecuting() (B-185 part ب, T-1684).
 *
 * Sizing rationale — this must be comfortably longer than any real execution so
 * a live run is never settled under itself: the foreground action cap is 120 s
 * and the raw-exec cap is 120 s. 30 minutes is ~15× the longest bounded run.
 */
const STALE_EXECUTING_MS = 30 * 60 * 1000;

/**
 * True when a better-sqlite3 error is a constraint violation (the partial UNIQUE
 * dedup index over (action_type, IFNULL(session_id,'')) WHERE status='pending').
 * better-sqlite3 exposes SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY in `.code`.
 */
const isConstraintError = (err: unknown): boolean =>
  typeof (err as { code?: unknown })?.code === 'string' &&
  ((err as { code: string }).code).startsWith('SQLITE_CONSTRAINT');

const mapRow = (row: PendingServerActionDbRow): PendingServerActionRow => ({
  id: row.id,
  actionType: row.action_type,
  sessionId: row.session_id,
  reason: row.reason,
  requestedBy: row.requested_by,
  expectedServerBuildId: row.expected_server_build_id,
  executionAttemptNonce: row.execution_attempt_nonce ?? null,
  sourceUpdateJobId: row.source_update_job_id,
  sourceUpdateTransactionId: row.source_update_transaction_id,
  activationIdentitySha256: row.activation_identity_sha256,
  releaseCommit: row.release_commit,
  status: row.status as PendingServerActionStatus,
  error: row.error,
  requestedAt: row.requested_at,
  executedAt: row.executed_at,
  settledAt: row.settled_at ?? null,
});

/**
 * Prevents an older in-flight generation from returning to the actionable
 * queue after a newer generation was enqueued while its gate was running.
 * Must be called as the first write inside the caller's transaction.
 */
const fenceWhenNewerGenerationExists = (
  db: ReturnType<typeof getConnection>,
  id: string,
): number => db.prepare(
  `UPDATE pending_server_actions AS target
   SET status = 'superseded',
       settled_at = CURRENT_TIMESTAMP,
       error = substr('superseded_by:' || (
         SELECT newer.id FROM pending_server_actions AS newer
         WHERE newer.action_type = target.action_type
           AND newer.rowid > target.rowid
           AND newer.status IN ('pending', 'failed', 'executing')
           AND newer.expected_server_build_id IS NOT NULL
           AND (target.expected_server_build_id IS NULL
                OR newer.expected_server_build_id != target.expected_server_build_id)
         ORDER BY newer.rowid DESC LIMIT 1
       ), 1, ${MAX_ERROR_LEN})
   WHERE target.id = ?
     AND target.action_type = 'safe-restart'
     AND EXISTS (
       SELECT 1 FROM pending_server_actions AS newer
       WHERE newer.action_type = target.action_type
         AND newer.rowid > target.rowid
         AND newer.status IN ('pending', 'failed', 'executing')
         AND newer.expected_server_build_id IS NOT NULL
         AND (target.expected_server_build_id IS NULL
              OR newer.expected_server_build_id != target.expected_server_build_id)
     )`,
).run(id).changes;

/**
 * Returns a row to 'pending' from one of `allowedStatuses`, clearing the
 * execution stamps so it reads as freshly queued. Shared by resetToPending (a
 * deferred gate, guard = 'executing') and requeueSettled (an aborted execution
 * whose row already settled). CAS-guarded on the same status set it read.
 *
 * `execution_attempt_nonce` is cleared too (B-1057, ADR-156 WI-1): a row that
 * reads as freshly queued must carry no stamp from the attempt that was undone,
 * otherwise boot reconciliation (clearSatisfiedBefore) used to skip it and the
 * row stayed 'pending' forever after its restart had in fact happened.
 *
 * DEDUP-CONFLICT SAFETY (B-200 follow-on). A retry can end here while a
 * DIFFERENT row with the same dedup key (action_type, IFNULL(session_id,''),
 * IFNULL(expected_server_build_id,'')) is already 'pending' — a state the
 * partial UNIQUE index forbids, so the UPDATE would throw and leave the row
 * stuck (a new orphan). When that happens the row is REDUNDANT by construction:
 * an identical request is already queued and will do exactly the same work. So
 * it is retained as terminal history rather than wedged, and 0 is reported
 * (nothing was returned to pending; an equivalent row already is).
 */
const moveToPending = (
  id: string,
  allowedStatuses: readonly PendingServerActionStatus[],
  reasonCode: string | null,
): number => {
  const db = getConnection();
  const guard = allowedStatuses.map(() => '?').join(', ');
  return db.transaction(() => {
    const current = db.prepare(
      'SELECT status FROM pending_server_actions WHERE id = ?',
    ).get(id) as { status: string } | undefined;
    if (!current || !allowedStatuses.includes(current.status as PendingServerActionStatus)) return 0;
    if (fenceWhenNewerGenerationExists(db, id) === 1) return 1;
    try {
      return db
        .prepare(
          `UPDATE pending_server_actions
           SET status = 'pending', executed_at = NULL, settled_at = NULL,
               execution_attempt_nonce = NULL, error = ?
           WHERE id = ? AND status IN (${guard})`,
        )
        .run(reasonCode?.slice(0, MAX_ERROR_LEN) ?? null, id, ...allowedStatuses).changes;
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      db.prepare(
        `UPDATE pending_server_actions
         SET status = 'superseded', error = 'satisfied_by_equivalent_pending_action',
             settled_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(id);
      return 0;
    }
  })();
};

/** Insert through an explicitly held connection, preserving the ordinary queue's SQL and dedup contract. */
export function insertPendingServerAction(db: Database.Database, action: InsertPendingServerAction): number {
  return db.prepare(`INSERT INTO pending_server_actions
    (id, action_type, session_id, reason, requested_by, expected_server_build_id,
     source_update_job_id, source_update_transaction_id, activation_identity_sha256, release_commit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(action.id, action.actionType, action.sessionId ?? null, action.reason ?? null,
      action.requestedBy ?? null, action.expectedServerBuildId ?? null, action.sourceUpdateJobId ?? null,
      action.sourceUpdateTransactionId ?? null, action.activationIdentitySha256 ?? null, action.releaseCommit ?? null).changes;
}

/** Read a bound action from the same connection that owns its transaction. */
export function getPendingServerActionById(db: Database.Database, id: string): PendingServerActionRow | null {
  const row = db.prepare('SELECT * FROM pending_server_actions WHERE id = ?').get(id) as PendingServerActionDbRow | undefined;
  return row ? mapRow(row) : null;
}

export const pendingServerActionsDb = {
  /**
   * Inserts a new pending action. Idempotent via the partial-unique dedup index
   * (ON CONFLICT DO NOTHING): a second request for the same (action_type,
   * session_id) while one is still 'pending' is a no-op. Returns the number of
   * rows inserted (1 = new, 0 = deduped against an existing pending request).
   * `status` and `requested_at` come from the table defaults.
   */
  insert(action: InsertPendingServerAction): number {
    return insertPendingServerAction(getConnection(), action);
  },

  /**
   * Atomically replaces the actionable generation of a global host action.
   *
   * A newly-sealed safe-restart candidate is the only restart the owner should
   * be offered. Older and legacy unbound rows are retained as `superseded` for
   * audit, while an already queued row for the SAME build is reused (including
   * a retryable failed row). An immediate transaction obtains the writer lock
   * before inspecting unresolved executions or selecting/inserting a row.
   * An exact executing restart is retained; ambiguity rejects without writes.
   */
  enqueueGenerationBoundGlobal(action: InsertPendingServerAction): GenerationBoundEnqueueResult {
    if (!action.expectedServerBuildId) {
      throw new Error('expected_server_build_id_required');
    }
    const db = getConnection();
    return db.transaction(() => {
      if (action.actionType === 'safe-restart') {
        const executing = db.prepare(`SELECT * FROM pending_server_actions
          WHERE action_type = ? AND status = 'executing' LIMIT 2`)
          .all(action.actionType) as PendingServerActionDbRow[];
        if (executing.length) {
          const row = mapRow(executing[0]);
          const identityFields = ['expectedServerBuildId', 'reason', 'requestedBy', 'activationIdentitySha256',
            'releaseCommit', 'sourceUpdateJobId', 'sourceUpdateTransactionId'] as const;
          if (executing.length !== 1 || identityFields.some(field => row[field] !== (action[field] ?? null))) {
            throw new Error('safe_restart_execution_conflict');
          }
          return { row, inserted: false, superseded: 0 };
        }
      }
      let superseded = db.prepare(
        `UPDATE pending_server_actions
         SET status = 'superseded', error = ?, settled_at = CURRENT_TIMESTAMP
         WHERE action_type = ?
           AND (expected_server_build_id IS NULL OR expected_server_build_id != ?)
           AND status IN ('pending', 'failed')`,
      ).run(`superseded_by:${action.id}`.slice(0, MAX_ERROR_LEN), action.actionType,
        action.expectedServerBuildId).changes;

      if (action.reason?.startsWith('local-update:')) {
        superseded += db.prepare(`UPDATE pending_server_actions
          SET status = 'superseded', error = ?, settled_at = CURRENT_TIMESTAMP
          WHERE action_type = ? AND expected_server_build_id = ? AND status IN ('pending', 'failed')
          AND (activation_identity_sha256 IS NOT ? OR release_commit IS NOT ? OR requested_by IS NOT ? OR reason IS NOT ?)`)
          .run(`superseded_by:${action.id}`, action.actionType, action.expectedServerBuildId,
            action.activationIdentitySha256 ?? null, action.releaseCommit ?? null, action.requestedBy ?? null, action.reason).changes;
      }

      const queuedDb = db.prepare(
        `SELECT * FROM pending_server_actions
         WHERE action_type = ?
           AND expected_server_build_id = ?
           AND status IN ('pending', 'failed')
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                  requested_at ASC, rowid ASC
         LIMIT 1`,
      ).get(action.actionType, action.expectedServerBuildId) as PendingServerActionDbRow | undefined;

      if (queuedDb) {
        // Older releases could leave more than one same-generation row when
        // different sessions requested the global action concurrently. Keep
        // exactly one current row and retain every duplicate as terminal audit
        // history; otherwise the command board would still render two buttons
        // for the very same build.
        const sameGenerationSuperseded = db.prepare(
          `UPDATE pending_server_actions
           SET status = 'superseded', error = ?, settled_at = CURRENT_TIMESTAMP
           WHERE action_type = ?
             AND expected_server_build_id = ?
             AND id != ?
             AND status IN ('pending', 'failed')`,
        ).run(`superseded_by:${queuedDb.id}`.slice(0, MAX_ERROR_LEN), action.actionType,
          action.expectedServerBuildId, queuedDb.id).changes;
        // Local-update reason is the exact job identity inspected after claim, not audit prose.
        // Preserve it on retries (and when another asker targets the same generation).
        if (!queuedDb.reason?.startsWith('local-update:')
          && typeof action.reason === 'string' && action.reason.trim() !== '') {
          db.prepare(
            `UPDATE pending_server_actions
             SET reason = substr(
                   CASE WHEN reason IS NULL OR reason = '' THEN ? ELSE reason || char(10) || ? END,
                   1, ${MAX_REASON_LEN})
             WHERE id = ?`,
          ).run(action.reason, action.reason, queuedDb.id);
        }
        const merged = db.prepare('SELECT * FROM pending_server_actions WHERE id = ?')
          .get(queuedDb.id) as PendingServerActionDbRow;
        return {
          row: mapRow(merged),
          inserted: false,
          superseded: superseded + sameGenerationSuperseded,
        };
      }

      const inserted = db.prepare(
        `INSERT INTO pending_server_actions
           (id, action_type, session_id, reason, requested_by, expected_server_build_id,
            source_update_job_id, source_update_transaction_id, activation_identity_sha256, release_commit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        action.id, action.actionType, action.sessionId ?? null, action.reason ?? null,
        action.requestedBy ?? null, action.expectedServerBuildId,
        action.sourceUpdateJobId ?? null, action.sourceUpdateTransactionId ?? null,
        action.activationIdentitySha256 ?? null, action.releaseCommit ?? null,
      );
      if (inserted.changes !== 1) throw new Error('pending_server_action_insert_failed');
      const row = db.prepare('SELECT * FROM pending_server_actions WHERE id = ?')
        .get(action.id) as PendingServerActionDbRow;
      return { row: mapRow(row), inserted: true, superseded };
    }).immediate();
  },

  /**
   * Lists the CLAIMABLE set (status IN 'pending','failed'), oldest first — the
   * rows claimForExecution accepts. An 'executing' row is excluded (mid-flight),
   * and so is every settled row.
   *
   * NOTE (T-1684): this is no longer "the queue the owner sees". A 'failed' row
   * is history that stays retryable; the visible queue is listVisible().
   */
  listActionable(): PendingServerActionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT * FROM pending_server_actions
         WHERE status IN ('pending', 'failed')
         ORDER BY requested_at ASC, rowid ASC`
      )
      .all() as PendingServerActionDbRow[];
    return rows.map(mapRow);
  },

  /** Returns a single action by id, or null when absent. */
  getById(id: string): PendingServerActionRow | null {
    return getPendingServerActionById(getConnection(), id);
  },

  /**
   * Returns the currently-pending action matching a dedup key (used to surface
   * the existing request on a deduped insert), or null. Matches the partial
   * unique index's key: (action_type, IFNULL(session_id,'')).
   */
  getPendingByDedup(
    actionType: string,
    sessionId: string | null,
    expectedServerBuildId: string | null = null,
  ): PendingServerActionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT * FROM pending_server_actions
         WHERE action_type = ?
           AND IFNULL(session_id, '') = IFNULL(?, '')
           AND IFNULL(expected_server_build_id, '') = IFNULL(?, '')
           AND status = 'pending'
         LIMIT 1`
      )
      .get(actionType, sessionId ?? null, expectedServerBuildId) as PendingServerActionDbRow | undefined;
    return row ? mapRow(row) : null;
  },

  /**
   * Atomically claims an ACTIONABLE action for execution (CAS): flips
   * 'pending' OR 'failed' → 'executing', stamps a fresh executed_at and CLEARS
   * the stale `error` of a previous attempt. Returns the number of rows changed
   * — the caller MUST treat a value other than 1 as "already claimed / not
   * claimable" (409) and NOT spawn anything.
   *
   * WHY 'failed' IS CLAIMABLE (B-200). The claim used to require
   * status='pending', while the UI (and listActionable/countActionable, which
   * both surface pending+failed as "the actionable queue") offers Retry on a
   * 'failed' row. Nothing in the system ever moved a row back from 'failed' to
   * 'pending', so every Retry on a failed row CAS-missed → 409 not_claimable,
   * forever: the row was permanently un-runnable and only Dismiss could clear
   * it. Accepting 'failed' here is what makes Retry real, and it keeps the
   * claim set identical to the "actionable" set used everywhere else.
   *
   * The double-run guard is UNCHANGED and still exact: 'executing' is excluded,
   * so the second of two racing claims still gets changes=0. Widening to
   * 'failed' cannot double-run anything either — a failed row by definition has
   * no live execution behind it (the outcome was already recorded). 'succeeded'
   * and 'superseded' stay UNclaimable (T-1684): a proven success must not be
   * silently re-run from the history tab.
   */
  claimForExecution(id: string): number {
    const db = getConnection();
    return db
      .prepare(
        `UPDATE pending_server_actions
         SET status = 'executing', executed_at = CURRENT_TIMESTAMP, settled_at = NULL,
             error = NULL, execution_attempt_nonce = ?
         WHERE id = ? AND status IN ('pending', 'failed')
           AND IFNULL(error, '') != 'oid_manual_recovery_required'`
      )
      .run(randomBytes(32).toString('hex'), id).changes;
  },

  /** Settle only the exact executing attempt; stale exits and receipts cannot mutate a retry. */
  settleExecution(id: string, nonce: string, buildId: string, status: PendingServerActionStatus, reasonCode: string): number {
    if (!/^[a-f0-9]{64}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(buildId || '')
      || !['pending', 'succeeded', 'failed', 'superseded'].includes(status)) return 0;
    const db = getConnection();
    return db.transaction(() => {
      // Hold the SQLite writer lock before inspecting the partial-UNIQUE key.
      // A new request may legitimately arrive while this attempt is executing.
      const current = db.prepare(
        `SELECT * FROM pending_server_actions WHERE id = ? AND status = 'executing'
         AND execution_attempt_nonce = ? AND expected_server_build_id = ?`,
      ).get(id, nonce, buildId) as PendingServerActionDbRow | undefined;
      if (!current) return 0;
      const replacement = status === 'pending' ? db.prepare(
        `SELECT id FROM pending_server_actions WHERE action_type = ?
         AND IFNULL(session_id, '') = IFNULL(?, '')
         AND IFNULL(expected_server_build_id, '') = IFNULL(?, '')
         AND status = 'pending' AND id != ? LIMIT 1`,
      ).get(current.action_type, current.session_id, buildId, id) as { id: string } | undefined : undefined;
      const finalStatus = replacement ? 'superseded' : status;
      const finalReason = replacement ? `superseded_by:${replacement.id}` : reasonCode;
      return db.prepare(
        `UPDATE pending_server_actions SET status = ?, error = ?,
           executed_at = CASE WHEN ? = 'pending' THEN NULL ELSE executed_at END,
           settled_at = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END
         WHERE id = ? AND status = 'executing' AND execution_attempt_nonce = ?
           AND expected_server_build_id = ?`,
      ).run(finalStatus, finalReason.slice(0, MAX_ERROR_LEN), finalStatus, finalStatus, id, nonce, buildId).changes;
    }).immediate();
  },

  /**
   * The QUEUE the owner acts on: 'pending' plus a row whose execution is
   * genuinely in flight, oldest first, with bounded pagination.
   *
   * T-1684 removed 'failed' from this projection. A failed row is HISTORY that
   * stays retryable — it is returned by listHistory() and rendered in the
   * history tab, so a failure can no longer keep the queue (and with it the
   * yellow badge) permanently non-empty.
   */
  listVisible(limit = 100, offset = 0): PendingServerActionRow[] {
    const pageSize = Number.isSafeInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
    const start = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
    return (getConnection().prepare(
      `SELECT * FROM pending_server_actions WHERE status IN ('pending', 'executing')
       ORDER BY requested_at ASC, rowid ASC LIMIT ? OFFSET ?`,
    ).all(pageSize, start) as PendingServerActionDbRow[]).map(mapRow);
  },

  /**
   * HISTORY: settled rows, NEWEST FIRST (the order the history tab renders).
   * Ordering falls back to executed_at then requested_at so a row settled by a
   * pre-T-1684 build (no settled_at) still sorts sensibly instead of last.
   */
  listHistory(limit = 100): PendingServerActionRow[] {
    const pageSize = Number.isSafeInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
    return (getConnection().prepare(
      `SELECT * FROM pending_server_actions
       WHERE status IN ('succeeded', 'failed', 'superseded')
       ORDER BY datetime(COALESCE(settled_at, executed_at, requested_at)) DESC, rowid DESC
       LIMIT ?`,
    ).all(pageSize) as PendingServerActionDbRow[]).map(mapRow);
  },

  /**
   * Returns a claimed ('executing') action to the 'pending' state and clears
   * executed_at — used when a pre-execution gate defers the action (live work in
   * progress) so the owner can retry once the work drains. Dedup-conflict
   * handling lives in moveToPending (B-200 follow-on).
   */
  resetToPending(id: string, reasonCode: string | null = null): number {
    return moveToPending(id, ['executing'], reasonCode);
  },

  /**
   * Returns an ABORTED execution to the queue from any non-pending state.
   *
   * Needed since T-1684: the detached restart path used to DELETE its row before
   * spawning, so its recovery path (the child exited without restarting) could
   * re-INSERT it. The row now survives as a settled history row instead, and
   * "the restart never happened" must put that exact row back on the board —
   * otherwise the work silently disappears from the queue while the yellow badge
   * stays down. Same dedup-conflict handling as resetToPending.
   */
  requeueSettled(id: string, reasonCode: string | null = null): number {
    return moveToPending(id, ['executing', 'succeeded', 'failed', 'superseded'], reasonCode);
  },

  /**
   * Settles an action as PROVEN SUCCESS: status 'succeeded' + settled_at, so it
   * leaves the queue and appears in history (T-1684 — it used to be deleted).
   *
   * CALL ONLY WITH EVIDENCE. "The process was spawned" is not evidence; an exit
   * code of 0 from a foreground action is, and for the self-restart path the
   * only evidence is an OID receipt, which settles through settleExecution.
   *
   * DEFENCE IN DEPTH: the guard is `status = 'executing'`, not merely "not
   * already succeeded". Every caller reaches here through claimForExecution, so
   * the row it is settling is the one it claimed; a late callback firing after
   * the row was superseded, requeued or already settled therefore changes 0 rows
   * instead of resurrecting a stale request as a success.
   */
  markSucceeded(id: string, reasonCode = 'exit_0'): number {
    const db = getConnection();
    return db
      .prepare(
        `UPDATE pending_server_actions
         SET status = 'succeeded', error = ?,
             executed_at = COALESCE(executed_at, CURRENT_TIMESTAMP),
             settled_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'executing'`,
      )
      .run(reasonCode.slice(0, MAX_ERROR_LEN), id).changes;
  },

  /** Marks an action failed with a bounded error string (kept for visibility). */
  markFailed(id: string, error: string): number {
    const db = getConnection();
    const safeError = typeof error === 'string' ? error.slice(0, MAX_ERROR_LEN) : null;
    return db.transaction(() => {
      if (fenceWhenNewerGenerationExists(db, id) === 1) return 1;
      return db
        .prepare(
          `UPDATE pending_server_actions
           SET status = 'failed', error = ?, settled_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(safeError, id).changes;
    })();
  },

  /**
   * CAS-guarded supersede for a row that must still be QUEUED (ADR-156 ت-1).
   *
   * markSuperseded below is deliberately unguarded — it is used on rows that
   * are mid-execution, where recording the outcome is the point. This variant
   * exists for the opposite case: a caller that decided a row was abandoned by
   * READING it a moment ago. Between that read and this write a claim may have
   * turned the row 'executing', and settling it then would erase a live
   * attempt's identity. The status guard makes the decision and the write agree
   * on the same row state, so a lost race reports 0 instead of clobbering.
   */
  supersedeQueued(id: string, error: string): number {
    const db = getConnection();
    return db.prepare(
      `UPDATE pending_server_actions
       SET status = 'superseded', error = ?, settled_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('pending', 'failed')`,
    ).run(error.slice(0, MAX_ERROR_LEN), id).changes;
  },

  /** Permanently fence one stale generation-bound row. */
  markSuperseded(id: string, error = 'superseded_by_newer_server_candidate'): number {
    const db = getConnection();
    return db.prepare(
      `UPDATE pending_server_actions
       SET status = 'superseded', error = ?, settled_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(error.slice(0, MAX_ERROR_LEN), id).changes;
  },

  /**
   * UNGUARDED delete of one row by id. Idempotent — a missing id is a silent
   * no-op. Since T-1684 no execution path deletes a row on success (it settles
   * to 'succeeded'), so this is a maintenance/test primitive; every user-facing
   * removal goes through dismissById, which refuses a mid-execution row.
   */
  deleteById(id: string): number {
    const db = getConnection();
    return db.prepare('DELETE FROM pending_server_actions WHERE id = ?').run(id).changes;
  },

  /**
   * Dismiss only inactive rows — a queued request the owner no longer wants, or
   * a settled history row they want gone before the hour is up (T-1684). A
   * mid-execution row is refused so a racing claim keeps its identity.
   */
  dismissById(id: string): number {
    return getConnection().prepare(
      "DELETE FROM pending_server_actions WHERE id = ? AND status != 'executing'",
    ).run(id).changes;
  },

  /**
   * Returns the oldest still-queued row of `actionType` from ANY session, or
   * null. Used to collapse requests for a GLOBAL action (one whose single
   * execution satisfies every asker, e.g. safe-restart) onto one row.
   *
   * The dedup index keys on (action_type, session_id), which is right for an
   * action scoped to a conversation and wrong for a global one: three
   * conversations each asking for a deploy produced three rows, and pressing
   * them in sequence produced three real restarts — each cutting live sockets.
   */
  getQueuedByActionType(
    actionType: string,
    expectedServerBuildId: string | null = null,
  ): PendingServerActionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT * FROM pending_server_actions
         WHERE action_type = ?
           AND IFNULL(expected_server_build_id, '') = IFNULL(?, '')
           AND status IN ('pending', 'failed')
         ORDER BY requested_at ASC, rowid ASC
         LIMIT 1`
      )
      .get(actionType, expectedServerBuildId) as PendingServerActionDbRow | undefined;
    return row ? mapRow(row) : null;
  },

  /**
   * Appends `reason` to a row's reason, so collapsing several requests onto one
   * row keeps every asker's context instead of silently discarding it.
   * Bounded like `error` to keep one row from growing without limit.
   */
  appendReason(id: string, reason: string): number {
    const db = getConnection();
    if (typeof reason !== 'string' || reason.trim() === '') return 0;
    return db
      .prepare(
        `UPDATE pending_server_actions
         SET reason = substr(
               CASE WHEN reason IS NULL OR reason = '' THEN ? ELSE reason || char(10) || ? END,
               1, ${MAX_REASON_LEN})
         WHERE id = ?`
      )
      .run(reason, reason, id).changes;
  },

  /**
   * Settles every OTHER queued row of the same action type as history — called
   * after a global action runs, because the work they were all waiting for has
   * just happened. Leaving them queued is what turned one needed restart into a
   * sequence of them, each draining live sockets.
   *
   * T-1684 replaced the older delete-the-siblings variant: a request the owner
   * made must be visible in the history tab as "satisfied", not vanish.
   * Excludes 'executing' rows: those belong to a live run, not to this one.
   */
  supersedeSiblings(
    actionType: string,
    keepId: string,
    expectedServerBuildId: string | null = null,
    error = 'satisfied_by_same_generation_execution',
  ): number {
    const db = getConnection();
    return db.prepare(
      `UPDATE pending_server_actions
       SET status = 'superseded', error = ?, settled_at = CURRENT_TIMESTAMP
       WHERE action_type = ? AND id != ?
         AND IFNULL(expected_server_build_id, '') = IFNULL(?, '')
         AND status IN ('pending', 'failed')`,
    ).run(error.slice(0, MAX_ERROR_LEN), actionType, keepId, expectedServerBuildId).changes;
  },

  /** Permanently fence older or legacy-unbound clicks when a newer candidate arrives. */
  supersedeOtherGenerations(actionType: string, expectedServerBuildId: string): number {
    const db = getConnection();
    return db.prepare(
      `UPDATE pending_server_actions
       SET status = 'superseded', error = 'superseded_by_newer_server_candidate',
           settled_at = CURRENT_TIMESTAMP
       WHERE action_type = ?
         AND (expected_server_build_id IS NULL OR expected_server_build_id != ?)
         AND status IN ('pending', 'failed')`,
    ).run(actionType, expectedServerBuildId).changes;
  },

  /**
   * Settle only queued requests for the exact loaded generation; boot cannot
   * prove an execution outcome, so 'executing' rows are never touched here.
   *
   * B-1057 / ADR-156 WI-1, narrowed on review (م-5). The nonce condition of
   * d98c4855 is KEPT, because dropping it would let a server start overwrite a
   * row that carries a real verdict — a 'failed' row stamped
   * 'oid_manual_recovery_required' would silently become
   * 'satisfied_by_server_start' with no evidence behind the claim.
   *
   * The one exception is a row that was DEFERRED: moveToPending now clears the
   * nonce, but rows deferred by an older build still carry theirs, and they are
   * the eternally-pending rows of 1.47.0.9. They are admitted only when ALL of
   * this holds: status is 'pending' (never 'failed' — a failure is a recorded
   * outcome), and `error` is empty or one of RESTART_DEFERRAL_REASON_CODES,
   * i.e. it provably means the action never ran. Everything else keeps the
   * original strict condition.
   */
  clearSatisfiedBefore(
    actionType: string,
    startedAt: string,
    loadedServerBuildId: string | null = null,
  ): number {
    if (!/^[a-f0-9]{64}$/.test(loadedServerBuildId || '')) return 0;
    const db = getConnection();
    const deferred = RESTART_DEFERRAL_REASON_CODES.map(() => '?').join(', ');
    return db.prepare(
      `UPDATE pending_server_actions
       SET status = 'superseded', error = 'satisfied_by_server_start',
           settled_at = CURRENT_TIMESTAMP
       WHERE action_type = ? AND expected_server_build_id = ?
         AND status IN ('pending', 'failed')
         AND (execution_attempt_nonce IS NULL
              OR (status = 'pending' AND IFNULL(error, '') IN ('', ${deferred})))
         AND datetime(requested_at) <= datetime(?)`,
    ).run(actionType, loadedServerBuildId, ...RESTART_DEFERRAL_REASON_CODES, startedAt).changes;
  },

  /**
   * ONE-HOUR retention for history (T-1684). Deletes settled rows — succeeded,
   * failed and superseded alike — once HISTORY_RETENTION_MS has passed since
   * they settled. This is the history tab's stated contract ("deleted an hour
   * after execution"), so unlike the flag-gated 90-day pruneTerminal it replaces
   * there is nothing to switch on: runQueueMaintenance() in
   * server/routes/system.js calls it on the queue's bounded janitor cadence.
   *
   * 'pending' rows are never touched at any age — they are the queue's actual
   * work — and neither is a live 'executing' row (reapStaleExecuting settles an
   * abandoned one long before this horizon). The durable record of what ran is
   * audit_log, which this does not touch.
   *
   * @param maxAgeMs override the retention horizon (tests).
   * @returns number of rows deleted.
   */
  pruneHistory(maxAgeMs: number = HISTORY_RETENTION_MS): number {
    const db = getConnection();
    const cutoffSeconds = Math.max(0, Math.floor(maxAgeMs / 1000));
    const deleted = db
      .prepare(
      `DELETE FROM pending_server_actions
         WHERE status IN ('succeeded', 'failed', 'superseded')
           AND datetime(COALESCE(settled_at, executed_at, requested_at))
               <= datetime('now', ?)`
      )
      .run(`-${cutoffSeconds} seconds`).changes;

    if (deleted > 0) {
      console.log('Pruned pending_server_actions history rows', { deleted, maxAgeMs });
    }
    return deleted;
  },

  /**
   * Settles ABANDONED 'executing' rows as UNRESOLVED history (B-185 part ب,
   * amended by T-1684).
   *
   * THE LEAK IT CLOSES: a claim flips the row to 'executing'; if the process
   * dies between the claim and the outcome (deploy, OOM, restart), nothing ever
   * moves it again. Such a row is invisible to the queue AND to the dedup index
   * (partial on status='pending'), so it is neither retryable nor dismissable
   * from the UI — it just rots.
   *
   * WHY IT NO LONGER RETURNS THE ROW TO 'pending' (T-1684): the owner's rule is
   * that the yellow badge means "new commands are waiting", so nothing the
   * system infers on its own may raise it. An orphan proves only that the
   * outcome is UNKNOWN — never that the work still needs doing — so it settles
   * to 'failed'/`execution_unresolved`, which the history tab renders as an
   * unknown outcome and marks NOT retryable: re-running work that may already
   * have happened is the worse error. Such a row is therefore never requeued on
   * its own — it leaves history when the owner removes it or when pruneHistory
   * sweeps it at the one-hour horizon. audit_log keeps the durable record.
   *
   * SAFETY AGAINST SETTLING A LIVE RUN: only rows older than STALE_EXECUTING_MS
   * (30 min) are touched, ~15× the 120 s foreground cap. safe-restart is
   * excluded — its outcome is proven by OID receipts, not by age.
   *
   * Idempotent and safe to call repeatedly.
   *
   * @param maxAgeMs override the staleness horizon (tests).
   * @returns number of rows settled.
   */
  reapStaleExecuting(maxAgeMs: number = STALE_EXECUTING_MS): number {
    const db = getConnection();
    const cutoffSeconds = Math.max(0, Math.floor(maxAgeMs / 1000));
    const reaped = db
      .prepare(
        `UPDATE pending_server_actions
         SET status = 'failed', error = 'execution_unresolved',
             settled_at = CURRENT_TIMESTAMP
         WHERE status = 'executing' AND action_type != 'safe-restart'
           AND datetime(COALESCE(executed_at, requested_at)) <= datetime('now', ?)`
      )
      .run(`-${cutoffSeconds} seconds`).changes;

    if (reaped > 0) {
      console.log('Settled abandoned executing pending_server_actions rows', {
        reaped,
        maxAgeMs,
      });
    }
    return reaped;
  },

  /**
   * Count of rows that are WAITING FOR THE OWNER — status 'pending' only. Backs
   * /health.hasPendingActions and therefore the yellow command-board badge.
   *
   * T-1684 dropped 'failed' from this count: a failed row is history (retryable
   * from the history tab), and counting it kept the badge lit forever after one
   * failure, which is exactly what the badge must not do.
   */
  countActionable(): number {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM pending_server_actions
         WHERE status = 'pending'`
      )
      .get() as { count: number };
    return row.count;
  },
};

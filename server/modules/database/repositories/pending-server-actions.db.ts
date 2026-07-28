/**
 * Pending server-action queue repository (ADR-066, T-944).
 *
 * Persistence for privileged host actions a Claude coordinator requests and the
 * platform owner executes from the web UI. See PENDING_SERVER_ACTIONS_TABLE_SCHEMA_SQL
 * for the security model: `action_type` is a symbolic allowlist key only — this
 * repository never stores or resolves a command/argv. Callers resolve the real
 * argv from server/services/server-actions.js at execution time.
 *
 * Lifecycle (status): pending → executing (CAS claim) → { deleted on success,
 * failed on error, back to pending on a deferred gate }. A 'failed' row is
 * RETRYABLE: the CAS claim accepts it too (B-200) — see claimForExecution. All
 * access is parameterized; state transitions are CAS-guarded (WHERE status=...)
 * so a duplicate/racing execute cannot double-run an action.
 */

import { getConnection } from '@/modules/database/connection.js';

export type PendingServerActionStatus = 'pending' | 'executing' | 'failed';

export type PendingServerActionRow = {
  id: string;
  actionType: string;
  sessionId: string | null;
  reason: string | null;
  requestedBy: string | null;
  status: PendingServerActionStatus;
  error: string | null;
  requestedAt: string;
  executedAt: string | null;
};

export type InsertPendingServerAction = {
  id: string;
  actionType: string;
  sessionId?: string | null;
  reason?: string | null;
  requestedBy?: string | null;
};

type PendingServerActionDbRow = {
  id: string;
  action_type: string;
  session_id: string | null;
  reason: string | null;
  requested_by: string | null;
  status: string;
  error: string | null;
  requested_at: string;
  executed_at: string | null;
};

/** Hard cap on a stored error string so a verbose failure cannot bloat the row. */
const MAX_ERROR_LEN = 500;
/** Cap for a collapsed reason: several requests merge into one row's reason. */
const MAX_REASON_LEN = 2000;

/**
 * Retention horizon (days) for terminal rows, used only by pruneTerminal().
 * A successful execution deletes its row, so what accumulates here is 'failed'
 * rows plus 'executing' rows abandoned by a process that died mid-flight.
 */
const PENDING_ACTIONS_RETENTION_DAYS = 90;

/**
 * Feature flag gating pruneTerminal(). Retention is OFF unless this is set to
 * exactly '1' — an unset or malformed value keeps every row.
 */
const RETENTION_FLAG_ENV = 'NASSAJ_PENDING_ACTIONS_RETENTION';

/**
 * Age (ms) after which an 'executing' row is considered ABANDONED and reaped
 * back to 'pending' by reapStaleExecuting() (B-185 part ب).
 *
 * Sizing rationale — this must be comfortably longer than any real execution so
 * a live run is never yanked back under itself: the foreground action cap is
 * 120 s, the raw-exec cap is 120 s, and the detached restart path DELETES its
 * row before spawning (so it never sits in 'executing' at all). 30 minutes is
 * ~15× the longest bounded run.
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
  status: row.status as PendingServerActionStatus,
  error: row.error,
  requestedAt: row.requested_at,
  executedAt: row.executed_at,
});

export const pendingServerActionsDb = {
  /**
   * Inserts a new pending action. Idempotent via the partial-unique dedup index
   * (ON CONFLICT DO NOTHING): a second request for the same (action_type,
   * session_id) while one is still 'pending' is a no-op. Returns the number of
   * rows inserted (1 = new, 0 = deduped against an existing pending request).
   * `status` and `requested_at` come from the table defaults.
   */
  insert(action: InsertPendingServerAction): number {
    const db = getConnection();
    const info = db
      .prepare(
        `INSERT INTO pending_server_actions
           (id, action_type, session_id, reason, requested_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`
      )
      .run(
        action.id,
        action.actionType,
        action.sessionId ?? null,
        action.reason ?? null,
        action.requestedBy ?? null
      );
    return info.changes;
  },

  /**
   * Lists the actionable queue (status IN 'pending','failed'), oldest first. An
   * 'executing' row is intentionally excluded — it is mid-flight and neither
   * re-executable nor a "needs attention" item.
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
    const db = getConnection();
    const row = db
      .prepare('SELECT * FROM pending_server_actions WHERE id = ?')
      .get(id) as PendingServerActionDbRow | undefined;
    return row ? mapRow(row) : null;
  },

  /**
   * Returns the currently-pending action matching a dedup key (used to surface
   * the existing request on a deduped insert), or null. Matches the partial
   * unique index's key: (action_type, IFNULL(session_id,'')).
   */
  getPendingByDedup(actionType: string, sessionId: string | null): PendingServerActionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT * FROM pending_server_actions
         WHERE action_type = ?
           AND IFNULL(session_id, '') = IFNULL(?, '')
           AND status = 'pending'
         LIMIT 1`
      )
      .get(actionType, sessionId ?? null) as PendingServerActionDbRow | undefined;
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
   * no live execution behind it (the outcome was already recorded), and a
   * successful execution DELETES its row rather than leaving a terminal one.
   */
  claimForExecution(id: string): number {
    const db = getConnection();
    return db
      .prepare(
        `UPDATE pending_server_actions
         SET status = 'executing', executed_at = CURRENT_TIMESTAMP, error = NULL
         WHERE id = ? AND status IN ('pending', 'failed')`
      )
      .run(id).changes;
  },

  /**
   * Returns a claimed ('executing') action to the 'pending' state and clears
   * executed_at — used when a pre-execution gate defers the action (live work in
   * progress) so the owner can retry once the work drains.
   *
   * DEDUP-CONFLICT SAFETY (B-200 follow-on). Since a 'failed' row is now
   * claimable, a retry can end at this reset while a DIFFERENT row with the same
   * dedup key (action_type, IFNULL(session_id,'')) is already 'pending' — a
   * state the partial UNIQUE index forbids, so the UPDATE would throw and leave
   * the row stuck in 'executing' (a new orphan). When that happens the row is
   * REDUNDANT by construction: an identical request is already queued and will
   * do exactly the same work. So we drop it instead of wedging it, and report 0
   * changed rows (nothing was returned to pending; an equivalent row already is).
   */
  resetToPending(id: string): number {
    const db = getConnection();
    try {
      return db
        .prepare(
          `UPDATE pending_server_actions
           SET status = 'pending', executed_at = NULL
           WHERE id = ?`
        )
        .run(id).changes;
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      db.prepare('DELETE FROM pending_server_actions WHERE id = ?').run(id);
      return 0;
    }
  },

  /** Marks an action failed with a bounded error string (kept for visibility). */
  markFailed(id: string, error: string): number {
    const db = getConnection();
    const safeError = typeof error === 'string' ? error.slice(0, MAX_ERROR_LEN) : null;
    return db
      .prepare(
        `UPDATE pending_server_actions
         SET status = 'failed', error = ?
         WHERE id = ?`
      )
      .run(safeError, id).changes;
  },

  /** Deletes an action by id. Idempotent — a missing id is a silent no-op. */
  deleteById(id: string): number {
    const db = getConnection();
    return db.prepare('DELETE FROM pending_server_actions WHERE id = ?').run(id).changes;
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
  getQueuedByActionType(actionType: string): PendingServerActionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT * FROM pending_server_actions
         WHERE action_type = ? AND status IN ('pending', 'failed')
         ORDER BY requested_at ASC, rowid ASC
         LIMIT 1`
      )
      .get(actionType) as PendingServerActionDbRow | undefined;
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
   * Clears every OTHER queued row of the same action type — called after a
   * global action succeeds, because the work they were all waiting for has just
   * happened. Leaving them queued is what turned one needed restart into a
   * sequence of them.
   *
   * Excludes 'executing' rows: those belong to a live run, not to this one.
   */
  clearSiblings(actionType: string, keepId: string): number {
    const db = getConnection();
    return db
      .prepare(
        `DELETE FROM pending_server_actions
         WHERE action_type = ? AND id != ? AND status IN ('pending', 'failed')`
      )
      .run(actionType, keepId).changes;
  },

  /**
   * Retention prune for terminal rows — DISABLED BY DEFAULT, but now WIRED.
   *
   * The queue has no retention policy of its own: a successful execution deletes
   * its row, but a 'failed' row is kept for visibility forever, so the table
   * only grows. This is the mechanism to bound it. It stays OFF unless the
   * platform owner sets NASSAJ_PENDING_ACTIONS_RETENTION=1 — the owner decides
   * whether queue history may be deleted at all — but it is no longer dead code:
   * runQueueMaintenanceOnce() in server/routes/system.js calls it (behind that
   * same flag) on the first read of the queue after boot. It mirrors
   * pruneAuditLog and is safe to call repeatedly.
   *
   * 'pending' rows are never touched at any age — they are the queue's actual
   * work. 'executing' rows are recovered by reapStaleExecuting() long before
   * this 90-day horizon, so what this actually collects is old 'failed' history.
   *
   * Returns the number of rows deleted; 0 whenever the flag is off.
   */
  pruneTerminal(): number {
    if (process.env[RETENTION_FLAG_ENV] !== '1') {
      return 0;
    }

    const db = getConnection();
    const cutoff = `-${PENDING_ACTIONS_RETENTION_DAYS} days`;
    const deleted = db
      .prepare(
        `DELETE FROM pending_server_actions
         WHERE status IN ('failed', 'executing')
           AND datetime(COALESCE(executed_at, requested_at)) < datetime('now', ?)`
      )
      .run(cutoff).changes;

    if (deleted > 0) {
      console.log('Pruned terminal pending_server_actions rows', {
        deleted,
        retentionDays: PENDING_ACTIONS_RETENTION_DAYS,
      });
    }
    return deleted;
  },

  /**
   * Reaps ABANDONED 'executing' rows back to 'pending' (B-185 part ب).
   *
   * THE LEAK IT CLOSES: a claim flips the row to 'executing'; if the process
   * dies between the claim and the outcome (deploy, OOM, restart), nothing ever
   * moves it again. Such a row is invisible to listActionable/countActionable
   * AND invisible to the dedup index (which is partial on status='pending'), so
   * it is neither retryable nor dismissable from the UI and it silently blocks
   * nothing — it just rots. This returns it to the queue.
   *
   * SAFETY AGAINST YANKING A LIVE RUN: only rows older than STALE_EXECUTING_MS
   * (30 min) are touched, which is ~15× the 120 s foreground cap; the detached
   * restart path never leaves a row in 'executing' at all. The reset is done
   * per-row through resetToPending so a row whose dedup twin is already pending
   * is dropped rather than throwing on the UNIQUE index.
   *
   * Idempotent and safe to call repeatedly. Unlike pruneTerminal this DELETES
   * nothing by age and is NOT behind the retention flag — it is recovery of
   * live queue work, not history retention.
   *
   * @param maxAgeMs override the staleness horizon (tests).
   * @returns number of rows returned to 'pending' (a dropped-as-redundant row
   *          counts as reaped: it left the 'executing' limbo either way).
   */
  reapStaleExecuting(maxAgeMs: number = STALE_EXECUTING_MS): number {
    const db = getConnection();
    const cutoffSeconds = Math.max(0, Math.floor(maxAgeMs / 1000));
    const stale = db
      .prepare(
        `SELECT id FROM pending_server_actions
         WHERE status = 'executing'
           AND datetime(COALESCE(executed_at, requested_at)) <= datetime('now', ?)`
      )
      .all(`-${cutoffSeconds} seconds`) as { id: string }[];

    let reaped = 0;
    for (const { id } of stale) {
      try {
        this.resetToPending(id);
        reaped += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Failed to reap stale pending_server_action', { id, error: message });
      }
    }
    if (reaped > 0) {
      console.log('Reaped abandoned executing pending_server_actions rows', {
        reaped,
        maxAgeMs,
      });
    }
    return reaped;
  },

  /** Count of actionable rows (status IN 'pending','failed') — backs /health. */
  countActionable(): number {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM pending_server_actions
         WHERE status IN ('pending', 'failed')`
      )
      .get() as { count: number };
    return row.count;
  },
};

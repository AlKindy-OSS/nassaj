import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type ScheduledMessageStatus = 'pending' | 'running' | 'sent' | 'failed' | 'cancelled';
export type ScheduledMessageOptions = Readonly<{
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  mode?: 'chat' | 'agent';
  coordinationLevel?: 'direct' | 'delegate' | 'delegate_review';
}>;

type StoredRow = {
  id: string; user_id: number; session_id: string; content: string; options_json: string;
  scheduled_for: string; available_at: string; status: ScheduledMessageStatus; attempts: number; max_attempts: number;
  lease_token: string | null; lease_expires_at: string | null; last_error_code: string | null;
  sent_at: string | null; created_at: string; updated_at: string;
};

export type ScheduledMessage = {
  id: string; userId: number; sessionId: string; content: string; options: ScheduledMessageOptions;
  scheduledFor: string; availableAt: string; status: ScheduledMessageStatus; attempts: number; maxAttempts: number;
  leaseToken: string | null; leaseExpiresAt: string | null; lastErrorCode: string | null;
  sentAt: string | null; createdAt: string; updatedAt: string;
};

export type ScheduledMessagesPage = Readonly<{
  messages: ScheduledMessage[];
  total: number;
}>;

export type ScheduledMessageActionableCounts = Readonly<{
  pending: number;
  running: number;
  failed: number;
}>;

export type ScheduledMessagesDueSoon = Readonly<{
  count: number;
  earliestAt: string | null;
}>;

/** Marks the five user positions in the writable-session template. */
const USER_SLOT = '{{user}}';

/**
 * Set-wise equivalent of `isSessionWritableByUser` for persisted sessions.
 * `userExpr` fills every USER_SLOT: `?` for a bound user (keep the five
 * bindings in the order of `accessBindings`), or a column reference for a
 * per-row correlated check.
 */
const WRITABLE_SESSION_TEMPLATE = `EXISTS (
  SELECT 1
  FROM sessions s
  WHERE s.session_id = scheduled_messages.session_id
    AND (
      s.project_path IS NULL OR TRIM(s.project_path) = ''
      OR NOT EXISTS (SELECT 1 FROM projects p0 WHERE p0.project_path = TRIM(s.project_path))
      OR EXISTS (
        SELECT 1 FROM session_participants sp
        WHERE sp.session_id = s.session_id AND sp.user_id = {{user}} AND sp.attribution = 'spawn'
      )
      OR EXISTS (
        SELECT 1 FROM message_authors ma
        WHERE ma.session_id = s.session_id AND ma.user_id = {{user}}
      )
      OR EXISTS (
        SELECT 1
        FROM projects p
        WHERE p.project_path = TRIM(s.project_path)
          AND (
            p.created_by = {{user}}
            OR EXISTS (
              SELECT 1 FROM project_members pm
              WHERE pm.project_id = p.project_id AND pm.user_id = {{user}}
            )
            OR EXISTS (
              SELECT 1
              FROM session_participants project_sp
              JOIN sessions project_s ON project_s.session_id = project_sp.session_id
              WHERE project_sp.user_id = {{user}}
                AND project_sp.attribution = 'spawn'
                AND TRIM(project_s.project_path) = p.project_path
            )
          )
      )
    )
)`;

const writableSessionSql = (userExpr: string): string => WRITABLE_SESSION_TEMPLATE.split(USER_SLOT).join(userExpr);

const WRITABLE_SESSION_SQL = writableSessionSql('?');

const accessBindings = (userId: number): number[] => [userId, userId, userId, userId, userId];

function listOrder(status?: ScheduledMessageStatus): string {
  if (status === 'failed' || status === 'sent' || status === 'cancelled') {
    return 'updated_at DESC, id ASC';
  }
  if (status === 'pending' || status === 'running') {
    return 'scheduled_for ASC, id ASC';
  }
  return `CASE WHEN status IN ('pending','running') THEN 0 WHEN status = 'failed' THEN 1 ELSE 2 END ASC,
    CASE WHEN status IN ('pending','running') THEN scheduled_for END ASC,
    CASE WHEN status NOT IN ('pending','running') THEN updated_at END DESC,
    id ASC`;
}

const parseOptions = (value: string): ScheduledMessageOptions => {
  try { return JSON.parse(value) as ScheduledMessageOptions; } catch { return {}; }
};
const mapRow = (row: StoredRow): ScheduledMessage => ({
  id: row.id, userId: row.user_id, sessionId: row.session_id, content: row.content,
  options: parseOptions(row.options_json), scheduledFor: row.scheduled_for,
  availableAt: row.available_at, status: row.status,
  attempts: row.attempts, maxAttempts: row.max_attempts, leaseToken: row.lease_token,
  leaseExpiresAt: row.lease_expires_at, lastErrorCode: row.last_error_code,
  sentAt: row.sent_at, createdAt: row.created_at, updatedAt: row.updated_at,
});

export const scheduledMessagesDb = {
  create(input: { userId: number; sessionId: string; content: string; options: ScheduledMessageOptions; scheduledFor: string }): ScheduledMessage {
    const db = getConnection();
    const id = randomUUID();
    db.prepare(`INSERT INTO scheduled_messages
      (id, user_id, session_id, content, options_json, scheduled_for, available_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.userId, input.sessionId, input.content, JSON.stringify(input.options), input.scheduledFor, input.scheduledFor);
    return scheduledMessagesDb.getOwned(id, input.userId)!;
  },

  getOwned(id: string, userId: number): ScheduledMessage | null {
    const row = getConnection().prepare(
      'SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ?'
    ).get(id, userId) as StoredRow | undefined;
    return row ? mapRow(row) : null;
  },

  listOwned(userId: number, filters: { sessionId?: string; status?: ScheduledMessageStatus } = {}): ScheduledMessage[] {
    const clauses = ['user_id = ?'];
    const values: Array<string | number> = [userId];
    if (filters.sessionId) { clauses.push('session_id = ?'); values.push(filters.sessionId); }
    if (filters.status) { clauses.push('status = ?'); values.push(filters.status); }
    return (getConnection().prepare(
      `SELECT * FROM scheduled_messages WHERE ${clauses.join(' AND ')} ORDER BY scheduled_for ASC LIMIT 200`
    ).all(...values) as StoredRow[]).map(mapRow);
  },

  /** Lists only rows whose target session remains writable by their owner. */
  listAccessibleOwned(
    userId: number,
    filters: { sessionId?: string; status?: ScheduledMessageStatus; limit: number; offset: number },
  ): ScheduledMessagesPage {
    const clauses = ['scheduled_messages.user_id = ?', WRITABLE_SESSION_SQL];
    const values: Array<string | number> = [userId, ...accessBindings(userId)];
    if (filters.sessionId) { clauses.push('scheduled_messages.session_id = ?'); values.push(filters.sessionId); }
    if (filters.status) { clauses.push('scheduled_messages.status = ?'); values.push(filters.status); }
    const where = clauses.join(' AND ');
    const db = getConnection();
    const count = db.prepare(`SELECT COUNT(*) AS count FROM scheduled_messages WHERE ${where}`)
      .get(...values) as { count: number };
    const rows = db.prepare(`SELECT scheduled_messages.* FROM scheduled_messages
      WHERE ${where} ORDER BY ${listOrder(filters.status)} LIMIT ? OFFSET ?`)
      .all(...values, filters.limit, filters.offset) as StoredRow[];
    return { messages: rows.map(mapRow), total: count.count };
  },

  /** Returns metadata-only badge counts after the same current write gate. */
  countAccessibleActionable(userId: number): ScheduledMessageActionableCounts {
    const rows = getConnection().prepare(`SELECT status, COUNT(*) AS count
      FROM scheduled_messages
      WHERE user_id = ? AND status IN ('pending','running','failed') AND ${WRITABLE_SESSION_SQL}
      GROUP BY status`)
      .all(userId, ...accessBindings(userId)) as Array<{ status: ScheduledMessageStatus; count: number }>;
    const counts: { pending: number; running: number; failed: number } = { pending: 0, running: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === 'pending' || row.status === 'running' || row.status === 'failed') {
        counts[row.status] = row.count;
      }
    }
    return counts;
  },

  countOpenForUser(userId: number): number {
    const row = getConnection().prepare(
      "SELECT COUNT(*) AS count FROM scheduled_messages WHERE user_id = ? AND status IN ('pending','running')"
    ).get(userId) as { count: number };
    return row.count;
  },

  /**
   * T-1912: node-wide count and earliest due time of scheduled messages that
   * the queue WILL deliver by `untilIso` (UTC ISO, compared as text like
   * claimDue). Eligibility mirrors claimDue and the due-time re-authorization:
   * - `pending` with attempts left, due by `untilIso` (overdue rows included);
   * - `running` still in flight (unexpired lease, pre-acceptance by construction:
   *   an accepted row is settled `sent`), or with an expired lease and attempts
   *   left (claimDue will re-lease it);
   * - owner still active, and the target session still writable by the owner.
   * Cancelled, sent, failed, exhausted, revoked-session and inactive-user rows
   * never count. Returns metadata only: no content, ids or owners.
   */
  nextDueWithin(nowIso: string, untilIso: string): ScheduledMessagesDueSoon {
    const row = getConnection().prepare(`SELECT COUNT(*) AS count, MIN(available_at) AS earliestAt
      FROM scheduled_messages
      WHERE available_at <= ?
        AND (
          (status = 'pending' AND attempts < max_attempts)
          OR (status = 'running' AND (lease_expires_at > ? OR attempts < max_attempts))
        )
        AND EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = scheduled_messages.user_id AND u.is_active = 1 AND u.status = 'active'
        )
        AND ${writableSessionSql('scheduled_messages.user_id')}`)
      .get(untilIso, nowIso) as { count: number; earliestAt: string | null };
    return { count: row.count, earliestAt: row.count > 0 ? row.earliestAt : null };
  },

  failExpiredExhausted(nowIso: string): ScheduledMessage[] {
    const db = getConnection();
    return db.transaction(() => {
      const rows = db.prepare(`SELECT * FROM scheduled_messages
        WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts
        ORDER BY lease_expires_at ASC LIMIT 200`).all(nowIso) as StoredRow[];
      const failed: ScheduledMessage[] = [];
      const statement = db.prepare(`UPDATE scheduled_messages
        SET status = 'failed', last_error_code = 'lease_expired', lease_token = NULL,
            lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running' AND lease_token = ?
          AND lease_expires_at <= ? AND attempts >= max_attempts`);
      for (const row of rows) {
        if (row.lease_token && statement.run(row.id, row.lease_token, nowIso).changes === 1) {
          failed.push(mapRow({
            ...row,
            status: 'failed',
            lease_token: null,
            lease_expires_at: null,
            last_error_code: 'lease_expired',
          }));
        }
      }
      return failed;
    })();
  },

  updateOwned(id: string, userId: number, input: { content: string; options: ScheduledMessageOptions; scheduledFor: string }): ScheduledMessage | null {
    const result = getConnection().prepare(`UPDATE scheduled_messages
      SET content = ?, options_json = ?, scheduled_for = ?, available_at = ?, status = 'pending', attempts = 0,
          lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
          sent_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status IN ('pending','failed')`)
      .run(input.content, JSON.stringify(input.options), input.scheduledFor, input.scheduledFor, id, userId);
    return result.changes === 1 ? scheduledMessagesDb.getOwned(id, userId) : null;
  },

  cancelOwned(id: string, userId: number): 'cancelled' | 'not_found' | 'conflict' {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare('SELECT status FROM scheduled_messages WHERE id = ? AND user_id = ?')
        .get(id, userId) as { status: ScheduledMessageStatus } | undefined;
      if (!row) return 'not_found';
      if (row.status === 'cancelled') return 'cancelled';
      if (row.status !== 'pending' && row.status !== 'failed') return 'conflict';
      db.prepare(`UPDATE scheduled_messages SET status = 'cancelled', lease_token = NULL,
        lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`)
        .run(id, userId);
      return 'cancelled';
    })();
  },

  /**
   * Atomically leases the earliest due row that is the HEAD of its session.
   *
   * - `excludeSessionIds` names sessions that already have a delivery or turn in
   *   flight, so a busy session neither blocks other sessions (B-1390) nor gets
   *   a second concurrent turn; its next row stays pending in line.
   * - `excludeUserIds` names users at their concurrent-delivery cap, so one
   *   user's many sessions cannot monopolise the provider pool.
   * - Only a session's head (earliest `scheduled_for`, then `created_at`, then
   *   insertion order) among its open rows is claimable: a retryable failure
   *   that pushes the head's `available_at` later must not let a later message
   *   of the same session overtake it. A pending row that has exhausted its
   *   attempts can never be claimed, so it is never a head either; otherwise
   *   it would block its whole session forever.
   *
   * Both exclusion lists are IN-PROCESS state of the caller: they describe
   * deliveries this process started, not work another process may be running.
   * Cross-process exclusivity rests on the lease CAS below, nothing else.
   */
  claimDue(
    nowIso: string,
    leaseMs: number,
    excludeSessionIds: readonly string[] = [],
    excludeUserIds: readonly number[] = [],
  ): ScheduledMessage | null {
    const db = getConnection();
    return db.transaction(() => {
      const candidate = db.prepare(`SELECT sm.id FROM scheduled_messages sm
        WHERE sm.available_at <= ? AND sm.attempts < sm.max_attempts
          AND (sm.status = 'pending' OR (sm.status = 'running' AND sm.lease_expires_at <= ?))
          AND sm.session_id NOT IN (SELECT value FROM json_each(?))
          AND sm.user_id NOT IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_messages e
            WHERE e.session_id = sm.session_id AND e.rowid <> sm.rowid
              AND e.status IN ('pending','running')
              AND NOT (e.status = 'pending' AND e.attempts >= e.max_attempts)
              AND (e.scheduled_for < sm.scheduled_for
                OR (e.scheduled_for = sm.scheduled_for AND (e.created_at < sm.created_at
                  OR (e.created_at = sm.created_at AND e.rowid < sm.rowid))))
          )
        ORDER BY sm.available_at ASC, sm.scheduled_for ASC, sm.created_at ASC, sm.rowid ASC
        LIMIT 1`)
        .get(nowIso, nowIso, JSON.stringify(excludeSessionIds), JSON.stringify(excludeUserIds)) as
        { id: string } | undefined;
      if (!candidate) return null;
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
      const result = db.prepare(`UPDATE scheduled_messages
        SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND attempts < max_attempts
          AND (status = 'pending' OR (status = 'running' AND lease_expires_at <= ?))`)
        .run(leaseToken, leaseExpiresAt, candidate.id, nowIso);
      if (result.changes !== 1) return null;
      const row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(candidate.id) as StoredRow;
      return mapRow(row);
    })();
  },

  renewLease(id: string, leaseToken: string, leaseExpiresAt: string): boolean {
    return getConnection().prepare(`UPDATE scheduled_messages SET lease_expires_at = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running' AND lease_token = ?`)
      .run(leaseExpiresAt, id, leaseToken).changes === 1;
  },

  /**
   * Settles a claimed row. `refundAttempt` (a retryable refusal before any
   * provider effect, e.g. update maintenance) gives back the attempt the claim
   * spent, so a maintenance window cannot exhaust `max_attempts`.
   *
   * Both statements run in one transaction: a crash between them must not
   * leave a row `pending` with `attempts >= max_attempts`.
   */
  settle(id: string, leaseToken: string, outcome: {
    success: boolean; retryable: boolean; errorCode?: string; retryAt?: string; refundAttempt?: boolean;
  }): boolean {
    const db = getConnection();
    const status = outcome.success ? 'sent' : outcome.retryable ? 'pending' : 'failed';
    const boundedCode = outcome.errorCode?.slice(0, 128) ?? null;
    const refund = status === 'pending' && outcome.refundAttempt === true ? 1 : 0;
    return db.transaction(() => {
      const result = db.prepare(`UPDATE scheduled_messages SET status = ?, last_error_code = ?,
        available_at = COALESCE(?, available_at),
        sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END,
        attempts = CASE WHEN ? = 1 AND attempts > 0 THEN attempts - 1 ELSE attempts END,
        lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running' AND lease_token = ?`)
        .run(status, boundedCode, outcome.retryAt ?? null, status, refund, id, leaseToken);
      if (result.changes === 1 && !outcome.success && outcome.retryable) {
        db.prepare(`UPDATE scheduled_messages SET status = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending' AND attempts >= max_attempts`).run(id);
      }
      return result.changes === 1;
    })();
  },
};

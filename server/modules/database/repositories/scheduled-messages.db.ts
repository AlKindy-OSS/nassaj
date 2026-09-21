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

/**
 * Set-wise equivalent of `isSessionWritableByUser` for persisted sessions.
 * Keep the five user bindings in the same order as `accessBindings` below.
 */
const WRITABLE_SESSION_SQL = `EXISTS (
  SELECT 1
  FROM sessions s
  WHERE s.session_id = scheduled_messages.session_id
    AND (
      s.project_path IS NULL OR TRIM(s.project_path) = ''
      OR NOT EXISTS (SELECT 1 FROM projects p0 WHERE p0.project_path = TRIM(s.project_path))
      OR EXISTS (
        SELECT 1 FROM session_participants sp
        WHERE sp.session_id = s.session_id AND sp.user_id = ? AND sp.attribution = 'spawn'
      )
      OR EXISTS (
        SELECT 1 FROM message_authors ma
        WHERE ma.session_id = s.session_id AND ma.user_id = ?
      )
      OR EXISTS (
        SELECT 1
        FROM projects p
        WHERE p.project_path = TRIM(s.project_path)
          AND (
            p.created_by = ?
            OR EXISTS (
              SELECT 1 FROM project_members pm
              WHERE pm.project_id = p.project_id AND pm.user_id = ?
            )
            OR EXISTS (
              SELECT 1
              FROM session_participants project_sp
              JOIN sessions project_s ON project_s.session_id = project_sp.session_id
              WHERE project_sp.user_id = ?
                AND project_sp.attribution = 'spawn'
                AND TRIM(project_s.project_path) = p.project_path
            )
          )
      )
    )
)`;

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

  claimDue(nowIso: string, leaseMs: number): ScheduledMessage | null {
    const db = getConnection();
    return db.transaction(() => {
      const candidate = db.prepare(`SELECT id FROM scheduled_messages
        WHERE available_at <= ? AND attempts < max_attempts
          AND (status = 'pending' OR (status = 'running' AND lease_expires_at <= ?))
        ORDER BY available_at ASC LIMIT 1`).get(nowIso, nowIso) as { id: string } | undefined;
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

  settle(id: string, leaseToken: string, outcome: { success: boolean; retryable: boolean; errorCode?: string; retryAt?: string }): boolean {
    const db = getConnection();
    const status = outcome.success ? 'sent' : outcome.retryable ? 'pending' : 'failed';
    const boundedCode = outcome.errorCode?.slice(0, 128) ?? null;
    const result = db.prepare(`UPDATE scheduled_messages SET status = ?, last_error_code = ?, available_at = COALESCE(?, available_at),
      sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END,
      lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running' AND lease_token = ?`)
      .run(status, boundedCode, outcome.retryAt ?? null, status, id, leaseToken);
    if (!outcome.success && outcome.retryable) {
      db.prepare(`UPDATE scheduled_messages SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending' AND attempts >= max_attempts`).run(id);
    }
    return result.changes === 1;
  },
};

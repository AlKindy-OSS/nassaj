/** Durable response-duration sidecar (ADR-126).
 *
 * Values here are written only after a runner has observed first model activity
 * and a final assistant message.  The public reader returns no turn id, so this
 * table can never turn an ephemeral run handle into a history capability.
 */
import { getConnection } from '@/modules/database/connection.js';

/** Structural view of the providers-module HistoryReadLease; no cross-module import (T-1632). */
type HistoryReadLease = {
  queryRows<T>(db: ReturnType<typeof getConnection>, sql: string, parameters: readonly unknown[]): T[];
};

export type ResponseTurnMetric = {
  assistantMessageId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type RecordResponseTurnMetricResult =
  | { status: 'inserted' | 'idempotent'; metric: ResponseTurnMetric }
  | { status: 'conflict' | 'invalid' | 'missing_session'; metric: null };

function parseMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export const responseTurnMetricsDb = {
  recordCompleted(input: {
    turnId: string;
    sessionId: string;
    assistantMessageId: string;
    startedAt: string;
    completedAt: string;
  }): RecordResponseTurnMetricResult {
    if (!input.turnId || !input.sessionId || !input.assistantMessageId) {
      return { status: 'invalid', metric: null };
    }
    const startedMs = parseMs(input.startedAt);
    const completedMs = parseMs(input.completedAt);
    if (
      startedMs === null
      || completedMs === null
      || completedMs < startedMs
      || completedMs - startedMs > MAX_DURATION_MS
    ) {
      return { status: 'invalid', metric: null };
    }
    const metric: ResponseTurnMetric = {
      assistantMessageId: input.assistantMessageId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: completedMs - startedMs,
    };
    try {
      return getConnection().transaction((): RecordResponseTurnMetricResult => {
        const db = getConnection();
        if (!db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(input.sessionId)) {
          return { status: 'missing_session', metric: null };
        }
        const existing = db.prepare(
          `SELECT turn_id AS turnId, session_id AS sessionId,
                  assistant_message_id AS assistantMessageId,
                  started_at AS startedAt, completed_at AS completedAt
           FROM response_turn_metrics
           WHERE turn_id = ? OR (session_id = ? AND assistant_message_id = ?)
           LIMIT 1`,
        ).get(input.turnId, input.sessionId, input.assistantMessageId) as {
          turnId: string; sessionId: string; assistantMessageId: string;
          startedAt: string; completedAt: string;
        } | undefined;
        if (existing) {
          const exact = existing.turnId === input.turnId
            && existing.sessionId === input.sessionId
            && existing.assistantMessageId === input.assistantMessageId
            && existing.startedAt === input.startedAt
            && existing.completedAt === input.completedAt;
          return exact ? { status: 'idempotent', metric } : { status: 'conflict', metric: null };
        }
        db.prepare(
          `INSERT INTO response_turn_metrics
            (turn_id, session_id, assistant_message_id, started_at, completed_at, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          input.turnId, input.sessionId, input.assistantMessageId,
          input.startedAt, input.completedAt, metric.durationMs,
        );
        return { status: 'inserted', metric };
      })();
    } catch (error) {
      console.error('Failed to record completed response timing', {
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'conflict', metric: null };
    }
  },

  /** Read only metrics for normalized messages already authorized and present
   * in this response page.  Empty ids deliberately yield no database query. */
  listForMessages(sessionId: string, assistantMessageIds: readonly string[], lease?: HistoryReadLease): ResponseTurnMetric[] {
    const ids = [...new Set(assistantMessageIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (!sessionId || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const sql = `SELECT assistant_message_id AS assistantMessageId,
              started_at AS startedAt,
              completed_at AS completedAt,
              duration_ms AS durationMs
       FROM response_turn_metrics
       WHERE session_id = ? AND assistant_message_id IN (${placeholders})`;
    const db = getConnection();
    return lease ? lease.queryRows<ResponseTurnMetric>(db, sql, [sessionId, ...ids])
      : db.prepare(sql).all(sessionId, ...ids) as ResponseTurnMetric[];
  },

  /**
   * All durable turn windows for one session — for server-side cost attribution
   * that already reads the whole transcript (session-cost turn detail). Returns
   * the same durable columns as `listForMessages` and NO turn id, so it grants
   * no history capability. Unlike `listForMessages` it is not scoped to a page's
   * pre-authorized ids: the cost engine needs every window to bucket requests by
   * time, and the stored `assistant_message_id` is a normalized display id, not
   * a secret. Bounded by session; ordered for deterministic consumers.
   */
  listSessionWindows(sessionId: string): Array<Pick<ResponseTurnMetric, 'assistantMessageId' | 'startedAt' | 'completedAt'>> {
    if (!sessionId) return [];
    return getConnection().prepare(
      `SELECT assistant_message_id AS assistantMessageId,
              started_at AS startedAt,
              completed_at AS completedAt
       FROM response_turn_metrics
       WHERE session_id = ?
       ORDER BY started_at ASC`,
    ).all(sessionId) as Array<Pick<ResponseTurnMetric, 'assistantMessageId' | 'startedAt' | 'completedAt'>>;
  },

  /** Null means "no measurement exists", which is not the same fact as a total
   * of zero and must not be rendered as one (B-822). */
  sumSessionDuration(sessionId: string, lease?: HistoryReadLease): number | null {
    if (!sessionId) return null;
    if (lease) {
      const rows = lease.queryRows<{ duration: number }>(getConnection(),
        'SELECT duration_ms AS duration FROM response_turn_metrics WHERE session_id = ?', [sessionId]);
      return rows.length ? rows.reduce((sum, row) => sum + row.duration, 0) : null;
    }
    const row = getConnection().prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(duration_ms), 0) AS total
       FROM response_turn_metrics WHERE session_id = ?`,
    ).get(sessionId) as { rows: number; total: number } | undefined;
    if (!row || Number(row.rows) === 0) return null;
    return Number(row.total);
  },

  cleanupOrphaned(): number {
    return getConnection().prepare(
      `DELETE FROM response_turn_metrics
       WHERE session_id NOT IN (SELECT session_id FROM sessions)`,
    ).run().changes;
  },
};

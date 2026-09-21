/**
 * Closed (finished) conversations repository.
 *
 * Closing marks a conversation as done. Unlike a star, the flag is GLOBAL: the
 * conversation itself is closed, so every project member sees the same state.
 * Who closed it and when are recorded so the marker is attributable.
 *
 * Deliberately presentation-only: nothing here is consulted by the resume/read
 * path, and reopening is a plain DELETE — closing can never strand work.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ClosedSessionRow = {
  sessionId: string;
  closedBy: number | null;
  closedAt: string;
};

type ClosedSessionDbRow = {
  session_id: string;
  closed_by: number | null;
  closed_at: string;
};

const toRow = (row: ClosedSessionDbRow): ClosedSessionRow => ({
  sessionId: row.session_id,
  closedBy: row.closed_by,
  closedAt: row.closed_at,
});

export const closedSessionsDb = {
  /** True when this conversation is closed (by anyone). */
  isClosed(sessionId: string): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT 1 FROM closed_sessions WHERE session_id = ? LIMIT 1')
      .get(sessionId);
    return Boolean(row);
  },

  /** Full marker for one conversation, or null when it is open. */
  getClosedSession(sessionId: string): ClosedSessionRow | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT session_id, closed_by, closed_at FROM closed_sessions WHERE session_id = ?')
      .get(sessionId) as ClosedSessionDbRow | undefined;
    return row ? toRow(row) : null;
  },

  /**
   * The subset of the given ids that is closed, as a Set, in ONE query — the
   * sidebar flags a whole page of conversations at once and must not fan out
   * into N queries. An empty input never touches the DB.
   */
  getClosedSessionIds(sessionIds: string[]): Set<string> {
    const closed = new Set<string>();
    if (sessionIds.length === 0) {
      return closed;
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT session_id FROM closed_sessions WHERE session_id IN (${placeholders})`)
      .all(...sessionIds) as { session_id: string }[];

    for (const row of rows) {
      closed.add(row.session_id);
    }

    return closed;
  },

  /**
   * Full markers (id + who + when) for a page of conversations, in ONE query.
   *
   * The attribution counterpart of getClosedSessionIds. It exists so the sidebar
   * never reaches for listClosedSessions() to answer a per-page question: that
   * one is unfiltered, so calling it per project turns a page render into
   * O(projects x closed_sessions) and grows forever as conversations are closed.
   */
  getClosedSessionRows(sessionIds: string[]): ClosedSessionRow[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT session_id, closed_by, closed_at
         FROM closed_sessions
         WHERE session_id IN (${placeholders})`
      )
      .all(...sessionIds) as ClosedSessionDbRow[];

    return rows.map(toRow);
  },

  /**
   * Closes a conversation. Idempotent: re-closing an already-closed
   * conversation keeps the ORIGINAL closer and timestamp rather than
   * overwriting them, so the record answers "who finished this" honestly.
   */
  closeSession(sessionId: string, closedBy: number | null): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO closed_sessions (session_id, closed_by, closed_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO NOTHING`
    ).run(sessionId, closedBy);
  },

  /** Reopens a conversation. Idempotent — reopening an open one is a no-op. */
  reopenSession(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM closed_sessions WHERE session_id = ?').run(sessionId);
  },

  /** All closed conversations, most recently closed first. */
  listClosedSessions(): ClosedSessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT session_id, closed_by, closed_at
         FROM closed_sessions
         ORDER BY closed_at DESC, session_id ASC`
      )
      .all() as ClosedSessionDbRow[];
    return rows.map(toRow);
  },
};

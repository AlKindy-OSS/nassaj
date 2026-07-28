/**
 * Starred (favorite/pinned) sessions repository.
 *
 * Persists a per-user star flag for a session so a user can mark conversations
 * they want to return to. Star is PER USER: the composite primary key
 * (user_id, session_id) means the same session can be starred by one user and
 * not another. All queries are parameterized and scoped by user_id — a user can
 * only ever see or mutate their own stars.
 */

import { getConnection } from '@/modules/database/connection.js';

export type StarredSessionRow = {
  sessionId: string;
  projectName: string | null;
  createdAt: string;
};

type StarredSessionDbRow = {
  session_id: string;
  project_name: string | null;
  created_at: string;
};

export const starredSessionsDb = {
  /**
   * Returns the user's starred sessions, newest star first. Each row carries the
   * sessionId and the projectName recorded when the star was created.
   */
  listStarredSessions(userId: number): StarredSessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT session_id, project_name, created_at
         FROM starred_sessions
         WHERE user_id = ?
         ORDER BY created_at DESC, session_id ASC`
      )
      .all(userId) as StarredSessionDbRow[];

    return rows.map((row) => ({
      sessionId: row.session_id,
      projectName: row.project_name,
      createdAt: row.created_at,
    }));
  },

  /** True when the given session is starred by this user. */
  isStarred(userId: number, sessionId: string): boolean {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT 1 FROM starred_sessions WHERE user_id = ? AND session_id = ? LIMIT 1'
      )
      .get(userId, sessionId);
    return Boolean(row);
  },

  /**
   * Returns the subset of the given session ids that this user has starred, as a
   * Set, in a single query (avoids N+1 when flagging a page of sessions). An
   * empty input yields an empty Set without touching the DB.
   */
  getStarredSessionIds(userId: number, sessionIds: string[]): Set<string> {
    const starred = new Set<string>();
    if (sessionIds.length === 0) {
      return starred;
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT session_id FROM starred_sessions
         WHERE user_id = ? AND session_id IN (${placeholders})`
      )
      .all(userId, ...sessionIds) as { session_id: string }[];

    for (const row of rows) {
      starred.add(row.session_id);
    }
    return starred;
  },

  /**
   * Stars a session for a user. Idempotent: re-starring keeps the original
   * created_at and refreshes the stored project_name. Returns true (the session
   * is starred after the call).
   */
  star(userId: number, sessionId: string, projectName: string | null): boolean {
    const db = getConnection();
    db.prepare(
      `INSERT INTO starred_sessions (user_id, session_id, project_name)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, session_id) DO UPDATE SET
         project_name = excluded.project_name`
    ).run(userId, sessionId, projectName);
    return true;
  },

  /**
   * Removes a user's star from a session. Idempotent: a no-op when not starred.
   * Returns false (the session is not starred after the call).
   */
  unstar(userId: number, sessionId: string): boolean {
    const db = getConnection();
    db.prepare('DELETE FROM starred_sessions WHERE user_id = ? AND session_id = ?').run(
      userId,
      sessionId
    );
    return false;
  },

  /**
   * Sets the star state explicitly. Returns the resulting starred state.
   */
  setStarred(
    userId: number,
    sessionId: string,
    starred: boolean,
    projectName: string | null
  ): boolean {
    return starred
      ? starredSessionsDb.star(userId, sessionId, projectName)
      : starredSessionsDb.unstar(userId, sessionId);
  },
};

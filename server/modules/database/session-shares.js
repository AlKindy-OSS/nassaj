/**
 * Persistence for read-only session share links (ADR-196, T-1970 stage 4).
 *
 * A share row holds the gzip snapshot blob, the SHA-256 of the bearer token
 * (never the token), and its lifecycle. Every revocation path nulls the
 * snapshot in the same statement, so a revoked link keeps no conversation text.
 * All SQL is parameterized; table names are fixed literals.
 */

/** Active-share caps enforced inside the INSERT itself (race-free under concurrency). */
export const SESSION_SHARE_CAPS = Object.freeze({ perCreator: 50, perSession: 20 });

/**
 * Additive schema, one statement per exec (reviewed startup SQL contract).
 * `owner_user_id` pins the strict session owner at creation so an ownership
 * change is a definitive death cause even for shares made by an admin.
 * @param {import('better-sqlite3').Database} db
 */
export function migrateSessionShares(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_shares (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL, token_hash TEXT NOT NULL, created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT,
    snapshot BLOB, snapshot_sha256 TEXT NOT NULL, up_to_message_id TEXT NOT NULL,
    message_count INTEGER NOT NULL, redaction_counts TEXT NOT NULL,
    view_count INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT,
    sweep_miss_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS session_shares_session ON session_shares(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS session_shares_creator ON session_shares(created_by)');
  db.exec('CREATE INDEX IF NOT EXISTS session_shares_liveness ON session_shares(revoked_at, expires_at)');
}

/** Columns safe to return to management callers: no token hash, no blob. */
const LISTED = `id, session_id, project_id, owner_user_id, created_by, created_at, expires_at,
  revoked_at, revoke_reason, snapshot_sha256, up_to_message_id, message_count, redaction_counts,
  view_count, last_viewed_at`;

const REVOKE_SET = `revoked_at = COALESCE(revoked_at, @at),
  revoke_reason = COALESCE(revoke_reason, @reason), snapshot = NULL`;

/**
 * True when the session_shares table exists on this connection. Revocation
 * hooks in shared code paths (session/project/user deletion) call this so a
 * test database without the feature schema is a no-op, never an error.
 * @param {import('better-sqlite3').Database} db
 */
export function sessionSharesTableExists(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_shares'").get());
}

/**
 * Revokes every share of one session (archive/delete hooks).
 * @returns {number} rows changed
 */
export function revokeSharesBySession(db, sessionId, reason, at = new Date().toISOString()) {
  if (!sessionSharesTableExists(db)) return 0;
  return db.prepare(`UPDATE session_shares SET ${REVOKE_SET} WHERE session_id = @sessionId
    AND (revoked_at IS NULL OR snapshot IS NOT NULL)`).run({ sessionId, reason, at }).changes;
}

/** Revokes every share in one project (archive/delete hooks). @returns {number} */
export function revokeSharesByProject(db, projectId, reason, at = new Date().toISOString()) {
  if (!sessionSharesTableExists(db)) return 0;
  return db.prepare(`UPDATE session_shares SET ${REVOKE_SET} WHERE project_id = @projectId
    AND (revoked_at IS NULL OR snapshot IS NOT NULL)`).run({ projectId, reason, at }).changes;
}

/**
 * Revokes shares created by a user AND shares of sessions that user owns.
 * Called inside the user-deletion transaction. @returns {number}
 */
export function revokeSharesByUser(db, userId, reason, at = new Date().toISOString()) {
  if (!sessionSharesTableExists(db)) return 0;
  return db.prepare(`UPDATE session_shares SET ${REVOKE_SET}
    WHERE (created_by = @userId OR owner_user_id = @userId)
    AND (revoked_at IS NULL OR snapshot IS NOT NULL)`).run({ userId, reason, at }).changes;
}

/**
 * Dependency-injected store over one connection; never creates schema on a request.
 * @param {import('better-sqlite3').Database} db
 */
export function createSessionSharesStore(db) {
  return {
    /** Full row including token hash and blob; public read path only. */
    get: (id) => db.prepare('SELECT * FROM session_shares WHERE id = ?').get(id),
    listBySession: (sessionId) => db.prepare(`SELECT ${LISTED} FROM session_shares
      WHERE session_id = ? ORDER BY created_at DESC LIMIT 200`).all(sessionId),
    /** Shares the user created plus shares of sessions the user owns. */
    listForUser: (userId) => db.prepare(`SELECT ${LISTED} FROM session_shares
      WHERE created_by = @userId OR owner_user_id = @userId
      ORDER BY created_at DESC LIMIT 200`).all({ userId }),
    /**
     * Inserts only while both active caps hold, evaluated in the same statement.
     * @returns {boolean} false when a cap was reached
     */
    insertWithinCaps: (row, now = new Date().toISOString()) => db.prepare(`INSERT INTO session_shares
      (id, session_id, project_id, owner_user_id, token_hash, created_by, created_at, expires_at,
       snapshot, snapshot_sha256, up_to_message_id, message_count, redaction_counts)
      SELECT @id, @session_id, @project_id, @owner_user_id, @token_hash, @created_by, @created_at,
       @expires_at, @snapshot, @snapshot_sha256, @up_to_message_id, @message_count, @redaction_counts
      WHERE (SELECT COUNT(*) FROM session_shares WHERE created_by = @created_by
          AND revoked_at IS NULL AND expires_at > @now) < @perCreator
        AND (SELECT COUNT(*) FROM session_shares WHERE session_id = @session_id
          AND revoked_at IS NULL AND expires_at > @now) < @perSession`)
      .run({ ...row, now, perCreator: SESSION_SHARE_CAPS.perCreator, perSession: SESSION_SHARE_CAPS.perSession })
      .changes === 1,
    revoke: (id, reason, at = new Date().toISOString()) => db.prepare(`UPDATE session_shares
      SET ${REVOKE_SET} WHERE id = @id`).run({ id, reason, at }).changes,
    /** Adds pending views; the caller batches so this runs at most once a minute per share. */
    addViews: (id, count, at) => db.prepare(`UPDATE session_shares
      SET view_count = view_count + @count, last_viewed_at = @at WHERE id = @id AND revoked_at IS NULL`)
      .run({ id, count, at }).changes,
    /**
     * One id-ordered page of rows the sweeper still has to judge (not revoked, or
     * revoked with a leftover blob), strictly after `afterId`.
     */
    listSweepable: (afterId = '', limit = 500) => db.prepare(`SELECT id, session_id, project_id,
      owner_user_id, created_by, expires_at, revoked_at, sweep_miss_count FROM session_shares
      WHERE (revoked_at IS NULL OR snapshot IS NOT NULL) AND id > ? ORDER BY id LIMIT ?`).all(afterId, limit),
    /**
     * Revokes (reason 'expired', blob nulled) up to `limit` live rows whose
     * ISO expiry is at or before `at`.
     * @returns {number} rows changed
     */
    revokeExpired: (at, limit = 500) => db.prepare(`UPDATE session_shares SET ${REVOKE_SET}
      WHERE id IN (SELECT id FROM session_shares WHERE revoked_at IS NULL AND expires_at <= @at LIMIT @limit)`)
      .run({ at, reason: 'expired', limit }).changes,
    markSweepMiss: (id) => db.prepare(`UPDATE session_shares SET sweep_miss_count = sweep_miss_count + 1
      WHERE id = ? AND revoked_at IS NULL`).run(id).changes,
    resetSweepMiss: (id) => db.prepare(`UPDATE session_shares SET sweep_miss_count = 0
      WHERE id = ? AND sweep_miss_count <> 0`).run(id).changes,
  };
}

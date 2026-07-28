import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { parseStoredTimestampMs } from '@/modules/database/utils/timestamps.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type SessionMetadataLookupRow = Pick<
  SessionRow,
  'session_id' | 'provider' | 'project_path' | 'jsonl_path' | 'custom_name' | 'isArchived' | 'created_at' | 'updated_at'
>;

/**
 * Normalizes any accepted timestamp form to ISO-8601 UTC — the single format
 * this module writes, so stored values stay mutually comparable.
 */
function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  const epoch = parseStoredTimestampMs(value);
  if (epoch === null) {
    return null;
  }

  return new Date(epoch).toISOString();
}

/**
 * SQL expression for "now" in the same ISO-8601 UTC format normalizeTimestamp
 * produces. Used instead of CURRENT_TIMESTAMP, which writes the timezone-less
 * form and is what mixed the two formats into one column in the first place.
 */
const NOW_ISO_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

/**
 * "Native" session predicate (B-29): a session is shown in the conversations
 * list only when it was actually started through this server — i.e. the server
 * run path recorded a participant row (`recordSpawn`) or a message-author row
 * (`recordUserMessage`) for it. Both are written exclusively on the spawn path
 * and never by an external `claude -p` invocation, so any transcript dropped
 * into the project folder by an out-of-band CLI/agent run (an "orphan" session)
 * is excluded from the list instead of being silently adopted.
 *
 * Applied as a correlated EXISTS so it never duplicates session rows and stays a
 * pure visibility filter — it does not touch ownership, deletion, or archival
 * paths, which must still see every row.
 */
const NATIVE_SESSION_PREDICATE_SQL = `(
  EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = sessions.session_id)
  OR EXISTS (SELECT 1 FROM message_authors ma WHERE ma.session_id = sessions.session_id)
)`;

export const sessionsDb = {
  createSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // Wrap the project-upsert + session-upsert in a single transaction so a
    // concurrent UNIQUE violation or mid-flight crash never leaves the sessions
    // table with a dangling project_path reference or a partial row.  (B-38.)
    const run = db.transaction(() => {
      // Ensure the project path exists in the projects table before writing the
      // session row that carries the FK reference.
      projectsDb.createProjectPath(normalizedProjectPath);

      // Archival is a USER decision, never overwritten by an upsert (B-161/T-857):
      // a new row starts active (isArchived 0 in VALUES), but on conflict the
      // stored isArchived is PRESERVED — a background rescan (any provider's
      // synchronizer re-indexing an unchanged/archived session) must not
      // resurrect a session the user archived. Un-archiving has its own explicit
      // path (restoreSessionById → updateSessionIsArchived(false)).
      db.prepare(
        `INSERT INTO sessions (session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, COALESCE(?, ${NOW_ISO_SQL}), COALESCE(?, ${NOW_ISO_SQL}))
         ON CONFLICT(session_id) DO UPDATE SET
           provider = excluded.provider,
           updated_at = excluded.updated_at,
           project_path = excluded.project_path,
           jsonl_path = excluded.jsonl_path,
           custom_name = COALESCE(excluded.custom_name, sessions.custom_name)`
      ).run(
        sessionId,
        provider,
        customName ?? null,
        normalizedProjectPath,
        jsonlPath ?? null,
        createdAtValue,
        updatedAtValue
      );
    });

    run();
    return sessionId;
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  /**
   * Best-effort freshness bump used when a Codex CHILD thread (a subagent spawn
   * or a fork) is FOLDED under its parent conversation instead of being indexed
   * as its own session row (codex-session-synchronizer). It advances the parent's
   * updated_at to `updatedAt` ONLY when the parent row already exists AND the new
   * value is strictly newer, so:
   *   - a missing parent is a no-op (no INSERT, no project upsert) — it can never
   *     create or resurrect a row, unlike createSession;
   *   - a background rescan of an OLD child never rewinds a parent that has since
   *     moved on.
   * Returns nothing; callers treat it as fire-and-forget.
   */
  bumpSessionUpdatedAt(sessionId: string, updatedAt?: string): void {
    const normalized = normalizeTimestamp(updatedAt);
    if (!sessionId || !normalized) {
      return;
    }
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
         SET updated_at = ?
       WHERE session_id = ?
         AND (updated_at IS NULL OR datetime(updated_at) < datetime(?))`
    ).run(normalized, sessionId, normalized);
  },

  getSessionById(sessionId: string): SessionMetadataLookupRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionMetadataLookupRow | undefined;

    return row ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    // Sidebar order: newest-created first (creation date, NOT last activity).
    // `created_at` comes from the session's first transcript timestamp /
    // file birthtime at index time and never changes on upsert, so pagination
    // pages stay stable while a session is active.
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}
         ORDER BY datetime(COALESCE(created_at, updated_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /**
   * Hands a run's temporary id over to the conversation id the provider actually
   * files the transcript under, and removes the temporary row.
   *
   * Some adapters mint a runtime spawn key before the CLI reveals its own
   * conversation id (antigravity's `agy_<ts>_<rand>` vs the brain UUID). While
   * that key is live, participants.recordSpawn creates a STUB sessions row for it
   * to satisfy the FK — a row with no transcript path. Its comment assumes "the
   * synchronizer's upsert later replaces the stub fields with real values", which
   * only holds when the synchronizer indexes the SAME id. For antigravity it does
   * not: the synchronizer files the brain UUID, so the stub survives forever as an
   * empty chat while the real conversation sits under another row — the user sends
   * a message, sees the live reply, and finds the chat empty on the next load
   * (fetchHistory resolves the transcript from jsonl_path, which the stub lacks).
   *
   * Everything the run recorded against the temporary id moves with it:
   * `message_authors` (who wrote which message — the sidebar's attribution) and
   * `session_participants` (visibility/ownership). The participant rows are
   * copied BEFORE the delete because they cascade with the session row. The stub
   * is only removed when it is genuinely a stub — a row with no transcript path —
   * so this can never delete a real conversation.
   *
   * Returns true when a stub was adopted and removed.
   */
  adoptRuntimeSessionId(stubId: string, realId: string): boolean {
    if (!stubId || !realId || stubId === realId) {
      return false;
    }

    const db = getConnection();
    const stub = db
      .prepare('SELECT session_id, jsonl_path FROM sessions WHERE session_id = ?')
      .get(stubId) as Pick<SessionRow, 'session_id' | 'jsonl_path'> | undefined;
    if (!stub || (stub.jsonl_path ?? '').trim() !== '') {
      return false;
    }
    const real = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(realId);
    if (!real) {
      // Never strand the run's records: without the destination row the move
      // would delete them (FK cascade) instead of relocating them.
      return false;
    }

    const run = db.transaction(() => {
      db.prepare('UPDATE message_authors SET session_id = ? WHERE session_id = ?').run(realId, stubId);
      db.prepare(
        `INSERT OR IGNORE INTO session_participants
           (session_id, user_id, role, first_seen, last_seen, message_count)
         SELECT ?, user_id, role, first_seen, last_seen, message_count
         FROM session_participants WHERE session_id = ?`
      ).run(realId, stubId);
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(stubId);
    });
    run();
    return true;
  },

  /**
   * Ghost-session cleanup reads every row for one provider (archived included)
   * with a stored transcript path, so the synchronizer can prune entries whose
   * file vanished from disk (e.g. Claude's ~30-day retention sweep).
   */
  getSessionFilePathsByProvider(provider: string): Array<{ session_id: string; jsonl_path: string }> {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, jsonl_path
         FROM sessions
         WHERE provider = ?
           AND jsonl_path IS NOT NULL`
      )
      .all(provider) as Array<{ session_id: string; jsonl_path: string }>;
  },

  /**
   * Batched transcript-path lookup for a set of session ids (avoids N+1 in the
   * workflow-status scan, T-53-B3). Returns one row per session that has a
   * jsonl_path; sessions without one (or not present) are simply omitted. An
   * empty input yields [] without touching the database. Prepared statement with
   * `?`-placeholders per id — no interpolation of caller input.
   */
  getSessionFilePathsByIds(
    sessionIds: string[],
  ): Array<{ session_id: string; jsonl_path: string; project_path: string | null }> {
    if (sessionIds.length === 0) {
      return [];
    }
    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    // project_path (the run's real cwd) is returned alongside jsonl_path so the
    // workflow-status endpoint can match a session to a supervisor scope by its
    // actual project directory (ADR-053 §ج-2). Existing callers read by field
    // name, so the extra column is additive and non-breaking.
    return db
      .prepare(
        `SELECT session_id, jsonl_path, project_path
         FROM sessions
         WHERE session_id IN (${placeholders})
           AND jsonl_path IS NOT NULL`
      )
      .all(...sessionIds) as Array<{
      session_id: string;
      jsonl_path: string;
      project_path: string | null;
    }>;
  },

  /**
   * Removes every row indexed from one transcript file and returns the deleted
   * session ids, so watcher `unlink` events can drop ghost sessions immediately.
   */
  deleteSessionsByJsonlPath(jsonlPath: string): string[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT session_id FROM sessions WHERE jsonl_path = ?`)
      .all(jsonlPath) as Array<{ session_id: string }>;

    if (rows.length === 0) {
      return [];
    }

    db.prepare(`DELETE FROM sessions WHERE jsonl_path = ?`).run(jsonlPath);
    return rows.map((row) => row.session_id);
  },
};

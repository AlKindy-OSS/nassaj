import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { rotateProjectStructureForPath } from '@/modules/database/repositories/project-access.js';
import { notifyProjectTransfer } from '@/modules/database/repositories/session-project-transfer-events.js';
import { parseStoredTimestampMs } from '@/modules/database/utils/timestamps.js';
import { logicalProjectPathForWorkspace } from '@/modules/session-workspaces/index.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  /**
   * ADR-088: engine axis — 'anthropic' | engine id ('kimi'/'glm') | null=UNKNOWN.
   * null never means official. Written only via setSessionEnginePin.
   */
  engine_provider: string | null;
  /** 'server_verdict' | 'inferred' | null. */
  engine_provider_source: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type SessionMetadataLookupRow = Pick<
  SessionRow,
  'session_id' | 'provider' | 'project_path' | 'jsonl_path' | 'custom_name' | 'engine_provider' | 'engine_provider_source' | 'isArchived' | 'created_at' | 'updated_at'
>;

/**
 * The one SELECT column list for session rows (ADR-088 review, بند 13): every
 * reader below uses this constant, so a future column cannot be silently
 * dropped from SOME queries and read back as null/undefined — which is how the
 * engine axis got lost client-side in the first place. A guard test compares
 * this list against PRAGMA table_info(sessions).
 */
const SESSION_ROW_COLUMNS_SQL =
  'session_id, provider, project_path, jsonl_path, custom_name, engine_provider, engine_provider_source, isArchived, created_at, updated_at';

const SESSION_ROW_COLUMNS_FROM_SESSIONS_SQL =
  'sessions.session_id AS session_id, sessions.provider AS provider, sessions.project_path AS project_path, sessions.jsonl_path AS jsonl_path, sessions.custom_name AS custom_name, sessions.engine_provider AS engine_provider, sessions.engine_provider_source AS engine_provider_source, sessions.isArchived AS isArchived, sessions.created_at AS created_at, sessions.updated_at AS updated_at';

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
  return normalizeProjectPath(logicalProjectPathForWorkspace(projectPath));
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
    let createdProjectId: string | null = null;
    let transferred = false;
    const run = db.transaction(() => {
      // Ensure the project path exists in the projects table before writing the
      // session row that carries the FK reference.
      // Discovery must not undo a user's project archival (B-963). Explicit
      // project creation/restoration retains its separate reactivation path.
      createdProjectId = projectsDb.ensureProjectPathForSession(normalizedProjectPath, {
        deferFenceRotation: true,
      });

      // Archival is a USER decision, never overwritten by an upsert (B-161/T-857):
      // a new row starts active (isArchived 0 in VALUES), but on conflict the
      // stored isArchived is PRESERVED — a background rescan (any provider's
      // synchronizer re-indexing an unchanged/archived session) must not
      // resurrect a session the user archived. Un-archiving has its own explicit
      // path (restoreSessionById → updateSessionIsArchived(false)).
      //
      // engine_provider / engine_provider_source are deliberately ABSENT from
      // both the INSERT and the UPDATE below (ADR-088): this operation is
      // reachable from every background synchronizer, and mentioning the engine
      // columns here would wipe the pin on the next rescan — the isArchived/B-161
      // failure all over again. Their sole writer is setSessionEnginePin.
      // BEFORE INSERT guards deliberately reject existing identities. Update first
      // so synchronization preserves children and never runs an INSERT conflict path.
      const previous = db.prepare('SELECT project_path FROM sessions WHERE session_id = ?')
        .get(sessionId) as { project_path: string | null } | undefined;
      const updated = db.prepare(
        `UPDATE sessions SET provider = ?, updated_at = COALESCE(?, ${NOW_ISO_SQL}),
           project_path = ?, jsonl_path = ?, custom_name = COALESCE(?, custom_name)
         WHERE session_id = ?`
      ).run(provider, updatedAtValue, normalizedProjectPath, jsonlPath ?? null, customName ?? null, sessionId);
      if (updated.changes === 0) {
        db.prepare(
          `INSERT INTO sessions (session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, COALESCE(?, ${NOW_ISO_SQL}), COALESCE(?, ${NOW_ISO_SQL}))`
        ).run(sessionId, provider, customName ?? null, normalizedProjectPath, jsonlPath ?? null, createdAtValue, updatedAtValue);
      } else if (previous?.project_path !== normalizedProjectPath) {
        // ADR-187: a cross-project transfer never silently retains human-room grants.
        // The tables exist only once the feature flag has been enabled.
        const hasRooms = db.prepare(`SELECT 1 FROM sqlite_master
          WHERE type='table' AND name='session_internal_rooms'`).get();
        if (hasRooms) {
          db.prepare(`UPDATE session_internal_rooms
            SET membership_state='revalidation_required', version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE session_id=?`).run(sessionId);
        }
        transferred = true;
      }
    });

    run.immediate();
    if (transferred) notifyProjectTransfer(sessionId);
    // The new row may be a lexical alias of an already-registered physical root.
    // Rotate through the committed path so every canonical alias is fenced.
    if (createdProjectId) rotateProjectStructureForPath(createdProjectId, normalizedProjectPath);
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

  /**
   * Reads the engine pin (ADR-088). Distinguishes "no row" (null) from a row
   * whose pin is unknown ({engine: null, source: null}) — callers treat both as
   * UNKNOWN for decisions but the difference matters for write diagnostics.
   */
  getSessionEnginePin(
    sessionId: string,
  ): { engine: string | null; source: string | null } | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT engine_provider, engine_provider_source
         FROM sessions
         WHERE session_id = ?`
      )
      .get(sessionId) as { engine_provider: string | null; engine_provider_source: string | null } | undefined;
    if (!row) return null;
    return { engine: row.engine_provider, source: row.engine_provider_source };
  },

  /**
   * The ONE writer for the engine pin (ADR-088). Write rules — chosen so a
   * leaked or racing turn can never overwrite lineage truth:
   *
   *   - NULL column           → written (first verdict wins; the UPDATE's WHERE
   *                             makes concurrent first-turns atomic — the loser
   *                             reads back what settled).
   *   - source='inferred' AND incoming source='server_verdict' AND the incoming
   *     value is an ENGINE id → upgraded. An 'anthropic' verdict never upgrades
   *     an inferred engine pin: with enforcement off a leaked official turn
   *     would otherwise launder the leak into a permanent official pin
   *     (qa-critic حرج 1).
   *   - anything else         → kept (returns the settled value).
   *
   * `engine='anthropic'` on a NULL row is additionally restricted by the CALLER
   * to brand-new sessions (isNewSession) — an old NULL row is UNKNOWN, and
   * unknown must never silently become official (qa-critic حرج 2).
   *
   * ── ADR-099/T-1237: the fourth source, `user_switch` ──────────────────────
   *
   * The three rules above all answer one question — "which vendor DID serve this
   * session?" — so later evidence never overrules earlier evidence. A user
   * switching engines asks a different question: "which vendor SHALL serve it
   * from now on?" That is an intent, not an observation, so it is the one source
   * allowed to overwrite a settled pin.
   *
   * Its power is fenced by three rules, and removing any one of them re-opens
   * exactly what ADR-088 closed:
   *
   *   1. ONLY the authenticated HTTP restamp route may pass it. A spawn must
   *      never write `user_switch` — a spawn observes, it does not intend. This
   *      is asserted below, not merely documented, because "a helper nobody
   *      calls" is how a guard becomes a comment (feedback_security_helper_dead_code).
   *   2. It outranks everything, including `server_verdict`.
   *   3. A later `server_verdict` must NOT demote it — otherwise the first spawn
   *      after the switch would record what it observed and silently undo the
   *      user's choice on the turn after next. This is why the WHERE clause
   *      below excludes a settled `user_switch` row from every other source.
   *
   * Note the asymmetry with rule 2 of ADR-088: `user_switch → 'anthropic'` IS
   * permitted on a row pinned to a vendor. That is the whole feature. It is safe
   * where a *verdict* of 'anthropic' is not, because the caller has proven both
   * session ownership and an explicit export acknowledgement first.
   *
   * Never throws; a missing row is reported (not silent) because on anon/system
   * spawns recordSpawn never created the sessions row (qa-critic بند 7).
   */
  setSessionEnginePin(
    sessionId: string,
    engine: string,
    source: 'server_verdict' | 'inferred' | 'user_switch',
    options: { intent?: boolean } = {},
  ): { outcome: 'written' | 'upgraded' | 'restamped' | 'kept' | 'missing_row'; engine: string | null } {
    const db = getConnection();
    const isOfficial = engine === 'anthropic';
    const isUserSwitch = source === 'user_switch';
    // Fence rule 1, asserted rather than described. `intent` is the caller's
    // signed statement that it is the authenticated restamp route; no spawn path
    // sets it, so a spawn that ever tries to pass `user_switch` fails loudly here
    // instead of quietly acquiring the power to overwrite a settled pin.
    if (isUserSwitch && options.intent !== true) {
      throw new Error(
        "setSessionEnginePin: source 'user_switch' requires options.intent — " +
        'only the authenticated restamp route may express intent (ADR-099).',
      );
    }
    const before = this.getSessionEnginePin(sessionId);
    const result = db
      .prepare(
        `UPDATE sessions
            SET engine_provider = ?, engine_provider_source = ?
          WHERE session_id = ?
            AND (
              ? = 1
              OR (
                -- NULL-safe on purpose: a row with no source yet must pass this
                -- arm, and \`NULL <> 'user_switch'\` alone would evaluate to NULL.
                (engine_provider_source IS NULL OR engine_provider_source <> 'user_switch')
                AND (
                  engine_provider IS NULL
                  OR (
                    engine_provider_source = 'inferred'
                    AND ? = 'server_verdict'
                    AND ? = 0
                  )
                )
              )
            )`
      )
      .run(engine, source, sessionId, isUserSwitch ? 1 : 0, source, isOfficial ? 1 : 0);

    const settled = this.getSessionEnginePin(sessionId);
    if (!settled) {
      console.warn(
        `[engine-pin] no sessions row for ${sessionId} — pin "${engine}" NOT recorded ` +
        '(anon/system spawn without recordSpawn?)'
      );
      return { outcome: 'missing_row', engine: null };
    }
    if (result.changes === 0) {
      return { outcome: 'kept', engine: settled.engine };
    }
    if (isUserSwitch) {
      // Distinct from 'written'/'upgraded' so the audit row can tell an intent
      // that REPLACED a settled pin from a first observation on a blank one.
      return { outcome: 'restamped', engine: settled.engine };
    }
    return {
      outcome: before?.source === 'inferred' ? 'upgraded' : 'written',
      engine: settled.engine,
    };
  },

  /** Minimal pre-admission locator; CASE prevents oversized TEXT materialization in SQLite or JS. */
  getHistorySource(sessionId: string): {
    session_id: string; provider: string; project_path: string | null;
    jsonl_path: string | null; updated_at: string; sourceOversized: number;
  } | null {
    if (typeof sessionId !== 'string' || !sessionId || Buffer.byteLength(sessionId) > 256) return null;
    return getConnection().prepare(`SELECT session_id,
      CASE WHEN octet_length(provider) <= 64 THEN provider ELSE '' END AS provider,
      CASE WHEN octet_length(project_path) <= 4096 THEN project_path ELSE NULL END AS project_path,
      CASE WHEN octet_length(jsonl_path) <= 4096 THEN jsonl_path ELSE NULL END AS jsonl_path,
      CASE WHEN octet_length(updated_at) <= 64 THEN updated_at ELSE '' END AS updated_at,
      (COALESCE(octet_length(provider), 0) > 64 OR COALESCE(octet_length(project_path), 0) > 4096
        OR COALESCE(octet_length(jsonl_path), 0) > 4096 OR COALESCE(octet_length(updated_at), 0) > 64) AS sourceOversized
      FROM sessions WHERE session_id = ? LIMIT 1`).get(sessionId) as {
        session_id: string; provider: string; project_path: string | null;
        jsonl_path: string | null; updated_at: string; sourceOversized: number;
      } | null ?? null;
  },

  getSessionById(sessionId: string): SessionMetadataLookupRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS_SQL}
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
        `SELECT ${SESSION_ROW_COLUMNS_SQL}
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
        `SELECT ${SESSION_ROW_COLUMNS_SQL}
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
        `SELECT ${SESSION_ROW_COLUMNS_SQL}
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
        `SELECT ${SESSION_ROW_COLUMNS_SQL}
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
        `SELECT ${SESSION_ROW_COLUMNS_SQL}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}
         ORDER BY datetime(COALESCE(created_at, updated_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];
  },

  /**
   * Returns every active, native session in a project starred by one user.
   * The user predicate belongs in the JOIN so another user's favourites can
   * never affect this caller's first sidebar page.
   */
  getStarredSessionsByProjectPathForUser(userId: number, projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS_FROM_SESSIONS_SQL}
         FROM sessions
         INNER JOIN starred_sessions
           ON starred_sessions.session_id = sessions.session_id
          AND starred_sessions.user_id = ?
         WHERE sessions.project_path = ?
           AND sessions.isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}
         ORDER BY datetime(COALESCE(sessions.created_at, sessions.updated_at)) DESC,
                  sessions.session_id DESC`
      )
      .all(userId, normalizedProjectPath) as SessionRow[];
  },

  /**
   * Pages only the active sessions a user has not starred. Callers prepend the
   * starred set once, so offsets remain stable as "loaded rows" offsets.
   */
  getUnstarredSessionsByProjectPathPageForUser(
    userId: number,
    projectPath: string,
    limit: number,
    offset: number,
  ): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS_FROM_SESSIONS_SQL}
         FROM sessions
         LEFT JOIN starred_sessions
           ON starred_sessions.session_id = sessions.session_id
          AND starred_sessions.user_id = ?
         WHERE sessions.project_path = ?
           AND sessions.isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}
           AND starred_sessions.session_id IS NULL
         ORDER BY datetime(COALESCE(sessions.created_at, sessions.updated_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, normalizedProjectPath, limit, offset) as SessionRow[];
  },

  /** Counts the same unstarred set used by the paged query above. */
  countUnstarredSessionsByProjectPathForUser(userId: number, projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN starred_sessions
           ON starred_sessions.session_id = sessions.session_id
          AND starred_sessions.user_id = ?
         WHERE sessions.project_path = ?
           AND sessions.isArchived = 0
           AND ${NATIVE_SESSION_PREDICATE_SQL}
           AND starred_sessions.session_id IS NULL`
      )
      .get(userId, normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
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
        `UPDATE message_coordination_ingress SET session_id = ? WHERE session_id = ?`,
      ).run(realId, stubId);
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

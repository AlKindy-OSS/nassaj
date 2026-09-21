/**
 * Session tombstones — the record that a conversation was deleted on purpose
 * (ADR-120).
 *
 * Deleting a session row is not enough to delete a conversation. Nineteen call
 * sites can create a session row, sixteen of them through sessionsDb
 * .createSession, and a full re-index runs at boot, on every GET /api/projects
 * and on every GET /api/projects/archived (that last one with no skip option at
 * all). So a deleted row whose transcript is still on disk comes back within
 * seconds — and comes back CLOSED and OWNERLESS, because closed_sessions
 * survives while session_participants cascades away.
 *
 * A tombstone is therefore the deletion itself: the row in `sessions` is the
 * cache, and this table is the decision. createSession consults it inside its
 * transaction and refuses to resurrect.
 *
 * Deliberately NOT a child of `sessions`: the row exists precisely BECAUSE the
 * session row does not. An FK here would fail the insert, and ON DELETE CASCADE
 * would destroy the tombstone along with the session — the exact inverse of its
 * purpose. It also has to survive rebuildSessionsTableWithProjectSchema, which
 * rebuilds under PRAGMA foreign_keys = OFF (the same mechanism that produced the
 * orphaned session_participants rows documented in migrations.ts).
 *
 * No title and no content are stored. A tombstone lives forever, so anything put
 * in it survives the "deletion" — which would make the delete a lie. The title
 * lives in the audit row (90-day window): that is the forensic record, this is
 * the guard.
 */

import { getConnection } from '@/modules/database/connection.js';

/**
 * Thrown by createSession when the id is tombstoned.
 *
 * A CLASS with a `code`, never a message match: participants.db.ts sniffs
 * /FOREIGN KEY/i on error messages today, and that fragility is not repeated
 * here. TypeScript callers use `instanceof`, the two .js call sites (agy-cli,
 * hermes-cli) check `err?.code === 'SESSION_TOMBSTONED'`.
 *
 * A plain Error, not AppError: the repository layer imports no HTTP error shape
 * (zero matches across repositories/*.ts), and inverting that dependency to
 * carry a status code would be worse than mapping at the boundary.
 */
export class SessionTombstonedError extends Error {
  readonly code = 'SESSION_TOMBSTONED';
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session ${sessionId} was deleted and must not be recreated`);
    this.name = 'SessionTombstonedError';
    this.sessionId = sessionId;
  }
}

export type SessionTombstoneInput = {
  sessionId: string;
  provider: string;
  projectPath?: string | null;
  /** The jsonl_path that was deleted; NULL means no artefact we own. */
  sourcePath?: string | null;
  deletedBy?: number | null;
};

export type SessionTombstoneRow = {
  sessionId: string;
  provider: string;
  projectPath: string | null;
  sourcePath: string | null;
  deletedAt: string;
  deletedBy: number | null;
};

type SessionTombstoneDbRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  source_path: string | null;
  deleted_at: string;
  deleted_by: number | null;
};

const toRow = (row: SessionTombstoneDbRow): SessionTombstoneRow => ({
  sessionId: row.session_id,
  provider: row.provider,
  projectPath: row.project_path,
  sourcePath: row.source_path,
  deletedAt: row.deleted_at,
  deletedBy: row.deleted_by,
});

export const sessionTombstonesDb = {
  /**
   * True when this id was deliberately deleted and must not be recreated.
   *
   * On the hot path: called once per session per full synchronize, i.e. ~400
   * times per sweep at current scale. Primary-key lookup, well under a
   * millisecond in aggregate.
   */
  isTombstoned(sessionId: string): boolean {
    if (!sessionId) return false;
    const db = getConnection();
    const row = db
      .prepare('SELECT 1 FROM session_tombstones WHERE session_id = ? LIMIT 1')
      .get(sessionId);
    return Boolean(row);
  },

  /**
   * Record deletions. NO internal transaction on purpose: this composes INSIDE
   * the caller's delete transaction, so the tombstone and the row removal commit
   * together — there is never an instant where the row is gone and unguarded.
   *
   * Idempotent via ON CONFLICT: re-deleting refreshes the provenance instead of
   * throwing, which matters because a bulk request may repeat an id.
   */
  recordTombstones(entries: SessionTombstoneInput[]): number {
    if (!entries.length) return 0;
    const db = getConnection();
    const stmt = db.prepare(
      `INSERT INTO session_tombstones
         (session_id, provider, project_path, source_path, deleted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         project_path = COALESCE(excluded.project_path, session_tombstones.project_path),
         source_path = COALESCE(excluded.source_path, session_tombstones.source_path),
         deleted_at = CURRENT_TIMESTAMP,
         deleted_by = COALESCE(excluded.deleted_by, session_tombstones.deleted_by)`
    );

    let written = 0;
    for (const entry of entries) {
      if (!entry?.sessionId) continue;
      stmt.run(
        entry.sessionId,
        entry.provider,
        entry.projectPath ?? null,
        entry.sourcePath ?? null,
        Number.isInteger(entry.deletedBy) ? entry.deletedBy : null
      );
      written += 1;
    }
    return written;
  },

  /** Operational read. Not wired to any request path — support/diagnostics only. */
  listTombstones(options: { projectPath?: string; provider?: string; limit?: number; offset?: number } = {}): SessionTombstoneRow[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.projectPath) {
      clauses.push('project_path = ?');
      params.push(options.projectPath);
    }
    if (options.provider) {
      clauses.push('provider = ?');
      params.push(options.provider);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit as number, 1), 500) : 100;
    const offset = Number.isInteger(options.offset) ? Math.max(options.offset as number, 0) : 0;

    const rows = db
      .prepare(
        `SELECT session_id, provider, project_path, source_path, deleted_at, deleted_by
           FROM session_tombstones ${where}
          ORDER BY deleted_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as SessionTombstoneDbRow[];

    return rows.map(toRow);
  },
};

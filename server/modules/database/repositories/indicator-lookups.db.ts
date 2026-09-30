/**
 * B-1431 — batched, read-only lookups behind the sidebar's project indicators.
 *
 * Kept apart from projects.db / sessions.db on purpose: those files are pinned
 * by the session/project writer inventory (T-1634), and nothing here writes.
 * Every query is a fixed number of round trips regardless of input size.
 */

import { getConnection } from '@/modules/database/connection.js';

/** Session columns a deep-link context needs (mirrors getSessionById's pick). */
export type IndicatorSessionRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string | null;
  updated_at: string | null;
};

/**
 * project_path -> project_id for every ACTIVE project, in one query. Attaches a
 * DB project id (never a path) to indicator payloads without a lookup per run
 * or session. project_path is UNIQUE, so the map is exact.
 */
function getActiveProjectIdsByPath(): Map<string, string> {
  const rows = getConnection()
    .prepare('SELECT project_id, project_path FROM projects WHERE isArchived = 0')
    .all() as Array<{ project_id: string; project_path: string }>;
  return new Map(rows.map((row) => [row.project_path, row.project_id]));
}

/**
 * Batched session read (no N+1). Rows come back newest-first, so a caller that
 * keeps the FIRST row per id matches getSessionById's
 * `ORDER BY updated_at DESC LIMIT 1` pick.
 */
function getSessionsByIds(sessionIds: readonly string[]): IndicatorSessionRow[] {
  if (sessionIds.length === 0) {
    return [];
  }
  const placeholders = sessionIds.map(() => '?').join(', ');
  return getConnection()
    .prepare(
      `SELECT session_id, provider, project_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
        WHERE session_id IN (${placeholders})
     ORDER BY updated_at DESC`
    )
    .all(...sessionIds) as IndicatorSessionRow[];
}

export const indicatorLookupsDb = {
  getActiveProjectIdsByPath,
  getSessionsByIds,
};

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getConnection, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

function uniqueJsonlPathsFromSessions(
  sessions: Array<{ jsonl_path: string | null }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const row of sessions) {
    const raw = row.jsonl_path?.trim();
    if (!raw) {
      continue;
    }
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    result.push(absolute);
  }

  return result;
}

async function unlinkJsonlIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    console.warn(`[project-delete] Failed to remove ${filePath}:`, (error as Error).message);
  }
}

/**
 * Loads all session rows for the project path and removes each distinct `jsonl_path` file on disk.
 */
export async function deleteSessionJsonlFilesForProjectPath(projectPath: string): Promise<void> {
  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
  const paths = uniqueJsonlPathsFromSessions(sessions);

  for (const filePath of paths) {
    await unlinkJsonlIfExists(filePath);
  }
}

/**
 * Removes the `sessions` rows for a path and the `projects` row itself in ONE
 * transaction.
 *
 * As three independent writes this was a data-loss window: `sessions` declares
 * `project_path REFERENCES projects(project_path) ON DELETE SET NULL`, so any
 * row the synchronizer inserted for that path after the session delete but
 * before the project delete did not get removed — it got its `project_path`
 * nulled instead. A session row with a NULL project_path belongs to no project,
 * appears in no sidebar, and there is no path back: the value that said where it
 * came from is the value that was erased. Committing both writes atomically
 * removes the window entirely.
 *
 * The follow-up sweeps are cheap and deliberate: by path (a row re-inserted for
 * the same path) and by the ids captured up front (a row whose project_path was
 * nulled). Both are no-ops in the normal case and log if they ever fire, since
 * that would mean a write reached the table from outside this transaction.
 */
function deleteProjectRowsAtomically(projectId: string, projectPath: string): void {
  const db = getConnection();

  const run = db.transaction(() => {
    const priorSessionIds = (
      db.prepare('SELECT session_id FROM sessions WHERE project_path = ?').all(projectPath) as Array<{
        session_id: string;
      }>
    ).map((sessionRow) => sessionRow.session_id);

    sessionsDb.deleteSessionsByProjectPath(projectPath);
    projectsDb.deleteProjectById(projectId);

    const reinserted = db
      .prepare('DELETE FROM sessions WHERE project_path = ?')
      .run(projectPath).changes;

    let orphaned = 0;
    if (priorSessionIds.length > 0) {
      const placeholders = priorSessionIds.map(() => '?').join(', ');
      orphaned = db
        .prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`)
        .run(...priorSessionIds).changes;
    }

    if (reinserted > 0 || orphaned > 0) {
      console.warn('[project-delete] Swept session rows written during project deletion', {
        projectPath,
        reinserted,
        orphaned,
      });
    }
  });

  run();
}

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): remove the session rows and the `projects` row in one transaction, then delete
 *   each session's `jsonl_path` file from disk.
 *
 * Ordering is deliberate: the database commit happens FIRST and the (non
 * transactional, irreversible) file deletions only after it succeeds. Removing
 * files first would leave rows pointing at transcripts that no longer exist if
 * the commit then failed.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    return;
  }

  // Collect the transcript paths BEFORE the rows are gone — they are only
  // recoverable from those rows.
  const jsonlPaths = uniqueJsonlPathsFromSessions(
    sessionsDb.getSessionsByProjectPathIncludingArchived(row.project_path),
  );

  deleteProjectRowsAtomically(projectId, row.project_path);

  for (const filePath of jsonlPaths) {
    await unlinkJsonlIfExists(filePath);
  }
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
}

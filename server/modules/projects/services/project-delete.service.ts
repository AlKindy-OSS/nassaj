import {
  getConnection, projectsDb, revokeSharesByProject, rotateProjectStructureForPath, sessionsDb,
} from '@/modules/database/index.js';
import { purgeProjectLogoFiles } from '@/modules/projects/services/project-logo.service.js';
import {
  createRemovalContext, isRetryableRefusal, probeSessionTranscript, removeSessionTranscript, type TranscriptRemoval,
} from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

type TranscriptRow = { session_id: string; provider: string; jsonl_path: string | null };

/**
 * Session rows that record a transcript, one per distinct recorded path (the
 * first row wins), in row order. Only the fields the removal primitive needs.
 */
function transcriptRowsOf(sessions: TranscriptRow[]): TranscriptRow[] {
  const seen = new Set<string>();
  const result: TranscriptRow[] = [];
  for (const row of sessions) {
    const recorded = row.jsonl_path?.trim();
    if (!recorded || seen.has(recorded)) continue;
    seen.add(recorded);
    result.push({ session_id: row.session_id, provider: row.provider, jsonl_path: row.jsonl_path });
  }
  return result;
}

/**
 * T8 (B-1608): transcripts handled at once. Measured on a sandbox project of
 * 2,000 Claude sessions (each with a subagent dir): ~10 s one by one. Every
 * removal works on its own file and directory names, so they are independent.
 */
const TRANSCRIPT_CONCURRENCY = 8;

/** `task` over `items` with at most `limit` in flight; results in item order. */
async function mapBounded<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await task(items[index]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** What happened to the recorded transcripts of a force-deleted project (B-1596). */
export type TranscriptRemovalSummary = { removed: number; keptForSafety: number; failed: number };

export type ProjectDeleteOutcome = { transcripts?: TranscriptRemovalSummary };

/**
 * Admission check BEFORE the commit: a retryable refusal (I/O, a concurrent
 * change) refuses the whole delete with 409 while nothing has changed, so the
 * user can retry. Security refusals do not block: their files are kept.
 */
async function assertTranscriptsRemovable(rows: TranscriptRow[]): Promise<void> {
  const refusals = await mapBounded(rows, TRANSCRIPT_CONCURRENCY, (row) => probeSessionTranscript(row, 'project-delete'));
  if (refusals.some((refusal) => refusal !== null && isRetryableRefusal(refusal))) {
    throw new AppError('A conversation file could not be checked right now. Nothing was deleted; please try again.', {
      code: 'TRANSCRIPT_REMOVAL_RETRY', statusCode: 409,
    });
  }
}

/**
 * Removes each row's transcript through the confined primitive (B-1596),
 * at most {@link TRANSCRIPT_CONCURRENCY} at a time, after the commit. Never throws: a file refused for safety is kept,
 * and a retryable failure at this point (the rows are already gone) is counted
 * as `failed` so the response does not claim a clean removal.
 */
async function removeTranscripts(rows: TranscriptRow[]): Promise<TranscriptRemovalSummary> {
  const summary: TranscriptRemovalSummary = { removed: 0, keptForSafety: 0, failed: 0 };
  // One context for the whole delete: each Codex day directory is indexed once (B-1607/T8).
  const context = createRemovalContext();
  const removals: TranscriptRemoval[] = await mapBounded(rows, TRANSCRIPT_CONCURRENCY,
    (row) => removeSessionTranscript(row, 'project-delete', context));
  for (const removal of removals) {
    if (removal.removed) summary.removed += 1;
    else if (isRetryableRefusal(removal.reason)) summary.failed += 1;
    else if (removal.reason !== 'missing') summary.keptForSafety += 1;
  }
  return summary;
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

    // ADR-196: null every share blob before the project row cascades the shares away.
    revokeSharesByProject(db, projectId, 'project_gone');
    sessionsDb.deleteSessionsByProjectPath(projectPath);
    projectsDb.deleteProjectById(projectId, { deferFenceRotation: true });

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
  rotateProjectStructureForPath(projectId, projectPath, { retireProjectId: true });
}

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): check every recorded transcript is admissible (a retryable refusal → 409,
 *   nothing changed), remove the session rows and the `projects` row in one transaction, then remove each
 *   transcript through the confined primitive (B-1596). The outcome counts removed, kept-for-safety and
 *   failed files; a failure after the commit is reported, never silently claimed as removed.
 *
 * Ordering is deliberate: the database commit happens FIRST and the (non
 * transactional, irreversible) file deletions only after it succeeds. Removing
 * files first would leave rows pointing at transcripts that no longer exist if
 * the commit then failed.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<ProjectDeleteOutcome> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    revokeSharesByProject(getConnection(), projectId, 'project_archived');
    return {};
  }

  // Collect the transcript rows BEFORE the rows are gone — they are only
  // recoverable from those rows.
  const transcripts = transcriptRowsOf(sessionsDb.getSessionsByProjectPathIncludingArchived(row.project_path));
  await assertTranscriptsRemovable(transcripts);

  deleteProjectRowsAtomically(projectId, row.project_path);

  const summary = await removeTranscripts(transcripts);
  if (summary.failed > 0) {
    console.warn('[project-delete] Some transcripts could not be removed after the commit', { projectId, ...summary });
  }

  // The row that pointed at the logo file is gone, so nothing would ever clean
  // it up again. Best-effort and last: a failure here must not turn a completed
  // deletion into an error.
  await purgeProjectLogoFiles(projectId);
  return { transcripts: summary };
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

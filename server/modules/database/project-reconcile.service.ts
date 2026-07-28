/**
 * Project-reconcile service (B-38, B-150).
 *
 * At server boot (and every 6 hours thereafter) this service scans every
 * active project row in the database and checks whether its directory exists
 * on disk. Projects whose folder is *confirmed* gone are soft-archived
 * (isArchived = 1) — no rows are deleted, so data is never lost.
 *
 * Design constraints:
 *  - No deletion: missing folder → isArchived = 1 + log. Hard-delete is a
 *    user action (project-delete.service.ts).
 *  - Confirmed-missing only (B-150): a project is archived ONLY when its path
 *    probe returns ENOENT (definitively absent). Any other error — EACCES,
 *    EIO, ENOTDIR, a timeout, or a mount flapping in/out — is treated as
 *    inconclusive and the project is skipped, never archived on a guess, so a
 *    transient filesystem hiccup can no longer make live projects vanish.
 *  - Auto-recovery (B-150): a project this service archived is remembered in
 *    `reconcile_archived_projects`. If its folder reappears in a later pass it
 *    is unarchived automatically (reusing projectsDb.updateProjectIsArchivedById).
 *    Only projects WE archived are eligible, so a project a user archived by
 *    hand is never resurrected.
 *  - No conflict with the session synchronizer: the synchronizer operates on
 *    the sessions table; this service touches only the projects table (plus its
 *    own tracking table). Writes are one-row UPDATE/INSERT statements.
 *  - The timer is intentionally coarse (6 h): it is not a realtime watcher.
 *    The filesystem check is async so it never blocks the event loop.
 *  - `stopReconcileScheduler()` cancels the interval — used in tests and
 *    graceful shutdown.
 */

import fs from 'node:fs/promises';

import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';

// ---------------------------------------------------------------------------
// Reconcile-archive tracking
// ---------------------------------------------------------------------------

/**
 * Records which projects THIS service archived (confirmed-missing path) so that
 * only those are eligible for auto-recovery — a project the user archived by
 * hand is never listed here and so is never auto-unarchived.
 *
 * Created idempotently on first use and kept out of INIT_SCHEMA_SQL on purpose:
 * it is tiny, keyed by its PRIMARY KEY, and needs no separate index (see the
 * "502 lesson" — index migration-added structures in migrations, not at init).
 */
const RECONCILE_ARCHIVE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reconcile_archived_projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

type FsProbe = 'exists' | 'missing' | 'transient';

/**
 * Classifies a project path:
 *  - 'exists'    : the path is present.
 *  - 'missing'   : confirmed absent (ENOENT) — safe to archive.
 *  - 'transient' : any other error (EACCES / EIO / ENOTDIR / timeout / a mount
 *                  flapping) — the path's real state is unknown, so callers must
 *                  NOT archive on it.
 */
async function probeProjectPath(projectPath: string): Promise<FsProbe> {
  try {
    await fs.access(projectPath);
    return 'exists';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' ? 'missing' : 'transient';
  }
}

// ---------------------------------------------------------------------------
// Core reconcile logic (exported for direct use + tests)
// ---------------------------------------------------------------------------

export type ReconcileResult = {
  /** Total active (non-archived) projects inspected. */
  checked: number;
  /** Projects newly archived because their folder was confirmed missing. */
  archived: number;
  /** project_ids that were archived in this run. */
  archivedIds: string[];
  /** Projects auto-recovered because their folder reappeared. */
  recovered: number;
  /** project_ids that were unarchived in this run. */
  recoveredIds: string[];
  /** Active projects skipped because their path probe was inconclusive. */
  skipped: number;
  /** project_ids whose probe was transient/inconclusive this run. */
  skippedIds: string[];
};

/**
 * Checks every active project in the database and archives those whose
 * directory no longer exists on disk.
 *
 * Safe to call concurrently: each UPDATE is keyed by project_id and operates
 * only on rows where isArchived = 0, so a double-run is idempotent.
 */
export type ReconcileDeps = {
  /**
   * Path classifier — injectable so tests can drive the transient/missing/exists
   * branches deterministically without staging real EACCES/EIO conditions.
   * Defaults to the real filesystem probe.
   */
  probe?: (projectPath: string) => Promise<FsProbe>;
};

export async function reconcileProjects(deps: ReconcileDeps = {}): Promise<ReconcileResult> {
  const probePath = deps.probe ?? probeProjectPath;
  const db = getConnection();
  db.exec(RECONCILE_ARCHIVE_TABLE_SQL);

  const forgetStmt = db.prepare('DELETE FROM reconcile_archived_projects WHERE project_id = ?');

  // --- Auto-recovery pass (B-150) ----------------------------------------
  // Only projects WE archived (tracked below) are eligible; a project the user
  // archived by hand is never in this set, so their intent is preserved.
  type TrackedRow = { project_id: string; project_path: string };
  const trackedArchived = db
    .prepare(
      `SELECT p.project_id AS project_id, p.project_path AS project_path
       FROM reconcile_archived_projects r
       JOIN projects p ON p.project_id = r.project_id
       WHERE p.isArchived = 1`
    )
    .all() as TrackedRow[];

  const recoveredIds: string[] = [];
  const recoveries = trackedArchived.map(async (row) => {
    const probe = await probePath(row.project_path);
    if (probe === 'exists') {
      // Reuse the existing DB-layer unarchive (mirrors the archive route).
      projectsDb.updateProjectIsArchivedById(row.project_id, false);
      forgetStmt.run(row.project_id);
      recoveredIds.push(row.project_id);
      console.log('[reconcile] Project folder reappeared — unarchived:', {
        project_id: row.project_id,
        project_path: row.project_path,
      });
    }
    // 'missing' → still gone, keep archived + keep tracking.
    // 'transient' → inconclusive, leave everything as-is for the next pass.
  });
  await Promise.all(recoveries);

  // Drop tracking rows whose project is no longer archived (user unarchived it)
  // or was hard-deleted, so the tracking table cannot leak rows over time.
  db.prepare(
    `DELETE FROM reconcile_archived_projects
     WHERE project_id NOT IN (SELECT project_id FROM projects WHERE isArchived = 1)`
  ).run();

  // --- Archive pass -------------------------------------------------------
  type ProjectRow = { project_id: string; project_path: string };
  const activeProjects = db
    .prepare(
      `SELECT project_id, project_path
       FROM projects
       WHERE isArchived = 0`
    )
    .all() as ProjectRow[];

  const archiveStmt = db.prepare(
    `UPDATE projects
     SET isArchived = 1
     WHERE project_id = ? AND isArchived = 0`
  );
  const rememberStmt = db.prepare(
    `INSERT INTO reconcile_archived_projects (project_id)
     VALUES (?)
     ON CONFLICT(project_id) DO UPDATE SET archived_at = CURRENT_TIMESTAMP`
  );

  const archivedIds: string[] = [];
  const skippedIds: string[] = [];

  // Check existence in parallel — avoids sequential disk round-trips for
  // large project lists while staying non-blocking on the event loop.
  const checks = activeProjects.map(async (row) => {
    const probe = await probePath(row.project_path);

    if (probe === 'exists') {
      return;
    }

    if (probe === 'transient') {
      // Transient FS failure (EACCES / EIO / mount flap): do NOT archive on a
      // guess — a temporary error must never make a live project disappear.
      skippedIds.push(row.project_id);
      console.warn('[reconcile] Project path probe inconclusive — skipping archive:', {
        project_id: row.project_id,
        project_path: row.project_path,
      });
      return;
    }

    // probe === 'missing' (confirmed ENOENT): archive + remember so it can be
    // auto-recovered if the folder ever reappears.
    const changes = archiveStmt.run(row.project_id).changes;
    if (changes > 0) {
      rememberStmt.run(row.project_id);
      console.log('[reconcile] Project folder missing — archived:', {
        project_id: row.project_id,
        project_path: row.project_path,
      });
      archivedIds.push(row.project_id);
    }
  });

  await Promise.all(checks);

  return {
    checked: activeProjects.length,
    archived: archivedIds.length,
    archivedIds,
    recovered: recoveredIds.length,
    recoveredIds,
    skipped: skippedIds.length,
    skippedIds,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the project-reconcile scheduler.
 *
 * Runs one reconcile pass immediately on boot, then again every 6 hours.
 * Calling this more than once is safe — a running scheduler is stopped and
 * replaced so there is never more than one timer.
 *
 * Integration note (server/index.js): call `startReconcileScheduler()` after
 * `initializeDatabase()` completes. No import of server/index.js is required
 * here — the coupling is one-directional.
 */
export function startReconcileScheduler(): void {
  // Clear any existing timer so hot-reloads or double-init are safe.
  stopReconcileScheduler();

  // Immediate first pass — catches stale paths on boot without waiting 6 h.
  void reconcileProjects().then((result) => {
    if (result.archived > 0) {
      console.log('[reconcile] Boot pass complete:', result);
    }
  }).catch((err: unknown) => {
    console.error('[reconcile] Boot pass failed:', err);
  });

  reconcileTimer = setInterval(() => {
    void reconcileProjects().then((result) => {
      if (result.archived > 0) {
        console.log('[reconcile] Scheduled pass complete:', result);
      }
    }).catch((err: unknown) => {
      console.error('[reconcile] Scheduled pass failed:', err);
    });
  }, RECONCILE_INTERVAL_MS);

  // Allow the Node.js process to exit even if this timer is still pending.
  reconcileTimer.unref();
}

/**
 * Cancels the reconcile scheduler. Used in tests and graceful shutdown.
 */
export function stopReconcileScheduler(): void {
  if (reconcileTimer !== null) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

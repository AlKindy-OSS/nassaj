import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { rotateProjectStructureForPath } from '@/modules/database/repositories/project-access.js';
import { notifyProjectTransfer } from '@/modules/database/repositories/session-project-transfer-events.js';
import {
  OPERATOR_TREE,
  isCrossMemberPath,
  isSameSourceTree,
  memberTreeKey,
  sourceTreeKeys,
} from '@/modules/database/repositories/session-source-tree.js';
import { isForeignTempRootPath } from '@/modules/database/temp-root-guard.js';
import { isForeignTestRunPath } from '@/modules/database/test-run-root-guard.js';
import { parseStoredTimestampMs } from '@/modules/database/utils/timestamps.js';
import { logicalProjectPathForWorkspace } from '@/modules/session-workspaces/index.js';
import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
// eslint-disable-next-line boundaries/no-unknown -- shared guard (B-1373), same seam as project-management
import { isForbiddenProjectRoot } from '@/shared/secret-path-guard.js';
import { pathHasGitDirSegment } from '../../../../shared/git-safety.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * Discovery writers for the `sessions` table (ADR-201 A2).
 *
 * Every synchronizer and launch writer records a session through
 * {@link insertDiscoveredSession} (new id only) or
 * {@link refreshDiscoveredSession} (existing row), usually via the atomic
 * dispatcher {@link recordDiscoveredSession}. A refresh never rebinds a row:
 *   - `provider` never changes (a mismatch refuses the whole refresh);
 *   - `project_path` changes only agy placeholder → real workspace (case c) or
 *     to the canonical form of the stored value, `normalize(old) === new` (d);
 *   - `jsonl_path` changes only to a file in the same member tree as the stored
 *     path (a, b); a NULL stored path (g) is filled only from the tree of a
 *     credential principal (or own tree) of a recorded spawn participant, or the
 *     operator/shared root. A refused source writes nothing at all — its name
 *     and timestamps are as untrusted as its path;
 *   - otherwise only timestamps and the name are written.
 * Conflicts are logged once per (session, candidate) per process; no table, no
 * repair. Explicit migration/transfer paths (e, f) do not come through here.
 * Synchronizers pass `origin: 'watcher'` and are refused temp-root cwds that no
 * user registered (B-1620); launch writers keep the default 'launch'.
 */

/**
 * Who is recording the session. 'watcher' = a provider synchronizer indexing a
 * transcript it found on disk; 'launch' = a writer that started (or authorizes)
 * the run itself. Only 'watcher' is subject to the B-1620 temp-root rule.
 */
export type DiscoveryOrigin = 'watcher' | 'launch';

export type DiscoveredSession = {
  sessionId: string;
  provider: string;
  projectPath: string;
  customName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Transcript path; null/undefined means "unknown here" and never clears a stored path. */
  jsonlPath?: string | null;
  /** Defaults to 'launch' so launch writers are never affected by the temp-root rule. */
  origin?: DiscoveryOrigin;
};

export type InsertOutcome = 'inserted' | 'exists' | 'skipped';
export type RefreshOutcome = 'refreshed' | 'refused' | 'missing' | 'skipped';

type StoredSessionRow = { provider: string; project_path: string | null; jsonl_path: string | null };

type RefreshPlan =
  | { refused: true; reason: string }
  | { refused: false; projectPath: string; jsonlPath: string | null; projectReason: string | null };

type PostCommit = { transferred: boolean; createdProject: { id: string; path: string } | null };

export const ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH = '/__antigravity__';

/** SQL "now" in the ISO-8601 UTC form normalizeDiscoveryTimestamp writes. */
export const NOW_ISO_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/** Any accepted timestamp form → ISO-8601 UTC, or null. */
export function normalizeDiscoveryTimestamp(value?: string): string | null {
  if (!value) return null;
  const epoch = parseStoredTimestampMs(value);
  return epoch === null ? null : new Date(epoch).toISOString();
}

/** Canonical stored form of a project path (overlay → logical root, normalized). */
export function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(logicalProjectPathForWorkspace(projectPath));
}

const warnedForeignTestRunPaths = new Set<string>();
const warnedForbiddenProjectRoots = new Set<string>();
const warnedTempRootPaths = new Set<string>();
const MAX_WARNED_TEMP_ROOT_PATHS = 10_000;
const warnedConflicts = new Set<string>();
const MAX_WARNED_CONFLICTS = 10_000;

/**
 * Logs a refused rebind once per (session, reason, candidate) per process.
 * Only the session id, provider and reason are logged — never a path or
 * content that could belong to another member.
 */
function warnSourceConflict(sessionId: string, provider: string, reason: string, candidate: string): void {
  const key = `${sessionId}\0${reason}\0${candidate}`;
  if (warnedConflicts.has(key)) return;
  if (warnedConflicts.size >= MAX_WARNED_CONFLICTS) warnedConflicts.clear();
  warnedConflicts.add(key);
  console.warn('Refused session source change (ADR-201)', { sessionId, provider, reason });
}

/** True when a user explicitly registered `projectPath` (archived rows included). */
function isUserRegisteredProject(projectPath: string): boolean {
  return Boolean(getConnection()
    .prepare('SELECT 1 FROM projects WHERE project_path = ? AND created_by IS NOT NULL')
    .get(projectPath));
}

/**
 * B-1620: true when synchronizers must not write for a session at the canonical
 * `projectPath` — it lies under a temp root foreign to the active database and
 * no user registered it as a project. Rows already stored there are frozen.
 */
export function isWatcherFrozenProjectPath(projectPath: string | null): boolean {
  if (!projectPath) return false;
  return isForeignTempRootPath(projectPath) && !isUserRegisteredProject(projectPath);
}

/**
 * B-1620: a synchronizer ('watcher') never records — inserts or refreshes — a
 * session whose cwd is under a temp root foreign to the active database, unless
 * a user registered that path as a project. Launch writers are exempt. Existing
 * rows under such paths are frozen, not deleted; the skipped run's cost lands
 * as unattributed in the cost ledger. Warned once per path, without the path.
 */
function isRefusedTempRootPath(input: DiscoveredSession, normalized: string): boolean {
  if ((input.origin ?? 'launch') !== 'watcher' || !isWatcherFrozenProjectPath(normalized)) return false;
  if (!warnedTempRootPaths.has(normalized)) {
    if (warnedTempRootPaths.size >= MAX_WARNED_TEMP_ROOT_PATHS) warnedTempRootPaths.clear();
    warnedTempRootPaths.add(normalized);
    console.warn('Skipped session discovered under a temporary root', { provider: input.provider });
  }
  return true;
}

/**
 * The canonical project path for `input`, or null when the path must not be
 * registered at all: B-1420 foreign test root, B-1373 protected root, or
 * (synchronizers only) a B-1620 unregistered temp root.
 */
function admissibleProjectPath(input: DiscoveredSession): string | null {
  const normalized = normalizeProjectPathForProvider(input.provider, input.projectPath);
  if (isRefusedTempRootPath(input, normalized)) return null;
  if (isForeignTestRunPath(normalized)) {
    if (!warnedForeignTestRunPaths.has(normalized)) {
      warnedForeignTestRunPaths.add(normalized);
      console.warn('Skipped session discovered under a foreign test run root', { provider: input.provider });
    }
    return null;
  }
  // B-1691 (qa F8): a session cwd inside `.git` (not an overlay, which maps to
  // its logical project above) never registers a project.
  const refusedRoot = isForbiddenProjectRoot(normalized) || pathHasGitDirSegment(normalized);
  if (refusedRoot && !projectsDb.getProjectPath(normalized)) {
    if (!warnedForbiddenProjectRoots.has(normalized)) {
      warnedForbiddenProjectRoots.add(normalized);
      console.warn('Skipped session discovered under a protected root', { provider: input.provider });
    }
    return null;
  }
  return normalized;
}

/** Credential-grant key for a session provider ('antigravity' rows are granted as 'agy'). */
function grantProviderKey(provider: string): string {
  return provider === 'antigravity' ? 'agy' : provider;
}

/**
 * Trees allowed to fill a NULL `jsonl_path` (case g): the operator/shared root,
 * plus each recorded spawn participant's own tree and credential-principal tree.
 */
function allowedFillTrees(db: Database, sessionId: string, provider: string): Set<string> {
  const allowed = new Set([OPERATOR_TREE]);
  const rows = db.prepare('SELECT DISTINCT user_id FROM session_participants WHERE session_id = ?')
    .all(sessionId) as Array<{ user_id: number | string }>;
  for (const { user_id: userId } of rows) {
    allowed.add(memberTreeKey(userId));
    const principal = credentialPrincipalId(userId, grantProviderKey(provider));
    if (principal !== null && principal !== undefined) allowed.add(memberTreeKey(principal));
  }
  return allowed;
}

/** Null when `candidate` may become the row's `jsonl_path`, else the refusal reason. */
function jsonlRefusal(db: Database, sessionId: string, row: StoredSessionRow, candidate: string): string | null {
  if (isCrossMemberPath(candidate)) return 'jsonl_path_cross_member';
  if (row.jsonl_path) {
    return isSameSourceTree(row.jsonl_path, candidate) ? null : 'jsonl_path_other_tree';
  }
  const keys = sourceTreeKeys(candidate);
  if (keys.size === 0) return 'jsonl_path_invalid';
  const allowed = allowedFillTrees(db, sessionId, row.provider);
  return [...keys].every((key) => allowed.has(key)) ? null : 'jsonl_path_fill_non_participant_tree';
}

/** True when an existing `project_path` may become `next` (cases c and d). */
function isAllowedProjectChange(row: StoredSessionRow, next: string): boolean {
  const old = row.project_path;
  if (!old) return true;
  if (row.provider === 'antigravity' && old === ANTIGRAVITY_PLACEHOLDER_PROJECT_PATH) return true;
  return normalizeProjectPathForProvider(row.provider, old) === next;
}

/** Decides what a refresh of `row` from `input` may write. Pure apart from reads. */
function planRefresh(db: Database, row: StoredSessionRow, input: DiscoveredSession, nextPath: string): RefreshPlan {
  if (row.provider !== input.provider) return { refused: true, reason: 'provider_relabel' };
  const candidate = input.jsonlPath?.trim() || null;
  let jsonlPath = row.jsonl_path;
  if (candidate && candidate !== row.jsonl_path) {
    const reason = jsonlRefusal(db, input.sessionId, row, candidate);
    if (reason) return { refused: true, reason };
    jsonlPath = candidate;
  }
  if (row.project_path === nextPath || isAllowedProjectChange(row, nextPath)) {
    return { refused: false, projectPath: nextPath, jsonlPath, projectReason: null };
  }
  return { refused: false, projectPath: row.project_path as string, jsonlPath, projectReason: 'project_path_move' };
}

/** ADR-187: a project change never silently keeps human-room grants. */
function revalidateRoomGrants(db: Database, sessionId: string): void {
  const hasRooms = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='session_internal_rooms'`).get();
  if (!hasRooms) return;
  db.prepare(`UPDATE session_internal_rooms
    SET membership_state='revalidation_required', version=version+1, updated_at=CURRENT_TIMESTAMP
    WHERE session_id=?`).run(sessionId);
}

function readStoredRow(db: Database, sessionId: string): StoredSessionRow | undefined {
  return db.prepare('SELECT provider, project_path, jsonl_path FROM sessions WHERE session_id = ?')
    .get(sessionId) as StoredSessionRow | undefined;
}

/** Ensures the project row exists (B-963: never un-archives) and notes a new one for fence rotation. */
function noteCreatedProject(post: PostCommit, projectPath: string): void {
  const id = projectsDb.ensureProjectPathForSession(projectPath, { deferFenceRotation: true });
  if (id) post.createdProject = { id, path: projectPath };
}

/**
 * Inserts a new row inside the caller's transaction. Archival starts at 0 and
 * the engine-pin columns are deliberately absent (ADR-088): their sole writer
 * is setSessionEnginePin.
 */
function insertRow(db: Database, input: DiscoveredSession, projectPath: string, post: PostCommit): void {
  noteCreatedProject(post, projectPath);
  db.prepare(
    `INSERT INTO sessions (session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, COALESCE(?, ${NOW_ISO_SQL}), COALESCE(?, ${NOW_ISO_SQL}))`
  ).run(
    input.sessionId, input.provider, input.customName ?? null, projectPath, input.jsonlPath?.trim() || null,
    normalizeDiscoveryTimestamp(input.createdAt), normalizeDiscoveryTimestamp(input.updatedAt),
  );
}

/**
 * Applies a refresh inside the caller's transaction. isArchived (B-161) and the
 * engine pin (ADR-088) are never touched.
 */
function refreshRow(
  db: Database, row: StoredSessionRow, input: DiscoveredSession, nextPath: string, post: PostCommit,
): RefreshOutcome {
  const plan = planRefresh(db, row, input, nextPath);
  if (plan.refused) {
    warnSourceConflict(input.sessionId, row.provider, plan.reason, `${input.provider}\0${input.jsonlPath ?? ''}`);
    return 'refused';
  }
  if (plan.projectReason) warnSourceConflict(input.sessionId, row.provider, plan.projectReason, nextPath);
  if (plan.projectPath !== row.project_path) {
    noteCreatedProject(post, plan.projectPath);
  }
  db.prepare(
    `UPDATE sessions SET updated_at = COALESCE(?, ${NOW_ISO_SQL}), project_path = ?, jsonl_path = ?,
       custom_name = COALESCE(?, custom_name)
     WHERE session_id = ?`
  ).run(normalizeDiscoveryTimestamp(input.updatedAt), plan.projectPath, plan.jsonlPath, input.customName ?? null,
    input.sessionId);
  if (plan.projectPath !== row.project_path) {
    revalidateRoomGrants(db, input.sessionId);
    post.transferred = true;
  }
  return 'refreshed';
}

/** Runs `body` in an IMMEDIATE transaction, then the post-commit effects. */
function withDiscoveryTransaction<T>(
  sessionId: string, body: (db: Database, post: PostCommit) => T,
): T {
  const db = getConnection();
  const post: PostCommit = { transferred: false, createdProject: null };
  const result = db.transaction(() => body(db, post)).immediate();
  if (post.transferred) notifyProjectTransfer(sessionId);
  // The new project may be a lexical alias of a registered physical root.
  if (post.createdProject) rotateProjectStructureForPath(post.createdProject.id, post.createdProject.path);
  return result;
}

/**
 * H1: a new row is never recorded from a path whose lexical and physical
 * member trees differ (logged once, nothing written).
 */
function isCrossMemberCandidate(input: DiscoveredSession): boolean {
  const candidate = input.jsonlPath?.trim() || null;
  if (!candidate || !isCrossMemberPath(candidate)) return false;
  warnSourceConflict(input.sessionId, input.provider, 'jsonl_path_cross_member', candidate);
  return true;
}

/**
 * Inserts a session row for an id that has none. An existing row is left
 * untouched ('exists'); a foreign-test, protected or (watcher) temp path is skipped.
 */
export function insertDiscoveredSession(input: DiscoveredSession): InsertOutcome {
  const projectPath = admissibleProjectPath(input);
  if (projectPath === null || isCrossMemberCandidate(input)) return 'skipped';
  return withDiscoveryTransaction(input.sessionId, (db, post) => {
    if (readStoredRow(db, input.sessionId)) return 'exists';
    insertRow(db, input, projectPath, post);
    return 'inserted';
  });
}

/**
 * Refreshes an existing row under the no-rebind rules above. A missing row is
 * never created ('missing').
 */
export function refreshDiscoveredSession(input: DiscoveredSession): RefreshOutcome {
  const projectPath = admissibleProjectPath(input);
  if (projectPath === null) return 'skipped';
  return withDiscoveryTransaction(input.sessionId, (db, post) => {
    const row = readStoredRow(db, input.sessionId);
    return row ? refreshRow(db, row, input, projectPath, post) : 'missing';
  });
}

/**
 * Atomic dispatcher: inserts when the id has no row, otherwise refreshes it,
 * in one IMMEDIATE transaction. Returns the session id (callers' contract).
 */
export function recordDiscoveredSession(input: DiscoveredSession): string {
  const projectPath = admissibleProjectPath(input);
  if (projectPath === null) return input.sessionId;
  withDiscoveryTransaction(input.sessionId, (db, post) => {
    const row = readStoredRow(db, input.sessionId);
    if (row) refreshRow(db, row, input, projectPath, post);
    else if (!isCrossMemberCandidate(input)) insertRow(db, input, projectPath, post);
  });
  return input.sessionId;
}

/**
 * True when a child transcript at `childPath` sits in the same source tree as
 * the parent row's recorded transcript; used to gate freshness bumps from
 * derivative files (Codex child threads).
 */
export function isChildInParentTree(parentSessionId: string, childPath: string): boolean {
  const row = readStoredRow(getConnection(), parentSessionId);
  if (!row) return false;
  if (isSameSourceTree(row.jsonl_path, childPath)) return true;
  warnSourceConflict(parentSessionId, row.provider, 'child_other_tree', childPath);
  return false;
}

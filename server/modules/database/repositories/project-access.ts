/**
 * Project membership access (ADR-172).
 *
 * One predicate answers "may this user reach this project at all?":
 *   canAccessProject = canSeeAllProjects (platform role owner|admin)
 *                      OR an explicit project_members row
 *                      OR projects.created_by.
 *
 * SAFE ROLLOUT: the read/write gates in projects.db.ts only delegate here when
 * PROJECT_MEMBERSHIP_ENFORCE is on. With the flag off they keep the ADR-089
 * behaviour byte-for-byte, so the owner can review the gain/loss report
 * (scripts/project-membership-seed.mjs) before any user loses access.
 *
 * `isPlatformOwner` (B-PRIV, role === 'owner' only) is deliberately NOT touched:
 * admin gains project visibility here and nothing else. Private sessions stay
 * governed by ADR-052 — this predicate never widens session visibility.
 *
 * The role is always read from the users table, never from the request, so a
 * demotion takes effect on the next check. Prepared statements only.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import { WORKSPACES_ROOT, normalizeProjectPath } from '@/shared/utils.js';

const ALL_PROJECTS_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);
const TRUE_FLAG_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'on', 'yes']);

type OpaqueFenceToken = Readonly<{ nonce: symbol }>;

/** One-process race fence. Tokens are object identities and are never serialized or reused. */
export type ProjectAccessFence = Readonly<{
  kind: 'project';
  processInstance: object;
  projectId: string;
  userId: number;
  subjectAccessToken: object;
  projectStructureToken: object;
}>;

/** One-process topology fence for a canonical path with no registered owner. */
export type ProjectlessTopologyFence = Readonly<{
  kind: 'projectless';
  processInstance: object;
  userId: number;
  resolvedPath: string;
  workspaceTopologyToken: object;
  sessionId: string | null;
  consent: 'read' | 'control' | null;
}>;

export type WorkspaceTopologyFence = ProjectAccessFence | ProjectlessTopologyFence;

export class ProjectOwnershipAmbiguousError extends Error {
  constructor() {
    super('project_ownership_ambiguous');
    this.name = 'ProjectOwnershipAmbiguousError';
  }
}

const processInstance = Object.freeze({});
const subjectTokens = new Map<string, Map<number, OpaqueFenceToken>>();
const structureTokens = new Map<string, OpaqueFenceToken>();
let workspaceTopologyToken: OpaqueFenceToken = Object.freeze({ nonce: Symbol('workspace-topology') });
let projectFenceRuntimeReady = true;
let injectRotationFailureForTests = false;
let injectAliasEnumerationFailureForTests = false;

const mintFenceToken = (): OpaqueFenceToken => Object.freeze({ nonce: Symbol('project-fence') });

const currentSubjectToken = (projectId: string, userId: number): OpaqueFenceToken => {
  let byUser = subjectTokens.get(projectId);
  if (!byUser) {
    byUser = new Map();
    subjectTokens.set(projectId, byUser);
  }
  let token = byUser.get(userId);
  if (!token) {
    token = mintFenceToken();
    byUser.set(userId, token);
  }
  return token;
};

const currentStructureToken = (projectId: string): OpaqueFenceToken => {
  let token = structureTokens.get(projectId);
  if (!token) {
    token = mintFenceToken();
    structureTokens.set(projectId, token);
  }
  return token;
};

const existingSubjectToken = (projectId: string, userId: number): OpaqueFenceToken | undefined =>
  subjectTokens.get(projectId)?.get(userId);

const existingStructureToken = (projectId: string): OpaqueFenceToken | undefined =>
  structureTokens.get(projectId);

const rotateNoThrow = (effect: () => void): boolean => {
  try {
    if (injectRotationFailureForTests) throw new Error('injected_project_fence_rotation_failure');
    effect();
    return true;
  } catch {
    projectFenceRuntimeReady = false;
    return false;
  }
};

/**
 * T-1854 / ADR-172 amendment: rotation, THEN the post-commit sweep. The sweep
 * never runs inside the rotation effect, so a sweep fault cannot mark the token
 * registry unready; a failed rotation widens the sweep to every fenced run.
 */
const rotateThenSweep = (effect: () => void, filter: () => FencedRunSweepFilter): boolean => {
  const rotated = rotateNoThrow(effect);
  sweepFencedRuns(rotated ? filter() : 'all');
  return rotated;
};

export type FencedRunRevokeReason = 'project_access_changed' | 'project_access_unverifiable';

/**
 * One admitted provider run (T-1854). Authority belongs to the run, not to the
 * socket: `revoked` is set synchronously by a post-commit sweep that proved
 * `!canAccessProject`, and it never flips back (I3) — a re-added member gets a
 * NEW run, never this one back.
 */
export type FencedRun = Readonly<{ projectId: string; userId: number; revoked: boolean }>;

export type ArmFencedRunInput = {
  projectId: string;
  userId: number | null;
  /** Called once, from a microtask, after `revoked` became true. */
  onRevoke: (reason: FencedRunRevokeReason) => void;
  /** JWT user id stamped on the run's current primary socket (null = none). */
  primarySocketUserId?: () => number | null;
  /** The primary socket now belongs to a user who lost this project (I7). */
  onForeignSocketRevoked?: () => void;
};

type FencedRunEntry = {
  projectId: string;
  userId: number;
  revoked: boolean;
  released: boolean;
  onRevoke: ArmFencedRunInput['onRevoke'];
  primarySocketUserId: () => number | null;
  onForeignSocketRevoked: () => void;
};

type FencedRunSweepFilter = { projectIds?: Iterable<string>; userId?: number } | 'all';

const fencedRunsByProject = new Map<string, Set<FencedRunEntry>>();
const fencedRunsByUser = new Map<number, Set<FencedRunEntry>>();

const indexFencedRun = <K>(index: Map<K, Set<FencedRunEntry>>, key: K, entry: FencedRunEntry): void => {
  let bucket = index.get(key);
  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }
  bucket.add(entry);
};

const unindexFencedRun = <K>(index: Map<K, Set<FencedRunEntry>>, key: K, entry: FencedRunEntry): void => {
  const bucket = index.get(key);
  bucket?.delete(entry);
  if (bucket?.size === 0) index.delete(key);
};

const canAccessProjectSafe = (projectId: string, userId: number): boolean => {
  try {
    return canAccessProject(projectId, userId);
  } catch {
    return false;
  }
};

const readPrimarySocketUserId = (entry: FencedRunEntry): number | null => {
  try {
    const value = entry.primarySocketUserId();
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Registers an admitted run, or returns null when the user may not reach the
 * project now (or fencing is unprovable). Registration is synchronous with the
 * access check, so no commit can fall between them within this process.
 */
export function armFencedRun(input: ArmFencedRunInput): FencedRun | null {
  const { projectId, userId } = input;
  if (!projectFenceRuntimeReady || !projectId || !Number.isInteger(userId)) return null;
  if (!canAccessProjectSafe(projectId, userId as number)) return null;
  const entry: FencedRunEntry = {
    projectId,
    userId: userId as number,
    revoked: false,
    released: false,
    onRevoke: input.onRevoke,
    primarySocketUserId: input.primarySocketUserId ?? (() => null),
    onForeignSocketRevoked: input.onForeignSocketRevoked ?? (() => undefined),
  };
  indexFencedRun(fencedRunsByProject, entry.projectId, entry);
  indexFencedRun(fencedRunsByUser, entry.userId, entry);
  return entry;
}

/** Forgets a finished (or aborted) run so the registry stays bounded. Idempotent. */
export function releaseFencedRun(run: FencedRun | null | undefined): void {
  const entry = run as FencedRunEntry | null | undefined;
  if (!entry || entry.released) return;
  entry.released = true;
  unindexFencedRun(fencedRunsByProject, entry.projectId, entry);
  unindexFencedRun(fencedRunsByUser, entry.userId, entry);
}

function selectSweepCandidates(filter: FencedRunSweepFilter): FencedRunEntry[] {
  const selected = new Set<FencedRunEntry>();
  if (filter === 'all') {
    for (const bucket of fencedRunsByProject.values()) for (const entry of bucket) selected.add(entry);
    return [...selected];
  }
  for (const projectId of filter.projectIds ?? []) {
    for (const entry of fencedRunsByProject.get(projectId) ?? []) selected.add(entry);
  }
  if (filter.userId !== undefined) {
    for (const entry of fencedRunsByUser.get(filter.userId) ?? []) selected.add(entry);
    // Another member's run whose primary socket is this user's (I7).
    for (const bucket of fencedRunsByProject.values()) {
      for (const entry of bucket) {
        if (readPrimarySocketUserId(entry) === filter.userId) selected.add(entry);
      }
    }
  }
  return [...selected];
}

function sweepFencedRun(entry: FencedRunEntry): void {
  if (entry.revoked || entry.released) return;
  if (!projectFenceRuntimeReady || !canAccessProjectSafe(entry.projectId, entry.userId)) {
    entry.revoked = true;
    const reason: FencedRunRevokeReason = projectFenceRuntimeReady
      ? 'project_access_changed'
      : 'project_access_unverifiable';
    // The sweep may run inside a caller's synchronous flow; provider I/O waits
    // for a microtask while `revoked` already drops every frame (I1).
    queueMicrotask(() => {
      try {
        entry.onRevoke(reason);
      } catch (error) {
        console.error('[ADR-172] fenced run revocation handler failed', {
          projectId: entry.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return;
  }
  const socketUserId = readPrimarySocketUserId(entry);
  if (socketUserId !== null && socketUserId !== entry.userId
      && !canAccessProjectSafe(entry.projectId, socketUserId)) {
    entry.onForeignSocketRevoked();
  }
}

/** The only revocation generation: post-commit, per entry, fail-closed. */
function sweepFencedRuns(filter: FencedRunSweepFilter): void {
  for (const entry of selectSweepCandidates(filter)) {
    try {
      sweepFencedRun(entry);
    } catch (error) {
      console.error('[ADR-172] fenced run sweep failed for one entry', {
        projectId: entry.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Re-checks every fenced run of a user whose platform role/status changed
 * without rotating project tokens (setRole, setStatus, deleteUser).
 */
export function revalidateUserProjectAccess(userId: number): void {
  if (!Number.isInteger(userId)) return;
  sweepFencedRuns({ userId });
}

/** Test-only registry cardinality proof. */
export function __fencedRunCountForTests(): number {
  let count = 0;
  for (const bucket of fencedRunsByProject.values()) count += bucket.size;
  return count;
}

/** Whether post-commit project fencing remains provable for this process. */
export function isProjectFenceRuntimeReady(): boolean {
  return projectFenceRuntimeReady;
}

/** Rotates one user's authority in one project without disturbing other subjects/projects. */
export function rotateProjectSubjectAccess(projectId: string, userId: number): boolean {
  if (!projectId || !Number.isInteger(userId)) return false;
  return rotateThenSweep(() => {
    let byUser = subjectTokens.get(projectId);
    if (!byUser) {
      byUser = new Map();
      subjectTokens.set(projectId, byUser);
    }
    byUser.set(userId, mintFenceToken());
  }, () => ({ projectIds: [projectId] }));
}

/** Invalidates and forgets a removed subject so the boot-local registry stays bounded. */
export function retireProjectSubjectAccess(projectId: string, userId: number): boolean {
  if (!projectId || !Number.isInteger(userId)) return false;
  return rotateThenSweep(() => {
    const byUser = subjectTokens.get(projectId);
    byUser?.delete(userId);
    if (byUser?.size === 0) subjectTokens.delete(projectId);
  }, () => ({ projectIds: [projectId] }));
}

/** Rotates project-wide structure and the projectless workspace topology. */
export function rotateProjectStructure(projectId: string): boolean {
  if (!projectId) return false;
  return rotateThenSweep(() => {
    structureTokens.set(projectId, mintFenceToken());
    workspaceTopologyToken = mintFenceToken();
    invalidateProjectFormsCache();
  }, () => ({ projectIds: [projectId] }));
}

/** Invalidates and forgets all tokens for a deleted project. */
export function retireProjectStructure(projectId: string): boolean {
  if (!projectId) return false;
  return rotateThenSweep(() => {
    subjectTokens.delete(projectId);
    structureTokens.delete(projectId);
    workspaceTopologyToken = mintFenceToken();
    invalidateProjectFormsCache();
  }, () => ({ projectIds: [projectId] }));
}

/** Rotates topology when a write has ambiguous/projectless reach. */
export function rotateWorkspaceTopology(): boolean {
  // Projectless/ambiguous reach: any registered project may be affected.
  return rotateThenSweep(() => {
    workspaceTopologyToken = mintFenceToken();
    invalidateProjectFormsCache();
  }, () => 'all');
}

/** Project ids registered through lexical aliases of the same canonical directory. */
export function listCanonicalProjectAliasIds(rawPath: string): string[] {
  const canonical = resolveFromNearestExistingAncestor(path.resolve(rawPath));
  if (!canonical) return [];
  const ids = new Set<string>();
  for (const entry of readProjectForms()) {
    if (entry.forms.some(({ form }) => resolveFromNearestExistingAncestor(form) === canonical)) {
      ids.add(entry.project_id);
    }
  }
  return [...ids];
}

/** Rotates every registered alias of one physical project root. */
export function rotateProjectStructureForPath(
  projectId: string,
  projectPath: string,
  options: { retireProjectId?: boolean } = {},
): boolean {
  if (!projectId || !projectPath) return false;
  let rotatedIds: string[] = [projectId];
  return rotateThenSweep(() => {
    if (injectAliasEnumerationFailureForTests) throw new Error('injected_alias_enumeration_failure');
    const ids = new Set([...listCanonicalProjectAliasIds(projectPath), projectId]);
    rotatedIds = [...ids];
    for (const id of ids) {
      if (options.retireProjectId && id === projectId) {
        subjectTokens.delete(id);
        structureTokens.delete(id);
      } else {
        structureTokens.set(id, mintFenceToken());
      }
    }
    workspaceTopologyToken = mintFenceToken();
    invalidateProjectFormsCache();
  }, () => ({ projectIds: rotatedIds }));
}

/** Captures current access for one registered project, or null on any denial/uncertainty. */
export function captureProjectFence(projectId: string, userId: number | null): ProjectAccessFence | null {
  if (!projectFenceRuntimeReady || !Number.isInteger(userId)) return null;
  try {
    if (!canAccessProject(projectId, userId)) return null;
    return Object.freeze({
      kind: 'project', processInstance, projectId, userId: userId as number,
      subjectAccessToken: currentSubjectToken(projectId, userId as number),
      projectStructureToken: currentStructureToken(projectId),
    });
  } catch {
    return null;
  }
}

/** Rechecks token identity and the current database predicate. */
export function isProjectFenceCurrent(fence: ProjectAccessFence): boolean {
  if (!projectFenceRuntimeReady || fence.processInstance !== processInstance) return false;
  if (existingSubjectToken(fence.projectId, fence.userId) !== fence.subjectAccessToken) return false;
  if (existingStructureToken(fence.projectId) !== fence.projectStructureToken) return false;
  try {
    return canAccessProject(fence.projectId, fence.userId);
  } catch {
    return false;
  }
}

const hasProjectlessSessionConsent = (
  sessionId: string,
  userId: number,
  consent: 'read' | 'control',
): boolean => {
  const db = getConnection();
  const spawn = db.prepare(`SELECT 1 FROM session_participants
    WHERE session_id = ? AND user_id = ? AND attribution = 'spawn' LIMIT 1`).get(sessionId, userId);
  if (spawn) return true;
  return consent === 'read' && db.prepare(`SELECT 1 FROM message_authors
    WHERE session_id = ? AND user_id = ? LIMIT 1`).get(sessionId, userId) !== undefined;
};

/** Captures registered-project or projectless canonical workspace authority. */
export function captureWorkspaceTopologyFence(
  rawPath: string,
  userId: number | null,
  options: { sessionId?: string | null; consent?: 'read' | 'control' } = {},
): WorkspaceTopologyFence | null {
  if (!projectFenceRuntimeReady) return null;
  const admission = resolveWorkspaceProjectAdmission(rawPath, userId);
  if (!admission.allowed || admission.resolvedPath === null || !Number.isInteger(userId)) return null;
  if (admission.projectId) return captureProjectFence(admission.projectId, userId);
  const sessionId = options.sessionId?.trim() || null;
  const consent = options.consent ?? null;
  try {
    if (sessionId && (!consent || !hasProjectlessSessionConsent(sessionId, userId as number, consent))) {
      return null;
    }
    return Object.freeze({
      kind: 'projectless', processInstance, userId: userId as number,
      resolvedPath: admission.resolvedPath, workspaceTopologyToken,
      sessionId, consent,
    });
  } catch {
    return null;
  }
}

/** Re-resolves canonical topology and optional session consent before every boundary. */
export function isWorkspaceTopologyFenceCurrent(fence: WorkspaceTopologyFence): boolean {
  if (fence.kind === 'project') return isProjectFenceCurrent(fence);
  if (!projectFenceRuntimeReady || fence.processInstance !== processInstance
      || fence.workspaceTopologyToken !== workspaceTopologyToken) return false;
  try {
    const admission = resolveWorkspaceProjectAdmission(fence.resolvedPath, fence.userId);
    if (!admission.allowed || admission.projectId !== null || admission.resolvedPath !== fence.resolvedPath) {
      return false;
    }
    return !fence.sessionId || (fence.consent !== null
      && hasProjectlessSessionConsent(fence.sessionId, fence.userId, fence.consent));
  } catch {
    return false;
  }
}

/** Test-only deterministic post-commit rotation fault seam. */
export function __setProjectFenceRotationFailureForTests(enabled: boolean): void {
  injectRotationFailureForTests = enabled;
}

/** Test-only deterministic failure while enumerating canonical aliases after commit. */
export function __setProjectAliasEnumerationFailureForTests(enabled: boolean): void {
  injectAliasEnumerationFailureForTests = enabled;
}

/** Test-only reset; production never refreshes boot-local tokens in place. */
export function __resetProjectFenceStateForTests(): void {
  subjectTokens.clear();
  structureTokens.clear();
  workspaceTopologyToken = mintFenceToken();
  projectFenceRuntimeReady = true;
  injectRotationFailureForTests = false;
  injectAliasEnumerationFailureForTests = false;
  fencedRunsByProject.clear();
  fencedRunsByUser.clear();
  invalidateProjectFormsCache();
}

/** Test-only registry cardinality proof; never exposes token identities. */
export function __projectFenceTokenCountsForTests(): {
  projects: number; subjects: number; structures: number;
} {
  let subjects = 0;
  for (const byUser of subjectTokens.values()) subjects += byUser.size;
  return { projects: subjectTokens.size, subjects, structures: structureTokens.size };
}

/** True when ADR-172 membership enforcement is switched on (read per call). */
export function isProjectMembershipEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PROJECT_MEMBERSHIP_ENFORCE;
  return typeof raw === 'string' && TRUE_FLAG_VALUES.has(raw.trim().toLowerCase());
}

/** Pure role check: platform owner and admin see every project. */
export function canSeeAllProjects(user: { role?: string | null } | null | undefined): boolean {
  return typeof user?.role === 'string' && ALL_PROJECTS_ROLES.has(user.role);
}

/** Role of an ACTIVE user, or null for unknown/disabled/non-integer ids. */
function readActiveUserRole(userId: number | null): string | null {
  if (!Number.isInteger(userId)) {
    return null;
  }
  const row = getConnection()
    .prepare(`SELECT role FROM users WHERE id = ? AND is_active = 1 AND status = 'active'`)
    .get(userId) as { role: string } | undefined;
  return row?.role ?? null;
}

/** Whether the user (by id) holds a see-all-projects platform role. */
export function userCanSeeAllProjects(userId: number | null): boolean {
  return canSeeAllProjects({ role: readActiveUserRole(userId) });
}

/**
 * ADR-172 access predicate. False for unknown projects, anonymous callers and
 * disabled users. Independent of the enforcement flag — callers that must keep
 * ADR-089 behaviour while the flag is off check the flag themselves.
 */
export function canAccessProject(projectId: string, userId: number | null): boolean {
  if (!Number.isInteger(userId) || typeof projectId !== 'string' || projectId === '') {
    return false;
  }
  const row = getConnection().prepare(`
    SELECT
      p.created_by AS created_by,
      EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.project_id AND pm.user_id = ?
      ) AS isMember
    FROM projects p
    WHERE p.project_id = ?
  `).get(userId, projectId) as { created_by: number | null; isMember: number } | undefined;

  if (!row) {
    return false;
  }
  const role = readActiveUserRole(userId);
  if (role === null) {
    return false;
  }
  return canSeeAllProjects({ role }) || row.created_by === userId || row.isMember === 1;
}

/** Active project paths the user may access under ADR-172 (flag-independent). */
export function listAccessibleProjectPaths(userId: number | null): string[] {
  const role = readActiveUserRole(userId);
  if (role === null) {
    return [];
  }
  const db = getConnection();
  if (canSeeAllProjects({ role })) {
    const all = db.prepare(`
      SELECT DISTINCT project_path FROM projects WHERE isArchived = 0
    `).all() as Array<{ project_path: string }>;
    return all.map((row) => row.project_path);
  }
  const rows = db.prepare(`
    SELECT DISTINCT p.project_path AS project_path
    FROM projects p
    WHERE p.isArchived = 0
      AND (
        p.created_by = ?
        OR EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = p.project_id AND pm.user_id = ?
        )
      )
  `).all(userId, userId) as Array<{ project_path: string }>;
  return rows.map((row) => row.project_path);
}

/**
 * canAccessProject keyed by the exact path of an ACTIVE registered project;
 * false for unregistered or archived paths (never the creation-flow allowance).
 * Used for document-share member reads (owner decision 2026-09-23), so reading
 * a 'members' share follows the same rule as managing one — admin included.
 */
export function canAccessRegisteredProjectPath(projectPath: string, userId: number | null): boolean {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    return false;
  }
  const row = getConnection()
    .prepare('SELECT project_id FROM projects WHERE project_path = ? AND isArchived = 0')
    .get(projectPath.trim()) as { project_id: string } | undefined;
  return row ? canAccessProject(row.project_id, userId) : false;
}

function resolveFromNearestExistingAncestor(rawPath: string): string | null {
  const lexical = path.resolve(rawPath);
  let existing = lexical;
  const remainder: string[] = [];
  for (;;) {
    try {
      return normalizeProjectPath(path.join(fs.realpathSync(existing), ...remainder));
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') return null;
      try {
        fs.lstatSync(existing);
        return null;
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      remainder.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Lexical and symlink-resolved absolute forms, fail-closed on lookup errors. */
function candidatePaths(rawPath: string): string[] {
  const lexical = normalizeProjectPath(path.resolve(rawPath));
  const canonical = resolveFromNearestExistingAncestor(lexical);
  return canonical ? [...new Set([lexical, canonical])] : [];
}

/**
 * The registered project that OWNS `rawPath` (qa #4): the project whose path
 * equals it or is its longest ancestor, checked for both the lexical and the
 * realpath form, so `<project>/sub`, `<project>/a/../b` and a symlink pointing
 * into a project all resolve to that project. Null for a genuinely unregistered
 * location (the creation / first-run flow). Relative input is resolved against
 * the server cwd, as a spawn would; empty input → null.
 */
type ProjectForms = { project_id: string; project_path: string; forms: Array<{ form: string; prefix: string }> };

/** Cached literal + realpath forms of every stored project path (qa ن1). */
let formsCache: { signature: string; loadedAt: number; entries: ProjectForms[] } | null = null;
const FORMS_CACHE_TTL_MS = 10_000;

/**
 * Drops the cached project path forms. Called by the projects repository on
 * every write it owns; writers elsewhere are caught by the table signature and
 * the short TTL.
 */
export function invalidateProjectFormsCache(): void {
  formsCache = null;
}

function readProjectForms(): ProjectForms[] {
  const db = getConnection();
  // Cheap change detector for writers outside projects.db (count, max rowid, path lengths).
  const sig = db.prepare(
    'SELECT count(*) AS n, max(rowid) AS r, total(length(project_path)) AS l FROM projects',
  ).get() as { n: number; r: number | null; l: number };
  const signature = `${sig.n}:${sig.r}:${sig.l}`;
  const now = Date.now();
  if (formsCache && formsCache.signature === signature && now - formsCache.loadedAt < FORMS_CACHE_TTL_MS) {
    return formsCache.entries;
  }
  const rows = db.prepare('SELECT project_id, project_path FROM projects ORDER BY project_path, project_id')
    .all() as Array<{ project_id: string; project_path: string }>;
  const entries = rows.map((row) => ({
    ...row,
    forms: candidatePaths(row.project_path).map((form) => ({ form, prefix: form === '/' ? '/' : `${form}/` })),
  }));
  formsCache = { signature, loadedAt: now, entries };
  return entries;
}

export function findOwningProject(rawPath: string): { project_id: string; project_path: string } | null {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return null;
  }
  const candidates = candidatePaths(rawPath.trim());
  if (candidates.length === 0) return null;
  let bestDepth = -1;
  const best = new Map<string, { project_id: string; project_path: string }>();
  for (const entry of readProjectForms()) {
    // Stored path in both forms (qa م6): a project registered through a
    // symlink must still own a request made with its real path, and vice versa.
    for (const { form, prefix } of entry.forms) {
      if (candidates.some((candidate) => candidate === form || candidate.startsWith(prefix))) {
        const canonicalForm = resolveFromNearestExistingAncestor(form) ?? form;
        const depth = canonicalForm.split(path.sep).filter(Boolean).length;
        if (depth > bestDepth) {
          best.clear();
          bestDepth = depth;
        }
        if (depth === bestDepth) {
          best.set(entry.project_id, { project_id: entry.project_id, project_path: entry.project_path });
        }
      }
    }
  }
  if (best.size > 1) throw new ProjectOwnershipAmbiguousError();
  return best.size === 1 ? [...best.values()][0] : null;
}

/**
 * Enforced path gate for spawns/terminals (qa #4): unregistered location →
 * allowed (creation flow); inside a registered project → canAccessProject.
 *
 * Owner decision 2026-09-23 (qa م4, accepted risk B-1314): an UNREGISTERED
 * ancestor of projects (e.g. ~/Project) stays allowed. Membership
 * governs visibility, not OS isolation — every provider runs as one uid.
 */
export type WorkspaceProjectAdmission = {
  allowed: boolean;
  resolvedPath: string | null;
  projectId: string | null;
};

/** Canonical, fail-closed admission for provider and PTY working directories. */
export function resolveWorkspaceProjectAdmission(
  rawPath: string,
  userId: number | null,
  workspaceRoot = process.env.WORKSPACES_ROOT || WORKSPACES_ROOT,
): WorkspaceProjectAdmission {
  if (!Number.isInteger(userId) || typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { allowed: false, resolvedPath: null, projectId: null };
  }
  const rootLexical = normalizeProjectPath(path.resolve(workspaceRoot));
  const targetLexical = normalizeProjectPath(path.resolve(rawPath.trim()));
  const rootCanonical = resolveFromNearestExistingAncestor(rootLexical);
  const targetCanonical = resolveFromNearestExistingAncestor(targetLexical);
  const within = (candidate: string, root: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  if (!rootCanonical || !targetCanonical
      || !within(targetLexical, rootLexical)
      || !within(targetCanonical, rootCanonical)) {
    return { allowed: false, resolvedPath: null, projectId: null };
  }
  let owner: { project_id: string; project_path: string } | null;
  try {
    owner = findOwningProject(targetCanonical) ?? findOwningProject(targetLexical);
  } catch {
    return { allowed: false, resolvedPath: null, projectId: null };
  }
  if (owner) {
    return {
      allowed: canAccessProject(owner.project_id, userId),
      resolvedPath: targetCanonical,
      projectId: owner.project_id,
    };
  }
  return { allowed: readActiveUserRole(userId) !== null, resolvedPath: targetCanonical, projectId: null };
}

/** Boolean compatibility wrapper for existing launch gates. */
export function canAccessProjectPath(rawPath: string, userId: number | null): boolean {
  return resolveWorkspaceProjectAdmission(rawPath, userId).allowed;
}

/**
 * Startup advisory (P1-3): platform mode authenticates every request as the
 * first user, which makes per-user visibility meaningless. Returns the warning
 * text to log, or null when the combination is sound. Never throws.
 */
export function describePlatformModeVisibilityRisk(isPlatform: boolean, enforced: boolean): string | null {
  if (!isPlatform) {
    return null;
  }
  return enforced
    ? '[ADR-172] PROJECT_MEMBERSHIP_ENFORCE is on but platform mode (IS_PLATFORM) authenticates every '
      + 'request as the first user: project visibility is NOT meaningful on this node.'
    : '[ADR-172] platform mode (IS_PLATFORM) is on: per-user project visibility cannot be enforced '
      + 'on this node.';
}

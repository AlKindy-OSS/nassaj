import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import {
    canAccessProject,
    invalidateProjectFormsCache,
    isProjectMembershipEnforced,
    listAccessibleProjectPaths,
    rotateProjectStructureForPath,
    rotateProjectSubjectAccess,
} from '@/modules/database/repositories/project-access.js';
import type { CreateProjectPathResult, ProjectRepositoryRow, ProjectVisibility } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    /** Ensures a discovered session's project exists without restoring or modifying an existing project. */
    ensureProjectPathForSession(
        projectPath: string,
        options: { deferFenceRotation?: boolean } = {},
    ): string | null {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const db = getConnection();
        // Discovery of an existing project must not enter BEFORE INSERT guards.
        if (db.prepare('SELECT 1 FROM projects WHERE project_path = ?').get(normalizedProjectPath)) return null;
        const projectId = randomUUID();
        const inserted = db.prepare(`
            INSERT INTO projects (project_id, project_path, detected_name, isArchived)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(project_path) DO NOTHING
        `).run(projectId, normalizedProjectPath, normalizeProjectDisplayName(normalizedProjectPath, null));
        if (inserted.changes === 0) return null;
        if (!options.deferFenceRotation) rotateProjectStructureForPath(projectId, normalizedProjectPath);
        return projectId;
    },

    /**
     * Inserts (or reactivates an archived) project path. When `createdBy` is the
     * id of the authenticated creator it is recorded on first insert so the
     * private-project authorization layer (B-PRIV) can identify the owner.
     * Pre-existing/reactivated rows keep their original created_by — a path that
     * already exists is never re-attributed by this upsert.
     *
     * `preserveArchived` (B-1096) keeps an existing archived row archived instead
     * of reactivating it, and returns that row as an `active_conflict` (a path
     * that already exists blocked a fresh registration). It is used by the session
     * launch path (POST /api/agent), where merely starting or resuming a session
     * must NOT un-archive the project — only an explicit /restore does. The
     * DEFAULT (create-project) path is unchanged: an archived path is reactivated.
     */
    createProjectPath(
        projectPath: string,
        customProjectName: string | null = null,
        createdBy: number | null = null,
        options: { preserveArchived?: boolean } = {},
    ): CreateProjectPathResult {
        invalidateProjectFormsCache(); // ADR-172 qa ن1: owning-project cache
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const explicitProjectName = typeof customProjectName === 'string' && customProjectName.trim()
            ? customProjectName.trim()
            : null;
        const detectedName = normalizeProjectDisplayName(normalizedProjectPath, null);
        const attemptedId = randomUUID();
        const normalizedCreatedBy = Number.isInteger(createdBy) ? createdBy : null;

        // Archive-preserving path: never touch an existing row (active OR archived),
        // so the archived flag survives a session launch. Only a genuinely new path
        // is inserted; any existing path is reported as active_conflict with its row.
        if (options.preserveArchived === true) {
            const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
            if (existingProject) {
                return { outcome: 'active_conflict', project: existingProject };
            }
            const insertedRow = db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name, detected_name, isArchived, created_by)
                VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(project_path) DO NOTHING
                RETURNING project_id, project_path, custom_project_name, detected_name, isStarred, isArchived, visibility, created_by, logo_url, dir_exists, dir_checked_at
            `).get(attemptedId, normalizedProjectPath, explicitProjectName, detectedName, normalizedCreatedBy) as ProjectRepositoryRow | undefined;
            if (insertedRow) {
                rotateProjectStructureForPath(insertedRow.project_id, insertedRow.project_path);
                return { outcome: 'created', project: insertedRow };
            }
            // Lost an insert race: a concurrent writer created the row first.
            return { outcome: 'active_conflict', project: projectsDb.getProjectPath(normalizedProjectPath) };
        }

        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, detected_name, isArchived, created_by)
            VALUES (?, ?, ?, ?, 0, ?)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, detected_name, isStarred, isArchived, visibility, created_by, logo_url, dir_exists, dir_checked_at
        `).get(attemptedId, normalizedProjectPath, explicitProjectName, detectedName, normalizedCreatedBy) as ProjectRepositoryRow | undefined;

        if (row) {
            rotateProjectStructureForPath(row.project_id, row.project_path);
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, detected_name, isStarred, isArchived, visibility, created_by, logo_url, dir_exists, dir_checked_at
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, detected_name, isStarred, isArchived, visibility, created_by, logo_url, dir_exists, dir_checked_at
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    getProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, detected_name, isStarred, isArchived, visibility, created_by, logo_url, dir_exists, dir_checked_at
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     */
    getArchivedProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, detected_name, isStarred, isArchived, visibility, created_by, logo_url, dir_exists, dir_checked_at
            FROM projects
            WHERE isArchived = 1
        `).all() as ProjectRepositoryRow[];
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const existing = db.prepare('SELECT project_id FROM projects WHERE project_path = ?')
            .get(normalizedProjectPath) as { project_id: string } | undefined;
        const projectId = randomUUID();
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(projectId, normalizedProjectPath, customProjectName);
        if (!existing) rotateProjectStructureForPath(projectId, normalizedProjectPath);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    /**
     * Stores the project's logo URL (server-relative, cache-busted), or clears
     * it with null. The value is produced by the logo service from a validated
     * extension — never from client input — so nothing here can be a path.
     */
    setProjectLogoUrl(projectId: string, logoUrl: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET logo_url = ?
            WHERE project_id = ?
        `).run(logoUrl, projectId);
    },

    updateProjectDetectedName(projectId: string, detectedName: string): void {
        const normalized = detectedName.trim();
        if (!normalized) return;
        getConnection().prepare(`
            UPDATE projects SET detected_name = ? WHERE project_id = ?
        `).run(normalized, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): boolean {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const target = isArchived ? 1 : 0;
        const row = db.prepare('SELECT project_id, project_path FROM projects WHERE project_path = ?')
            .get(normalizedProjectPath) as { project_id: string; project_path: string } | undefined;
        const changed = db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ? AND isArchived <> ?
        `).run(target, normalizedProjectPath, target);
        if (row && changed.changes > 0) rotateProjectStructureForPath(row.project_id, row.project_path);
        return changed.changes > 0;
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): boolean {
        const db = getConnection();
        const target = isArchived ? 1 : 0;
        const row = db.prepare('SELECT project_path FROM projects WHERE project_id = ?')
            .get(projectId) as { project_path: string } | undefined;
        const changed = db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ? AND isArchived <> ?
        `).run(target, projectId, target);
        if (row && changed.changes > 0) rotateProjectStructureForPath(projectId, row.project_path);
        return changed.changes > 0;
    },

    /** Persists a conclusive or unknown filesystem probe without doing I/O. */
    updateProjectDirectoryState(projectId: string, exists: boolean | null): void {
        const db = getConnection();
        const persistedExists = exists === null ? null : exists ? 1 : 0;
        db.prepare(`
            UPDATE projects
            SET dir_exists = ?,
                dir_checked_at = CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
            WHERE project_id = ?
        `).run(persistedExists, persistedExists, projectId);
    },

    deleteProjectPath(projectPath: string): boolean {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare('SELECT project_id, project_path FROM projects WHERE project_path = ?')
            .get(normalizedProjectPath) as { project_id: string; project_path: string } | undefined;
        const deleted = db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
        if (row && deleted.changes > 0) {
            rotateProjectStructureForPath(row.project_id, row.project_path, { retireProjectId: true });
        }
        return deleted.changes > 0;
    },

    deleteProjectById(projectId: string, options: { deferFenceRotation?: boolean } = {}): boolean {
        const db = getConnection();
        const row = db.prepare('SELECT project_path FROM projects WHERE project_id = ?')
            .get(projectId) as { project_path: string } | undefined;
        const deleted = db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
        if (row && deleted.changes > 0 && !options.deferFenceRotation) {
            rotateProjectStructureForPath(projectId, row.project_path, { retireProjectId: true });
        }
        return deleted.changes > 0;
    },

    /** Sets a project's visibility ('public' | 'private') by project id. */
    setProjectVisibility(projectId: string, visibility: ProjectVisibility): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET visibility = ?
            WHERE project_id = ?
        `).run(visibility, projectId);
    },

    /** Reads a project's visibility by id, or null when the project is unknown. */
    getProjectVisibility(projectId: string): ProjectVisibility | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT visibility
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as { visibility: ProjectVisibility } | undefined;

        return row?.visibility ?? null;
    },

    /** Sets a project's creator (created_by) by id. Used by orphan-recovery. */
    setProjectCreatedBy(projectId: string, userId: number | null): void {
        const db = getConnection();
        const current = db.prepare('SELECT created_by FROM projects WHERE project_id = ?')
            .get(projectId) as { created_by: number | null } | undefined;
        if (!current || current.created_by === userId) return;
        const changed = db.prepare(`
            UPDATE projects
            SET created_by = ?
            WHERE project_id = ?
        `).run(Number.isInteger(userId) ? userId : null, projectId);
        if (changed.changes === 0) return;
        if (Number.isInteger(current.created_by)) {
            rotateProjectSubjectAccess(projectId, current.created_by as number);
        }
        if (Number.isInteger(userId)) rotateProjectSubjectAccess(projectId, userId as number);
    },

    /** Atomically transfers creator projection and its required owner membership. */
    transferProjectCreator(projectId: string, userId: number): boolean {
        if (!projectId || !Number.isInteger(userId)) return false;
        const db = getConnection();
        const change = db.transaction(() => {
            const current = db.prepare('SELECT created_by FROM projects WHERE project_id = ?')
                .get(projectId) as { created_by: number | null } | undefined;
            if (!current) return null;
            const member = db.prepare(
                'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
            ).get(projectId, userId) as { role: string } | undefined;
            if (current.created_by === userId && member?.role === 'owner') return null;
            db.prepare('UPDATE projects SET created_by = ? WHERE project_id = ?').run(userId, projectId);
            db.prepare(`INSERT INTO project_members (project_id, user_id, role, added_by)
                VALUES (?, ?, 'owner', NULL)
                ON CONFLICT(project_id, user_id) DO UPDATE SET role='owner', added_by=NULL`)
                .run(projectId, userId);
            return { oldCreator: current.created_by };
        })();
        if (!change) return false;
        if (Number.isInteger(change.oldCreator)) {
            rotateProjectSubjectAccess(projectId, change.oldCreator as number);
        }
        rotateProjectSubjectAccess(projectId, userId);
        return true;
    },

    /**
     * Active (non-archived) project paths — every project, for every caller.
     *
     * ADR-089 retired project visibility (public/private): nassaj is an internal
     * tool for one trusted team, so every project is shared with every member.
     * The predicate is kept (rather than deleted) because ten read gates call it;
     * neutralizing it HERE turns each of those gates into a plain existence check
     * in one place, with no call-site churn and no chance of a gate being missed.
     *
     * The `userId` parameter is retained for signature compatibility and is
     * deliberately unused. The WRITE gate (isProjectWritableByUser) is orthogonal
     * and untouched — session ownership still restricts mutation.
     */
    getVisibleProjectPaths(userId: number | null): string[] {
        // ADR-172: behind PROJECT_MEMBERSHIP_ENFORCE the list is membership-based
        // (role owner/admin, member, or creator). Flag off = ADR-089 unchanged.
        if (isProjectMembershipEnforced()) {
            return listAccessibleProjectPaths(userId);
        }
        const db = getConnection();

        const rows = db.prepare(`
            SELECT DISTINCT project_path
            FROM projects
            WHERE isArchived = 0
        `).all() as Array<{ project_path: string }>;

        return rows.map((row) => row.project_path);
    },

    /**
     * Whether a single project is readable by the user (guard primitive).
     *
     * ADR-089 retired project visibility, so this now answers EXISTENCE only:
     * true for any project row, false for an unknown id. Returning false for the
     * unknown id is load-bearing — callers answer 404 with it, so an enumerated
     * or guessed projectId still gets "not found" rather than a real response.
     *
     * The anonymous caller stays refused: an unresolved identity is not a team
     * member, and every route reaching this primitive is behind authentication.
     * Archived state does NOT affect the answer — management/restore paths
     * operate on archived rows by id.
     */
    isProjectVisibleToUser(projectId: string, userId: number | null): boolean {
        // ADR-172: delegate to the membership predicate when enforced.
        if (isProjectMembershipEnforced()) {
            return canAccessProject(projectId, userId);
        }
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as { project_id: string } | undefined;

        if (!row) {
            return false;
        }
        // Fail-closed defense-in-depth: an anonymous / unresolved caller is never
        // reported as seeing a project through this primitive.
        return Number.isInteger(userId);
    },

    /**
     * WRITE authorization predicate (B-138) — the mutating-endpoint sibling of
     * the READ predicate isProjectVisibleToUser. Answers "may this user MODIFY
     * files in the project identified by `projectId`?" (save / create / rename /
     * delete / upload).
     *
     * WHY THIS IS SEPARATE FROM isProjectVisibleToUser
     * ------------------------------------------------
     * isProjectVisibleToUser returns true for EVERY visibility='public' project
     * to ANY authenticated user — public projects are readable by the whole team
     * by design (B-PRIV). Gating a WRITE on that read predicate let any non-member
     * replace or plant files in another user's public project. The write gate is
     * therefore membership-based, NOT visibility-based:
     *   - created_by === userId  (the creator), OR
     *   - an explicit project_members row (any role), OR
     *   - an active session participant on the project.
     * The public bypass is intentionally ABSENT — 'public' confers read, never
     * write. The participant arm counts attribution='spawn' rows ONLY (ADR-104):
     * an inferred row means the server associated a conversation with someone,
     * not that they joined it, and this arm turns any single session inside a
     * project into write access over ALL of its files — the widest thing a
     * mis-attributed row could grant (B-476). These three routes are the exact NON-public routes of
     * isProjectVisibleToUser, so the read and write gates cannot silently diverge.
     *
     * Because writable ⊂ visible, a caller who passes this gate always also passed
     * the visibility gate; a caller who fails it may still SEE the project (public)
     * but is refused the mutation. Callers answer 404 (not 403) on false so a
     * PRIVATE project the user cannot see is never disclosed via a write attempt —
     * the B-PRIV non-disclosure guarantee is preserved on the mutating paths too.
     *
     * Fail-closed: a non-integer userId (anonymous/unresolved) or an unknown
     * projectId returns false. Archived state does NOT affect the answer (matching
     * isProjectVisibleToUser, so management/restore paths on archived rows are
     * unaffected). Prepared statements only — the caller id is never interpolated.
     */
    isProjectWritableByUser(projectId: string, userId: number | null): boolean {
        if (!Number.isInteger(userId)) {
            return false;
        }
        // ADR-172: every member may act in the project, so write == access, and
        // the session-participant arm is dropped (replaced by initial seeding).
        if (isProjectMembershipEnforced()) {
            return canAccessProject(projectId, userId);
        }

        const db = getConnection();
        const row = db.prepare(`
            SELECT
                p.created_by AS created_by,
                EXISTS (
                    SELECT 1 FROM project_members pm
                    WHERE pm.project_id = p.project_id AND pm.user_id = ?
                ) AS isMember,
                EXISTS (
                    SELECT 1
                    FROM session_participants sp
                    JOIN sessions s ON s.session_id = sp.session_id
                    WHERE sp.user_id = ?
                      AND sp.attribution = 'spawn'
                      AND s.project_path = p.project_path
                ) AS isParticipant
            FROM projects p
            WHERE p.project_id = ?
        `).get(
            userId,
            userId,
            projectId,
        ) as { created_by: number | null; isMember: number; isParticipant: number } | undefined;

        if (!row) {
            return false;
        }
        return row.created_by === userId || row.isMember === 1 || row.isParticipant === 1;
    },

    /**
     * Whether an ACTIVE project exists at a given project_path (path-keyed
     * sibling of isProjectVisibleToUser).
     *
     * Sessions carry a project_path, not a project_id, while the content
     * authorization layer must answer the SAME question the sidebar list layer
     * answers via getVisibleProjectPaths(userId). ADR-089 retired project
     * visibility, so both now reduce to existence — but the two predicates must
     * still be neutralized TOGETHER, because the content gate (B-111) and the
     * list gate diverging is exactly the failure mode this pair was built to
     * prevent.
     *
     * Keeps the `isArchived = 0` filter, so a project archived out of the visible
     * list is still not resolvable here and the caller falls back to
     * participant-only — that behaviour is about archival, not privacy.
     * Returns false when:
     *   - the path is blank, or no ACTIVE project row exists for it,
     *   - userId is not an integer (anonymous / unresolved).
     * Uses prepared statements only.
     */
    isProjectPathVisibleToUser(projectPath: string | null | undefined, userId: number | null): boolean {
        if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
            return false;
        }

        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id
            FROM projects
            WHERE project_path = ?
              AND isArchived = 0
        `).get(normalizedProjectPath) as { project_id: string } | undefined;

        if (!row) {
            return false;
        }
        // ADR-172: the content gate must stay aligned with the list gate.
        if (isProjectMembershipEnforced()) {
            return canAccessProject(row.project_id, userId);
        }
        // Fail-closed defense-in-depth: an anonymous / unresolved caller is never
        // reported as seeing a project through this primitive.
        return Number.isInteger(userId);
    },

    /**
     * OWNERSHIP predicate (ADR-053 §ج-3 حرج-2 — the workflow-supervisor GATE2
     * guard). Answers "does this user OWN or is an explicit MEMBER of the project
     * at `projectPath`?" — deliberately NOT the visibility question above.
     *
     * WHY THIS IS SEPARATE FROM isProjectPathVisibleToUser
     * ----------------------------------------------------
     * The visibility predicates return `true` for EVERY `visibility = 'public'`
     * project for ANY authenticated user (public is readable by the whole team by
     * design, B-PRIV). Using a visibility predicate to authorize a workflow LAUNCH
     * would let any user launch a background run — on the OWNER's Claude
     * subscription (per-user CLAUDE_CONFIG_DIR isolation) — against any public
     * project, which is a silent subscription-sharing ToS breach
     * (project_is_platform_shared_sub_risk). The launch guard must therefore be
     * strict ownership/membership, NOT visibility:
     *   - `created_by === userId`  (the creator), OR
     *   - an explicit `project_members` row for the user (any role).
     * The public bypass AND the session-participation route are intentionally
     * ABSENT here: neither confers the ownership needed to spend a subscription.
     *
     * Fail-closed: a non-integer userId (anonymous/unresolved), an empty path, or
     * a path with no ACTIVE project row returns false. Prepared statements only —
     * the caller-supplied path/id is never interpolated.
     */
    isProjectPathOwnedOrMemberedBy(projectPath: string | null | undefined, userId: number | null): boolean {
        if (!Number.isInteger(userId)) {
            return false;
        }
        if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
            return false;
        }

        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT
                p.created_by AS created_by,
                EXISTS (
                    SELECT 1 FROM project_members pm
                    WHERE pm.project_id = p.project_id AND pm.user_id = ?
                ) AS isMember
            FROM projects p
            WHERE p.project_path = ?
              AND p.isArchived = 0
        `).get(
            userId,
            normalizedProjectPath,
        ) as { created_by: number | null; isMember: number } | undefined;

        if (!row) {
            return false;
        }
        return row.created_by === userId || row.isMember === 1;
    },
};

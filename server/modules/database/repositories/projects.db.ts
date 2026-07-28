import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
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
    /**
     * Inserts (or reactivates an archived) project path. When `createdBy` is the
     * id of the authenticated creator it is recorded on first insert so the
     * private-project authorization layer (B-PRIV) can identify the owner.
     * Pre-existing/reactivated rows keep their original created_by — a path that
     * already exists is never re-attributed by this upsert.
     */
    createProjectPath(
        projectPath: string,
        customProjectName: string | null = null,
        createdBy: number | null = null,
    ): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const normalizedCreatedBy = Number.isInteger(createdBy) ? createdBy : null;
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, created_by)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName, normalizedCreatedBy) as ProjectRepositoryRow | undefined;

        if (row) {
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
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
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
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
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
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
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
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
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

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
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
        db.prepare(`
            UPDATE projects
            SET created_by = ?
            WHERE project_id = ?
        `).run(Number.isInteger(userId) ? userId : null, projectId);
    },

    /**
     * Project paths VISIBLE to the given user — the single source of truth for
     * the private-project privacy guarantee (B-PRIV). A path is visible when the
     * project is public, OR the user created it, OR the user is an explicit
     * project_members row, OR the user is derived from session participation.
     *
     * Privacy is ABSOLUTE: there is intentionally NO platform-owner bypass here.
     * The platform owner sees a private project only via one of the four
     * membership routes above — never by role. Returned as a de-duplicated set of
     * active (non-archived) project paths.
     */
    getVisibleProjectPaths(userId: number | null): string[] {
        const db = getConnection();

        // Unauthenticated / missing identity: only public projects are visible.
        if (!Number.isInteger(userId)) {
            const publicRows = db.prepare(`
                SELECT project_path
                FROM projects
                WHERE isArchived = 0 AND visibility = 'public'
            `).all() as Array<{ project_path: string }>;
            return publicRows.map((row) => row.project_path);
        }

        const rows = db.prepare(`
            SELECT DISTINCT p.project_path AS project_path
            FROM projects p
            WHERE p.isArchived = 0
              AND (
                p.visibility = 'public'
                OR p.created_by = ?
                OR EXISTS (
                    SELECT 1 FROM project_members pm
                    WHERE pm.project_id = p.project_id AND pm.user_id = ?
                )
                OR EXISTS (
                    SELECT 1
                    FROM session_participants sp
                    JOIN sessions s ON s.session_id = sp.session_id
                    WHERE sp.user_id = ?
                      AND s.project_path = p.project_path
                )
              )
        `).all(userId, userId, userId) as Array<{ project_path: string }>;

        return rows.map((row) => row.project_path);
    },

    /**
     * Whether a single project is visible to the user (B-PRIV guard primitive).
     * Mirrors getVisibleProjectPaths but resolves one project by id without
     * materializing the full visible set. Returns false for unknown projects so
     * callers can answer 404 (existence is not disclosed). Archived state does
     * NOT affect visibility here — archived private projects must stay protected
     * for management/restore paths that operate on archived rows by id.
     */
    isProjectVisibleToUser(projectId: string, userId: number | null): boolean {
        const db = getConnection();
        const row = db.prepare(`
            SELECT
                p.project_id AS project_id,
                p.visibility AS visibility,
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
                      AND s.project_path = p.project_path
                ) AS isParticipant
            FROM projects p
            WHERE p.project_id = ?
        `).get(
            Number.isInteger(userId) ? userId : -1,
            Number.isInteger(userId) ? userId : -1,
            projectId,
        ) as
            | { visibility: ProjectVisibility; created_by: number | null; isMember: number; isParticipant: number }
            | undefined;

        if (!row) {
            return false;
        }
        // Fail-closed defense-in-depth: refuse an anonymous / unresolved caller
        // before any visibility branch, so a non-integer id is never reported as
        // seeing even a public project through this primitive.
        if (!Number.isInteger(userId)) {
            return false;
        }
        if (row.visibility === 'public') {
            return true;
        }
        return row.created_by === userId || row.isMember === 1 || row.isParticipant === 1;
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
     * write. These three routes are the exact NON-public routes of
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
     * Whether the project that OWNS a given project_path is visible to the user
     * (B-PRIV guard primitive, path-keyed sibling of isProjectVisibleToUser).
     *
     * Sessions carry a project_path, not a project_id, while the content
     * authorization layer must answer the SAME question the sidebar list layer
     * answers via getVisibleProjectPaths(userId): "does this user see the project
     * this session lives in?". This resolves that directly from the path so the
     * content gate (B-111) and the list gate share one predicate and cannot
     * diverge — a session listable because its project is public/shared is now
     * also readable, while a session in a private project the user is not a
     * member of stays invisible (the B-105 IDOR fix is preserved).
     *
     * The membership routes are an exact single-row projection of the
     * getVisibleProjectPaths query (public OR creator OR project_members OR
     * session-participation-derived), including its `isArchived = 0` filter, so
     * the path-keyed content gate and the list gate cannot diverge: a project
     * archived out of the visible list is also invisible here (the caller then
     * falls back to participant-only). Returns false when:
     *   - no ACTIVE (non-archived) project row exists for the path (fall back to
     *     participant-only — this also covers an archived project),
     *   - the project is private and the user satisfies no membership route,
     *   - userId is not an integer (anonymous / unresolved) — the fail-closed
     *     guard runs BEFORE the public check, so even a public project is not
     *     reported visible to an unidentified caller via this primitive.
     * Uses prepared statements only.
     */
    isProjectPathVisibleToUser(projectPath: string | null | undefined, userId: number | null): boolean {
        if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
            return false;
        }

        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT
                p.visibility AS visibility,
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
                      AND s.project_path = p.project_path
                ) AS isParticipant
            FROM projects p
            WHERE p.project_path = ?
              AND p.isArchived = 0
        `).get(
            Number.isInteger(userId) ? userId : -1,
            Number.isInteger(userId) ? userId : -1,
            normalizedProjectPath,
        ) as
            | { visibility: ProjectVisibility; created_by: number | null; isMember: number; isParticipant: number }
            | undefined;

        if (!row) {
            return false;
        }
        // Fail-closed defense-in-depth: an anonymous / unresolved caller is
        // refused before any visibility branch, so a non-integer id can never be
        // reported as seeing even a public project through this primitive.
        if (!Number.isInteger(userId)) {
            return false;
        }
        if (row.visibility === 'public') {
            return true;
        }
        return row.created_by === userId || row.isMember === 1 || row.isParticipant === 1;
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

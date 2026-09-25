/**
 * Project members repository (B-PRIV).
 *
 * Backs explicit membership of a project (table: project_members). A private
 * project is visible only to its creator (projects.created_by), the users listed
 * here, and users derived from session participation. By owner decision privacy
 * is ABSOLUTE: there is no platform-owner bypass at the visibility layer — the
 * platform owner sees a private project only if they are themselves a member.
 *
 * role: 'owner' (may manage visibility + membership) | 'member' (read access).
 * All access uses prepared statements — no string interpolation of caller input.
 */

import { getConnection } from '@/modules/database/connection.js';
import {
  retireProjectSubjectAccess,
  rotateProjectSubjectAccess,
} from '@/modules/database/repositories/project-access.js';

export type ProjectMemberRole = 'owner' | 'member';

export type ProjectMemberRow = {
  project_id: string;
  user_id: number;
  role: ProjectMemberRole;
  added_by: number | null;
  created_at: string;
};

/** Membership row joined with the member's public display identity. */
export type ProjectMemberIdentityRow = Omit<ProjectMemberRow, 'created_at'> & {
  created_at: string | null;
  username: string | null;
  avatar_url: string | null;
  is_creator: number;
};

export const projectMembersDb = {
  /**
   * Adds (or updates) a membership row. Upsert: re-adding an existing member
   * refreshes their role and the granting user without creating a duplicate.
   * `addedBy` is the acting user's id (nullable for system-driven inserts).
   */
  add(
    projectId: string,
    userId: number,
    role: ProjectMemberRole = 'member',
    addedBy: number | null = null,
  ): void {
    if (!projectId || !Number.isInteger(userId)) {
      return;
    }
    const db = getConnection();
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, added_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET
         role = excluded.role,
         added_by = excluded.added_by`,
    ).run(projectId, userId, role, addedBy);
  },

  /** Adds/changes the access projection, then rotates only this project subject. */
  addAndRotateProjectAccess(
    projectId: string,
    userId: number,
    role: ProjectMemberRole = 'member',
    addedBy: number | null = null,
  ): boolean {
    const db = getConnection();
    const changed = db.transaction(() => {
      const existing = db.prepare(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
      ).get(projectId, userId) as { role: ProjectMemberRole } | undefined;
      if (existing?.role === role) return false;
      this.add(projectId, userId, role, addedBy);
      return true;
    })();
    if (changed) rotateProjectSubjectAccess(projectId, userId);
    return changed;
  },

  /** Removes a membership row. Returns whether a row was deleted (false = no-op). */
  remove(projectId: string, userId: number): boolean {
    if (!projectId || !Number.isInteger(userId)) {
      return false;
    }
    const db = getConnection();
    const result = db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(
      projectId,
      userId,
    );
    return result.changes > 0;
  },

  /** Removes membership transactionally, then rotates only this project subject. */
  removeAndRotateProjectAccess(projectId: string, userId: number): boolean {
    const db = getConnection();
    const removed = db.transaction(() => this.remove(projectId, userId))();
    if (removed) retireProjectSubjectAccess(projectId, userId);
    return removed;
  },

  /** Updates a member's role. No-op when the row does not exist. */
  setRole(projectId: string, userId: number, role: ProjectMemberRole): void {
    if (!projectId || !Number.isInteger(userId)) {
      return;
    }
    const db = getConnection();
    db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(
      role,
      projectId,
      userId,
    );
  },

  /** All members of a project, oldest first. */
  listByProject(projectId: string): ProjectMemberRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT project_id, user_id, role, added_by, created_at
         FROM project_members
         WHERE project_id = ?
         ORDER BY datetime(created_at) ASC`,
      )
      .all(projectId) as ProjectMemberRow[];
  },

  /**
   * ADR-172 member listing with display identity: every project_members row
   * plus the creator (as role 'owner') when the creator has no explicit row.
   * Joins users for username/avatar_url ONLY — never email, system role or
   * status. Creator first, then members by join date.
   */
  listByProjectWithIdentity(projectId: string): ProjectMemberIdentityRow[] {
    return getConnection()
      .prepare(
        `SELECT * FROM (
         SELECT pm.project_id, pm.user_id, pm.role, pm.added_by, pm.created_at,
                u.username, u.avatar_url, (pm.user_id = p.created_by) AS is_creator
         FROM project_members pm
         JOIN projects p ON p.project_id = pm.project_id
         LEFT JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ?
         UNION ALL
         SELECT p.project_id, p.created_by, 'owner', NULL, NULL, u.username, u.avatar_url, 1
         FROM projects p
         LEFT JOIN users u ON u.id = p.created_by
         WHERE p.project_id = ? AND p.created_by IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM project_members pm
                           WHERE pm.project_id = p.project_id AND pm.user_id = p.created_by)
         ) ORDER BY is_creator DESC, datetime(created_at) ASC`,
      )
      .all(projectId, projectId) as ProjectMemberIdentityRow[];
  },

  /**
   * Project ids where the given user holds the 'owner' member role. One
   * set-based query, used to stamp the per-user `isOwner` flag on project
   * payloads (sidebar "My projects" filter) without a per-project lookup.
   */
  listUserOwnedProjectIds(userId: number): string[] {
    if (!Number.isInteger(userId)) {
      return [];
    }
    const db = getConnection();
    const rows = db
      .prepare("SELECT project_id FROM project_members WHERE user_id = ? AND role = 'owner'")
      .all(userId) as Array<{ project_id: string }>;
    return rows.map((row) => row.project_id);
  },

  /** Project ids the given user is an explicit member of (any role). */
  listUserProjectIds(userId: number): string[] {
    if (!Number.isInteger(userId)) {
      return [];
    }
    const db = getConnection();
    const rows = db
      .prepare('SELECT project_id FROM project_members WHERE user_id = ?')
      .all(userId) as Array<{ project_id: string }>;
    return rows.map((row) => row.project_id);
  },

  /**
   * The user's role on a single project, or null when they are not an explicit
   * member. Used by management authorization (member-role 'owner' may manage).
   */
  getRole(projectId: string, userId: number): ProjectMemberRole | null {
    if (!projectId || !Number.isInteger(userId)) {
      return null;
    }
    const db = getConnection();
    const row = db
      .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, userId) as { role: ProjectMemberRole } | undefined;
    return row?.role ?? null;
  },
};

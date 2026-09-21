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

export type ProjectMemberRole = 'owner' | 'member';

export type ProjectMemberRow = {
  project_id: string;
  user_id: number;
  role: ProjectMemberRole;
  added_by: number | null;
  created_at: string;
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

  /** Removes a membership row. No-op when the row does not exist. */
  remove(projectId: string, userId: number): void {
    if (!projectId || !Number.isInteger(userId)) {
      return;
    }
    const db = getConnection();
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(
      projectId,
      userId,
    );
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

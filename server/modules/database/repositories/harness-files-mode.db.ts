/**
 * harness-files-mode repository (ADR-203, T-2003 C1).
 *
 * Two facts live here and nowhere else:
 *   - `user_harness_files_mode`: each user's REQUESTED skills mode. A missing
 *     row is `shared`; the row survives the workspace switch turning off, so a
 *     member returns to their saved choice when it is turned back on.
 *   - app_config `harness_files.allow_member_private`: the owner/admin workspace
 *     switch, a JSON boolean, default false. The key sits under a reserved prefix
 *     (app-config-reserved.ts), so the generic appConfigDb writer refuses it and
 *     only this repository can change it.
 *
 * Reads are STRICT (they throw on a database fault); the resolver catches and
 * fails safe to `shared`. Writes are plain statements meant to run inside the
 * caller's transaction together with the strict audit row.
 */

import { getConnection } from '@/modules/database/connection.js';

export type HarnessFilesStoredMode = 'shared' | 'private';

/** app_config key of the workspace switch "allow members to use private files". */
export const ALLOW_MEMBER_PRIVATE_KEY = 'harness_files.allow_member_private';

function numericUserId(userId: string | number | null | undefined): number | null {
  if (userId === null || userId === undefined || userId === '') return null;
  const parsed = Number(userId);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const harnessFilesModeDb = {
  /** The user's requested mode; `shared` when no row exists or the id is invalid. */
  getStoredMode(userId: string | number | null | undefined): HarnessFilesStoredMode {
    const id = numericUserId(userId);
    if (id === null) return 'shared';
    const row = getConnection()
      .prepare('SELECT mode FROM user_harness_files_mode WHERE user_id = ?')
      .get(id) as { mode?: string } | undefined;
    return row?.mode === 'private' ? 'private' : 'shared';
  },

  /** Upserts the user's requested mode. Run inside the caller's transaction. */
  setStoredMode(userId: string | number, mode: HarnessFilesStoredMode): void {
    const id = numericUserId(userId);
    if (id === null) throw new Error('HARNESS_FILES_USER_INVALID');
    getConnection().prepare(
      `INSERT INTO user_harness_files_mode (user_id, mode, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    ).run(id, mode, Date.now());
  },

  /** The workspace switch; anything but the stored JSON `true` reads as false. */
  getAllowMemberPrivate(): boolean {
    const row = getConnection()
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get(ALLOW_MEMBER_PRIVATE_KEY) as { value?: string } | undefined;
    return row?.value === 'true';
  },

  /** Writes the workspace switch as a JSON boolean. Run inside the caller's transaction. */
  setAllowMemberPrivate(allow: boolean): void {
    getConnection().prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(ALLOW_MEMBER_PRIVATE_KEY, allow ? 'true' : 'false');
  },

  /**
   * Active members (role `user`) whose saved choice is `private`: the members
   * the workspace switch moves when it changes. Owners/admins are not affected
   * by the switch, so they are not counted.
   */
  listMembersWithSavedPrivate(): number[] {
    const rows = getConnection().prepare(
      `SELECT m.user_id AS id FROM user_harness_files_mode m
         JOIN users u ON u.id = m.user_id
        WHERE m.mode = 'private' AND u.role = 'user' AND u.is_active = 1 AND u.status = 'active'
        ORDER BY m.user_id ASC`,
    ).all() as { id: number }[];
    return rows.map((row) => row.id);
  },
};

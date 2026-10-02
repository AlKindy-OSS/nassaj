/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table. The schema is
 * multi-user (Phase-MU): each user has a role (owner/admin/user), a status
 * (active/disabled), and an optional inviter. All queries use prepared
 * statements; no string interpolation of user input.
 */

import { getConnection } from '@/modules/database/connection.js';
import { recordStrictAuditOnConnection } from '@/modules/database/repositories/audit-log.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import {
  retireProjectSubjectAccess,
  revalidateUserProjectAccess,
} from '@/modules/database/repositories/project-access.js';

export type UserRole = 'owner' | 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  avatar_url: string | null;
  has_completed_onboarding: number;
  role: UserRole;
  status: UserStatus;
  invited_by: number | null;
  password_changed_at: number | null;
  must_change_password: number;
  authorization_generation: number;
};

type UserPublicRow = Pick<
  UserRow,
  | 'id'
  | 'username'
  | 'created_at'
  | 'last_login'
  | 'role'
  | 'status'
  | 'avatar_url'
  | 'password_changed_at'
  | 'must_change_password'
  | 'authorization_generation'
>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number;
  username: string;
  role: UserRole;
  /**
   * The stamp written by createUser (ms epoch). Returned so callers that mint a
   * JWT straight from this result (invite acceptance) carry the SAME pwd_iat the
   * row holds — otherwise generateToken's missing-stamp fallback would issue a
   * token that the row's stamp immediately invalidates (B-164).
   */
  password_changed_at: number;
  authorization_generation: number;
};

type CreateSsoUserInput = {
  username: string;
  /** Sentinel from services/sso-only-password.js; never a real hash. */
  passwordHash: string;
  role: Exclude<UserRole, 'owner'>;
  issuer: string;
  subject: string;
  attestedAtMs: number;
  /** Reserved-name policy (services/username-policy.js), checked with the clash. */
  isReservedUsername: (username: string) => boolean;
};

type CreateSsoUserResult =
  | { created: true; user: CreateUserResult; identityId: number }
  | { created: false; reason: 'username_taken' };

const PUBLIC_COLUMNS =
  'id, username, created_at, last_login, role, status, avatar_url, password_changed_at, must_change_password, authorization_generation';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Number of users with the owner role. Used to gate bootstrap. */
  getOwnerCount(): number {
    const db = getConnection();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'owner'")
      .get() as { count: number };
    return row.count;
  },

  /**
   * Number of active accounts (is_active=1 AND status='active') — the set whose
   * sessions the server will actually serve. Used by the platform-mode boot
   * guard (B-5) to detect a silent shared-subscription condition: in platform
   * mode every WS session authenticates as the first active user, so more than
   * one active account on an isolated Claude provider means several people would
   * silently run on the operator's single subscription.
   */
  getActiveUserCount(): number {
    const db = getConnection();
    const row = db
      .prepare(
        "SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND status = 'active'"
      )
      .get() as { count: number };
    return row.count;
  },

  /**
   * Inserts a new user with an explicit role and optional inviter.
   * Returns the created id, username, role, and password stamp.
   *
   * B-164: `password_changed_at` is stamped HERE, at insert. It used to be left
   * NULL and filled only by the one-shot migration backfill, so every account
   * created after that migration kept a NULL stamp forever — and a NULL stamp
   * makes authenticateToken skip the `pwd_iat` gate entirely, i.e. those users'
   * tokens were NEVER invalidated by a password change or an admin reset (the
   * "logout everywhere" guarantee silently did not apply to them).
   */
  createUser(
    username: string,
    passwordHash: string,
    role: UserRole = 'user',
    invitedBy: number | null = null
  ): CreateUserResult {
    const db = getConnection();
    const passwordChangedAt = Date.now();
    const result = db
      .prepare(
        'INSERT INTO users (username, password_hash, role, invited_by, status, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(username, passwordHash, role, invitedBy, 'active', passwordChangedAt);
    return {
      id: Number(result.lastInsertRowid),
      username,
      role,
      password_changed_at: passwordChangedAt,
      authorization_generation: 1,
    };
  },

  /**
   * T-1939 slice 4: creates an SSO-only account, links its IdP identity and
   * stamps the attestation in ONE transaction, so an account never exists
   * without its link (or a link without a fresh attestation). The username is
   * refused — nothing written — when any account, active or not, already holds
   * it case-insensitively, or when it is reserved. The check and the insert
   * share the transaction, so no concurrent writer can slip between them.
   * Throws on any other failure (including a UNIQUE(issuer, subject) conflict
   * from a concurrent sign-in); nothing is written in that case.
   */
  createSsoUser(input: CreateSsoUserInput): CreateSsoUserResult {
    if (input.role !== 'admin' && input.role !== 'user') {
      throw new Error('invalid_sso_role');
    }
    const db = getConnection();
    return db.transaction((): CreateSsoUserResult => {
      if (input.isReservedUsername(input.username) || userDb.isUsernameTaken(input.username)) {
        return { created: false, reason: 'username_taken' };
      }
      const user = userDb.createUser(input.username, input.passwordHash, input.role, null);
      const identityId = userIdentitiesDb.link(user.id, input.issuer, input.subject);
      if (!userIdentitiesDb.markAttested(identityId, user.id, input.attestedAtMs)) {
        throw new Error('attestation_stamp_failed');
      }
      return { created: true, user, identityId };
    })();
  },

  /**
   * Whether any account — active or not — already holds `username`
   * case-insensitively (ASCII folding, matching the username pattern), other
   * than `excludeUserId`. Backed by idx_users_username_lower where it exists.
   */
  isUsernameTaken(username: string, excludeUserId: number | null = null): boolean {
    const db = getConnection();
    return db
      .prepare('SELECT 1 FROM users WHERE lower(username) = lower(?) AND (? IS NULL OR id <> ?) LIMIT 1')
      .get(username, excludeUserId, excludeUserId) !== undefined;
  },

  /**
   * Looks up an active (status=active, is_active=1) user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        "SELECT * FROM users WHERE username = ? AND is_active = 1 AND status = 'active'"
      )
      .get(username) as UserRow | undefined;
  },

  /**
   * Resolves a local login identifier without exposing whether it exists.
   * Local accounts historically store a username while invite-bound email lives
   * on the accepted invite; an ambiguous reused email intentionally resolves to
   * no account instead of selecting one by row order.
   */
  getUserByLoginIdentifier(identifier: string): UserRow | undefined {
    const normalized = identifier.trim().toLowerCase();
    const db = getConnection();
    return db.prepare(`
      SELECT u.*
      FROM users u
      WHERE u.is_active = 1 AND u.status = 'active'
        AND (
          lower(u.username) = ?
          OR u.id = (
            SELECT CASE WHEN COUNT(DISTINCT accepted_by) = 1 THEN MIN(accepted_by) END
            FROM invites
            WHERE accepted_by IS NOT NULL AND email IS NOT NULL
              AND lower(trim(email)) = ?
          )
        )
      ORDER BY CASE WHEN lower(u.username) = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(normalized, normalized, normalized) as UserRow | undefined;
  },

  /** Replaces the stored password hash (e.g. legacy bcrypt → argon2id rehash). */
  setPasswordHash(userId: number, passwordHash: string): void {
    const db = getConnection();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      passwordHash,
      userId
    );
  },

  /**
   * User-initiated password change: stores the new hash, stamps the change time
   * (invalidating older tokens via pwd_iat), and clears any forced-rotation flag.
   * @param changedAt unix epoch in ms (Date.now())
   */
  changePassword(userId: number, passwordHash: string, changedAt: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0 WHERE id = ?'
    ).run(passwordHash, changedAt, userId);
  },

  /**
   * Admin-initiated reset: stores the temporary hash, stamps the change time
   * (invalidating the target's existing tokens), and forces the user to set a
   * new password on next use.
   * @param changedAt unix epoch in ms (Date.now())
   */
  resetPassword(userId: number, passwordHash: string, changedAt: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 1 WHERE id = ?'
    ).run(passwordHash, changedAt, userId);
  },

  /** Changes a user's username. Uniqueness is enforced by the UNIQUE index. */
  setUsername(userId: number, username: string): void {
    const db = getConnection();
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
  },

  /**
   * Sets a user's status (active/disabled). Used by admin management.
   *
   * SEC-APIKEY-STATUS (defence in depth): `resolveApiKey` refuses a disabled
   * owner by `u.status`, and disabling ALSO removes every API key the account
   * owns in the SAME transaction, so no code path that reads `api_keys` without
   * joining `users` can ever accept one.
   *
   * T-1946 (owner decision 2026-09-29): the keys are DELETED, no longer only
   * flagged inactive. Re-activating the account therefore never brings a key
   * back; the member creates new ones. A non-empty purge is audited strictly in
   * the same transaction (`api_keys_revoked`, ids and count only), so a failed
   * audit write rolls the suspension back.
   *
   * Returns how many API keys were deleted (0 when enabling).
   */
  setStatus(userId: number, status: UserStatus): number {
    const db = getConnection();
    const apply = db.transaction((id: number, nextStatus: UserStatus): number => {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(nextStatus, id);
      if (nextStatus !== 'disabled') return 0;
      const count = db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(id).changes;
      if (count > 0) {
        recordStrictAuditOnConnection(db, 'api_keys_revoked', {
          userId: id, metadata: { trigger: 'user_disabled', targetUserId: id, count },
        });
      }
      return count;
    });
    const deletedKeys = apply(userId, status);
    // T-1854: status changes rotate no project token; re-check live runs now.
    revalidateUserProjectAccess(userId);
    return deletedKeys;
  },

  /** Updates a user's role (owner/admin/user). Used by owner-only management. */
  setRole(userId: number, role: UserRole): void {
    const db = getConnection();
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    // T-1854: an admin demotion can remove see-all access without a token rotation.
    revalidateUserProjectAccess(userId);
  },

  /**
   * Compare-and-set role change for externally attested roles (ADR-069). Only
   * applies when the stored role still equals `expectedRole`; never promotes to
   * and never modifies an owner row. Returns true when a row changed.
   */
  setRoleIfUnchanged(userId: number, expectedRole: UserRole, nextRole: Exclude<UserRole, 'owner'>): boolean {
    if ((nextRole as UserRole) === 'owner' || expectedRole === 'owner') {
      return false;
    }
    const db = getConnection();
    const result = db
      .prepare("UPDATE users SET role = ? WHERE id = ? AND role = ? AND role <> 'owner'")
      .run(nextRole, userId, expectedRole);
    if (result.changes === 1) revalidateUserProjectAccess(userId);
    return result.changes === 1;
  },

  /**
   * Returns the full row (incl. role/status) for any user by id regardless of
   * status. Used by management routes that must act on disabled users too.
   */
  getRawById(userId: number): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(userId) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash), active only. */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? AND is_active = 1 AND status = 'active'`
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /**
   * The platform owner's user id, or null when no user exists.
   *
   * "Platform owner" is the SAME identity the rest of the server treats as the
   * administrative super-user: the account whose `role === 'owner'` (see the
   * isPlatformOwner checks in projects.routes.ts / projects-with-sessions-fetch).
   * The oldest active owner is chosen when several exist. If — through some
   * legacy/edge state — no owner-role account is active, this falls back to the
   * oldest active user (the same identity getFirstUser resolves in platform
   * mode), so callers always get a stable, existing attribution target rather
   * than a silent null. Used by the OpenCode session synchronizer (T-857) to
   * attribute externally-created sessions living in the SHARED operator data
   * dir to the platform owner without inventing an implicit default.
   */
  getPlatformOwnerId(): number | null {
    const db = getConnection();
    const owner = db
      .prepare(
        "SELECT id FROM users WHERE role = 'owner' AND is_active = 1 AND status = 'active' ORDER BY id ASC LIMIT 1"
      )
      .get() as { id: number } | undefined;
    if (owner) {
      return owner.id;
    }
    const fallback = db
      .prepare(
        "SELECT id FROM users WHERE is_active = 1 AND status = 'active' ORDER BY id ASC LIMIT 1"
      )
      .get() as { id: number } | undefined;
    return fallback?.id ?? null;
  },

  /** Ids of every active owner, oldest first (owner alerts, T-1939 slice 4). */
  listActiveOwnerIds(): number[] {
    const rows = getConnection()
      .prepare("SELECT id FROM users WHERE role = 'owner' AND is_active = 1 AND status = 'active' ORDER BY id ASC")
      .all() as Array<{ id: number }>;
    return rows.map((row) => row.id);
  },

  /** Returns the first active user. Used for single-user / platform mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM users WHERE is_active = 1 AND status = 'active' ORDER BY id ASC LIMIT 1`
      )
      .get() as UserPublicRow | undefined;
  },

  /** Lists all users (public fields) ordered by id. For admin management UI. */
  listUsers(): UserPublicRow[] {
    const db = getConnection();
    return db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY id ASC`)
      .all() as UserPublicRow[];
  },

  /**
   * ADR-172 member-candidate search: ACTIVE users whose username contains `query`
   * (LIKE wildcards escaped), excluding current members and the creator of `projectId`. Returns
   * only id/username/avatar_url — never email, role or status. Capped by `limit`.
   */
  searchMemberCandidates(
    projectId: string,
    query: string,
    limit: number,
  ): Array<{ id: number; username: string; avatar_url: string | null }> {
    const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    return getConnection()
      .prepare(
        `SELECT id, username, avatar_url FROM users
         WHERE is_active = 1 AND status = 'active'
           AND username LIKE ? ESCAPE '\\'
           AND id NOT IN (SELECT user_id FROM project_members WHERE project_id = ?)
           AND id NOT IN (SELECT created_by FROM projects
                          WHERE project_id = ? AND created_by IS NOT NULL)
         ORDER BY username COLLATE NOCASE ASC
         LIMIT ?`
      )
      .all(pattern, projectId, projectId, limit) as Array<{ id: number; username: string; avatar_url: string | null }>;
  },

  /** Stores the user's preferred git name and email. */
  updateGitConfig(userId: number, gitName: string, gitEmail: string): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Stores the user's avatar URL (server-relative path), or clears it with null. */
  setAvatarUrl(userId: number, url: string | null): void {
    const db = getConnection();
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(url, userId);
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(
      userId
    );
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },

  /**
   * Permanently deletes a user and every row that references them (T-116).
   *
   * The schema declares ON DELETE CASCADE / SET NULL on the referencing tables,
   * but FK enforcement is per-connection in SQLite (default OFF): it is enabled
   * by INIT_SCHEMA_SQL at initializeDatabase(), yet connection.ts itself never
   * sets it, migrations toggle it OFF/ON during table rebuilds, and a connection
   * created without the init path (tests, tooling) has it OFF. The cascade is
   * therefore mirrored explicitly here, child tables first inside a single
   * transaction — correct under FK ON, and guaranteed orphan-free under FK OFF.
   * Tables touched mirror the live schema exactly:
   *   CASCADE  → webauthn_credentials, project_members, starred_sessions,
   *              api_keys, user_credentials, user_notification_preferences,
   *              user_ui_preferences, push_subscriptions, session_participants,
   *              message_authors, invites.invited_by
   *   SET NULL → invites.accepted_by, audit_log.user_id
   *
   * T-1946: a non-empty API key purge is audited strictly in the same
   * transaction (`api_keys_revoked`, trigger `user_deleted`, ids and count).
   *
   * Returns true if the user row existed and was deleted.
   */
  deleteUser(userId: number): boolean {
    const db = getConnection();
    const runDelete = db.transaction((id: number): { deleted: boolean; projectIds: string[] } => {
      const affectedProjects = db.prepare(`SELECT project_id FROM projects WHERE created_by = ?
        UNION SELECT project_id FROM project_members WHERE user_id = ?`)
        .all(id, id) as Array<{ project_id: string }>;
      // A wallet may retain this user in an inactive slot. Detach those rows
      // inside the same deletion transaction so the RESTRICT foreign key never
      // turns account deletion into a partial operation. Surviving devices keep
      // their other eligible slots and receive a new generation.
      db.prepare(`
        UPDATE device_sessions SET active_slot_id = NULL
        WHERE active_slot_id IN (
          SELECT id FROM device_account_slots WHERE user_id = ?
        )
      `).run(id);
      db.prepare(`
        UPDATE device_sessions SET generation = generation + 1
        WHERE id IN (
          SELECT DISTINCT device_session_id FROM device_account_slots WHERE user_id = ?
        )
      `).run(id);
      db.prepare(`
        UPDATE device_account_slots SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(Date.now(), id);
      db.prepare(`
        UPDATE device_sessions
        SET active_slot_id = (
          SELECT s.id FROM device_account_slots s
          JOIN users u ON u.id = s.user_id
          WHERE s.device_session_id = device_sessions.id AND s.revoked_at IS NULL
            AND u.is_active = 1 AND u.status = 'active' AND u.must_change_password = 0
            AND s.password_stamp = u.password_changed_at
          ORDER BY s.last_used_at DESC, s.id ASC LIMIT 1
        )
        WHERE active_slot_id IS NULL AND revoked_at IS NULL
          AND id IN (
            SELECT DISTINCT device_session_id FROM device_account_slots WHERE user_id = ?
          )
      `).run(id);
      db.prepare('DELETE FROM device_account_slots WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM project_members WHERE user_id = ?').run(id);
      db.prepare('UPDATE projects SET created_by = NULL WHERE created_by = ?').run(id);
      db.prepare('DELETE FROM starred_sessions WHERE user_id = ?').run(id);
      const deletedKeys = db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(id).changes;
      db.prepare('DELETE FROM user_credentials WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_notification_preferences WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_ui_preferences WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM session_participants WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM message_authors WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM invites WHERE invited_by = ?').run(id);
      db.prepare('UPDATE invites SET accepted_by = NULL WHERE accepted_by = ?').run(id);
      db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);
      const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
      if (deletedKeys > 0) {
        // T-1946: the account row is gone, so the id rides in metadata only.
        recordStrictAuditOnConnection(db, 'api_keys_revoked', {
          metadata: { trigger: 'user_deleted', targetUserId: id, count: deletedKeys },
        });
      }
      return { deleted: result.changes > 0, projectIds: affectedProjects.map((row) => row.project_id) };
    });
    const outcome = runDelete(userId);
    if (outcome.deleted) {
      for (const projectId of outcome.projectIds) retireProjectSubjectAccess(projectId, userId);
    }
    // T-1854 (qa M1): an admin reaches projects without a membership row, so
    // the per-project retire above can miss runs; re-check every run of the user.
    revalidateUserProjectAccess(userId);
    return outcome.deleted;
  },

  /** Exact active-user generation check for immutable request principals. */
  isAuthorizationPrincipalCurrent(userId: number, authorizationGeneration: number): boolean {
    if (!Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(authorizationGeneration) || authorizationGeneration <= 0) {
      return false;
    }
    const row = getConnection().prepare(`SELECT 1 FROM users
      WHERE id = ? AND authorization_generation = ?
        AND is_active = 1 AND status = 'active'`).get(userId, authorizationGeneration);
    return row !== undefined;
  },
};

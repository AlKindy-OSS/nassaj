/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table. The schema is
 * multi-user (Phase-MU): each user has a role (owner/admin/user), a status
 * (active/disabled), and an optional inviter. All queries use prepared
 * statements; no string interpolation of user input.
 */

import { getConnection } from '@/modules/database/connection.js';

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
};

const PUBLIC_COLUMNS =
  'id, username, created_at, last_login, role, status, avatar_url, password_changed_at, must_change_password';

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
    };
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
   * SEC-APIKEY-STATUS (defence in depth): disabling an account ALSO deactivates
   * every API key it owns, in the SAME transaction. `validateApiKey` now checks
   * `u.status` too, so this is the second of two independent guards — it means a
   * suspended member's keys are dead even for a future/foreign code path that
   * queries `api_keys` without joining `users`.
   *
   * DISABLE BY FLAG, NEVER DELETE (owner rule): the rows are flipped to
   * `is_active = 0`, so no history is destroyed and the keys stay listed in the
   * UI. Re-activating the user does NOT auto-re-enable them — that would
   * silently resurrect a credential an admin may have revoked on purpose.
   */
  setStatus(userId: number, status: UserStatus): void {
    const db = getConnection();
    const apply = db.transaction((id: number, nextStatus: UserStatus): void => {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(nextStatus, id);
      if (nextStatus === 'disabled') {
        db.prepare('UPDATE api_keys SET is_active = 0 WHERE user_id = ?').run(id);
      }
    });
    apply(userId, status);
  },

  /** Updates a user's role (owner/admin/user). Used by owner-only management. */
  setRole(userId: number, role: UserRole): void {
    const db = getConnection();
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
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
   * Returns true if the user row existed and was deleted.
   */
  deleteUser(userId: number): boolean {
    const db = getConnection();
    const runDelete = db.transaction((id: number): boolean => {
      db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM project_members WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM starred_sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(id);
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
      return result.changes > 0;
    });
    return runDelete(userId);
  },
};

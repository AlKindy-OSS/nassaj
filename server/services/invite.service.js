/**
 * Invite service.
 *
 * Implements invite-only registration (C-AUTH-4):
 *   - createInvite: owner/admin mints a single-use token; only its hash is stored.
 *   - acceptInvite: validates token (pending + unexpired), creates a `user`
 *     account, atomically consumes the invite, and audits the event.
 *
 * Plaintext invite tokens are never persisted — only SHA-256 hashes are stored.
 */

import crypto from 'crypto';

import { userDb, invitesDb, auditLogDb } from '../modules/database/index.js';

import { provisionUserDirs } from './isolation/provision-user-dirs.js';
import { hashPassword } from './password.service.js';

const DEFAULT_TTL_HOURS = 72;
const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;
const ASSIGNABLE_ROLES = new Set(['admin', 'user']);

// Allowed username shape for admin-created accounts: 3–32 chars, alphanumeric
// plus underscore. The {3,} lower bound mirrors MIN_USERNAME_LENGTH.
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

/** Errors thrown by the service carry a `status` for the HTTP layer. */
class InviteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sqliteUtcNow() {
  // 'YYYY-MM-DD HH:MM:SS' in UTC to match SQLite CURRENT_TIMESTAMP comparisons.
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sqliteUtcFromNow(hours) {
  const d = new Date(Date.now() + hours * 3600_000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Creates an invite. Only owner/admin may invite; only 'admin'/'user' roles are
 * assignable, and only an owner may mint an 'admin' invite.
 *
 * @param {{ id:number, role:string }} actor authenticated creator
 * @param {{ role?:string, email?:string, ttlHours?:number }} params
 * @returns {{ token:string, expiresAt:string, role:string }} plaintext token (shown once)
 */
export async function createInvite(actor, params = {}) {
  const role = params.role ?? 'user';
  if (!ASSIGNABLE_ROLES.has(role)) {
    throw new InviteError(400, 'Invalid role');
  }
  if (role === 'admin' && actor.role !== 'owner') {
    throw new InviteError(403, 'Only the owner can invite admins');
  }

  const ttlHours = Number.isFinite(params.ttlHours) ? params.ttlHours : DEFAULT_TTL_HOURS;
  if (ttlHours <= 0 || ttlHours > 24 * 30) {
    throw new InviteError(400, 'Invalid expiry');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = sqliteUtcFromNow(ttlHours);

  invitesDb.create({
    tokenHash: hashToken(token),
    role,
    invitedBy: actor.id,
    email: params.email ?? null,
    expiresAt,
  });

  auditLogDb.record('invite_created', {
    userId: actor.id,
    metadata: { role, hasEmail: Boolean(params.email) },
  });

  return { token, expiresAt, role };
}

/**
 * Accepts an invite by token, creating a new user account.
 *
 * @param {{ token:string, username:string, password:string }} input
 * @param {string|null} ipAddress
 * @returns {Promise<{ id:number, username:string, role:string }>}
 */
export async function acceptInvite(input, ipAddress = null) {
  const { token, username, password } = input;

  if (!token || typeof token !== 'string') {
    throw new InviteError(400, 'Invite token is required');
  }
  if (!username || username.length < MIN_USERNAME_LENGTH) {
    throw new InviteError(400, `Username must be at least ${MIN_USERNAME_LENGTH} characters`);
  }
  // B-147: enforce the same username shape createOidcUser applies (see below),
  // so invite-accepted accounts cannot carry characters the length check alone
  // would let through (spaces, dots, slashes, control/unicode). Same message for
  // a consistent client contract across both account-creation paths.
  if (!USERNAME_PATTERN.test(username)) {
    throw new InviteError(400, 'Username may contain only letters, digits, and underscores (3–32)');
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new InviteError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const tokenHash = hashToken(token);
  const invite = invitesDb.findByTokenHash(tokenHash);
  const now = sqliteUtcNow();

  if (!invite || invite.status !== 'pending' || invite.expires_at <= now) {
    auditLogDb.record('invite_rejected', {
      metadata: { reason: !invite ? 'not_found' : invite.status === 'pending' ? 'expired' : invite.status },
      ipAddress,
    });
    throw new InviteError(400, 'Invite is invalid, expired, or already used');
  }

  if (userDb.getUserByUsername(username)) {
    throw new InviteError(409, 'Username already taken');
  }

  const passwordHash = await hashPassword(password);

  // Create the user, then atomically consume the invite. If the atomic
  // transition fails (concurrent acceptance), reject — the second caller loses.
  const user = userDb.createUser(username, passwordHash, invite.role, invite.invited_by);
  const consumed = invitesDb.markAccepted(tokenHash, user.id, now);
  if (!consumed) {
    throw new InviteError(409, 'Invite was already used');
  }

  auditLogDb.record('invite_accepted', {
    userId: user.id,
    metadata: { inviteId: invite.id, role: invite.role },
    ipAddress,
  });

  // Provision the new user's isolated config tree (+ shared symlinks) eagerly,
  // so they can register their own Claude subscription the moment the account
  // exists rather than waiting for the first provider spawn (B-ISO-PROVISION).
  // provisionUserDirs is idempotent and swallows its own errors, but we still
  // guard here: a provisioning failure must never roll back an accepted invite —
  // the lazy path on first spawn remains a fallback. Audit the failure for
  // visibility.
  try {
    provisionUserDirs(user.id);
  } catch (err) {
    auditLogDb.record('user_dirs_provision_failed', {
      userId: user.id,
      metadata: { stage: 'accept_invite', error: err?.message || String(err) },
      ipAddress,
    });
  }

  return user;
}

/**
 * Creates an OIDC-only user account (C-1: sentinel argon2 hash, no usable password).
 * Called by admin to pre-provision a user before their first OIDC login.
 * The admin then links their IdP identity via POST /api/auth/oidc/link.
 *
 * @param {{ id:number, role:string }} actor - admin/owner creating the account
 * @param {{ username:string, role?:string, email?:string }} params
 */
export async function createOidcUser(actor, params = {}) {
  const { username, role = 'user', email } = params;

  if (!username || username.length < MIN_USERNAME_LENGTH) {
    throw new InviteError(400, `Username must be at least ${MIN_USERNAME_LENGTH} characters`);
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new InviteError(400, 'Username may contain only letters, digits, and underscores (3–32)');
  }
  if (!ASSIGNABLE_ROLES.has(role)) {
    throw new InviteError(400, 'Invalid role');
  }
  if (role === 'admin' && actor.role !== 'owner') {
    throw new InviteError(403, 'Only the owner can create admin accounts');
  }
  if (userDb.getUserByUsername(username)) {
    throw new InviteError(409, 'Username already taken');
  }

  // C-1: sentinel argon2 hash — valid hash of a random unreachable secret.
  // The user can never authenticate with a local password; OIDC is the only path.
  const sentinelPlaintext = crypto.randomBytes(32).toString('hex');
  const sentinelHash = await hashPassword(sentinelPlaintext);

  const user = userDb.createUser(username, sentinelHash, role, actor.id);

  // Provision user dirs eagerly (same as acceptInvite). A provisioning failure
  // must never roll back the created account — the lazy path on first spawn
  // remains a fallback; audit the failure for visibility.
  try {
    provisionUserDirs(user.id);
  } catch (err) {
    auditLogDb.record('user_dirs_provision_failed', {
      userId: user.id,
      metadata: { stage: 'create_oidc_user', error: err?.message || String(err) },
    });
  }

  auditLogDb.record('oidc_user_created', {
    userId: actor.id,
    metadata: { newUserId: user.id, username, role, hasEmail: Boolean(email) },
  });

  return user;
}

export { InviteError };

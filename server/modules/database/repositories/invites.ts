/**
 * Invites repository.
 *
 * Invite-only registration: an owner/admin creates an invite, the plaintext
 * token is returned ONCE to the caller, and only its SHA-256 hash is persisted.
 * Acceptance looks up by hash, checks status/expiry, and marks the invite used.
 *
 * All queries use prepared statements.
 */

import { getConnection } from '@/modules/database/connection.js';
import type { UserRole } from '@/modules/database/repositories/users.js';

export type InviteStatus = 'pending' | 'accepted' | 'revoked';

type InviteRow = {
  id: number;
  token_hash: string;
  role: UserRole;
  invited_by: number;
  email: string | null;
  status: InviteStatus;
  expires_at: string;
  accepted_by: number | null;
  accepted_at: string | null;
  created_at: string;
};

type InvitePublicRow = Omit<InviteRow, 'token_hash'>;

const PUBLIC_COLUMNS =
  'id, role, invited_by, email, status, expires_at, accepted_by, accepted_at, created_at';

export const invitesDb = {
  /**
   * Creates a pending invite. Stores only the token hash. `expiresAt` must be
   * an ISO 8601 / SQLite datetime string in UTC.
   */
  create(params: {
    tokenHash: string;
    role: UserRole;
    invitedBy: number;
    email?: string | null;
    expiresAt: string;
  }): number {
    const db = getConnection();
    const result = db
      .prepare(
        `INSERT INTO invites (token_hash, role, invited_by, email, status, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        params.tokenHash,
        params.role,
        params.invitedBy,
        params.email ?? null,
        params.expiresAt
      );
    return Number(result.lastInsertRowid);
  },

  /** Looks up an invite by its token hash (any status). */
  findByTokenHash(tokenHash: string): InviteRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM invites WHERE token_hash = ?')
      .get(tokenHash) as InviteRow | undefined;
  },

  /**
   * Marks a pending, unexpired invite as accepted in a single atomic UPDATE.
   * Returns true if exactly one row transitioned (guards against double-use
   * and expiry races). `now` is a SQLite datetime string (UTC).
   */
  markAccepted(tokenHash: string, acceptedBy: number, now: string): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE invites
            SET status = 'accepted', accepted_by = ?, accepted_at = ?
          WHERE token_hash = ?
            AND status = 'pending'
            AND expires_at > ?`
      )
      .run(acceptedBy, now, tokenHash, now);
    return result.changes === 1;
  },

  /** Revokes a pending invite by id. Returns true if it was pending. */
  revoke(id: number): boolean {
    const db = getConnection();
    const result = db
      .prepare("UPDATE invites SET status = 'revoked' WHERE id = ? AND status = 'pending'")
      .run(id);
    return result.changes === 1;
  },

  /** Lists invites (newest first) without exposing token hashes. */
  list(): InvitePublicRow[] {
    const db = getConnection();
    return db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM invites ORDER BY id DESC`)
      .all() as InvitePublicRow[];
  },
};

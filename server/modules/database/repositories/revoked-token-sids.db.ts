/**
 * revoked_token_sids repository (ADR-212, T-2035 round 3).
 *
 * A row is one signed-out device session (`sid` claim of its JWTs), kept only
 * until those tokens could no longer be used or renewed (`expires_at`).
 * Expired rows are pruned on every write. Verifiers ask `isRevoked` per
 * request: one primary-key lookup, so a revocation written by any process or
 * connection is seen by the very next request (no in-process cache to go
 * stale).
 */

import { getConnection } from '@/modules/database/connection.js';

export type RevokedTokenSidRow = { sid: string; expires_at: number };

export const revokedTokenSidsDb = {
  /**
   * Records a signed-out sid and prunes rows past their expiry, in one
   * transaction. Re-revoking keeps the later expiry.
   */
  revoke({ sid, userId, revokedAt, expiresAt }: {
    sid: string; userId: number; revokedAt: number; expiresAt: number;
  }): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('DELETE FROM revoked_token_sids WHERE expires_at <= ?').run(revokedAt);
      db.prepare(`INSERT INTO revoked_token_sids (sid, user_id, revoked_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET expires_at = max(expires_at, excluded.expires_at)`)
        .run(sid, userId, revokedAt, expiresAt);
    }).immediate();
  },

  /** True while `sid` has a revocation in force at `nowMs` (primary-key lookup). */
  isRevoked(sid: string, nowMs: number): boolean {
    return getConnection()
      .prepare('SELECT 1 FROM revoked_token_sids WHERE sid = ? AND expires_at > ?')
      .get(sid, nowMs) !== undefined;
  },

  /** Every revocation still in force at `nowMs`. */
  listActive(nowMs: number): RevokedTokenSidRow[] {
    return getConnection()
      .prepare('SELECT sid, expires_at FROM revoked_token_sids WHERE expires_at > ?')
      .all(nowMs) as RevokedTokenSidRow[];
  },

  /** Deletes rows past their expiry; returns the count. */
  pruneExpired(nowMs: number): number {
    return getConnection().prepare('DELETE FROM revoked_token_sids WHERE expires_at <= ?').run(nowMs).changes;
  },
};

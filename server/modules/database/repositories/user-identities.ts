/**
 * user_identities repository.
 * Bridges external IdP identities (issuer + subject) to local users.
 * Used by the OIDC Relying Party flow (P-IDP-3, ADR-046).
 *
 * The (issuer, subject) pair is the natural key for an external identity and is
 * UNIQUE at the schema level, so an IdP identity links to at most one local
 * user. link() therefore throws on a duplicate (the caller maps the violation to
 * a conflict). All mutations that target a single link are scoped by user_id so
 * a caller can never unlink an identity it does not own even with a guessed
 * issuer/subject.
 */
import { getConnection } from '@/modules/database/connection.js';

export type UserIdentityRow = {
  id: number;
  user_id: number;
  issuer: string;
  subject: string;
  created_at: string;
  /** Epoch ms of the last SSO login that carried a recognized role (T-1939). */
  last_attested_at: number | null;
};

export const userIdentitiesDb = {
  /** Find a linked identity by IdP (iss + sub). Returns undefined if not linked. */
  findByIssuerAndSubject(issuer: string, subject: string): UserIdentityRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM user_identities WHERE issuer = ? AND subject = ?')
      .get(issuer, subject) as UserIdentityRow | undefined;
  },

  /** List all IdP identities linked to a user (for admin UI). */
  findByUserId(userId: number): UserIdentityRow[] {
    return getConnection()
      .prepare('SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at')
      .all(userId) as UserIdentityRow[];
  },

  /**
   * Link a local user to an IdP identity and return the new link id. Throws on
   * a duplicate (UNIQUE(issuer, subject), and UNIQUE(user_id, issuer) once that
   * index exists). The only caller is the member self-link callback (T-1939
   * slice 5), which runs it inside one transaction with markAttested.
   */
  link(userId: number, issuer: string, subject: string): number {
    const result = getConnection()
      .prepare('INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, ?, ?)')
      .run(userId, issuer, subject);
    return Number(result.lastInsertRowid);
  },

  /** Number of links `userId` holds for `issuer` (>1 only on a legacy duplicate). */
  countForUserAndIssuer(userId: number, issuer: string): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ? AND issuer = ?')
      .get(userId, issuer) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  /**
   * Number of users holding more than one link for the same issuer — the rows
   * that block the UNIQUE(user_id, issuer) index (T-1939 slice 5). Count only.
   */
  countUsersWithDuplicateIssuerLinks(): number {
    const row = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT user_id FROM user_identities
        GROUP BY user_id, issuer HAVING COUNT(*) > 1)`)
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  },

  /**
   * Stamps the successful SSO attestation of one link (T-1939). Scoped by
   * user_id as well as the link id so a stale id can never touch another user.
   * Returns true only when exactly that link was stamped.
   */
  markAttested(identityId: number, userId: number, attestedAtMs: number): boolean {
    return getConnection()
      .prepare('UPDATE user_identities SET last_attested_at = ? WHERE id = ? AND user_id = ?')
      .run(attestedAtMs, identityId, userId).changes === 1;
  },

  /** Whether the user holds at least one IdP link (SSO-only gate, T-1939). */
  hasAnyLink(userId: number): boolean {
    return getConnection()
      .prepare('SELECT 1 FROM user_identities WHERE user_id = ? LIMIT 1')
      .get(userId) !== undefined;
  },

  /**
   * Link count and newest SSO attestation (epoch ms, null when never stamped)
   * of one user, in a single read (T-1939 slice 3 freshness gate).
   */
  attestationSummary(userId: number): { linkCount: number; latestAttestedAt: number | null } {
    const row = getConnection()
      .prepare(`SELECT COUNT(*) AS linkCount, MAX(last_attested_at) AS latestAttestedAt
        FROM user_identities WHERE user_id = ?`)
      .get(userId) as { linkCount: number; latestAttestedAt: number | null } | undefined;
    return { linkCount: row?.linkCount ?? 0, latestAttestedAt: row?.latestAttestedAt ?? null };
  },

  /**
   * Active linked NON-OWNER users whose newest attestation is older than
   * `cutoffMs` (or was never stamped), ascending by id after `afterUserId`, at
   * most `limit` rows (T-1939 slice 3 sweep). MAX() skips NULLs, so a user with
   * only unstamped links yields NULL and counts as stale.
   */
  listStaleLinkedNonOwners(
    cutoffMs: number,
    afterUserId: number,
    limit: number,
  ): Array<{ userId: number; latestAttestedAt: number | null }> {
    return getConnection()
      .prepare(`SELECT ui.user_id AS userId, MAX(ui.last_attested_at) AS latestAttestedAt
        FROM user_identities ui JOIN users u ON u.id = ui.user_id
        WHERE u.role <> 'owner' AND u.is_active = 1 AND u.status = 'active'
          AND ui.user_id > ?
        GROUP BY ui.user_id
        HAVING MAX(ui.last_attested_at) IS NULL OR MAX(ui.last_attested_at) < ?
        ORDER BY ui.user_id
        LIMIT ?`)
      .all(afterUserId, cutoffMs, limit) as Array<{ userId: number; latestAttestedAt: number | null }>;
  },

  /** Remove a specific IdP identity link owned by this user. */
  unlink(userId: number, issuer: string, subject: string): void {
    getConnection()
      .prepare('DELETE FROM user_identities WHERE user_id = ? AND issuer = ? AND subject = ?')
      .run(userId, issuer, subject);
  },

  /** Number of distinct users with `role` that hold at least one IdP link. */
  countLinkedUsersWithRole(role: string): number {
    const row = getConnection()
      .prepare(`SELECT COUNT(DISTINCT ui.user_id) AS n
        FROM user_identities ui JOIN users u ON u.id = ui.user_id
        WHERE u.role = ?`)
      .get(role) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  /** Remove all IdP links for a user (used on account deletion). */
  unlinkAll(userId: number): void {
    getConnection()
      .prepare('DELETE FROM user_identities WHERE user_id = ?')
      .run(userId);
  },
};

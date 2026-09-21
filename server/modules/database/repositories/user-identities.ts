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

  /** Link a local user to an IdP identity. Throws on duplicate (UNIQUE constraint). */
  link(userId: number, issuer: string, subject: string): void {
    getConnection()
      .prepare('INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, ?, ?)')
      .run(userId, issuer, subject);
  },

  /** Remove a specific IdP identity link owned by this user. */
  unlink(userId: number, issuer: string, subject: string): void {
    getConnection()
      .prepare('DELETE FROM user_identities WHERE user_id = ? AND issuer = ? AND subject = ?')
      .run(userId, issuer, subject);
  },

  /** Remove all IdP links for a user (used on account deletion). */
  unlinkAll(userId: number): void {
    getConnection()
      .prepare('DELETE FROM user_identities WHERE user_id = ?')
      .run(userId);
  },
};

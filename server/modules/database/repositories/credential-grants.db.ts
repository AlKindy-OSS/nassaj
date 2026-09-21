/**
 * credential-grants.db — rows of `provider_credential_grants` (T-1675).
 *
 * A grant says "owner's <provider> credential may be used by grantee". The
 * repository is deliberately dumb: it stores and reads rows. Which row is
 * EFFECTIVE for a spawn (active users only, first non-declined, no chaining)
 * is decided by `resolveCredentialPrincipal` in
 * server/services/isolation/credential-principal.js, the single seam every
 * spawn path already funnels through.
 *
 * `version()` is a monotonic counter bumped by every write in this process, so
 * the spawn-path cache can answer "has anything changed since I looked" without
 * a query. This install runs one server process, so in-process is enough.
 */

import { getConnection } from '@/modules/database/connection.js';

export type CredentialGrantRow = {
  ownerUserId: number;
  granteeUserId: number;
  provider: string;
  createdAt: string;
  declinedAt: string | null;
};

type DbRow = {
  owner_user_id: number;
  grantee_user_id: number;
  provider: string;
  created_at: string;
  declined_at: string | null;
};

const SELECT_COLUMNS =
  'owner_user_id, grantee_user_id, provider, created_at, declined_at';

let writeVersion = 0;

function numericUserId(userId: string | number | null | undefined): number | null {
  if (userId === null || userId === undefined || userId === '') return null;
  const parsed = Number(userId);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toPublic(row: DbRow): CredentialGrantRow {
  return {
    ownerUserId: row.owner_user_id,
    granteeUserId: row.grantee_user_id,
    provider: row.provider,
    createdAt: row.created_at,
    declinedAt: row.declined_at,
  };
}

export const credentialGrantsDb = {
  /** Monotonic write counter for cache invalidation (in-process). */
  version(): number {
    return writeVersion;
  },

  /** Every grant this owner has given, all providers, oldest first. */
  listByOwner(ownerUserId: string | number | null | undefined): CredentialGrantRow[] {
    const owner = numericUserId(ownerUserId);
    if (owner === null) return [];
    const rows = getConnection()
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM provider_credential_grants
          WHERE owner_user_id = ?
          ORDER BY provider ASC, created_at ASC, grantee_user_id ASC`,
      )
      .all(owner) as DbRow[];
    return rows.map(toPublic);
  },

  /** Every grant offered to this grantee, declined ones included, oldest first. */
  listByGrantee(granteeUserId: string | number | null | undefined): CredentialGrantRow[] {
    const grantee = numericUserId(granteeUserId);
    if (grantee === null) return [];
    const rows = getConnection()
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM provider_credential_grants
          WHERE grantee_user_id = ?
          ORDER BY provider ASC, created_at ASC, owner_user_id ASC`,
      )
      .all(grantee) as DbRow[];
    return rows.map(toPublic);
  },

  /**
   * Non-declined grants offered to `grantee` for `provider` whose owner is an
   * ACTIVE account, oldest first. The first one is the effective grant; an owner
   * who was disabled or deleted stops sharing without any bookkeeping.
   */
  listUsableForGrantee(
    granteeUserId: string | number | null | undefined,
    provider: string,
  ): CredentialGrantRow[] {
    const grantee = numericUserId(granteeUserId);
    if (grantee === null || !provider) return [];
    const rows = getConnection()
      .prepare(
        `SELECT g.owner_user_id, g.grantee_user_id, g.provider, g.created_at, g.declined_at
           FROM provider_credential_grants g
           JOIN users u ON u.id = g.owner_user_id
          WHERE g.grantee_user_id = ? AND g.provider = ? AND g.declined_at IS NULL
            AND u.is_active = 1 AND u.status = 'active'
          ORDER BY g.created_at ASC, g.owner_user_id ASC`,
      )
      .all(grantee, provider) as DbRow[];
    return rows.map(toPublic);
  },

  /**
   * Every usable grant offered to `grantee` across ALL providers (same
   * predicate as listUsableForGrantee), oldest first — one query per spawn.
   */
  listUsableByGrantee(granteeUserId: string | number | null | undefined): CredentialGrantRow[] {
    const grantee = numericUserId(granteeUserId);
    if (grantee === null) return [];
    const rows = getConnection()
      .prepare(
        `SELECT g.owner_user_id, g.grantee_user_id, g.provider, g.created_at, g.declined_at
           FROM provider_credential_grants g
           JOIN users u ON u.id = g.owner_user_id
          WHERE g.grantee_user_id = ? AND g.declined_at IS NULL
            AND u.is_active = 1 AND u.status = 'active'
          ORDER BY g.created_at ASC, g.owner_user_id ASC`,
      )
      .all(grantee) as DbRow[];
    return rows.map(toPublic);
  },

  /** Creates the grant if absent; an existing row (declined or not) is left as is. */
  grant(
    ownerUserId: string | number,
    granteeUserId: string | number,
    provider: string,
  ): boolean {
    const owner = numericUserId(ownerUserId);
    const grantee = numericUserId(granteeUserId);
    if (owner === null || grantee === null || owner === grantee || !provider) {
      throw new Error('credential grant requires two distinct valid user ids and a provider');
    }
    const result = getConnection()
      .prepare(
        `INSERT OR IGNORE INTO provider_credential_grants (owner_user_id, grantee_user_id, provider)
         VALUES (?, ?, ?)`,
      )
      .run(owner, grantee, provider);
    if (result.changes > 0) writeVersion += 1;
    return result.changes > 0;
  },

  /** Owner-side revocation: the row disappears for both parties. */
  revoke(
    ownerUserId: string | number,
    granteeUserId: string | number,
    provider: string,
  ): boolean {
    const owner = numericUserId(ownerUserId);
    const grantee = numericUserId(granteeUserId);
    if (owner === null || grantee === null || !provider) return false;
    const result = getConnection()
      .prepare(
        `DELETE FROM provider_credential_grants
          WHERE owner_user_id = ? AND grantee_user_id = ? AND provider = ?`,
      )
      .run(owner, grantee, provider);
    if (result.changes > 0) writeVersion += 1;
    return result.changes > 0;
  },

  /**
   * Grantee-side switch. `declined = true` parks the grant (the grantee runs on
   * their own credential); `false` picks it back up. Returns false when no such
   * row exists — a grantee cannot conjure a grant by "accepting" one.
   */
  setDeclined(
    ownerUserId: string | number,
    granteeUserId: string | number,
    provider: string,
    declined: boolean,
  ): boolean {
    const owner = numericUserId(ownerUserId);
    const grantee = numericUserId(granteeUserId);
    if (owner === null || grantee === null || !provider) return false;
    const result = getConnection()
      .prepare(
        `UPDATE provider_credential_grants
            SET declined_at = ${declined ? 'CURRENT_TIMESTAMP' : 'NULL'}
          WHERE owner_user_id = ? AND grantee_user_id = ? AND provider = ?`,
      )
      .run(owner, grantee, provider);
    if (result.changes > 0) writeVersion += 1;
    return result.changes > 0;
  },
};

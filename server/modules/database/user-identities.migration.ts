import type { Database } from 'better-sqlite3';

import {
  USER_IDENTITIES_TABLE_SCHEMA_SQL,
  USER_IDENTITIES_USER_ID_INDEX_SQL,
  USER_IDENTITIES_USER_ISSUER_UNIQUE_INDEX_SQL,
} from './schema.js';

const DUPLICATE_USER_ISSUER_COUNT_SQL = `SELECT COUNT(*) AS n FROM (SELECT user_id FROM user_identities
  GROUP BY user_id, issuer HAVING COUNT(*) > 1)`;

/**
 * OIDC identity links (P-IDP-3, ADR-046) plus the T-1939 attestation stamp.
 * `last_attested_at` (epoch ms, nullable) records the last successful SSO login
 * that carried a recognized project role. It is additive: existing rows keep
 * NULL (never attested under the new rule). Probe and ALTER share one immediate
 * transaction so two admitted processes cannot both add the column. The
 * user_id index (idempotent) serves the per-request attestation lookup.
 *
 * T-1939 slice 5: UNIQUE(user_id, issuer) is added only when no user already
 * holds two links for one issuer. Duplicates are never deleted or merged here:
 * the index is skipped, a count-only warning is written, and the SSO login of
 * the affected users is refused until the owner removes the extra links (the
 * next boot then creates the index).
 *
 * @returns the number of users whose duplicate links blocked the unique index
 */
export function migrateUserIdentities(db: Database): number {
  const duplicateUsers = db.transaction(() => {
    db.exec(USER_IDENTITIES_TABLE_SCHEMA_SQL);
    const columns = db.prepare('PRAGMA table_info(user_identities)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'last_attested_at')) {
      db.exec('ALTER TABLE user_identities ADD COLUMN last_attested_at INTEGER');
    }
    db.exec(USER_IDENTITIES_USER_ID_INDEX_SQL);
    const { n } = db.prepare(DUPLICATE_USER_ISSUER_COUNT_SQL).get() as { n: number };
    if (n === 0) {
      db.exec(USER_IDENTITIES_USER_ISSUER_UNIQUE_INDEX_SQL);
    }
    return n;
  }).immediate();
  if (duplicateUsers > 0) {
    process.stderr.write(`${JSON.stringify({
      level: 'warn', scope: 'oidc', code: 'user_issuer_unique_index_skipped', duplicateUsers,
    })}\n`);
  }
  return duplicateUsers;
}

/** Explicit rollback of the T-1939 column; never invoked automatically. */
export function rollbackUserIdentitiesAttestation(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(user_identities)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'last_attested_at')) {
    db.exec('ALTER TABLE user_identities DROP COLUMN last_attested_at');
  }
}

/** Explicit rollback of the T-1939 user_id index; never invoked automatically. */
export function rollbackUserIdentitiesUserIdIndex(db: Database): void {
  db.exec('DROP INDEX IF EXISTS idx_user_identities_user_id');
}

/** Explicit rollback of the T-1939 slice 5 UNIQUE(user_id, issuer) index; never automatic. */
export function rollbackUserIdentitiesUserIssuerIndex(db: Database): void {
  db.exec('DROP INDEX IF EXISTS idx_user_identities_user_issuer');
}

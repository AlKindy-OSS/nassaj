/**
 * provider-sharing-retirement-notice — the one-time notice (ADR-152 A1 §3.10, D3).
 *
 * Owner-role accounts see one notice after the upgrade that retired the
 * install-wide `provider_sharing` policy: which providers were shared, which
 * had an install-wide vendor key, and which members were active at retirement.
 * It says nothing about which members have linked since (no enumeration of
 * members' credential presence, ADR-121 non-disclosure). No grant is created.
 *
 * It is the ONLY reader of the non-runtime snapshot `provider_sharing_retirement`
 * written by the migration; nothing here decides a spawn, status or catalog.
 * Acknowledging is idempotent and strictly audited. A retirement that shared
 * nothing and found no install-wide key is recorded but not announced.
 */

import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';
import { recordStrictAuditOnConnection } from '@/modules/database/repositories/audit-log.js';

export type RetirementNotice = {
  retiredAt: string;
  sharedProviders: string[];
  /** Providers that had an install-wide vendor key, or 'unknown' when unreadable at retirement. */
  orgKeyProviders: string[] | 'unknown';
  members: Array<{ userId: number; username: string }>;
  /**
   * qa condition 8: owner-role accounts lose the inherited operator credential
   * too (D2) and must link their own account in their own tree.
   */
  ownersMustLinkOwnAccount: true;
};

type SnapshotRow = {
  retired_at: string;
  shared_providers: string;
  org_key_providers: string;
  members_at_retirement: string;
  notice_acknowledged_at: string | null;
};

const parseIds = (raw: string): number[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
};

const parseStrings = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

/** The snapshot table exists only once the migration ran. */
function hasSnapshotTable(db: Database): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'provider_sharing_retirement'",
  ).get());
}

/** Usernames for the members active at retirement (ids of deleted users are dropped). */
function membersOf(db: Database, ids: number[]): Array<{ userId: number; username: string }> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id, username FROM users WHERE id IN (${placeholders}) ORDER BY id`)
    .all(...ids) as Array<{ id: number; username: string }>;
  return rows.map((row) => ({ userId: row.id, username: row.username }));
}

export const providerSharingRetirementNoticeService = {
  /**
   * The pending notice, or null when there is no snapshot or it was acknowledged.
   * @param db connection (defaults to the app connection)
   */
  getNotice(db: Database = getConnection()): RetirementNotice | null {
    if (!hasSnapshotTable(db)) return null;
    const row = db.prepare(`SELECT retired_at, shared_providers, org_key_providers, members_at_retirement,
      notice_acknowledged_at FROM provider_sharing_retirement WHERE id = 1`).get() as SnapshotRow | undefined;
    if (!row || row.notice_acknowledged_at !== null) return null;
    const sharedProviders = parseStrings(row.shared_providers);
    const orgKeyProviders = row.org_key_providers === 'unknown' ? 'unknown' : parseStrings(row.org_key_providers);
    // A node that shared nothing and held no install-wide key lost nothing at
    // retirement: the snapshot stays on record, but there is nothing to announce.
    if (sharedProviders.length === 0 && Array.isArray(orgKeyProviders) && orgKeyProviders.length === 0) return null;
    return {
      retiredAt: row.retired_at,
      sharedProviders,
      orgKeyProviders,
      members: membersOf(db, parseIds(row.members_at_retirement)),
      ownersMustLinkOwnAccount: true,
    };
  },

  /**
   * Marks the notice acknowledged by `userId`. Idempotent: only the first call
   * writes, and it writes the strict audit row in the same transaction.
   * @returns true when this call acknowledged it
   */
  acknowledge(userId: number, db: Database = getConnection()): boolean {
    if (!hasSnapshotTable(db)) return false;
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE provider_sharing_retirement
        SET notice_acknowledged_at = ?, notice_acknowledged_by = ?
        WHERE id = 1 AND notice_acknowledged_at IS NULL`).run(new Date().toISOString(), userId).changes;
      if (changed === 0) return false;
      recordStrictAuditOnConnection(db, 'provider_sharing_notice_acknowledged', { userId, metadata: {} });
      return true;
    }).immediate();
  },
};

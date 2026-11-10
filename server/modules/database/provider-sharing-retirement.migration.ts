/**
 * retire_provider_sharing_v1 — ADR-152 amendment 1 §3.2 (T-2083, B-1741).
 *
 * The install-wide `provider_sharing` policy is no longer read by any runtime
 * path (isolation is a code constant, §3.1). This migration is the RECORD and
 * the CLEANUP, not the safety mechanism:
 *
 *   1. a single, permanent snapshot row in `provider_sharing_retirement` (the raw
 *      stored policy verbatim, which providers were shared, which install-wide
 *      vendor keys were present, which members were active);
 *   2. one strict audit row `provider_sharing_retired`, retained past the prune;
 *   3. deletion of the `provider_sharing` key from app_config.
 *
 * All three happen inside ONE `BEGIN IMMEDIATE` transaction on the CALLER's
 * connection (a second connection would contend for the write lock, qa
 * condition 3). If the strict audit fails, the transaction rolls back, the error
 * is logged loudly, boot continues, and the next boot retries. Nothing here may
 * throw into the boot path.
 *
 * The snapshot table is NON-RUNTIME: only the one-time retirement notice
 * (§3.10) reads it. No spawn, status or catalog decision may derive from it.
 */

import type { Database } from 'better-sqlite3';

import { listSharedVendorKeyPresence } from '@/services/isolation/provider-secrets-store.js';

// Namespace import: several test files mock the audit repository with a partial
// export set, which would break a named import at link time.
import * as auditLog from './repositories/audit-log.js';

/** The retired app_config key. Read verbatim here, never normalised. */
const RETIRED_CONFIG_KEY = 'provider_sharing';

/** Stored in `org_key_providers` when key presence could not be determined. */
export const ORG_KEY_PRESENCE_UNKNOWN = 'unknown';

/** The single-row snapshot table (§3.2 step 3). Non-runtime. */
export const PROVIDER_SHARING_RETIREMENT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS provider_sharing_retirement (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  retired_at TEXT NOT NULL,
  raw_policy TEXT,
  shared_providers TEXT NOT NULL,
  org_key_providers TEXT NOT NULL,
  members_at_retirement TEXT NOT NULL,
  notice_acknowledged_at TEXT,
  notice_acknowledged_by INTEGER
)`;

export type RetirementOutcome =
  | 'retired'
  | 'already_retired'
  | 'nothing_to_retire'
  | 'deferred'
  | 'failed';

export type RetirementDeps = {
  /** Vendor slots with an install-wide key, by presence only; throws if unknown. */
  orgKeyProviders?: () => string[];
  /** Strict audit on the same connection; injectable to force a failure in tests. */
  audit?: typeof auditLog.recordStrictAuditOnConnection;
  /** Clock for `retired_at`. */
  now?: () => Date;
};

/** Providers whose RAW stored value was exactly 'shared'; [] for anything unparsable. */
function sharedProvidersOf(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, mode]) => mode === 'shared')
      .map(([provider]) => provider);
  } catch {
    return [];
  }
}

/** Org-key presence as stored: a JSON array, or the literal 'unknown'. */
function orgKeyPresence(read: () => string[]): { stored: string; value: string[] | typeof ORG_KEY_PRESENCE_UNKNOWN } {
  try {
    const providers = read();
    return { stored: JSON.stringify(providers), value: providers };
  } catch (error) {
    console.error('[provider-sharing-retirement] install-wide key presence unknown (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { stored: ORG_KEY_PRESENCE_UNKNOWN, value: ORG_KEY_PRESENCE_UNKNOWN };
  }
}

/** Active non-owner members at the moment of retirement (ids only). */
function activeMembers(db: Database): number[] {
  return (db.prepare(
    "SELECT id FROM users WHERE role != 'owner' AND is_active = 1 AND status = 'active' ORDER BY id",
  ).all() as Array<{ id: number }>).map((row) => row.id);
}

/** The transaction body; returns the outcome, throws to roll back. */
function retireInTransaction(db: Database, deps: Required<RetirementDeps>): RetirementOutcome {
  if (db.prepare('SELECT 1 FROM provider_sharing_retirement WHERE id = 1').get()) {
    return 'already_retired';
  }
  const stored = db.prepare('SELECT value FROM app_config WHERE key = ?').get(RETIRED_CONFIG_KEY) as
    { value: string } | undefined;
  const rawPolicy = stored?.value ?? null;
  const orgKeys = orgKeyPresence(deps.orgKeyProviders);
  if (rawPolicy === null && Array.isArray(orgKeys.value) && orgKeys.value.length === 0) {
    return 'nothing_to_retire';
  }
  const sharedProviders = sharedProvidersOf(rawPolicy);
  const members = activeMembers(db);
  db.prepare(`INSERT INTO provider_sharing_retirement
    (id, retired_at, raw_policy, shared_providers, org_key_providers, members_at_retirement)
    VALUES (1, ?, ?, ?, ?, ?)`).run(
    deps.now().toISOString(), rawPolicy, JSON.stringify(sharedProviders), orgKeys.stored, JSON.stringify(members),
  );
  deps.audit(db, 'provider_sharing_retired', {
    userId: null,
    metadata: { rawPolicy, sharedProviders, orgKeyProviders: orgKeys.value, memberCount: members.length },
  });
  db.prepare('DELETE FROM app_config WHERE key = ?').run(RETIRED_CONFIG_KEY);
  return 'retired';
}

/**
 * Runs retire_provider_sharing_v1 once. Idempotent; never throws.
 *
 * Inside an already-open transaction (the connector fence wraps runMigrations,
 * B-1147) it defers: `BEGIN IMMEDIATE` cannot nest, and a second connection is
 * forbidden. The boot path calls it again right after the fenced block.
 *
 * @param db the boot connection
 * @param deps test seams; production uses the real store, strict audit and clock
 */
export function retireProviderSharing(db: Database, deps: RetirementDeps = {}): RetirementOutcome {
  if (db.inTransaction) {
    return 'deferred';
  }
  const resolved: Required<RetirementDeps> = {
    orgKeyProviders: deps.orgKeyProviders ?? listSharedVendorKeyPresence,
    audit: deps.audit ?? auditLog.recordStrictAuditOnConnection,
    now: deps.now ?? (() => new Date()),
  };
  try {
    db.exec(PROVIDER_SHARING_RETIREMENT_TABLE_SQL);
    const outcome = db.transaction(() => retireInTransaction(db, resolved)).immediate();
    if (outcome === 'retired') {
      console.log('[provider-sharing-retirement] install-wide provider sharing retired (ADR-152 A1)');
    }
    return outcome;
  } catch (error) {
    console.error('[provider-sharing-retirement] FAILED — rolled back, boot continues, retried next boot', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/**
 * login_throttle repository (ADR-212, T-2035).
 *
 * Stores per-identifier failure counters keyed by an HMAC (`key_hash`); the
 * raw identifier never reaches this table. The policy lives in
 * services/login-throttle.service.ts; this layer only reads and writes rows,
 * and runs each admission as one IMMEDIATE transaction so concurrent password
 * checks cannot both read the old count.
 */

import { getConnection } from '@/modules/database/connection.js';

export type LoginThrottleRow = {
  key_hash: string;
  failures: number;
  first_failure_at: number;
  locked_until: number | null;
  lock_count: number;
  updated_at: number;
};

export const loginThrottleDb = {
  /** The row for a key hash, or undefined. */
  get(keyHash: string): LoginThrottleRow | undefined {
    return getConnection()
      .prepare(`SELECT key_hash, failures, first_failure_at, locked_until, lock_count, updated_at
        FROM login_throttle WHERE key_hash = ?`)
      .get(keyHash) as LoginThrottleRow | undefined;
  },

  /** Inserts or replaces the row for its key hash. */
  put(row: LoginThrottleRow): void {
    getConnection()
      .prepare(`INSERT INTO login_throttle
          (key_hash, failures, first_failure_at, locked_until, lock_count, updated_at)
        VALUES (@key_hash, @failures, @first_failure_at, @locked_until, @lock_count, @updated_at)
        ON CONFLICT(key_hash) DO UPDATE SET
          failures = excluded.failures, first_failure_at = excluded.first_failure_at,
          locked_until = excluded.locked_until, lock_count = excluded.lock_count,
          updated_at = excluded.updated_at`)
      .run(row);
  },

  /** Removes the row for a key hash; returns how many rows were deleted (0 or 1). */
  delete(keyHash: string): number {
    return getConnection().prepare('DELETE FROM login_throttle WHERE key_hash = ?').run(keyHash).changes;
  },

  /** Deletes rows untouched since `cutoffMs` (24 h decay); returns the count. */
  pruneOlderThan(cutoffMs: number): number {
    return getConnection()
      .prepare('DELETE FROM login_throttle WHERE updated_at < ?')
      .run(cutoffMs).changes;
  },

  /** Runs `work` inside one IMMEDIATE transaction on the shared connection. */
  inTransaction<T>(work: () => T): T {
    return getConnection().transaction(work).immediate();
  },
};

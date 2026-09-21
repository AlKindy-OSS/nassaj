/**
 * provider_run_failures repository (T-1191).
 *
 * Holds the cause of the LAST failed run per conversation, so a failure whose
 * only evidence was a line on the provider's stderr survives a page reload.
 * See PROVIDER_RUN_FAILURES_TABLE_SCHEMA_SQL for why the table exists at all.
 *
 * Every method here is best-effort by contract: a failure to record a failure
 * must never escalate into a second failure on the run path. Callers get a
 * boolean/null rather than an exception.
 */

import { getConnection } from '@/modules/database/connection.js';
import { parseStoredTimestampMs } from '@/modules/database/utils/timestamps.js';

export type ProviderRunFailureRow = {
  sessionId: string;
  provider: string;
  reason: string;
  exitCode: number | null;
  /** Epoch ms of the provider's quota reset, or null when unrelated to quota. */
  quotaResetsAtMs: number | null;
  failedAtMs: number | null;
};

/**
 * Formats an instant as SQLite's own `YYYY-MM-DD HH:MM:SS` **UTC** text.
 *
 * NOT `toISOString()`, and the difference is a real bug rather than a style
 * preference: `quota_resets_at` is compared in SQL against `CURRENT_TIMESTAMP`,
 * which produces exactly this timezone-less shape. An ISO string carries a `T`
 * where CURRENT_TIMESTAMP carries a space, and `'T' (0x54) > ' ' (0x20)` in a
 * text comparison — so on the SAME calendar day an ISO-formatted deadline sorts
 * as later than *any* current timestamp, and an elapsed quota block would keep
 * reporting itself active until the date rolled over. Same UTC-vs-local trap
 * documented in `parseStoredTimestampMs`, one layer down.
 */
const toSqliteUtc = (epochMs: number): string =>
  new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);

type ProviderRunFailureDbRow = {
  session_id: string;
  provider: string;
  reason: string;
  exit_code: number | null;
  quota_resets_at: string | null;
  failed_at: string;
};

const toRow = (row: ProviderRunFailureDbRow): ProviderRunFailureRow => ({
  sessionId: row.session_id,
  provider: row.provider,
  reason: row.reason,
  exitCode: row.exit_code,
  quotaResetsAtMs: parseStoredTimestampMs(row.quota_resets_at),
  failedAtMs: parseStoredTimestampMs(row.failed_at),
});

export const providerRunFailuresDb = {
  /**
   * Records (or replaces) the failure for a conversation. One row per session:
   * a newer failure overwrites the older one, because what the UI shows is the
   * current state of the last run, not a history of every stumble.
   *
   * `quotaResetsAtMs` must be a real parsed instant or null — never a guess.
   */
  recordFailure(input: {
    sessionId: string;
    provider: string;
    reason: string;
    exitCode?: number | null;
    quotaResetsAtMs?: number | null;
  }): boolean {
    if (!input.sessionId || !input.provider || !input.reason) return false;
    try {
      const db = getConnection();
      db.prepare(
        `INSERT INTO provider_run_failures
           (session_id, provider, reason, exit_code, quota_resets_at, failed_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(session_id) DO UPDATE SET
           provider        = excluded.provider,
           reason          = excluded.reason,
           exit_code       = excluded.exit_code,
           quota_resets_at = excluded.quota_resets_at,
           failed_at       = CURRENT_TIMESTAMP`
      ).run(
        input.sessionId,
        input.provider,
        input.reason,
        input.exitCode ?? null,
        typeof input.quotaResetsAtMs === 'number' && Number.isFinite(input.quotaResetsAtMs)
          ? toSqliteUtc(input.quotaResetsAtMs)
          : null
      );
      return true;
    } catch (error) {
      console.warn(
        '[providerRunFailuresDb] recordFailure failed (non-fatal):',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  },

  /**
   * Drops a conversation's failure row. Called on every SUCCESSFUL run so a
   * healed conversation stops displaying a dead error — the stale-marker defect
   * this table would otherwise introduce.
   */
  clearFailure(sessionId: string): boolean {
    if (!sessionId) return false;
    try {
      const db = getConnection();
      db.prepare('DELETE FROM provider_run_failures WHERE session_id = ?').run(sessionId);
      return true;
    } catch (error) {
      console.warn(
        '[providerRunFailuresDb] clearFailure failed (non-fatal):',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  },

  /** The recorded failure for a conversation, or null when its last run was fine. */
  getFailure(sessionId: string): ProviderRunFailureRow | null {
    if (!sessionId) return null;
    try {
      const db = getConnection();
      const row = db
        .prepare(
          `SELECT session_id, provider, reason, exit_code, quota_resets_at, failed_at
             FROM provider_run_failures
            WHERE session_id = ?`
        )
        .get(sessionId) as ProviderRunFailureDbRow | undefined;
      return row ? toRow(row) : null;
    } catch (error) {
      console.warn(
        '[providerRunFailuresDb] getFailure failed (non-fatal):',
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  },

  /**
   * The provider's currently-active quota block: the furthest reset instant
   * still in the future, or null when the provider is not quota-blocked.
   *
   * Reads the FURTHEST (MAX) rather than the most recent row on purpose. The
   * quota is an account-level fact shared by every conversation, so two blocked
   * sessions describe one block seen twice; the later deadline is the one that
   * actually governs, and a chronologically-newer row can carry an EARLIER
   * deadline simply because its countdown started later.
   *
   * The comparison is done in SQL against CURRENT_TIMESTAMP, so an elapsed
   * block disappears on its own without any sweeper — the row stays as the
   * conversation's failure record while ceasing to be a live block.
   */
  getActiveQuotaBlock(provider: string): { resetsAtMs: number; reason: string } | null {
    if (!provider) return null;
    try {
      const db = getConnection();
      const row = db
        .prepare(
          `SELECT quota_resets_at, reason
             FROM provider_run_failures
            WHERE provider = ?
              AND quota_resets_at IS NOT NULL
              AND quota_resets_at > CURRENT_TIMESTAMP
            ORDER BY quota_resets_at DESC
            LIMIT 1`
        )
        .get(provider) as { quota_resets_at: string; reason: string } | undefined;
      if (!row) return null;
      const resetsAtMs = parseStoredTimestampMs(row.quota_resets_at);
      return resetsAtMs === null ? null : { resetsAtMs, reason: row.reason };
    } catch (error) {
      console.warn(
        '[providerRunFailuresDb] getActiveQuotaBlock failed (non-fatal):',
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  },
};

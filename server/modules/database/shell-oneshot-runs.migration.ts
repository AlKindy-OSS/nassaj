import type { Database } from 'better-sqlite3';

/**
 * T-2037 (ADR-213): the durable ledger of composer shell one-shot runIds.
 *
 * A runId runs at most once. The ledger must survive a server restart: the
 * client keeps its runs and re-sends the same runId on every init, so an
 * in-memory ledger would let any restart (update button, release) replay an
 * arbitrary command with no user action. A row is written synchronously when a
 * run is reserved, BEFORE any await, and read before every reservation.
 *
 * `state`: 'started' (reserved; a row still 'started' after a restart was
 * interrupted), 'finished' (exit seen) or 'refused' (never reached spawn).
 * Only finished/refused rows are pruned, by age, on write; the index serves
 * that prune. No user FK: a deleted user's rows are inert and age out.
 *
 * One statement per exec: the admitted boot path runs this too, where the exact
 * text is a reviewed startup effect (`__tests__/startup-sql-trace-contract.mjs`).
 */
export const SHELL_ONESHOT_RUNS_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS shell_oneshot_runs (
  user_id INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  consumed_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'finished', 'refused')),
  exit_code INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (user_id, run_id)
)`;

export const SHELL_ONESHOT_RUNS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_shell_oneshot_runs_ended_at ON shell_oneshot_runs(ended_at)';

/** Creates `shell_oneshot_runs` (additive, idempotent, no backfill). */
export function migrateShellOneShotRuns(db: Database): void {
  db.exec(SHELL_ONESHOT_RUNS_TABLE_SCHEMA_SQL);
  db.exec(SHELL_ONESHOT_RUNS_INDEX_SQL);
}

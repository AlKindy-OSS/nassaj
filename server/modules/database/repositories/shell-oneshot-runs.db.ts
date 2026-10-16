/**
 * shell_oneshot_runs repository (ADR-213, T-2037): the durable consumed-runId
 * ledger of composer shell one-shots. Every call is synchronous so the shell
 * service can consume a runId before its first await.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ShellOneShotRunState = 'started' | 'finished' | 'refused';
export type ShellOneShotRunRow = {
  state: ShellOneShotRunState;
  exit_code: number | null;
  consumed_at: number;
  ended_at: number | null;
};

/** Finished/refused rows older than this are pruned (the client keeps runs for long). */
export const SHELL_ONESHOT_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const shellOneShotRunsDb = {
  /** The ledger row of a runId, or undefined when it was never consumed. */
  get(userId: number, runId: string): ShellOneShotRunRow | undefined {
    return getConnection()
      .prepare('SELECT state, exit_code, consumed_at, ended_at FROM shell_oneshot_runs WHERE user_id = ? AND run_id = ?')
      .get(userId, runId) as ShellOneShotRunRow | undefined;
  },

  /**
   * Consumes a runId atomically. First closes 'started' rows older than the
   * retention as refused, and prunes ended rows older than the retention.
   * @returns true when this call consumed it; false when it already was.
   */
  consume(userId: number, runId: string, nowMs: number): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const cutoff = nowMs - SHELL_ONESHOT_RUN_RETENTION_MS;
      // A run cannot still be live this long after it started (the PTY lifetime
      // cap is minutes), so an aged 'started' row is closed as refused — it then
      // ages out like any ended row instead of growing the table forever. It
      // stays known (never re-runnable) for one more retention period.
      db.prepare(`UPDATE shell_oneshot_runs SET state = 'refused', ended_at = ?
        WHERE state = 'started' AND consumed_at <= ?`).run(nowMs, cutoff);
      db.prepare("DELETE FROM shell_oneshot_runs WHERE state != 'started' AND ended_at <= ?").run(cutoff);
      return db.prepare(`INSERT OR IGNORE INTO shell_oneshot_runs (user_id, run_id, consumed_at, state)
        VALUES (?, ?, ?, 'started')`).run(userId, runId, nowMs).changes === 1;
    }).immediate();
  },

  /** Records how a started run ended; a run that already ended keeps its first outcome. */
  end(userId: number, runId: string, state: Exclude<ShellOneShotRunState, 'started'>,
    exitCode: number | null, nowMs: number): void {
    getConnection().prepare(`UPDATE shell_oneshot_runs SET state = ?, exit_code = ?, ended_at = ?
      WHERE user_id = ? AND run_id = ? AND state = 'started'`).run(state, exitCode, nowMs, userId, runId);
  },
};

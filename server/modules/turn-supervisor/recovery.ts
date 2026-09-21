/** Startup reconciliation and writer-epoch fencing for supervised turns. */
import type { Database } from 'better-sqlite3';

export type RecoveryRunState = 'claimed' | 'dispatching' | 'running' | 'cancel_requested';

export type RecoverableRun = {
  readonly rootId: string;
  readonly runId: string;
  readonly state: RecoveryRunState;
  readonly writerEpoch: number;
};

export interface RecoveryStore {
  listNonTerminalRuns(): readonly RecoverableRun[];
  /** Atomically increments writer epoch and returns its new value. */
  fenceWriter(runId: string, expectedEpoch: number): number | null;
  markUncertain(runId: string, writerEpoch: number, reason: string): boolean;
  quarantine(runId: string, writerEpoch: number, reason: string): boolean;
}

export const RECOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turn_supervisor_recovery (
  run_id TEXT PRIMARY KEY,
  writer_epoch INTEGER NOT NULL DEFAULT 0,
  disposition TEXT NOT NULL DEFAULT 'active'
    CHECK (disposition IN ('active', 'uncertain', 'quarantined')),
  reason TEXT
);
`;

/** Durable sidecar for startup dispositions without weakening run state CAS. */
export class SqliteRecoveryStore implements RecoveryStore {
  constructor(
    private readonly db: Database,
    private readonly adapterIds: readonly string[] = [],
  ) {}

  listNonTerminalRuns(): readonly RecoverableRun[] {
    this.db.prepare(
      `INSERT OR IGNORE INTO turn_supervisor_recovery (run_id)
       SELECT run_id FROM turn_supervisor_runs WHERE state != 'terminal'`,
    ).run();
    const adapterFilter = this.adapterIds.length > 0
      ? ` AND EXISTS (
          SELECT 1 FROM turn_cancellation_runs c
          WHERE c.run_id = r.run_id AND c.adapter_id IN (${this.adapterIds.map(() => '?').join(', ')})
        )`
      : '';
    return this.db.prepare(
      `SELECT r.turn_id AS rootId, r.run_id AS runId, r.state,
              x.writer_epoch AS writerEpoch
       FROM turn_supervisor_runs r
       JOIN turn_supervisor_recovery x ON x.run_id = r.run_id
       WHERE r.state != 'terminal' AND x.disposition = 'active'${adapterFilter}
       ORDER BY r.created_at, r.run_id`,
    ).all(...this.adapterIds) as RecoverableRun[];
  }

  fenceWriter(runId: string, expectedEpoch: number): number | null {
    const changed = this.db.prepare(
      `UPDATE turn_supervisor_recovery SET writer_epoch = writer_epoch + 1
       WHERE run_id = ? AND writer_epoch = ? AND disposition = 'active'`,
    ).run(runId, expectedEpoch).changes;
    if (changed !== 1) return null;
    return expectedEpoch + 1;
  }

  /** Allocates the only writer epoch an execution may use. */
  claimWriter(runId: string): number {
    return this.db.transaction(() => {
      this.db.prepare(
        'INSERT OR IGNORE INTO turn_supervisor_recovery (run_id) VALUES (?)',
      ).run(runId);
      const current = this.db.prepare(
        "SELECT writer_epoch AS epoch FROM turn_supervisor_recovery WHERE run_id = ? AND disposition = 'active'",
      ).get(runId) as { epoch: number } | undefined;
      if (!current) throw new Error('writer recovery row unavailable');
      const next = this.fenceWriter(runId, current.epoch);
      if (next === null) throw new Error('writer epoch CAS failed');
      return next;
    }).immediate();
  }

  markUncertain(runId: string, writerEpoch: number, reason: string): boolean {
    return this.mark(runId, writerEpoch, 'uncertain', reason);
  }

  quarantine(runId: string, writerEpoch: number, reason: string): boolean {
    return this.mark(runId, writerEpoch, 'quarantined', reason);
  }

  private mark(
    runId: string,
    writerEpoch: number,
    disposition: 'uncertain' | 'quarantined',
    reason: string,
  ): boolean {
    return this.db.prepare(
      `UPDATE turn_supervisor_recovery SET disposition = ?, reason = ?
       WHERE run_id = ? AND writer_epoch = ? AND disposition = 'active'`,
    ).run(disposition, reason, runId, writerEpoch).changes === 1;
  }
}

export type RecoveryProbe = (run: RecoverableRun) =>
  | 'not_dispatched'
  | 'alive'
  | 'dead'
  | 'unknown'
  | Promise<'not_dispatched' | 'alive' | 'dead' | 'unknown'>;

export type RecoveryResult = {
  readonly recoverable: readonly (RecoverableRun & { writerEpoch: number })[];
  readonly uncertain: readonly string[];
  readonly quarantined: readonly string[];
};

/**
 * Reconciles before accepting new work. Anything beyond the dispatch boundary
 * is never replayed based on inference: unknown/dead work becomes uncertain,
 * while live orphan work is quarantined for cancellation/reaping.
 */
export async function reconcileOnStartup(
  store: RecoveryStore,
  probe: RecoveryProbe,
): Promise<RecoveryResult> {
  const result: {
    recoverable: (RecoverableRun & { writerEpoch: number })[];
    uncertain: string[];
    quarantined: string[];
  } = { recoverable: [], uncertain: [], quarantined: [] };
  for (const run of store.listNonTerminalRuns()) {
    const writerEpoch = store.fenceWriter(run.runId, run.writerEpoch);
    if (writerEpoch === null) continue;
    let state: Awaited<ReturnType<RecoveryProbe>>;
    try {
      state = await probe(run);
    } catch {
      state = 'unknown';
    }
    if (run.state === 'claimed' && state === 'not_dispatched') {
      result.recoverable.push({ ...run, writerEpoch });
    } else if (state === 'alive' || run.state === 'cancel_requested') {
      if (store.quarantine(run.runId, writerEpoch, 'orphan_requires_reap')) {
        result.quarantined.push(run.runId);
      }
    } else if (store.markUncertain(run.runId, writerEpoch, 'dispatch_outcome_unknown')) {
      result.uncertain.push(run.runId);
    }
  }
  return result;
}

export class WriterEpochFence {
  private epochs = new Map<string, { epoch: number; open: boolean }>();

  open(runId: string, epoch: number): void {
    const current = this.epochs.get(runId);
    if (current && epoch <= current.epoch) throw new Error('writer epoch must increase');
    this.epochs.set(runId, { epoch, open: true });
  }

  close(runId: string, epoch: number): boolean {
    const current = this.epochs.get(runId);
    if (!current || current.epoch !== epoch || !current.open) return false;
    current.open = false;
    return true;
  }

  /** Late events from pre-restart or terminal writers are rejected. */
  accepts(runId: string, epoch: number): boolean {
    const current = this.epochs.get(runId);
    return current?.open === true && current.epoch === epoch;
  }
}

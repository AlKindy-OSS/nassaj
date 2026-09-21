/** Durable root-to-run cancellation with adapter reap before lease release. */
import type { Database } from 'better-sqlite3';

import {
  type AdapterTerminalExitProof,
  type AdapterTerminalProofAuthority,
  releaseWithExitProof,
} from './resource-admission.js';

export type CancellationRunState = 'active' | 'cancel_requested' | 'reaped' | 'completed';

export type CancellationRun = {
  readonly rootId: string;
  readonly runId: string;
  readonly adapterId: string;
  readonly state: CancellationRunState;
  readonly epoch: number;
};

export interface CancellationStore {
  /** Atomically marks the root and every active child; future spawn must fail. */
  requestRootCancellation(rootId: string, reason: string): readonly CancellationRun[];
  /** CAS: completion wins only before cancellation does. */
  completeRun(runId: string, expectedEpoch: number): boolean;
  /** CAS: a cancelled adapter is durably reaped. */
  markRunReaped(runId: string, expectedEpoch: number): boolean;
  markRootCancelled(rootId: string): void;
}

export const CANCELLATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turn_cancellation_roots (
  root_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'cancel_requested', 'cancelled')),
  reason TEXT,
  epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS turn_cancellation_runs (
  run_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'cancel_requested', 'reaped', 'completed')),
  epoch INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (root_id) REFERENCES turn_cancellation_roots(root_id) ON DELETE CASCADE
);
`;

type CancellationRunRow = {
  root_id: string;
  run_id: string;
  adapter_id: string;
  state: CancellationRunState;
  epoch: number;
};

function toRun(row: CancellationRunRow): CancellationRun {
  return {
    rootId: row.root_id,
    runId: row.run_id,
    adapterId: row.adapter_id,
    state: row.state,
    epoch: row.epoch,
  };
}

/** SQLite implementation whose transactions linearize spawn/cancel/complete. */
export class SqliteCancellationStore implements CancellationStore {
  constructor(private readonly db: Database) {}

  createRoot(rootId: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO turn_cancellation_roots (root_id, state) VALUES (?, 'active')",
    ).run(rootId);
  }

  registerRun(rootId: string, runId: string, adapterId: string): void {
    this.db.transaction(() => {
      const root = this.db.prepare(
        'SELECT state FROM turn_cancellation_roots WHERE root_id = ?',
      ).get(rootId) as { state: string } | undefined;
      if (root?.state !== 'active') throw new Error('root is not accepting runs');
      const existing = this.db.prepare(
        'SELECT root_id, adapter_id FROM turn_cancellation_runs WHERE run_id = ?',
      ).get(runId) as { root_id: string; adapter_id: string } | undefined;
      if (existing) {
        if (existing.root_id !== rootId || existing.adapter_id !== adapterId) {
          throw new Error('run already belongs to a different cancellation root');
        }
        return;
      }
      this.db.prepare(
        `INSERT INTO turn_cancellation_runs (run_id, root_id, adapter_id, state)
         VALUES (?, ?, ?, 'active')`,
      ).run(runId, rootId, adapterId);
    }).immediate();
  }

  listPendingRootIds(): readonly string[] {
    return (this.db.prepare(
      "SELECT root_id FROM turn_cancellation_roots WHERE state = 'cancel_requested' ORDER BY root_id",
    ).all() as { root_id: string }[]).map(({ root_id }) => root_id);
  }

  requestRootCancellation(rootId: string, reason: string): readonly CancellationRun[] {
    return this.db.transaction(() => {
      const root = this.db.prepare(
        'SELECT state FROM turn_cancellation_roots WHERE root_id = ?',
      ).get(rootId) as { state: string } | undefined;
      if (!root) throw new Error('cancellation root not found');
      if (root.state === 'cancelled') return [];
      if (root.state === 'active') {
        this.db.prepare(
          `UPDATE turn_cancellation_roots SET state = 'cancel_requested', reason = ?, epoch = epoch + 1
           WHERE root_id = ? AND state = 'active'`,
        ).run(reason, rootId);
        this.db.prepare(
          `UPDATE turn_cancellation_runs SET state = 'cancel_requested', epoch = epoch + 1
           WHERE root_id = ? AND state = 'active'`,
        ).run(rootId);
      }
      return (this.db.prepare(
        `SELECT * FROM turn_cancellation_runs
         WHERE root_id = ? AND state = 'cancel_requested' ORDER BY run_id`,
      ).all(rootId) as CancellationRunRow[]).map(toRun);
    }).immediate();
  }

  completeRun(runId: string, expectedEpoch: number): boolean {
    return this.db.prepare(
      `UPDATE turn_cancellation_runs SET state = 'completed', epoch = epoch + 1
       WHERE run_id = ? AND state = 'active' AND epoch = ?`,
    ).run(runId, expectedEpoch).changes === 1;
  }

  markRunReaped(runId: string, expectedEpoch: number): boolean {
    return this.db.prepare(
      `UPDATE turn_cancellation_runs SET state = 'reaped', epoch = epoch + 1
       WHERE run_id = ? AND state = 'cancel_requested' AND epoch = ?`,
    ).run(runId, expectedEpoch).changes === 1;
  }

  markRootCancelled(rootId: string): void {
    this.db.transaction(() => {
      const pending = this.db.prepare(
        "SELECT COUNT(*) AS count FROM turn_cancellation_runs WHERE root_id = ? AND state = 'cancel_requested'",
      ).get(rootId) as { count: number };
      if (pending.count !== 0) throw new Error('children have not been reaped');
      const changed = this.db.prepare(
        `UPDATE turn_cancellation_roots SET state = 'cancelled', epoch = epoch + 1
         WHERE root_id = ? AND state = 'cancel_requested'`,
      ).run(rootId).changes;
      if (changed !== 1) throw new Error('root cancellation state changed');
    }).immediate();
  }
}

export interface CancelAdapter {
  cancel(runId: string, signal: AbortSignal): void | Promise<void>;
  /** Resolves only after the process/request can no longer emit effects. */
  reap(runId: string): void | Promise<void>;
}

export type CancelCascadeOptions = {
  readonly adapters: ReadonlyMap<string, CancelAdapter>;
  readonly releaseLease: (rootId: string) => void | Promise<void>;
};

export type CancellationLeaseRecoveryOptions = {
  readonly probeProcess: (pid: number) => 'alive' | 'dead' | 'unknown';
  readonly now?: () => number;
  readonly terminalProof?: AdapterTerminalExitProof;
  readonly terminalProofAuthority?: AdapterTerminalProofAuthority;
};

/**
 * Releases a recovered cancellation lease only from durable terminal authority
 * or a positive dead-owner observation. Live/unknown owners stay quarantined.
 */
export function releaseRecoveredCancellationLease(
  db: Database,
  rootId: string,
  options: CancellationLeaseRecoveryOptions,
): boolean {
  const lease = db.prepare(
    "SELECT lease_id, owner_id, owner_pid FROM turn_resource_leases WHERE turn_id = ? AND status = 'active'",
  ).get(rootId) as { lease_id: string; owner_id: string; owner_pid: number } | undefined;
  if (!lease) return false;

  if (options.terminalProof) {
    if (!options.terminalProofAuthority || !releaseWithExitProof(db, {
      leaseId: lease.lease_id,
      ownerId: lease.owner_id,
      proof: options.terminalProof,
      adapterProofAuthority: options.terminalProofAuthority,
    })) throw new Error('cancel recovery terminal proof was not authoritative');
    return true;
  }

  if (options.probeProcess(lease.owner_pid) !== 'dead') {
    throw new Error('cannot release cancellation lease without dead-owner proof');
  }
  if (!releaseWithExitProof(db, {
    leaseId: lease.lease_id,
    ownerId: lease.owner_id,
    proof: { kind: 'process_dead', observedAtMs: (options.now ?? Date.now)() },
  })) throw new Error('cancel recovery lease release was fenced');
  return true;
}

export class CancellationCascade {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: CancellationStore,
    private readonly options: CancelCascadeOptions,
  ) {}

  registerController(runId: string, controller: AbortController): void {
    this.controllers.set(runId, controller);
  }

  /**
   * Persistence is the linearization point. No capacity is returned until all
   * children have acknowledged cancellation and have been reaped.
   */
  async cancel(rootId: string, reason = 'user_cancelled'): Promise<void> {
    const runs = this.store.requestRootCancellation(rootId, reason);
    for (const run of runs) {
      const controller = this.controllers.get(run.runId);
      controller?.abort(reason);
      const adapter = this.options.adapters.get(run.adapterId);
      if (!adapter) throw new Error(`cancel adapter unavailable: ${run.adapterId}`);
      await adapter.cancel(run.runId, controller?.signal ?? AbortSignal.abort(reason));
      await adapter.reap(run.runId);
      if (!this.store.markRunReaped(run.runId, run.epoch)) {
        throw new Error(`stale cancellation epoch: ${run.runId}`);
      }
      this.controllers.delete(run.runId);
    }
    this.store.markRootCancelled(rootId);
    await this.options.releaseLease(rootId);
  }
}

/** Resumes durable, interrupted cascades before new work is accepted. */
export async function resumePendingCancellations(
  store: SqliteCancellationStore,
  cascade: CancellationCascade,
): Promise<readonly string[]> {
  const resumed: string[] = [];
  for (const rootId of store.listPendingRootIds()) {
    await cascade.cancel(rootId, 'startup_recovery');
    resumed.push(rootId);
  }
  return Object.freeze(resumed);
}

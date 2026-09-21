import type { Database } from 'better-sqlite3';

import { runLocalUpdateBackground } from '../../services/update-writer-lease.js';
/** Lease heartbeat and dead-owner reconciliation for Turn Supervisor. */

import {
  heartbeatOwner,
  listStaleActiveLeases,
  releaseWithExitProof,
  type ResourceLease,
} from './resource-admission.js';

export type ProcessState = 'alive' | 'dead' | 'unknown';
export type ProcessProbe = (pid: number) => ProcessState | Promise<ProcessState>;

export type WatchdogOptions = {
  ownerId: string;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  probeProcess?: ProcessProbe;
};

export type ReconcileResult = {
  heartbeated: number;
  examined: number;
  released: number;
  retainedAlive: number;
  retainedUnknown: number;
};

export function probeProcess(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'dead';
    // EPERM proves that a process occupies the pid even if we cannot signal it.
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

async function reconcileLease(
  db: Database,
  lease: ResourceLease,
  processProbe: ProcessProbe,
  now: number,
): Promise<'released' | 'alive' | 'unknown'> {
  let state: ProcessState;
  try {
    state = await processProbe(lease.ownerPid);
  } catch {
    state = 'unknown';
  }
  if (state !== 'dead') return state;
  const released = releaseWithExitProof(db, {
    leaseId: lease.leaseId,
    ownerId: lease.ownerId,
    proof: { kind: 'process_dead', observedAtMs: now },
  });
  // A concurrent normal exit may have released it first; either way it is no
  // longer capacity. Count our own transition only.
  return released ? 'released' : 'unknown';
}

export class ResourceLeaseWatchdog {
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly processProbe: ProcessProbe;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly db: Database, private readonly options: WatchdogOptions) {
    if (!options.ownerId) throw new Error('watchdog ownerId is required');
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.staleAfterMs = options.staleAfterMs ?? 20_000;
    if (this.heartbeatIntervalMs <= 0 || this.staleAfterMs <= this.heartbeatIntervalMs) {
      throw new Error('staleAfterMs must exceed the positive heartbeat interval');
    }
    this.now = options.now ?? Date.now;
    this.processProbe = options.probeProcess ?? probeProcess;
  }

  /** One bounded reconciliation pass. Measurement/probe failures retain leases. */
  async tick(): Promise<ReconcileResult> {
    const now = this.now();
    const result: ReconcileResult = {
      heartbeated: heartbeatOwner(this.db, this.options.ownerId, now),
      examined: 0,
      released: 0,
      retainedAlive: 0,
      retainedUnknown: 0,
    };
    const stale = listStaleActiveLeases(this.db, now - this.staleAfterMs)
      .filter((lease) => lease.ownerId !== this.options.ownerId);
    result.examined = stale.length;
    for (const lease of stale) {
      const verdict = await reconcileLease(this.db, lease, this.processProbe, now);
      if (verdict === 'released') result.released += 1;
      else if (verdict === 'alive') result.retainedAlive += 1;
      else result.retainedUnknown += 1;
    }
    return result;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.inFlight = runLocalUpdateBackground('turn-watchdog', () => this.tick())
        .then(() => undefined)
        .catch((error) => {
          // Fail closed: leave every lease reserved and try again next tick.
          console.error('Turn resource watchdog tick failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.running = false;
          this.inFlight = null;
        });
    }, this.heartbeatIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}

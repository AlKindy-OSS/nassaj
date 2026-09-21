
import type { Database } from 'better-sqlite3';

// eslint-disable-next-line boundaries/no-unknown -- root-verified process context is a builtins-only leaf outside feature barrels.
import { requireStartupAdmission } from '../../bootstrap-startup-context.js';
/** Server-bound lifecycle for Turn Supervisor recovery and resource leases. */

import { sweepOrphanedRoleHomes } from './adapters/isolated-cli-cage.js';
import { ResourceLeaseWatchdog, type ProcessProbe, type ReconcileResult } from './watchdog.js';

type InitializableSupervisor = { initialize(): Promise<void>; resumeDeferredStartupMaintenance?(): Promise<void> };

type Watchdog = {
  tick(): Promise<ReconcileResult>;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
};

export type TurnSupervisorLifecycleOptions = {
  readonly db: Database;
  readonly ownerIds: readonly [string, string];
  readonly supervisors: readonly [InitializableSupervisor, InitializableSupervisor];
  readonly sweepRoleHomes?: () => Promise<readonly string[]>;
  readonly processProbe?: ProcessProbe;
  readonly now?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly createWatchdog?: (ownerId: string) => Watchdog;
};

export type TurnSupervisorLifecycle = {
  /** Must complete before the network listener opens. */
  prepare(): Promise<void>;
  /** Starts heartbeat timers for the bound-server lifetime. */
  start(): void | Promise<void>;
  /** Stops heartbeat timers before SQLite shutdown. */
  stop(): Promise<void>;
};

export function createTurnSupervisorLifecycle(
  options: TurnSupervisorLifecycleOptions,
): TurnSupervisorLifecycle {
  if (!options.ownerIds[0] || !options.ownerIds[1] || options.ownerIds[0] === options.ownerIds[1]) {
    throw new TypeError('two distinct Turn Supervisor owner ids are required');
  }
  const watchdogs = options.ownerIds.map((ownerId) => (
    options.createWatchdog?.(ownerId) ?? new ResourceLeaseWatchdog(options.db, {
      ownerId,
      probeProcess: options.processProbe,
      now: options.now,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      staleAfterMs: options.staleAfterMs,
    })
  ));
  const sweep = options.sweepRoleHomes ?? sweepOrphanedRoleHomes;
  let prepared = false;
  let preparing: Promise<void> | null = null;
  let started = false;
  let starting: Promise<void> | null = null;

  return {
    async prepare(): Promise<void> {
      if (prepared) return;
      if (preparing) return preparing;
      preparing = (async () => {
        // Filesystem cleanup comes first: no new CLI role may be admitted while
        // crash-owned homes from a predecessor are still present.
        if (!requireStartupAdmission()) await sweep();
        await Promise.all(options.supervisors.map((supervisor) => supervisor.initialize()));
        // Reconcile once synchronously; the periodic timer is maintenance, not
        // the authority for making startup capacity safe.
        await Promise.all(watchdogs.map((watchdog) => watchdog.tick()));
        prepared = true;
      })().finally(() => { preparing = null; });
      return preparing;
    },

    start(): void | Promise<void> {
      if (!prepared) throw new Error('Turn Supervisor lifecycle was not prepared before start');
      if (starting) return starting;
      if (started) return;
      const admission = requireStartupAdmission();
      if (admission && admission.phase !== 'serving') throw new Error('root_serving_confirmation_required');
      const begin = () => { started = true; for (const watchdog of watchdogs) watchdog.start(); };
      if (!admission) { begin(); return; }
      starting = sweep().then(async () => {
        for (const supervisor of options.supervisors) await supervisor.resumeDeferredStartupMaintenance?.();
        begin();
      }).finally(() => { starting = null; });
      return starting;
    },

    async stop(): Promise<void> {
      await starting;
      if (!started) return;
      started = false;
      await Promise.all(watchdogs.map((watchdog) => watchdog.stop()));
    },
  };
}

/**
 * Owns background services that must live for the whole bound-server lifetime.
 * Keeping this seam outside index.js makes the bind/shutdown ordering testable
 * without importing or starting the application server.
 */
export type ServerBackgroundLifecycleDeps = {
  prepareTurnSupervisor: () => Promise<void>;
  startTurnSupervisorWatchdogs: () => void | Promise<void>;
  stopTurnSupervisorWatchdogs: () => Promise<void>;
  initializeSessionsWatcher: () => Promise<void>;
  closeSessionsWatcher: () => Promise<void>;
  startCostLedgerScheduler: () => void;
  stopCostLedgerScheduler: () => void;
  startScheduledMessages?: () => void;
  stopScheduledMessages?: () => Promise<void>;
  logger?: Pick<Console, 'error'>;
};

export type ServerBackgroundLifecycle = {
  prepare: () => Promise<void>;
  start: () => void | Promise<void>;
  stop: () => Promise<void>;
};

export function createServerBackgroundLifecycle(
  deps: ServerBackgroundLifecycleDeps,
): ServerBackgroundLifecycle {
  const logger = deps.logger ?? console;
  let started = false;
  let starting: Promise<void> | null = null;
  let prepared = false;
  let preparing: Promise<void> | null = null;
  let watcherStart: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  return {
    async prepare(): Promise<void> {
      if (prepared) return;
      if (preparing) return preparing;
      preparing = deps.prepareTurnSupervisor()
        .then(() => { prepared = true; })
        .finally(() => { preparing = null; });
      return preparing;
    },

    start(): void | Promise<void> {
      if (!prepared) throw new Error('background lifecycle was not prepared before start');
      if (starting) return starting;
      if (started) return;
      const begin = () => {
      started = true;
      deps.startCostLedgerScheduler();
      deps.startScheduledMessages?.();
      watcherStart = deps.initializeSessionsWatcher().catch((error: unknown) => {
        logger.error(
          '[Sessions] Error initializing watcher:',
          error instanceof Error ? error.message : String(error),
        );
        if (process.env.NASSAJ_UPDATE_MODE === 'local-main') throw error;
      });
      return process.env.NASSAJ_UPDATE_MODE === 'local-main' ? watcherStart : undefined;
      };
      const watchdogStart = deps.startTurnSupervisorWatchdogs();
      if (watchdogStart) {
        starting = watchdogStart.then(begin).finally(() => { starting = null; });
        return starting;
      }
      return begin();
    },

    async stop(): Promise<void> {
      await starting;
      if (stopping) return stopping;
      if (!started) return;
      started = false;
      const watchdogStop = deps.stopTurnSupervisorWatchdogs();
      deps.stopCostLedgerScheduler();
      const scheduledStop = deps.stopScheduledMessages?.() ?? Promise.resolve();
      stopping = (async () => {
        await watchdogStop;
        await scheduledStop;
        await watcherStart;
        await deps.closeSessionsWatcher();
      })().finally(() => {
        watcherStart = null;
        stopping = null;
      });
      return stopping;
    },
  };
}

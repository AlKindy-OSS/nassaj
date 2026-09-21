import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServerBackgroundLifecycle } from './server-background-lifecycle.service.js';

describe('server background lifecycle', () => {
  it('keeps the scheduler and watcher alive after start until explicit shutdown', async () => {
    const events: string[] = [];
    const lifecycle = createServerBackgroundLifecycle({
      prepareTurnSupervisor: async () => { events.push('supervisor:prepare'); },
      startTurnSupervisorWatchdogs: () => { events.push('supervisor:start'); },
      stopTurnSupervisorWatchdogs: async () => { events.push('supervisor:stop'); },
      initializeSessionsWatcher: async () => { events.push('watcher:start'); },
      closeSessionsWatcher: async () => { events.push('watcher:close'); },
      startCostLedgerScheduler: () => { events.push('scheduler:start'); },
      stopCostLedgerScheduler: () => { events.push('scheduler:stop'); },
      startScheduledMessages: () => { events.push('scheduled:start'); },
      stopScheduledMessages: async () => { events.push('scheduled:stop'); },
    });

    await lifecycle.prepare();
    lifecycle.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [
      'supervisor:prepare', 'supervisor:start', 'scheduler:start', 'scheduled:start', 'watcher:start',
    ]);

    await lifecycle.stop();
    assert.deepEqual(events, [
      'supervisor:prepare', 'supervisor:start', 'scheduler:start', 'scheduled:start', 'watcher:start',
      'supervisor:stop', 'scheduler:stop', 'scheduled:stop', 'watcher:close',
    ]);
  });

  it('waits for watcher initialization before closing and is idempotent', async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const initialized = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = createServerBackgroundLifecycle({
      prepareTurnSupervisor: async () => { events.push('supervisor:prepare'); },
      startTurnSupervisorWatchdogs: () => { events.push('supervisor:start'); },
      stopTurnSupervisorWatchdogs: async () => { events.push('supervisor:stop'); },
      initializeSessionsWatcher: async () => {
        events.push('watcher:start');
        await initialized;
        events.push('watcher:ready');
      },
      closeSessionsWatcher: async () => { events.push('watcher:close'); },
      startCostLedgerScheduler: () => { events.push('scheduler:start'); },
      stopCostLedgerScheduler: () => { events.push('scheduler:stop'); },
    });

    await lifecycle.prepare();
    await lifecycle.prepare();
    lifecycle.start();
    lifecycle.start();
    const firstStop = lifecycle.stop();
    const secondStop = lifecycle.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [
      'supervisor:prepare', 'supervisor:start', 'scheduler:start', 'watcher:start',
      'supervisor:stop', 'scheduler:stop',
    ]);

    release?.();
    await Promise.all([firstStop, secondStop]);
    assert.deepEqual(events, [
      'supervisor:prepare', 'supervisor:start', 'scheduler:start', 'watcher:start',
      'supervisor:stop', 'scheduler:stop', 'watcher:ready', 'watcher:close',
    ]);
  });

  it('refuses to start before supervisor recovery has completed', () => {
    const lifecycle = createServerBackgroundLifecycle({
      prepareTurnSupervisor: async () => {},
      startTurnSupervisorWatchdogs: () => {},
      stopTurnSupervisorWatchdogs: async () => {},
      initializeSessionsWatcher: async () => {}, closeSessionsWatcher: async () => {},
      startCostLedgerScheduler: () => {}, stopCostLedgerScheduler: () => {},
    });
    assert.throws(() => lifecycle.start(), /not prepared/);
  });
});

it('defers schedulers and watchers until asynchronous maintenance succeeds and keeps them stopped on failure', async () => {
  for (const fails of [false, true]) {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve, reject) => { release = () => fails ? reject(new Error('maintenance failed')) : resolve(); });
    const lifecycle = createServerBackgroundLifecycle({
      prepareTurnSupervisor: async () => {}, startTurnSupervisorWatchdogs: () => pending,
      stopTurnSupervisorWatchdogs: async () => {}, initializeSessionsWatcher: async () => { events.push('watcher'); },
      closeSessionsWatcher: async () => {}, startCostLedgerScheduler: () => { events.push('scheduler'); },
      stopCostLedgerScheduler: () => {}, startScheduledMessages: () => { events.push('messages'); },
    });
    await lifecycle.prepare(); const starting = lifecycle.start();
    assert.deepEqual(events, []); release();
    if (fails) { await assert.rejects(Promise.resolve(starting), /maintenance failed/); assert.deepEqual(events, []); }
    else { await starting; assert.deepEqual(events, ['scheduler', 'messages', 'watcher']); }
    await lifecycle.stop();
  }
});

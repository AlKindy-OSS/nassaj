import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { FSWatcher } from 'chokidar';

import {
  closeSessionsWatcher,
  initializeSessionsWatcher,
} from './sessions-watcher.service.js';

class FakeWatcher extends EventEmitter {
  closed = 0;

  async close(): Promise<void> {
    this.closed += 1;
  }
}

async function withReferencedDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let deadline!: ReturnType<typeof setTimeout>;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadlinePromise]);
  } finally {
    clearTimeout(deadline);
  }
}

test('watcher starts native and falls back only the failed target to polling', async () => {
  const calls: Array<{ path: string; polling: boolean; watcher: FakeWatcher }> = [];
  const watch = ((rootPath: string, options: { usePolling?: boolean }) => {
    const watcher = new FakeWatcher();
    calls.push({ path: rootPath, polling: options.usePolling === true, watcher });
    queueMicrotask(() => watcher.emit('ready'));
    return watcher as unknown as FSWatcher;
  }) as never;

  await initializeSessionsWatcher({
    targets: [
      { provider: 'claude', rootPath: '/virtual/claude' },
      { provider: 'codex', rootPath: '/virtual/codex' },
    ],
    ensureRoot: async () => undefined,
    watch,
    requestSynchronization: () => undefined,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].polling, false, 'native filesystem events are the default');
  assert.equal(calls[1].polling, false);

  calls[0].watcher.emit('error', Object.assign(new Error('inotify limit'), { code: 'ENOSPC' }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls[0].watcher.closed, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(({ path, polling }) => ({ path, polling })),
    [
      { path: '/virtual/claude', polling: false },
      { path: '/virtual/codex', polling: false },
      { path: '/virtual/claude', polling: true },
    ],
  );

  await closeSessionsWatcher();
  assert.equal(calls[1].watcher.closed, 1, 'healthy target participates in normal shutdown');
  assert.equal(calls[2].watcher.closed, 1, 'fallback watcher participates in normal shutdown');
});

test('full synchronization starts before every target ready event', { concurrency: false }, async () => {
  const watchers: FakeWatcher[] = [];
  let syncRequests = 0;
  let markSynchronizationRequested!: () => void;
  const synchronizationRequested = new Promise<void>((resolve) => {
    markSynchronizationRequested = resolve;
  });
  const watch = ((_rootPath: string, _options: { usePolling?: boolean }) => {
    const watcher = new FakeWatcher();
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  }) as never;

  const initializing = initializeSessionsWatcher({
    targets: [
      { provider: 'claude', rootPath: '/virtual/claude' },
      { provider: 'codex', rootPath: '/virtual/codex' },
    ],
    ensureRoot: async () => undefined,
    watch,
    requestSynchronization: () => {
      syncRequests += 1;
      markSynchronizationRequested();
    },
  });
  await synchronizationRequested;
  assert.equal(syncRequests, 1, 'existing transcripts must be indexed even when a watcher is not ready');
  watchers[0].emit('ready');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(syncRequests, 1, 'watcher readiness does not duplicate the initial sync');
  watchers[1].emit('ready');
  await initializing;
  assert.equal(syncRequests, 1);
  await closeSessionsWatcher();
});

test('synchronous native limit falls back, and polling creation failure is contained', { concurrency: false }, async () => {
  let calls = 0;
  const fallbackWatch = ((_rootPath: string, options: { usePolling?: boolean }) => {
    calls += 1;
    if (!options.usePolling) throw Object.assign(new Error('watch limit'), { code: 'ENOSPC' });
    const watcher = new FakeWatcher();
    queueMicrotask(() => watcher.emit('ready'));
    return watcher as unknown as FSWatcher;
  }) as never;
  await initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: '/virtual/claude' }],
    ensureRoot: async () => undefined,
    watch: fallbackWatch,
    requestSynchronization: () => undefined,
  });
  assert.equal(calls, 2);
  await closeSessionsWatcher();

  let syncRequests = 0;
  const alwaysFail = (() => { throw new Error('polling unavailable'); }) as never;
  await assert.doesNotReject(initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: '/virtual/claude' }],
    ensureRoot: async () => undefined,
    watch: alwaysFail,
    requestSynchronization: () => { syncRequests += 1; },
  }));
  assert.equal(syncRequests, 1, 'failed watcher creation does not crash initialization');
  await closeSessionsWatcher();
});

test('a watcher that never emits ready times out into polling instead of hanging initialization', async () => {
  const calls: boolean[] = [];
  const watch = ((_rootPath: string, options: { usePolling?: boolean }) => {
    const watcher = new FakeWatcher();
    calls.push(options.usePolling === true);
    if (options.usePolling) queueMicrotask(() => watcher.emit('ready'));
    return watcher as unknown as FSWatcher;
  }) as never;

  await withReferencedDeadline(initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: '/virtual/timeout' }],
    ensureRoot: async () => undefined,
    watch,
    readyTimeoutMs: 5,
    requestSynchronization: () => undefined,
  }), 1_000);
  assert.deepEqual(calls, [false, true]);
  await closeSessionsWatcher();
});

test('one add event schedules usage once after file synchronization', { concurrency: false }, async () => {
  let watcher!: FakeWatcher;
  const scheduled: unknown[] = [];
  await initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: '/virtual/claude' }],
    ensureRoot: async () => undefined,
    watch: ((_rootPath: string) => {
      watcher = new FakeWatcher();
      queueMicrotask(() => watcher.emit('ready'));
      return watcher as unknown as FSWatcher;
    }) as never,
    requestSynchronization: () => undefined,
    startUsageBackfill: async () => undefined,
    synchronizeProviderFile: async (provider, _filePath) => ({ provider, indexed: true, sessionId: 'session-1' }),
    scheduleUsageIngestion: async (request) => { scheduled.push(request); },
  });
  watcher.emit('add', '/virtual/claude/session.jsonl');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduled, [{
    provider: 'claude', filePath: '/virtual/claude/session.jsonl', sessionId: 'session-1',
  }]);
  await closeSessionsWatcher();
});

test('initial backfill waits until full synchronization includes late indexed sessions', { concurrency: false }, async () => {
  let complete!: (result: { processedByProvider: Record<string, number>; failures: string[] }) => void;
  let indexedLateSession = false;
  const observedBoundaries: boolean[] = [];
  await initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: '/virtual/claude' }],
    ensureRoot: async () => undefined,
    watch: ((_rootPath: string) => {
      const watcher = new FakeWatcher();
      queueMicrotask(() => watcher.emit('ready'));
      return watcher as unknown as FSWatcher;
    }) as never,
    requestSynchronization: () => { indexedLateSession = true; },
    onSynchronizationComplete: ((listener: typeof complete) => {
      complete = listener;
      return () => undefined;
    }) as never,
    startUsageBackfill: async () => { observedBoundaries.push(indexedLateSession); },
  });
  assert.deepEqual(observedBoundaries, [], 'backfill cannot capture a pre-sync boundary');
  complete({ processedByProvider: { claude: 1 }, failures: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(observedBoundaries, [true]);
  await closeSessionsWatcher();
});

test('a real append watcher event resumes a partial backfill through remaining sources', { concurrency: false }, async () => {
  let watcher!: FakeWatcher;
  let complete!: (result: { processedByProvider: Record<string, number>; failures: string[] }) => void;
  let appended = false;
  let cursor = 0;
  let backfillRuns = 0;
  await initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: '/virtual/claude' }],
    ensureRoot: async () => undefined,
    watch: ((_rootPath: string) => {
      watcher = new FakeWatcher();
      queueMicrotask(() => watcher.emit('ready'));
      return watcher as unknown as FSWatcher;
    }) as never,
    requestSynchronization: () => undefined,
    onSynchronizationComplete: ((listener: typeof complete) => {
      complete = listener;
      return () => undefined;
    }) as never,
    synchronizeProviderFile: async (provider) => ({ provider, indexed: true, sessionId: 'partial-session' }),
    scheduleUsageIngestion: async () => ({ caughtUp: appended }),
    startUsageBackfill: async () => {
      backfillRuns += 1;
      if (!appended) return; // first source is a stable partial; cursor must not move
      cursor = 2; // resumed source plus the remaining stable source
    },
    resumeUsageBackfill: async () => {
      backfillRuns += 1;
      if (appended) cursor = 2;
    },
  });
  complete({ processedByProvider: { claude: 2 }, failures: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(backfillRuns, 1);
  assert.equal(cursor, 0, 'partial source leaves the durable generation resumable');

  appended = true;
  watcher.emit('change', '/virtual/claude/partial.jsonl');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(backfillRuns, 2, 'only the real watcher event triggers the resume attempt');
  assert.equal(cursor, 2, 'resume advances through the formerly partial and remaining source');
  await closeSessionsWatcher();
});

test('watcher event after a completed generation never starts a new full backfill', { concurrency: false }, async () => {
  let watcher!: FakeWatcher;
  let complete!: (result: { processedByProvider: Record<string, number>; failures: string[] }) => void;
  let starts = 0;
  let resumes = 0;
  await initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: '/virtual/claude' }],
    ensureRoot: async () => undefined,
    watch: ((_rootPath: string) => {
      watcher = new FakeWatcher();
      queueMicrotask(() => watcher.emit('ready'));
      return watcher as unknown as FSWatcher;
    }) as never,
    requestSynchronization: () => undefined,
    onSynchronizationComplete: ((listener: typeof complete) => {
      complete = listener;
      return () => undefined;
    }) as never,
    synchronizeProviderFile: async (provider) => ({ provider, indexed: true, sessionId: 'complete-session' }),
    scheduleUsageIngestion: async () => ({ caughtUp: true }),
    startUsageBackfill: async () => { starts += 1; },
    // Production resume checks for pending/running only; completed means no-op.
    resumeUsageBackfill: async () => { resumes += 1; },
  });
  complete({ processedByProvider: { claude: 1 }, failures: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  watcher.emit('change', '/virtual/claude/complete.jsonl');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1, 'watcher path cannot invoke start/create');
  assert.equal(resumes, 1, 'only resume-only hook is consulted');
  await closeSessionsWatcher();
});

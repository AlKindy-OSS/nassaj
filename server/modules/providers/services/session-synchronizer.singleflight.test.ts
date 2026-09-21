import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let resolveProviderSync: ((value: number) => void) | null = null;
let providerCalls = 0;
let scanAsOf: Date | null = null;
let syncImplementation: (since?: Date) => Promise<number>;

mock.module('@/modules/database/index.js', {
  namedExports: {
    scanStateDb: {
      getLastScannedAt: () => scanAsOf,
      updateLastScannedAt: (value: Date) => { scanAsOf = value; },
    },
  },
});

const provider = {
  id: 'claude',
  sessionSynchronizer: {
    synchronize: (since?: Date) => {
      providerCalls += 1;
      return syncImplementation(since);
    },
    synchronizeFile: async () => null,
  },
};

mock.module('@/modules/providers/provider.registry.js', {
  namedExports: {
    providerRegistry: {
      listProviders: () => [provider],
      resolveProvider: () => provider,
    },
  },
});

const { sessionSynchronizerService } = await import('./session-synchronizer.service.js');

test('full synchronization is singleflight and reports snapshot lifecycle', async () => {
  scanAsOf = null;
  providerCalls = 0;
  syncImplementation = () => new Promise<number>((resolve) => { resolveProviderSync = resolve; });

  const first = sessionSynchronizerService.synchronizeSessions();
  const second = sessionSynchronizerService.synchronizeSessions();

  assert.equal(providerCalls, 1);
  assert.deepEqual(sessionSynchronizerService.getSnapshotMetadata(), {
    state: 'initializing',
    asOf: null,
  });

  assert.ok(resolveProviderSync);
  resolveProviderSync(7);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.processedByProvider.claude, 7);
  assert.equal(providerCalls, 1);
  assert.equal(sessionSynchronizerService.getSnapshotMetadata().state, 'ready');
  assert.ok(sessionSynchronizerService.getSnapshotMetadata().asOf);
});

test('successful refresh notifies DB-empty consumers and a failed run can retry immediately', async () => {
  scanAsOf = new Date();
  providerCalls = 0;
  let completions = 0;
  const unsubscribe = sessionSynchronizerService.onSynchronizationComplete(() => { completions += 1; });

  syncImplementation = async () => { throw new Error('temporary scan failure'); };
  const failed = await sessionSynchronizerService.synchronizeSessions();
  assert.equal(failed.failures.length, 1);
  assert.equal(completions, 0);

  syncImplementation = async () => 3;
  sessionSynchronizerService.requestBackgroundSynchronization();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 2, 'failure clears the throttle for an immediate retry');
  assert.equal(completions, 1, 'successful committed refresh emits one completion');
  assert.ok(scanAsOf, 'successful retry advances the snapshot watermark');
  unsubscribe();
});

test('forced reconciliation ignores the incremental scan cursor', async () => {
  scanAsOf = new Date('2030-01-01T00:00:00.000Z');
  providerCalls = 0;
  let observedSince: Date | undefined;
  syncImplementation = async (since) => {
    observedSince = since;
    return 1;
  };

  await sessionSynchronizerService.synchronizeSessions({ ignoreScanCursor: true });
  assert.equal(providerCalls, 1);
  assert.equal(observedSince, undefined);
});

test('forced reconciliation queues behind an already-running incremental scan', async () => {
  scanAsOf = new Date('2030-01-01T00:00:00.000Z');
  const initialCursor = scanAsOf;
  providerCalls = 0;
  const observedSince: Array<Date | undefined> = [];
  let finishIncremental!: () => void;
  syncImplementation = async (since) => {
    observedSince.push(since);
    if (observedSince.length === 1) {
      await new Promise<void>((resolve) => { finishIncremental = resolve; });
    }
    return observedSince.length;
  };

  const incremental = sessionSynchronizerService.synchronizeSessions();
  const forced = sessionSynchronizerService.synchronizeSessions({ ignoreScanCursor: true });
  finishIncremental();
  await Promise.all([incremental, forced]);

  assert.deepEqual(observedSince, [initialCursor, undefined]);
});

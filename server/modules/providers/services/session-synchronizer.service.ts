import { scanStateDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

import { withLocalUpdateWriterLease } from '../../../services/update-writer-lease.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  failures: string[];
};

type SynchronizeSessionsOptions = {
  /** Reconcile all on-disk artifacts, ignoring the persisted incremental cursor. */
  ignoreScanCursor?: boolean;
};

export type SessionSnapshotState = 'initializing' | 'ready' | 'stale' | 'error';

export type SessionSnapshotMetadata = {
  state: SessionSnapshotState;
  asOf: string | null;
};

const providerSyncs = new Map<LLMProvider, Promise<number>>();
let fullSync: Promise<SessionSynchronizeResult> | null = null;
let fullReconciliationQueued = false;
let backgroundRequestedAt = 0;
let lastFullSyncError = false;
const SNAPSHOT_STALE_AFTER_MS = 5 * 60_000;
const synchronizationListeners = new Set<(result: SessionSynchronizeResult) => void>();

function synchronizeOneProvider(provider: LLMProvider, since?: Date): Promise<number> {
  const active = providerSyncs.get(provider);
  if (active) {
    return active;
  }

  const promise = providerRegistry.resolveProvider(provider).sessionSynchronizer.synchronize(since)
    .finally(() => {
      if (providerSyncs.get(provider) === promise) {
        providerSyncs.delete(provider);
      }
    });
  providerSyncs.set(provider, promise);
  return promise;
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers and updates scan_state.last_scanned_at.
   */
  async synchronizeSessions(options: SynchronizeSessionsOptions = {}): Promise<SessionSynchronizeResult> {
    if (fullSync) {
      if (options.ignoreScanCursor) {
        // A normal incremental scan may already have started before watcher
        // initialization requests its boot reconciliation. Do not let that
        // in-flight cursor-bound scan swallow the repair: queue exactly one
        // cursorless pass immediately after it finishes.
        fullReconciliationQueued = true;
        const activeSync = fullSync;
        return activeSync.then((result) => {
          if (!fullReconciliationQueued) {
            return fullSync ?? result;
          }
          fullReconciliationQueued = false;
          return this.synchronizeSessions({ ignoreScanCursor: true });
        });
      }
      return fullSync;
    }

    const run = async (): Promise<SessionSynchronizeResult> => {
    const lastScanAt = options.ignoreScanCursor ? null : scanStateDb.getLastScannedAt();
    const scanBoundary = new Date();
    const processedByProvider: Record<LLMProvider, number> = {
      claude: 0,
      codex: 0,
      cursor: 0,
      antigravity: 0,
      opencode: 0,
      // Hosted vendors have real synchronizers; seeded to 0 here and overwritten
      // by the Promise.allSettled loop below with their actual processed counts.
      kimi: 0,
      deepseek: 0,
      glm: 0,
      // Placeholder providers: declared in the union, no synchronizer yet.
      hermes: 0,
      // Qwen uses the shared nassaj-owned transcript synchronizer.
      qwen: 0,
      sakana: 0,
    };
    const failures: string[] = [];

    const results = await Promise.allSettled(
      providerRegistry.listProviders().map(async (provider) => ({
        provider: provider.id,
        processed: await synchronizeOneProvider(provider.id, lastScanAt ?? undefined),
      }))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        processedByProvider[result.value.provider] = result.value.processed;
        continue;
      }

      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(reason);
    }

    if (failures.length === 0) {
      scanStateDb.updateLastScannedAt(scanBoundary);
      lastFullSyncError = false;
    } else {
      lastFullSyncError = true;
      backgroundRequestedAt = 0;
      console.warn(
        `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
      );
    }

    const result = {
      processedByProvider,
      failures,
    };
    if (failures.length === 0) {
      for (const listener of synchronizationListeners) {
        try {
          listener(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[Sessions] Synchronization completion listener failed', { error: message });
        }
      }
    }
    return result;
    };

    fullSync = withLocalUpdateWriterLease('session-synchronization', run).finally(() => {
      fullSync = null;
    });
    return fullSync;
  },

  /** Starts a background sync; `force` deliberately reconciles pre-existing files too. */
  requestBackgroundSynchronization(options: { force?: boolean } = {}): void {
    const now = Date.now();
    const lastScanAt = scanStateDb.getLastScannedAt();
    const snapshotIsFresh = lastScanAt && now - lastScanAt.getTime() < SNAPSHOT_STALE_AFTER_MS;
    if (
      fullSync ||
      (!options.force && !lastFullSyncError && snapshotIsFresh) ||
      now - backgroundRequestedAt < 1_000
    ) {
      return;
    }
    backgroundRequestedAt = now;
    void this.synchronizeSessions({ ignoreScanCursor: options.force === true }).catch((error: unknown) => {
      lastFullSyncError = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Sessions] Background synchronization failed', { error: message });
    });
  },

  /** Metadata for consumers that render a DB snapshot while refresh runs. */
  getSnapshotMetadata(): SessionSnapshotMetadata {
    const asOfDate = scanStateDb.getLastScannedAt();
    const asOf = asOfDate?.toISOString() ?? null;
    if (lastFullSyncError) {
      return { state: 'error', asOf };
    }
    if (fullSync) {
      return { state: asOf ? 'stale' : 'initializing', asOf };
    }
    if (!asOfDate) {
      return { state: 'initializing', asOf: null };
    }
    return {
      state: Date.now() - asOfDate.getTime() >= SNAPSHOT_STALE_AFTER_MS ? 'stale' : 'ready',
      asOf,
    };
  },

  /** Subscribes to successful, fully committed full-sync completions. */
  onSynchronizationComplete(listener: (result: SessionSynchronizeResult) => void): () => void {
    synchronizationListeners.add(listener);
    return () => synchronizationListeners.delete(listener);
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await withLocalUpdateWriterLease('session-file-synchronization',
      () => resolvedProvider.sessionSynchronizer.synchronizeFile(filePath));
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};

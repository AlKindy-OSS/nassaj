import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveClaudeHomes } from '@/modules/providers/list/claude/claude-home.js';
import { resolveCodexHomes } from '@/modules/providers/list/codex/codex-home.js';
import { resolveOpenCodeDataHomes } from '@/modules/providers/list/opencode/opencode-home.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import {
  startUsageIngestionBackfill,
  resumeUsageIngestionBackfill,
  usageIngestionScheduler,
  type UsageIngestionScheduleRequest,
} from '@/modules/providers/services/cost/usage-ingestion.scheduler.js';
import { vendorProviderRoot } from '@/modules/providers/shared/vendor/vendor-transcript.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { getProjectsWithSessions } from '@/modules/projects/index.js';

import { runLocalUpdateBackground } from '../../../services/update-writer-lease.js';

type WatcherEventType = 'add' | 'change' | 'unlink';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    // Operator baseline only. B-738 expands this into one watch per effective
    // CLAUDE_CONFIG_DIR/projects so isolated users' live transcripts are seen.
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    // Operator baseline only. B-152: at watcher init this single codex entry is
    // expanded (see resolveEffectiveWatchTargets) into one watch per isolated
    // user's CODEX_HOME/sessions so an isolated user's live sessions are indexed.
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  {
    // Operator baseline only. OC-07: at watcher init this single opencode entry
    // is expanded (see resolveEffectiveWatchTargets) into one watch per isolated
    // user's opencode data dir so an isolated user's live sessions are indexed.
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
  // Hosted vendor providers write nassaj-owned JSONL transcripts; watch each
  // provider's transcript root so new/updated sessions are indexed into the DB.
  {
    provider: 'kimi',
    rootPath: vendorProviderRoot('kimi'),
  },
  {
    provider: 'deepseek',
    rootPath: vendorProviderRoot('deepseek'),
  },
  {
    provider: 'glm',
    rootPath: vendorProviderRoot('glm'),
  },
];

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

type WatchTarget = { provider: LLMProvider; rootPath: string };
type ActiveWatcher = { watcher: FSWatcher; polling: boolean; generation: number };
type WatchFactory = typeof chokidar.watch;
type SessionsWatcherInitDeps = {
  targets?: WatchTarget[];
  ensureRoot?: (rootPath: string) => Promise<unknown>;
  watch?: WatchFactory;
  requestSynchronization?: () => void;
  readyTimeoutMs?: number;
  scheduleUsageIngestion?: (request: UsageIngestionScheduleRequest) => Promise<unknown>;
  startUsageBackfill?: () => Promise<void>;
  resumeUsageBackfill?: () => Promise<void>;
  synchronizeProviderFile?: typeof sessionSynchronizerService.synchronizeProviderFile;
  onSynchronizationComplete?: typeof sessionSynchronizerService.onSynchronizationComplete;
};
const watchers = new Map<string, ActiveWatcher>();
let watcherGeneration = 0;
let watcherClosing = false;
let unsubscribeSynchronizationComplete: (() => void) | null = null;
let scheduleUsageIngestion = (request: UsageIngestionScheduleRequest): Promise<unknown> =>
  usageIngestionScheduler.schedule(request);
let resumeUsageBackfill = resumeUsageIngestionBackfill;
let synchronizeProviderFile = sessionSynchronizerService.synchronizeProviderFile.bind(sessionSynchronizerService);

function watchTargetKey(target: WatchTarget): string {
  return `${target.provider}\0${target.rootPath}`;
}

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  return filePath.endsWith('.jsonl');
}

/**
 * Coerces the socket-stamped identity into a DB user id, or null when the
 * socket is unauthenticated or the value is not an integer id.
 */
function toMembershipUserId(rawUserId: string | number | null | undefined): number | null {
  if (typeof rawUserId === 'number') {
    return Number.isInteger(rawUserId) ? rawUserId : null;
  }
  if (typeof rawUserId === 'string' && rawUserId.trim() !== '') {
    const parsed = Number(rawUserId);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(retry = false): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = retry ? 1_000 : Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void runLocalUpdateBackground('session-watcher-flush', () => flushPendingWatcherUpdate())
      .then(result => { if (result === null && !watcherClosing) schedulePendingWatcherFlush(true); })
      .catch(() => { if (!watcherClosing) schedulePendingWatcherFlush(true); });
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    const changeTypes = Array.from(queuedUpdate.changeTypes);
    const watchProviders = Array.from(queuedUpdate.providers);
    const updatedSessionIds = Array.from(queuedUpdate.updatedSessionIds);
    const snapshot = sessionSynchronizerService.getSnapshotMetadata();

    // Backward-compatible fields stay populated with the first queued values.
    const basePayload = {
      type: 'projects_updated',
      timestamp: new Date().toISOString(),
      changeType: changeTypes[0] ?? 'change',
      updatedSessionId: updatedSessionIds[0] ?? undefined,
      watchProvider: watchProviders[0] ?? undefined,
      changeTypes,
      updatedSessionIds,
      watchProviders,
      batched: true,
      snapshotStatus: snapshot.state,
      snapshotAsOf: snapshot.asOf,
    };

    // `starred`, `isMember`, `isOwner` and the composition of each project's
    // FIRST session page (favourites are hoisted onto it) are all per-user, so
    // this frame cannot be built once and shared. It used to be: one anonymous
    // fetch stamped `starred: false` on every row, and the send loop re-stamped
    // only `isMember`/`isOwner` — so every transcript write anywhere on the
    // server overwrote the client's correct pin state (B-825).
    //
    // Build one payload per DISTINCT recipient identity instead. `getProjects
    // WithSessions` already resolves all four facets from `currentUserId`, so
    // the hand-rolled re-stamping is gone with it. Cost is one fetch + one
    // serialization per identity, not per socket — mirror sockets of the same
    // account share a payload.
    const membershipUserIds = new Set<number | null>();
    for (const client of connectedClients) {
      if (client.readyState === WS_OPEN_STATE) {
        membershipUserIds.add(toMembershipUserId(client.userId));
      }
    }

    // Every payload is built BEFORE anything is sent. Awaiting inside the send
    // loop would let a later flush interleave and hand one socket a snapshot
    // older than the one its neighbour already received.
    const serializedByUserId = new Map<number | null, string>();
    for (const membershipUserId of membershipUserIds) {
      const projects = await getProjectsWithSessions({
        skipSynchronization: true,
        // null for an unauthenticated socket: it legitimately owns no stars.
        currentUserId: membershipUserId,
        // A watcher flush is a background refresh. Progress frames fan out to
        // every client per project, so leaving them on here would multiply that
        // noise by the number of connected identities.
        broadcastProgress: false,
      });
      serializedByUserId.set(membershipUserId, JSON.stringify({ ...basePayload, projects }));
    }

    for (const client of connectedClients) {
      if (client.readyState !== WS_OPEN_STATE) {
        continue;
      }
      const serialized = serializedByUserId.get(toMembershipUserId(client.userId));
      // Absent only for a socket that connected during the fetches above. It
      // has just run its own authenticated GET /api/projects, and the next
      // flush will include it, so skipping beats sending it another identity's
      // frame.
      if (serialized !== undefined) {
        client.send(serialized);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting projects_updated', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/** Retain file events across a temporary maintenance pause, including a rollback without restart. */
async function onUpdate(eventType: WatcherEventType, filePath: string, provider: LLMProvider): Promise<void> {
  if (process.env.NASSAJ_UPDATE_MODE !== 'local-main') return onAdmittedUpdate(eventType, filePath, provider);
  const generation = watcherGeneration;
  const attempt = async (): Promise<void> => {
    if (watcherClosing || generation !== watcherGeneration) return;
    const result = await runLocalUpdateBackground('session-watcher-update', () => onAdmittedUpdate(eventType, filePath, provider));
    if (result === null) {
      const timer = setTimeout(() => { void attempt().catch(() => {}); }, 1_000);
      timer.unref();
    }
  };
  await attempt();
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onAdmittedUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await synchronizeProviderFile(provider, filePath);
    // Schedule only after the session index has observed the write. A late child
    // may itself be unindexed, so scheduling intentionally precedes this return.
    void scheduleUsageIngestion({ provider, filePath, sessionId: result.sessionId })
      .then(() => resumeUsageBackfill())
      .catch((error) => {
        console.error('Background usage ingestion failed', {
          provider, filePath, error: error instanceof Error ? error.message : String(error),
        });
      });
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Handles transcript deletions (e.g. Claude's ~30-day retention sweep) by
 * dropping the ghost DB rows indexed from the removed file.
 */
function onUnlink(filePath: string, provider: LLMProvider): void {
  if (process.env.NASSAJ_UPDATE_MODE !== 'local-main') return onAdmittedUnlink(filePath, provider);
  const generation = watcherGeneration;
  const attempt = async (): Promise<void> => {
    if (watcherClosing || generation !== watcherGeneration) return;
    try {
      const result = await runLocalUpdateBackground('session-watcher-unlink', () => {
        if (!existsSync(filePath)) onAdmittedUnlink(filePath, provider);
      });
      if (result === null) {
        const timer = setTimeout(() => { void attempt(); }, 1_000);
        timer.unref();
      }
    } catch (error) { console.error('Session unlink reconciliation failed', { code: error instanceof Error ? error.name : 'unknown' }); }
  };
  void attempt();
}

/** Delete transcript index rows only while the enclosing local writer is admitted. */
function onAdmittedUnlink(filePath: string, provider: LLMProvider): void {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const removedSessionIds = sessionsDb.deleteSessionsByJsonlPath(filePath);
    if (removedSessionIds.length === 0) {
      return;
    }

    console.log(`Session cleanup triggered by unlink event for provider "${provider}"`, {
      filePath,
      sessionIds: removedSessionIds,
    });
    for (const sessionId of removedSessionIds) {
      queuePendingWatcherUpdate('unlink', provider, sessionId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher cleanup failed for provider "${provider}"`, {
      filePath,
      error: message,
    });
  }
}

/**
 * Expands the static watch list into the concrete set of dirs to watch. Every
 * provider maps to its single declared root except homes managed by an isolation
 * variable (Claude, Codex and OpenCode), whose effective roots are expanded per
 * registered user. Their resolver dedupes shared users to the operator root.
 */
function resolveEffectiveWatchTargets(): Array<{ provider: LLMProvider; rootPath: string }> {
  const targets: Array<{ provider: LLMProvider; rootPath: string }> = [];

  for (const entry of PROVIDER_WATCH_PATHS) {
    if (entry.provider === 'claude') {
      for (const claudeHome of resolveClaudeHomes()) {
        targets.push({ provider: 'claude', rootPath: path.join(claudeHome, 'projects') });
      }
      continue;
    }
    if (entry.provider === 'codex') {
      for (const codexHome of resolveCodexHomes()) {
        targets.push({ provider: 'codex', rootPath: path.join(codexHome, 'sessions') });
      }
      continue;
    }
    if (entry.provider === 'opencode') {
      // OC-07: watch every user's opencode data dir (operator + isolated). In
      // shared mode resolveOpenCodeDataHomes collapses to the single operator
      // dir, leaving the original single watch.
      for (const dataHome of resolveOpenCodeDataHomes()) {
        targets.push({ provider: 'opencode', rootPath: dataHome });
      }
      continue;
    }
    targets.push(entry);
  }

  return targets;
}

/** Starts one target. Native events are the default; only a failed target falls back to polling. */
function startTargetWatcher(
  target: WatchTarget,
  polling: boolean,
  generation: number,
  watch: WatchFactory,
  readyTimeoutMs: number,
  onRegistered?: () => void,
): Promise<void> {
  const key = watchTargetKey(target);
  if (watcherClosing || generation !== watcherGeneration) {
    return Promise.resolve();
  }

  let watcher: FSWatcher;
  try {
    watcher = watch(target.rootPath, {
      ignored: WATCHER_IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 6,
      usePolling: polling,
      ...(polling ? { interval: 6_000, binaryInterval: 6_000 } : {}),
    });
  } catch (error) {
    if (!polling) {
      console.warn(`Native watcher creation failed; polling target "${target.provider}"`, {
        rootPath: target.rootPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return startTargetWatcher(target, true, generation, watch, readyTimeoutMs, onRegistered);
    }
    return Promise.reject(error);
  }
  watchers.set(key, { watcher, polling, generation });

  let ready = false;
  let fallbackStarted = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let readyTimer!: ReturnType<typeof setTimeout>;

  const handleFailure = (error: unknown): void => {
    clearTimeout(readyTimer);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher error for provider "${target.provider}"`, {
      rootPath: target.rootPath,
      polling,
      error: message,
    });

    const active = watchers.get(key);
    if (!active || active.watcher !== watcher || watcherClosing || generation !== watcherGeneration) return;
    if (polling) {
      if (!ready) rejectReady(error);
      return;
    }
    if (fallbackStarted) return;
    fallbackStarted = true;
    watchers.delete(key);
    void watcher.close().finally(() => {
      if (!watcherClosing && generation === watcherGeneration && !watchers.has(key)) {
        console.warn(`Falling back to polling for session watcher target "${target.provider}"`, {
          rootPath: target.rootPath,
        });
        void startTargetWatcher(target, true, generation, watch, readyTimeoutMs)
          .then(resolveReady, rejectReady);
      }
    });
  };

  readyTimer = setTimeout(() => {
    handleFailure(new Error(`watcher ready timeout after ${readyTimeoutMs}ms`));
  }, readyTimeoutMs);
  readyTimer.unref();

  watcher
    .on('ready', () => {
      ready = true;
      clearTimeout(readyTimer);
      resolveReady();
    })
    .on('add', (filePath: string) => {
      void onUpdate('add', filePath, target.provider);
    })
    .on('change', (filePath: string) => {
      void onUpdate('change', filePath, target.provider);
    })
    .on('unlink', (filePath: string) => {
      onUnlink(filePath, target.provider);
    })
    .on('error', handleFailure);

  // The watcher is now registered and can observe writes, even though its
  // initial directory crawl has not emitted `ready` yet.
  onRegistered?.();
  return readyPromise;
}

/**
 * Starts provider filesystem watchers and requests initial DB synchronization.
 */
export async function initializeSessionsWatcher(deps: SessionsWatcherInitDeps = {}): Promise<void> {
  console.log('Setting up session watchers');

  if (watchers.size > 0) {
    await closeSessionsWatcher();
  }
  watcherClosing = false;
  scheduleUsageIngestion = deps.scheduleUsageIngestion
    ?? ((request) => usageIngestionScheduler.schedule(request));
  resumeUsageBackfill = deps.resumeUsageBackfill ?? resumeUsageIngestionBackfill;
  synchronizeProviderFile = deps.synchronizeProviderFile
    ?? sessionSynchronizerService.synchronizeProviderFile.bind(sessionSynchronizerService);
  const generation = ++watcherGeneration;

  const targets = deps.targets ?? resolveEffectiveWatchTargets();
  const ensureRoot = deps.ensureRoot ?? ((rootPath: string) => fsPromises.mkdir(rootPath, { recursive: true }));
  const watch = deps.watch ?? chokidar.watch.bind(chokidar);
  const readyTimeoutMs = Math.max(1, deps.readyTimeoutMs ?? 10_000);

  // Prepare and normalize every requested root before constructing a watcher.
  // Different configured homes may deliberately share one transcript symlink;
  // deduping after realpath prevents duplicate Chokidar instances racing on the
  // same physical tree (and overwriting the watchers Map entry).
  const resolvedTargets = await Promise.all(targets.map(async ({ provider, rootPath }) => {
    try {
      await ensureRoot(rootPath);
      const effectiveRootPath = await fsPromises.realpath(rootPath).catch(() => rootPath);
      return { provider, rootPath: effectiveRootPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to prepare session watcher for provider "${provider}"`, { rootPath, error: message });
      return null;
    }
  }));
  const uniqueTargets = new Map<string, WatchTarget>();
  for (const target of resolvedTargets) {
    if (target) uniqueTargets.set(watchTargetKey(target), target);
  }

  const watcherStarts = Array.from(uniqueTargets.values()).map(({ provider, rootPath }) => {
    let markRegistered!: () => void;
    const registered = new Promise<void>((resolve) => { markRegistered = resolve; });
    const ready = (async () => {
      try {
        await startTargetWatcher(
          { provider, rootPath }, false, generation, watch, readyTimeoutMs, markRegistered
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to initialize session watcher for provider "${provider}"`, { rootPath, error: message });
        markRegistered();
        if (process.env.NASSAJ_UPDATE_MODE === 'local-main') throw error;
      }
    })();
    return { registered, ready };
  });

  unsubscribeSynchronizationComplete?.();
  let initialBackfillPending = true;
  const startBackfill = deps.startUsageBackfill ?? startUsageIngestionBackfill;
  const onSynchronizationComplete = deps.onSynchronizationComplete
    ?? sessionSynchronizerService.onSynchronizationComplete.bind(sessionSynchronizerService);
  unsubscribeSynchronizationComplete = onSynchronizationComplete((result) => {
    for (const provider of Object.keys(result.processedByProvider) as LLMProvider[]) {
      queuePendingWatcherUpdate('change', provider, null);
    }
    if (initialBackfillPending) {
      initialBackfillPending = false;
      void startBackfill().catch((error) => {
        console.error('Usage ingestion backfill failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  // Wait until every watch is actually registered, but do not make the initial
  // DB repair contingent on a filesystem watcher's `ready` event. This closes
  // the gap where a write between the scan and watch registration was missed.
  await Promise.all(watcherStarts.map(({ registered }) => registered));

  // Do not make the initial DB repair contingent on a filesystem watcher's
  // `ready` event. A broken/symlinked root used to leave existing JSONL files
  // indefinitely as DB rows with jsonl_path=NULL. Watches are registered above
  // before this request, so concurrent writes still get incremental handling.
  (deps.requestSynchronization ?? (() => sessionSynchronizerService.requestBackgroundSynchronization({ force: true })))();

  // Keep the historical lifecycle contract: callers finish initialization only
  // after every watcher has either become ready or been contained. The initial
  // synchronization above is intentionally already in flight.
  await Promise.all(watcherStarts.map(({ ready }) => ready));
}

/**
 * Broadcasts a `projects_updated` refresh for a change the watchers cannot see.
 *
 * The watchers are filesystem-driven: they fire when a transcript file changes.
 * A state that lives ONLY in the database — closing a conversation is the first
 * of these — never touches a transcript, so without this the sidebar keeps
 * serving the flag it last fetched and the row looks unchanged until a reload.
 *
 * Reuses the existing queue rather than sending its own frame, so it inherits
 * the per-user membership stamping and the private-project filtering that the
 * flush already applies (B-PRIV) — a hand-rolled broadcast here would have to
 * re-implement both, and would leak project names the recipient may not see.
 */
export function notifySessionMetadataChanged(
  provider: LLMProvider,
  sessionId: string | null,
): void {
  queuePendingWatcherUpdate('change', provider, sessionId);
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  watcherClosing = true;
  watcherGeneration += 1;
  clearPendingWatcherFlushTimer();
  unsubscribeSynchronizationComplete?.();
  unsubscribeSynchronizationComplete = null;

  await Promise.all(
    Array.from(watchers.values(), async ({ watcher }) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.clear();
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
  scheduleUsageIngestion = (request) => usageIngestionScheduler.schedule(request);
  resumeUsageBackfill = resumeUsageIngestionBackfill;
  synchronizeProviderFile = sessionSynchronizerService.synchronizeProviderFile.bind(sessionSynchronizerService);
}

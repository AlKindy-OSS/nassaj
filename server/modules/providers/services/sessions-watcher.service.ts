import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { participantsDb, projectMembersDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { resolveCodexHomes } from '@/modules/providers/list/codex/codex-home.js';
import { resolveOpenCodeDataHomes } from '@/modules/providers/list/opencode/opencode-home.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { vendorProviderRoot } from '@/modules/providers/shared/vendor/vendor-transcript.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider, RealtimeClientConnection } from '@/shared/types.js';
import { getProjectsWithSessions } from '@/modules/projects/index.js';

type WatcherEventType = 'add' | 'change' | 'unlink';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
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
  // {
  //   provider: 'gemini',
  //   rootPath: path.join(os.homedir(), '.gemini', 'sessions'),
  // },
  // Keep `sessions/` watcher disabled: Gemini also mirrors artifacts there,
  // which causes duplicate synchronization events.
  {
    provider: 'gemini',
    rootPath: path.join(os.homedir(), '.gemini', 'tmp'),
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

const watchers: FSWatcher[] = [];

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

  if (provider === 'gemini') {
    return filePath.endsWith('.json') || filePath.endsWith('.jsonl');
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

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
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
    const updatedProjects = await getProjectsWithSessions({ skipSynchronization: true });
    const changeTypes = Array.from(queuedUpdate.changeTypes);
    const watchProviders = Array.from(queuedUpdate.providers);
    const updatedSessionIds = Array.from(queuedUpdate.updatedSessionIds);

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
    };

    // `isMember` is per-user, but the shared fetch above runs without a
    // requester so every project carries isMember:false. Stamp the correct
    // membership flag per authenticated client before sending (one DB lookup
    // and one serialization per distinct userId, not per socket).
    //
    // B-PRIV: the shared fetch returns EVERY project, so it must also be filtered
    // to the projects each recipient is allowed to see — otherwise a private
    // project would leak to non-members through the projects_updated broadcast.
    // Unauthenticated sockets receive only the public projects.
    const serializedByUserId = new Map<number, string>();
    let serializedFallback: string | null = null;

    const resolveUpdateMessage = (client: RealtimeClientConnection): string => {
      const membershipUserId = toMembershipUserId(client.userId);
      if (membershipUserId === null) {
        if (serializedFallback === null) {
          const publicPaths = new Set(projectsDb.getVisibleProjectPaths(null));
          serializedFallback = JSON.stringify({
            ...basePayload,
            projects: updatedProjects.filter(project => publicPaths.has(project.fullPath)),
          });
        }
        return serializedFallback;
      }

      let serialized = serializedByUserId.get(membershipUserId);
      if (!serialized) {
        const visiblePaths = new Set(projectsDb.getVisibleProjectPaths(membershipUserId));
        const memberProjectPaths = new Set(participantsDb.getProjectPathsForUser(membershipUserId));
        // `isOwner` is per-user like `isMember`: the shared fetch above ran
        // without a requester, so re-stamp it from the (user-independent)
        // `ownerId` plus this user's project_members 'owner' roles.
        const ownedProjectIds = new Set(projectMembersDb.listUserOwnedProjectIds(membershipUserId));
        serialized = JSON.stringify({
          ...basePayload,
          projects: updatedProjects
            .filter(project => visiblePaths.has(project.fullPath))
            .map(project => ({
              ...project,
              isMember: memberProjectPaths.has(project.fullPath),
              isOwner:
                (project.ownerId !== null && project.ownerId === membershipUserId) ||
                ownedProjectIds.has(project.projectId),
            })),
        });
        serializedByUserId.set(membershipUserId, serialized);
      }
      return serialized;
    };

    connectedClients.forEach(client => {
      if (client.readyState === WS_OPEN_STATE) {
        client.send(resolveUpdateMessage(client));
      }
    });
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

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
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
 * provider maps to its single declared root EXCEPT codex, whose entry is fanned
 * out (B-152) into one watch per relevant CODEX_HOME/sessions — the operator
 * ~/.codex plus each isolated user's per-user home — so an isolated user's live
 * sessions trigger the same incremental sync as the operator's. In shared mode
 * resolveCodexHomes() collapses to just ~/.codex, leaving the original behavior.
 */
function resolveEffectiveWatchTargets(): Array<{ provider: LLMProvider; rootPath: string }> {
  const targets: Array<{ provider: LLMProvider; rootPath: string }> = [];

  for (const entry of PROVIDER_WATCH_PATHS) {
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

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of resolveEffectiveWatchTargets()) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('unlink', (filePath: string) => {
          onUnlink(filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
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
  clearPendingWatcherFlushTimer();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}

/**
 * RUNNER WS WATCHER
 * =================
 *
 * Mirrors server/routes/project-board.js's watch+broadcast pipeline exactly,
 * but for the runner's on-disk files. A lazy chokidar watcher is created per
 * project on first GET /api/runner/:projectId and watches:
 *
 *   state/<name>/checkpoint.json    (v2: coordinator writes after each cycle)
 *   state/<name>/supervisor.json    (v2: heartbeat + cycle_stats)
 *   state/<name>/cycle-history.json (unchanged: RunnerJourney data)
 *   state/<name>/pause              (control file)
 *   state/<name>/pending-approvals/ (auto-mode approval queue — dir watch)
 *   projects/registry.json          (enable/priority changes)
 *
 * Any event fans `runner-updated` out to every WS client via app.locals.wss,
 * with the same 250ms debounce. The frontend hook filters on type+projectId
 * and re-fetches GET /api/runner/:projectId — identical to useProjectBoard.
 *
 * No new WS transport, no new socket: reuses app.locals.wss.
 */

import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';

import { runnerPaths, REGISTRY_FILE } from './runner-bridge.service.js';

const MAX_WATCHED_PROJECTS = 50;
const BROADCAST_DEBOUNCE_MS = 250;

type WatchEntry = {
  runnerName: string;
  watcher: FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
};

/** projectId -> watcher entry. */
const watchers = new Map<string, WatchEntry>();

type WssLike = {
  clients: Set<{ readyState: number; send: (data: string) => void }>;
};

function broadcastRunnerUpdate(wss: WssLike | undefined, projectId: string): void {
  if (!wss || !projectId) {
    return;
  }
  const message = JSON.stringify({
    type: 'runner-updated',
    projectId,
    timestamp: new Date().toISOString(),
  });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending runner update:', error);
      }
    }
  });
}

/**
 * Ensure a watcher is running for (projectId, runnerName). Re-targets when the
 * runner name changes (project re-mapped). No-op once established. Safe to call
 * on every GET — idempotent like the board route's ensureWatcher.
 */
export function ensureRunnerWatcher(
  projectId: string,
  runnerName: string,
  wss: WssLike | undefined,
): void {
  let entry = watchers.get(projectId);

  if (entry && entry.runnerName !== runnerName) {
    // The project now maps to a different runner project — rebuild.
    if (entry.watcher) {
      entry.watcher.close().catch(() => {});
    }
    watchers.delete(projectId);
    entry = undefined;
  }

  if (entry?.watcher) {
    return;
  }

  if (!entry) {
    if (watchers.size > MAX_WATCHED_PROJECTS) {
      return; // safety valve
    }
    entry = { runnerName, watcher: null, debounceTimer: null };
    watchers.set(projectId, entry);
  }

  const paths = runnerPaths(runnerName);
  const targets = [
    // v2 primary state files
    paths.checkpoint,
    paths.supervisor,
    // unchanged: RunnerJourney history
    paths.cycleHistory,
    paths.pause,
    paths.approveNextPhase,
    // Dir watch: fires on every card the runner drops/clears in the auto-mode
    // approval queue. chokidar tolerates the dir being absent and picks it up
    // once the runner (or the sample seed) creates it.
    paths.pendingApprovalsDir,
    REGISTRY_FILE(),
  ];

  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  const currentEntry = entry;
  const notify = () => {
    if (currentEntry.debounceTimer) {
      clearTimeout(currentEntry.debounceTimer);
    }
    currentEntry.debounceTimer = setTimeout(() => {
      currentEntry.debounceTimer = null;
      broadcastRunnerUpdate(wss, projectId);
    }, BROADCAST_DEBOUNCE_MS);
  };

  watcher.on('add', notify);
  watcher.on('change', notify);
  watcher.on('unlink', notify);
  watcher.on('error', (error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Runner watcher error for ${projectId}:`, msg);
  });

  currentEntry.watcher = watcher;
}

/**
 * Broadcast immediately after a control write so the owner sees the optimistic
 * change without waiting for the filesystem event (the watcher will also fire).
 */
export function broadcastNow(wss: WssLike | undefined, projectId: string): void {
  broadcastRunnerUpdate(wss, projectId);
}

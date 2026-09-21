/**
 * background-tasks WS watcher (§ب-1 "الشارة", runner-watcher pattern) — the
 * SERVER side of the background-task badge. The permanent supervisor is a SEPARATE
 * process with no access to the app's WebSocket server, so — exactly like
 * runner-watcher.service.ts mirrors project-board's watch+broadcast — the APP
 * process watches the supervisor's on-disk state and fans a `background-tasks-
 * updated` signal out to every WS client. The client (deferred to a later wave;
 * build:client is out of scope here) refetches the count endpoint on that signal,
 * identical to how useProjectBoard refetches on `runner-updated`.
 *
 * NO NEW TRANSPORT: reuses app.locals.wss. FLAG-GATED: a no-op when
 * WORKFLOW_SUPERVISOR is OFF, so wiring it into index.js is byte-identical to
 * before until the flag is set. Broadcast-only (the message carries no payload
 * beyond a timestamp) so it never leaks a task's contents over the socket.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';

import {
  isSupervisorEnabled,
  intentsDir,
  tasksDir,
  handoffsDir,
} from './config.js';

const BROADCAST_DEBOUNCE_MS = 250;

type WssLike = {
  clients: Set<{ readyState: number; send: (data: string) => void }>;
};

let watcher: FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

function broadcast(wss: WssLike | undefined): void {
  if (!wss) {
    return;
  }
  const message = JSON.stringify({
    type: 'background-tasks-updated',
    timestamp: new Date().toISOString(),
  });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending background-tasks update:', error);
      }
    }
  });
}

/**
 * Ensure the singleton watcher is running. Idempotent (safe to call once at boot).
 * FLAG-GATED: returns immediately when the feature is OFF. Watches the intents,
 * tasks, and handoffs dirs; chokidar tolerates their absence and picks them up on
 * first create. Any add/change/unlink debounces one broadcast.
 */
export function ensureBackgroundTasksWatcher(
  wss: WssLike | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isSupervisorEnabled(env) || watcher) {
    return;
  }
  const targets = [intentsDir(env), tasksDir(env), handoffsDir(env)];
  watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const notify = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcast(wss);
    }, BROADCAST_DEBOUNCE_MS);
  };
  watcher.on('add', notify);
  watcher.on('change', notify);
  watcher.on('unlink', notify);
  watcher.on('error', (error: unknown) => {
    console.error('background-tasks watcher error:', error instanceof Error ? error.message : String(error));
  });
}

/** Tear the watcher down (tests). */
export async function stopBackgroundTasksWatcher(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    await watcher.close().catch(() => {});
    watcher = null;
  }
}

/**
 * A cheap count for the badge: pending intents (queued, not yet launched) + the
 * number of launched task dirs. Kept intentionally simple and I/O-cheap (a
 * dir-listing, no per-task ledger cross-reference); never throws.
 */
export function countBackgroundTasks(env: NodeJS.ProcessEnv = process.env): {
  pendingIntents: number;
  tasks: number;
} {
  let pendingIntents = 0;
  try {
    const root = intentsDir(env);
    for (const userDir of fs.readdirSync(root)) {
      try {
        pendingIntents += fs
          .readdirSync(path.join(root, userDir))
          .filter((n) => n.endsWith('.json') && !n.includes('.tmp-')).length;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no intents dir */
  }

  let tasks = 0;
  try {
    tasks = fs
      .readdirSync(tasksDir(env))
      .filter((n) => !n.startsWith('.')).length;
  } catch {
    /* no tasks dir */
  }

  return { pendingIntents, tasks };
}

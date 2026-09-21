/**
 * queue-guard — the disk-queue DoS defenses the T-820 audit made a BLOCKING
 * condition for building the monitor on top of the poll loop (C1). The audit's
 * finding: the intents dir has no per-user cap and no rate-limit, and each queued
 * intent costs a GATE2 + a systemctl probe on EVERY tick — so a single
 * authenticated owner could flood the dir and amplify it into host-wide
 * CPU/IO/disk exhaustion. This module supplies the four missing pieces:
 *
 *   (أ) countPendingIntents  — the route enforces a per-user cap (429) with it.
 *   (ج) QueuedRetryTracker   — back-off so a queued intent is re-processed at most
 *                              once per interval, not every tick (kills the probe
 *                              amplification).
 *   (د) sweepStaleIntents    — the monitor deletes intents older than a TTL (a
 *                              queued intent that never admits, or a corrupt file
 *                              that never parses) so the queue cannot grow forever.
 *   (ب) rate-limit           — supplied by the route via the shared limiter.
 *
 * Every function is pure I/O over the intents tree and NEVER throws — a stat/read
 * failure degrades to "nothing counted / nothing swept", never a crash.
 */

import fs from 'node:fs';
import path from 'node:path';

import { intentsDir, userIntentDir } from './config.js';

/** True for a real intent file (not a half-written `.tmp-` rename target). */
function isIntentFile(name: string): boolean {
  return name.endsWith('.json') && !name.includes('.tmp-');
}

/**
 * Count a user's PENDING (on-disk) intents. Used by the route to reject an
 * (N+1)th launch with 429 before it writes, so the queue is bounded at the
 * source. Fail-open to 0 is deliberately AVOIDED: a read failure returns a large
 * sentinel so the cap fails CLOSED (a monitoring blip denies rather than floods).
 */
export function countPendingIntents(
  userId: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const dir = userIntentDir(userId, env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0; // no dir yet ⇒ genuinely zero pending
    }
    return Number.MAX_SAFE_INTEGER; // unreadable ⇒ fail closed (treat as full)
  }
  return names.filter(isIntentFile).length;
}

export type SweepResult = { scannedUsers: number; deleted: number };

/**
 * Delete intent files older than `maxAgeMs` across every user (by mtime). Also
 * removes now-empty per-user dirs. Runs on a slow cadence (the monitor's sweep
 * timer). Never throws; a per-file failure is skipped.
 */
export function sweepStaleIntents(
  env: NodeJS.ProcessEnv = process.env,
  maxAgeMs = 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): SweepResult {
  const root = intentsDir(env);
  let userDirs: string[];
  try {
    userDirs = fs.readdirSync(root);
  } catch {
    return { scannedUsers: 0, deleted: 0 };
  }

  let deleted = 0;
  let scannedUsers = 0;
  for (const userDir of userDirs) {
    const dir = path.join(root, userDir);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    scannedUsers++;
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) {
          continue;
        }
        if (now - st.mtimeMs >= maxAgeMs) {
          fs.rmSync(full, { force: true });
          deleted++;
        }
      } catch {
        /* vanished or unreadable — skip */
      }
    }
    // Best-effort cleanup of an emptied user dir.
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      /* not empty or gone — leave it */
    }
  }
  return { scannedUsers, deleted };
}

/**
 * In-memory back-off for QUEUED intents (C1-ج). A queued intent (over the
 * concurrency cap) is left on disk and retried; without back-off it re-runs GATE2
 * + a systemctl probe on every single tick. This tracker gates a retry to at most
 * once per `backoffMs` per intent key, collapsing the amplification. It also
 * forgets keys it no longer sees, so a consumed intent leaves no residue.
 */
export class QueuedRetryTracker {
  private readonly lastAttempt = new Map<string, number>();

  constructor(
    private readonly backoffMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if `key` may be attempted now (never attempted, or past the back-off). */
  shouldAttempt(key: string): boolean {
    const last = this.lastAttempt.get(key);
    return last === undefined || this.now() - last >= this.backoffMs;
  }

  /** Record an attempt so the next one waits a full back-off. */
  markAttempt(key: string): void {
    this.lastAttempt.set(key, this.now());
  }

  /** Drop a key once its intent is gone (consumed/swept), preventing unbounded growth. */
  forget(key: string): void {
    this.lastAttempt.delete(key);
  }

  /** Prune tracked keys that are no longer present in `liveKeys`. */
  retain(liveKeys: Set<string>): void {
    for (const key of this.lastAttempt.keys()) {
      if (!liveKeys.has(key)) {
        this.lastAttempt.delete(key);
      }
    }
  }
}

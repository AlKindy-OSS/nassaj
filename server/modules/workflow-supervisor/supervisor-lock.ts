/**
 * supervisor-lock — the single-owner flock(2) gate for the permanent monitor
 * (الشرط 5, §ب-0/§ب-2), ported from the proven T-819 spike wrapper
 * (`spikes/b103-t819/bin/supervisor-run.sh`) into in-process node so runSupervisor
 * is self-contained and testable WITHOUT a shell wrapper.
 *
 * WHY THIS MECHANISM (الأمان ثم الاستقرار)
 * ----------------------------------------
 * The spike proved single-ownership with a shell `exec 9>LOCK; flock -n 9`. The
 * kernel property that makes the crash-safety criteria sound is that flock(2) is
 * released on ANY death — including an uncatchable `kill -9` — so a restart
 * re-acquires with NO stale lock. We reproduce the EXACT kernel primitive in node
 * without a native addon:
 *
 *   1. openSync(lockPath) → an fd the process holds for its whole life.
 *   2. spawnSync('flock', ['-n', '3'], { stdio: [..., fd] }) maps that fd to the
 *      child's fd 3 (a dup ⇒ the SAME open file description). `flock -n 3` (the fd
 *      form, no command) locks the OFD and returns immediately (0 = acquired,
 *      1 = would-block ⇒ another instance holds it).
 *   3. The child exits, but the lock is bound to the OFD, which stays alive via
 *      the parent's fd — so the lock PERSISTS after the child flock exits, and is
 *      released only when the parent process dies (all fds to the OFD close). That
 *      is precisely the kill-9-safe behavior the spike relied on.
 *
 * This is the same flock(2) syscall the runner uses; choosing in-process over a
 * shell wrapper keeps the single-owner gate inside runSupervisor (directly
 * testable, no ExecStart coupling) — the deliberate, documented choice for T-821.
 * Verified on a 2-process kill-9 experiment before adoption.
 */

import { openSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type SupervisorLock = {
  /** The held fd — kept open for the process lifetime; do NOT close while active. */
  fd: number;
  /** Explicit release (also happens on process death via the kernel). */
  release: () => void;
};

/**
 * Try to acquire the single-owner lock. Returns a {@link SupervisorLock} on
 * success or `null` when another instance already holds it (the second monitor
 * exits quietly — الشرط 5). Never throws: a missing `flock` binary or an open
 * failure yields `null` (fail-closed: do NOT run a second, unguarded monitor).
 */
export function acquireSingleOwnerLock(lockPath: string): SupervisorLock | null {
  let fd: number;
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    fd = openSync(lockPath, 'w');
  } catch {
    return null;
  }

  let acquired = false;
  try {
    // Map the parent fd to child fd 3; `flock -n 3` locks the shared OFD.
    const r = spawnSync('flock', ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    acquired = r.status === 0;
  } catch {
    acquired = false;
  }

  if (!acquired) {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
    return null;
  }

  return {
    fd,
    release: () => {
      try {
        closeSync(fd); // releasing the last fd to the OFD drops the flock.
      } catch {
        /* best-effort — process death releases it regardless */
      }
    },
  };
}

/**
 * Crash-safe process ownership gate for the Universal Conversation writer.
 *
 * The parent keeps the descriptor open after a short-lived `flock -n` helper
 * acquires flock(2) on the same open file description. Kernel process teardown,
 * including SIGKILL, closes the descriptor and releases the lock.
 */
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import * as childProcess from 'node:child_process';

export interface ConversationWriterLock {
  readonly fd: number;
  release(): void;
}

/** Tries once and fails closed on contention or an unavailable flock binary. */
export function acquireConversationWriterLock(lockPath: string): ConversationWriterLock | null {
  let fd: number;
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    fd = openSync(lockPath, 'w', 0o600);
  } catch {
    return null;
  }

  let acquired = false;
  try {
    const result = childProcess.spawnSync('flock', ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    acquired = result.status === 0;
  } catch {
    acquired = false;
  }

  if (!acquired) {
    try {
      closeSync(fd);
    } catch {
      // The process owns no writer authority when acquisition fails.
    }
    return null;
  }

  let released = false;
  return {
    fd,
    release: () => {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        // Process death is the final crash-safe release path.
      }
    },
  };
}

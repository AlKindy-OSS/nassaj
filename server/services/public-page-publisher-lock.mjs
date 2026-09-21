import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { isPublicationId, openPrivateRoot } from './public-page-manifest.mjs';

/** A publisher failure that is safe to return to the control-plane boundary. */
export class PublicPagePublisherError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function lockFailure(code) { throw new PublicPagePublisherError(code); }

function assertPrivateLockDirectory(directory) {
  try {
    return openPrivateRoot(directory);
  } catch (error) {
    if (error instanceof PublicPagePublisherError) throw error;
    lockFailure('PUBLICATION_LOCK_UNCERTAIN');
  }
}

function openLockFile(directoryFd, publicationId) {
  let fd;
  try {
    fd = openSync(`/proc/self/fd/${directoryFd}/${publicationId}.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      lockFailure('PUBLICATION_LOCK_UNCERTAIN');
    }
    return fd;
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd); } catch {}
    if (error instanceof PublicPagePublisherError) throw error;
    lockFailure('PUBLICATION_LOCK_UNCERTAIN');
  }
}

/** Classify the fixed flock helper result without making lock acquisition injectable. */
export function classifyFlockExit(code, signal = null) {
  if (signal || !Number.isInteger(code)) return 'PUBLICATION_LOCK_UNCERTAIN';
  if (code === 0) return 'ACQUIRED';
  return code === 75 ? 'PUBLICATION_BUSY' : 'PUBLICATION_LOCK_UNCERTAIN';
}

/** Acquire a kernel-owned exclusive lock and retain its inherited file description until release. */
export async function acquirePublicPageLock(lockDirectory, publicationId, { waitMs = 1_000 } = {}) {
  if (!isPublicationId(publicationId) || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
    lockFailure('PUBLICATION_LOCK_UNCERTAIN');
  }
  const directoryFd = assertPrivateLockDirectory(lockDirectory);
  let lockFd;
  try {
    lockFd = openLockFile(directoryFd, publicationId);
    const child = spawn('/usr/bin/flock', ['-x', '-E', '75', '-w', String(waitMs / 1_000), '3'], {
      shell: false, stdio: ['ignore', 'ignore', 'ignore', lockFd], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new PublicPagePublisherError('PUBLICATION_LOCK_UNCERTAIN')));
      child.once('close', (code, signal) => {
        const result = classifyFlockExit(code, signal);
        if (result === 'ACQUIRED') resolve();
        else reject(new PublicPagePublisherError(result));
      });
    });
  } catch (error) {
    try { if (lockFd !== undefined) closeSync(lockFd); } catch {}
    try { closeSync(directoryFd); } catch {}
    if (error instanceof PublicPagePublisherError) throw error;
    lockFailure('PUBLICATION_LOCK_UNCERTAIN');
  }
  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      try { closeSync(lockFd); } finally { closeSync(directoryFd); }
    },
  });
}

/**
 * Durable filesystem primitives shared by the snapshot libraries: fsync of
 * files and directories, atomic write (temp + fsync + rename + dir fsync),
 * hashing and hashing copy. Synchronous by design: every caller runs under a
 * per-harness lease and needs a crash-consistent order of operations.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PRIVATE_FILE_MODE, withPrivateUmask } from './paths.js';

const CHUNK = 1024 * 1024;

/** fsyncs a file or a directory by path. */
export function fsyncPath(p: string): void {
  const fd = fs.openSync(p, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically replaces `file` with `data` (temp 0600, fsync, rename, dir fsync). */
export function writeFileAtomic(file: string, data: string | Buffer, mode = PRIVATE_FILE_MODE): void {
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  withPrivateUmask(() => {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fsyncPath(path.dirname(file));
}

/** Streams `file` through sha256 without following a final symlink. */
export function hashFile(file: string): { sha256: string; size: number } {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buf = Buffer.allocUnsafe(CHUNK);
  let size = 0;
  try {
    for (let n = fs.readSync(fd, buf, 0, CHUNK, null); n > 0; n = fs.readSync(fd, buf, 0, CHUNK, null)) {
      hash.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Copies `src` to a NEW file `dst` (O_EXCL, `mode`), hashing the bytes that
 * were written, then fsyncs `dst`. Returns the digest and byte count.
 */
export function copyFileHashed(src: string, dst: string, mode = PRIVATE_FILE_MODE): { sha256: string; size: number } {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  const inFd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let size = 0;
  try {
    const outFd = withPrivateUmask(() => fs.openSync(dst, 'wx', mode));
    try {
      for (let n = fs.readSync(inFd, buf, 0, CHUNK, null); n > 0; n = fs.readSync(inFd, buf, 0, CHUNK, null)) {
        hash.update(buf.subarray(0, n));
        fs.writeSync(outFd, buf, 0, n);
        size += n;
      }
      fs.fchmodSync(outFd, mode);
      fs.fsyncSync(outFd);
    } finally {
      fs.closeSync(outFd);
    }
  } finally {
    fs.closeSync(inFd);
  }
  return { sha256: hash.digest('hex'), size };
}

/** sha256 of a UTF-8 string. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** lstat that returns null for a missing path (other errors propagate). */
export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Contained, descriptor-based file reads for live read-link attachments
 * (ADR-205 D4 L1/N2). Every read:
 *   - opens the validator-resolved path with O_RDONLY | O_NOFOLLOW (a symlink
 *     leaf, even one swapped in after validation, is refused);
 *   - fstat()s the descriptor and requires a regular, singly-linked file within the size cap;
 *   - re-checks containment through the descriptor (the `/proc/self/fd/<n>`
 *     link text, read verbatim, strictly inside the validator's real root and
 *     still naming the descriptor's dev/ino), so a symlinked directory in the
 *     chain cannot lead outside;
 *   - re-runs the secret-path guards on that real path;
 *   - reads bytes from the descriptor only.
 * Linux only (the project's host); elsewhere every read is refused.
 */
import fs from 'node:fs';
import path from 'node:path';

import { classifySecretPath, isSecretPath } from '@/shared/secret-path-guard.js';

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Bytes sniffed at projection time to classify a file as text-like (N2). */
export const TEXT_PROBE_BYTES = 64 * 1024;

export type ContainedRead =
  | { ok: true; bytes: Buffer; size: number; complete: boolean }
  | { ok: false; reason: 'gone' | 'too_large' | 'secret' };

const gone = (): ContainedRead => ({ ok: false, reason: 'gone' });

/** Secret location by either guard (H1). */
export function isSecretLocation(target: string): boolean {
  return classifySecretPath(target) !== null || isSecretPath(target);
}

/** Reads up to `limit` bytes from `fd` starting at 0. */
function readPrefix(fd: number, limit: number): Buffer {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const read = fs.readSync(fd, buffer, filled, limit - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/** Checks the open descriptor: regular, within the cap, contained in `realRoot`, not secret. */
function inspectDescriptor(fd: number, realRoot: string, maxBytes: number): ContainedRead | { ok: true; size: number } {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) return gone();
  // A second hard link may alias a file outside the root (same rule as pinned-fd's multiply_linked).
  if (stat.nlink !== 1) return gone();
  if (stat.size > maxBytes) return { ok: false, reason: 'too_large' };
  // B-1611: the /proc link text is read verbatim, never resolved by name (a
  // planted `<name> (deleted)` symlink could vouch for an unlinked descriptor);
  // the name must still be this very object (dev/ino), else it is gone.
  const real = fs.readlinkSync(`/proc/self/fd/${fd}`);
  if (!real.startsWith(realRoot + path.sep)) return gone();
  const named = fs.lstatSync(real, { throwIfNoEntry: false });
  if (!named || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) return gone();
  if (isSecretLocation(real)) return { ok: false, reason: 'secret' };
  return { ok: true, size: stat.size };
}

/**
 * Opens `candidate` (already resolved by an existing validator) and reads at
 * most `readBytes` (default: the whole file) under the L1 rules.
 * @param realRoot canonical root the validator confines `candidate` to
 */
export function readContainedFile(realRoot: string, candidate: string,
  options: { maxBytes?: number; readBytes?: number } = {}): ContainedRead {
  const maxBytes = options.maxBytes ?? ATTACHMENT_MAX_BYTES;
  if (process.platform !== 'linux' || !path.isAbsolute(candidate)) return gone();
  let fd: number;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return gone();
  }
  try {
    const inspected = inspectDescriptor(fd, realRoot, maxBytes);
    if (!inspected.ok || !('size' in inspected)) return inspected as ContainedRead;
    const limit = Math.min(inspected.size, options.readBytes ?? inspected.size);
    const bytes = readPrefix(fd, limit);
    return { ok: true, bytes, size: inspected.size, complete: bytes.length === inspected.size };
  } catch {
    return gone();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Text-like per N2: no NUL byte and valid UTF-8. For a prefix (`complete`
 * false) a multi-byte sequence cut at the end is accepted.
 */
export function isTextLike(bytes: Buffer, complete: boolean): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}

/** The canonical form of `root`, or null when it does not resolve. */
export function realRootOf(root: string): string | null {
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

import fs, { type BigIntStats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Pinned open of a file or directory by its expected realpath (ADR-201 A1.5).
 *
 * Opening a stored path by name is a race: the name can be swapped for a
 * symlink, a hardlink or another file between the check and the read. A pinned
 * open closes that window. It `lstat`s the name, opens it with `O_NOFOLLOW`,
 * `fstat`s the descriptor, and accepts the descriptor only when:
 *   - `lstat` and `fstat` describe the same object of the expected kind
 *     (same device and inode at this instant), and
 *   - the kernel's own name for the descriptor (`/proc/self/fd/<n>`) is the
 *     expected realpath.
 * dev/ino are compared only between the two calls of this one open; they are
 * never compared with a value recorded earlier (files are legitimately
 * rewritten and rotated), so callers may keep them as diagnostics only.
 *
 * Linux only by design: without `/proc/self/fd` the descriptor's real name
 * cannot be proven, so the open fails closed with `proc_unavailable`.
 */

export type PinnedRefusal =
  | 'not_absolute' | 'missing' | 'symlink' | 'wrong_kind' | 'changed_during_open'
  | 'path_mismatch' | 'multiply_linked' | 'proc_unavailable' | 'io_error';

/** A refused pinned open; `reason` is safe to log (it carries no path or content). */
export class PinnedOpenError extends Error {
  constructor(readonly reason: PinnedRefusal) {
    super(`pinned open refused: ${reason}`);
    this.name = 'PinnedOpenError';
  }
}

export type PinnedKind = 'file' | 'directory';

export type PinnedHandle = { handle: FileHandle; realpath: string; stat: BigIntStats };

export type PinnedOpenOptions = {
  /** Called between every step; may throw to abort (e.g. a request budget). */
  checkpoint?: () => void;
  /** Takes ownership of the descriptor the moment it exists. */
  track?: (handle: FileHandle) => void;
  /** Releases a descriptor refused after open; defaults to `handle.close()`. */
  release?: (handle: FileHandle) => Promise<void>;
  /** Refuse a regular file with more than one hard link. */
  singleLink?: boolean;
  /** Open this spelling instead of `expected` (e.g. `/proc/self/fd/<dir>/<name>`). */
  via?: string;
  /** `/proc/self/fd` replacement; tests use it to model a host without /proc. */
  procFdDir?: string;
};

const PROC_FD_DIR = '/proc/self/fd';
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
// libuv opens every descriptor with O_CLOEXEC on Linux; Node does not expose the
// constant, so it is OR-ed only where it exists.
const CLOEXEC = (fs.constants as Record<string, number>).O_CLOEXEC ?? 0;

/** Open flags of a pinned open of `kind`. */
export function pinnedFlags(kind: PinnedKind): number {
  return (kind === 'file' ? FILE_FLAGS : DIRECTORY_FLAGS) | CLOEXEC;
}

function isKind(stat: fs.BigIntStats, kind: PinnedKind): boolean {
  return kind === 'file' ? stat.isFile() : stat.isDirectory();
}

/**
 * Realpath the kernel reports for descriptor `fd`. Throws `proc_unavailable`
 * when `/proc/self/fd` itself is missing, `io_error` for any other failure.
 */
export async function descriptorRealpath(fd: number, procFdDir: string = PROC_FD_DIR): Promise<string> {
  try {
    return await fsp.realpath(path.join(procFdDir, String(fd)));
  } catch {
    const procPresent = await fsp.stat(procFdDir).then((stat) => stat.isDirectory(), () => false);
    throw new PinnedOpenError(procPresent ? 'io_error' : 'proc_unavailable');
  }
}

async function lstatExpected(target: string, kind: PinnedKind): Promise<fs.BigIntStats> {
  let stat: fs.BigIntStats;
  try {
    stat = await fsp.lstat(target, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PinnedOpenError(code === 'ENOENT' ? 'missing' : 'io_error');
  }
  if (stat.isSymbolicLink()) throw new PinnedOpenError('symlink');
  if (!isKind(stat, kind)) throw new PinnedOpenError('wrong_kind');
  return stat;
}

async function openNoFollow(target: string, kind: PinnedKind): Promise<FileHandle> {
  try {
    return await fsp.open(target, pinnedFlags(kind));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new PinnedOpenError('symlink');
    if (code === 'ENOENT') throw new PinnedOpenError('changed_during_open');
    throw new PinnedOpenError(code === 'ENOTDIR' ? 'wrong_kind' : 'io_error');
  }
}

/** Gate on an open descriptor; throws a PinnedOpenError on any mismatch. */
async function admitDescriptor(
  handle: FileHandle, expected: string, named: fs.BigIntStats, kind: PinnedKind, options: PinnedOpenOptions,
): Promise<BigIntStats> {
  const stat = await handle.stat({ bigint: true });
  options.checkpoint?.();
  if (!isKind(stat, kind) || stat.dev !== named.dev || stat.ino !== named.ino) {
    throw new PinnedOpenError('changed_during_open');
  }
  if (kind === 'file' && options.singleLink && stat.nlink !== 1n) throw new PinnedOpenError('multiply_linked');
  if (await descriptorRealpath(handle.fd, options.procFdDir) !== expected) throw new PinnedOpenError('path_mismatch');
  options.checkpoint?.();
  return stat;
}

/**
 * Pinned open of `expected` (an absolute realpath) as `kind`. Resolves to the
 * open handle with its fstat, or throws: a PinnedOpenError for a refused or
 * failed open, or whatever `checkpoint` throws. A descriptor refused after open
 * is released before the throw.
 */
export async function openPinned(
  expected: string, kind: PinnedKind, options: PinnedOpenOptions = {},
): Promise<PinnedHandle> {
  if (!path.isAbsolute(expected) || path.resolve(expected) !== expected) throw new PinnedOpenError('not_absolute');
  const spelling = options.via ?? expected;
  options.checkpoint?.();
  const named = await lstatExpected(spelling, kind);
  options.checkpoint?.();
  const handle = await openNoFollow(spelling, kind);
  options.track?.(handle);
  try {
    options.checkpoint?.();
    const stat = await admitDescriptor(handle, expected, named, kind, options);
    return { handle, realpath: expected, stat };
  } catch (error) {
    await (options.release ?? ((owned: FileHandle) => owned.close()))(handle).catch(() => undefined);
    throw error;
  }
}

/** Entry names of a pinned directory, read through its descriptor (never by name). */
export async function listPinnedDirectory(
  directory: FileHandle, limit: number, procFdDir: string = PROC_FD_DIR,
): Promise<string[]> {
  const dir = await fsp.opendir(path.join(procFdDir, String(directory.fd)));
  const names: string[] = [];
  try {
    for (let entry = await dir.read(); entry; entry = await dir.read()) {
      if (names.length >= limit) break;
      names.push(entry.name);
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return names;
}

/**
 * Pinned single-link open of a server-derived file (a manifest child, a cost
 * source) whose directory part may legitimately pass through symlinked dirs
 * (shared provider trees): the directory is realpath-resolved, the final
 * component never is, so a symlinked or hardlinked file is refused. The caller
 * confines the returned realpath and binds its identity.
 */
export async function openFileNoFollow(candidate: string, options: PinnedOpenOptions = {}): Promise<PinnedHandle> {
  if (!path.isAbsolute(candidate)) throw new PinnedOpenError('not_absolute');
  let directory: string;
  try {
    directory = await fsp.realpath(path.dirname(candidate));
  } catch {
    throw new PinnedOpenError('missing');
  }
  return openPinned(path.join(directory, path.basename(candidate)), 'file', { singleLink: true, ...options });
}

export type PinnedSyncHandle = { fd: number; realpath: string; stat: fs.BigIntStats };

/** Opens `target` with `flags | O_NOFOLLOW`, mapping errno to a refusal. */
function openNoFollowSync(target: string, flags: number, mode: number): number {
  try {
    return fs.openSync(target, flags | fs.constants.O_NOFOLLOW | CLOEXEC, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new PinnedOpenError('symlink');
    if (code === 'ENOENT') throw new PinnedOpenError('missing');
    throw new PinnedOpenError(code === 'EEXIST' ? 'changed_during_open' : 'io_error');
  }
}

/** Synchronous gate of {@link admitDescriptor} for a regular file. */
function admitSync(fd: number, expected: string, named: fs.BigIntStats | null): fs.BigIntStats {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || (named && (stat.dev !== named.dev || stat.ino !== named.ino))) {
    throw new PinnedOpenError('changed_during_open');
  }
  if (stat.nlink !== 1n) throw new PinnedOpenError('multiply_linked');
  let real: string;
  try {
    real = fs.realpathSync.native(path.join(PROC_FD_DIR, String(fd)));
  } catch {
    throw new PinnedOpenError(fs.existsSync(PROC_FD_DIR) ? 'io_error' : 'proc_unavailable');
  }
  if (real !== expected) throw new PinnedOpenError('path_mismatch');
  return stat;
}

/**
 * Synchronous pinned open of the regular single-link file at the absolute
 * realpath `expected` (for synchronous writers: the supervisor handoff, the
 * transcript repair). `flags` are OR-ed with `O_NOFOLLOW`; with `O_CREAT` the
 * caller must also pass `O_EXCL` so a planted name is never followed. The
 * caller owns and closes `fd`.
 */
export function openPinnedSync(expected: string, flags: number = fs.constants.O_RDONLY, mode = 0o600): PinnedSyncHandle {
  if (!path.isAbsolute(expected) || path.resolve(expected) !== expected) throw new PinnedOpenError('not_absolute');
  const creating = (flags & fs.constants.O_CREAT) !== 0;
  if (creating && (flags & fs.constants.O_EXCL) === 0) throw new PinnedOpenError('io_error');
  let named: fs.BigIntStats | null = null;
  if (!creating) {
    try {
      named = fs.lstatSync(expected, { bigint: true });
    } catch (error) {
      throw new PinnedOpenError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'io_error');
    }
    if (named.isSymbolicLink()) throw new PinnedOpenError('symlink');
    if (!named.isFile()) throw new PinnedOpenError('wrong_kind');
  }
  const fd = openNoFollowSync(expected, flags, mode);
  try {
    return { fd, realpath: expected, stat: admitSync(fd, expected, named) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * `candidate` with its directory realpath-resolved and its last component left
 * as is (so a pinned open refuses a symlinked file instead of following it),
 * or null when the directory does not resolve.
 */
export function canonicalFileSync(candidate: string): string | null {
  try {
    return path.join(fs.realpathSync(path.dirname(path.resolve(candidate))), path.basename(candidate));
  } catch {
    return null;
  }
}

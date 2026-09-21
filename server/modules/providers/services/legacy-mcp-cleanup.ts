import fs from 'node:fs';
import type { Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import TOML from '@iarna/toml';

import { AppError } from '@/shared/utils.js';

export type LegacyMcpConfigFormat = 'json' | 'toml';
export type LegacyCleanupFault = 'after-stage-write' | 'after-stage-fsync' | 'before-promotion';
export type LegacyLockTestPhase =
  | 'recovery-before-quarantine'
  | 'recovery-after-quarantine-link'
  | 'release-before-quarantine'
  | 'release-after-quarantine-link';
export type LegacyLockPublishFault = 'chmod' | 'write' | 'fsync' | 'dir-fsync';

type LegacyMcpFile = {
  rootDir: string;
  relativePath: string;
  format: LegacyMcpConfigFormat;
  mapKey: 'mcpServers' | 'mcp_servers';
};

type PinnedLegacyFile = {
  directoryHandles: Array<Awaited<ReturnType<typeof open>>>;
  directoryIdentities: Array<{ path: string; stat: Stats }>;
  parentHandle: Awaited<ReturnType<typeof open>>;
  fileHandle: Awaited<ReturnType<typeof open>>;
  finalName: string;
  content: string;
  stat: Stats;
};

type PinnedLockParent = Pick<PinnedLegacyFile, 'parentHandle'>;

type PinnedWriterParent = PinnedLockParent & {
  directoryHandles: Array<Awaited<ReturnType<typeof open>>>;
  directoryIdentities: Array<{ path: string; stat: Stats }>;
  finalName: string;
};

type WriterFinalSnapshot = {
  content: string | null;
  stat: Stats | null;
};

export type CanonicalMcpWriterTransaction = {
  targetPath: string;
  snapshotContent: string | null;
  beforePromotion: () => Promise<void>;
  recordPromotion: (stat: Stats, content: string) => void;
};

type CleanupLockOwner = {
  token: string;
  fence: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
};

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 10;
const LOCK_WAIT_LIMIT_MS = 10_000;
const LOCK_MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const LOCK_MAX_BYTES = 4_096;
// Linux O_PATH is not exposed by Node's fs.constants, but this module already
// relies on Linux procfs for descriptor-relative traversal. It pins a mode-000
// directory created under a restrictive umask without requiring search access.
const LINUX_O_PATH = 0o10000000;
const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const legacyCleanupLockName = (relativePath: string): string =>
  `.nassaj-mcp-cleanup-${path.basename(relativePath)}.lock`;

const unsafePath = (message: string): AppError => new AppError(message, {
  code: 'MCP_CLEANUP_UNSAFE_PATH', statusCode: 409,
});

const sameIdentity = (
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean => left.dev === right.dev && left.ino === right.ino;

const descriptorChild = (handle: { fd: number }, name: string): string =>
  `/proc/self/fd/${handle.fd}/${name}`;

const safeComponents = (rootDir: string, relativePath: string): {
  rootComponents: string[];
  relativeComponents: string[];
} => {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, relativePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw unsafePath('Historical MCP cleanup path escaped its declared root.');
  }
  const split = (value: string): string[] => value.split(path.sep).filter(Boolean);
  return {
    rootComponents: split(path.relative(path.parse(root).root, root)),
    relativeComponents: split(path.relative(root, candidate)),
  };
};

const closeHandles = async (handles: Array<Awaited<ReturnType<typeof open>>>): Promise<void> => {
  await Promise.allSettled(handles.map((handle) => handle.close()));
};

/**
 * Pins every directory from `/` to the target parent with O_NOFOLLOW handles.
 * Every subsequent lookup is relative to the previous descriptor through procfs,
 * which is Linux's safe openat-equivalent for Node's missing openat binding.
 */
const openPinnedLegacyParent = async (input: LegacyMcpFile): Promise<PinnedWriterParent | null> => {
  const { rootComponents, relativeComponents } = safeComponents(input.rootDir, input.relativePath);
  const finalName = relativeComponents.at(-1);
  if (!finalName) throw unsafePath('Historical MCP cleanup target filename is missing.');
  const directoryComponents = [...rootComponents, ...relativeComponents.slice(0, -1)];
  const handles: Array<Awaited<ReturnType<typeof open>>> = [];
  const identities: Array<{ path: string; stat: Stats }> = [];

  try {
    let current = await open('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    handles.push(current);
    let lexicalPath = '/';
    identities.push({ path: lexicalPath, stat: await current.stat() });
    for (const component of directoryComponents) {
      try {
        current = await open(
          descriptorChild(current, component),
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        handles.push(current);
        lexicalPath = path.join(lexicalPath, component);
        identities.push({ path: lexicalPath, stat: await current.stat() });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await closeHandles(handles);
          return null;
        }
        throw unsafePath(`Refusing unsafe historical MCP cleanup ancestor: ${component}`);
      }
    }

    return { directoryHandles: handles, directoryIdentities: identities, parentHandle: current, finalName };
  } catch (error) {
    await closeHandles(handles);
    throw error;
  }
};

/** Opens and verifies the target only after cleanup owns its parent-relative lock. */
const openLegacyFileInParent = async (parent: PinnedWriterParent): Promise<PinnedLegacyFile | null> => {
  const pinnedPath = descriptorChild(parent.parentHandle, parent.finalName);
  let before;
  try {
    before = await lstat(pinnedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw unsafePath('Historical MCP cleanup target must be one non-linked regular file.');
  }
  const fileHandle = await open(pinnedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await fileHandle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)) {
      throw unsafePath('Historical MCP cleanup file identity or hardlink count changed while opening.');
    }
    return { ...parent, fileHandle, content: await fileHandle.readFile('utf8'), stat: opened };
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
};

const openPinnedLegacyFile = async (input: LegacyMcpFile): Promise<PinnedLegacyFile | null> => {
  const parent = await openPinnedLegacyParent(input);
  if (!parent) return null;
  try {
    const opened = await openLegacyFileInParent(parent);
    if (opened) return opened;
  } catch (error) {
    await closeHandles(parent.directoryHandles);
    throw error;
  }
  await closeHandles(parent.directoryHandles);
  return null;
};

const closePinnedFile = async (opened: PinnedLegacyFile): Promise<void> => {
  await opened.fileHandle.close().catch(() => {});
  await closeHandles(opened.directoryHandles);
};

/** Pins (and writer-only creates) every parent component without following links. */
const openPinnedWriterParent = async (
  filePath: string,
  secureFinalParent: boolean,
  testAfterDirectoryCreated?: (directoryPath: string) => void | Promise<void>,
): Promise<PinnedWriterParent> => {
  const resolved = path.resolve(filePath);
  const finalName = path.basename(resolved);
  const components = path.dirname(resolved).split(path.sep).filter(Boolean);
  const handles: Array<Awaited<ReturnType<typeof open>>> = [];
  const identities: Array<{ path: string; stat: Stats }> = [];
  try {
    let current = await open('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    handles.push(current);
    let lexicalPath = '/';
    identities.push({ path: lexicalPath, stat: await current.stat() });
    for (const component of components) {
      const childPath = descriptorChild(current, component);
      let created = false;
      let recoverModeZero = false;
      try {
        current = await open(
          childPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === 'EACCES') {
          recoverModeZero = true;
        } else if (errorCode !== 'ENOENT') {
          throw unsafePath(`Refusing unsafe MCP writer ancestor: ${component}`);
        } else {
          try {
            await mkdir(childPath, { mode: 0o700 });
            created = true;
            await testAfterDirectoryCreated?.(path.join(lexicalPath, component));
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
            recoverModeZero = true;
          }
        }
        if (created || recoverModeZero) {
          const modePin = await open(
            childPath,
            LINUX_O_PATH | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          try {
            const expectedUid = typeof process.getuid === 'function'
              ? process.getuid()
              : (await modePin.stat()).uid;
            const pinnedBefore = await modePin.stat();
            if (!pinnedBefore.isDirectory() || pinnedBefore.uid !== expectedUid
              || (!created && ![0, 0o700].includes(pinnedBefore.mode & 0o777))) {
              throw unsafePath(`Refusing unowned or insecure raced MCP writer ancestor: ${component}`);
            }
            await chmod(`/proc/self/fd/${modePin.fd}`, 0o700);
            current = await open(
              childPath,
              fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
            );
            const openedStat = await current.stat();
            if (!sameIdentity(pinnedBefore, openedStat)) {
              await current.close();
              throw unsafePath(`MCP writer ancestor changed after creation: ${component}`);
            }
            await current.chmod(0o700);
            const securedStat = await current.stat();
            if (!sameIdentity(pinnedBefore, securedStat) || (securedStat.mode & 0o777) !== 0o700) {
              await current.close();
              throw unsafePath(`MCP writer ancestor could not be secured: ${component}`);
            }
          } finally {
            await modePin.close();
          }
        }
      }
      handles.push(current);
      if (created) {
        await current.chmod(0o700);
        const createdStat = await current.stat();
        if (!createdStat.isDirectory() || (createdStat.mode & 0o777) !== 0o700) {
          throw new AppError('MCP writer directory mode could not be secured.', {
            code: 'MCP_CONFIG_INSECURE_MODE', statusCode: 500,
          });
        }
      }
      lexicalPath = path.join(lexicalPath, component);
      identities.push({ path: lexicalPath, stat: await current.stat() });
    }
    if (secureFinalParent) {
      await current.chmod(0o700);
      if (((await current.stat()).mode & 0o777) !== 0o700) {
        throw new AppError('MCP writer parent directory mode could not be secured.', {
          code: 'MCP_CONFIG_INSECURE_DIRECTORY_MODE', statusCode: 500,
        });
      }
    }
    return {
      directoryHandles: handles,
      directoryIdentities: identities,
      parentHandle: current,
      finalName,
    };
  } catch (error) {
    await closeHandles(handles);
    throw error;
  }
};

const assertPinnedWriterAncestorsUnchanged = async (opened: PinnedWriterParent): Promise<void> => {
  for (const identity of opened.directoryIdentities) {
    let current: Stats;
    try {
      current = await lstat(identity.path);
    } catch {
      throw unsafePath('MCP writer ancestor disappeared during the transaction.');
    }
    if (current.isSymbolicLink() || !current.isDirectory()
      || !sameIdentity(identity.stat, current)) {
      throw unsafePath('MCP writer ancestor identity changed during the transaction.');
    }
  }
};

const assertWriterFinalSafe = async (opened: PinnedWriterParent): Promise<void> => {
  const finalPath = descriptorChild(opened.parentHandle, opened.finalName);
  let before: Stats;
  try {
    before = await lstat(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw unsafePath('MCP writer target must be one non-linked regular file.');
  }
  const handle = await open(finalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || !sameIdentity(before, current)) {
      throw unsafePath('MCP writer target changed while validating it.');
    }
  } finally {
    await handle.close();
  }
};

const readWriterFinalSnapshot = async (
  opened: PinnedWriterParent,
): Promise<WriterFinalSnapshot> => {
  const finalPath = descriptorChild(opened.parentHandle, opened.finalName);
  let before: Stats;
  try {
    before = await lstat(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: null, stat: null };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw unsafePath('MCP writer snapshot target must be one non-linked regular file.');
  }
  const handle = await open(finalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || !sameIdentity(before, current)) {
      throw unsafePath('MCP writer snapshot identity changed while opening.');
    }
    return { content: await handle.readFile('utf8'), stat: current };
  } finally {
    await handle.close();
  }
};

const assertWriterFinalMatchesSnapshot = async (
  opened: PinnedWriterParent,
  snapshot: WriterFinalSnapshot,
): Promise<void> => {
  const finalPath = descriptorChild(opened.parentHandle, opened.finalName);
  let current: Stats;
  try {
    current = await lstat(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && snapshot.stat === null) return;
    throw unsafePath('MCP writer final entry disappeared before promotion.');
  }
  if (snapshot.stat === null || current.isSymbolicLink() || !current.isFile()
    || current.nlink !== 1 || !sameIdentity(snapshot.stat, current)
    || current.ctimeMs !== snapshot.stat.ctimeMs) {
    throw unsafePath('MCP writer final entry changed before promotion.');
  }
  if (snapshot.content !== null) {
    const handle = await open(finalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const openedStat = await handle.stat();
      const content = await handle.readFile('utf8');
      if (!sameIdentity(snapshot.stat, openedStat) || openedStat.nlink !== 1
        || content !== snapshot.content) {
        throw unsafePath('MCP writer final bytes changed before transaction completion.');
      }
    } finally {
      await handle.close();
    }
  }
};

const reopenPinnedFile = async (opened: PinnedLegacyFile): Promise<void> => {
  await opened.fileHandle.close().catch(() => {});
  const pinnedPath = descriptorChild(opened.parentHandle, opened.finalName);
  const before = await lstat(pinnedPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw unsafePath('Historical MCP cleanup target changed before locked read.');
  }
  const fileHandle = await open(pinnedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const current = await fileHandle.stat();
  if (!current.isFile() || current.nlink !== 1 || !sameIdentity(before, current)) {
    await fileHandle.close();
    throw unsafePath('Historical MCP cleanup locked file identity is unsafe.');
  }
  opened.fileHandle = fileHandle;
  opened.stat = current;
  opened.content = await fileHandle.readFile('utf8');
};

const processIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readLockOwner = async (
  parentHandle: Awaited<ReturnType<typeof open>>,
  lockName: string,
  allowedNlinks: readonly number[] = [1],
): Promise<{ owner: CleanupLockOwner; stat: Stats }> => {
  const lockPath = descriptorChild(parentHandle, lockName);
  const before = await lstat(lockPath);
  if (before.isSymbolicLink() || !before.isFile() || !allowedNlinks.includes(before.nlink)) {
    throw unsafePath('Historical MCP cleanup lock path is unsafe.');
  }
  const handle = await open(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !allowedNlinks.includes(opened.nlink) || !sameIdentity(before, opened)) {
      throw unsafePath('Historical MCP cleanup lock identity changed while opening.');
    }
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : opened.uid;
    if (opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600
      || opened.size <= 0 || opened.size > LOCK_MAX_BYTES) {
      throw new AppError('Historical MCP cleanup lock metadata is invalid.', {
        code: 'MCP_CLEANUP_LOCK_MALFORMED', statusCode: 409,
      });
    }
    let owner: unknown;
    try {
      owner = JSON.parse(await handle.readFile('utf8'));
    } catch {
      throw new AppError('Historical MCP cleanup lock is malformed.', {
        code: 'MCP_CLEANUP_LOCK_MALFORMED', statusCode: 409,
      });
    }
    const candidate = owner as Partial<CleanupLockOwner> | null;
    const exactFields = candidate !== null && typeof candidate === 'object'
      && Object.keys(candidate).sort().join(',') === 'createdAt,expiresAt,fence,pid,token';
    const tokenValid = typeof candidate?.token === 'string'
      && CANONICAL_UUID_V4.test(candidate.token);
    const fenceValid = typeof candidate?.fence === 'string'
      && candidate.fence === `${candidate.createdAt}-${candidate.token}`;
    const timesValid = Number.isSafeInteger(candidate?.createdAt)
      && Number.isSafeInteger(candidate?.expiresAt)
      && (candidate?.createdAt ?? 0) > 0
      && (candidate?.createdAt ?? 0) <= Date.now() + 60_000
      && (candidate?.expiresAt ?? 0) >= (candidate?.createdAt ?? 0)
      && (candidate?.expiresAt ?? 0) - (candidate?.createdAt ?? 0) <= LOCK_MAX_LEASE_MS;
    if (!candidate || !exactFields || !tokenValid || !fenceValid || !timesValid
      || !Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) {
      throw new AppError('Historical MCP cleanup lock is malformed.', {
        code: 'MCP_CLEANUP_LOCK_MALFORMED', statusCode: 409,
      });
    }
    return { owner: candidate as CleanupLockOwner, stat: opened };
  } finally {
    await handle.close();
  }
};

const acquireCleanupLock = async (
  opened: PinnedLockParent,
  relativePath: string,
  options?: {
    waitLimitMs?: number;
    testLockHook?: (phase: LegacyLockTestPhase, lockPath: string) => void | Promise<void>;
    testPublishFault?: LegacyLockPublishFault;
    testBeforePublish?: () => void | Promise<void>;
  },
): Promise<{ owner: CleanupLockOwner; lockName: string }> => {
  const lockName = legacyCleanupLockName(relativePath);
  const lockPath = descriptorChild(opened.parentHandle, lockName);
  const deadline = Date.now() + (options?.waitLimitMs ?? LOCK_WAIT_LIMIT_MS);

  const waitForExistingOwner = async (): Promise<void> => {
    // Accept both stable lock states in one identity-checked read. A publisher
    // or releaser may legitimately collapse nlink 2 -> 1 between syscalls.
    const interrupted = await readLockOwner(opened.parentHandle, lockName, [1, 2]);
    if (interrupted.stat.nlink === 2) {
      const transitionMoved = async (): Promise<boolean> => {
        try {
          const latest = await readLockOwner(opened.parentHandle, lockName, [1, 2]);
          return latest.stat.nlink === 1
            || !sameIdentity(interrupted.stat, latest.stat)
            || latest.owner.token !== interrupted.owner.token
            || latest.owner.fence !== interrupted.owner.fence;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
          throw error;
        }
      };
      const siblingNames = [
        `${lockName}.publish-${interrupted.owner.token}`,
        `${lockName}.quarantine-${interrupted.owner.token}`,
      ];
      const matchingSiblings: string[] = [];
      for (const siblingName of siblingNames) {
        try {
          const siblingStat = await lstat(descriptorChild(opened.parentHandle, siblingName));
          if (siblingStat.isSymbolicLink() || siblingStat.nlink !== 2
            || !sameIdentity(interrupted.stat, siblingStat)) {
            if (await transitionMoved()) return;
            throw unsafePath('Two-link MCP cleanup lock sibling is unsafe.');
          }
          matchingSiblings.push(siblingName);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (await transitionMoved()) return;
        }
      }
      if (matchingSiblings.length !== 1) {
        if (await transitionMoved()) return;
        throw unsafePath('Two-link MCP cleanup lock has no unique matching sibling.');
      }
      const siblingName = matchingSiblings[0]!;
      let siblingOwner: Awaited<ReturnType<typeof readLockOwner>>;
      try {
        siblingOwner = await readLockOwner(opened.parentHandle, siblingName, [1, 2]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && await transitionMoved()) return;
        throw error;
      }
      if (siblingOwner.stat.nlink !== 2) {
        if (await transitionMoved()) return;
        throw unsafePath('Two-link MCP cleanup sibling link count is unsafe.');
      }
      if (siblingOwner.owner.token !== interrupted.owner.token
        || siblingOwner.owner.fence !== interrupted.owner.fence) {
        if (await transitionMoved()) return;
        throw unsafePath('Two-link MCP cleanup sibling owner does not match canonical lock.');
      }
      if (!processIsAlive(interrupted.owner.pid)) {
        // Collapse only the recognized sibling. The canonical inode remains at
        // nlink=1 and is recovered by the normal owner-bound CAS on the next loop.
        await rm(descriptorChild(opened.parentHandle, siblingName));
        await opened.parentHandle.sync();
        return;
      }
      if (Date.now() >= deadline) {
        throw new AppError('Timed out waiting for interrupted historical MCP lock transition.', {
          code: 'MCP_CLEANUP_LOCK_TIMEOUT', statusCode: 503,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      return;
    }
    if (!processIsAlive(interrupted.owner.pid)) {
      await quarantineOwnedLock(
        opened,
        { owner: interrupted.owner, lockName, stat: interrupted.stat },
        'recovery-before-quarantine',
        options?.testLockHook,
      );
      return;
    }
    if (Date.now() >= deadline) {
      throw new AppError('Timed out waiting for historical MCP cleanup lock.', {
        code: 'MCP_CLEANUP_LOCK_TIMEOUT', statusCode: 503,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
  };

  while (true) {
    // The canonical name is the cheap contention signal. Do not create, write,
    // or fsync a publication inode while another valid owner is still live.
    try {
      await lstat(lockPath);
      await waitForExistingOwner();
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const token = randomUUID();
    const now = Date.now();
    const owner: CleanupLockOwner = {
      token,
      fence: `${now}-${token}`,
      pid: process.pid,
      createdAt: now,
      expiresAt: now + LOCK_TTL_MS,
    };
    const publishName = `${lockName}.publish-${token}`;
    const publishPath = descriptorChild(opened.parentHandle, publishName);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let published = false;
    try {
      await options?.testBeforePublish?.();
      handle = await open(
        publishPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      if (options?.testPublishFault === 'chmod') throw new Error('injected lock chmod failure');
      await handle.chmod(0o600);
      const lockStat = await handle.stat();
      if (!lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o777) !== 0o600) {
        throw new AppError('Historical MCP cleanup lock mode could not be secured.', {
          code: 'MCP_CLEANUP_LOCK_INSECURE_MODE', statusCode: 500,
        });
      }
      if (options?.testPublishFault === 'write') throw new Error('injected lock write failure');
      await writeAll(handle, Buffer.from(JSON.stringify(owner)));
      if (options?.testPublishFault === 'fsync') throw new Error('injected lock fsync failure');
      await handle.sync();
      await link(publishPath, lockPath);
      published = true;
      await rm(publishPath);
      if (options?.testPublishFault === 'dir-fsync') throw new Error('injected lock dir fsync failure');
      await opened.parentHandle.sync();
      return { owner, lockName };
    } catch (error) {
      if (published) {
        try {
          const current = await readLockOwner(opened.parentHandle, lockName);
          if (current.owner.token === owner.token && current.owner.fence === owner.fence) {
            await quarantineOwnedLock(
              opened,
              { owner, lockName, stat: current.stat },
              'release-before-quarantine',
            );
          }
        } catch {
          // Preserve the publication failure; the owner-bound CAS above is the
          // only cleanup allowed and deliberately refuses a changed successor.
        }
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A competing publisher won after our ENOENT preflight. Discard this one
      // and let the next loop inspect/wait on the canonical owner cheaply.
      continue;
    } finally {
      await handle?.close().catch(() => {});
      await rm(publishPath, { force: true }).catch(() => {});
    }
  }
};

const quarantineOwnedLock = async (
  opened: PinnedLockParent,
  expected: { owner: CleanupLockOwner; lockName: string; stat?: Stats },
  phase: LegacyLockTestPhase,
  testLockHook?: (phase: LegacyLockTestPhase, lockPath: string) => void | Promise<void>,
): Promise<void> => {
  const lockPath = descriptorChild(opened.parentHandle, expected.lockName);
  await testLockHook?.(phase, lockPath);
  const quarantineName = `${expected.lockName}.quarantine-${expected.owner.token}`;
  const quarantinePath = descriptorChild(opened.parentHandle, quarantineName);
  await link(lockPath, quarantinePath);
  try {
    const afterLinkPhase = phase === 'recovery-before-quarantine'
      ? 'recovery-after-quarantine-link'
      : 'release-after-quarantine-link';
    await testLockHook?.(afterLinkPhase, lockPath);
    const [canonicalStat, quarantineStat] = await Promise.all([
      lstat(lockPath),
      lstat(quarantinePath),
    ]);
    if (canonicalStat.isSymbolicLink() || quarantineStat.isSymbolicLink()
      || canonicalStat.nlink !== 2 || quarantineStat.nlink !== 2
      || !sameIdentity(canonicalStat, quarantineStat)
      || (expected.stat && !sameIdentity(expected.stat, quarantineStat))) {
      throw new AppError('Historical MCP cleanup lock changed before quarantine.', {
        code: 'MCP_CLEANUP_LOCK_CHANGED', statusCode: 409,
      });
    }
    const [canonical, quarantined] = await Promise.all([
      readLockOwner(opened.parentHandle, expected.lockName, [2]),
      readLockOwner(opened.parentHandle, quarantineName, [2]),
    ]);
    if (canonical.owner.token !== expected.owner.token
      || canonical.owner.fence !== expected.owner.fence
      || quarantined.owner.token !== expected.owner.token
      || quarantined.owner.fence !== expected.owner.fence) {
      throw new AppError('Historical MCP cleanup lock owner changed before CAS unlink.', {
        code: 'MCP_CLEANUP_LOCK_CHANGED', statusCode: 409,
      });
    }
    await rm(lockPath);
    await rm(quarantinePath);
    await opened.parentHandle.sync();
  } finally {
    await rm(quarantinePath, { force: true }).catch(() => {});
  }
};

const assertLockOwner = async (
  opened: PinnedLockParent,
  lock: { owner: CleanupLockOwner; lockName: string },
): Promise<void> => {
  const current = await readLockOwner(opened.parentHandle, lock.lockName);
  if (current.owner.token !== lock.owner.token || current.owner.fence !== lock.owner.fence) {
    throw new AppError('Historical MCP cleanup lock fencing token was lost.', {
      code: 'MCP_CLEANUP_LOCK_LOST', statusCode: 409,
    });
  }
};

const releaseCleanupLock = async (
  opened: PinnedLockParent,
  lock: { owner: CleanupLockOwner; lockName: string },
  testLockHook?: (phase: LegacyLockTestPhase, lockPath: string) => void | Promise<void>,
): Promise<void> => {
  const current = await readLockOwner(opened.parentHandle, lock.lockName);
  if (current.owner.token !== lock.owner.token || current.owner.fence !== lock.owner.fence) {
    throw new AppError('Historical MCP cleanup lock fencing token was lost.', {
      code: 'MCP_CLEANUP_LOCK_LOST', statusCode: 409,
    });
  }
  await quarantineOwnedLock(
    opened,
    { ...lock, stat: current.stat },
    'release-before-quarantine',
    testLockHook,
  );
};

const parseConfig = (content: string, format: LegacyMcpConfigFormat): Record<string, unknown> => {
  const parsed = format === 'json' ? JSON.parse(content) : TOML.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('Historical MCP config root is not an object.', {
      code: 'MCP_CLEANUP_INVALID_CONFIG', statusCode: 409,
    });
  }
  return parsed as Record<string, unknown>;
};

const serializeConfig = (config: Record<string, unknown>, format: LegacyMcpConfigFormat): Buffer =>
  Buffer.from(format === 'json'
    ? `${JSON.stringify(config, null, 2)}\n`
    : TOML.stringify(config as never));

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  content: Buffer,
): Promise<void> => {
  let offset = 0;
  while (offset < content.length) {
    const result = await handle.write(content, offset, content.length - offset, offset);
    if (result.bytesWritten <= 0) {
      throw new AppError('Historical MCP staged write made no progress.', {
        code: 'MCP_CLEANUP_STAGE_WRITE_FAILED', statusCode: 500,
      });
    }
    offset += result.bytesWritten;
  }
};

const injectFault = (actual: LegacyCleanupFault | undefined, phase: LegacyCleanupFault): void => {
  if (actual === phase) {
    throw new AppError(`Injected historical MCP cleanup fault: ${phase}`, {
      code: 'MCP_CLEANUP_TEST_FAULT', statusCode: 500,
    });
  }
};

const assertPinnedAncestorsUnchanged = async (opened: PinnedLegacyFile): Promise<void> => {
  for (const identity of opened.directoryIdentities) {
    let current;
    try {
      current = await lstat(identity.path);
    } catch {
      throw unsafePath('Historical MCP cleanup ancestor disappeared before promotion.');
    }
    if (current.isSymbolicLink() || !current.isDirectory()
      || !sameIdentity(identity.stat, current)) {
      throw unsafePath('Historical MCP cleanup ancestor changed before promotion.');
    }
  }
};

/** Stages complete bytes beside the pinned original, then atomically promotes them. */
const promoteReplacement = async (
  opened: PinnedLegacyFile,
  content: Buffer,
  testFaultAfter?: LegacyCleanupFault,
  testBeforePromotion?: () => void | Promise<void>,
  assertFence?: () => Promise<void>,
): Promise<void> => {
  const tempName = `.nassaj-mcp-cleanup-${process.pid}-${randomUUID()}`;
  const tempPath = descriptorChild(opened.parentHandle, tempName);
  const finalPath = descriptorChild(opened.parentHandle, opened.finalName);
  let staged: Awaited<ReturnType<typeof open>> | null = null;
  try {
    staged = await open(
      tempPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    await writeAll(staged, content);
    injectFault(testFaultAfter, 'after-stage-write');
    await staged.sync();
    injectFault(testFaultAfter, 'after-stage-fsync');

    const verification = Buffer.alloc(content.length);
    let offset = 0;
    while (offset < verification.length) {
      const result = await staged.read(verification, offset, verification.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== content.length || !verification.equals(content)) {
      throw new AppError('Historical MCP staged bytes failed verification.', {
        code: 'MCP_CLEANUP_STAGE_VERIFY_FAILED', statusCode: 500,
      });
    }

    await testBeforePromotion?.();
    await assertPinnedAncestorsUnchanged(opened);

    const current = await opened.fileHandle.stat();
    const pathState = await lstat(finalPath);
    if (current.nlink !== 1 || pathState.nlink !== 1
      || !sameIdentity(opened.stat, current) || !sameIdentity(opened.stat, pathState)) {
      throw unsafePath('Historical MCP original changed before atomic promotion.');
    }
    if (current.uid !== opened.stat.uid || current.gid !== opened.stat.gid) {
      throw unsafePath('Historical MCP original ownership changed before atomic promotion.');
    }
    const originalMode = opened.stat.mode & 0o777;
    await staged.chown(opened.stat.uid, opened.stat.gid);
    await staged.chmod(originalMode);
    await staged.sync();
    injectFault(testFaultAfter, 'before-promotion');
    await assertFence?.();

    await rename(tempPath, finalPath);
    await opened.parentHandle.sync();
    const promoted = await open(finalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const promotedStat = await promoted.stat();
      const promotedBytes = await promoted.readFile();
      if (promotedStat.nlink !== 1 || promotedStat.uid !== opened.stat.uid
        || promotedStat.gid !== opened.stat.gid || (promotedStat.mode & 0o777) !== originalMode
        || !promotedBytes.equals(content)) {
        throw new AppError('Historical MCP promoted file failed durable read-back.', {
          code: 'MCP_CLEANUP_PROMOTION_VERIFY_FAILED', statusCode: 500,
        });
      }
    } finally {
      await promoted.close();
    }
  } finally {
    await staged?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
};

export async function removeLegacyMcpEntry(
  input: LegacyMcpFile & {
    name: string;
    testFaultAfter?: LegacyCleanupFault;
    testBeforePromotion?: () => void | Promise<void>;
    testAfterParentPinned?: () => void | Promise<void>;
    testLockWaitLimitMs?: number;
    testLockHook?: (phase: LegacyLockTestPhase, lockPath: string) => void | Promise<void>;
    testAfterLockAcquired?: (lockPath: string) => void | Promise<void>;
    testLockPublishFault?: LegacyLockPublishFault;
    testBeforeLockPublish?: () => void | Promise<void>;
  },
): Promise<{ removed: boolean; residueAbsent: boolean }> {
  const parent = await openPinnedLegacyParent(input);
  if (!parent) return { removed: false, residueAbsent: true };
  let lock: Awaited<ReturnType<typeof acquireCleanupLock>> | undefined;
  let opened: PinnedLegacyFile | null = null;
  try {
    await input.testAfterParentPinned?.();
    lock = await acquireCleanupLock(parent, input.relativePath, {
      waitLimitMs: input.testLockWaitLimitMs,
      testLockHook: input.testLockHook,
      testPublishFault: input.testLockPublishFault,
      testBeforePublish: input.testBeforeLockPublish,
    });
    await input.testAfterLockAcquired?.(
      descriptorChild(parent.parentHandle, legacyCleanupLockName(input.relativePath)),
    );
    await assertPinnedWriterAncestorsUnchanged(parent);
    opened = await openLegacyFileInParent(parent);
    if (!opened) return { removed: false, residueAbsent: true };
    const ownedLock = lock;
    const config = parseConfig(opened.content, input.format);
    const rawServers = config[input.mapKey];
    const servers = rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? rawServers as Record<string, unknown>
      : {};
    const removed = Object.prototype.hasOwnProperty.call(servers, input.name);
    if (removed) {
      delete servers[input.name];
      config[input.mapKey] = servers;
      await promoteReplacement(
        opened,
        serializeConfig(config, input.format),
        input.testFaultAfter,
        input.testBeforePromotion,
        () => assertLockOwner(parent, ownedLock),
      );
    }
    await assertLockOwner(opened, lock);
    await reopenPinnedFile(opened);
    const readBack = parseConfig(opened.content, input.format)[input.mapKey];
    const residueAbsent = !(readBack && typeof readBack === 'object' && !Array.isArray(readBack)
      && Object.prototype.hasOwnProperty.call(readBack, input.name));
    return { removed, residueAbsent };
  } finally {
    try {
      if (lock) await releaseCleanupLock(parent, lock, input.testLockHook);
    } finally {
      await opened?.fileHandle.close().catch(() => {});
      await closeHandles(parent.directoryHandles);
    }
  }
}

export async function readLegacyMcpEntries(input: LegacyMcpFile): Promise<Record<string, unknown>> {
  const opened = await openPinnedLegacyFile(input);
  if (!opened) return {};
  try {
    const config = parseConfig(opened.content, input.format);
    const rawServers = config[input.mapKey];
    return rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? rawServers as Record<string, unknown>
      : {};
  } finally {
    await closePinnedFile(opened);
  }
}

/** Shares the historical file's cross-process lock with normal nassaj writers. */
export async function withCanonicalMcpWriterLock<T>(
  filePath: string,
  operation: (transaction: CanonicalMcpWriterTransaction) => Promise<T>,
  options: {
    secureFinalParent?: boolean;
    testAfterDirectoryCreated?: (directoryPath: string) => void | Promise<void>;
    testBeforeEffect?: () => void | Promise<void>;
    testAfterFinalSnapshot?: () => void | Promise<void>;
    testAfterEffect?: () => void | Promise<void>;
    testAfterRelease?: () => void | Promise<void>;
  } = {},
): Promise<T> {
  let opened: PinnedWriterParent | null = null;
  try {
    opened = await openPinnedWriterParent(
      filePath,
      options.secureFinalParent ?? true,
      options.testAfterDirectoryCreated,
    );
    await assertWriterFinalSafe(opened);
  } catch (error) {
    if (opened) await closeHandles(opened.directoryHandles);
    if (error instanceof AppError && error.code === 'MCP_CLEANUP_UNSAFE_PATH') {
      throw new AppError('Refusing MCP writer path with an unsafe directory or file.', {
        code: 'MCP_CONFIG_UNSAFE_DIRECTORY', statusCode: 500,
      });
    }
    throw error;
  }
  let lock;
  let promotedSnapshot: WriterFinalSnapshot | null = null;
  let appliedIdentity: Stats | null = null;
  try {
    lock = await acquireCleanupLock(opened, opened.finalName);
  } catch (error) {
    await closeHandles(opened.directoryHandles);
    throw error;
  }
  try {
    // Recheck after acquiring ownership: another non-participating process may
    // have installed an unsafe final entry while this writer was waiting.
    await assertWriterFinalSafe(opened);
    await assertPinnedWriterAncestorsUnchanged(opened);
    const snapshot = await readWriterFinalSnapshot(opened);
    await options.testAfterFinalSnapshot?.();
    await options.testBeforeEffect?.();
    await assertPinnedWriterAncestorsUnchanged(opened);
    const result = await operation({
      targetPath: descriptorChild(opened.parentHandle, opened.finalName),
      snapshotContent: snapshot.content,
      beforePromotion: async () => {
        await assertPinnedWriterAncestorsUnchanged(opened);
        await assertWriterFinalMatchesSnapshot(opened, snapshot);
      },
      recordPromotion: (stat, content) => {
        if (!stat.isFile() || stat.nlink !== 1) {
          throw unsafePath('MCP writer promoted inode is unsafe.');
        }
        appliedIdentity = stat;
        promotedSnapshot = { stat, content };
      },
    });
    promotedSnapshot ??= appliedIdentity
      ? { content: null, stat: appliedIdentity }
      : await readWriterFinalSnapshot(opened);
    await options.testAfterEffect?.();
    await assertWriterFinalMatchesSnapshot(opened, promotedSnapshot);
    await assertPinnedWriterAncestorsUnchanged(opened);
    return result;
  } finally {
    try {
      await releaseCleanupLock(opened, lock);
      // The final-entry linearization point is the identity/content check above
      // while ownership is held. A succeeding writer may replace it immediately
      // after release and must not turn this completed transaction into failure.
      await options.testAfterRelease?.();
      await assertPinnedWriterAncestorsUnchanged(opened);
    } finally {
      await closeHandles(opened.directoryHandles);
    }
  }
}

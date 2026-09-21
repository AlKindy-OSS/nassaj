/**
 * Cross-process transaction and crash-recovery primitives for the governed
 * OpenCode config.  Both provisioning and the MCP adapter use this module so
 * there is exactly one lock namespace and one migration recovery policy.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from '../../shared/utils.js';

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_CLOCK_SKEW_MS = 5_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameRegularFile = (a, b) => sameEntry(a, b) && a.nlink === 1 && b.nlink === 1;

const unsafe = (message, code = 'MCP_CONFIG_UNSAFE_FILE') =>
  new AppError(message, { code, statusCode: 409 });

/** Proves every existing ancestor is a real directory before creating anything. */
export function ensurePrivateRealDirectory(dirPath) {
  const absolute = path.resolve(dirPath);
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  let missing = false;

  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (missing) continue;
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw unsafe('OpenCode config path contains an unsafe ancestor.', 'MCP_CONFIG_UNSAFE_DIRECTORY');
      }
      if (fs.realpathSync(cursor) !== cursor) {
        throw unsafe('OpenCode config path escapes through an ancestor.', 'MCP_CONFIG_UNSAFE_DIRECTORY');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing = true;
    }
  }

  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(cursor) !== cursor) {
      throw unsafe('OpenCode config path is not a contained real directory.', 'MCP_CONFIG_UNSAFE_DIRECTORY');
    }
  }
  fs.chmodSync(absolute, 0o700);
}

/** Reads a single-link regular file without following a final symlink. */
export function secureReadOpenCodeText(filePath) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw unsafe('Unsafe OpenCode config file.');
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameRegularFile(before, opened)) {
      throw unsafe('OpenCode config identity changed.');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Neutralizes secret-bearing legacy bytes durably before unlinking the name. */
export function secureNeutralizeOpenCodeFile(filePath, afterNeutralize) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw unsafe('Unsafe OpenCode migration file.', 'MCP_CONFIG_UNSAFE_LEGACY_FILE');
  }
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!sameRegularFile(before, fs.fstatSync(fd))) {
      throw unsafe('OpenCode migration identity changed.', 'MCP_CONFIG_UNSAFE_LEGACY_FILE');
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, '{}\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  afterNeutralize?.();
  const after = fs.lstatSync(filePath);
  if (!sameRegularFile(before, after)) {
    throw unsafe('OpenCode migration identity changed before unlink.', 'MCP_CONFIG_UNSAFE_LEGACY_FILE');
  }
  fs.unlinkSync(filePath);
  const dirFd = fs.openSync(
    path.dirname(filePath),
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

/** Restores one interrupted JSONC migration, and rejects ambiguous states. */
export function recoverOpenCodeConfigMigration(filePath) {
  const dir = path.dirname(filePath);
  try {
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw unsafe('Unsafe OpenCode config directory.', 'MCP_CONFIG_UNSAFE_DIRECTORY');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const jsoncPath = `${filePath}c`;
  const orphans = fs.readdirSync(dir).filter((name) => name.startsWith('opencode.jsonc.migrating-'));
  if (orphans.length > 1 || (orphans.length === 1 && fs.existsSync(jsoncPath))) {
    throw new AppError('Ambiguous OpenCode migration recovery state.', {
      code: 'MCP_CONFIG_MIGRATION_AMBIGUOUS', statusCode: 409,
    });
  }
  if (orphans.length === 0) return;
  const orphan = path.join(dir, orphans[0]);
  if (fs.existsSync(filePath)) secureNeutralizeOpenCodeFile(orphan);
  else fs.renameSync(orphan, jsoncPath);
}

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

const validOwner = (value) => {
  const now = Date.now();
  return value
    && typeof value === 'object'
    && typeof value.token === 'string'
    && value.token.length >= 16
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && Number.isFinite(value.createdAt)
    && value.createdAt > 0
    && value.createdAt <= now + LOCK_CLOCK_SKEW_MS;
};

const readOwner = (lockDir) => {
  try {
    const parsed = JSON.parse(secureReadOpenCodeText(path.join(lockDir, 'owner.json')));
    return validOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const quarantineAndRemove = (lockDir, expectedStat, suffix) => {
  const quarantine = `${lockDir}.${suffix}-${crypto.randomUUID()}`;
  try {
    const current = fs.lstatSync(lockDir);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameEntry(current, expectedStat)) return false;
    fs.renameSync(lockDir, quarantine);
    const quarantined = fs.lstatSync(quarantine);
    if (!sameEntry(quarantined, expectedStat)) return false;
    fs.rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

const recoverStaleLock = (lockDir) => {
  let lockStat;
  try {
    lockStat = fs.lstatSync(lockDir);
  } catch {
    return false;
  }
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw unsafe('Unsafe OpenCode lock entry.', 'MCP_CONFIG_UNSAFE_LOCK');
  }
  const owner = readOwner(lockDir);
  const age = owner ? Date.now() - owner.createdAt : Date.now() - lockStat.mtimeMs;
  if (age < LOCK_STALE_MS || (owner && processIsAlive(owner.pid))) return false;
  return quarantineAndRemove(lockDir, lockStat, `stale-${owner?.token ?? 'ownerless'}`);
};

const acquireLock = (filePath, options = {}) => {
  ensurePrivateRealDirectory(path.dirname(filePath));
  const lockDir = `${filePath}.nassaj-lock`;
  const owner = { token: crypto.randomUUID(), pid: process.pid, createdAt: Date.now() };
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;

  for (;;) {
    let lockStat;
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      lockStat = fs.lstatSync(lockDir);
      try {
        options.afterMkdir?.();
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        quarantineAndRemove(lockDir, lockStat, `failed-${owner.token}`);
        throw error;
      }
      return { lockDir, lockStat, owner };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (recoverStaleLock(lockDir)) continue;
      if (waitMs === 0 || Date.now() >= deadline) {
        throw new AppError('OpenCode MCP config is busy.', {
          code: 'MCP_CONFIG_LOCKED', statusCode: 409,
        });
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, 25);
    }
  }
};

const releaseLock = ({ lockDir, lockStat, owner }) => {
  const currentOwner = readOwner(lockDir);
  if (currentOwner?.token !== owner.token) return;
  quarantineAndRemove(lockDir, lockStat, `released-${owner.token}`);
};

/** Holds the filesystem lock across an asynchronous transaction. */
export async function withOpenCodeConfigLock(filePath, operation, options) {
  const lock = acquireLock(filePath, options);
  try {
    return await operation();
  } finally {
    releaseLock(lock);
  }
}

/** Holds the same filesystem lock for synchronous provisioning writers. */
export function withOpenCodeConfigLockSync(filePath, operation, options) {
  // A synchronous provisioner must never wait on an asynchronous owner in the
  // same process: blocking here would also block the timer/promise that releases
  // that owner. Provisioning therefore performs one fenced try-lock and returns
  // MCP_CONFIG_LOCKED immediately; its caller already treats `false` as a safe
  // deferred repair and retries on the next provision/spawn pass.
  const lock = acquireLock(filePath, { ...options, waitMs: 0 });
  try {
    return operation();
  } finally {
    releaseLock(lock);
  }
}

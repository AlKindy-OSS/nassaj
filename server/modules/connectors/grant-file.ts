/**
 * Crash-safe storage and refresh serialization for per-user OAuth grants.
 *
 * The lock is a directory beside the grant (never tmpfs). mkdir is the atomic
 * ownership primitive across processes. A crashed owner is recovered only when
 * its PID is gone; a live but slow refresh is never stolen merely because a TTL
 * elapsed. The attempt journal makes the one irreducibly ambiguous window
 * explicit: if the provider may have consumed a rotating refresh token but no
 * newer generation reached disk, the next caller requires relinking instead of
 * gambling with the old token.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 15 * 1000;
const RETRY_MS = 25;
const REQUEST_DRAIN_MS = 2_000;
const REQUEST_LEASE_STALE_MS = 2 * 60 * 1000;

export type StoredGrant = {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  token_url: string;
  scope?: unknown;
  generation?: number;
  last_refresh_id?: string;
  client_id?: string;
  client_secret?: string;
  token_auth_method?: 'none' | 'client_secret_basic' | 'client_secret_post';
};

/** Durable local withdrawal marker. Presence forbids every new refresh/request. */
export function grantRevocationTombstone(file: string): string {
  return `${file}.revocation-pending.json`;
}

function grantRevocationIntent(file: string): string {
  return `${file}.revocation-intent.json`;
}

function requestLeaseDirectory(file: string): string {
  return `${file}.request-leases`;
}

/** Refuses every symlinked/non-directory ancestor before recursive mkdir mutates disk. */
function ensurePrivateRealDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  let missing = false;

  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (missing) continue;
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) {
      missing = true;
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(cursor) !== cursor) {
      throw new Error('مسار تنسيق OAuth يحتوي رابطاً أو سلفاً غير آمن.');
    }
  }

  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(cursor) !== cursor) {
      throw new Error('مسار تنسيق OAuth خرج من الدليل الحقيقي المعتمد.');
    }
  }
  const finalStat = fs.lstatSync(absolute);
  if (typeof process.getuid === 'function' && finalStat.uid !== process.getuid()) {
    throw new Error('مسار تنسيق OAuth ليس مملوكاً للعملية الحالية.');
  }
  fs.chmodSync(absolute, 0o700);
}

function secureMarkerExists(marker: string): boolean {
  const before = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!before) return false;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('مسار حالة إبطال OAuth غير آمن.');
  }
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('تغيّر مسار حالة إبطال OAuth أثناء التحقق.');
    }
    return true;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function isGrantRevocationPending(file: string): boolean {
  return secureMarkerExists(grantRevocationTombstone(file))
    || secureMarkerExists(grantRevocationIntent(file));
}

export class GrantRevocationPendingError extends Error {
  constructor() {
    super('تم طلب إبطال هذا الموصل؛ أُوقفت الطلبات الجديدة وتنتظر المنحة الإبطال لدى المزوّد.');
    this.name = 'GrantRevocationPendingError';
  }
}

export function assertGrantActive(file: string): void {
  if (isGrantRevocationPending(file)) {
    throw new GrantRevocationPendingError();
  }
}

type RequestLeaseRecord = { pid: number; createdAt: number };

function ensurePrivateDirectory(directory: string): void {
  ensurePrivateRealDirectory(directory);
}

function sweepDeadRequestLeases(file: string): number {
  const directory = requestLeaseDirectory(file);
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return 0;
  ensurePrivateDirectory(directory);
  for (const name of fs.readdirSync(directory)) {
    const lease = path.join(directory, name);
    try {
      const record = readJson<RequestLeaseRecord>(lease);
      if (!processExists(record.pid) && Date.now() - record.createdAt > REQUEST_LEASE_STALE_MS) {
        fs.rmSync(lease, { force: true });
      }
    } catch {
      // An unreadable entry is never silently removed while it might represent
      // a live request; bounded drain reports cleanupRequired instead.
    }
  }
  return fs.readdirSync(directory).length;
}

export type GrantRequestLease = { release(): void };

/**
 * Final launch gate for one remote request. No token exchange, refresh, or API
 * fetch may begin before this reservation succeeds; revocation intent and the
 * final tombstone both block the reservation under the same grant lock.
 */
export async function acquireGrantRequestLease(file: string): Promise<GrantRequestLease> {
  const id = `${process.pid}.${crypto.randomUUID()}.json`;
  const lease = path.join(requestLeaseDirectory(file), id);
  await withGrantLock(file, () => {
    assertGrantActive(file);
    ensurePrivateDirectory(requestLeaseDirectory(file));
    sweepDeadRequestLeases(file);
    atomicWritePrivateJson(lease, { pid: process.pid, createdAt: Date.now() });
  });
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      fs.rmSync(lease, { force: true });
    },
  };
}

/** Runs a remote request immediately behind the final launch gate. */
export async function withGrantRequestLease<T>(
  file: string,
  request: () => Promise<T>,
): Promise<T> {
  const lease = await acquireGrantRequestLease(file);
  try {
    return await request();
  } finally {
    lease.release();
  }
}

/**
 * Persists intent and the final tombstone under the grant lock, then waits a
 * bounded time for existing request leases. New leases are blocked before the
 * first marker write and DELETE cannot claim revocationPending until both
 * durable writes have succeeded.
 */
export async function markGrantRevocationPending(
  file: string,
  options: { drainMs?: number; lockWaitMs?: number } = {},
): Promise<{ drained: boolean }> {
  await withGrantLock(file, () => {
    if (!secureMarkerExists(grantRevocationIntent(file))) {
      atomicWritePrivateJson(grantRevocationIntent(file), { version: 1, requestedAt: Date.now() });
    }
    // Persist the user-visible revocation marker in the same first lock. DELETE
    // may return 202 only after this write succeeds for every target. Draining
    // existing leases is separate: the marker blocks all future launch gates.
    if (!secureMarkerExists(grantRevocationTombstone(file))) {
      atomicWritePrivateJson(grantRevocationTombstone(file), {
        version: 1,
        requestedAt: Date.now(),
      });
    }
  }, { waitMs: options.lockWaitMs });
  const deadline = Date.now() + (options.drainMs ?? REQUEST_DRAIN_MS);
  for (;;) {
    const remaining = await withGrantLock(
      file,
      () => sweepDeadRequestLeases(file),
      { waitMs: options.lockWaitMs },
    );
    if (remaining === 0) {
      return { drained: true };
    }
    if (Date.now() >= deadline) return { drained: false };
    await sleep(RETRY_MS);
  }
}

type LockOwner = { token: string; pid: number; createdAt: number };
type RefreshAttempt = { id: string; fromGeneration: number; createdAt: number };

const inProcessRefreshes = new Map<string, Promise<StoredGrant>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** Repairs permissions inherited from pre-B-750 files and directories. */
export function repairGrantPermissions(file: string): void {
  const dir = path.dirname(file);
  ensurePrivateRealDirectory(dir);
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (before) {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error('ملف منحة OAuth غير آمن.');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
        throw new Error('تغيّر ملف منحة OAuth أثناء التحقق.');
      }
      fs.fchmodSync(descriptor, 0o600);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

/** Writes JSON on the same filesystem, fsyncs it, and atomically promotes it. */
export function atomicWritePrivateJson(file: string, value: unknown): void {
  repairGrantPermissions(file);
  const dir = path.dirname(file);
  const staged = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(staged, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(staged, file);
    fs.chmodSync(file, 0o600);
    const directoryDescriptor = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(staged, { force: true });
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function recoverDeadLock(lockDir: string): boolean {
  let owner: LockOwner | null = null;
  try {
    owner = readJson<LockOwner>(path.join(lockDir, 'owner.json'));
  } catch {
    // An owner can be between mkdir and owner.json. Only recover that incomplete
    // lock after its directory itself has exceeded the TTL.
  }

  let age = 0;
  try {
    age = Date.now() - (owner?.createdAt ?? fs.statSync(lockDir).mtimeMs);
  } catch {
    return true;
  }
  if (age <= LOCK_TTL_MS) return false;
  if (owner && processExists(owner.pid)) return false;

  const tombstone = `${lockDir}.stale.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDir, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  fs.rmSync(tombstone, { recursive: true, force: true });
  return true;
}

/** Serializes all mutations of one grant across every nassaj process. */
export async function withGrantLock<T>(
  file: string,
  operation: () => Promise<T> | T,
  options: { waitMs?: number } = {},
): Promise<T> {
  repairGrantPermissions(file);
  const lockDir = `${file}.lock`;
  const owner: LockOwner = { token: crypto.randomUUID(), pid: process.pid, createdAt: Date.now() };
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);

  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        atomicWritePrivateJson(path.join(lockDir, 'owner.json'), owner);
      } catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!recoverDeadLock(lockDir) && Date.now() >= deadline) {
        throw new Error('تعذّر قفل منحة OAuth بأمان؛ حاول مجدداً بعد لحظات.');
      }
      await sleep(RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const current = readJson<LockOwner>(path.join(lockDir, 'owner.json'));
      if (current.token === owner.token) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // A missing owner means the lock was already removed; never remove an
      // unverified path that might now belong to a successor.
    }
  }
}

/** Error whose `ambiguous` bit says whether the provider may have consumed the token. */
export class GrantRefreshError extends Error {
  constructor(message: string, readonly ambiguous: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GrantRefreshError';
  }
}

function ambiguousMessage(): string {
  return 'تعذّر تأكيد نتيجة تجديد الربط؛ أعد الربط لحماية الحساب من إعادة استخدام رمز قد يكون استُهلك.';
}

/**
 * Single-flights a refresh in-process and locks it cross-process.
 * `needsRefresh` is checked again only after the disk lock is held.
 */
export function refreshGrantSingleFlight(input: {
  file: string;
  needsRefresh: (grant: StoredGrant) => boolean;
  refresh: (grant: StoredGrant) => Promise<Omit<StoredGrant, 'generation' | 'last_refresh_id'>>;
}): Promise<StoredGrant> {
  const key = path.resolve(input.file);
  const existing = inProcessRefreshes.get(key);
  if (existing) return existing;

  const promise = withGrantLock(key, async () => {
    assertGrantActive(key);
    repairGrantPermissions(key);
    const grant = readJson<StoredGrant>(key);
    if (!input.needsRefresh(grant)) return grant;

    const journalFile = `${key}.refreshing.json`;
    if (fs.existsSync(journalFile)) {
      const attempt = readJson<RefreshAttempt>(journalFile);
      if (grant.last_refresh_id === attempt.id) {
        fs.rmSync(journalFile, { force: true });
      } else {
        throw new GrantRefreshError(ambiguousMessage(), true);
      }
    }

    const fromGeneration = Number.isSafeInteger(grant.generation) ? grant.generation! : 0;
    const attempt: RefreshAttempt = {
      id: crypto.randomUUID(),
      fromGeneration,
      createdAt: Date.now(),
    };
    atomicWritePrivateJson(journalFile, attempt);

    let refreshed: Omit<StoredGrant, 'generation' | 'last_refresh_id'>;
    try {
      refreshed = await input.refresh(grant);
    } catch (error) {
      if (error instanceof GrantRefreshError && !error.ambiguous) {
        fs.rmSync(journalFile, { force: true });
      }
      if (error instanceof GrantRefreshError) throw error;
      throw new GrantRefreshError(ambiguousMessage(), true, { cause: error });
    }

    const next: StoredGrant = {
      ...refreshed,
      generation: fromGeneration + 1,
      last_refresh_id: attempt.id,
    };
    atomicWritePrivateJson(key, next);
    fs.rmSync(journalFile, { force: true });
    return next;
  }).finally(() => {
    if (inProcessRefreshes.get(key) === promise) inProcessRefreshes.delete(key);
  });

  inProcessRefreshes.set(key, promise);
  return promise;
}

import crypto from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createEngineRestampIntentRepository,
  engineRestampIntentKey,
  engineRestampIntentsDb,
  getConnection,
  type EngineRestampIntent,
} from '@/modules/database/index.js';

import {
  isEngineRestampReservationCurrent,
  isEngineRestampReserved,
  isEngineRestampRecoveryClaimCurrent,
  isEngineRestampRecoveryReservationBound,
  type EngineRestampRecoveryReservation,
  type RestampReservation,
} from './engine-switch-liveness.service.js';

const TARGET_NAME = 'provider-session-active-model-changes.json';
const LOCK_NAME = '.provider-session-active-model-changes.lock';
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_STORE_ENTRIES = 50_000;
const MAX_WAITERS = 128;
const FIFO_TIMEOUT_MS = 2_000;
const FLOCK_TIMEOUT_MS = 1_000;
const COMBINED_TIMEOUT_MS = 3_000;
const ALLOWED_PROVIDERS = new Set(['claude','codex','cursor','antigravity','opencode','kimi','deepseek','glm','hermes','qwen','sakana']);
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const LOCK_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
const TARGET_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const TEMP_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

export type EngineRestampModelStoreEntry = Readonly<{
  provider: string; sessionId: string; supported: boolean; changed: boolean;
  model: string | null; updatedAt: string;
}>;
export type EngineRestampModelStoreDocument = Readonly<{
  version: 1; entries: Readonly<Record<string, EngineRestampModelStoreEntry>>;
}>;
export type EngineRestampModelStoreMutation = Readonly<{
  provider: string; sessionId: string; entry: EngineRestampModelStoreEntry | null;
}>;
type FlockSpawner = typeof spawn;
export type EngineRestampModelStoreTestDeps = Readonly<{
  home: () => string; spawnFlock?: FlockSpawner; now: () => number;
  afterTempFsync?: (tempPath: string) => void;
}>;
type StoreDeps = EngineRestampModelStoreTestDeps;
type FifoLease = Readonly<{ identity: object; release: () => void }>;
type LeaseState = { active: boolean };
type LockLease = Readonly<{
  directoryFd: number; lockFd: number; directoryStat: fs.BigIntStats; lockStat: fs.BigIntStats;
  fifo: FifoLease; state: LeaseState; release: () => void;
}>;

declare const engineRestampStoreOwnerBrand: unique symbol;
export type EngineRestampStoreOwner = Readonly<{ readonly [engineRestampStoreOwnerBrand]: true }>;

export class EngineRestampStoreError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options); this.name = 'EngineRestampStoreError';
  }
}

const fail = (code: string, cause?: unknown): never => {
  throw new EngineRestampStoreError(code, cause === undefined ? undefined : { cause });
};
const procPath = (fd: number, name?: string): string =>
  name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;
const currentUid = (): bigint => BigInt(process.getuid?.() ?? -1);
const fstatBig = (fd: number): fs.BigIntStats => fs.fstatSync(fd, { bigint: true });
const sameInode = (left: fs.BigIntStats, right: fs.BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const cleanupFailure = (primary: unknown, errors: unknown[], message: string): never => {
  if (errors.length === 0) throw primary;
  if (primary !== undefined) throw new AggregateError([primary, ...errors], message, { cause: primary });
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message, { cause: errors[0] });
};
const closeFd = (fd: number | undefined, expected?: fs.BigIntStats): unknown | undefined => {
  if (fd === undefined) return undefined;
  try { fs.closeSync(fd); return undefined; }
  catch (first) {
    if (!expected) return first;
    let current: fs.BigIntStats;
    try { current = fstatBig(fd); } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === 'EBADF') {
        return new EngineRestampStoreError('ENGINE_MODEL_FD_CLOSE_UNCERTAIN', { cause: first });
      }
      return new AggregateError([first, probeError], 'ENGINE_MODEL_FD_CLOSE_UNCERTAIN', { cause: first });
    }
    if (!sameInode(current, expected)) return new AggregateError([first], 'ENGINE_MODEL_FD_REUSED', { cause: first });
    try {
      fs.closeSync(fd);
      return new EngineRestampStoreError('ENGINE_MODEL_FD_CLOSE_RETRIED', { cause: first });
    }
    catch (second) { return new AggregateError([first, second], 'ENGINE_MODEL_FD_CLOSE_FAILED', { cause: first }); }
  }
};
const digest = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

class BoundedFifo {
  private active = false;
  private readonly waiters: Array<{
    identity: object; resolve: (lease: FifoLease) => void; reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  acquire(): Promise<FifoLease> {
    const identity = Object.freeze({});
    if (!this.active) { this.active = true; return Promise.resolve(this.lease(identity)); }
    if (this.waiters.length >= MAX_WAITERS) return Promise.reject(new EngineRestampStoreError('ENGINE_MODEL_QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const waiter = { identity, resolve, reject, timer: undefined as unknown as NodeJS.Timeout };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new EngineRestampStoreError('ENGINE_MODEL_QUEUE_TIMEOUT'));
      }, FIFO_TIMEOUT_MS);
      this.waiters.push(waiter);
    });
  }

  private lease(identity: object): FifoLease {
    let released = false;
    return Object.freeze({ identity, release: () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (!next) { this.active = false; return; }
      clearTimeout(next.timer);
      next.resolve(this.lease(next.identity));
    } });
  }
}

const fifo = new BoundedFifo();
const TEST_DEPS_KEY = Symbol.for('nassaj.engine-restamp-model-store.test-deps');
const SERVER_HOME = os.homedir();
const dependencies = (): StoreDeps => {
  const injected = (globalThis as Record<PropertyKey, unknown>)[TEST_DEPS_KEY];
  return (injected as StoreDeps | undefined) ?? { home: () => SERVER_HOME, now: Date.now };
};

function assertDirectory(stat: fs.BigIntStats, mode: bigint): void {
  if (!stat.isDirectory() || stat.uid !== currentUid() || stat.nlink < 2n || (stat.mode & 0o777n) !== mode) {
    fail('ENGINE_MODEL_DIRECTORY_UNTRUSTED');
  }
}

function openStoreDirectory(homeInput: string): { fd: number; stat: fs.BigIntStats } {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) fail('ENGINE_MODEL_PLATFORM_UNSUPPORTED');
  const homeReal = fs.realpathSync(homeInput);
  if (homeReal !== path.resolve(homeInput)) fail('ENGINE_MODEL_HOME_UNTRUSTED');
  const homeFd = fs.openSync(homeReal, DIRECTORY_FLAGS); let homeStat: fs.BigIntStats | undefined;
  let result: { fd: number; stat: fs.BigIntStats } | undefined; let primary: unknown;
  try {
    homeStat = fstatBig(homeFd);
    if (!homeStat.isDirectory() || homeStat.uid !== currentUid() || (homeStat.mode & 0o022n) !== 0n) {
      fail('ENGINE_MODEL_HOME_UNTRUSTED');
    }
    try { fs.mkdirSync(procPath(homeFd, '.cloudcli'), { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const fd = fs.openSync(procPath(homeFd, '.cloudcli'), DIRECTORY_FLAGS); let stat: fs.BigIntStats | undefined;
    try {
      stat = fstatBig(fd);
      const mode = stat.mode & 0o777n;
      if (mode !== 0o700n && mode !== 0o755n) fail('ENGINE_MODEL_DIRECTORY_UNTRUSTED');
      assertDirectory(stat, mode);
      result = { fd, stat };
    } catch (error) {
      const closeError = closeFd(fd, stat); if (closeError) cleanupFailure(error, [closeError], 'ENGINE_MODEL_DIRECTORY_OPEN_CLEANUP_FAILED');
      throw error;
    }
  } catch (error) { primary = error; }
  const homeCloseError = closeFd(homeFd, homeStat);
  if (primary !== undefined || homeCloseError !== undefined) cleanupFailure(primary, homeCloseError ? [homeCloseError] : [], 'ENGINE_MODEL_HOME_CLOSE_FAILED');
  return result!;
}

function assertPrivateFile(stat: fs.BigIntStats, code: string): void {
  if (!stat.isFile() || stat.uid !== currentUid() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n) fail(code);
}

function assertNamedLock(lease: LockLease): void {
  if (!lease.state.active) fail('ENGINE_MODEL_LEASE_INACTIVE');
  let probe: number | undefined; let probeStat: fs.BigIntStats | undefined; let primary: unknown;
  try {
    const directory = fstatBig(lease.directoryFd);
    if (!sameInode(directory, lease.directoryStat)) {
      fail('ENGINE_MODEL_DIRECTORY_REPLACED');
    }
    probe = fs.openSync(procPath(lease.directoryFd, LOCK_NAME), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    probeStat = fstatBig(probe);
    assertPrivateFile(probeStat, 'ENGINE_MODEL_LOCK_UNTRUSTED');
    if (!sameInode(probeStat, lease.lockStat)) fail('ENGINE_MODEL_LOCK_REPLACED');
  } catch (error) {
    primary = error instanceof EngineRestampStoreError
      ? error : new EngineRestampStoreError('ENGINE_MODEL_LOCK_UNCERTAIN', { cause: error });
  }
  const closeError = closeFd(probe, probeStat);
  if (primary !== undefined || closeError !== undefined) cleanupFailure(primary, closeError ? [closeError] : [], 'ENGINE_MODEL_LOCK_PROBE_CLOSE_FAILED');
}

async function runFlock(lockFd: number, testSpawn?: FlockSpawner): Promise<void> {
  let child: ChildProcess;
  try {
    const args = ['-x', '-E', '75', '-w', '1', '3'];
    const options: SpawnOptions = { shell: false, stdio: ['ignore', 'ignore', 'ignore', lockFd],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } };
    child = testSpawn
      ? testSpawn('/usr/bin/flock', args, options)
      : spawn('/usr/bin/flock', args, options);
  } catch (error) { return fail('ENGINE_MODEL_LOCK_UNCERTAIN', error); }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let helperError: EngineRestampStoreError | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.removeListener('error', onError); child.removeListener('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error): void => {
      helperError ??= new EngineRestampStoreError('ENGINE_MODEL_LOCK_UNCERTAIN', { cause: error });
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (helperError) return finish(helperError);
      if (timedOut) return finish(new EngineRestampStoreError('ENGINE_MODEL_LOCK_TIMEOUT'));
      if (signal || code !== 0) finish(new EngineRestampStoreError(code === 75 ? 'ENGINE_MODEL_LOCK_BUSY' : 'ENGINE_MODEL_LOCK_UNCERTAIN'));
      else finish();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FLOCK_TIMEOUT_MS);
    child.once('error', onError); child.once('close', onClose);
  });
}

async function acquireLock(deps: StoreDeps): Promise<LockLease> {
  const startedAt = deps.now();
  const fifoLease = await fifo.acquire();
  let directoryFd: number | undefined; let lockFd: number | undefined;
  let directoryStat: fs.BigIntStats | undefined; let lockStat: fs.BigIntStats | undefined;
  try {
    if (deps.now() - startedAt > COMBINED_TIMEOUT_MS) fail('ENGINE_MODEL_ACQUIRE_TIMEOUT');
    const directory = openStoreDirectory(deps.home()); directoryFd = directory.fd; directoryStat = directory.stat;
    lockFd = fs.openSync(procPath(directoryFd, LOCK_NAME), LOCK_FLAGS, 0o600);
    lockStat = fstatBig(lockFd); assertPrivateFile(lockStat, 'ENGINE_MODEL_LOCK_UNTRUSTED');
    await runFlock(lockFd, deps.spawnFlock);
    if (deps.now() - startedAt > COMBINED_TIMEOUT_MS) fail('ENGINE_MODEL_ACQUIRE_TIMEOUT');
    const state: LeaseState = { active: true };
    const lease: LockLease = Object.freeze({ directoryFd, lockFd, directoryStat, lockStat, state,
      fifo: fifoLease, release: () => {
        if (!state.active) return;
        state.active = false;
        const errors = [closeFd(lockFd, lockStat), closeFd(directoryFd, directoryStat)].filter((error) => error !== undefined);
        if (errors.length > 0) cleanupFailure(undefined, errors, 'ENGINE_MODEL_LEASE_CLOSE_FAILED');
        fifoLease.release();
      } });
    assertNamedLock(lease);
    if (deps.now() - startedAt > COMBINED_TIMEOUT_MS) fail('ENGINE_MODEL_ACQUIRE_TIMEOUT');
    return lease;
  } catch (error) {
    const errors = [closeFd(lockFd, lockStat), closeFd(directoryFd, directoryStat)].filter((item) => item !== undefined);
    if (errors.length === 0) fifoLease.release();
    return cleanupFailure(error, errors, 'ENGINE_MODEL_ACQUIRE_CLEANUP_FAILED');
  }
}

function parseStore(raw: string): EngineRestampModelStoreDocument {
  if (byteLength(raw) > MAX_STORE_BYTES) fail('ENGINE_MODEL_STORE_TOO_LARGE');
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch (error) { return fail('ENGINE_MODEL_STORE_MALFORMED', error); }
  if (!isPlainObject(parsed)) fail('ENGINE_MODEL_STORE_MALFORMED');
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ['version', 'entries']) || record.version !== 1 || !isPlainObject(record.entries)) {
    fail('ENGINE_MODEL_STORE_MALFORMED');
  }
  const pairs = Object.entries(record.entries as Record<string, unknown>);
  if (pairs.length > MAX_STORE_ENTRIES) fail('ENGINE_MODEL_STORE_ENTRY_LIMIT');
  for (const [key, value] of pairs) {
    if (!isPlainObject(value) || !exactKeys(value, ['provider','sessionId','supported','changed','model','updatedAt'])
      || typeof value.provider !== 'string' || typeof value.sessionId !== 'string'
      || typeof value.supported !== 'boolean' || typeof value.changed !== 'boolean'
      || (typeof value.model !== 'string' && value.model !== null) || typeof value.updatedAt !== 'string'
      || !ALLOWED_PROVIDERS.has(value.provider) || value.sessionId.length === 0
      || key !== `${value.provider}:${value.sessionId}` || byteLength(value.sessionId) > 256
      || (typeof value.model === 'string' && (value.model.trim().length === 0 || byteLength(value.model) > 512))
      || (value.changed ? typeof value.model !== 'string' : value.model !== null)
      || (!value.supported && (value.changed || value.model !== null))
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)) fail('ENGINE_MODEL_STORE_MALFORMED');
  }
  const compact = JSON.stringify(record);
  const pretty = `${JSON.stringify(record, null, 2)}\n`;
  if (raw !== compact && raw !== pretty) fail('ENGINE_MODEL_STORE_MALFORMED');
  return parsed as EngineRestampModelStoreDocument;
}

function readBoundedStoreText(fd: number): string {
  const buffer = Buffer.allocUnsafe(MAX_STORE_BYTES + 1);
  let offset = 0;
  while (offset <= MAX_STORE_BYTES) {
    const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); }
      catch (error) { return fail('ENGINE_MODEL_STORE_MALFORMED', error); }
    }
    offset += count;
  }
  return fail('ENGINE_MODEL_STORE_TOO_LARGE');
}

function readStore(lease: LockLease): { document: EngineRestampModelStoreDocument; canonical: string; digest: string; bytes: number } {
  assertNamedLock(lease);
  let fd: number | undefined; let stat: fs.BigIntStats | undefined;
  let result: { document: EngineRestampModelStoreDocument; canonical: string; digest: string; bytes: number } | undefined;
  let primary: unknown;
  try {
    try { fd = fs.openSync(procPath(lease.directoryFd, TARGET_NAME), TARGET_FLAGS); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const canonical = '{"version":1,"entries":{}}';
        return { document: { version: 1, entries: {} }, canonical, digest: digest(canonical), bytes: 0 };
      }
      throw error;
    }
    stat = fstatBig(fd); assertPrivateFile(stat, 'ENGINE_MODEL_TARGET_UNTRUSTED');
    if (stat.size > BigInt(MAX_STORE_BYTES)) fail('ENGINE_MODEL_STORE_TOO_LARGE');
    const raw = readBoundedStoreText(fd);
    result = { document: parseStore(raw), canonical: raw, digest: digest(raw), bytes: byteLength(raw) };
  } catch (error) {
    primary = error instanceof EngineRestampStoreError
      ? error : new EngineRestampStoreError('ENGINE_MODEL_STORE_UNKNOWN', { cause: error });
  }
  const closeError = closeFd(fd, stat);
  if (primary !== undefined || closeError !== undefined) cleanupFailure(primary, closeError ? [closeError] : [], 'ENGINE_MODEL_TARGET_CLOSE_FAILED');
  return result!;
}

function cleanupTemp(lease: LockLease, name: string, owned: fs.BigIntStats): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let probe: number | undefined; let probeStat: fs.BigIntStats | undefined; let primary: unknown;
    try {
      probe = fs.openSync(procPath(lease.directoryFd, name), TARGET_FLAGS);
      probeStat = fstatBig(probe); assertPrivateFile(probeStat, 'ENGINE_MODEL_TEMP_UNTRUSTED');
      if (!sameInode(probeStat, owned)) {
        const mismatchCloseError = closeFd(probe, probeStat); probe = undefined;
        if (mismatchCloseError) throw mismatchCloseError;
        return;
      }
      const closeError = closeFd(probe, probeStat); probe = undefined;
      if (closeError) throw closeError;
      fs.unlinkSync(procPath(lease.directoryFd, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      primary = error;
    }
    const probeCloseError = closeFd(probe, probeStat);
    if (probeCloseError && primary === undefined) primary = probeCloseError;
    else if (probeCloseError) primary = new AggregateError([primary, probeCloseError], 'ENGINE_MODEL_TEMP_PROBE_CLOSE_FAILED', { cause: primary });
    if (primary !== undefined) {
      if (attempt === 1) fail('ENGINE_MODEL_TEMP_CLEANUP_FAILED', primary);
      continue;
    }
    fsyncDirectoryWithRetry(lease.directoryFd);
    return;
  }
}

function fstatTempWithRetry(fd: number): fs.BigIntStats {
  let first: unknown;
  try { return fstatBig(fd); } catch (error) { first = error; }
  try { return fstatBig(fd); }
  catch (error) { throw new AggregateError([first, error], 'ENGINE_MODEL_TEMP_FSTAT_UNCERTAIN', { cause: first }); }
}

function fsyncDirectoryWithRetry(directoryFd: number): void {
  let first: unknown;
  try { fs.fsyncSync(directoryFd); return; } catch (error) { first = error; }
  try { fs.fsyncSync(directoryFd); }
  catch (error) { throw new AggregateError([first, error], 'ENGINE_MODEL_DIRECTORY_FSYNC_FAILED', { cause: first }); }
}

function promoteStore(lease: LockLease, expectedDigest: string, document: EngineRestampModelStoreDocument, deps: StoreDeps): void {
  assertNamedLock(lease);
  if (readStore(lease).digest !== expectedDigest) fail('ENGINE_MODEL_STORE_CAS_MISMATCH');
  const serialized = JSON.stringify(document);
  if (byteLength(serialized) > MAX_STORE_BYTES) fail('ENGINE_MODEL_STORE_TOO_LARGE');
  parseStore(serialized);
  const tempName = `.${TARGET_NAME}.${crypto.randomUUID()}.tmp`;
  let tempFd: number | undefined; let owned: fs.BigIntStats | undefined;
  let tempCreated = false; let promoted = false; let primary: unknown;
  try {
    tempFd = fs.openSync(procPath(lease.directoryFd, tempName), TEMP_FLAGS, 0o600);
    tempCreated = true;
    owned = fstatBig(tempFd); assertPrivateFile(owned, 'ENGINE_MODEL_TEMP_UNTRUSTED');
    fs.writeFileSync(tempFd, serialized, 'utf8'); fs.fsyncSync(tempFd);
    deps.afterTempFsync?.(procPath(lease.directoryFd, tempName));
    let namedFd: number | undefined; let namedStat: fs.BigIntStats | undefined; let namedPrimary: unknown;
    try {
      namedFd = fs.openSync(procPath(lease.directoryFd, tempName), TARGET_FLAGS);
      namedStat = fstatBig(namedFd); assertPrivateFile(namedStat, 'ENGINE_MODEL_TEMP_UNTRUSTED');
      if (!sameInode(namedStat, owned)) fail('ENGINE_MODEL_TEMP_REPLACED');
    } catch (error) { namedPrimary = error; }
    const namedCloseError = closeFd(namedFd, namedStat);
    if (namedPrimary !== undefined || namedCloseError !== undefined) cleanupFailure(namedPrimary, namedCloseError ? [namedCloseError] : [], 'ENGINE_MODEL_TEMP_PROBE_CLOSE_FAILED');
    if (readStore(lease).digest !== expectedDigest) fail('ENGINE_MODEL_STORE_CAS_MISMATCH');
    fs.renameSync(procPath(lease.directoryFd, tempName), procPath(lease.directoryFd, TARGET_NAME));
    promoted = true; fsyncDirectoryWithRetry(lease.directoryFd);
    if (readStore(lease).digest !== digest(serialized)) fail('ENGINE_MODEL_STORE_READBACK_FAILED');
  } catch (error) { primary = error; }
  const cleanupErrors: unknown[] = [];
  if (tempCreated && !owned && tempFd !== undefined) {
    try { owned = fstatTempWithRetry(tempFd); }
    catch (error) { cleanupErrors.push(error); }
  }
  const tempCloseError = closeFd(tempFd, owned);
  if (tempCloseError !== undefined) cleanupErrors.push(tempCloseError);
  if (cleanupErrors.length === 0) {
    try {
      if (!promoted && owned) cleanupTemp(lease, tempName, owned);
      else if (!promoted && tempCreated) fail('ENGINE_MODEL_TEMP_OWNERSHIP_UNCERTAIN');
    } catch (error) { cleanupErrors.push(error); }
  }
  if (primary !== undefined || cleanupErrors.length > 0) {
    cleanupFailure(primary, cleanupErrors, 'ENGINE_MODEL_PROMOTION_AND_CLEANUP_FAILED');
  }
}

export type EngineRestampRecoveryBatchMember = Readonly<{
  intent: EngineRestampIntent;
  canonical: string;
  reservation: EngineRestampRecoveryReservation;
}>;
export type EngineRestampRecoveryBatchResult = Readonly<{
  members: readonly Readonly<{ operationId: string; sessionId: string;
    status: 'already_restored' | 'repaired' | 'ineligible' }>[];
  counters: Readonly<{ contentReadCount: 3; contentBytesRead: number;
    contentBytesWritten: number; promotionCount: 0 | 1 }>;
  settlementAllowed: boolean;
}>;
declare const engineRestampRecoveryBatchOwnerBrand: unique symbol;
type EngineRestampRecoveryBatchOwner = Readonly<{ readonly [engineRestampRecoveryBatchOwnerBrand]: true }>;
type RecoveryBatchOwnerRecord = Readonly<{
  claim: object; db: ReturnType<typeof getConnection>; lease: LockLease;
  members: readonly EngineRestampRecoveryBatchMember[];
}>;
const recoveryBatchOwners = new WeakMap<EngineRestampRecoveryBatchOwner, RecoveryBatchOwnerRecord>();
const RECOVERY_DEADLINE_MS = 5_000;
const RECOVERY_MAX_MEMBERS = 64;
const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const assertRecoveryDeadline = (deadline: number): void => {
  if (monotonicMs() > deadline) fail('ENGINE_MODEL_RECOVERY_DEADLINE');
};

function freezeStoreDocument(document: EngineRestampModelStoreDocument): EngineRestampModelStoreDocument {
  const entries = Object.fromEntries(Object.entries(document.entries)
    .map(([key, value]) => [key, Object.freeze({ ...value })]));
  return Object.freeze({ version: 1 as const, entries: Object.freeze(entries) });
}

function freezeIntent(canonical: string): EngineRestampIntent {
  const intent = JSON.parse(canonical) as EngineRestampIntent;
  for (const value of Object.values(intent)) {
    if (value && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(intent);
}

function assertRecoveryBatchOwner(owner: EngineRestampRecoveryBatchOwner): RecoveryBatchOwnerRecord {
  const record = recoveryBatchOwners.get(owner);
  if (record === undefined) return fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
  if (!record.lease.state.active || !isEngineRestampRecoveryClaimCurrent(record.claim, record.db)) {
    fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
  }
  assertNamedLock(record.lease);
  return record;
}

function assertRecoveryMembersCurrent(record: RecoveryBatchOwnerRecord): void {
  const repository = createEngineRestampIntentRepository(record.db);
  for (const member of record.members) {
    if (!isEngineRestampRecoveryReservationBound(member.reservation, record.claim, record.db,
      member.intent, member.canonical)) fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
    const stored = repository.read(member.intent.sessionId);
    if (stored?.canonical !== member.canonical || stored.intent.operationId !== member.intent.operationId) {
      fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
    }
  }
}

function readRecoveryStore(
  lease: LockLease,
  accounting: { contentReadCount: number; contentBytesRead: number },
): ReturnType<typeof readStore> {
  if (accounting.contentReadCount >= 3) fail('ENGINE_MODEL_RECOVERY_READ_LIMIT');
  accounting.contentReadCount += 1;
  assertNamedLock(lease);
  let fd: number | undefined; let stat: fs.BigIntStats | undefined; let primary: unknown;
  let result: ReturnType<typeof readStore> | undefined;
  try {
    try { fd = fs.openSync(procPath(lease.directoryFd, TARGET_NAME), TARGET_FLAGS); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const canonical = '{"version":1,"entries":{}}';
      return { document: { version: 1, entries: {} }, canonical, digest: digest(canonical), bytes: 0 };
    }
    stat = fstatBig(fd); assertPrivateFile(stat, 'ENGINE_MODEL_TARGET_UNTRUSTED');
    if (stat.size > BigInt(MAX_STORE_BYTES)) fail('ENGINE_MODEL_STORE_TOO_LARGE');
    const buffer = Buffer.allocUnsafe(MAX_STORE_BYTES + 1); let offset = 0;
    while (offset <= MAX_STORE_BYTES) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count; accounting.contentBytesRead += count;
      if (offset > MAX_STORE_BYTES || accounting.contentBytesRead > MAX_STORE_BYTES * 3) {
        fail('ENGINE_MODEL_RECOVERY_READ_LIMIT');
      }
    }
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); }
    catch (error) { return fail('ENGINE_MODEL_STORE_MALFORMED', error); }
    result = { document: parseStore(raw), canonical: raw, digest: digest(raw), bytes: offset };
  } catch (error) {
    primary = error instanceof EngineRestampStoreError
      ? error : new EngineRestampStoreError('ENGINE_MODEL_STORE_UNKNOWN', { cause: error });
  }
  const closeError = closeFd(fd, stat);
  if (primary !== undefined || closeError !== undefined) {
    cleanupFailure(primary, closeError ? [closeError] : [], 'ENGINE_MODEL_RECOVERY_READ_CLOSE_FAILED');
  }
  return result!;
}

function writeRecoveryTemp(
  fd: number,
  serialized: string,
  accounting: { contentBytesWritten: number },
): void {
  const content = Buffer.from(serialized, 'utf8');
  if (content.length > MAX_STORE_BYTES) fail('ENGINE_MODEL_RECOVERY_WRITE_LIMIT');
  let written = 0;
  while (written < content.length) {
    const count = fs.writeSync(fd, content, written, content.length - written, null);
    if (!Number.isSafeInteger(count) || count <= 0) fail('ENGINE_MODEL_RECOVERY_WRITE_UNCERTAIN');
    written += count; accounting.contentBytesWritten += count;
    if (written > MAX_STORE_BYTES || accounting.contentBytesWritten > MAX_STORE_BYTES) {
      fail('ENGINE_MODEL_RECOVERY_WRITE_LIMIT');
    }
  }
}

function assertRecoveryTempNamed(lease: LockLease, name: string, owned: fs.BigIntStats): void {
  let fd: number | undefined; let stat: fs.BigIntStats | undefined; let primary: unknown;
  try {
    fd = fs.openSync(procPath(lease.directoryFd, name), TARGET_FLAGS);
    stat = fstatBig(fd); assertPrivateFile(stat, 'ENGINE_MODEL_TEMP_UNTRUSTED');
    if (!sameInode(stat, owned)) fail('ENGINE_MODEL_TEMP_REPLACED');
  } catch (error) { primary = error; }
  const closeError = closeFd(fd, stat);
  if (primary !== undefined || closeError !== undefined) {
    cleanupFailure(primary, closeError ? [closeError] : [], 'ENGINE_MODEL_TEMP_PROBE_CLOSE_FAILED');
  }
}

function pinMatches(db: ReturnType<typeof getConnection>, intent: EngineRestampIntent): boolean {
  const row = db.prepare(`SELECT engine_provider, engine_provider_source FROM sessions
    WHERE session_id = ?`).get(intent.sessionId) as
    { engine_provider: string | null; engine_provider_source: string | null } | undefined;
  return Boolean(row && row.engine_provider === intent.fromPin.engine
    && row.engine_provider_source === intent.fromPin.source);
}

function sameProjection(
  entry: EngineRestampModelStoreEntry | undefined,
  projection: Readonly<{ changed: boolean; model: string | null }>,
): boolean {
  if (!entry) return projection.changed === false && projection.model === null;
  return entry.changed === projection.changed && entry.model === projection.model;
}

/**
 * Executes the dormant E5 three-read model primitive under one retained FIFO/flock.
 * It never settles durable intents; the synchronous E4 loop is wired in a later reviewed slice.
 */
export async function runEngineRestampRecoveryModelBatch(
  claim: object,
  inputMembers: readonly EngineRestampRecoveryBatchMember[],
): Promise<EngineRestampRecoveryBatchResult> {
  const startedAt = monotonicMs(); const deadline = startedAt + RECOVERY_DEADLINE_MS;
  if (!Array.isArray(inputMembers) || inputMembers.length < 1 || inputMembers.length > RECOVERY_MAX_MEMBERS) {
    fail('ENGINE_MODEL_RECOVERY_BATCH_INVALID');
  }
  const db = getConnection();
  if (!isEngineRestampRecoveryClaimCurrent(claim, db)) fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
  const repository = createEngineRestampIntentRepository(db);
  const captured = inputMembers.map(member => {
    if (!isEngineRestampRecoveryReservationBound(member.reservation, claim, db,
      member.intent, member.canonical)) fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
    const stored = repository.read(member.intent.sessionId);
    if (stored === null) return fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
    if (stored.canonical !== member.canonical
        || stored.intent.operationId !== member.intent.operationId) fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
    return Object.freeze({ intent: freezeIntent(stored.canonical), canonical: stored.canonical,
      reservation: member.reservation });
  });
  const ordered = captured.sort((left, right) =>
    engineRestampIntentKey(left.intent.sessionId).localeCompare(engineRestampIntentKey(right.intent.sessionId)));
  if (new Set(ordered.map(member => member.intent.sessionId)).size !== ordered.length) {
    fail('ENGINE_MODEL_RECOVERY_BATCH_INVALID');
  }
  const members = Object.freeze(ordered.map(member => Object.freeze({ ...member })));
  assertRecoveryDeadline(deadline);
  const deps = dependencies(); const lease = await acquireLock(deps);
  const accounting = { contentReadCount: 0, contentBytesRead: 0 };
  const writeAccounting = { contentBytesWritten: 0 }; let promotionCount: 0 | 1 = 0;
  let primary: unknown; let result: EngineRestampRecoveryBatchResult | undefined;
  try {
    assertRecoveryDeadline(deadline);
    const publicOwner = Object.freeze(Object.create(null)) as EngineRestampRecoveryBatchOwner;
    const ownerRecord = Object.freeze({ claim, db, lease, members }); recoveryBatchOwners.set(publicOwner, ownerRecord);
    assertRecoveryBatchOwner(publicOwner); assertRecoveryMembersCurrent(ownerRecord);
    assertRecoveryDeadline(deadline);
    const snapshotRead = readRecoveryStore(lease, accounting);
    const snapshot = freezeStoreDocument(snapshotRead.document);
    assertRecoveryDeadline(deadline);
    const entries: Record<string, EngineRestampModelStoreEntry> = { ...snapshot.entries };
    const statuses: Array<{ operationId: string; sessionId: string;
      status: 'already_restored' | 'repaired' | 'ineligible' }> = [];
    let repairCount = 0;
    for (const member of members) {
      const key = `claude:${member.intent.sessionId}`; const entry = snapshot.entries[key];
      let status: 'already_restored' | 'repaired' | 'ineligible' = 'ineligible';
      assertRecoveryDeadline(deadline);
      const exactPin = pinMatches(db, member.intent);
      assertRecoveryDeadline(deadline);
      if (exactPin && sameProjection(entry, member.intent.fromModel)) status = 'already_restored';
      else if (exactPin && sameProjection(entry, member.intent.toModel)) {
        status = 'repaired'; repairCount += 1;
        if (member.intent.fromModel.changed) {
          entries[key] = Object.freeze({ ...entry!, changed: true, model: member.intent.fromModel.model });
        } else delete entries[key];
      }
      statuses.push(Object.freeze({ operationId: member.intent.operationId,
        sessionId: member.intent.sessionId, status }));
    }
    const planned = freezeStoreDocument({ version: 1, entries });
    const serialized = JSON.stringify(planned);
    if (byteLength(serialized) > MAX_STORE_BYTES) fail('ENGINE_MODEL_STORE_TOO_LARGE');
    parseStore(serialized);
    let tempName: string | undefined; let tempFd: number | undefined; let tempStat: fs.BigIntStats | undefined;
    let promotionAttempted = false; let promoted = false;
    let readbackAttempted = false; let operationError: unknown;
    try {
      assertRecoveryDeadline(deadline);
      if (repairCount > 0) {
        tempName = `.${TARGET_NAME}.${crypto.randomUUID()}.tmp`;
        tempFd = fs.openSync(procPath(lease.directoryFd, tempName), TEMP_FLAGS, 0o600);
        tempStat = fstatTempWithRetry(tempFd); assertPrivateFile(tempStat, 'ENGINE_MODEL_TEMP_UNTRUSTED');
        writeRecoveryTemp(tempFd, serialized, writeAccounting);
        assertRecoveryDeadline(deadline); fs.fsyncSync(tempFd); assertRecoveryDeadline(deadline);
        deps.afterTempFsync?.(procPath(lease.directoryFd, tempName)); assertRecoveryDeadline(deadline);
        assertRecoveryTempNamed(lease, tempName, tempStat);
      }
      assertRecoveryDeadline(deadline);
      assertRecoveryBatchOwner(publicOwner); assertRecoveryMembersCurrent(ownerRecord);
      for (const status of statuses) {
        if (status.status !== 'ineligible') {
          const member = members.find(value => value.intent.sessionId === status.sessionId)!;
          if (!pinMatches(db, member.intent)) fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
        }
      }
      assertRecoveryDeadline(deadline);
      const casRead = readRecoveryStore(lease, accounting);
      if (casRead.canonical !== snapshotRead.canonical || casRead.digest !== snapshotRead.digest) {
        fail('ENGINE_MODEL_STORE_CAS_MISMATCH');
      }
      const expiredBeforePromotion = monotonicMs() > deadline;
      if (repairCount > 0) {
        if (expiredBeforePromotion) fail('ENGINE_MODEL_RECOVERY_DEADLINE');
        assertNamedLock(lease);
        promotionAttempted = true;
        fs.renameSync(procPath(lease.directoryFd, tempName!), procPath(lease.directoryFd, TARGET_NAME));
        promoted = true; promotionCount = 1; fsyncDirectoryWithRetry(lease.directoryFd);
      }
      const expiredAfterPromotion = monotonicMs() > deadline;
      readbackAttempted = true;
      const readback = readRecoveryStore(lease, accounting);
      const expectedReadback = repairCount > 0 ? serialized : snapshotRead.canonical;
      if (readback.canonical !== expectedReadback
          || JSON.stringify(readback.document) !== JSON.stringify(planned)) {
        fail('ENGINE_MODEL_STORE_READBACK_FAILED');
      }
      if (!expiredAfterPromotion) {
        assertRecoveryBatchOwner(publicOwner); assertRecoveryMembersCurrent(ownerRecord);
        for (const status of statuses) {
          if (status.status !== 'ineligible') {
            const member = members.find(value => value.intent.sessionId === status.sessionId)!;
            if (!pinMatches(db, member.intent)) fail('ENGINE_MODEL_RECOVERY_OWNER_REVOKED');
          }
        }
      }
      if (accounting.contentReadCount !== 3) fail('ENGINE_MODEL_RECOVERY_READ_LIMIT');
      result = Object.freeze({ members: Object.freeze(statuses), counters: Object.freeze({
        contentReadCount: 3 as const, contentBytesRead: accounting.contentBytesRead,
        contentBytesWritten: writeAccounting.contentBytesWritten, promotionCount }),
      settlementAllowed: !expiredBeforePromotion && !expiredAfterPromotion });
    } catch (error) {
      operationError = error;
      if (promotionAttempted && !readbackAttempted && accounting.contentReadCount < 3) {
        try { readbackAttempted = true; readRecoveryStore(lease, accounting); }
        catch (readbackError) {
          operationError = new AggregateError([operationError, readbackError],
            'ENGINE_MODEL_RECOVERY_MANDATORY_READBACK_FAILED', { cause: operationError });
        }
      }
    } finally {
      const cleanupErrors: unknown[] = [];
      const closeError = closeFd(tempFd, tempStat); if (closeError) cleanupErrors.push(closeError);
      if (!promoted && tempName && tempStat) {
        try { cleanupTemp(lease, tempName, tempStat); } catch (error) { cleanupErrors.push(error); }
      }
      if (operationError !== undefined || cleanupErrors.length > 0) {
        cleanupFailure(operationError, cleanupErrors, 'ENGINE_MODEL_RECOVERY_CONTENT_CLEANUP_FAILED');
      }
    }
  } catch (error) { primary = error; }
  let releaseError: unknown;
  try { lease.release(); } catch (error) { releaseError = error; }
  if (primary !== undefined || releaseError !== undefined) {
    cleanupFailure(primary, releaseError ? [releaseError] : [], 'ENGINE_MODEL_RECOVERY_BATCH_RELEASE_FAILED');
  }
  return result!;
}

type OwnerRecord = Readonly<{
  publicOwner: EngineRestampStoreOwner; sessionId: string; operationId: string;
  canonicalDigest: string; reservation: RestampReservation; lease: LockLease;
}>;
const owners = new WeakMap<EngineRestampStoreOwner, OwnerRecord>();

function assertOwner(record: OwnerRecord): void {
  assertNamedLock(record.lease);
  if (record.reservation.sessionId !== record.sessionId
      || !isEngineRestampReservationCurrent(record.reservation)) fail('ENGINE_MODEL_OWNER_REVOKED');
  const current = engineRestampIntentsDb.read(record.sessionId);
  if (!current || current.intent.operationId !== record.operationId || digest(current.canonical) !== record.canonicalDigest) {
    fail('ENGINE_MODEL_OWNER_REVOKED');
  }
}

export type EngineRestampModelStoreBoundary = Readonly<{
  readOrdinary: () => { document: EngineRestampModelStoreDocument; digest: string };
  mintOwner: (intent: EngineRestampIntent, canonical: string, reservation: RestampReservation) => EngineRestampStoreOwner;
  readOwned: (owner: EngineRestampStoreOwner) => { document: EngineRestampModelStoreDocument; digest: string };
  writeOwned: (owner: EngineRestampStoreOwner, mutation: EngineRestampModelStoreMutation, expectedDigest: string) => void;
}>;

function createBoundary(sessionId: string, lease: LockLease, deps: StoreDeps): EngineRestampModelStoreBoundary {
  let ordinaryUsed = false;
  const gateOrdinary = (): void => {
    assertNamedLock(lease);
    if (engineRestampIntentsDb.has(sessionId) || isEngineRestampReserved(sessionId)) fail('ENGINE_MODEL_SESSION_BLOCKED');
  };
  return Object.freeze({
    readOrdinary: () => {
      gateOrdinary();
      const snapshot = readStore(lease);
      ordinaryUsed = true;
      return { document: snapshot.document, digest: snapshot.digest };
    },
    mintOwner: (intent, canonical, reservation) => {
      assertNamedLock(lease);
      const current = engineRestampIntentsDb.read(sessionId);
      if (!ordinaryUsed || intent.sessionId !== sessionId || reservation.sessionId !== sessionId
        || !isEngineRestampReservationCurrent(reservation)
        || current?.canonical !== canonical || current.intent.operationId !== intent.operationId) fail('ENGINE_MODEL_OWNER_REVOKED');
      const publicOwner = Object.freeze(Object.create(null)) as EngineRestampStoreOwner;
      owners.set(publicOwner, Object.freeze({ publicOwner, sessionId, operationId: intent.operationId,
        canonicalDigest: digest(canonical), reservation, lease }));
      return publicOwner;
    },
    readOwned: (owner) => { const record = owners.get(owner); if (!record || record.lease !== lease) return fail('ENGINE_MODEL_OWNER_REVOKED'); assertOwner(record); const snapshot = readStore(lease); return { document: snapshot.document, digest: snapshot.digest }; },
    writeOwned: (owner, mutation, expectedDigest) => {
      const ownerRecord = owners.get(owner);
      if (!ownerRecord || ownerRecord.lease !== lease) return fail('ENGINE_MODEL_OWNER_REVOKED');
      assertOwner(ownerRecord);
      if (!mutation || mutation.sessionId !== sessionId || !ALLOWED_PROVIDERS.has(mutation.provider)
        || byteLength(mutation.sessionId) > 256) fail('ENGINE_MODEL_MUTATION_INVALID');
      const key = `${mutation.provider}:${mutation.sessionId}`;
      if (mutation.entry && (mutation.entry.provider !== mutation.provider
        || mutation.entry.sessionId !== mutation.sessionId)) fail('ENGINE_MODEL_MUTATION_INVALID');
      const snapshot = readStore(lease);
      if (snapshot.digest !== expectedDigest) fail('ENGINE_MODEL_STORE_CAS_MISMATCH');
      const entries = { ...snapshot.document.entries };
      if (mutation.entry === null) delete entries[key]; else entries[key] = mutation.entry;
      promoteStore(lease, expectedDigest, { version: 1, entries }, deps);
    },
  });
}

/** Holds the FIFO and retained-FD flock across one future restamp settlement callback. */
export async function withEngineRestampModelStoreBoundary<T>(
  sessionId: string,
  callback: (boundary: EngineRestampModelStoreBoundary) => Promise<T>,
): Promise<T> {
  if (!sessionId || byteLength(sessionId) > 256) fail('ENGINE_MODEL_SESSION_INVALID');
  const deps = dependencies();
  const lease = await acquireLock(deps);
  let result: T | undefined; let primary: unknown;
  try { result = await callback(createBoundary(sessionId, lease, deps)); }
  catch (error) { primary = error; }
  let releaseError: unknown;
  try { lease.release(); } catch (error) { releaseError = error; }
  if (primary !== undefined || releaseError !== undefined) {
    cleanupFailure(primary, releaseError ? [releaseError] : [], 'ENGINE_MODEL_BOUNDARY_RELEASE_FAILED');
  }
  return result as T;
}

export const ENGINE_RESTAMP_MODEL_STORE_LIMITS = Object.freeze({
  maxBytes: MAX_STORE_BYTES, maxEntries: MAX_STORE_ENTRIES, maxWaiters: MAX_WAITERS,
  fifoTimeoutMs: FIFO_TIMEOUT_MS, flockTimeoutMs: FLOCK_TIMEOUT_MS,
  combinedTimeoutMs: COMBINED_TIMEOUT_MS,
});

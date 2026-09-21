/** Durable, installation-local root for the inert M2 runtime authority. */

import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';

import { ConnectorRuntimeAuthority } from './connector-runtime-fence.js';

const FORMAT = 'nassaj-connector-runtime-authority-v1';
const LOCK_FORMAT = 'nassaj-connector-runtime-authority-lock-v1';
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const ROOT_DOCUMENT_MAX_BYTES = 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type RootDocument = Readonly<{ format: typeof FORMAT; rotationId: string; rootKey: string }>;
type LockDocument = Readonly<{
  format: typeof LOCK_FORMAT;
  pid: number;
  createdAtMs: number;
  nonce: string;
}>;
type LockRecord = Readonly<{ document: LockDocument; stat: Stats }>;

const exactPrivateFile = (stat: Stats): boolean => stat.isFile() && (stat.mode & 0o777) === 0o600;
const sameIdentity = (left: Stats, right: Stats): boolean => left.isFile() && right.isFile()
  && left.dev === right.dev && left.ino === right.ino;

const openPinnedPrivateFile = (path: string): Readonly<{ descriptor: number; stat: Stats }> => {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !exactPrivateFile(before)) {
    throw new Error('connector_runtime_authority_root_permissions_invalid');
  }
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  const pinned = fstatSync(descriptor);
  if (!sameIdentity(before, pinned) || !exactPrivateFile(pinned)) {
    closeSync(descriptor);
    throw new Error('connector_runtime_authority_root_permissions_invalid');
  }
  return Object.freeze({ descriptor, stat: pinned });
};

const readDocument = (path: string): RootDocument => {
  const opened = openPinnedPrivateFile(path);
  let raw: string;
  try {
    if (opened.stat.size < 2 || opened.stat.size > ROOT_DOCUMENT_MAX_BYTES) {
      throw new Error('connector_runtime_authority_root_corrupt');
    }
    raw = readFileSync(opened.descriptor, 'utf8');
  }
  finally { closeSync(opened.descriptor); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('connector_runtime_authority_root_corrupt'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('connector_runtime_authority_root_corrupt');
  }
  const document = parsed as Record<string, unknown>;
  const exactKeys = Object.keys(document).sort().join(',') === 'format,rootKey,rotationId';
  const canonicalBytes = `${JSON.stringify(document)}\n`;
  if (!exactKeys || raw !== canonicalBytes || document.format !== FORMAT
    || typeof document.rotationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(document.rotationId)
    || typeof document.rootKey !== 'string'
    || !/^[A-Za-z0-9+/]{43}=$/u.test(document.rootKey)) {
    throw new Error('connector_runtime_authority_root_corrupt');
  }
  const exact = document as RootDocument;
  const key = Buffer.from(exact.rootKey, 'base64');
  if (key.length !== 32) { key.fill(0); throw new Error('connector_runtime_authority_root_corrupt'); }
  key.fill(0); return Object.freeze(exact);
};

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
};

const writePrivateFile = (path: string, contents: string): Stats => {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | NOFOLLOW, 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    fchmodSync(descriptor, 0o600);
    const stat = fstatSync(descriptor);
    if (!exactPrivateFile(stat)) throw new Error('connector_runtime_authority_private_file_mode_invalid');
    fsyncSync(descriptor);
    return stat;
  } finally { if (descriptor !== null) closeSync(descriptor); }
};

const writeStaged = (path: string, document: RootDocument): void => {
  writePrivateFile(path, `${JSON.stringify(document)}\n`);
};

const materialize = (path: string): RootDocument => {
  try { return readDocument(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staged = `${path}.staged`;
  try {
    const recovered = readDocument(staged);
    renameSync(staged, path); fsyncDirectory(dirname(path)); return recovered;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const document = Object.freeze({ format: FORMAT, rotationId: randomUUID(),
    rootKey: randomBytes(32).toString('base64') });
  writeStaged(staged, document);
  renameSync(staged, path); fsyncDirectory(dirname(path)); return document;
};

export type ConnectorRuntimeAuthorityRoot = Readonly<{
  authority: ConnectorRuntimeAuthority;
  rotationId: string;
}>;

const authorityFromDocument = (document: RootDocument): ConnectorRuntimeAuthorityRoot => {
  const key = Buffer.from(document.rootKey, 'base64');
  try { return Object.freeze({ authority: ConnectorRuntimeAuthority.create(key),
    rotationId: document.rotationId }); } finally { key.fill(0); }
};

/** Reads an existing authority root without locks, repair, creation, or cleanup writes. */
export const readConnectorRuntimeAuthorityRoot = (path: string): ConnectorRuntimeAuthorityRoot =>
  authorityFromDocument(readDocument(path));

const validLockDocument = (value: unknown): value is LockDocument => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'createdAtMs,format,nonce,pid'
    && row.format === LOCK_FORMAT && Number.isSafeInteger(row.pid) && Number(row.pid) > 0
    && Number.isSafeInteger(row.createdAtMs) && Number(row.createdAtMs) > 0
    && typeof row.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(row.nonce);
};

const readLock = (path: string): LockRecord => {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !exactPrivateFile(before)) {
    throw new Error('connector_runtime_authority_lock_identity_invalid');
  }
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const pinned = fstatSync(descriptor);
    if (!sameIdentity(before, pinned) || !exactPrivateFile(pinned) || pinned.size > 1024) {
      throw new Error('connector_runtime_authority_lock_identity_invalid');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(descriptor, 'utf8')); }
    catch { throw new Error('connector_runtime_authority_lock_corrupt'); }
    if (!validLockDocument(parsed)) throw new Error('connector_runtime_authority_lock_corrupt');
    return Object.freeze({ document: Object.freeze(parsed), stat: pinned });
  } finally { closeSync(descriptor); }
};

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

const restoreMovedLock = (moved: string, original: string): void => {
  try { lstatSync(original); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
  try { renameSync(moved, original); } catch { /* preserve evidence at moved path */ }
};

const removeExactMovedLock = (original: string, expected: LockRecord, purpose: string): boolean => {
  const moved = `${original}.${purpose}-${randomUUID()}`;
  try { renameSync(original, moved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const movedRecord = readLock(moved);
    if (!sameIdentity(expected.stat, movedRecord.stat)
      || movedRecord.document.nonce !== expected.document.nonce) {
      throw new Error('connector_runtime_authority_lock_identity_changed');
    }
    unlinkSync(moved); fsyncDirectory(dirname(original)); return true;
  } catch (error) {
    restoreMovedLock(moved, original);
    throw error;
  }
};

type AuthorityLock = Readonly<{ release: () => void }>;

const tryCreateLock = (path: string, nowMs: number): AuthorityLock | null => {
  const document = Object.freeze({ format: LOCK_FORMAT, pid: process.pid, createdAtMs: nowMs,
    nonce: randomBytes(32).toString('base64url') });
  const candidate = `${path}.candidate-${document.nonce}`;
  const candidateStat = writePrivateFile(candidate, `${JSON.stringify(document)}\n`);
  try { linkSync(candidate, path); }
  catch (error) {
    try { unlinkSync(candidate); } catch { /* the candidate contains no secret */ }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  try { unlinkSync(candidate); fsyncDirectory(dirname(path)); }
  catch { /* the published lock remains authoritative; an orphan candidate is harmless */ }
  const published = readLock(path);
  if (!sameIdentity(candidateStat, published.stat) || published.document.nonce !== document.nonce) {
    throw new Error('connector_runtime_authority_lock_publish_invalid');
  }
  const owned = Object.freeze({ document, stat: published.stat });
  return Object.freeze({ release: () => {
    let current: LockRecord;
    try { current = readLock(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; else throw error; }
    if (!sameIdentity(owned.stat, current.stat) || current.document.nonce !== document.nonce) {
      throw new Error('connector_runtime_authority_lock_ownership_lost');
    }
    removeExactMovedLock(path, current, 'release');
  } });
};

const waitBriefly = (): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
};

const acquireAuthorityLock = (path: string): AuthorityLock | null => {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  do {
    const nowMs = Date.now();
    const created = tryCreateLock(path, nowMs);
    if (created) return created;
    let existing: LockRecord;
    try { existing = readLock(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof Error && error.message === 'connector_runtime_authority_lock_corrupt') {
        let ageMs = Number.POSITIVE_INFINITY;
        try { ageMs = nowMs - lstatSync(path).mtimeMs; } catch { continue; }
        if (ageMs < 1_000) { waitBriefly(); continue; }
      }
      throw error;
    }
    const stale = nowMs - existing.document.createdAtMs >= LOCK_STALE_MS
      && !processAlive(existing.document.pid);
    if (stale) { removeExactMovedLock(path, existing, 'stale'); continue; }
    waitBriefly();
  } while (Date.now() < deadline);
  return null;
};

/** Opens or atomically bootstraps one root; corruption is never replaced. */
export const openOrCreateConnectorRuntimeAuthorityRoot = (path: string): ConnectorRuntimeAuthorityRoot => {
  const lock = acquireAuthorityLock(`${path}.lock`);
  if (!lock) throw new Error('connector_runtime_authority_root_lock_unavailable');
  try { return authorityFromDocument(materialize(path)); }
  finally { lock.release(); }
};

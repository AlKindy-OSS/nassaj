/** Immutable, fail-closed boundary between the product and published governance data. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  GOVERNANCE_CATALOG_MAX_BYTES,
  InvalidGovernanceCatalog,
  parseGovernanceCatalog,
} from './governance-content-catalog.js';

export const GOVERNANCE_CATALOG_PATH = '/etc/nassaj/governance-content.json';
const ROOT_UID = 0;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Stable fail-closed error returned when published governance content cannot be trusted. */
export class GovernanceContentUnavailable extends Error {
  constructor(reason = 'unavailable') {
    super('GOVERNANCE_CONTENT_UNAVAILABLE');
    this.name = 'GovernanceContentUnavailable';
    this.code = 'GOVERNANCE_CONTENT_UNAVAILABLE';
    this.reason = reason;
  }
}

function unavailable(reason) {
  throw new GovernanceContentUnavailable(reason);
}

function close(fd) {
  try { fs.closeSync(fd); } catch { /* descriptor is already closed */ }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function openAbsolute(pathname, leafFlags) {
  if (typeof pathname !== 'string' || !path.isAbsolute(pathname) || pathname === '/'
    || pathname.includes('\0') || pathname.includes('\\')) unavailable('invalid_path');
  const parts = pathname.split('/').filter(Boolean);
  let fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const [index, part] of parts.entries()) {
      if (!SEGMENT.test(part) || part === '.' || part === '..') unavailable('invalid_path');
      const flags = index === parts.length - 1
        ? leafFlags | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
      const next = fs.openSync(`/proc/self/fd/${fd}/${part}`, flags);
      close(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    close(fd);
    if (error instanceof GovernanceContentUnavailable) throw error;
    unavailable('path_unavailable');
  }
}

function assertImmutableFile(stat, ownerUid, maximum, expectedDevice = null) {
  if (!stat.isFile() || (ownerUid !== null && stat.uid !== ownerUid)
    || (ownerUid !== null && (stat.mode & 0o222) !== 0) || stat.nlink !== 1
    || stat.size < 1 || stat.size > maximum
    || (expectedDevice !== null && stat.dev !== expectedDevice)) unavailable('unsafe_file');
}

function assertImmutableDirectory(stat, ownerUid, expectedDevice = null) {
  if (!stat.isDirectory() || (ownerUid !== null && stat.uid !== ownerUid)
    || (ownerUid !== null && (stat.mode & 0o222) !== 0)
    || (expectedDevice !== null && stat.dev !== expectedDevice)) unavailable('unsafe_directory');
}

function readStableBytes(fd, ownerUid, maximum, expectedDevice = null) {
  const before = fs.fstatSync(fd);
  assertImmutableFile(before, ownerUid, maximum, expectedDevice);
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
    if (count === 0) unavailable('short_read');
    offset += count;
  }
  if (!sameIdentity(before, fs.fstatSync(fd))) unavailable('identity_changed');
  return { bytes, stat: before };
}

function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { unavailable('invalid_utf8'); }
}

function readCatalog(dependencies) {
  const injected = Number.isInteger(dependencies.catalogFd);
  const fd = injected ? dependencies.catalogFd : openAbsolute(
    GOVERNANCE_CATALOG_PATH,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
  );
  try {
    const { bytes } = readStableBytes(
      fd,
      dependencies.catalogOwnerUid ?? ROOT_UID,
      GOVERNANCE_CATALOG_MAX_BYTES,
    );
    let value;
    try { value = JSON.parse(decodeUtf8(bytes)); } catch (error) {
      if (error instanceof GovernanceContentUnavailable) throw error;
      unavailable('invalid_catalog_json');
    }
    try { return parseGovernanceCatalog(value); } catch (error) {
      if (error instanceof InvalidGovernanceCatalog) unavailable(error.reason);
      throw error;
    }
  } finally {
    if (!injected) close(fd);
  }
}

function visibleTo(entry, actorId) {
  if (actorId === null || actorId === undefined) return false;
  if (entry.visibility.mode === 'authenticated') return true;
  return entry.visibility.actorIds.includes(String(actorId));
}

function selectEntry(catalog, projectId, kind, actorId) {
  const entry = catalog.entries.find((candidate) => (
    candidate.key.projectId === projectId && candidate.key.kind === kind
  ));
  if (!entry) unavailable('entry_unavailable');
  if (!visibleTo(entry, actorId)) unavailable('not_visible');
  return entry;
}

function validateRelativePath(relativePath) {
  const parts = relativePath.split('/');
  if (parts.some((part) => !SEGMENT.test(part) || part === '.' || part === '..')) {
    unavailable('invalid_catalog_path');
  }
  return parts;
}

function readSnapshotFile(rootFd, rootStat, entry, trustedUid) {
  const parts = validateRelativePath(entry.path);
  let parentFd = rootFd;
  const directories = [];
  let fileFd;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = fs.openSync(`/proc/self/fd/${parentFd}/${part}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const directory = { parentFd, part, fd: next, stat: null };
      directories.push(directory);
      directory.stat = fs.fstatSync(next);
      assertImmutableDirectory(directory.stat, trustedUid, rootStat.dev);
      parentFd = next;
    }
    fileFd = fs.openSync(`/proc/self/fd/${parentFd}/${parts.at(-1)}`,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const read = readStableBytes(fileFd, trustedUid, entry.bytes, rootStat.dev);
    for (const directory of directories) {
      const current = fs.lstatSync(`/proc/self/fd/${directory.parentFd}/${directory.part}`);
      if (current.isSymbolicLink() || current.dev !== directory.stat.dev
        || current.ino !== directory.stat.ino) unavailable('component_changed');
    }
    return read;
  } catch (error) {
    if (error instanceof GovernanceContentUnavailable) throw error;
    unavailable('snapshot_unavailable');
  } finally {
    if (fileFd !== undefined) close(fileFd);
    for (const directory of directories.reverse()) close(directory.fd);
  }
}

function openSnapshotRoot(catalog, dependencies) {
  const injected = Number.isInteger(dependencies.rootFd);
  const fd = injected ? dependencies.rootFd : openAbsolute(
    catalog.root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    const stat = fs.fstatSync(fd);
    assertImmutableDirectory(stat, catalog.trustedUid);
    return { fd, stat, injected };
  } catch (error) {
    if (!injected) close(fd);
    throw error;
  }
}

function resolveWithDependencies(selector = {}, dependencies = {}) {
  const serviceUid = dependencies.serviceUid ?? process.geteuid?.() ?? process.getuid?.();
  const catalog = readCatalog(dependencies);
  if (!Number.isSafeInteger(serviceUid) || catalog.trustedUid === serviceUid) {
    unavailable('shared_service_uid');
  }
  const entry = selectEntry(catalog, selector.projectId, selector.kind, selector.actorId);
  const root = openSnapshotRoot(catalog, dependencies);
  try {
    const read = readSnapshotFile(root.fd, root.stat, entry, catalog.trustedUid);
    if (read.bytes.length !== entry.bytes) unavailable('size_mismatch');
    const sha256 = createHash('sha256').update(read.bytes).digest('hex');
    if (sha256 !== entry.sha256) unavailable('file_digest_mismatch');
    const content = decodeUtf8(read.bytes);
    let value = null;
    if (entry.format === 'json') {
      try { value = JSON.parse(content); } catch { unavailable('invalid_json'); }
    }
    return {
      content,
      value,
      provenance: Object.freeze({
        source: 'governance-provider', snapshotId: catalog.snapshotId,
        rootDigest: catalog.rootDigest, projectId: selector.projectId,
        kind: selector.kind, sha256, bytes: read.bytes.length,
      }),
    };
  } finally {
    if (!root.injected) close(root.fd);
  }
}

/** Resolve one actor-visible governance record from the immutable system catalog. */
export function resolveGovernanceContent(selector = {}) {
  return resolveWithDependencies(selector);
}

/** Resolve governance content without exposing internal filesystem or validation errors. */
export function tryResolveGovernanceContent(selector) {
  try { return { available: true, ...resolveGovernanceContent(selector) }; } catch (error) {
    return { available: false, reason: error instanceof GovernanceContentUnavailable ? error.reason : 'unavailable' };
  }
}

/** Read a product-versioned file without using the governance publication boundary. */
export function readProductVersionedContent(rootPath, relativePath, maximum = DEFAULT_MAX_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) {
    unavailable('invalid_maximum');
  }
  const rootFd = openAbsolute(rootPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const rootStat = fs.fstatSync(rootFd);
    const entry = { path: relativePath, bytes: maximum };
    const read = readSnapshotFile(rootFd, rootStat, entry, null);
    const content = decodeUtf8(read.bytes);
    return { content, provenance: Object.freeze({
      source: 'product-versioned', sha256: createHash('sha256').update(read.bytes).digest('hex'),
      bytes: read.bytes.length,
    }) };
  } finally { close(rootFd); }
}

export const __test__ = Object.freeze({
  DEFAULT_MAX_BYTES,
  resolveWithDependencies,
  tryWithDependencies(selector, dependencies) {
    try { return { available: true, ...resolveWithDependencies(selector, dependencies) }; } catch (error) {
      return { available: false, reason: error instanceof GovernanceContentUnavailable ? error.reason : 'unavailable' };
    }
  },
});

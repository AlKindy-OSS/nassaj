import { createHash } from 'node:crypto';
import path from 'node:path';

export const GOVERNANCE_CATALOG_SCHEMA_VERSION = 1;
export const GOVERNANCE_CATALOG_MAX_BYTES = 1024 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KINDS = new Set(['project-state', 'project-plan', 'project-status']);
const ENTRY_KEYS = ['bytes', 'format', 'key', 'path', 'sha256', 'visibility'];
const CATALOG_KEYS = ['entries', 'root', 'rootDigest', 'schemaVersion', 'snapshotId', 'trustedUid'];

export class InvalidGovernanceCatalog extends Error {
  constructor(reason) {
    super('INVALID_GOVERNANCE_CATALOG');
    this.name = 'InvalidGovernanceCatalog';
    this.reason = reason;
  }
}

function invalid(reason) {
  throw new InvalidGovernanceCatalog(reason);
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validatePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)
    || relativePath.includes('\0') || relativePath.includes('\\')) invalid('invalid_catalog_path');
  const parts = relativePath.split('/');
  if (parts.some((part) => !PROJECT_ID.test(part) || part === '.' || part === '..')) {
    invalid('invalid_catalog_path');
  }
  return relativePath;
}

function normalizeVisibility(visibility) {
  if (hasExactKeys(visibility, ['mode']) && visibility.mode === 'authenticated') {
    return { mode: 'authenticated' };
  }
  if (!hasExactKeys(visibility, ['actorIds', 'mode']) || visibility.mode !== 'actors'
    || !Array.isArray(visibility.actorIds) || visibility.actorIds.length === 0) {
    invalid('invalid_visibility');
  }
  const actorIds = visibility.actorIds.map((id) => {
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) invalid('invalid_visibility');
    return id;
  });
  if (new Set(actorIds).size !== actorIds.length) invalid('invalid_visibility');
  return { mode: 'actors', actorIds: [...actorIds].sort() };
}

function normalizeEntry(entry) {
  if (!hasExactKeys(entry, ENTRY_KEYS) || !hasExactKeys(entry.key, ['kind', 'projectId'])) {
    invalid('invalid_entry');
  }
  const { projectId, kind } = entry.key;
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || !KINDS.has(kind)) {
    invalid('invalid_logical_key');
  }
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 16 * 1024 * 1024
    || typeof entry.sha256 !== 'string' || !DIGEST.test(entry.sha256)
    || !['json', 'text'].includes(entry.format)) invalid('invalid_entry');
  return {
    key: { projectId, kind },
    path: validatePath(entry.path),
    bytes: entry.bytes,
    sha256: entry.sha256,
    format: entry.format,
    visibility: normalizeVisibility(entry.visibility),
  };
}

function digestPayload(catalog) {
  return {
    snapshotId: catalog.snapshotId,
    trustedUid: catalog.trustedUid,
    entries: catalog.entries,
  };
}

export function calculateGovernanceRootDigest(catalog) {
  return createHash('sha256').update(JSON.stringify(digestPayload(catalog))).digest('hex');
}

/** Parse the single canonical catalog schema; unknown and legacy fields are rejected. */
export function parseGovernanceCatalog(value) {
  if (!hasExactKeys(value, CATALOG_KEYS) || value.schemaVersion !== GOVERNANCE_CATALOG_SCHEMA_VERSION
    || typeof value.snapshotId !== 'string' || !IDENTIFIER.test(value.snapshotId)
    || typeof value.root !== 'string' || !path.isAbsolute(value.root) || value.root === '/'
    || value.root.includes('\0') || value.root.includes('\\')
    || !Number.isSafeInteger(value.trustedUid) || value.trustedUid < 0
    || typeof value.rootDigest !== 'string' || !DIGEST.test(value.rootDigest)
    || !Array.isArray(value.entries) || value.entries.length === 0) invalid('invalid_catalog');

  const entries = value.entries.map(normalizeEntry);
  const logicalKeys = entries.map(({ key }) => `${key.projectId}\0${key.kind}`);
  if (new Set(logicalKeys).size !== logicalKeys.length
    || logicalKeys.some((key, index) => index > 0 && logicalKeys[index - 1] >= key)) {
    invalid('noncanonical_entries');
  }
  const catalog = Object.freeze({
    schemaVersion: GOVERNANCE_CATALOG_SCHEMA_VERSION,
    snapshotId: value.snapshotId,
    root: value.root,
    rootDigest: value.rootDigest,
    trustedUid: value.trustedUid,
    entries: Object.freeze(entries),
  });
  if (calculateGovernanceRootDigest(catalog) !== catalog.rootDigest) invalid('root_digest_mismatch');
  return catalog;
}

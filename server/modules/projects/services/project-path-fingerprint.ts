import { createHmac } from 'node:crypto';
import path from 'node:path';

/** Linux canonical path contract v1. Resolve symlinks/verify open-directory identity before calling, outside SQLite. */
export function fingerprintCanonicalProjectPath(canonicalPath: string, keyVersion: number, keys: ReadonlyMap<number, Uint8Array>): string {
  const key = keys.get(keyVersion);
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || !key || key.byteLength < 32) throw new Error('DELETION_FINGERPRINT_KEY_REQUIRED');
  if (!path.posix.isAbsolute(canonicalPath) || canonicalPath.includes('\0') || path.posix.normalize(canonicalPath) !== canonicalPath ||
      (canonicalPath.length > 1 && canonicalPath.endsWith('/'))) throw new Error('DELETION_CANONICAL_PATH_REQUIRED');
  return createHmac('sha256', key).update('nassaj:project-path:v1\0').update(canonicalPath).digest('hex');
}

/** Every historical read key is mandatory; never silently skip an unreadable generation. */
export function fingerprintProjectReadSet(canonicalPath: string, requiredVersions: readonly number[], keys: ReadonlyMap<number, Uint8Array>) {
  if (!requiredVersions.length || new Set(requiredVersions).size !== requiredVersions.length) throw new Error('DELETION_FINGERPRINT_VERSIONS_INVALID');
  return requiredVersions.map(keyVersion => Object.freeze({ keyVersion, fingerprint: fingerprintCanonicalProjectPath(canonicalPath,keyVersion,keys) }));
}

/**
 * atomic-json-file — shared read/merge/write primitives for the provider
 * credential writers (T-866).
 *
 * Mirrors the `writeKeysFile` pattern in
 * server/services/isolation/provider-secrets-store.js: the parent directory is
 * created at 0700, the payload is written to a unique tmp file at 0600 and then
 * atomically renamed over the destination, so a concurrent reader can never
 * observe a torn file and the credential file is never group/world readable.
 *
 * Reading is fail-open to "empty object": a missing, unreadable or corrupt
 * (non-JSON / non-object) file degrades to `{}` so callers report
 * "not configured" instead of crashing — the security contract of T-866.
 *
 * This module never logs file contents (they may hold secrets).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Reads and parses a JSON object file. Returns `{}` when the file is missing,
 * unreadable, not valid JSON, or not a plain object (corrupt-file degradation).
 */
export function readJsonObjectOrEmpty(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing/corrupt file: treat as empty — degrade to "not configured".
  }
  return {};
}

/**
 * Atomically writes a JSON object with restrictive permissions:
 * dir 0700 (created if absent), file 0600, tmp + rename (never in-place).
 */
export function writeJsonObjectAtomic(filePath: string, value: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    // Non-fatal; the write mode above already restricts the file.
  }
}

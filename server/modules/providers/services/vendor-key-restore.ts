/**
 * vendor-key-restore — ADR-200 §3 rollback (G2, B-1570): puts a harness
 * credential file back from its `backup:<harness>` record.
 *
 *   - **keys** (default): only the API-key fields go back to their backed-up
 *     values; a field the backup did not hold is removed. Claude
 *     `env.ANTHROPIC_API_KEY` (a restored key outranks a Claude subscription:
 *     documented and intended); Codex `OPENAI_API_KEY`, with `auth_mode`
 *     derived as the credential writer does and never moved off a ChatGPT
 *     login in effect; OpenCode `type: 'api'` entries, where a provider that
 *     now holds a login (any non-api entry) is left alone and reported as
 *     `login_present`. OAuth material (`CLAUDE_CODE_OAUTH_TOKEN`, Codex
 *     `tokens`, OpenCode logins) and every other setting are never touched.
 *   - **full**: the exact backed-up bytes (or the file removed when it was
 *     absent). The caller asks for it with an explicit confirm.
 *
 * Both write through a symlink to its target (the link is kept) and keep the
 * file's current permission bits. No key value is returned or logged.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { codexAuthAfterKeyRestore } from '@/modules/providers/list/codex/codex-auth-shape.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

import type { ProjectionHarness } from './vendor-key-migration.inventory.js';

export type RestoreMode = 'keys' | 'full';

export type HarnessBackup = { existed: boolean; bytes: Buffer };

/** A provider entry the restore left as found, and why. */
export type RestoreSkip = { target: string; outcome: 'login_present' };

/** What a restore did beyond writing the file; `skipped` is empty in `full` mode. */
export type RestoreReport = { skipped: RestoreSkip[] };

type JsonObject = Record<string, unknown>;

const DEFAULT_FILE_MODE = 0o600;

function restoreError(code: string, message: string): AppError {
  return new AppError(message, { code, statusCode: 409 });
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** The file a write lands in: a symlink's target (the link stays), else the path itself. */
function writeTarget(filePath: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return filePath;
  }
  if (!stat.isSymbolicLink()) return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
  }
}

/** Atomic write (tmp + rename) that keeps the target's permission bits, or 0600 for a new file. */
function writeKeepingMode(filePath: string, bytes: Buffer): void {
  const target = writeTarget(filePath);
  let mode = DEFAULT_FILE_MODE;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${target}.restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, bytes, { mode });
  fs.chmodSync(tmpPath, mode);
  fs.renameSync(tmpPath, target);
}

function parseObject(bytes: Buffer): JsonObject | null {
  try {
    return readObjectRecord(JSON.parse(bytes.toString('utf8'))) ?? null;
  } catch {
    return null;
  }
}

/** Copies `field` from `from` into `to`, or removes it from `to` when `from` lacks it. */
function copyField(to: JsonObject, from: JsonObject, field: string): void {
  if (hasOwn(from, field)) to[field] = from[field];
  else delete to[field];
}

function isApiEntry(value: unknown): boolean {
  return readObjectRecord(value)?.type === 'api';
}

/**
 * OpenCode: `type: 'api'` entries back to the backup's. An entry that is now a
 * login (present and not `type: 'api'`) is never replaced or removed (N-1).
 */
function mergeOpenCodeEntries(current: JsonObject, backup: JsonObject, skipped: RestoreSkip[]): JsonObject {
  const next: JsonObject = { ...current };
  for (const name of new Set([...Object.keys(current), ...Object.keys(backup)])) {
    const isLogin = hasOwn(current, name) && !isApiEntry(current[name]);
    if (isLogin) {
      if (isApiEntry(backup[name])) skipped.push({ target: name, outcome: 'login_present' });
      continue;
    }
    if (isApiEntry(backup[name])) next[name] = backup[name];
    else if (isApiEntry(current[name])) delete next[name];
  }
  return next;
}

/** The current file with its API-key fields set back to the backup's. */
function mergeKeyFields(
  harness: ProjectionHarness,
  current: JsonObject,
  backup: JsonObject,
  skipped: RestoreSkip[],
): JsonObject {
  if (harness === 'claude') {
    const next: JsonObject = { ...current };
    const env: JsonObject = { ...(readObjectRecord(current.env) ?? {}) };
    copyField(env, readObjectRecord(backup.env) ?? {}, 'ANTHROPIC_API_KEY');
    if (hasOwn(current, 'env') || Object.keys(env).length > 0) next.env = env;
    return next;
  }
  if (harness === 'codex') {
    const merged: JsonObject = { ...current };
    copyField(merged, backup, 'OPENAI_API_KEY');
    return codexAuthAfterKeyRestore(current, merged);
  }
  return mergeOpenCodeEntries(current, backup, skipped);
}

/** Reads the current file as an object; absent reads as `null`, unparseable refuses. */
function readCurrent(filePath: string): JsonObject | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw restoreError('VENDOR_RESTORE_FILE_UNREADABLE', 'The harness file cannot be read.');
  }
  const json = parseObject(bytes);
  if (!json) {
    throw restoreError('VENDOR_RESTORE_FILE_UNPARSEABLE',
      'The harness file is not valid JSON; only a full restore can replace it.');
  }
  return json;
}

/** `keys` mode: API-key fields only. Writes nothing when they already match. */
function restoreKeyFields(harness: ProjectionHarness, filePath: string, backup: HarnessBackup): RestoreReport {
  const saved = backup.existed ? parseObject(backup.bytes) : {};
  if (!saved) {
    throw restoreError('VENDOR_BACKUP_UNPARSEABLE', 'The backup is not valid JSON; only a full restore can use it.');
  }
  const current = readCurrent(filePath);
  const skipped: RestoreSkip[] = [];
  const next = mergeKeyFields(harness, current ?? {}, saved, skipped);
  const unchanged = current === null
    ? Object.keys(next).length === 0
    : JSON.stringify(next) === JSON.stringify(current);
  if (!unchanged) writeKeepingMode(filePath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
  return { skipped };
}

/** `full` mode: the exact bytes, or no file when the backup recorded none. */
function restoreFullFile(filePath: string, backup: HarnessBackup): void {
  if (backup.existed) {
    writeKeepingMode(filePath, backup.bytes);
    return;
  }
  let isLink = false;
  try {
    isLink = fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return;
  }
  if (isLink) {
    throw restoreError('VENDOR_RESTORE_SYMLINK', 'The harness file is a link; it is not removed by a restore.');
  }
  fs.rmSync(filePath, { force: true });
}

/**
 * Restores one harness file from its backup in the given mode.
 * @param harness the harness the file belongs to
 * @param filePath the member's own credential file
 * @param backup the decrypted, intact backup
 * @param mode `keys` (API-key fields only) or `full` (exact bytes)
 * @returns the entries a `keys` restore left as found (none in `full` mode)
 */
export function restoreHarnessFile(
  harness: ProjectionHarness,
  filePath: string,
  backup: HarnessBackup,
  mode: RestoreMode,
): RestoreReport {
  if (mode === 'keys') return restoreKeyFields(harness, filePath, backup);
  restoreFullFile(filePath, backup);
  return { skipped: [] };
}

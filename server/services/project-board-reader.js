/**
 * project-board-reader.js — B-1524.
 *
 * Reads a project's board files (docs/project-state.json and the two
 * ARCHITECTURE documents) from the project's OWN folder. Whoever may enter a
 * project may read its board; the caller proves that first (the route through
 * `assertProjectVisible`, the coordinator hooks through the session's own
 * project), and hands this module only the project root that check returned.
 *
 * Containment is judged on resolved paths, not on literal spelling, so roots
 * with spaces, Arabic names, `@`/`+`, or symlinked ancestors are fine:
 *  1. realpath the root and the candidate, and refuse a candidate that resolves
 *     outside the root BEFORE it is opened;
 *  2. open without following into a blocking device (O_NONBLOCK | O_NOCTTY);
 *  3. re-judge the path the KERNEL reports for the open descriptor
 *     (/proc/self/fd/N), which closes the swap window between 1 and 2;
 *  4. accept only a regular file with exactly one link (a hard link would let a
 *     file outside the project be reached through a name inside it).
 *
 * The only way out of the project root is an operator-declared external binding
 * (NASSAJ_BOARD_EXTERNAL_BINDINGS) for ONE project's state file, matched exactly.
 */

import fs from 'node:fs';
import path from 'node:path';

export const BOARD_STATE_FILE = 'docs/project-state.json';
export const ARCHITECTURE_FILE = 'docs/ARCHITECTURE.md';
export const ARCHITECTURE_AR_FILE = 'docs/ARCHITECTURE_AR.md';

export const STATE_MAX_BYTES = 16 * 1024 * 1024;
export const ARCHITECTURE_MAX_BYTES = 4 * 1024 * 1024;
export const GOVERNANCE_STUB_SCHEMA = 'nassaj-governance-boundary/v1';

/** Every reason a read can end with; 'ok' is the only success value. */
export const BOARD_READ_REASONS = Object.freeze([
  'ok', 'missing', 'invalid_json', 'too_large', 'outside_project',
  'external_source_unconfigured', 'unreadable',
]);

const ALLOWED_FILES = new Set([BOARD_STATE_FILE, ARCHITECTURE_FILE, ARCHITECTURE_AR_FILE]);
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY;
const READ_CHUNK = 64 * 1024;
// One parsed version per state file, bounded by an estimated byte budget.
const STATE_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const stateCache = new Map(); // realPath -> { key, value, bytes }, LRU order
const warnedLarge = new Set();
let bindingCache = { raw: undefined, map: new Map() };

class BoardReadRefusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function refuse(reason) {
  throw new BoardReadRefusal(reason);
}

function isWithin(candidate, root) {
  if (root === path.sep) return candidate !== root;
  return candidate.startsWith(root + path.sep);
}

function closeQuietly(fd) {
  try { fs.closeSync(fd); } catch { /* already closed */ }
}

function realpathOrRefuse(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    refuse(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }
  return null;
}

/**
 * Parse NASSAJ_BOARD_EXTERNAL_BINDINGS (format only; files resolve per lookup).
 *
 * Format: `<projectId>=<absolute file>[,<projectId>=<absolute file>...]`.
 * Entries are comma-separated, so a bound path cannot contain a comma.
 * `projectId` is the board route's `:projectId`, i.e. `projects.project_id`:
 * a lowercase UUID v4 for every project created or discovered by nassaj
 * (randomUUID), or a migrated legacy `workspace_id` on old rows. Each file must
 * be absolute. Malformed entries are logged (by position, never by path) and
 * ignored; an absent or empty value yields no bindings. Existence and realpath
 * are NOT judged here: see getExternalBinding.
 *
 * @param {unknown} raw the env value
 * @returns {Map<string, string>} projectId -> configured absolute path
 */
export function parseExternalBindings(raw) {
  const bindings = new Map();
  if (typeof raw !== 'string' || raw.trim() === '') return bindings;
  raw.split(',').forEach((item, index) => {
    const separator = item.indexOf('=');
    const projectId = separator > 0 ? item.slice(0, separator).trim() : '';
    const file = separator > 0 ? item.slice(separator + 1).trim() : '';
    if (!PROJECT_ID_PATTERN.test(projectId) || !path.isAbsolute(file) || file.includes('\0')) {
      console.warn(`[project-board] ignoring invalid NASSAJ_BOARD_EXTERNAL_BINDINGS entry #${index + 1}`);
      return;
    }
    bindings.set(projectId, file);
  });
  return bindings;
}

function resolveBindingFile(file) {
  try {
    const real = fs.realpathSync(file);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The external state file bound to `projectId` (realpath), or null. The env
 * value is parsed once per distinct value, but the bound path is re-resolved
 * on every call, so a file created later or a re-pointed symlink takes effect
 * without a restart.
 *
 * @param {string} projectId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function getExternalBinding(projectId, env = process.env) {
  const raw = env.NASSAJ_BOARD_EXTERNAL_BINDINGS;
  if (bindingCache.raw !== raw) bindingCache = { raw, map: parseExternalBindings(raw) };
  const configured = typeof projectId === 'string' ? bindingCache.map.get(projectId) : undefined;
  return configured ? resolveBindingFile(configured) : null;
}

function isAllowedTarget(real, rootReal, externalBinding) {
  return isWithin(real, rootReal) || (typeof externalBinding === 'string' && real === externalBinding);
}

function descriptorPath(fd) {
  const linked = fs.readlinkSync(`/proc/self/fd/${fd}`);
  if (linked.endsWith(' (deleted)')) refuse('unreadable');
  return linked;
}

/** Open `relativePath` under `projectPath` and validate where the fd really points. */
function openContained(projectPath, relativePath, externalBinding) {
  if (!ALLOWED_FILES.has(relativePath)) refuse('outside_project');
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) refuse('missing');
  const binding = relativePath === BOARD_STATE_FILE ? externalBinding : null;
  const rootReal = realpathOrRefuse(projectPath);
  const candidate = path.join(rootReal, relativePath);
  if (!isAllowedTarget(realpathOrRefuse(candidate), rootReal, binding)) refuse('outside_project');
  let fd;
  try {
    fd = fs.openSync(candidate, OPEN_FLAGS);
  } catch (error) {
    refuse(error?.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  try {
    const realPath = descriptorPath(fd);
    if (!isAllowedTarget(realPath, rootReal, binding)) refuse('outside_project');
    return { fd, realPath, rootReal };
  } catch (error) {
    closeQuietly(fd);
    if (error instanceof BoardReadRefusal) throw error;
    refuse('unreadable');
  }
  return null;
}

function checkStat(stat, maxBytes) {
  if (!stat.isFile() || stat.nlink !== 1n) refuse('unreadable');
  if (stat.size === 0n) refuse('missing');
  if (stat.size > BigInt(maxBytes)) refuse('too_large');
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Cache key for one exact file version (identity + size + timestamps). */
function statKey(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function readBytes(fd, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, Math.min(READ_CHUNK, size - offset), offset);
    if (count === 0) return null;
    offset += count;
  }
  return bytes;
}

/**
 * Read the whole file once its stat is stable; one retry if a writer raced us.
 * `shortcut(stat)` may return a value to skip the read (cache hit).
 */
function readStable(fd, maxBytes, shortcut) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fs.fstatSync(fd, { bigint: true });
    checkStat(before, maxBytes);
    const cached = shortcut ? shortcut(before) : undefined;
    if (cached !== undefined) return { cached, stat: before };
    const bytes = readBytes(fd, Number(before.size));
    if (bytes && sameStat(before, fs.fstatSync(fd, { bigint: true }))) return { bytes, stat: before };
  }
  refuse('unreadable');
  return null;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('unreadable');
  }
  return null;
}

function withValidatedFile(projectPath, relativePath, options, consume) {
  try {
    const { fd, realPath, rootReal } = openContained(
      projectPath, relativePath, options.externalBinding ?? null,
    );
    try {
      return { status: 'ok', realPath, rootReal, ...consume(fd, realPath) };
    } finally {
      closeQuietly(fd);
    }
  } catch (error) {
    if (error instanceof BoardReadRefusal) return { status: error.reason };
    return { status: 'unreadable' };
  }
}

/**
 * Read one fixed board file from a project root.
 *
 * @param {string} projectPath root returned by the visibility check (never user input)
 * @param {string} relativePath one of BOARD_STATE_FILE / ARCHITECTURE_FILE / ARCHITECTURE_AR_FILE
 * @param {{maxBytes?: number, externalBinding?: string|null}} [options]
 * @returns {{status: string, content?: string, realPath?: string, rootReal?: string, stat?: object}}
 *   status is one of BOARD_READ_REASONS; empty files read as 'missing'.
 */
export function readProjectFile(projectPath, relativePath, options = {}) {
  const maxBytes = options.maxBytes ?? ARCHITECTURE_MAX_BYTES;
  return withValidatedFile(projectPath, relativePath, options, (fd) => {
    const { bytes, stat } = readStable(fd, maxBytes);
    return { content: decodeUtf8(bytes), stat };
  });
}

function parseState(bytes) {
  let value;
  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof BoardReadRefusal) throw error;
    refuse('invalid_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('invalid_json');
  if (value.$schema === GOVERNANCE_STUB_SCHEMA) {
    refuse('external_source_unconfigured');
  }
  return value;
}

function cachedState(realPath, key) {
  const hit = stateCache.get(realPath);
  if (!hit || hit.key !== key) return undefined;
  stateCache.delete(realPath);
  stateCache.set(realPath, hit);
  return hit.value;
}

/** Replace this file's entry, then evict least-recently-used files over budget. */
function rememberState(realPath, key, value, bytes) {
  stateCache.delete(realPath);
  stateCache.set(realPath, { key, value, bytes });
  let total = 0;
  for (const entry of stateCache.values()) total += entry.bytes;
  for (const [oldest, entry] of stateCache) {
    if (total <= STATE_CACHE_BUDGET_BYTES || oldest === realPath) break;
    stateCache.delete(oldest);
    total -= entry.bytes;
  }
}

function warnIfNearCap(realPath, size, maxBytes) {
  if (Number(size) > maxBytes * 0.75 && !warnedLarge.has(realPath)) {
    warnedLarge.add(realPath);
    console.warn(`[project-board] a project-state.json exceeds 75% of the ${maxBytes}-byte cap`);
  }
}

/**
 * Read and parse a project's docs/project-state.json.
 *
 * Parsed values are cached per exact file version (dev, ino, size, mtimeNs,
 * ctimeNs) and shared by every caller, so treat `value` as read-only.
 *
 * @param {string} projectPath root returned by the visibility check
 * @param {{externalBinding?: string|null, maxBytes?: number}} [options]
 * @returns {{status: string, value?: unknown, realPath?: string, rootReal?: string, stat?: object}}
 */
export function readProjectBoardState(projectPath, options = {}) {
  const maxBytes = options.maxBytes ?? STATE_MAX_BYTES;
  return withValidatedFile(projectPath, BOARD_STATE_FILE, options, (fd, realPath) => {
    const read = readStable(fd, maxBytes, (stat) => cachedState(realPath, statKey(stat)));
    warnIfNearCap(realPath, read.stat.size, maxBytes);
    if (read.cached !== undefined) return { value: read.cached, stat: read.stat };
    const value = parseState(read.bytes);
    rememberState(realPath, statKey(read.stat), value, read.bytes.length);
    return { value, stat: read.stat };
  });
}

/** Whether a resolved state path lies outside the resolved project root (binding case). */
export function isExternalStatePath(realPath, rootReal) {
  return typeof realPath === 'string' && typeof rootReal === 'string' && !isWithin(realPath, rootReal);
}

export const __test__ = Object.freeze({
  stateCache,
  statKey,
  resetBindings() { bindingCache = { raw: undefined, map: new Map() }; },
  resetWarnings() { warnedLarge.clear(); },
});

/**
 * engine-pin-config-dir — ADR-200 S2 (D7, C1, M-6), out of the unified-keys flag.
 *
 * An engine-pinned Claude spawn (ADR-037) must carry no Anthropic credential
 * from any source the CLI loads (B-1541). The user-scope sources live in the
 * spawn's CLAUDE_CONFIG_DIR: `settings.json` (`env` keys, `apiKeyHelper`) and
 * `.claude.json` (`primaryApiKey`), plus the OAuth login in `.credentials.json`.
 * A user in API-key mode legitimately keeps a key there for official turns, so
 * the pinned spawn runs on a DERIVED, credential-free config dir instead:
 *
 *   - `settings.json` — a copy with every credential channel removed, then
 *     `applyOperatorPolicy` applied;
 *   - `.claude.json` — a COPY without `primaryApiKey` (never a link);
 *   - `.credentials.json` / legacy `.config.json` — never present;
 *   - `projects/` and the other shared, credential-free entries — linked to the
 *     source, so a pinned and an unpinned turn resume the same transcript.
 *
 * The source is the spawn's own config dir, which resolveProviderEnv already
 * pointed at the grantor's tree under a grant (ADR-152). The dir is rebuilt on
 * every pinned spawn under a lock keyed by its path (in-process queue plus a
 * cross-process lock dir), then re-read and verified. Any failure refuses the
 * spawn: leaking is never the fallback. Values are never logged.
 *
 * Managed, project and local settings are not rewritten here; the B-1541 guard
 * still runs on the final env and refuses when they hold a credential.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyOperatorPolicy } from './claude-managed-settings.js';
import {
  GLOBAL_CONFIG_FORBIDDEN,
  SETTINGS_ENV_FORBIDDEN,
  SETTINGS_TOP_LEVEL_FORBIDDEN,
  readJsonObject,
} from './engine-anthropic-credential-guard.js';

export const ENGINE_PIN_CONFIG_DIR_CODE = 'ENGINE_PIN_CONFIG_DIR_FAILED';
export const ENGINE_PIN_RESUME_CONTINUITY_CODE = 'ENGINE_PIN_RESUME_CONTINUITY';

/** Name of the derived dir, a sibling of the source config dir. */
export const DERIVED_DIR_NAME = '.claude-engine-pin';

/** Files that hold, or may come to hold, a credential; never present in the derived dir. */
export const DERIVED_FORBIDDEN_FILES = Object.freeze(['.credentials.json', '.config.json']);

/** Credential-free entries linked from the source. `projects` is required (resume). */
export const LINKED_ENTRIES = Object.freeze([
  'projects', 'CLAUDE.md', 'NASSAJ.md', 'AGENTS.md', 'agents', 'skills', 'plugins', 'commands',
  'output-styles', 'todos', 'file-history', 'plans', 'shell-snapshots', 'session-env', 'history.jsonl',
]);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 20;

/**
 * Builds the typed refusal. The message names no value.
 * @param {string} code
 * @param {string} reason
 * @returns {Error & {code: string}}
 */
function refusal(code, reason) {
  const error = new Error(
    'تعذّر تجهيز إعداد خالٍ من مفاتيح Anthropic لهذا المحرك، فرُفض التشغيل حمايةً للمفتاح. '
      + `Could not prepare a credential-free Claude config for this engine; the run was refused. (${reason})`,
  );
  return Object.assign(error, { code });
}

/**
 * Source config dir and global-config file the CLI would load for this env.
 * Mirrors the B-1541 guard: without CLAUDE_CONFIG_DIR the global config is ~/.claude.json.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{configDir: string, globalConfig: string}}
 */
export function sourceLayout(env) {
  const home = env.HOME || os.homedir();
  if (env.CLAUDE_CONFIG_DIR) {
    return { configDir: env.CLAUDE_CONFIG_DIR, globalConfig: path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') };
  }
  return { configDir: path.join(home, '.claude'), globalConfig: path.join(home, '.claude.json') };
}

/**
 * Path of the derived dir for a source config dir.
 * @param {string} sourceConfigDir
 * @returns {string}
 */
export function derivedConfigDirFor(sourceConfigDir) {
  return path.join(path.dirname(path.resolve(sourceConfigDir)), DERIVED_DIR_NAME);
}

/**
 * A copy of a settings object with every Anthropic credential channel removed.
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function stripSettingsCredentials(settings) {
  const next = { ...settings };
  for (const key of SETTINGS_TOP_LEVEL_FORBIDDEN) delete next[key];
  const env = next.env;
  if (env === undefined || env === null) return next;
  if (typeof env !== 'object' || Array.isArray(env)) {
    delete next.env;
    return next;
  }
  const cleanEnv = { ...env };
  for (const key of SETTINGS_ENV_FORBIDDEN) delete cleanEnv[key];
  next.env = cleanEnv;
  return next;
}

/**
 * A copy of a global config (.claude.json) without its stored API key.
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
export function stripGlobalConfigCredentials(config) {
  const next = { ...config };
  for (const key of GLOBAL_CONFIG_FORBIDDEN) delete next[key];
  return next;
}

/**
 * Creates the derived dir as a private real directory; refuses a symlink or a
 * non-directory in its place (it could redirect writes elsewhere).
 * @param {string} dir
 */
function ensurePrivateDir(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw refusal(ENGINE_PIN_CONFIG_DIR_CODE, 'derived path is not a real directory');
    }
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  fs.chmodSync(dir, DIR_MODE);
}

/**
 * Atomic JSON write (tmp + rename, 0600) inside the derived dir.
 * @param {string} file
 * @param {Record<string, unknown>} value
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Points `dest` at `src` with a symlink, replacing a stale link. A real entry
 * the CLI created earlier is left alone, except `projects`, which must be the
 * link (else the pinned and unpinned turns would write different transcripts).
 * @param {string} src
 * @param {string} dest
 * @param {string} name
 */
function linkEntry(src, dest, name) {
  let stat = null;
  try {
    stat = fs.lstatSync(dest);
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') throw error;
  }
  if (stat && !stat.isSymbolicLink()) {
    if (name === 'projects') {
      throw refusal(ENGINE_PIN_RESUME_CONTINUITY_CODE, 'derived projects/ is not linked to the source');
    }
    return;
  }
  if (stat && fs.readlinkSync(dest) === src) return;
  if (stat) fs.unlinkSync(dest);
  fs.symlinkSync(src, dest);
}

/**
 * Links the shared entries and proves resume continuity: the derived
 * `projects/` must resolve to the same real directory as the source's.
 * @param {string} sourceDir
 * @param {string} derivedDir
 */
function linkSharedEntries(sourceDir, derivedDir) {
  const sourceProjects = path.join(sourceDir, 'projects');
  if (!fs.existsSync(sourceProjects)) fs.mkdirSync(sourceProjects, { recursive: true, mode: DIR_MODE });
  for (const name of LINKED_ENTRIES) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) continue;
    linkEntry(src, path.join(derivedDir, name), name);
  }
  const same = fs.realpathSync(path.join(derivedDir, 'projects')) === fs.realpathSync(sourceProjects);
  if (!same) throw refusal(ENGINE_PIN_RESUME_CONTINUITY_CODE, 'derived projects/ resolves elsewhere');
}

/**
 * Re-reads the derived dir and refuses if any credential survived the build.
 * @param {string} derivedDir
 */
export function verifyDerivedConfigDir(derivedDir) {
  for (const name of DERIVED_FORBIDDEN_FILES) {
    if (fs.existsSync(path.join(derivedDir, name))) {
      throw refusal(ENGINE_PIN_CONFIG_DIR_CODE, `${name} present in derived dir`);
    }
  }
  const settings = readJsonObject(path.join(derivedDir, 'settings.json'), 'derived settings') ?? {};
  const config = readJsonObject(path.join(derivedDir, '.claude.json'), 'derived global config') ?? {};
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const leaked = [
    ...SETTINGS_TOP_LEVEL_FORBIDDEN.filter((key) => key in settings),
    ...SETTINGS_ENV_FORBIDDEN.filter((key) => key in env),
    ...GLOBAL_CONFIG_FORBIDDEN.filter((key) => key in config),
  ];
  if (leaked.length > 0) {
    throw refusal(ENGINE_PIN_CONFIG_DIR_CODE, `credential keys survived: ${leaked.join(', ')}`);
  }
}

/**
 * Rebuilds the derived dir from the source layout. Caller holds the lock.
 * @param {{configDir: string, globalConfig: string}} source
 * @param {string} derivedDir
 * @param {string} [operatorHome] whose ~/.claude policy is applied (test seam)
 */
function rebuildDerivedConfigDir(source, derivedDir, operatorHome) {
  ensurePrivateDir(derivedDir);
  for (const name of DERIVED_FORBIDDEN_FILES) fs.rmSync(path.join(derivedDir, name), { force: true });
  const settings = readJsonObject(path.join(source.configDir, 'settings.json'), 'user settings') ?? {};
  writeJsonAtomic(path.join(derivedDir, 'settings.json'), stripSettingsCredentials(settings));
  applyOperatorPolicy(derivedDir, operatorHome);
  const config = readJsonObject(source.globalConfig, 'global config', { retryOnce: true }) ?? {};
  writeJsonAtomic(path.join(derivedDir, '.claude.json'), stripGlobalConfigCredentials(config));
  linkSharedEntries(source.configDir, derivedDir);
  verifyDerivedConfigDir(derivedDir);
}

/** @type {Map<string, Promise<void>>} */
const inProcessLocks = new Map();

/**
 * True when a lock dir is abandoned: its owner pid is gone or it is too old.
 * @param {string} lockDir
 * @returns {boolean}
 */
function isStaleLock(lockDir) {
  try {
    const owner = Number(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'));
    if (Number.isInteger(owner) && owner > 0) process.kill(owner, 0);
    return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    return /** @type {{code?: string}} */ (error)?.code === 'ESRCH'
      || Date.now() - safeMtime(lockDir) > LOCK_STALE_MS;
  }
}

/**
 * Modification time of a path, or now when it vanished.
 * @param {string} file
 * @returns {number}
 */
function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Cross-process exclusive lock: an atomic mkdir next to the derived dir.
 * @param {string} lockDir
 * @returns {Promise<void>}
 */
async function acquireLockDir(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: DIR_MODE });
      fs.writeFileSync(path.join(lockDir, 'owner'), String(process.pid), { mode: FILE_MODE });
      return;
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code !== 'EEXIST') throw error;
    }
    if (isStaleLock(lockDir)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw refusal(ENGINE_PIN_CONFIG_DIR_CODE, 'derived dir lock timed out');
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Runs `operation` while holding the per-dir lock: one in-process queue per
 * derived dir, plus the cross-process lock dir, so no spawn sees a half-built dir.
 * @template T
 * @param {string} derivedDir
 * @param {() => Promise<T>|T} operation
 * @returns {Promise<T>}
 */
export async function withDerivedDirLock(derivedDir, operation) {
  const previous = inProcessLocks.get(derivedDir) ?? Promise.resolve();
  let release = () => {};
  const tail = new Promise((resolve) => { release = () => resolve(undefined); });
  const chained = previous.then(() => tail);
  inProcessLocks.set(derivedDir, chained);
  await previous;
  const lockDir = `${derivedDir}.lock`;
  try {
    await acquireLockDir(lockDir);
    try {
      return await operation();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } finally {
    release();
    if (inProcessLocks.get(derivedDir) === chained) inProcessLocks.delete(derivedDir);
  }
}

/**
 * Prepares the credential-free config dir for an engine-pinned spawn and
 * returns its path; the caller sets it as the child's CLAUDE_CONFIG_DIR.
 * Throws a typed refusal (never degrades to the source dir).
 * @param {NodeJS.ProcessEnv} env the spawn env, before CLAUDE_CONFIG_DIR is replaced
 * @param {{operatorHome?: string}} [opts] test seam for the operator policy home
 * @returns {Promise<string>}
 */
export async function prepareEnginePinConfigDir(env, opts = {}) {
  const source = sourceLayout(env);
  const derivedDir = derivedConfigDirFor(source.configDir);
  await withDerivedDirLock(derivedDir, () => rebuildDerivedConfigDir(source, derivedDir, opts.operatorHome));
  return derivedDir;
}

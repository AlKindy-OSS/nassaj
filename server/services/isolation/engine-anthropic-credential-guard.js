/**
 * engine-anthropic-credential-guard — B-1541.
 *
 * An engine-pinned Claude spawn (ADR-037: Kimi/GLM/DeepSeek behind the Claude
 * CLI) points ANTHROPIC_BASE_URL at the vendor. The CLI then sends WHATEVER
 * Anthropic credential it can find to that host: measured against CLI 2.1.288,
 * an `ANTHROPIC_API_KEY` in any settings `env` block, an `apiKeyHelper`, the
 * `.claude.json` `primaryApiKey`, or the spawn env's own ANTHROPIC_API_KEY all
 * reached the vendor as `x-api-key`. settings `env` beats the spawn env, so
 * blanking the variable in the env we build does not neutralise it.
 *
 * This guard reads every source the CLI loads for the spawn (spawn env, the
 * managed policy tier, user / project / local settings, and the global config
 * file) and REFUSES the spawn when any of them holds an Anthropic credential.
 * It never edits user files and never logs a value — only source labels and
 * key names leave this module.
 *
 * Fail-closed: a file that exists but cannot be read, or does not parse as a
 * JSON object, refuses the spawn. Only ENOENT/ENOTDIR count as "absent".
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAnthropicHostAllowed } from './anthropic-base-url-guard.js';

export const ENGINE_ANTHROPIC_CREDENTIAL_CODE = 'ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED';

/** Spawn-env names that carry an Anthropic credential or arbitrary auth headers.
 * ANTHROPIC_AUTH_TOKEN is absent on purpose: in the spawn env it IS the engine
 * key that apply-claude-engine-provider-env.js just set. */
const SPAWN_ENV_FORBIDDEN = Object.freeze([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'ANTHROPIC_CUSTOM_HEADERS',
]);

/** In a settings `env` block ANTHROPIC_AUTH_TOKEN would override the engine key
 * we set, so a settings file may not carry it either. */
const SETTINGS_ENV_FORBIDDEN = Object.freeze([...SPAWN_ENV_FORBIDDEN, 'ANTHROPIC_AUTH_TOKEN']);

/** Top-level settings keys that make the CLI produce a credential. */
const SETTINGS_TOP_LEVEL_FORBIDDEN = Object.freeze(['apiKeyHelper']);

/** Top-level global-config (.claude.json) keys holding a stored API key. */
const GLOBAL_CONFIG_FORBIDDEN = Object.freeze(['primaryApiKey']);

/** Managed (policy) settings locations the CLI always loads, per platform. */
const MANAGED_SETTINGS_DIR = Object.freeze({
  linux: '/etc/claude-code',
  darwin: '/Library/Application Support/ClaudeCode',
  win32: 'C:\\Program Files\\ClaudeCode',
});

/**
 * True when a value would be honoured as a credential: anything except
 * undefined, null, or a blank string.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPresent(value) {
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

/** Pause before the single re-read of a global config that failed to parse. */
const GLOBAL_CONFIG_RETRY_MS = 20;

/**
 * Reads one file. `null` when absent; `{ raw }` otherwise; throws a typed
 * refusal when it exists but cannot be read.
 * @param {string} file
 * @param {string} label
 * @returns {{raw: string}|null}
 */
function readRaw(file, label) {
  try {
    return { raw: readFileSync(file, 'utf8') };
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw credentialRefusal([{ source: label, file, key: `<unreadable:${code ?? 'error'}>` }]);
  }
}

/**
 * Parses a JSON object; whitespace-only counts as `{}`. `undefined` when the
 * text is not a JSON object.
 * @param {string} raw
 * @returns {Record<string, unknown>|undefined}
 */
function parseObject(raw) {
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * Reads and parses a JSON object file. `null` when absent; throws a typed
 * refusal when it exists but is unreadable or not a JSON object.
 *
 * `retryOnce` is for the CLI's global config (.claude.json), which a running
 * CLI rewrites often: one re-read after a short pause avoids refusing on a torn
 * read. A file that is still malformed after it is refused.
 * @param {string} file
 * @param {string} label
 * @param {{retryOnce?: boolean}} [opts]
 * @returns {Record<string, unknown>|null}
 */
function readJsonObject(file, label, opts = {}) {
  let read = readRaw(file, label);
  if (read === null) return null;
  let parsed = parseObject(read.raw);
  if (parsed === undefined && opts.retryOnce) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, GLOBAL_CONFIG_RETRY_MS);
    read = readRaw(file, label);
    if (read === null) return null;
    parsed = parseObject(read.raw);
  }
  if (parsed !== undefined) return parsed;
  throw credentialRefusal([{ source: label, file, key: '<malformed-json>' }]);
}

/**
 * Lists forbidden credential names found in one settings object.
 * @param {Record<string, unknown>} settings
 * @param {string} label
 * @param {string} file
 * @returns {Array<{source:string, file:string, key:string}>}
 */
function settingsFindings(settings, label, file) {
  const findings = [];
  for (const key of SETTINGS_TOP_LEVEL_FORBIDDEN) {
    if (isPresent(settings[key])) findings.push({ source: label, file, key });
  }
  const env = settings.env;
  if (env === undefined || env === null) return findings;
  if (typeof env !== 'object' || Array.isArray(env)) {
    return [...findings, { source: label, file, key: '<malformed-env>' }];
  }
  for (const key of SETTINGS_ENV_FORBIDDEN) {
    if (isPresent(env[key])) findings.push({ source: label, file, key: `env.${key}` });
  }
  return findings;
}

/**
 * Nearest ancestor of `cwd` (inclusive) that contains `.git`, or null.
 * @param {string} cwd
 * @returns {string|null}
 */
function findGitRoot(cwd) {
  let dir = cwd;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every settings file the CLI may load for this spawn, with a stable label.
 * Project/local settings are checked at the cwd AND at its git root, since the
 * CLI may resolve the project root either way.
 * @param {string} configDir
 * @param {string} cwd
 * @param {string} managedDir
 * @returns {Array<{file:string, label:string}>}
 */
function settingsFiles(configDir, cwd, managedDir) {
  const files = [
    { file: path.join(managedDir, 'managed-settings.json'), label: 'managed policy settings' },
    ...managedDropIns(managedDir),
    { file: path.join(configDir, 'settings.json'), label: 'user settings' },
  ];
  const roots = [cwd, findGitRoot(cwd)].filter((dir, i, all) => dir && all.indexOf(dir) === i);
  for (const root of roots) {
    files.push({ file: path.join(root, '.claude', 'settings.json'), label: 'project settings' });
    files.push({ file: path.join(root, '.claude', 'settings.local.json'), label: 'local project settings' });
  }
  return files;
}

/**
 * Drop-in policy fragments (`managed-settings.d/*.json`). An unreadable
 * directory that exists refuses the spawn.
 * @param {string} managedDir
 * @returns {Array<{file:string, label:string}>}
 */
function managedDropIns(managedDir) {
  const dir = path.join(managedDir, 'managed-settings.d');
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw credentialRefusal([{ source: 'managed policy settings', file: dir, key: `<unreadable:${code}>` }]);
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ file: path.join(dir, name), label: 'managed policy settings' }));
}

/**
 * Global config files the CLI reads its stored API key from.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} configDir
 * @param {string} home the child's home (same value configDir derives from)
 * @returns {string[]}
 */
function globalConfigFiles(env, configDir, home) {
  if (env.CLAUDE_CONFIG_DIR) {
    return [path.join(configDir, '.claude.json'), path.join(configDir, '.config.json')];
  }
  return [path.join(home, '.claude.json'), path.join(configDir, '.config.json')];
}

/**
 * True when the env routes the CLI to a host the official allowlist does not
 * cover, i.e. an engine-pinned env. For callers that receive a resolved env
 * without the engine verdict (the managed-terminal wrapper). Official Anthropic,
 * flag-enabled Bedrock/Vertex and operator-allowlisted proxies
 * (NASSAJ_ALLOWED_ANTHROPIC_HOSTS in the same env) are not engine routing, the
 * same rule the server-side guard applies. An unparseable URL counts as routed.
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isEngineRoutedEnv(env) {
  const raw = env.ANTHROPIC_BASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  let host;
  try {
    host = new URL(raw.trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return true;
  }
  return !host || !isAnthropicHostAllowed(host, env);
}

/** CLI flags that inject or re-select settings sources from the command line.
 * `--settings` accepts inline JSON or a file path, so it can carry `env` keys or
 * an `apiKeyHelper` that no file on disk shows. */
const SETTINGS_OVERRIDE_FLAGS = Object.freeze(['--settings', '--setting-sources']);

/**
 * Refuses a command line that overrides settings for an engine-pinned launch.
 * The WHOLE argv is scanned: the CLI consumes a `--` that follows a
 * value-taking option as that option's value and keeps parsing options after
 * it (measured, CLI 2.1.288), so `--` is not a safe end-of-options marker here.
 * A prompt that literally contains `--settings` is refused too; that
 * over-refusal is accepted on this path.
 * @param {readonly string[]} argv the argv the real CLI will receive
 * @returns {void}
 * @throws {Error} code ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED
 */
export function assertNoSettingsOverrideArgv(argv) {
  const findings = [];
  for (const arg of argv) {
    const flag = SETTINGS_OVERRIDE_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag) findings.push({ source: 'command line', file: '', key: flag });
  }
  if (findings.length > 0) throw credentialRefusal(findings);
}

/**
 * Builds the typed refusal. The message names sources and key names only.
 * @param {Array<{source:string, file:string, key:string}>} findings
 * @returns {Error & {code:string, findings:Array<{source:string, file:string, key:string}>}}
 */
export function credentialRefusal(findings) {
  const where = [...new Set(findings.map((f) => `${f.source}: ${f.key}`))].join('; ');
  const error = new Error(
    'مفتاح Anthropic مخزَّن في موضع سيصل منه إلى هذا المحرك؛ احذفه أو شغّل المحادثة على Claude مباشرة. ' +
      'An Anthropic key is stored where this engine would receive it; remove it or use Claude directly. ' +
      `(${where})`,
  );
  error.code = ENGINE_ANTHROPIC_CREDENTIAL_CODE;
  error.findings = findings;
  return /** @type {any} */ (error);
}

/**
 * Refuses an engine-pinned spawn when any source the Claude CLI loads holds an
 * Anthropic credential. Call ONLY for engine-pinned runs; the official path may
 * legitimately carry ANTHROPIC_API_KEY.
 *
 * @param {NodeJS.ProcessEnv} env the exact env the child will receive
 * @param {{cwd?: string|null, managedSettingsDir?: string}} [ctx] the child's
 *   working directory (defaults to this process's cwd, which is what the CLI
 *   inherits when the spawn sets none); managedSettingsDir is a test seam
 * @returns {void}
 * @throws {Error} code ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED
 */
export function assertNoAnthropicCredentialForEngine(env, ctx = {}) {
  const findings = SPAWN_ENV_FORBIDDEN
    .filter((key) => isPresent(env[key]))
    .map((key) => ({ source: 'spawn environment', file: '', key }));

  // The CHILD's home: the CLI resolves ~ from the HOME it is spawned with.
  const home = env.HOME || os.homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const managedDir = ctx.managedSettingsDir ?? MANAGED_SETTINGS_DIR[process.platform] ?? MANAGED_SETTINGS_DIR.linux;

  for (const { file, label } of settingsFiles(configDir, cwd, managedDir)) {
    const settings = readJsonObject(file, label);
    if (settings) findings.push(...settingsFindings(settings, label, file));
  }
  for (const file of globalConfigFiles(env, configDir, home)) {
    const config = readJsonObject(file, 'global config', { retryOnce: true });
    if (!config) continue;
    for (const key of GLOBAL_CONFIG_FORBIDDEN) {
      if (isPresent(config[key])) findings.push({ source: 'global config', file, key });
    }
  }
  if (findings.length > 0) throw credentialRefusal(findings);
}

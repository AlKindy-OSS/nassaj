/**
 * dsh-launch — the governed launch seam of the DeepSeek Harness body (T-2086 S2,
 * ADR-224). Pure builders plus ONE ordered preparation step; it never spawns.
 * The ACP runtime (dsh-acp-runtime.js) calls `prepareDshLaunch` and spawns
 * exactly the `{ command, args, env }` it returns.
 *
 * THE ORDER (do not reorder; each step fails closed before any process exists):
 *   1. resolveModelRunEnv(actor, 'dsh', …, { honorGrants: false })
 *        credential gate: the member's OWN deepseek key slot (CREDENTIAL_NOT_LINKED
 *        otherwise), then the isolated env (HOME = member tree, the member's key).
 *   2. the member's dsh dirs (<HOME>/.dsh, <HOME>/.agents, <HOME>/.tmp) exist as
 *      real directories (a planted symlink is unlinked, never followed).
 *   3. ensureVendorCliGovernance('dsh', <HOME>/.dsh, neutral source)
 *        AGENTS.md 0444 copy, one self-heal, else governance_missing.
 *   4. the user patch layers a turn could write (<DSH_HOME>/cordis.patch.yml and
 *      the nassaj-acp profile's) are deleted.
 *   5. the shipped Nassaj patch layer and the policy plugin it names (T-2089) are verified
 *      against their sha256 pins.
 *   6. the dsh CLI (harness registry, DSH_PATH server override) must be a Node
 *      script, run by an absolute node >= 24.9.0 (PATH is restricted below).
 *      Without the override it must be the entry of a Nassaj-installed reviewed
 *      pin whose tree passed its full sha256 manifest check (T-2086 S4,
 *      npm-lock/trust.ts; unconditional, not behind NASSAJ_VENDOR_BINARY_PIN).
 *   7. the env is rebuilt FROM SCRATCH as an exact allow-list; nothing inherited
 *      from the server survives (no *_BASE_URL, ANTHROPIC_*, XDG_*, NODE_OPTIONS).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { credentialNotLinkedError, resolveModelRunEnv } from '../../../../services/isolation/credential-gate.js';
import { neutralGovernanceSource } from '../../../../services/isolation/codex-governance-material.js';
import { sanitizeVendorAgentEnv } from '../../../../services/isolation/sanitize-vendor-agent-env.js';
import { ensureVendorCliGovernance } from '../../../../services/isolation/vendor-cli-governance.js';
import { resolveHarnessBinary } from '../../../../shared/harness-binaries.js';
import { npmLockLaunchRefusal } from '../../harness-update/npm-lock/trust.js';
import { findAppRoot, getModuleDir } from '../../../../utils/runtime-paths.js';

/** The fixed PATH of a dsh child: no operator or member bin dir is reachable. */
export const DSH_CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';
/** The dsh profile Nassaj runs, re-derived from `acp` on every launch. */
export const DSH_PROFILE = 'nassaj-acp';
export const DSH_BASE_PROFILE = 'acp';
/** The lowest node dsh supports (package engines, verified 2026-11-07). */
export const DSH_MIN_NODE_VERSION = '24.9.0';
/** The governance filename dsh reads from DSH_HOME. */
export const DSH_GOVERNANCE_FILENAME = 'AGENTS.md';
/** sha256 of server/governance/dsh-nassaj-layer.yml; an edit there must update it. */
export const DSH_LAYER_SHA256 = '77a541193140793189cf4a0e0d8040759ecacc8b8744c094efebfd94522fae2c';
/**
 * sha256 of each file of server/governance/dsh-policy-plugin/ (T-2091): index.mjs is the plugin,
 * package.json carries the engines.dsh range dsh enforces. An edit there must update the pin.
 */
export const DSH_POLICY_PLUGIN_SHA256 = Object.freeze({
  'index.mjs': '4ce12e3a7db3a01cb4e82e0dd9c5f811dc2225cac2f73fd5d40ee9dc09ca7955',
  'package.json': '22385336d77b6af3da14790840d213ac51f988a753cfeeb8fb4fa72b22072a88',
});

/** The exact env keys a dsh child receives (sorted). */
export const DSH_ENV_ALLOW_LIST = Object.freeze([
  'DEEPSEEK_API_KEY', 'DSH_AGENTS_HOME', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'HOME', 'LANG', 'PATH', 'TERM',
  'TMPDIR',
]);

/** Refusal codes of this seam (credential and governance keep their own codes). */
export const DSH_LAUNCH_ERROR = Object.freeze({
  NODE_UNSUPPORTED: 'dsh_node_unsupported',
  BINARY_NOT_NODE: 'dsh_binary_not_node',
  LAYER_UNTRUSTED: 'dsh_layer_untrusted',
  USER_LAYER_RESET_FAILED: 'dsh_user_layer_reset_failed',
  HOME_NOT_DIRECTORY: 'dsh_home_not_directory',
  ENV_NOT_EXACT: 'dsh_env_not_exact',
  /** The install tree differs from its reviewed manifest (planted/edited file). */
  TREE_TAMPERED: 'dsh_tree_tampered',
  /** The tree's full check has not finished yet (it was started; retry shortly). */
  TREE_UNVERIFIED: 'dsh_tree_unverified',
  /** The launcher is not the entry of a Nassaj-installed reviewed pin. */
  TREE_UNMANAGED: 'dsh_tree_unmanaged',
  /** The Nassaj policy plugin is missing, a symlink, or altered (T-2089). */
  POLICY_PLUGIN_UNTRUSTED: 'dsh_policy_plugin_untrusted',
  /** A DSH_PATH override whose composed --dump-config lacks a Nassaj security row state (T-2091). */
  OVERRIDE_UNVERIFIED: 'dsh_override_unverified',
});

const TREE_REFUSALS = Object.freeze({
  tree_tampered: [DSH_LAUNCH_ERROR.TREE_TAMPERED, 'The DeepSeek Harness install was altered; reinstall it from Settings.'],
  tree_unverified: [DSH_LAUNCH_ERROR.TREE_UNVERIFIED, 'The DeepSeek Harness install is being verified; try again shortly.'],
  tree_unmanaged: [DSH_LAUNCH_ERROR.TREE_UNMANAGED, 'DeepSeek Harness was not installed by Nassaj; install it from Settings.'],
});

/** A fail-closed refusal of the dsh launch seam; `code` is one of DSH_LAUNCH_ERROR. */
export class DshLaunchError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'DshLaunchError';
    this.code = code;
  }
}

const SAFE_LOCALE = /^[A-Za-z0-9_.@-]{1,64}$/;

/** The dsh directories derived from a member home. */
export function dshPaths(home) {
  return {
    home,
    dshHome: path.join(home, '.dsh'),
    agentsHome: path.join(home, '.agents'),
    tmpDir: path.join(home, '.tmp'),
  };
}

/** The shipped Nassaj patch layer (release tree, never a member tree). */
export function nassajDshLayerPath() {
  return path.join(findAppRoot(getModuleDir(import.meta.url)), 'server', 'governance', 'dsh-nassaj-layer.yml');
}

/** The shipped policy plugin, named relatively from the main layer (release tree). */
export function nassajDshPolicyPluginPath() {
  return path.join(findAppRoot(getModuleDir(import.meta.url)), 'server', 'governance', 'dsh-policy-plugin');
}

/**
 * The launch argv after the dsh script: the nassaj-acp profile re-derived from
 * `acp` (which resets that profile's user layer), the Nassaj layer LAST (and only).
 * @param {string} layerPath the Nassaj layer
 * @returns {string[]}
 */
export function buildDshLaunchArgv(layerPath) {
  return [DSH_PROFILE, '--from-default-profile', DSH_BASE_PROFILE, '--patch', layerPath];
}

/**
 * The child env, built from scratch: exactly DSH_ENV_ALLOW_LIST.
 * @param {{ home: string, apiKey: string, serverEnv?: NodeJS.ProcessEnv }} input
 * @returns {Record<string, string>}
 */
export function buildDshLaunchEnv({ home, apiKey, serverEnv = process.env }) {
  const { dshHome, agentsHome, tmpDir } = dshPaths(home);
  const locale = (value, fallback) => (typeof value === 'string' && SAFE_LOCALE.test(value) ? value : fallback);
  return {
    PATH: DSH_CHILD_PATH,
    HOME: home,
    LANG: locale(serverEnv.LANG, 'C.UTF-8'),
    TERM: locale(serverEnv.TERM, 'dumb'),
    TMPDIR: tmpDir,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DEEPSEEK_API_KEY: apiKey,
    DSH_TELEMETRY_DISABLED: '1',
  };
}

/** Throws unless `env` holds exactly the allow-list keys, each a non-empty string. */
export function assertExactDshEnv(env) {
  const keys = Object.keys(env).sort();
  const exact = keys.length === DSH_ENV_ALLOW_LIST.length && keys.every((key, i) => key === DSH_ENV_ALLOW_LIST[i]);
  if (!exact || keys.some((key) => typeof env[key] !== 'string' || env[key] === '')) {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.ENV_NOT_EXACT, 'dsh launch env is not the exact allow-list.');
  }
  return env;
}

/** True when `version` (x.y.z, optional leading v) is >= DSH_MIN_NODE_VERSION. */
export function isSupportedNodeVersion(version) {
  const parse = (text) => String(text).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10));
  const have = parse(version);
  const need = parse(DSH_MIN_NODE_VERSION);
  if (have.length < 3 || have.some((part) => !Number.isFinite(part))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/**
 * The absolute node that runs dsh: the server's own runtime, verified (absolute,
 * executable, >= DSH_MIN_NODE_VERSION). No PATH lookup: the child PATH holds no
 * nvm/user bin, so `#!/usr/bin/env node` would find the wrong node or none.
 * @param {{ execPath?: string, version?: string }} [runtime]
 * @returns {string}
 */
export function resolveDshNode({ execPath = process.execPath, version = process.versions.node } = {}) {
  const runnable = path.isAbsolute(execPath) && (() => {
    try { fs.accessSync(execPath, fs.constants.X_OK); return fs.statSync(execPath).isFile(); } catch { return false; }
  })();
  if (!runnable) {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.NODE_UNSUPPORTED, 'The node runtime for dsh is not an executable file.');
  }
  if (!isSupportedNodeVersion(version)) {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.NODE_UNSUPPORTED,
      `dsh needs node >= ${DSH_MIN_NODE_VERSION}; the server runs ${version}.`);
  }
  return execPath;
}

/** Throws unless the resolved dsh CLI is a Node script (js extension or node shebang). */
export function assertNodeScript(binPath) {
  let real;
  let head = '';
  try {
    real = fs.realpathSync(binPath);
    const fd = fs.openSync(real, 'r');
    try {
      const buffer = Buffer.alloc(128);
      head = buffer.subarray(0, fs.readSync(fd, buffer, 0, 128, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.BINARY_NOT_NODE, 'The dsh CLI cannot be read.');
  }
  const firstLine = head.split('\n')[0];
  if (/\.[cm]?js$/.test(real) || (firstLine.startsWith('#!') && /\bnode\b/.test(firstLine))) return real;
  throw new DshLaunchError(DSH_LAUNCH_ERROR.BINARY_NOT_NODE, 'The dsh CLI is not a Node script.');
}

/**
 * Boot warning: a DSH_PATH operator override makes every dsh launch run that
 * exact file without the managed install-tree check. Never silent; the path
 * itself is not logged. Returns true when the override is set.
 * @param {(message: string, details: Record<string, unknown>) => void} [warn]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function warnDshPathOverride(warn = console.warn, env = process.env) {
  if ((env.DSH_PATH ?? '').trim() === '') return false;
  warn('[dsh] DSH_PATH operator override is set: dsh launches run that file and skip the managed '
    + 'install-tree check (version status reports operatorOverride)', { env: 'DSH_PATH', treeCheckSkipped: true });
  return true;
}

/**
 * Refuses a dsh CLI whose install tree is not a verified reviewed pin. A
 * DSH_PATH operator override names an exact file outside the managed tree and
 * is taken as the operator's choice (the registry already checked it).
 * @param {string} script the registry-resolved dsh CLI
 * @param {{ serverEnv?: NodeJS.ProcessEnv, home?: string }} [options]
 */
export function assertDshTreeTrusted(script, { serverEnv = process.env, home } = {}) {
  if ((serverEnv.DSH_PATH ?? '').trim() !== '') return;
  const refusal = npmLockLaunchRefusal(script, home);
  if (!refusal) return;
  const [code, message] = TREE_REFUSALS[refusal];
  throw new DshLaunchError(code, message);
}

/** Verifies the shipped layer: a regular file (no symlink) whose bytes match the pin. */
export function verifyNassajDshLayer(file = nassajDshLayerPath(), expected = DSH_LAYER_SHA256) {
  let digest = null;
  try {
    if (fs.lstatSync(file).isFile()) digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    digest = null;
  }
  if (digest !== expected) {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.LAYER_UNTRUSTED, 'The Nassaj dsh patch layer is missing or altered.');
  }
  return file;
}

/** Verifies the policy plugin dir: each pinned file regular (no symlink) and matching its pin. */
export function verifyNassajDshPolicyPlugin(dir = nassajDshPolicyPluginPath(), expected = DSH_POLICY_PLUGIN_SHA256) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('not a directory');
    for (const [file, sha] of Object.entries(expected)) verifyNassajDshLayer(path.join(dir, file), sha);
    return dir;
  } catch {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.POLICY_PLUGIN_UNTRUSTED, 'The Nassaj dsh policy plugin is missing or altered.');
  }
}

/** Deletes the user patch layers a turn could have written into its own DSH_HOME. */
export function resetDshUserLayers(dshHome) {
  const files = [path.join(dshHome, 'cordis.patch.yml'), path.join(dshHome, 'profiles', DSH_PROFILE, 'cordis.patch.yml')];
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true, recursive: true });
    } catch {
      throw new DshLaunchError(DSH_LAUNCH_ERROR.USER_LAYER_RESET_FAILED, 'A dsh user patch layer cannot be removed.');
    }
  }
}

/** Makes `dir` a real 0700 directory; a symlink is unlinked (never followed). */
export function ensureRealDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) fs.unlinkSync(dir);
    else if (stat && !stat.isDirectory()) throw new Error('not a directory');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.HOME_NOT_DIRECTORY, 'A dsh home directory cannot be prepared.');
  }
}

/**
 * Runs the ordered seam for one dsh launch (see the file header). Throws
 * CREDENTIAL_NOT_LINKED (AppError), VendorGovernanceMissingError
 * (governance_missing), HarnessBinaryUnresolvedError or DshLaunchError; no
 * process exists on any throw.
 * @param {{ userId: unknown }} input
 * @param {{ serverEnv?: NodeJS.ProcessEnv, layerPath?: string }} [options]
 * @returns {{ command: string, args: string[], env: Record<string, string>, home: string, dshHome: string }}
 */
export function prepareDshLaunch({ userId }, options = {}) {
  const serverEnv = options.serverEnv ?? process.env;
  const resolved = resolveModelRunEnv(userId, 'dsh', serverEnv, 'agent', { honorGrants: false });
  const home = resolved.HOME;
  const apiKey = resolved.DEEPSEEK_API_KEY;
  if (typeof apiKey !== 'string' || apiKey === '') throw credentialNotLinkedError('deepseek', null);

  const { dshHome, agentsHome, tmpDir } = dshPaths(home);
  for (const dir of [dshHome, agentsHome, tmpDir]) ensureRealDirectory(dir);
  ensureVendorCliGovernance('dsh', dshHome, neutralGovernanceSource(), { filename: DSH_GOVERNANCE_FILENAME });
  resetDshUserLayers(dshHome);
  const layerPath = verifyNassajDshLayer(options.layerPath ?? nassajDshLayerPath());
  verifyNassajDshPolicyPlugin(path.join(path.dirname(layerPath), 'dsh-policy-plugin'));

  // Resolved ONCE per launch (T-2091): the real entry is checked and spawned, so an update that
  // renames the launcher link meanwhile cannot change the version this launch runs.
  const script = assertNodeScript(resolveHarnessBinary('dsh'));
  assertDshTreeTrusted(script, { serverEnv });
  const command = resolveDshNode();
  const env = assertExactDshEnv(sanitizeVendorAgentEnv(buildDshLaunchEnv({ home, apiKey, serverEnv })));
  return { command, args: [script, ...buildDshLaunchArgv(layerPath)], env, home, dshHome, script, layerPath };
}

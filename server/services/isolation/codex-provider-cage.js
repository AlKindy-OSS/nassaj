/**
 * Experimental, fail-closed Codex-only bubblewrap launch builder.
 *
 * This seam is deliberately NOT wired to openai-codex.js. It exists so the
 * allowlist cage can be reviewed and tested before any live launch changes.
 * Unlike provider-cage.js, it never exposes the host root and never returns an
 * uncaged passthrough.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBwrapPath } from './provider-cage.js';

export const CODEX_CAGE_RUNTIME_READ_PATHS = Object.freeze([
  '/usr',
  '/bin',
  '/lib',
  '/lib64',
  '/etc/ld.so.cache',
  '/etc/ssl/certs',
]);

/**
 * Operator-owned trees that must never become writable project mounts.
 *
 * `.local` is load-bearing, not decorative: the LIVE application database lives
 * at `$HOME/.local/share/nassaj-dev/db.sqlite` (DATABASE_PATH in .env), so
 * without this entry a "project" could be declared on top of the DB — users,
 * roles, sessions, app_config — and ADR-068 §11's promise that the cage cannot
 * see the DB would be false. `.gnupg` (private keys) and `.kube` (cluster
 * credentials) are the same class as the .ssh/.aws entries already here.
 */
export const OPERATOR_SENSITIVE_DIR_NAMES = Object.freeze([
  '.nassaj-users',
  '.codex',
  '.hermes',
  '.npm',
  '.cache',
  '.ssh',
  '.claude',
  '.config',
  '.docker',
  '.aws',
  '.local',
  '.gnupg',
  '.kube',
]);

/** Error raised when a Codex launch cannot be caged safely. */
export class CodexCageError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CodexCageError';
    this.code = code;
  }
}

/** @param {unknown} value @param {string} name @returns {string} */
function requiredAbsolutePath(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CodexCageError(`missing-${name}`, `${name} is required`);
  }
  if (!path.isAbsolute(value)) {
    throw new CodexCageError(`invalid-${name}`, `${name} must be absolute`);
  }
  return path.normalize(value);
}

/** @param {string} candidate @param {string} name */
function forbidRootMount(candidate, name) {
  if (candidate === path.parse(candidate).root) {
    throw new CodexCageError(`invalid-${name}`, `${name} cannot be a filesystem root`);
  }
}

/** @param {unknown} value @returns {string[]} */
function requiredStringArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CodexCageError('invalid-args', 'args must be an array of strings');
  }
  return value;
}

/** @param {string} candidate @param {string} name @param {object} io */
function requireDirectory(candidate, name, io) {
  try {
    if (io.statSync(candidate).isDirectory()) return;
  } catch {
    // Normalized below into a stable fail-closed error.
  }
  throw new CodexCageError(`invalid-${name}`, `${name} must be an existing directory`);
}

/** @param {string} candidate @param {string} name @param {object} io */
function requireExecutable(candidate, name, io) {
  try {
    if (!io.statSync(candidate).isFile()) throw new Error('not a file');
    io.accessSync(candidate, fs.constants.X_OK);
    return;
  } catch {
    throw new CodexCageError(`invalid-${name}`, `${name} must be an executable file`);
  }
}

/** @param {string} candidate @param {string} name @param {object} io @returns {string} */
function canonicalPath(candidate, name, io) {
  try {
    return io.realpathSync(candidate);
  } catch {
    throw new CodexCageError(`invalid-${name}`, `${name} cannot be resolved safely`);
  }
}

/** @param {unknown} value @returns {string} */
function requiredUserId(value) {
  const userId = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(userId)) {
    throw new CodexCageError('invalid-user-id', 'userId must be a positive integer');
  }
  return userId;
}

/** @param {string} codexHome @param {string} userId */
function requirePerUserCodexHome(codexHome, userId) {
  const expectedTail = path.join('.nassaj-users', userId, '.codex');
  if (!codexHome.endsWith(`${path.sep}${expectedTail}`)) {
    throw new CodexCageError(
      'invalid-codex-home',
      `CODEX_HOME must be the per-user .nassaj-users/${userId}/.codex directory`,
    );
  }
}

/** @param {string} first @param {string} second @returns {boolean} */
function pathsOverlap(first, second) {
  const relative = path.relative(first, second);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

/** @param {string} candidate @param {string[]} roots @returns {boolean} */
function pathWithinAny(candidate, roots) {
  return roots.some((root) => pathsOverlap(root, candidate));
}

/** @param {string} candidate @param {string[]} roots @returns {boolean} */
function pathEqualOrWithinAny(candidate, roots) {
  return roots.some((root) => candidate === root || pathsOverlap(root, candidate));
}

/** @param {string} codexHome @param {string} cwd */
function requireDisjointWritableMounts(codexHome, cwd) {
  if (pathsOverlap(codexHome, cwd) || pathsOverlap(cwd, codexHome)) {
    throw new CodexCageError(
      'overlapping-writable-paths',
      'CODEX_HOME and cwd must be disjoint writable mounts',
    );
  }
}

/** @param {string[]} candidates @param {object} io @returns {string[]} */
function existingRuntimePaths(candidates, io) {
  return candidates
    .map((candidate) => requiredAbsolutePath(candidate, 'runtime-path'))
    .map((candidate) => {
      forbidRootMount(candidate, 'runtime-path');
      return candidate;
    })
    .filter((candidate) => io.existsSync(candidate));
}

/** @param {string} candidate @param {string} name */
function forbidCanonicalRoot(candidate, name) {
  forbidRootMount(candidate, name);
}

/** @param {string[]} runtimePaths @param {string} operatorHome */
function requireNarrowRuntimePaths(runtimePaths, operatorHome) {
  const broadRoots = ['/', '/home', '/root', '/tmp', '/var', '/etc', '/proc', '/dev', '/run', '/sys'];
  for (const runtimePath of runtimePaths) {
    forbidCanonicalRoot(runtimePath, 'runtime-path');
    if (broadRoots.includes(runtimePath) || pathEqualOrWithinAny(runtimePath, [operatorHome])) {
      throw new CodexCageError(
        'invalid-runtime-path',
        'runtime paths cannot expose broad host or operator-home trees',
      );
    }
  }
}

/** @param {string} candidate @param {object} io @returns {string} */
function canonicalIfPresent(candidate, io) {
  try {
    return io.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/** @param {string} operatorHome @param {object} io @returns {string[]} */
function operatorDataRoots(operatorHome, io) {
  return OPERATOR_SENSITIVE_DIR_NAMES.map((name) =>
    canonicalIfPresent(path.join(operatorHome, name), io),
  );
}

/** @param {string} candidate @param {string} operatorHome @param {object} io */
function isSensitiveWritablePath(candidate, operatorHome, io) {
  const pseudoFilesystems = ['/proc', '/dev', '/run', '/sys'];
  const broadRoots = ['/', '/tmp', '/home', '/root', '/var', '/etc', operatorHome];
  return (
    broadRoots.includes(candidate) ||
    pathEqualOrWithinAny(candidate, pseudoFilesystems) ||
    pathEqualOrWithinAny(candidate, operatorDataRoots(operatorHome, io))
  );
}

/**
 * Require cwd to be inside a separately attested project root.
 * @param {string} cwd @param {string} projectRoot @param {string} codexHome
 * @param {string} operatorHome @param {object} io
 */
function requireTrustedProjectCwd(cwd, projectRoot, codexHome, operatorHome, io) {
  if (isSensitiveWritablePath(projectRoot, operatorHome, io)) {
    throw new CodexCageError('invalid-project-root', 'trustedProjectRoot is host-sensitive');
  }
  if (isSensitiveWritablePath(cwd, operatorHome, io) || !pathsOverlap(projectRoot, cwd)) {
    throw new CodexCageError('invalid-cwd', 'cwd must be inside the trusted project root');
  }
  if (pathsOverlap(projectRoot, codexHome) || pathsOverlap(codexHome, projectRoot)) {
    throw new CodexCageError(
      'invalid-project-root',
      'trustedProjectRoot must be disjoint from CODEX_HOME',
    );
  }
}

/** @param {string} codexHome @returns {string[]} */
function isolatedEnvironmentArgs(codexHome) {
  return [
    '--clearenv',
    '--setenv',
    'CODEX_HOME',
    codexHome,
    '--setenv',
    'HOME',
    path.dirname(codexHome),
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8',
  ];
}

/** @param {string[]} runtimePaths @returns {string[]} */
function readOnlyMountArgs(runtimePaths) {
  return runtimePaths.flatMap((runtimePath) => ['--ro-bind', runtimePath, runtimePath]);
}

/**
 * Re-creates, INSIDE the cage, any runtime path that is a symlink on the host.
 *
 * Why this is required and not cosmetic: on a merged-/usr host (this one)
 * `/bin -> usr/bin`, `/lib -> usr/lib`, `/lib64 -> usr/lib64`. canonicalPath
 * resolves those before the mount, so `--ro-bind` only ever creates
 * `/usr/bin`, `/usr/lib`, … and the cage has NO `/bin` at all. Every
 * `#!/bin/sh` script — and the `PATH=/usr/bin:/bin` this cage itself sets —
 * would then fail with ENOENT the moment the seam is wired to a live launch.
 * Emitting `--symlink usr/bin /bin` reproduces the host layout exactly.
 *
 * The link target is derived from the canonical path (relative to the link's
 * own directory), so it points at a tree that IS mounted read-only above; a
 * symlink is never emitted for a path that was not a symlink to begin with.
 *
 * NOT LIVE-VERIFIED: this seam is still unwired (no bwrap launch runs it), so
 * the arguments are asserted by unit test only, never yet by a real cage start.
 *
 * @param {string[]} requestedPaths paths as configured (pre-canonicalization)
 * @param {string[]} canonicalPaths same order, after realpath
 * @returns {string[]}
 */
function runtimeSymlinkArgs(requestedPaths, canonicalPaths) {
  const args = [];
  requestedPaths.forEach((requested, index) => {
    const canonical = canonicalPaths[index];
    if (typeof canonical !== 'string' || canonical === requested) return;
    const target = path.relative(path.dirname(requested), canonical);
    if (target === '') return;
    args.push('--symlink', target, requested);
  });
  return args;
}

/**
 * Build a Codex-only allowlist bwrap launch or throw; never passes through.
 *
 * @param {{userId: string|number, codexHome: string, cwd: string,
 *   trustedProjectRoot: string, cmd: string, args?: string[]}} spec
 * @param {{resolveBwrapPath?: () => string|null, existsSync?: Function,
 *   statSync?: Function, accessSync?: Function, realpathSync?: Function,
 *   runtimeReadPaths?: string[], homedir?: () => string}} [deps]
 * @returns {{cmd: string, args: string[]}}
 */
export function buildCodexCagedLaunch(spec, deps = {}) {
  const io = {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    accessSync: fs.accessSync,
    realpathSync: fs.realpathSync,
    ...deps,
  };
  const userId = requiredUserId(spec?.userId);
  const requestedHome = requiredAbsolutePath(spec?.codexHome, 'codex-home');
  const requestedCwd = requiredAbsolutePath(spec?.cwd, 'cwd');
  const requestedProjectRoot = requiredAbsolutePath(
    spec?.trustedProjectRoot,
    'project-root',
  );
  const requestedBinary = requiredAbsolutePath(spec?.cmd, 'binary');
  const args = requiredStringArgs(spec?.args);
  forbidRootMount(requestedHome, 'codex-home');
  forbidRootMount(requestedCwd, 'cwd');
  forbidRootMount(requestedProjectRoot, 'project-root');
  requireDirectory(requestedHome, 'codex-home', io);
  requireDirectory(requestedCwd, 'cwd', io);
  requireDirectory(requestedProjectRoot, 'project-root', io);
  requireExecutable(requestedBinary, 'binary', io);
  const codexHome = canonicalPath(requestedHome, 'codex-home', io);
  const cwd = canonicalPath(requestedCwd, 'cwd', io);
  const projectRoot = canonicalPath(requestedProjectRoot, 'project-root', io);
  const binary = canonicalPath(requestedBinary, 'binary', io);
  requirePerUserCodexHome(codexHome, userId);
  const operatorHome = canonicalPath((deps.homedir ?? os.homedir)(), 'operator-home', io);
  if (
    cwd !== path.parse(cwd).root &&
    isSensitiveWritablePath(cwd, operatorHome, io)
  ) {
    throw new CodexCageError('invalid-cwd', 'cwd cannot expose host-sensitive paths');
  }
  requireDisjointWritableMounts(codexHome, cwd);
  requireTrustedProjectCwd(cwd, projectRoot, codexHome, operatorHome, io);

  const resolvedBwrap = (deps.resolveBwrapPath ?? resolveBwrapPath)();
  if (!resolvedBwrap) throw new CodexCageError('missing-bwrap', 'bwrap is required for Codex');
  const requestedBwrap = requiredAbsolutePath(resolvedBwrap, 'bwrap');
  requireExecutable(requestedBwrap, 'bwrap', io);
  const bwrap = canonicalPath(requestedBwrap, 'bwrap', io);
  const requestedRuntimePaths = existingRuntimePaths(
    deps.runtimeReadPaths ?? CODEX_CAGE_RUNTIME_READ_PATHS,
    io,
  );
  const runtimePaths = requestedRuntimePaths.map((runtimePath) =>
    canonicalPath(runtimePath, 'runtime-path', io));
  requireNarrowRuntimePaths(runtimePaths, operatorHome);
  if (!pathWithinAny(binary, runtimePaths)) {
    throw new CodexCageError(
      'binary-outside-runtime',
      'Codex binary must be inside an explicit read-only runtime path',
    );
  }

  return {
    cmd: bwrap,
    args: [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup',
      '--unshare-net',
      ...isolatedEnvironmentArgs(codexHome),
      ...readOnlyMountArgs(runtimePaths),
      // Placed AFTER the read-only binds: the link targets must already exist
      // inside the cage when the symlinks are created.
      ...runtimeSymlinkArgs(requestedRuntimePaths, runtimePaths),
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/tmp',
      '--bind',
      codexHome,
      codexHome,
      '--bind',
      cwd,
      cwd,
      '--chdir',
      cwd,
      '--',
      binary,
      ...args,
    ],
  };
}

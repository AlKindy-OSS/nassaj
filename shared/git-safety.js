/**
 * B-1691 — one place for the two git safety rules shared by the server and the
 * runtime scripts it imports (session-commit arbiter, preview pipeline).
 *
 * 1. Paths: a project file path, a project root or a workspace path never
 *    passes through a `.git` directory (config, hooks, session overlays).
 * 2. Spawns: every git child runs with config that a repository cannot
 *    override into running a command:
 *      - always `core.fsmonitor=false` and `safe.bareRepository=explicit`
 *        (a bare repository planted in a project is refused, not used);
 *      - `core.hooksPath=/dev/null` only for READ-ONLY invocations (status,
 *        diff, log …). Commit, push, pull/merge and checkout keep the project's
 *        own hooks (owner decision F12, 2026-10-26).
 *
 * Plain ESM with no dependencies, so scripts run by bare `node` can import it.
 */

import path from 'node:path';

/** Always passed: no fsmonitor command, no implicitly discovered bare repository. */
export const GIT_SAFE_CONFIG_ARGS = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'safe.bareRepository=explicit',
]);

/** Added for read-only invocations: no hook (post-index-change, reference-transaction …) runs. */
export const GIT_NO_HOOKS_ARGS = Object.freeze(['-c', 'core.hooksPath=/dev/null']);

/** Full prefix for a read-only invocation. */
export const GIT_READ_ONLY_ARGS = Object.freeze([...GIT_SAFE_CONFIG_ARGS, ...GIT_NO_HOOKS_ARGS]);

/**
 * Prefix for `git clone` of a remote repository: the clone has no project
 * hooks yet, so none may run (a template directory could carry some), and a
 * `file://` transport is never followed (local repositories of other projects,
 * submodule tricks). Clone URLs are canonical GitHub HTTPS URLs already.
 */
export const GIT_CLONE_ARGS = Object.freeze([
  ...GIT_READ_ONLY_ARGS,
  '-c', 'protocol.file.allow=never',
]);

/** Verbs that never change the repository. */
const READ_ONLY_VERBS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'cat-file', 'for-each-ref', 'ls-tree',
  'rev-list', 'merge-base', 'blame', 'describe', 'ls-remote', 'check-ignore', 'check-attr', 'diff-tree',
  'diff-index', 'diff-files', 'show-ref', 'name-rev', 'grep', 'shortlog', 'count-objects', 'archive',
  'var', 'version',
]);

/** `branch` flags that create, move, copy, delete or re-point a branch. */
const BRANCH_WRITE_FLAGS = new Set([
  '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force',
  '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-t', '--track', '--no-track',
]);

/** `config` flags that only read. */
const CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch']);

/** Global options before the verb that take a separate value. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/** Index of the git verb in `args`, skipping global options (-C dir, -c k=v …). */
function verbIndex(args) {
  let index = 0;
  while (index < args.length && String(args[index]).startsWith('-')) {
    index += GLOBAL_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
  }
  return index;
}

/** True for a `branch` invocation that only lists or reports. */
function isBranchListing(rest) {
  if (rest.some((arg) => BRANCH_WRITE_FLAGS.has(arg))) return false;
  const listing = rest.some((arg) => ['-a', '--all', '-r', '--remotes', '-l', '--list', '--show-current',
    '-v', '-vv', '--contains', '--merged', '--no-merged', '--format'].some((flag) => arg === flag
    || arg.startsWith(`${flag}=`)));
  return listing || rest.every((arg) => arg.startsWith('-'));
}

/**
 * True when a git invocation (argv after `git`) cannot change the repository.
 * Unknown verbs are NOT read-only, so they keep the project's hooks.
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function isReadOnlyGitInvocation(args) {
  const at = verbIndex(args);
  const verb = args[at];
  const rest = args.slice(at + 1).map(String);
  if (READ_ONLY_VERBS.has(verb)) return true;
  if (verb === 'branch') return isBranchListing(rest);
  if (verb === 'config') return rest.some((arg) => CONFIG_READ_FLAGS.has(arg));
  if (verb === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'get-url';
  if (verb === 'symbolic-ref') return rest.filter((arg) => !arg.startsWith('-')).length <= 1;
  if (verb === 'worktree' || verb === 'stash') return rest[0] === 'list';
  return false;
}

/**
 * The hardening prefix for one git invocation (argv after `git`).
 * @param {readonly string[]} args
 * @returns {readonly string[]}
 */
export function gitHardeningArgs(args) {
  return isReadOnlyGitInvocation(args) ? GIT_READ_ONLY_ARGS : GIT_SAFE_CONFIG_ARGS;
}

/**
 * `args` with its hardening prefix: pass the result as git's whole argv.
 * @param {readonly string[]} args
 * @returns {string[]}
 */
export function hardenGitArgs(args) {
  return [...gitHardeningArgs(args), ...args];
}

/**
 * True for a path segment naming a git directory: exactly `.git`,
 * case-insensitively, with trailing dots/spaces ignored (the names Windows and
 * case-insensitive filesystems fold onto `.git`). `.gitignore`, `.github`,
 * `.gitattributes`, `.gitmodules` and `.gitkeep` are ordinary names.
 * @param {string} segment
 * @returns {boolean}
 */
export function isGitDirSegment(segment) {
  return segment.replace(/[. ]+$/, '').toLowerCase() === '.git';
}

/**
 * True when any segment of an absolute path names a git directory.
 * @param {string} absolutePath
 * @returns {boolean}
 */
export function pathHasGitDirSegment(absolutePath) {
  return path.resolve(absolutePath).split(path.sep).some(isGitDirSegment);
}

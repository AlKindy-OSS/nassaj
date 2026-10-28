/**
 * Symlink-aware path boundary guard for project file access (B-159 / T-845).
 *
 * The pre-existing checks in the file endpoints resolved a client-supplied path
 * with `path.resolve` and then compared it against the project root with
 * `String.startsWith`. That comparison is purely LEXICAL: it never follows
 * symbolic links. A symlink planted inside the project tree (e.g. shipped inside
 * a cloned git repository) that points OUTSIDE the tree therefore passed the
 * check, yet `createReadStream`/`readFile`/`writeFile` would follow the link and
 * touch an arbitrary path on disk — arbitrary file disclosure on the read paths
 * and arbitrary write/delete on the mutate paths.
 *
 * These helpers add the missing canonicalization step (`fs.realpath`) so the
 * boundary is enforced against the REAL on-disk location, not the lexical string.
 * They are the single shared implementation every file path calls, so the guard
 * cannot drift between endpoints.
 *
 * Depends only on node:path + node:fs (no server/express/DB coupling), so it is
 * unit-testable against a real temp-dir filesystem.
 */

import path from 'node:path';
import fs from 'node:fs';
import { open, realpath } from 'node:fs/promises';

import {
  SQLITE_HEADER,
  classifySecretPath,
  classifySqliteContentPath,
  containsServiceRoot,
  containsServiceSecretValue,
  hasAppDatabaseSchema,
  hasSqliteHeader,
  hasSqliteWalHeader,
  isForbiddenProjectRoot,
  isSecretPath,
} from '@/shared/secret-path-guard.js';
import { isGitDirSegment, pathHasGitDirSegment } from '../../shared/git-safety.js';

export { isGitDirSegment, pathHasGitDirSegment };

/** Refusal for a service secret (B-1373): never served, whatever the request says. */
const SECRET_PATH_REFUSAL = Object.freeze({
  valid: false,
  code: 'SECRET_PATH',
  error: 'Path must be under project root',
});

/** Refusal for a project secret file opened without explicit confirmation (B-1593). */
const SECRET_CONFIRMATION_REFUSAL = Object.freeze({
  valid: false,
  code: 'SECRET_CONFIRMATION_REQUIRED',
  error: 'Secret file requires confirmation',
});

/**
 * B-1691: refusal for a path inside a git directory. Same code-free shape as an
 * out-of-root path, so the refusal discloses nothing more than OUTSIDE_ROOT.
 */
const GIT_DIR_REFUSAL = Object.freeze({
  valid: false,
  code: 'GIT_DIR',
  error: 'Path must be under project root',
});

/**
 * B-1691: true when `target`, taken relative to `root`, passes through a git
 * directory. A file API write there (`.git/config`, `.git/hooks/*`, a worktree's
 * `.git` gitdir file) is code execution the next time the server runs git, and
 * a read there bypasses the session checks of the overlays kept under `.git`.
 * @param {string} root   Effective root (project root or session overlay).
 * @param {string} target Absolute path to test.
 * @returns {boolean}
 */
function hasGitDirSegment(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative.split(path.sep).some(isGitDirSegment);
}

/**
 * B-1691: true (and one log line, the path only, never content) when `target`
 * passes through a git directory below `root`. Call it only for a target
 * already known to be inside `root`, so an escape is not logged as a git path.
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function refuseIfGitDir(root, target) {
  if (!hasGitDirSegment(root, target)) return false;
  console.warn('[path-guard] refused git directory path', {
    event: 'project_file_git_dir_refused', root, path: path.relative(root, target),
  });
  return true;
}

/**
 * B-1691 (qa F8): true (and one log line) when the project ROOT itself, lexically
 * or for real, lies inside a git directory: a legacy project row registered on
 * `<P>/.git` (or an overlay) would expose `config` and `hooks/*` as plain paths.
 * The only exemption is a session overlay root the caller resolved server-side
 * (resolveSessionFileRoot / the bound session workspace), passed explicitly as
 * `trustedOverlayRoot`; it is never inferred from the path's shape.
 * @param {string} rootAbs
 * @param {string} realRoot
 * @param {boolean} trustedOverlayRoot
 * @returns {boolean}
 */
function refuseIfGitDirRoot(rootAbs, realRoot, trustedOverlayRoot) {
  if (trustedOverlayRoot === true) return false;
  if (!pathHasGitDirSegment(rootAbs) && !pathHasGitDirSegment(realRoot)) return false;
  console.warn('[path-guard] refused project root inside a git directory', {
    event: 'project_root_git_dir_refused', root: rootAbs,
  });
  return true;
}

/** The stricter of two secret classes ('service' > 'project' > null). */
function stricterSecretClass(a, b) {
  if (a === 'service' || b === 'service') return 'service';
  return a ?? b ?? null;
}

/**
 * Canonicalize a client-supplied path against a project root and confirm — after
 * following symlinks — that it stays strictly inside the tree. For READ endpoints
 * that then open the file (createReadStream / readFile), so the target must exist.
 *
 * Two layered checks:
 *   1. Lexical fast-reject (path.resolve + startsWith). Catches obvious "../.."
 *      traversal without any filesystem I/O.
 *   2. Canonical boundary (fs.realpath on BOTH the target and the root, then
 *      re-check startsWith). Catches a symlink inside the tree pointing outside.
 *
 * Callers MUST open the returned `realResolved` (the canonical, verified path) —
 * not the lexical `resolved` — so a symlink cannot be swapped between the check
 * and the open (TOCTOU).
 *
 * @param {string} projectRoot     Absolute project root directory.
 * @param {string} requestedPath   Client-supplied path (absolute or project-relative).
 * B-1373: a root that is (or contains) the service user's home or a secret
 * location is refused outright (FORBIDDEN_ROOT), and a target resolving into a
 * secret location is refused even under an allowed root (SECRET_PATH).
 * B-1593: a service secret (classifySecretPath 'service') is always refused
 * (SECRET_PATH). A project secret file (dotenv or SQLite by name) is refused
 * with SECRET_CONFIRMATION_REQUIRED unless `options.confirmSecret` is true; when
 * served, the result carries `secretFile: true` so the caller can audit it.
 * B-1691: a path through a `.git` directory below the root, lexically or after
 * following symlinks, is refused (GIT_DIR, same message as an out-of-root path),
 * and so is every path under a root inside a git directory unless
 * `options.trustedOverlayRoot` marks a server-resolved session overlay (qa F8).
 *
 * @param {{ confirmSecret?: boolean, trustedOverlayRoot?: boolean }} [options]
 * @returns {Promise<
 *   { valid: true, resolved: string, realResolved: string, secretFile: boolean } |
 *   { valid: false, code: 'OUTSIDE_ROOT' | 'SYMLINK_ESCAPE' | 'ENOENT' | 'FORBIDDEN_ROOT' | 'SECRET_PATH'
 *     | 'SECRET_CONFIRMATION_REQUIRED' | 'GIT_DIR', error: string }
 * >}
 */
export async function resolveReadPathInProject(projectRoot, requestedPath, options = {}) {
  if (isForbiddenProjectRoot(projectRoot)) {
    return { valid: false, code: 'FORBIDDEN_ROOT', error: 'Project root is not allowed' };
  }
  const rootAbs = path.resolve(projectRoot);
  const resolved = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootAbs, requestedPath);

  // (1) Lexical boundary — rejects plain traversal before touching the disk.
  if (!resolved.startsWith(rootAbs + path.sep)) {
    return { valid: false, code: 'OUTSIDE_ROOT', error: 'Path must be under project root' };
  }
  // B-1691: before any disk I/O, so a refusal never tells whether it exists.
  if (refuseIfGitDir(rootAbs, resolved)) return GIT_DIR_REFUSAL;

  // (2) Canonical boundary — follows symlinks on both sides.
  let realRoot;
  try {
    realRoot = await realpath(rootAbs);
  } catch {
    // Root missing/unreadable: nothing under it can be served.
    return { valid: false, code: 'ENOENT', error: 'File not found' };
  }
  if (refuseIfGitDirRoot(rootAbs, realRoot, options.trustedOverlayRoot)) return GIT_DIR_REFUSAL;

  let realResolved;
  try {
    realResolved = await realpath(resolved);
  } catch {
    // Target (or a component of its path) does not exist / is a broken link.
    // A read endpoint needs the file to exist, so surface this as not-found.
    return { valid: false, code: 'ENOENT', error: 'File not found' };
  }

  if (!realResolved.startsWith(realRoot + path.sep)) {
    // Lexically inside, but the real path escapes the tree via a symlink.
    return { valid: false, code: 'SYMLINK_ESCAPE', error: 'Path must be under project root' };
  }
  // B-1691: a symlink inside the tree that lands in a git directory.
  if (refuseIfGitDir(realRoot, realResolved)) return GIT_DIR_REFUSAL;

  const secretClass = stricterSecretClass(classifySecretPath(resolved), classifySecretPath(realResolved));
  if (secretClass === 'service') return SECRET_PATH_REFUSAL;
  if (secretClass === 'project' && options.confirmSecret !== true) return SECRET_CONFIRMATION_REFUSAL;

  return { valid: true, resolved, realResolved, secretFile: secretClass === 'project' };
}

/** Files up to this size are read whole, inspected, and served from that buffer. */
export const MAX_INSPECTED_FILE_BYTES = 4 * 1024 * 1024;

/** How much of a larger SQLite file is scanned for the application schema. */
const MAX_SCHEMA_SCAN_BYTES = 8 * 1024 * 1024;

/** Reads up to `length` bytes from offset 0 of `handle` (positional; the file offset is untouched). */
async function readPrefix(handle, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Content verdict for an opened regular file (B-1593 review):
 *   - an SQLite WAL, or an SQLite database carrying the application schema,
 *     or SQLite content under a service root  -> service secret;
 *   - any inspected file containing the value of a secret the running service
 *     holds (a copy of its .env under any name)  -> service secret;
 *   - other SQLite content -> project secret file;
 *   - a dotenv-named file too large to inspect -> service (fail closed).
 * Files above MAX_INSPECTED_FILE_BYTES that are neither are not value-scanned.
 * Returns the inspected bytes so the caller serves exactly what was checked.
 */
async function inspectOpenedFile(handle, size, guard) {
  const inspectable = size <= MAX_INSPECTED_FILE_BYTES;
  let bytes = await readPrefix(handle, inspectable ? size : SQLITE_HEADER.length);
  if (hasSqliteWalHeader(bytes)) return { refusal: SECRET_PATH_REFUSAL };
  let { secretFile } = guard;
  const isSqlite = hasSqliteHeader(bytes);
  if (isSqlite) {
    if (!inspectable) bytes = await readPrefix(handle, Math.min(size, MAX_SCHEMA_SCAN_BYTES));
    const contentClass = stricterSecretClass(
      classifySqliteContentPath(guard.resolved),
      classifySqliteContentPath(guard.realResolved),
    );
    if (contentClass === 'service' || hasAppDatabaseSchema(bytes)) return { refusal: SECRET_PATH_REFUSAL };
    secretFile = true;
  }
  // A dotenv-named file too large to inspect fails closed; a large non-application
  // SQLite database stays a confirmable project file (streamed, not buffered).
  if (!inspectable) {
    return secretFile && !isSqlite ? { refusal: SECRET_PATH_REFUSAL } : { secretFile, content: null };
  }
  if (containsServiceSecretValue(bytes)) return { refusal: SECRET_PATH_REFUSAL };
  return { secretFile, content: bytes };
}

/**
 * `resolveReadPathInProject`, then OPEN the verified real path and inspect its
 * content on that descriptor (inspectOpenedFile). Service secrets are refused
 * (SECRET_PATH) whatever `options.confirmSecret` says; a project secret file
 * needs `options.confirmSecret` (SECRET_CONFIRMATION_REQUIRED otherwise).
 *
 * For files up to MAX_INSPECTED_FILE_BYTES the result carries `content`: the
 * exact bytes that were inspected, which the caller must serve instead of
 * re-reading. Larger files carry `content: null` and are streamed from
 * `handle`. The caller owns `handle` and must close it.
 *
 * @param {string} projectRoot   Absolute project root directory.
 * @param {string} requestedPath Client-supplied path (absolute or project-relative).
 * @param {{ confirmSecret?: boolean, trustedOverlayRoot?: boolean }} [options]
 * @returns {Promise<
 *   { valid: true, resolved: string, realResolved: string, secretFile: boolean,
 *     content: Buffer | null, handle: import('node:fs/promises').FileHandle } |
 *   { valid: false, code: string, error: string }
 * >}
 */
export async function openReadableProjectFile(projectRoot, requestedPath, options = {}) {
  // Confirmation is decided after the content check, so a service secret is
  // always 403 and never 428.
  const guard = await resolveReadPathInProject(projectRoot, requestedPath, {
    confirmSecret: true, trustedOverlayRoot: options.trustedOverlayRoot,
  });
  if (!guard.valid) return guard;
  const handle = await open(guard.realResolved, 'r');
  try {
    const stats = await handle.stat();
    const verdict = stats.isFile()
      ? await inspectOpenedFile(handle, stats.size, guard)
      : { secretFile: guard.secretFile, content: null };
    const refusal = verdict.refusal
      ?? (verdict.secretFile && options.confirmSecret !== true ? SECRET_CONFIRMATION_REFUSAL : null);
    if (refusal) {
      await handle.close();
      return refusal;
    }
    return { ...guard, secretFile: verdict.secretFile, content: verdict.content, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Synchronous canonical boundary check for MUTATE helpers, where the target may
 * not exist yet (creating a new file / renaming into a new name). Since the leaf
 * has no realpath, we canonicalize the deepest EXISTING ancestor and verify it
 * stays inside the project root — anything later created beneath a safe, real
 * ancestor is itself inside the tree. Existing (non-symlink) intermediates cannot
 * change identity at creation time, so this closes the symlink-escape vector for
 * writes without forcing the caller to pre-create the target.
 *
 * DANGLING-SYMLINK HARDENING: `realpathSync` throws ENOENT in two very different
 * situations, and the original walk-up conflated them:
 *   (a) the path component genuinely does not exist  — safe, keep walking up;
 *   (b) the component EXISTS as a symlink whose TARGET is missing (a "dangling"
 *       link, exactly what git materialises when a repo ships
 *       `inbox/x.md -> ~/.ssh/authorized_keys`) — NOT safe: the entry is real,
 *       and a later `writeFile`/`copyFile` FOLLOWS it and CREATES the attacker's
 *       target outside the tree.
 * Case (b) used to walk up to the project root itself and return `true`. We now
 * `lstat` each probe before walking up: if the entry exists in any form while
 * realpath failed, we fail closed. `lstat` does not follow the final component,
 * so it is precisely the primitive that distinguishes (a) from (b).
 *
 * Healthy cases are unchanged by design: a LIVE symlink (dangling or not is the
 * only new axis) still resolves through `realpathSync` and is judged purely on
 * where it really lands, so an in-tree link stays allowed and an escaping link
 * stays rejected. Only "entry exists but has no realpath" flipped true -> false.
 *
 * B-1373: always false for a forbidden root (the service user's home, or one
 * containing a secret location) and for a target resolving into a secret
 * location. B-1593: with `options.allowProjectSecretFiles` only SERVICE
 * secrets are refused, so a member can again create, rename, delete and (after
 * a confirmation the caller enforces) save the project's own dotenv/SQLite
 * files; without it every isSecretPath target stays refused.
 * B-1691: with `options.refuseGitDir` a target passing through a `.git`
 * directory below the root (lexically, or via the real path of its deepest
 * existing ancestor) is refused too; the file API and the git routes set it.
 * With it, a root inside a git directory is refused as a whole unless
 * `options.trustedOverlayRoot` marks a server-resolved session overlay (qa F8).
 *
 * Returns true only when the path is provably inside the (real) project root.
 *
 * @param {string} projectRoot    Absolute project root directory.
 * @param {string} resolvedTarget Already lexically-resolved absolute target path.
 * @param {{ allowProjectSecretFiles?: boolean, refuseGitDir?: boolean, trustedOverlayRoot?: boolean }} [options]
 * @returns {boolean}
 */
export function isResolvedPathInsideRootReal(projectRoot, resolvedTarget, options = {}) {
  const isRefusedTarget = options.allowProjectSecretFiles === true
    ? (candidate) => classifySecretPath(candidate) === 'service'
    : isSecretPath;
  // A target that IS or CONTAINS a service root (install, deploy, release …) is
  // never renamed, moved or deleted, whatever the secret-file mode.
  if (isForbiddenProjectRoot(projectRoot) || isRefusedTarget(resolvedTarget) || containsServiceRoot(resolvedTarget)) {
    return false;
  }
  const refuseGitDir = options.refuseGitDir === true;
  const rootAbs = path.resolve(projectRoot);
  const targetAbs = path.resolve(resolvedTarget);
  // B-1691: lexical git-dir check, only for a target inside the root (qa F6).
  if (refuseGitDir && isInsideOrEqual(rootAbs, targetAbs) && refuseIfGitDir(rootAbs, targetAbs)) return false;
  let realRoot;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch {
    return false;
  }
  if (refuseGitDir && refuseIfGitDirRoot(rootAbs, realRoot, options.trustedOverlayRoot)) return false;
  const real = realpathOfDeepestExisting(targetAbs);
  if (real === null || isRefusedTarget(real) || !isInsideOrEqual(realRoot, real)) return false;
  return !(refuseGitDir && refuseIfGitDir(realRoot, real));
}

/** True when `target` is `root` or strictly below it (lexical). */
function isInsideOrEqual(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Real path of the deepest EXISTING ancestor of `probe` (the leaf may not exist
 * yet), or null when it cannot be proven: a name that exists but has no
 * realpath (a dangling symlink, see the DANGLING-SYMLINK note above), any error
 * other than ENOENT (EACCES, ELOOP …), or no existing ancestor at all.
 * @param {string} probe Absolute path.
 * @returns {string|null}
 */
function realpathOfDeepestExisting(probe) {
  for (;;) {
    try {
      return fs.realpathSync(probe);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return null;
      // lstat does NOT follow the final component: a dangling link reports as
      // an existing entry here (fail closed), a truly absent name throws again.
      try {
        fs.lstatSync(probe);
        return null;
      } catch {
        // Genuinely absent: consider its parent.
      }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

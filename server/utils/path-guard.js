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
import { realpath } from 'node:fs/promises';

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
 * @returns {Promise<
 *   { valid: true, resolved: string, realResolved: string } |
 *   { valid: false, code: 'OUTSIDE_ROOT' | 'SYMLINK_ESCAPE' | 'ENOENT', error: string }
 * >}
 */
export async function resolveReadPathInProject(projectRoot, requestedPath) {
  const rootAbs = path.resolve(projectRoot);
  const resolved = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootAbs, requestedPath);

  // (1) Lexical boundary — rejects plain traversal before touching the disk.
  if (!resolved.startsWith(rootAbs + path.sep)) {
    return { valid: false, code: 'OUTSIDE_ROOT', error: 'Path must be under project root' };
  }

  // (2) Canonical boundary — follows symlinks on both sides.
  let realRoot;
  try {
    realRoot = await realpath(rootAbs);
  } catch {
    // Root missing/unreadable: nothing under it can be served.
    return { valid: false, code: 'ENOENT', error: 'File not found' };
  }

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

  return { valid: true, resolved, realResolved };
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
 * Returns true only when the path is provably inside the (real) project root.
 *
 * @param {string} projectRoot    Absolute project root directory.
 * @param {string} resolvedTarget Already lexically-resolved absolute target path.
 * @returns {boolean}
 */
export function isResolvedPathInsideRootReal(projectRoot, resolvedTarget) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(projectRoot));
  } catch {
    return false;
  }

  let probe = path.resolve(resolvedTarget);
  // Walk up to the nearest existing ancestor (the leaf may not exist yet).
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // Disambiguate "missing" from "exists but unresolvable" (see the
        // DANGLING-SYMLINK note above). lstat does NOT follow the final
        // component, so a dangling link reports as an existing symlink here
        // while a truly absent name throws ENOENT again.
        let entry = null;
        try {
          entry = fs.lstatSync(probe);
        } catch {
          entry = null; // genuinely absent — safe to consider its parent.
        }
        if (entry) {
          // The name IS present on disk yet has no realpath: a dangling symlink
          // (or an equally unresolvable entry). A write here would follow the
          // link and land on an unverifiable target. Fail closed.
          return false;
        }
        const parent = path.dirname(probe);
        if (parent === probe) {
          // Reached the filesystem root without finding an existing ancestor.
          return false;
        }
        probe = parent;
        continue;
      }
      // EACCES / ELOOP / any other error: fail closed.
      return false;
    }
  }
}

/**
 * Secret-location guard for project roots and project file access (B-1373).
 *
 * The project path guard (server/utils/path-guard.js) only proves that a path
 * stays inside its project root. It cannot help when the ROOT itself is the
 * service user's home: a project registered at the service home made every
 * credential under it (`.ssh`, `.config/nassaj`, `.nassaj-users/*`, the live
 * database, Claude credentials) readable by any member through
 * GET /api/projects/:id/file.
 *
 * This module is the single policy for that class of leak:
 *   - `findForbiddenProjectRootReason` refuses a project root that equals or
 *     contains the service user's home, or equals/contains/lies inside a known
 *     secret location. Legitimate roots such as `~/Project/<name>` pass.
 *   - `isSecretPath` refuses any path that resolves (realpath) into a secret
 *     location, as defense in depth for file reads/writes on existing projects.
 *   - Structural rule (round 2): everything under a first-level hidden entry of
 *     a protected home is secret, except ALLOWED_HIDDEN_HOME_ENTRIES. The fixed
 *     SECRET_HOME_ENTRIES list stays as defense in depth (it also wins over the
 *     allowlist).
 *
 * Synchronous on purpose: it is called from both the async read guard and the
 * synchronous mutate guard. Depends only on node built-ins.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Credential-bearing entries relative to a protected home directory. Anything
 * at or below one of these is never served, and no project root may equal,
 * contain, or lie inside one.
 */
export const SECRET_HOME_ENTRIES: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.docker',
  '.kube',
  '.netrc',
  '.git-credentials',
  '.config/nassaj',
  '.config/nassaj-test',
  '.config/gh',
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.hermes',
  '.local/share/nassaj-dev',
  '.nassaj-users',
]);

export type ForbiddenProjectRootReason = 'home' | 'secret';

/** Canonical form of `p`: realpath when it exists, otherwise the lexical resolve. */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** True when `child` equals `parent` or lies strictly beneath it. */
function isAtOrInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Both the lexical and canonical forms of a path, deduplicated. */
function forms(p: string): string[] {
  const lexical = path.resolve(p);
  const real = canonical(p);
  return lexical === real ? [lexical] : [lexical, real];
}

/**
 * Hidden home paths that ARE legitimate project roots. `agent.js` clones
 * githubUrl-only requests into `~/.claude/external-projects/<hash>`. Nothing
 * else under a hidden first-level home entry is a workspace.
 */
export const ALLOWED_HIDDEN_HOME_ENTRIES: readonly string[] = Object.freeze([
  '.claude/external-projects',
]);

/** How long the derived home/secret sets are reused before re-resolving. */
const POLICY_TTL_MS = 30_000;

type SecretPolicy = {
  key: string;
  expiresAt: number;
  homes: string[];
  secrets: string[];
  allowed: string[];
};

let cachedPolicy: SecretPolicy | null = null;
let cachedPasswdHome: string | null | undefined;

/** The passwd home (independent of $HOME); resolved once per process. */
function passwdHome(): string | null {
  if (cachedPasswdHome === undefined) {
    try {
      cachedPasswdHome = os.userInfo().homedir || null;
    } catch {
      cachedPasswdHome = null; // No passwd entry (rare container setups).
    }
  }
  return cachedPasswdHome;
}

/** Joins every home with every entry, in lexical and canonical forms. */
function expandUnderHomes(homes: string[], entries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const home of homes) {
    for (const entry of entries) {
      for (const form of forms(path.join(home, entry))) out.add(form);
    }
  }
  return [...out];
}

/**
 * The derived policy, memoised for POLICY_TTL_MS (each build costs ~30
 * realpath calls). The key is the current $HOME, so changing it re-derives at
 * once; a secret directory created later is still caught lexically and by the
 * structural hidden-entry rule, so a stale canonical form cannot open a hole.
 */
function policy(): SecretPolicy {
  const envHome = os.homedir();
  const key = `${envHome}\0${passwdHome() ?? ''}`;
  const now = Date.now();
  if (cachedPolicy && cachedPolicy.key === key && cachedPolicy.expiresAt > now) return cachedPolicy;
  const homeSet = new Set<string>();
  for (const home of [envHome, passwdHome()]) {
    if (typeof home === 'string' && home.length > 0) {
      for (const form of forms(home)) homeSet.add(form);
    }
  }
  const homes = [...homeSet];
  cachedPolicy = {
    key,
    expiresAt: now + POLICY_TTL_MS,
    homes,
    secrets: expandUnderHomes(homes, SECRET_HOME_ENTRIES),
    allowed: expandUnderHomes(homes, ALLOWED_HIDDEN_HOME_ENTRIES),
  };
  return cachedPolicy;
}

/** Drops the memoised policy (tests, or after a known configuration change). */
export function resetSecretPathGuardCache(): void {
  cachedPolicy = null;
  cachedPasswdHome = undefined;
}

/**
 * Home directories of the service user. `os.homedir()` honours $HOME, and the
 * passwd entry is added so a changed $HOME cannot hide the real home.
 */
export function getProtectedHomes(): string[] {
  return [...policy().homes];
}

/** Absolute listed secret locations (lexical and canonical) under every protected home. */
export function getSecretLocations(): string[] {
  return [...policy().secrets];
}

/** True when `candidate` lies under a first-level hidden entry of `home`. */
function isUnderHiddenHomeEntry(candidate: string, home: string): boolean {
  const relative = path.relative(home, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0].startsWith('.');
}

/** Secret test for one already-resolved form of a path. */
function isSecretForm(candidate: string, current: SecretPolicy): boolean {
  // Listed locations win over the allowlist: credentials are never re-opened.
  if (current.secrets.some((secret) => isAtOrInside(candidate, secret))) return true;
  if (!current.homes.some((home) => isUnderHiddenHomeEntry(candidate, home))) return false;
  return !current.allowed.some((allowed) => isAtOrInside(candidate, allowed));
}

/**
 * True when `targetPath` (lexically or after following symlinks) is, or lies
 * beneath, a secret location: a listed credential location, or ANY entry under
 * a first-level hidden directory/file of a protected home (`~/.cloudflared`,
 * `~/.pgpass`, `~/.codex`, `~/.claude.json` …) except the explicit allowlist.
 */
export function isSecretPath(targetPath: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  const current = policy();
  return forms(targetPath).some((candidate) => isSecretForm(candidate, current));
}

/**
 * Why `projectRoot` may not be a project root, or `null` when it is allowed.
 *   - 'home'   the root equals or contains a protected home directory;
 *   - 'secret' the root equals, contains, or lies inside a secret location.
 */
export function findForbiddenProjectRootReason(projectRoot: string): ForbiddenProjectRootReason | null {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return null;
  const roots = forms(projectRoot);
  const current = policy();
  if (roots.some((root) => current.homes.some((home) => isAtOrInside(home, root)))) {
    return 'home';
  }
  if (roots.some((root) => isSecretForm(root, current)
    || current.secrets.some((secret) => isAtOrInside(secret, root)))) {
    return 'secret';
  }
  return null;
}

/** True when `projectRoot` must never be registered or served as a project. */
export function isForbiddenProjectRoot(projectRoot: string): boolean {
  return findForbiddenProjectRootReason(projectRoot) !== null;
}

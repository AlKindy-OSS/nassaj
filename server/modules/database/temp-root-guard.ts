import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDatabasePath } from './connection.js';
import { isOwnTestRunPath } from './test-run-root-guard.js';

/**
 * B-1620: nested CLI runs (an agent running `codex exec` or `claude -p` from a
 * scratch directory) write transcripts into watched provider homes, and
 * discovery used to register those scratch cwds as sidebar projects. A path
 * under a temporary root is therefore never admitted by the synchronizers
 * unless a user registered it (see session-discovery.db.ts). This module only
 * answers "is this path under a temp root foreign to the active database?".
 *
 * Temp roots: os.tmpdir(), $TMPDIR, /tmp, /var/tmp, /dev/shm,
 * NASSAJ_SCRATCHPAD_BASE and its parent (only when named `tmp` or inside
 * another root), and `.cache/tmp` under the service
 * home, the passwd home and every member home (`<home>/.nassaj-users/<id>`).
 * A root that resolves to "/" or equals/contains a home is discarded, so
 * TMPDIR=$HOME can never turn a home into a temp root.
 *
 * Both the lexical and the realpath form of the candidate are tested, so a
 * symlink from a real project into a temp root is rejected as well; such a
 * project can still be registered explicitly by a user.
 */

/** How long the derived root set (and the per-path verdicts) is reused. */
const POLICY_TTL_MS = 30_000;
/** Upper bound of memoised per-path verdicts; cleared wholesale when reached. */
const MAX_CACHED_VERDICTS = 512;
const FIXED_TEMP_ROOTS: readonly string[] = ['/tmp', '/var/tmp', '/dev/shm'];

type TempRootPolicy = { key: string; expiresAt: number; roots: string[] };

let cachedPolicy: TempRootPolicy | null = null;
const verdicts = new Map<string, boolean>();

/** Realpath of `p`, or its lexical resolve when it does not exist (never throws). */
function realOrLexical(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Lexical and canonical forms of `p`, deduplicated. */
function forms(p: string): string[] {
  const lexical = path.resolve(p);
  const real = realOrLexical(lexical);
  return lexical === real ? [lexical] : [lexical, real];
}

/** True when `child` equals `parent` or lies beneath it on a segment boundary. */
function isAtOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The passwd home, independent of $HOME (null when there is no passwd entry). */
function passwdHome(): string | null {
  try {
    return os.userInfo().homedir || null;
  } catch {
    return null;
  }
}

/** Member homes `<home>/.nassaj-users/<id>` under each base home. */
function memberHomes(baseHomes: string[]): string[] {
  const out: string[] = [];
  for (const home of baseHomes) {
    const usersDir = path.join(home, '.nassaj-users');
    try {
      for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) out.push(path.join(usersDir, entry.name));
      }
    } catch {
      // No member tree on this host.
    }
  }
  return out;
}

/** Raw root candidates from the environment and the known homes (scratch parent excluded). */
function rawRoots(homes: string[]): string[] {
  const scratch = process.env.NASSAJ_SCRATCHPAD_BASE;
  const raw = [os.tmpdir(), process.env.TMPDIR, ...FIXED_TEMP_ROOTS, scratch];
  for (const home of homes) raw.push(path.join(home, '.cache', 'tmp'));
  return raw.filter((root): root is string => typeof root === 'string' && path.isAbsolute(root));
}

/**
 * The scratchpad parent (the CLI's tmp, e.g. ~/.cache/tmp) is a root only when
 * it is named `tmp` or already lies inside another root: an operator base such
 * as /srv/scratch/claude must not turn /srv into a temp root.
 */
function scratchParentForms(roots: Set<string>): string[] {
  const scratch = process.env.NASSAJ_SCRATCHPAD_BASE;
  if (!scratch || !path.isAbsolute(scratch)) return [];
  const parentForms = forms(path.dirname(scratch));
  const accepted = path.basename(path.dirname(path.resolve(scratch))) === 'tmp'
    || parentForms.some((form) => [...roots].some((root) => isAtOrInside(form, root)));
  return accepted ? parentForms : [];
}

/** Builds the root set: every form of every raw root that is neither "/" nor a home container. */
function buildRoots(): string[] {
  const baseHomes = [os.homedir(), passwdHome()].filter((home): home is string => Boolean(home));
  const homes = [...baseHomes, ...memberHomes(baseHomes)];
  const homeForms = homes.flatMap(forms);
  const admissible = (root: string) => root !== path.parse(root).root
    && !homeForms.some((home) => isAtOrInside(home, root));
  const roots = new Set(rawRoots(homes).flatMap(forms).filter(admissible));
  for (const form of scratchParentForms(roots).filter(admissible)) roots.add(form);
  return [...roots];
}

/** The memoised root set; re-derived after the TTL or when the env inputs change. */
function policy(): TempRootPolicy {
  const key = [os.homedir(), os.tmpdir(), process.env.TMPDIR, process.env.NASSAJ_SCRATCHPAD_BASE].join('\0');
  const now = Date.now();
  if (cachedPolicy && cachedPolicy.key === key && cachedPolicy.expiresAt > now) return cachedPolicy;
  verdicts.clear();
  cachedPolicy = { key, expiresAt: now + POLICY_TTL_MS, roots: buildRoots() };
  return cachedPolicy;
}

/** Drops the memoised roots and verdicts (tests, or after a configuration change). */
export function resetTempRootGuardCache(): void {
  cachedPolicy = null;
  verdicts.clear();
}

/** Number of memoised verdicts (bounded by MAX_CACHED_VERDICTS); for tests and diagnostics. */
export function getTempRootVerdictCacheSize(): number {
  return verdicts.size;
}

/** The current temp roots (lexical and canonical forms). */
export function getTempRoots(): string[] {
  return [...policy().roots];
}

/** Uncached verdict for {@link isForeignTempRootPath}. */
function computeVerdict(projectPath: string, databasePath: string, roots: string[]): boolean {
  const candidateForms = forms(projectPath);
  const matching = roots.filter((root) => candidateForms.some((form) => isAtOrInside(form, root)));
  if (matching.length === 0) return false;
  if (isOwnTestRunPath(projectPath, databasePath)) return false;
  const dbForms = forms(databasePath);
  return !matching.some((root) => dbForms.some((form) => isAtOrInside(form, root)));
}

/**
 * True when `projectPath` (lexically or after realpath) lies under a temp root
 * that does not also contain the active database. A database inside the same
 * temp root — or the same B-1420 test run root — is a test or scratch database
 * for which such paths are its own fixtures. Never throws; a missing path is
 * judged by its lexical form. Verdicts are memoised in a small bounded cache.
 */
export function isForeignTempRootPath(
  projectPath: string,
  databasePath: string = getDatabasePath(),
): boolean {
  const { roots } = policy();
  const key = `${databasePath}\0${projectPath}`;
  const cached = verdicts.get(key);
  if (cached !== undefined) return cached;
  const verdict = computeVerdict(projectPath, databasePath, roots);
  if (verdicts.size >= MAX_CACHED_VERDICTS) verdicts.clear();
  verdicts.set(key, verdict);
  return verdict;
}

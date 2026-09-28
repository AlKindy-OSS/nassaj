import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listClaudeConfigDirsReadOnly, operatorClaudeHome } from './claude-home.js';

/**
 * Claude projects-root spellings and layout-independent transcript lookup
 * (T-1880, Claude-home separation stage a).
 *
 * Until the separation, `~/.claude` is a symlink to the governance checkout, so
 * rows in the app DB are spelled with the checkout realpath
 * (`$CORE_DIR/projects/...`). After it, the same files live under a real
 * `~/.claude/projects`. Everything here lets code survive both layouts and the
 * relocation itself without deleting or double-counting anything.
 */

/** Public /health marker: stage d proves this code is live before touching `~/.claude`. */
export const CLAUDE_HOME_READY = Object.freeze({
  watcherRecheck: true,
  costKeyV2: true,
  resolverFallback: true,
});

/** Operator root id in `claude-rel:` keys; members sharing its real root use it too. */
export const OPERATOR_ROOT_ID = '0';

/** Realpath or null; never throws. */
function realOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Governance checkout: `$NASSAJ_GOVERNANCE_DIR`, else the directory holding the
 * real `~/.claude/NASSAJ.md`, else `~/nassaj-core`. Works in both layouts.
 */
export function resolveGovernanceDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.NASSAJ_GOVERNANCE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const nassajMd = realOrNull(path.join(operatorClaudeHome(), 'NASSAJ.md'));
  return nassajMd ? path.dirname(nassajMd) : path.join(os.homedir(), 'nassaj-core');
}

/** Legacy spellings of the operator projects root: `$CORE_DIR/projects`, literal and real. */
export function legacyOperatorProjectsSpellings(): string[] {
  const legacy = path.join(resolveGovernanceDir(), 'projects');
  return unique([legacy, realOrNull(legacy)]);
}

/** Literal `<home>/projects` for the operator and every registered user's Claude home. */
export function claudeProjectsSpellings(): string[] {
  return unique(listClaudeConfigDirsReadOnly().map((home) => path.join(home, 'projects')));
}

/** Current roots to search, plus every spelling a stored path may start with. */
export type ClaudeRootLists = { roots: string[]; spellings: string[] };

const ROOT_LISTS_TTL_MS = 30_000;
let rootListsCache: { key: string; expiresAt: number; value: ClaudeRootLists } | null = null;

/**
 * Root lists, computed only on demand and cached briefly (a ghost sweep or an
 * unlink storm asks hundreds of times). The key covers the inputs that can
 * change without a user-table write, so a changed HOME is never served stale.
 */
export function claudeRootLists(now: number = Date.now()): ClaudeRootLists {
  const key = [os.homedir(), process.env.NASSAJ_GOVERNANCE_DIR ?? '', process.env.CLAUDE_CONFIG_DIR ?? ''].join('\0');
  if (rootListsCache && rootListsCache.key === key && rootListsCache.expiresAt > now) return rootListsCache.value;
  const roots = claudeProjectsSpellings();
  const value = { roots, spellings: unique([...roots, ...roots.map(realOrNull), ...legacyOperatorProjectsSpellings()]) };
  rootListsCache = { key, expiresAt: now + ROOT_LISTS_TTL_MS, value };
  return value;
}

/**
 * Path of `filePath` relative to the longest matching root spelling, or
 * `<slug>/<file>` (its last two segments) when no known spelling prefixes it.
 */
export function relativeTranscriptPath(filePath: string, spellings: string[]): string {
  const resolved = path.resolve(filePath);
  const match = spellings
    .map((root) => path.resolve(root))
    .filter((root) => resolved.startsWith(`${root}${path.sep}`))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return path.relative(match, resolved);
  return path.join(path.basename(path.dirname(resolved)), path.basename(resolved));
}

export type PathPresence = 'present' | 'absent' | 'unknown';

/**
 * Presence of a regular file. Only ENOENT/ENOTDIR count as absent: ELOOP (the
 * migration's self-loop instant), EACCES and friends are `unknown`, so no
 * caller deletes rows on an error that does not prove the file is gone.
 */
export function filePresence(target: string): PathPresence {
  try {
    return statSync(target).isFile() ? 'present' : 'absent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

export type TranscriptLocation =
  | { state: 'present'; path: string }
  | { state: 'absent' }
  | { state: 'unknown' };

/**
 * Finds a transcript by its stored path, falling back to the same relative
 * path under every current Claude projects root. The stored path is checked
 * first; root lists are resolved only when it is not present. `absent` means
 * every candidate is provably missing; anything uncertain is `unknown`.
 */
export function locateClaudeTranscript(
  storedPath: string,
  rootLists: () => ClaudeRootLists = claudeRootLists,
): TranscriptLocation {
  const stored = filePresence(storedPath);
  if (stored === 'present') return { state: 'present', path: storedPath };
  const { roots, spellings } = rootLists();
  const rel = relativeTranscriptPath(storedPath, unique([...spellings, ...roots]));
  const candidates = unique(roots.map((root) => path.join(root, rel))).filter((candidate) => candidate !== storedPath);
  let uncertain = stored === 'unknown';
  for (const candidate of candidates) {
    const presence = filePresence(candidate);
    if (presence === 'present') return { state: 'present', path: candidate };
    if (presence === 'unknown') uncertain = true;
  }
  return uncertain ? { state: 'unknown' } : { state: 'absent' };
}

/** Existing transcript path for a stored `jsonl_path`, or null. */
export function resolveStoredClaudeTranscript(storedPath: string): string | null {
  const location = locateClaudeTranscript(storedPath);
  return location.state === 'present' ? location.path : null;
}

/** One realpath-distinct projects root with every spelling that reaches it. */
export type ClaudeRootEntry = { real: string; rootId: string; spellings: string[] };

/**
 * Member root id from the member's own config-dir literal: the spelling that is
 * itself the real directory (not a link to it). Link spellings added or removed
 * later never change it; only a group without such a literal falls back to its
 * smallest spelling.
 */
function memberRootId(real: string, literals: string[]): string {
  const anchor = literals.includes(real) ? real : [...literals].sort()[0] ?? real;
  return `m${createHash('sha256').update(anchor).digest('hex').slice(0, 10)}`;
}

/**
 * Groups root spellings by realpath. The operator's group gets id `0` and also
 * owns the legacy governance spellings; any other distinct real root gets an id
 * from its member's own config-dir literal (see memberRootId), which the
 * migration never changes. Missing roots drop out.
 */
export function buildClaudeRootCatalog(
  literalRoots: string[],
  operatorRoot: string,
  legacyOperatorSpellings: string[] = [],
): ClaudeRootEntry[] {
  const operatorReal = realOrNull(operatorRoot);
  const groups = new Map<string, string[]>();
  for (const literal of unique([operatorRoot, ...literalRoots])) {
    const real = realOrNull(literal);
    if (real) groups.set(real, [...(groups.get(real) ?? []), literal]);
  }
  return [...groups].map(([real, literals]) => {
    const isOperator = real === operatorReal;
    return {
      real,
      rootId: isOperator ? OPERATOR_ROOT_ID : memberRootId(real, literals),
      spellings: unique([...literals, real, ...(isOperator ? legacyOperatorSpellings : [])]),
    };
  });
}

/** Host catalog: operator + member roots, legacy governance spellings on the operator. */
export function resolveClaudeRootCatalog(): ClaudeRootEntry[] {
  return buildClaudeRootCatalog(
    claudeProjectsSpellings(),
    path.join(operatorClaudeHome(), 'projects'),
    legacyOperatorProjectsSpellings(),
  );
}

/** Spelling-independent cost-ledger key for a file under `root.real`. */
export function claudeRelativeSourceKey(root: ClaudeRootEntry, absolutePath: string): string {
  const rel = path.relative(root.real, absolutePath).split(path.sep).join('/');
  return `claude-rel:${root.rootId}/${rel}`;
}

/** Exact legacy absolute keys the same file may have been recorded under. */
export function legacySourceKeyCandidates(root: ClaudeRootEntry, absolutePath: string): string[] {
  const rel = path.relative(root.real, absolutePath);
  return unique(root.spellings.map((spelling) => path.join(spelling, rel)));
}

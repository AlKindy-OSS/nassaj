import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Source-tree identity of a transcript path (ADR-201 A2).
 *
 * A tree key names the physical owner area a path sits in:
 *   - `member:<n>` — under `<home>/.nassaj-users/<n>/` (segment-exact, so `/1`
 *     never matches `/10`);
 *   - `operator`   — anywhere else: the operator home, the pre-separation
 *     `$CORE_DIR/projects` spelling (T-1880, wherever the checkout lives) and
 *     shared locations outside any member tree. They form one operator/shared
 *     root because no member harness can write there under isolation.
 *
 * A path carries up to two keys: its lexical spelling and its realpath. Both are
 * kept because provisioning may link a member's provider dir to a shared tree
 * (legitimate case b), while a symlink planted in one member's tree pointing at
 * another's must not pass as either. Nothing here enumerates member trees: the
 * key is computed from the path alone. Never throws.
 */

export const OPERATOR_TREE = 'operator';
const MEMBER_PREFIX = 'member:';

/** Realpath of `target`; for a missing leaf, realpath of its parent plus the leaf. */
function realSpelling(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      return null;
    }
  }
}

function strictlyUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Lexical and real spellings of a root, deduplicated. */
function rootSpellings(root: string): string[] {
  const real = realSpelling(root);
  return real && real !== root ? [root, real] : [root];
}

/** The one tree key of an already-absolute spelling. */
function classify(spelling: string): string {
  for (const usersRoot of rootSpellings(path.join(os.homedir(), '.nassaj-users'))) {
    if (!strictlyUnder(spelling, usersRoot)) continue;
    const memberId = path.relative(usersRoot, spelling).split(path.sep)[0];
    // A non-numeric entry under the users root is not a member tree; it stays
    // operator-owned, never another member's.
    return /^\d+$/.test(memberId) ? `${MEMBER_PREFIX}${memberId}` : OPERATOR_TREE;
  }
  return OPERATOR_TREE;
}

/**
 * Tree keys of `filePath` (lexical and real). Empty for a blank or relative
 * path: such a value names no tree and therefore never matches one.
 */
export function sourceTreeKeys(filePath: string | null | undefined): Set<string> {
  const literal = (filePath ?? '').trim();
  if (!literal || !path.isAbsolute(literal)) return new Set();
  const lexical = path.resolve(literal);
  const keys = new Set([classify(lexical)]);
  const real = realSpelling(lexical);
  if (real) keys.add(classify(real));
  return keys;
}

/**
 * True when every tree key of `candidate` is one of the tree keys of
 * `recorded`, i.e. the candidate lies in the same member tree as the recorded
 * path both lexically and physically.
 */
export function isSameSourceTree(recorded: string | null | undefined, candidate: string | null | undefined): boolean {
  const recordedKeys = sourceTreeKeys(recorded);
  const candidateKeys = sourceTreeKeys(candidate);
  if (recordedKeys.size === 0 || candidateKeys.size === 0) return false;
  return [...candidateKeys].every((key) => recordedKeys.has(key));
}

/**
 * H1 (ADR-201 qa): true when the keys of `filePath` name two DIFFERENT
 * members — a member spelling whose realpath lies in another member's tree
 * (one member linked a provider root at another's). Such a path belongs to
 * neither and is never recorded. Member + operator (case b) is not a conflict.
 */
export function isCrossMemberPath(filePath: string | null | undefined): boolean {
  const members = [...sourceTreeKeys(filePath)].filter((key) => key.startsWith(MEMBER_PREFIX));
  return members.length > 1;
}

/** Tree key of member `<id>`. */
export function memberTreeKey(memberId: string | number): string {
  return `${MEMBER_PREFIX}${String(memberId)}`;
}

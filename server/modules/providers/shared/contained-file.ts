import os from 'node:os';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

/**
 * Containment check for provider transcripts read from a stored path (B-1564).
 *
 * A stored `jsonl_path` is a database column; a reader that opens it as-is is an
 * arbitrary-file-read primitive the moment anything can write that column or
 * plant a symlink in a provider tree. Every reader therefore realpath-resolves
 * the candidate and requires the RESOLVED file to sit under a resolved root, so
 * a symlink that escapes the root is rejected as surely as a foreign path.
 */

/** Realpaths of `roots`; absent or unreadable roots drop out. */
export async function realRoots(roots: Iterable<string>): Promise<string[]> {
  const resolved = new Set<string>();
  for (const root of roots) {
    try {
      resolved.add(await realpath(root));
    } catch {
      // A root that does not exist on this host cannot contain anything.
    }
  }
  return [...resolved];
}

/** True when `target` is strictly below `root` (both already resolved). */
export function isStrictlyUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Literal and real spellings of the users root (`<home>/.nassaj-users`). */
async function usersRootSpellings(): Promise<string[]> {
  const usersRoot = path.join(os.homedir(), '.nassaj-users');
  return [...new Set([usersRoot, ...await realRoots([usersRoot])])];
}

/**
 * Users-root entry (`<n>` of `<users>/<n>/…`) named by the spelling of
 * `target` itself (no link in it is followed), or null outside the users root.
 */
export async function lexicalMemberOf(target: string): Promise<string | null> {
  return usersEntryOf(path.resolve(target));
}

/**
 * Users-root entry that physically holds `target` (its realpath), or null when
 * that lies outside the users root (operator/shared). A target that cannot be
 * resolved is judged by its literal spelling. Never throws.
 */
export async function physicalMemberOf(target: string): Promise<string | null> {
  return usersEntryOf(await realpath(target).catch(() => path.resolve(target)));
}

async function usersEntryOf(spelling: string): Promise<string | null> {
  for (const users of await usersRootSpellings()) {
    if (isStrictlyUnder(spelling, users)) return path.relative(users, spelling).split(path.sep)[0];
  }
  return null;
}

/**
 * H1 (ADR-201 qa): a provider root may be a link only to its own member tree
 * or to the operator/shared area (provisioning case b: every live member's
 * `.claude/projects` links to the operator tree). A root of member `<n>`
 * whose realpath lies under ANY other users-root entry, or an operator/shared
 * root whose realpath lies under the users root at all, is not that tree.
 */
async function isOwnPhysicalRoot(root: string, memberId: string | null): Promise<boolean> {
  const owner = await physicalMemberOf(root);
  return owner === null || owner === memberId;
}

/**
 * Roots of the ONE tree that holds `recorded` (ADR-201 A1.3), as literal
 * spellings: `[<users>/<n>/<underHome>]` when `recorded` lies in member tree
 * `<n>`, every `sharedRoots` spelling when it lies under one of them, else `[]`.
 * Member trees are never enumerated: the member id is the first path segment
 * below the users root (a `path.relative` split, so `/1` never matches `/10`).
 * A path inside the users root but not in a numeric member tree, or a provider
 * with no member trees (`underHome` null), yields `[]` for that branch. A root
 * that physically lies in another member's tree is dropped (H1, see
 * {@link isOwnPhysicalRoot}).
 */
export async function recordedTreeRoots(
  recorded: string,
  sharedRoots: readonly string[],
  underHome: string | null,
): Promise<string[]> {
  const literal = path.resolve(recorded);
  for (const users of await usersRootSpellings()) {
    if (!isStrictlyUnder(literal, users)) continue;
    const memberId = path.relative(users, literal).split(path.sep)[0];
    if (!underHome || !/^\d+$/.test(memberId)) return [];
    const root = path.join(users, memberId, underHome);
    return await isOwnPhysicalRoot(root, memberId) ? [root] : [];
  }
  const spellings = [...sharedRoots, ...await realRoots(sharedRoots)];
  if (!spellings.some((root) => isStrictlyUnder(literal, path.resolve(root)))) return [];
  const own = await Promise.all(sharedRoots.map((root) => isOwnPhysicalRoot(root, null)));
  return sharedRoots.filter((_, index) => own[index]);
}

/** Realpath of `candidate` when it is a regular file passing `accept`, else null. Never throws. */
export async function realFileOf(
  candidate: string | null | undefined,
  accept: (resolved: string) => boolean = () => true,
): Promise<string | null> {
  const literal = (candidate ?? '').trim();
  if (!literal || !path.isAbsolute(literal)) return null;
  try {
    const resolved = await realpath(literal);
    return (await stat(resolved)).isFile() && accept(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

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

/**
 * `<~/.nassaj-users>/<id>/<underHome>` for the member tree that holds `resolved`,
 * or null when `resolved` is not inside a numeric member tree. Read-only: it
 * enumerates nothing and provisions nothing.
 */
export async function memberTreeRoot(resolved: string, underHome: string): Promise<string | null> {
  const [usersRoot] = await realRoots([path.join(os.homedir(), '.nassaj-users')]);
  if (!usersRoot || !isStrictlyUnder(resolved, usersRoot)) return null;
  const memberId = path.relative(usersRoot, resolved).split(path.sep)[0];
  return /^\d+$/.test(memberId) ? path.join(usersRoot, memberId, underHome) : null;
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

/**
 * Realpath of `candidate` when it is a regular file under one of `roots` and
 * passes `accept`; otherwise null. Never throws.
 */
export async function resolveContainedFile(
  candidate: string | null | undefined,
  roots: Iterable<string>,
  accept: (resolved: string) => boolean = () => true,
): Promise<string | null> {
  const resolved = await realFileOf(candidate, accept);
  if (!resolved) return null;
  const contained = await realRoots(roots);
  return contained.some((root) => isStrictlyUnder(resolved, root)) ? resolved : null;
}

/**
 * Realpath of `candidate` when it is a regular file passing `accept` under one of
 * `sharedRoots` or under `<member tree>/<underHome>` of the member tree holding
 * it; otherwise null. Never throws.
 */
export async function resolveProviderTranscript(
  candidate: string | null | undefined,
  sharedRoots: Iterable<string>,
  underHome: string,
  accept: (resolved: string) => boolean,
): Promise<string | null> {
  const resolved = await realFileOf(candidate, accept);
  if (!resolved) return null;
  const memberRoot = await memberTreeRoot(resolved, underHome);
  const roots = await realRoots(memberRoot ? [...sharedRoots, memberRoot] : sharedRoots);
  return roots.some((root) => isStrictlyUnder(resolved, root)) ? resolved : null;
}

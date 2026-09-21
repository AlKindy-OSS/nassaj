import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { operatorClaudeHome, resolveClaudeHomeForUser } from './claude-home.js';

/**
 * Transcript-path resolution for Claude sessions, shared by every reader that
 * needs the file behind a session row (B-823).
 *
 * The location cannot be re-derived from the project: a session launched inside
 * a nassaj session overlay runs with cwd
 * `<repo>/.git/nassaj-session-overlays/instances/<id>/workspace`, so Claude
 * writes its transcript under the OVERLAY-encoded directory while the session
 * row still names the repo project. Re-deriving `<projects>/<encoded
 * project_path>/<sessionId>.jsonl` therefore points at a file that never
 * existed. `sessions.jsonl_path` — written by the synchronizer from the file it
 * actually found — is the only source that survives that divergence.
 *
 * `jsonl_path` is a database column, so a reader that trusts it blindly becomes
 * an arbitrary-file-read primitive the moment anything can write that column.
 * Every candidate returned here is therefore realpath-resolved and required to
 * live under a Claude projects root. Containment is checked on the RESOLVED
 * path, not the literal one: on this box `~/.claude` is a symlink to
 * `nassaj-core`, and the database holds rows spelled both ways, so a textual
 * prefix test would reject perfectly valid transcripts.
 */

export type ClaudeTranscriptRow = {
  session_id: string;
  project_path?: string | null;
  jsonl_path?: string | null;
};

/** Claude's on-disk project folder name: every char outside [A-Za-z0-9-] → '-'. */
export function encodeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Every `<claude home>/projects` root that may hold this user's transcripts.
 * The per-user home comes from the same `resolveProviderEnv` seam the launcher
 * uses, so an isolated user's `CLAUDE_CONFIG_DIR` is honored; the operator home
 * stays in the list because Claude projects are shared by design.
 */
export function claudeProjectRoots(userId: string | number | null): string[] {
  const roots = new Set<string>();

  try {
    roots.add(path.join(resolveClaudeHomeForUser(userId), 'projects'));
  } catch {
    // A provider-env failure must not hide the operator home below.
  }
  roots.add(path.join(operatorClaudeHome(), 'projects'));

  return [...roots];
}

/** Resolves a root to its real location; absent roots simply drop out. */
async function realRoots(roots: string[]): Promise<string[]> {
  const resolved: string[] = [];

  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      // A root that does not exist on this host cannot contain anything.
    }
  }

  return resolved;
}

/** Realpath of `candidate` when it is a regular file, else null. */
async function realFile(candidate: string): Promise<string | null> {
  try {
    const resolved = await realpath(candidate);
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True when the already-resolved path sits under any resolved root. */
function isContained(target: string, roots: string[]): boolean {
  return roots.some((root) => isUnder(target, root));
}

/**
 * Resolves the transcript file for a Claude session row, or null when no
 * trusted file exists. Null is a real answer — "this session has no readable
 * transcript" — and callers must render it as such rather than as zero usage.
 */
export async function resolveClaudeTranscriptPath(
  row: ClaudeTranscriptRow,
  userId: string | number | null,
): Promise<string | null> {
  const sessionId = (row.session_id ?? '').trim();
  if (!sessionId || sessionId !== path.basename(sessionId)) {
    return null;
  }

  const roots = await realRoots(claudeProjectRoots(userId));
  if (roots.length === 0) {
    return null;
  }

  const fileName = `${sessionId}.jsonl`;

  const stored = (row.jsonl_path ?? '').trim();
  if (stored) {
    const resolved = await realFile(stored);
    if (resolved && path.basename(resolved) === fileName && isContained(resolved, roots)) {
      return resolved;
    }
  }

  // Fallback for rows the synchronizer has not indexed yet: the encoded path.
  const projectPath = (row.project_path ?? '').trim();
  if (!projectPath) {
    return null;
  }

  const encoded = encodeClaudeProjectDir(projectPath);
  for (const root of roots) {
    const resolved = await realFile(path.join(root, encoded, fileName));
    if (resolved && isContained(resolved, roots)) {
      return resolved;
    }
  }

  return null;
}

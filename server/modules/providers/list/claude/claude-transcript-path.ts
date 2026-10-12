import path from 'node:path';

import { operatorClaudeHome, resolveClaudeHomeForUser } from './claude-home.js';

/**
 * Claude project-directory helpers (B-823). The by-path transcript resolver
 * that lived here was removed with ADR-201 A-P2b: every transcript read goes
 * through the pinned reader (shared/session-transcript.ts), whose candidate is
 * the recorded `jsonl_path` only. A path re-derived from the project is wrong
 * for overlay sessions (Claude writes under the overlay-encoded directory),
 * which is why the recorded path, written at launch or by the synchronizer,
 * is the only source.
 */

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

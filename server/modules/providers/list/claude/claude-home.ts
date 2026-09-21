import os from 'node:os';
import path from 'node:path';

import { userDb } from '@/modules/database/index.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { readOptionalString } from '@/shared/utils.js';

/** Operator (shared / legacy) Claude configuration home: ~/.claude. */
export function operatorClaudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Resolves the Claude config home used by one user's spawn environment. Claude
 * writes transcripts below `<CLAUDE_CONFIG_DIR>/projects`, so this must use the
 * same central resolver as the launcher rather than reconstructing user paths.
 * Anonymous/shared callers retain the historical operator-home behavior.
 */
export function resolveClaudeHomeForUser(userId: string | number | null): string {
  const env = resolveProviderEnv(userId, 'claude', process.env);
  return readOptionalString(env.CLAUDE_CONFIG_DIR) ?? operatorClaudeHome();
}

/**
 * Returns every distinct Claude config home that can contain transcripts: the
 * operator home plus all registered users' effective homes. Enumeration is
 * best-effort so a transient database failure never blocks session indexing.
 */
export function resolveClaudeHomes(): string[] {
  const homes = new Set<string>([operatorClaudeHome()]);

  try {
    for (const user of userDb.listUsers()) {
      homes.add(resolveClaudeHomeForUser(user.id));
      // T-1675: a member on a delegated credential resolves to the grantor's
      // home above; their OWN tree still holds their earlier transcripts.
      homes.add(readOptionalString(resolveProviderEnv(user.id, 'claude', process.env, 'chat', { honorGrants: false }).CLAUDE_CONFIG_DIR) ?? operatorClaudeHome());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to enumerate per-user Claude homes; using operator home only', { error: message });
  }

  return [...homes];
}

/**
 * Derives the owning Claude config home from a transcript path. Claude stores
 * sessions under `<CLAUDE_CONFIG_DIR>/projects/...`; single-file watcher syncs
 * must resolve history.jsonl from that same home.
 */
export function claudeHomeForSessionFile(filePath: string): string {
  const marker = `${path.sep}projects${path.sep}`;
  const markerIndex = filePath.indexOf(marker);
  return markerIndex === -1 ? operatorClaudeHome() : filePath.slice(0, markerIndex);
}

import { lstatSync } from 'node:fs';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';

/** `pending`: the CLI has not written the file yet; try again on a later stream event. */
type RefreshOutcome = ReturnType<typeof sessionsDb.refreshDiscoveredSession> | 'skipped' | 'pending';

import { operatorClaudeHome } from './claude-home.js';
import { encodeClaudeProjectDir } from './claude-transcript-path.js';

/** Claude session ids are uuids; anything else is never turned into a path. */
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type ClaudeLaunchContext = { cwd: string | null | undefined; configDir: string | null | undefined };

/**
 * Where a Claude launch writes its transcript, derived from the spawn's own
 * context — its `CLAUDE_CONFIG_DIR` (else the operator home), its cwd and the
 * session id the CLI announced — never from file content: the CLI writes
 * `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl`. Null when unusable.
 */
export function claudeLaunchTranscriptPath(sessionId: string, context: ClaudeLaunchContext): string | null {
  const cwd = context.cwd?.trim();
  if (!cwd || !path.isAbsolute(cwd) || !SESSION_ID.test(sessionId)) return null;
  const configDir = context.configDir?.trim() || operatorClaudeHome();
  return path.join(configDir, 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** True when `file` is a regular file right now (its own entry, no link followed). */
function isWrittenFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * ADR-201 A2 (case g): fills the NULL `jsonl_path` of a just-launched Claude
 * session with the path its launch writes to, so readers that use only the
 * recorded path (token usage, progress seed, steer delivery) work before the
 * synchronizer indexes the file. Goes through `refreshDiscoveredSession`, so
 * the fill is admitted only from a recorded spawn participant's credential
 * tree or the operator root, and an existing path is never replaced here.
 *
 * M3 (ADR-201 qa): the path is recorded only once the file exists. A recorded
 * path whose file is absent is what the synchronizer's prune treats as a
 * retention-deleted ghost, so recording it early let a failed or cancelled run
 * (or a cwd the CLI encodes differently) lose its row, participants, authors
 * and failure mark. Until then this returns `pending` and the run retries on
 * its next stream event. Runs after the spawn participant is recorded. Never throws.
 */
export function recordClaudeLaunchTranscript(sessionId: string, context: ClaudeLaunchContext): RefreshOutcome {
  try {
    const jsonlPath = claudeLaunchTranscriptPath(sessionId, context);
    const row = sessionsDb.getSessionById(sessionId);
    if (!jsonlPath || !row?.project_path || row.jsonl_path || row.provider !== 'claude') return 'skipped';
    if (!isWrittenFile(jsonlPath)) return 'pending';
    return sessionsDb.refreshDiscoveredSession({
      sessionId, provider: 'claude', projectPath: row.project_path, jsonlPath,
    });
  } catch {
    return 'skipped';
  }
}

/**
 * Per-run recorder: calls {@link recordClaudeLaunchTranscript} on each stream
 * event until it is no longer `pending` (one `lstat` per event until the CLI
 * has written the file), then never again. Never throws.
 */
export function createClaudeLaunchTranscriptRecorder(): (sessionId: string | null | undefined, context: ClaudeLaunchContext | null) => void {
  let settled = false;
  return (sessionId, context) => {
    if (settled || !sessionId || !context) return;
    settled = recordClaudeLaunchTranscript(sessionId, context) !== 'pending';
  };
}

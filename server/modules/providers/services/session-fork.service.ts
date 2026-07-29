import os from 'node:os';
import path from 'node:path';

import { participantsDb, sessionsDb } from '@/modules/database/index.js';
import {
  forkClaudeTranscript,
  TranscriptForkError,
  type ForkExtraMessage,
} from '@/modules/providers/list/claude/claude-transcript-fork.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { notifySessionMetadataChanged } from '@/modules/providers/services/sessions-watcher.service.js';

/**
 * Session FORK orchestration (T-1090) — turns the one-shot `/btw` side question
 * into a real, continuable conversation.
 *
 * `/btw` answers from an SDK fork that persists NOTHING (ADR-077 / C1), which is
 * exactly right for a throwaway question and exactly wrong the moment the answer
 * is worth following up on: there is no thread to reply into. Forking branches
 * the session's transcript on disk and appends the question and the answer the
 * user just read, so the side thread opens as an ordinary session — same project,
 * same context, resumable by the CLI and the SDK alike.
 *
 * The heavy lifting (the upstream-faithful transcript rewrite) is in
 * claude-transcript-fork.ts. This layer owns everything AROUND the file:
 *   - resolving the source transcript (DB `jsonl_path`, else the encoded path),
 *   - indexing the new file so it has a sessions row without waiting for the
 *     6-second watcher poll,
 *   - recording the FORKER as the new session's participant. That is not
 *     cosmetic: a session with no participant and no message author fails the
 *     "native session" predicate (sessions.db.ts) and would never appear in the
 *     sidebar — the same orphan guard that hides out-of-band CLI runs,
 *   - broadcasting the sidebar refresh.
 *
 * Authorization is NOT decided here — the caller (the WS `btw-fork` handler)
 * applies the same write gate the abort path uses, before this runs.
 *
 * ── Two boundaries worth stating plainly ─────────────────────────────────────
 *
 * 1. The appended answer is CLIENT-SUPPLIED, and structurally has to be: the
 *    side query ran with `persistSession:false`, so the server kept no copy of
 *    what it streamed. A caller could therefore append an assistant turn the
 *    model never produced. That is not a privilege boundary — the branch is a
 *    new session the requester owns, and anyone can already type anything as a
 *    user message — but in a SHARED project a fabricated turn would read as
 *    Claude's words to other members. Recovering server-side ground truth would
 *    mean persisting every side query (the thing ADR-077 deliberately refuses),
 *    so the honest fix, if this ever matters, is to persist the answer for the
 *    life of the overlay and fork from THAT, not to trust harder.
 *
 * 2. The branch is cut from what is ON DISK, which is the same C5 contract the
 *    side query itself carries: a turn still mid-flight has not been flushed and
 *    is not in the branch. Forking during a live run is therefore allowed and
 *    safe — it reads a consistent prefix and never touches the running session.
 */

/** Upstream's own cap for the `btw: …` session title. */
const FORK_TITLE_MAX_LEN = 80;

/** Guards the appended pair against a pathological payload. */
const FORK_MAX_MESSAGE_CHARS = 100_000;

export type SessionForkErrorCode =
  | 'session_not_found'
  | 'unsupported_provider'
  | 'transcript_not_found'
  | 'source_empty'
  | 'source_too_large'
  | 'message_not_found'
  | 'fork_failed';

export class SessionForkError extends Error {
  readonly code: SessionForkErrorCode;

  constructor(code: SessionForkErrorCode, message: string) {
    super(message);
    this.name = 'SessionForkError';
    this.code = code;
  }
}

export interface ForkSessionParams {
  /** The live session being branched. */
  sessionId: string;
  /** The `/btw` question — appended as the branch's next user message. */
  question: string;
  /** The answer already streamed to the overlay — appended as the reply. */
  answer: string;
  /** Numeric user id of the requester; they own the resulting session. */
  userId: number | null;
  /** Optional context pin (the same id `/btw` answered against). */
  upToMessageId?: string | null;
}

export interface ForkSessionResult {
  sessionId: string;
  title: string;
  projectPath: string | null;
}

/** `btw: <question>` clipped to the upstream title budget. */
export function buildForkTitle(question: string): string {
  const normalized = (question ?? '').replace(/\s+/g, ' ').trim();
  const title = `btw: ${normalized}`;
  return title.length > FORK_TITLE_MAX_LEN
    ? `${title.slice(0, FORK_TITLE_MAX_LEN - 1)}…`
    : title;
}

/**
 * Claude's on-disk project folder name: every character outside [A-Za-z0-9-]
 * becomes '-'. Used only when the DB has no `jsonl_path` yet (a session row the
 * run path created before the synchronizer indexed its file).
 */
function encodeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function clip(text: string): string {
  const value = typeof text === 'string' ? text : '';
  return value.length > FORK_MAX_MESSAGE_CHARS ? value.slice(0, FORK_MAX_MESSAGE_CHARS) : value;
}

/**
 * Branches `sessionId` into a new session carrying the `/btw` exchange.
 *
 * Never partially registers: the transcript is renamed into place first, and
 * only an existing file is indexed and attributed.
 */
export async function forkSessionFromSideQuery(
  params: ForkSessionParams,
): Promise<ForkSessionResult> {
  const { sessionId, question, answer, userId, upToMessageId = null } = params;

  let row: { provider: string; project_path: string | null; jsonl_path: string | null } | null =
    null;
  try {
    row = sessionsDb.getSessionById(sessionId) ?? null;
  } catch {
    row = null;
  }
  if (!row) {
    throw new SessionForkError('session_not_found', 'Session not found.');
  }
  if (row.provider !== 'claude') {
    throw new SessionForkError(
      'unsupported_provider',
      `Forking a side question supports Claude sessions only (this session runs on "${row.provider}").`,
    );
  }

  const projectPath = (row.project_path ?? '').trim() || null;
  let sourceFilePath = (row.jsonl_path ?? '').trim();
  if (!sourceFilePath) {
    if (!projectPath) {
      throw new SessionForkError('transcript_not_found', 'This session has no transcript to fork.');
    }
    sourceFilePath = path.join(
      os.homedir(),
      '.claude',
      'projects',
      encodeClaudeProjectDir(projectPath),
      `${sessionId}.jsonl`,
    );
  }

  const title = buildForkTitle(question);
  const extraMessages: ForkExtraMessage[] = [
    { role: 'user', content: clip(question) },
    { role: 'assistant', content: clip(answer) },
  ];

  let forked;
  try {
    forked = await forkClaudeTranscript({
      sourceFilePath,
      sourceSessionId: sessionId,
      upToMessageId,
      extraMessages,
      title,
    });
  } catch (error) {
    if (error instanceof TranscriptForkError) {
      if (error.code === 'source_unreadable') {
        throw new SessionForkError('transcript_not_found', 'This session has no transcript to fork.');
      }
      if (
        error.code === 'source_empty'
        || error.code === 'source_too_large'
        || error.code === 'message_not_found'
      ) {
        throw new SessionForkError(error.code, error.message);
      }
    }
    console.error('[BTW] fork write failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new SessionForkError('fork_failed', 'The conversation could not be forked.');
  }

  // Index immediately instead of waiting for the watcher's 6s poll, so the new
  // session is openable the moment the client navigates to it.
  try {
    await sessionSynchronizerService.synchronizeProviderFile('claude', forked.filePath);
  } catch (error) {
    console.warn('[BTW] fork indexing failed; the watcher will retry', {
      sessionId: forked.forkedSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // The forker owns the branch. Without this row the session is an "orphan" and
  // stays hidden from every listing (see the native-session predicate).
  if (Number.isInteger(userId) && userId !== null) {
    const spawnProjectPath = projectPath ?? forked.cwd;
    participantsDb.recordSpawn(
      forked.forkedSessionId,
      userId,
      spawnProjectPath ? { provider: 'claude', projectPath: spawnProjectPath } : undefined,
    );
  }

  try {
    notifySessionMetadataChanged('claude', forked.forkedSessionId);
  } catch {
    // Broadcast is best-effort; the watcher's own poll still refreshes clients.
  }

  console.log(
    `[BTW] fork created source=${sessionId} forked=${forked.forkedSessionId} `
    + `entries=${forked.entryCount} userIdValue=${String(userId)}`,
  );

  return {
    sessionId: forked.forkedSessionId,
    title,
    projectPath: projectPath ?? forked.cwd,
  };
}

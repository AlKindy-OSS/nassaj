import { sessionsDb } from '@/modules/database/index.js';

import { isSessionAccessibleByUser } from '../services/session-access.js';

import { openRecordedTranscript, type SessionTranscriptResult, type TranscriptPurpose } from './session-transcript-reader.js';

/**
 * ADR-201 A1 — the one way to read a session's transcript and its sibling
 * artifact directories. `openSessionTranscript` authorises the requester on the
 * session (step 1; a refusal is indistinguishable from "no such session") and
 * hands the row to the reader (session-transcript-reader.ts) for steps 2–6:
 * candidate from the recorded `jsonl_path`, confinement to the one tree that
 * holds it, pinned open, and the per-provider name/header id check.
 */

export * from './session-transcript-reader.js';

export type TranscriptRequester = number | null | { userId: number | null; access: 'read' | 'restamp' };

function requesterOf(requester: TranscriptRequester): { userId: number | null; access: 'read' | 'restamp' } {
  return requester !== null && typeof requester === 'object' ? requester : { userId: requester, access: 'read' };
}

/**
 * Opens the transcript of `sessionId` for `requester` (ADR-201 A1). Resolves
 * to `{ fd, realpath, stat }` (the caller closes `fd`) or `{ reason }`; an
 * unauthorised requester gets `not_found`, exactly as for a missing session.
 */
export async function openSessionTranscript(
  sessionId: string, requester: TranscriptRequester, purpose: TranscriptPurpose,
): Promise<SessionTranscriptResult> {
  const { userId, access } = requesterOf(requester);
  let row: ReturnType<typeof sessionsDb.getHistorySource> = null;
  try {
    row = sessionsDb.getHistorySource(sessionId);
    if (row && !isSessionAccessibleByUser(sessionId, row.project_path, userId, access)) row = null;
  } catch {
    row = null;
  }
  if (!row) return { reason: 'not_found' };
  return openRecordedTranscript(row, purpose);
}

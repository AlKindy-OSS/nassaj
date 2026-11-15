/**
 * ADR-173 P8 B1 — pairing a colleague's live prompt (`user_turn`, marked
 * `sharedTurn`) with the saved transcript row of the same turn, so the viewer
 * sees one bubble, not two until reload.
 *
 * Key first: the persisted transcript id the server names (`messageUuid` on
 * `user_turn`), stored on the live row as `transcriptMessageId`; the saved row carries it as its id, or as
 * `<uuid>_text_<n>` for block content. Without it, a conservative fallback: same author (or
 * an unstamped saved row), same text, within a short window, and never a saved
 * row that acknowledges another send. Pairing is one-to-one.
 */
import type { NormalizedMessage } from './useSessionStore';

/** How far apart (ms) a live prompt and its saved row may be for the text fallback. */
export const SHARED_TURN_MATCH_WINDOW_MS = 60_000;

function isUserText(row: NormalizedMessage): boolean {
  return row.kind === 'text' && row.role === 'user';
}

/** A colleague's live prompt shown from a `user_turn` frame. */
export function isSharedLiveTurn(row: NormalizedMessage): boolean {
  return row.sharedTurn === true && isUserText(row);
}

/** A saved (or stream-echoed) user row that may stand for a live shared prompt. */
function isSavedUserRow(row: NormalizedMessage): boolean {
  return isUserText(row) && row.sharedTurn !== true
    && !row.id.startsWith('cmid_') && !row.id.startsWith('local_');
}

/** The saved row of a transcript uuid: the row itself, or a block of it (`<uuid>_text_<n>`). */
function isRowOfTranscriptId(saved: NormalizedMessage, uuid: string): boolean {
  return saved.id === uuid || saved.id.startsWith(`${uuid}_`);
}

function sameTurnByText(live: NormalizedMessage, saved: NormalizedMessage): boolean {
  const ack = saved.clientMsgId ?? saved.displayClientMsgId;
  if (ack && ack !== live.sharedClientMsgId) return false;
  if (typeof saved.userId === 'number' && saved.userId !== live.userId) return false;
  const text = (live.content || '').trim();
  if (!text || text !== (saved.content || '').trim()) return false;
  const gap = Math.abs(Date.parse(saved.timestamp) - Date.parse(live.timestamp));
  return Number.isFinite(gap) && gap <= SHARED_TURN_MATCH_WINDOW_MS;
}

/**
 * Live shared prompts paired with the saved row of the same turn. A live row
 * that knows its transcript id pairs by that id only; the others fall back to
 * text. Each saved row retires at most one live prompt.
 */
export function pairSharedTurns(
  liveRows: readonly NormalizedMessage[],
  savedRows: readonly NormalizedMessage[],
): Map<NormalizedMessage, NormalizedMessage> {
  const pairs = new Map<NormalizedMessage, NormalizedMessage>();
  const used = new Set<NormalizedMessage>();
  const candidates = savedRows.filter(isSavedUserRow);
  const live = liveRows.filter(isSharedLiveTurn);
  for (const row of live) {
    if (!row.transcriptMessageId) continue;
    const uuid = row.transcriptMessageId;
    const match = candidates.find(saved => !used.has(saved) && isRowOfTranscriptId(saved, uuid));
    if (match) { pairs.set(row, match); used.add(match); }
  }
  for (const row of live) {
    if (row.transcriptMessageId || pairs.has(row)) continue;
    const match = candidates.find(saved => !used.has(saved) && sameTurnByText(row, saved));
    if (match) { pairs.set(row, match); used.add(match); }
  }
  return pairs;
}

/**
 * Drop each paired live prompt from a merged list and let its saved row carry
 * the author the live frame named (the saved row may arrive unstamped).
 */
export function foldSharedTurns(merged: NormalizedMessage[]): NormalizedMessage[] {
  if (!merged.some(isSharedLiveTurn)) return merged;
  const pairs = pairSharedTurns(merged, merged);
  if (pairs.size === 0) return merged;
  const authorFor = new Map<NormalizedMessage, NormalizedMessage>();
  for (const [live, saved] of pairs) authorFor.set(saved, live);
  const out: NormalizedMessage[] = [];
  for (const row of merged) {
    if (pairs.has(row)) continue;
    const live = authorFor.get(row);
    out.push(live ? {
      ...row,
      userId: row.userId ?? live.userId,
      authorName: row.authorName ?? live.authorName,
    } : row);
  }
  return out;
}

/**
 * Live prompts a history read retires for good: paired with a saved row that
 * carries its own author stamp. One paired with an unstamped row stays (hidden
 * by `foldSharedTurns`) so the author it names is not lost.
 */
export function durablyCoveredSharedTurns(
  realtime: readonly NormalizedMessage[],
  server: readonly NormalizedMessage[],
): Set<NormalizedMessage> {
  const covered = new Set<NormalizedMessage>();
  for (const [live, saved] of pairSharedTurns(realtime, server)) {
    if (typeof saved.userId === 'number') covered.add(live);
  }
  return covered;
}

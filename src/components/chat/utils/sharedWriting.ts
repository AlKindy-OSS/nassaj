/**
 * ADR-173 rev.3 P6 (client half) — shared writing in conversations.
 *
 * Pure readers for the frames the server sends when a member writes in a
 * conversation another member started (UI contract in the ADR), and the
 * non-starter rules for approval prompts. The server enforces every rule; these
 * only decide what the UI shows, so an unknown value always falls back to
 * today's behaviour.
 */
import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { readServerErrorCode } from './serverErrorMessage';

/** What occupies a session that refused a send. */
export type SessionBusyPhase = 'running' | 'post_result' | 'scheduled_wake' | 'launching';

const BUSY_PHASES: ReadonlySet<string> = new Set(['running', 'post_result', 'scheduled_wake', 'launching']);

export interface SessionBusyInfo {
  /** users.id of the member whose turn holds the session; null when unknown. */
  busyBy: number | null;
  phase: SessionBusyPhase;
  /** No stream event for the configured threshold (server-judged). */
  stuck: boolean;
  /** Whether the refused sender may stop that turn (server-judged). */
  canStop: boolean;
}

export interface SharedWritingRefusal {
  provider: string | null;
  creatorName: string | null;
  canFork: boolean;
}

/** The UI notice shown above the composer, scoped to the session it is about. */
export type SharedWritingNotice =
  | ({ kind: 'busy'; sessionId: string } & SessionBusyInfo)
  | { kind: 'stop_forbidden'; sessionId: string; busyBy: number | null; stuck: boolean }
  | ({ kind: 'unsupported'; sessionId: string } & SharedWritingRefusal)
  /** ADR-173 P8 B4: another member stopped the reply on screen. */
  | { kind: 'stopped_by'; sessionId: string; stoppedBy: number; stoppedByName: string | null };

/** Server cap on a non-starter's deny note (ADR-173 M3). */
export const SHARED_DENY_NOTE_MAX_CHARS = 500;

type Frame = Record<string, unknown>;

function toUserId(value: unknown): number | null {
  const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Occupancy of a `session_busy` refusal; null for any other frame. */
export function readSessionBusy(msg: Frame): SessionBusyInfo | null {
  if (msg.kind !== 'error' || readServerErrorCode(msg) !== 'session_busy') return null;
  // A refusal without occupancy (older servers, other providers) keeps the generic banner.
  if (!('phase' in msg) && !('busyBy' in msg)) return null;
  const phase = typeof msg.phase === 'string' && BUSY_PHASES.has(msg.phase)
    ? msg.phase as SessionBusyPhase : 'running';
  return { busyBy: toUserId(msg.busyBy), phase, stuck: msg.stuck === true, canStop: msg.canStop === true };
}

/** The pre-start refusal of a member continuing another member's conversation. */
export function readSharedWritingRefusal(msg: Frame): SharedWritingRefusal | null {
  if (msg.kind !== 'complete' || readServerErrorCode(msg) !== 'shared_writing_unsupported') return null;
  return {
    provider: nonEmptyString(msg.provider),
    creatorName: nonEmptyString(msg.creatorName),
    canFork: msg.canFork === true,
  };
}

/** A stop request the server refused: the turn it names is still running. */
export function isTurnStopForbidden(msg: Frame): boolean {
  return msg.kind === 'complete' && readServerErrorCode(msg) === 'turn_stop_forbidden';
}

/**
 * The `user_turn` frame as a user text row stamped with its author, or null when
 * it is the viewer's own prompt (by author, or by a message id the viewer holds).
 * P8 B1: keyed by the server's id (never a bare `cmid_`, which the store would
 * take for the viewer's own optimistic send) and marked `sharedTurn`; the saved
 * transcript row of the same turn replaces it (`messageUuid`, or the fallback in
 * sharedTurnReconcile).
 */
export function sharedUserTurnRow(
  msg: Frame,
  viewer: { currentUserId: number | null; isOwnMessageId: (id: string) => boolean },
): NormalizedMessage | null {
  if (msg.kind !== 'user_turn') return null;
  const sessionId = nonEmptyString(msg.sessionId);
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!sessionId || !content.trim()) return null;
  const authorUserId = toUserId(msg.authorUserId);
  if (authorUserId !== null && viewer.currentUserId !== null && authorUserId === viewer.currentUserId) return null;
  const clientMsgId = nonEmptyString(msg.clientMsgId);
  if (clientMsgId && viewer.isOwnMessageId(clientMsgId)) return null;
  const id = nonEmptyString(msg.id) ?? (clientMsgId ? `user_turn_${clientMsgId}` : null);
  if (!id) return null;
  const messageUuid = nonEmptyString(msg.messageUuid);
  const imageCount = typeof msg.imageCount === 'number' && msg.imageCount > 0 ? msg.imageCount : 0;
  return {
    id,
    sessionId,
    timestamp: nonEmptyString(msg.timestamp) ?? new Date().toISOString(),
    provider: (nonEmptyString(msg.provider) ?? 'claude') as NormalizedMessage['provider'],
    kind: 'text',
    role: 'user',
    content,
    ...(authorUserId !== null ? { userId: authorUserId } : {}),
    ...(nonEmptyString(msg.authorName) ? { authorName: msg.authorName as string } : {}),
    sharedTurn: true,
    ...(clientMsgId ? { sharedClientMsgId: clientMsgId } : {}),
    ...(messageUuid ? { transcriptMessageId: messageUuid } : {}),
    ...(imageCount > 0 ? { sharedImageCount: imageCount } : {}),
    ...(typeof msg.sequence === 'number' ? { sequence: msg.sequence } : {}),
  };
}

/**
 * P8 B2: the send a refusal is about — a busy refusal, or any pre-start refusal
 * (`complete` with `success:false` and `notStarted`). Null for anything else, or
 * when the frame names no send (older servers: handled as before).
 */
export function readSendRefusalClientMsgId(msg: Frame): string | null {
  const isBusy = msg.kind === 'error' && readServerErrorCode(msg) === 'session_busy';
  const isPreStart = msg.kind === 'complete' && msg.success === false && msg.notStarted === true;
  return isBusy || isPreStart ? nonEmptyString(msg.clientMsgId) : null;
}

/** P8 B4: who stopped an aborted turn (`stoppedBy` on the aborted `complete`); null when unnamed. */
export function readStoppedBy(msg: Frame): { userId: number; name: string | null } | null {
  if (msg.kind !== 'complete' || msg.aborted !== true) return null;
  const stopper = msg.stoppedBy && typeof msg.stoppedBy === 'object' ? msg.stoppedBy as Frame : null;
  const userId = stopper ? toUserId(stopper.userId) : null;
  return userId === null ? null : { userId, name: nonEmptyString(stopper?.name) };
}

/**
 * P8 B4: the notice telling the starter and other viewers that another member
 * stopped the reply. None for the member who stopped it, nor when the starter
 * stopped their own turn (`starterUserId` from the frame, else the caller's).
 */
export function stoppedByNotice(
  msg: Frame,
  viewer: { sessionId: string; currentUserId: number | null; starterUserId: number | null },
): SharedWritingNotice | null {
  const stopper = readStoppedBy(msg);
  if (!stopper || stopper.userId === toUserId(viewer.currentUserId)) return null;
  const starter = toUserId(msg.starterUserId) ?? toUserId(viewer.starterUserId);
  if (starter !== null && starter === stopper.userId) return null;
  return { kind: 'stopped_by', sessionId: viewer.sessionId, stoppedBy: stopper.userId, stoppedByName: stopper.name };
}

/** The author of the newest user row on screen: the starter of the turn that just ended. */
export function newestUserAuthor(rows: ReadonlyArray<{ kind?: string; role?: string; userId?: number }>): number | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === 'text' && row.role === 'user') return toUserId(row.userId);
  }
  return null;
}

/**
 * Prompts the server keeps for the starter alone besides external identity: a question
 * (its answer is edited input) and the plan approval (ADR-173 M-c, qa r2 #3).
 */
const STARTER_ONLY_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

/**
 * How the viewer may answer an approval prompt:
 *  - `starter`     — the turn's starter (or the starter is unknown): today's controls;
 *  - `non_starter` — another shared writer: allow/deny with a capped note only;
 *  - `read_only`   — another member on a starter-only prompt (external identity,
 *                    a question answered by edited input, or a plan approval): no controls.
 */
export function permissionAnswerRole(
  request: { toolName: string; externalIdentity?: boolean; starterUserId?: number | null },
  viewerUserId: number | null,
  runStarterUserId: number | null,
): 'starter' | 'non_starter' | 'read_only' {
  const starter = toUserId(request.starterUserId) ?? toUserId(runStarterUserId);
  const viewer = toUserId(viewerUserId);
  if (starter === null || viewer === null || starter === viewer) return 'starter';
  if (request.externalIdentity === true || STARTER_ONLY_TOOLS.has(request.toolName)) return 'read_only';
  return 'non_starter';
}

/**
 * P8: whether the conversation holds user messages by more than one human
 * (author ids on live and saved rows). Only then is every prompt captioned
 * with its author; a solo conversation keeps its earlier look.
 */
export function hasSeveralHumanAuthors(messages: ReadonlyArray<{ type?: string; userId?: number }>): boolean {
  let first: number | null = null;
  for (const message of messages) {
    if (message.type !== 'user') continue;
    const id = toUserId(message.userId);
    if (id === null) continue;
    if (first === null) first = id;
    else if (id !== first) return true;
  }
  return false;
}

/** A non-starter's deny note, trimmed and capped as the server caps it. */
export function capDenyNote(text: string): string {
  return text.trim().slice(0, SHARED_DENY_NOTE_MAX_CHARS);
}

/** The newest transcript id a conversation can be forked at; null when none. */
export function lastForkableMessageId(messages: ReadonlyArray<{ transcriptMessageId?: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i].transcriptMessageId;
    if (typeof id === 'string' && id.trim()) return id;
  }
  return null;
}

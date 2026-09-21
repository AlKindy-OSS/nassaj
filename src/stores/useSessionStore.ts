/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  | 'task_reconcile';

export interface NormalizedMessage {
  /** Structured provider error, preserved for safe classification at render time. */
  error?: unknown;
  id: string;
  sessionId: string;
  timestamp: string;
  /** Durable response metric persisted by the server for this final reply. */
  responseTurnMetric?: {
    durationMs: number;
    startedAt: string;
    completedAt: string;
  };
  /** Client-generated turn identity echoed by the active run only. */
  clientMsgId?: string;
  /**
   * B-1078: the optimistic `cmid_` id of the send this history user row was
   * bound to by identity (transcript uuid + payload hash), whatever the turn
   * state. Display pairing only — never outbox deletion proof (`clientMsgId`).
   */
  displayClientMsgId?: string;
  /** Exact optimistic user-row id that started this streamed reply. */
  responseToMessageId?: string;
  /** Local-only provenance, retained when a streaming placeholder is finalized. */
  clientStream?: true;
  provider: LLMProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /** Coordination level persisted with this user turn. */
  coordinationLevel?: 'direct' | 'delegate' | 'delegate_review';
  /**
   * Authenticated author (users.id) of a kind:'text' role:'user' message in
   * multi-user sessions; same id as the participants API. Absent = author
   * unknown (rows recorded before author tracking, provider-internal echoes) —
   * never assume the viewing user wrote it.
   */
  userId?: number;
  /**
   * Coordinator attribution for a kind:'text' role:'assistant' message (server
   * commit 9c61b60): the users.id of the participant who launched the run that
   * produced this reply. Stamped live and on reloaded history. Absent/null =
   * unknown coordinator (legacy rows) — clients fall back to the session owner.
   */
  coordinatorId?: number | null;
  /**
   * The model that produced this assistant message, verbatim from the provider
   * (B-352). Stamped live and on reloaded history. Absent = the provider names
   * no model for this row — never substitute the session's model, since one
   * session can hold turns from several of them.
   */
  model?: string;
  /** Canonical provider transcript id for a primary assistant reply. */
  transcriptMessageId?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: string[];
  files?: { name: string; path: string; relPath?: string; size?: number; mimeType?: string }[];
  /** Images deliberately omitted by the history API to cap memory usage. */
  imagesOmitted?: number;
  /** Heavy fields omitted from a light history payload and available on demand. */
  deferredPayload?: {
    schema?: number;
    revision?: string;
    fields: string[];
  };
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  /** Machine-readable error discriminator (e.g. 'conversation_not_found'). */
  code?: string;
  /** Stale resume target reported alongside a 'conversation_not_found' error. */
  staleSessionId?: string;
  /**
   * Machine origin discriminator for a kind:'text' role:'user' message (server
   * commit 91b8b39). Absent = genuine human input (has a userId stamp).
   * Present = the row was written programmatically, not by a human:
   *   'coordinator' — the coordinator (main agent) prompted a sub-agent via
   *                   Task/Agent tool; never has a userId.
   *   'peer'        — inter-agent peer message.
   *   'channel'     — broadcast channel injection.
   *   'task-notification' — automated task status update.
   * Rule: role:'user' + originKind present ⇒ machine-authored; absent ⇒ human.
   */
  originKind?: 'coordinator' | 'peer' | 'channel' | 'task-notification' | string;
  /** Original command that failed to resume, used to retry as a new session. */
  command?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  /** الجلسة الأمّ لحدث `session_created` (B-426): null = محادثة جديدة. */
  parentSessionId?: string | null;
  /** A new user-owned continuation branch, not a replacement for its parent. */
  forked?: boolean;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  /**
   * Workflow identifier for task_reconcile rows (B-94/B-95).
   * Matches the wfId parsed from the stopped notification so the UI can
   * replace or append to the stopped card for the same workflow.
   */
  wfId?: string;
  /** Number of agents that finished (task_reconcile). */
  agentsDone?: number;
  /** Total agents in the workflow (task_reconcile). */
  agentsTotal?: number;
  /**
   * Terminal outcome carried on a task_reconcile row (C5). The backend emits
   * 'completed' (all agents finished) or 'settled' (workflow quiesced but some
   * agents never completed); the UI renders distinct copy for each. Absent =
   * legacy row, treated as 'completed'.
   */
  taskStatus?: 'completed' | 'settled' | string;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export type HistoryOperation = 'initial' | 'older' | 'all' | 'deferred' | 'reconnect';
export type HistoryFailure = {
  ok: false;
  status: number;
  code: string | null;
  retryAfterMs: number | null;
};
export type HistoryError = HistoryFailure & { operation: HistoryOperation; retryAt: number };

/**
 * Statuses that describe a transient transport/gateway problem rather than a
 * client- or content-level rejection, so a later identical read can still
 * succeed. Includes 0 (fetch rejected / offline), the standard 502/503/504, and
 * the Cloudflare-tunnel origin errors 520–524/530 the owner's live tunnel
 * emits when the origin recycles during a restart/drain (T-1660). A 4xx
 * (400/401/404/413) is deliberately excluded — retrying it is pointless.
 */
export const HISTORY_RETRYABLE_STATUSES: readonly number[] = Object.freeze(
  [0, 502, 503, 504, 520, 521, 522, 523, 524, 530],
);
/** Give up automatic recovery after this many attempts and leave the manual button. */
export const HISTORY_AUTO_RETRY_CAP = 5;

/** Bound untrusted Retry-After values; excessive delays disable automatic retry. */
export function historyRetryDelay(error: HistoryFailure): number | null {
  if (!HISTORY_RETRYABLE_STATUSES.includes(error.status)) return null;
  const delay = error.retryAfterMs ?? 2000;
  return delay <= 60_000 ? Math.max(1000, delay) : null;
}

/**
 * Decide whether the automatic recovery loop should schedule another read and
 * after how long. Exponential backoff (1s, 2s, 4s, 8s, 16s) capped at 30s and
 * never earlier than the failure's own retryAt (an honoured Retry-After). Once
 * `attempt` reaches the cap, or the status is not retryable, recovery stops and
 * the sticky banner keeps only its manual "Try again" button.
 */
export function planHistoryAutoRetry(
  error: HistoryError | null | undefined,
  attempt: number,
  now = Date.now(),
): { retry: boolean; delayMs: number } {
  if (!error || historyRetryDelay(error) === null || attempt >= HISTORY_AUTO_RETRY_CAP) {
    return { retry: false, delayMs: 0 };
  }
  const backoff = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return { retry: true, delayMs: Math.max(backoff, error.retryAt - now) };
}

/** Only these conflicts allow an explicit fresh-tail rebase. */
export function isHistoryRebaseFailure(error: Pick<HistoryFailure, 'code'> | null | undefined): boolean {
  return error?.code === 'HISTORY_REVISION_CHANGED' || error?.code === 'CURSOR_STALE';
}

/**
 * Banner keys are the ONE mapping from a history failure to the message the user
 * reads. The generic `'unavailable'` bucket is the fallback for every failure
 * that is not a rebase conflict, an incomplete source, or a specific transport
 * budget/busy/timeout status — it therefore absorbs pure transport failures
 * (`status === 0`), auth rejections (401), not-found (404), bad-request (400)
 * and internal errors (500). Because those causes are collapsed into one label
 * AND, for `status === 0`, never reach the server at all, an `'unavailable'`
 * banner used to be undiagnosable (T-1660). Exporting the classifier lets the
 * banner (ChatMessagesPane) and the diagnostic log below share a single source
 * of truth, so their verdicts can never drift.
 */
export type HistoryBannerKey = 'revision' | 'incomplete' | 'budget' | 'busy' | 'timeout' | 'unavailable';
export function classifyHistoryFailure(
  error: Pick<HistoryFailure, 'status' | 'code'> | null | undefined,
): HistoryBannerKey {
  if (isHistoryRebaseFailure(error)) return 'revision';
  if (error?.code === 'HISTORY_SOURCE_INCOMPLETE') return 'incomplete';
  if (error?.status === 413) return 'budget';
  if (error?.status === 503) return 'busy';
  if (error?.status === 504) return 'timeout';
  return 'unavailable';
}

/** Gate automatic reads without blocking independent session activity probes. */
export function canAutomaticallyReadHistory(error: HistoryError | null | undefined, now = Date.now()): boolean {
  return !error || (historyRetryDelay(error) !== null && now >= error.retryAt);
}

/** Classify transport/abort failures without retaining response bodies or paths. */
export function historyTransportFailure(error: unknown): HistoryFailure {
  const aborted = error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
  return { ok: false, status: aborted ? 499 : 0,
    code: aborted ? 'HISTORY_ABORTED' : 'HISTORY_NETWORK_ERROR', retryAfterMs: null };
}

/** Read only bounded public error metadata, never expose the server's message. */
async function readHistoryFailure(response: Response): Promise<HistoryFailure> {
  let code: string | null = null;
  try {
    const body = await response.json();
    const value = body?.error?.code ?? body?.code;
    if (typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value)) code = value;
  } catch { /* A proxy may return non-JSON. */ }
  const header = response.headers?.get('Retry-After');
  let retryAfterMs: number | null = null;
  if (header && header.length <= 128) {
    const value = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(value)) retryAfterMs = Math.min(86_400_000, Math.max(0, value));
  }
  return { ok: false, status: response.status, code, retryAfterMs };
}

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  /** Provider-owned anchor for the next older page. */
  historyCursor: string | null;
  tokenUsage: unknown;
  /** Full-session aggregate from response_turn_metrics, independent of paging. */
  responseTurnDurationTotalMs: number | null;
  historyError: HistoryError | null;
  historyGeneration: number;
  historyRevision: string | null;
  historyPayloadMode: 'light' | 'full' | null;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    historyCursor: null,
    tokenUsage: null,
    responseTurnDurationTotalMs: null,
    historyError: null,
    historyGeneration: 0,
    historyRevision: null,
    historyPayloadMode: null,
  };
}

const MAX_RESPONSE_TURN_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;

function validResponseDuration(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_RESPONSE_TURN_DURATION_MS
    ? value
    : null;
}

function validResponseDurationTotal(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
function userTextFingerprint(m: NormalizedMessage): string | null {
  if (m.kind !== 'text' || m.role !== 'user') return null;
  const t = (m.content || '').trim();
  return t.length > 0 ? t : null;
}

/** Text coverage utility for legacy delivery probes; never an identity for history deduplication. */
export function serverTextCoversLocal(serverText: string, localFingerprint: string): boolean {
  if (serverText === localFingerprint) return true;
  if (!serverText.startsWith(localFingerprint)) return false;
  const rest = serverText.slice(localFingerprint.length);
  // ما بعد النصّ إمّا فراغ محض، وإمّا مسافاتٌ ثم سطرٌ جديد يبدأ عنده المُذيَّل.
  return rest.trim() === '' || /^[^\S\n]*\n/.test(rest);
}

/** Whether a user row carries a current composer or legacy local identity. */
function isOptimisticUser(row: NormalizedMessage): boolean {
  return row.kind === 'text' && row.role === 'user'
    && (row.id.startsWith('cmid_') || row.id.startsWith('local_'));
}

/**
 * Exact echoed identity proves which send a canonical user row acknowledges.
 * `displayClientMsgId` (B-1078) pairs the row mid-turn; text never does (B-985/B-997).
 */
function acknowledgesUser(local: NormalizedMessage, saved: NormalizedMessage): boolean {
  return saved.kind === 'text' && saved.role === 'user'
    && (saved.id === local.id || saved.clientMsgId === local.id || saved.displayClientMsgId === local.id);
}

/**
 * Index of the optimistic user row a send identity names, scanning newest first.
 * With an id: that exact row only. Without one: the newest optimistic row holding
 * text. Only `branchSessionId` may use the id-less form (no mirrors); withdrawal
 * requires an id.
 */
function findOptimisticUserRowIndex(rows: NormalizedMessage[], clientMsgId?: string): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!isOptimisticUser(row)) continue;
    if (clientMsgId ? row.id === clientMsgId : userTextFingerprint(row) !== null) return i;
  }
  return -1;
}

/**
 * Retain unacknowledged composer rows, including attachment-only messages.
 * A canonical row can acknowledge at most one local send. Current cmid rows
 * require exact identity, as do legacy rows: repeated text cannot prove which
 * send reached history. An unidentifiable legacy echo may remain duplicated.
 */
export function retainUnsyncedOptimisticRows(
  realtime: NormalizedMessage[],
  server: NormalizedMessage[],
): NormalizedMessage[] {
  const consumed = new Set<number>();
  return realtime.filter(row => {
    if (!isOptimisticUser(row)) return false;
    const index = server.findIndex((saved, i) => !consumed.has(i) && acknowledgesUser(row, saved));
    if (index < 0) return true;
    consumed.add(index);
    return false;
  });
}

/** Require reply identity and text coverage before retiring a local assistant row. */
function persistedReplyCovers(row: NormalizedMessage, server: NormalizedMessage[]): boolean {
  const content = row.content;
  if (!content) return false;
  const synthetic = row.kind === 'stream_delta' || row.clientStream === true;
  return server.some(message => message.kind === 'text' && message.role === 'assistant'
    && (message.id === row.id || (synthetic && row.responseToMessageId
      && message.responseToMessageId === row.responseToMessageId))
    && message.content?.startsWith(content));
}

/** Shared history reconciliation: retain assistant content until its identity is covered. */
function retainUnconfirmedRealtime(
  realtime: NormalizedMessage[],
  server: NormalizedMessage[],
  capturedRows: ReadonlySet<NormalizedMessage> = new Set(realtime),
): NormalizedMessage[] {
  const unsyncedUsers = new Set(retainUnsyncedOptimisticRows(realtime, server));
  return realtime.filter(row => {
    if (!capturedRows.has(row) || row.id.startsWith('stream_gap_')) return true;
    if (row.kind === 'stream_delta' || (row.kind === 'text' && row.role === 'assistant')) {
      return !persistedReplyCovers(row, server);
    }
    return unsyncedUsers.has(row);
  });
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * `refreshFromServer` clears realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev && !(prev.responseToMessageId && m.responseToMessageId
      && prev.responseToMessageId !== m.responseToMessageId)) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          // B-1024: race condition — إطار النص المُثبَّت يصل بعد صف البث المُنتهي،
          // فيحمل responseTurnMetric الذي ألصقه applyResponseTurnCompletion على
          // الأحدث لا الأسبق. نستبدل الأسبق بالأحدث لحفظ بيانات التوقيت.
          if (m.responseTurnMetric && !prev.responseTurnMetric) {
            out[out.length - 1] = m;
          }
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) return server;
  if (server.length === 0) return dedupeAdjacentAssistantEchoes([...realtime].sort(compareMessagesByTimestamp));
  const serverIds = new Set(server.map(m => m.id));
  const pendingUsers = new Set(retainUnsyncedOptimisticRows(realtime, server));
  const extra = realtime.filter((m) => {
    if (serverIds.has(m.id)) return false;
    if (isOptimisticUser(m) && !pendingUsers.has(m)) return false;
    return true;
  });
  if (extra.length === 0) return server;
  const merged = [...server, ...extra].sort(compareMessagesByTimestamp);
  return dedupeAdjacentAssistantEchoes(merged);
}

// design-ok: ‏`left:`/`right:` أدناه وسيطان في توقيع دالة مقارنة (TypeScript)،
// لا خاصّيتا CSS فيزيائيتان. لا تخطيط في هذا الملف أصلاً — إنه مخزن رسائل.
export function compareMessagesByTimestamp(left: NormalizedMessage, right: NormalizedMessage): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);

  if (Number.isNaN(leftTime) || Number.isNaN(rightTime) || leftTime === rightTime) {
    return 0;
  }

  return leftTime - rightTime;
}

function rewriteMessageSessionId(
  msg: NormalizedMessage,
  fromSessionId: string,
  toSessionId: string,
): NormalizedMessage {
  const streamingSourceId = `__streaming_${fromSessionId}`;
  const nextId = msg.id === streamingSourceId ? `__streaming_${toSessionId}` : msg.id;

  if (msg.sessionId === toSessionId && nextId === msg.id) {
    return msg;
  }

  return {
    ...msg,
    id: nextId,
    sessionId: toSessionId,
  };
}

function mergeMessagesById(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  const merged = [...existing, ...incoming];
  const deduped: NormalizedMessage[] = [];
  const seen = new Set<string>();

  for (const msg of merged) {
    if (seen.has(msg.id)) {
      continue;
    }

    seen.add(msg.id);
    deduped.push(msg);
  }

  deduped.sort(compareMessagesByTimestamp);
  return deduped;
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

/**
 * B-432: علامة الصفحة التالية، مشتقّةً ممّا نملكه فعلاً لا من عدّاد يُزاد يدوياً.
 *
 * نقطة `/messages` مرساتها **الذيل** (`endIndex = total - offset`)، فمعنى
 * `offset` هو «كم صفّاً من الذيل عندي». وكان `slot.offset` لا يُزاد حين يكبر
 * الذيل بغير `fetchMore`: التشغيل الحيّ (`mergeTailFromServer` يوثّق تركه
 * صراحةً) و`refreshFromServer` كلاهما يضيف صفوفاً ولا يمسّه. فينزلق العدّاد
 * تحت الواقع بمقدار ما كُتب أثناء الجلسة، وتعود صفحة «الأقدم» حاملةً أحدث
 * الصفوف.
 *
 * `serverMessages` كتلة متّصلة من ذيل السجلّ دائماً (التحميل الأول ذيل،
 * وfetchMore يُلصق الأقدم في رأسها)، فطولها علامة ذاتية التصحيح. وتُؤخذ
 * الأكبر من الاثنتين تحوّطاً: علامةٌ أكبر تفوّت صفوفاً في أسوأ الحالات، بينما
 * الأصغر تُعيد تحميل ما هو معروض.
 */
export function resolveTailBookmark(slot: Pick<SessionSlot, 'offset' | 'serverMessages'>): number {
  return Math.max(slot.offset, slot.serverMessages.length);
}

/**
 * B-432: الحزام الثاني — لا يُلصَق في **رأس** المحادثة صفٌّ نملكه أصلاً.
 *
 * الإلصاق كان بلا فحص هوية إطلاقاً، فأي تداخل في النافذة (انزلاق العلامة، أو
 * كتابة جديدة بين قراءة `total` والتقطيع) يُنتج نسخةً من أحدث الصفوف جالسةً
 * فوق أقدمها. والترتيب الزمني لا يحميه: `computeMerged` لا يرتّب شيئاً حين
 * تكون `realtimeMessages` فارغة، فيُعرض ترتيب المصفوفة كما هو.
 */
export function selectTrulyOlder(
  held: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const heldIds = new Set(held.map((m) => m.id));
  return incoming.filter((m) => !heldIds.has(m.id));
}

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const sessionAliasesRef = useRef(new Map<string, string>());
  const activeSessionIdRef = useRef<string | null>(null);
  // ADR-041 (B-80): highest stream `sequence` seen per session. Sent as `lastSeq`
  // in check-session-status so the server replays only the delta on reconnect.
  // Kept in a ref (not slot state) because it must survive independently of the
  // message arrays and is read synchronously; it monotonically increases and is
  // never reset for the life of a session id.
  const lastSeqRef = useRef(new Map<string, number>());
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    if (resolvedSessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const resolveSessionId = useCallback((sessionId: string | null | undefined): string | null => {
    if (!sessionId) {
      return null;
    }

    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    return resolvedSessionId;
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = resolveSessionId(sessionId);
  }, [resolveSessionId]);

  // ADR-041 (B-80): record the highest stream `sequence` seen for a session.
  // Monotonic max — an out-of-order or older payload never lowers it. No-op for
  // a non-finite/absent sequence (legacy payloads, or the registry flag off
  // server-side so no `sequence` is ever stamped). Keyed by the resolved session
  // id so an alias (post session_created rename) shares one counter.
  const recordSeq = useCallback((sessionId: string, sequence: unknown) => {
    if (typeof sequence !== 'number' || !Number.isFinite(sequence)) return;
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const prev = lastSeqRef.current.get(resolvedSessionId) ?? 0;
    if (sequence > prev) {
      lastSeqRef.current.set(resolvedSessionId, sequence);
    }
  }, [resolveSessionId]);

  // ADR-041 (B-80): highest stream `sequence` seen for a session (0 when unknown).
  // Sent as `lastSeq` in check-session-status so the server replays only seq >
  // lastSeq on reconnect.
  const getLastSeq = useCallback((sessionId: string): number => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return lastSeqRef.current.get(resolvedSessionId) ?? 0;
  }, [resolveSessionId]);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const store = storeRef.current;
    if (!store.has(resolvedSessionId)) {
      store.set(resolvedSessionId, createEmptySlot());
    }
    return store.get(resolvedSessionId)!;
  }, [resolveSessionId]);

  /** Begin a competing history operation; only its generation may subsequently commit. */
  const beginHistoryRequest = useCallback((sessionId: string): number => {
    const slot = getSlot(sessionId);
    slot.historyGeneration += 1;
    return slot.historyGeneration;
  }, [getSlot]);

  /** A view epoch alone cannot protect concurrent reads of the same session. */
  const isHistoryRequestCurrent = useCallback((sessionId: string, generation: number): boolean => (
    getSlot(sessionId).historyGeneration === generation
  ), [getSlot]);

  type HistorySnapshot = {
    messages: NormalizedMessage[];
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
    tokenUsage: unknown;
    responseTurnDurationTotalMs: number | null;
    historySchema: number | null;
    payloadMode: 'light' | 'full';
    revision: string | null;
  };

  /** Read a history snapshot without mutating the store; callers own race guards. */
  const requestHistorySnapshot = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
      cursor?: string;
      payload?: 'light' | 'full';
      revision?: string;
      signal?: AbortSignal;
      /** One bounded rollout fallback when health and the serving process disagree. */
      fallbackOnLightDisabled?: boolean;
    } = {},
  ): Promise<{ ok: true; snapshot: HistorySnapshot } | HistoryFailure> => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const params = new URLSearchParams();
    if (opts.limit !== null && opts.limit !== undefined) {
      params.set('limit', String(opts.limit));
      params.set('offset', String(opts.offset ?? 0));
    }
    if (opts.cursor) { params.delete('offset'); params.set('cursor', opts.cursor); }
    if (opts.payload) params.set('payload', opts.payload);
    if (opts.revision) params.set('revision', opts.revision);
    let usedLegacyFallback = false;
    try {
      while (true) {
        const response = await authenticatedFetch(
          `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${params.size ? `?${params.toString()}` : ''}`,
          { signal: opts.signal },
        );
        if (!response.ok) {
          const failure = await readHistoryFailure(response);
          const { code } = failure;
          if (opts.fallbackOnLightDisabled
            && opts.payload === 'light'
            && !usedLegacyFallback
            && response.status === 409
            && code === 'LIGHT_HISTORY_DISABLED') {
            // A rolling restart or flag change can briefly make the shared health
            // receipt newer than the process serving this request. Retry exactly
            // once using the legacy/default full contract; never recurse or loop.
            usedLegacyFallback = true;
            params.delete('payload');
            params.delete('revision');
            continue;
          }
          return failure;
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.messages)
          || !data.messages.every((row: unknown) => row && typeof row === 'object'
            && typeof (row as NormalizedMessage).id === 'string' && typeof (row as NormalizedMessage).kind === 'string')
          || (data.historySchema !== undefined && data.historySchema !== 1)
          || (data.historySchema === 1 && !['light', 'full'].includes(data.payloadMode))
          || (data.payloadMode !== undefined && !['light', 'full'].includes(data.payloadMode))
          || (data.payloadMode === 'light' && (data.historySchema !== 1 || typeof data.revision !== 'string'))
          || (data.total !== undefined && (!Number.isSafeInteger(data.total) || data.total < 0))
          || (data.hasMore !== undefined && typeof data.hasMore !== 'boolean')
          || (data.nextCursor != null && (typeof data.nextCursor !== 'string' || data.nextCursor.length > 2048))) {
          return { ok: false, status: 422, code: 'HISTORY_UNSUPPORTED_RESPONSE', retryAfterMs: null };
        }
        // An old server has no marker. Treat that response as authoritative full;
        // crucially, never follow it with a redundant enrichment request.
        const markedLight = data.historySchema === 1 && data.payloadMode === 'light';
        return {
          ok: true,
          snapshot: {
            messages: Array.isArray(data.messages) ? data.messages : [],
            total: typeof data.total === 'number' ? data.total : (data.messages?.length ?? 0),
            hasMore: Boolean(data.hasMore),
            nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
            tokenUsage: data.tokenUsage ?? null,
            responseTurnDurationTotalMs: validResponseDurationTotal(data.responseTurnDurationTotalMs),
            historySchema: data.historySchema === 1 ? 1 : null,
            payloadMode: markedLight ? 'light' : 'full',
            revision: typeof data.revision === 'string' ? data.revision : null,
          },
        };
      }
    } catch (error) {
      if (error instanceof SyntaxError) return { ok: false, status: 422, code: 'HISTORY_UNSUPPORTED_RESPONSE', retryAfterMs: null };
      return historyTransportFailure(error);
    }
  }, [resolveSessionId]);

  /** Record failure without changing messages, pagination, token usage or pending input. */
  const setHistoryError = useCallback((sessionId: string, failure: HistoryFailure, operation: HistoryOperation) => {
    if (failure.status === 499) return;
    // T-1660: surface the exact status/code behind a generic 'unavailable'
    // banner. A pure transport failure (status 0) never reaches the server, so
    // this console line is the only place its status/code is recorded. Fields
    // are bounded metadata only — no transcript, header, token or path.
    if (classifyHistoryFailure(failure) === 'unavailable') {
      console.warn('[history] unavailable banner', {
        sessionId, operation, status: failure.status, code: failure.code,
      });
    }
    const slot = getSlot(sessionId);
    slot.historyGeneration += 1;
    slot.historyError = { ...failure, operation, retryAt: Date.now() + (failure.retryAfterMs ?? 0) };
    slot.status = 'error';
    notify(sessionId);
  }, [getSlot, notify]);

  /** Apply a previously guarded snapshot, retaining unsynced optimistic/WS rows. */
  const applyHistorySnapshot = useCallback((sessionId: string, snapshot: HistorySnapshot): SessionSlot => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.historyGeneration += 1;
    slot.serverMessages = snapshot.messages;
    slot.total = snapshot.total;
    slot.hasMore = snapshot.hasMore;
    slot.offset = snapshot.messages.length;
    slot.historyCursor = snapshot.nextCursor;
    slot.responseTurnDurationTotalMs = snapshot.responseTurnDurationTotalMs;
    slot.historyRevision = snapshot.revision;
    slot.historyPayloadMode = snapshot.payloadMode;
    slot.fetchedAt = Date.now();
    slot.status = 'idle';
    slot.historyError = null;
    if (snapshot.tokenUsage) slot.tokenUsage = snapshot.tokenUsage;
    slot.realtimeMessages = retainUnconfirmedRealtime(slot.realtimeMessages, slot.serverMessages);
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
    return slot;
  }, [getSlot, notify, resolveSessionId]);

  /** Replace equal-id light rows with their full forms without shrinking a wider light window. */
  const applyHistoryEnrichment = useCallback((sessionId: string, snapshot: HistorySnapshot): SessionSlot => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.historyGeneration += 1;
    const fullById = new Map(snapshot.messages.map((message) => [message.id, message]));
    slot.serverMessages = slot.serverMessages.map((message) => fullById.get(message.id) ?? message);
    // If the light tail was shorter for any reason, retain every full response row.
    const heldIds = new Set(slot.serverMessages.map((message) => message.id));
    for (const message of snapshot.messages) {
      if (!heldIds.has(message.id)) slot.serverMessages.push(message);
    }
    slot.serverMessages.sort(compareMessagesByTimestamp);
    slot.responseTurnDurationTotalMs = snapshot.responseTurnDurationTotalMs;
    slot.historyPayloadMode = 'full';
    if (slot.historyError?.operation === 'deferred') slot.historyError = null;
    if (!slot.historyError) slot.status = 'idle';
    slot.fetchedAt = Date.now();
    if (snapshot.tokenUsage) slot.tokenUsage = snapshot.tokenUsage;
    slot.realtimeMessages = retainUnconfirmedRealtime(slot.realtimeMessages, slot.serverMessages);
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
    return slot;
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Widen a light window without downgrading rows already enriched at the same
   * revision. This matters when the active-run light(400) request completes
   * after full(20): replacing the slot wholesale would otherwise discard the
   * full image/tool fields and leave the scheduler believing enrichment done.
   */
  const applyLightHistoryExpansion = useCallback((sessionId: string, snapshot: HistorySnapshot): SessionSlot => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const preserveEnriched = slot.historyRevision === snapshot.revision;
    const currentById = preserveEnriched
      ? new Map(slot.serverMessages.map((message) => [message.id, message]))
      : new Map<string, NormalizedMessage>();
    const messages = snapshot.messages.map((message) => {
      const current = currentById.get(message.id);
      return current && !current.deferredPayload ? current : message;
    });
    return applyHistorySnapshot(resolvedSessionId, { ...snapshot, messages });
  }, [applyHistorySnapshot, getSlot, resolveSessionId]);

  const has = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.has(resolvedSessionId);
  }, [resolveSessionId]);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: { provider?: LLMProvider; projectId?: string; projectPath?: string;
      limit?: number | null; offset?: number; signal?: AbortSignal; operation?: HistoryOperation } = {},
  ): Promise<{ ok: true; slot: SessionSlot } | HistoryFailure> => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const generation = beginHistoryRequest(resolvedSessionId);
    const previousStatus = slot.status;
    slot.status = 'loading';
    notify(resolvedSessionId);
    const result = await requestHistorySnapshot(resolvedSessionId, opts);
    if (opts.signal?.aborted || !isHistoryRequestCurrent(resolvedSessionId, generation)) {
      if (isHistoryRequestCurrent(resolvedSessionId, generation)) { slot.status = previousStatus; notify(resolvedSessionId); }
      return historyTransportFailure(new DOMException('', 'AbortError'));
    }
    if (!result.ok) {
      setHistoryError(resolvedSessionId, result, opts.operation ?? (opts.limit === null ? 'all' : 'initial'));
      return result;
    }
    applyHistorySnapshot(resolvedSessionId, result.snapshot);
    slot.offset = (opts.offset ?? 0) + result.snapshot.messages.length;
    return { ok: true, slot };
  }, [getSlot, notify, resolveSessionId, requestHistorySnapshot, applyHistorySnapshot, setHistoryError, beginHistoryRequest, isHistoryRequestCurrent]);

  /** Load one older page; a conflict requires explicit recovery, never a hidden tail replacement. */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: { provider?: LLMProvider; projectId?: string; projectPath?: string;
      limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ ok: true; slot: SessionSlot } | HistoryFailure> => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    if (!slot.hasMore) return { ok: true, slot };
    const generation = beginHistoryRequest(resolvedSessionId);
    const tailBookmark = resolveTailBookmark(slot);
    const result = await requestHistorySnapshot(resolvedSessionId, {
      limit: opts.limit ?? 20, offset: tailBookmark,
      cursor: slot.historyCursor ?? undefined, signal: opts.signal,
    });
    if (opts.signal?.aborted || !isHistoryRequestCurrent(resolvedSessionId, generation)) return historyTransportFailure(new DOMException('', 'AbortError'));
    if (!result.ok) { setHistoryError(resolvedSessionId, result, 'older'); return result; }
    const data = result.snapshot;
    const trulyOlder = selectTrulyOlder(slot.serverMessages, data.messages);
    slot.serverMessages = [...trulyOlder, ...slot.serverMessages];
    slot.hasMore = data.hasMore;
    slot.offset = tailBookmark + trulyOlder.length;
    slot.historyCursor = data.nextCursor;
    slot.responseTurnDurationTotalMs = data.responseTurnDurationTotalMs;
    if (slot.historyError?.operation === 'older') slot.historyError = null;
    if (!slot.historyError) slot.status = 'idle';
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
    return { ok: true, slot };
  }, [getSlot, notify, resolveSessionId, requestHistorySnapshot, setHistoryError, beginHistoryRequest, isHistoryRequestCurrent]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    // ADR-041 (B-80): track the highest server-stamped stream sequence so reconnect
    // requests only the delta. No-op when `sequence` is absent (flag off / legacy).
    recordSeq(resolvedSessionId, (msg as NormalizedMessage).sequence);
    const normalizedMessage =
      msg.sessionId === resolvedSessionId
        ? msg
        : { ...msg, sessionId: resolvedSessionId };
    const retained = slot.realtimeMessages.filter(row => row.id !== normalizedMessage.id
      && !(row.kind === 'stream_delta' && persistedReplyCovers(row, [normalizedMessage])));
    let updated = [...retained, normalizedMessage];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * B-518 — سحب الصفّ المتفائل الأخير بعد أن يرفض الخادمُ إرسالَه صراحةً.
   *
   * ‏`appendRealtime` تُضيف فقاعة المستخدم قبل أن يُعرف مصير الإرسال — وهو
   * الصواب في المسار السليم. لكن حين يردّ الخادم برفضٍ قاطع (`session_busy`:
   * المحادثة عليها جولة حيّة) فالرسالة **لم تصل المحرّك ولن تصل**، ولا نسخة
   * لها في أي سجلّ. وإبقاء الفقاعة حينها كذبٌ مكتمل: يراها المستخدم مُرسَلة
   * فينتظر رداً لن يأتي، ثم يعيد الإرسال فيرفض الخادم ثانيةً وتتراكم النسخ
   * (أربع فقاعات متطابقة، حادثة 2026-08-06).
   *
   * تُعيد نصَّ الصفّ المسحوب ليُردّ إلى المُؤلِّف — فلا يفقد المستخدم كلامه
   * (سلسلة فارغة لصفّ مرفقاتٍ فقط، و`null` حين لا صفّ). ولا تمسّ إلا صفّاً
   * متفائلاً (`cmid_*` أو `local_*` القديم): ما جاء من الخادم أو من البثّ ليس
   * ملكاً لنا لنسحبه.
   *
   * B-1078: المعرّف **إلزامي** ولا رجوع إلى «آخر صفّ». إطار `session_busy` يُبثّ
   * إلى مرايا الجلسة، فإطارٌ بلا معرّف (qwen/hermes قبل صدى المعرّف) كان سيسحب
   * في التبويب A إرسالَه الحيّ M1 ويردّ نصّه للمُؤلِّف بسبب رفض M2 في التبويب B.
   * الرجوع إلى الأخير متاح لـ`branchSessionId` وحده (لا مرايا لجلسة وُلدت للتوّ).
   */
  const withdrawOptimisticUserRow = useCallback((sessionId: string, clientMsgId: string): string | null => {
    if (!clientMsgId) return null;
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return null;
    const index = findOptimisticUserRowIndex(slot.realtimeMessages, clientMsgId);
    if (index < 0) return null;
    const text = slot.realtimeMessages[index].content || '';
    slot.realtimeMessages = [
      ...slot.realtimeMessages.slice(0, index),
      ...slot.realtimeMessages.slice(index + 1),
    ];
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
    return text;
  }, [notify, resolveSessionId]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    // ADR-041 (B-80): track the highest server-stamped stream sequence in the batch.
    for (const msg of msgs) {
      recordSeq(resolvedSessionId, (msg as NormalizedMessage).sequence);
    }
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === resolvedSessionId
        ? msg
        : { ...msg, sessionId: resolvedSessionId },
    );
    let updated = [...slot.realtimeMessages, ...normalizedMessages];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Re-fetch serverMessages from the provider sessions endpoint.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    _opts: {
      signal?: AbortSignal;
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const generation = beginHistoryRequest(resolvedSessionId);
    const capturedRows = new Set(slot.realtimeMessages);
    try {
      const result = await requestHistorySnapshot(resolvedSessionId, { signal: _opts.signal });
      if (_opts.signal?.aborted || !isHistoryRequestCurrent(resolvedSessionId, generation)) return false;
      if (!result.ok) { setHistoryError(resolvedSessionId, result, 'initial'); return false; }
      const data = result.snapshot;
      slot.historyError = null;
      if (slot.status === 'error' || slot.status === 'loading') slot.status = 'idle';
      slot.serverMessages = data.messages || [];
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.responseTurnDurationTotalMs = validResponseDurationTotal(data.responseTurnDurationTotalMs);
      slot.fetchedAt = Date.now();
      // A successful read does not prove it includes pending/live content.
      // Preserve B-516 user rows and assistant rows until their counterpart is
      // proven; no response may erase rows that arrived while it was pending.
      slot.realtimeMessages = retainUnconfirmedRealtime(slot.realtimeMessages, slot.serverMessages, capturedRows);
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
      return true;
    } catch (error) {
      if (_opts.signal?.aborted || !isHistoryRequestCurrent(resolvedSessionId, generation)) return false;
      console.error(`[SessionStore] refresh failed for ${resolvedSessionId}:`, error);
      return false;
    }
  }, [getSlot, notify, resolveSessionId, requestHistorySnapshot, setHistoryError, beginHistoryRequest, isHistoryRequestCurrent]);

  /**
   * Reconnect recovery merges the latest transcript tail by id. Preserve the
   * live row through failures and lagging reads: REST availability alone does
   * not prove that its content was persisted. Retire only the captured row when
   * the same run's persisted reply covers its text; never erase newer deltas.
   * Returns a boolean so the caller can retry a failed read.
   *
   * Must NOT update slot.offset / slot.hasMore so existing pagination
   * bookmarks from the initial load remain consistent.
   */
  const mergeTailFromServer = useCallback(async (
    sessionId: string,
    _opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const generation = beginHistoryRequest(resolvedSessionId);

    const streamId = `__streaming_${resolvedSessionId}`;
    const capturedStream = slot.realtimeMessages.find(m => m.id === streamId);

    try {
      const result = await requestHistorySnapshot(resolvedSessionId, { limit: 20, offset: 0, signal: _opts.signal });
      if (_opts.signal?.aborted || !isHistoryRequestCurrent(resolvedSessionId, generation)) return false;
      if (!result.ok) { setHistoryError(resolvedSessionId, result, 'reconnect'); return false; }
      const data = result.snapshot;
      const tailMessages = data.messages;
      if (slot.historyError?.operation === 'reconnect') slot.historyError = null;
      if (!slot.historyError && (slot.status === 'error' || slot.status === 'loading')) slot.status = 'idle';
      notify(resolvedSessionId);

      // This aggregate covers the entire persisted session, not merely the
      // tail page returned below. A successful read with no valid aggregate
      // clears the previous value rather than retaining stale UI state.
      const previousDurationTotal = slot.responseTurnDurationTotalMs;
      slot.responseTurnDurationTotalMs = validResponseDurationTotal(data.responseTurnDurationTotalMs);

      if (capturedStream && persistedReplyCovers(capturedStream, tailMessages)) {
        // Reference equality is the request boundary: a delta arriving while
        // REST was pending has a new row object and must remain visible.
        slot.realtimeMessages = slot.realtimeMessages.filter(message => message !== capturedStream);
      }

      if (tailMessages.length > 0) {
        // The tail is a newer authoritative read, not merely an append-only
        // batch.  A response metric is written just after the assistant row
        // itself reaches the transcript, so an earlier history read can hold
        // that same row *without* timing.  Dropping an equal-id tail row kept
        // the stale version forever (until a full refresh), making attested
        // durations disappear after reconnect/history recovery.
        const previousById = new Map(slot.serverMessages.map((message) => [message.id, message]));
        const novelCount = tailMessages.filter((message) => !previousById.has(message.id)).length;
        for (const message of tailMessages) previousById.set(message.id, message);
        slot.serverMessages = [...previousById.values()].sort(compareMessagesByTimestamp);
        slot.total = data.total ?? (slot.total + novelCount);
        slot.fetchedAt = Date.now();
        recomputeMergedIfNeeded(slot);
        notify(resolvedSessionId);
      } else if (slot.responseTurnDurationTotalMs !== previousDurationTotal) {
        notify(resolvedSessionId);
      }
      return true;
    } catch (error) {
      if (_opts.signal?.aborted || !isHistoryRequestCurrent(resolvedSessionId, generation)) return false;
      console.error(`[SessionStore] mergeTail failed for ${resolvedSessionId}:`, error);
      return false;
    }
  }, [getSlot, notify, resolveSessionId, requestHistorySnapshot, setHistoryError, beginHistoryRequest, isHistoryRequestCurrent]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.status = status;
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, [resolveSessionId]);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   *
   * `attribution` mirrors the coordinator/origin fields stamped by the server on
   * completed assistant rows (commit 9c61b60 / 91b8b39). The live `stream_delta`
   * events already carry `coordinatorId`, but the previous implementation rebuilt
   * the streaming row from scratch and dropped it — so the active-speaker
   * highlight and per-message attribution only appeared once the run finalized.
   * Carrying it here makes attribution correct *while* streaming (B-43).
   */
  const updateStreaming = useCallback((
    sessionId: string,
    accumulatedText: string,
    msgProvider: LLMProvider,
    attribution?: { coordinatorId?: number | null; originKind?: string; model?: string },
    responseToMessageId?: string,
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const streamId = `__streaming_${resolvedSessionId}`;
    let existing = slot.realtimeMessages.find(m => m.id === streamId);
    if (existing?.responseToMessageId && responseToMessageId
      && existing.responseToMessageId !== responseToMessageId) {
      const previous = existing;
      slot.realtimeMessages = slot.realtimeMessages.map(message => message === previous
        ? { ...message, id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, kind: 'text', role: 'assistant' }
        : message);
      existing = undefined;
    }
    // Prefer a freshly-supplied coordinator, but never lose one already stamped
    // on the streaming row by an earlier delta if a later call omits it.
    const coordinatorId =
      attribution?.coordinatorId ?? existing?.coordinatorId;
    const originKind = attribution?.originKind ?? existing?.originKind;
    // Keep only a model named by this response's stream, never the picker or
    // another response. Sparse deltas must not erase earlier attestation.
    const model = typeof attribution?.model === 'string' && attribution.model.trim()
      ? attribution.model.trim() : existing?.model;
    // A missing run identity is deliberately not filled from another row. A
    // completion without its prompt relationship cannot be attached safely.
    const responseTo = responseToMessageId ?? existing?.responseToMessageId;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId: resolvedSessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      clientStream: true,
      content: accumulatedText,
      ...(responseTo ? { responseToMessageId: responseTo } : {}),
      ...(coordinatorId != null ? { coordinatorId } : {}),
      ...(originKind ? { originKind } : {}),
      ...(model ? { model } : {}),
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string, finalId?: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;
    const streamId = `__streaming_${resolvedSessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: finalId ?? `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    }
  }, [notify, resolveSessionId]);

  /**
   * Attach a server-attested terminal turn to the one assistant row that
   * belongs to its user run. `complete` is a control event, so without this
   * bridge its timing fields never reach the rendered/finalized stream row.
   */
  const applyResponseTurnCompletion = useCallback((
    sessionId: string,
    completion: {
      responseToMessageId: string;
      responseTurnMetric: NonNullable<NormalizedMessage['responseTurnMetric']>;
      responseTurnDurationTotalMs: number | null;
      /** Durable transcript row id attested by the terminal server frame. */
      transcriptMessageId?: string;
      model?: string;
    },
  ) => {
    const responseTo = completion.responseToMessageId;
    const durationMs = validResponseDuration(completion.responseTurnMetric.durationMs);
    if (!responseTo || durationMs === null) return;
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;

    const responseTurnMetric = {
      ...completion.responseTurnMetric,
      durationMs,
    };
    const transcriptMessageId = typeof completion.transcriptMessageId === 'string'
      && completion.transcriptMessageId.trim()
      ? completion.transcriptMessageId.trim()
      : undefined;

    const patch = (rows: NormalizedMessage[]) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (
          row.sessionId === resolvedSessionId
          && row.role === 'assistant'
          && (row.kind === 'text' || row.kind === 'stream_delta')
          && row.responseToMessageId === responseTo
        ) {
          // حارس التكرار: إن كانت البيانات مطابقة تماماً (إطار مكرَّر أو متأخر)
          // نُعيد نفس المصفوفة كي لا يتغيّر مرجع ref ولا يُضاعف التراكم.
          const existing = row.responseTurnMetric;
          if (
            existing
            && existing.startedAt === responseTurnMetric.startedAt
            && existing.completedAt === responseTurnMetric.completedAt
            && existing.durationMs === responseTurnMetric.durationMs
            && (!transcriptMessageId || row.transcriptMessageId === transcriptMessageId)
          ) {
            return rows; // إطار مكرَّر — لا تعديل
          }
          const next = [...rows];
          next[index] = {
            ...row,
            responseTurnMetric,
            ...(transcriptMessageId ? { transcriptMessageId } : {}),
            ...(completion.model ? { model: completion.model } : {}),
          };
          return next;
        }
      }
      return rows;
    };

    const realtime = patch(slot.realtimeMessages);
    const server = realtime === slot.realtimeMessages ? patch(slot.serverMessages) : slot.serverMessages;
    // الإجمالي التراكمي من الخادم — يُفضَّل دائماً على الحساب العميلي.
    // إن أرسل الخادم null (إطار تحكّم قديم أو مفقود)، نجمع عميلياً من
    // الإجمالي السابق + مدة هذا الدور كي لا يُصفَّر التاريخ.
    const serverTotal = validResponseDurationTotal(completion.responseTurnDurationTotalMs);
    const nextTotal = serverTotal !== null
      ? serverTotal
      : slot.responseTurnDurationTotalMs !== null
        ? slot.responseTurnDurationTotalMs + durationMs
        : durationMs;
    const totalChanged = slot.responseTurnDurationTotalMs !== nextTotal;
    if (realtime === slot.realtimeMessages && server === slot.serverMessages && !totalChanged) return;
    slot.realtimeMessages = realtime;
    slot.serverMessages = server;
    slot.responseTurnDurationTotalMs = nextTotal;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [notify, resolveSessionId]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    }
  }, [notify, resolveSessionId]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.get(resolvedSessionId)?.merged ?? [];
  }, [resolveSessionId]);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.get(resolvedSessionId);
  }, [resolveSessionId]);

  const replaceSessionId = useCallback((fromSessionId: string, toSessionId: string) => {
    const resolvedFromSessionId = resolveSessionId(fromSessionId) ?? fromSessionId;
    const resolvedToSessionId = resolveSessionId(toSessionId) ?? toSessionId;

    if (resolvedFromSessionId === resolvedToSessionId) {
      sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);
      return;
    }

    const store = storeRef.current;
    const sourceSlot = store.get(resolvedFromSessionId);
    const targetSlot = store.get(resolvedToSessionId) ?? createEmptySlot();

    if (sourceSlot) {
      const migratedServerMessages = sourceSlot.serverMessages.map((msg) =>
        rewriteMessageSessionId(msg, resolvedFromSessionId, resolvedToSessionId),
      );
      const migratedRealtimeMessages = sourceSlot.realtimeMessages.map((msg) =>
        rewriteMessageSessionId(msg, resolvedFromSessionId, resolvedToSessionId),
      );

      targetSlot.serverMessages = mergeMessagesById(targetSlot.serverMessages, migratedServerMessages);
      targetSlot.realtimeMessages = mergeMessagesById(targetSlot.realtimeMessages, migratedRealtimeMessages);
      if (targetSlot.realtimeMessages.length > MAX_REALTIME_MESSAGES) {
        targetSlot.realtimeMessages = targetSlot.realtimeMessages.slice(-MAX_REALTIME_MESSAGES);
      }
      targetSlot.status =
        sourceSlot.status === 'error'
          ? 'error'
          : sourceSlot.status === 'streaming' || targetSlot.status === 'streaming'
            ? 'streaming'
            : sourceSlot.status === 'loading' || targetSlot.status === 'loading'
              ? 'loading'
              : targetSlot.status;
      targetSlot.fetchedAt = Math.max(targetSlot.fetchedAt, sourceSlot.fetchedAt, Date.now());
      targetSlot.total = Math.max(
        targetSlot.total,
        sourceSlot.total,
        targetSlot.serverMessages.length,
        targetSlot.realtimeMessages.length,
      );
      targetSlot.hasMore = targetSlot.hasMore || sourceSlot.hasMore;
      targetSlot.offset = Math.max(targetSlot.offset, sourceSlot.offset);
      targetSlot.historyCursor = targetSlot.historyCursor ?? sourceSlot.historyCursor;
      targetSlot.tokenUsage = targetSlot.tokenUsage ?? sourceSlot.tokenUsage;
      recomputeMergedIfNeeded(targetSlot);

      store.set(resolvedToSessionId, targetSlot);
      store.delete(resolvedFromSessionId);
    }

    sessionAliasesRef.current.set(resolvedFromSessionId, resolvedToSessionId);
    sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);

    for (const [aliasSessionId, targetSessionId] of sessionAliasesRef.current.entries()) {
      if (targetSessionId === resolvedFromSessionId) {
        sessionAliasesRef.current.set(aliasSessionId, resolvedToSessionId);
      }
    }

    if (activeSessionIdRef.current === resolvedFromSessionId) {
      activeSessionIdRef.current = resolvedToSessionId;
    }

    notify(resolvedToSessionId);
  }, [notify, resolveSessionId]);

  /**
   * Move only the pending command into a newly-created branch; never alias the source.
   * `clientMsgId` (echoed on the fork's `session_created`) names the exact row to move.
   * Without it the newest optimistic row moves: safe here, since the frame targets
   * a session born for this send and has no mirror tabs.
   */
  const branchSessionId = useCallback((fromSessionId: string, toSessionId: string, clientMsgId?: string) => {
    const source = storeRef.current.get(fromSessionId);
    const target = storeRef.current.get(toSessionId) ?? createEmptySlot();
    if (source) {
      const index = findOptimisticUserRowIndex(source.realtimeMessages, clientMsgId);
      if (index >= 0) {
        const pending = source.realtimeMessages[index];
        // A new array, not splice: recomputeMergedIfNeeded caches by reference.
        source.realtimeMessages = source.realtimeMessages.filter((_row, cursor) => cursor !== index);
        target.realtimeMessages = [
          ...target.realtimeMessages,
          rewriteMessageSessionId(pending, fromSessionId, toSessionId),
        ];
        recomputeMergedIfNeeded(source);
      }
    }
    target.status = 'streaming';
    recomputeMergedIfNeeded(target);
    storeRef.current.set(toSessionId, target);
    activeSessionIdRef.current = toSessionId;
    notify(fromSessionId);
    notify(toSessionId);
  }, [notify]);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    mergeTailFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    applyResponseTurnCompletion,
    clearRealtime,
    withdrawOptimisticUserRow,
    getMessages,
    getSessionSlot,
    replaceSessionId,
    branchSessionId,
    recordSeq,
    getLastSeq,
    requestHistorySnapshot,
    beginHistoryRequest,
    isHistoryRequestCurrent,
    setHistoryError,
    applyHistorySnapshot,
    applyHistoryEnrichment,
    applyLightHistoryExpansion,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer, mergeTailFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming, applyResponseTurnCompletion,
    clearRealtime, withdrawOptimisticUserRow, getMessages, getSessionSlot, replaceSessionId,
    branchSessionId,
    recordSeq, getLastSeq,
    requestHistorySnapshot, beginHistoryRequest, isHistoryRequestCurrent, setHistoryError, applyHistorySnapshot,
    applyHistoryEnrichment, applyLightHistoryExpansion,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;

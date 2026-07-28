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
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
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
  tokenUsage: unknown;
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
    tokenUsage: null,
  };
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
    if (prev) {
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
  const serverUserTexts = new Set(
    server.map(userTextFingerprint).filter((t): t is string => t !== null),
  );
  const extra = realtime.filter((m) => {
    if (serverIds.has(m.id)) return false;
    // Optimistic user rows use `local_*` ids; once the same text exists on the
    // server-backed copy, drop the realtime echo to avoid duplicate bubbles.
    if (m.id.startsWith('local_')) {
      const fp = userTextFingerprint(m);
      if (fp && serverUserTexts.has(fp)) return false;
    }
    return true;
  });
  if (extra.length === 0) return server;
  const merged = [...server, ...extra].sort(compareMessagesByTimestamp);
  return dedupeAdjacentAssistantEchoes(merged);
}

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
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.status = 'loading';
    notify(resolvedSessionId);

    try {
      const params = new URLSearchParams();
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const messages: NormalizedMessage[] = data.messages || [];

      slot.serverMessages = messages;
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(resolvedSessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${resolvedSessionId}:`, error);
      slot.status = 'error';
      notify(resolvedSessionId);
      return slot;
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // Prepend older messages (they're earlier in the conversation)
      slot.serverMessages = [...olderMessages, ...slot.serverMessages];
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${resolvedSessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify, resolveSessionId]);

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
    let updated = [...slot.realtimeMessages, normalizedMessage];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

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
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    try {
      const params = new URLSearchParams();

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      slot.serverMessages = data.messages || [];
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // drop realtime messages that the server has caught up with to prevent unbounded growth.
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${resolvedSessionId}:`, error);
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Reconnect recovery: merge the latest N transcript messages idempotently
   * (by id) into serverMessages, and always clear the streaming placeholder
   * first — even if the REST fetch fails — so the UI never stays frozen on a
   * stale stream_delta bubble after the run has completed.
   *
   * Why this instead of refreshFromServer on reconnect:
   *   1. Always clears the streaming placeholder regardless of network outcome.
   *   2. Fetches only the last 20 messages (lightweight; avoids 6 MB full-dump).
   *   3. Merges by id (idempotent, safe to retry, no duplicate bubbles).
   *   4. Returns a boolean so the caller can retry on failure.
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
    } = {},
  ): Promise<boolean> => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);

    // Step 1 (always): clear the streaming placeholder so the frozen bubble
    // disappears immediately, independent of whether the REST fetch succeeds.
    const streamId = `__streaming_${resolvedSessionId}`;
    if (slot.realtimeMessages.some(m => m.id === streamId)) {
      slot.realtimeMessages = slot.realtimeMessages.filter(m => m.id !== streamId);
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    }

    // Step 2: fetch the tail (last 20 messages) and merge by id.
    try {
      const params = new URLSearchParams({ limit: '20', offset: '0' });
      const url =
        `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages?${params.toString()}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const tailMessages: NormalizedMessage[] = data.messages || [];

      if (tailMessages.length > 0) {
        const existingIds = new Set(slot.serverMessages.map(m => m.id));
        const novel = tailMessages.filter(m => !existingIds.has(m.id));
        if (novel.length > 0) {
          slot.serverMessages = [...slot.serverMessages, ...novel]
            .sort(compareMessagesByTimestamp);
          slot.total = data.total ?? (slot.total + novel.length);
          slot.fetchedAt = Date.now();
          recomputeMergedIfNeeded(slot);
          notify(resolvedSessionId);
        }
      }
      return true;
    } catch (error) {
      console.error(`[SessionStore] mergeTail failed for ${resolvedSessionId}:`, error);
      return false;
    }
  }, [getSlot, notify, resolveSessionId]);

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
    attribution?: { coordinatorId?: number | null; originKind?: string },
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const streamId = `__streaming_${resolvedSessionId}`;
    const existing = slot.realtimeMessages.find(m => m.id === streamId);
    // Prefer a freshly-supplied coordinator, but never lose one already stamped
    // on the streaming row by an earlier delta if a later call omits it.
    const coordinatorId =
      attribution?.coordinatorId ?? existing?.coordinatorId;
    const originKind = attribution?.originKind ?? existing?.originKind;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId: resolvedSessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
      ...(coordinatorId != null ? { coordinatorId } : {}),
      ...(originKind ? { originKind } : {}),
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
  const finalizeStreaming = useCallback((sessionId: string) => {
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
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    }
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
    clearRealtime,
    getMessages,
    getSessionSlot,
    replaceSessionId,
    recordSeq,
    getLastSeq,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer, mergeTailFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot, replaceSessionId,
    recordSeq, getLastSeq,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;

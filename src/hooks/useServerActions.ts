import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import { useWebSocket } from '../contexts/WebSocketContext';

import { refreshRawExecConfig } from './useRawExecConfig';

/** Shape of a single pending action as returned by GET /api/system/pending */
export type PublicAction = {
  id: string;
  actionType: string;
  label: string;
  commandPreview: string | null;
  reason: string | null;
  sessionId: string | null;
  status: 'pending' | 'executing' | 'failed';
  error: string | null;
  reasonCode?: string | null;
  retryable?: boolean;
  expectedServerBuildId: string | null;
  requestedAt: string;
  currentActionOutcome?: CurrentActionOutcome;
  /** Browser-side execution marker; persisted before sending the POST. */
  attemptedLocally?: boolean;
};

export type CurrentActionOutcome = {
  status: 'success' | 'failure' | 'pending' | 'unknown';
  reasonCode: string;
  retryable: boolean;
};

/**
 * A single settled operation, newest first, as returned by GET /api/system/pending.
 *
 * T-1684 — the queue answers "what still waits"; this answers "what happened".
 * Both outcomes and non-outcomes land here: a command whose result could not be
 * established is a fact about the past exactly as much as a failure is, and
 * leaving it in the queue was what kept the amber button lit over nothing.
 */
export type HistoryOutcome = 'success' | 'failure' | 'unknown';

export type HistoryEntry = {
  id: string;
  kind: 'action' | 'raw';
  actionType?: string;
  label: string;
  commandPreview: string | null;
  outcome: HistoryOutcome;
  reasonCode: string | null;
  retryable: boolean;
  /** ISO — when the attempt settled. */
  executedAt: string;
  /** ISO — executedAt + 1h; the server drops the row at this point. */
  expiresAt: string;
  requestedAt?: string;
  sessionId?: string;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
};

/** The server keeps a settled operation for one hour; the client mirrors that. */
export const HISTORY_TTL_MS = 3_600_000;

const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set(['success', 'failure', 'unknown']);

/** A settled request: it belongs to history, never to the queue or the badge. */
export function isTerminalOutcome(action: PublicAction): boolean {
  return TERMINAL_OUTCOMES.has(action.currentActionOutcome?.status ?? '');
}

/**
 * Count only work that is still waiting for a decision.
 *
 * T-1684 — the amber button exists to say "something new is queued". An
 * executing row is already moving, and a failed or unverified one is a receipt,
 * so neither is a reason to keep calling for attention.
 */
export function countPendingServerActions(actions: readonly PublicAction[]): number {
  return actions.filter(action => action.status === 'pending' && !isTerminalOutcome(action)).length;
}

/** Fail-closed read of the `history` array; an old server simply has none. */
export function parseHistoryEntries(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): HistoryEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const kind = row.kind === 'raw' ? 'raw' : row.kind === 'action' ? 'action' : null;
    if (typeof row.id !== 'string' || !row.id || !kind) return [];
    if (!TERMINAL_OUTCOMES.has(String(row.outcome))) return [];
    return [{
      id: row.id,
      kind,
      actionType: typeof row.actionType === 'string' ? row.actionType : undefined,
      label: typeof row.label === 'string' ? row.label : row.id,
      commandPreview: typeof row.commandPreview === 'string' ? row.commandPreview : null,
      outcome: row.outcome as HistoryOutcome,
      reasonCode: typeof row.reasonCode === 'string' ? row.reasonCode : null,
      retryable: row.retryable === true,
      executedAt: typeof row.executedAt === 'string' ? row.executedAt : '',
      expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : '',
      requestedAt: typeof row.requestedAt === 'string' ? row.requestedAt : undefined,
      sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
      exitCode: typeof row.exitCode === 'number' ? row.exitCode : row.exitCode === null ? null : undefined,
      stdoutTail: typeof row.stdoutTail === 'string' ? row.stdoutTail : undefined,
      stderrTail: typeof row.stderrTail === 'string' ? row.stderrTail : undefined,
    }];
  });
}

/**
 * Turn settled rows this browser still holds a reference to into history entries.
 *
 * These are the retained safe-restart receipts (sessionStorage), reconciled via
 * /pending/:id/outcome after the server restarted itself. The server cannot
 * always report them — that is the whole reason the reference exists — so they
 * are rendered as history alongside the server's own list, never instead of it.
 */
export function deriveHistoryFromActions(actions: readonly PublicAction[]): HistoryEntry[] {
  return actions.filter(isTerminalOutcome).map(action => {
    const settledAt = Date.parse(action.requestedAt ?? '');
    return {
      id: action.id,
      kind: 'action' as const,
      actionType: action.actionType,
      label: action.label,
      commandPreview: action.commandPreview ?? null,
      outcome: action.currentActionOutcome!.status as HistoryOutcome,
      reasonCode: action.currentActionOutcome!.reasonCode ?? action.reasonCode ?? null,
      // A local receipt never re-arms Execute on its own: only the server's own
      // history row may carry `retryable: true`.
      retryable: false,
      // `requestedAt` dates the REQUEST, not the moment it settled, so it can
      // only ever order the list — never start the hourly clock. A local
      // reference therefore carries no expiry: the server's own row (same id,
      // higher priority) is what expires, and this one lives no longer than the
      // browser session that holds it.
      executedAt: Number.isNaN(settledAt) ? '' : new Date(settledAt).toISOString(),
      expiresAt: '',
      requestedAt: action.requestedAt,
      sessionId: action.sessionId ?? undefined,
    };
  });
}

/** Newest first; the server's row wins over a local reference to the same id. */
export function mergeHistory(
  serverEntries: readonly HistoryEntry[],
  localEntries: readonly HistoryEntry[],
): HistoryEntry[] {
  const known = new Set(serverEntries.map(entry => entry.id));
  const at = (entry: HistoryEntry) => Date.parse(entry.executedAt) || 0;
  return [...serverEntries, ...localEntries.filter(entry => !known.has(entry.id))]
    .sort((left, right) => at(right) - at(left));
}

/** Hide an expired row without waiting for the server's own sweep. */
export function filterLiveHistory(entries: readonly HistoryEntry[], now: number): HistoryEntry[] {
  // An unparsable expiry is not evidence of expiry: keep the receipt visible.
  return entries.filter(entry => {
    const expiry = Date.parse(entry.expiresAt);
    return Number.isNaN(expiry) || expiry > now;
  });
}

/** Only a freshly reconciled superseded restart may be removed from this browser. */
export function isSupersededAction(action: PublicAction): boolean {
  return action.actionType === 'safe-restart' && action.status !== 'executing'
    && action.currentActionOutcome?.status === 'failure'
    && action.currentActionOutcome.reasonCode === 'superseded'
    && action.currentActionOutcome.retryable === false;
}

const UNKNOWN_OUTCOME: CurrentActionOutcome = { status: 'unknown', reasonCode: 'outcome_unverified', retryable: false };

/** The legacy SPA fallback returns its document for an unknown API route. */
function isHtmlDocumentResponse(response: Response): boolean {
  const contentType = response.headers?.get('content-type');
  return typeof contentType === 'string'
    && contentType.split(';', 1)[0].trim().toLowerCase() === 'text/html';
}

/** Read only the server's reconciled action outcome; availability is not proof. */
async function readActionOutcome(id: string): Promise<CurrentActionOutcome | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await authenticatedFetch(`/api/system/pending/${encodeURIComponent(id)}/outcome`, { cache: 'no-store', signal: controller.signal });
    // Before the outcome route existed, the server's catch-all served the SPA
    // document with 200 rather than a 404. That is route absence, not evidence
    // of an execution. Keep every other response fail-closed.
    if (response.status === 404 || (response.ok && isHtmlDocumentResponse(response))) return null;
    if (!response.ok) return UNKNOWN_OUTCOME;
    const data = await response.json();
    const outcome = data.currentActionOutcome;
    if (data.actionId !== id || !outcome || !['success', 'failure', 'pending', 'unknown'].includes(outcome.status)
      || typeof outcome.reasonCode !== 'string' || typeof outcome.retryable !== 'boolean') return UNKNOWN_OUTCOME;
    return outcome;
  } catch { return UNKNOWN_OUTCOME; }
  finally { clearTimeout(timeout); }
}

/** Keep bounded, account-scoped request references across a browser refresh. */
function restoreActionReferences(scope?: string): PublicAction[] {
  if (!scope) return [];
  try {
    const rows = JSON.parse(sessionStorage.getItem(`server-action-outcomes:${scope}`) ?? '[]');
    return Array.isArray(rows) ? rows.filter(row => row && typeof row.id === 'string'
      && row.actionType === 'safe-restart' && typeof row.label === 'string').slice(-20)
      .map(row => ({ ...row, currentActionOutcome: UNKNOWN_OUTCOME, retryable: false })) : [];
  } catch { return []; }
}

/** These classifier refusals require preparation, not another ordinary restart attempt. */
export function isRestartPreparationBlocked(actionType: string, code: string | null | undefined): boolean {
  return actionType === 'safe-restart' && (code === 'unknown_candidate' || code === 'sensitive_candidate');
}

export type ExecuteOutcome =
  | { status: 'restarting' }
  | { status: 'success' }
  | { status: 'deferred'; reason: string; detail?: string }
  | { status: 'error'; code: string };

export type DismissOutcome =
  | { status: 'dismissed'; id: string }
  | { status: 'error' };

type PendingActionsResponse = {
  actions?: PublicAction[];
  /** T-1684; absent on a server that predates the split — read as empty. */
  history?: unknown;
};

/**
 * useServerActions — T-944 F1
 *
 * يجلب قائمة طلبات التنفيذ المعلّقة (GET /api/system/pending) ويبقيها حيّة
 * عبر WS 'pending-actions-updated'. يُعيد الجلب أيضاً عند تغيّر hasPendingActions
 * من /health (انعكاس قيمة جديدة من useVersionCheck).
 *
 * النمط: useProjectBoard (استهلاك useWebSocket().latestMessage ثم refetch).
 * العقد الخادمي: راوتر خلف authenticateToken؛ لا cmd/argv في PublicAction.
 */
export function useServerActions(hasPendingActions: boolean, ownerScope?: string) {
  const [actions, setActions] = useState<PublicAction[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const { latestMessage } = useWebSocket();
  const lastMsgRef = useRef<unknown>(null);

  const scopeRef = useRef(ownerScope);
  const generationRef = useRef(0);
  const retainedRef = useRef<PublicAction[]>(restoreActionReferences(ownerScope));
  const [actionsScope, setActionsScope] = useState(ownerScope);
  if (scopeRef.current !== ownerScope) {
    scopeRef.current = ownerScope;
    generationRef.current += 1;
    retainedRef.current = restoreActionReferences(ownerScope);
  }
  const refreshVersion = useRef(0);

  const refetch = useCallback(async () => {
    const generation = generationRef.current;
    const version = ++refreshVersion.current;
    try {
      setLoading(true);
      const res = await (authenticatedFetch as (url: string) => Promise<Response>)(
        '/api/system/pending',
      );
      if (!res.ok) return;
      const data = (await res.json()) as PendingActionsResponse;
      if (generation !== generationRef.current || version !== refreshVersion.current) return;
      const visible = data.actions ?? [];
      const rows = [...visible.map(row => retainedRef.current.some(known => known.id === row.id && known.attemptedLocally)
        ? { ...row, attemptedLocally: true } : row), ...retainedRef.current.filter(row => !visible.some(action => action.id === row.id))];
      const reconciled = await Promise.all(rows.map(async row => {
        if (!ownerScope || row.actionType !== 'safe-restart') return row;
        if (row.currentActionOutcome?.status === 'success') return row;
        const evidence = await readActionOutcome(row.id);
        // An old server has no outcome route. Only its fresh, never-attempted
        // pending row may retain its original eligibility; absence is no proof.
        if (evidence === null && !row.attemptedLocally && row.status === 'pending'
          && row.reasonCode !== 'execution_unresolved' && visible.some(action => action.id === row.id)) return row;
        const outcome = evidence ?? UNKNOWN_OUTCOME;
        return { ...row, currentActionOutcome: outcome,
          ...(outcome.status === 'pending' && outcome.retryable
            ? { status: 'pending' as const, reasonCode: outcome.reasonCode, error: null } : {}),
          retryable: outcome.status === 'unknown' ? false : outcome.retryable };
      }));
      if (generation !== generationRef.current || version !== refreshVersion.current) return;
      retainedRef.current = reconciled.filter(row => row.actionType === 'safe-restart').slice(-20);
      if (ownerScope) {
        try { sessionStorage.setItem(`server-action-outcomes:${ownerScope}`, JSON.stringify(retainedRef.current)); } catch { /* Storage unavailable: keep in-memory references. */ }
      }
      setActionsScope(ownerScope);
      setActions(reconciled);
      setHistory(parseHistoryEntries(data.history));
    } catch {
      // Network error — keep previous state, WS reconnect will re-trigger
    } finally {
      if (generation === generationRef.current && version === refreshVersion.current) setLoading(false);
    }
  }, [ownerScope]);

  useEffect(() => {
    setActions(retainedRef.current);
    // A new account inherits no history; the next GET supplies its own.
    setHistory([]);
    setActionsScope(ownerScope);
    window.addEventListener('online', refetch);
    return () => { generationRef.current += 1; window.removeEventListener('online', refetch); };
  }, [refetch, ownerScope]);

  // Fetch on mount and both health transitions, including a newly terminal action.
  useEffect(() => {
    void refetch();
  }, [hasPendingActions, refetch]);

  // WS subscription: 'pending-actions-updated' → refetch; reconnect → catch up
  useEffect(() => {
    if (!latestMessage) return;
    if (lastMsgRef.current === latestMessage) return;
    lastMsgRef.current = latestMessage;
    const msg = latestMessage as { type?: string };
    if (
      msg.type === 'pending-actions-updated' ||
      msg.type === 'websocket-reconnected'
    ) {
      void refetch();
      // The server broadcasts this same message on raw insert/dismiss/execute
      // (broadcastPendingActionsUpdated in server/routes/system.js), so it is the
      // live signal for BOTH queues. This hook mounts once, at Sidebar level and
      // inside the WebSocketProvider, which makes it the one place that can push
      // a fresh raw snapshot to consumers that render outside that provider.
      refreshRawExecConfig();
    }
  }, [latestMessage, refetch]);

  /**
   * POST /api/system/pending/:id/execute
   * Returns the outcome for the panel to handle per-item UI state.
   * A lost POST response leaves the execution outcome unverified.
   */
  const execute = useCallback(
    async (id: string): Promise<ExecuteOutcome> => {
      const generation = generationRef.current;
      // Invalidate reads started before this new attempt, including late outcome replies.
      refreshVersion.current += 1;
      const attempted = actions.find(row => row.id === id && row.actionType === 'safe-restart');
      if (attempted) {
        // Remove the prior attempt's proof from rendered state before sending the POST.
        setActions(previous => previous.map(row => row.id === id
          ? { ...row, attemptedLocally: true, currentActionOutcome: UNKNOWN_OUTCOME, retryable: false } : row));
        retainedRef.current = [...retainedRef.current.filter(row => row.id !== id),
          { ...attempted, attemptedLocally: true, currentActionOutcome: UNKNOWN_OUTCOME, retryable: false }].slice(-20);
        if (ownerScope) {
          try { sessionStorage.setItem(`server-action-outcomes:${ownerScope}`, JSON.stringify(retainedRef.current)); } catch { /* The in-memory lock still applies; reload persistence is unavailable. */ }
        }
      }
      try {
        const res = await (
          authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
        )(`/api/system/pending/${id}/execute`, { method: 'POST' });

        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        if (generation !== generationRef.current) return { status: 'error', code: 'outcome_unverified' };
        if (!res.ok) {
          const code = String(data.code ?? 'outcome_unverified');
          if (code === 'outcome_unverified' || code === 'execution_unresolved') void refetch();
          setActions(previous => previous.map(action => action.id === id
            && isRestartPreparationBlocked(action.actionType, code)
            ? { ...action, status: 'failed', error: code, reasonCode: code,
              currentActionOutcome: { status: 'failure', reasonCode: code, retryable: false } } : action));
          return { status: 'error', code };
        }

        const s = String(data.status ?? '');
        void refetch();
        if (s === 'restarting') return { status: 'restarting' };
        if (s === 'success') {
          return { status: 'success' };
        }
        if (s === 'deferred') {
          return {
            status: 'deferred',
            reason: String(data.reason ?? ''),
            detail: data.detail !== undefined ? String(data.detail) : undefined,
          };
        }
        return { status: 'error', code: 'outcome_unverified' };
      } catch {
        // Reconcile with a GET only; never repeat the execution.
        if (generation === generationRef.current) void refetch();
        return { status: 'error', code: 'outcome_unverified' };
      }
    },
    [refetch, actions, ownerScope],
  );

  /**
   * Superseded requests: remove the local reference only. Other eligible rows
   * use DELETE /api/system/pending/:id — idempotent dismiss.
   * Triggers refetch; WS will also broadcast pending-actions-updated.
   */
  const dismiss = useCallback(
    async (id: string): Promise<DismissOutcome> => {
      const generation = generationRef.current;
      if (scopeRef.current !== ownerScope) return { status: 'error' };
      const row = retainedRef.current.find(action => action.id === id);
      if (row && isSupersededAction(row)) {
        // Invalidate an in-flight refresh so it cannot restore the removed reference.
        refreshVersion.current += 1;
        retainedRef.current = retainedRef.current.filter(action => action.id !== id);
        if (ownerScope) {
          try { sessionStorage.setItem(`server-action-outcomes:${ownerScope}`, JSON.stringify(retainedRef.current)); } catch { /* In-memory removal still applies. */ }
        }
        setActions(current => current.filter(action => action.id !== id));
        setLoading(false);
        return { status: 'dismissed', id };
      }
      if (row?.actionType === 'safe-restart' && (row.status === 'executing'
        || row.currentActionOutcome?.status === 'unknown' || row.retryable === false)) return { status: 'error' };
      try {
        const res = await (
          authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
        )(`/api/system/pending/${id}`, { method: 'DELETE' });
        if (!res.ok || generation !== generationRef.current) return { status: 'error' };
        retainedRef.current = retainedRef.current.filter(row => row.id !== id);
        if (ownerScope) {
          try { sessionStorage.setItem(`server-action-outcomes:${ownerScope}`, JSON.stringify(retainedRef.current)); } catch { /* Optional browser persistence. */ }
        }
        setActions(previous => previous.filter(row => row.id !== id));
        void refetch();
        return { status: 'dismissed', id };
      } catch {
        return { status: 'error' };
      }
    },
    [refetch, ownerScope],
  );

  const scoped = actionsScope === ownerScope;
  return {
    actions: scoped ? actions : [],
    history: scoped ? history : [],
    loading,
    execute,
    dismiss,
    refetch,
  };
}

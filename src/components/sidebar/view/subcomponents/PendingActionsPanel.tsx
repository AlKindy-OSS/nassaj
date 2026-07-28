/**
 * PendingActionsPanel — T-944 F1 · B-247
 *
 * لوحة أوامر النظام المعلّقة. تحلّ محلّ RestartConfirmModal.
 * تعرض قائمة PublicAction[] من GET /api/system/pending مع:
 * - صف علوي ثابت غير قابل للحذف عند restartRequired.
 * - كل عنصر: label + commandPreview (dir=ltr mono) + reason + رابط جلسة
 *   + شارة حالة + زر «تنفيذ» (owner فقط) + زر «تجاهل» (owner فقط).
 * - معالجة كاملة: restarting/deferred/409/400/503/500 + استطلاع /health.
 *
 * B-247 — طابوران في لوحة واحدة، والفرق ما يُصدَّق لا مَن يطلب:
 * - 🟡 الأصفر (أعلى): pending_server_actions — مفتاح رمزي مخزَّن، والأمر مثبَّت في
 *   SERVER_ACTIONS ويُطلَق بلا صدفة. زر «تنفيذ» هنا مشروع لأن ما يُنفَّذ معروف سلفاً.
 * - 🔴 الأحمر (أسفل): command_board_raw_queue — نصّ صدفة حرّ يُنفَّذ كما هو، وقد يكون
 *   كاتبه وكيلاً قرأ محتوى خارجياً ⇒ رسالة مسمومة = RCE (ADR-070 §59-63). لذلك
 *   لا زرّ تنفيذ هنا إطلاقاً: الصفّ يفتح ExecReviewDialog وهي وحدها بوابة التنفيذ
 *   (بصمة sha256 على البايتات المعروضة + إقرار يُصفَّر لكل أمر + عزل bidi).
 *   الرؤية ليست قراراً عميلياً: الخادم يُرسل commands: [] لمن لا يجتاز mayReadQueue.
 *
 * الأنماط: ReactDOM.createPortal، aria-modal، focus trap، logical properties.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { useAuth } from '../../../auth/context/AuthContext';
import { ExecReviewDialog, type RawCommand } from '../../../command-board/ExecReviewDialog';
import type { PublicAction, ExecuteOutcome, DismissOutcome } from '../../../../hooks/useServerActions';
import { useRestartWatch } from '../../../../hooks/useRestartWatch';
import { authenticatedFetch } from '../../../../utils/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ItemExecStatus =
  | 'idle'
  | 'executing'
  | 'restarting'
  | 'success'
  | 'deferred'
  | 'failed';

type ItemState = {
  execStatus: ItemExecStatus;
  errorMsg: string;
  deferredDetail: string;
};

export type PendingActionsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  /** true when build:client has run but server hasn't restarted yet (T-928). */
  restartRequired: boolean;
  actions: PublicAction[];
  loading: boolean;
  execute: (id: string) => Promise<ExecuteOutcome>;
  dismiss: (id: string) => Promise<DismissOutcome>;
  /**
   * B-247 — the raw shell queue, already scoped by the server's mayReadQueue gate
   * (empty for anyone who does not hold the raw tier on an armed board).
   */
  rawCommands?: readonly RawCommand[];
  /** Re-read the raw queue after a dismiss or after the dialog consumed a row. */
  onRawQueueChange?: () => void;
};

/** Stable default so an omitted prop does not churn effect dependencies. */
const NO_RAW_COMMANDS: readonly RawCommand[] = Object.freeze([]);

const RAW_URL = '/api/system/command-board-raw';

// ---------------------------------------------------------------------------
// B-193 types: live-session deferred detail for the restartRequired row
// ---------------------------------------------------------------------------

type LiveSession = {
  pid: number;
  provider: string;
  ageS: number;
  /**
   * Conversation title (B-270), resolved server-side from the session id the
   * gate parsed out of the child's argv. Absent for a brand-new conversation
   * that has no id on its command line yet, or when the lookup found nothing.
   */
  title?: string;
  /** The blocking session lives in a project this user may not see (B-PRIV). */
  titleRedacted?: boolean;
  sessionId?: string;
  cmd?: string;
};

type RestartRowState = {
  execStatus: ItemExecStatus;
  errorMsg: string;
  sessionCount: number | null;
  liveSessions: LiveSession[];
};

function defaultRestartRowState(): RestartRowState {
  return { execStatus: 'idle', errorMsg: '', sessionCount: null, liveSessions: [] };
}

function formatAge(ageS: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (ageS < 60) return t('pendingActions.sessionAge_second', { seconds: ageS });
  return t('pendingActions.sessionAge_minute', { minutes: Math.floor(ageS / 60) });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Action types whose queue row is DELETED by the server before the action even
 * starts, so a retry must not be addressed to the row id (B-200 UI complement).
 *
 * `safe-restart` is a `detachExec` action: executeActionRow deletes the row
 * synchronously *before* spawning, precisely so a process that dies mid-restart
 * leaves no stale row. If the spawn then declines (live sessions) the server
 * re-queues a row — but the client is still holding the id it started with, and
 * any retry against a deleted/replaced id can only ever CAS-miss → 409
 * not_claimable, forever. For these types the retry is re-issued through the
 * record-then-run endpoint (/actions/:actionType/run), which creates a fresh row
 * and runs it under exactly the same server-side gates.
 */
const RUN_BY_TYPE_ON_DEAD_ROW: ReadonlySet<string> = new Set(['safe-restart']);

/** Outcome of the record-then-run endpoint (POST /api/system/actions/:type/run). */
type DirectRunOutcome =
  | { status: 'restarting' }
  | { status: 'success' }
  | { status: 'deferred'; detail: string; sessionCount: number | null; liveSessions: LiveSession[] }
  | { status: 'error'; code: string };

/**
 * POST /api/system/actions/:actionType/run — the "record then run in one call"
 * path (T-947). Shared by the static restartRequired row and by the dead-row
 * retry fallback above so both consume one implementation of the response
 * contract (restarting | deferred + liveSessions | success | error code).
 * A network error right after the POST means the server is going down → treat
 * it as 'restarting' (same reasoning as useServerActions.execute).
 */
async function runActionByType(actionType: string, reason: string): Promise<DirectRunOutcome> {
  try {
    const res = await (
      authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
    )(`/api/system/actions/${encodeURIComponent(actionType)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) return { status: 'error', code: String(data.code ?? 'internal') };

    const s = String(data.status ?? '');
    if (s === 'restarting') return { status: 'restarting' };
    if (s === 'success') return { status: 'success' };
    if (s === 'deferred') {
      const sessionCount = typeof data.sessionCount === 'number' ? data.sessionCount : null;
      const rawSessions = Array.isArray(data.liveSessions) ? data.liveSessions : [];
      const liveSessions = rawSessions.map((e: unknown) => {
        const v = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
        return {
          pid: typeof v.pid === 'number' ? v.pid : 0,
          provider: typeof v.provider === 'string' ? v.provider : '?',
          ageS: typeof v.ageS === 'number' ? v.ageS : 0,
          title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : undefined,
          titleRedacted: v.titleRedacted === true,
          sessionId: typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : undefined,
        };
      }) as LiveSession[];
      return {
        status: 'deferred',
        detail: data.detail !== undefined ? String(data.detail) : '',
        sessionCount,
        liveSessions,
      };
    }
    return { status: 'error', code: 'internal' };
  } catch {
    // Network error immediately after POST → the server is restarting.
    return { status: 'restarting' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultItemState(): ItemState {
  return { execStatus: 'idle', errorMsg: '', deferredDetail: '' };
}

function resolveErrorKey(code: string): string {
  switch (code) {
    case 'action_in_flight': return 'errorInFlight';
    case 'not_claimable': return 'errorNotClaimable';
    case 'unknown_action': return 'errorUnknownAction';
    case 'proc_not_in_pm2': return 'errorProcNotInPM2';
    default: return 'errorGeneric';
  }
}

// ---------------------------------------------------------------------------
// StatusBadge sub-component
// ---------------------------------------------------------------------------

function StatusBadge({
  serverStatus,
  localStatus,
  t,
}: {
  serverStatus: PublicAction['status'];
  localStatus: ItemExecStatus;
  t: TFunction;
}) {
  // Local state takes precedence over server status
  const effective: 'pending' | 'executing' | 'failed' =
    localStatus === 'executing' || localStatus === 'restarting'
      ? 'executing'
      : localStatus === 'failed'
        ? 'failed'
        : serverStatus;

  if (effective === 'executing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
        <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
        {t('pendingActions.statusExecuting')}
      </span>
    );
  }
  if (effective === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">
        <XCircle className="h-2.5 w-2.5" aria-hidden="true" />
        {t('pendingActions.statusFailed')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
      <Clock className="h-2.5 w-2.5" aria-hidden="true" />
      {t('pendingActions.statusPending')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PendingActionsPanel({
  isOpen,
  onClose,
  restartRequired,
  actions,
  loading,
  execute,
  dismiss,
  rawCommands = NO_RAW_COMMANDS,
  onRawQueueChange,
}: PendingActionsPanelProps) {
  const { t } = useTranslation('sidebar');
  const { user } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.role === 'owner';

  // Per-item execution state (queue items)
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});

  // B-247: the raw row currently under review. Non-null ⇒ ExecReviewDialog is
  // open on top of this panel, and this panel must stop reacting to dismissals.
  const [execTarget, setExecTarget] = useState<RawCommand | null>(null);
  const [dismissingRawId, setDismissingRawId] = useState<string | null>(null);

  // B-193: state for the static restartRequired row (not a queue item)
  const [restartRowState, setRestartRowState] = useState<RestartRowState>(defaultRestartRowState);

  // Global restarting state — delegated to useRestartWatch
  const {
    isRestarting: globalRestarting,
    isSuccess: restartSuccess,
    startPolling: pollUntilRestarted,
    reset: resetWatch,
  } = useRestartWatch();

  const contentRef = useRef<HTMLDivElement | null>(null);

  // ----- Focus trap ----------------------------------------------------------
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      contentRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  // ----- Keyboard: Escape closes (not during active restart) ----------------
  //
  // Both this panel and ExecReviewDialog listen on `document` in the CAPTURE
  // phase, and stopPropagation() does not silence a sibling listener on the same
  // node. Without the execTarget guard a single Escape would dismiss the review
  // dialog AND tear down the panel underneath it — so while a command is under
  // review, Escape belongs to the dialog alone.
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !globalRestarting && !execTarget) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [isOpen, globalRestarting, execTarget, onClose]);

  // ----- Reset on open/close ------------------------------------------------
  useEffect(() => {
    if (isOpen) {
      setItemStates({});
      setRestartRowState(defaultRestartRowState());
      setExecTarget(null);
      setDismissingRawId(null);
      resetWatch();
    } else {
      setExecTarget(null);
      resetWatch();
    }
  }, [isOpen, resetWatch]);

  // ----- Helpers ------------------------------------------------------------
  const setItemState = useCallback((id: string, patch: Partial<ItemState>) => {
    setItemStates(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? defaultItemState()), ...patch },
    }));
  }, []);

  // ----- Execute handler ----------------------------------------------------
  const handleExecute = useCallback(
    async (action: PublicAction) => {
      const id = action.id;
      const current = itemStates[id]?.execStatus ?? 'idle';
      if (current === 'executing' || current === 'restarting') return;

      setItemState(id, { execStatus: 'executing', errorMsg: '' });
      let outcome: ExecuteOutcome = await execute(id);

      // B-200 complement: a row id the server no longer accepts (deleted by a
      // detachExec run, or replaced by a re-queued row) can only ever 409. For
      // the action types that legitimately destroy their own row, re-issue the
      // request by TYPE instead of failing the owner with a dead-end error.
      if (
        outcome.status === 'error' &&
        outcome.code === 'not_claimable' &&
        RUN_BY_TYPE_ON_DEAD_ROW.has(action.actionType)
      ) {
        const direct = await runActionByType(action.actionType, 'retry-stale-row');
        outcome =
          direct.status === 'deferred'
            ? { status: 'deferred', reason: 'live-work', detail: direct.detail }
            : direct;
      }

      if (outcome.status === 'restarting') {
        setItemState(id, { execStatus: 'restarting' });
        pollUntilRestarted();
        return;
      }
      if (outcome.status === 'success') {
        setItemState(id, { execStatus: 'success' });
        return;
      }
      if (outcome.status === 'deferred') {
        setItemState(id, {
          execStatus: 'deferred',
          deferredDetail: outcome.detail ?? outcome.reason ?? '',
        });
        return;
      }
      // status === 'error'
      const key = resolveErrorKey(outcome.code);
      setItemState(id, {
        execStatus: 'failed',
        errorMsg: t(`pendingActions.${key}`),
      });
    },
    [execute, itemStates, setItemState, pollUntilRestarted, t],
  );

  // ----- Dismiss handler ----------------------------------------------------
  const handleDismiss = useCallback(
    async (id: string) => {
      const outcome = await dismiss(id);
      if (outcome.status === 'error') {
        setItemState(id, {
          execStatus: 'failed',
          errorMsg: t('pendingActions.errorGeneric'),
        });
      }
      // On success: WS 'pending-actions-updated' → useServerActions refetch
      // → action disappears from actions[] on next render
    },
    [dismiss, setItemState, t],
  );

  // ----- B-193: direct run for the restartRequired static row ---------------
  // Calls POST /api/system/actions/safe-restart/run (T-947). This is the
  // "run without queue" path — separate from the execute() prop which takes
  // a queue-item id. The gate returns 200 { status:'deferred', liveSessions }
  // when live interactive sessions are OS children of the server (T-880).
  const handleRestartExecute = useCallback(async () => {
    const cur = restartRowState.execStatus;
    if (cur === 'executing' || cur === 'restarting') return;

    setRestartRowState({ execStatus: 'executing', errorMsg: '', sessionCount: null, liveSessions: [] });

    const outcome = await runActionByType('safe-restart', 'restart-required-banner');

    if (outcome.status === 'restarting') {
      setRestartRowState({ execStatus: 'restarting', errorMsg: '', sessionCount: null, liveSessions: [] });
      pollUntilRestarted();
      return;
    }
    if (outcome.status === 'deferred') {
      // Gate code 6 — live interactive sessions blocking (T-880). Surface them
      // so the owner knows WHO is blocking and that their OWN session may be one.
      setRestartRowState({
        execStatus: 'deferred',
        errorMsg: '',
        sessionCount: outcome.sessionCount,
        liveSessions: outcome.liveSessions,
      });
      return;
    }
    if (outcome.status === 'success') {
      setRestartRowState({ execStatus: 'success', errorMsg: '', sessionCount: null, liveSessions: [] });
      return;
    }
    setRestartRowState({
      execStatus: 'failed',
      errorMsg: t(`pendingActions.${resolveErrorKey(outcome.code)}`),
      sessionCount: null,
      liveSessions: [],
    });
  }, [restartRowState.execStatus, pollUntilRestarted, t]);

  // ----- B-247: dismiss a raw row without running it ------------------------
  // The only mutating action the red section performs itself. It removes bytes
  // rather than running them, so it needs no review gate — and having it here is
  // what lets an owner clear a command they judge poisoned without ever opening
  // the reviewer on it.
  const handleRawDismiss = useCallback(
    async (id: string) => {
      setDismissingRawId(id);
      try {
        await (authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>)(
          `${RAW_URL}/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
      } catch {
        // Network error — the WS broadcast or the next refresh reconciles.
      } finally {
        setDismissingRawId(null);
        onRawQueueChange?.();
      }
    },
    [onRawQueueChange],
  );

  // ----- Render -------------------------------------------------------------
  if (!isOpen) return null;

  const rawCount = rawCommands.length;
  const totalCount = (restartRequired ? 1 : 0) + actions.length + rawCount;
  // A review dialog on top owns the interaction; the panel must not close under it.
  const canClose = (!globalRestarting || restartSuccess) && !execTarget;

  const panel = (
    <>
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      onClick={e => {
        if (canClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pap-title"
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ServerCrash
              className="h-5 w-5 flex-shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <h2
              id="pap-title"
              className="text-base font-semibold text-foreground"
            >
              {t('pendingActions.title')}
            </h2>
            {totalCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white">
                {totalCount}
              </span>
            )}
          </div>
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={t('actions.cancel')}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Global restarting / success banner */}
        {globalRestarting && !restartSuccess && (
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-5 py-3 text-sm text-amber-700 dark:bg-amber-900/15 dark:text-amber-300">
            <RefreshCw className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden="true" />
            <span>{t('pendingActions.restarting')}</span>
          </div>
        )}
        {restartSuccess && (
          <div className="flex items-center gap-2 border-b border-border bg-emerald-50/60 px-5 py-3 text-sm text-emerald-700 dark:bg-emerald-900/15 dark:text-emerald-300">
            <CheckCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>{t('pendingActions.restartSuccess')}</span>
          </div>
        )}

        {/* Body: scrollable list */}
        <div className="flex-1 overflow-y-auto">
          {/* restartRequired row — B-193: now has Execute button (owner-only).
              Not a queue item; not dismissable. Uses the direct run endpoint. */}
          {restartRequired && (
            <div className="flex items-start gap-3 border-b border-border px-5 py-4">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                {/* Title */}
                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  {t('pendingActions.restartNeeded')}
                </p>

                {/* Hint (idle only) — softer than old disclaimer; describes what
                    the button does rather than asserting the action is imminent */}
                {restartRowState.execStatus === 'idle' && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('pendingActions.restartNeededHint')}
                  </p>
                )}

                {/* Deferred: surface the blocking live sessions */}
                {restartRowState.execStatus === 'deferred' && (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-xs text-blue-700 dark:text-blue-300">
                      {t('pendingActions.deferredSessionsCount', {
                        count: restartRowState.sessionCount ?? restartRowState.liveSessions.length,
                      })}
                    </p>
                    {/* B-270: name each blocker. Five identical "claude · 14m"
                        rows told the owner nothing about WHICH conversation to
                        close; the title (plus pid and short session id) makes
                        the row actionable. The title is content — dir="auto" so
                        an Arabic title reads correctly — while the technical
                        line stays LTR/mono. */}
                    {restartRowState.liveSessions.slice(0, 5).map((sess) => (
                      <div key={sess.pid} className="leading-tight">
                        <p
                          className="truncate text-[11px] text-foreground/80"
                          dir="auto"
                          title={sess.title}
                        >
                          {sess.title
                            ?? (sess.titleRedacted
                              ? t('pendingActions.sessionTitleHidden')
                              : t('pendingActions.sessionTitleUnknown'))}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground" dir="ltr">
                          {sess.provider}
                          {' · '}
                          {formatAge(sess.ageS, t as (key: string, opts?: Record<string, unknown>) => string)}
                          {' · pid '}
                          {sess.pid}
                          {sess.sessionId ? ` · ${sess.sessionId.slice(0, 8)}` : ''}
                        </p>
                      </div>
                    ))}
                    {/* Never let the 5-row cap read as "that's all of them". */}
                    {restartRowState.liveSessions.length > 5 && (
                      <p className="text-[11px] text-muted-foreground">
                        {t('pendingActions.deferredSessionsMore', {
                          count: restartRowState.liveSessions.length - 5,
                        })}
                      </p>
                    )}
                    <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                      {t('pendingActions.deferredOwnSessionWarning')}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t('pendingActions.deferredRetryHint')}
                    </p>
                  </div>
                )}

                {/* Error */}
                {restartRowState.execStatus === 'failed' && restartRowState.errorMsg && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {restartRowState.errorMsg}
                  </p>
                )}

                {/* Success (server restarted before WS reconnect confirmed it) */}
                {restartRowState.execStatus === 'success' && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {t('restart.success')}
                  </p>
                )}

                {/* Action buttons */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/* Execute button: owner + idle */}
                  {isOwner && restartRowState.execStatus === 'idle' && (
                    <Button
                      className="h-7 bg-amber-600 px-3 text-xs text-white hover:bg-amber-700"
                      onClick={() => void handleRestartExecute()}
                    >
                      {t('pendingActions.execute')}
                    </Button>
                  )}

                  {/* In-progress spinner */}
                  {isOwner && (restartRowState.execStatus === 'executing' || restartRowState.execStatus === 'restarting') && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      <span>
                        {restartRowState.execStatus === 'restarting'
                          ? t('pendingActions.restarting')
                          : t('pendingActions.statusExecuting')}
                      </span>
                    </div>
                  )}

                  {/* Retry after deferred or failed */}
                  {isOwner && (restartRowState.execStatus === 'deferred' || restartRowState.execStatus === 'failed') && (
                    <Button
                      variant="outline"
                      className="h-7 px-3 text-xs"
                      onClick={() => void handleRestartExecute()}
                    >
                      {t('restart.retry')}
                    </Button>
                  )}

                  {/* Non-owner notice in idle */}
                  {!isOwner && restartRowState.execStatus === 'idle' && (
                    <span className="text-xs text-muted-foreground">
                      {t('pendingActions.ownerOnly')}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!restartRequired && !loading && actions.length === 0 && rawCount === 0 && (
            <div className="flex items-center justify-center px-5 py-10 text-sm text-muted-foreground">
              {t('pendingActions.empty')}
            </div>
          )}

          {/* Loading state (first load, no items yet) */}
          {loading && actions.length === 0 && rawCount === 0 && !restartRequired && (
            <div className="flex items-center justify-center px-5 py-10">
              <Loader2
                className="h-5 w-5 animate-spin text-muted-foreground"
                aria-label={t('sessions.loading')}
              />
            </div>
          )}

          {/* Action list */}
          {actions.map(action => {
            const state = itemStates[action.id] ?? defaultItemState();
            const { execStatus } = state;
            const isExecuting = execStatus === 'executing' || execStatus === 'restarting';
            const isFailed = execStatus === 'failed';
            const isDeferred = execStatus === 'deferred';
            const isSuccess = execStatus === 'success';

            return (
              <div
                key={action.id}
                className="border-b border-border/60 px-5 py-4 last:border-b-0"
              >
                {/* Status badge + label */}
                <div className="mb-2 flex flex-wrap items-start gap-2">
                  <StatusBadge
                    serverStatus={action.status}
                    localStatus={execStatus}
                    t={t}
                  />
                  <p className="min-w-0 flex-1 text-sm font-medium text-foreground">
                    {action.label}
                  </p>
                </div>

                {/* commandPreview — always LTR, monospace (code/ASCII) */}
                {action.commandPreview && (
                  <pre
                    className="mb-2 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground"
                    dir="ltr"
                  >
                    {action.commandPreview}
                  </pre>
                )}

                {/* reason */}
                {action.reason && (
                  <p className="mb-2 text-xs text-muted-foreground">{action.reason}</p>
                )}

                {/* Deferred detail */}
                {isDeferred && (
                  <p className="mb-2 text-xs text-blue-700 dark:text-blue-300">
                    {state.deferredDetail || t('pendingActions.deferredLiveWork')}
                  </p>
                )}

                {/* Error message */}
                {isFailed && state.errorMsg && (
                  <p className="mb-2 flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {state.errorMsg}
                  </p>
                )}

                {/* Success message */}
                {isSuccess && (
                  <p className="mb-2 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {t('restart.success')}
                  </p>
                )}

                {/* Action buttons row */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Open session link */}
                  {action.sessionId && (
                    <button
                      type="button"
                      onClick={() => {
                        navigate(`/session/${action.sessionId}`);
                        onClose();
                      }}
                      className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      {t('pendingActions.openSession')}
                    </button>
                  )}

                  {/* Execute button (owner + idle) */}
                  {isOwner && execStatus === 'idle' && (
                    <Button
                      className="h-7 bg-amber-600 px-3 text-xs text-white hover:bg-amber-700"
                      onClick={() => void handleExecute(action)}
                    >
                      {t('pendingActions.execute')}
                    </Button>
                  )}

                  {/* Executing spinner */}
                  {isOwner && isExecuting && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                      <span>{t('pendingActions.statusExecuting')}</span>
                    </div>
                  )}

                  {/* Retry button (deferred or failed) */}
                  {isOwner && (isDeferred || isFailed) && (
                    <Button
                      variant="outline"
                      className="h-7 px-3 text-xs"
                      onClick={() => void handleExecute(action)}
                    >
                      {t('restart.retry')}
                    </Button>
                  )}

                  {/* Dismiss button (owner, not success) */}
                  {isOwner && !isSuccess && (
                    <Button
                      variant="ghost"
                      className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => void handleDismiss(action.id)}
                      disabled={isExecuting}
                    >
                      {t('pendingActions.dismiss')}
                    </Button>
                  )}

                  {/* Non-owner notice */}
                  {!isOwner && execStatus === 'idle' && (
                    <span className="text-xs text-muted-foreground">
                      {t('pendingActions.ownerOnly')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* ── B-247: raw shell queue — the RED tier ─────────────────────────
              Separate section, separate colour, separate promise. Above: a
              symbolic key the server resolves to a fixed command. Here: free
              shell text that runs verbatim. Nothing in this block executes —
              the only control is «review», which opens ExecReviewDialog. */}
          {rawCount > 0 && (
            <section
              className="border-t-2 border-red-300 bg-red-50/40 dark:border-red-800/70 dark:bg-red-950/20"
              aria-labelledby="pap-raw-title"
            >
              <div className="flex items-start gap-2.5 px-5 pb-2 pt-4">
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-400"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3
                      id="pap-raw-title"
                      className="text-sm font-semibold text-red-700 dark:text-red-300"
                    >
                      {t('pendingActions.rawTitle')}
                    </h3>
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-bold text-white">
                      {rawCount}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-red-700/90 dark:text-red-400/90">
                    {t('pendingActions.rawWarning')}
                  </p>
                </div>
              </div>

              {rawCommands.map(cmd => (
                <div
                  key={cmd.id}
                  className="border-t border-red-200/70 px-5 py-3 dark:border-red-900/50"
                >
                  {/*
                    Command text: dir="ltr" + unicode-bidi:isolate.
                    In an RTL page the bidi algorithm can reorder a mixed-script
                    command so the preview reads differently from what would run.
                    The reviewer repeats this isolation; here it protects the
                    glance that decides whether to open the reviewer at all.
                  */}
                  <p
                    dir="ltr"
                    className="truncate font-mono text-xs text-foreground"
                    style={{ unicodeBidi: 'isolate' }}
                    title={cmd.command}
                  >
                    {cmd.command}
                  </p>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {cmd.requestedBy ? (
                      <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
                        {t('pendingActions.rawRequestedBy', { name: cmd.requestedBy })}
                      </span>
                    ) : (
                      /* B-277: a row can reach this queue without a recorded
                         requester — one did, on 2026-07-27, with no matching
                         insert entry in the audit log at all. Saying so is the
                         difference between «somebody queued this» and «nobody
                         knows who did». */
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('pendingActions.rawUnattributed')}
                      </span>
                    )}
                    {cmd.requestedAt && (
                      <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
                        {new Date(cmd.requestedAt).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* Row actions — NO execute button here by design (ADR-070 §16).
                      «review» only opens the dialog; the dialog owns the digest
                      check, the per-command acknowledgement and the POST. */}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      className="h-7 bg-red-600 px-3 text-xs text-white hover:bg-red-700"
                      onClick={() => setExecTarget(cmd)}
                      aria-label={`${t('pendingActions.rawReview')} — ${cmd.command.slice(0, 40)}`}
                    >
                      {t('pendingActions.rawReview')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => void handleRawDismiss(cmd.id)}
                      disabled={dismissingRawId === cmd.id}
                      aria-label={`${t('pendingActions.dismiss')} — ${cmd.command.slice(0, 40)}`}
                    >
                      {dismissingRawId === cmd.id && (
                        <Loader2 className="me-1 h-3 w-3 animate-spin" aria-hidden="true" />
                      )}
                      {dismissingRawId === cmd.id ? null : (
                        <Trash2 className="me-1 h-3 w-3" aria-hidden="true" />
                      )}
                      {t('pendingActions.dismiss')}
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={!canClose}
          >
            {t('actions.cancel')}
          </Button>
        </div>
      </div>
    </div>

    {/*
      B-247 — the single execution gate for the red tier. A SIBLING of the
      backdrop, not a child: it renders through its own portal, but React events
      bubble along the React tree, so nesting it would send every click inside
      the reviewer through the backdrop's dismiss handler.

      Stacking works out because both use z-50 and the dialog's portal node is
      appended to <body> later, so it paints last.

      onComplete does NOT close the dialog: the reviewer stays open to show the
      exit code and output, exactly as it does in settings. It re-reads the queue
      instead, so the consumed row leaves the list and every badge behind the
      dialog is already correct when the owner closes it.
    */}
    <ExecReviewDialog
      target={execTarget}
      onClose={() => setExecTarget(null)}
      onComplete={() => onRawQueueChange?.()}
    />
    </>
  );

  return ReactDOM.createPortal(panel, document.body);
}

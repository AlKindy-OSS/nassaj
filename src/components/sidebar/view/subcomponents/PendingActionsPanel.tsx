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
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { HistoryTab } from '../../../command-board/HistoryTab';
import { resolveErrorKey } from '../../../command-board/actionErrorKey';
import { formatAge } from '../../../../utils/relativeAge';
import {
  countPendingServerActions,
  deriveHistoryFromActions,
  filterLiveHistory,
  isSupersededAction,
  isRestartPreparationBlocked,
  isTerminalOutcome,
  mergeHistory,
  type PublicAction,
  type ExecuteOutcome,
  type DismissOutcome,
  type HistoryEntry,
} from '../../../../hooks/useServerActions';
import {
  useRestartWatch,
  waitForExpectedServerBuildLoaded,
} from '../../../../hooks/useRestartWatch';
import { authenticatedFetch } from '../../../../utils/api';
import {
  publishRestartSignal,
  restartCooldownRemainingMs,
  subscribeRestartSignal,
} from '../../../../utils/restartSignal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ItemExecStatus =
  | 'idle'
  | 'executing'
  | 'restarting'
  | 'success'
  | 'deferred'
  | 'unverified'
  | 'failed';

type ItemState = {
  errorCode?: string;
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
  refreshActions?: () => Promise<void>;
  dismiss: (id: string) => Promise<DismissOutcome>;
  /**
   * T-1684 — settled operations from GET /api/system/pending. Absent on a
   * server that predates the split, which simply leaves the tab empty.
   */
  history?: readonly HistoryEntry[];
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
const NO_HISTORY: readonly HistoryEntry[] = Object.freeze([]);

type PanelTab = 'queue' | 'history';

/** One minute is the resolution of the "deleted in N min" countdown. */
const HISTORY_TICK_MS = 60_000;

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * T-1296 — الأفعال التي يقع تكرارُها على الخادم نفسه فيهدره.
 *
 * الحارس القديم هنا كان `if (hasRestartRequest || cur === 'executing' || cur === 'restarting' || cur === 'unverified') return;`
 * وهو حالة مكوّن واحد: لا يرى تبويباً ثانياً، ولا مرآة جلسة لمشاهد آخر، ولا حتى
 * نفسه بعد إعادة تحميل الصفحة. وحارس `restartInFlight` في الخادم يعيش في ذاكرة
 * العملية — وإعادة التشغيل تستبدل تلك العملية، فالضغطة الثانية بعد ثانيتين تصل
 * عمليةً وليدةً بحارس نظيف وتُنفَّذ فعلاً. لذلك تُعامَل هذه الأفعال بنافذة تهدئة
 * معمَّرة في localStorage ومبثوثة بين التبويبات (restartSignal).
 *
 * الحدّ المعروف: التهدئة لا تعبر إلى متصفّح آخر ولا جهاز آخر. إتمامها يحتاج
 * طابعاً زمنياً من الخادم في /health (T-1302).
 */
const COOLDOWN_ACTION_TYPES: ReadonlySet<string> = new Set(['safe-restart']);

/** Terminal-looking outcomes that can race the durable OID loaded receipt. */
const RECONCILABLE_RESTART_ERRORS: ReadonlySet<string> = new Set([
  'action_in_flight',
  'not_claimable',
  'oid_control_failed',
  'superseded',
]);

/** Outcome of the record-then-run endpoint (POST /api/system/actions/:type/run). */
type DirectRunOutcome =
  | { status: 'restarting' }
  | { status: 'success' }
  | { status: 'deferred'; detail: string; sessionCount: number | null; liveSessions: LiveSession[] }
  | { status: 'error'; code: string };

/** T-1677 — Outcome of POST /api/system/actions/force-restart/run */
type ForceRunOutcome =
  | { status: 'restarting' }
  | {
      status: 'confirm_required';
      reasonCode: string;
      sessionCount: number;
      liveSessions: LiveSession[];
      liveCount?: number;
      detail?: string;
    }
  | { status: 'error'; code: string };

type ForceConfirmState = {
  sessionCount: number;
  liveSessions: LiveSession[];
  reasonCode: string;
  liveCount?: number;
  detail?: string;
} | null;

/**
 * POST /api/system/actions/:actionType/run — the "record then run in one call"
 * path (T-947), used only by the static restartRequired row. Response
 * contract (restarting | deferred + liveSessions | success | error code).
 * A network error leaves the execution outcome unverified.
 */
async function runActionByType(
  actionType: string,
  reason: string,
  expectedServerBuildId: string | null = null,
): Promise<DirectRunOutcome> {
  try {
    const res = await (
      authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
    )(`/api/system/actions/${encodeURIComponent(actionType)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, ...(expectedServerBuildId ? { expectedServerBuildId } : {}) }),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) return { status: 'error', code: String(data.code ?? 'outcome_unverified') };

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
    return { status: 'error', code: 'outcome_unverified' };
  } catch {
    // No acknowledgement: do not infer a restart from transport failure.
    return { status: 'error', code: 'outcome_unverified' };
  }
}

/**
 * T-1677 — POST /api/system/actions/force-restart/run
 * Forces a restart even when live sessions block safe-restart.
 * The server either proceeds immediately (restarting) or requests confirmation
 * (confirm_required) supplying the session list the owner must approve.
 */
async function runForceRestart(
  body: {
    confirmKillSessions?: true;
    confirmedSessionCount?: number;
    reason?: string;
    expectedServerBuildId: string;
  },
): Promise<ForceRunOutcome> {
  try {
    const res = await (
      authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
    )('/api/system/actions/force-restart/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) return { status: 'error', code: String(data.code ?? 'outcome_unverified') };

    const s = String(data.status ?? '');
    if (s === 'restarting') return { status: 'restarting' };
    if (s === 'confirm_required') {
      const sessionCount = typeof data.sessionCount === 'number' ? data.sessionCount : 0;
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
        status: 'confirm_required',
        reasonCode: typeof data.reasonCode === 'string' ? data.reasonCode : 'live_sessions',
        sessionCount,
        liveSessions,
        liveCount: typeof data.liveCount === 'number' ? data.liveCount : undefined,
        detail: typeof data.detail === 'string' ? data.detail : undefined,
      };
    }
    return { status: 'error', code: 'outcome_unverified' };
  } catch {
    return { status: 'error', code: 'outcome_unverified' };
  }
}

/** Bind local-preview clicks to the candidate visible at click time. */
async function readExpectedPreviewServerBuildId(): Promise<string> {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('preview_identity_unavailable');
    const health = await response.json() as Record<string, unknown>;
    const candidate = typeof health.serverCandidateBuildId === 'string' ? health.serverCandidateBuildId : '';
    const loaded = typeof health.serverLoadedBuildId === 'string' ? health.serverLoadedBuildId : '';
    const promoted = health.serverPromotedBuildId;
    const onDisk = typeof health.serverBuildIdOnDisk === 'string' ? health.serverBuildIdOnDisk : '';
    const promotedMatchesLoaded = promoted === null
      || (typeof promoted === 'string' && /^[a-f0-9]{64}$/.test(promoted) && promoted === loaded);
    if (health.serverPreviewActivationV2 !== true || health.restartRequired !== true
      || !/^[a-f0-9]{64}$/.test(candidate)
      || !/^[a-f0-9]{64}$/.test(loaded) || candidate === loaded
      || !promotedMatchesLoaded || onDisk !== loaded) {
      throw new Error('preview_identity_invalid');
    }
    return candidate;
  } catch {
    throw new Error('preview_identity_unavailable');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultItemState(): ItemState {
  return { execStatus: 'idle', errorMsg: '', deferredDetail: '' };
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
  if (localStatus === 'success') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
        <CheckCircle className="h-2.5 w-2.5" aria-hidden="true" />
        {t('restart.success')}
      </span>
    );
  }
  if (localStatus === 'unverified') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Clock className="h-2.5 w-2.5" aria-hidden="true" />
      {t('pendingActions.statusVerifying')}
    </span>;
  }
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
// ForceRestartConfirmDialog — T-1677
// ---------------------------------------------------------------------------

/**
 * Confirmation modal shown when force-restart finds blocking live sessions.
 * RTL first (dir="rtl" on the dialog box). Rendered through a separate portal
 * at z-[60] so it overlays the parent panel without being a child of its
 * backdrop (which would re-route click events through the dismiss handler).
 *
 * Accessibility: aria-modal, Escape closes via capture-phase listener, focus
 * is moved to the first focusable element on open, logical properties for
 * margin/padding so RTL/LTR both render correctly.
 */
const DIALOG_RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

function ForceRestartConfirmDialog({
  confirm,
  onClose,
  onConfirm,
  t,
  lang,
}: {
  confirm: ForceConfirmState;
  onClose: () => void;
  /** Called with the displayed count — liveCount for live_work, sessionCount otherwise. */
  onConfirm: (displayedCount: number) => void;
  t: TFunction;
  lang: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogDir = DIALOG_RTL_LANGUAGES.has(lang.slice(0, 2)) ? 'rtl' : 'ltr';

  // Focus trap — first focusable element on open
  useEffect(() => {
    if (!confirm) return;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [confirm]);

  // Escape → cancel (capture phase so it fires before the parent panel's handler)
  useEffect(() => {
    if (!confirm) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handle, true);
    return () => document.removeEventListener('keydown', handle, true);
  }, [confirm, onClose]);

  if (!confirm) return null;

  const { sessionCount, liveSessions, reasonCode, liveCount } = confirm;
  const isLiveWork = reasonCode === 'live_work' && liveSessions.length === 0;
  const displayCount = isLiveWork ? (liveCount ?? sessionCount) : sessionCount;

  const content = (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="force-restart-confirm-title"
        dir={dialogDir}
        className="w-full max-w-md overflow-hidden rounded-xl border border-destructive/40 bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <AlertTriangle
            className="h-5 w-5 flex-shrink-0 text-destructive"
            aria-hidden="true"
          />
          <h2
            id="force-restart-confirm-title"
            className="text-base font-semibold text-destructive"
          >
            {isLiveWork
              ? t('pendingActions.forceRestartConfirmTitleWork', { count: displayCount })
              : t('pendingActions.forceRestartConfirmTitle', { count: displayCount })}
          </h2>
        </div>

        {/* Session list */}
        <div className="max-h-[40vh] overflow-y-auto px-5 py-4 space-y-3">
          {!isLiveWork && liveSessions.length > 0 && (
            <div className="space-y-1.5">
              {liveSessions.slice(0, 5).map((sess) => (
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
              {liveSessions.length > 5 && (
                <p className="text-[11px] text-muted-foreground">
                  {t('pendingActions.deferredSessionsMore', {
                    count: liveSessions.length - 5,
                  })}
                </p>
              )}
            </div>
          )}
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t('pendingActions.forceRestartOwnSessionWarning')}
          </p>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            className="bg-destructive px-3 text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm(displayCount)}
          >
            {t('pendingActions.forceRestartConfirm')}
          </Button>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(content, document.body);
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
  refreshActions,
  history = NO_HISTORY,
  rawCommands = NO_RAW_COMMANDS,
  onRawQueueChange,
}: PendingActionsPanelProps) {
  const { t, i18n } = useTranslation('sidebar');
  const { user } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.role === 'owner';
  const accountScope = `${user?.id ?? ''}:${user?.role ?? ''}`;
  const accountScopeRef = useRef(accountScope);
  accountScopeRef.current = accountScope;
  const [itemStateScope, setItemStateScope] = useState(accountScope);
  const hasRestartRequest = actions.some(action => action.actionType === 'safe-restart');

  // Per-item execution state (queue items)
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});
  const [activeTab, setActiveTab] = useState<PanelTab>('queue');
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const [verificationDelayed, setVerificationDelayed] = useState(false);
  const unresolvedIds = actions.filter(action => action.currentActionOutcome?.status === 'unknown'
    || (!['success', 'failure'].includes(action.currentActionOutcome?.status ?? '')
      && itemStateScope === accountScope && ['unverified', 'restarting'].includes(itemStates[action.id]?.execStatus))
    || (action.currentActionOutcome?.status === 'pending' && !action.currentActionOutcome.retryable))
    .map(action => action.id).sort().join(',');
  const refreshActionsRef = useRef(refreshActions);
  refreshActionsRef.current = refreshActions;
  // Retry reads only, bounded independently of rerenders and refreshed snapshots.
  useEffect(() => {
    setVerificationDelayed(false);
    if (!isOpen || !unresolvedIds) return;
    let reading = false;
    const tick = setInterval(async () => {
      if (reading) return;
      reading = true;
      try { await refreshActionsRef.current?.(); } catch { /* Keep the outcome unknown until authoritative evidence arrives. */ }
      finally { reading = false; }
    }, 5000);
    const timeout = setTimeout(() => {
      clearInterval(tick);
      setVerificationDelayed(true);
    }, 60000);
    return () => { clearInterval(tick); clearTimeout(timeout); };
  }, [isOpen, unresolvedIds, accountScope]);

  // B-247: the raw row currently under review. Non-null ⇒ ExecReviewDialog is
  // open on top of this panel, and this panel must stop reacting to dismissals.
  const [execTarget, setExecTarget] = useState<RawCommand | null>(null);
  const [dismissingRawId, setDismissingRawId] = useState<string | null>(null);

  // B-193: state for the static restartRequired row (not a queue item)
  const [restartRowState, setRestartRowState] = useState<RestartRowState>(defaultRestartRowState);

  // T-1677: state for the force-restart button
  const [forceRestartStatus, setForceRestartStatus] = useState<'idle' | 'executing' | 'restarting' | 'failed'>('idle');
  const [forceRestartError, setForceRestartError] = useState('');
  const [forceConfirm, setForceConfirm] = useState<ForceConfirmState>(null);

  // Global restarting state — delegated to useRestartWatch
  const {
    isRestarting: globalRestarting,
    isSuccess: restartSuccess,
    startPolling: pollUntilRestarted,
    reset: resetWatch,
  } = useRestartWatch();

  // T-1296: ما تبقّى من نافذة التهدئة بعد آخر طلب إعادة تشغيل ناجح — يُقرأ من
  // مخزن مشترك بين التبويبات لا من حالة هذا المكوّن.
  const [cooldownMs, setCooldownMs] = useState(0);

  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen) void refreshActions?.();
  }, [isOpen, refreshActions]);

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
      if (e.key === 'Escape' && !globalRestarting && !execTarget && !forceConfirm) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [isOpen, globalRestarting, execTarget, forceConfirm, onClose]);

  // ----- Reset on open/close ------------------------------------------------
  useEffect(() => {
    if (isOpen) {
      setItemStates({});
      setActiveTab('queue');
      setHistoryBusyId(null);
      setItemStateScope(accountScope);
      setRestartRowState(defaultRestartRowState());
      setExecTarget(null);
      setDismissingRawId(null);
      setForceRestartStatus('idle');
      setForceRestartError('');
      setForceConfirm(null);
      resetWatch();
    } else {
      setExecTarget(null);
      setForceConfirm(null);
      resetWatch();
    }
  }, [isOpen, resetWatch, accountScope]);

  // ----- T-1296: cross-tab restart cooldown ---------------------------------
  // Recomputed from the shared store (not from local state) so a second tab —
  // or this same tab after a reload — sees the same window. The 1 s tick only
  // drives the countdown label; the guard itself always re-reads the store at
  // click time, so a stale render can never open the door.
  useEffect(() => {
    if (!isOpen) return;
    const sync = () => setCooldownMs(restartCooldownRemainingMs());
    sync();
    const tick = setInterval(sync, 1_000);
    const unsubscribe = subscribeRestartSignal(sync);
    return () => {
      clearInterval(tick);
      unsubscribe();
    };
  }, [isOpen]);

  // ----- T-1684: history clock ----------------------------------------------
  // The server drops a settled row an hour after it ran, but the browser must
  // not wait for that sweep to stop showing it — nor re-render every second to
  // find out. One shared minute tick drives both the countdown and the hiding.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isOpen) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), HISTORY_TICK_MS);
    return () => clearInterval(tick);
  }, [isOpen]);

  /**
   * A row the owner acted on WHILE this panel was open keeps its receipt in the
   * queue until the panel closes; that is the feedback for the click they just
   * made. Everything else that has settled belongs to history only.
   */
  const hasLiveReceipt = useCallback(
    (id: string) => itemStateScope === accountScope && Boolean(itemStates[id]),
    [itemStates, itemStateScope, accountScope],
  );

  const queueActions = useMemo(
    () => actions.filter(action => !isTerminalOutcome(action) || hasLiveReceipt(action.id)),
    [actions, hasLiveReceipt],
  );

  const historyEntries = useMemo(
    () => filterLiveHistory(
      mergeHistory(history, deriveHistoryFromActions(actions.filter(action => !hasLiveReceipt(action.id)))),
      now,
    ),
    [history, actions, hasLiveReceipt, now],
  );

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
      const executionScope = accountScopeRef.current;
      const current = itemStates[id]?.execStatus ?? 'idle';
      const retryConfirmed = action.currentActionOutcome?.status === 'pending' && action.currentActionOutcome.retryable;
      if (current === 'executing' || current === 'restarting' || (current === 'unverified' && !retryConfirmed)
        || action.status === 'executing' || action.retryable === false
        || action.reasonCode === 'execution_unresolved'
        || isRestartPreparationBlocked(action.actionType, itemStates[id]?.errorCode ?? action.reasonCode ?? action.error)) return;
      // T-1296: same window as the static row — a queued safe-restart row is
      // the very same restart, and the store is read at click time, not render.
      if (COOLDOWN_ACTION_TYPES.has(action.actionType) && restartCooldownRemainingMs() > 0) {
        setCooldownMs(restartCooldownRemainingMs());
        return;
      }

      setItemState(id, { execStatus: 'executing', errorMsg: '' });
      const outcome = await execute(id);
      if (executionScope !== accountScopeRef.current) return;

      if (outcome.status === 'restarting') {
        setItemState(id, { execStatus: 'restarting' });
        // T-1296: only a request the server actually accepted opens the window —
        // a deferred or failed attempt restarted nothing and must stay retryable.
        if (COOLDOWN_ACTION_TYPES.has(action.actionType)) publishRestartSignal('triggered');
        pollUntilRestarted(action.expectedServerBuildId);
        return;
      }
      if (outcome.status === 'success') {
        setItemState(id, { execStatus: 'success' });
        return;
      }
      if (outcome.status === 'deferred') {
        setItemState(id, {
          execStatus: 'deferred',
          deferredDetail: outcome.detail || t('pendingActions.deferredLiveWork'),
        });
        return;
      }
      // Loading the requested build proves its availability, not this attempt.
      if (
        action.actionType === 'safe-restart'
        && action.expectedServerBuildId
        && RECONCILABLE_RESTART_ERRORS.has(outcome.code)
        && await waitForExpectedServerBuildLoaded(action.expectedServerBuildId)
      ) {
        if (executionScope !== accountScopeRef.current) return;
        setItemState(id, { execStatus: 'unverified', errorMsg: t('pendingActions.loadedOutcomeUnverified') });
        return;
      }
      if (executionScope !== accountScopeRef.current) return;
      const key = resolveErrorKey(outcome.code);
      setItemState(id, {
        execStatus: ['outcome_unverified', 'execution_unresolved'].includes(outcome.code) ? 'unverified' : 'failed',
        errorMsg: t(`pendingActions.${key}`),
        errorCode: outcome.code,
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

  // ----- T-1684: retry one settled declared action --------------------------
  // Same door as the queue's Execute: POST /pending/:id/execute through the
  // execute() prop, under the same T-1296 cooldown. A raw command never reaches
  // here — re-running free shell text has exactly one gate, ExecReviewDialog.
  const handleHistoryRetry = useCallback(
    async (entry: HistoryEntry) => {
      if (entry.kind !== 'action' || !entry.retryable || historyBusyId) return;
      const cooled = COOLDOWN_ACTION_TYPES.has(entry.actionType ?? '');
      if (cooled && restartCooldownRemainingMs() > 0) {
        setCooldownMs(restartCooldownRemainingMs());
        return;
      }
      setHistoryBusyId(entry.id);
      try {
        const outcome = await execute(entry.id);
        if (outcome.status === 'restarting') {
          if (cooled) publishRestartSignal('triggered');
          pollUntilRestarted();
        }
      } finally {
        setHistoryBusyId(null);
      }
    },
    [execute, historyBusyId, pollUntilRestarted],
  );

  // ----- T-1684: remove one settled operation before its hourly expiry ------
  // A declared action goes through dismiss(), which already owns the refusals
  // that protect an unverified restart's only proof. A raw receipt has its own
  // collection, beside the queue deletion below.
  const handleHistoryRemove = useCallback(
    async (entry: HistoryEntry) => {
      if (historyBusyId) return;
      setHistoryBusyId(entry.id);
      try {
        if (entry.kind === 'action') {
          await dismiss(entry.id);
          return;
        }
        await (authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>)(
          `${RAW_URL}/history/${encodeURIComponent(entry.id)}`,
          { method: 'DELETE' },
        );
        await refreshActions?.();
      } catch {
        // Network error — the WS broadcast or the next refresh reconciles.
      } finally {
        setHistoryBusyId(null);
      }
    },
    [dismiss, historyBusyId, refreshActions],
  );

  // ----- B-193: direct run for the restartRequired static row ---------------
  // Calls POST /api/system/actions/safe-restart/run (T-947). This is the
  // "run without queue" path — separate from the execute() prop which takes
  // a queue-item id. The gate returns 200 { status:'deferred', liveSessions }
  // when live interactive sessions are OS children of the server (T-880).
  const handleRestartExecute = useCallback(async () => {
    const cur = restartRowState.execStatus;
    // Component-local half of the guard: covers the double-click inside THIS
    // panel instance and nothing else.
    if (hasRestartRequest || cur === 'executing' || cur === 'restarting' || cur === 'unverified') return;
    // T-1296: the half that survives a second tab, a page reload and the server
    // process being replaced mid-restart. Read at click time — a render that
    // predates another tab's request would otherwise still expose the button.
    if (restartCooldownRemainingMs() > 0) {
      setCooldownMs(restartCooldownRemainingMs());
      return;
    }

    setRestartRowState({ execStatus: 'executing', errorMsg: '', sessionCount: null, liveSessions: [] });

    let expectedServerBuildId: string;
    try {
      expectedServerBuildId = await readExpectedPreviewServerBuildId();
    } catch {
      setRestartRowState({
        execStatus: 'failed',
        errorMsg: t('pendingActions.errorPreviewIdentity'),
        sessionCount: null,
        liveSessions: [],
      });
      return;
    }
    const outcome = await runActionByType(
      'safe-restart',
      'restart-required-banner',
      expectedServerBuildId,
    );

    if (outcome.status === 'restarting') {
      setRestartRowState({ execStatus: 'restarting', errorMsg: '', sessionCount: null, liveSessions: [] });
      publishRestartSignal('triggered');
      pollUntilRestarted(expectedServerBuildId);
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
    if (
      RECONCILABLE_RESTART_ERRORS.has(outcome.code)
      && await waitForExpectedServerBuildLoaded(expectedServerBuildId)
    ) {
      setRestartRowState({ execStatus: 'unverified', errorMsg: t('pendingActions.loadedOutcomeUnverified'), sessionCount: null, liveSessions: [] });
      return;
    }
    setRestartRowState({
      execStatus: ['outcome_unverified', 'execution_unresolved'].includes(outcome.code) ? 'unverified' : 'failed',
      errorMsg: t(`pendingActions.${resolveErrorKey(outcome.code)}`),
      sessionCount: null,
      liveSessions: [],
    });
  }, [hasRestartRequest, restartRowState.execStatus, pollUntilRestarted, t]);

  // ----- T-1677: force-restart — bypasses deferred gate by confirming kill ---
  // First call: POST /api/system/actions/force-restart/run → restarting | confirm_required | error.
  // Confirm call: same endpoint with { confirmKillSessions: true, confirmedSessionCount: N }.
  // If confirm_required arrives again (count changed mid-dialog), re-show the dialog.
  const handleForceRestart = useCallback(
    async (confirmOpts?: { killSessions: true; confirmedSessionCount: number }) => {
      if (forceRestartStatus === 'executing' || forceRestartStatus === 'restarting') return;

      setForceRestartStatus('executing');
      setForceRestartError('');
      setForceConfirm(null);

      // force-restart is generation-bound like safe-restart: the server refuses
      // to enqueue it without the candidate visible at click time (B-1023).
      // Prefer the candidate already queued by the coordinator (server-validated
      // at enqueue time): when dist-server was promoted directly, the strict
      // preview identity below fails on purpose (B-1334) while the queued row is
      // still the exact generation the owner is being asked to load (B-1026).
      const queued = actions.find(
        (action) => (action.actionType === 'safe-restart' || action.actionType === 'force-restart')
          && typeof action.expectedServerBuildId === 'string'
          && /^[a-f0-9]{64}$/.test(action.expectedServerBuildId),
      );
      let expectedServerBuildId: string;
      if (queued?.expectedServerBuildId) {
        expectedServerBuildId = queued.expectedServerBuildId;
      } else {
        try {
          expectedServerBuildId = await readExpectedPreviewServerBuildId();
        } catch {
          setForceRestartStatus('failed');
          setForceRestartError(t('pendingActions.errorPreviewIdentity'));
          return;
        }
      }

      const body = confirmOpts
        ? {
            confirmKillSessions: true as const,
            confirmedSessionCount: confirmOpts.confirmedSessionCount,
            reason: 'force-restart-confirmed',
            expectedServerBuildId,
          }
        : { reason: 'force-restart-requested', expectedServerBuildId };

      const outcome = await runForceRestart(body);

      if (outcome.status === 'restarting') {
        setForceRestartStatus('restarting');
        publishRestartSignal('triggered');
        pollUntilRestarted(expectedServerBuildId);
        return;
      }
      if (outcome.status === 'confirm_required') {
        // Count may have changed from the last shown dialog — always update.
        setForceRestartStatus('idle');
        setForceConfirm({
          sessionCount: outcome.sessionCount,
          liveSessions: outcome.liveSessions,
          reasonCode: outcome.reasonCode,
          liveCount: outcome.liveCount,
          detail: outcome.detail,
        });
        return;
      }
      // Error
      setForceRestartStatus('failed');
      setForceRestartError(t(`pendingActions.${resolveErrorKey(outcome.code)}`));
    },
    [actions, forceRestartStatus, pollUntilRestarted, t],
  );

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

  // T-1296: نافذة التهدئة فعّالة — الزرّ يُستبدل بعدّاد يقول «طُلبت للتوّ»، لأن
  // زرّاً معروضاً بعد طلب ناجح دعوةٌ صريحة لإعادة تشغيل ثانية مهدورة.
  const restartCooldownActive = cooldownMs > 0;
  const cooldownSeconds = Math.ceil(cooldownMs / 1000);

  const rawCount = rawCommands.length;
  const totalCount = (restartRequired ? 1 : 0) + countPendingServerActions(actions) + rawCount;
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

        {/* T-1684 — tabs: what still waits vs. what already happened. */}
        <div
          role="tablist"
          aria-label={t('pendingActions.title')}
          className="flex gap-1 border-b border-border px-3"
          onKeyDown={event => {
            // Two tabs only, so either arrow simply moves to the other one —
            // which also spares the handler from having to mirror for RTL.
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next: PanelTab = event.key === 'Home' ? 'queue'
              : event.key === 'End' ? 'history'
                : activeTab === 'queue' ? 'history' : 'queue';
            setActiveTab(next);
            document.getElementById(`pap-tab-${next}`)?.focus();
          }}
        >
          {([
            { key: 'queue' as const, label: 'pendingActions.tabQueue', count: totalCount },
            { key: 'history' as const, label: 'pendingActions.tabHistory', count: historyEntries.length },
          ]).map(tab => (
            <button
              key={tab.key}
              id={`pap-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`pap-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              onClick={() => setActiveTab(tab.key)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                activeTab === tab.key
                  ? 'border-amber-500 text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(tab.label)}
              {tab.count > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-bold text-muted-foreground">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Global restarting / success banner */}
        {globalRestarting && !restartSuccess && (
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-5 py-3 text-sm text-amber-700 dark:bg-amber-900/15 dark:text-amber-300">
            <RefreshCw className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden="true" />
            <span>{t('pendingActions.restarting')}</span>
          </div>
        )}
        {restartSuccess && (
          <div className="flex items-center gap-2 border-b border-border bg-muted px-5 py-3 text-sm text-muted-foreground">
            <Clock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>{t('pendingActions.outcomeUnverified')}</span>
          </div>
        )}

        {/* Body: scrollable list */}
        <div
          id={`pap-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`pap-tab-${activeTab}`}
          tabIndex={0}
          className="flex-1 overflow-y-auto focus-visible:outline-none"
        >
          {activeTab === 'history' ? (
            <HistoryTab
              entries={historyEntries}
              isOwner={isOwner}
              now={now}
              cooldownActive={restartCooldownActive}
              cooldownSeconds={cooldownSeconds}
              busyId={historyBusyId}
              onRetry={entry => void handleHistoryRetry(entry)}
              onRemove={entry => void handleHistoryRemove(entry)}
              t={t}
            />
          ) : (
          <>
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
                <p className="text-sm font-medium text-warning">
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
                      {restartRowState.sessionCount !== null
                        ? t('pendingActions.deferredSessionsCount', { count: restartRowState.sessionCount })
                        : t('pendingActions.deferredLiveWork')}
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

                {restartRowState.execStatus === 'unverified' && (
                  <p role="status" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {restartRowState.errorMsg}
                  </p>
                )}
                {/* Explicit error */}
                {restartRowState.execStatus === 'failed' && restartRowState.errorMsg && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {restartRowState.errorMsg}
                  </p>
                )}

                {/* Success (server restarted before WS reconnect confirmed it) */}
                {restartRowState.execStatus === 'success' && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-success">
                    <CheckCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {t('restart.success')}
                  </p>
                )}

                {/* Action buttons */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/* Execute button: owner + idle + outside the cooldown window */}
                  {isOwner && !hasRestartRequest && restartRowState.execStatus === 'idle' && !restartCooldownActive && (
                    <Button
                      className="h-7 bg-amber-600 px-3 text-xs text-white hover:bg-amber-700"
                      onClick={() => void handleRestartExecute()}
                    >
                      {t('pendingActions.execute')}
                    </Button>
                  )}

                  {/* T-1296: cooldown notice — replaces every restart trigger,
                      including a retry, while a request is still landing. */}
                  {isOwner
                    && restartCooldownActive
                    && restartRowState.execStatus !== 'executing'
                    && restartRowState.execStatus !== 'restarting'
                    && restartRowState.execStatus !== 'success' && (
                    <p
                      className="flex items-center gap-1 text-xs text-muted-foreground"
                      role="status"
                    >
                      <Clock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                      {t('pendingActions.restartCooldown', { seconds: cooldownSeconds })}
                    </p>
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
                  {isOwner && !hasRestartRequest && !restartCooldownActive && (restartRowState.execStatus === 'deferred' || restartRowState.execStatus === 'failed') && (
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

          {/* T-1677: force-restart lives OUTSIDE the restartRequired row so it is
              available whenever a restart command is queued, even when the loaded
              server already matches disk (owner decision 2026-09-10). */}
          {hasRestartRequest && (
            <div className="border-b border-border px-5 py-3">
            {/* T-1677: force-restart — owner only, destructive, not during any restart,
                and ONLY while a restart command is actually queued (owner decision 2026-09-10). */}
            {isOwner
              && hasRestartRequest
              && restartRowState.execStatus !== 'executing'
              && restartRowState.execStatus !== 'restarting'
              && forceRestartStatus !== 'executing'
              && forceRestartStatus !== 'restarting' && (
              <div className="mt-2 border-t border-red-200/60 pt-2.5 dark:border-red-900/40">
                <p className="mb-1.5 text-[11px] text-muted-foreground">
                  {t('pendingActions.forceRestartDesc')}
                </p>
                {forceRestartStatus === 'failed' && forceRestartError && (
                  <p className="mb-1.5 flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {forceRestartError}
                  </p>
                )}
                <Button
                  className="h-7 bg-red-700 px-3 text-xs text-white hover:bg-red-800"
                  onClick={() => void handleForceRestart()}
                >
                  {t('pendingActions.forceRestartButton')}
                </Button>
              </div>
            )}
            </div>
          )}

          {/* Empty state */}
          {!restartRequired && !loading && queueActions.length === 0 && rawCount === 0 && (
            <div className="flex items-center justify-center px-5 py-10 text-sm text-muted-foreground">
              {t('pendingActions.empty')}
            </div>
          )}

          {/* Loading state (first load, no items yet) */}
          {loading && queueActions.length === 0 && rawCount === 0 && !restartRequired && (
            <div className="flex items-center justify-center px-5 py-10">
              <Loader2
                className="h-5 w-5 animate-spin text-muted-foreground"
                aria-label={t('sessions.loading')}
              />
            </div>
          )}

          {/* Action list — T-1684: settled rows live in the history tab, except
              a receipt for a click made while this panel has been open. */}
          {queueActions.map(action => {
            const durable = action.currentActionOutcome;
            const localState = itemStateScope === accountScope ? itemStates[action.id] ?? defaultItemState() : defaultItemState();
            const state: ItemState = durable && localState.execStatus !== 'executing'
              ? { ...localState,
                execStatus: durable.status === 'success' ? 'success'
                  : durable.status === 'failure' ? 'failed'
                    : durable.status === 'unknown' ? 'unverified'
                      : durable.retryable && localState.execStatus === 'unverified'
                        ? (['live_work', 'live_sessions'].includes(durable.reasonCode) ? 'deferred' : 'idle') : localState.execStatus,
                errorMsg: durable.status === 'success' ? '' : t(`pendingActions.${
                  durable.status === 'failure' && durable.reasonCode === 'superseded'
                    ? 'superseded' : resolveErrorKey(durable.reasonCode)}`),
                errorCode: durable.reasonCode }
              : localState;
            const { execStatus } = state;
            const isExecuting = execStatus !== 'success' && (
              ((!durable || durable.status === 'pending') && action.status === 'executing')
              || execStatus === 'executing' || execStatus === 'restarting'
            );
            const preparationBlocked = isRestartPreparationBlocked(action.actionType, state.errorCode ?? action.reasonCode ?? action.error);
            const removableSuperseded = isSupersededAction(action) && !isExecuting;
            const blocked = isExecuting || (action.retryable === false && !preparationBlocked)
              || action.reasonCode === 'execution_unresolved' || execStatus === 'unverified' || execStatus === 'success';
            const isUnverified = execStatus === 'unverified' || (durable?.status !== 'failure' && durable?.status !== 'success' && action.reasonCode === 'execution_unresolved');
            const isFailed = execStatus !== 'success' && !isUnverified && (execStatus === 'failed' || action.status === 'failed');
            const isDeferred = execStatus !== 'success' && (execStatus === 'deferred' || ['live_work', 'live_sessions'].includes(action.reasonCode ?? ''));
            const isSuccess = execStatus === 'success';
            // T-1296: a queued safe-restart row triggers the same restart as the
            // static row, so it shares the same window.
            const cooldownBlocked =
              restartCooldownActive && COOLDOWN_ACTION_TYPES.has(action.actionType);

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

                {isUnverified && (
                  <p role="status" className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {verificationDelayed ? t('pendingActions.verificationDelayed')
                      : state.errorMsg === t('pendingActions.loadedOutcomeUnverified') ? state.errorMsg : t('pendingActions.outcomeUnverified')}
                  </p>
                )}
                {/* Only an explicit failure receives error styling. */}
                {isFailed && (
                  <p className="mb-2 flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    {state.errorMsg || (action.reasonCode === 'execution_unresolved'
                      ? t('pendingActions.outcomeUnverified')
                      : t(`pendingActions.${resolveErrorKey(action.reasonCode ?? action.error ?? '')}`))}
                  </p>
                )}

                {/* Success message */}
                {isSuccess && (
                  <p className="mb-2 flex items-center gap-1 text-xs text-success">
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
                  {isOwner && execStatus === 'idle' && !isDeferred && !isFailed && !blocked && !preparationBlocked && !cooldownBlocked && (
                    <Button
                      className="h-7 bg-amber-600 px-3 text-xs text-white hover:bg-amber-700"
                      onClick={() => void handleExecute(action)}
                    >
                      {t('pendingActions.execute')}
                    </Button>
                  )}

                  {/* T-1296 cooldown notice for a queued restart row */}
                  {isOwner && cooldownBlocked && !isExecuting && !isSuccess && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
                      <Clock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                      {t('pendingActions.restartCooldown', { seconds: cooldownSeconds })}
                    </p>
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
                  {isOwner && !blocked && !preparationBlocked && !cooldownBlocked && (isDeferred || isFailed) && (
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
                      disabled={blocked && !removableSuperseded}
                    >
                      {t(removableSuperseded ? 'pendingActions.removeFromPanel' : 'pendingActions.dismiss')}
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
          </>
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
      // T-1684 — the result is not kept in this component. Closing the reviewer
      // re-reads /pending, and the run appears in the history tab with the
      // server's own exit code and output tails.
      onClose={() => { setExecTarget(null); void refreshActions?.(); }}
      onComplete={() => onRawQueueChange?.()}
    />
    {/* T-1677 — force-restart confirmation dialog (own portal at z-[60]) */}
    <ForceRestartConfirmDialog
      confirm={forceConfirm}
      onClose={() => setForceConfirm(null)}
      onConfirm={(count) => void handleForceRestart({ killSessions: true, confirmedSessionCount: count })}
      t={t}
      lang={i18n.language ?? 'ar'}
    />
    </>
  );

  return ReactDOM.createPortal(panel, document.body);
}

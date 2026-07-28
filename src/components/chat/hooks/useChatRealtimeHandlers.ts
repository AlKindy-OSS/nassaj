import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { MAX_CONTROL_FRAMES, type ControlFrameMap } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound } from '../../../utils/notificationSound';
import type { PendingPermissionRequest, SessionNavigationOptions } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

import {
  consumePendingEngineStamp,
  readSessionEngineProvider,
  stampSessionEngineProvider,
} from './useChatProviderState';
import { bumpSessionActivityEpoch, readIsProcessing } from './sessionActivity';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  [key: string]: any;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  /**
   * الشريحة التراكمية لإطارات التحكّم (`session-status`) من WebSocketContext.
   * تُستهلك بالتسلسل لا بمقارنة المرجع، فلا يبتلع إطارٌ إطاراً في نفس دفعة
   * الـrender. اختيارية كي تبقى الاستدعاءات القديمة/الاختبارات صالحة.
   */
  controlFrames?: ControlFrameMap;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string, options?: SessionNavigationOptions) => void;
  onWebSocketReconnect?: () => void;
  /** Called when the server sends an error event with a recognised error code. */
  onServerError?: (message: string) => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/** Map known server error codes to i18n keys in the 'chat' namespace. */
export const SERVER_ERROR_CODE_KEYS: Record<string, string> = {
  project_dir_missing: 'serverError.project_dir_missing',
  cli_not_installed: 'serverError.cli_not_installed',
  spawn_failed: 'serverError.spawn_failed',
  session_create_failed: 'serverError.session_create_failed',
};

/**
 * Resolve a human, localised message from a server error event (T-83).
 *
 * The error can arrive in several shapes and we degrade gracefully through them:
 *   1. A structured `{ error: { code, messageKey, detail } }` object emitted by
 *      the session channel — `messageKey` is a ready i18n key (chat namespace),
 *      `code` maps via SERVER_ERROR_CODE_KEYS.
 *   2. A flat top-level `code` (legacy error events).
 *   3. Nothing recognisable → the generic `serverError.unknown` fallback.
 *
 * `detail` is appended (parenthesised) when present so the user sees the raw
 * server reason without it ever replacing the translated headline.
 */
export function resolveServerErrorMessage(
  msg: { code?: unknown; error?: unknown; reason?: unknown },
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const fallback = t('serverError.unknown');
  const structured =
    msg.error && typeof msg.error === 'object' ? (msg.error as Record<string, unknown>) : null;

  const messageKey =
    structured && typeof structured.messageKey === 'string' ? structured.messageKey : null;
  const code =
    (structured && typeof structured.code === 'string' && structured.code)
    || (typeof msg.code === 'string' && msg.code)
    || null;
  const detail =
    (structured && typeof structured.detail === 'string' && structured.detail)
    || (typeof msg.reason === 'string' && msg.reason)
    || null;

  let headline = fallback;
  if (messageKey) {
    headline = t(messageKey, { defaultValue: fallback });
  } else if (code) {
    const i18nKey = SERVER_ERROR_CODE_KEYS[code] ?? null;
    headline = i18nKey ? t(i18nKey, { defaultValue: fallback }) : fallback;
  }

  return detail ? `${headline} (${detail})` : headline;
}

export function useChatRealtimeHandlers({
  latestMessage,
  controlFrames,
  provider,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  streamTimerRef,
  accumulatedStreamRef,
  onSessionInactive,
  onSessionActive,
  onSessionProcessing,
  onSessionNotProcessing,
  onNavigateToSession,
  onWebSocketReconnect,
  onServerError,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const paletteOps = usePaletteOps();
  const { t } = useTranslation('chat');
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);
  /** أعلى `seq` عولج لكل جلسة من شريحة إطارات التحكّم. */
  const processedControlSeqRef = useRef<Map<string, number>>(new Map());
  /**
   * خطّ الأساس: أعلى `seq` كان موجوداً في الشريحة **لحظة أول تشغيل** لهذا
   * المستهلك. كل ما دونه سابقٌ لتركيبه ⇒ يُتجاهل.
   *
   * لماذا (مراجعة qa-critic، حرج 2): المزوّد يعيش في جذر التطبيق والشريحة
   * تراكمية تبقى عبر التركيبات، بينما `ChatInterface` يُفكَّك ويُعاد تركيبه
   * (تبويب Terminal، ‏`!selectedProject`) فيُصفَّر سجلّ ما عولج. بلا خطّ أساس:
   * جلسة فُتحت خاملة (إطار `isProcessing:false`) ثم صارت حيّة بإرسال المستخدم
   * (بلا إطار جديد لأن المخزن دافئ) ⇒ العودة من Terminal تُعيد تطبيق الإطار
   * البائت ⇒ `setIsLoading(false)` وسط تشغيل حيّ ⇒ تختفي البطاقة وزر STOP بلا
   * تعافٍ (الإعادة نفسها ترفع الـepoch فتعود اللقطة `'stale'`).
   *
   * `null` = لم يُشغَّل التأثير بعد.
   */
  const controlBaselineSeqRef = useRef<number | null>(null);

  /* ---------------------------------------------------------------- */
  /*  إطارات التحكّم: session-status                                    */
  /* ---------------------------------------------------------------- */

  /**
   * تطبيق إطار `session-status` واحد.
   *
   * كان هذا فرعاً داخل مُبدِّل `latestMessage`؛ نُقل إلى هنا لأن الإطار صار
   * يصل عبر الشريحة التراكمية `controlFrames` (فتحة `latestMessage` كانت تبتلعه
   * حين يليه بثّ حيّ في نفس المللي‑ثانية — B-208). المنطق نفسه حرفياً عدا
   * تصريح الترميز ورفع الـepoch.
   */
  const applySessionStatusFrame = useCallback((frame: LatestChatMessage) => {
    const statusSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
    if (!statusSessionId) return;

    // حدث سُلطوي على حالة التشغيل: أي لقطة REST أُطلقت قبله تُهمَل عند عودتها.
    bumpSessionActivityEpoch(statusSessionId);

    const status = frame.status;
    if (status) {
      const statusInfo = {
        text: status.text || 'Working...',
        tokens: status.tokens || 0,
        can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
      };
      setClaudeStatus(statusInfo);
      setIsLoading(true);
      setCanAbortSession(statusInfo.can_interrupt);
      return;
    }

    const isCurrentSession =
      statusSessionId === currentSessionId
      || Boolean(selectedSession && statusSessionId === selectedSession.id);

    // ترميز الحقيقة: **غياب `isProcessing` = غير نشطة**. لا «امسح فقط عند
    // false صريح» — كان سيُبقي مؤشّراً عالقاً للأبد على أي حمولة بلا الحقل.
    if (readIsProcessing(frame)) {
      onSessionActive?.(statusSessionId);
      onSessionProcessing?.(statusSessionId);
      if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
      return;
    }

    onSessionInactive?.(statusSessionId);
    onSessionNotProcessing?.(statusSessionId);
    if (isCurrentSession) {
      setIsLoading(false);
      setCanAbortSession(false);
      setClaudeStatus(null);
    }
  }, [
    currentSessionId,
    onSessionActive,
    onSessionInactive,
    onSessionNotProcessing,
    onSessionProcessing,
    selectedSession,
    setCanAbortSession,
    setClaudeStatus,
    setIsLoading,
  ]);

  useEffect(() => {
    if (!controlFrames) return;

    // أول تشغيل: ثبّت خطّ الأساس على أعلى `seq` موجود ولا تُطبّق شيئاً منه.
    // اللقطة الحتمية عبر REST هي مصدر حالة الفتح، لا إطار سابق لعمر المكوّن.
    if (controlBaselineSeqRef.current === null) {
      let highest = 0;
      for (const [, entry] of controlFrames) {
        if (entry.seq > highest) highest = entry.seq;
      }
      controlBaselineSeqRef.current = highest;
      return;
    }

    if (controlFrames.size === 0) return;
    const baseline = controlBaselineSeqRef.current;
    const processed = processedControlSeqRef.current;
    for (const [sessionId, entry] of controlFrames) {
      if (entry.seq <= baseline) continue; // سابق لتركيب هذا المستهلك
      if ((processed.get(sessionId) ?? 0) >= entry.seq) continue;
      processed.set(sessionId, entry.seq);
      applySessionStatusFrame(entry.frame);
    }

    // سقف مطابق لتقليم الشريحة نفسها: لا تنمو خريطة «ما عولج» بلا حدّ.
    if (processed.size > MAX_CONTROL_FRAMES) {
      const bySeqAsc = [...processed.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of bySeqAsc.slice(0, processed.size - MAX_CONTROL_FRAMES)) {
        processed.delete(key);
      }
    }
  }, [controlFrames, applySessionStatusFrame]);

  useEffect(() => {
    if (!latestMessage) return;
    if (lastProcessedMessageRef.current === latestMessage) return;
    lastProcessedMessageRef.current = latestMessage;

    const activeViewSessionId =
      selectedSession?.id || currentSessionId || null;

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field) — handle and return           */
    /* ---------------------------------------------------------------- */

    const msg = latestMessage as any;

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          setPendingPermissionRequests(msg.data || []);
          return;
        }

        // ملحوظة: `session-status` لم يعد يمرّ من هنا — يُوجَّه في
        // WebSocketContext إلى الشريحة التراكمية `controlFrames` ويُعالَج في
        // `applySessionStatusFrame` أعلاه (B-208). لا فرع له هنا عمداً كي لا
        // يوجد مساران للمنطق نفسه ولا احتمال معالجة مزدوجة.

        default:
          // Unknown legacy message type — ignore
          return;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const sid = msg.sessionId || activeViewSessionId;
    // ADR-041 (B-80): record the highest server-stamped stream `sequence` for any
    // normalized payload that carries one, so `lastSeq` in check-session-status is
    // an exact floor across all kinds (stream_delta, tool_use, complete, status…).
    // appendRealtime also records it for persisted kinds, but stream_delta on the
    // active view and the non-persisted control kinds bypass appendRealtime, so we
    // cover them here. No-op when `sequence` is absent (registry flag off / legacy).
    if (sid) {
      sessionStore.recordSeq(sid, (msg as NormalizedMessage).sequence);
    }
    // True only when the event belongs to the session currently on screen.
    // Mirror events for background sessions must NOT mutate the active view
    // (spinner, status text, pending permission prompts). When a payload has no
    // sessionId we fall back to the active id (sid === activeViewSessionId), so
    // such legacy/global events apply to the current view — the safe default.
    const isActiveViewSession = !sid || sid === activeViewSessionId;

    // Coordinator/origin attribution stamped by the server on every assistant
    // payload of this run (incl. stream_delta). Carried onto the streaming row so
    // attribution is correct *while* streaming, not only after finalize (B-43).
    const streamAttribution = {
      coordinatorId: (msg as NormalizedMessage).coordinatorId,
      originKind: (msg as NormalizedMessage).originKind,
    };

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text) return;
      // (seq recorded at the top of this block for all kinds; ADR-041 B-80.)
      accumulatedStreamRef.current += text;
      if (!streamTimerRef.current) {
        streamTimerRef.current = window.setTimeout(() => {
          streamTimerRef.current = null;
          if (sid) {
            sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider, streamAttribution);
          }
        }, 100);
      }
      // Also route to store for non-active sessions
      if (sid && sid !== activeViewSessionId) {
        sessionStore.appendRealtime(sid, msg as NormalizedMessage);
      }
      return;
    }

    if (msg.kind === 'stream_end') {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      if (sid) {
        if (accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider, streamAttribution);
        }
        sessionStore.finalizeStreaming(sid);
      }
      accumulatedStreamRef.current = '';
      return;
    }

    // --- workflow_reconciled (B-94 / C4): synthetic reconcile card -----------
    // TODO(ADR-048 phase-2): no server emitter yet — REST reconcile is the active
    // path. This branch is dead today (nothing on the backend broadcasts a
    // `workflow_reconciled` WS event); it is kept, hardened, and documented so a
    // future server emitter can light it up without another client change. When
    // revived, it would fire when the server discovers a workflow that completed
    // after the parent session was already marked stopped, synthesizing a
    // task_reconcile row injected via appendRealtime so useChatMessages can
    // replace the stale stopped card.
    if (msg.kind === 'workflow_reconciled') {
      const wfId = msg.wfId || msg.workflowId;
      // wfId is mandatory: the reconcile pass keys replacement off it, and a
      // stable id (not Date.now()) is required so a re-delivered event dedupes by
      // id instead of stacking a second card. Ignore the event without one.
      if (sid && wfId) {
        const reconcileRow: NormalizedMessage = {
          id: `reconcile-${wfId}`,
          sessionId: sid,
          timestamp: msg.timestamp || new Date().toISOString(),
          provider: msg.provider || provider,
          kind: 'task_reconcile',
          wfId,
          agentsDone: typeof msg.agentsDone === 'number' ? msg.agentsDone : undefined,
          agentsTotal: typeof msg.agentsTotal === 'number' ? msg.agentsTotal : undefined,
          summary: msg.summary,
          // C5: carry the terminal outcome ('completed' | 'settled') so the card
          // renders the right copy; default to 'completed' when absent.
          taskStatus: msg.taskStatus === 'settled' ? 'settled' : 'completed',
        };
        sessionStore.appendRealtime(sid, reconcileRow);
      }
      return;
    }

    // --- All other messages: route to store ---
    const shouldPersist =
      msg.kind !== 'session_created'
      && msg.kind !== 'complete'
      && msg.kind !== 'status'
      && msg.kind !== 'permission_request'
      && msg.kind !== 'permission_cancelled';

    if (sid && shouldPersist) {
      sessionStore.appendRealtime(sid, msg as NormalizedMessage);
    }

    // --- UI side effects for specific kinds ---
    switch (msg.kind) {
      case 'session_created': {
        const newSessionId = msg.newSessionId;
        if (!newSessionId) {
          // sessionId=null means the provider failed to mint a session. This
          // used to break silently, leaving the user on a dead, spinning view.
          // Clear the active-view spinner and surface the failure (T-83). The
          // event may carry a structured `{ error }` / flat code; otherwise we
          // show the session-create fallback.
          if (isActiveViewSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
            pendingViewSessionRef.current = null;
            const hasErrorInfo =
              (msg.error && typeof msg.error === 'object') || typeof msg.code === 'string';
            const message = hasErrorInfo
              ? resolveServerErrorMessage(msg, t)
              : t('serverError.session_create_failed', {
                defaultValue: t('serverError.unknown'),
              });
            onServerError?.(message);
          }
          break;
        }

        // We no longer synthesize client-side placeholder IDs. Until the provider
        // announces `session_created`, the active id is expected to be null.
        if (!currentSessionId) {
          console.log('Session created with ID:', newSessionId);
          console.log('Existing session ID:', currentSessionId);
          // T-915 (privacy fix, qa-critic correction): stamp the engine provider
          // (ADR-037) from the PENDING SLOT written by dispatchProviderCommand
          // at send-time, NOT from the global localStorage key.  The global key
          // diverges from React state when the user opens an older session
          // (React→null) without touching the picker, while the global still
          // holds a vendor id from a previous "Claude via Kimi" selection.
          // consumePendingEngineStamp() reads exactly what was sent and clears
          // the slot, so every session_created event sees the right value.
          // Only meaningful for claude; other providers never write the stamp.
          if (provider === 'claude') {
            stampSessionEngineProvider(newSessionId, consumePendingEngineStamp());
          }
          setCurrentSessionId(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
          );
        } else if (newSessionId !== currentSessionId) {
          // Stale-resume fallback: the backend could not resume the active
          // session and minted a fresh one. `session_created` never fires for a
          // healthy resume, so a mismatch here means the old id is dead — migrate
          // the view (messages, pending permissions) onto the new conversation.
          console.log('Session reset: replacing', currentSessionId, 'with', newSessionId);
          sessionStore.replaceSessionId(currentSessionId, newSessionId);
          sessionStorage.setItem('pendingSessionId', newSessionId);
          if (pendingViewSessionRef.current) {
            pendingViewSessionRef.current.sessionId = newSessionId;
          }
          // T-915 (B-ENG continuity): a stale-resume mint means the backend
          // couldn't find the old session. The pending stamp was NOT written
          // for a resume (writePendingEngineStamp runs only for new conversations).
          // Preserve B-ENG continuity by copying the OLD session's engine stamp
          // onto the replacement so a vendor-routed conversation keeps routing
          // through the same vendor. No-op for official-Anthropic sessions (null).
          if (provider === 'claude') {
            stampSessionEngineProvider(newSessionId, readSessionEngineProvider(currentSessionId));
          }
          setCurrentSessionId(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => ({ ...r, sessionId: newSessionId })),
          );
          onNavigateToSession?.(newSessionId, { replace: true });
          break;
        }
        pendingViewSessionRef.current = null;
        onSessionActive?.(newSessionId);
        onSessionProcessing?.(newSessionId);
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({
          text: 'Processing',
          tokens: 0,
          can_interrupt: true,
        });
        onNavigateToSession?.(newSessionId);
        break;
      }

      case 'complete': {
        // Flush any remaining streaming state
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        if (sid && accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider, streamAttribution);
          sessionStore.finalizeStreaming(sid);
        }
        accumulatedStreamRef.current = '';

        // When Workflow tool calls were issued, the assistant turn ended but
        // background work is still running. Keep the spinner alive until the
        // next turn arrives (which will re-enter the loading state naturally).
        const hasPendingWorkflows =
          typeof msg.pendingWorkflows === 'number' && msg.pendingWorkflows > 0;

        // حدث سُلطوي: يُبطل أي لقطة REST لحالة النشاط أُطلقت قبله، فلا تعيد
        // إجابةُ «نشطة» متأخرةٌ رفعَ المؤشّر بعد انتهاء التشغيل فعلياً.
        bumpSessionActivityEpoch(sid);

        // Session-list / global concerns: keyed by sid, safe for any session.
        onSessionInactive?.(sid);
        if (!hasPendingWorkflows) {
          onSessionNotProcessing?.(sid);
        }

        // View mutations: only when this event is for the session on screen.
        // A background session completing must not clear the active view's
        // spinner, status, or pending permission prompts.
        if (isActiveViewSession) {
          if (hasPendingWorkflows) {
            // Keep isLoading true — background Workflow still running.
            setClaudeStatus({ text: 'Workflow يعمل في الخلفية…', tokens: 0, can_interrupt: true });
          } else {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
            setPendingPermissionRequests([]);
            pendingViewSessionRef.current = null;
          }
        }

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it. The loading
          // state was already cleared above. If the server could NOT honour the
          // abort (no matching/active session), surface why instead of leaving
          // the user thinking STOP silently failed.
          if (msg.success === false || msg.abortFailed) {
            const reason =
              typeof msg.error === 'string' && msg.error.trim().length > 0
                ? msg.error
                : 'Could not stop the run (no active session matched).';
            onServerError?.(reason);
          }
          break;
        }

        if (hasPendingWorkflows) break;

        showCompletionTitleIndicator();
        void playChatCompletionSound();

        const actualSessionId =
          typeof msg.actualSessionId === 'string' && msg.actualSessionId.trim().length > 0
            ? msg.actualSessionId
            : null;
        const isVisibleSession =
          Boolean(
            sid
            && sid === activeViewSessionId,
          );

        if (actualSessionId && sid && actualSessionId !== sid) {
          sessionStore.replaceSessionId(sid, actualSessionId);

          if (isVisibleSession) {
            setCurrentSessionId(actualSessionId);
          }

          if (isVisibleSession) {
            onNavigateToSession?.(actualSessionId, { replace: true });
            setTimeout(() => { void paletteOps.refreshProjects(); }, 500);
          }
          break;
        }

        break;
      }

      case 'error': {
        // حدث سُلطوي (كما في 'complete'): يُبطل اللقطات المتأخرة.
        bumpSessionActivityEpoch(sid);

        // Session-list / global concerns: keyed by sid, safe for any session.
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);

        // View mutations only for the session on screen.
        if (isActiveViewSession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          pendingViewSessionRef.current = null;

          // Surface a human-readable, localised message via onServerError for
          // any error event — structured `{ error: {...} }`, a flat code, or an
          // unrecognised failure (general fallback). Previously this fired only
          // when a known top-level `code` was present, so structured new-session
          // failures and unknown errors failed silently (T-83).
          onServerError?.(resolveServerErrorMessage(msg, t));
        }
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        // A permission request for a background session must not pop into the
        // active view or hijack its spinner/status.
        if (!isActiveViewSession) break;
        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === msg.requestId)) return prev;
          return [...prev, {
            requestId: msg.requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            sessionId: sid || null,
            receivedAt: new Date(),
          }];
        });
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        break;
      }

      case 'permission_cancelled': {
        // Pending prompts only ever belong to the active view, but gate anyway
        // so a background cancellation can never touch the on-screen list.
        if (isActiveViewSession && msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
        }
        break;
      }

      case 'status': {
        if (msg.text === 'process_state') {
          // Frozen-session indicator: consumed globally (AppContent →
          // sessionProcessStateStore). Never treat it as a spinner status.
          break;
        }
        // Status text / token budget are active-view concerns: a background
        // session's status must not overwrite the on-screen status line.
        if (!isActiveViewSession) break;
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text) {
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
      default:
        break;
    }
  }, [
    latestMessage,
    provider,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamTimerRef,
    accumulatedStreamRef,
    onSessionInactive,
    onSessionActive,
    onSessionProcessing,
    onSessionNotProcessing,
    onNavigateToSession,
    onWebSocketReconnect,
    onServerError,
    sessionStore,
    paletteOps,
    t,
  ]);
}

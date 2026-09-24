import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { readServerErrorCode, resolveServerErrorMessage } from '../utils/serverErrorMessage';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import {
  MAX_CONTROL_FRAMES,
  type ControlEventLog,
  type ControlFrameMap,
} from '../../../contexts/WebSocketContext';
import {
  pruneProcessedStreamSeqs,
  type StreamFrameMap,
} from '../../../contexts/streamFrameLog';
import { playChatCompletionSound, playChatErrorSound } from '../../../utils/notificationSound';
import type { PendingPermissionRequest, SessionNavigationOptions } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import { canAutomaticallyReadHistory, type SessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { confirmOutboxEntry, getOutboxSnapshot, removeOutboxEntry } from '../utils/messageOutbox';

import {
  consumePendingEngineStamp,
  readSessionEngineProvider,
  stampSessionEngineProvider,
} from './useChatProviderState';
import {
  bumpSessionActivityEpoch,
  readIsProcessing,
  runSessionActivityProbe,
} from './sessionActivity';

// Weak keys keep the consumed cursor only while the store owns the slot.
// A remounted consumer must not report an already applied evicted head as lost.
const consumedStreamHeads = new WeakMap<object, { seq: number; gap?: number }>();

/**
 * حارس الجلب منفصل عمداً عن وجود صفّ `stream_gap_<sessionId>` (مراجعة
 * qa-critic، فيتو): إخفاء/حذف الصفّ لا يجوز أن يُعيد فتح الجلب. مفتاحه
 * **كائن الـslot** لا الـsessionId — كـ`consumedStreamHeads` أعلاه — لأن
 * الحارس يجب أن ينجو من إعادة تركيب المستهلك (remount) طالما بقي المتجر
 * مالكاً للـslot نفسه؛ ref محلّي داخل الخطّاف كان سيُصفَّر بكل remount
 * ويُعيد الجلب. القيمة هي آخر فجوة (`droppedBeforeSeq` أو `evictionSeq`)
 * طُلب استرجاعها فعلاً.
 */
const streamGapFetchedHeads = new WeakMap<object, number>();

export { SERVER_ERROR_CODE_KEYS, readServerErrorCode, readServerErrorDetail, resolveServerErrorMessage } from '../utils/serverErrorMessage';

/** Record applied content without treating a later response as proof of an older gap. */
function recordConsumedStreamHead(slot: object, seq: number, gap?: number): void {
  const prior = consumedStreamHeads.get(slot);
  consumedStreamHeads.set(slot, { seq: Math.max(prior?.seq ?? 0, seq),
    ...((gap ?? prior?.gap) ? { gap: gap ?? prior?.gap } : {}) });
}

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
  /**
   * B-1297: معرّف رسالة العميل التي أطلقت هذه الجلسة الجديدة.
   * يُستخدم لمطابقة `session_created` المتأخر برسالتنا تحديداً، فلا
   * يُسرق التنقّل لجلسات جلبات أخرى أو تبويبات أخرى.
   */
  clientMsgId?: string | null;
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

/**
 * نصّ البثّ المتراكم لجلسة واحدة، ومعه نسبتُه (المنسّق/أصل الكلام) كما وصلت
 * مع دفعاته هو لا مع آخر دفعة وصلت للتطبيق كله.
 */
export type StreamBuffer = {
  text: string;
  attribution: { coordinatorId?: number | null; originKind?: string; model?: string };
  /** Present only when the server attests this delta belongs to a client run. */
  responseToMessageId?: string;
};

/**
 * A latency anchor is evidence only when the server has tied the event to the
 * optimistic user row that started this run.  In particular, a tool *result*
 * and session/workflow noise are not model-first-response evidence.
 */
function responseRunId(message: LatestChatMessage): string | null {
  const id = message.responseToMessageId ?? message.clientMsgId;
  return typeof id === 'string' && id.trim() ? id : null;
}

const MAX_RESPONSE_TURN_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;

/** Accept only a response metric that the server confirms was persisted. */
export function persistedTurnFromControlEvent(message: LatestChatMessage) {
  const responseToMessageId = typeof message.responseToMessageId === 'string'
    && message.responseToMessageId.trim()
    ? message.responseToMessageId
    : null;
  const metric = message.responseTurnMetric;
  const durationMs = metric?.durationMs;
  const total = message.responseTurnDurationTotalMs;
  const transcriptMessageId = typeof message.transcriptMessageId === 'string'
    && message.transcriptMessageId.trim()
    ? message.transcriptMessageId.trim()
    : undefined;
  if (
    !responseToMessageId
    || !metric
    || typeof durationMs !== 'number'
    || !Number.isSafeInteger(durationMs)
    || durationMs < 0
    || durationMs > MAX_RESPONSE_TURN_DURATION_MS
    || typeof metric.startedAt !== 'string'
    || typeof metric.completedAt !== 'string'
    || typeof total !== 'number'
    || !Number.isSafeInteger(total)
    || total < 0
    || message.aborted
    || message.success === false
  ) return null;
  // The terminal control frame is also the only safe live source for the
  // model name when a provider does not stamp every stream delta.  Preserve
  // absence: callers must never substitute the session picker/provider.
  const model = typeof message.model === 'string' && message.model.trim()
    ? message.model.trim()
    : undefined;
  return {
    responseToMessageId,
    responseTurnMetric: { durationMs, startedAt: metric.startedAt, completedAt: metric.completedAt },
    responseTurnDurationTotalMs: total,
    ...(transcriptMessageId ? { transcriptMessageId } : {}),
    ...(model ? { model } : {}),
  };
}

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  /** Reconnect counter independent of the lossy latest-message slot. */
  reconnectEpoch?: number;
  /**
   * الشريحة التراكمية لإطارات التحكّم (`session-status`) من WebSocketContext.
   * تُستهلك بالتسلسل لا بمقارنة المرجع، فلا يبتلع إطارٌ إطاراً في نفس دفعة
   * الـrender. اختيارية كي تبقى الاستدعاءات القديمة/الاختبارات صالحة.
   */
  controlFrames?: ControlFrameMap;
  /**
   * سجلّ **أحداث** التحكّم الملحَق (`complete`, `error`, `session_created`,
   * `permission_request`, `permission_cancelled`) من WebSocketContext.
   *
   * منفصل عن `controlFrames` لأن هذه أحداث لا حالات: خريطةٌ بمفتاح الجلسة كانت
   * تجمع أحداث تشغيلات مختلفة في خانة واحدة (وفي خانة `''` حين تصل الحمولة بلا
   * معرّف). اختياري كي تبقى الاستدعاءات القديمة/الاختبارات صالحة.
   */
  controlEvents?: ControlEventLog;
  /** لقطات البث المجمعة تزامنياً عند مدخل WebSocket (B-829). */
  streamFrames?: StreamFrameMap;
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
  /** مخزن البثّ لكل جلسة: نصّها ونسبتها معاً (انظر ChatInterface). */
  accumulatedStreamRef: MutableRefObject<Map<string, StreamBuffer>>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string, options?: SessionNavigationOptions) => void;
  onWebSocketReconnect?: () => void;
  /** Called when the server sends an error event with a recognised error code. */
  onServerError?: (message: string) => void;
  /**
   * B-518: نصّ رسالةٍ رفضها الخادم قبل التنفيذ، يُردّ إلى المُؤلِّف بعد سحب
   * فقاعتها المتفائلة — إعادةُ ملكية الكلام لصاحبه لا إعادةُ إرسال.
   */
  onRejectedSendRestore?: (text: string) => void;
  /**
   * استرجاع موسَّع لفجوة بثّ في الجلسة المعروضة (طابور التاريخ المُجمِّع
   * `queueHistoryWork('light400')` في `useChatSessionState`). غيابه يفعّل
   * بديلاً محلياً بتوسيع نافذة `mergeTailFromServer` (انظر
   * `requestStreamGapRecovery` أدناه).
   */
  onRequestExpandedHistory?: (sessionId: string) => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */


export function useChatRealtimeHandlers({
  latestMessage,
  reconnectEpoch,
  controlFrames,
  controlEvents,
  streamFrames,
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
  onRejectedSendRestore,
  onRequestExpandedHistory,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const paletteOps = usePaletteOps();
  const { t } = useTranslation('chat');
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);
  const processedReconnectEpochRef = useRef(reconnectEpoch);
  useEffect(() => {
    const previous = processedReconnectEpochRef.current;
    processedReconnectEpochRef.current = reconnectEpoch;
    if (previous !== undefined && reconnectEpoch !== undefined && reconnectEpoch > previous) {
      void onWebSocketReconnect?.();
    }
  }, [reconnectEpoch, onWebSocketReconnect]);

  const processedStreamSeqRef = useRef<Map<string, number>>(new Map());
  const recoveredEvictionRef = useRef<{ sessionId: string; seq: number } | null>(null);

  /**
   * مسار الاسترجاع الموسَّع لفجوة بثّ. `queueHistoryWork('light400')` (طابور
   * التاريخ المُجمِّع في `useChatSessionState`) هو المسار الأصلي — single-flight
   * وحارس رؤية وحارس `revision`. حين لا يتوفّر (لم يُمرَّر من المستدعي)، البديل
   * المقبول (مراجعة qa-critic): توسيع نافذة `mergeTailFromServer` نفسها إلى
   * `min(200, total - المحتفَظ به + هامش)` بحمولة خفيفة — بلا مساس بميزانية
   * لقطات البثّ ولا بعقد خادمي جديد.
   */
  const requestStreamGapRecovery = useCallback((sessionId: string) => {
    if (onRequestExpandedHistory) {
      onRequestExpandedHistory(sessionId);
      return;
    }
    const slot = sessionStore.getSessionSlot?.(sessionId);
    const held = slot?.serverMessages?.length ?? 0;
    const total = slot?.total ?? held;
    const margin = 20;
    const limit = Math.min(200, Math.max(20, total - held + margin));
    void sessionStore.mergeTailFromServer?.(sessionId, { limit, payload: 'light' });
  }, [onRequestExpandedHistory, sessionStore]);
  /** أعلى `seq` عولج لكل جلسة من شريحة إطارات التحكّم. */
  const processedControlSeqRef = useRef<Map<string, number>>(new Map());
  /**
   * أعلى `seq` عولج من **سجلّ الأحداث**: رقم واحد لا خريطة، لأن السجلّ ملحَق
   * بلا مفتاح — وأي مفتاح مبني على الجلسة كان سيجمع تشغيلات مختلفة في خانة
   * واحدة (وفي خانة `''` حين تصل الحمولة بلا معرّف).
   */
  const processedEventSeqRef = useRef(0);
  /**
   * خطّ الأساس: أعلى `seq` كان موجوداً في **الشريحتين معاً** لحظة أول تشغيل
   * لهذا المستهلك. كل ما دونه سابقٌ لتركيبه ⇒ يُتجاهل.
   *
   * لماذا (مراجعة qa-critic، حرج 2): المزوّد يعيش في جذر التطبيق والشريحة
   * تراكمية تبقى عبر التركيبات، بينما `ChatInterface` يُفكَّك ويُعاد تركيبه
   * (تبويب Terminal، ‏`!selectedProject`) فيُصفَّر سجلّ ما عولج. بلا خطّ أساس:
   * جلسة فُتحت خاملة (إطار `isProcessing:false`) ثم صارت حيّة بإرسال المستخدم
   * (بلا إطار جديد لأن المخزن دافئ) ⇒ العودة من Terminal تُعيد تطبيق الإطار
   * البائت ⇒ `setIsLoading(false)` وسط تشغيل حيّ ⇒ تختفي البطاقة وزر STOP بلا
   * تعافٍ (الإعادة نفسها ترفع الـepoch فتعود اللقطة `'stale'`).
   *
   * ويخدم سجلّ الأحداث بنفس المنطق: حدثٌ وقع قبل التركيب (‏`permission_request`
   * لطلبٍ انقضى، أو `complete` لتشغيلٍ مضى) لا يُبعث ثانيةً عند إعادة التركيب.
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

  /* ---------------------------------------------------------------- */
  /*  أحداث التحكّم: complete / error / session_created / permission_*   */
  /* ---------------------------------------------------------------- */

  /**
   * تطبيق حدث تحكّم واحد من السجلّ الملحَق.
   *
   * هذه الحالات الخمس كانت فروعاً في مُبدِّل `latestMessage`؛ نُقلت إلى هنا لأن
   * تلك فتحة **قيمة واحدة**: حمولتان في نفس دفعة الـrender ⇒ الأولى تُمحى قبل
   * أن يقرأها أحد. و`complete` المفقود يعني بطاقةً عالقة وزرّ STOP لا يزول
   * (‏T-1293). الحمولة ما تزال تمرّ إلى `latestMessage` لمستهلكيها الآخرين،
   * فمنعُ المعالجة المزدوجة هنا: لا فرع لهذه الأنواع في ذلك المُبدِّل.
   *
   * الاشتقاقات الثلاثة (`activeViewSessionId`, `sid`, `isActiveViewSession`)
   * مُعادة الحساب حرفياً كما في المسار الآخر — لا فرق دلالي بينهما.
   */
  const applyControlEvent = useCallback((event: LatestChatMessage) => {
    const msg = event as any;
    const activeViewSessionId = selectedSession?.id || currentSessionId || null;
    const sid = msg.sessionId || activeViewSessionId;
    // True only when the event belongs to the session currently on screen.
    const isActiveViewSession = !sid || sid === activeViewSessionId;


    switch (msg.kind) {
      case 'session_created': {
        const newSessionId = msg.newSessionId;
        // T-1295: مولدُ جلسةٍ بمعرّف فارغ = فشلُ إقلاعٍ صريح ⇒ الإدخال يُرفع
        // بطاقةً. وبمعرّفٍ صحيح = قبولٌ مؤكَّد (الجولة بدأت والرسالة في سجلّها)
        // ⇒ يُحذف الإدخال وكائن صوره معه، فلا تتراكم بطاقاتُ «نجحت».
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
            const message = resolveServerErrorMessage(msg, t, 'session_create_failed');
            onServerError?.(message);
          }
          break;
        }

        // B-1297: correlate session_created to this tab's pending send by clientMsgId,
        // but ONLY on the brand-new-conversation path (`!currentSessionId`). Forked
        // sends and stale-resume mints (branches below) already have their own
        // parentSessionId-based guard (B-426) and must not be filtered here — those
        // paths never populate `pendingViewSessionRef.current.clientMsgId` (it is only
        // written by useChatComposerState when sending WITHOUT a session), so applying
        // this guard there would reject every healthy fork/resume with no error.
        // Two sub-cases when starting a brand-new conversation:
        //  (a) pendingViewSessionRef is set with a clientMsgId  — must match exactly.
        //  (b) pendingViewSessionRef was cleared by a message_dispatch_unconfirmed
        //      error while the provider was still starting (slow local model) — accept
        //      a late session_created only when the clientMsgId belongs to an
        //      unconfirmed outbox entry. NOTE: the outbox is keyed by userId in
        //      localStorage and shared across all tabs of the same user, so this can
        //      accept a session_created that belongs to another tab of the same user
        //      (not a cross-user leak) and navigate this tab with it.
        //  (c) no clientMsgId from the server (older provider) — allow for compat.
        if (!currentSessionId) {
          const incomingCmid = typeof msg.clientMsgId === 'string' && msg.clientMsgId
            ? msg.clientMsgId : null;
          if (incomingCmid) {
            const pendingCmid = pendingViewSessionRef.current?.clientMsgId ?? null;
            if (pendingCmid) {
              // (a) active pending send: require exact match.
              if (pendingCmid !== incomingCmid) break;
            } else if (!pendingViewSessionRef.current) {
              // (b) pending view was cleared (e.g. by earlier error); accept only
              // when the clientMsgId maps to an unconfirmed outbox entry (this
              // user's outbox, possibly written by another tab — see note above).
              const lateMatch = getOutboxSnapshot().some(
                (e) => e.id === incomingCmid
                  && e.status === 'unconfirmed'
                  && e.reasonCode === 'message_dispatch_unconfirmed',
              );
              if (!lateMatch) break;
              // Mark accepted: the session was created, so the message was delivered.
              confirmOutboxEntry(incomingCmid);
            }
            // else: pendingViewSessionRef is set but has no clientMsgId (older
            // provider that does not echo clientMsgId) — allow for backward compat.
          }
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
          if (msg.forked === true && msg.parentSessionId === currentSessionId) {
            sessionStore.branchSessionId(
              currentSessionId,
              newSessionId,
              typeof msg.clientMsgId === 'string' ? msg.clientMsgId : undefined,
            );
            sessionStorage.setItem('pendingSessionId', newSessionId);
            if (pendingViewSessionRef.current) {
              pendingViewSessionRef.current.sessionId = newSessionId;
            }
            setCurrentSessionId(newSessionId);
            setPendingPermissionRequests((prev) =>
              prev.map((r) => ({ ...r, sessionId: newSessionId })),
            );
            pendingViewSessionRef.current = null;
            onSessionActive?.(newSessionId);
            onSessionProcessing?.(newSessionId);
            setIsLoading(true);
            setCanAbortSession(true);
            setClaudeStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
            onNavigateToSession?.(newSessionId, { replace: true });
            break;
          }
          // Stale-resume fallback: the backend could not resume the active
          // session and minted a fresh one. `session_created` never fires for a
          // healthy resume, so a mismatch here means the old id is dead — migrate
          // the view (messages, pending permissions) onto the new conversation.
          //
          // B-426: «عدم التطابق» وحده لا يُثبت أن الحدث يخصّ هذه الشاشة. لو أرسل
          // المستخدم في محادثة ثم فتح أخرى قبل أن تُقلع الأولى، وصل
          // `session_created` والمعروضةُ أخرى، فكان هذا الفرع ينسخ محتوى
          // المعروضة إلى الجلسة الجديدة ويُسمّيها باسمها (alias) — فيرى
          // المستخدم رسالته ومحادثته الأولى داخل الثانية حتى يُحدّث الصفحة.
          //
          // `parentSessionId` يحسم النسب: يساوي معرّف الجلسة المعروضة ⇒ استئنافٌ
          // بائت لها فعلاً ⇒ الترحيل مشروع. و`null` ⇒ محادثة وُلدت الآن من إرسالٍ
          // آخر ⇒ لا تُمَسّ هذه الشاشة. وغيابُه (مزوّد لم يُحدَّث بعد) يُبقي
          // السلوك القديم كما هو حتى لا نكسر مساراً قائماً.
          const parentSessionId = (msg as { parentSessionId?: string | null }).parentSessionId;
          if (parentSessionId !== undefined && parentSessionId !== currentSessionId) {
            break;
          }
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
        // T-1295: نهايةُ الجولة حكمٌ على إدخال صندوق الصادر.
        //
        //  • `success === false` — رفضٌ صريح من طبقة الـWS (مزوّد مُعطَّل،
        //    مشروع غير مرئي). الرسالة لم تصل محرّكاً قط ⇒ بطاقة.
        //  • ما عداه — ومنه `aborted` — قبولٌ مؤكَّد: الجولة **بدأت**، والرسالة
        //    في سجلّ المحادثة. إجهاضُ المستخدم قرارُه هو لا فشلُ إرسال، فلا
        //    يُنتج بطاقةً (شرط التصنيف الرابع).

        // Flush any remaining streaming state — لهذه الجلسة وحدها.
        if (sid) {
          const buffered = accumulatedStreamRef.current.get(sid);
          if (buffered?.text) {
            sessionStore.updateStreaming(sid, buffered.text, provider, buffered.attribution, buffered.responseToMessageId);
            sessionStore.finalizeStreaming(sid);
          }
          accumulatedStreamRef.current.delete(sid);
        }
        if (streamTimerRef.current && accumulatedStreamRef.current.size === 0) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }

        // `complete` never becomes a conversation row itself. Transfer its
        // server-attested boundaries onto the exact linked assistant row after
        // finalizing the stream, so per-reply and conversation-total timing use
        // the same completed turn and never infer timestamps from adjacency.
        const completedTurn = persistedTurnFromControlEvent(msg);
        if (sid && completedTurn) {
          sessionStore.applyResponseTurnCompletion(sid, completedTurn);
        }

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

        // نهاية التشغيل تُعلَن هنا، قبل أي تفريع لاحق — قناتان مستقلّتان:
        //
        //  • المؤشّر البصري **أساس لا يُحجب**: هو ما يقول للمستخدم إن هذه
        //    المحادثة لم تعد تنتظره، سواء اكتمل الردّ أو أُجهض أو بقيت ورشة
        //    تعمل خلفه. كان أسفلَ بوابتَي `aborted` و`hasPendingWorkflows`،
        //    فكان يسقط كلّما اختلفت نهاية التشغيل عن أبسط صورها — وسقوطه
        //    يعني أن المستخدم لا يعلم أن ردّه جاهز.
        //  • الصوت قناة **تابعة لإعدادها وحدها**: `playChatCompletionSound`
        //    تفحص `isNotificationSoundEnabled` بنفسها فتصمت إن كان مطفأً. لا
        //    تشترط شيئاً آخر، ولا يشترطها شيء.
        //
        // B-538: علامة العنوان لم تعد تُوضع هنا. كانت تُعرض لحظياً ثم تُمسح بعد
        // ثانيتين — تُخبر من كان ناظراً بما يراه، وتغيب عمّن انصرف وهو وحده من
        // يحتاجها. صارت تُشتقّ من «انتهت ولم تُفتح» (`AppContent`) فتبقى قائمة
        // حتى يفتح المستخدم المحادثة. والصوت باقٍ هنا: قناةٌ لحظية بطبعها.
        // الـ`catch` جزءٌ من الاستقلال لا زينة: الدالة تُسجّل أخطاءها المتوقّعة
        // بنفسها، وما ينفلت منها (متصفّح يمنع AudioContext مثلاً) كان يخرج
        // رفضاً غير مُلتقَط. قناةٌ تابعة لا يجوز أن تُصدر ضجيجاً على فشلها.
        void playChatCompletionSound().catch(() => {});

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it. The loading
          // state was already cleared above. If the server could NOT honour the
          // abort (no matching/active session), surface why instead of leaving
          // the user thinking STOP silently failed.
          if (msg.success === false || msg.abortFailed) {
            onServerError?.(resolveServerErrorMessage(msg, t, 'abort_failed'));
          }
          break;
        }

        if (hasPendingWorkflows) break;

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

        // T-1294: الجولة الفاشلة **نهاية** كالنجاح، وتُعلَن بالعقد نفسه (B-513):
        // المؤشّر أوّلاً ثم الصوت، وقبل أي تفريع، وخارج بوابة الشاشة المعروضة.
        //
        //  • خارج البوابة عمداً: خطأ جلسةٍ خلفية يجب أن يُعلَن كما يُعلَن
        //    اكتمالها — المستخدم غائب عن التبويب، والقناتان هما كل ما يبلغه.
        //    (أما الشريط الأحمر فشأن الشاشة المعروضة وحدها، فيبقى داخلها.)
        //  • علامة `[Error]` لا `[Done]`: «تمّ» على جولة فشلت كذبة.
        //  • نبرة هابطة مقابل صاعدة، بنفس المفتاح الواحد للصوت — لا إعداد ثانٍ.
        //
        // ويُستثنى `session_busy` وحده: هو **رفضُ محاولةِ إرسال** لا نهايةَ
        // جولة — والجلسة ما تزال تعمل. إعلانه بالعلامة يقول «انتهت بفشل» عن
        // جولةٍ حيّة، وهي كذبةٌ من نوع «تمّ على فشل» بعينه معكوسةً. ولا يقع
        // أصلاً إلا من إرسال المستخدم نفسه ⇒ الصفحة أمامه والشريط الأحمر أدنى
        // إليه من عنوان تبويبٍ ينظر إليه.
        // B-544: العلامة لم تعد تُوضع من هنا — تُشتقّ من حالة الجلسة في
        // `AppContent` فتبقى حتى تُفتح المحادثة بدل ثانيتين. والصوت باقٍ: قناةٌ
        // لحظية بطبعها، ولها إعدادها وحدها.
        const isSendRejection = readServerErrorCode(msg) === 'session_busy';
        if (!isSendRejection) {
          void playChatErrorSound().catch(() => {});
        }

        // T-1295: الجولة فشلت ⇒ يُرفع إدخالها بطاقةً بسببه المترجَم.
        //
        // ويُستثنى `session_busy` **بشرطه**: B-518 يعالجه بما هو أفضل من بطاقة —
        // يسحب الفقاعة ويردّ النصّ إلى المُؤلِّف مباشرةً — فبطاقةٌ فوق ذلك تعني
        // نسختين من كلامٍ واحد على الشاشة. لكن ذلك الردّ **مشروط بالشاشة
        // المعروضة** (‏`isActiveViewSession` أدناه): أرسل المستخدم في محادثة ثم
        // فتح أخرى قبل أن يصل الرفض ⇒ لا ردّ إلى مُؤلِّف، فحذفُ الإدخال هنا يُتلف
        // النسخة الأخيرة من كلامه. فالحذف حيث يقع الردّ، والبطاقة حيث لا يقع.

        // View mutations only for the session on screen.
        if (isActiveViewSession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          pendingViewSessionRef.current = null;
          // A run that ends in error can never answer a permission prompt it
          // left open, and ChatComposer hides the WHOLE status card while any
          // request is pending (`!hasPendingPermissions`) — so an orphaned
          // request suppresses the running indicator of every LATER run in this
          // session, silently and forever. `complete` already clears them here;
          // the error path did not, which is the asymmetry that made a failed
          // run look like a dead UI.
          setPendingPermissionRequests([]);

          // Surface a human-readable, localised message via onServerError for
          // any error event — structured `{ error: {...} }`, a flat code, or an
          // unrecognised failure (general fallback). Previously this fired only
          // when a known top-level `code` was present, so structured new-session
          // failures and unknown errors failed silently (T-83).
          onServerError?.(resolveServerErrorMessage(msg, t));

          // B-518: رفضٌ قاطع قبل أي تنفيذ — الرسالة لم تصل المحرّك ولن تصل،
          // ولا نسخة لها في أي سجلّ. نسحب فقاعتها المتفائلة (وإلا بقيت كذبةً
          // على الشاشة يُبنى عليها انتظارٌ ثم إعادةُ إرسال) ونردّ نصّها إلى
          // المُؤلِّف كي لا يفقد المستخدم كلامه ولا يعيد كتابته.
          if (isSendRejection && sid) {
            // B-1078: only the frame's own id may select a bubble. A busy frame
            // without one (older qwen/hermes) withdraws NOTHING: it fans out to
            // mirror tabs, where "the last pending row" is another tab's live send.
            // An attachment-only bubble returns '' ⇒ no draft restore and no
            // outbox delete, so its card keeps the images for retry.
            const rejectedClientMsgId = typeof msg.clientMsgId === 'string' && msg.clientMsgId
              ? msg.clientMsgId : null;
            const withdrawn = rejectedClientMsgId
              ? sessionStore.withdrawOptimisticUserRow(sid, rejectedClientMsgId) : null;
            if (rejectedClientMsgId && withdrawn && onRejectedSendRestore) {
              onRejectedSendRestore(withdrawn);
              // The ingress consumer kept a recoverable failed copy. Remove it
              // only after the active composer really accepted the text back.
              removeOutboxEntry(rejectedClientMsgId);
            }
          }
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

      default:
        break;
    }
  }, [
    accumulatedStreamRef,
    currentSessionId,
    onNavigateToSession,
    onRejectedSendRestore,
    onServerError,
    onSessionActive,
    onSessionInactive,
    onSessionNotProcessing,
    onSessionProcessing,
    paletteOps,
    pendingViewSessionRef,
    provider,
    selectedSession,
    sessionStore,
    setCanAbortSession,
    setClaudeStatus,
    setCurrentSessionId,
    setIsLoading,
    setPendingPermissionRequests,
    streamTimerRef,
    t,
  ]);

  /**
   * تعافٍ بعد فقدٍ مُعلَن: لقطة الحالة الحتمية عبر المسار القائم (`/activity`).
   *
   * **رافعة فقط** ومحروسة بالـepoch داخل `runSessionActivityProbe`، فلا يمكنها
   * أن تُنزل مؤشّراً لتشغيل حيّ ولا أن تُطبّق إجابة سبقها حدثٌ أحدث.
   */
  const requestActivitySnapshot = useCallback(() => {
    const sessionId = selectedSession?.id || currentSessionId || null;
    if (!sessionId) return;
    void runSessionActivityProbe({
      sessionId,
      onActive: () => {
        setIsLoading(true);
        setCanAbortSession(true);
      },
    });
  }, [currentSessionId, selectedSession, setCanAbortSession, setIsLoading]);

  /**
   * تأثير **واحد** للشريحتين معاً، يمشي على اتحادهما مرتّباً بـ`seq`.
   *
   * تأثيران منفصلان كانا سيتبعان ترتيب التصريح لا ترتيب السلك: إطار
   * `session-status` يقول «تعمل» وحدثُ `complete` يقول «انتهت» يصلان في نفس
   * الدفعة، فيفوز آخرُ المُعلَنين لا آخرُ الواصلين — ومؤشّرٌ عالق أو مرفوع بلا
   * تشغيل. العدّاد واحد أصلاً في المزوّد، فالترتيب بينهما معلوم هنا.
   */
  useEffect(() => {
    if (!controlFrames && !controlEvents) return;

    const events = controlEvents?.events ?? [];

    // أول تشغيل: ثبّت خطّ الأساس على أعلى `seq` موجود ولا تُطبّق شيئاً منه.
    // اللقطة الحتمية عبر REST هي مصدر حالة الفتح، لا إطار سابق لعمر المكوّن.
    if (controlBaselineSeqRef.current === null) {
      let highest = 0;
      if (controlFrames) {
        for (const [, entry] of controlFrames) {
          if (entry.seq > highest) highest = entry.seq;
        }
      }
      for (const entry of events) {
        if (entry.seq > highest) highest = entry.seq;
      }
      controlBaselineSeqRef.current = highest;
      processedEventSeqRef.current = highest;
      return;
    }

    // فقدٌ بالتقليم: أحداثٌ خرجت من السجلّ قبل أن تُعالَج هنا. المضيّ صامتاً
    // يترك الواجهة على حالة ناقصة لا يُصلحها شيء، فنقفز إلى الأحدث (ما بقي في
    // السجلّ غير موثوق تسلسله بالنسبة لما فُقد) ونُعيد ضبط خطّ الأساس، ثم نسأل
    // المصدر الحتمي عن الحقيقة.
    const droppedBeforeSeq = controlEvents?.droppedBeforeSeq ?? 0;
    if (processedEventSeqRef.current < droppedBeforeSeq) {
      let highest = droppedBeforeSeq;
      if (controlFrames) {
        for (const [, entry] of controlFrames) {
          if (entry.seq > highest) highest = entry.seq;
        }
      }
      for (const entry of events) {
        if (entry.seq > highest) highest = entry.seq;
      }
      controlBaselineSeqRef.current = highest;
      processedEventSeqRef.current = highest;
      requestActivitySnapshot();
      return;
    }

    const baseline = controlBaselineSeqRef.current;
    const processed = processedControlSeqRef.current;

    type PendingControl = {
      seq: number;
      frame: any;
      /** `null` لحدثٍ من السجلّ؛ معرّف الجلسة لإطار حالة من الخريطة. */
      frameSessionId: string | null;
    };
    const pending: PendingControl[] = [];

    if (controlFrames) {
      for (const [sessionId, entry] of controlFrames) {
        if (entry.seq <= baseline) continue; // سابق لتركيب هذا المستهلك
        if ((processed.get(sessionId) ?? 0) >= entry.seq) continue;
        pending.push({ seq: entry.seq, frame: entry.frame, frameSessionId: sessionId });
      }
    }
    for (const entry of events) {
      if (entry.seq <= baseline) continue;
      if (entry.seq <= processedEventSeqRef.current) continue;
      pending.push({ seq: entry.seq, frame: entry.frame, frameSessionId: null });
    }

    if (pending.length === 0) return;
    pending.sort((a, b) => a.seq - b.seq);

    for (const item of pending) {
      if (item.frameSessionId === null) {
        processedEventSeqRef.current = item.seq;
        applyControlEvent(item.frame);
      } else {
        processed.set(item.frameSessionId, item.seq);
        applySessionStatusFrame(item.frame);
      }
    }

    // سقف مطابق لتقليم الشريحة نفسها: لا تنمو خريطة «ما عولج» بلا حدّ.
    if (processed.size > MAX_CONTROL_FRAMES) {
      const bySeqAsc = [...processed.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of bySeqAsc.slice(0, processed.size - MAX_CONTROL_FRAMES)) {
        processed.delete(key);
      }
    }
  }, [
    applyControlEvent,
    applySessionStatusFrame,
    controlEvents,
    controlFrames,
    requestActivitySnapshot,
  ]);

  /**
   * استهلاك اللقطة التراكمية للبث. هذا هو مسار العرض الحي السلطوي؛
   * `latestMessage` يبقى قناة توافقية لبقية الأنواع لكنه لا يعالج stream هنا
   * حين تتوفر هذه الشريحة، وإلا تكرر النص.
   */
  useLayoutEffect(() => {
    if (!streamFrames) return;
    const processed = processedStreamSeqRef.current;
    const viewedSessionId = selectedSession?.id || currentSessionId;
    const eviction = viewedSessionId ? streamFrames.evictedHeads?.get(viewedSessionId) : undefined;
    if (viewedSessionId && eviction
      && (recoveredEvictionRef.current?.sessionId !== viewedSessionId
        || recoveredEvictionRef.current.seq !== eviction.seq)) {
      recoveredEvictionRef.current = { sessionId: viewedSessionId, seq: eviction.seq };
      const slot = sessionStore.getSessionSlot?.(viewedSessionId);
      const consumed = Math.max(processed.get(viewedSessionId) ?? 0,
        slot ? consumedStreamHeads.get(slot)?.seq ?? 0 : 0);
      if (eviction.seq > consumed || (slot && consumedStreamHeads.get(slot)?.gap)) {
        const id = `stream_gap_${viewedSessionId}`;
        if (!sessionStore.getMessages?.(viewedSessionId)?.some(message => message.id === id)) {
          sessionStore.appendRealtime(viewedSessionId, {
            id, sessionId: viewedSessionId, kind: 'error', provider,
            code: 'stream_recovery_gap', content: t('streamRecoveryGap'), timestamp: new Date().toISOString(),
          });
        }
        // الحارس على قيمة الفجوة لا على وجود الصفّ: صفّ محذوف بلا فجوة جديدة
        // لا يعيد الجلب (فيتو qa-critic ضدّ حلقة طلبات لا نهائية).
        if (canAutomaticallyReadHistory(slot?.historyError)
          && (!slot || streamGapFetchedHeads.get(slot) !== eviction.seq)) {
          if (slot) streamGapFetchedHeads.set(slot, eviction.seq);
          requestStreamGapRecovery(viewedSessionId);
        }
      }
    }
    const unresolvedEvictions = new Map<string, number>();
    for (const [sessionId, entry] of streamFrames) {
      const slot = sessionStore.getSessionSlot?.(sessionId);
      const consumed = Math.max(processed.get(sessionId) ?? 0,
        slot ? consumedStreamHeads.get(slot)?.seq ?? 0 : 0);
      const savedGap = slot ? consumedStreamHeads.get(slot)?.gap : undefined;
      const evictionGap = entry.evictionGap && entry.droppedBeforeSeq
        && (entry.incomplete || entry.droppedBeforeSeq > consumed || savedGap)
        ? entry.droppedBeforeSeq : undefined;
      if (evictionGap) {
        unresolvedEvictions.set(sessionId, evictionGap);
        if (slot) recordConsumedStreamHead(slot, consumed, evictionGap);
      }
      // جلسة غير معروضة: لا صفّ خطأ ولا جلب. تُعاد التقييم عند فتحها لاحقاً
      // (تبقى الفجوة في streamFrames، وunresolvedEvictions أعلاه محفوظة).
      if (entry.droppedBeforeSeq && sessionId === viewedSessionId
        && (entry.incomplete || evictionGap || entry.droppedBeforeSeq > consumed)) {
        // A tail is only a bounded recovery attempt, not proof of completeness.
        const id = `stream_gap_${sessionId}`;
        if (!sessionStore.getMessages?.(sessionId)?.some(message => message.id === id)) {
          sessionStore.appendRealtime(sessionId, {
            id, sessionId, kind: 'error', provider,
            code: 'stream_recovery_gap', content: t('streamRecoveryGap'), timestamp: new Date().toISOString(),
          });
        }
        // الحارس على قيمة الفجوة لا على وجود الصفّ (فيتو qa-critic): إخفاء
        // الصفّ لا يفتح الجلب ثانيةً، وفجوة تالية بقيمة أعلى تفتحه فعلاً حتى
        // إن بقي الصفّ القديم ظاهراً.
        const gapKey = evictionGap ?? entry.droppedBeforeSeq;
        if (canAutomaticallyReadHistory(slot?.historyError)
          && (!slot || streamGapFetchedHeads.get(slot) !== gapKey)) {
          if (slot) streamGapFetchedHeads.set(slot, gapKey);
          requestStreamGapRecovery(sessionId);
        }
      }
    }
    const pending = [...streamFrames.entries()]
      .flatMap(([sessionId, entry]) => [...(entry.completed ?? []), entry]
        .map(snapshot => [sessionId, snapshot] as const))
      .filter(([sessionId, entry]) => entry.seq > (processed.get(sessionId) ?? 0))
      .sort((a, b) => a[1].seq - b[1].seq);

    for (const [sessionId, entry] of pending) {
      processed.set(sessionId, entry.seq);
      // An evicted cumulative baseline cannot be reconstructed from a suffix.
      // Keep any visible prefix until REST or a canonical full text arrives.
      if ('incomplete' in entry && entry.incomplete) continue;
      // ADR-041: this path is authoritative for stream frames, so it must move
      // the reconnect replay floor before `latestMessage` skips the same frame.
      sessionStore.recordSeq(sessionId, entry.frame?.sequence);
      const finalId = entry.frame?.kind === 'text' ? entry.frame.id : `stream_${sessionId}_${entry.seq}`;
      const slot = sessionStore.getSessionSlot?.(sessionId);
      if (entry.ended && finalId && slot
        && [...slot.serverMessages, ...slot.realtimeMessages].some(message => message.id === finalId)) continue;
      if (entry.frame?.kind === 'text' && entry.frame?.role === 'assistant') {
        const responseToMessageId = responseRunId(entry.frame);
        sessionStore.appendRealtime(sessionId, responseToMessageId
          ? { ...entry.frame, responseToMessageId } as NormalizedMessage
          : entry.frame as NormalizedMessage);
        const appliedSlot = sessionStore.getSessionSlot?.(sessionId);
        if (appliedSlot) recordConsumedStreamHead(appliedSlot, entry.seq, unresolvedEvictions.get(sessionId));
        continue;
      }
      if (entry.text) {
        sessionStore.updateStreaming(
          sessionId,
          entry.text,
          (entry.frame?.provider || provider) as LLMProvider,
          {
            coordinatorId: entry.frame?.coordinatorId,
            originKind: entry.frame?.originKind,
            model: entry.frame?.model,
          },
          responseRunId(entry.frame) ?? undefined,
        );
      }
      if (entry.ended) sessionStore.finalizeStreaming(sessionId, finalId);
      const appliedSlot = sessionStore.getSessionSlot?.(sessionId);
      if (appliedSlot) recordConsumedStreamHead(appliedSlot, entry.seq, unresolvedEvictions.get(sessionId));
    }
    pruneProcessedStreamSeqs(processed, streamFrames);
  }, [currentSessionId, selectedSession?.id, provider, requestStreamGapRecovery, sessionStore, streamFrames, t]);

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

    // B-829: stream_delta/stream_end يُستهلكان من الشريحة التراكمية أعلاه.
    // القناة الأحادية قد تفقد أجزاء في batching ولا يجوز جمعها مرة ثانية.
    if (
      streamFrames
      && (
        msg.kind === 'stream_delta'
        || msg.kind === 'stream_end'
        || (msg.kind === 'text' && msg.role === 'assistant')
      )
    ) return;

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          if (reconnectEpoch === undefined) onWebSocketReconnect?.();
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
      model: typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : undefined,
    };

    const responseToMessageId = responseRunId(msg);
    const buffers = accumulatedStreamRef.current;

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text) return;
      // بلا جلسة معلومة لا موضع للنصّ: إضافته إلى مخزن مشترك كانت تُلصقه بجلسة
      // أخرى عند أول إفراغ. الإسقاط هنا أصدق من نسبته إلى غير أهله.
      if (!sid) return;
      // (seq recorded at the top of this block for all kinds; ADR-041 B-80.)
      const previous = buffers.get(sid);
      // A delta lacking the explicit run id (or naming a different run) may
      // still render, but it must never inherit a latency anchor.
      const sameRun = Boolean(
        responseToMessageId
        && (!previous?.responseToMessageId || previous.responseToMessageId === responseToMessageId),
      );
      const differentResponse = Boolean(responseToMessageId && previous?.responseToMessageId
        && responseToMessageId !== previous.responseToMessageId);
      buffers.set(sid, {
        text: (previous?.text || '') + text,
        // النسبة تُحفَظ مع نصّها لا مع آخر دفعة وصلت للتطبيق: الإفراغ يمرّ على
        // جلسات عدّة، فنسبةُ رسالةٍ من جلسة أخرى تُخطئ صاحب الكلام.
        attribution: {
          ...streamAttribution,
          model: streamAttribution.model ?? (differentResponse ? undefined : previous?.attribution.model),
        },
        responseToMessageId: sameRun ? responseToMessageId! : undefined,
      });
      if (!streamTimerRef.current) {
        streamTimerRef.current = window.setTimeout(() => {
          streamTimerRef.current = null;
          // يُفرَّغ كل مخزن في **جلسته هو**: مؤقّت واحد يخدم كل الجلسات
          // الجارية بلا أن يخلط نصّها.
          for (const [bufferedSessionId, buffered] of buffers) {
            if (buffered.text) {
              sessionStore.updateStreaming(
                bufferedSessionId,
                buffered.text,
                provider,
                buffered.attribution,
                buffered.responseToMessageId,
              );
            }
          }
        }, 100);
      }
      // Also route to store for non-active sessions
      if (sid && sid !== activeViewSessionId) {
        sessionStore.appendRealtime(sid, {
          ...(msg as NormalizedMessage),
          responseToMessageId: sameRun ? responseToMessageId! : undefined,
        });
      }
      return;
    }

    if (msg.kind === 'stream_end') {
      if (sid) {
        const buffered = accumulatedStreamRef.current.get(sid);
        if (buffered?.text) {
          sessionStore.updateStreaming(sid, buffered.text, provider, buffered.attribution, buffered.responseToMessageId);
        }
        sessionStore.finalizeStreaming(sid);
        // مخزن هذه الجلسة وحده يُمحى. المؤقّت مشترك، فلا يُلغى إلا إن لم يبقَ
        // نصّ لجلسة أخرى تنتظر إفراغه — وإلغاؤه مطلقاً كان يبتر بثّها.
        accumulatedStreamRef.current.delete(sid);
      }
      if (streamTimerRef.current && accumulatedStreamRef.current.size === 0) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
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
      && msg.kind !== 'permission_cancelled'
      // B-518: ‏`session_busy` رفضٌ لمحاولةِ إرسالٍ لم تقع، لا حدثٌ في
      // المحادثة. والخادم لا يخزّنه عمداً (لا مخزن لمحاولة مرفوضة)، فحفظُه
      // هنا يُنشئ فقاعةَ خطأ تتراكم مع كل محاولة وتختفي عند أول تحديث —
      // تناقضٌ بين ما يُعرض وما هو محفوظ. الرسالة تصل عبر شريط الخطأ.
      && !(msg.kind === 'error' && msg.code === 'session_busy');

    // B-426: صفٌّ يُحفَظ في المحادثة يلزمه **معرّف جلسته هو**، لا الارتداد إلى
    // الجلسة المعروضة. الخادم يبعث `sessionId: capturedSessionId || sessionId`،
    // وهو فارغ في نافذة إقلاع المحادثة الجديدة قبل أن يُلتقط معرّفها — فكان صدى
    // رسالة المستخدم يُكتب في أي محادثة تكون مفتوحة أمامه حينها، ولا يزول إلا
    // بتحديث الصفحة. والإسقاط هنا بلا خسارة: في شاشة المسوّدة لا مفتاح أصلاً
    // (`sid` عندها null) فلم يكن يُكتب شيء على أي حال.
    if (msg.sessionId && shouldPersist) {
      // Preserve only the run identity needed to attach a later *persisted*
      // response metric. No client timestamp participates in duration UI.
      const persisted = msg.kind === 'text'
        && msg.role === 'assistant'
        && responseToMessageId
        ? {
            ...(msg as NormalizedMessage),
            responseToMessageId,
          }
        : msg as NormalizedMessage;
      sessionStore.appendRealtime(msg.sessionId, persisted);
    }

    // --- UI side effects for specific kinds ---
    //
    // ملحوظة (T-1293، على نمط `session-status` أعلاه): `session_created`
    // و`complete` و`error` و`permission_request` و`permission_cancelled` لم تعد
    // تُعالَج من هنا — تُوجَّه في WebSocketContext إلى سجلّ الأحداث الملحَق
    // `controlEvents` وتُطبَّق في `applyControlEvent`. الحمولة ما تزال تصل
    // `latestMessage` عمداً (مستهلكون آخرون يقرؤونها: AppContent،
    // useBtwSideChannel…)، فالحذف من هنا هو **كل** ما يمنع المعالجة المزدوجة.
    //
    // ما بقي فوق المُبدِّل يخصّها ويعمل لها كما كان: `recordSeq` (ADR-041) —
    // ونقلُه كان سيكسر `lastSeq` فيعود الـreplay من الصفر — و`appendRealtime`
    // لـ`error` وحده (بوابة `shouldPersist` تستثني الأربع الأخرى ولا تستثنيه).
    switch (msg.kind) {
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
    // التبعيات المحذوفة (setCurrentSessionId، pendingViewSessionRef، onSession*،
    // onNavigateToSession، onServerError، onRejectedSendRestore، paletteOps، t)
    // انتقلت مع حالاتها إلى `applyControlEvent` ولم تعد مقروءة هنا.
  }, [
    latestMessage,
    reconnectEpoch,
    streamFrames,
    provider,
    selectedSession,
    currentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    onWebSocketReconnect,
    sessionStore,
  ]);

  // زرّ «استكمِل الآن» على صفّ `stream_recovery_gap` (بلا إخفاء تلقائي
  // للتنبيه): استدعاء صريح لنفس مسار الاسترجاع الموسَّع، خارج حارس الجلب
  // التلقائي — إجراء مستخدم متعمَّد لا يخضع لتقييد إعادة المحاولة.
  return { requestStreamGapRecovery };
}

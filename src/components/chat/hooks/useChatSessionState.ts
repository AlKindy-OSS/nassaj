import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import { canAutomaticallyReadHistory, isHistoryRebaseFailure, historyTransportFailure, type SessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { useLightHistoryCapability } from '../../../stores/serverCapabilitiesStore';
import type { ChatMessage, Provider } from '../types/types';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';

import { newestContextUsage } from './contextUsagePresentation';
import { normalizedToChatMessages } from './useChatMessages';
import { runSessionActivityProbe, type SessionActivityProbeOutcome } from './sessionActivity';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;

/**
 * سقف النافذة المُوسَّعة التي تُجلب مرّة واحدة حين تُثبت لقطة REST أن الجلسة
 * **نشطة** (B-208، بند 7).
 *
 * لماذا أصلاً: النافذة الافتتاحية 20 صفاً خاماً قد تسقط صفوف `Agent` وحدّ
 * الجولة إذا تراكمت بعدها تحديثات كثيرة. عندها يُرجع `useRunProgress`
 * ‏`agents: []` وتنهار البطاقة إلى `ClaudeStatus` بلا صفوف. عينة اصطناعية
 * ممثلة تثبت هذا الحد في اختبارات النافذة.
 *
 * لماذا آمن — الشرطان الملزمان:
 *  (أ) **صفوف النتائج**: نافذة الخادم لاحقة دائماً (`offset=0` = ذيل السجلّ)،
 *      وصفّ نتيجة أي `Agent` داخل النافذة يقع بعده زمنياً فيكون داخلها حتماً؛
 *      كما أن مزوّد claude يُلصق `toolResult`/`subagentTools` على صفّ الأداة
 *      نفسه قبل التقطيع. فلا يُوسَم وكيل منتهٍ بـ«running» بسبب التقطيع.
 *  (ب) **حدّ الجولة**: النافذة الأوسع تبلغ ما قبل آخر صفّ مستخدم في الحالة
 *      العملية. وإن لم تبلغه (تشغيل أطول من السقف) فكل صفوفها بعد آخر مطالبة
 *      بشرية بحكم كونها ذيلاً ⇒ `boundaryIndex = -1` يمسح النافذة كلها وهي
 *      كلّها من الجولة الجارية: نقص محتمل في العدّ، لا تلوّث بجولة سابقة.
 *
 * طلب واحد إضافي محدود، لا polling.
 */
const ACTIVE_RUN_HYDRATION_LIMIT = 400;

type PendingViewSession = {
  startedAt: number;
};

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  autoScrollToBottom?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: Set<string>;
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  sessionStore: SessionStore;
}

interface ScrollRestoreState {
  height: number;
  top: number;
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

/** Preserve a composer row and its attachments when routing it into the session store. */
export function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = typeof msg.id === 'string' && msg.id.trim()
    ? msg.id
    : `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    images: msg.images?.map(image => typeof image === 'string' ? image : image.data),
    files: msg.files,
    // Preserve the author stamp on optimistic local user messages so the
    // sender's own avatar resolves immediately (mirrors get the same id from
    // the server-stamped WS echo / history rows).
    userId: typeof msg.userId === 'number' ? msg.userId : undefined,
  } as NormalizedMessage;
}

/**
 * Turns a non-2xx token-usage response into an "unavailable" marker (B-823).
 * `reason` comes from the server when it knows why (a transcript it could not
 * resolve); the HTTP status is kept so the indicator can say *something* even
 * for an unlabeled failure.
 */
export async function readUsageFailure(response: Response): Promise<Record<string, unknown>> {
  let reason = 'lookup_failed';
  try {
    const body = await response.json();
    if (typeof body?.reason === 'string') reason = body.reason;
  } catch {
    // A non-JSON error body still leaves us with the status below.
  }
  return { unavailable: true, reason, status: response.status };
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  autoScrollToBottom,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  resetStreamingState,
  pendingViewSessionRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [canAbortSession, setCanAbortSession] = useState(false);
  /**
   * هل أجابت نقطة `/activity` إجابةً قاطعة مرّة واحدة على الأقل في هذه الجلسة؟
   *
   * تُستعمل كبوّابة ذاتية-الشفاء (مراجعة qa-critic، حرج 3): مخرج الطوارئ
   * الجديد (إظهار زر التحديث أثناء التشغيل) لا يُفتح قبل توفّر مصدر حتمي
   * يستطيع إعادة رفع المؤشّر بعد الضغط — فلا انحدار ينشره `build:client`
   * قبل أن يصل الخادم.
   */
  const [activitySourceAvailable, setActivitySourceAvailable] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, storeTokenBudget] = useState<Record<string, unknown> | null>(null);
  const setTokenBudget = useCallback((incoming: Record<string, unknown> | null) => {
    storeTokenBudget((current) => newestContextUsage(current, incoming));
  }, []);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [claudeStatus, setClaudeStatus] = useState<{ text: string; tokens: number; can_interrupt: boolean } | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);
  const lightHistoryCapability = useLightHistoryCapability();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  // Holds whichever setTimeout is currently pending in the findAndScroll retry
  // chain (below) so it can be cancelled outright on a session switch instead
  // of being left to fire against a session it no longer applies to.
  const searchScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  /**
   * B-431: ميزانية إطارات «التمرير الابتدائي» **عبر إعادات تشغيل الأثر**.
   * الأثر يعتمد على `chatMessages.length`، فكل رسالة جديدة تُلغي حلقة rAF
   * الجارية وتبدأ أخرى بعدّاد صفر. أثناء بثّ حيّ (رسالة كل أقل من ثانية) لا
   * تبلغ الحلقة سقفها أبداً، فتظلّ تثبّت scrollTop=scrollHeight كل إطار —
   * والنتيجة أن التمرير لأعلى مستحيل حرفياً. العدّاد في ref فلا يُصفَّر إلا
   * عند تبديل الجلسة.
   */
  const initialScrollFramesRef = useRef(0);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /* --- لقطة نشاط الجلسة (B-208) ------------------------------------- */
  /** حارس single-flight: لا لقطتان متزامنتان أبداً. */
  const activityProbeInFlightRef = useRef(false);
  /** طلب لقطة وصل أثناء لقطة جارية: يُنفَّذ مرّة واحدة بعدها (لا يُهمَل ولا يُكرَّر). */
  const activityProbeQueuedRef = useRef(false);
  /** مفتاح آخر محادثة أُطلقت لها لقطة فتح — محاولة واحدة لكل محادثة مفتوحة. */
  const probedOpenKeyRef = useRef<string | null>(null);
  /** مفتاح آخر محادثة وُسّعت نافذتها — مرّة واحدة لكل (جلسة، مشروع). */
  const hydratedRunKeyRef = useRef<string | null>(null);
  /** وعد التحميل الافتتاحي الجاري، كي لا تصطدم النافذة المُوسَّعة بردّه المتأخر. */
  const initialLoadRef = useRef<{ sessionId: string; promise: Promise<unknown> } | null>(null);
  const historyEpochRef = useRef(0);
  const historyRequestRef = useRef<AbortController | null>(null);
  const paginationRequestsRef = useRef(new Set<AbortController>());
  const historyIdleCancelRef = useRef<(() => void) | null>(null);
  const historyQueueRef = useRef<{
    sessionId: string | null;
    epoch: number;
    running: boolean;
    fullQueued: boolean;
    light400Queued: boolean;
    fullDone: boolean;
    fullLimit: number;
  }>({
    sessionId: null,
    epoch: 0,
    running: false,
    fullQueued: false,
    light400Queued: false,
    fullDone: false,
    fullLimit: MESSAGES_PER_PAGE,
  });
  /** مرآة معرّف الجلسة المعروضة، تُقرأ داخل مسارات لاتزامنية بلا closure بائت. */
  const selectedSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  selectedSessionIdRef.current = selectedSession?.id ?? null;
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    pendingViewSessionRef.current = null;
    setClaudeStatus(null);
    setCanAbortSession(false);
    setIsLoading(false);
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    sessionStorage.removeItem('cursorSessionId');
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    setSearchTarget(null);
    if (searchScrollTimeoutRef.current) {
      clearTimeout(searchScrollTimeoutRef.current);
      searchScrollTimeoutRef.current = null;
    }
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = true;
    initialScrollFramesRef.current = 0;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, pendingViewSessionRef, resetStreamingState, setTokenBudget]);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    // الرسالة المعلّقة تُكتب في مسوّدة بلا جلسة، فلا تملك إلا الجلسة التي
    // يُنشئها إرسالها هي. و`activeSessionId` قد يتغيّر لسبب آخر تماماً: أن
    // يفتح المستخدم محادثةً أخرى بينما الإرسال ما زال طائراً. الإفراغ حينها
    // كان يحقن الرسالة في مخزن جلسةٍ لم تستقبلها قط، فتظهر معلّقة أسفلها حتى
    // تحديث الصفحة (صفّ realtime عميلي لا وجود له على الخادم).
    //
    // `pendingViewSessionRef` هو المميِّز الدقيق: يُضبط عند الإرسال بلا جلسة،
    // ويُصفَّر داخل معالج `session_created` **قبل** أن يُرى تغيّر
    // `currentSessionId` هنا (تصفيرٌ متزامن على ref في نفس المعالج) — فالإفراغ
    // المشروع يمرّ، والانتقال إلى محادثة أخرى لا يمرّ. وفي الحالة الثانية
    // نُسقِط النسخة المتفائلة بدل حقنها: الخادم يحفظ رسالة المستخدم، فتظهر
    // صحيحةً في جلستها عند فتحها.
    if (pendingViewSessionRef.current) {
      flushedPendingUserMessageRef.current = pendingUserMessage;
      setPendingUserMessage(null);
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, pendingViewSessionRef, sessionStore]);

  const historyError = activeSessionId ? sessionStore.getSessionSlot(activeSessionId)?.historyError ?? null : null;
  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : [];
  const responseTurnDurationTotalMs = activeSessionId
    ? sessionStore.getSessionSlot(activeSessionId)?.responseTurnDurationTotalMs ?? null
    : null;

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session,
    // pre-backend-response). مشروطاً بغياب جلسة معروضة: وإلا ظهرت المسوّدة
    // داخل أي محادثة فارغة يفتحها المستخدم قبل أن يعمل تأثير الإفراغ.
    if (pendingUserMessage && !activeSessionId && all.length === 0) {
      return [pendingUserMessage];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [activeSessionId, storeMessages, viewHiddenCount, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  /**
   * T-1295 — سحب فقاعة المستخدم المتفائلة بعد أن يفشل **نقلُها** (‏`sendMessage`
   * أعاد `ok:false`، فالرسالة لم تغادر المتصفّح).
   *
   * الفقاعة تُضاف قبل أن يُعرف مصير الإرسال، وهو الصواب في المسار السليم. لكن
   * بقاءها بعد فشل النقل كذبٌ مكتمل: يراها المستخدم مُرسَلة فينتظر رداً لن يأتي
   * ثم يعيد الإرسال (نفس آفة B-518، من باب النقل لا الرفض). النصّ والصور
   * محفوظان في صندوق الصادر، فلا شيء يُفقد بالسحب.
   *
   * والمسار مساران لأن الفقاعة تعيش في مكانين: مخزن الجلسة حين يكون لها معرّف،
   * وحالةُ المكوّن (`pendingUserMessage`) قبل أن يُولَد.
   */
  const withdrawOptimisticUserMessage = useCallback((sessionId: string | null, clientMsgId: string) => {
    if (!sessionId) {
      setPendingUserMessage(null);
      return;
    }
    sessionStore.withdrawOptimisticUserRow(sessionId, clientMsgId);
  }, [sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement, manual = false) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;
      const error = sessionStore.getSessionSlot(selectedSession.id)?.historyError;
      if (error && (!manual || Date.now() < error.retryAt)) return false;

      const sessionProvider = selectedSession.__provider || 'claude';
      const requestSessionId = selectedSession.id;
      const epoch = historyEpochRef.current;
      const controller = new AbortController();
      paginationRequestsRef.current.add(controller);

      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        const result = await sessionStore.fetchMore(requestSessionId, {
          signal: controller.signal,
          provider: sessionProvider as LLMProvider,
          // DB-assigned projectId replaces the legacy folder-derived name.
          projectId: selectedProject.projectId,
          projectPath: selectedProject.fullPath || selectedProject.path || '',
          limit: MESSAGES_PER_PAGE,
        });
        if (selectedSessionIdRef.current !== requestSessionId || historyEpochRef.current !== epoch || !result.ok) return false;
        const { slot } = result;
        if (slot.serverMessages.length === 0) return false;

        pendingScrollRestoreRef.current = { height: previousScrollHeight, top: previousScrollTop };
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        setVisibleMessageCount((prev) => prev + MESSAGES_PER_PAGE);
        return true;
      } finally {
        paginationRequestsRef.current.delete(controller);
        if (selectedSessionIdRef.current === requestSessionId && historyEpochRef.current === epoch) {
          isLoadingMoreRef.current = false;
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);

    if (!allMessagesLoadedRef.current) {
      const scrolledNearTop = container.scrollTop < 100;
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [isNearBottom, loadOlderMessages]);

  /**
   * B-431: تُستدعى من إيماءة مستخدم حقيقية (wheel/touch) لا من حدث scroll
   * البرمجي. حدث scroll لا يميّز الإيماءة من `scrollTop = scrollHeight`، فلو
   * فسخنا التثبيت داخل handleScroll لفسخه التمرير الابتدائي نفسه. هنا نُنهي
   * التمرير الابتدائي فوراً: من مسّ العجلة يريد أن يقود بنفسه.
   */
  const handleUserScrollIntent = useCallback(() => {
    pendingInitialScrollRef.current = false;
    void handleScroll();
  }, [handleScroll]);

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) return;
    const { height, top } = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = top + Math.max(newScrollHeight - height, 0);
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    // Bug 6: switching sessions while a search-result scroll (from clicking a
    // search hit) was still in flight left `searchScrollActiveRef` stuck true
    // forever — findAndScroll's own setTimeout chain (up to 15 retries ×
    // 200ms, ~3s) kept running unabated and could still land on the NEW
    // session's DOM well after the switch, yanking its scroll position
    // around. And because the flag never cleared, the initial "scroll to
    // bottom" effect (below) saw it true and permanently skipped itself for
    // every session opened afterwards. Unconditionally cancel any pending
    // retry and clear the flag here so a session switch always starts clean.
    if (searchScrollTimeoutRef.current) {
      clearTimeout(searchScrollTimeoutRef.current);
      searchScrollTimeoutRef.current = null;
    }
    searchScrollActiveRef.current = false;

    pendingInitialScrollRef.current = true;
    initialScrollFramesRef.current = 0;
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      initialScrollFramesRef.current++;
      if (stableCount < 3 && initialScrollFramesRef.current < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom]);

  const cancelHistoryPipeline = useCallback(() => {
    historyEpochRef.current += 1;
    for (const controller of paginationRequestsRef.current) controller.abort();
    paginationRequestsRef.current.clear();
    historyRequestRef.current?.abort();
    historyRequestRef.current = null;
    historyIdleCancelRef.current?.();
    historyIdleCancelRef.current = null;
    historyQueueRef.current = {
      sessionId: null,
      epoch: historyEpochRef.current,
      running: false,
      fullQueued: false,
      light400Queued: false,
      fullDone: false,
      fullLimit: MESSAGES_PER_PAGE,
      };
  }, []);

  useEffect(() => cancelHistoryPipeline, [cancelHistoryPipeline]);

  const canEnrichHistoryNow = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    return connection?.saveData !== true
      && connection?.effectiveType !== 'slow-2g'
      && connection?.effectiveType !== '2g';
  }, []);

  /**
   * One coalescing scheduler owns every deferred history request. A full tail
   * and an active-run light window can never run concurrently, and repeated
   * paint/activity/interaction signals collapse to one request of each kind.
   */
  const drainHistoryQueue = useCallback(async () => {
    const queue = historyQueueRef.current;
    if (queue.running || !queue.sessionId) return;
    const sessionId = queue.sessionId;
    const epoch = queue.epoch;
    const slot = sessionStore.getSessionSlot(sessionId);
    if (!slot || slot.historyError || selectedSessionIdRef.current !== sessionId || historyEpochRef.current !== epoch) return;

    let kind: 'full' | 'light400' | null = null;
    if (queue.fullQueued && !queue.fullDone && canEnrichHistoryNow()) {
      kind = 'full';
      queue.fullQueued = false;
    } else if (queue.light400Queued) {
      kind = 'light400';
      queue.light400Queued = false;
    }
    if (!kind) return;

    queue.running = true;
    const controller = new AbortController();
    historyRequestRef.current = controller;
    const generation = sessionStore.beginHistoryRequest(sessionId);
    try {
      const result = await sessionStore.requestHistorySnapshot(sessionId, {
        limit: kind === 'light400' ? ACTIVE_RUN_HYDRATION_LIMIT : queue.fullLimit,
        offset: 0,
        payload: kind === 'light400' ? 'light' : 'full',
        revision: slot.historyRevision ?? undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted
        || selectedSessionIdRef.current !== sessionId
        || historyEpochRef.current !== epoch
        || !sessionStore.isHistoryRequestCurrent(sessionId, generation)) return;

      if (!result.ok) {
        sessionStore.setHistoryError(sessionId, result, 'deferred');
        queue.fullQueued = false;
        queue.light400Queued = false;
        return;
      }
      const snapshot = result.snapshot;
      // Full enrichment is valid only for the exact light revision it enriches.
      if (kind === 'full') {
        if (!slot.historyRevision
          || snapshot.revision !== slot.historyRevision
          || snapshot.payloadMode !== 'full') {
          sessionStore.setHistoryError(sessionId, { ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null }, 'deferred');
          return;
        }
        sessionStore.applyHistoryEnrichment(sessionId, snapshot);
        queue.fullDone = true;
      } else if (snapshot.payloadMode === 'light'
        && snapshot.revision === slot.historyRevision) {
        sessionStore.applyLightHistoryExpansion(sessionId, snapshot);
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        if (selectedSessionIdRef.current === sessionId && historyEpochRef.current === epoch
          && sessionStore.isHistoryRequestCurrent(sessionId, generation)) {
          sessionStore.setHistoryError(sessionId, historyTransportFailure(error), 'deferred');
          queue.fullQueued = false; queue.light400Queued = false;
        }
      }
    } finally {
      if (historyEpochRef.current === epoch) {
        queue.running = false;
        if (historyRequestRef.current === controller) historyRequestRef.current = null;
        if (queue.fullQueued || queue.light400Queued) void drainHistoryQueue();
      }
    }
  }, [canEnrichHistoryNow, sessionStore]);

  const queueHistoryWork = useCallback((kind: 'full' | 'light400', interaction = false) => {
    const queue = historyQueueRef.current;
    if (!queue.sessionId || selectedSessionIdRef.current !== queue.sessionId) return;
    if (sessionStore.getSessionSlot(queue.sessionId)?.historyError) return;
    if (kind === 'full') {
      if (interaction) {
        queue.fullDone = false;
        queue.fullLimit = ACTIVE_RUN_HYDRATION_LIMIT;
      }
      queue.fullQueued = !queue.fullDone;
    }
    else queue.light400Queued = true;
    void drainHistoryQueue();
  }, [drainHistoryQueue, sessionStore]);

  // An idle callback can fire while the tab is backgrounded. Keep the queued
  // work, then resume it when the document becomes visible instead of silently
  // leaving light placeholders for the rest of the session.
  useEffect(() => {
    const resumeWhenVisible = () => {
      if (document.visibilityState === 'visible') void drainHistoryQueue();
    };
    document.addEventListener('visibilitychange', resumeWhenVisible);
    return () => document.removeEventListener('visibilitychange', resumeWhenVisible);
  }, [drainHistoryQueue]);

  const scheduleHistoryEnrichment = useCallback(() => {
    historyIdleCancelRef.current?.();
    let cancelled = false;
    let timer: number | null = null;
    let idleId: number | null = null;
    const start = () => {
      if (!cancelled) queueHistoryWork('full');
    };
    const afterPaint = window.requestAnimationFrame(() => {
      const idleWindow = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
      };
      if (idleWindow.requestIdleCallback) {
        idleId = idleWindow.requestIdleCallback(start, { timeout: 1800 });
      } else {
        timer = window.setTimeout(start, 350);
      }
    });
    historyIdleCancelRef.current = () => {
      cancelled = true;
      window.cancelAnimationFrame(afterPaint);
      if (timer !== null) window.clearTimeout(timer);
      const idleWindow = window as Window & { cancelIdleCallback?: (id: number) => void };
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [queueHistoryWork]);

  // Main session loading effect — store-based
  useEffect(() => {
    // Wait for the application's existing health read. Starting a legacy full
    // request while capability is still unknown would force a second light
    // request and recreate the very waterfall this path removes.
    if (selectedSession && selectedProject && !lightHistoryCapability.resolved) return;
    if (!selectedSession || !selectedProject) {
      // A new provider run can be in flight before the router has a canonical
      // selectedSession. Keep the processing banner alive until complete/error.
      if (pendingViewSessionRef.current) {
        return;
      }

      resetStreamingState();
      pendingViewSessionRef.current = null;
      setClaudeStatus(null);
      setCanAbortSession(false);
      setIsLoading(false);
      setCurrentSessionId(null);
      sessionStorage.removeItem('cursorSessionId');
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      setIsLoadingSessionMessages(false);
      setIsLoadingMoreMessages(false);
      setIsLoadingAllMessages(false);
      isLoadingMoreRef.current = false;
      cancelHistoryPipeline();
      return;
    }

    const provider = (selectedSession.__provider || localStorage.getItem('selected-provider') as Provider) || 'claude';
    const sessionKey = `${selectedSession.id}:${selectedProject.projectId}:${provider}`;

    // A failed read needs explicit recovery; WS/property updates must not restart it.
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.getSessionSlot(selectedSession.id)?.historyError) return;

    // Skip if already loaded and fresh
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSession.id) && !sessionStore.isStale(selectedSession.id)) {
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSession.id;
    if (sessionChanged) {
      resetStreamingState();
      pendingViewSessionRef.current = null;
      setClaudeStatus(null);
      setCanAbortSession(false);
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    const heldSlot = sessionStore.getSessionSlot(selectedSession.id);
    setHasMoreMessages(heldSlot?.hasMore ?? false);
    setTotalMessages(heldSlot?.total ?? 0);
    isLoadingMoreRef.current = false;
    setIsLoadingMoreMessages(false);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
      setIsLoading(false);
    }

    setCurrentSessionId(selectedSession.id);
    if (provider === 'cursor') {
      sessionStorage.setItem('cursorSessionId', selectedSession.id);
    }

    // Check session status. ADR-041 (B-80): carry the highest stream `sequence`
    // this client has already seen for the session so the server can replay only
    // the delta (seq > lastSeq) on reconnect, avoiding duplicate text on the
    // active view. Defaults to 0 (replay-all) when unknown or the registry flag
    // is off server-side. getLastSeq is optional-chained so older store shapes
    // (and tests) degrade gracefully to 0.
    if (ws) {
      sendMessage({
        type: 'check-session-status',
        sessionId: selectedSession.id,
        provider,
        lastSeq: sessionStore.getLastSeq?.(selectedSession.id) ?? 0,
      });
    }

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch the small renderable tail first on capable servers. The request is
    // epoch/session guarded and aborted on navigation; old servers receive the
    // exact legacy full request (no payload query, no follow-up).
    cancelHistoryPipeline();
    const epoch = historyEpochRef.current;
    historyQueueRef.current = {
      sessionId: selectedSession.id,
      epoch,
      running: false,
      fullQueued: false,
      light400Queued: false,
      fullDone: false,
      fullLimit: MESSAGES_PER_PAGE,
      };
    setIsLoadingSessionMessages(true);
    const controller = new AbortController();
    historyRequestRef.current = controller;
    sessionStore.setStatus?.(selectedSession.id, 'loading');
    const requestSessionId = selectedSession.id;
    const generation = sessionStore.beginHistoryRequest(requestSessionId);
    const initialLoad = typeof sessionStore.requestHistorySnapshot === 'function'
      ? sessionStore.requestHistorySnapshot(requestSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
      payload: lightHistoryCapability.enabled ? 'light' : undefined,
      fallbackOnLightDisabled: lightHistoryCapability.enabled,
      signal: controller.signal,
    }).then(result => {
      if (controller.signal.aborted
        || selectedSessionIdRef.current !== requestSessionId
        || historyEpochRef.current !== epoch
        || !sessionStore.isHistoryRequestCurrent(requestSessionId, generation)) return;
      if (result.ok) {
        const slot = sessionStore.applyHistorySnapshot(requestSessionId, result.snapshot);
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
        // Missing markers mean an old server returned full, even if it ignored
        // `payload=light`; never issue an enrichment request in that case.
        if (result.snapshot.payloadMode === 'light' && result.snapshot.revision) {
          scheduleHistoryEnrichment();
        } else {
          historyQueueRef.current.fullDone = true;
        }
      } else {
        sessionStore.setHistoryError(requestSessionId, result, 'initial');
      }
      setIsLoadingSessionMessages(false);
    })
      : sessionStore.fetchFromServer(requestSessionId, {
        signal: controller.signal,
        provider: (selectedSession.__provider || provider) as LLMProvider,
        projectId: selectedProject.projectId,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
        limit: MESSAGES_PER_PAGE,
        offset: 0,
      }).then((result) => {
        if (selectedSessionIdRef.current !== requestSessionId || historyEpochRef.current !== epoch) return;
        setIsLoadingSessionMessages(false);
        if (!result.ok) return;
        const { slot } = result;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
        historyQueueRef.current.fullDone = true;
        setIsLoadingSessionMessages(false);
      });
    initialLoad.catch((error) => {
      if (controller.signal.aborted || selectedSessionIdRef.current !== requestSessionId || historyEpochRef.current !== epoch
        || !sessionStore.isHistoryRequestCurrent(requestSessionId, generation)) return;
      if (!(error instanceof Error && error.name === 'AbortError')) {
        sessionStore.setHistoryError(requestSessionId, historyTransportFailure(error), 'initial');
        setIsLoadingSessionMessages(false);
      }
    }).finally(() => {
      if (selectedSessionIdRef.current === requestSessionId && historyEpochRef.current === epoch
        && historyRequestRef.current === controller) {
        historyRequestRef.current = null;
        setIsLoadingSessionMessages(false);
      }
    });
    // تُنتظر قبل توسيع النافذة كي لا يدهس ردُّ الـ20 صفاً المتأخرُ النافذةَ
    // الأوسع (كلاهما يكتب `slot.serverMessages`).
    initialLoadRef.current = { sessionId: selectedSession.id, promise: initialLoad };
  }, [
    pendingViewSessionRef,
    resetStreamingState,
    setTokenBudget,
    selectedProject,
    selectedSession?.id,
    sendMessage,
    ws,
    sessionStore,
    lightHistoryCapability.enabled,
    lightHistoryCapability.resolved,
    cancelHistoryPipeline,
    scheduleHistoryEnrichment,
  ]);

  /* ---------------------------------------------------------------- */
  /*  لقطة نشاط الجلسة عبر REST (B-208)                                 */
  /* ---------------------------------------------------------------- */

  /**
   * توسيع نافذة الجلب مرّة واحدة بعد ثبوت أن الجلسة نشطة (بند 7).
   * تنتظر التحميل الافتتاحي إن كان جارياً حتى لا يدهسه، وتتخطّى العمل كلياً
   * حين تكون النافذة الحالية تغطي السجلّ (`hasMore === false`).
   */
  const hydrateActiveRunWindow = useCallback(async (sessionId: string) => {
    const pendingInitial = initialLoadRef.current;
    if (pendingInitial && pendingInitial.sessionId === sessionId) {
      await pendingInitial.promise.catch(() => undefined);
    }
    if (selectedSessionIdRef.current !== sessionId || !selectedProject) return;
    if (!sessionStore.has(sessionId)) return;
    const slot = sessionStore.getSlot(sessionId);
    if (!slot.hasMore) return;

    // The widened request is safe only under the explicit light-history
    // contract. An absent/disabled capability means the initial response is
    // authoritative full; issuing legacy full(400) afterwards recreates the
    // multi-megabyte bootstrap this pipeline exists to remove.
    if (!lightHistoryCapability.enabled || !slot.historyRevision) return;
    queueHistoryWork('light400');
  }, [lightHistoryCapability.enabled, queueHistoryWork, selectedProject, sessionStore]);

  /**
   * توسيع النافذة مربوط بـ**ثبوت النشاط من أي مصدر**، لا بنتيجة اللقطة.
   *
   * الخلل الذي يعالجه هذا الربط (مراجعة qa-critic، حرج 1): كان التوسيع مشروطاً
   * بـ`outcome === 'applied'` وحده. لكن `check-session-status` يُرسَل في تأثير
   * التحميل، وكل إطار `session-status` وارد يرفع epoch الجلسة ⇒ إن سبق الإطارُ
   * (‏~15ms) لقطةَ REST ‏(~40ms) عادت اللقطة `'stale'` فلا يُستدعى التوسيع
   * إطلاقاً ⇒ نافذة الـ20 ⇒ `agents: []`. أي: **كلما نجح المسار الأساسي فشل
   * البند 7**، ونتيجة غير حتمية تتأرجح بسباق شبكة.
   *
   * `isLoading` هو نقطة الالتقاء الوحيدة لكل مصادر «نشطة» (إطار `session-status`،
   * لقطة REST، ‏`session_created`، ‏`status`، مزامنة `processingSessions`)، فربط
   * التوسيع بحافة صعوده يجعله يعمل أياً كان الفائز بالسباق.
   *
   * الحارس: مرّة واحدة لكل (جلسة، مشروع) — لا تكرار على كل تشغيل لاحق في نفس
   * المحادثة (الجولات التالية تنمو نافذتها من إطارات WS الحيّة أصلاً).
   */
  useEffect(() => {
    if (!isLoading) return;
    const sessionId = selectedSession?.id ?? currentSessionId;
    if (!sessionId || !selectedProject) return;
    const key = `${sessionId}:${selectedProject.projectId}`;
    if (hydratedRunKeyRef.current === key) return;
    hydratedRunKeyRef.current = key;
    void hydrateActiveRunWindow(sessionId);
  }, [currentSessionId, hydrateActiveRunWindow, isLoading, selectedProject, selectedSession?.id]);

  /**
   * لقطة واحدة لحالة النشاط، **رافعة فقط** ومحروسة بالـepoch وبـsingle-flight.
   *
   * تُستدعى في ثلاث حالات: التحميل الأول، تحديث الصفحة، والتنقّل بين المحادثات
   * (بما فيه المسار الذي يخرج مبكراً عند مخزن دافئ فلا يُرسل `check-session-status`
   * أصلاً)، وكذلك مرّة عند إعادة الاتصال عبر `ChatInterface`. طلب وصل أثناء
   * لقطة جارية يُنفَّذ مرّة واحدة بعدها بدل أن يُهمَل أو يُطلق حلقة.
   *
   * تُعيد نتيجة اللقطة (أو `'skipped'` حين ابتلعها حارس single-flight) كي يبني
   * عليها المتصل قراراً قاطعاً — لا سيما ألّا يُنزِل المؤشّر على `'unknown'`.
   * لا تُوسِّع النافذة بنفسها: ذلك مربوط بحافة `isLoading` أعلاه.
   */
  const probeSessionActivity = useCallback(async (
    sessionId: string | null,
  ): Promise<SessionActivityProbeOutcome | 'skipped'> => {
    if (!sessionId) return 'skipped';
    if (activityProbeInFlightRef.current) {
      activityProbeQueuedRef.current = true;
      return 'skipped';
    }
    activityProbeInFlightRef.current = true;
    try {
      let again = true;
      let lastOutcome: SessionActivityProbeOutcome = 'unknown';
      while (again) {
        again = false;
        lastOutcome = await runSessionActivityProbe({
          sessionId,
          onActive: () => {
            // حارس تنقّل: لقطة لجلسة سابقة عادت بعد فتح محادثة أخرى يجب ألّا
            // ترفع مؤشّر المحادثة المعروضة الآن (حارس الـepoch يمنع التأخّر
            // الزمني، وهذا يمنع التأخّر «المكاني»).
            if (selectedSessionIdRef.current !== sessionId) return;
            setIsLoading(true);
            setCanAbortSession(true);
          },
        });
        // ردّ قاطع (لا فشل شبكة/نقطة غائبة) ⇒ المصدر الحتمي متاح فعلاً.
        if (lastOutcome === 'applied' || lastOutcome === 'idle') {
          setActivitySourceAvailable(true);
        }
        if (selectedSessionIdRef.current !== sessionId) break;
        if (activityProbeQueuedRef.current) {
          activityProbeQueuedRef.current = false;
          again = selectedSessionIdRef.current === sessionId;
        }
      }
      return lastOutcome;
    } finally {
      activityProbeInFlightRef.current = false;
    }
  }, []);

  // محاولة واحدة لكل محادثة تُفتح — لا إعادة إطلاق على تغيّر `processingSessions`
  // ولا polling. مستقلّ عن تأثير التحميل أعلاه عمداً: ذاك يخرج مبكراً عند مخزن
  // دافئ (مسار التنقّل) فلا يستعلم عن الحالة إطلاقاً.
  useEffect(() => {
    const sessionId = selectedSession?.id ?? null;
    if (!sessionId || !selectedProject) return;
    const key = `${sessionId}:${selectedProject.projectId}`;
    if (probedOpenKeyRef.current === key) return;
    probedOpenKeyRef.current = key;
    void probeSessionActivity(sessionId);
  }, [probeSessionActivity, selectedProject, selectedSession?.id]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  const externalHistoryUpdateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;
    const sessionId = selectedSession.id;
    const error = sessionStore.getSessionSlot(sessionId)?.historyError;
    if (isLoading || !canAutomaticallyReadHistory(error)) return;
    const key = `${sessionId}:${selectedProject.projectId}:${externalMessageUpdate}`;
    if (externalHistoryUpdateRef.current === key) return;
    externalHistoryUpdateRef.current = key;
    const controller = new AbortController();
    const epoch = historyEpochRef.current;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !controller.signal.aborted && selectedSessionIdRef.current === sessionId && historyEpochRef.current === epoch;

    const reloadExternalMessages = async () => {
      try {
        const provider = (localStorage.getItem('selected-provider') as Provider) || 'claude';

        // Skip store refresh during active streaming
        if (!isLoading) {
          const refreshed = await sessionStore.refreshFromServer(sessionId, {
            signal: controller.signal,
            provider: (selectedSession.__provider || provider) as LLMProvider,
            projectId: selectedProject.projectId,
            projectPath: selectedProject.fullPath || selectedProject.path || '',
          });

          if (refreshed && isCurrent() && Boolean(autoScrollToBottom) && isNearBottom()) {
            scrollTimer = setTimeout(() => { if (isCurrent()) scrollToBottom(); }, 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    void reloadExternalMessages();
    return () => { controller.abort(); if (scrollTimer) clearTimeout(scrollTimer); };
  }, [
    autoScrollToBottom,
    externalMessageUpdate,
    isNearBottom,
    scrollToBottom,
    selectedProject?.projectId,
    selectedProject?.fullPath,
    selectedProject?.path,
    selectedSession?.id,
    selectedSession?.__provider,
    sessionStore,
    isLoading,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const requestSessionId = selectedSession?.id;
    const epoch = historyEpochRef.current;
    const isCurrent = () => selectedSessionIdRef.current === requestSessionId && historyEpochRef.current === epoch;
    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
        const sessionProvider = selectedSession.__provider || 'claude';
        const controller = new AbortController();
        paginationRequestsRef.current.add(controller);
          try {
            // Load all messages into the store for search navigation
            const result = await sessionStore.fetchFromServer(selectedSession.id, {
              signal: controller.signal,
              provider: sessionProvider as LLMProvider,
              projectId: selectedProject.projectId,
              projectPath: selectedProject.fullPath || selectedProject.path || '',
              limit: null,
              offset: 0,
            });
            if (!isCurrent() || !result.ok) return;
            const { slot } = result;
            if (!slot.hasMore) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.total;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          } finally {
            paginationRequestsRef.current.delete(controller);
          }
      }
      if (!isCurrent()) return;
      setVisibleMessageCount(Infinity);

      const findAndScroll = (retriesLeft: number) => {
        if (!isCurrent()) return;
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
          searchScrollTimeoutRef.current = null;
        } else if (retriesLeft > 0) {
          searchScrollTimeoutRef.current = setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
          searchScrollTimeoutRef.current = null;
        }
      };

      searchScrollTimeoutRef.current = setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const sessionProvider = selectedSession.__provider || 'claude';
    if (sessionProvider !== 'claude' && sessionProvider !== 'codex' && sessionProvider !== 'gemini' && sessionProvider !== 'opencode') {
      setTokenBudget(null);
      return;
    }

    let cancelled = false;
    const fetchInitialTokenUsage = async () => {
      try {
        // Token usage endpoint is now keyed by the DB projectId.
        const params = new URLSearchParams({ provider: sessionProvider });
        const url = `/api/projects/${selectedProject.projectId}/sessions/${selectedSession.id}/token-usage?${params.toString()}`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const incoming = await response.json();
          if (!cancelled) storeTokenBudget((current) => newestContextUsage(current, incoming, 'hydration'));
        } else {
          // B-823: a failed lookup is NOT "no tokens used yet". Blanking to null
          // rendered the empty state, so a server-side transcript miss read as a
          // brand-new session. The marker carries no counts, so every consumer
          // that reads through `?? 0` behaves exactly as it did for null.
          const failure = await readUsageFailure(response);
          if (!cancelled) setTokenBudget(failure);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
        if (!cancelled) setTokenBudget({ unavailable: true, reason: 'request_failed' });
      }
    };
    fetchInitialTokenUsage();
    return () => { cancelled = true; };
  }, [selectedProject, selectedSession?.id, selectedSession?.__provider, setTokenBudget]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  // Bug 2: this had no dependency array, so it read scrollHeight/scrollTop
  // (forcing a synchronous layout reflow) after EVERY render of the parent
  // ChatInterface — including renders unrelated to messages/scroll, such as
  // every composer keystroke (setInput lives in the same component tree).
  // Scoped to the same triggers as the paired effect below (which consumes
  // this recorded position) so the two stay co-scheduled.
  useEffect(() => {
    if (!autoScrollToBottom && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
    }
  }, [autoScrollToBottom, chatMessages.length, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current) return;

    if (autoScrollToBottom) {
      if (!isUserScrolledUp) setTimeout(() => scrollToBottom(), 50);
      return;
    }

    const container = scrollContainerRef.current;
    const prevHeight = scrollPositionRef.current.height;
    const prevTop = scrollPositionRef.current.top;
    const newHeight = container.scrollHeight;
    const heightDiff = newHeight - prevHeight;
    if (heightDiff > 0 && prevTop > 0) container.scrollTop = prevTop + heightDiff;
  }, [autoScrollToBottom, chatMessages.length, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const activeViewSessionId = selectedSession?.id || currentSessionId;
    if (!activeViewSessionId || !processingSessions) return;
    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing && !isLoading) {
      setIsLoading(true);
      setCanAbortSession(true);
    }
  }, [currentSessionId, isLoading, processingSessions, selectedSession?.id]);

  // "Load all" overlay
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoadingMoreMessages;

    if (wasLoading && !isLoadingMoreMessages && hasMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(true);
      loadAllOverlayTimerRef.current = setTimeout(() => setShowLoadAllOverlay(false), 2000);
    }
    if (!hasMoreMessages && !isLoadingMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(false);
    }
    return () => { if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current); };
  }, [isLoadingMoreMessages, hasMoreMessages]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages || isLoadingMoreRef.current) return;
    const previousError = sessionStore.getSessionSlot(selectedSession.id)?.historyError;
    if (previousError && Date.now() < previousError.retryAt) return;
    const sessionProvider = selectedSession.__provider || 'claude';

    const requestSessionId = selectedSession.id;
    const epoch = historyEpochRef.current;
    const isCurrent = () => selectedSessionIdRef.current === requestSessionId && historyEpochRef.current === epoch;
    const controller = new AbortController();
    paginationRequestsRef.current.add(controller);
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
      const result = await sessionStore.fetchFromServer(requestSessionId, {
        signal: controller.signal,
        provider: sessionProvider as LLMProvider,
        projectId: selectedProject.projectId,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
        limit: null,
        offset: 0,
      });

      if (!isCurrent()) return;

      if (result.ok && !result.slot.hasMore) {
        const { slot } = result;
        allMessagesLoadedRef.current = true;
        if (container) {
          pendingScrollRestoreRef.current = { height: previousScrollHeight, top: previousScrollTop };
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => { if (isCurrent()) { setLoadAllJustFinished(false); setShowLoadAllOverlay(false); } }, 1000);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      paginationRequestsRef.current.delete(controller);
      if (isCurrent()) {
        isLoadingMoreRef.current = false;
        setIsLoadingAllMessages(false);
      }
    }
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  /** One explicit attempt; keep the visible window until a validated replacement arrives. */
  const retryHistory = useCallback(async () => {
    if (!activeSessionId || isLoadingSessionMessages || isLoadingAllMessages || isLoadingMoreRef.current) return;
    const failure = sessionStore.getSessionSlot(activeSessionId)?.historyError;
    if (!failure || Date.now() < failure.retryAt) return;
    if (!isHistoryRebaseFailure(failure) && failure.operation === 'older') {
      if (scrollContainerRef.current) await loadOlderMessages(scrollContainerRef.current, true);
      return;
    }
    if (!isHistoryRebaseFailure(failure) && failure.operation === 'all') {
      await loadAllMessages(); return;
    }
    const sessionId = activeSessionId;
    const epoch = historyEpochRef.current;
    setIsLoadingSessionMessages(true);
    const controller = new AbortController();
    historyRequestRef.current = controller;
    if (failure.operation === 'reconnect' && !isHistoryRebaseFailure(failure)) {
      await sessionStore.mergeTailFromServer(sessionId, { signal: controller.signal });
      if (selectedSessionIdRef.current === sessionId && historyEpochRef.current === epoch) setIsLoadingSessionMessages(false);
      if (historyRequestRef.current === controller) historyRequestRef.current = null;
      return;
    }
    const generation = sessionStore.beginHistoryRequest(sessionId);
    const enrich = failure.operation === 'deferred' && !isHistoryRebaseFailure(failure);
    const result = await sessionStore.requestHistorySnapshot(sessionId, {
      limit: MESSAGES_PER_PAGE, offset: 0, signal: controller.signal,
      revision: enrich ? sessionStore.getSessionSlot(sessionId)?.historyRevision ?? undefined : undefined,
      payload: enrich ? 'full' : lightHistoryCapability.enabled ? 'light' : undefined,
      fallbackOnLightDisabled: !enrich && lightHistoryCapability.enabled,
    });
    if (controller.signal.aborted || selectedSessionIdRef.current !== sessionId || historyEpochRef.current !== epoch) return;
    if (!sessionStore.isHistoryRequestCurrent(sessionId, generation)) {
      if (historyRequestRef.current === controller) {
        historyRequestRef.current = null;
        setIsLoadingSessionMessages(false);
      }
      return;
    }
    if (result.ok && enrich) {
      const revision = sessionStore.getSessionSlot(sessionId)?.historyRevision;
      if (result.snapshot.payloadMode === 'full' && revision && result.snapshot.revision === revision) {
        sessionStore.applyHistoryEnrichment(sessionId, result.snapshot);
      } else sessionStore.setHistoryError(sessionId, { ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null }, 'deferred');
    } else if (result.ok) {
      const slot = sessionStore.applyHistorySnapshot(sessionId, result.snapshot);
      setHasMoreMessages(slot.hasMore); setTotalMessages(slot.total);
      allMessagesLoadedRef.current = false; setAllMessagesLoaded(false);
      if (result.snapshot.payloadMode === 'light') {
        historyQueueRef.current.fullDone = false;
        historyQueueRef.current.fullLimit = MESSAGES_PER_PAGE;
        scheduleHistoryEnrichment();
      }
    } else sessionStore.setHistoryError(sessionId, result, failure.operation);
    setIsLoadingSessionMessages(false);
    if (historyRequestRef.current === controller) historyRequestRef.current = null;
  }, [activeSessionId, isLoadingSessionMessages, isLoadingAllMessages, sessionStore, loadOlderMessages,
    loadAllMessages, lightHistoryCapability.enabled, scheduleHistoryEnrichment]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  /**
   * B-431: نظير التمرير-إلى-الأعلى بضغطة. التمرير كان المُطلِق الوحيد لجلب
   * الصفحة الأقدم من الخادم، وloadEarlierMessages يوسّع النافذة المحلية فقط
   * فلا يُحضر شيئاً لم يُجلَب بعد.
   */
  const loadMoreMessages = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    pendingInitialScrollRef.current = false;
    topLoadLockRef.current = false;
    await loadOlderMessages(container, true);
  }, [loadOlderMessages]);

  return {
    historyError,
    retryHistory,
    chatMessages,
    responseTurnDurationTotalMs,
    addMessage,
    withdrawOptimisticUserMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadMoreMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    requestDeferredHistory: () => queueHistoryWork('full', true),
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    probeSessionActivity,
    activitySourceAvailable,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    handleUserScrollIntent,
  };
}

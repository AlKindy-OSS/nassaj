import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { useConversationCost } from '../hooks/useConversationCost';
import { ConversationCostContext } from '../context/ConversationCostContext';
import { TurnCostContext } from '../context/TurnCostContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import type { LLMProvider } from '../../../types/app';
import { useChatProviderState } from '../hooks/useChatProviderState';
import {
  bumpSessionActivityEpoch,
  shouldClearLoadingAfterRecovery,
  shouldShowManualRefresh,
} from '../hooks/sessionActivity';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers, type StreamBuffer } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { hasOutboxDeliveryEvidence, verifyOutboxReceipt } from '../utils/messageOutbox';
import { authenticatedFetch } from '../../../utils/api';
import { useBtwSideChannel } from '../hooks/useBtwSideChannel';
import { useMessageFork } from '../hooks/useMessageFork';
import { useSessionActiveModel } from '../hooks/useSessionActiveModel';
import {
  readSessionEngineProvider,
  stampSessionEngineProvider,
  type EngineProvider,
} from '../hooks/engineProviderSession';
import {
  getProviderCapabilities,
  getProviderDisplayName,
  PROVIDER_UI_CAPABILITIES,
} from '../constants/providerCapabilities';
import { useRunProgress } from '../hooks/useRunProgress';
import { SessionParticipantsBar } from '../../participants';
import { useSessionSkills } from '../../participants/useSessionSkills';
import { attachObservedSkills } from '../../participants/skillObservationHelpers';
import { useWorkflowStripAgents, useWorkflowStripStatus } from '../hooks/useWorkflowStripAgents';
import {
  useSessionStore,
  historyRetryDelay,
  canAutomaticallyReadHistory,
} from '../../../stores/useSessionStore';
import { useHistoryAutoRetry } from '../hooks/useHistoryAutoRetry';
import { useSessionProcessState } from '../../../stores/sessionProcessStateStore';
// انعكاس النموذج الفعّال ليقرأه الشريط العلوي: هو الدليل المستقلّ عن الجهاز على
// محور المحرّك (ختم المحرّك محليّ لكل متصفّح ولا يُحفَظ خادمياً).
import {
  setSelectedActiveModel as mirrorSelectedActiveModel,
  setSelectedEngineProvider as mirrorSelectedEngineProvider,
} from '../../../stores/selectedProviderStore';
import { useProviderAuthStatus } from '../../provider-auth/hooks/useProviderAuthStatus';
import { resolveIdleThresholdMs } from '../utils/idleThreshold';
import { resolveFallbackProvider, shouldResetProvider } from '../../provider-auth/providerAuthFilter';
import { useServerErrorBanner } from '../hooks/useServerErrorBanner';

import { buildTurnsMap } from './subcomponents/conversationCostFormat';
import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import { resolveEffectiveEngine } from './subcomponents/engineGuard';
import WsConnectionBadge from './subcomponents/WsConnectionBadge';
import CommandResultModal from './subcomponents/CommandResultModal';
import BtwOverlay from './subcomponents/BtwOverlay';


type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

function ChatInterface({
  sessionHeaderTarget,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  latestMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  showToolCalls,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onNewSession,
  onSelectedSessionClosedChange,
}: ChatInterfaceProps) {
  const { t } = useTranslation('chat');
  const { isConnected, wsStatus, controlFrames, controlEvents, streamFrames, reconnectEpoch } = useWebSocket();

  // Manual refresh state — prevents double-clicks and shows a spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Ephemeral error message surfaced from server error events with error codes.
  // ‏T-1294: العدّ يبدأ حين تصير الصفحة أمام المستخدم لا لحظة وصول الخطأ —
  // والمنطق (والتنظيف عند التفكيك) في `useServerErrorBanner`.
  const { serverError, showServerError: handleServerError } = useServerErrorBanner();

  // Guard: blocks concurrent reconnect-fetches that can trigger on rapid WS flaps.
  // One fetch per reconnect event; additional events within the same inflight
  // window are no-ops (the fetch already covers them idempotently).
  const reconnectInFlightRef = useRef(false);
  const reconnectControllerRef = useRef<AbortController | null>(null);
  const reconnectSessionRef = useRef(selectedSession?.id);
  reconnectSessionRef.current = selectedSession?.id;
  useEffect(() => () => {
    reconnectControllerRef.current?.abort();
    reconnectInFlightRef.current = false;
  }, [selectedSession?.id]);

  const sessionStore = useSessionStore();

  // Only canonical user identity proves delivery; text and assistant replies do not.
  const verifyMessageDelivered = useCallback(async (sessionId: string, clientMsgId: string, provider?: string, signal?: AbortSignal) => {
    const matches = () => hasOutboxDeliveryEvidence(
      sessionStore.getSessionSlot(sessionId)?.serverMessages ?? [], sessionId, clientMsgId,
    );
    if (matches()) return true;
    if (canAutomaticallyReadHistory(sessionStore.getSessionSlot(sessionId)?.historyError)) {
      await sessionStore.refreshFromServer(sessionId, { signal });
    }
    if (signal?.aborted) return 'unknown';
    if (matches()) return true;
    return verifyOutboxReceipt(sessionId, clientMsgId, provider, authenticatedFetch, signal);
  }, [sessionStore]);

  const streamTimerRef = useRef<number | null>(null);
  /**
   * مخزن البثّ **لكل جلسة على حدة**، لا سلسلة واحدة للتطبيق كله.
   *
   * كان مرجعاً نصّياً وحيداً: كل `stream_delta` يُضاف إليه أياً كانت جلسته، ثم
   * يُكتب المخزن **كاملاً** في صفّ البثّ للجلسة صاحبة آخر دفعة. فمتى عملت
   * محادثتان معاً — وهو الشائع هنا — ظهر نصّ إحداهما داخل الأخرى، ومسحُ
   * `stream_end` لإحداهما يبتر بثّ الأخرى. ولا يُصلح العرض إلا تحديث الصفحة
   * لأن السجلّ على الخادم سليم أصلاً.
   */
  const accumulatedStreamRef = useRef(new Map<string, StreamBuffer>());
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current.clear();
  }, []);

  const {
    providerAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus({ initialLoading: true });

  // TTL guard: avoid re-fetching auth status if last successful fetch was < 30 s ago.
  const lastAuthFetchRef = useRef<number>(0);
  const authFetchInFlightRef = useRef(false);

  /**
   * Refresh provider auth statuses.
   * @param force When true, skips the 30-second TTL so an explicit user action
   *   (e.g. the model-picker refresh button) always fetches a fresh status.
   *   Background/automatic callers omit this to avoid hammering the endpoint.
   */
  const refreshAuthStatus = useCallback(async (force?: boolean) => {
    if (authFetchInFlightRef.current) return;
    const now = Date.now();
    if (!force && now - lastAuthFetchRef.current < 30_000) return;
    authFetchInFlightRef.current = true;
    try {
      await refreshProviderAuthStatuses();
      lastAuthFetchRef.current = Date.now();
    } finally {
      authFetchInFlightRef.current = false;
    }
  }, [refreshProviderAuthStatuses]);

  // Fetch auth status once on mount.
  useEffect(() => {
    void refreshAuthStatus();
    // intentionally runs only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    provider,
    setProvider,
    engineProvider,
    setEngineProvider,
    selectClaudeEngineProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    antigravityModel,
    setAntigravityModel,
    opencodeModel,
    setOpenCodeModel,
    hermesModel,
    setHermesModel,
    kimiModel,
    setKimiModel,
    deepseekModel,
    setDeepSeekModel,
    glmModel,
    setGlmModel,
    qwenModel,
    setQwenModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    providerModelsFallbackProviders,
    hardRefreshProviderModels,
    selectProviderModel,
    restampSessionEngine,
    clearSessionModel,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  // Sanitize selected provider after auth status resolves: if the current
  // provider is definitively not installed (installed===false, no error, not
  // loading), reset to the first qualified (installed===true) provider.
  // fail-open: only act on a confirmed installed===false, never during loading.
  useEffect(() => {
    const currentStatus = providerAuthStatus[provider];
    if (!shouldResetProvider(currentStatus)) return;

    // Find first qualified provider (installed===true), defaulting to 'claude'.
    // Derived from PROVIDER_UI_CAPABILITIES (Record<LLMProvider, …>, so TS
    // enforces every provider is a key) instead of a hand-maintained literal —
    // the previous hard-coded list omitted kimi/deepseek/glm (and sakana),
    // so a user on one of those could be silently bounced to an unauthenticated
    // 'claude' the moment its auth status resolved to installed===false.
    // resolveFallbackProvider drops the globally disabled ids from that order
    // (gemini/deepseek/glm): they are absent from the picker and refused at the
    // dispatch seam, so landing on one is a dead end, not a fallback.
    const fallback = resolveFallbackProvider(
      Object.keys(PROVIDER_UI_CAPABILITIES) as LLMProvider[],
      providerAuthStatus,
    );

    setProvider(fallback);
    localStorage.setItem('selected-provider', fallback);
  }, [providerAuthStatus, provider, setProvider]);

  // Provider used for in-conversation display (message logos, status badge).
  // Prefer the open session's own provider so an old Claude session keeps its
  // Claude branding even if the global (composer) selection is Antigravity.
  const displayProvider = selectedSession?.__provider ?? provider;

  // B-249: النموذج الفعّال للجلسة يُجلَب من الخادم لا يُشتقّ من الحالة العامة.
  // الحالة العامة (claudeModel/…) لا تعكس ما خزَّنه resolveResumeModel للجلسة —
  // جلسة بُدِّلت إلى X تعرض Y بعد remount بينما الاستئناف يستعمل X فعلاً.
  //
  // `fallbackGlobalModel`: قيمة المنتقي العام حين لا sessionId أو فشل الجلب.
  // تُستعمل لإظهار «النموذج الذي سيُطبَّق على الدور الأول» في جلسة جديدة.
  const fallbackGlobalModel = useMemo(() => {
    const dp = displayProvider;
    if (dp === 'cursor') return cursorModel;
    if (dp === 'codex') return codexModel;
    if (dp === 'gemini') return geminiModel;
    if (dp === 'antigravity') return antigravityModel;
    if (dp === 'opencode') return opencodeModel;
    if (dp === 'hermes') return hermesModel;
    if (dp === 'kimi') return kimiModel;
    if (dp === 'deepseek') return deepseekModel;
    if (dp === 'glm') return glmModel;
    if (dp === 'qwen') return qwenModel;
    return claudeModel;
  }, [displayProvider, claudeModel, cursorModel, codexModel, geminiModel,
      antigravityModel, opencodeModel, hermesModel, kimiModel, deepseekModel, glmModel, qwenModel]);

  const {
    historyError,
    retryHistory,
    chatMessages,
    responseTurnDurationTotalMs,
    addMessage,
    withdrawOptimisticUserMessage,
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
    requestDeferredHistory,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    probeSessionActivity,
    activitySourceAvailable,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleUserScrollIntent,
  } = useChatSessionState({
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
  });

  // T-1660: automatic recovery for a sticky "unavailable" history banner —
  // schedules capped-backoff retries and reads immediately on WS reconnect,
  // `online`, and tab visibility regain. See useHistoryAutoRetry for the full
  // rationale; retryHistory owns the per-operation path and de-dupes reads.
  const { recoverHistoryNow } = useHistoryAutoRetry({
    sessionId: selectedSession?.id,
    historyError,
    retryHistory,
    readHistoryError: useCallback(
      (id: string) => sessionStore.getSessionSlot(id)?.historyError ?? null,
      [sessionStore],
    ),
  });

  // B-249: مصدر الحقيقة الفعلي للنموذج — من الخادم لا من الحالة العامة.
  // sessionId = currentSessionId (من useChatSessionState) أو selectedSession.id.
  const sessionActiveModelId = currentSessionId || selectedSession?.id || null;
  /**
   * B-ENG / B-251: ختم المحرّك للجلسة المفتوحة تحديداً — لا الاختيار العام.
   * null = مسار Anthropic الرسمي العادي.
   * غير null = جسد Claude موجَّه إلى نقطة مورّد.
   * يُعاد تقييمه تلقائياً عند تغيّر sessionActiveModelId (درس T-915/T-882).
   *
   * B-352: صار **حالةً** لا useMemo، لأن الختم لم يعد يُكتب مرّة واحدة عند
   * الإنشاء: المبدّل صار يعيد ختمه وسط المحادثة، وuseMemo على معرّف الجلسة
   * وحده لا يلتقط كتابةً في localStorage فتبقى الواجهة تعرض المحرّك القديم
   * بينما الدور التالي يذهب إلى الجديد.
   */
  const [sessionEngineStamp, setSessionEngineStamp] = useState<string | null>(null);

  /**
   * isImageCropping — صحيح أثناء فتح مودال القص أو ترميز الناتج.
   * يُعطّل زر الإرسال (شرط qa-critic 7).
   */
  const [isImageCropping, setIsImageCropping] = useState(false);
  useEffect(() => {
    setSessionEngineStamp(
      sessionActiveModelId ? readSessionEngineProvider(sessionActiveModelId) : null,
    );
  }, [sessionActiveModelId]);

  const {
    displayModel: sessionCurrentModel,
    setDisplayModel: setSessionCurrentModel,
    changed: sessionModelChanged,
    resetOverride: resetSessionModelOverride,
  } = useSessionActiveModel(displayProvider, sessionActiveModelId, fallbackGlobalModel);

  // عكس النموذج الفعّال في المتجر الانعكاسي (نفس نمط المزوّد والمحرّك): مكوّنٌ
  // بعيد كالهيدر يحتاجه ليعرف مورّد الفوترة الحقيقي، بلا prop-drilling وبلا
  // جلبٍ ثانٍ لنفس القيمة.
  useEffect(() => {
    mirrorSelectedActiveModel(sessionCurrentModel ?? null);
  }, [sessionCurrentModel]);

  // ومعه المحرّك **المُحلّ** لا الختم الخام: `resolveEffectiveEngine` (وحدة
  // engineGuard المشتركة، ‏B-311/B-312) = الختم ∪ الاستنباط من كتالوج المحرّك.
  // هنا وحده تتوفّر مدخلاتها الأربعة (الختم، الجسد، النموذج الفعّال، الكتالوج)،
  // ولذلك يُعكَس من هنا لا من useChatProviderState: كاتبٌ واحد لهذه الفتحة فلا
  // تتقافز القيمة بين مصدرين. والهيدر يستهلكها ليعرف **جهة الفوترة** الحقيقية.
  useEffect(() => {
    mirrorSelectedEngineProvider(
      resolveEffectiveEngine(engineProvider, displayProvider, sessionCurrentModel ?? '', providerModelCatalog),
    );
  }, [engineProvider, displayProvider, sessionCurrentModel, providerModelCatalog]);

  // T-1028 / B-247 / B-249: تبديل نموذج الجلسة — تفاؤلي ثم مصالحة مع الخادم.
  // يستعمل displayProvider لا provider العام (B-247) وsetSessionCurrentModel
  // للتحديث الفوري (B-249 optimistic).
  /**
   * B-352: المحوران يتحرّكان معاً — النموذج **ومحرّكه**.
   *
   * الحارس القديم عطّل المبدّل كلياً على أي جلسة محرَّكة، مبنيّاً على أن كتابة
   * معرّف Claude في جلسة موجَّهة إلى z.ai/Moonshot تُنتج دوراً فاشلاً — وهذا
   * صحيح ما دام الختم ثابتاً. لكن الختم ليس ثابتاً: يُقرأ في
   * dispatchProviderCommand لكل دور على حدة، فالمنع كان يقفل باباً مفتوحاً
   * فعلاً (نُقض ميدانياً على transcript واحد ضمّ kimi-k3 ثم kimi-k2.6 ثم
   * claude-opus-5 بنفس معرّف الجلسة).
   *
   * فالعلاج ليس المنع بل **الاقتران**: كل صفّ في المبدّل يحمل محرّكه، والاختيار
   * يعيد ختم المحرّك ثم يثبّت النموذج. لا يبقى تركيبٌ يُرسَل فيه معرّف لا يعرفه
   * المحرّك العامل، ويبقى القرار للمستخدم.
   *
   * `engine === undefined` (مستدعٍ قديم) = لا تمسّ المحور الثاني إطلاقاً؛
   * `null` = المسار الرسمي (Anthropic)؛ معرّف مورّد = وجّه الدور التالي إليه.
   */
  const handleChangeSessionModel = useCallback(async (
    model: string,
    engine?: EngineProvider,
  ): Promise<{ scope: 'session' | 'default'; model: string }> => {
    const sid = currentSessionId || selectedSession?.id || null;
    const previousModel = sessionCurrentModel;

    // تحديث تفاؤلي: المستخدم يرى أثر نقرته فوراً
    setSessionCurrentModel(model);

    // ADR-099/T-1237: عبورُ محورِ المحرّك على جلسة قائمة ليس تثبيتَ نموذج.
    //
    // الختم العميلي وحده لا ينقل شيئاً: الخادم يقرأ sessions.engine_provider
    // ويفوز به (ADR-088)، و`null` في الحمولة تعني «لا إشارة» لا «رسمي» — وهذه
    // الفجوة التعبيرية بعينها هي ما جعل اختيار Opus على جلسة GLM يبقى على z.ai
    // (B-433). فالنقل يمرّ بالعقد الخادمي، والختم العميلي يتبعه لا يسبقه.
    const engineAxisMoves =
      engine !== undefined && sid && engine !== readSessionEngineProvider(sid);
    if (engineAxisMoves && sid) {
      try {
        const moved = await restampSessionEngine(
          sid,
          engine ?? 'anthropic',
          model,
          // بلا بادئة `chat.` — الـnamespace محدَّد في useTranslation('chat')
          // أعلاه، فإضافتها تبحث عن chat.chat.* فيسقط i18next إلى طباعة
          // المفتاح نفسه في نافذة التأكيد.
          (turns) => window.confirm(t('engineSwitch.exportWarning', { turns })),
        );
        setSessionCurrentModel(moved.model);
        stampSessionEngineProvider(sid, engine ?? null);
        setSessionEngineStamp(engine ?? null);
        return { scope: 'session', model: moved.model };
      } catch (e) {
        setSessionCurrentModel(previousModel);
        throw e;
      }
    }

    try {
      const result = await selectProviderModel(displayProvider as LLMProvider, model, sid);
      // مصالحة: قيمة مؤكَّدة من الخادم
      setSessionCurrentModel(result.model);

      // المحور الثاني بعد نجاح الأول فقط: فشلُ POST يترك الختم كما كان، فلا
      // تبقى جلسة موسومة بمحرّك لم يُثبَّت له نموذج.
      if (engine !== undefined) {
        if (sid) {
          stampSessionEngineProvider(sid, engine);
          setSessionEngineStamp(engine);
        } else if (engine) {
          // لا جلسة بعد: الاختيار افتراضٌ للمحادثة القادمة، وهو نفس عقد
          // ProviderSelectionEmptyState (الجسد claude + المحرّك + النموذج).
          selectClaudeEngineProvider(engine, result.model);
        } else {
          setEngineProvider(null);
        }
      }

      // B-251: أعِد النطاق الفعلي للمبدّل كي يعرضه في شارة التأكيد
      return { scope: result.scope, model: result.model };
    } catch (e) {
      // POST فشل → تراجع للقيمة السابقة
      setSessionCurrentModel(previousModel);
      throw e; // يُعيد الإغلاق الفوري في InlineModelSwitcher
    }
  }, [selectProviderModel, restampSessionEngine, t, displayProvider, currentSessionId, selectedSession?.id,
      sessionCurrentModel, setSessionCurrentModel, selectClaudeEngineProvider,
      setEngineProvider]);

  /**
   * B-252: يمسح تثبيت النموذج الصريح للجلسة (DELETE endpoint).
   * يُعيد النموذج الذي سيسري بعد المسح (افتراضي المزوّد الحالي).
   */
  const handleClearSessionModel = useCallback(async (): Promise<{ model: string }> => {
    const sid = currentSessionId || selectedSession?.id || null;
    if (!sid) {
      return { model: sessionCurrentModel };
    }
    try {
      const result = await clearSessionModel(displayProvider, sid);
      // تحديث الحالة بلا جلب إضافي
      resetSessionModelOverride(result.model);
      return { model: result.model };
    } catch {
      // فشل DELETE → نُعيد النموذج الحالي ونترك الحالة كما هي
      return { model: sessionCurrentModel };
    }
  }, [clearSessionModel, displayProvider, currentSessionId, selectedSession?.id,
      sessionCurrentModel, resetSessionModelOverride]);

  // Frozen-session indicator: pause the status spinner while the underlying
  // provider process is kill -STOP'd (state 'T'), instead of spinning forever.
  const sessionProcessState = useSessionProcessState(currentSessionId ?? selectedSession?.id ?? null);
  const isSessionFrozen = sessionProcessState === 'frozen';

  // T-849 (+ الجزء العميلي من T-881): قناة «/btw» الجانبية. تستقبل إطارات btw-*
  // من نفس فتحة latestMessage وتعرضها في overlay مستقل — بلا مساس بسجلّ المحادثة
  // (useChatRealtimeHandlers يتجاهل إطارات btw-* لأنها بلا حقل kind). تُستدعى قبل
  // useChatComposerState كي يُمرَّر startBtwQuery إليه كمُعترِض التوجيه.
  const closeBtwRef = useRef<(() => void) | null>(null);
  //
  // T-1090: نجاح الفرك ← نغلق الـoverlay وننتقل إلى المحادثة الجديدة، فيتابع
  // المستخدم الحوار الجانبي فيها بدل بقائه سؤالاً معزولاً.
  const handleBtwForked = useCallback(
    (forkedSessionId: string) => {
      closeBtwRef.current?.();
      onNavigateToSession?.(forkedSessionId);
    },
    [onNavigateToSession],
  );

  const {
    activeBtw,
    startBtwQuery,
    closeBtw,
    forkBtw,
  } = useBtwSideChannel({
    sessionId: currentSessionId ?? selectedSession?.id ?? null,
    latestMessage,
    sendMessage,
    onForked: handleBtwForked,
  });
  // closeBtw يُعرَّف بعد handleBtwForked، فنمرّره عبر ref لكسر الدورة.
  closeBtwRef.current = closeBtw;

  const handleMessageForked = useCallback(
    (forkedSessionId: string) => onNavigateToSession?.(forkedSessionId),
    [onNavigateToSession],
  );
  const handleMessageForkError = useCallback((code: string, message?: string) => {
    // Codes are intentionally rendered locally. The server's message is only
    // a fallback for a newer code the current client does not know yet.
    handleServerError(t(`messageFork.errors.${code}`, {
      defaultValue: message || t('messageFork.errors.fork_failed', {
        defaultValue: "Couldn't fork this reply — please try again.",
      }),
    }));
  }, [handleServerError, t]);
  const { forkFromMessage, isForking: isForkingMessage } = useMessageFork({
    sessionId: currentSessionId ?? selectedSession?.id ?? null,
    latestMessage,
    sendMessage,
    onForked: handleMessageForked,
    onError: handleMessageForkError,
  });

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    composerMode,
    setComposerMode,
    agentModeAvailable,
    coordinationLevel,
    setCoordinationLevel,
    coordinationLevelAvailable,
    isSubmitSealed,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    isCommandExecutionDisabled,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    setImageErrors,
    setUploadingImages,
    uploadingImages,
    imageErrors,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    handleInputChange,
    insertTextAtCursor,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    startFreshSession,
    commandModalPayload,
    closeCommandModal,
    executingCommand,
    sendError,
    outboxEntries,
    retryOutboxEntry,
    editOutboxEntry,
    deleteOutboxEntry,
    verifyOutboxEntry,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    displayProvider,
    engineProvider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    geminiModel,
    antigravityModel,
    opencodeModel,
    hermesModel,
    kimiModel,
    deepseekModel,
    glmModel,
    qwenModel,
    isLoading,
    canAbortSession,
    tokenBudget,
    sendMessage,
    onBtwQuery: startBtwQuery,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    withdrawOptimisticUserMessage,
    verifyMessageDelivered,
    outboxHistory: sessionStore.getSessionSlot(currentSessionId || selectedSession?.id || '')?.serverMessages,
  });

  /**
   * handleReplaceImage — يستبدل الصورة الأصلية بالمقصوصة.
   *
   * يبحث بهوّية الكائن (File object identity) لا باسم الملف — شرط qa-critic 7:
   * إن غابت الصورة الأصلية من القائمة (مثلاً أزالها المستخدم أثناء القص)
   * يُغلق المودال بصمت.
   *
   * يُنظّف imageErrors وuploadingImages للاسم القديم — شرط qa-critic 9.
   */
  const handleReplaceImage = useCallback(
    (original: File, next: File) => {
      // شرط جودة: حجم الناتج المقصوص لا يتجاوز 5MB (نفس حد التحقق في useChatComposerState)
      if (next.size > 5 * 1024 * 1024) {
        setImageErrors((prev) => {
          const updated = new Map(prev);
          updated.set(original.name, 'File too large (max 5MB)');
          return updated;
        });
        // المودال مغلق فعلاً من ImageAttachment قبل استدعاء هذه الدالة
        return;
      }

      setAttachedImages((prev) => {
        const idx = prev.indexOf(original);
        if (idx === -1) return prev; // الصورة غير موجودة — تجاهل
        const updated = [...prev];
        updated[idx] = next;
        return updated;
      });
      // تنظيف حالات الرفع والأخطاء للاسم القديم
      setImageErrors((prev) => {
        if (!prev.has(original.name)) return prev;
        const next2 = new Map(prev);
        next2.delete(original.name);
        return next2;
      });
      setUploadingImages((prev) => {
        if (!prev.has(original.name)) return prev;
        const next2 = new Map(prev);
        next2.delete(original.name);
        return next2;
      });
    },
    [setAttachedImages, setImageErrors, setUploadingImages],
  );

  // On WebSocket reconnect, recover any messages that were produced while the
  // socket was dead (stream-orphaned payloads): re-register as a live mirror
  // so future events are delivered, then merge the transcript tail via REST so
  // already-completed content is not stuck in the frozen spinner.
  //
  // Two-step strategy:
  //   1. check-session-status — re-registers this socket as a session mirror
  //      (future WS payloads arrive) and triggers RingBuffer differential replay
  //      (fills the gap between socket death and now).
  //   2. mergeTailFromServer — idempotent REST merge of the last 20 messages:
  //      preserves live content until the same run's persisted reply covers it,
  //      then merges messages by id (lightweight and safe to retry).
  //      Independent of writer-swap success: works whether the run is active or
  //      already complete (no-writer). One transient retry respects Retry-After;
  //      permanent failures remain visible for manual recovery.
  // Ordering: WS re-register first so we don't miss the tail of an active run
  // during the REST round-trip; REST merge second to catch already-complete runs.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    // Idempotency guard: concurrent calls from rapid WS flaps share one fetch.
    if (reconnectInFlightRef.current) return;
    reconnectInFlightRef.current = true;
    const controller = new AbortController();
    reconnectControllerRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && reconnectSessionRef.current === selectedSession.id;
    try {
      const providerVal = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
      const resolvedProvider = (selectedSession.__provider || providerVal) as LLMProvider;

      // Step 1: re-register as mirror + trigger server-side RingBuffer replay
      // (seq > lastSeq). No-op when SESSION_REGISTRY_claude is off — REST merge
      // covers that case anyway.
      sendMessage({
        type: 'check-session-status',
        sessionId: selectedSession.id,
        provider: resolvedProvider,
        lastSeq: sessionStore.getLastSeq?.(selectedSession.id) ?? 0,
      });

      // Step 2: merge the tail idempotently.
      // Keep live content through failed/lagging reads, and fetch only the last
      // 20 messages. A matching persisted run can retire the captured live row;
      // newer deltas arriving during this request are preserved.
      const opts = {
        signal: controller.signal,
        provider: resolvedProvider,
        // Use DB projectId; legacy folder-derived projectName is no longer accepted here.
        projectId: selectedProject.projectId,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
      };
      const previousFailure = sessionStore.getSessionSlot(selectedSession.id)?.historyError;
      const mayRead = canAutomaticallyReadHistory(previousFailure);
      const ok = mayRead ? await sessionStore.mergeTailFromServer(selectedSession.id, opts) : true;

      if (!isCurrent()) return;
      const failure = sessionStore.getSessionSlot(selectedSession.id)?.historyError;
      const retryDelay = !ok && failure ? historyRetryDelay(failure) : null;
      if (retryDelay !== null) {
        await new Promise<void>((resolve) => {
          const finish = () => { window.clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
          const timer = window.setTimeout(finish, retryDelay);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
        if (!isCurrent()) return;
        await sessionStore.mergeTailFromServer(selectedSession.id, opts);
      }
      if (!isCurrent()) return;

      // B-208 (بند 6 + حرج 3): كان المسح غير مشروط ويعتمد على مصادفة أن ترفعه
      // مزامنةُ `processingSessions` مجدداً (وهي أحادية الاتجاه: ترفع ولا
      // تُنزل). صار داخل نظام الـepoch وبقرار **قاطع** فقط: نرفع epoch الجلسة
      // (فتُهمَل أي لقطة أُطلقت قبل المسار)، نطلق لقطة، ولا نُنزِل المؤشّر إلا
      // على `'idle'` صريحة. على `'unknown'` (النقطة غير منشورة بعد / شبكة)
      // نترك المؤشّر كما هو — إنزاله كان يُخفي البطاقة وزر STOP لبقية التشغيل.
      bumpSessionActivityEpoch(selectedSession.id);
      const outcome = await probeSessionActivity(selectedSession.id);
      if (isCurrent() && shouldClearLoadingAfterRecovery(outcome)) {
        setIsLoading(false);
        setCanAbortSession(false);
      }
    } finally {
      if (reconnectControllerRef.current === controller) {
        reconnectInFlightRef.current = false;
        reconnectControllerRef.current = null;
      }
      // T-1660: a reconnect means the network is back — retry a still-sticky
      // banner even if its backoff cap was already spent during the outage.
      // (mergeTailFromServer above only clears a 'reconnect'-operation error;
      // an 'initial'/'older'/'deferred' failure needs its own operation retried.)
      recoverHistoryNow();
    }
  }, [
    selectedProject,
    selectedSession,
    sessionStore,
    sendMessage,
    setIsLoading,
    setCanAbortSession,
    probeSessionActivity,
    recoverHistoryNow,
  ]);

  // Manual refresh: re-fetches messages from the server and, if the WebSocket
  // is not connected, the auto-reconnect mechanism will handle it on its own —
  // we only need to trigger the message fetch here.
  const handleManualRefresh = useCallback(async () => {
    if (isRefreshing || !selectedProject || !selectedSession) return;
    setIsRefreshing(true);
    try {
      await handleWebSocketReconnect();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, selectedProject, selectedSession, handleWebSocketReconnect]);

  // B-518: رسالة رفضها الخادم قبل التنفيذ تعود إلى المُؤلِّف بدل أن تبقى
  // فقاعةً كاذبة. لا نكتب فوق ما بدأ المستخدم كتابته بعد الرفض.
  const handleRejectedSendRestore = useCallback((text: string) => {
    setInput((current) => (current.trim() ? current : text));
  }, [setInput]);

  useChatRealtimeHandlers({
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
    onWebSocketReconnect: handleWebSocketReconnect,
    onServerError: handleServerError,
    onRejectedSendRestore: handleRejectedSendRestore,
    sessionStore,
  });

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Real start of the current run: timestamp of the last user message that
  // triggered it. Transcript messages keep their original timestamps, so after
  // a page refresh onto a still-processing session the elapsed counter in
  // ClaudeStatus resumes from the true value instead of restarting at 0.
  const runStartedAt = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const message = chatMessages[i];
      // Skip local-command stdout: user-role transcript artifacts, not the
      // message that started the run.
      if (message.type !== 'user' || message.isLocalCommandStdout) continue;
      const ts = new Date(message.timestamp as string | number | Date).getTime();
      return Number.isFinite(ts) ? ts : null;
    }
    return null;
  }, [chatMessages]);

  // Task/agent progress snapshot for the ClaudeStatus indicators. Scans the
  // FULL transcript (not the windowed visibleMessages) once per change; reads no
  // clock, so it never recomputes on the per-second tick. Empty while idle.
  const baseRunProgress = useRunProgress(chatMessages, isLoading);
  const workflowStripAgents = useWorkflowStripAgents(currentSessionId || selectedSession?.id || null);
  const sessionSkills = useSessionSkills(selectedSession?.id ?? currentSessionId, displayProvider, isLoading || workflowStripAgents.some(agent => agent.status === 'running'), !isLoadingSessionMessages);
  const runProgress = useMemo(() => ({ ...baseRunProgress, agents: attachObservedSkills(baseRunProgress.agents, sessionSkills.projection, sessionSkills.stale) }), [baseRunProgress, sessionSkills.projection, sessionSkills.stale]);
  // Full-session total is returned independently of the current history page.
  // Never reconstruct it from visible messages or the cost snapshot.
  const completedWorkDurationMs = responseTurnDurationTotalMs;

  // Agents of this session's background workflows. Server-sourced (the polled
  // `/workflows/active` store), because a `Workflow` run leaves no container row
  // in the transcript for `useRunProgress` to find — the reason the strip stayed
  // empty for workflow-heavy sessions. Independent of `isLoading`: these keep
  // running long after the reply that launched them ended.
  const observedWorkflowAgents = useMemo(() => attachObservedSkills(workflowStripAgents, sessionSkills.projection, sessionSkills.stale), [workflowStripAgents, sessionSkills.projection, sessionSkills.stale]);
  // The verdict for those same rows. Same session key and same store, so the two
  // cannot describe different workflows.
  const workflowStripStatus = useWorkflowStripStatus(currentSessionId || selectedSession?.id || null);

  // كلفة المحادثة للشارة العلوية + خريطة الأدوار للتذييلات (T-1676 / B-1021).
  // نستدعي الخطّاف هنا بدل جلب ثانٍ في ConversationCostChip لأن المصدر
  // واحد: النتيجة تُمرَّر عبر ConversationCostContext (للشارة)
  // و TurnCostContext (للتذييلات).
  const { cost: turnCostData, status: costStatus, refresh: costRefresh } = useConversationCost(
    selectedSession?.id ?? currentSessionId ?? null,
    { isLoading, historyReady: !isLoadingSessionMessages },
  );
  const turnsMap = useMemo(() => buildTurnsMap(turnCostData), [turnCostData]);
  const conversationCostContextValue = useMemo(
    () => ({ cost: turnCostData, status: costStatus, refresh: costRefresh }),
    [turnCostData, costStatus, costRefresh],
  );
  // التحديث اليدوي يسترجع ذيل السجل أولاً، ثم يجدّد اللقطة التي تغذّي
  // الشريط العلوي وتذييلات الردود من المصدر نفسه.
  const handleManualRefreshWithCost = useCallback(async () => {
    await handleManualRefresh();
    costRefresh();
  }, [handleManualRefresh, costRefresh]);

  // حجم السياق الحالي لتنبيه خمول الجلسة (T-1764).
  // المصدر: tokenBudget.used (نفس TokenUsageSummary:379-381) لا cumulative tokens.
  // يُحسب فقط حين يدعم المزوّد عدّاد التوكنز؛ وإلّا null → جملة بلا رقم.
  const idleContextTokens = useMemo(() => {
    if (!getProviderCapabilities(displayProvider).tokenCounter.supported) return null;
    const usage = tokenBudget;
    const breakdown =
      usage?.breakdown && typeof usage.breakdown === 'object'
        ? (usage.breakdown as Record<string, unknown>)
        : null;
    const readNum = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const input = readNum(usage?.inputTokens ?? breakdown?.input);
    const output = readNum(usage?.outputTokens ?? breakdown?.output);
    const used = readNum(usage?.used) || (input + output);
    return used > 0 ? used : null;
  }, [displayProvider, tokenBudget]);

  // عتبة تنبيه الخمول حسب الهارنس (T-1765): مدة الكاش كما يعلنها المزوّد أو null
  // فلا تنبيه. لـClaude يقرؤها الخادم من usage.cache_creation ويضعها في tokenBudget.
  const claudeCacheTtlMinutes = typeof tokenBudget?.cacheTtlMinutes === 'number'
    ? tokenBudget.cacheTtlMinutes
    : null;
  const idleThresholdMs = useMemo(() => resolveIdleThresholdMs({
    provider: displayProvider,
    model: sessionCurrentModel,
    engine: resolveEffectiveEngine(engineProvider, displayProvider, sessionCurrentModel ?? '', providerModelCatalog),
    claudeCacheTtlMinutes,
  }), [displayProvider, sessionCurrentModel, engineProvider, providerModelCatalog, claudeCacheTtlMinutes]);

  // مخرج الطوارئ: القرار في دالّة صرفة مختبَرة (انظر التعليق عند موضع الزرّ).
  const showManualRefresh = shouldShowManualRefresh({
    hasHistoryError: Boolean(historyError),
    hasSession: Boolean(currentSessionId ?? selectedSession?.id),
    isLoading,
    activitySourceAvailable,
  });

  if (!selectedProject) {
    // T-224 (م0): getProviderDisplayName من الواصف — hermes/kimi/deepseek/glm تظهر
    // بأسمائها الصحيحة بدل «Claude» (المزوّدات المعروفة غير متأثرة بصرياً).
    const selectedProviderLabel = getProviderDisplayName(provider);

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ConversationCostContext.Provider value={conversationCostContextValue}>
    <TurnCostContext.Provider value={turnsMap}>
    <PermissionContext.Provider value={permissionContextValue}>
      <div data-chat-reading-surface style={{ backgroundColor: 'var(--chat-reading-surface, transparent)' }} className="flex h-full flex-col">
        {sessionHeaderTarget && createPortal(
          <SessionParticipantsBar
            key={selectedSession?.id ?? currentSessionId}
            skills={sessionSkills}
            sessionId={selectedSession?.id ?? currentSessionId ?? null}
            isLoading={isLoading}
            workDurationMs={completedWorkDurationMs}
            closed={selectedSession?.closed ?? false}
            onClosedChange={(closed) => {
              const sessionId = selectedSession?.id ?? currentSessionId;
              if (sessionId) onSelectedSessionClosedChange?.(sessionId, closed);
            }}
            historyReady={!isLoadingSessionMessages && (!selectedSession || currentSessionId === selectedSession.id)}
          />,
          sessionHeaderTarget,
        )}
        {/* Top floating column: WsConnectionBadge (when disconnected) + manual-refresh button.
            h-0 keeps it out of the flex-column flow so the messages scroll area can extend up
            to the top divider. Anchored to the messages pane's *full width* (the real window
            inline-end edge), NOT the composer's centered max-w-4xl column — the 7fc0307 wrapper
            made `end-10` land at the centred column's edge (≈ page middle on wide screens).
            The controls remain anchored beside the reading pane scrollbar. */}
        {/* B-208 (بند 10 + حرج 3): زرّ التحديث اليدوي مخرج الطوارئ الوحيد من
            مؤشّر عالق، لكن إظهاره أثناء تشغيل حيّ قبل توفّر مصدر حتمي يعيد رفع
            المؤشّر يقلبه إلى فخّ. القرار في `shouldShowManualRefresh` (دالّة
            صرفة مختبَرة): يظهر دائماً حين لا تشغيل، وأثناء التشغيل فقط بعد أن
            تُجيب `/activity` إجابة قاطعة — بوّابة ذاتية الشفاء بلا علم يدوي. */}
        {(wsStatus !== 'connected' || showManualRefresh) && (
          <div className="relative z-10 h-0">
            <div className="absolute end-[14px] top-2 flex flex-col items-center gap-1 sm:end-[18px]">
              {wsStatus !== 'connected' && <WsConnectionBadge status={wsStatus} />}
              {showManualRefresh && (
                <button
                  type="button"
                  onClick={handleManualRefreshWithCost}
                  disabled={isRefreshing}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  aria-label={isRefreshing ? t('refreshChat.refreshing', { defaultValue: 'Refreshing…' }) : t('refreshChat.button', { defaultValue: 'Refresh chat' })}
                  title={isRefreshing ? t('refreshChat.refreshing', { defaultValue: 'Refreshing…' }) : t('refreshChat.button', { defaultValue: 'Refresh chat' })}
                >
                  <RefreshCw
                    className={['h-3 w-3', isRefreshing ? 'animate-spin' : ''].join(' ').trim()}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
          </div>
        )}
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleUserScrollIntent}
          onTouchMove={handleUserScrollIntent}
          historyError={historyError}
          retryHistory={retryHistory}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          displayProvider={displayProvider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          engineProvider={engineProvider}
          setEngineProvider={setEngineProvider}
          onSelectClaudeEngineProvider={selectClaudeEngineProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
          antigravityModel={antigravityModel}
          setAntigravityModel={setAntigravityModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          hermesModel={hermesModel}
          setHermesModel={setHermesModel}
          kimiModel={kimiModel}
          setKimiModel={setKimiModel}
          deepseekModel={deepseekModel}
          setDeepSeekModel={setDeepSeekModel}
          glmModel={glmModel}
          setGlmModel={setGlmModel}
          qwenModel={qwenModel}
          setQwenModel={setQwenModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          providerModelsRefreshing={providerModelsRefreshing}
          providerAuthStatus={providerAuthStatus}
          onHardRefreshProviderModels={hardRefreshProviderModels}
          onRefreshAuthStatus={refreshAuthStatus}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadMoreMessages={loadMoreMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          onRequestDeferredHistory={requestDeferredHistory}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          onStartNewSession={startFreshSession}
          onForkFromMessage={forkFromMessage}
          isForkingMessage={isForkingMessage}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          showToolCalls={showToolCalls}
          selectedProject={selectedProject}
          isStreaming={isLoading}
          contextTokens={idleContextTokens}
          idleThresholdMs={idleThresholdMs}
          onNewSession={onNewSession}
        />

        <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={claudeStatus}
          isLoading={isLoading}
          isSubmitSealed={isSubmitSealed}
          isSessionFrozen={isSessionFrozen}
          runStartedAt={runStartedAt}
          runProgress={runProgress}
          workflowAgents={observedWorkflowAgents}
          workflowStatus={workflowStripStatus}
          onAbortSession={handleAbortSession}
          provider={provider}
          displayProvider={displayProvider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          composerMode={composerMode}
          setComposerMode={setComposerMode}
          agentModeAvailable={agentModeAvailable}
          coordinationLevel={coordinationLevel}
          setCoordinationLevel={setCoordinationLevel}
          coordinationLevelAvailable={coordinationLevelAvailable}
          tokenBudget={tokenBudget}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={chatMessages.length > 0}
          onScrollToBottom={scrollToBottomAndReset}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          onReplaceImage={handleReplaceImage}
          onCropStateChange={setIsImageCropping}
          isImageCropping={isImageCropping}
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          attachedFiles={attachedFiles}
          onRemoveFile={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingFiles={uploadingFiles}
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          isCommandDisabled={isCommandExecutionDisabled}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceInsert={insertTextAtCursor}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            // T-224 (م0): اسم العرض من الواصف — لا ترناريات مكرّرة.
            // مزوّد الجلسة المعروضة لا الاختيار العام: داخل جلسة Codex يجب ألّا
            // يظهر «ask Hermes anything» لمجرّد أن المزوّد العام hermes.
            provider: getProviderDisplayName(displayProvider),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          isWsConnected={isConnected}
          executingCommand={executingCommand}
          sendError={sendError ?? serverError}
          outboxEntries={outboxEntries}
          onOutboxRetry={retryOutboxEntry}
          onOutboxEdit={editOutboxEntry}
          onOutboxDelete={deleteOutboxEntry}
          onOutboxVerify={verifyOutboxEntry}
          sessionCurrentModel={sessionCurrentModel}
          providerModelCatalog={providerModelCatalog}
          onChangeSessionModel={handleChangeSessionModel}
          sessionId={sessionActiveModelId}
          sessionStartedAt={selectedSession?.created_at ?? null}
          sessionActiveModelChanged={sessionModelChanged}
          onClearSessionModel={handleClearSessionModel}
          sessionEngineProvider={sessionEngineStamp}
        />
      </div>

      <QuickSettingsPanel sessionProvider={displayProvider} />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        providerModelsFallbackProviders={providerModelsFallbackProviders}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
        sessionEngineProvider={sessionEngineStamp}
      />

      <BtwOverlay
        state={activeBtw}
        onClose={closeBtw}
        onFork={forkBtw}
        supportsFork={getProviderCapabilities(displayProvider).sideChannel.supportsFork === true}
      />
    </PermissionContext.Provider>
    </TurnCostContext.Provider>
    </ConversationCostContext.Provider>
  );
}

export default React.memo(ChatInterface);

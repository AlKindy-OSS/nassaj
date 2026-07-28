import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw } from 'lucide-react';

import { useParticipantsBar } from '../../../contexts/ParticipantsBarContext';
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
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useBtwSideChannel } from '../hooks/useBtwSideChannel';
import { useSessionActiveModel } from '../hooks/useSessionActiveModel';
import { readSessionEngineProvider } from '../hooks/engineProviderSession';
import { getProviderDisplayName, PROVIDER_UI_CAPABILITIES } from '../constants/providerCapabilities';
import { useRunProgress } from '../hooks/useRunProgress';
import { useWorkflowStripAgents } from '../hooks/useWorkflowStripAgents';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useSessionProcessState } from '../../../stores/sessionProcessStateStore';
import { useProviderAuthStatus } from '../../provider-auth/hooks/useProviderAuthStatus';
import { resolveFallbackProvider, shouldResetProvider } from '../../provider-auth/providerAuthFilter';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import WsConnectionBadge from './subcomponents/WsConnectionBadge';
import { SessionParticipantsBar } from '../../participants';
import CommandResultModal from './subcomponents/CommandResultModal';
import BtwOverlay from './subcomponents/BtwOverlay';


type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

/** Matches the `participants-bar-slide-up` animation duration in tailwind.config.js. */
const PARTICIPANTS_BAR_COLLAPSE_MS = 200;

/**
 * Drive the mount lifecycle of the participants bar so it can slide up on hide
 * yet stay fully unmounted while stably hidden (so its hook/polling never runs).
 *
 * - `shown === true`  → mounted, sliding down.
 * - `shown === false` → keeps the bar mounted for one short collapse animation,
 *   then unmounts it entirely.
 *
 * Returns `{ mounted, closing }`: render the bar only while `mounted`, and apply
 * the slide-up class while `closing`.
 */
function useCollapsibleMount(shown: boolean) {
  const [mounted, setMounted] = useState(shown);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (shown) {
      setClosing(false);
      setMounted(true);
      return;
    }
    if (!mounted) {
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, PARTICIPANTS_BAR_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
    // `mounted` is intentionally excluded: re-running on its change would
    // restart the timer mid-collapse. We only react to `shown` flipping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  return { mounted, closing };
}

function ChatInterface({
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
  hideToolCalls,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
}: ChatInterfaceProps) {
  const { t } = useTranslation('chat');
  const { showParticipantsBar, setShowParticipantsBar } = useParticipantsBar();
  const participantsBar = useCollapsibleMount(showParticipantsBar);
  const { isConnected, wsStatus, controlFrames } = useWebSocket();

  // Manual refresh state — prevents double-clicks and shows a spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Ephemeral error message surfaced from server error events with error codes.
  const [serverError, setServerError] = useState<string | null>(null);
  const serverErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guard: blocks concurrent reconnect-fetches that can trigger on rapid WS flaps.
  // One fetch per reconnect event; additional events within the same inflight
  // window are no-ops (the fetch already covers them idempotently).
  const reconnectInFlightRef = useRef(false);
  const handleServerError = useCallback((message: string) => {
    setServerError(message);
    if (serverErrorTimerRef.current) clearTimeout(serverErrorTimerRef.current);
    serverErrorTimerRef.current = setTimeout(() => setServerError(null), 6000);
  }, []);

  // Clean up the server-error auto-dismiss timer on unmount. (memory-leak fix)
  useEffect(() => {
    return () => {
      if (serverErrorTimerRef.current) {
        clearTimeout(serverErrorTimerRef.current);
        serverErrorTimerRef.current = null;
      }
    };
  }, []);

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
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
    return claudeModel;
  }, [displayProvider, claudeModel, cursorModel, codexModel, geminiModel,
      antigravityModel, opencodeModel, hermesModel, kimiModel, deepseekModel, glmModel]);

  const {
    chatMessages,
    addMessage,
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
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    probeSessionActivity,
    activitySourceAvailable,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
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

  // B-249: مصدر الحقيقة الفعلي للنموذج — من الخادم لا من الحالة العامة.
  // sessionId = currentSessionId (من useChatSessionState) أو selectedSession.id.
  const sessionActiveModelId = currentSessionId || selectedSession?.id || null;
  /**
   * B-ENG / B-251: ختم المحرّك للجلسة المفتوحة تحديداً — لا الاختيار العام.
   * null = مسار Anthropic الرسمي العادي.
   * غير null = جسد Claude موجَّه إلى نقطة مورّد → المبدّل يُعطَّل كلياً.
   * يُعاد تقييمه تلقائياً عند تغيّر sessionActiveModelId (درس T-915/T-882).
   */
  const sessionEngineStamp = useMemo(
    () => (sessionActiveModelId ? readSessionEngineProvider(sessionActiveModelId) : null),
    [sessionActiveModelId],
  );

  const {
    displayModel: sessionCurrentModel,
    setDisplayModel: setSessionCurrentModel,
    changed: sessionModelChanged,
    resetOverride: resetSessionModelOverride,
  } = useSessionActiveModel(displayProvider, sessionActiveModelId, fallbackGlobalModel);

  // T-1028 / B-247 / B-249: تبديل نموذج الجلسة — تفاؤلي ثم مصالحة مع الخادم.
  // يستعمل displayProvider لا provider العام (B-247) وsetSessionCurrentModel
  // للتحديث الفوري (B-249 optimistic).
  const handleChangeSessionModel = useCallback(async (
    model: string,
  ): Promise<{ scope: 'session' | 'default'; model: string }> => {
    const sid = currentSessionId || selectedSession?.id || null;
    const previousModel = sessionCurrentModel;

    // تحديث تفاؤلي: المستخدم يرى أثر نقرته فوراً
    setSessionCurrentModel(model);

    try {
      const result = await selectProviderModel(displayProvider as LLMProvider, model, sid);
      // مصالحة: قيمة مؤكَّدة من الخادم
      setSessionCurrentModel(result.model);
      // B-251: أعِد النطاق الفعلي للمبدّل كي يعرضه في شارة التأكيد
      return { scope: result.scope, model: result.model };
    } catch (e) {
      // POST فشل → تراجع للقيمة السابقة
      setSessionCurrentModel(previousModel);
      throw e; // يُعيد الإغلاق الفوري في InlineModelSwitcher
    }
  }, [selectProviderModel, displayProvider, currentSessionId, selectedSession?.id,
      sessionCurrentModel, setSessionCurrentModel]);

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
  const {
    activeBtw,
    startBtwQuery,
    closeBtw,
  } = useBtwSideChannel({
    sessionId: currentSessionId ?? selectedSession?.id ?? null,
    latestMessage,
    sendMessage,
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
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
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
    sendError,
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
  });

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
  //      always clears the streaming placeholder first (so the frozen bubble
  //      disappears even when the fetch fails), then merges novel messages by id
  //      into serverMessages (lightweight, no duplicates, safe to retry).
  //      Independent of writer-swap success: works whether the run is active or
  //      already complete (no-writer). Retried once after 2 s if the network is
  //      still unstable (same cause as the WS 1006 drop).
  // Ordering: WS re-register first so we don't miss the tail of an active run
  // during the REST round-trip; REST merge second to catch already-complete runs.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    // Idempotency guard: concurrent calls from rapid WS flaps share one fetch.
    if (reconnectInFlightRef.current) return;
    reconnectInFlightRef.current = true;
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
      // mergeTailFromServer always clears the streaming placeholder first (fixes
      // the frozen bubble even on network failure), then fetches the last 20
      // messages and merges by id — no duplicate bubbles, no 6 MB full-dump.
      const opts = {
        provider: resolvedProvider,
        // Use DB projectId; legacy folder-derived projectName is no longer accepted here.
        projectId: selectedProject.projectId,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
      };
      const ok = await sessionStore.mergeTailFromServer(selectedSession.id, opts);

      // Retry once after 2 s: the same Cloudflare tunnel that dropped the WS
      // (1006) can still be unstable when the socket first reconnects, causing the
      // REST fetch to fail too. A single delayed retry catches this window without
      // creating a polling loop (no-writer sessions stop after one retry).
      if (!ok) {
        await new Promise<void>((resolve) => { window.setTimeout(resolve, 2000); });
        await sessionStore.mergeTailFromServer(selectedSession.id, opts);
      }

      // B-208 (بند 6 + حرج 3): كان المسح غير مشروط ويعتمد على مصادفة أن ترفعه
      // مزامنةُ `processingSessions` مجدداً (وهي أحادية الاتجاه: ترفع ولا
      // تُنزل). صار داخل نظام الـepoch وبقرار **قاطع** فقط: نرفع epoch الجلسة
      // (فتُهمَل أي لقطة أُطلقت قبل المسار)، نطلق لقطة، ولا نُنزِل المؤشّر إلا
      // على `'idle'` صريحة. على `'unknown'` (النقطة غير منشورة بعد / شبكة)
      // نترك المؤشّر كما هو — إنزاله كان يُخفي البطاقة وزر STOP لبقية التشغيل.
      bumpSessionActivityEpoch(selectedSession.id);
      const outcome = await probeSessionActivity(selectedSession.id);
      if (shouldClearLoadingAfterRecovery(outcome)) {
        setIsLoading(false);
        setCanAbortSession(false);
      }
    } finally {
      reconnectInFlightRef.current = false;
    }
  }, [
    selectedProject,
    selectedSession,
    sessionStore,
    sendMessage,
    setIsLoading,
    setCanAbortSession,
    probeSessionActivity,
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

  useChatRealtimeHandlers({
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
    onWebSocketReconnect: handleWebSocketReconnect,
    onServerError: handleServerError,
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
  const runProgress = useRunProgress(chatMessages, isLoading);

  // Agents of this session's background workflows. Server-sourced (the polled
  // `/workflows/active` store), because a `Workflow` run leaves no container row
  // in the transcript for `useRunProgress` to find — the reason the strip stayed
  // empty for workflow-heavy sessions. Independent of `isLoading`: these keep
  // running long after the reply that launched them ended.
  const workflowStripAgents = useWorkflowStripAgents(currentSessionId || selectedSession?.id || null);

  // مخرج الطوارئ: القرار في دالّة صرفة مختبَرة (انظر التعليق عند موضع الزرّ).
  const showManualRefresh = shouldShowManualRefresh({
    hasSession: Boolean(currentSessionId ?? selectedSession?.id),
    isLoading,
    activitySourceAvailable,
  });

  // Coordinator speaking *now*: the `coordinatorId` of the most recent assistant
  // message (live or streaming). Drives the participants bar's active-speaker
  // highlight so the strip names the brother actually replying, not whoever
  // opened the session. `null` until an attributed assistant reply exists.
  const activeCoordinatorId = useMemo<number | null>(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const message = chatMessages[i];
      if (message.type !== 'assistant') continue;
      if (typeof message.coordinatorId === 'number') return message.coordinatorId;
    }
    return null;
  }, [chatMessages]);

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
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full flex-col">
        {participantsBar.mounted && (
          <div
            className={
              participantsBar.closing
                ? 'overflow-hidden animate-participants-bar-slide-up'
                : 'overflow-hidden animate-participants-bar-slide-down'
            }
          >
            {/* isLoading: هبوطه (true ← false) هو مُطلِق إعادة جلب الكلفة
                الوحيد — عندها تستقرّ عدّادات السجلّ. تركه غير ممرَّر يجعل
                الرقم المعروض لقطةَ لحظة الفتح ولا يتحدّث بعد أي ردّ.
                closed: الحالة تصل مع صفّ الجلسة، فيبدأ الزرّ بحالته الصحيحة
                بدل أن يعرض «إغلاق» لمحادثة مغلقة أصلاً. */}
            <SessionParticipantsBar
              sessionId={currentSessionId ?? selectedSession?.id ?? null}
              activeCoordinatorId={activeCoordinatorId}
              onHide={() => setShowParticipantsBar(false)}
              isLoading={isLoading}
              closed={selectedSession?.closed ?? false}
            />
          </div>
        )}
        {/* Re-show button: a slim chevron shown only when the participants bar is
            hidden AND a session is open. Sits flush at the top-start edge so it
            does not interfere with the floating end-side refresh / WS buttons. */}
        {!showParticipantsBar && Boolean(currentSessionId ?? selectedSession?.id) && (
          <button
            type="button"
            onClick={() => setShowParticipantsBar(true)}
            className="flex w-full items-center gap-1 border-b border-border/40 bg-muted/20 px-3 py-0.5 text-[10px] text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-muted-foreground sm:px-4"
            aria-label={t('participants.show', { defaultValue: 'Show participants bar' })}
            title={t('participants.show', { defaultValue: 'Show participants bar' })}
          >
            <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden />
            <span>{t('participants.show', { defaultValue: 'Show participants bar' })}</span>
          </button>
        )}
        {/* Top floating column: WsConnectionBadge (when disconnected) + manual-refresh button.
            h-0 keeps it out of the flex-column flow so the messages scroll area can extend up
            to the top divider. Anchored to the messages pane's *full width* (the real window
            inline-end edge), NOT the composer's centered max-w-4xl column — the 7fc0307 wrapper
            made `end-10` land at the centred column's edge (≈ page middle on wide screens).
            Instead we sit the button on the same axis as the participants-bar collapse chevron
            (SessionParticipantsBar's `ms-auto` ChevronUp, w-7 inside px-3/sm:px-4): its centre is
            12+14=26px (mobile) / 16+14=30px (≥sm) from the edge, so a w-6 (24px) button centres
            there at end-[14px] / sm:end-[18px], directly beneath the chevron beside the scrollbar. */}
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
                  onClick={handleManualRefresh}
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
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isLoading={isLoading}
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
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          onStartNewSession={startFreshSession}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          hideToolCalls={hideToolCalls}
          selectedProject={selectedProject}
        />

        <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={claudeStatus}
          isLoading={isLoading}
          isSessionFrozen={isSessionFrozen}
          runStartedAt={runStartedAt}
          runProgress={runProgress}
          workflowAgents={workflowStripAgents}
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
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            // T-224 (م0): اسم العرض من الواصف — لا ترناريات مكرّرة.
            provider: getProviderDisplayName(provider),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          isWsConnected={isConnected}
          sendError={sendError ?? serverError}
          sessionCurrentModel={sessionCurrentModel}
          providerModelCatalog={providerModelCatalog}
          onChangeSessionModel={handleChangeSessionModel}
          sessionId={sessionActiveModelId}
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
      />

      <BtwOverlay state={activeBtw} onClose={closeBtw} />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);

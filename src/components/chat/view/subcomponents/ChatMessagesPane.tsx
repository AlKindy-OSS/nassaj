import { useTranslation } from 'react-i18next';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { ArrowDownIcon, RefreshCw } from 'lucide-react';

import { useSessionParticipants } from '../../../participants';
import type { SessionParticipant } from '../../../participants/types';
import { classifyHistoryFailure, type HistoryError } from '../../../../stores/useSessionStore';
import type { ChatMessage } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from '../../../../types/app';
import type { ProviderAuthStatusMap } from '../../../provider-auth/types';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';

import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import DateSeparator from './DateSeparator';
import SessionIdleWarning from './SessionIdleWarning';

// Parse a ChatMessage timestamp (string | number | Date) into a valid Date, or null.
function toValidDate(timestamp: string | number | Date | undefined): Date | null {
  if (timestamp == null) return null;
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  historyError?: HistoryError | null;
  // T-1821: retryHistory حُذف من الواجهة — المعالج انتقل إلى ChatComposer (jump-down).
  isLoadingSessionMessages: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  displayProvider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  /** Active "Claude engine on a vendor endpoint" selection (ADR-037), or null. */
  engineProvider: 'kimi' | 'deepseek' | 'glm' | null;
  /** Sets/clears the engine provider (clearing on plain model selection). */
  setEngineProvider: (next: 'kimi' | 'deepseek' | 'glm' | null) => void;
  /** Selects the Claude engine routed through a vendor endpoint + a vendor model. */
  onSelectClaudeEngineProvider: (vendor: 'kimi' | 'deepseek' | 'glm', model: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  antigravityModel: string;
  setAntigravityModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  hermesModel: string;
  setHermesModel: (model: string) => void;
  kimiModel: string;
  setKimiModel: (model: string) => void;
  deepseekModel: string;
  setDeepSeekModel: (model: string) => void;
  glmModel: string;
  setGlmModel: (model: string) => void;
  qwenModel: string;
  setQwenModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  providerModelsRefreshing: boolean;
  providerAuthStatus: ProviderAuthStatusMap;
  /** إعادة تحميل كتالوج النماذج بدون bypassCache — يُستدعى عند فتح المنتقي. */
  onRefreshProviderModels: () => Promise<void>;
  onHardRefreshProviderModels: () => void;
  onRefreshAuthStatus: (force?: boolean) => Promise<void>;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  /** يجلب الصفحة الأقدم من الخادم (نظير التمرير-إلى-الأعلى بضغطة، B-431). */
  loadMoreMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  onRequestDeferredHistory: () => void;
  /** زرّ «استكمِل الآن» على صفّ فجوة البثّ (bypass صريح، بلا إخفاء تلقائي). */
  onResumeStreamRecovery?: (sessionId: string) => void;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  onStartNewSession?: (command: string) => void;
  onForkFromMessage?: (transcriptMessageId: string) => void;
  isForkingMessage?: boolean;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  showToolCalls?: boolean;
  selectedProject: Project;
  /** true = بثّ جارٍ (يُمرَّر لـSessionIdleWarning لإخفائه أثناء التشغيل). */
  isStreaming?: boolean;
  /**
   * حجم السياق الحالي (tokenBudget.used) بالتوكنز — null حين المزوّد لا يدعم
   * عدّاد التوكنز؛ يُمرَّر مباشرةً لـSessionIdleWarning دون إعادة حساب.
   */
  contextTokens?: number | null;
  /** عتبة تنبيه الخمول بالمللي ثانية حسب الهارنس (T-1765)؛ null = لا تنبيه. */
  idleThresholdMs?: number | null;
  /** يُستدعى عند النقر على «محادثة جديدة» في تنبيه الخمول. */
  onNewSession?: () => void;
  /** B-1044: زرّ scroll-to-bottom — true حين المستخدم تمرَّر للأعلى ويوجد رسائل. */
  isUserScrolledUp?: boolean;
  hasMessages?: boolean;
  /** T-1821: يُظهر الزرّ حتى حين المستخدم في الأسفل (جلسة عالقة / historyError / انقطاع تعافى). */
  showResync?: boolean;
  /** T-1821: دوّامة أثناء إعادة المزامنة (refresh أو retry تاريخ). */
  isResyncing?: boolean;
  /**
   * T-1821: طابع Unix بالميلي ثانية لوقت انتهاء تأجيل المحاولة (retryAt من historyError).
   * حين `retryUntil > Date.now()` يُعطَّل الزرّ ويُعرض تلميح «يرجى الانتظار».
   */
  retryUntil?: number | null;
  onScrollToBottom?: () => void;
}

export default function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  historyError,
  isLoadingSessionMessages,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  displayProvider,
  setProvider,
  engineProvider,
  setEngineProvider,
  onSelectClaudeEngineProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
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
  providerModelCatalog,
  providerModelsLoading,
  providerModelsRefreshing,
  providerAuthStatus,
  onRefreshProviderModels,
  onHardRefreshProviderModels,
  onRefreshAuthStatus,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadMoreMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  onRequestDeferredHistory,
  onResumeStreamRecovery,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  onStartNewSession,
  onForkFromMessage,
  isForkingMessage,
  autoExpandTools,
  showRawParameters,
  showThinking,
  showToolCalls,
  selectedProject,
  isStreaming = false,
  contextTokens = null,
  idleThresholdMs = null,
  onNewSession,
  isUserScrolledUp = false,
  hasMessages = false,
  showResync = false,
  isResyncing = false,
  retryUntil = null,
  onScrollToBottom,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');

  // T-1821 fix-6: isRetryWaiting is computed from Date.now() at render time, so
  // the button stays disabled after retryAt expires unless we force a re-render.
  // Schedule one re-render at the exact expiry time so the button re-enables promptly.
  const [, setRetryTick] = useState(0);
  useEffect(() => {
    if (retryUntil == null) return;
    const delay = retryUntil - Date.now();
    if (delay <= 0) return; // already past — no timer needed
    const id = window.setTimeout(() => setRetryTick((n) => n + 1), delay + 50);
    return () => window.clearTimeout(id);
  }, [retryUntil]);

  // Roster of humans seen in this session, used to resolve a message's
  // `userId` author stamp to a username/avatar/colour so mirrors render the
  // real sender instead of the viewing user (B-MU-UX-FIX-MSG-AUTHOR). Keyed by
  // String(userId) to tolerate the backend's loose id typing.
  const { participants } = useSessionParticipants(
    currentSessionId ?? selectedSession?.id ?? null,
    !isLoadingSessionMessages,
  );
  const participantsById = useMemo(() => {
    const byId = new Map<string, SessionParticipant>();
    for (const participant of participants) {
      byId.set(String(participant.userId), participant);
    }
    return byId;
  }, [participants]);

  const messageKeyMapRef = useRef<WeakMap<ChatMessage, string>>(new WeakMap());
  const allocatedKeysRef = useRef<Set<string>>(new Set());
  const generatedMessageKeyCounterRef = useRef(0);

  // Keep keys stable across prepends so existing MessageComponent instances retain local state.
  const getMessageKey = useCallback((message: ChatMessage) => {
    const existingKey = messageKeyMapRef.current.get(message);
    if (existingKey) {
      return existingKey;
    }

    const intrinsicKey = getIntrinsicMessageKey(message);
    let candidateKey = intrinsicKey;

    if (!candidateKey || allocatedKeysRef.current.has(candidateKey)) {
      do {
        generatedMessageKeyCounterRef.current += 1;
        candidateKey = intrinsicKey
          ? `${intrinsicKey}-${generatedMessageKeyCounterRef.current}`
          : `message-generated-${generatedMessageKeyCounterRef.current}`;
      } while (allocatedKeysRef.current.has(candidateKey));
    }

    allocatedKeysRef.current.add(candidateKey);
    messageKeyMapRef.current.set(message, candidateKey);
    return candidateKey;
  }, []);

  // T-1821: retryWaiting حُذف — الزرّ انتقل إلى ChatComposer (jump-down الموحَّد).
  const historyFailureKey = classifyHistoryFailure(historyError);

  // Collisions must only be judged against keys allocated THIS render pass.
  // `normalizedToChatMessages` rebuilds fresh ChatMessage objects on every
  // store update, so the identity-keyed WeakMap above misses for the whole
  // list on those renders and every message falls through to its intrinsic
  // (now id-based, stable) key. Carrying `allocatedKeysRef` across renders
  // made that stable key look "already taken" by itself from the previous
  // pass, so it was rejected and replaced by a counter-suffixed key every
  // time — defeating the whole point of a stable key and causing the exact
  // remount thrash (collapsed tool details, lost selection, scroll jumps)
  // this hook exists to prevent. Clearing here scopes collision detection to
  // the messages actually being keyed in this render.
  allocatedKeysRef.current.clear();

  // Unix ms لآخر رسالة في القائمة الكاملة (لا المرئية فقط) — يُمرَّر
  // لـSessionIdleWarning لحساب وقت الخمول. يُعاد حسابه فقط عند تغيّر chatMessages.
  const lastMessageTimestamp = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const ts = chatMessages[i].timestamp;
      if (ts == null) continue;
      const ms = ts instanceof Date ? ts.getTime() : new Date(ts as string | number).getTime();
      if (Number.isFinite(ms)) return ms;
    }
    return null;
  }, [chatMessages]);

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="relative flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-0 py-1 sm:space-y-3 sm:px-4"
    >
      {/* T-1821: حُذف زرّ التحديث من هنا — الزرّ الموحَّد (jump-down) في ChatComposer
            يتولّى دور retryHistory عند وجود historyError. النصّ يبقى للإعلام. */}
      {historyError && (
        <div role="alert" className="sticky top-0 z-10 mx-3 rounded-lg border border-border bg-muted p-3 text-sm sm:mx-0">
          <p>{t(`session.historyError.${historyFailureKey}`)}</p>
          {chatMessages.length > 0 && <p className="mt-1 text-muted-foreground">{t('session.historyError.retained')}</p>}
        </div>
      )}
      {isLoadingSessionMessages && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-muted-foreground">
          <div className="flex items-center justify-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 && historyError ? null : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          engineProvider={engineProvider}
          setEngineProvider={setEngineProvider}
          onSelectClaudeEngineProvider={onSelectClaudeEngineProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
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
          onRefreshProviderModels={onRefreshProviderModels}
          onHardRefreshProviderModels={onHardRefreshProviderModels}
          onRefreshAuthStatus={onRefreshAuthStatus}
          setInput={setInput}
          onShowSettings={onShowSettings}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-muted-foreground">
              <div className="flex items-center justify-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-border py-2 text-center text-sm text-muted-foreground">
              {totalMessages > 0 && (
                <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                  <span>
                    {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}
                  </span>
                  {/*
                    B-431: زرّان صريحان — «مرّر لأعلى» وحده كان المخرج الوحيد،
                    فإن تعطّل التمرير (أو تعذّر على المستخدم) لم يبقَ أي سبيل
                    لعرض الأقدم: لوحة «تحميل الكل» العائمة لا تظهر إلا ثانيتين
                    بعد تحميل ناجح، أي أنها غير موجودة عملياً عند فتح المحادثة.
                  */}
                  <button
                    className="rounded-full border border-border px-2.5 py-0.5 text-xs text-primary transition-colors hover:bg-accent"
                    onClick={loadMoreMessages}
                    disabled={isLoadingMoreMessages}
                  >
                    {t('session.messages.loadEarlier')}
                  </button>
                  <button
                    className="rounded-full border border-border px-2.5 py-0.5 text-xs text-primary transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-60"
                    onClick={loadAllMessages}
                    disabled={isLoadingAllMessages}
                  >
                    {isLoadingAllMessages
                      ? t('session.messages.loadingAll')
                      : `${t('session.messages.loadAll')} (${totalMessages})`}
                  </button>
                </span>
              )}
            </div>
          )}

          {/*
            "Load all" confirmation toast. The floating CTA button that used
            to sit here duplicated the one in the "showingOf" row above (both
            called loadAllMessages and were visible together while loading);
            only the completion toast is kept, since the acting button
            disappears the moment allMessagesLoaded flips true.
          */}
          {loadAllJustFinished && (
            <div className="pointer-events-none sticky top-2 z-20 flex justify-center">
              <div className="flex items-center gap-2 rounded-full bg-success px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-lg">
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
                <span>{t('session.messages.allLoaded')}</span>
              </div>
            </div>
          )}

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-border py-2 text-center text-sm text-muted-foreground">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="me-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 disabled:cursor-wait disabled:no-underline disabled:opacity-60 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
                disabled={isLoadingAllMessages}
              >
                {isLoadingAllMessages ? t('session.messages.loadingAll') : t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {visibleMessages.map((message, index) => {
            const prevMessage = index > 0 ? visibleMessages[index - 1] : null;
            const messageDate = toValidDate(message.timestamp);
            const prevDate = prevMessage ? toValidDate(prevMessage.timestamp) : null;
            const showSeparator =
              messageDate != null &&
              (prevDate == null || messageDate.toDateString() !== prevDate.toDateString());
            return (
              <Fragment key={getMessageKey(message)}>
                {showSeparator && messageDate && <DateSeparator date={messageDate} />}
                <MessageComponent
                  message={message}
                  prevMessage={prevMessage}
                  createDiff={createDiff}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  onStartNewSession={onStartNewSession}
                  onForkFromMessage={onForkFromMessage}
                  isForkingMessage={isForkingMessage}
                  autoExpandTools={autoExpandTools}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  showToolCalls={showToolCalls}
                  selectedProject={selectedProject}
                  owner={selectedSession?.owner ?? null}
                  participantsById={participantsById}
                  provider={displayProvider}
                  onRequestDeferredHistory={onRequestDeferredHistory}
                  onResumeStreamRecovery={onResumeStreamRecovery}
                  sessionId={currentSessionId ?? selectedSession?.id ?? null}
                />
              </Fragment>
            );
          })}

          {/* تنبيه الخمول — يظهر بعد مدة كاش الهارنس على آخر رسالة خارج البثّ.
              يُعرض داخل منطقة التمرير لأنه يتبع آخر رسالة بصرياً، لا بعدها. */}
          {onNewSession && idleThresholdMs !== null && (
            <SessionIdleWarning
              lastMessageTimestamp={lastMessageTimestamp}
              isStreaming={isStreaming}
              contextTokens={contextTokens}
              thresholdMs={idleThresholdMs}
              onNewSession={onNewSession}
            />
          )}

        </>
      )}

      {/* B-1044: زرّ scroll-to-bottom sticky داخل منطقة التمرير نفسها (لا فوق
            المُؤلِّف/شريط الحالة كالسابق بإزاحة سالبة هشّة). يبقى مثبَّتاً عند
            أسفل ما هو مرئي من منطقة التمرير، فوق المُؤلِّف تماماً وبلا تغطية،
            بصرف النظر عن ارتفاع AgentStatusCard.
            T-1821: زرّ موحَّد — ينزل ويُعيد المزامنة. يظهر حين:
              (أ) المستخدم تمرَّر للأعلى ويوجد رسائل، أو
              (ب) showResync=true (historyError / جلسة عالقة / انقطاع تعافى)
                  بصرف النظر عن وجود رسائل (fix-1: لا بديل مرئي عند الخطأ الابتدائي).
            أثناء المزامنة أو انتظار retryAt تظهر دوّامة وتُعطَّل النقرة. */}
      {onScrollToBottom && ((isUserScrolledUp && hasMessages) || showResync) && (() => {
        const isRetryWaiting = retryUntil != null && retryUntil > Date.now();
        const isDisabled = isResyncing || isRetryWaiting;
        const label = isResyncing
          ? t('refreshChat.refreshing', { defaultValue: 'Refreshing…' })
          : isRetryWaiting
            ? t('session.historyError.wait', { defaultValue: 'Please wait before trying again' })
            : showResync
              ? t('input.scrollToBottomAndSync', { defaultValue: 'Go to latest & refresh' })
              : t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' });
        return (
          <div className="sticky bottom-2 end-0 start-0 z-10 flex justify-center">
            <button
              type="button"
              onClick={onScrollToBottom}
              disabled={isDisabled}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              title={label}
              aria-label={label}
            >
              {isDisabled
                ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <ArrowDownIcon className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        );
      })()}
    </div>
  );
}

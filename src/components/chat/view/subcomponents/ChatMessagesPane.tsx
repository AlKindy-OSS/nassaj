import { useTranslation } from 'react-i18next';
import { Fragment, useCallback, useMemo, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { useSessionParticipants } from '../../../participants';
import type { SessionParticipant } from '../../../participants/types';
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
import RunningActivityGapCard from './RunningActivityGapCard';
import { getRunningActivityGap } from './runningActivityGap';

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
  isLoadingSessionMessages: boolean;
  /**
   * Whether the current reply is in flight (run-loading, NOT the session's
   * initial-load/pagination flags above). Used only to detect the T-836
   * "silent running" gap (see `getRunningActivityGap`) — everything else in
   * this pane is unaffected by it.
   */
  isLoading: boolean;
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
  geminiModel: string;
  setGeminiModel: (model: string) => void;
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
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  providerModelsRefreshing: boolean;
  providerAuthStatus: ProviderAuthStatusMap;
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
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  onStartNewSession?: (command: string) => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  hideToolCalls?: boolean;
  selectedProject: Project;
}

export default function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isLoading,
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
  providerModelCatalog,
  providerModelsLoading,
  providerModelsRefreshing,
  providerAuthStatus,
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
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  onStartNewSession,
  autoExpandTools,
  showRawParameters,
  showThinking,
  hideToolCalls,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');

  // Roster of humans seen in this session, used to resolve a message's
  // `userId` author stamp to a username/avatar/colour so mirrors render the
  // real sender instead of the viewing user (B-MU-UX-FIX-MSG-AUTHOR). Keyed by
  // String(userId) to tolerate the backend's loose id typing.
  const { participants } = useSessionParticipants(currentSessionId ?? selectedSession?.id ?? null);
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

  // T-836: detect "current reply is running, everything so far is tool_use,
  // no assistant text yet" — the case where `hideToolCalls` (default ON)
  // leaves the message list looking empty/stalled. Pure scan over the FULL
  // transcript (same contract as useRunProgress), memoized on the two inputs
  // that can actually change its result.
  const activityGap = useMemo(
    () => getRunningActivityGap(chatMessages, isLoading),
    [chatMessages, isLoading],
  );

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

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="relative flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-0 py-3 sm:space-y-4 sm:p-4"
    >
      {isLoadingSessionMessages && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
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
          onHardRefreshProviderModels={onHardRefreshProviderModels}
          onRefreshAuthStatus={onRefreshAuthStatus}
          setInput={setInput}
          onShowSettings={onShowSettings}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          {/* Floating "Load all messages" overlay */}
          {(showLoadAllOverlay || isLoadingAllMessages || loadAllJustFinished) && (
            <div className="pointer-events-none sticky top-2 z-20 flex justify-center">
              {loadAllJustFinished ? (
                <div className="flex items-center space-x-2 rounded-full bg-green-600 px-4 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-green-500">
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>{t('session.messages.allLoaded')}</span>
                </div>
              ) : (
                <button
                  className="pointer-events-auto flex items-center space-x-2 rounded-full bg-blue-600 px-4 py-1.5 text-xs font-medium text-white shadow-lg transition-all duration-200 hover:scale-105 hover:bg-blue-700 disabled:cursor-wait disabled:opacity-75 dark:bg-blue-500 dark:hover:bg-blue-600"
                  onClick={loadAllMessages}
                  disabled={isLoadingAllMessages}
                >
                  {isLoadingAllMessages && (
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  )}
                  <span>
                    {isLoadingAllMessages
                      ? t('session.messages.loadingAll')
                      : <>{t('session.messages.loadAll')} {totalMessages > 0 && `(${totalMessages})`}</>
                    }
                  </span>
                </button>
              )}
            </div>
          )}

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="me-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
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
                  autoExpandTools={autoExpandTools}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  hideToolCalls={hideToolCalls}
                  selectedProject={selectedProject}
                  owner={selectedSession?.owner ?? null}
                  participantsById={participantsById}
                  provider={displayProvider}
                />
              </Fragment>
            );
          })}

          {activityGap.visible && activityGap.lastActivityAt !== null && (
            <RunningActivityGapCard lastActivityAt={activityGap.lastActivityAt} />
          )}
        </>
      )}
    </div>
  );
}


import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  SetStateAction,
  TouchEvent,
} from 'react';
import { ImageIcon, MessageSquareIcon, XIcon, ArrowDownIcon } from 'lucide-react';

import type { PendingPermissionRequest, PermissionMode, Provider } from '../../types/types';
import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import { getProviderCapabilities } from '../../constants/providerCapabilities';
import { isBtwCommand } from '../../utils/btwCommand';
import { effortModes } from '../../constants/thinkingModes';
import FileAttachment from './FileAttachment';
import type { RunAgent, RunProgress } from '../../hooks/useRunProgress';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '../../../../shared/view/ui';

import CommandMenu from './CommandMenu';
import AgentStatusCard from './AgentStatusCard';
import CodexPostureInfo from './CodexPostureInfo';
import ImageAttachment from './ImageAttachment';
import InlineModelSwitcher from './InlineModelSwitcher';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import ThinkingModeSelector from './ThinkingModeSelector';
import TokenUsageSummary from './TokenUsageSummary';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  claudeStatus: { text: string; tokens: number; can_interrupt: boolean } | null;
  isLoading: boolean;
  /** True while the session's provider process is externally frozen (kill -STOP). */
  isSessionFrozen?: boolean;
  /** Epoch-ms start of the current run (last triggering user message); lets the elapsed counter survive refresh. */
  runStartedAt?: number | null;
  /** Task/agent progress snapshot for the ClaudeStatus indicators (derived in ChatInterface). */
  runProgress?: RunProgress | null;
  /**
   * Rows for agents of this session's background workflows (server-sourced).
   * Separate from `runProgress.agents`, which is transcript-derived and scoped to
   * the current reply: a workflow's agents outlive the reply that launched them.
   */
  workflowAgents?: RunAgent[];
  onAbortSession: () => void;
  provider: Provider | string;
  displayProvider: Provider | string;
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  thinkingMode: string;
  setThinkingMode: Dispatch<SetStateAction<string>>;
  /** KM-3/GL-8 (ADR-062): وضع المُؤلِّف الحالي (chat افتراضياً، agent متاح لـ kimi/glm فقط). */
  composerMode: 'chat' | 'agent';
  setComposerMode: Dispatch<SetStateAction<'chat' | 'agent'>>;
  /** صحيح حين يعرض المزوّد الحالي سطح وكيل محكوم — يتحكم في ظهور الزرّ. */
  agentModeAvailable: boolean;
  tokenBudget: Record<string, unknown> | null;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  isUserScrolledUp: boolean;
  hasMessages: boolean;
  onScrollToBottom: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  attachedFiles: File[];
  onRemoveFile: (index: number) => void;
  uploadingFiles: Map<string, number>;
  fileErrors: Map<string, string>;
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  /** False while the WebSocket connection is not open; disables the send button. */
  isWsConnected?: boolean;
  /** Non-null error message to display when the last send failed (e.g. WS disconnected). */
  sendError?: string | null;
  /**
   * T-1028: النموذج الفعّال للجلسة المفتوحة (مشتقّ من displayProvider في ChatInterface).
   * يُعرَض في مبدّل النموذج المدمج بشريط الأدوات.
   */
  sessionCurrentModel?: string;
  /**
   * T-1028: كتالوج النماذج لعرض قائمة اختيار النموذج في المبدّل المدمج.
   */
  providerModelCatalog?: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  /**
   * T-1028 / B-247: يُستدعى عند اختيار نموذج جديد من المبدّل المدمج.
   * الـcallback في ChatInterface يستعمل displayProvider لضمان الكتابة الصحيحة.
   * B-251: يُعيد النطاق الفعلي (session/default) والنموذج المؤكَّد من الخادم.
   */
  onChangeSessionModel?: (model: string) => Promise<{ scope: 'session' | 'default'; model: string }>;
  /**
   * B-251: معرّف الجلسة الحالية — يحدّد شارة النطاق في المبدّل قبل الاختيار.
   * null/undefined = لا جلسة → «افتراضي لكل محادثة جديدة».
   */
  sessionId?: string | null;
  /**
   * B-252: صحيح حين تملك الجلسة تثبيتاً صريحاً (changed===true في GET).
   * يُظهِر خيار «اتبع الافتراضي الحالي» في المبدّل.
   */
  sessionActiveModelChanged?: boolean;
  /**
   * B-252: يُستدعى لمسح تثبيت النموذج (DELETE endpoint).
   * يُعيد النموذج الذي سيسري بعد المسح.
   */
  onClearSessionModel?: () => Promise<{ model: string }>;
  /**
   * B-ENG: ختم محرّك الجلسة المفتوحة (null = مسار Anthropic الرسمي).
   * غير null → المبدّل يُعطَّل كلياً مع سبب مرئي للمستخدم.
   */
  sessionEngineProvider?: string | null;
}

export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  claudeStatus,
  isLoading,
  isSessionFrozen = false,
  runStartedAt = null,
  runProgress = null,
  workflowAgents = [],
  onAbortSession,
  displayProvider,
  permissionMode,
  onModeSwitch,
  thinkingMode,
  setThinkingMode,
  composerMode,
  setComposerMode,
  agentModeAvailable,
  tokenBudget,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  isUserScrolledUp,
  hasMessages,
  onScrollToBottom,
  onSubmit,
  isDragActive,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  attachedFiles,
  onRemoveFile,
  uploadingFiles,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  isWsConnected = true,
  sendError = null,
  sessionCurrentModel = '',
  providerModelCatalog = {},
  onChangeSessionModel,
  sessionId,
  sessionActiveModelChanged = false,
  onClearSessionModel,
  sessionEngineProvider = null,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  // T-904: كل قدرات المُؤلِّف (منتقي التفكير، عدّاد التوكنز، تلميح الإرفاق)
  // تُشتق من مزوّد الجلسة المفتوحة (displayProvider) لا الاختيار العام
  // (provider)، فتبقى أدوات جلسة claude ثابتة مهما تغيّر الاختيار العام —
  // الأخير يؤثّر فقط على جلسة جديدة (قرار المالك، انحراف واعٍ عن PLAN-v1 §4.1).
  const capabilities = useMemo(
    () => getProviderCapabilities(displayProvider),
    [displayProvider],
  );
  // T-905: ThinkingModeSelector يعرض effortModes الكاملة ما لم يحصرها الواصف
  // (capabilities.effort.modes) بمجموعة فرعية من الهويّات — حال codex اليوم
  // (بلا max/ultracode، لا مقابل لهما في codex ModelReasoningEffort). المرجع
  // ثابت من PROVIDER_UI_CAPABILITIES (مصفوفة وحدة نمطية لا تُعاد كل رندر)،
  // فالمذكِّر مستقرّ ولا يُعيد الحساب إلا حين يتبدّل المزوّد فعلياً.
  const effortModesForProvider = useMemo(() => {
    if (!capabilities.effort.modes) {
      return effortModes;
    }
    const allowedIds = new Set(capabilities.effort.modes);
    return effortModes.filter((mode) => allowedIds.has(mode.id));
  }, [capabilities.effort.modes]);
  // T-849: «/btw <سؤال>» قناة جانبية «دائمة التمكين» يُسمح بإرسالها حتى أثناء
  // البث (isLoading) — لكن لجلسة claude فقط (المزوّد الوحيد ذو آلية الفرك). هنا
  // نُرخي بوابة تعطيل الإرسال فقط؛ الاعتراض والـWS/overlay في وحدات منفصلة
  // (useChatComposerState/useBtwSideChannel/BtwOverlay) — قيد بوابة التصميم.
  const isBtwReady = capabilities.sideChannel.supported && isBtwCommand(input);
  const textareaRect = textareaRef.current?.getBoundingClientRect();
  // bottom-anchored position: distance from bottom of viewport to top of textarea + gap.
  // design-ok: `left` here is a raw viewport pixel X-coordinate (not a CSS physical property);
  // CommandMenu's getMenuPosition converts it to the correct RTL inset-inline-start/end value.
  const commandMenuPosition = {
    top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
    left: textareaRect ? textareaRect.left : 16,
    bottom: textareaRect ? Math.max(16, window.innerHeight - textareaRect.top + 8) : 90,
  };

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;

  return (
    <div className="flex-shrink-0 p-2 pb-2 sm:p-4 sm:pb-4 md:p-4 md:pb-6">
      {!hasPendingPermissions && (
        // AgentStatusCard يدمج بطاقة نشاط الوكلاء وشريط CLAUDE في عنصر واحد:
        // — حين لا وكلاء (agents=[]): يُفوَّض لـ ClaudeStatus مباشرةً (سلوك سابق)
        // — حين يوجد وكلاء: يُعرض رأس واحد يجمع الشعار والمؤقت وزر STOP
        //   وملخّص الوكلاء وchevron الطيّ، مع صفوف الوكلاء في جزء قابل للطيّ.
        <AgentStatusCard
          agents={runProgress?.agents ?? []}
          workflowAgents={workflowAgents}
          status={claudeStatus}
          isLoading={isLoading}
          frozen={isSessionFrozen}
          onAbort={onAbortSession}
          provider={displayProvider}
          runStartedAt={runStartedAt}
          progress={runProgress}
        />
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-4xl">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      {sendError && (
        <div
          role="alert"
          className="mx-auto mb-2 max-w-4xl rounded-lg border border-red-300/60 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-600/40 dark:bg-red-900/15 dark:text-red-300"
        >
          {sendError}
        </div>
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-4xl">

        {isUserScrolledUp && hasMessages && (
          <div className="absolute -top-10 start-0 end-0 z-10 flex justify-center">
            <button
              type="button"
              onClick={onScrollToBottom}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
              title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
            >
              <ArrowDownIcon className="h-4 w-4" />
            </button>
          </div>
        )}

        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute bottom-full start-0 end-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={isTextareaExpanded ? 'chat-input-expanded' : ''}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">{t('input.dropFilesHere')}</p>
              </div>
            </div>
          )}

          {(attachedImages.length > 0 || attachedFiles.length > 0) && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={`img-${index}`}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                  {attachedFiles.map((file, index) => (
                    <FileAttachment
                      key={`file-${index}`}
                      file={file}
                      onRemove={() => onRemoveFile(index)}
                      uploadProgress={uploadingFiles.get(file.name)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            {/*
              طبقة مرآة الـ@mentions: نصّ شفّاف مرسوم فوق الـtextarea لتلوين
              إشارات الملفات، فصحّتها تعتمد على تطابق موضع كل حرف مع الحقل.
              `dir="auto"` هنا ليست خياراً بل مطابقةً حرفية لسِمة الـtextarea
              أدناه — بدونها ترث الطبقة `rtl` من المستند بينما يحسب الحقل اتجاهه
              من أول حرف قوي في المسودّة، فتسقط مستطيلات التمييز على حروف أخرى
              في كل مسودّة تفتح بحرف مخالف (126 من 1916 مسودّة حقيقية).
            */}
            <div ref={inputHighlightRef} dir="auto" aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter>
          {/* T-910: flex-nowrap + overflow-x-auto (scrollbar-hide) replace the
              PromptInputTools default flex-wrap — every child below is pinned
              shrink-0 so icons never get crushed; if the sum still exceeds the
              pane width (very narrow viewport, OS text-zoom, mid-breakpoint
              tablet widths where sm: reveals extra labels) the row scrolls
              horizontally instead of wrapping the badge/send button onto a
              second line.
              T-914: gap-2 (was the default gap-1/4px) — six-plus shrink-0
              controls sitting at 4px apart read as crushed together; 8px
              gives each icon room to breathe while the overflow-x-auto
              safety net above still absorbs any narrow-viewport overflow. */}
          <PromptInputTools className="scrollbar-hide flex-nowrap gap-2 overflow-x-auto">
            <PromptInputButton
              className="shrink-0"
              tooltip={{
                content: !capabilities.command.supportsImages
                  ? t('input.nonClaudeAttachmentHint')
                  : t('input.attachFilesAndImages'),
              }}
              onClick={openImagePicker}
              aria-label={
                !capabilities.command.supportsImages
                  ? t('input.nonClaudeAttachmentHint')
                  : t('input.attachFilesAndImages')
              }
            >
              <ImageIcon />
            </PromptInputButton>

            <button
              type="button"
              onClick={onModeSwitch}
              className={`shrink-0 rounded-lg border p-2 text-xs font-medium transition-all duration-200 sm:px-2.5 sm:py-1 ${
                permissionMode === 'default'
                  ? 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
                  : permissionMode === 'acceptEdits'
                    ? 'border-green-300/60 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-600/40 dark:bg-green-900/15 dark:text-green-300 dark:hover:bg-green-900/25'
                    : permissionMode === 'auto'
                      ? 'border-blue-300/60 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-600/40 dark:bg-blue-900/15 dark:text-blue-300 dark:hover:bg-blue-900/25'
                      : permissionMode === 'bypassPermissions'
                        ? 'border-orange-300/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25'
                        : 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10'
              }`}
              title={t('input.clickToChangeMode')}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${
                    permissionMode === 'default'
                      ? 'bg-muted-foreground'
                      : permissionMode === 'acceptEdits'
                        ? 'bg-green-500'
                        : permissionMode === 'auto'
                          ? 'bg-blue-500'
                          : permissionMode === 'bypassPermissions'
                            ? 'bg-orange-500'
                            : 'bg-primary'
                  }`}
                />
                <span className="hidden whitespace-nowrap sm:inline">
                  {permissionMode === 'default' && t('codex.modes.default')}
                  {permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
                  {permissionMode === 'auto' && t('codex.modes.auto')}
                  {permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
                  {permissionMode === 'plan' && t('codex.modes.plan')}
                </span>
              </div>
            </button>

            {/* T-894/T-905: زرّ معلومات السقف الفعلي (sandbox/شبكة) للوضع الحالي —
                codex فقط (capabilities.posture.supported)، تصحيحاً لنصوص كانت تصف
                bypassPermissions بأنه وصول كامل للقرص/الشبكة بينما السقف الحيّ
                مقصور على workspace-write وشبكة OFF (ADR-058/T-884). */}
            {capabilities.posture.supported && (
              <span className="inline-flex shrink-0">
                <CodexPostureInfo permissionMode={permissionMode} />
              </span>
            )}

            {capabilities.effort.supported && (
              <>
                <ThinkingModeSelector
                  selectedMode={thinkingMode}
                  onModeChange={setThinkingMode}
                  onClose={() => {}}
                  className="shrink-0"
                  modes={effortModesForProvider}
                />
                {/* design-ok: tracking-widest — 'ULTRACODE' is a Latin-only all-caps display label,
                    not Arabic text; letter-spacing is intentional for this specific badge only.
                    B-282: appears from `md` (not `sm`) — 640-768px is exactly where the composer
                    row is tightest, and this ~90px badge was the last straw that squeezed the
                    context pill. Below md the glow ring on the selector already says ultracode is
                    on, so nothing is lost. */}
                {thinkingMode === 'ultracode' && (
                  <span
                    className="hidden shrink-0 items-center rounded border border-red-400 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-red-700 shadow-[0_0_8px_rgba(239,68,68,0.40)] dark:border-red-600 dark:bg-red-950 dark:text-red-300 dark:shadow-[0_0_10px_rgba(239,68,68,0.55)] md:flex"
                    aria-label={t('effortMode.ultracodeActive')}
                  >
                    ULTRACODE
                  </span>
                )}
              </>
            )}

            {/* KM-3/GL-8 (ADR-062): زرّ مبدّل الوضع chat⇄agent.
                يظهر فقط حين agentModeAvailable (kimi أو glm مع علم الحامل).
                — RTL: gap-1.5 + ms-0 (logical) لا left/right فيزيائية.
                — i18n: مفاتيح composerMode.chat / composerMode.agent من ar/en chat.json.
                — لا نص ثابت مدمج. الوضع الافتراضي 'chat' (سلوك قائم بلا تغيير). */}
            {agentModeAvailable && (
              <button
                type="button"
                onClick={() => setComposerMode(composerMode === 'agent' ? 'chat' : 'agent')}
                aria-pressed={composerMode === 'agent'}
                aria-label={t(`composerMode.${composerMode}`)}
                className={`shrink-0 rounded-lg border p-2 text-xs font-medium transition-all duration-200 sm:px-2.5 sm:py-1 ${
                  composerMode === 'agent'
                    ? 'border-violet-300/60 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-900/20 dark:text-violet-300 dark:hover:bg-violet-900/30'
                    : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <div
                    className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${
                      composerMode === 'agent' ? 'bg-violet-500' : 'bg-muted-foreground/50'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="hidden whitespace-nowrap sm:inline">
                    {t(`composerMode.${composerMode}`)}
                  </span>
                </div>
              </button>
            )}

            {/* T-1028: مبدّل النموذج وسط المحادثة — يظهر حين المزوّد يدعم التبديل
                (capabilities.modelSwitch.supported) وتوفّر الـcallback والكتالوج.
                B-247: الـcallback في ChatInterface مبنيّ على displayProvider لا provider
                العام، فالمفتاح يُكتب دائماً تحت مزوّد الجلسة الصحيح. */}
            {capabilities.modelSwitch?.supported && onChangeSessionModel && (
              <InlineModelSwitcher
                provider={displayProvider}
                currentModel={sessionCurrentModel}
                catalog={providerModelCatalog}
                onSelect={onChangeSessionModel}
                disabled={isLoading}
                className="shrink-0"
                sessionId={sessionId}
                sessionModelChanged={sessionActiveModelChanged}
                onClearSessionModel={onClearSessionModel}
                engineProvider={sessionEngineProvider}
              />
            )}

            {/* Token usage + context-rot indicator gate (T-904, ADR-047 م0).
                Gated on the provider capability descriptor — claude/codex/
                opencode emit a real `token_budget` (opencode-cli.js:268-277),
                hermes/agy/gemini/... do not, so their gate stays closed
                (B-92). Derived from `capabilities` (displayProvider = the
                OPEN SESSION's provider), not the global picker, so the
                counter never disappears/appears out of sync with the
                conversation actually shown. */}
            {capabilities.tokenCounter.supported && (
              // T-913-follow-up: min-w-0 (not shrink-0) — TokenUsageSummary is
              // already built to shrink/ellipsize internally (min-w-0 +
              // overflow-hidden + truncate on its own root, and the used/total
              // sub-span is hidden below sm:). Pinning this wrapper shrink-0
              // forced the pill to keep its full intrinsic width and crowd out
              // the buttons beside it; letting it shrink first means the row
              // stays comfortably spaced and only the token pill narrows when
              // the pane is tight — no wrap, no overflow.
              <span className="inline-flex min-w-0">
                <TokenUsageSummary usage={tokenBudget} />
              </span>
            )}

            {/* Wrapper span establishes the containing block for the badge.
              * Firefox/Gecko (bug 1392476) does not let a <button> with
              * position:relative anchor absolutely-positioned descendants, so
              * the badge must be a SIBLING of the button inside a non-button
              * positioned ancestor — otherwise it escapes and the form's
              * overflow-hidden clips it (works in Chromium, hidden in FF/Zen). */}
            <span className="relative inline-flex shrink-0">
              <PromptInputButton
                tooltip={{ content: t('input.showAllCommands') }}
                onClick={onToggleCommandMenu}
              >
                <MessageSquareIcon />
              </PromptInputButton>
              {/* design-ok: -right-1 — notification badge anchored to physical top-right corner,
                  universal UI convention for count indicators regardless of text direction. */}
              {slashCommandsCount > 0 && (
                <span
                  className="pointer-events-none absolute -right-1 -top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                >
                  {slashCommandsCount}
                </span>
              )}
            </span>

            {hasInput && (
              <PromptInputButton
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
                className="sm:No-flex hidden shrink-0"
              >
                <XIcon />
              </PromptInputButton>
            )}

          </PromptInputTools>

          <div className="flex shrink-0 items-center gap-2">
            {/* min-w-0 + truncate: in a squeezed composer column the hint
              * ellipsizes on one line instead of wrapping over the toolbar
              * (lg: sees viewport width, not pane width). */}
            <div
              className={`ms-2 hidden min-w-0 truncate text-xs text-muted-foreground/50 transition-opacity duration-200 lg:block ${
                input.trim() ? 'opacity-0' : 'opacity-100'
              }`}
            >
              {sendByCtrlEnter ? t('input.hintText.ctrlEnter') : t('input.hintText.enter')}
            </div>
            <PromptInputSubmit
              disabled={!input.trim() || (isLoading && !isBtwReady) || !isWsConnected}
              title={!isWsConnected ? t('ws.sendDisabledTitle', { defaultValue: 'Cannot send — connection lost' }) : undefined}
              className="h-10 w-10 shrink-0 sm:h-10 sm:w-10"
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}

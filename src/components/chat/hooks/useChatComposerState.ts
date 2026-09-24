import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { validateCodexImageInput } from '../../../../shared/codex-image-input';
import { authenticatedFetch } from '../../../utils/api';
import { useResolvedEnterBehavior } from '../../../hooks/useResolvedEnterBehavior';
import { decideEnterAction } from '../../../lib/enter-behavior';
import { computeListContinuation } from '../../../lib/list-continuation';
import {
  useSessionProcessState,
  useSessionProcessStateAuthority,
} from '../../../stores/sessionProcessStateStore';
import { useAuth } from '../../auth/context/AuthContext';
import { DEFAULT_EFFORT_MODE, effortModes } from '../constants/thinkingModes';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import { safeLocalStorage } from '../utils/chatStorage';
import {
  createClientMsgId,
  createOutboxReceiptRecovery,
  getOutboxSnapshot,
  markOutboxFailed,
  markOutboxPendingDurably,
  restorePreparedOutboxRetryDurably,
  outboxRetryMode,
  readOutboxRetryPayload,
  verifyOutboxImagePersistence,
  blockOutboxRetry,
  recordOutboxEntryDurably,
  removeOutboxEntryExplicit,
  confirmOutboxEntry,
  reconcileOutboxDeliveryEvidence,
  selectVisibleEntries,
  subscribeOutbox,
  type OutboxEntry,
  type OutboxIntent,
  type OutboxHistoryEligibility,
} from '../utils/messageOutbox';
import type {
  ChatFile,
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelsCacheInfo } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';
import { resolveSendProvider } from '../utils/resolveSendProvider';
import {
  getProviderCapabilities,
  isAgentModeAvailable,
  type CoordinationLevel,
} from '../constants/providerCapabilities';
import {
  isReservedSideChannelCommandForProvider,
  isSideChannelCommandForProvider,
  parseBtwQuestion,
} from '../utils/btwCommand';
import { isArabicCodexSideAlias, normalizeArabicSlashCommand } from '../utils/commandLocalization';

import { resolveStickyEffortMode } from './stickyEffortMode';
import { readSessionEngineProvider, writePendingEngineStamp } from './useChatProviderState';
import { useFileMentions } from './useFileMentions';
import {
  isBtwSlashEntry,
  isOpenCodePassthroughCommand,
  isPassthroughBuiltInCommand,
  isProviderHandledBuiltInCommand,
  resolveProviderCommandFallback,
  type SlashCommand,
  useSlashCommands,
} from './useSlashCommands';

/**
 * مفتاح تخزين مستوى التفكير المثبَّت لمحادثة بعينها. مُعرَّف الجلسة هو المفتاح
 * (لا المشروع): المستوى خاصية المحادثة الواحدة، ومحادثتان في مشروع واحد قد
 * تستحقّان مستويين مختلفين. يوازي عُرف `draft_input_${projectId}` القائم.
 */
const effortStorageKey = (sessionId: string) => `thinking_mode_${sessionId}`;
const coordinationLevelStorageKey = (sessionId: string) => `coordination_level_${sessionId}`;
const COORDINATION_LEVELS = new Set<CoordinationLevel>(['direct', 'delegate', 'delegate_review']);
const DEFAULT_COORDINATION_LEVEL: CoordinationLevel = 'delegate';

function narrowCoordinationLevel(value: unknown): CoordinationLevel {
  if (value === undefined || value === null) return DEFAULT_COORDINATION_LEVEL;
  return typeof value === 'string' && COORDINATION_LEVELS.has(value as CoordinationLevel)
    ? (value as CoordinationLevel)
    : 'direct';
}

// Maximum number of images that can be attached to a single chat message.
// Must stay in sync with the server-side multer limit (`upload.array('images', 15)`).
const MAX_IMAGES = 15;

// Maximum number of non-image file attachments per message.
const MAX_FILES = 10;

// Allowed non-image MIME types / extensions for the file attachment path.
const ALLOWED_FILE_TYPES = new Set([
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'text/tab-separated-values',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
]);

// 50 MB cap for non-image files.
const MAX_FILE_SIZE = 50 * 1024 * 1024;

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
  /** Correlates a new-session view with its originating composer submission. */
  clientMsgId?: string | null;
};

/**
 * T-1295 — ما يُمرَّر إلى `dispatchProviderCommand` فوق نصّ الرسالة: هويةُ
 * الجولة (`clientMsgId`) ونيّةُ صاحبها المستعادة عند إعادة الإرسال. المسار
 * العادي يمرّر `clientMsgId` وحده.
 */
type DispatchMeta = {
  clientMsgId?: string;
  intent?: OutboxIntent;
  historyEligibility?: OutboxHistoryEligibility;
};

/** فضاء قيم ختم المحرّك (ADR-037). ما سواه = المسار الرسمي. */
const ENGINE_PROVIDERS = new Set(['kimi', 'deepseek', 'glm']);

function narrowEngineProvider(value: string | null | undefined): 'kimi' | 'deepseek' | 'glm' | null {
  return value && ENGINE_PROVIDERS.has(value) ? (value as 'kimi' | 'deepseek' | 'glm') : null;
}

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  /**
   * T-1029 / B-247 — مزوّد الجلسة المفتوحة فعلياً
   * (`selectedSession?.__provider ?? provider` من ChatInterface).
   * يُستخدم في سياق تنفيذ الأوامر بدل `provider` العام حتى لا يُكتب مفتاح
   * active-model تحت مزوّد مختلف عن مزوّد الجلسة فيغيب عن resolveResumeModel.
   */
  displayProvider: LLMProvider | string;
  /**
   * Active "Claude engine on a vendor endpoint" selection (ADR-037). Non-null
   * only while provider==='claude'; when set, the claude-command carries
   * options.engineProvider so the server points the engine at that vendor.
   */
  engineProvider: 'kimi' | 'deepseek' | 'glm' | null;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  geminiModel: string;
  antigravityModel: string;
  opencodeModel: string;
  hermesModel: string;
  kimiModel: string;
  deepseekModel: string;
  glmModel: string;
  qwenModel: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => { ok: boolean; reason?: string } | void;
  /**
   * T-849: مُطلِق استعلام «/btw» الجانبي. حين يبدأ الإدخال بـ«/btw » ومزوّد
   * الجلسة claude، يُعترَض في handleSubmit ويُمرَّر السؤال هنا بدل مسار الرسائل
   * العادي (لا سجلّ محادثة ولا دور). منطق القناة نفسه في useBtwSideChannel.
   */
  onBtwQuery?: (question: string) => void;
  /**
   * ‏T-1319 — **لم يعد يقرّر سلوك Enter**. القرار صار ثلاثيّ القيم
   * (`enterBehavior`) ويُحلّ محلياً عبر `useResolvedEnterBehavior` داخل هذا
   * الخطّاف، فلا يمرّ عبر سلسلة الـprops. المفتاح باقٍ في الواجهة لأن
   * `ChatComposer` ما زال يقرؤه لسطر التلميح وحده.
   */
  sendByCtrlEnter?: boolean;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  pendingViewSessionRef: { current: PendingViewSession | null };
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * T-1295 — سحب فقاعة المستخدم المتفائلة حين يفشل النقل. `null` للمحادثة التي
   * لم تُولد بعد (الفقاعة حينها معلَّقة في حالة المكوّن لا في المخزن).
   * اختياري كي تبقى الاستدعاءات القائمة والاختبارات صالحة.
   */
  withdrawOptimisticUserMessage?: (sessionId: string | null, clientMsgId: string) => void;
  /**
   * T-1295 — سؤال المصدر الحتمي: هل بلغ هذا النصّ سجلَّ المحادثة؟ يُستخدم لفعل
   * «تحقّق» على إدخالٍ `unconfirmed` وحده، منعاً لإرسالٍ مزدوج.
   */
  outboxHistory?: Parameters<typeof reconcileOutboxDeliveryEvidence>[1];
  verifyMessageDelivered?: (sessionId: string, clientMsgId: string, provider?: string, signal?: AbortSignal) => Promise<boolean | 'accepted' | 'unknown'>;
}

interface MentionableFile {
  name: string;
  path: string;
}

export interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

export interface ExecutingSlashCommand {
  name: string;
  sessionId: string | null;
  /** T-1704: raw CLI dispatch (Claude /compact); released when the run ends. */
  passthrough?: boolean;
}

/** Commands lock only the session that started them. A new-session draft gets
 * its own key so it cannot inherit a lock from an already open conversation. */
const commandExecutionKey = (sessionId: string | null): string => sessionId ?? '__new-session__';

/** Extract a human-readable result from provider-specific built-in actions. */
export function readCommandResultMessage(result: CommandExecutionResult): string | null {
  if (typeof result.content === 'string' && result.content.trim()) {
    return result.content.trim();
  }

  const data = result.data;
  if (!data || typeof data !== 'object') return null;
  for (const key of ['message', 'content', 'markdown']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  // Provider actions may intentionally return structured data. Preserve it in
  // a readable form instead of silently claiming success or discarding it.
  if (Object.keys(data).length > 0) {
    return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }
  return null;
}

export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: Array<{
    value: string;
    label?: string;
    description?: string;
  }>;
  defaultModel?: string;
  cache?: ProviderModelsCacheInfo;
};

export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

export type CompactCommandData = {
  provider?: string;
  status?: 'started' | 'completed' | string;
  message?: string;
};

export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
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
  onBtwQuery,
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
  outboxHistory,
}: UseChatComposerStateArgs) {
  const { user } = useAuth();
  const { t, i18n } = useTranslation('chat');
  // Numeric users.id of the signed-in sender, stamped on optimistic user
  // messages so the author avatar resolves locally before the server-stamped
  // echo/history rows arrive (B-MU-UX-FIX-MSG-AUTHOR). Undefined when the
  // identity layer exposes no numeric id (e.g. platform mode).
  const authUserId = useMemo(() => {
    const raw = user?.id;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(numeric) ? numeric : undefined;
  }, [user?.id]);
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, number>>(new Map());
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(DEFAULT_EFFORT_MODE);
  // KM-3/GL-8 (ADR-062): the composer's chat⇄agent toggle. Default 'chat' keeps
  // today's exact routing (no `options.mode` sent). Only meaningful for providers
  // whose descriptor supports a governed agent mode AND, if flag-gated, whose fleet
  // flag is armed (isAgentModeAvailable); for every other provider the value is
  // inert. Reset to 'chat' whenever the open session's provider changes (below), so
  // a stale 'agent' can never cross into a provider that has no agent surface.
  const [composerMode, setComposerMode] = useState<'chat' | 'agent'>('chat');
  const [coordinationLevel, setCoordinationLevel] = useState<CoordinationLevel>(DEFAULT_COORDINATION_LEVEL);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);
  // Execute-style commands are scoped to their session. Keeping a per-session
  // registry prevents a long native /compact in one conversation from blocking
  // input or displaying its status in another conversation.
  const [executingCommands, setExecutingCommands] = useState<Map<string, ExecutingSlashCommand>>(() => new Map());
  // State updates are not synchronous enough to reject two clicks in the same
  // browser turn. This ref is the actual lock; state is its visible projection.
  const executingCommandsRef = useRef<Map<string, ExecutingSlashCommand>>(new Map());
  const activeCommandSessionId = currentSessionId ?? selectedSession?.id ?? null;
  const sideSessionId = currentSessionId || selectedSession?.id || null;
  const activeCommandKey = commandExecutionKey(activeCommandSessionId);
  const executingCommand = executingCommands.get(activeCommandKey) ?? null;
  // Non-null while a send failed due to WS disconnect; cleared on next attempt or after timeout.
  const [sendError, setSendError] = useState<string | null>(null);
  // Locks turn-scoped controls synchronously from accepted submit through the
  // attachment-upload window, before the parent `isLoading` state can render.
  const [isSubmitSealed, setIsSubmitSealed] = useState(false);
  const submitSealRef = useRef(false);
  const sendErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True between issuing an abort and the server confirming it (complete/aborted
  // or error). Disables the STOP button so a double-click can't fire two aborts,
  // and gives the user immediate feedback that the stop is in flight.
  const [isAborting, setIsAborting] = useState(false);
  const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const handleSubmitRef = useRef<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;

  /**
   * ‏T-1319 — هل تُرسل ضغطةُ Enter المجرّدة على هذا الجهاز الآن؟ محلولةٌ من
   * النيّة المخزَّنة (`auto|send|newline`) ومن `(any-pointer: fine)` حيّاً.
   */
  const enterSendsLive = useResolvedEnterBehavior();
  /**
   * **حرس المسودّة.** تغيّر البيئة لا يُطبَّق ما دامت المسودّة غير فارغة؛
   * القيمة تُثبَّت حتى تُفرَّغ. وإلّا: يكتب المستخدم رسالةً متعدّدة الأسطر على
   * جهاز لوحي (‏Enter = سطر جديد)، ثمّ يصل ماوساً أو لوحة مفاتيح، فينقلب
   * الاستعلام تحته وترسل ضغطةُ Enter التالية مسودّةً نصفَ مكتوبة. الالتقاط
   * يحدث عند أول ضغطة والمسودّة خالية — وهي اللحظة التي لا شيء فيها ليضيع.
   */
  const enterSendsRef = useRef(enterSendsLive);
  // اللحاق بالبيئة كلّما كانت المسودّة خالية — لا عند ضغطة Enter وحدها. وإلّا
  // بقيت قيمةُ لحظة التركيب سارية عند من غيّر بيئته ثمّ كتب أول رسالة.
  // ‏(‏`input` لا `inputValueRef` هنا قصداً: مزامنةُ الـref تحدث في تأثيرٍ
  // لاحق، فقراءتها في هذا الموضع تُعطي قيمة التصييرة السابقة.)
  useEffect(() => {
    if (input.length === 0) {
      enterSendsRef.current = enterSendsLive;
    }
  }, [enterSendsLive, input]);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'compact': {
          const compactData = (data || {}) as CompactCommandData;
          addMessage({
            type: 'assistant',
            content: compactData.message || t('commands.compactStarted', {
              defaultValue: 'Context compaction started.',
            }),
            timestamp: Date.now(),
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          {
            const content = readCommandResultMessage(result);
            addMessage({
              type: 'assistant',
              content: content || t('customCommand.emptyResult', {
                defaultValue: 'Could not display the command result: no content was returned.',
              }),
              timestamp: Date.now(),
            });
          }
      }
    },
    [onFileOpen, onShowSettings, addMessage, t],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        t('customCommand.confirmBashExecution', {
          defaultValue: 'This command contains bash commands that will be executed. Do you want to proceed?',
        }),
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: t('customCommand.executionCancelled', { defaultValue: 'Command execution cancelled' }),
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage, t]);

  // T-1704: the immediate /compact dispatcher is defined after
  // dispatchProviderCommand; the menu hook only needs a stable entry point.
  const dispatchPassthroughCommandRef = useRef<((command: SlashCommand, remainingInput: string) => void) | null>(null);
  const dispatchPassthroughCommand = useCallback((command: SlashCommand, remainingInput: string) => {
    dispatchPassthroughCommandRef.current?.(command, remainingInput);
  }, []);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string) => {
      const executionSessionId = currentSessionId ?? selectedSession?.id ?? null;
      const executionKey = commandExecutionKey(executionSessionId);
      if (!command || !selectedProject || executingCommandsRef.current.has(executionKey)) {
        return;
      }

      const execution: ExecutingSlashCommand = {
        name: command.name,
        sessionId: executionSessionId,
      };
      // Acquire before the first await so a double click / double Enter can
      // never issue two HTTP requests, even before React commits the state.
      executingCommandsRef.current.set(executionKey, execution);
      setExecutingCommands((current) => {
        const next = new Map(current);
        next.set(executionKey, execution);
        return next;
      });

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // T-1029 / B-247: السياق يستعمل displayProvider (مزوّد الجلسة المفتوحة =
        // selectedSession?.__provider ?? provider) لا provider العام. سبب البق:
        // كتابة المفتاح تحت provider العام بينما sessionId للجلسة المفتوحة تجعل
        // مفتاح active-model لا يُقرأ أبداً في resolveResumeModel (المفتاح يُخزَّن
        // كـ`<displayProvider>:<sessionId>` ويُقرأ بنفس الصيغة). إذا تطابق المزوّدان
        // فلا فرق، وإذا اختلفا يُكتب المفتاح الصحيح.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: executionSessionId,
          provider: displayProvider,
          model:
            displayProvider === 'cursor'
              ? cursorModel
              : displayProvider === 'codex'
                ? codexModel
                : displayProvider === 'gemini'
                  ? geminiModel
                  : displayProvider === 'antigravity'
                    ? antigravityModel
                    : displayProvider === 'opencode'
                      ? opencodeModel
                      : displayProvider === 'hermes'
                        ? hermesModel
                        : displayProvider === 'kimi'
                          ? kimiModel
                          : displayProvider === 'deepseek'
                            ? deepseekModel
                            : displayProvider === 'glm'
                              ? glmModel
                              : claudeModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        } else {
          throw new Error(t('customCommand.invalidResult', {
            defaultValue: 'The command returned an unsupported result.',
          }));
        }
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : t('customCommand.unknownError', { defaultValue: 'Unknown error' });
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: t('customCommand.executeError', {
            message,
            defaultValue: 'Error executing command: {{message}}',
          }),
          timestamp: Date.now(),
        });
      } finally {
        if (executingCommandsRef.current.get(executionKey) === execution) {
          executingCommandsRef.current.delete(executionKey);
          setExecutingCommands((current) => {
            if (current.get(executionKey) !== execution) return current;
            const next = new Map(current);
            next.delete(executionKey);
            return next;
          });
        }
      }
    },
    [
      antigravityModel,
      claudeModel,
      codexModel,
      currentSessionId,
      cursorModel,
      geminiModel,
      hermesModel,
      opencodeModel,
      kimiModel,
      deepseekModel,
      glmModel,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      displayProvider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      t,
      tokenBudget,
    ],
  );

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
    isCommandExecutionDisabled,
  } = useSlashCommands({
    selectedProject,
    selectedSession,
    // Command discovery must follow the harness of the open session. The
    // global provider selector can point at a different harness while an old
    // session remains open; using it leaked Claude commands into Codex and
    // caused native actions such as /compact to be sent as ordinary prompts.
    provider: displayProvider as LLMProvider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
    onDispatchPassthroughCommand: dispatchPassthroughCommand,
    isExecutableCommandRunning: executingCommand !== null,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const handleImageFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (!file.type || !file.type.startsWith('image/')) {
          return false;
        }

        if (!file.size || file.size > 5 * 1024 * 1024) {
          const fileName = file.name || 'Unknown file';
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 5MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedImages((previous) => {
        const combined = [...previous, ...validFiles];
        const next = combined.slice(0, MAX_IMAGES);

        if (combined.length > MAX_IMAGES && next.length > 0) {
          // Surface a visible error on the last kept attachment, since the
          // overflow files are dropped and never rendered as attachments.
          const anchorName = next[next.length - 1].name || 'Unknown file';
          setImageErrors((previousErrors) => {
            const updated = new Map(previousErrors);
            updated.set(anchorName, `You can attach at most ${MAX_IMAGES} images`);
            return updated;
          });
        }

        return next;
      });
    }
  }, []);

  const handleNonImageFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        // Accept by MIME type, or fall back to extension for types browsers misdetect.
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        const allowedExtensions = new Set([
          'pdf', 'xls', 'xlsx', 'ods', 'csv', 'tsv',
          'doc', 'docx', 'ppt', 'pptx',
          'txt', 'md', 'json', 'zip',
        ]);
        const typeOk = ALLOWED_FILE_TYPES.has(file.type) || allowedExtensions.has(ext);
        if (!typeOk) {
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(file.name, t('fileAttachment.errorType'));
            return next;
          });
          return false;
        }

        if (file.size > MAX_FILE_SIZE) {
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(file.name, t('fileAttachment.errorSize'));
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating non-image file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => {
        const combined = [...previous, ...validFiles];
        const next = combined.slice(0, MAX_FILES);

        if (combined.length > MAX_FILES && next.length > 0) {
          const anchorName = next[next.length - 1].name || 'Unknown file';
          setFileErrors((previousErrors) => {
            const updated = new Map(previousErrors);
            updated.set(anchorName, t('fileAttachment.errorCount', { max: MAX_FILES }));
            return updated;
          });
        }

        return next;
      });
    }
  }, [t]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleImageFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const nonImageFiles = files.filter((file) => !file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleImageFiles(imageFiles);
        }
        if (nonImageFiles.length > 0) {
          handleNonImageFiles(nonImageFiles);
        }
      }
    },
    [handleImageFiles, handleNonImageFiles],
  );

  const handleDroppedFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    const nonImageFiles = files.filter((f) => !f.type.startsWith('image/'));
    if (imageFiles.length > 0) handleImageFiles(imageFiles);
    if (nonImageFiles.length > 0) handleNonImageFiles(nonImageFiles);
  }, [handleImageFiles, handleNonImageFiles]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
      'application/pdf': ['.pdf'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
      'text/csv': ['.csv'],
      'text/tab-separated-values': ['.tsv'],
      'application/msword': ['.doc'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.ms-powerpoint': ['.ppt'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
      'application/json': ['.json'],
      'application/zip': ['.zip'],
    },
    maxSize: MAX_FILE_SIZE,
    maxFiles: MAX_IMAGES + MAX_FILES,
    onDrop: handleDroppedFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Reads the per-provider tool settings persisted in localStorage, falling back
  // to permissive defaults when none are stored or parsing fails.
  // Reads per-provider tool settings for `targetProvider` — the provider the turn
  // is actually dispatched to (the SESSION's provider when resuming), not
  // necessarily the composer's global selection (B-167).
  const getToolsSettings = useCallback((targetProvider: LLMProvider) => {
    try {
      const settingsKey =
        targetProvider === 'cursor'
          ? 'cursor-tools-settings'
          : targetProvider === 'codex'
            ? 'codex-settings'
            : targetProvider === 'gemini'
              ? 'gemini-settings'
              : targetProvider === 'antigravity'
                ? 'antigravity-settings'
                : 'claude-settings';
      const savedSettings = safeLocalStorage.getItem(settingsKey);
      if (savedSettings) {
        return JSON.parse(savedSettings);
      }
    } catch (error) {
      console.error('Error loading tools settings:', error);
    }

    return { allowedTools: [], disallowedTools: [], skipPermissions: false };
  }, []);

  /**
   * اختيار المُؤلِّف الحالي للنموذج تحت مزوّد بعينه.
   *
   * مُشترك بين مسار الإرسال (الذي كان كل فرع فيه يقرأ متغيّره هو) وبين تسجيل
   * نيّة صاحب الرسالة في صندوق الصادر — فما يُحفظ للإعادة هو بالضبط ما أُرسل.
   */
  const composerModelFor = useCallback((target: string): string => (
    target === 'cursor' ? cursorModel
      : target === 'codex' ? codexModel
        : target === 'gemini' ? geminiModel
          : target === 'antigravity' ? antigravityModel
            : target === 'opencode' ? opencodeModel
              : target === 'hermes' ? hermesModel
                : target === 'kimi' ? kimiModel
                  : target === 'deepseek' ? deepseekModel
                    : target === 'glm' ? glmModel
                      : target === 'qwen' ? qwenModel
                      : claudeModel
  ), [
    antigravityModel, claudeModel, codexModel, cursorModel, deepseekModel,
    geminiModel, glmModel, hermesModel, kimiModel, opencodeModel, qwenModel,
  ]);

  // Single source of truth for building and sending a provider chat command.
  // `targetSessionId` is null/undefined for a brand-new conversation. Shared by
  // the composer submit and the explicit "start new session" retry action so
  // both paths stay in lockstep across providers.
  // Returns false when the WS was not connected (message not sent).
  const dispatchProviderCommand = useCallback(
    (
      messageContent: string,
      targetSessionId: string | null | undefined,
      uploadedImages: unknown[] = [],
      effortValue?: string,
      uploadedFiles: ChatFile[] = [],
      meta: DispatchMeta = {},
    ): boolean => {
      // T-1295 — نيّة صاحب الرسالة كما كانت لحظة إرسالها الأول، تُعاد عند إعادة
      // الإرسال من صندوق الصادر. غائبة تماماً في المسار العادي (`{}`)، فكل قيمة
      // تسقط إلى اختيار المُؤلِّف الحالي حرفياً كما كانت.
      //
      // ولا تدخلها `toolsSettings`: تُقرأ حيّةً أدناه في كل الأحوال. إعادة
      // `skipPermissions: true` محفوظةً بعد أن أطفأه المستخدم انحدارُ صلاحيات.
      const intent = meta.intent;
      const clientMsgId = meta.clientMsgId;
      const resolvedProjectPath = selectedProject?.fullPath || selectedProject?.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, messageContent);
      const resume = Boolean(targetSessionId);
      // Seal the turn to the conversation's OWN provider when resuming, so a
      // provider/model picked for a NEW chat can never cross into a running
      // conversation of another provider system (B-167). A brand-new conversation
      // (no targetSessionId) uses the composer's current global selection.
      // ‏`intent.provider` يحلّ محلّ **اختيار المُؤلِّف** لا محلّ الختم: ختمُ
      // المحادثة على مزوّدها (B-167) خاصية أمان تبقى فوق النيّة المستعادة.
      const composerProvider = (intent?.provider as LLMProvider | undefined) ?? provider;
      const effectiveProvider = resolveSendProvider(resume, selectedSession?.__provider, composerProvider);
      // النموذج: نيّة صاحب الرسالة إن وُجدت، وإلا اختيار المُؤلِّف لهذا المزوّد.
      const effectiveModel = intent?.model ?? composerModelFor(effectiveProvider);
      const effectivePermissionMode = intent?.permissionMode ?? permissionMode;
      const effectiveComposerMode = intent?.composerMode ?? composerMode;
      const effectiveCoordinationLevel = intent
        ? narrowCoordinationLevel(intent.coordinationLevel)
        : narrowCoordinationLevel(coordinationLevel);
      // T-915 (privacy fix): seal engineProvider (ADR-037) to the session being
      // resumed, the same way effectiveProvider is sealed above, and read it
      // fresh from the per-session stamp rather than trusting the composer's
      // `engineProvider` React state to have already re-synced for whichever
      // session is being resumed. A resume must never carry a vendor chosen for
      // an unrelated new chat (the confirmed T-882 leak: an official Anthropic
      // session resumed while the global picker still held "Claude via Kimi").
      // A brand-new conversation (resume===false) keeps the composer's current
      // selection, exactly like effectiveProvider.
      const effectiveEngineProvider = resume && targetSessionId
        ? readSessionEngineProvider(targetSessionId)
        // النيّة المحفوظة نصٌّ عند التخزين (JSON)، فتُضيَّق هنا إلى فضاء القيم
        // الذي يقبله ختمُ المحرّك — قيمةٌ غريبة تُقرأ `null` أي المسار الرسمي،
        // وهو الانحدار الآمن الوحيد (ADR-037).
        : (intent?.engineProvider !== undefined
          ? narrowEngineProvider(intent.engineProvider)
          : engineProvider);
      const toolsSettings = getToolsSettings(effectiveProvider);

      // KM-3/GL-8 (ADR-062): send the governed agent-mode flag ONLY when the
      // composer toggle is 'agent' AND the resolved (sealed-on-resume) provider
      // actually offers an agent surface — isAgentModeAvailable re-checks the
      // client fleet flag for glm (VITE_NASSAJ_OPENCODE_CARRIER). Chat (default)
      // attaches no `mode`, so every existing provider path is byte-for-byte
      // unchanged. The server re-enforces this gate fail-closed regardless.
      const wantsAgentMode = effectiveComposerMode === 'agent' && isAgentModeAvailable(effectiveProvider);
      const wantsCoordinationLevel = getProviderCapabilities(effectiveProvider).coordinationLevel.supported;

      /**
       * T-1295 — المخرج الوحيد إلى السلك، وفيه تُطبَّق **نيّة صاحب الرسالة**
       * وتُلصَق هويةُ الجولة.
       *
       * الثلاثة هنا لا في كل فرع مزوّد: قيمة واحدة لكل منها تُشتقّ أعلاه
       * (`effectiveModel`, `effectivePermissionMode`, `clientMsgId`)، وتوزيعُها
       * على عشرة فروع يعني عشرة مواضع يجب أن تتغيّر معاً — وأولُ فرعٍ يُنسى
       * يُرسل بنيّة المُؤلِّف الحالية بدل نيّة صاحب الرسالة، بصمت.
       *
       * • `model` — كان كل فرع يقرأ متغيّره هو، وهو بالضبط ما يعطيه
       *   `composerModelFor(effectiveProvider)`، فالقيمة لم تتغيّر في المسار
       *   العادي؛ إنما صار للنيّة المستعادة مدخلٌ واحد.
       * • `permissionMode` — يُكتب فقط حيث كان مكتوباً أصلاً (`!== undefined`)،
       *   فلا يُحقن في مزوّد لا يقرؤه. وتحويلُ `plan → default` يبقى لـcodex
       *   وحده كما كان في فرعه.
       * • `clientMsgId` — يصدى به الخادم في حمولات هذه الجولة، فيُربط الحكمُ
       *   بإدخال صندوق الصادر الصحيح لا بـ«أحدث معلَّق». غيابه (اختبار/مسار
       *   قديم) لا يكسر شيئاً: الخادم يتجاهل ما لا يعرف.
       */
      const dispatch = (payload: {
        type: string;
        command: string;
        sessionId?: string | null;
        options: Record<string, unknown>;
      }) => {
        const options: Record<string, unknown> = { ...payload.options, model: effectiveModel };
        if (options.permissionMode !== undefined) {
          options.permissionMode =
            payload.type === 'codex-command' && effectivePermissionMode === 'plan'
              ? 'default'
              : effectivePermissionMode;
        }
        if (clientMsgId) {
          options.clientMsgId = clientMsgId;
        }
        // B-1078: the receipt manifest also mints identity for image/file messages,
        // whose attachments the server folds into a text path annotation before the
        // engine sees them, so the engine payload stays pure text and `kind` remains
        // 'text'. The declared counts MUST equal what the server receives on
        // `options.images`/`options.files`. We still withhold it when the user attached
        // something the upload dropped (ineligible with zero uploaded attachments),
        // preserving B-894's "no text receipt once an intended attachment vanished".
        const receiptImageCount = uploadedImages.length;
        const receiptFileCount = uploadedFiles.length;
        if (clientMsgId
          && ['claude', 'qwen', 'hermes', 'kimi', 'deepseek', 'glm'].includes(effectiveProvider)
          && options.mode !== 'agent'
          && (meta.historyEligibility === 'text_only' || receiptImageCount > 0 || receiptFileCount > 0)) {
          options.receiptPayload = { version: 1, kind: 'text', imageCount: receiptImageCount, fileCount: receiptFileCount };
        }
        if (wantsCoordinationLevel) {
          options.coordinationLevel = effectiveCoordinationLevel;
        }
        return sendMessage({ ...payload, options });
      };

      let result: { ok: boolean } | void;
      if (effectiveProvider === 'cursor') {
        result = dispatch({
          type: 'cursor-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: cursorModel, skipPermissions: toolsSettings?.skipPermissions || false,
            sessionSummary, toolsSettings,
          },
        });
      } else if (effectiveProvider === 'codex') {
        // T-905: mirrors the Claude branch's `effort` handling below — attach
        // `reasoningEffort` only when a non-empty value is chosen (the UI only
        // ever offers codex the none/low/medium/high/xhigh subset, see
        // providerCapabilities.ts codex.effort.modes). The server (openai-codex.js
        // queryCodexUnlocked) re-validates against the SDK's own enum regardless —
        // this is not the sole safety net.
        const codexOptions: Record<string, unknown> = {
          cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
          resume, model: codexModel, sessionSummary,
          permissionMode: permissionMode === 'plan' ? 'default' : permissionMode,
          images: uploadedImages,
        };
        if (effortValue) {
          codexOptions.reasoningEffort = effortValue;
        }
        result = dispatch({
          type: 'codex-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: codexOptions,
        });
      } else if (effectiveProvider === 'gemini') {
        result = dispatch({
          type: 'gemini-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: geminiModel, sessionSummary, permissionMode, toolsSettings,
          },
        });
      } else if (effectiveProvider === 'antigravity') {
        result = dispatch({
          type: 'antigravity-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: antigravityModel, sessionSummary, permissionMode, toolsSettings,
          },
        });
      } else if (effectiveProvider === 'opencode') {
        // OC-22: opencode `run` consumes attachments via -f/--file, so forward
        // images and files (the same payload shape as Claude). The server
        // materializes base64 images to temp files and resolves file paths, then
        // passes each as --file. Empty arrays are a no-op on the server side.
        const opencodeOptions: Record<string, unknown> = {
          cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
          resume, model: opencodeModel, sessionSummary,
          images: uploadedImages,
        };
        if (uploadedFiles.length > 0) {
          opencodeOptions.files = uploadedFiles.map((f) => ({ path: f.relPath ?? f.path, name: f.name }));
        }
        result = dispatch({
          type: 'opencode-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: opencodeOptions,
        });
      } else if (effectiveProvider === 'hermes') {
        result = dispatch({
          type: 'hermes-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: hermesModel, sessionSummary,
          },
        });
      } else if (effectiveProvider === 'kimi') {
        result = dispatch({
          type: 'kimi-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: kimiModel, sessionSummary,
            // KM-3: 'agent' routes the WS dispatch to the native governed launcher
            // (spawnKimiAgent); omitted on the default chat turn.
            ...(wantsAgentMode ? { mode: 'agent' } : {}),
          },
        });
      } else if (effectiveProvider === 'deepseek') {
        result = dispatch({
          type: 'deepseek-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: deepseekModel, sessionSummary,
          },
        });
      } else if (effectiveProvider === 'glm') {
        result = dispatch({
          type: 'glm-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: glmModel, sessionSummary,
            // GL-8: 'agent' routes the WS dispatch to the OpenCode carrier
            // (carrier=true, glm/<model>); omitted on the default chat turn.
            ...(wantsAgentMode ? { mode: 'agent' } : {}),
          },
        });
      } else if (effectiveProvider === 'qwen') {
        result = dispatch({
          type: 'qwen-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: effectiveModel, sessionSummary, permissionMode: effectivePermissionMode,
          },
        });
      } else {
        // T-915 (privacy fix, qa-critic correction): record the value being
        // SENT right now into the pending slot so session_created can stamp the
        // new session id with it.  Only for new conversations (resume=false) —
        // a resume already has its stamp from creation time; it must NOT
        // overwrite that stamp with a potentially-stale global selection.
        // effectiveEngineProvider is already sealed to the session's own stamp
        // for resumes (line above) but writePendingEngineStamp is a no-op for
        // resumes anyway since session_created never fires for a healthy resume.
        if (!resume) {
          writePendingEngineStamp(effectiveEngineProvider);
        }
        // Anthropic / Claude provider. Attach `effort` only when a non-empty value is chosen.
        const claudeOptions: Record<string, unknown> = {
          projectPath: resolvedProjectPath, cwd: resolvedProjectPath, sessionId: targetSessionId,
          resume, toolsSettings, permissionMode, model: claudeModel, sessionSummary,
          images: uploadedImages,
        };
        if (effortValue) {
          claudeOptions.effort = effortValue;
        }
        // File attachments are Claude-only (server contract).
        if (uploadedFiles.length > 0) {
          claudeOptions.files = uploadedFiles.map((f) => ({ path: f.relPath ?? f.path, name: f.name }));
        }
        // ADR-037 (B-DEL-6): the "allow delegating subtasks to other models"
        // toggle lives in the Claude agent settings (claude-settings, the same
        // blob toolsSettings is for provider==='claude'). When on, the server
        // registers the per-spawn vendor-delegate MCP server keyed to the user.
        // Omitted entirely (falsy) on the default path.
        if (toolsSettings?.allowVendorDelegation) {
          claudeOptions.allowVendorDelegation = true;
        }
        // ADR-037: when the Claude engine is routed through a vendor endpoint,
        // the server reads options.engineProvider to inject that vendor's
        // ANTHROPIC_BASE_URL/AUTH_TOKEN and passes `model` (a vendor model id)
        // through unchanged. Omitted entirely on the normal official path.
        if (effectiveEngineProvider) {
          claudeOptions.engineProvider = effectiveEngineProvider;
        }
        result = dispatch({
          type: 'claude-command',
          command: messageContent,
          options: claudeOptions,
        });
      }
      // If sendMessage returns void (legacy/compat callers), treat as ok.
      return result == null ? true : result.ok;
    },
    [
      antigravityModel, claudeModel, codexModel, cursorModel, geminiModel, opencodeModel,
      hermesModel, kimiModel, deepseekModel, glmModel, qwenModel, engineProvider, composerMode, coordinationLevel,
      getToolsSettings, permissionMode, provider, selectedProject, selectedSession, sendMessage,
      composerModelFor,
    ],
  );

  // T-1704: Claude `/compact` picked from the slash menu. It behaves like an
  // execute-style command for the operator — the "Running command /compact…"
  // bar and the "Context compaction started." note — while the command itself
  // travels raw to the CLI, which is the only place Claude compaction happens.
  // No user bubble, no draft consumed, no attachments: only the "/comp…" token
  // that opened the menu leaves the composer.
  const runPassthroughCompaction = useCallback(
    (command: SlashCommand, remainingInput: string) => {
      const sessionId = currentSessionId ?? selectedSession?.id ?? null;
      const executionKey = commandExecutionKey(sessionId);
      if (!selectedProject || isLoading || executingCommandsRef.current.has(executionKey)) {
        return;
      }
      setInput(remainingInput);
      inputValueRef.current = remainingInput;

      const execution: ExecutingSlashCommand = { name: command.name, sessionId, passthrough: true };
      executingCommandsRef.current.set(executionKey, execution);
      setExecutingCommands((current) => new Map(current).set(executionKey, execution));

      addMessage({
        type: 'assistant',
        content: t('commands.compactStarted', { defaultValue: 'Context compaction started.' }),
        timestamp: Date.now(),
      });
      setIsLoading(true);
      setCanAbortSession(true);
      setClaudeStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
      if (sessionId) {
        onSessionActive?.(sessionId);
        onSessionProcessing?.(sessionId);
      }

      const sent = dispatchProviderCommand(command.name, sessionId);
      if (!sent) {
        executingCommandsRef.current.delete(executionKey);
        setExecutingCommands((current) => {
          const next = new Map(current);
          next.delete(executionKey);
          return next;
        });
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        setSendError(t('ws.sendFailed', { defaultValue: 'Message not sent — connection lost' }));
      }
    },
    [
      addMessage, currentSessionId, dispatchProviderCommand, isLoading, onSessionActive, onSessionProcessing,
      selectedProject, selectedSession?.id, setCanAbortSession, setClaudeStatus, setIsLoading, t,
    ],
  );
  useEffect(() => {
    dispatchPassthroughCommandRef.current = runPassthroughCompaction;
  }, [runPassthroughCompaction]);

  // The raw dispatch has no HTTP promise to settle on: release its bar and lock
  // when the session's run ends (result, abort or error all clear isLoading).
  useEffect(() => {
    if (isLoading) return;
    const entry = executingCommandsRef.current.get(activeCommandKey);
    if (!entry?.passthrough) return;
    executingCommandsRef.current.delete(activeCommandKey);
    setExecutingCommands((current) => {
      if (current.get(activeCommandKey) !== entry) return current;
      const next = new Map(current);
      next.delete(activeCommandKey);
      return next;
    });
  }, [activeCommandKey, isLoading]);


  /* ------------------------------------------------------------------ */
  /*  T-1295 — صندوق الصادر: الإدخالات المعروضة وأفعالها الثلاثة          */
  /* ------------------------------------------------------------------ */

  const outboxAll = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, getOutboxSnapshot);
  const outboxSessionId = currentSessionId ?? selectedSession?.id ?? null;
  useEffect(() => {
    if (outboxSessionId && outboxHistory) reconcileOutboxDeliveryEvidence(outboxSessionId, outboxHistory);
  }, [outboxHistory, outboxSessionId, outboxAll]);
  /**
   * B-521: حالة عملية الجلسة المعروضة. كل إدخال يمرّ الفلتر يخصّ هذه الجلسة
   * بعينها (النطاق يطابق `sessionId`)، فحالةٌ واحدة تكفي للحكم على جميعها.
   * جولةٌ جارية = الرسالة سُلِّمت ونُفِّذت مهما طالت، فلا بطاقة إنذار عليها.
   */
  const outboxSessionState = useSessionProcessState(outboxSessionId);
  const outboxSessionStateAuthoritative = useSessionProcessStateAuthority(outboxSessionId);
  /**
   * نبضة تُعيد تقييم مهلة الشكّ وحدها. بلا واحدة، إدخالٌ معلَّق لجلسةٍ سكنت
   * يبقى مخفيّاً إلى أن يقع رندر لسببٍ آخر — وقد لا يقع أصلاً في محادثة هادئة.
   * مشروطة بوجود معلَّقٍ في النطاق فلا تدور على الفارغ.
   */
  const [outboxTick, setOutboxTick] = useState(0);
  const hasPendingInScope = useMemo(
    () => outboxAll.some((entry) => entry.status === 'pending'),
    [outboxAll],
  );
  useEffect(() => {
    if (!hasPendingInScope) return undefined;
    const timer = setInterval(() => setOutboxTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [hasPendingInScope]);

  /** المرشّحون: ما طابق النطاق واستحقّ الشكّ — قبل أن يُسأل عنه السجلّ. */
  const outboxCandidates = useMemo(
    () => selectVisibleEntries(
      outboxAll,
      selectedProject ? String(selectedProject.projectId) : null,
      outboxSessionId,
      {
        isSessionLive: () => outboxSessionState === 'running' || outboxSessionState === 'frozen',
        isSessionStateAuthoritative: () => outboxSessionStateAuthoritative,
      },
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- outboxTick نبضةُ إعادة تقييم للمهلة لا قيمة تُقرأ.
    [
      outboxAll,
      selectedProject,
      outboxSessionId,
      outboxSessionState,
      outboxSessionStateAuthoritative,
      outboxTick,
    ],
  );

  // Receipt recovery retries unknown evidence within a bounded connection epoch.
  // Only exact canonical identity removes the local copy; acceptance keeps it.
  const [recoveryWake, setRecoveryWake] = useState(0);
  useEffect(() => {
    let lastWake = 0;
    const wake = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastWake < 60_000) return;
      lastWake = Date.now();
      setRecoveryWake((value) => value + 1);
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  const recoveryRef = useRef<ReturnType<typeof createOutboxReceiptRecovery> | null>(null);
  const verifyDeliveryRef = useRef(verifyMessageDelivered);
  verifyDeliveryRef.current = verifyMessageDelivered;
  /**
   * B-539 — الإدخالات التي **انقضى** التحقّق منها ولم تُحذف: هي وحدها ما يُعرض.
   *
   * البطاقة كانت تظهر لحظة فتح المحادثة ثم تختفي بعد ثانية — ووميضُ إنذارٍ
   * كاذب أسوأ من إنذارٍ ثابت: يراه صاحبه فيصدّقه، ثم يزول فلا يدري أكان حقّاً
   * أم وهماً. والسبب أن العرض كان يسبق الحكم: الإدخال يُرسم فور أن يستحقّ
   * الشكّ، بينما جوابُ السجلّ ما يزال في الطريق (وسجلّ المحادثة نفسه لم
   * يُحمَّل بعد — «Loading session messages…» في لقطة المالك).
   *
   * فالقاعدة: لا بطاقة قبل حكم. ‏`failed` وحده يُعرض فوراً — حكمٌ صريح وصل من
   * الخادم لا ظنٌّ ينتظر تأكيداً.
   */
  const [settledOutboxIds, setSettledOutboxIds] = useState<ReadonlySet<string>>(() => new Set());
  const settleOutboxEntry = useCallback((entryId: string) => {
    setSettledOutboxIds((current) => {
      if (current.has(entryId)) return current;
      const next = new Set(current);
      next.add(entryId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!outboxSessionStateAuthoritative) return;
    const recovery = createOutboxReceiptRecovery(
      async (entry, signal) => {
        const verdict = await verifyDeliveryRef.current?.(entry.sessionId!, entry.id, entry.intent.provider, signal);
        return verdict === true || verdict === 'accepted' ? verdict : false;
      },
      (entry, delivered) => {
        if (!getOutboxSnapshot().includes(entry)) return;
        // This callback can establish ingress/native identity, never the full
        // attachment projection required for automatic disposal.  The v2
        // recovery hook supplies the typed canonical proof separately.
        if (delivered === true) confirmOutboxEntry(entry.id);
        else if (delivered === 'accepted') confirmOutboxEntry(entry.id);
        settleOutboxEntry(entry.id);
      },
    );
    recoveryRef.current = recovery;
    return () => { recovery.dispose(); recoveryRef.current = null; };
  }, [authUserId, outboxSessionId, outboxSessionStateAuthoritative, recoveryWake, settleOutboxEntry]);

  useEffect(() => {
    recoveryRef.current?.reconcile(outboxCandidates);
    for (const entry of outboxCandidates) {
      if (!entry.sessionId || !verifyMessageDelivered) settleOutboxEntry(entry.id);
    }
  }, [outboxCandidates, authUserId, outboxSessionId, outboxSessionStateAuthoritative, recoveryWake, settleOutboxEntry, verifyMessageDelivered]);

  const outboxEntries = useMemo(
    () => outboxCandidates.filter(
      (entry) => entry.status === 'failed' || entry.status === 'delivered'
        || (entry.status === 'unconfirmed' && entry.reasonCode === 'message_dispatch_unconfirmed')
        || settledOutboxIds.has(entry.id),
    ),
    [outboxCandidates, settledOutboxIds],
  );

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();

      // Execute-style slash commands own a synchronous lock for their session
      // until their fetch settles. Other conversations remain available.
      if (executingCommandsRef.current.has(activeCommandKey)) {
        return;
      }

      // T-1769: المسافات والسطور الفارغة في نهاية النص الملصوق لا تُرسل؛
      // البداية والإزاحة الداخلية تبقيان كما هما.
      const rawInput = inputValueRef.current.trimEnd();
      const sideChannelProvider = selectedSession?.__provider ?? provider;
      const currentInput = normalizeArabicSlashCommand(
        rawInput,
        sideChannelProvider,
        i18n?.language,
      );

      // T-849: اعتراض «/btw <سؤال>» — قناة جانبية على سياق الجلسة تُجاب في overlay
      // ولا تدخل مسار الرسائل العادي إطلاقاً (لا سجلّ محادثة ولا دور). يسبق بوابة
      // isLoading كي يعمل حتى أثناء البث. بوابة القدرات تفعّله لـClaude وCodex؛
      // ولغيرهما يسقط للسلوك القائم بلا تغيير. مزوّد الجلسة = __provider ثم العام.
      if (
        onBtwQuery
        && Boolean(sideSessionId)
        && getProviderCapabilities(sideChannelProvider).sideChannel.supported
        && isSideChannelCommandForProvider(currentInput, sideChannelProvider)
      ) {
        if (sendErrorTimerRef.current) clearTimeout(sendErrorTimerRef.current);
        sendErrorTimerRef.current = null;
        setSendError(null);
        onBtwQuery(parseBtwQuestion(currentInput));
        setInput('');
        inputValueRef.current = '';
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (selectedProject) {
          safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        }
        return;
      }

      // A localized side alias is reserved UI syntax. If its session,
      // capability, or question guard fails, do not degrade it into a normal
      // prompt or CLI command.
      const sideChannelSupported = getProviderCapabilities(sideChannelProvider).sideChannel.supported;
      const isReservedSideInput = (
        isArabicCodexSideAlias(rawInput, sideChannelProvider, i18n?.language) ||
        isReservedSideChannelCommandForProvider(currentInput, sideChannelProvider)
      );
      if (isReservedSideInput) {
        const question = parseBtwQuestion(currentInput);
        const feedbackKey = !sideSessionId
          ? 'btw.errors.session_not_found'
          : !sideChannelSupported
            ? 'btw.errors.unsupported_provider'
            : !question
              ? 'btw.errors.question_required'
              : 'btw.errors.sdk_error';
        setSendError(t(feedbackKey));
        if (sendErrorTimerRef.current) clearTimeout(sendErrorTimerRef.current);
        sendErrorTimerRef.current = setTimeout(() => setSendError(null), 6000);
        return;
      }

      if ((!currentInput.trim() && attachedImages.length === 0) || isLoading || submitSealRef.current || !selectedProject) {
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          resolveProviderCommandFallback(displayProvider as LLMProvider, commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        // T-881: «/btw» بلا سؤال (مسافة فارغة أو لا شيء بعد البادئة) — سبقتها
        // بوابة isBtwCommand أعلاه لكنها أعادت false (سؤال فارغ). نُجاهل الإرسال
        // صمتاً بدل توجيهه إلى الخادم أو CLI: لا تنفيذ، لا رسالة، لا خطأ.
        if (matchedCommand && isBtwSlashEntry(matchedCommand)) {
          return;
        }

        // Built-in commands without a UI handler (passthrough) and skills are NOT
        // sent to /api/commands/execute. They fall through below so the raw text
        // (including any args, e.g. `/review 123`) is dispatched straight to the
        // CLI via dispatchProviderCommand, exactly like a normal message.
        // OC-19ب: opencode namespace commands are also passthrough — they must reach
        // the opencode engine as raw "/name args", not /api/commands/execute which
        // 403s paths outside .claude/commands.
        if (
          matchedCommand &&
          matchedCommand.type !== 'skill' &&
          (!isPassthroughBuiltInCommand(matchedCommand) ||
            isProviderHandledBuiltInCommand(displayProvider as LLMProvider, matchedCommand)) &&
          !isOpenCodePassthroughCommand(matchedCommand)
        ) {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedImages([]);
          setUploadingImages(new Map());
          setImageErrors(new Map());
          setAttachedFiles([]);
          setUploadingFiles(new Map());
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;
      // Snapshot original attachments before awaiting upload responses or composer edits.
      const originalImages = [...attachedImages];
      const originalFileNames = attachedFiles.map(file => file.name);
      const historyEligibility: OutboxHistoryEligibility =
        attachedImages.length === 0 && attachedFiles.length === 0 ? 'text_only' : 'ineligible';
      // Resolve the effort value for the selected mode (empty string = no effort field).
      const selectedEffortMode = effortModes.find(m => m.id === thinkingMode);
      const effortValue = selectedEffortMode?.effortValue ?? '';

      let uploadedImages: unknown[] = [];
      let uploadedFiles: ChatFile[] = [];

      submitSealRef.current = true;
      setIsSubmitSealed(true);

      // Upload images and non-image files in parallel.
      const imageUploadPromise = (async () => {
        if (attachedImages.length === 0) return;
        const formData = new FormData();
        attachedImages.forEach((file) => {
          formData.append('images', file);
        });
        const response = await authenticatedFetch(`/api/projects/${selectedProject.projectId}/upload-images`, {
          method: 'POST',
          headers: {},
          body: formData,
        });
        if (!response.ok) throw new Error('Failed to upload images');
        const result = await response.json();
        uploadedImages = result.images;
      })();

      const fileUploadPromise = (async () => {
        if (attachedFiles.length === 0) return;
        const formData = new FormData();
        attachedFiles.forEach((file) => {
          formData.append('files', file);
        });
        const response = await authenticatedFetch(`/api/projects/${selectedProject.projectId}/upload-attachments`, {
          method: 'POST',
          headers: {},
          body: formData,
        });
        if (!response.ok) throw new Error('Failed to upload attachments');
        const result = await response.json();
        uploadedFiles = (result.files ?? []) as ChatFile[];
      })();

      try {
        await Promise.all([imageUploadPromise, fileUploadPromise]);
      } catch (error) {
        submitSealRef.current = false;
        setIsSubmitSealed(false);
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Upload failed:', error);
        addMessage({
          type: 'error',
          content: `Failed to upload files: ${message}`,
          timestamp: new Date(),
        });
        return;
      }

      const effectiveSessionId =
        currentSessionId || selectedSession?.id || sessionStorage.getItem('cursorSessionId');

      // This id is the immutable identity of both the optimistic bubble and
      // the wire-level run. Stream events echo it, so latency never relies on
      // “the most recent user message” (which fails for history and branches).
      const clientMsgId = createClientMsgId();
      const sendIntentProvider = resolveSendProvider(
        Boolean(effectiveSessionId),
        selectedSession?.__provider,
        provider,
      );
      if (sendIntentProvider === 'codex') {
        const completeUpload = Array.isArray(uploadedImages) && uploadedImages.length === originalImages.length;
        const validation = validateCodexImageInput(messageContent,
          completeUpload ? uploadedImages.map(image => (image as { data?: unknown } | null)?.data) : null);
        if (!validation.ok) {
          submitSealRef.current = false;
          setIsSubmitSealed(false);
          if (sendErrorTimerRef.current) {
            clearTimeout(sendErrorTimerRef.current);
            sendErrorTimerRef.current = null;
          }
          setSendError(t(validation.reason === 'too_large' ? 'codexImageInput.tooLarge' : 'codexImageInput.unsupported'));
          return;
        }
      }
      const savedOutbox = await recordOutboxEntryDurably({
        id: clientMsgId,
        projectId: String(selectedProject.projectId),
        sessionId: effectiveSessionId ?? null,
        text: messageContent,
        images: originalImages,
        fileNames: originalFileNames,
        historyEligibility,
        status: 'pending',
        intent: {
          provider: sendIntentProvider,
          model: composerModelFor(sendIntentProvider),
          effort: effortValue || undefined,
          permissionMode: typeof permissionMode === 'string' ? permissionMode : undefined,
          composerMode,
          coordinationLevel,
          engineProvider,
        },
      });

      if (!savedOutbox) {
        submitSealRef.current = false;
        setIsSubmitSealed(false);
        setSendError(t('outbox.storageFull'));
        return;
      }

      const userMessage: ChatMessage = {
        id: clientMsgId,
        type: 'user',
        content: currentInput,
        coordinationLevel,
        images: uploadedImages as any,
        files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        timestamp: new Date(),
        userId: authUserId,
      };

      addMessage(userMessage);
      setIsLoading(true); // Processing banner starts
      setCanAbortSession(true);
      setClaudeStatus({
        text: 'Processing',
        tokens: 0,
        can_interrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      if (!effectiveSessionId && !selectedSession?.id) {
        // This tracks that a request is in flight before the provider has
        // emitted its real session id; routing still waits for session_created.
        // B-1297: carry clientMsgId so the realtime handler can match a late
        // session_created to this specific send (cross-tab safety).
        pendingViewSessionRef.current = {
          sessionId: null,
          startedAt: Date.now(),
          clientMsgId,
        };
      }
      if (effectiveSessionId) {
        onSessionActive?.(effectiveSessionId);
        onSessionProcessing?.(effectiveSessionId);
      }


      const sent = dispatchProviderCommand(
        messageContent,
        effectiveSessionId,
        uploadedImages,
        effortValue,
        uploadedFiles,
        { clientMsgId, historyEligibility: savedOutbox.historyEligibility },
      );

      // Hand the lock to the run's `isLoading` state in the same React batch.
      submitSealRef.current = false;
      setIsSubmitSealed(false);

      if (!sent) {
        // WS was not open — roll back optimistic UI state and surface error.
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        const errMsg = t('ws.sendFailed', { defaultValue: 'Message not sent — connection lost' });
        setSendError(errMsg);
        if (sendErrorTimerRef.current) clearTimeout(sendErrorTimerRef.current);
        sendErrorTimerRef.current = setTimeout(() => setSendError(null), 6000);
        // فشلُ نقلٍ صريح: الإدخال يُرفع إلى بطاقةٍ فوراً — لا انتظار لحكمٍ من
        // خادمٍ لم تصله الرسالة أصلاً.
        markOutboxFailed(clientMsgId, { code: 'transport' });
        // وتُسحب الفقاعة المتفائلة التي أُضيفت قبل الإرسال: إبقاؤها يعرض رسالةً
        // «مُرسَلة» لم تُرسَل، فينتظر المستخدم رداً لن يأتي ثم يعيد الإرسال
        // (نفس آفة B-518، من بابٍ آخر). النصّ والصور صارا في البطاقة.
        withdrawOptimisticUserMessage?.(effectiveSessionId ?? null, clientMsgId);
        setInput('');
        inputValueRef.current = '';
        setAttachedImages([]);
        setAttachedFiles([]);
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        return;
      }

      setSendError(null);
      if (sendErrorTimerRef.current) {
        clearTimeout(sendErrorTimerRef.current);
        sendErrorTimerRef.current = null;
      }

      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedImages([]);
      setUploadingImages(new Map());
      setImageErrors(new Map());
      setAttachedFiles([]);
      setUploadingFiles(new Map());
      setFileErrors(new Map());
      setIsTextareaExpanded(false);
      // مستوى التفكير لا يُصفَّر بعد الإرسال: هو خاصية المحادثة لا خاصية الرسالة
      // الواحدة. تصفيره هنا كان يجعل كل رسالة تالية تعود للافتراضي بصمت، فيدفع
      // المستخدم كلفة مستوى لم يخترْه. الثبات + الاستعادة في effort-sticky أدناه.

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
    },
    [
      activeCommandKey,
      selectedSession,
      sideSessionId,
      attachedImages,
      attachedFiles,
      authUserId,
      currentSessionId,
      dispatchProviderCommand,
      displayProvider,
      executeCommand,
      isLoading,
      onBtwQuery,
      provider,
      onSessionActive,
      onSessionProcessing,
      pendingViewSessionRef,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      setCanAbortSession,
      addMessage,
      setClaudeStatus,
      setIsLoading,
      setIsUserScrolledUp,
      slashCommands,
      thinkingMode,
      t,
      i18n,
      // T-1295: تُقرأ لتسجيل نيّة صاحب الرسالة ولسحب فقاعتها عند فشل النقل.
      composerMode,
      coordinationLevel,
      composerModelFor,
      engineProvider,
      permissionMode,
      withdrawOptimisticUserMessage,
    ],
  );

  // Explicit "start new session" retry. Invoked from the conversation_not_found
  // error bubble: re-sends the command that failed to resume as a brand-new
  // conversation (no resume id), reusing the exact dispatch path of a normal
  // submit so a fresh provider session id is minted via `session_created`.
  const startFreshSession = useCallback(
    (command: string) => {
      const trimmed = (command || '').trim();
      if (!trimmed || isLoading || !selectedProject) {
        return;
      }

      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('pendingSessionId');
      }
      pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now() };

      addMessage({ type: 'user', content: command, timestamp: new Date(), userId: authUserId });
      setIsLoading(true);
      setCanAbortSession(true);
      setClaudeStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      dispatchProviderCommand(command, undefined);
    },
    [
      addMessage, authUserId, dispatchProviderCommand, isLoading, pendingViewSessionRef, scrollToBottom,
      selectedProject, setCanAbortSession, setClaudeStatus, setIsLoading, setIsUserScrolledUp,
    ],
  );

  /**
   * إعادة إرسال إدخال من صندوق الصادر.
   *
   * ثلاثة قرارات مقصودة:
   *  • **هوية الإعادة تتبع حكم الخادم**: يُعاد المعرّف نفسه فقط بإذن صريح؛
   *    وإلا تنشأ محاولة بمعرّف جديد بعد التحقق من اكتمال الحمولة.
   *  • **`toolsSettings` حيّة**: لا تُحفظ ولا تُعاد — `dispatchProviderCommand`
   *    يقرؤها بنفسه عند كل إرسال. إعادةُ `skipPermissions: true` محفوظةً بعد أن
   *    أطفأه المستخدم انحدارُ صلاحيات صامت.
   *  • **`sessionId`/`resume` يُحسبان الآن**: قد تكون المحادثة وُلدت بين
   *    المحاولتين، فالإعادة تستأنفها بدل أن تفتح محادثة ثانية.
   */
  /**
   * ‏B-553/م5 — محاولةٌ جديدة ⇒ حكمٌ جديد: يُنسى أنها فُحصت وأنها سُوّيت، وإلا
   * بقيت معروضةً بحكمٍ يخصّ المحاولة الماضية.
   */
  const resetOutboxJudgement = useCallback((entryId: string) => {
    recoveryRef.current?.reset(entryId);
    setSettledOutboxIds((current) => {
      if (!current.has(entryId)) return current;
      const next = new Set(current);
      next.delete(entryId);
      return next;
    });
  }, []);

  const activeOutboxRetries = useRef(new Set<OutboxEntry>());

  const retryOutboxEntry = useCallback(
    async (entryId: string) => {
      const entry = getOutboxSnapshot().find((candidate) => candidate.id === entryId);
      if (!entry || !selectedProject || activeOutboxRetries.current.has(entry)) {
        return;
      }

      const retryMode = outboxRetryMode(entry);
      if (retryMode === 'verify') {
        return;
      }

      // B-969: reserve the original object before asynchronous payload reads.
      activeOutboxRetries.current.add(entry);
      try {
        // ‏`conversation_not_found` يعني أن المحادثة **ذهبت**، فاستئنافُها يفشل
        // ثانيةً ويعيد البطاقة إلى الشاشة — حلقةٌ مغلقة. الإعادة حينئذٍ تبدأ
        // محادثة جديدة، وهو بالضبط ما يفعله زرّ «ابدأ جلسة جديدة» في فقاعة الخطأ.
        const targetSessionId = entry.reasonCode === 'conversation_not_found'
          ? null
          : (currentSessionId || selectedSession?.id || entry.sessionId || null);

        const payload = await readOutboxRetryPayload(entry);
        // A receipt, another retry, removal, or account switch may win during the read.
        if (getOutboxSnapshot().find(candidate => candidate.id === entryId) !== entry) return;
        if (!payload.ok) {
          const saved = blockOutboxRetry(entryId, payload.code);
          setSendError(t(saved ? `outbox.reason.${payload.code}` : 'outbox.storageFull'));
          return;
        }

        const retryProvider = resolveSendProvider(Boolean(targetSessionId), selectedSession?.__provider,
          (entry.intent.provider as LLMProvider | undefined) ?? provider);
        // These are the existing dispatch branches that carry images on the wire.
        if (payload.images.length > 0 && !['claude', 'codex', 'opencode'].includes(retryProvider)) {
          const saved = blockOutboxRetry(entryId, 'attachment_provider_unsupported');
          setSendError(t(saved ? 'outbox.reason.attachment_provider_unsupported' : 'outbox.storageFull'));
          return;
        }
        const retryImageFiles = payload.images;
        const retryClientMsgId = retryMode === 'same_id' ? entryId : createClientMsgId();
        let prepared: OutboxEntry | undefined;
        if (retryMode === 'same_id') {
          prepared = await markOutboxPendingDurably(entryId) ?? undefined;
          if (!prepared) {
            setSendError(t('outbox.storageFull'));
            return;
          }
        } else {
          prepared = await recordOutboxEntryDurably({
            id: retryClientMsgId,
            projectId: entry.projectId,
            sessionId: targetSessionId,
            text: entry.text,
            images: retryImageFiles,
            fileNames: entry.fileNames,
            historyEligibility: entry.historyEligibility,
            status: 'pending',
            intent: entry.intent,
          }) ?? undefined;
          if (!prepared) {
            setSendError(t('outbox.storageFull'));
            return;
          }
        }
        if (!prepared || prepared.status !== 'pending') return;
        const currentAttempt = () => getOutboxSnapshot().find(candidate => candidate.id === retryClientMsgId) === prepared;
        const currentOriginal = () => retryMode === 'same_id'
          || getOutboxSnapshot().find(candidate => candidate.id === entryId) === entry;
        // Only the unmodified, unsent replacement belongs to this attempt.
        const discardReplacement = async () => {
          if (retryMode !== 'new_id' || !currentAttempt()) return true;
          const removed = await removeOutboxEntryExplicit(retryClientMsgId);
          if (!removed) setSendError(t('outbox.storageFull'));
          return removed;
        };
        const stillCurrent = async () => {
          if (currentAttempt() && currentOriginal()) return true;
          await discardReplacement();
          return false;
        };
        const failPreparation = (code: 'attachment_copy_failed' | 'attachment_upload_failed') => {
          // The caller rechecks staleness after every awaited storage/network
          // boundary; rollback itself is also durable for v2.
          void (async () => {
          if (!await stillCurrent()) return;
          const restored = retryMode === 'same_id'
            ? Boolean(await restorePreparedOutboxRetryDurably(prepared, entry, code))
            : await discardReplacement() && blockOutboxRetry(entryId, code);
          if (!restored) {
            setSendError(t('outbox.storageFull'));
            return;
          }
          setSendError(t(`outbox.reason.${code}`));
          })();
        };
        if (retryMode === 'new_id') {
          const savedImages = await verifyOutboxImagePersistence(prepared, retryImageFiles);
          if (!await stillCurrent()) return;
          if (!savedImages) {
            failPreparation('attachment_copy_failed');
            return;
          }
        }
        let uploadedImages: unknown[] = [];
        if (retryImageFiles.length > 0) {
          try {
            const formData = new FormData();
            retryImageFiles.forEach(file => formData.append('images', file));
            const response = await authenticatedFetch(
              `/api/projects/${selectedProject.projectId}/upload-images`,
              { method: 'POST', headers: {}, body: formData },
            );
            if (!await stillCurrent()) return;
            if (!response.ok) throw new Error('Failed to upload images');
            uploadedImages = (await response.json()).images;
            if (!await stillCurrent()) return;
            if (!Array.isArray(uploadedImages) || uploadedImages.length !== retryImageFiles.length) {
              throw new Error('Incomplete image upload');
            }
          } catch {
            failPreparation('attachment_upload_failed');
            return;
          }
        }
        if (!await stillCurrent()) return;
        resetOutboxJudgement(entryId);

        const sent = dispatchProviderCommand(
          entry.text,
          targetSessionId,
          uploadedImages,
          entry.intent.effort,
          [],
          { clientMsgId: retryClientMsgId, intent: entry.intent, historyEligibility: entry.historyEligibility },
        );

        if (!sent) {
          markOutboxFailed(retryClientMsgId, { code: 'transport' });
          return;
        }
        if (retryMode === 'new_id') await removeOutboxEntryExplicit(entryId);

        addMessage({
          id: retryClientMsgId,
          type: 'user',
          content: entry.text,
          coordinationLevel: narrowCoordinationLevel(entry.intent.coordinationLevel),
          images: uploadedImages as any,
          timestamp: new Date(),
          userId: authUserId,
        });
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
        setIsUserScrolledUp(false);
        setTimeout(() => scrollToBottom(), 100);
      } finally {
        activeOutboxRetries.current.delete(entry);
      }
    },
    [
      addMessage, authUserId, currentSessionId, dispatchProviderCommand, resetOutboxJudgement,
      scrollToBottom, selectedProject, selectedSession, setCanAbortSession, setClaudeStatus,
      setIsLoading, setIsUserScrolledUp, t, provider,
    ],
  );

  /**
   * «تعديل» — تسليمُ الرسالة إلى صاحبها: النصّ والصور تنتقل إلى المُؤلِّف
   * **وتزول البطاقة** (قرار المالك 2026-08-07، B-536).
   *
   * كان الإدخال يبقى محفوظاً بعد التعديل خشيةَ أن تعود الرسالة إلى حقلٍ متطاير
   * وحيد. والواقع أنها لا تعود إليه وحده: المُؤلِّف يحفظ مسوّدته في
   * `draft_input_*` عند كل ضغطة مفتاح، فتصمد أمام إعادة التحميل. وبقاءُ
   * البطاقة فوق النصّ المنقول كان يعرض نسختين من كلامٍ واحد ويترك إنذاراً
   * قائماً عن رسالةٍ صار أمرُها بيد صاحبها — فيضغط «حذف» ليصمت الإنذار،
   * وذلك بعينه الخطر الذي خُشي منه.
   *
   * والصور تُقرأ **قبل** الحذف: الحذف يُسقط كائناتها من IndexedDB.
   */
  const editOutboxEntry = useCallback(
    async (entryId: string) => {
      const entry = getOutboxSnapshot().find((candidate) => candidate.id === entryId);
      if (!entry) return;

      const payload = await readOutboxRetryPayload(entry);
      if (getOutboxSnapshot().find(candidate => candidate.id === entryId) !== entry) return;
      if (!payload.ok) {
        blockOutboxRetry(entryId, payload.code);
        setSendError(t(`outbox.reason.${payload.code}`));
        return;
      }
      setInput(entry.text);
      inputValueRef.current = entry.text;
      setAttachedImages(payload.images);
      await removeOutboxEntryExplicit(entryId);
      textareaRef.current?.focus();
    },
    [t],
  );

  const deleteOutboxEntry = useCallback(async (entryId: string) => {
    await removeOutboxEntryExplicit(entryId);
  }, []);

  /**
   * «تحقّق» — فعلُ إدخالٍ حالتُه `unconfirmed` وحده.
   *
   * الإدخال هنا أُرسل ولم يصل حكمُه (أُغلقت الصفحة أثناء الجولة). إعادةُ إرساله
   * ابتداءً قد تكون إرسالاً مزدوجاً، فالفعل الأول سؤالُ المصدر الحتمي: أوصلت
   * هوية الرسالة سجلَّ المحادثة؟ نعم ⇒ يُحذف الإدخال. غياب الهوية يبقي
   * التسليم غير مؤكد؛ لا يثبت فشل الإرسال ولا يجيز إعادته.
   */
  const verifyOutboxEntry = useCallback(
    async (entryId: string) => {
      const entry = getOutboxSnapshot().find((candidate) => candidate.id === entryId);
      if (!entry) return;
      const targetSessionId = entry.sessionId || currentSessionId || selectedSession?.id || null;
      if (!targetSessionId || !verifyMessageDelivered) {
        /**
         * ‏B-553/م4 — لا سبيل إلى سؤال، فلا حكم.
         *
         * كان يُوسم `failed` — فتصير البطاقة الصفراء «لم يصل تأكيد» حمراءَ
         * «فشل الإرسال» عن رسالةٍ نُفِّذت ومحادثتُها تعمل، ثم تُستثنى من
         * التحقّق التلقائي (`failed` مستثنى) فتفقد آخر فرصة شفاء ذاتي. فعلٌ
         * يكذب على صاحبه أسوأ من بطاقة عالقة.
         */
        return;
      }
      let delivered: boolean | 'accepted' | 'unknown' = false;
      try {
        delivered = await verifyMessageDelivered(targetSessionId, entry.id, entry.intent.provider);
      } catch {
        return;
      }
      if (getOutboxSnapshot().includes(entry)) {
        if (delivered === true) confirmOutboxEntry(entryId);
        else if (delivered === 'accepted') confirmOutboxEntry(entryId);
      }
      // Missing history or a failed refresh is unknown, never permission to replay.
    },
    [currentSessionId, selectedSession?.id, verifyMessageDelivered],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // T-904 (بند 6): تصفير thinkingMode عند تبدّل مزوّد الجلسة المفتوحة (session
  // = selectedSession?.__provider ?? العام، لا العام وحده — نفس الاشتقاق
  // المستخدَم في ChatComposer/useChatProviderState). effortModes قيم مزوّد-محدَّدة
  // (claude فقط اليوم)، فبقاء قيمة كـ'ultracode' معلَّقة بعد تبدّل الجلسة إلى
  // مزوّد آخر ثم العودة يُعدّ تسرّباً بين فضاءي قيم متنافرين.
  const sessionProviderForThinkingReset = selectedSession?.__provider ?? provider;
  const lastThinkingProviderRef = useRef<string | null>(null);
  useEffect(() => {
    // أول تشغيل (mount) ليس «تبدّل مزوّد»: تصفيره حينها يمسح المستوى المستعاد
    // للمحادثة المفتوحة قبل أن يراه المستخدم. التصفير عند تغيّر فعليّ فقط —
    // وهو ما قصده T-904 أصلاً (منع تسرّب قيمة مزوّد إلى فضاء قيم مزوّد آخر).
    const previousProvider = lastThinkingProviderRef.current;
    lastThinkingProviderRef.current = sessionProviderForThinkingReset;
    if (previousProvider === null || previousProvider === sessionProviderForThinkingReset) {
      return;
    }

    setThinkingMode(DEFAULT_EFFORT_MODE);
    // KM-3/GL-8: also reset the chat⇄agent toggle when the open session's provider
    // changes — 'agent' is provider-specific, so it must never persist across a
    // switch to a provider with no (or a different) agent surface.
    setComposerMode('chat');
  }, [sessionProviderForThinkingReset]);

  // ── ثبات مستوى التفكير لكل محادثة ────────────────────────────────────────
  // المستوى خاصية المحادثة: يُختار مرة ويبقى حتى يغيّره المستخدم. يصمد أمام
  // الإرسال (أُزيل التصفير من handleSubmit)، والتبديل بين المحادثات، وإعادة
  // تحميل الصفحة (التخزين المحلي بمفتاح مُعرِّف الجلسة — نفس عُرف draft_input_*).
  const stickyEffortSessionId = currentSessionId ?? selectedSession?.id ?? null;
  const effortRestoreSeenRef = useRef(false);
  const previousEffortSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const isFirstRun = !effortRestoreSeenRef.current;
    const previousSessionId = previousEffortSessionIdRef.current;
    effortRestoreSeenRef.current = true;
    previousEffortSessionIdRef.current = stickyEffortSessionId;

    const decision = resolveStickyEffortMode({
      sessionId: stickyEffortSessionId,
      previousSessionId,
      isFirstRun,
      storedMode: stickyEffortSessionId
        ? safeLocalStorage.getItem(effortStorageKey(stickyEffortSessionId))
        : null,
      knownModeIds: effortModes.map((mode) => mode.id),
      defaultMode: DEFAULT_EFFORT_MODE,
    });

    if (decision.action === 'apply') {
      setThinkingMode(decision.mode);
    }
  }, [stickyEffortSessionId]);

  useEffect(() => {
    if (!stickyEffortSessionId) {
      return;
    }
    safeLocalStorage.setItem(effortStorageKey(stickyEffortSessionId), thinkingMode);
  }, [stickyEffortSessionId, thinkingMode]);

  // ── ثبات مستوى التنسيق لكل محادثة ───────────────────────────────────────
  const stickyCoordinationSessionId = currentSessionId ?? selectedSession?.id ?? null;
  const skipNextCoordinationWriteRef = useRef(false);
  const previousCoordinationSessionIdRef = useRef<string | null>(null);
  const coordinationLevelRef = useRef(coordinationLevel);
  useEffect(() => {
    coordinationLevelRef.current = coordinationLevel;
  }, [coordinationLevel]);

  useEffect(() => {
    const previousSessionId = previousCoordinationSessionIdRef.current;
    previousCoordinationSessionIdRef.current = stickyCoordinationSessionId;
    if (!stickyCoordinationSessionId) {
      skipNextCoordinationWriteRef.current = true;
      setCoordinationLevel(DEFAULT_COORDINATION_LEVEL);
      return;
    }
    const stored = safeLocalStorage.getItem(coordinationLevelStorageKey(stickyCoordinationSessionId));
    const assignedAfterFirstSend = stored === null && previousSessionId === null;
    const restoredLevel = assignedAfterFirstSend
      ? coordinationLevelRef.current
      : narrowCoordinationLevel(stored);

    if (assignedAfterFirstSend) {
      // A new conversation has no id while its first turn is composed. When the
      // server assigns the id, persist that turn's selected level immediately:
      // setState may be a no-op when the value is unchanged, so relying on the
      // writer effect would silently lose delegate/delegate_review on reload.
      safeLocalStorage.setItem(
        coordinationLevelStorageKey(stickyCoordinationSessionId),
        restoredLevel,
      );
      skipNextCoordinationWriteRef.current = false;
    } else {
      skipNextCoordinationWriteRef.current = true;
    }
    setCoordinationLevel(restoredLevel);
  }, [stickyCoordinationSessionId]);

  useEffect(() => {
    if (!stickyCoordinationSessionId) {
      return;
    }
    if (skipNextCoordinationWriteRef.current) {
      skipNextCoordinationWriteRef.current = false;
      return;
    }
    safeLocalStorage.setItem(coordinationLevelStorageKey(stickyCoordinationSessionId), coordinationLevel);
  }, [stickyCoordinationSessionId, coordinationLevel]);

  // KM-3/GL-8: whether the chat⇄agent toggle should be OFFERED for the currently
  // displayed session provider (open session's __provider, else the global
  // selection). Consumed by the composer UI to render/hide the toggle. False for
  // every provider without a governed agent surface, and for glm while its client
  // fleet flag is unarmed (default OFF ⇒ unchanged behavior).
  const agentModeAvailable = useMemo(
    () => isAgentModeAvailable(sessionProviderForThinkingReset),
    [sessionProviderForThinkingReset],
  );
  const coordinationLevelAvailable = useMemo(
    () => getProviderCapabilities(sessionProviderForThinkingReset).coordinationLevel.supported,
    [sessionProviderForThinkingReset],
  );

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Clean up the send-error auto-dismiss timer on unmount to prevent setting
  // state on an already-unmounted component. (memory-leak fix)
  useEffect(() => {
    return () => {
      if (sendErrorTimerRef.current) {
        clearTimeout(sendErrorTimerRef.current);
        sendErrorTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    // Re-run when input changes so restored drafts get the same autosize behavior as typed text.
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.max(22, textareaRef.current.scrollHeight)}px`;
    const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
    const expanded = textareaRef.current.scrollHeight > lineHeight * 2;
    setIsTextareaExpanded(expanded);
  }, [input]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  /**
   * ADR-097 / B-428 — إدراج نصّ عند مؤشّر الحقل من مصدر خارج لوحة المفاتيح
   * (التفريغ الصوتي اليوم، وأيّ مُدرِج لاحق). يعيش هنا لا في المكوّن لأنّ إدراجاً
   * يكتب `input` وحده يلتفّ على حالة المُؤلِّف: `inputValueRef` يبقى بائتاً
   * (يستهلكه الإرسال والمسودّة) ومُكتشف «/» لا يُعاد تقييمه. فيمرّ هنا بنفس
   * المسار الذي يمرّ به `handleInputChange` أعلاه، حرفاً بحرف.
   *
   * القيمة السابقة تُقرأ من `inputValueRef` — المصدر المتزامن الحقيقي لقيمة
   * الحقل (يُحدَّث في كل مسار كتابة، ويُستهلك في الإرسال). **لا** من مُحدِّث
   * دالّي ذي أثر جانبي (B-437 §1): React لا يُقيّم المُحدِّث تعجّلاً متى كان على
   * الليف تحديث معلّق — وهو الحال أثناء بثّ WS — فتُقرأ `nextValue` فارغةً
   * فيُمحى مرجع القيمة، ويقفز المؤشّر إلى الصفر فينعكس ترتيب الكلام، ويقرأ
   * الإرسال حقلاً خاوياً. القيمة تُحسب كاملةً هنا ثم تُمرَّر إلى `setInput`.
   *
   * والمؤشّر يُقرأ من الـDOM لحظة الاستدعاء — لكن فقط إن كانت قيمة الـDOM
   * مطابقة لقيمتنا؛ إدراجان في الإطار نفسه يسبقان رندر React، فموضع المؤشّر
   * المعروض يعود لنصّ أقدم ولا يُوثق به، والإلحاق في الآخر هو الترتيب الصحيح.
   */
  const insertTextAtCursor = useCallback(
    (text: string) => {
      if (!text) {
        return;
      }
      const previous = inputValueRef.current ?? '';
      const textarea = textareaRef.current;
      const domInSync = textarea != null && textarea.value === previous;
      const selectionStart = domInSync ? textarea.selectionStart : null;
      const selectionEnd = domInSync ? textarea.selectionEnd : null;

      const start =
        selectionStart === null ? previous.length : Math.min(selectionStart, previous.length);
      const end =
        selectionEnd === null
          ? previous.length
          : Math.min(Math.max(selectionEnd, start), previous.length);
      const before = previous.slice(0, start);
      const after = previous.slice(end);
      const needsSpaceBefore = before.length > 0 && !/\s$/.test(before);
      const needsSpaceAfter = after.length > 0 && !/^\s/.test(after);
      const insertion = `${needsSpaceBefore ? ' ' : ''}${text}${needsSpaceAfter ? ' ' : ''}`;
      const nextValue = `${before}${insertion}${after}`;
      const caret = before.length + insertion.length;

      setInput(nextValue);
      inputValueRef.current = nextValue;
      setCursorPosition(caret);

      if (!nextValue.trim()) {
        resetCommandMenuState();
      } else {
        handleCommandInputChange(nextValue, caret);
      }

      // لا `focus()`: الإدراج قد يقع والمستخدم على زرّ المايكروفون، وخطف التركيز
      // عند كل مقطع يسلبه القدرة على إيقاف الاستماع بلوحة المفاتيح. نضبط المؤشّر
      // فقط — إن كان الحقل مركَّزاً أصلاً تابع الكتابة من الموضع الصحيح.
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (!element) {
          return;
        }
        element.setSelectionRange(caret, caret);
      });
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        // حرس المسودّة: البيئة تُلتقط عند الفراغ فقط، وتُثبَّت أثناء التحرير.
        if ((inputValueRef.current ?? '').length === 0) {
          enterSendsRef.current = enterSendsLive;
        }

        // القرار نفسه دالّة نقيّة في `src/lib/enter-behavior.ts` كي يُختبَر على
        // المصفوفة كاملةً بلا تركيب المُؤلِّف. وفيه ثلاثة ثوابت لم تُمَسّ:
        // تركيب IME لا يُرسل، وCtrl/Cmd+Enter يُرسل دائماً، وShift+Enter سطرٌ
        // جديد دائماً.
        //
        // ‏[قرار مقصود] `Alt+Enter` **لم يعد يُرسل**؛ يسقط إلى سطرٍ جديد.
        // السطر السابق فحص `shiftKey` و`ctrlKey` و`metaKey` ولم يفحص `altKey`،
        // فكان `Alt+Enter` مساوياً لـ`Enter` المجرّدة — أي يُرسل. وهذه وراثةُ
        // سهوٍ لا قرار: لا واجهةَ في المنتج تذكر `Alt+Enter` مُرسِلاً، ولا
        // وثيقة، وليس عُرفاً في مُؤلِّفات المحادثة. والكفّتان غير متكافئتين:
        // خسارةُ من كان يعتمده = ضغطةٌ إضافية، وخسارةُ الإبقاء عليه = إرسالُ
        // رسالةٍ نصفَ مكتوبة بضغطةٍ عرضية لا رجعة فيها. `Alt` هنا كـ`Shift`:
        // مُعدِّلٌ ليس مُعدِّل الإرسال.
        const action = decideEnterAction(
          {
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            isComposing: event.nativeEvent.isComposing,
          },
          enterSendsRef.current,
        );

        // ‏T-1320: استمرار قوائم Markdown. يقع هنا تحديداً — بعد قرار الإرسال
        // وقبل السقوط إلى إدراج المتصفّح الافتراضي — فلا يمسّ فرع `send` ولا
        // حارس IME (‏`decideEnterAction` يُعيد `'newline'` أثناء التركيب، فلولا
        // الفحص الصريح هنا لأطلق تأكيدُ اقتراحٍ من مُنقِّح الكتابة منطقَ قائمة).
        //
        // التحرير عبر `execCommand` حصراً لا `setInput`: الأخير يمحو مكدّس
        // تراجع المتصفّح لتلك الكتابة، وهو مقبولٌ لإدراجٍ صوتيّ نادر لا لضغطة
        // Enter متكرّرة. و`execCommand` يمرّ بخطّ التحرير الأصلي فيبقى التراجع
        // سليماً، ويُطلق حدث `input` حقيقياً فيلتقطه React بلا مزامنة يدوية.
        if (action === 'newline' && !event.nativeEvent.isComposing) {
          const textarea = event.currentTarget;
          const listAction = computeListContinuation(
            textarea.value,
            textarea.selectionStart,
            textarea.selectionEnd,
          );

          if (listAction) {
            // نُطبّق أوّلاً ونمنع الافتراضي عند النجاح وحده. `execCommand`
            // مهجورةٌ في المواصفة وقد تُعيد `false`؛ ولو منعنا الافتراضي قبلها
            // لكانت ضغطةُ Enter تُعطَّل صامتةً عند أيّ فشل — أي أنّ ميزةَ راحةٍ
            // تكسر أبسط وظيفةٍ في المحرّر. والتدهور هنا رشيق: يُدرج المتصفّح
            // سطراً عادياً بلا علامة، فيكتبها المستخدم بيده كما كان يفعل.
            let applied: boolean;
            if (listAction.kind === 'continue') {
              applied = document.execCommand('insertText', false, listAction.insertText);
            } else {
              const { selectionStart, selectionEnd } = textarea;
              textarea.setSelectionRange(listAction.deleteFrom, listAction.deleteTo);
              applied = document.execCommand('delete');
              // فشلُ الحذف يترك تحديداً موسَّعاً لم يطلبه المستخدم، فيستبدله
              // السطرُ الجديد الافتراضي. نُعيده كما كان قبل أن نُسلّم للمتصفّح.
              if (!applied) {
                textarea.setSelectionRange(selectionStart, selectionEnd);
              }
            }

            if (applied) {
              event.preventDefault();
              return;
            }
          }
        }

        if (action === 'send') {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      enterSendsLive,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      target.style.height = 'auto';
      target.style.height = `${Math.max(22, target.scrollHeight)}px`;
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);

      const lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      setIsTextareaExpanded(target.scrollHeight > lineHeight * 2);
    },
    [setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  // Clear the in-flight abort state once the server confirms the run ended.
  // The realtime handler flips canAbortSession→false on complete/aborted/error;
  // that transition is our signal the STOP took effect, so we re-enable any UI
  // gated on isAborting and cancel the safety timeout.
  useEffect(() => {
    if (!canAbortSession && isAborting) {
      setIsAborting(false);
      if (abortTimerRef.current) {
        clearTimeout(abortTimerRef.current);
        abortTimerRef.current = null;
      }
    }
  }, [canAbortSession, isAborting]);

  // Tidy the safety timeout on unmount.
  useEffect(
    () => () => {
      if (abortTimerRef.current) {
        clearTimeout(abortTimerRef.current);
        abortTimerRef.current = null;
      }
    },
    [],
  );

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession || isAborting) {
      return;
    }

    const cursorSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('cursorSessionId') : null;

    const candidateSessionIds = [
      currentSessionId,
      provider === 'cursor' ? cursorSessionId : null,
      selectedSession?.id || null,
    ];

    const targetSessionId =
      candidateSessionIds.find((sessionId) => Boolean(sessionId)) || null;

    // Even with no concrete id (the brand-new-session race: the run started but
    // its real session_id has not arrived yet), still send the abort with an
    // empty id. The server falls back to the newest active claude run on THIS
    // socket, so STOP works before the id is known. Previously this bailed with
    // a silent console.warn, which is exactly the dead-button symptom.
    const result = sendMessage({
      type: 'abort-session',
      sessionId: targetSessionId || '',
      provider,
    });

    // Surface transport failure instead of failing silently. A `void` return
    // (legacy senders) is treated as success.
    if (result && result.ok === false) {
      const errMsg = t('ws.abortFailed', {
        defaultValue: 'Could not stop — connection lost. Retrying may help.',
      });
      setSendError(errMsg);
      if (sendErrorTimerRef.current) clearTimeout(sendErrorTimerRef.current);
      sendErrorTimerRef.current = setTimeout(() => setSendError(null), 6000);
      return;
    }

    // Disable STOP and show "Stopping…" until the server's complete/aborted
    // event arrives (cleared by the realtime handler) or a safety timeout fires
    // so the button never gets stuck disabled if the confirmation is lost.
    setIsAborting(true);
    if (abortTimerRef.current) clearTimeout(abortTimerRef.current);
    abortTimerRef.current = setTimeout(() => setIsAborting(false), 10000);
  }, [canAbortSession, isAborting, currentSessionId, provider, selectedSession?.id, sendMessage, t]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'claude-permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) => {
        const next = previous.filter((request) => !validIds.includes(request.requestId));
        if (next.length === 0) {
          setClaudeStatus(null);
        }
        return next;
      });
    },
    [sendMessage, setClaudeStatus, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    // KM-3/GL-8 (ADR-062): chat⇄agent toggle state + whether it should be offered
    // for the current session provider. Consumed by the composer UI (toggle button
    // wired separately); inert while composerMode stays 'chat'.
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
    filteredFiles: filteredFiles as MentionableFile[],
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
    handleNonImageFiles,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker: open,
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
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    executingCommand,
    sendError,
    isAborting,
    // T-1295 — صندوق الصادر: ما يُعرض للجلسة المفتوحة، وأفعاله.
    outboxEntries,
    retryOutboxEntry,
    editOutboxEntry,
    deleteOutboxEntry,
    verifyOutboxEntry,
  };
}

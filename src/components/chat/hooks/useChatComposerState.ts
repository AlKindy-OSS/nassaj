import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { authenticatedFetch } from '../../../utils/api';
import { useAuth } from '../../auth/context/AuthContext';
import { DEFAULT_EFFORT_MODE, effortModes } from '../constants/thinkingModes';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import { safeLocalStorage } from '../utils/chatStorage';
import type {
  ChatFile,
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelsCacheInfo } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';
import { resolveSendProvider } from '../utils/resolveSendProvider';
import { getProviderCapabilities, isAgentModeAvailable } from '../constants/providerCapabilities';
import { isBtwCommand, parseBtwQuestion } from '../utils/btwCommand';

import { resolveStickyEffortMode } from './stickyEffortMode';
import { readSessionEngineProvider, writePendingEngineStamp } from './useChatProviderState';
import { useFileMentions } from './useFileMentions';
import {
  isBtwSlashEntry,
  isOpenCodePassthroughCommand,
  isPassthroughBuiltInCommand,
  type SlashCommand,
  useSlashCommands,
} from './useSlashCommands';

/**
 * مفتاح تخزين مستوى التفكير المثبَّت لمحادثة بعينها. مُعرَّف الجلسة هو المفتاح
 * (لا المشروع): المستوى خاصية المحادثة الواحدة، ومحادثتان في مشروع واحد قد
 * تستحقّان مستويين مختلفين. يوازي عُرف `draft_input_${projectId}` القائم.
 */
const effortStorageKey = (sessionId: string) => `thinking_mode_${sessionId}`;

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
};

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
}

interface MentionableFile {
  name: string;
  path: string;
}

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
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
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  onBtwQuery,
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
}: UseChatComposerStateArgs) {
  const { user } = useAuth();
  const { t } = useTranslation('chat');
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
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);
  // Non-null while a send failed due to WS disconnect; cleared on next attempt or after timeout.
  const [sendError, setSendError] = useState<string | null>(null);
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
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
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

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string) => {
      if (!command || !selectedProject) {
        return;
      }

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
          sessionId: currentSessionId,
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
          setInput('');
          inputValueRef.current = '';
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
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
      provider,
      selectedProject,
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
  } = useSlashCommands({
    selectedProject,
    selectedSession,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
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
    ): boolean => {
      const resolvedProjectPath = selectedProject?.fullPath || selectedProject?.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, messageContent);
      const resume = Boolean(targetSessionId);
      // Seal the turn to the conversation's OWN provider when resuming, so a
      // provider/model picked for a NEW chat can never cross into a running
      // conversation of another provider system (B-167). A brand-new conversation
      // (no targetSessionId) uses the composer's current global selection.
      const effectiveProvider = resolveSendProvider(resume, selectedSession?.__provider, provider);
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
        : engineProvider;
      const toolsSettings = getToolsSettings(effectiveProvider);

      // KM-3/GL-8 (ADR-062): send the governed agent-mode flag ONLY when the
      // composer toggle is 'agent' AND the resolved (sealed-on-resume) provider
      // actually offers an agent surface — isAgentModeAvailable re-checks the
      // client fleet flag for glm (VITE_NASSAJ_OPENCODE_CARRIER). Chat (default)
      // attaches no `mode`, so every existing provider path is byte-for-byte
      // unchanged. The server re-enforces this gate fail-closed regardless.
      const wantsAgentMode = composerMode === 'agent' && isAgentModeAvailable(effectiveProvider);

      let result: { ok: boolean } | void;
      if (effectiveProvider === 'cursor') {
        result = sendMessage({
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
        result = sendMessage({
          type: 'codex-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: codexOptions,
        });
      } else if (effectiveProvider === 'gemini') {
        result = sendMessage({
          type: 'gemini-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: geminiModel, sessionSummary, permissionMode, toolsSettings,
          },
        });
      } else if (effectiveProvider === 'antigravity') {
        result = sendMessage({
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
        result = sendMessage({
          type: 'opencode-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: opencodeOptions,
        });
      } else if (effectiveProvider === 'hermes') {
        result = sendMessage({
          type: 'hermes-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: hermesModel, sessionSummary,
          },
        });
      } else if (effectiveProvider === 'kimi') {
        result = sendMessage({
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
        result = sendMessage({
          type: 'deepseek-command',
          command: messageContent,
          sessionId: targetSessionId,
          options: {
            cwd: resolvedProjectPath, projectPath: resolvedProjectPath, sessionId: targetSessionId,
            resume, model: deepseekModel, sessionSummary,
          },
        });
      } else if (effectiveProvider === 'glm') {
        result = sendMessage({
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
        result = sendMessage({
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
      hermesModel, kimiModel, deepseekModel, glmModel, engineProvider, composerMode,
      getToolsSettings, permissionMode, provider, selectedProject, selectedSession, sendMessage,
    ],
  );

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;

      // T-849: اعتراض «/btw <سؤال>» — قناة جانبية على سياق الجلسة تُجاب في overlay
      // ولا تدخل مسار الرسائل العادي إطلاقاً (لا سجلّ محادثة ولا دور). يسبق بوابة
      // isLoading كي يعمل حتى أثناء البث. claude فقط (المزوّد الوحيد ذو الفرك)؛
      // لغيره يسقط للسلوك القائم بلا تغيير. مزوّد الجلسة = __provider ثم العام.
      const sideChannelProvider = selectedSession?.__provider ?? provider;
      if (
        onBtwQuery
        && getProviderCapabilities(sideChannelProvider).sideChannel.supported
        && isBtwCommand(currentInput)
      ) {
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

      if (!currentInput.trim() || isLoading || !selectedProject) {
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
          !isPassthroughBuiltInCommand(matchedCommand) &&
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
      // Resolve the effort value for the selected mode (empty string = no effort field).
      const selectedEffortMode = effortModes.find(m => m.id === thinkingMode);
      const effortValue = selectedEffortMode?.effortValue ?? '';

      let uploadedImages: unknown[] = [];
      let uploadedFiles: ChatFile[] = [];

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

      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
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
        // This tracks only that a request is in flight before the provider has
        // emitted its real session id; routing still waits for session_created.
        pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now() };
      }
      if (effectiveSessionId) {
        onSessionActive?.(effectiveSessionId);
        onSessionProcessing?.(effectiveSessionId);
      }

      const sent = dispatchProviderCommand(messageContent, effectiveSessionId, uploadedImages, effortValue, uploadedFiles);

      if (!sent) {
        // WS was not open — roll back optimistic UI state and surface error.
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        const errMsg = t('ws.sendFailed', { defaultValue: 'Message not sent — connection lost' });
        setSendError(errMsg);
        if (sendErrorTimerRef.current) clearTimeout(sendErrorTimerRef.current);
        sendErrorTimerRef.current = setTimeout(() => setSendError(null), 6000);
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
      selectedSession,
      attachedImages,
      attachedFiles,
      authUserId,
      currentSessionId,
      dispatchProviderCommand,
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

  // KM-3/GL-8: whether the chat⇄agent toggle should be OFFERED for the currently
  // displayed session provider (open session's __provider, else the global
  // selection). Consumed by the composer UI to render/hide the toggle. False for
  // every provider without a governed agent surface, and for glm while its client
  // fleet flag is unarmed (default OFF ⇒ unchanged behavior).
  const agentModeAvailable = useMemo(
    () => isAgentModeAvailable(sessionProviderForThinkingReset),
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
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
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
    filteredFiles: filteredFiles as MentionableFile[],
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
    handleNonImageFiles,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker: open,
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
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    sendError,
    isAborting,
  };
}

import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type {
  ChangeEvent,
  ClipboardEvent,
  CSSProperties,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  SetStateAction,
  TouchEvent,
} from 'react';
import {
  Check,
  ImageIcon,
  XIcon,
  ArrowDownIcon,
  RefreshCw,
  MicIcon,
  Loader2Icon,
  Terminal,
} from 'lucide-react';

import { useVoiceDictation, voiceConsentStorageKey } from '../../hooks/useVoiceDictation';
import {
  useVoiceMode,
  useVoiceTranscription,
  voiceAccurateConsentStorageKey,
  type VoiceMode,
} from '../../hooks/useVoiceTranscription';
import { useVoiceTranscriptionSettings } from '../../hooks/useVoiceTranscriptionSettings';
// من الوحدة مباشرة لا من الـbarrel: الأخير يسحب ProtectedRoute وتبعياته إلى كل
// اختبار يُركّب المُؤلِّف بلا حاجة.
import { useOptionalAuth } from '../../../auth/context/AuthContext';
import type { PendingPermissionRequest, PermissionMode, Provider } from '../../types/types';
import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import {
  getProviderCapabilities,
  type CoordinationEnforcement,
  type CoordinationLevel,
} from '../../constants/providerCapabilities';
import { cn } from '../../../../lib/utils';
import { isSideChannelCommandForProvider } from '../../utils/btwCommand';
import { normalizeArabicSlashCommand } from '../../utils/commandLocalization';
import { effortModes } from '../../constants/thinkingModes';
import FileAttachment from './FileAttachment';
import type { RunAgent, RunProgress } from '../../hooks/useRunProgress';
import type { WorkflowUiDescriptor } from '../../../../stores/workflowStatus';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  Tooltip,
} from '../../../../shared/view/ui';

import { resolveAnchoredPlacement, type AnchoredPlacement } from './anchoredPopover';

/** ثابت المرجع: قيمةٌ افتراضية جديدة كل رندر تُبطل الذاكرة بلا سبب. */
const EMPTY_OUTBOX_ENTRIES: OutboxEntry[] = [];
const noopOutboxAction = () => undefined;
import CommandMenu from './CommandMenu';
import OutboxCard from './OutboxCard';
import {
  createDeliveredOutboxDismissal,
  getAdmissionRefusedSnapshot,
  getOutboxSnapshot,
  subscribeOutbox,
  type OutboxEntry,
} from '../../utils/messageOutbox';
import AgentStatusCard from './AgentStatusCard';
import { getCodexPostureKey } from './CodexPostureInfo';
import ImageAttachment from './ImageAttachment';
import InlineModelSwitcher from './InlineModelSwitcher';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import ThinkingModeSelector from './ThinkingModeSelector';
import TokenUsageSummary from './TokenUsageSummary';
import { useScheduledMessages } from '../../hooks/useScheduledMessages';
import type { ScheduledMessage } from '../../hooks/useScheduledMessages';
import {
  ScheduleMessageButton,
  ScheduleMessageDialog,
  ScheduledMessagesPanel,
} from './ScheduledMessages';

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
  /** Synchronous submit/upload seal before the run flips `isLoading`. */
  isSubmitSealed?: boolean;
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
  /** Honest verdict for those rows; drives the card's headline (see AgentStatusCard). */
  workflowStatus?: WorkflowUiDescriptor | null;
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
  coordinationLevel: CoordinationLevel;
  setCoordinationLevel: Dispatch<SetStateAction<CoordinationLevel>>;
  coordinationLevelAvailable: boolean;
  tokenBudget: Record<string, unknown> | null;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  isUserScrolledUp: boolean;
  hasMessages: boolean;
  /** T-1821: يُظهر الزرّ حتى حين المستخدم في الأسفل (جلسة عالقة / historyError / انقطاع تعافى). */
  showResync?: boolean;
  /** T-1821: دوّامة أثناء إعادة المزامنة (refresh أو retry تاريخ). */
  isResyncing?: boolean;
  /**
   * T-1821: طابع Unix بالميلي ثانية لوقت انتهاء تأجيل المحاولة (retryAt من historyError).
   * حين `retryUntil > Date.now()` يُعطَّل الزرّ ويُعرض تلميح «يرجى الانتظار».
   */
  retryUntil?: number | null;
  onScrollToBottom: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  /** استبدال صورة مرفقة بنسخة مقصوصة؛ يُمرَّر إلى ImageAttachment */
  onReplaceImage?: (original: File, next: File) => void;
  /** يُستدعى عند تغيّر حالة القص (مفتوح/مغلق) لأي صورة */
  onCropStateChange?: (isCropping: boolean) => void;
  /** صحيح أثناء فتح مودال القص أو ترميز الناتج — يُعطّل زر الإرسال */
  isImageCropping?: boolean;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  isCommandDisabled?: (command: SlashCommand) => boolean;
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
  /**
   * ADR-097 / B-428: يُدرج النصّ المُتفَرَّغ صوتياً عند مؤشّر الـtextarea عبر
   * طبقة حالة المُؤلِّف (useChatComposerState.insertTextAtCursor) لا عبر
   * `setInput` خاماً — الأخير يترك `inputValueRef` ومُكتشف «/» خارج المزامنة.
   * الواجهة الأماميّة وحدها (لا قدرة مزوّد)، لذا غير مشروطة بمزوّد الجلسة.
   */
  onVoiceInsert: (text: string) => void;
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
  /** Execute-style slash command whose HTTP request has not settled yet. */
  executingCommand?: { name: string; sessionId: string | null } | null;
  /** Non-null error message to display when the last send failed (e.g. WS disconnected). */
  sendError?: string | null;
  /**
   * T-1295 — رسائل هذه الجلسة التي لم تصل: بطاقةٌ لكلٍّ منها فوق المُؤلِّف،
   * بمعاينة النصّ ومصغّرات الصور وسبب الفشل وأفعاله الثلاثة.
   */
  outboxEntries?: OutboxEntry[];
  onOutboxRetry?: (entryId: string) => void;
  onOutboxEdit?: (entryId: string) => void;
  onOutboxDelete?: (entryId: string) => void;
  onOutboxVerify?: (entryId: string) => void;
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
  /** بداية الجلسة المفتوحة (ISO) لتنبيه مرور ساعة في مؤشر السياق. */
  sessionStartedAt?: string | null;
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

/**
 * نافذة الإفصاح عن معالجة الصوت (ADR-097). داخل التطبيق لا `window.confirm`:
 * المتصفّح يكبت الحوارات الأصليّة بعد رفض واحد أو داخل إطار، فيصمت زرّ
 * المايكروفون بلا تفسير. وهنا نملك RTL والهوية البصرية والوصول بالكيبورد.
 */
function VoiceConsentModal({
  open,
  message,
  title,
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm,
  restoreFocusRef,
}: {
  open: boolean;
  message: string;
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** العنصر الذي يعود إليه التركيز عند الإغلاق (زرّ المايكروفون). */
  restoreFocusRef?: RefObject<HTMLButtonElement>;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // المُلغي يُقرأ من مرجع لا من تبعية: نسخته تتغيّر مع كل رندر للمُؤلِّف، وإعادة
  // تشغيل الـeffect تُعيد التركيز إلى الزرّ وسط النافذة المفتوحة.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) {
      return;
    }
    confirmRef.current?.focus();
    // يُلتقط عند الفتح: زرّ المايكروفون حيّ طوال عمر النافذة، والالتقاط هنا
    // يجعل هدف العودة معلوماً وقت الفتح لا وقت الإغلاق.
    const restoreTarget = restoreFocusRef?.current ?? null;
    const focusables = (): HTMLElement[] => {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      // حبس التبويب: `aria-modal` وحدها لا تمنع الخروج بالكيبورد إلى مؤلِّف
      // معطَّل بصرياً خلف الحجاب — تصريح بلا إنفاذ (WCAG 2.2 §2.4.3/2.1.2).
      const list = focusables();
      if (list.length === 0) {
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const root = dialogRef.current;
      const active = document.activeElement as HTMLElement | null;
      const inside = Boolean(root && active && root.contains(active));
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      // عودة التركيز عند أي مسار إغلاق (تأكيد، إلغاء، Escape، نقر الحجاب):
      // كلّها تُسقط `open` فتُشغّل هذا التنظيف.
      restoreTarget?.focus();
    };
  }, [open, restoreFocusRef]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div
        ref={dialogRef}
        className="relative w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-consent-title"
        aria-describedby="voice-consent-message"
      >
        <div className="p-6">
          <div className="mb-4 flex items-center">
            <div className="me-3 rounded-full bg-primary/10 p-2 text-primary">
              <MicIcon className="h-4 w-4" />
            </div>
            <h3 id="voice-consent-title" className="text-lg font-semibold text-foreground">
              {title}
            </h3>
          </div>

          <p id="voice-consent-message" className="mb-6 text-sm leading-6 text-muted-foreground">
            {message}
          </p>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              ref={confirmRef}
              onClick={onConfirm}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <MicIcon className="h-4 w-4" />
              <span>{confirmLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** عتبة الضغط المطوّل على اللمس — نفس عتبة قائمة السياق الأصليّة في المتصفّحات. */
const VOICE_LANG_LONG_PRESS_MS = 500;
/**
 * نافذة كبت النقرة التالية بعد فتح القائمة بإيماءة. الضغط المطوّل يُتبَع دائماً
 * بـ`pointerup` ثم `click` صناعي؛ بلا الكبت يبدأ التفريغ الصوتي خلف القائمة
 * المفتوحة للتوّ. نافذة زمنية لا رايةٌ لزجة: الراية تبتلع أوّل نقرة **مقصودة**
 * بعد فتحٍ بالزرّ الأيمن على سطح المكتب.
 */
const VOICE_LANG_CLICK_SUPPRESS_MS = 700;
/** إلغاء الضغط المطوّل عند سحب الإصبع — الصفّ نفسه قابل للتمرير أفقياً. */
const VOICE_LANG_LONG_PRESS_SLOP_PX = 10;

/**
 * اسم اللغة بلُغتها (`ar-SA` ⇒ «العربية»). `Intl.DisplayNames` متاحة في كل
 * المتصفّحات المستهدفة وبلا تبعية جديدة؛ وحين تغيب أو يكون الوسم غير قياسي
 * (اللغة المكتشفة تُضاف خياراً كما هي) نسقط لطيفاً إلى الرمز الخام.
 */
function voiceLanguageLabel(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    if (name && name.toLowerCase() !== tag.toLowerCase()) {
      return name;
    }
  } catch {
    // متصفّح بلا Intl.DisplayNames أو وسم غير صالح — الرمز الخام أصدق من الفراغ.
  }
  return tag;
}

/** خيار وضع واحد في قسم «وضع التفريغ» أعلى القائمة (ADR-103). */
interface VoiceMenuModeEntry {
  value: VoiceMode;
  label: string;
  hint: string;
  /** معروض ولا يُختار — مع سبب مقروء بدل اختفاء صامت. */
  disabled?: boolean;
  disabledReason?: string | null;
}

type VoiceMenuEntry =
  | ({ kind: 'mode' } & VoiceMenuModeEntry)
  | { kind: 'lang'; value: string };

/**
 * قائمة خيارات التفريغ — تُفتح بالزرّ الأيمن (سطح المكتب) أو بالضغط المطوّل (اللمس)
 * أو بـShift+F10/مفتاح القائمة (لوحة المفاتيح) على زرّ المايكروفون.
 *
 * لماذا لا `<select>`: الصندوق الصغير «EN» كان يزاحم صفّ الأدوات المزدحم أصلاً
 * ويقرأ كعطل بصري، وقيمته صفر لمن لا يبدّل لغته أبداً. القائمة المنبثقة تُخفيه
 * دون أن تفقده.
 *
 * `menuitemradio` لا `menuitem`: اختيار واحد من مجموعة — هذا هو الدور الذي يجعل
 * قارئ الشاشة يُعلن «محدَّد» بدل أن يترك علامة الاختيار بصرية وحدها. والقسمان
 * (وضع، لغة) مجموعتان `role="group"` مسمّاتان: بلا التسمية يقرأ القارئ عشرة
 * أزرار radio في مجموعة واحدة ظاهرياً وهي مجموعتان مستقلّتان.
 *
 * قسم اللغة يختفي في الوضع الدقيق (ADR-103): الكشف تلقائي هناك، ومنتقي لغةٍ
 * لا أثر له كذبٌ بصري. مكانه سطر يشرح لماذا غاب.
 */
function VoiceLanguageMenu({
  options,
  current,
  label,
  anchorRef,
  onSelect,
  onClose,
  modes,
  mode,
  onModeSelect,
  modeSectionLabel,
  languageSectionLabel,
  showLanguages,
  languageNote,
}: {
  options: string[];
  current: string;
  label: string;
  anchorRef: RefObject<HTMLButtonElement>;
  onSelect: (lang: string) => void;
  /** `restoreFocus` صحيحة حين يكون الإغلاق بالكيبورد فيعود التركيز إلى الزرّ. */
  onClose: (restoreFocus: boolean) => void;
  /** فارغة = وضع واحد فقط متاح، فلا يُعرض قسم اختيارٍ من واحد. */
  modes: VoiceMenuModeEntry[];
  mode: VoiceMode;
  onModeSelect: (mode: VoiceMode) => void;
  modeSectionLabel: string;
  languageSectionLabel: string;
  showLanguages: boolean;
  languageNote?: string | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);

  // فهرس مسطّح واحد فوق القسمين: التنقّل بالأسهم يعبر الحدّ بينهما كما يتوقّع
  // مستخدم لوحة المفاتيح، ولو احتفظ كل قسم بفهرسه لَحُبس التركيز في أحدهما.
  const entries = useMemo<VoiceMenuEntry[]>(() => {
    const list: VoiceMenuEntry[] = modes.map((entry) => ({ kind: 'mode', ...entry }));
    if (showLanguages) {
      options.forEach((option) => list.push({ kind: 'lang', value: option }));
    }
    return list;
  }, [modes, options, showLanguages]);

  // التركيز يبدأ على المُحدَّد لا على أوّل الخيارات: المستخدم يفتح القائمة
  // ليغيّر عمّا هو فيه، فالبدء منه يجعل السهم الواحد كافياً غالباً. وحين تُعرض
  // اللغات فهي الأرجح تبديلاً، وإلّا فالوضع الحالي.
  const [activeIndex, setActiveIndex] = useState(() => {
    if (showLanguages) {
      const langIndex = options.indexOf(current);
      if (langIndex >= 0) return modes.length + langIndex;
    }
    return Math.max(
      0,
      modes.findIndex((entry) => entry.value === mode),
    );
  });

  const isRtl =
    typeof document !== 'undefined' &&
    (document.documentElement.dir === 'rtl' || document.body.dir === 'rtl');

  useLayoutEffect(() => {
    const reposition = () => {
      const trigger = anchorRef.current;
      if (!trigger || typeof window === 'undefined') return;
      const rect = trigger.getBoundingClientRect();
      setPlacement(
        resolveAnchoredPlacement({
          trigger: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          measuredHeight: menuRef.current?.offsetHeight ?? 0,
          preferredWidth: 264,
          isRtl,
        }),
      );
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchorRef, isRtl]);

  // تركيز متدحرج: العنصر النشط وحده في ترتيب التبويب، والباقي -1.
  useEffect(() => {
    itemRefs.current[activeIndex]?.focus();
  }, [activeIndex]);

  // الإغلاق بالنقر خارجها. زرّ المايكروفون مستثنى: نقرته تُعالَج في المُؤلِّف
  // (تُغلق القائمة) فإغلاقها هنا أيضاً يجعلها تُفتح وتُغلق في الحركة نفسها.
  useEffect(() => {
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [anchorRef, onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (entries.length === 0) return;
    switch (event.key) {
      case 'Escape':
      case 'Tab':
        // Tab يُغلق كذلك: قائمة معلّقة بينما التركيز غادرها تُخفي أين وصل المستخدم.
        event.preventDefault();
        onClose(true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % entries.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + entries.length) % entries.length);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(entries.length - 1);
        break;
      default:
        break;
    }
  };

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
      // design-ok: إحداثيات portal فيزيائية بالضرورة — الاتجاه محسوم داخل
      // resolveAnchoredPlacement بـ`isRtl`، والخصائص المنطقية هنا تقع في فخّ
      // tailwindcss-rtl (تضبط left وright معاً) فيتمدّد العنصر ويقع يساراً.
      style={
        placement
          ? {
              position: 'fixed',
              top: placement.top,
              bottom: placement.bottom,
              left: placement.left,
              right: placement.right,
              width: placement.width,
              maxHeight: placement.maxHeight,
              zIndex: 80,
            }
          : { position: 'fixed', top: 0, left: 0, visibility: 'hidden', zIndex: 80 }
      }
      className="overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl outline-none"
    >
      {modes.length > 0 && (
        <div role="group" aria-label={modeSectionLabel}>
          {modes.map((entry, index) => {
            const isSelected = entry.value === mode;
            const isDisabled = entry.disabled === true;
            return (
              <button
                key={entry.value}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                // `aria-disabled` لا `disabled`: العنصر المعطَّل هنا يحمل **سبب**
                // تعطيله، وزرٌّ محذوف من ترتيب التركيز لا يُقرأ سببه أبداً.
                aria-disabled={isDisabled || undefined}
                tabIndex={index === activeIndex ? 0 : -1}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                onClick={() => {
                  if (isDisabled) return;
                  onModeSelect(entry.value);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex w-full select-none items-start gap-2 rounded-lg px-2.5 py-2 text-sm outline-none',
                  'transition-colors duration-150 motion-reduce:transition-none',
                  isDisabled
                    ? 'cursor-not-allowed opacity-60'
                    : 'cursor-pointer hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground',
                  isSelected && !isDisabled && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {isSelected && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col text-start">
                  <bdi className="truncate">{entry.label}</bdi>
                  <span className="text-[11px] leading-4 text-muted-foreground">
                    {isDisabled && entry.disabledReason ? entry.disabledReason : entry.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {modes.length > 0 && (showLanguages || languageNote) && (
        <div className="my-1 h-px bg-border" aria-hidden="true" />
      )}

      {showLanguages && (
        <div role="group" aria-label={languageSectionLabel}>
          {options.map((option, langIndex) => {
            const index = modes.length + langIndex;
            const isSelected = option === current;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                tabIndex={index === activeIndex ? 0 : -1}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                onClick={() => onSelect(option)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none',
                  'transition-colors duration-150 motion-reduce:transition-none',
                  'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground',
                  isSelected && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {isSelected && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
                </span>
                {/* bdi: اسم اللغة بلُغتها قد يكون عربياً داخل واجهة لاتينية أو العكس. */}
                <bdi className="min-w-0 flex-1 truncate text-start">
                  {voiceLanguageLabel(option)}
                </bdi>
                <span dir="ltr" className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {option}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* لماذا غاب منتقي اللغة: الوضع الدقيق يكتشفها من الصوت نفسه. */}
      {!showLanguages && languageNote && (
        <p className="px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">{languageNote}</p>
      )}
    </div>,
    document.body,
  );
}

const COORDINATION_LEVEL_OPTIONS: Array<{
  id: CoordinationLevel;
  rank: 1 | 2 | 3;
}> = [
  { id: 'direct', rank: 1 },
  { id: 'delegate', rank: 2 },
  { id: 'delegate_review', rank: 3 },
];

function CoordinationLevelGlyph({ rank }: { rank: 1 | 2 | 3 }) {
  return (
    <span className="flex h-4 w-4 flex-col items-center justify-center gap-0.5" aria-hidden="true">
      {[1, 2, 3].map((level) => (
        <span
          key={level}
          className={cn(
            'h-0.5 rounded-full transition-colors duration-150',
            level === 1 ? 'w-1.5' : level === 2 ? 'w-2.5' : 'w-3.5',
            level <= rank ? 'bg-current' : 'bg-current/25',
          )}
        />
      ))}
    </span>
  );
}

function CoordinationLevelSelector({
  value,
  onChange,
  enforcement,
  disabled = false,
  className,
}: {
  value: CoordinationLevel;
  onChange: (level: CoordinationLevel) => void;
  /**
   * T-1315 (الموجة الثانية): درجة إنفاذ هذا المحرّك للمستوى — تُعرض نصّاً في
   * رأس اللوحة. المقود يعمل على كل الأجساد، لكن أثره يتفاوت، والمستخدم يقرأ
   * التفاوت بدل أن يستنتجه: وعدٌ بحدٍّ لا يُفرض هو ما أسقط الموجة الأولى.
   * لا تُرسم حالةٌ معطَّلة ولا تُخفى المعلومة — سطرٌ واحد يقول الحقيقة.
   */
  enforcement: CoordinationEnforcement;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const current = COORDINATION_LEVEL_OPTIONS.find((option) => option.id === value) ?? COORDINATION_LEVEL_OPTIONS[0];

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  const closePanel = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);
  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel || typeof window === 'undefined') {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = window.innerWidth < 640 ? 12 : 16;
    const spacing = 8;
    const width = Math.min(window.innerWidth - viewportPadding * 2, window.innerWidth < 640 ? 300 : 312);
    const centred = triggerRect.left + triggerRect.width / 2 - width / 2;
    const clampedLeft = Math.max(viewportPadding, Math.min(centred, window.innerWidth - width - viewportPadding));
    const measuredHeight = panel.offsetHeight || 0;
    const availableAbove = triggerRect.top - spacing - viewportPadding;
    const availableBelow = window.innerHeight - triggerRect.bottom - spacing - viewportPadding;
    const openAbove = availableAbove >= measuredHeight || availableAbove > availableBelow;
    const availableHeight = Math.max(0, openAbove ? availableAbove : availableBelow);
    const renderedHeight = Math.min(measuredHeight, availableHeight);
    const top = openAbove
      ? Math.max(viewportPadding, triggerRect.top - spacing - renderedHeight)
      : triggerRect.bottom + spacing;

    setPanelStyle({
      position: 'fixed',
      // design-ok: لوحة portal داخل جزيرة dir=ltr؛ الإزاحة الفيزيائية تمنع
      // tailwindcss-rtl من ضبط left/right معاً وتمديد اللوحة داخل RTL.
      left: clampedLeft,
      top,
      width,
      maxHeight: availableHeight,
      zIndex: 80,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPanelStyle(null);
      return undefined;
    }

    const rafId = window.requestAnimationFrame(updatePanelPosition);
    const handleViewportChange = () => updatePanelPosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isOpen, updatePanelPosition]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const selectedIndex = Math.max(0, COORDINATION_LEVEL_OPTIONS.findIndex((option) => option.id === value));
    setActiveOptionIndex(selectedIndex);
    const rafId = window.requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    return () => window.cancelAnimationFrame(rafId);
  }, [isOpen, value]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      closePanel();
    };
    // globalThis.KeyboardEvent صراحةً: الملف يستورد KeyboardEvent من React
    // (‏`handleListboxKeyDown` أدناه يستعمله بوسيطه العام)، فيظلّل نوعَ DOM
    // ويرفض addEventListener مطابقةَ المستمع. لا يصحّ هنا إلا نوع DOM.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePanel(true);
      } else if (event.key === 'Tab') {
        closePanel();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, closePanel]);

  const handleListboxKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = optionRefs.current.findIndex((option) => option === document.activeElement);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % COORDINATION_LEVEL_OPTIONS.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + COORDINATION_LEVEL_OPTIONS.length) % COORDINATION_LEVEL_OPTIONS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = COORDINATION_LEVEL_OPTIONS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveOptionIndex(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  }, []);

  const triggerLabel = t('coordinationLevel.ariaLabel', {
    level: current.rank,
    name: t(`coordinationLevel.levels.${value}.full`),
  });

  return (
    <span className={cn('inline-flex shrink-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!disabled) setIsOpen((open) => !open);
        }}
        disabled={disabled}
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-transparent px-0 text-xs font-medium outline-none transition-colors duration-200 motion-reduce:transition-none sm:h-8 sm:w-auto sm:px-2.5',
          'hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
          value === 'direct'
            ? 'text-muted-foreground'
            : value === 'delegate'
              ? 'text-blue-700 dark:text-blue-300'
              : 'text-amber-800 dark:text-amber-300',
        )}
        title={disabled ? t('coordinationLevel.lockedDuringRun') : t('coordinationLevel.appliesNextReply')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={triggerLabel}
      >
        <div className="flex items-center gap-1.5">
          <CoordinationLevelGlyph rank={current.rank} />
          <span className="hidden whitespace-nowrap sm:inline">
            {t(`coordinationLevel.levels.${value}.short`)}
          </span>
        </div>
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          dir={document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'}
          style={panelStyle || { position: 'fixed', top: 0, left: 0, width: 320, visibility: 'hidden' }}
          className="overflow-y-auto rounded-xl border border-border bg-popover shadow-xl"
          role="listbox"
          aria-label={t('coordinationLevel.selectorTitle')}
          onKeyDown={handleListboxKeyDown}
        >
          <div className="border-b border-border px-3 py-2.5">
            <span className="block text-[11px] font-semibold text-foreground/70">
              {t('coordinationLevel.selectorTitle')}
            </span>
            <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
              {t(`coordinationLevel.enforcement.${enforcement}`)}
            </span>
          </div>
          <div className="p-1.5">
            {COORDINATION_LEVEL_OPTIONS.map((option) => {
              const isSelected = option.id === value;
              return (
                <button
                  key={option.id}
                  ref={(node) => { optionRefs.current[option.rank - 1] = node; }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={activeOptionIndex === option.rank - 1 ? 0 : -1}
                  onFocus={() => setActiveOptionIndex(option.rank - 1)}
                  onClick={() => {
                    if (disabled) return;
                    onChange(option.id);
                    closePanel(true);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm outline-none transition-colors duration-150 motion-reduce:transition-none',
                    'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground',
                    isSelected && 'bg-accent text-accent-foreground',
                  )}
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                    <CoordinationLevelGlyph rank={option.rank} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {t(`coordinationLevel.levels.${option.id}.full`)}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t(`coordinationLevel.levels.${option.id}.description`)}
                    </span>
                  </span>
                  {isSelected && <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  claudeStatus,
  isLoading,
  isSubmitSealed = false,
  isSessionFrozen = false,
  runStartedAt = null,
  runProgress = null,
  workflowAgents = [],
  workflowStatus = null,
  onAbortSession,
  displayProvider,
  permissionMode,
  onModeSwitch,
  thinkingMode,
  setThinkingMode,
  composerMode,
  setComposerMode,
  agentModeAvailable,
  coordinationLevel,
  setCoordinationLevel,
  coordinationLevelAvailable,
  tokenBudget,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  isUserScrolledUp,
  hasMessages,
  showResync = false,
  isResyncing = false,
  retryUntil = null,
  onScrollToBottom,
  onSubmit,
  isDragActive,
  attachedImages,
  onRemoveImage,
  onReplaceImage,
  onCropStateChange,
  isImageCropping = false,
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
  isCommandDisabled,
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
  onVoiceInsert,
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
  executingCommand = null,
  sendError = null,
  outboxEntries = EMPTY_OUTBOX_ENTRIES,
  onOutboxRetry,
  onOutboxEdit,
  onOutboxDelete,
  onOutboxVerify,
  sessionCurrentModel = '',
  providerModelCatalog = {},
  onChangeSessionModel,
  sessionId,
  sessionStartedAt = null,
  sessionActiveModelChanged = false,
  onClearSessionModel,
  sessionEngineProvider = null,
}: ChatComposerProps) {
  const { t, i18n } = useTranslation('chat');
  // B-1042: الراية تُرفع فقط عند رفض القبول بسبب امتلاء الصندوق، وتنخفض عند
  // نجاح قبول لاحق أو عند تنفيذ الإقالة. كلا الاشتراكين يستخدمان نفس القناة.
  const admissionRefused = useSyncExternalStore(subscribeOutbox, getAdmissionRefusedSnapshot, getAdmissionRefusedSnapshot);
  const localOutbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, getOutboxSnapshot);
  const dismissReceivedCopies = useMemo(() => createDeliveredOutboxDismissal(), [localOutbox]);
  const scheduled = useScheduledMessages(sessionId);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledEdit, setScheduledEdit] = useState<ScheduledMessage | null>(null);

  useEffect(() => {
    // The composer survives route changes. Never leave a dialog from the old
    // conversation open where its id could be edited after navigation.
    setScheduleOpen(false);
    setScheduledEdit(null);
  }, [sessionId]);

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

  const openNewSchedule = useCallback(() => {
    setScheduledEdit(null);
    setScheduleOpen(true);
  }, []);

  const openScheduleEdit = useCallback((message: ScheduledMessage) => {
    setScheduledEdit(message);
    setScheduleOpen(true);
  }, []);

  const saveScheduledMessage = useCallback(async (content: string, scheduledFor: string) => {
    if (scheduledEdit) {
      await scheduled.update(scheduledEdit.id, content, scheduledFor);
      return;
    }
    const options: Record<string, unknown> = {};
    if (sessionCurrentModel) options.model = sessionCurrentModel;
    if (['low', 'medium', 'high', 'max'].includes(thinkingMode)) options.effort = thinkingMode;
    if (['default', 'acceptEdits', 'plan'].includes(permissionMode)) options.permissionMode = permissionMode;
    options.mode = composerMode;
    if (['direct', 'delegate', 'delegate_review'].includes(coordinationLevel)) {
      options.coordinationLevel = coordinationLevel;
    }
    await scheduled.create(content, scheduledFor, options);
    onClearInput();
  }, [composerMode, coordinationLevel, onClearInput, permissionMode, scheduled, scheduledEdit, sessionCurrentModel, thinkingMode]);
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
  // البث (isLoading) — لجلسات Claude وCodex التي تعلن قدرة sideChannel. هنا
  // نُرخي بوابة تعطيل الإرسال فقط؛ الاعتراض والـWS/overlay في وحدات منفصلة
  // (useChatComposerState/useBtwSideChannel/BtwOverlay) — قيد بوابة التصميم.
  const isBtwReady = capabilities.sideChannel.supported
    && Boolean(sessionId)
    && isSideChannelCommandForProvider(
      normalizeArabicSlashCommand(input, displayProvider, i18n?.language),
      displayProvider,
    );

  // ADR-097 — تفريغ صوتي عبر Web Speech. الإدراج نفسه يعيش في طبقة حالة
  // المُؤلِّف (onVoiceInsert ⇐ insertTextAtCursor): يحترم المؤشّر ويُحيّط النصّ
  // بمسافات ويُزامن مرجع القيمة ومُكتشف «/». لا نتائج مؤقّتة (تجنّب ارتباك طبقة
  // الـoverlay). موافقة لمرة واحدة قبل أول تفريغ (الصوت يمرّ بمحرّك المتصفّح).
  const auth = useOptionalAuth();
  // نطاق مفاتيح التخزين = معرّف المستخدم إن كان جاهزاً من سياق المصادقة القائم؛
  // بلا اعتماديّة جديدة — غيابه يُبقي المفتاح على نطاق المنتَج ونسخته وحدهما.
  const voiceStorageScope = auth?.user?.id != null ? String(auth.user.id) : null;
  const voice = useVoiceDictation(onVoiceInsert, { storageScope: voiceStorageScope });

  // ── ADR-103 / T-1248 — الوضع «الدقيق»: تسجيل ⇒ رفع ⇒ Whisper بمفتاح المُشغّل ──
  // الإتاحة من الخادم وحده و fail-closed (انظر useVoiceTranscriptionSettings)،
  // والإدراج بنفس مسار الوضع السريع (`onVoiceInsert`) فلا مسار إدراج ثانٍ.
  const voiceSettings = useVoiceTranscriptionSettings();
  const transcription = useVoiceTranscription(onVoiceInsert, {
    maxMb: voiceSettings.settings?.maxMb ?? null,
  });
  const [voiceMode, setVoiceMode] = useVoiceMode(voiceStorageScope);

  // قسم الوضع يُعرض دائماً، والمعطَّل يُعرض بسببه.
  //
  // كان مشروطاً بجواب الخادم، فصمتُ الخادم يُخفي القسم كلّه — وهو أسوأ فشل
  // ممكن هنا: صفحةٌ فُتحت قبل نشر مسار `/api/voice` تُبقي الجواب فارغاً إلى
  // الأبد، فيرى المستخدم قائمة لغات بلا أثر للوضع المستمرّ ولا سطر يقول لماذا.
  // ضاعت ساعة على هذا التشخيص بالضبط. الإخفاء الصامت يُبدَّل بسببٍ منطوق.
  const accurateOffered = true;
  const accurateUsable = Boolean(voiceSettings.settings?.available && transcription.isSupported);
  // «لم يُسأل الخادم بعد» ليس «لا مفتاح»: خلطهما يُرسل المستخدم إلى الإعدادات
  // يبحث عن مفتاح موجود أصلاً، بينما العلّة صفحةٌ لم تُحدَّث. سببان لا واحد.
  const accurateDisabledReasonKey = !voiceSettings.settings
    ? 'input.voice.modeAccurateUnknown'
    : !voiceSettings.settings.available
      ? 'input.voice.modeAccurateNeedsKey'
      : !transcription.isSupported
        ? 'input.voice.modeAccurateUnsupported'
        : null;
  // التفضيل المحفوظ لا يفرض وضعاً لا يعمل: مفتاحٌ سُحب من الإعدادات يُعيد
  // المستخدم إلى الوضع السريع بدل زرٍّ يفشل عند كل ضغطة. والتفضيل يبقى محفوظاً
  // فيعود وحده متى عاد المفتاح.
  // `!voice.isSupported` يرجّح الدقيق تلقائياً: في Firefox لا وجود لـWeb Speech
  // أصلاً، فوضعٌ «سريع» مختار وميّت يعني زرّ مايكروفون لا يفعل شيئاً بينما
  // البديل العامل حاضر.
  const effectiveVoiceMode: VoiceMode =
    accurateUsable && (voiceMode === 'accurate' || !voice.isSupported) ? 'accurate' : 'fast';
  const isAccurate = effectiveVoiceMode === 'accurate';

  // نافذة إفصاح واحدة بنصّين: أيّ وضع فتحها هو ما يحدّد النصّ ومفتاح الموافقة.
  const [consentFor, setConsentFor] = useState<VoiceMode | null>(null);
  const voiceButtonRef = useRef<HTMLButtonElement>(null);
  // «جلسة استماع قائمة» = التقاط جارٍ أو بدء معلّق. الحالة المعروضة تفصل بينهما:
  // الزرّ يستجيب فوراً بـisActive، وشارة «يستمع» لا تظهر إلا عند التقاط فعلي.
  const isVoiceActive = isAccurate
    ? transcription.isRecording
    : voice.isListening || voice.isStarting;
  const isVoiceBusy = isAccurate && transcription.isUploading;

  const consentKeyFor = useCallback(
    (mode: VoiceMode) =>
      mode === 'accurate'
        ? voiceAccurateConsentStorageKey(voiceStorageScope)
        : voiceConsentStorageKey(voiceStorageScope),
    [voiceStorageScope],
  );

  const closeConsentModal = useCallback(() => {
    setConsentFor(null);
  }, []);

  const beginDictation = useCallback(() => {
    const mode = consentFor ?? 'fast';
    try {
      window.localStorage.setItem(consentKeyFor(mode), 'granted');
    } catch {
      // تجاهل: قد يكون التخزين معطّلاً.
    }
    setConsentFor(null);
    if (mode === 'accurate') {
      transcription.start();
      return;
    }
    voice.start();
  }, [consentFor, consentKeyFor, transcription, voice]);

  const handleVoiceToggle = useCallback(() => {
    if (isAccurate) {
      if (transcription.isRecording) {
        transcription.stop();
        return;
      }
      if (transcription.isUploading) return;
    } else if (voice.isListening || voice.isStarting) {
      voice.stop();
      return;
    }
    // موافقة لمرة واحدة **لكل وضع**: الوضع السريع يمرّ الصوت بمحرّك المتصفّح
    // (Chromium يرسله إلى خوادم Google)، والدقيق يرفعه إلى خادم نسّاج ثمّ إلى
    // مزوّد خارجي بمفتاح المُشغّل. رحلتان مختلفتان، فموافقة كلٍّ لا تُغني عن
    // الأخرى. نافذة داخل التطبيق لا `confirm()`: الأخيرة يكبتها المتصفّح بعد
    // أول رفض فيصمت الزرّ بلا تفسير (مراجعة B-428).
    let consent: string | null = null;
    try {
      consent = window.localStorage.getItem(consentKeyFor(effectiveVoiceMode));
    } catch {
      consent = null;
    }
    if (consent !== 'granted') {
      setConsentFor(effectiveVoiceMode);
      return;
    }
    if (isAccurate) {
      transcription.start();
      return;
    }
    voice.start();
  }, [consentKeyFor, effectiveVoiceMode, isAccurate, transcription, voice]);

  // ── قائمة لغة التفريغ: زرّ أيمن (سطح المكتب)، ضغط مطوّل (لمس)، Shift+F10 ──
  const [isLangMenuOpen, setIsLangMenuOpen] = useState(false);
  const voiceHintId = useId();
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressMicClickUntilRef = useRef(0);

  // تعبير دالّة مسمّى كي تستطيع نزع نفسها من مستمع التمرير — الهوية ثابتة
  // (deps فارغة) فالنزع يطابق الإضافة.
  const cancelLongPress = useCallback(function cancel() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressOriginRef.current = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', cancel, true);
    }
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  const refreshVoiceSettings = voiceSettings.refresh;
  const openLangMenu = useCallback(() => {
    cancelLongPress();
    // اللمس يُطلق `contextmenu` في بعض المتصفّحات فوق مؤقّتنا: الفتح إثبات لا
    // تبديل، فالمساران يلتقيان على قائمة واحدة مفتوحة لا على فتحٍ ثمّ إغلاق.
    suppressMicClickUntilRef.current = Date.now() + VOICE_LANG_CLICK_SUPPRESS_MS;
    // المالك قد يكون أضاف المفتاح في تبويب الإعدادات قبل ثوانٍ؛ إعادة القراءة
    // عند الفتح أرخص من إجبار المستخدم على تحديث الصفحة ليرى الوضع الدقيق.
    refreshVoiceSettings();
    setIsLangMenuOpen(true);
  }, [cancelLongPress, refreshVoiceSettings]);

  const closeLangMenu = useCallback(
    (restoreFocus: boolean) => {
      setIsLangMenuOpen(false);
      if (restoreFocus) {
        voiceButtonRef.current?.focus();
      }
    },
    [],
  );

  const handleLangSelect = useCallback(
    (nextLang: string) => {
      voice.setLang(nextLang);
      closeLangMenu(true);
    },
    [closeLangMenu, voice],
  );

  /**
   * تبديل الوضع يُنهي أي التقاط جارٍ في الوضع المغادَر: تسجيلٌ بدأ في وضع ثمّ
   * سُلّم إلى آلة الوضع الآخر لا مالك له — والمايكروفون يبقى مفتوحاً بلا زرّ
   * يوقفه. الإنهاء قاطع في الحالتين (لا إدراج متأخّر لوضعٍ غادره المستخدم).
   */
  const handleModeSelect = useCallback(
    (nextMode: VoiceMode) => {
      if (nextMode !== voiceMode) {
        voice.stopAndDiscard();
        transcription.cancel();
      }
      setVoiceMode(nextMode);
      closeLangMenu(true);
    },
    [closeLangMenu, setVoiceMode, transcription, voice, voiceMode],
  );

  const handleMicClick = useCallback(() => {
    if (isLangMenuOpen) {
      closeLangMenu(false);
      return;
    }
    if (Date.now() < suppressMicClickUntilRef.current) {
      // نقرة تابعة لإيماءة فتح القائمة، لا نيّة تفريغ.
      suppressMicClickUntilRef.current = 0;
      return;
    }
    handleVoiceToggle();
  }, [closeLangMenu, handleVoiceToggle, isLangMenuOpen]);

  const handleMicContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // قائمة المتصفّح لا تُعرض: مكانها قائمتنا.
      event.preventDefault();
      openLangMenu();
    },
    [openLangMenu],
  );

  const handleMicPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // الفأرة تملك الزرّ الأيمن، فالضغط المطوّل لها تأخيرٌ بلا فائدة.
      if (event.pointerType === 'mouse') return;
      cancelLongPress();
      longPressOriginRef.current = { x: event.clientX, y: event.clientY };
      // الالتقاط على النافذة: أحداث التمرير لا تتصاعد، فالمرور الهابط وحده
      // يبلغنا تمرير صفّ الأدوات أو لوح المحادثة تحت الإصبع.
      window.addEventListener('scroll', cancelLongPress, true);
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        openLangMenu();
      }, VOICE_LANG_LONG_PRESS_MS);
    },
    [cancelLongPress, openLangMenu],
  );

  const handleMicPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const origin = longPressOriginRef.current;
      if (!origin) return;
      if (
        Math.abs(event.clientX - origin.x) > VOICE_LANG_LONG_PRESS_SLOP_PX ||
        Math.abs(event.clientY - origin.y) > VOICE_LANG_LONG_PRESS_SLOP_PX
      ) {
        // سحبٌ لا ضغطة: صفّ الأدوات نفسه يُمرَّر أفقياً.
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );

  const handleMicKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      // الزرّ الأيمن وحده يقصي مستخدم لوحة المفاتيح؛ Shift+F10 ومفتاح القائمة
      // هما المكافئ القياسي لقائمة السياق.
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        openLangMenu();
      }
    },
    [openLangMenu],
  );

  // تبديل الجلسة (وضمناً المشروع، فتبديل المشروع يُبدّل الجلسة المعروضة) يُنهي
  // الاستماع: تفريغ يتسرّب إلى مسودّة محادثة أخرى أسوأ من تفريغ ينقطع.
  // B-437 §3: `stop()` اللطيف يُبقي المستمعات كي تصل النتيجة المعلّقة — وهو
  // الصواب للإيقاف اليدوي، وتسرُّبٌ هنا: المكوّن لا يُعاد تركيبه عند تبديل
  // الجلسة، فالمُدرِج صار مؤلِّف الجلسة الجديدة وما قيل في الأولى يُكتب فيها.
  // لذلك إيقاف قاطع يفصل ويُجهض ويمنع أي إدراج لاحق.
  // الوضع الدقيق يُلغى قطعاً كذلك: تسجيلٌ يُرفع بعد تبديل الجلسة يُدرج نصّه في
  // المسودّة الخطأ بعد ثانيتين — والصمت الظاهري يجعل مصدره غامضاً تماماً.
  const voiceDiscardRef = useRef<() => void>(() => {});
  voiceDiscardRef.current = () => {
    voice.stopAndDiscard();
    transcription.cancel();
  };
  useEffect(() => {
    return () => {
      voiceDiscardRef.current();
    };
  }, [sessionId]);

  const voiceErrorMessage = useMemo(() => {
    // خطأ الوضع المعروض وحده: بقايا خطأ الوضع الآخر تشرح عطلاً لا يعيشه المستخدم.
    const activeError = isAccurate ? transcription.error : voice.error;
    if (!activeError) return null;
    const knownKeys: Record<string, string> = {
      // الوضع السريع (Web Speech).
      'not-allowed': 'input.voice.errors.notAllowed',
      'service-not-allowed': 'input.voice.errors.notAllowed',
      network: 'input.voice.errors.network',
      'audio-capture': 'input.voice.errors.audioCapture',
      'language-not-supported': 'input.voice.errors.languageNotSupported',
      'start-failed': 'input.voice.errors.startFailed',
      'restart-exhausted': 'input.voice.errors.restartExhausted',
      unsupported: 'input.voice.errors.unsupported',
      // الوضع الدقيق: رموز الخادم حرفياً + أعطال محليّة لا تصله.
      NO_TRANSCRIPTION_KEY: 'input.voice.errors.noKey',
      INVALID_TRANSCRIPTION_KEY: 'input.voice.errors.invalidKey',
      TRANSCRIPTION_RATE_LIMITED: 'input.voice.errors.rateLimited',
      TRANSCRIPTION_TIMEOUT: 'input.voice.errors.timeout',
      TRANSCRIPTION_UNREACHABLE: 'input.voice.errors.unreachable',
      TRANSCRIPTION_FAILED: 'input.voice.errors.transcriptionFailed',
      UNSUPPORTED_AUDIO_TYPE: 'input.voice.errors.unsupportedAudio',
      EMPTY_AUDIO: 'input.voice.errors.emptyAudio',
      'mic-denied': 'input.voice.errors.notAllowed',
      'no-mic': 'input.voice.errors.audioCapture',
      'capture-failed': 'input.voice.errors.captureFailed',
      'recorder-failed': 'input.voice.errors.recorderFailed',
      'upload-failed': 'input.voice.errors.uploadFailed',
    };
    if (activeError === 'AUDIO_TOO_LARGE') {
      // السقف جزء من الرسالة: «كبير جداً» بلا رقم لا تُرشد إلى تسجيل أقصر.
      return t('input.voice.errors.tooLarge', { maxMb: transcription.maxMb });
    }
    return t(knownKeys[activeError] ?? 'input.voice.errors.generic');
  }, [isAccurate, t, transcription.error, transcription.maxMb, voice.error]);

  // إشعار غير خطأ: التسجيل بلغ سقف المدّة فتوقّف تلقائياً — وما سُجّل يُفرَّغ.
  const voiceNoticeMessage =
    isAccurate && transcription.reachedMaxDuration && !voiceErrorMessage
      ? t('input.voice.maxDurationNotice')
      : null;

  // اسم الزرّ = فعله الآن، لا اسم الميزة: «يُفرَّغ…» أثناء الرفع تمنع ضغطةً
  // ثانية يظنّها المستخدم إعادةَ محاولة.
  const voiceActionLabel = isVoiceBusy
    ? t('input.voice.transcribing')
    : isVoiceActive
      ? t(isAccurate ? 'input.voice.stopAccurate' : 'input.voice.stop')
      : t(isAccurate ? 'input.voice.startAccurate' : 'input.voice.start');

  // قسم الوضع لا يُعرض إلا إن كان للاختيار معنى (الخادم يعرف الوضع الدقيق).
  // والمعطَّل يُعرض بسببه: «غير متاح» صامتاً يجعل المستخدم يبحث عن عطل في جهازه.
  const voiceMenuModes = useMemo<VoiceMenuModeEntry[]>(() => {
    if (!accurateOffered) return [];
    return [
      {
        value: 'fast',
        label: t('input.voice.modeFast'),
        hint: t('input.voice.modeFastHint'),
        disabled: !voice.isSupported,
        disabledReason: voice.isSupported ? null : t('input.voice.errors.unsupported'),
      },
      {
        value: 'accurate',
        label: t('input.voice.modeAccurate'),
        hint: t('input.voice.modeAccurateHint'),
        disabled: !accurateUsable,
        disabledReason: accurateDisabledReasonKey ? t(accurateDisabledReasonKey) : null,
      },
    ];
  }, [accurateDisabledReasonKey, accurateOffered, accurateUsable, t, voice.isSupported]);

  // إعلان واحد لقارئ الشاشة: بدء، إيقاف (بعد استماع فعلي لا عند أول رندر)، وخطأ.
  const [voiceAnnouncement, setVoiceAnnouncement] = useState('');
  // الإعلان على مستوى الجلسة (isVoiceActive) لا على مستوى الالتقاط: المحرّك
  // يتوقّف ويُستأنف عند كل فترة صمت، والإعلان عنده يُغرق قارئ الشاشة.
  const wasListeningRef = useRef(false);
  useEffect(() => {
    if (isAccurate) {
      // آلة الوضع الدقيق تُعلن عن نفسها أدناه؛ تصفير الراية يمنع إعلان «توقّف»
      // كاذباً حين يعود المستخدم إلى الوضع السريع.
      wasListeningRef.current = false;
      return;
    }
    if (isVoiceActive) {
      if (!wasListeningRef.current) {
        wasListeningRef.current = true;
        setVoiceAnnouncement(t('input.voice.startedAnnouncement'));
      }
      return;
    }
    if (wasListeningRef.current) {
      wasListeningRef.current = false;
      setVoiceAnnouncement(t('input.voice.stoppedAnnouncement'));
    }
  }, [isAccurate, t, isVoiceActive]);

  // الوضع الدقيق يمرّ بأربع حالات مرئية للمستخدم، وأهمّها الانتقالان الصامتان:
  // «يُفرَّغ» (لا شيء يحدث على الشاشة لثانيتين) و«تمّ» (نصّ ظهر فجأة في الحقل).
  const prevTranscriptionStateRef = useRef(transcription.state);
  useEffect(() => {
    const previous = prevTranscriptionStateRef.current;
    const next = transcription.state;
    prevTranscriptionStateRef.current = next;
    if (!isAccurate || previous === next) return;
    if (next === 'recording') {
      setVoiceAnnouncement(t('input.voice.recordingAnnouncement'));
    } else if (next === 'uploading') {
      setVoiceAnnouncement(t('input.voice.transcribingAnnouncement'));
    } else if (next === 'idle') {
      setVoiceAnnouncement(
        t(
          previous === 'uploading'
            ? 'input.voice.transcribedAnnouncement'
            : 'input.voice.stoppedAnnouncement',
        ),
      );
    }
  }, [isAccurate, t, transcription.state]);

  useEffect(() => {
    if (voiceErrorMessage) {
      setVoiceAnnouncement(voiceErrorMessage);
    }
  }, [voiceErrorMessage]);
  useEffect(() => {
    if (voiceNoticeMessage) {
      setVoiceAnnouncement(voiceNoticeMessage);
    }
  }, [voiceNoticeMessage]);

  // اتجاه المؤلِّف: `dir="auto"` يحسب الاتجاه من **قيمة** الحقل لا من الـplaceholder،
  // والقيمة الفارغة تُحسم `ltr` — فيرتدّ نصّ الـplaceholder العربي إلى يسار الصندوق
  // داخل واجهة `rtl` (وهو ما يظهر في كل محادثة جديدة قبل كتابة أول حرف). عند الفراغ
  // نُسقط السِمة فيرث الحقل اتجاه المستند، ونعيد `auto` فور وجود مسودّة كي يبقى
  // الاتجاه محسوباً من أول حرف قوي فيها ومطابقاً لطبقة مرآة الـ@mentions.
  const composerDir = input ? 'auto' : undefined;
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

  const permissionModeLabel =
    permissionMode === 'acceptEdits'
      ? t('codex.modes.acceptEdits')
      : permissionMode === 'auto'
        ? t('codex.modes.auto')
        : permissionMode === 'bypassPermissions'
          ? t('codex.modes.bypassPermissions')
          : permissionMode === 'plan'
            ? t('codex.modes.plan')
            : t('codex.modes.default');
  const postureDescription = capabilities.posture.supported
    ? t(getCodexPostureKey(permissionMode))
    : null;
  const modeAriaLabel = postureDescription
    ? `${t('input.clickToChangeMode')}: ${permissionModeLabel}. ${t('codex.posture.title')}: ${postureDescription}`
    : `${t('input.clickToChangeMode')}: ${permissionModeLabel}`;

  return (
    <div className="flex-shrink-0 px-2 py-3 sm:px-4">
      <VoiceConsentModal
        open={consentFor !== null}
        title={t(
          consentFor === 'accurate'
            ? 'input.voice.accurateConsentTitle'
            : 'input.voice.consentTitle',
        )}
        message={t(
          consentFor === 'accurate' ? 'input.voice.accurateConsent' : 'input.voice.consent',
        )}
        confirmLabel={t('input.voice.consentAccept')}
        cancelLabel={t('input.voice.consentCancel')}
        onCancel={closeConsentModal}
        onConfirm={beginDictation}
        restoreFocusRef={voiceButtonRef}
      />

      {/* AgentStatusCard يدمج بطاقة نشاط الوكلاء وشريط CLAUDE في عنصر واحد:
          — حين لا وكلاء (agents=[]): يُفوَّض لـ ClaudeStatus مباشرةً (سلوك سابق)
          — حين يوجد وكلاء: يُعرض رأس واحد يجمع الشعار والمؤقت وزر STOP
          وملخّص الوكلاء وchevron الطيّ، مع صفوف الوكلاء في جزء قابل للطيّ.
          — يبقى ظاهراً أثناء طلب الصلاحية كي لا ينقطع مؤقّت التشغيل الجاري. */}
      <AgentStatusCard
          agents={runProgress?.agents ?? []}
          workflowAgents={workflowAgents}
          workflowStatus={workflowStatus}
          status={claudeStatus}
          isLoading={isLoading}
          frozen={isSessionFrozen}
          onAbort={onAbortSession}
          provider={displayProvider}
          runStartedAt={runStartedAt}
          progress={runProgress}
      />

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
          className="mx-auto mb-2 max-w-4xl [overflow-wrap:anywhere] rounded-lg border border-red-300/60 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-600/40 dark:bg-red-900/15 dark:text-red-300"
        >
          {sendError}
        </div>
      )}

      {/*
        T-1295 — بطاقة لكل رسالةٍ لم تصل، في موضع شريط الخطأ نفسه فوق المُؤلِّف:
        هذا هو المكان الذي ينظر إليه المستخدم لحظة الإرسال. الشريط أعلاه إشعارٌ
        يزول بعد ثوانٍ، وهذه بطاقةٌ تبقى حتى يتصرّف صاحبها.
      */}
      {/*
        B-1042 — شريط الإقالة: يظهر فقط حين رُفض القبول بسبب امتلاء الصندوق
        (admissionRefused)، ويختفي عند الإقالة أو نجاح إرسال لاحق.
      */}
      {admissionRefused && (
        <div className="mx-auto mb-2 max-w-4xl">
          <button
            type="button"
            onClick={dismissReceivedCopies}
            title={t('outbox.dismissAllDeliveredDescription')}
            className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            {t('outbox.dismissAllDelivered')}
          </button>
          <p className="mt-1 text-xs text-muted-foreground">{t('outbox.dismissAllDeliveredDescription')}</p>
        </div>
      )}
      {outboxEntries.map((entry) => (
        <OutboxCard
          key={entry.id}
          entry={entry}
          onRetry={onOutboxRetry ?? noopOutboxAction}
          onEdit={onOutboxEdit ?? noopOutboxAction}
          onDelete={onOutboxDelete ?? noopOutboxAction}
          onVerify={onOutboxVerify ?? noopOutboxAction}
        />
      ))}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-4xl">

        {/* B-999: الشريط يمتدّ بعرض المُؤلِّف كاملاً فوقه (‏-top-10) وهو شفاف،
              فكان يبتلع نقرات كل ما يقع تحته: أزرار طلب الصلاحية وأزرار آخر
              رسالة. ويظهر حصراً حين لا يكون المستخدم في آخر المحادثة، فيبدو
              العطل كأنّ «الأزرار لا تعمل إلا بعد النزول لآخر المحادثة».
              الحلّ: الغلاف لا يستقبل اللمس، والزرّ وحده يستقبله. */}
        {/* T-1821: زرّ موحَّد — ينزل ويُعيد المزامنة.
              يظهر حين:
                (أ) المستخدم تمرَّر للأعلى ويوجد رسائل، أو
                (ب) showResync=true (historyError / جلسة عالقة / انقطاع تعافى)
                    بصرف النظر عن وجود رسائل (fix-1: لا بديل مرئي عند الخطأ الابتدائي).
              أثناء المزامنة أو انتظار retryAt تظهر دوّامة وتُعطَّل النقرة. */}
        {((isUserScrolledUp && hasMessages) || showResync) && (() => {
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
            <div className="pointer-events-none absolute -top-10 start-0 end-0 z-10 flex justify-center">
              <button
                type="button"
                onClick={onScrollToBottom}
                disabled={isDisabled}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
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
          isCommandDisabled={isCommandDisabled}
        />

        {executingCommand && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="mb-2 flex min-h-9 w-full items-center gap-2 overflow-hidden rounded-xl border border-border/60 bg-muted/50 px-3 py-2 text-sm text-muted-foreground shadow-sm"
          >
            <Loader2Icon
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            />
            <span className="min-w-0 truncate">
              {t('commandExecution.running', { defaultValue: 'Running command' })}{' '}
              <bdi dir="ltr" className="font-mono font-medium text-primary">
                {executingCommand.name}
              </bdi>
              <span aria-hidden="true">…</span>
            </span>
          </div>
        )}

        <ScheduledMessagesPanel
          messages={scheduled.messages}
          loading={scheduled.loading}
          busyId={scheduled.busyId}
          error={scheduled.error}
          errorKind={scheduled.errorKind}
          onEdit={openScheduleEdit}
          onRetry={(id) => { void scheduled.retry(id).catch(() => undefined); }}
          onCancel={(id) => { void scheduled.cancel(id).catch(() => undefined); }}
          onRefresh={() => { void scheduled.refresh(); }}
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
                      onReplace={onReplaceImage ? (next) => onReplaceImage(file, next) : undefined}
                      onCropStateChange={onCropStateChange}
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
              `composerDir` هنا ليست خياراً بل مطابقةً حرفية لسِمة الـtextarea
              أدناه — بدونها ترث الطبقة `rtl` من المستند بينما يحسب الحقل اتجاهه
              من أول حرف قوي في المسودّة، فتسقط مستطيلات التمييز على حروف أخرى
              في كل مسودّة تفتح بحرف مخالف (126 من 1916 مسودّة حقيقية).
            */}
            <div ref={inputHighlightRef} dir={composerDir} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              // rows=1: الافتراضي في HTML سطران، والحقل الفارغ يُعاد إلى
              // height:auto (useChatComposerState) فيبقى بارتفاع سطرين ويترك
              // سطراً خالياً بين النائب والتلميح. الارتفاع عند الكتابة يضبطه
              // الـautosize بـstyle مباشرة، فلا أثر لـrows عليه.
              rows={1}
              dir={composerDir}
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

            {/* تلميح مفاتيح الإرسال — داخل صندوق الكتابة تحت الحقل مباشرة، لا في
                شريط الأدوات: هناك كان يزاحم مؤشّر السياق على العرض نفسه فيقصّره،
                وهنا يملك سطره الخاص فلا يحتاج truncate ولا سقف lg.
                opacity (لا شرط render) كي لا يقفز ارتفاع الصندوق عند أول حرف. */}
            <div
              // نفس مقاس النائب وارتفاع سطره وحشوته الأفقية (px-4/text-sm/leading-6)
              // فيقرأ السطران ككتلة واحدة متناسقة لا كسطرين بمقاسين مختلفين.
              // ‏-mt-2 يلغي حشوة الـtextarea السفلية (py-2) فيلتصق التلميح بالنائب
              // سطراً تالياً له تماماً (24px = leading-6) بدل فجوة ~36px.
              className={`pointer-events-none -mt-2 hidden select-none px-4 pb-2 text-sm leading-6 text-muted-foreground/50 transition-opacity duration-200 sm:block ${
                input.trim() ? 'opacity-0' : 'opacity-100'
              }`}
            >
              {sendByCtrlEnter ? t('input.hintText.ctrlEnter') : t('input.hintText.enter')}
            </div>
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
              safety net above still absorbs any narrow-viewport overflow.

              `py-2 -my-2` ثمنُ `overflow-x-auto` أعلاه: حين لا يكون أحد
              المحورين visible تُحوّل CSS الآخرَ إلى `auto`، فيصير هذا الصفّ
              سياقَ قصٍّ **رأسيّ** أيضاً وإن لم يُطلب — وحدّ القصّ هو صندوق
              الحشو، وهو هنا ملتصقٌ بارتفاع العناصر (36px). فكل ما يفيض رأسياً
              يُقصّ: توهّج ultracode كان يظهر شريطاً مستطيلاً مقطوع الأعلى
              والأسفل بدل هالة (شكوى المالك 2026-08-07، ولقطة تُثبته).
              الحشو 8px يفتح المتنفَّس، والهامش السالب يُلغي أثره في الارتفاع
              فيبقى الصفّ 36px والمُؤلِّف بقياسه. وأبعد من 8px يقصّ
              `overflow-hidden` على PromptInput نفسه — فهي سقف الميزانية،
              وعليها بُنيت شدّة التوهّج في index.css (لا تزد أحدهما وحده). */}
          <PromptInputTools className="scrollbar-hide -my-1.5 flex-nowrap gap-2 overflow-x-auto py-1.5">
            {/* ارتفاع موحّد 32px (h-8) لكل عناصر الشريط — أزرار وحبوب ومؤشّرات —
                فيقرأ الصفّ خطاً واحداً بدل 28/32/36/40 متفاوتة. */}
            <PromptInputButton
              className="h-8 w-8 shrink-0 [&_svg]:size-4"
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

            {/* ADR-097 — زرّ تفريغ صوتي (Web Speech). يُخفى تلقائياً في المتصفّحات
                بلا دعم (Firefox) أو خارج سياق آمن؛ التدهور اللطيف لا التعطّل الصامت.
                ليس قدرة مزوّد: ميزة إدخال تعود للمستخدم، تظهر دائماً عند توفر الدعم. */}
            {(voice.isSupported || accurateUsable) && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <PromptInputButton
                  ref={voiceButtonRef}
                  // select-none: الضغط المطوّل على اللمس يُطلق تحديد النصّ ونافذة
                  // النداء الأصليّة فوق قائمتنا لولاه.
                  // التوهّج مربوط بـisVoiceActive (مستوى الجلسة) لا بالالتقاط:
                  // محرّك Web Speech يُنهي الالتقاط عند كل صمت ويُعيد تشغيله،
                  // فمؤشّرٌ مربوط بالالتقاط يرفرف كأنّ التسجيل ينقطع ويعود.
                  className={`h-8 w-8 shrink-0 select-none [&_svg]:size-4 ${
                    isVoiceActive ? 'voice-mic-live' : ''
                  } ${isVoiceBusy ? 'text-primary' : ''}`}
                  // الزرّ معطَّل أثناء الرفع: ضغطة ثانية هناك إمّا تُلغي تفريغاً
                  // كاد يصل أو تبدأ تسجيلاً فوق آخر — وكلاهما ليس ما قصده أحد.
                  disabled={isVoiceBusy}
                  tooltip={{
                    content: voiceErrorMessage ? (
                      voiceErrorMessage
                    ) : (
                      // سطران: الفعل الأساسي، ثمّ كيف تُفتح القائمة — الإيماءة
                      // المخفيّة لا تُكتشف وحدها، وقد ورثت مكان الصندوق «EN».
                      <span className="flex flex-col gap-0.5 text-start">
                        <span>{voiceActionLabel}</span>
                        <span className="text-[10px] opacity-80">{t('input.voice.languageHint')}</span>
                      </span>
                    ),
                  }}
                  onClick={handleMicClick}
                  onContextMenu={handleMicContextMenu}
                  onPointerDown={handleMicPointerDown}
                  onPointerMove={handleMicPointerMove}
                  onPointerUp={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onKeyDown={handleMicKeyDown}
                  aria-pressed={isVoiceActive}
                  aria-busy={isVoiceBusy || undefined}
                  aria-haspopup="menu"
                  aria-expanded={isLangMenuOpen}
                  // الوصف لا الاسم: إلحاق التلميح بـaria-label يُغرق إعلان الزرّ
                  // في كل مرة يُنطق فيها.
                  aria-describedby={voiceHintId}
                  aria-label={voiceActionLabel}
                >
                  {isVoiceBusy ? (
                    // قرص دوّار لا نبض أحمر: «يُفرَّغ» انتظارٌ لا التقاط، وتمييزهما
                    // بصرياً هو ما يمنع المستخدم من الكلام في ميكروفون مغلق.
                    <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <MicIcon />
                  )}
                </PromptInputButton>
                <span id={voiceHintId} className="sr-only">
                  {t('input.voice.languageHint')}
                </span>
                {isLangMenuOpen && (
                  <VoiceLanguageMenu
                    options={voice.languageOptions}
                    current={voice.lang}
                    label={t('input.voice.language')}
                    anchorRef={voiceButtonRef}
                    onSelect={handleLangSelect}
                    onClose={closeLangMenu}
                    modes={voiceMenuModes}
                    mode={effectiveVoiceMode}
                    onModeSelect={handleModeSelect}
                    modeSectionLabel={t('input.voice.mode')}
                    languageSectionLabel={t('input.voice.language')}
                    // قائمة اللغات تختفي في الوضع الدقيق: الكشف تلقائي هناك.
                    showLanguages={!isAccurate && voice.isSupported}
                    languageNote={isAccurate ? t('input.voice.languageAutoNote') : null}
                  />
                )}
                {/* حالة الالتقاط تُعرض بتوهّج الأيقونة نفسها لا بكلمة تزحم صفّ
                    الأدوات (طلب المالك). النصّ يبقى في الشجرة لقارئ الشاشة —
                    اللون وحده لا يُبلّغ من لا يميّزه، والحذف الكامل يُسكت
                    التقنية المساعدة. */}
                {!isAccurate && voice.isListening && (
                  <span className="sr-only">{t('input.voice.listening')}</span>
                )}
                {isAccurate && transcription.isRecording && (
                  <span className="sr-only">{t('input.voice.recording')}</span>
                )}
                {isVoiceBusy && <span className="sr-only">{t('input.voice.transcribing')}</span>}
                {/* الخطأ مرئي لا صامت: نصّ صغير بجانب الزرّ + إعلان لقارئ الشاشة. */}
                {voiceErrorMessage && (
                  <span className="max-w-48 shrink-0 truncate text-[11px] text-red-600 dark:text-red-400">
                    {voiceErrorMessage}
                  </span>
                )}
                {!voiceErrorMessage && voiceNoticeMessage && (
                  <span className="max-w-48 shrink-0 truncate text-[11px] text-muted-foreground">
                    {voiceNoticeMessage}
                  </span>
                )}
                <span aria-live="polite" className="sr-only">
                  {voiceAnnouncement}
                </span>
              </span>
            )}

            <PromptInputButton
              className="group h-8 w-8 shrink-0 rounded-lg p-0 text-muted-foreground shadow-none transition-[color,background-color,transform] duration-150 hover:bg-muted hover:text-foreground hover:shadow-none active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              tooltip={{ content: t('input.showAllCommands') }}
              onClick={onToggleCommandMenu}
              aria-label={t('input.showAllCommands')}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 group-hover:text-foreground"
              >
                <Terminal size={16} strokeWidth={2.2} />
              </span>
            </PromptInputButton>

            {/* مبدّل النموذج يأتي بعد زر الأوامر: صورة، صوت، أوامر، نموذج. */}
            {capabilities.modelSwitch?.supported && onChangeSessionModel && (
              <InlineModelSwitcher
                provider={displayProvider}
                currentModel={sessionCurrentModel}
                catalog={providerModelCatalog}
                onSelect={onChangeSessionModel}
                disabled={isLoading || isSubmitSealed}
                className="shrink-0"
                sessionId={sessionId}
                sessionModelChanged={sessionActiveModelChanged}
                onClearSessionModel={onClearSessionModel}
                engineProvider={sessionEngineProvider}
              />
            )}

            {coordinationLevelAvailable && (
              <CoordinationLevelSelector
                value={coordinationLevel}
                onChange={setCoordinationLevel}
                enforcement={capabilities.coordinationLevel.enforcement}
                disabled={isLoading || isSubmitSealed}
                className="shrink-0"
              />
            )}

            {capabilities.posture.supported ? (
              <Tooltip
                multiline
                content={
                  <span className="flex flex-col gap-0.5 text-start">
                    <span>{t('input.clickToChangeMode')}</span>
                    <span className="text-[10px] opacity-80">{postureDescription}</span>
                  </span>
                }
              >
                <button
                  type="button"
                  onClick={onModeSwitch}
                  className="flex h-8 shrink-0 items-center rounded-lg px-2 text-xs font-medium text-muted-foreground transition-all duration-200 hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-2.5"
                  aria-label={modeAriaLabel}
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
                    <span className="hidden whitespace-nowrap sm:inline">{permissionModeLabel}</span>
                  </div>
                </button>
              </Tooltip>
            ) : (
              <button
              type="button"
              onClick={onModeSwitch}
              className="flex h-8 shrink-0 items-center rounded-lg px-2 text-xs font-medium text-muted-foreground transition-all duration-200 hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-2.5"
              title={t('input.clickToChangeMode')}
              aria-label={modeAriaLabel}
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
                  {permissionModeLabel}
                </span>
              </div>
            </button>
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
                    on, so nothing is lost.
                    عنصران بقصد (قرار المالك 2026-08-07): الحلقة النابضة تُبلّغ
                    بالحالة واللصيقة تُسمّيها، ودمجهما في حبّة واحدة جُرِّب ورُدّ. */}
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

            {/* Context measurement validates its native snapshot and carrier identity. */}
            <span className="inline-flex min-w-0">
              <TokenUsageSummary
                usage={tokenBudget}
                provider={displayProvider}
                modelId={sessionCurrentModel || null}
                sessionStartedAt={sessionStartedAt}
                sessionId={sessionId ?? null}
              />
            </span>

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
                className={`flex h-8 shrink-0 items-center rounded-lg border px-2 text-xs font-medium transition-all duration-200 sm:px-2.5 ${
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

            {hasInput && (
              <PromptInputButton
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
                className="sm:No-flex hidden h-8 w-8 shrink-0 [&_svg]:size-4"
              >
                <XIcon />
              </PromptInputButton>
            )}

          </PromptInputTools>

          <div className="flex shrink-0 items-center gap-2">
            <ScheduleMessageButton
              disabled={!sessionId || !input.trim() || attachedImages.length > 0 || attachedFiles.length > 0 || isSubmitSealed || Boolean(executingCommand)}
              onClick={openNewSchedule}
            />
            <PromptInputSubmit
              status={isBtwReady ? 'ready' : undefined}
              disabled={(!input.trim() && attachedImages.length === 0) || Boolean(executingCommand) || (isLoading && !isBtwReady) || !isWsConnected || isImageCropping}
              title={!isWsConnected ? t('ws.sendDisabledTitle', { defaultValue: 'Cannot send — connection lost' }) : undefined}
              className="h-8 w-8 shrink-0 sm:h-8 sm:w-8"
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
      <ScheduleMessageDialog
        open={scheduleOpen}
        message={scheduledEdit}
        initialContent={input}
        busy={scheduled.busyId !== null}
        onOpenChange={setScheduleOpen}
        onSave={saveScheduledMessage}
      />
      </div>}
    </div>
  );
}

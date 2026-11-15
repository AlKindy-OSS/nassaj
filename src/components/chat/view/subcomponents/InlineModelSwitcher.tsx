/**
 * InlineModelSwitcher.tsx — T-1028 / B-251 / B-252
 *
 * مبدّل نموذج مدمج في شريط أدوات المُؤلِّف لتبديل النموذج وسط المحادثة.
 * يستعمل `rowsForBody` من modelPickerRows.ts (مُرشَّح بلا صفوف محرّك) فلا
 * يعيد اختراع منطق الصفوف — B-245 يبقى محكوماً من مكانٍ واحد.
 *
 * ## B-251 — إفصاح النطاق
 * يعرض شارة في رأس القائمة قبل الاختيار تُخبر المستخدم هل تبديله يصيب
 * «هذه المحادثة فقط» (sessionId موجود) أم «افتراضي لكل محادثة جديدة»
 * (بلا جلسة بعد). بعد الاختيار يُؤكَّد الـscope الحقيقي العائد من الخادم.
 *
 * ## B-252 — خيار «اتبع الافتراضي»
 * يظهر فقط حين جلسة قائمة + changed===true (تثبيت صريح موجود).
 * لا يُعيد نموذج الإنشاء — يتبع افتراضي المزوّد الحالي.
 *
 * ## B-311 — استنباط المحرّك من النموذج حين يغيب الختم
 * ختم المحرّك يعيش في localStorage وحده (B-258/B-262): متصفّح آخر أو تخزين
 * مُسِح يُسقطه، فتبدو جلسةٌ تعمل على z.ai كأنها جلسة Anthropic رسمية.
 * الاستنباط من النموذج الفعّال (engineGuard.ts) يسدّ ذلك: نموذجٌ ليس في كتالوج
 * الجسد لكنه في كتالوج محرّك مؤهَّل ⇒ الجلسة محرَّكة. يبقى مستعمَلاً هنا —
 * لكن ليعرف المبدّل **أين هو الآن**، لا ليقفل نفسه.
 *
 * ## B-352 — المحرّك يُبدَّل، ولا يُقفَل عليه
 * حتى الآن كان أي محرّك (مختوماً أو مستنبَطاً) يُعطّل المبدّل كلياً، بحجّة أن
 * معرّف Claude في جلسة موجَّهة إلى مورّد يُنتج دوراً فاشلاً. الحجّة صحيحة
 * والاستنتاج خاطئ: الختم يُقرأ **لكل دور** في dispatchProviderCommand، فتبديله
 * وسط المحادثة ممكن فعلاً — ومُثبَت ميدانياً على transcript ضمّ kimi-k3 ثم
 * kimi-k2.6 ثم claude-opus-5 بنفس معرّف الجلسة. ما كان يجب منعه هو **افتراق
 * المحورين** (نموذج جديد على محرّك قديم)، لا التبديل نفسه.
 * فصار كل صفّ يحمل محرّكه، والاختيار يعيد ختم المحرّك ويثبّت النموذج معاً
 * (‏ChatInterface.handleChangeSessionModel)، والقرار للمستخدم.
 *
 * القيود الباقية:
 * — صفوف المحرّك بلا مفتاح مخزَّن (locked) لا تُعرض: لا مسار إعدادات من هنا.
 * — محور المحرّك يبقى حكراً على جسد claude (ADR-073 §4، مفروض في
 *   modelPickerRows).
 * — معرّف opencode المؤهَّل (glm/glm-5.2) يُمرَّر حرفياً بلا تشذيب (T-1021).
 * — المزوّدات التي لا تدعم التبديل (hermes/sakana/…) تُخفى عبر
 *   capabilities.modelSwitch.supported في ChatComposer — هذا المكوّن لا يُرى.
 * — RTL: positions are viewport-pixel coordinates (not CSS logical), same
 *   pattern as ThinkingModeSelector. Tailwind classes use logical utilities.
 */

import {
  Fragment,
  useState,
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { engineProviderLabel } from '../../../../../shared/engineProviders';
import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import { useUnifiedKeysEnabled } from '../../../provider-auth/hooks/useLinkMode';
import { useVendorKeyStatuses } from '../../../provider-auth/hooks/useVendorKeyStatuses';
import type { EngineProvider } from '../../hooks/engineProviderSession';
import { LOCAL_ENGINE } from '../../../../../shared/localEngine';
import { usePaletteOps } from '../../../../contexts/PaletteOpsContext';
import { useLocalOverlay } from '../../hooks/useLocalOverlay';

import { engineModelLabel, resolveEffectiveEngine } from './engineGuard';
import { rowsForBody, type PickerRow } from './modelPickerRows';
import {
  isLocalBody,
  isLocalChat,
  localCellOpen,
  localChatServer,
  localModelLabel,
  localPickerBlocks,
  type LocalChatContext,
} from './localOverlayRows';
import { localBlockHeading, localBlockText, localServerText } from './localModelText';

/** نتيجة مكتملة بعد اختيار نموذج أو مسح تثبيت. */
type SwitcherResult =
  | { kind: 'select'; scope: 'session' | 'default'; model: string }
  | { kind: 'clear'; model: string };

interface InlineModelSwitcherProps {
  /** مزوّد الجلسة المفتوحة (displayProvider من ChatComposer). */
  provider: string;
  /** النموذج الفعّال حالياً لهذه الجلسة. */
  currentModel: string;
  /** كتالوج النماذج الكامل. */
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  /**
   * يُستدعى عند اختيار نموذج، ومعه **محرّك ذلك الصفّ** (B-352): `null` للمسار
   * الرسمي، معرّف مورّد لصفّ محرّك. المستدعي يثبّت المحورين معاً أو لا يثبّت
   * أيّهما.
   * يُعيد النطاق الفعلي (session/default) والنموذج المؤكَّد من الخادم.
   * B-251: القيمة العائدة هي مصدر الحقيقة للتأكيد — لا تخمين عميلي.
   */
  onSelect: (
    model: string,
    engine: EngineProvider,
  ) => Promise<{ scope: 'session' | 'default'; model: string }>;
  /** صحيح أثناء البث — يُعطَّل زرّ التبديل لتجنّب تعارض الحالة. */
  disabled?: boolean;
  className?: string;
  /**
   * معرّف الجلسة الحالية — يحدّد نطاق التبديل قبل الاختيار. B-251
   * - موجود → «هذه المحادثة فقط»
   * - null/undefined → «افتراضي لكل محادثة جديدة»
   */
  sessionId?: string | null | undefined;
  /**
   * صحيح حين تملك الجلسة تثبيتاً صريحاً للنموذج (changed===true في GET). B-252
   * يُظهِر خيار «اتبع الافتراضي الحالي» في أسفل القائمة.
   */
  sessionModelChanged?: boolean;
  /**
   * يُستدعى لمسح تثبيت النموذج (DELETE endpoint). B-252
   * يُعيد النموذج الذي سيسري بعد المسح.
   */
  onClearSessionModel?: () => Promise<{ model: string }>;
  /**
   * مفاتيح PickerRow المفضّلة للمستخدم الحالي. عند توفّرها تُعرض أولاً في
   * القائمة. تعديل غير بنيوي: الغياب (undefined / []) يُبقي الترتيب الحالي.
   */
  favorites?: string[];
  /**
   * B-ENG: ختم محرّك الجلسة المفتوحة (ADR-037). غير null يعني أن جسد Claude
   * موجَّه إلى نقطة مورّد. null/undefined = المسار الرسمي العادي.
   * B-352: يُستعمل لتحديد الصفّ المُحدَّد ولعرض المحرّك العامل — لا للتعطيل.
   */
  engineProvider?: string | null | undefined;
}

/** يختصر المعرّف لعرض نصيّ مضغوط: يزيل البادئة قبل `/` ويقطع عند 18 حرفاً. */
function abbreviateModel(model: string): string {
  if (!model) return '—';
  const slug = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return slug.length > 18 ? `${slug.slice(0, 16)}…` : slug;
}


export default function InlineModelSwitcher({
  provider,
  currentModel,
  catalog,
  onSelect,
  disabled = false,
  className = '',
  sessionId,
  sessionModelChanged = false,
  onClearSessionModel,
  favorites,
  engineProvider = null,
}: InlineModelSwitcherProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [lastResult, setLastResult] = useState<SwitcherResult | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);

  // B-352: محور المحرّك صار معروضاً — لكن فقط ما هو **قابل للتشغيل الآن**.
  // المفاتيح تُستعلَم على جسد claude (هو الوحيد الذي يقبل محرّكاً، ADR-073 §4)
  // وعلى جسد opencode (يبوّب `qwen-plan/*` خلف مفتاح Alibaba Coding Plan، قرار
  // المالك 2026-09-28) — فلا طلبات شبكة زائدة على بقية المزوّدات.
  const isClaudeBody = provider === 'claude';
  const needsVendorKeyStatuses = isClaudeBody || provider === 'opencode';
  const { statuses: vendorKeyStatuses } = useVendorKeyStatuses(needsVendorKeyStatuses);
  // ADR-200 S9: unlinked vendor cells are absent from the list in the unified mode.
  const hideUnlinked = useUnifiedKeysEnabled();

  // B-251: هل يوجد sessionId؟ يحدّد نطاق التبديل قبل الاختيار.
  const hasSession = typeof sessionId === 'string' && sessionId.trim().length > 0;

  // ADR-227: محادثة على خادم محلي تُعرف بختمها أو بمعرّف نموذجها المحلي — فلا
  // يُستنبَط محرّكها من الكتالوج (لا كتالوج للنماذج المحلية) ولا يغيب بغياب الختم.
  const localCtx: LocalChatContext = {
    isNewChat: !hasSession,
    chatEngine: engineProvider ?? null,
    chatModel: currentModel,
  };
  // T-2107: Claude and Codex run on local servers; the overlay is read only while
  // the body × local matrix cell is open (a closed cell is hidden, not greyed).
  const localBody = isLocalBody(provider) && localCellOpen(provider) ? provider : null;
  const chatIsLocal = localBody !== null && isLocalChat(localCtx);
  const localOverlay = useLocalOverlay(localBody ?? 'claude', localBody !== null && (isOpen || chatIsLocal));
  const localBlocks = localBody ? localPickerBlocks(localBody, localOverlay ?? [], localCtx, true) : [];
  const localRows = localBlocks.flatMap((block) => block.rows);
  const { openSettings } = usePaletteOps();

  // صفّ locked = محرّك بلا مفتاح مخزَّن: يبقى مخفياً هنا (مساره الإعدادات، لا
  // مبدّل وسط المحادثة). وصفّ بلا model لا يُرسَل أصلاً. وجود تعريف كتالوج لا
  // يثبت وجود المفتاح: الكتالوج قد يكون مضمّناً أو مستعاداً من cache، لذلك لا
  // تفتح البوابة إلا نتيجة نقطة حالة الاعتماد الصريحة.
  const baseRows = rowsForBody(
    provider as LLMProvider,
    catalog,
    needsVendorKeyStatuses ? vendorKeyStatuses : {},
    undefined,
    { hideUnlinked },
  ).filter((row) => !row.locked && row.model);

  // إن وُفِّرت قائمة مفضّلة، تُرتَّب صفوفها أولاً (تعديل غير بنيوي — B-Fav).
  // الصفوف المفضّلة تُقدَّم أولاً بنفس ترتيب الإضافة (FIFO)، ثم ما تبقّى.
  // ADR-227: محادثة محلية لا تنتقل إلى Anthropic ولا إلى مورّد — صفوفها المحلية وحدها.
  const switchableRows = chatIsLocal ? [] : baseRows;
  const rows = favorites && favorites.length > 0
    ? [
        ...switchableRows.filter((r) => favorites.includes(r.key)),
        ...switchableRows.filter((r) => !favorites.includes(r.key)),
      ]
    : switchableRows;

  // B-ENG + B-311: المحرّك العامل فعلاً — الختم العميلي إن وُجد، وإلا مستنبَطاً
  // من النموذج الفعّال. منطقه المشترك مع لوحة /models في engineGuard.ts.
  const effectiveEngine = chatIsLocal
    ? LOCAL_ENGINE
    : resolveEffectiveEngine(engineProvider, provider, currentModel, catalog);

  // الصفّ الجاري = تطابق النموذج **والمحرّك** معاً. المطابقة على النموذج وحده
  // كانت تكفي حين كان المعروض محوراً واحداً؛ الآن قد يظهر المعرّف نفسه تحت
  // محرّكين، فتختار المطابقة الفضفاضة أوّلهما وتضع علامة الاختيار على صفّ لا
  // يعمل عليه المستخدم.
  const currentRow = rows.find(
    (r) => r.model === currentModel && (r.engineProvider ?? null) === effectiveEngine,
  ) ?? rows.find((r) => r.model === currentModel);
  // اسم النموذج المعروض: من كتالوج المحرّك حين تكون الجلسة محرَّكة، فصفوف
  // المحرّك مُرشَّحة من `rows` فلا يجدها currentRow ويظهر المعرّف خاماً (ADR-073 §6).
  const engineRowLabel =
    effectiveEngine === LOCAL_ENGINE
      ? localModelLabel(localOverlay ?? [], currentModel) ?? currentModel.slice(currentModel.indexOf('/') + 1)
      : effectiveEngine && !currentRow
        ? engineModelLabel(catalog, effectiveEngine, currentModel)
        : undefined;
  const displayLabel = abbreviateModel(currentRow?.label || engineRowLabel || currentModel);

  // B-252: إظهار خيار المسح فقط حين جلسة قائمة + تثبيت موجود + callback متاح.
  const showClearOption = hasSession && sessionModelChanged && typeof onClearSessionModel === 'function' && !lastResult;

  /** يُغلق القائمة ويُعيد ضبط حالة التأكيد. */
  const closeDropdown = useCallback(() => {
    if (confirmTimeoutRef.current !== null) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setIsOpen(false);
    setLastResult(null);
  }, []);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const dropdown = dropdownRef.current;
    if (!trigger || !dropdown || typeof window === 'undefined') return;

    const isRTL =
      typeof document !== 'undefined'
        ? document.documentElement.dir === 'rtl' ||
          document.documentElement.getAttribute('dir') === 'rtl' ||
          document.body.dir === 'rtl'
        : false;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = window.innerWidth < 640 ? 12 : 16;
    const spacing = 8;
    const width = Math.min(window.innerWidth - viewportPadding * 2, window.innerWidth < 640 ? 260 : 288);

    const centred = triggerRect.left + triggerRect.width / 2 - width / 2;
    const measuredHeight = dropdown.offsetHeight || 0;
    const spaceBelow = window.innerHeight - triggerRect.bottom - spacing - viewportPadding;
    const spaceAbove = triggerRect.top - spacing - viewportPadding;
    const openBelow = spaceBelow >= Math.min(measuredHeight || 240, 240) || spaceBelow >= spaceAbove;
    const availableHeight = Math.min(
      window.innerHeight - viewportPadding * 2,
      Math.max(120, openBelow ? spaceBelow : spaceAbove),
    );
    const panelHeight = Math.min(measuredHeight || availableHeight, availableHeight);
    const top = openBelow
      ? Math.min(triggerRect.bottom + spacing, window.innerHeight - viewportPadding - panelHeight)
      : Math.max(viewportPadding, triggerRect.top - spacing - panelHeight);

    // design-ok: `right`/`left` here are raw viewport pixel coordinates (not CSS
    // physical properties), mirroring the ThinkingModeSelector positioning pattern.
    if (isRTL) {
      const rightEdge = window.innerWidth - (centred + width);
      const clampedRight = Math.max(viewportPadding, Math.min(rightEdge, window.innerWidth - width - viewportPadding));
      setDropdownStyle({ position: 'fixed', top, right: clampedRight, width, maxHeight: availableHeight, zIndex: 80 });
    } else {
      const clampedLeft = Math.max(viewportPadding, Math.min(centred, window.innerWidth - width - viewportPadding));
      setDropdownStyle({ position: 'fixed', top, left: clampedLeft, width, maxHeight: availableHeight, zIndex: 80 });
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setDropdownStyle(null);
      return;
    }
    const rafId = window.requestAnimationFrame(updateDropdownPosition);
    const handleViewportChange = () => updateDropdownPosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      closeDropdown();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDropdown();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, closeDropdown]);

  /**
   * ينتظر ردّ الخادم قبل إغلاق القائمة، ثم يعرض التأكيد 1.4 ثانية. B-251
   */
  const handleSelectModel = useCallback(async (row: PickerRow) => {
    if (isSwitching || isClearing) return;
    const model = row.model;
    const engine = (row.engineProvider ?? null) as EngineProvider;
    // «لا تغيير» = نفس النموذج على نفس المحرّك. النموذج وحده لا يكفي: الانتقال
    // بين محرّكين يحملان المعرّف نفسه تغييرٌ حقيقي في وجهة الدور التالي.
    if (model === currentModel && engine === effectiveEngine) {
      closeDropdown();
      return;
    }
    setIsSwitching(true);
    try {
      // T-1021/6be3c7ab: قيمة الكتالوج تُمرَّر حرفياً — لا تشذيب ولا اشتقاق.
      // Only the Claude body has an engine axis; a Codex local row starts its local
      // chat by the local model id alone (T-2107), so it sends no engine stamp.
      const result = await onSelect(model, isClaudeBody ? engine : null);
      setLastResult({ kind: 'select', scope: result.scope, model: result.model });
      // إغلاق تلقائي بعد إظهار التأكيد
      confirmTimeoutRef.current = window.setTimeout(() => {
        confirmTimeoutRef.current = null;
        setIsOpen(false);
        setLastResult(null);
      }, 1400);
    } catch {
      // فشل POST → إغلاق فوري بلا تأكيد
      closeDropdown();
    } finally {
      setIsSwitching(false);
    }
  }, [isSwitching, isClearing, currentModel, effectiveEngine, onSelect, closeDropdown, isClaudeBody]);

  /**
   * يمسح تثبيت النموذج (DELETE) ويعرض النموذج الجديد السائر. B-252
   */
  const handleClear = useCallback(async () => {
    if (isSwitching || isClearing || !onClearSessionModel) return;
    setIsClearing(true);
    try {
      const result = await onClearSessionModel();
      setLastResult({ kind: 'clear', model: result.model });
      confirmTimeoutRef.current = window.setTimeout(() => {
        confirmTimeoutRef.current = null;
        setIsOpen(false);
        setLastResult(null);
      }, 1400);
    } catch {
      closeDropdown();
    } finally {
      setIsClearing(false);
    }
  }, [isSwitching, isClearing, onClearSessionModel, closeDropdown]);

  // B-352: المحرّك لم يعد سبب تعطيل. يبقى التعطيل لأسبابه الحقيقية وحدها:
  // بثٌّ جارٍ، عملية تبديل/مسح قائمة، أو لا صفوف أصلاً.
  const isDisabled = disabled || isSwitching || isClearing || (rows.length === 0 && localRows.length === 0);
  // اسم المحرّك العامل — يُعرض في رأس القائمة وفي التلميح ليعرف المستخدم أين هو.
  // المحلي باسم خادمه لا بمعرّف التثبيت الخام (ADR-227).
  const localServer = chatIsLocal && localOverlay !== null ? localChatServer(localOverlay, localCtx) : null;
  const activeEngineName = effectiveEngine === LOCAL_ENGINE
    ? (localServer ? localServerText(t, localServer) : t('localModels.engineShort', { defaultValue: 'Local' }))
    : effectiveEngine ? engineProviderLabel(effectiveEngine) : null;

  return (
    <div className={cn('relative', className)} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isDisabled) return;
          if (isOpen) { closeDropdown(); return; }
          setIsOpen(true);
        }}
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('inlineModelSwitcher.ariaLabel', { model: currentModel })}
        title={
          isSwitching
            ? t('inlineModelSwitcher.switching')
            : isClearing
              ? t('inlineModelSwitcher.clearing')
              : rows.length === 0 && localRows.length === 0
                ? t('inlineModelSwitcher.noModels')
                : activeEngineName
                  // ADR-073 §6: الاسم من مصدر واحد — لا يُبنى من معرّف السلك.
                  ? t('inlineModelSwitcher.engineRunning', {
                      engine: activeEngineName,
                      defaultValue: 'Running on {{engine}} — click to switch',
                    })
                  : t('inlineModelSwitcher.tooltip')
        }
        className={cn(
          'flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          isDisabled
            ? 'cursor-not-allowed text-muted-foreground/40'
            : isOpen
              ? 'bg-muted/65 text-foreground'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
        )}
      >
        {/* design-ok: أسماء النماذج نصوص لاتينية دائماً — dir="ltr" صحيح هنا. */}
        <span className="hidden max-w-40 truncate sm:inline" dir="ltr">
          {isSwitching
            ? t('inlineModelSwitcher.switching')
            : isClearing
              ? t('inlineModelSwitcher.clearing')
              : displayLabel}
        </span>
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 transition-transform duration-200',
            isOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          dir="ltr"
          style={dropdownStyle || { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}
          className="flex animate-menu-enter flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
          role="listbox"
          aria-label={t('inlineModelSwitcher.label')}
        >
          {/* رأس القائمة — يتبدّل بين: شارة النطاق (قبل) وتأكيد النتيجة (بعد) */}
          <div
            className={cn(
              'border-b border-border px-3 py-2 transition-colors duration-200',
              lastResult && 'bg-primary/[0.06]',
            )}
          >
            {lastResult ? (
              /* B-251 تأكيد ما بعد الاختيار/المسح — scope حقيقي من الخادم */
              <div className="flex items-center gap-1.5">
                <Check
                  className="h-3.5 w-3.5 shrink-0 text-green-500"
                  aria-hidden="true"
                />
                <span
                  className="text-[11px] font-medium text-foreground/80"
                  dir="auto"
                >
                  {lastResult.kind === 'select'
                    ? lastResult.scope === 'session'
                      ? t('inlineModelSwitcher.confirmedSession', { model: lastResult.model })
                      : t('inlineModelSwitcher.confirmedDefault', { model: lastResult.model })
                    : t('inlineModelSwitcher.clearedNotice', { model: lastResult.model })}
                </span>
              </div>
            ) : (
              /* B-251 شارة النطاق قبل الاختيار */
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/70">
                  {/* B-352: حين تعمل الجلسة على محرّك، الرأس يقول أين هي —
                      المعلومة التي كانت تُقدَّم سابقاً كسببِ تعطيل. */}
                  {activeEngineName
                    ? t('inlineModelSwitcher.engineRunningShort', {
                        engine: activeEngineName,
                        defaultValue: 'On {{engine}}',
                      })
                    : t('inlineModelSwitcher.label')}
                </span>
                <span
                  dir="auto"
                  className={cn(
                    'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
                    hasSession
                      ? 'bg-primary/10 text-primary'
                      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                  )}
                >
                  {hasSession
                    ? t('inlineModelSwitcher.scopeSession')
                    : t('inlineModelSwitcher.scopeDefault')}
                </span>
              </div>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto p-1">
            {rows.length === 0 && localRows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t('inlineModelSwitcher.noModels')}
              </p>
            ) : (
              rows.map((row, index) => {
                const rowEngine = (row.engineProvider ?? null) as EngineProvider;
                const isSelected = row.model === currentModel && rowEngine === effectiveEngine;
                // B-352: عنوان مجموعة عند كل تغيّر محرّك، فيرى المستخدم أن
                // السطر التالي يذهب إلى نقطة أخرى — الفرق الحقيقي بين صفّين
                // يحملان أحياناً معرّفاً متشابهاً.
                const prevEngine = index > 0
                  ? ((rows[index - 1].engineProvider ?? null) as EngineProvider)
                  : undefined;
                const startsGroup = index === 0 || prevEngine !== rowEngine;
                return (
                  /* Fragment, not a wrapper element: role="option" must stay a
                     direct child of the role="listbox" container. */
                  <Fragment key={row.key}>
                  {startsGroup && (
                    <div
                      role="presentation"
                      className={cn(
                        'px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70',
                        index === 0 && 'pt-1',
                      )}
                    >
                      {rowEngine
                        ? engineProviderLabel(rowEngine)
                        : t('inlineModelSwitcher.officialEngine', { defaultValue: 'Anthropic' })}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={isSwitching || isClearing}
                    onClick={() => void handleSelectModel(row)}
                    className={cn(
                      'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none',
                      'transition-colors duration-150 motion-reduce:transition-none',
                      'hover:bg-accent hover:text-accent-foreground',
                      'focus-visible:bg-accent focus-visible:text-accent-foreground',
                      'disabled:pointer-events-none disabled:opacity-50',
                      isSelected && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <div className="min-w-0 flex-1 text-start">
                      <div className="truncate text-sm font-medium leading-none">
                        {row.label || row.model}
                      </div>
                      {row.description && (
                        <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                          {row.description}
                        </div>
                      )}
                    </div>
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-primary transition-opacity duration-150',
                        isSelected ? 'opacity-100' : 'opacity-0',
                      )}
                      aria-hidden="true"
                    />
                  </button>
                  </Fragment>
                );
              })
            )}

            {localBlocks.map((block) => (
              <Fragment key={block.providerId}>
                <div
                  role="presentation"
                  dir="auto"
                  className="px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-wider text-muted-foreground/70"
                >
                  {localBlockHeading(t, block.serverLabel)}
                </div>
                {block.rows.map((row) => {
                  const isSelected = row.model === currentModel && effectiveEngine === LOCAL_ENGINE;
                  const reason = row.blocked ? localBlockText(t, { ...row, blocked: row.blocked }) : null;
                  return (
                    <div key={row.key} className="flex items-center gap-1" data-local-blocked={row.blocked ?? undefined}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={row.blocked !== null}
                        disabled={row.blocked !== null || isSwitching || isClearing}
                        onClick={() => void handleSelectModel(row)}
                        className={cn(
                          'relative flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none',
                          'transition-colors duration-150 motion-reduce:transition-none',
                          'hover:bg-accent hover:text-accent-foreground',
                          'focus-visible:bg-accent focus-visible:text-accent-foreground',
                          'disabled:pointer-events-none disabled:opacity-60',
                          isSelected && 'bg-accent text-accent-foreground',
                        )}
                      >
                        <div className="min-w-0 flex-1 text-start">
                          <div className="truncate text-sm font-medium leading-none">{row.label}</div>
                          {reason && (
                            <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground" dir="auto">
                              {reason}
                            </div>
                          )}
                        </div>
                        <Check
                          className={cn('h-3.5 w-3.5 shrink-0 text-primary', isSelected ? 'opacity-100' : 'opacity-0')}
                          aria-hidden="true"
                        />
                      </button>
                      {row.fixInSettings && (
                        <button
                          type="button"
                          onClick={() => {
                            closeDropdown();
                            openSettings('agents', { tab: 'agents', localModels: true });
                          }}
                          aria-label={t('localModels.openSettings', { defaultValue: 'Server settings' })}
                          title={t('localModels.openSettings', { defaultValue: 'Server settings' })}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        >
                          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))}

            {/* B-252 خيار «اتبع الافتراضي الحالي» — جلسة قائمة + تثبيت موجود */}
            {showClearOption && (
              <>
                <div className="mx-2 my-1 border-t border-border/40" aria-hidden="true" />
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={isClearing || isSwitching}
                  onClick={() => void handleClear()}
                  className={cn(
                    'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none',
                    'transition-colors duration-150 motion-reduce:transition-none',
                    'hover:bg-accent hover:text-accent-foreground',
                    'focus-visible:bg-accent focus-visible:text-accent-foreground',
                    'disabled:pointer-events-none disabled:opacity-50',
                  )}
                >
                  <div className="min-w-0 flex-1 text-start" dir="auto">
                    <div className="text-sm font-medium leading-none text-muted-foreground">
                      {isClearing
                        ? t('inlineModelSwitcher.clearing')
                        : t('inlineModelSwitcher.followDefault')}
                    </div>
                  </div>
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

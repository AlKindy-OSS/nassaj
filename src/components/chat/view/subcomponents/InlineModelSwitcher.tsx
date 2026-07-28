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
 * القيود الصارمة:
 * — محور المحرّك (engineProvider !== null) مستثنى تماماً (B-246/T-1027).
 * — معرّف opencode المؤهَّل (glm/glm-5.2) يُمرَّر حرفياً بلا تشذيب (T-1021).
 * — المزوّدات التي لا تدعم التبديل (hermes/antigravity/…) تُخفى عبر
 *   capabilities.modelSwitch.supported في ChatComposer — هذا المكوّن لا يُرى.
 * — RTL: positions are viewport-pixel coordinates (not CSS logical), same
 *   pattern as ThinkingModeSelector. Tailwind classes use logical utilities.
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import { rowsForBody } from './modelPickerRows';

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
   * يُستدعى عند اختيار نموذج.
   * يُعيد النطاق الفعلي (session/default) والنموذج المؤكَّد من الخادم.
   * B-251: القيمة العائدة هي مصدر الحقيقة للتأكيد — لا تخمين عميلي.
   */
  onSelect: (model: string) => Promise<{ scope: 'session' | 'default'; model: string }>;
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
   * موجَّه إلى نقطة مورّد — نماذج Claude الرسمية لا تنطبق، فيُعطَّل المبدّل
   * كلياً مع سبب مرئي للمستخدم. null/undefined = المسار الرسمي العادي.
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

  // T-1028 / B-246: فلترة صفوف المحرّك (engineProvider !== null) — محور المحرّك
  // مستثنى تماماً، لا تعرض ولا تسمح بتبديل «Claude engine on GLM/Kimi».
  const baseRows = rowsForBody(
    provider as LLMProvider,
    catalog,
    {}, // keyStatuses = {} — محافظ: كل صفوف المحرّك المحتملة ستُصنَّف locked ثم تُرشَّح
  ).filter((row) => row.engineProvider === null && !row.locked && row.model);

  // إن وُفِّرت قائمة مفضّلة، تُرتَّب صفوفها أولاً (تعديل غير بنيوي — B-Fav).
  // الصفوف المفضّلة تُقدَّم أولاً بنفس ترتيب الإضافة (FIFO)، ثم ما تبقّى.
  const rows = favorites && favorites.length > 0
    ? [
        ...baseRows.filter((r) => favorites.includes(r.key)),
        ...baseRows.filter((r) => !favorites.includes(r.key)),
      ]
    : baseRows;

  const currentRow = rows.find((r) => r.model === currentModel);
  const displayLabel = currentRow?.label
    ? abbreviateModel(currentRow.label)
    : abbreviateModel(currentModel);

  // B-251: هل يوجد sessionId؟ يحدّد نطاق التبديل قبل الاختيار.
  const hasSession = typeof sessionId === 'string' && sessionId.trim().length > 0;

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

  // B-ENG: إن ظهر ختم محرّك (تغيّر الجلسة) والقائمة مفتوحة — أغلقها فوراً
  // حتى لا تبقى نماذج Claude الرسمية معروضة لجلسة موجَّهة إلى مورّد.
  useEffect(() => {
    if (engineProvider) closeDropdown();
  }, [engineProvider, closeDropdown]);

  /**
   * ينتظر ردّ الخادم قبل إغلاق القائمة، ثم يعرض التأكيد 1.4 ثانية. B-251
   */
  const handleSelectModel = useCallback(async (model: string) => {
    if (isSwitching || isClearing) return;
    if (model === currentModel) {
      closeDropdown();
      return;
    }
    setIsSwitching(true);
    try {
      // T-1021/6be3c7ab: قيمة الكتالوج تُمرَّر حرفياً — لا تشذيب ولا اشتقاق.
      const result = await onSelect(model);
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
  }, [isSwitching, isClearing, currentModel, onSelect, closeDropdown]);

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

  // B-ENG: ختم المحرّك يُعطِّل المبدّل كلياً — نماذج Claude الرسمية لا تنطبق.
  const isEngineStamped = typeof engineProvider === 'string' && engineProvider.length > 0;
  const isDisabled = disabled || isSwitching || isClearing || rows.length === 0 || isEngineStamped;

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
          isEngineStamped
            ? t('inlineModelSwitcher.engineStamped', { engine: engineProvider as string })
            : isSwitching
              ? t('inlineModelSwitcher.switching')
              : isClearing
                ? t('inlineModelSwitcher.clearing')
                : rows.length === 0
                  ? t('inlineModelSwitcher.noModels')
                  : t('inlineModelSwitcher.tooltip')
        }
        className={cn(
          'flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-medium transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          isDisabled
            ? 'cursor-not-allowed border-border/30 bg-muted/30 text-muted-foreground/40'
            : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        {/* design-ok: أسماء النماذج نصوص لاتينية دائماً — dir="ltr" صحيح هنا. */}
        <span className="hidden max-w-[10rem] truncate sm:inline" dir="ltr">
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
          className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
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
                  {t('inlineModelSwitcher.label')}
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
            {rows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t('inlineModelSwitcher.noModels')}
              </p>
            ) : (
              rows.map((row) => {
                const isSelected = row.model === currentModel;
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={isSwitching || isClearing}
                    onClick={() => void handleSelectModel(row.model)}
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
                );
              })
            )}

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

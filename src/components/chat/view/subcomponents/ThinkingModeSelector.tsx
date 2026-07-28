import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_EFFORT_MODE, effortModes, type EffortMode } from '../../constants/thinkingModes';
import { cn } from '../../../../lib/utils';

type ThinkingModeSelectorProps = {
  selectedMode: string;
  onModeChange: (modeId: string) => void;
  onClose?: () => void;
  className?: string;
  /**
   * مجموعة فرعية اختيارية من effortModes (T-905، مثلاً كودكس بلا max/ultracode
   * — لا مقابل لهما في codex ModelReasoningEffort). الغياب = القائمة الكاملة،
   * فسلوك claude يبقى حرفياً كما كان قبل T-905.
   */
  modes?: EffortMode[];
};

function ThinkingModeSelector({
  selectedMode,
  onModeChange,
  onClose,
  className = '',
  modes = effortModes,
}: ThinkingModeSelectorProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);

  const translatedModes = modes.map(mode => ({
    ...mode,
    displayName: t(`effortMode.modes.${mode.id}.name`, { defaultValue: mode.name }),
    displayDescription: t(`effortMode.modes.${mode.id}.description`, { defaultValue: '' }),
  }));

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const dropdown = dropdownRef.current;
    if (!trigger || !dropdown || typeof window === 'undefined') {
      return;
    }

    const isRTL =
      typeof document !== 'undefined'
        ? document.documentElement.dir === 'rtl' ||
          document.documentElement.getAttribute('dir') === 'rtl' ||
          document.body.dir === 'rtl'
        : false;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = window.innerWidth < 640 ? 12 : 16;
    const spacing = 8;
    const width = Math.min(window.innerWidth - viewportPadding * 2, window.innerWidth < 640 ? 300 : 312);

    // Centre the panel on the trigger button, then clamp to viewport.
    const centred = triggerRect.left + triggerRect.width / 2 - width / 2;

    const measuredHeight = dropdown.offsetHeight || 0;
    const spaceBelow = window.innerHeight - triggerRect.bottom - spacing - viewportPadding;
    const spaceAbove = triggerRect.top - spacing - viewportPadding;
    const openBelow = spaceBelow >= Math.min(measuredHeight || 320, 320) || spaceBelow >= spaceAbove;
    const availableHeight = Math.min(
      window.innerHeight - viewportPadding * 2,
      Math.max(180, openBelow ? spaceBelow : spaceAbove),
    );
    const panelHeight = Math.min(measuredHeight || availableHeight, availableHeight);
    const top = openBelow
      ? Math.min(triggerRect.bottom + spacing, window.innerHeight - viewportPadding - panelHeight)
      : Math.max(viewportPadding, triggerRect.top - spacing - panelHeight);

    if (isRTL) {
      // In RTL anchor with `right` so the panel expands leftward naturally and never overflows
      // the inline-start (visual right) edge of the viewport.
      // design-ok: إحداثيات portal محسوبة بالبكسل داخل جزيرة dir="ltr" (انظر
      // العنصر أدناه). الخصائص المنطقية هنا تُضبط left وright معاً عبر
      // tailwindcss-rtl فيتمدّد العنصر ويقع في الجهة الخطأ — الفيزيائي مقصود.
      const rightEdge = window.innerWidth - (centred + width);
      const clampedRight = Math.max(viewportPadding, Math.min(rightEdge, window.innerWidth - width - viewportPadding));
      setDropdownStyle({
        position: 'fixed',
        top,
        right: clampedRight,
        width,
        maxHeight: availableHeight,
        zIndex: 80,
      });
    } else {
      const clampedLeft = Math.max(viewportPadding, Math.min(centred, window.innerWidth - width - viewportPadding));
      setDropdownStyle({
        position: 'fixed',
        top,
        left: clampedLeft,
        width,
        maxHeight: availableHeight,
        zIndex: 80,
      });
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
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) {
        return;
      }

      closeDropdown();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDropdown();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, closeDropdown]);

  const currentMode = translatedModes.find(mode => mode.id === selectedMode) || translatedModes[0];
  const IconComponent = currentMode.icon || Minus;
  const isUltracode = selectedMode === 'ultracode';
  const isMaxOrXhigh = selectedMode === 'max' || selectedMode === 'xhigh';

  const triggerBg = isUltracode
    ? 'bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900'
    : isMaxOrXhigh
      ? 'bg-orange-50 hover:bg-orange-100 dark:bg-orange-950 dark:hover:bg-orange-900'
      : selectedMode === 'none'
        ? 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600'
        : 'bg-blue-50 hover:bg-blue-100 dark:bg-blue-950 dark:hover:bg-blue-900';

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {/* Ultracode glow ring — respects prefers-reduced-motion */}
      {isUltracode && (
        <span
          className="pointer-events-none absolute inset-0 rounded-full ultracode-ring"
          aria-hidden="true"
        />
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) {
            closeDropdown();
            return;
          }
          setIsOpen(true);
        }}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-200 sm:h-8 sm:w-8 ${triggerBg}`}
        title={t('effortMode.buttonTitle', { mode: currentMode.displayName })}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('effortMode.buttonTitle', { mode: currentMode.displayName })}
      >
        <IconComponent className={`h-4 w-4 ${currentMode.color}`} />
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          dir="ltr"
          // design-ok: قياس أوّلي مخفيّ داخل نفس جزيرة dir="ltr" — فيزيائي مقصود
          style={dropdownStyle || { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}
          className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
          role="listbox"
          aria-label={t('effortMode.selector.title')}
        >
          {/* Header */}
          <div className="border-b border-border px-3 py-2.5">
            {/* بلا tracking: العنوان مترجَم، والتباعد الحرفي يكسر التحام العربية */}
            <span className="text-[11px] font-semibold uppercase text-foreground/70">
              {t('effortMode.selector.title')}
            </span>
          </div>

          <div className="min-h-0 overflow-y-auto p-1.5">
            {translatedModes.map((mode) => {
              const ModeIcon = mode.icon;
              const isSelected = mode.id === selectedMode;
              const isUC = mode.id === 'ultracode';

              // Logical separators: after 'none' (start of active tiers) and after
              // 'max' (start of the special/dangerous tier). Id-based (not index-based)
              // so a filtered `modes` subset (T-905, e.g. codex without max/ultracode)
              // degrades gracefully — the 'ultracode' separator simply never renders
              // when 'ultracode' itself is absent from the list.
              const showSeparatorBefore = mode.id === 'low' || mode.id === 'ultracode';

              return (
                <div key={mode.id}>
                  {showSeparatorBefore && (
                    <div className="my-1 h-px bg-border/60" role="separator" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onModeChange(mode.id);
                      closeDropdown();
                    }}
                    className={cn(
                      'relative flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none',
                      'transition-colors duration-150 motion-reduce:transition-none',
                      'hover:bg-accent hover:text-accent-foreground',
                      'focus-visible:bg-accent focus-visible:text-accent-foreground',
                      isSelected && 'bg-accent text-accent-foreground',
                    )}
                  >
                    {/* Mode icon — wrapped in a soft rounded container */}
                    <span className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      isSelected ? 'bg-background/60' : 'bg-muted',
                      mode.icon ? mode.color : 'text-muted-foreground',
                    )}>
                      {ModeIcon ? <ModeIcon className="h-3.5 w-3.5" /> : <div className="h-3.5 w-3.5" />}
                    </span>

                    {/* Name + description */}
                    <div className="min-w-0 flex-1 text-start">
                      <div className="flex items-center gap-1.5 leading-none">
                        <span className={cn(
                          'text-sm font-semibold',
                          isSelected ? 'text-foreground' : 'text-foreground/85',
                        )}>
                          {mode.displayName}
                        </span>
                        {mode.id === DEFAULT_EFFORT_MODE && (
                          <span className="shrink-0 rounded border border-blue-300/50 bg-blue-50/60 px-1 py-px text-[9px] font-semibold text-blue-500 dark:border-blue-700/40 dark:bg-blue-900/20 dark:text-blue-400">
                            default
                          </span>
                        )}
                        {/* Ultracode badge — always visible, subtle when inactive.
                            design-ok: tracking على نصّ لاتيني ثابت («UC») لا يُترجَم،
                            فلا يمسّ التحام حروف العربية. */}
                        {isUC && (
                          <span className={cn(
                            'shrink-0 rounded border px-1 py-px text-[9px] font-bold tracking-wider',
                            isSelected
                              ? 'border-red-400/60 bg-red-500/10 text-red-500 dark:border-red-500/50 dark:text-red-400 shadow-[0_0_6px_rgba(239,68,68,0.3)]'
                              : 'border-red-300/40 bg-transparent text-red-400/70 dark:border-red-700/40 dark:text-red-500/60',
                          )}>
                            UC
                          </span>
                        )}
                      </div>
                      {mode.displayDescription ? (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                          {mode.displayDescription}
                        </span>
                      ) : null}
                    </div>

                    {/* Check for selected */}
                    <Check className={cn(
                      'h-3.5 w-3.5 shrink-0 text-primary transition-opacity duration-150 motion-reduce:transition-none',
                      isSelected ? 'opacity-100' : 'opacity-0',
                    )} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default ThinkingModeSelector;

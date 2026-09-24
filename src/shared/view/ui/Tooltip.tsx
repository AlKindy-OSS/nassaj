import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../../lib/utils';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

type TooltipProps = {
  children: ReactNode;
  content?: ReactNode;
  position?: TooltipPosition;
  className?: string;
  /**
   * Extra classes for the trigger's own wrapper div (default `relative
   * inline-block`). Needed when the trigger sits inside a `pointer-events-none`
   * ancestor (e.g. an overlaid row) and must opt back into hover/tap, or when
   * it must participate in a flex/grid layout (e.g. `min-w-0` for a truncating
   * flex child) that the default `inline-block` wrapper would otherwise break.
   */
  wrapperClassName?: string;
  delay?: number;
  /**
   * When true, a short touch tap toggles the tooltip instead of requiring a
   * long-press. Desktop hover behaviour is preserved. Use this for elements
   * that are not otherwise interactive on touch (e.g. informational badges).
   */
  tapToToggle?: boolean;
  /**
   * When true, allows text content to wrap and constrains the tooltip to a
   * maximum width. Removes the default `whitespace-nowrap` restriction so that
   * multi-line ReactNode content renders with real line breaks.
   */
  multiline?: boolean;
  /** Makes a non-interactive informational trigger reachable by keyboard. */
  keyboard?: boolean;
  /** Keep the card open while its content is being hovered. */
  interactive?: boolean;
};

// السطح المقلوب `foreground/background` يتبع الثيم المختار (بما فيه أطقم
// العلامة)، بخلاف `gray-900/gray-100` الذي يبقى أسود فحمياً فوق سطح كريمي.
// design-ok: موضع السهم هندسي لا اتجاهي — `position` هنا جهة فيزيائية يحسبها
// الـpopper بالبكسل، فالخصائص المنطقية تقلبه على عكس السهم المرسوم.
function getArrowClasses(position: TooltipPosition): string {
  switch (position) {
    case 'top':
      return 'top-full left-1/2 transform -translate-x-1/2 border-t-foreground';
    case 'bottom':
      return 'bottom-full left-1/2 transform -translate-x-1/2 border-b-foreground';
    case 'left':
      return 'left-full top-1/2 transform -translate-y-1/2 border-l-foreground';
    case 'right':
      return 'right-full top-1/2 transform -translate-y-1/2 border-r-foreground';
    default:
      return 'top-full left-1/2 transform -translate-x-1/2 border-t-foreground';
  }
}

function Tooltip({
  children,
  content,
  position = 'top',
  className = '',
  wrapperClassName = '',
  delay = 350,
  tapToToggle = false,
  multiline = false,
  keyboard = false,
  interactive = false,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  // Store the timer id without forcing re-renders while hovering.
  const timeoutRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties | null>(null);
  // Dynamic arrow offset in px from the tooltip's inline-start edge (top/bottom only).
  const [arrowLeftPx, setArrowLeftPx] = useState<number | null>(null);
  // Touch start position for tap detection in tapToToggle mode.
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // Touch browsers synthesize mouse enter/leave after a tap. Those events
  // must not close a tooltip the same tap just opened. A real mouse entering
  // the trigger switches back to ordinary hover behavior.
  const touchInteractionRef = useRef(false);
  const tooltipHoveredRef = useRef(false);
  // Stable id for aria-describedby wiring in tapToToggle mode.
  const tooltipIdRef = useRef(`tt-${Math.random().toString(36).slice(2, 8)}`);

  const updateTooltipPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const spacing = 8;
    const style: React.CSSProperties = {
      position: 'fixed',
      zIndex: 9999,
    };

    // Read the tooltip's actual rendered dimensions so we can clamp to viewport.
    // The tooltip is in the DOM but at -9999px / opacity:0 on the first RAF call,
    // so getBoundingClientRect() returns the layout size without a visible flash.
    const tipW = tooltipRef.current?.getBoundingClientRect().width ?? 0;
    const vw = window.innerWidth;
    let newArrowLeft: number | null = null;

    switch (position) {
      case 'bottom': {
        const centerX = rect.left + rect.width / 2;
        style.top = rect.bottom + spacing;
        if (tipW > 0) {
          // Clamp so the tooltip never overflows the viewport edge (important on
          // narrow mobile screens, e.g. 360 px).
          const rawLeft = centerX - tipW / 2;
          const clampedLeft = Math.max(8, Math.min(rawLeft, vw - tipW - 8));
          style.left = clampedLeft;
          // Arrow: offset from the tooltip's left edge to the trigger's centre.
          newArrowLeft = Math.max(10, Math.min(centerX - clampedLeft, tipW - 10));
        } else {
          // Tooltip not yet sized — fall back to transform-based centering.
          style.left = centerX;
          style.transform = 'translateX(-50%)';
        }
        break;
      }
      case 'left':
        style.left = rect.left - spacing;
        style.top = rect.top + rect.height / 2;
        style.transform = 'translate(-100%, -50%)';
        break;
      case 'right':
        style.left = rect.right + spacing;
        style.top = rect.top + rect.height / 2;
        style.transform = 'translateY(-50%)';
        break;
      case 'top':
      default: {
        const centerX = rect.left + rect.width / 2;
        style.top = rect.top - spacing;
        if (tipW > 0) {
          const rawLeft = centerX - tipW / 2;
          const clampedLeft = Math.max(8, Math.min(rawLeft, vw - tipW - 8));
          style.left = clampedLeft;
          style.transform = 'translateY(-100%)';
          newArrowLeft = Math.max(10, Math.min(centerX - clampedLeft, tipW - 10));
        } else {
          style.left = centerX;
          style.transform = 'translate(-50%, -100%)';
        }
        break;
      }
    }

    // React 18 batches both setState calls into one re-render.
    setTooltipStyle(style);
    setArrowLeftPx(newArrowLeft);
  }, [position]);

  const clearTooltipTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // ── Hover / long-press handlers (default mode) ───────────────────────────

  const handleMouseEnter = () => {
    if (tapToToggle && touchInteractionRef.current) return;
    clearTooltipTimer();
    timeoutRef.current = window.setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (tapToToggle && touchInteractionRef.current) return;
    clearTooltipTimer();
    if (interactive) {
      // Keyboard focus is an independent visibility contract: leaving a
      // focused trigger with the mouse must not make its described content
      // disappear while focus remains there.
      if (containerRef.current?.contains(document.activeElement)) return;
      // The card is portalled, so crossing from trigger to card fires leave on
      // the trigger first. A small, cancellable grace period preserves the
      // hover affordance without keeping unrelated tooltips open.
      timeoutRef.current = window.setTimeout(() => setIsVisible(false), 150);
      return;
    }
    setIsVisible(false);
  };

  const handleFocus = () => {
    clearTooltipTimer();
    setIsVisible(true);
  };

  const handleBlur = () => {
    if (!tapToToggle && !(interactive && tooltipHoveredRef.current)) setIsVisible(false);
  };

  const handleTouchStart = () => {
    clearTooltipTimer();
    longPressTriggeredRef.current = false;
    timeoutRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      setIsVisible(true);
    }, delay);
  };

  const handleTouchEnd = () => {
    clearTooltipTimer();
    if (longPressTriggeredRef.current) {
      return;
    }
    setIsVisible(false);
  };

  // ── Tap-to-toggle handlers (tapToToggle mode) ─────────────────────────────

  const handleTouchStartTap = useCallback((e: React.TouchEvent) => {
    touchInteractionRef.current = true;
    clearTooltipTimer();
    touchStartPosRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }, [clearTooltipTimer]);

  const handleTouchEndTap = useCallback((e: React.TouchEvent) => {
    if (!touchStartPosRef.current) return;
    const dx = Math.abs(e.changedTouches[0].clientX - touchStartPosRef.current.x);
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartPosRef.current.y);
    touchStartPosRef.current = null;
    // Only toggle on a clean tap — ignore scroll/drag gestures.
    if (dx < 10 && dy < 10) {
      setIsVisible(prev => !prev);
    }
  }, []);

  const handleTouchCancelTap = useCallback(() => {
    touchStartPosRef.current = null;
  }, []);

  // Keyboard: Enter/Space toggle (tapToToggle mode only).
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsVisible(prev => !prev);
    }
  }, []);

  // ── Effects ──────────────────────────────────────────────────────────────

  // ESC always closes the tooltip, regardless of mode.
  useEffect(() => {
    if (!isVisible) return;
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsVisible(false);
        longPressTriggeredRef.current = false;
      }
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [isVisible]);

  useEffect(() => {
    // Avoid delayed updates after unmount.
    return () => {
      clearTooltipTimer();
    };
  }, [clearTooltipTimer]);

  useEffect(() => {
    if (!isVisible || typeof document === 'undefined') {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      setIsVisible(false);
      longPressTriggeredRef.current = false;
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) {
      setTooltipStyle(null);
      setArrowLeftPx(null);
      return;
    }

    const rafId = window.requestAnimationFrame(updateTooltipPosition);
    const handleViewportChange = () => updateTooltipPosition();

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isVisible, updateTooltipPosition]);

  if (!content) {
    return <>{children}</>;
  }

  const tooltipId = tooltipIdRef.current;

  // Compute dynamic arrow inline style when we have a clamped position for
  // top/bottom tooltips. The inline left overrides the Tailwind `left-1/2`
  // class and the inline transform overrides the Tailwind `transform
  // -translate-x-1/2`, keeping the arrow visually centred on the trigger even
  // when the tooltip bubble has been clamped to a viewport edge.
  const arrowStyle =
    arrowLeftPx !== null && (position === 'top' || position === 'bottom')
      ? ({ left: `${arrowLeftPx}px`, transform: 'translateX(-50%)' } as React.CSSProperties)
      : undefined;

  return (
    <div
      ref={containerRef}
      className={cn('relative inline-block', wrapperClassName)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') touchInteractionRef.current = false;
      }}
      onTouchStart={tapToToggle ? handleTouchStartTap : handleTouchStart}
      onTouchEnd={tapToToggle ? handleTouchEndTap : handleTouchEnd}
      onTouchCancel={tapToToggle ? handleTouchCancelTap : handleTouchEnd}
      {...((tapToToggle || keyboard) && {
        tabIndex: 0,
        'aria-describedby': isVisible ? tooltipId : undefined,
        onKeyDown: tapToToggle ? handleKeyDown : undefined,
        onFocus: keyboard ? handleFocus : undefined,
        onBlur: keyboard ? handleBlur : undefined,
      })}
    >
      {children}
      {isVisible && typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          id={tapToToggle || keyboard ? tooltipId : undefined}
          role={tapToToggle || keyboard ? 'tooltip' : undefined}
          style={tooltipStyle || { position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0 }}
          className={cn(
            'px-2 text-xs font-medium text-background bg-foreground rounded shadow-lg',
            interactive ? 'pointer-events-auto' : 'pointer-events-none',
            multiline ? 'py-1.5 whitespace-normal max-w-48' : 'py-1 whitespace-nowrap',
            'animate-in fade-in-0 zoom-in-95 duration-200',
            className
          )}
          onMouseEnter={interactive ? () => {
            tooltipHoveredRef.current = true;
            clearTooltipTimer();
          } : undefined}
          onMouseLeave={interactive ? () => {
            tooltipHoveredRef.current = false;
            handleMouseLeave();
          } : undefined}
        >
          {content}
          {/* Arrow */}
          <div
            className={cn('absolute w-0 h-0 border-4 border-transparent', getArrowClasses(position))}
            style={arrowStyle}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

export default Tooltip;

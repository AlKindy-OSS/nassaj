import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../../lib/utils';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

type TooltipProps = {
  children: ReactNode;
  content?: ReactNode;
  position?: TooltipPosition;
  className?: string;
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
};

function getArrowClasses(position: TooltipPosition): string {
  switch (position) {
    case 'top':
      return 'top-full left-1/2 transform -translate-x-1/2 border-t-gray-900 dark:border-t-gray-100';
    case 'bottom':
      return 'bottom-full left-1/2 transform -translate-x-1/2 border-b-gray-900 dark:border-b-gray-100';
    case 'left':
      return 'left-full top-1/2 transform -translate-y-1/2 border-l-gray-900 dark:border-l-gray-100';
    case 'right':
      return 'right-full top-1/2 transform -translate-y-1/2 border-r-gray-900 dark:border-r-gray-100';
    default:
      return 'top-full left-1/2 transform -translate-x-1/2 border-t-gray-900 dark:border-t-gray-100';
  }
}

function Tooltip({
  children,
  content,
  position = 'top',
  className = '',
  delay = 350,
  tapToToggle = false,
  multiline = false,
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

  const clearTooltipTimer = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  // ── Hover / long-press handlers (default mode) ───────────────────────────

  const handleMouseEnter = () => {
    clearTooltipTimer();
    timeoutRef.current = window.setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    clearTooltipTimer();
    setIsVisible(false);
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
    touchStartPosRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }, []);

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
  }, []);

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
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onTouchStart={tapToToggle ? handleTouchStartTap : handleTouchStart}
      onTouchEnd={tapToToggle ? handleTouchEndTap : handleTouchEnd}
      onTouchCancel={tapToToggle ? handleTouchCancelTap : handleTouchEnd}
      {...(tapToToggle && {
        tabIndex: 0,
        'aria-expanded': isVisible,
        'aria-describedby': isVisible ? tooltipId : undefined,
        onKeyDown: handleKeyDown,
      })}
    >
      {children}
      {isVisible && typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          id={tapToToggle ? tooltipId : undefined}
          role={tapToToggle ? 'tooltip' : undefined}
          style={tooltipStyle || { position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0 }}
          className={cn(
            'px-2 text-xs font-medium text-white bg-gray-900 dark:bg-gray-100 dark:text-gray-900 rounded shadow-lg pointer-events-none',
            multiline ? 'py-1.5 whitespace-normal max-w-48' : 'py-1 whitespace-nowrap',
            'animate-in fade-in-0 zoom-in-95 duration-200',
            className
          )}
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

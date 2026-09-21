import { useEffect, useRef, useState } from 'react';
import type { ReactNode, TransitionEvent } from 'react';

import { prefersReducedMotion } from '../../../../lib/motion';
import { cn } from '../../../../lib/utils';

type AnimatedRowProps = {
  /** Row content */
  children: ReactNode;
  /**
   * Skip the enter animation. Pass true for rows that were already present
   * when the list first mounted (initial page-load / initial project expand).
   */
  skipAnimation?: boolean;
  /**
   * When true the exit animation plays. The parent keeps the element mounted
   * until onExited fires, then removes it.
   */
  isExiting?: boolean;
  /** Called after the exit animation ends, or immediately on reduced-motion. */
  onExited?: () => void;
};

/**
 * Animates a session row entering or leaving the list.
 *
 * Mechanism: grid-template-rows 0fr ↔ 1fr + opacity, 300 ms ease-in-out.
 * Respects prefers-reduced-motion: if set, the transition is suppressed by
 * Tailwind's motion-reduce:transition-none, and onExited is called immediately
 * so the parent can drop the node without waiting for transitionend.
 *
 * Usage:
 *   // Enter — new row:
 *   <AnimatedRow><SidebarSessionItem .../></AnimatedRow>
 *
 *   // Enter — initial row (already visible, no animation):
 *   <AnimatedRow skipAnimation><SidebarSessionItem .../></AnimatedRow>
 *
 *   // Exit — parent keeps node until onExited:
 *   <AnimatedRow skipAnimation isExiting onExited={() => removeFromState(id)}>
 *     <SidebarSessionItem .../>
 *   </AnimatedRow>
 */
export function AnimatedRow({
  children,
  skipAnimation,
  isExiting,
  onExited,
}: AnimatedRowProps) {
  // Start open (visible=true) for rows that should skip animation so no
  // transition plays. Start closed for rows that should animate in.
  const [visible, setVisible] = useState(Boolean(skipAnimation));
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Keep latest onExited in a ref so the transitionend handler is always current.
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // Enter: flip to visible on the frame AFTER mount so the initial 0fr state
  // is painted before the browser transitions to 1fr.
  useEffect(() => {
    if (skipAnimation) return;
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []); // run once on mount only

  // Exit: when isExiting becomes true, collapse. With reduced-motion the
  // transition is instant so transitionend never fires — call onExited directly.
  useEffect(() => {
    if (!isExiting) return;
    if (prefersReducedMotion()) {
      onExitedRef.current?.();
      return;
    }
    setVisible(false);
  }, [isExiting]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    // Only respond to transitions on this element, not bubbled children.
    if (event.target !== wrapperRef.current) return;
    if (isExiting) onExitedRef.current?.();
  };

  return (
    <div
      ref={wrapperRef}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-300 ease-in-out',
        'motion-reduce:transition-none',
        visible
          ? '[grid-template-rows:1fr] opacity-100'
          : '[grid-template-rows:0fr] opacity-0',
      )}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

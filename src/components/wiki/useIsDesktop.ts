/**
 * useIsDesktop.ts — responsive breakpoint hook for the wiki viewer.
 *
 * Returns true while viewport width >= DESKTOP_BREAKPOINT, updates on
 * breakpoint crossing (device rotation, window resize).
 *
 * Consolidated from three identical inline definitions in WikiPanel.tsx
 * (WikiPanel, TableOfContents, and initial sidebarOpen state).
 */

import { useState, useEffect } from 'react';

/** Single source of truth for the mobile/desktop breakpoint (pixels). */
export const DESKTOP_BREAKPOINT = 768;

const MQ_QUERY = `(min-width: ${DESKTOP_BREAKPOINT}px)`;

/** Returns true while viewport width >= 768px, updates on breakpoint cross. */
export function useIsDesktop(): boolean {
  const mq =
    typeof window !== 'undefined' ? window.matchMedia(MQ_QUERY) : null;
  const [isDesktop, setIsDesktop] = useState<boolean>(() => mq?.matches ?? true);

  useEffect(() => {
    if (!mq) return;
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    // Modern API
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    // Legacy (Safari < 14)
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return isDesktop;
}

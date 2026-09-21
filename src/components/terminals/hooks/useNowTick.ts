import { useEffect, useState } from 'react';

/**
 * Returns a `Date.now()` value that refreshes every `intervalMs` while
 * `enabled`. One interval per LIST (not per row) — callers enable it only when
 * something is actually running, and every displayed duration is recomputed
 * from timestamps, so background-tab throttling costs resolution, never drift.
 */
export function useNowTick(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);

  return now;
}

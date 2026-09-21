import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { SCHEDULED_MESSAGES_CHANGED_EVENT } from '../scheduledMessagesEvents';

export type ScheduledMessagesCounts = { pending: number; running: number; failed: number };
const EMPTY_COUNTS: ScheduledMessagesCounts = { pending: 0, running: 0, failed: 0 };

function validCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Fetch metadata-only counts for the global sidebar badge. */
export function useScheduledMessagesSummary(enabled: boolean) {
  const [counts, setCounts] = useState<ScheduledMessagesCounts>(EMPTY_COUNTS);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const requestSequence = ++sequence.current;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    try {
      const response = await authenticatedFetch('/api/scheduled-messages/summary', {
        cache: 'no-store',
        signal: requestController.signal,
      });
      const payload = await response.json().catch(() => ({})) as { counts?: Partial<ScheduledMessagesCounts> };
      if (!response.ok || requestSequence !== sequence.current || requestController.signal.aborted) return;
      setCounts({
        pending: validCount(payload.counts?.pending),
        running: validCount(payload.counts?.running),
        failed: validCount(payload.counts?.failed),
      });
    } catch {
      // A badge is enhancement-only. Keep its last metadata snapshot on failure.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setCounts(EMPTY_COUNTS);
      return undefined;
    }
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onChanged = () => { void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(SCHEDULED_MESSAGES_CHANGED_EVENT, onChanged);
    return () => {
      controller.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(SCHEDULED_MESSAGES_CHANGED_EVENT, onChanged);
    };
  }, [enabled, refresh]);

  return { counts, total: counts.pending + counts.running + counts.failed, refresh };
}

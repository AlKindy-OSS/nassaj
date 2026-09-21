import { useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

type RemoteStatus = {
  hasUpstream?: unknown;
  ahead?: unknown;
};

/**
 * Loads the push reminder only when its project row approaches the viewport.
 * A failed or malformed response is intentionally indistinguishable from an
 * ineligible project, so the sidebar never exposes Git state it cannot prove.
 */
export function useProjectPushReminder(projectId: string): {
  visibilityRef: React.MutableRefObject<HTMLDivElement | null>;
  ahead: number | null;
} {
  const visibilityRef = useRef<HTMLDivElement | null>(null);
  const [requested, setRequested] = useState(false);
  const [ahead, setAhead] = useState<number | null>(null);

  useEffect(() => {
    const element = visibilityRef.current;
    if (!element || requested || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRequested(true);
        observer.disconnect();
      }
    }, { rootMargin: '80px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [requested]);

  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/git/remote-status?project=${encodeURIComponent(projectId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const status = (await response.json()) as RemoteStatus;
        const aheadCount = status.ahead;
        const isAhead = status.hasUpstream === true
          && typeof aheadCount === 'number'
          && Number.isSafeInteger(aheadCount)
          && aheadCount > 0;
        if (!controller.signal.aborted && isAhead) setAhead(aheadCount);
      } catch {
        // The reminder is advisory; failures remain silent and hidden.
      }
    })();

    return () => controller.abort();
  }, [projectId, requested]);

  return { visibilityRef, ahead };
}

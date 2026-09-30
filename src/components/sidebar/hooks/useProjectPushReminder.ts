import { useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

type RemoteStatus = {
  hasUpstream?: unknown;
  ahead?: unknown;
  isRepositoryRoot?: unknown;
};

/**
 * How often the reminder re-checks the remote once it starts watching a row.
 * Advisory data, not a live counter — a slow poll is enough to catch a commit
 * made elsewhere in the same session without hammering `git rev-list`.
 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Loads the push reminder only when its project row approaches the viewport.
 * A failed or malformed response is intentionally indistinguishable from an
 * ineligible project, so the sidebar never exposes Git state it cannot prove.
 *
 * The reminder shows only when the folder is the repository root
 * (`isRepositoryRoot === true`). A nested project folder whose git repo lives
 * in an ancestor directory would otherwise inherit that repo's ahead count and
 * falsely advertise unpushed commits; a missing field stays hidden (fail-closed).
 *
 * Re-fetches every `REFRESH_INTERVAL_MS` while the row stays on screen, and
 * immediately on tab focus/visibility return — otherwise a commit made after
 * the row first scrolled into view (e.g. the coordinator committing
 * mid-session) never shows up without a full page reload, since the original
 * fetch ran exactly once. Each `/api/git/remote-status` call spawns several
 * `git` processes, so once the row scrolls back out of view the interval
 * skips its poll instead of paying that cost for a row nobody can see; an
 * in-flight guard and a monotonic request counter keep a focus event that
 * lands mid-poll from doubling the call or letting a slower, older response
 * overwrite a newer one.
 */
export function useProjectPushReminder(projectId: string): {
  visibilityRef: React.MutableRefObject<HTMLDivElement | null>;
  ahead: number | null;
} {
  const visibilityRef = useRef<HTMLDivElement | null>(null);
  const [watching, setWatching] = useState(false);
  const isRowVisibleRef = useRef(false);
  const [ahead, setAhead] = useState<number | null>(null);
  const inFlightRef = useRef(false);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const element = visibilityRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      const isIntersecting = entries.some((entry) => entry.isIntersecting);
      isRowVisibleRef.current = isIntersecting;
      if (isIntersecting) setWatching(true);
    }, { rootMargin: '80px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();

    const fetchOnce = async () => {
      // One request at a time: a `focus` and `visibilitychange` firing in
      // the same tick (or a late poll tick overlapping a fetch already in
      // flight) must not spawn a second `git` process pass.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const requestSeq = ++requestSeqRef.current;
      try {
        const response = await authenticatedFetch(
          `/api/git/remote-status?project=${encodeURIComponent(projectId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || requestSeq !== requestSeqRef.current) return;
        if (!response.ok) return;
        const status = (await response.json()) as RemoteStatus;
        const aheadCount = status.ahead;
        const isAhead = status.isRepositoryRoot === true
          && status.hasUpstream === true
          && typeof aheadCount === 'number'
          && Number.isSafeInteger(aheadCount)
          && aheadCount > 0;
        // A slower, now-stale response must not clobber a result a newer
        // request already applied.
        if (!controller.signal.aborted && requestSeq === requestSeqRef.current) {
          setAhead(isAhead ? aheadCount : null);
        }
      } catch {
        // The reminder is advisory; failures remain silent and hidden.
      } finally {
        inFlightRef.current = false;
      }
    };

    const pollIfVisible = () => {
      if (!document.hidden && isRowVisibleRef.current) void fetchOnce();
    };

    void fetchOnce();
    const interval = window.setInterval(pollIfVisible, REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', pollIfVisible);
    window.addEventListener('focus', pollIfVisible);

    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', pollIfVisible);
      window.removeEventListener('focus', pollIfVisible);
    };
  }, [projectId, watching]);

  return { visibilityRef, ahead };
}

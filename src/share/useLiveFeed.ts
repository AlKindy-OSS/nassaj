import { useCallback, useEffect, useRef, useState } from 'react';

import type { LiveClient, LiveFailure, PageQuery } from './liveClient';
import { mergeNewer, mergeOlder, reconcileTail } from './liveMerge';
import type { LiveMessage, LivePage } from './types';

export const POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;

export type FeedNotice = 'rate-limited' | 'temporary' | null;

export interface FeedState {
  /** loading: nothing shown yet; ready: content shown; ended: link no longer active (terminal). */
  status: 'loading' | 'ready' | 'ended';
  messages: LiveMessage[];
  running: boolean;
  stale: boolean;
  moreBefore: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  notice: FeedNotice;
}

const INITIAL: FeedState = {
  status: 'loading', messages: [], running: false, stale: false,
  moreBefore: false, loadingOlder: false, olderFailed: false, notice: null,
};

const noticeFor = (failure: LiveFailure): FeedNotice =>
  failure.kind === 'rate-limited' ? 'rate-limited' : failure.kind === 'temporary' ? 'temporary' : null;

/**
 * Live feed: loads the newest page, then polls for newer messages every 5 s while the
 * tab is visible (paused while hidden), backing off on 429/503. Messages merge by `k`.
 * A 404 ends the feed for good; CURSOR_STALE reloads from the tail.
 */
export function useLiveFeed(client: LiveClient) {
  const [state, setState] = useState<FeedState>(INITIAL);
  const ref = useRef<FeedState & { revision: string }>({ ...INITIAL, revision: '' });
  const wakeRef = useRef<(() => void) | null>(null);
  const olderBusy = useRef(false);
  const cancelled = useRef(false);

  const commit = useCallback((patch: Partial<FeedState> & { revision?: string }) => {
    ref.current = { ...ref.current, ...patch };
    const { revision: _revision, ...visible } = ref.current;
    setState(visible);
  }, []);

  const applyPage = useCallback((page: LivePage, mode: 'tail' | 'after' | 'reconcile') => {
    const current = ref.current.messages;
    const messages = mode === 'tail' ? page.messages
      : mode === 'reconcile' ? reconcileTail(current, page.messages)
      : mergeNewer(current, page.messages);
    commit({
      status: 'ready', messages, revision: page.revision || ref.current.revision,
      running: page.running, stale: page.stale, notice: null,
      moreBefore: mode === 'after' ? ref.current.moreBefore : page.moreBefore,
    });
  }, [commit]);

  useEffect(() => {
    cancelled.current = false;
    const controller = new AbortController();
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); wakeRef.current = null; resolve(); };
      const timer = setTimeout(done, ms);
      wakeRef.current = done;
    });
    const waitVisible = async () => {
      while (document.hidden && !cancelled.current) {
        await new Promise<void>((resolve) => { wakeRef.current = resolve; });
      }
    };
    const onVisible = () => { if (!document.hidden) wakeRef.current?.(); };
    document.addEventListener('visibilitychange', onVisible);

    const reloadTail = async (): Promise<FailureOrNull> => {
      const tail = await client.messages({}, controller.signal);
      if (cancelled.current) return null;
      if (tail.ok) { applyPage(tail.value, 'reconcile'); return null; }
      return tail.failure;
    };

    const run = async () => {
      let failures = 0;
      for (;;) {
        await waitVisible();
        if (cancelled.current) return;
        const last = ref.current.messages.at(-1);
        const query: PageQuery = last ? { after: last.c } : {};
        const result = await client.messages(query, controller.signal);
        if (cancelled.current) return;
        let delay = POLL_INTERVAL_MS;
        let failure: FailureOrNull = null;
        if (result.ok) {
          applyPage(result.value, last ? 'after' : 'tail');
          failures = 0;
          delay = result.value.moreAfter ? 0 : Math.max(POLL_INTERVAL_MS, result.value.retryAfterMs);
        } else if (result.failure.kind === 'cursor-stale') {
          failure = await reloadTail();
          if (!failure) failures = 0;
        } else {
          failure = result.failure;
        }
        if (cancelled.current) return;
        if (failure) {
          if (failure.kind === 'ended') { commit({ status: 'ended', notice: null }); return; }
          failures += 1;
          const base = 'retryAfterMs' in failure ? failure.retryAfterMs : POLL_INTERVAL_MS;
          delay = Math.min(base * 2 ** Math.min(failures - 1, 4), MAX_BACKOFF_MS);
          commit({ notice: noticeFor(failure) ?? 'temporary' });
        }
        if (delay > 0) await sleep(delay);
      }
    };
    void run();

    return () => {
      cancelled.current = true;
      controller.abort();
      wakeRef.current?.();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, applyPage, commit]);

  const loadOlder = useCallback(async () => {
    const first = ref.current.messages[0];
    if (!first || olderBusy.current || !ref.current.moreBefore) return;
    olderBusy.current = true;
    commit({ loadingOlder: true, olderFailed: false });
    const result = await client.messages({ before: first.c });
    olderBusy.current = false;
    if (cancelled.current) return;
    if (result.ok) {
      commit({
        loadingOlder: false,
        messages: mergeOlder(ref.current.messages, result.value.messages),
        moreBefore: result.value.moreBefore,
      });
    } else if (result.failure.kind === 'ended') {
      commit({ status: 'ended', loadingOlder: false });
    } else if (result.failure.kind === 'cursor-stale') {
      const tail = await client.messages({});
      if (tail.ok) applyPage(tail.value, 'reconcile');
      commit({ loadingOlder: false, olderFailed: !tail.ok });
    } else {
      commit({ loadingOlder: false, olderFailed: true });
    }
  }, [client, commit, applyPage]);

  /** Poll again now (used by the manual retry button). */
  const retryNow = useCallback(() => wakeRef.current?.(), []);

  return { state, loadOlder, retryNow };
}

type FailureOrNull = LiveFailure | null;

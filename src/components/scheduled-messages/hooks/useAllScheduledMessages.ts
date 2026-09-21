import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { ScheduledMessage } from '../../chat/hooks/useScheduledMessages';
import { announceScheduledMessagesChanged } from '../scheduledMessagesEvents';

type ScheduledMessagesResponse = {
  messages?: ScheduledMessage[];
  message?: ScheduledMessage;
  total?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
  error?: string;
  messageText?: string;
};

const ACTIONABLE_STATUSES = ['pending', 'running', 'failed'] as const;
type ActionableStatus = typeof ACTIONABLE_STATUSES[number];
type PageState = Record<ActionableStatus, { total: number; hasMore: boolean; nextOffset: number | null }>;
const EMPTY_PAGES: PageState = {
  pending: { total: 0, hasMore: false, nextOffset: null },
  running: { total: 0, hasMore: false, nextOffset: null },
  failed: { total: 0, hasMore: false, nextOffset: null },
};

function pageState(payloads: ScheduledMessagesResponse[]): PageState {
  return Object.fromEntries(ACTIONABLE_STATUSES.map((status, index) => {
    const payload = payloads[index];
    const messages = payload.messages ?? [];
    const total = typeof payload.total === 'number' ? payload.total : messages.length;
    const hasMore = payload.hasMore === true;
    return [status, {
      total,
      hasMore,
      nextOffset: hasMore && typeof payload.nextOffset === 'number' ? payload.nextOffset : null,
    }];
  })) as PageState;
}

function sortedUnique(messages: ScheduledMessage[]): ScheduledMessage[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()]
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
}

async function readResponse(response: Response): Promise<ScheduledMessagesResponse> {
  return response.json().catch(() => ({})) as Promise<ScheduledMessagesResponse>;
}

function resolveError(response: Response, payload: ScheduledMessagesResponse): string {
  return payload.error || payload.messageText || `HTTP ${response.status}`;
}

/** Global, user-scoped client for actionable scheduled messages across sessions. */
export function useAllScheduledMessages() {
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pages, setPages] = useState<PageState>(EMPTY_PAGES);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'load' | 'action' | null>(null);
  const refreshSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const loadMoreController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    controller.current?.abort();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoadingMore(false);
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true);
    setError(null);
    setErrorKind(null);
    try {
      const responses = await Promise.all(ACTIONABLE_STATUSES.map((status) =>
        authenticatedFetch(`/api/scheduled-messages?status=${status}&limit=200&offset=0`, {
          signal: requestController.signal,
          cache: 'no-store',
        })));
      const payloads = await Promise.all(responses.map(readResponse));
      const failedIndex = responses.findIndex((response) => !response.ok);
      if (failedIndex >= 0) throw new Error(resolveError(responses[failedIndex], payloads[failedIndex]));
      if (sequence !== refreshSequence.current || requestController.signal.aborted) return;
      setMessages(sortedUnique(payloads.flatMap((payload) => payload.messages ?? [])));
      setPages(pageState(payloads));
    } catch (cause) {
      if (sequence === refreshSequence.current && !requestController.signal.aborted) {
        // Keep the last trusted snapshot visible; the page marks it as stale.
        setError(cause instanceof Error ? cause.message : 'request_failed');
        setErrorKind('load');
      }
    } finally {
      if (sequence === refreshSequence.current && !requestController.signal.aborted) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    const requested = ACTIONABLE_STATUSES.filter((status) => pages[status].hasMore && pages[status].nextOffset !== null);
    if (requested.length === 0 || loadingMore || loadMoreController.current) return;
    const sequence = refreshSequence.current;
    const requestController = new AbortController();
    loadMoreController.current = requestController;
    setLoadingMore(true);
    setError(null);
    setErrorKind(null);
    try {
      const responses = await Promise.all(requested.map((status) => authenticatedFetch(
        `/api/scheduled-messages?status=${status}&limit=200&offset=${pages[status].nextOffset}`,
        { cache: 'no-store', signal: requestController.signal },
      )));
      const payloads = await Promise.all(responses.map(readResponse));
      const failedIndex = responses.findIndex((response) => !response.ok);
      if (failedIndex >= 0) throw new Error(resolveError(responses[failedIndex], payloads[failedIndex]));
      if (sequence !== refreshSequence.current || requestController.signal.aborted) return;

      // Commit messages and cursors together only after every status page succeeds.
      setMessages((current) => sortedUnique([...current, ...payloads.flatMap((payload) => payload.messages ?? [])]));
      setPages((current) => {
        const next = { ...current };
        requested.forEach((status, index) => {
          const payload = payloads[index];
          const pageMessages = payload.messages ?? [];
          const total = typeof payload.total === 'number' ? payload.total : current[status].total;
          const hasMore = payload.hasMore === true;
          next[status] = {
            total,
            hasMore,
            nextOffset: hasMore && typeof payload.nextOffset === 'number'
              ? payload.nextOffset
              : null,
          };
          // A malformed page must not create an endless load-more loop.
          if (hasMore && next[status].nextOffset === null && pageMessages.length > 0) {
            next[status] = { total, hasMore: false, nextOffset: null };
          }
        });
        return next;
      });
    } catch (cause) {
      if (sequence === refreshSequence.current && !requestController.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'request_failed');
        setErrorKind('load');
      }
    } finally {
      if (loadMoreController.current === requestController) loadMoreController.current = null;
      if (sequence === refreshSequence.current && !requestController.signal.aborted) setLoadingMore(false);
    }
  }, [loadingMore, pages]);

  useEffect(() => {
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      refreshSequence.current += 1;
      controller.current?.abort();
      loadMoreController.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const mutate = useCallback(async (
    id: string,
    method: 'PATCH' | 'DELETE',
    body?: { content: string; scheduledFor: string },
  ) => {
    setBusyIds((current) => new Set(current).add(id));
    setError(null);
    setErrorKind(null);
    try {
      const response = await authenticatedFetch(`/api/scheduled-messages/${encodeURIComponent(id)}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = response.status === 204 ? {} : await readResponse(response);
      if (!response.ok) throw new Error(resolveError(response, payload));
      announceScheduledMessagesChanged();
      await refresh();
      return payload.message ?? null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'request_failed');
      setErrorKind('action');
      throw cause;
    } finally {
      setBusyIds((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  }, [refresh]);

  const update = useCallback((id: string, content: string, scheduledFor: string) =>
    mutate(id, 'PATCH', { content, scheduledFor }), [mutate]);
  const cancel = useCallback((id: string) => mutate(id, 'DELETE'), [mutate]);

  return {
    messages,
    loading,
    loadingMore,
    pages,
    total: ACTIONABLE_STATUSES.reduce((sum, status) => sum + pages[status].total, 0),
    hasMore: ACTIONABLE_STATUSES.some((status) => pages[status].hasMore),
    busyIds,
    error,
    errorKind,
    stale: Boolean(error && errorKind === 'load' && messages.length > 0),
    refresh,
    loadMore,
    update,
    cancel,
  };
}

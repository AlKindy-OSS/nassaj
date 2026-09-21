import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { SubscriptionsPayload } from '../subscriptionHelpers';

const SUBSCRIPTIONS_URL = '/api/providers/costs/subscriptions';

export type SubscriptionsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: SubscriptionsPayload }
  | { status: 'error' };

type UseSubscriptionCostsResult = SubscriptionsState & {
  refetch: () => void;
};

/**
 * Month-to-date cost per SUBSCRIPTION (vendor), fetched while `enabled` is true
 * (panel open AND the section expanded).
 *
 * READ-ONLY on purpose. The cycle anchor used to be typed in here, with an
 * optimistic write and a rollback; it is now detected server-side from real
 * subscription data (`anchorSource`), so the hook no longer offers a write path
 * at all. `PUT /:provider` still exists on the server — the UI simply stops
 * calling it, which is also why nothing here has to reason about a stale GET
 * landing on top of a local edit any more.
 *
 * Deliberately NOT polled, unlike useClaudeUsage: every call makes the server
 * re-read session transcripts off disk for the whole cycle window, which is far
 * too expensive to repeat on a timer for a figure that moves by cents. It
 * refreshes when the section is re-opened, and `refetch` is there for anything
 * that needs it sooner.
 */
export function useSubscriptionCosts(enabled: boolean): UseSubscriptionCostsResult {
  const [state, setState] = useState<SubscriptionsState>({ status: 'idle' });

  // Latest in-flight GET; stale responses are dropped.
  const requestIdRef = useRef(0);

  const fetchCosts = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((prev) => (prev.status === 'success' ? prev : { status: 'loading' }));

    try {
      const response = await authenticatedFetch(SUBSCRIPTIONS_URL);
      if (requestId !== requestIdRef.current) return;

      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }

      const body = (await response.json()) as Partial<SubscriptionsPayload>;
      if (requestId !== requestIdRef.current) return;

      // A payload without the array is a broken contract, not an empty account:
      // rendering it as "no subscriptions" would claim something we don't know.
      if (!Array.isArray(body?.subscriptions)) {
        setState({ status: 'error' });
        return;
      }

      setState({
        status: 'success',
        data: {
          pricesAsOf: typeof body.pricesAsOf === 'string' ? body.pricesAsOf : '',
          subscriptions: body.subscriptions,
        },
      });
    } catch {
      if (requestId !== requestIdRef.current) return;
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchCosts();
  }, [enabled, fetchCosts]);

  return { ...state, refetch: fetchCosts };
}

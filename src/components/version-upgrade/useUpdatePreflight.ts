import { useCallback, useRef, useState } from 'react';

import { authenticatedFetch } from '../../utils/api';
import {
  interpretPreflightResponse,
  UPDATE_PREFLIGHT_PATH,
  type PreflightOutcome,
  type PreflightState,
} from './updatePreflightClient';

const IDLE: PreflightState = { status: 'idle' };

/**
 * Runs the read-only update pre-flight and holds its latest state.
 *
 * `run` is single-flight on the client too: a second call while one request is
 * pending shares it, so a double click never spends two of the endpoint's five
 * requests per minute. It resolves with the outcome so the caller can gate the
 * POST on the same result the owner sees.
 */
export function useUpdatePreflight() {
  const [state, setState] = useState<PreflightState>(IDLE);
  const inFlightRef = useRef<Promise<PreflightOutcome> | null>(null);

  const run = useCallback((): Promise<PreflightOutcome> => {
    if (inFlightRef.current) return inFlightRef.current;
    setState({ status: 'checking' });
    const request = (async (): Promise<PreflightOutcome> => {
      try {
        const response = await authenticatedFetch(UPDATE_PREFLIGHT_PATH, { cache: 'no-store' });
        const parsed: unknown = await response.json().catch(() => ({}));
        const body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
        return interpretPreflightResponse(response.status, body, response.headers?.get('Retry-After') ?? null);
      } catch {
        return { status: 'error', reason: 'connection', code: null };
      }
    })();
    inFlightRef.current = request;
    return request.then(outcome => {
      setState(outcome);
      return outcome;
    }).finally(() => {
      inFlightRef.current = null;
    });
  }, []);

  const reset = useCallback(() => setState(IDLE), []);

  return { state, run, reset };
}

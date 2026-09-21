import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSkillProjection } from '../../../shared/skillObservations';
import { authenticatedFetch } from '../../utils/api';
import { readSessionSkillProjection } from './skillObservationPayload';

export type SessionSkillsState = {
  projection: SessionSkillProjection | null;
  status: 'loading' | 'ready' | 'unavailable' | 'unsupported';
  stale: boolean;
  refresh: () => void;
  loadMore?: () => void;
};
const POLL_MS = 10_000;

/** One session-owned, bounded reader; switches mask stale data before effects run. */
export function useSessionSkills(sessionId: string | null | undefined, provider: string | null | undefined, active: boolean, enabled = true): SessionSkillsState {
  const key = enabled && sessionId && provider ? `${provider}:${sessionId}` : '';
  const [state, setState] = useState<{ key: string; projection: SessionSkillProjection | null; status: SessionSkillsState['status']; stale: boolean }>({ key: '', projection: null, status: 'loading', stale: false });
  const [revision, setRevision] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadMoreRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const loadMore = useCallback(() => loadMoreRef.current?.(), []);

  useEffect(() => {
    if (!key) return;
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    const load = async (cursor?: string) => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const previous = stateRef.current.key === key ? stateRef.current.projection : null;
        if (cursor && previous?.coverage.nextCursor !== cursor) return;
        const response = await authenticatedFetch(`/api/providers/${encodeURIComponent(provider!)}/sessions/${encodeURIComponent(sessionId!)}/skills${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal });
        if (disposed || keyRef.current !== key) return;
        if (response.status === 404 || response.status === 501) {
          setState({ key, projection: null, status: 'unsupported', stale: false });
          return;
        }
        if (!response.ok) throw new Error('skill-observation-unavailable');
        const body = await response.json();
        if (disposed || keyRef.current !== key) return;
        const projection = readSessionSkillProjection(body.skills);
        if (body.success !== true || !projection) throw new Error('invalid-skill-observation');
        // Server validates cursor generation/scope before returning the page.
        // Never merge after an error or a first-page refresh of a new snapshot.
        if (cursor && previous) {
          const observations = [...new Map([...previous.observations, ...projection.observations].map(item => [item.id, item])).values()];
          projection.observations = observations.slice(0, 2000);
          if (observations.length >= 2000 && projection.coverage.nextCursor) projection.coverage = { ...projection.coverage, state: 'partial', nextCursor: null, reasons: [...projection.coverage.reasons, 'response_limit'] };
        }
        setState({ key, projection, status: 'ready', stale: false });
      } catch {
        if (!disposed && keyRef.current === key) setState(previous => ({ key, projection: previous.key === key ? previous.projection : null, status: previous.key === key && previous.projection ? 'ready' : 'unavailable', stale: true }));
      } finally { inFlight = false; }
    };
    loadMoreRef.current = () => { const cursor = stateRef.current.key === key ? stateRef.current.projection?.coverage.nextCursor : null; if (cursor) void load(cursor); };
    void load();
    const timer = active ? window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, POLL_MS) : undefined;
    return () => { disposed = true; loadMoreRef.current = null; controller.abort(); if (timer !== undefined) window.clearInterval(timer); };
  }, [key, provider, sessionId, active, revision]);

  return { ...(state.key === key && key ? state : { projection: null, status: 'loading' as const, stale: false }), refresh, loadMore };
}

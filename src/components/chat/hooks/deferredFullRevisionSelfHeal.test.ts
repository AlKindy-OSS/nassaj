/**
 * B-1386 - qa-critic round 2 (VETO on c8de29740): the fake store in round 1
 * simulated a server that answers ok:true with a mismatched revision on a
 * full request. The REAL server (sessions.service.ts:742-746) 409s that
 * mismatch outright (HISTORY_REVISION_CHANGED) -- it never returns 200 with
 * a different revision -- so that fixture never exercised the real failure
 * path. This rewrite mocks at the authenticatedFetch boundary instead of the
 * store, so the request/response contract matches the server exactly: a
 * full request whose revision no longer matches gets 409, and only a
 * request WITHOUT revision (the bounded retry) can succeed unconditionally.
 *
 * RUNNER: vitest.
 */

import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { useChatSessionState } from './useChatSessionState';

const PROJECT = { projectId: 'p1', path: '/synthetic', fullPath: '/synthetic' } as any;
const SESSION_ID = 's-new-session-revision-race';
const noOp = () => {};

const row = (id: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id, sessionId: SESSION_ID, kind: 'text', role: 'user', provider: 'claude',
  timestamp: '2026-09-28T00:00:00Z', content: id, ...overrides,
});

function mount() {
  return renderHook(() => {
    const store = useSessionStore();
    const pending = useRef(null);
    const state = useChatSessionState({
      selectedSession: { id: SESSION_ID, __provider: 'claude' } as any,
      selectedProject: PROJECT, ws: null, sendMessage: noOp, resetStreamingState: noOp,
      pendingViewSessionRef: pending, sessionStore: store,
    });
    return { store, ...state };
  });
}

let fullRequestCount = 0;

beforeEach(() => {
  fullRequestCount = 0;
  publishServerCapabilities({ capabilities: { lightHistory: { supported: true, enabled: true, schema: 1 } } });
  authenticatedFetch.mockReset().mockImplementation(async (url: string) => {
    if (!url.includes('/messages')) return { ok: false, status: 404, json: async () => ({}) };
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    if (query.get('payload') === 'light') {
      return {
        ok: true,
        json: async () => ({
          messages: [row('m-user')], total: 1, hasMore: false, nextCursor: null,
          historySchema: 1, payloadMode: 'light', revision: 'rev-1',
        }),
      };
    }
    fullRequestCount += 1;
    if (fullRequestCount === 1) {
      return {
        ok: false, status: 409, headers: new Headers(),
        json: async () => ({ error: { code: 'HISTORY_REVISION_CHANGED' } }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        messages: [
          row('m-user'),
          row('m-assistant', {
            role: 'assistant', content: 'assistant reply text', responseToMessageId: 'm-user',
          } as Partial<NormalizedMessage>),
        ],
        total: 2, hasMore: false, nextCursor: null,
        payloadMode: 'full', revision: 'rev-2',
      }),
    };
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('B-1386 - deferred full-enrichment revision conflict self-heals', () => {
  it(
    'retries without the stale revision instead of a sticky historyError, ' +
    'and keeps a realtime row covered by the rebase without duplicating it',
    async () => {
      const { result } = mount();
      await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));

      act(() => {
        result.current.store.appendRealtime(SESSION_ID, row('cmid_stream', {
          role: 'assistant', content: 'assistant reply', clientStream: true,
          responseToMessageId: 'm-user',
        } as Partial<NormalizedMessage>));
      });

      await waitFor(
        () => expect(result.current.store.getSessionSlot(SESSION_ID)?.historyRevision).toBe('rev-2'),
        { timeout: 5000 },
      );

      expect(fullRequestCount).toBe(2);
      expect(result.current.historyError).toBe(null);
      const ids = result.current.chatMessages.map((m: any) => m.id);
      expect(ids.filter((id: string) => id === 'm-assistant' || id === 'cmid_stream')).toHaveLength(1);
      expect(result.current.chatMessages).toHaveLength(2);
    },
    10000,
  );
});

/**
 * ADR-229 S5: a conversation of a removed harness (kimi/qwen/hermes) answers its
 * history read with `readFailed: true, unavailableReason: 'provider_removed'`.
 * An already-open tab must show the removed-tool message, not an empty chat or
 * the generic read failure, and must not keep re-reading.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));
import {
  canAutomaticallyReadHistory,
  classifyHistoryFailure,
  isProviderRemovedHistory,
  planHistoryAutoRetry,
  useSessionStore,
} from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';
import { resolveScrollResyncRoute, shouldShowResyncArrow } from './sessionActivity';

import { useChatSessionState } from './useChatSessionState';

const project = { projectId: 'p1', path: '/synthetic', fullPath: '/synthetic' } as any;
const noOp = () => {};
const removedBody = {
  messages: [], total: 0, hasMore: false, offset: 0, limit: 50, nextCursor: null,
  readFailed: true, unavailableReason: 'provider_removed', historySchema: 1, payloadMode: 'light',
  revision: 'provider_removed',
};
const historyCalls = () => authenticatedFetch.mock.calls.filter(([url]) => String(url).includes('/messages'));

function mount() {
  return renderHook(({ id, external = 0 }: { id: string; external?: number }) => {
    const store = useSessionStore();
    const pending = useRef(null);
    const state = useChatSessionState({ selectedSession: { id, __provider: 'kimi' } as any,
      selectedProject: project, ws: null, sendMessage: noOp, resetStreamingState: noOp,
      pendingViewSessionRef: pending, sessionStore: store, externalMessageUpdate: external });
    return { store, ...state };
  }, { initialProps: { id: 's-removed' } as { id: string; external?: number } });
}

beforeEach(() => {
  publishServerCapabilities({ lightHistoryReady: false });
  authenticatedFetch.mockReset().mockImplementation((url: string) => (String(url).includes('/messages')
    ? Promise.resolve({ ok: true, status: 200, json: async () => removedBody })
    : Promise.resolve({ ok: false, status: 404, json: async () => ({}) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('removed-harness conversation in an open tab (ADR-229 S5)', () => {
  it('turns provider_removed into a removed-tool failure, not an empty conversation', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    expect(result.current.chatMessages).toHaveLength(0);
    expect(result.current.historyError).toMatchObject({ code: 'PROVIDER_REMOVED', operation: 'initial' });
    expect(classifyHistoryFailure(result.current.historyError)).toBe('removed');
    expect(isProviderRemovedHistory(result.current.historyError)).toBe(true);
  });

  it('never re-reads on its own: no retry, no reconnect read, no loop on rerender', async () => {
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.historyError?.code).toBe('PROVIDER_REMOVED'));
    const error = result.current.historyError!;
    expect(planHistoryAutoRetry(error, 0).retry).toBe(false);
    expect(canAutomaticallyReadHistory(error, Date.now() + 3_600_000)).toBe(false);
    await act(async () => { rerender({ id: 's-removed', external: 1 }); });
    await act(async () => { rerender({ id: 's-removed', external: 2 }); });
    expect(historyCalls()).toHaveLength(1);
  });

  it('a 410 provider_removed answer is classified the same way', async () => {
    authenticatedFetch.mockImplementation(() => Promise.resolve({
      ok: false, status: 410, headers: new Headers(), json: async () => ({ error: { code: 'provider_removed' } }),
    }));
    const { result } = mount();
    await waitFor(() => expect(result.current.historyError).not.toBeNull());
    expect(classifyHistoryFailure(result.current.historyError)).toBe('removed');
  });

  it('the jump-down button does not offer a pointless retry for a removed tool', () => {
    expect(resolveScrollResyncRoute({ historyError: true, showManualRefresh: false, historyRemoved: true }))
      .toBe('scrollOnly');
    expect(shouldShowResyncArrow({ hasHistoryError: true, isStuck: false, historyRemoved: true })).toBe(false);
    expect(shouldShowResyncArrow({ hasHistoryError: true, isStuck: false })).toBe(true);
  });

  it('a generic readFailed without the removed reason stays an ordinary history', async () => {
    authenticatedFetch.mockImplementation(() => Promise.resolve({ ok: true, status: 200,
      json: async () => ({ messages: [], total: 0, hasMore: false, readFailed: true }) }));
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    expect(result.current.historyError).toBeNull();
  });
});

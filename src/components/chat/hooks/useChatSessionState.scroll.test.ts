import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));
import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { useChatSessionState } from './useChatSessionState';

const project = { projectId: 'p1', path: '/synthetic', fullPath: '/synthetic' } as any;
const noOp = () => {};
const row = (id: string): NormalizedMessage => ({
  id, sessionId: 's1', kind: 'text', role: 'assistant', provider: 'claude', timestamp: '2026-09-07T00:00:00Z', content: id,
});

function mount() {
  return renderHook(({ id }: { id: string }) => {
    const store = useSessionStore();
    const pending = useRef(null);
    const state = useChatSessionState({
      selectedSession: { id, __provider: 'claude' } as any,
      selectedProject: project, ws: null, sendMessage: noOp, resetStreamingState: noOp,
      pendingViewSessionRef: pending, sessionStore: store,
    });
    return { store, ...state };
  }, { initialProps: { id: 's1' } });
}

/** T-1862: يبني عنصر تمرير زائف بأبعاد قابلة للتحكّم (jsdom لا يحسب تخطيطاً فعلياً). */
function makeContainer(scrollHeight: number, clientHeight: number, scrollTop: number) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(container, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
  return container;
}

beforeEach(() => {
  publishServerCapabilities({ lightHistoryReady: false });
  authenticatedFetch.mockReset().mockImplementation((url: string) => url.includes('/messages')
    ? Promise.resolve({ ok: true, json: async () => ({ messages: [row('m1')], total: 1, hasMore: false }) })
    : Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('T-1862: onScroll path keeps isUserScrolledUp in sync with real position', () => {
  it('sets isUserScrolledUp=true for scrollbar/keyboard scroll away from bottom (no wheel/touch involved)', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    act(() => { (result.current.scrollContainerRef as any).current = makeContainer(1000, 400, 0); });
    // Exactly what ChatMessagesPane's `onScroll={handleScroll}` invokes — not
    // the wheel/touch-only handleUserScrollIntent.
    await act(async () => { await result.current.handleScroll(); });
    expect(result.current.isUserScrolledUp).toBe(true);
  });

  it('clears isUserScrolledUp once that same path reports a near-bottom position again', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    const container = makeContainer(1000, 400, 0);
    act(() => { (result.current.scrollContainerRef as any).current = container; });
    await act(async () => { await result.current.handleScroll(); });
    expect(result.current.isUserScrolledUp).toBe(true);

    // Scrollbar drag (or Home/End/PageDown) back to the bottom — still no
    // wheel/touchmove event, only a scrollTop change + native 'scroll'.
    Object.defineProperty(container, 'scrollTop', { value: 610, configurable: true, writable: true });
    await act(async () => { await result.current.handleScroll(); });
    expect(result.current.isUserScrolledUp).toBe(false);
  });

  it('does not force isUserScrolledUp back to stale true after a fresh mount', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    expect(result.current.isUserScrolledUp).toBe(false);
  });
});

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

const messageFetches = () => authenticatedFetch.mock.calls.filter(([url]) => String(url).includes('/messages')).length;

describe('B-1665: the session hook keeps pagination, the stick hook owns pinning', () => {
  it('handleScroll near the top still fetches the older page', async () => {
    authenticatedFetch.mockImplementation((url: string) => url.includes('/messages')
      ? Promise.resolve({ ok: true, json: async () => ({ messages: [row('m2')], total: 2, hasMore: true }) })
      : Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));
    const { result } = mount();
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(true));
    const before = messageFetches();
    act(() => { (result.current.scrollContainerRef as any).current = makeContainer(1000, 400, 0); });
    await act(async () => { await result.current.handleScroll(); });
    expect(messageFetches()).toBe(before + 1);
  });

  it('no frame loop or timer writes scrollTop when messages arrive (no competing writer)', async () => {
    const { result } = mount();
    const container = makeContainer(1000, 400, 0);
    act(() => { (result.current.scrollContainerRef as any).current = container; });
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    await waitFor(() => expect(result.current.chatMessages.length).toBe(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(container.scrollTop).toBe(0);
  });

  it('exposes the search-navigation flag so pinning can be suppressed during a search hit', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    expect(result.current.searchScrollActiveRef.current).toBe(false);
  });
});

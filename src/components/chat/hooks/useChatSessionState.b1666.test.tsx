/**
 * B-1666 #9/#10 — useChatSessionState keys token usage by projectId and stamps
 * optimistic rows with the session's own provider.
 *
 * RUNNER: vitest.
 */

import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

import { useSessionStore } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { useChatSessionState } from './useChatSessionState';

const noOp = () => {};
type Props = { project: any; session: any };

function mount(initial: Props) {
  return renderHook(({ project, session }: Props) => {
    const store = useSessionStore();
    const pending = useRef(null);
    const state = useChatSessionState({
      selectedSession: session, selectedProject: project, ws: null, sendMessage: noOp,
      resetStreamingState: noOp, pendingViewSessionRef: pending, sessionStore: store,
    });
    return { store, ...state };
  }, { initialProps: initial });
}

const usageCalls = () => authenticatedFetch.mock.calls.filter(([url]) => String(url).includes('/token-usage'));

beforeEach(() => {
  localStorage.setItem('selected-provider', 'claude');
  publishServerCapabilities({ lightHistoryReady: false });
  authenticatedFetch.mockReset().mockImplementation(async (url: string) => (String(url).includes('/messages')
    ? { ok: true, json: async () => ({ messages: [], total: 0, hasMore: false, nextCursor: null }) }
    : { ok: true, json: async () => ({ used: 1, total: 100 }) }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('B-1666 #9 — token usage follows projectId, not the project object', () => {
  it('a new project object with the same id does not refetch; a different id does', async () => {
    const session = { id: 's1', __provider: 'claude' };
    const view = mount({ project: { projectId: 'p1', path: '/a', fullPath: '/a' }, session });
    await waitFor(() => expect(usageCalls()).toHaveLength(1));

    view.rerender({ project: { projectId: 'p1', path: '/a', fullPath: '/a', updatedAt: 'x' }, session });
    view.rerender({ project: { projectId: 'p1', path: '/a', fullPath: '/a', updatedAt: 'y' }, session });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(usageCalls()).toHaveLength(1);

    view.rerender({ project: { projectId: 'p2', path: '/b', fullPath: '/b' }, session });
    await waitFor(() => expect(usageCalls()).toHaveLength(2));
    expect(String(usageCalls()[1][0])).toContain('/api/projects/p2/');
  });
});

describe('B-1666 #10 — optimistic rows carry the session provider', () => {
  const project = { projectId: 'p1', path: '/a', fullPath: '/a' };
  const userRow = (content: string) => ({ type: 'user', content, timestamp: new Date(), id: `cmid_${content}` } as any);

  it('an OpenCode session stamps opencode while the picker says claude', async () => {
    const view = mount({ project, session: { id: 'oc-1', __provider: 'opencode' } });
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));

    act(() => { view.result.current.addMessage(userRow('hello')); });
    const row = view.result.current.store.getMessages('oc-1').find((m) => m.role === 'user');
    expect(row?.provider).toBe('opencode');
  });

  it('a brand-new session falls back to the picker the message was sent with', async () => {
    localStorage.setItem('selected-provider', 'codex');
    const view = mount({ project, session: null });
    act(() => { view.result.current.setCurrentSessionId('fresh-1'); });

    act(() => { view.result.current.addMessage(userRow('first')); });
    const row = view.result.current.store.getMessages('fresh-1').find((m) => m.role === 'user');
    expect(row?.provider).toBe('codex');
  });
});

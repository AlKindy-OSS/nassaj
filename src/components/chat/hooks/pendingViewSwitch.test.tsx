/**
 * B-1666 #1 (critic) — a new-chat send's pending-view guard must not outlive a
 * switch to an existing session. Otherwise returning to the new-chat screen
 * keeps `currentSessionId` on that session (and its processing state) because
 * the stale guard holds the reset back.
 *
 * RUNNER: vitest.
 */

import { useRef } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

import { useSessionStore } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { useChatSessionState } from './useChatSessionState';

const PROJECT = { projectId: 'p1', path: '/synthetic', fullPath: '/synthetic' } as any;
const noOp = () => {};

type Pending = {
  sessionId: string | null; startedAt: number; clientMsgId?: string;
  projectId?: string | null; originSessionId?: string | null;
};

function mount(pendingInit: Pending | null, initialId: string | null = null) {
  return renderHook(({ id }: { id: string | null }) => {
    const store = useSessionStore();
    const pending = useRef<Pending | null>(pendingInit);
    const state = useChatSessionState({
      selectedSession: id ? ({ id, __provider: 'claude' } as any) : null,
      selectedProject: PROJECT, ws: null, sendMessage: noOp, resetStreamingState: noOp,
      pendingViewSessionRef: pending as any, sessionStore: store,
    });
    return { pending, ...state };
  }, { initialProps: { id: initialId } as { id: string | null } });
}

beforeEach(() => {
  publishServerCapabilities({ lightHistoryReady: false });
  authenticatedFetch.mockReset().mockImplementation(async (url: string) => (url.includes('/messages')
    ? { ok: true, json: async () => ({ messages: [], total: 0, hasMore: false, nextCursor: null }) }
    : { ok: false, status: 404, json: async () => ({}) }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('B-1666 — send from new chat, open B, return to new chat', () => {
  it('opening an existing session releases the abandoned send guard', async () => {
    const view = mount({ sessionId: null, startedAt: Date.now(), clientMsgId: 'cmid-1', projectId: 'p1' });

    view.rerender({ id: 'sess-B' });
    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-B'));
    expect(view.result.current.pending.current).toBeNull();

    view.rerender({ id: null });
    await waitFor(() => expect(view.result.current.currentSessionId).toBeNull());
  });

  it('the router catching up with the minted id still releases the guard (B-1386)', async () => {
    const view = mount({ sessionId: 'sess-new', startedAt: Date.now(), clientMsgId: 'cmid-1', projectId: 'p1' });

    view.rerender({ id: 'sess-new' });
    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-new'));
    expect(view.result.current.pending.current).toBeNull();
  });
});

describe('B-1666 — new conversation started from the session on screen', () => {
  const fromDead = (): Pending => ({
    sessionId: null, startedAt: Date.now(), clientMsgId: 'cmid_restart', projectId: 'p1', originSessionId: 'sess-A',
  });

  it('keeps the guard while the session it left from stays selected', async () => {
    const view = mount(null, 'sess-A');
    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-A'));

    view.result.current.pending.current = fromDead();
    view.rerender({ id: 'sess-A' });

    expect(view.result.current.pending.current?.clientMsgId).toBe('cmid_restart');
  });

  it('releases the guard when the user opens another session', async () => {
    const view = mount(null, 'sess-A');
    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-A'));

    view.result.current.pending.current = fromDead();
    view.rerender({ id: 'sess-B' });

    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-B'));
    expect(view.result.current.pending.current).toBeNull();
  });

  it('releases the guard and resets the view on a return to the new-chat screen', async () => {
    const view = mount(null, 'sess-A');
    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-A'));

    view.result.current.pending.current = fromDead();
    view.rerender({ id: null });

    await waitFor(() => expect(view.result.current.currentSessionId).toBeNull());
    expect(view.result.current.pending.current).toBeNull();
  });

  it('holds through router lag once the new id is minted, then releases on arrival', async () => {
    const view = mount(null, 'sess-A');
    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-A'));

    view.result.current.pending.current = { ...fromDead(), sessionId: 'sess-new' };
    view.rerender({ id: 'sess-A' });
    expect(view.result.current.pending.current?.sessionId).toBe('sess-new');

    view.rerender({ id: 'sess-new' });
    await waitFor(() => expect(view.result.current.currentSessionId).toBe('sess-new'));
    expect(view.result.current.pending.current).toBeNull();
  });
});

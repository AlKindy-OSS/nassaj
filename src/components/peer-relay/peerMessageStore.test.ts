import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  applyPeerMessage, ingestPeerMessageFrame, loadPeerMessagesForSession, parsePeerMessageFrame,
  resetPeerMessages, selectPeerMessagesForSession, usePeerMessagesForSession, type PeerMessageView,
} from './peerMessageStore';

const message = (over: Record<string, unknown> = {}) => ({
  id: 'pm-1', chainId: 'pm-1', parentId: null, hop: 0, state: 'queued', cause: null,
  fromSessionId: 'a', fromUserId: 1, fromName: 'Sender', fromMode: 'bypass', toSessionId: 'b',
  toUserId: 1, summary: null, body: 'hi', bodyBytes: 2, costUsdCharged: null,
  createdAt: 1000, updatedAt: 1000, deliveredAt: null, ...over,
});
const frame = (over: Record<string, unknown> = {}) => ({
  type: 'peer-message', version: 1, sessionIds: ['a', 'b'], message: message(over),
});

afterEach(() => resetPeerMessages());

describe('parsePeerMessageFrame', () => {
  it('accepts a v1 frame and drops server-only fields', () => {
    const view = parsePeerMessageFrame(frame());
    expect(view?.fromName).toBe('Sender');
    expect(view).not.toHaveProperty('fromUserId');
  });

  it.each([
    ['wrong version', { ...frame(), version: 2 }],
    ['unknown state', frame({ state: 'hacked' })],
    ['missing target', frame({ toSessionId: '' })],
    ['non-string body', frame({ body: { html: '<b>' } })],
    ['bad time', frame({ createdAt: 'now' })],
  ])('rejects %s', (_name, input) => {
    expect(parsePeerMessageFrame(input)).toBeNull();
  });
});

describe('store', () => {
  const hook = () => renderHook(() => usePeerMessagesForSession('a'));

  it('ingests only peer-message frames and keeps the newest state per id', () => {
    const { result } = hook();
    expect(ingestPeerMessageFrame({ type: 'session-status' })).toBe(false);
    act(() => {
      expect(ingestPeerMessageFrame(frame())).toBe(true);
      ingestPeerMessageFrame(frame({ state: 'delivered', updatedAt: 3000 }));
      ingestPeerMessageFrame(frame({ state: 'delivering', updatedAt: 2000 }));
    });
    expect(result.current.map((m) => m.state)).toEqual(['delivered']);
  });

  it('swallows a malformed peer frame without storing it', () => {
    const { result } = hook();
    act(() => { expect(ingestPeerMessageFrame(frame({ state: 'hacked' }))).toBe(true); });
    expect(result.current).toEqual([]);
  });

  it('clears on an identity change', () => {
    const { result } = hook();
    act(() => { applyPeerMessage(parsePeerMessageFrame(frame())!); });
    expect(result.current).toHaveLength(1);
    act(() => { window.dispatchEvent(new Event('auth:identity-changing')); });
    expect(result.current).toEqual([]);
  });

  it('selects messages from or to a session, oldest first', () => {
    const all = new Map<string, PeerMessageView>();
    for (const f of [frame({ id: 'x', createdAt: 2 }), frame({ id: 'y', createdAt: 1 }),
      frame({ id: 'z', fromSessionId: 'c', toSessionId: 'd' })]) {
      const v = parsePeerMessageFrame(f)!;
      all.set(v.id, v);
    }
    expect(selectPeerMessagesForSession(all, 'b').map((m) => m.id)).toEqual(['y', 'x']);
    expect(selectPeerMessagesForSession(all, null)).toEqual([]);
  });
});

describe('toName and history', () => {
  it('carries the server toName and seeds the store from the history route', async () => {
    expect(parsePeerMessageFrame(frame({ toName: 'Beta' }))!.toName).toBe('Beta');
    expect(parsePeerMessageFrame(frame())!.toName).toBe('');
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ success: true,
      data: { messages: [message({ id: 'h1', toName: 'Beta' }), { id: 'bad' }] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await loadPeerMessagesForSession('b');
    vi.unstubAllGlobals();
    const { result } = renderHook(() => usePeerMessagesForSession('b'));
    expect(result.current.map((m) => m.id)).toEqual(['h1']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/sessions/b/peer-messages');
  });
});

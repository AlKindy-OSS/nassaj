import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));

import { chatMessageToNormalized } from '../components/chat/hooks/useChatSessionState';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import { createClientMsgId } from '../components/chat/utils/messageOutbox';

import { useSessionStore, type NormalizedMessage } from './useSessionStore';

type HistorySnapshot = Parameters<ReturnType<typeof useSessionStore>['applyHistorySnapshot']>[1];
const sessionId = 'user-message-identity';
const snapshot = (messages: NormalizedMessage[]): HistorySnapshot => ({
  messages, total: messages.length, hasMore: false, nextCursor: null, tokenUsage: null,
  responseTurnDurationTotalMs: null, historySchema: 1, payloadMode: 'full', revision: 'r1',
});
const user = (): NormalizedMessage => ({
  id: createClientMsgId(), sessionId, kind: 'text', role: 'user', provider: 'claude',
  content: 'هذه رسالتي الجديدة', timestamp: new Date().toISOString(),
});

beforeEach(() => { authenticatedFetch.mockReset(); });

describe('the actual composer cmid identity survives history reconciliation', () => {
  it.each(['refreshFromServer', 'applyHistorySnapshot', 'applyHistoryEnrichment'] as const)(
    '%s preserves the sent user message when history has not caught up', async method => {
      const { result } = renderHook(() => useSessionStore());
      const row = user();
      expect(row.id).toMatch(/^cmid_/);
      act(() => result.current.appendRealtime(sessionId, row));
      authenticatedFetch.mockResolvedValue({ ok: true, json: async () => snapshot([]) });
      await act(async () => {
        if (method === 'refreshFromServer') expect(await result.current.refreshFromServer(sessionId)).toBe(true);
        else result.current[method](sessionId, snapshot([]));
      });
      expect(result.current.getMessages(sessionId)).toEqual([row]);
    },
  );

  it('does not mistake an older identical prompt for this new send', () => {
    const { result } = renderHook(() => useSessionStore());
    const row = user();
    const old = { ...row, id: 'older-user-message', clientMsgId: createClientMsgId() };
    act(() => {
      result.current.appendRealtime(sessionId, row);
      result.current.applyHistorySnapshot(sessionId, snapshot([old]));
    });
    expect(result.current.getMessages(sessionId).map(message => message.id)).toEqual([old.id, row.id]);
  });

  it('keeps two equal sends distinct while one canonical identity is acknowledged', () => {
    const { result } = renderHook(() => useSessionStore());
    const first = user();
    const second = user();
    const canonical = { ...first, id: 'canonical-first', clientMsgId: first.id };
    act(() => {
      result.current.applyHistorySnapshot(sessionId, snapshot([canonical]));
      result.current.appendRealtime(sessionId, first);
      result.current.appendRealtime(sessionId, second);
    });
    expect(result.current.getMessages(sessionId).map(row => row.id)).toEqual([canonical.id, second.id]);
    act(() => result.current.applyHistoryEnrichment(sessionId, snapshot([canonical])));
    expect(result.current.getMessages(sessionId).map(row => row.id)).toEqual([canonical.id, second.id]);
  });

  it('does not hide the send behind a legacy identical prompt without identity', () => {
    const { result } = renderHook(() => useSessionStore());
    const row = user();
    const older = { ...row, id: 'legacy-prompt', timestamp: '2020-01-01T00:00:00.000Z' };
    act(() => {
      result.current.applyHistorySnapshot(sessionId, snapshot([older]));
      result.current.appendRealtime(sessionId, row);
    });
    expect(result.current.getMessages(sessionId)).toHaveLength(2);
    act(() => result.current.applyHistorySnapshot(sessionId, snapshot([older])));
    expect(result.current.getMessages(sessionId)).toHaveLength(2);
  });

  it('does not reuse a legacy transcript text match during refresh and rendering', async () => {
    const { result } = renderHook(() => useSessionStore());
    const first = { ...user(), id: 'local_legacy_first' };
    const second = { ...user(), id: 'local_legacy_second' };
    const saved = { ...first, id: 'saved-legacy-row' };
    authenticatedFetch.mockResolvedValue({ ok: true, json: async () => snapshot([saved]) });
    act(() => {
      result.current.appendRealtime(sessionId, first);
      result.current.appendRealtime(sessionId, second);
    });
    await act(async () => {
      expect(await result.current.refreshFromServer(sessionId)).toBe(true);
    });
    expect(result.current.getMessages(sessionId).map(row => row.id))
      .toEqual([saved.id, first.id, second.id]);
  });

  it('does not let a legacy text match consume an exact current composer identity', () => {
    const { result } = renderHook(() => useSessionStore());
    const current = user();
    const legacy = { ...current, id: 'local_legacy_earlier' };
    act(() => {
      result.current.appendRealtime(sessionId, legacy);
      result.current.appendRealtime(sessionId, current);
      result.current.applyHistorySnapshot(sessionId, snapshot([current]));
    });
    expect(result.current.getMessages(sessionId).map(row => row.id)).toEqual([current.id, legacy.id]);
  });

  it('preserves attachment-only content through the real composer mapper, history and renderer', () => {
    const { result } = renderHook(() => useSessionStore());
    const id = createClientMsgId();
    const image = { data: '/api/images/example', name: 'example.png' };
    const file = { name: 'example.txt', path: '/files/example.txt' };
    const row = chatMessageToNormalized({
      id, type: 'user', content: '', timestamp: new Date(), images: [image], files: [file],
    }, sessionId, 'claude')!;
    act(() => {
      result.current.appendRealtime(sessionId, row);
      result.current.applyHistoryEnrichment(sessionId, snapshot([]));
    });
    const displayed = normalizedToChatMessages(result.current.getMessages(sessionId));
    expect(displayed).toHaveLength(1);
    expect(displayed[0].images?.[0].data).toBe(image.data);
    expect(displayed[0].files).toEqual([file]);
  });

  it('retires the optimistic row once the canonical message carries its exact client identity', () => {
    const { result } = renderHook(() => useSessionStore());
    const row = user();
    const canonical = { ...row, id: 'canonical-user-message', clientMsgId: row.id };
    act(() => {
      result.current.appendRealtime(sessionId, row);
      result.current.applyHistorySnapshot(sessionId, snapshot([canonical]));
    });
    expect(result.current.getMessages(sessionId)).toEqual([canonical]);
    expect(result.current.getSlot(sessionId).realtimeMessages).toHaveLength(0);
  });
});

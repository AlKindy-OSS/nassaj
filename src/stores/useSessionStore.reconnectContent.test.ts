import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import { useSessionStore, type NormalizedMessage } from './useSessionStore';

type HistorySnapshot = Parameters<ReturnType<typeof useSessionStore>['applyHistorySnapshot']>[1];

const sessionId = 'reconnect-content';
const content = 'نص وصل عبر البث';
const reply = (responseToMessageId = 'turn-1'): NormalizedMessage => ({
  id: 'persisted-reply', sessionId, provider: 'claude', kind: 'text', role: 'assistant',
  timestamp: new Date().toISOString(), content, responseToMessageId,
});
const response = (messages: NormalizedMessage[]) => ({
  ok: true, json: async () => ({ messages, total: messages.length }),
});

beforeEach(() => { authenticatedFetch.mockReset(); });

describe('reconnect preserves streamed content until the persisted reply covers it', () => {
  it('preserves the only copy when REST fails', async () => {
    authenticatedFetch.mockResolvedValue({ ok: false, status: 503 });
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1'));
    let ok = true;
    await act(async () => { ok = await result.current.mergeTailFromServer(sessionId); });
    expect(ok).toBe(false);
    expect(result.current.getMessages(sessionId).map(row => row.content)).toContain(content);
  });

  it.each([{ messages: [] }, { messages: [reply('older-turn')] }])('preserves content when a successful tail has no matching run: %j', async ({ messages }) => {
    authenticatedFetch.mockResolvedValue(response(messages));
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1'));
    await act(async () => { await result.current.mergeTailFromServer(sessionId); });
    expect(result.current.getSlot(sessionId).realtimeMessages).toHaveLength(1);
  });

  it('removes the captured placeholder only when the same persisted run contains its text', async () => {
    authenticatedFetch.mockResolvedValue(response([reply()]));
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1'));
    await act(async () => { await result.current.mergeTailFromServer(sessionId); });
    expect(result.current.getSlot(sessionId).realtimeMessages).toHaveLength(0);
    expect(result.current.getMessages(sessionId).map(row => row.id)).toEqual(['persisted-reply']);
  });

  it('preserves a legacy stream when REST supplies no run identity', async () => {
    authenticatedFetch.mockResolvedValue(response([{ ...reply(), responseToMessageId: undefined }]));
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(sessionId, content, 'claude'));
    await act(async () => { await result.current.mergeTailFromServer(sessionId); });
    expect(result.current.getSlot(sessionId).realtimeMessages).toHaveLength(1);
  });

  it('rotates a preserved older run before accepting a new run and its attribution', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(sessionId, 'الأول', 'claude', { coordinatorId: 1 }, 'turn-1'));
    act(() => result.current.updateStreaming(sessionId, 'الثاني', 'claude', { coordinatorId: 2 }, 'turn-2'));
    expect(result.current.getMessages(sessionId).map(row => [row.content, row.responseToMessageId, row.coordinatorId]))
      .toEqual([['الأول', 'turn-1', 1], ['الثاني', 'turn-2', 2]]);
  });

  it('does not erase a newer delta while the REST request is pending', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    authenticatedFetch.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1'));
    let recovery!: Promise<boolean>;
    act(() => { recovery = result.current.mergeTailFromServer(sessionId); });
    act(() => result.current.updateStreaming(sessionId, `${content} ثم وصل جديد`, 'claude', undefined, 'turn-1'));
    await act(async () => { resolve(response([reply()])); await recovery; });
    expect(result.current.getSlot(sessionId).realtimeMessages[0].content).toBe(`${content} ثم وصل جديد`);
  });
});


describe('full refresh preserves live changes across the request boundary', () => {
  it('keeps a finalized response absent from a lagging full history', async () => {
    authenticatedFetch.mockResolvedValue(response([]));
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1');
      result.current.finalizeStreaming(sessionId);
    });
    await act(async () => { await result.current.refreshFromServer(sessionId); });
    expect(result.current.getMessages(sessionId).map(row => row.content)).toEqual([content]);
  });

  it('does not treat a different canonical message in the same run as a persisted counterpart', async () => {
    authenticatedFetch.mockResolvedValue(response([{ ...reply(), content: 'تم التنفيذ' }]));
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.appendRealtime(sessionId, { ...reply(), id: 'text_canonical-commentary', content: 'تم' }));
    await act(async () => { await result.current.refreshFromServer(sessionId); });
    expect(result.current.getMessages(sessionId).map(row => row.content)).toContain('تم');
    expect(result.current.getMessages(sessionId)).toHaveLength(2);
  });

  it('retires a captured finalized response once a matching persisted run covers it', async () => {
    authenticatedFetch.mockResolvedValue(response([reply()]));
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1');
      result.current.finalizeStreaming(sessionId);
    });
    await act(async () => { await result.current.refreshFromServer(sessionId); });
    expect(result.current.getSlot(sessionId).realtimeMessages).toHaveLength(0);
    expect(result.current.getMessages(sessionId).map(row => row.id)).toEqual(['persisted-reply']);
  });

  it('keeps the latest delta and a new run when full REST settles with an older reply', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    authenticatedFetch.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1'));
    let refresh!: Promise<boolean>;
    act(() => { refresh = result.current.refreshFromServer(sessionId); });
    act(() => {
      result.current.updateStreaming(sessionId, `${content} والمزيد`, 'claude', undefined, 'turn-1');
      result.current.updateStreaming(sessionId, 'رد الجولة التالية', 'claude', undefined, 'turn-2');
    });
    await act(async () => { resolve(response([reply()])); await refresh; });
    expect(result.current.getSlot(sessionId).realtimeMessages.map(row => row.content))
      .toEqual([`${content} والمزيد`, 'رد الجولة التالية']);
  });
});


describe.each(['applyHistorySnapshot', 'applyHistoryEnrichment'] as const)('%s retains unconfirmed assistant rows', method => {
  const snapshot = (messages: NormalizedMessage[]): HistorySnapshot => ({
    messages, total: messages.length, hasMore: false, nextCursor: null,
    revision: 'history-1', payloadMode: 'full', responseTurnDurationTotalMs: null,
    tokenUsage: null, historySchema: null,
  });

  it('preserves a live delta and finalized reply absent from the history response', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(sessionId, 'رد مكتمل', 'claude', undefined, 'turn-0');
      result.current.finalizeStreaming(sessionId);
      result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1');
      result.current[method](sessionId, snapshot([]));
    });
    expect(result.current.getMessages(sessionId).map(row => row.content)).toEqual(['رد مكتمل', content]);
  });

  it('retires a captured matching reply without hiding a different current run', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-1');
      result.current.finalizeStreaming(sessionId);
      result.current.updateStreaming(sessionId, content, 'claude', undefined, 'turn-2');
      result.current[method](sessionId, snapshot([reply()]));
    });
    expect(result.current.getSlot(sessionId).realtimeMessages.map(row => row.responseToMessageId)).toEqual(['turn-2']);
    expect(result.current.getMessages(sessionId)).toHaveLength(2);
  });
});

it('B-894 forwards abort to history and never applies its late response', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  authenticatedFetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useSessionStore());
  const controller = new AbortController();
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.refreshFromServer('cancelled-history', { signal: controller.signal }); });
  expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/sessions/cancelled-history/messages', { signal: controller.signal });
  controller.abort();
  await act(async () => { finish(response([reply()])); await pending; });
  expect(result.current.getMessages('cancelled-history')).toHaveLength(0);
});

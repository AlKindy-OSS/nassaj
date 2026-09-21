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
const row = (id: string): NormalizedMessage => ({ id, sessionId: 's1', kind: 'text', role: 'assistant', provider: 'claude', timestamp: '2026-09-07T00:00:00Z', content: id });
const success = (id = 'held') => ({ ok: true, json: async () => ({ messages: [row(id)], total: 40, hasMore: true, nextCursor: 'held-cursor' }) });
const failure = (status: number, code: string) => ({ ok: false, status, headers: new Headers(status === 503 ? { 'Retry-After': '5' } : {}), json: async () => ({ error: { code } }) });
const failures = [[413, 'HISTORY_BUDGET_EXCEEDED'], [409, 'HISTORY_SOURCE_INCOMPLETE'], [409, 'HISTORY_REVISION_CHANGED'], [409, 'CURSOR_STALE'], [503, 'HISTORY_BUSY'], [504, 'HISTORY_TIMEOUT']] as const;
let historyResponse: () => Promise<any>;
const historyCalls = () => authenticatedFetch.mock.calls.filter(([url]) => url.includes('/messages'));
function mount() {
  return renderHook(({ id, external = 0 }: { id: string; external?: number }) => {
    const store = useSessionStore();
    const pending = useRef(null);
    const state = useChatSessionState({ selectedSession: { id, __provider: 'claude' } as any,
      selectedProject: project, ws: null, sendMessage: noOp, resetStreamingState: noOp,
      pendingViewSessionRef: pending, sessionStore: store, externalMessageUpdate: external });
    return { store, ...state };
  }, { initialProps: { id: 's1' } as { id: string; external?: number } });
}
beforeEach(() => {
  publishServerCapabilities({ lightHistoryReady: false });
  authenticatedFetch.mockReset().mockImplementation((url: string) => url.includes('/messages')
    ? historyResponse() : Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));
  historyResponse = async () => success();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('C3 actual store and chat loading transitions', () => {
  it.each(failures)('shows initial %i %s, retains an empty-unavailable distinction, and never loops', async (status, code) => {
    historyResponse = async () => failure(status, code);
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    expect(result.current.chatMessages).toHaveLength(0);
    expect(result.current.historyError).toMatchObject({ code, operation: 'initial' });
    expect(historyCalls()).toHaveLength(1);
  });
  it.each(failures)('older/all %i %s keep bookmarks, pending input and completion false', async (status, code) => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    const container = document.createElement('div');
    act(() => {
      (result.current.scrollContainerRef as any).current = container;
      result.current.store.appendRealtime('s1', { ...row('cmid_pending'), content: 'pending', role: 'user', clientMsgId: 'draft-id' });
    });
    historyResponse = async () => failure(status, code);
    await act(async () => { await result.current.loadMoreMessages(); });
    expect(result.current.hasMoreMessages).toBe(true);
    expect(result.current.totalMessages).toBe(40);
    expect(result.current.store.getSlot('s1').historyCursor).toBe('held-cursor');
    if (status !== 503) await act(async () => { await result.current.loadAllMessages(); });
    expect(result.current.allMessagesLoaded).toBe(false);
    expect(result.current.loadAllJustFinished).toBe(false);
    expect(result.current.isLoadingAllMessages).toBe(false);
    expect(result.current.chatMessages.map(message => message.content)).toContain('pending');
    expect(result.current.historyError?.code).toBe(code);
    expect(historyCalls()).toHaveLength(status === 503 ? 2 : 3);
  });
  it('manual recovery falls back once when the advertised light capability was disabled', async () => {
    publishServerCapabilities({ capabilities: { lightHistory: { supported: true, enabled: true, schema: 1 } } });
    historyResponse = async () => failure(502, 'HISTORY_UNAVAILABLE');
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    expect(result.current.historyError?.status).toBe(502);
    const queued = [failure(409, 'LIGHT_HISTORY_DISABLED'), success('recovered')];
    historyResponse = async () => queued.shift();
    await act(async () => { await result.current.retryHistory(); });
    expect(historyCalls()).toHaveLength(3);
    expect(historyCalls()[1][0]).toContain('payload=light');
    expect(historyCalls()[2][0]).not.toContain('payload=');
    expect(result.current.historyError).toBeNull();
    expect(result.current.chatMessages[0].content).toBe('recovered');
  });
  it('explicit revision recovery keeps held/pending rows until successful refresh', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    act(() => {
      result.current.store.appendRealtime('s1', { ...row('cmid_pending'), content: 'pending', role: 'user' });
      result.current.store.setHistoryError('s1', { ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null }, 'older');
    });
    let finish!: (response: ReturnType<typeof success>) => void;
    historyResponse = () => new Promise(resolve => { finish = resolve; });
    let retry!: Promise<void>;
    act(() => { retry = result.current.retryHistory(); });
    expect(result.current.chatMessages.map(message => message.content)).toEqual(['held', 'pending']);
    await act(async () => { finish(success('new')); await retry; });
    expect(result.current.chatMessages.map(message => message.content)).toEqual(['new', 'pending']);
    expect(result.current.historyError).toBeNull();
    expect(historyCalls()).toHaveLength(2);
  });
  it.each(['initial', 'all', 'older'] as const)('late %s failure cannot change the new session', async operation => {
    let finish!: (response: ReturnType<typeof failure>) => void;
    if (operation === 'initial') historyResponse = () => new Promise(resolve => { finish = resolve; });
    const { result, rerender } = mount();
    let old: Promise<unknown> | undefined;
    if (operation !== 'initial') {
      await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
      historyResponse = () => new Promise(resolve => { finish = resolve; });
      act(() => {
        (result.current.scrollContainerRef as any).current = document.createElement('div');
        old = operation === 'all' ? result.current.loadAllMessages() : result.current.loadMoreMessages();
      });
    }
    historyResponse = async () => success('session-two');
    rerender({ id: 's2' });
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    await act(async () => { finish(failure(413, 'HISTORY_BUDGET_EXCEEDED')); await old; });
    expect(result.current.historyError).toBeNull();
    expect(result.current.chatMessages.map(message => message.content)).toEqual(['session-two']);
    expect(result.current.isLoadingMoreMessages).toBe(false);
    expect(result.current.isLoadingAllMessages).toBe(false);
    expect(result.current.loadAllJustFinished).toBe(false);
  });
  it('recovers actual CURSOR_STALE only manually, without reusing cursor or revision', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    act(() => { (result.current.scrollContainerRef as any).current = document.createElement('div'); });
    historyResponse = async () => failure(409, 'CURSOR_STALE');
    await act(async () => { await result.current.loadMoreMessages(); });
    expect(historyCalls()[1][0]).toContain('cursor=held-cursor');
    expect(result.current.historyError?.code).toBe('CURSOR_STALE');
    let finish!: (value: ReturnType<typeof success>) => void;
    historyResponse = () => new Promise(resolve => { finish = resolve; });
    let pending!: Promise<void>;
    act(() => { pending = result.current.retryHistory(); });
    const url = new URL(historyCalls()[2][0], 'https://synthetic.test');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('revision')).toBe(false);
    expect(result.current.chatMessages[0].content).toBe('held');
    await act(async () => { finish(success('rebased')); await pending; });
    expect(result.current.chatMessages[0].content).toBe('rebased');
    expect(result.current.historyError).toBeNull();
    expect(historyCalls()).toHaveLength(3);
  });
  it.each([[413, 'HISTORY_BUDGET_EXCEEDED'], [409, 'HISTORY_SOURCE_INCOMPLETE'], [409, 'CURSOR_STALE']])(
    'external update does not automatically retry %i %s', async (status, code) => {
      historyResponse = async () => failure(Number(status), String(code));
      const { result, rerender } = mount();
      await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
      rerender({ id: 's1', external: 1 });
      rerender({ id: 's1', external: 2 });
      expect(historyCalls()).toHaveLength(1);
      expect(result.current.historyError?.code).toBe(code);
      expect(authenticatedFetch.mock.calls.some(([url]) => !url.includes('/messages'))).toBe(true);
    });
  it('external update respects Retry-After and admits only one read for an eligible update', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    historyResponse = async () => failure(503, 'HISTORY_BUSY');
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    rerender({ id: 's1', external: 1 });
    clock.mockReturnValue(now + 4999);
    rerender({ id: 's1', external: 2 });
    expect(historyCalls()).toHaveLength(1);
    clock.mockReturnValue(now + 5000);
    historyResponse = async () => success('after-wait');
    rerender({ id: 's1', external: 3 });
    await waitFor(() => expect(result.current.historyError).toBeNull());
    rerender({ id: 's1', external: 3 });
    expect(historyCalls()).toHaveLength(2);
    expect(result.current.chatMessages[0].content).toBe('after-wait');
  });
  it.each(['initial', 'manual'] as const)('old raw %s snapshot cannot clear a newer same-session error', async mode => {
    let finish!: (value: ReturnType<typeof success>) => void;
    if (mode === 'initial') historyResponse = () => new Promise(resolve => { finish = resolve; });
    const { result } = mount();
    let pending: Promise<void> | undefined;
    if (mode === 'manual') {
      await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
      act(() => result.current.store.setHistoryError('s1', { ok: false, status: 409, code: 'CURSOR_STALE', retryAfterMs: null }, 'older'));
      historyResponse = () => new Promise(resolve => { finish = resolve; });
      act(() => { pending = result.current.retryHistory(); });
    }
    act(() => result.current.store.setHistoryError('s1', { ok: false, status: 413, code: 'HISTORY_BUDGET_EXCEEDED', retryAfterMs: null }, 'all'));
    await act(async () => { finish(success('stale-response')); await pending; });
    expect(result.current.historyError?.code).toBe('HISTORY_BUDGET_EXCEEDED');
    expect(result.current.chatMessages.some(row => row.content === 'stale-response')).toBe(false);
    expect(result.current.isLoadingSessionMessages).toBe(false);
  });

});

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '../../../utils/api';

import { useAllScheduledMessages } from './useAllScheduledMessages';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
const fetchMock = vi.mocked(authenticatedFetch);

function message(id: string, status: 'pending' | 'running' | 'failed') {
  return { id, sessionId: `session-${id}`, content: `content-${id}`, options: {}, scheduledFor: '2026-09-05T10:00:00.000Z', status, attempts: 0, maxAttempts: 3, lastErrorCode: null, sentAt: null, createdAt: '', updatedAt: '' };
}

function ok(messages: unknown[], total = messages.length, hasMore = false, nextOffset: number | null = null): Response {
  return new Response(JSON.stringify({ messages, total, hasMore, nextOffset }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('useAllScheduledMessages', () => {
  beforeEach(() => fetchMock.mockReset());

  it('loads and merges all actionable statuses without a session filter', async () => {
    fetchMock.mockImplementation(async (url) => {
      const status = new URL(String(url), 'https://nassaj.test').searchParams.get('status') as 'pending' | 'running' | 'failed';
      return ok([message(status, status)]);
    });
    const { result } = renderHook(() => useAllScheduledMessages());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('sessionId'))).toBe(true);
    expect(result.current.messages.map((item) => item.status).sort()).toEqual(['failed', 'pending', 'running']);
    expect(result.current.total).toBe(3);
  });

  it('loads page 201 after the initial 200 and deduplicates overlapping rows', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => message(`p-${index}`, 'pending'));
    fetchMock.mockImplementation(async (url) => {
      const parsed = new URL(String(url), 'https://nassaj.test');
      const status = parsed.searchParams.get('status');
      const offset = Number(parsed.searchParams.get('offset'));
      if (status !== 'pending') return ok([]);
      if (offset === 0) return ok(firstPage, 201, true, 200);
      return ok([message('p-199', 'pending'), message('p-200', 'pending')], 201, false, null);
    });
    const { result } = renderHook(() => useAllScheduledMessages());
    await waitFor(() => expect(result.current.messages).toHaveLength(200));
    expect(result.current.hasMore).toBe(true);

    await act(async () => { await result.current.loadMore(); });

    expect(result.current.messages).toHaveLength(201);
    expect(result.current.total).toBe(201);
    expect(result.current.hasMore).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=pending&limit=200&offset=200'))).toBe(true);
  });

  it('preserves messages and pagination cursors when a later page fails', async () => {
    fetchMock.mockImplementation(async (url) => {
      const status = new URL(String(url), 'https://nassaj.test').searchParams.get('status');
      return status === 'pending' ? ok([message('trusted', 'pending')], 2, true, 1) : ok([]);
    });
    const { result } = renderHook(() => useAllScheduledMessages());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'offline' }), { status: 503 }));

    await act(async () => { await result.current.loadMore(); });

    expect(result.current.messages.map((item) => item.id)).toEqual(['trusted']);
    expect(result.current.pages.pending).toEqual({ total: 2, hasMore: true, nextOffset: 1 });
    expect(result.current.stale).toBe(true);
  });

  it('invalidates an in-flight next page when refresh replaces its epoch', async () => {
    fetchMock.mockImplementation(async (url) => {
      const parsed = new URL(String(url), 'https://nassaj.test');
      return parsed.searchParams.get('status') === 'pending'
        ? ok([message('trusted', 'pending')], 2, true, 1)
        : ok([]);
    });
    const { result } = renderHook(() => useAllScheduledMessages());
    await waitFor(() => expect(result.current.messages.map((item) => item.id)).toEqual(['trusted']));

    let releaseOldPage!: (response: Response) => void;
    const oldPage = new Promise<Response>((resolve) => { releaseOldPage = resolve; });
    let oldPageSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url), 'https://nassaj.test');
      if (parsed.searchParams.get('offset') === '1') {
        oldPageSignal = init?.signal ?? undefined;
        return oldPage;
      }
      return parsed.searchParams.get('status') === 'pending'
        ? ok([message('fresh', 'pending')], 1, false, null)
        : ok([]);
    });

    let loadMorePromise!: Promise<void>;
    act(() => { loadMorePromise = result.current.loadMore(); });
    await waitFor(() => expect(oldPageSignal).toBeDefined());
    await act(async () => { await result.current.refresh(); });
    expect(oldPageSignal?.aborted).toBe(true);
    expect(result.current.messages.map((item) => item.id)).toEqual(['fresh']);

    await act(async () => {
      releaseOldPage(ok([message('stale-page', 'pending')], 3, true, 2));
      await loadMorePromise;
    });
    expect(result.current.messages.map((item) => item.id)).toEqual(['fresh']);
    expect(result.current.pages.pending).toEqual({ total: 1, hasMore: false, nextOffset: null });
  });

  it('keeps the trusted snapshot and marks it stale when refresh fails', async () => {
    fetchMock.mockImplementation(async (url) => ok(String(url).includes('pending') ? [message('one', 'pending')] : []));
    const { result } = renderHook(() => useAllScheduledMessages());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'offline' }), { status: 503 }));

    await act(async () => { await result.current.refresh(); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.stale).toBe(true);
  });

  it('aborts superseded refreshes and ignores their late data', async () => {
    let release!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { release = resolve; });
    fetchMock.mockImplementationOnce(() => delayed).mockResolvedValue(ok([]));
    const { result } = renderHook(() => useAllScheduledMessages());
    await act(async () => { await result.current.refresh(); });
    await act(async () => { release(ok([message('old', 'pending')])); await delayed; });
    expect(result.current.messages).toEqual([]);
  });

  it('tracks concurrent row mutations independently', async () => {
    fetchMock.mockResolvedValue(ok([]));
    const { result } = renderHook(() => useAllScheduledMessages());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let releaseA!: (value: Response) => void;
    let releaseB!: (value: Response) => void;
    const pendingA = new Promise<Response>((resolve) => { releaseA = resolve; });
    const pendingB = new Promise<Response>((resolve) => { releaseB = resolve; });
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/a')) return pendingA;
      if (String(url).endsWith('/b')) return pendingB;
      return ok([]);
    });

    let mutationA!: Promise<unknown>;
    let mutationB!: Promise<unknown>;
    act(() => {
      mutationA = result.current.cancel('a');
      mutationB = result.current.cancel('b');
    });
    await waitFor(() => expect([...result.current.busyIds].sort()).toEqual(['a', 'b']));
    await act(async () => { releaseA(new Response(null, { status: 204 })); await mutationA; });
    expect([...result.current.busyIds]).toEqual(['b']);
    await act(async () => { releaseB(new Response(null, { status: 204 })); await mutationB; });
    expect(result.current.busyIds.size).toBe(0);
  });
});

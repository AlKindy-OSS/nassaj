import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projection } from './skillObservations.fixtures';

const requests: { url: string; resolve: (value: Response) => void; reject: (error: Error) => void }[] = [];
vi.mock('../../utils/api', () => ({ authenticatedFetch: (url: string) => new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject })) }));
import { useSessionSkills } from './useSessionSkills';
const reply = (status: number, skills = projection()) => ({ status, ok: status === 200, json: async () => ({ success: true, skills }) }) as Response;
beforeEach(() => { requests.length = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('useSessionSkills', () => {
  it('loads a server cursor explicitly, deduplicates evidence, and refreshes expired snapshots without mixing', async () => {
    const first = projection(); first.coverage.nextCursor = 'cursor-1';
    const { result } = renderHook(() => useSessionSkills('one', 'claude', false));
    await act(async () => requests[0].resolve(reply(200, first)));
    act(() => result.current.loadMore?.());
    expect(requests[1].url).toContain('?cursor=cursor-1');
    const next = projection([first.observations[0], { ...first.observations[0], id: 'event-2', skillKey: 'skill-2' }]);
    next.coverage.nextCursor = 'cursor-2';
    await act(async () => requests[1].resolve(reply(200, next)));
    expect(result.current.projection?.observations).toHaveLength(2);
    act(() => result.current.loadMore?.());
    await act(async () => requests[2].resolve(reply(409)));
    expect(result.current.stale).toBe(true);
    expect(result.current.projection?.observations).toHaveLength(2);
    act(() => result.current.refresh());
    expect(requests[3].url).not.toContain('cursor=');
    await act(async () => requests[3].resolve(reply(200, projection([]))));
    expect(result.current.projection?.observations).toHaveLength(0);
  });
  it('shows older server capability as unsupported, never measured empty', async () => {
    const { result } = renderHook(() => useSessionSkills('one', 'claude', false));
    await act(async () => requests[0].resolve(reply(404)));
    expect(result.current.status).toBe('unsupported');
    expect(result.current.projection).toBeNull();
  });
  it('masks old-session data immediately and discards a late response', async () => {
    const { result, rerender } = renderHook(({ id }) => useSessionSkills(id, 'claude', false), { initialProps: { id: 'one' } });
    await act(async () => requests[0].resolve(reply(200)));
    expect(result.current.projection?.summary.observedDistinct).toBe(1);
    act(() => result.current.refresh());
    rerender({ id: 'two' });
    expect(result.current.projection).toBeNull();
    await act(async () => requests[1].resolve(reply(200)));
    expect(result.current.projection).toBeNull();
    await act(async () => requests[2].resolve(reply(200, projection([]))));
    expect(result.current.projection?.summary.observedDistinct).toBe(0);
  });
  it('retains evidence when refresh fails', async () => {
    const { result } = renderHook(() => useSessionSkills('one', 'claude', false));
    await act(async () => requests[0].resolve(reply(200)));
    act(() => result.current.refresh());
    await act(async () => requests[1].reject(new Error('offline')));
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.projection?.summary.observedDistinct).toBe(1);
  });
  it('polls only on bounded active cadence and does not overlap requests', async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(({ active }) => useSessionSkills('one', 'claude', active), { initialProps: { active: true } });
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(requests).toHaveLength(1);
    await act(async () => requests[0].resolve(reply(200)));
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(requests).toHaveLength(2);
    rerender({ active: false });
    expect(requests).toHaveLength(3);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(requests).toHaveLength(3);
    unmount();
  });
});

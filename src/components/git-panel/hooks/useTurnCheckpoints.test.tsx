/** T-2095: data hook of the "Turn changes" git-panel tab. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

import { rememberSessionWorkspaceGeneration } from '../../../utils/sessionWorkspaceBinding';

import { useTurnCheckpoints } from './useTurnCheckpoints';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function turn(turnSeq: number) {
  return {
    turnSeq, status: 'complete', provider: 'claude', startedAt: null, completedAt: '2026-11-18T00:00:00.000Z',
    counts: { added: 1, modified: 0, deleted: 0, withheld: 0 }, files: [{ path: 'a.ts', status: 'A' }], filesTruncated: false,
  };
}

function paramsOf(call: unknown[]) {
  return new URL(String(call[0]), 'https://nassaj.test');
}

beforeEach(() => {
  sessionStorage.clear();
  authenticatedFetch.mockReset();
  rememberSessionWorkspaceGeneration('session-1', 'gen-1');
});
afterEach(cleanup);

describe('useTurnCheckpoints', () => {
  it('reads the list through the bound overlay coordinates', async () => {
    authenticatedFetch.mockResolvedValue(json({ turns: [turn(2), turn(1)], nextBefore: null }));
    const { result } = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: 'session-1' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const url = paramsOf(authenticatedFetch.mock.calls[0]);
    expect(url.pathname).toBe('/api/git/turn-checkpoints');
    expect(url.searchParams.get('project')).toBe('p-1');
    expect(url.searchParams.get('sessionId')).toBe('session-1');
    expect(url.searchParams.get('generation')).toBe('gen-1');
    expect(result.current.turns.map((t) => t.turnSeq)).toEqual([2, 1]);
    expect(result.current.hasOlder).toBe(false);
  });

  it('is not found without a session or without a workspace binding, and never fetches', async () => {
    const none = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: null }));
    expect(none.result.current.status).toBe('notFound');
    const unbound = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: 'legacy' }));
    expect(unbound.result.current.status).toBe('notFound');
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('maps a 404 to one neutral not-found state', async () => {
    authenticatedFetch.mockResolvedValue(json({ error: 'Turn checkpoints not found' }, 404));
    const { result } = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: 'session-1' }));
    await waitFor(() => expect(result.current.status).toBe('notFound'));
  });

  it.each([500, 429])('maps %i to a retryable error, and retry reloads', async (code) => {
    authenticatedFetch.mockResolvedValueOnce(json({ error: 'x' }, code));
    const { result } = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: 'session-1' }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    authenticatedFetch.mockResolvedValueOnce(json({ turns: [turn(1)], nextBefore: null }));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.turns).toHaveLength(1);
  });

  it('loads older turns with the nextBefore cursor and appends them', async () => {
    authenticatedFetch.mockResolvedValueOnce(json({ turns: [turn(5), turn(4)], nextBefore: 4 }));
    const { result } = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: 'session-1' }));
    await waitFor(() => expect(result.current.hasOlder).toBe(true));
    authenticatedFetch.mockResolvedValueOnce(json({ turns: [turn(3)], nextBefore: null }));
    await act(async () => { await result.current.loadOlder(); });
    expect(paramsOf(authenticatedFetch.mock.calls[1]).searchParams.get('before')).toBe('4');
    expect(result.current.turns.map((t) => t.turnSeq)).toEqual([5, 4, 3]);
    expect(result.current.hasOlder).toBe(false);
  });

  it('reads one file diff once and caches it by turn and path', async () => {
    authenticatedFetch.mockResolvedValueOnce(json({ turns: [turn(1)], nextBefore: null }));
    const { result } = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: 'session-1' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    authenticatedFetch.mockResolvedValueOnce(json({ path: 'a.ts', diff: '+x', truncated: true }));
    await act(async () => { await result.current.loadFileDiff(1, 'a.ts'); });
    const url = paramsOf(authenticatedFetch.mock.calls[1]);
    expect(url.pathname).toBe('/api/git/turn-checkpoints/diff');
    expect(url.searchParams.get('turnSeq')).toBe('1');
    expect(url.searchParams.get('path')).toBe('a.ts');
    expect(url.searchParams.get('generation')).toBe('gen-1');
    expect(result.current.fileDiffs['1:a.ts']).toEqual({ status: 'ready', diff: '+x', truncated: true });
    await act(async () => { await result.current.loadFileDiff(1, 'a.ts'); });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a withheld or failed file diff distinct from an unchanged one', async () => {
    authenticatedFetch.mockResolvedValueOnce(json({ turns: [turn(1)], nextBefore: null }));
    const { result } = renderHook(() => useTurnCheckpoints({ projectId: 'p-1', sessionId: 'session-1' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    authenticatedFetch.mockResolvedValueOnce(json({ path: '.env', withheld: true, reason: 'protected_content' }));
    authenticatedFetch.mockResolvedValueOnce(json({ error: 'x' }, 500));
    await act(async () => { await result.current.loadFileDiff(1, '.env'); });
    await act(async () => { await result.current.loadFileDiff(1, 'b.ts'); });
    expect(result.current.fileDiffs['1:.env']).toEqual({ status: 'withheld', reason: 'protected_content' });
    expect(result.current.fileDiffs['1:b.ts']).toEqual({ status: 'unavailable' });
  });
});

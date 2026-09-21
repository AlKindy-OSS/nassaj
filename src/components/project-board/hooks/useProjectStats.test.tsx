import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PendingRequest = {
  url: string;
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
};

const requests: PendingRequest[] = [];

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (url: string) =>
    new Promise<Response>((resolve, reject) => {
      requests.push({ url, resolve, reject });
    }),
}));

import { useProjectStats } from './useProjectStats';

function response(status: number, body: unknown = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const costBody = (totalUsd: number) => ({
  success: true,
  cost: {
    totalUsd,
    complete: true,
    unpricedModels: [],
    assumedModels: [],
  },
});

const statsBody = (totalUsd: number) => ({
  success: true,
  stats: { totalUsd, complete: true, conversations: 1 },
});

const codeBody = (fileCount: number) => ({
  success: true,
  codeStats: {
    fileCount,
    totalBytes: 10,
    totalLines: 1,
    linesCounted: 1,
    complete: true,
    incompleteReasons: [],
  },
});

async function resolveBatch(
  batch: PendingRequest[],
  replies: Array<{ status: number; body?: unknown }>,
) {
  await act(async () => {
    batch.forEach((request, index) => {
      const reply = replies[index];
      request.resolve(response(reply.status, reply.body));
    });
  });
}

beforeEach(() => {
  requests.length = 0;
});

afterEach(cleanup);

describe('useProjectStats', () => {
  it('retains statistics as stale on refresh failure and clears them on project switch', async () => {
    const { result, rerender } = renderHook(({ id }) => useProjectStats(id), { initialProps: { id: 'proj-1' } });
    await resolveBatch(requests.slice(), [{ status: 200, body: costBody(88) }, { status: 200, body: statsBody(88) }, { status: 404 }]);
    act(() => result.current.refresh());
    await resolveBatch(requests.slice(3), [{ status: 200, body: costBody(88) }, { status: 500 }, { status: 404 }]);
    expect(result.current.stats?.totalUsd).toBe(88);
    expect(result.current.stats?.skillsStale).toBe(true);
    rerender({ id: 'proj-2' });
    expect(result.current.stats).toBeNull();
  });
  it('keeps a newer same-project refresh when the initial request finishes last', async () => {
    const { result } = renderHook(() => useProjectStats('proj-1'));
    expect(requests).toHaveLength(3);

    act(() => result.current.refresh());
    expect(requests).toHaveLength(6);
    expect(requests[5].url).toContain('code-stats?force=1');

    await resolveBatch(requests.slice(3, 6), [
      { status: 200, body: costBody(222) },
      { status: 200, body: statsBody(222) },
      { status: 200, body: codeBody(22) },
    ]);
    await waitFor(() => expect(result.current.cost?.totalUsd).toBe(222));

    await resolveBatch(requests.slice(0, 3), [
      { status: 200, body: costBody(111) },
      { status: 200, body: statsBody(111) },
      { status: 200, body: codeBody(11) },
    ]);

    expect(result.current.cost?.totalUsd).toBe(222);
    expect(result.current.stats?.totalUsd).toBe(222);
    expect(result.current.codeStats?.fileCount).toBe(22);
  });

  it('reports an explicit unavailable capability when all endpoints return 404', async () => {
    const { result } = renderHook(() => useProjectStats('proj-1'));

    await resolveBatch(requests, [{ status: 404 }, { status: 404 }, { status: 404 }]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBe('statistics-unavailable');
    expect(result.current.cost).toBeNull();
    expect(result.current.stats).toBeNull();
    expect(result.current.codeStats).toBeNull();
  });

  it('does not mislabel a 404/404/500 result as an empty measured project', async () => {
    const { result } = renderHook(() => useProjectStats('proj-1'));

    await resolveBatch(requests, [{ status: 404 }, { status: 404 }, { status: 500 }]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBe('statistics-load-failed');
  });

  it('reports a load failure when every endpoint fails', async () => {
    const { result } = renderHook(() => useProjectStats('proj-1'));

    await resolveBatch(requests, [{ status: 500 }, { status: 503 }, { status: 500 }]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBe('statistics-load-failed');
  });

  it('renders a valid partial payload without promoting sibling failures to page failure', async () => {
    const { result } = renderHook(() => useProjectStats('proj-1'));

    await resolveBatch(requests, [
      { status: 200, body: costBody(88) },
      { status: 500 },
      { status: 404 },
    ]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.cost?.totalUsd).toBe(88);
    expect(result.current.stats).toBeNull();
    expect(result.current.codeStats).toBeNull();
    expect(result.current.loadError).toBeNull();
  });
});

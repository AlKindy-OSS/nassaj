import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { projectParticipants } = vi.hoisted(() => ({ projectParticipants: vi.fn() }));
vi.mock('../../utils/api', () => ({ api: { projectParticipants } }));
vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ latestMessage: null }),
}));

import { resetParticipantCachesForTests, useProjectParticipants } from './hooks';

const response = (data: Record<string, unknown> = { users: [], agents: [] }) => ({
  ok: true,
  json: async () => ({ success: true, data }),
});

async function loadProject(projectId: string) {
  const hook = renderHook(() => useProjectParticipants(projectId));
  act(() => hook.result.current.load());
  await waitFor(() => expect(hook.result.current.status).toBe('success'));
  hook.unmount();
}

describe('participant cache policy', () => {
  let now = 1_000_000;

  beforeEach(() => {
    resetParticipantCachesForTests();
    projectParticipants.mockReset().mockImplementation(async () => response());
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => vi.restoreAllMocks());

  it('reuses a fresh project roster but expires it after the 30 second TTL', async () => {
    await loadProject('p1');
    await loadProject('p1');
    expect(projectParticipants).toHaveBeenCalledTimes(1);

    now += 30_001;
    await loadProject('p1');
    expect(projectParticipants).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used roster beyond 64 projects', async () => {
    for (let index = 0; index < 65; index += 1) {
      await loadProject(`p${index}`);
    }
    expect(projectParticipants).toHaveBeenCalledTimes(65);

    await loadProject('p0');
    expect(projectParticipants).toHaveBeenCalledTimes(66);
  });

  it('keeps cached-agent metadata while tolerating older responses without it', async () => {
    projectParticipants.mockImplementationOnce(async () => response({
      users: [{ userId: 'u1' }],
      agents: [{ id: 'agent-1' }],
      agentsSource: 'cache',
    }));

    const cached = renderHook(() => useProjectParticipants('cached'));
    act(() => cached.result.current.load());
    await waitFor(() => expect(cached.result.current.status).toBe('success'));
    expect(cached.result.current.agentsSource).toBe('cache');
    cached.unmount();

    const legacy = renderHook(() => useProjectParticipants('legacy'));
    act(() => legacy.result.current.load());
    await waitFor(() => expect(legacy.result.current.status).toBe('success'));
    expect(legacy.result.current.agentsSource).toBeNull();
  });
});

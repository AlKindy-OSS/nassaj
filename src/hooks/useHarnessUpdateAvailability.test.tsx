import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import { useHarnessUpdateAvailability } from './useHarnessUpdateAvailability';

const row = (provider: string, over: Record<string, unknown> = {}) => ({
  provider, state: 'updatable', installedVersion: '1.0.0', latestVersion: '2.0.0', upToDate: false,
  updatable: true, reason: null, checkedAt: '2026-10-10T00:00:00Z', updating: false, activeJobId: null, ...over,
});
const reply = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 300, status, json: async () => body } as Response);

describe('useHarnessUpdateAvailability', () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(cleanup);

  it('collects only harnesses with a newer version, from one request', async () => {
    fetchMock.mockImplementation(() => reply([
      row('claude'),
      row('codex', { upToDate: true }),
      row('qwen', { state: 'unknown', upToDate: null, updatable: false }),
    ]));
    const { result } = renderHook(() => useHarnessUpdateAvailability(false));
    await waitFor(() => expect(result.current.has('claude')).toBe(true));
    expect(result.current.has('codex')).toBe(false);
    expect(result.current.has('qwen')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/providers/version-status');
  });

  it('stays empty when the request fails', async () => {
    fetchMock.mockImplementation(() => reply({}, 500));
    const { result } = renderHook(() => useHarnessUpdateAvailability(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });
});

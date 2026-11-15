/**
 * useLocalOverlay.test.tsx — T-2107 stage 5: each coding agent reads its own
 * overlay route, a malformed row is dropped, and one agent never shows the
 * servers read for another.
 *
 * Run: npx vitest run src/components/chat/hooks/useLocalOverlay.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import { parseLocalOverlay, useLocalOverlay } from './useLocalOverlay';

const fetchMock = vi.fn();
vi.mock('../../../utils/api', () => ({ authenticatedFetch: (url: string) => fetchMock(url) }));

const row = (label: string) => ({
  serverId: label, providerId: `nassaj_local_${label}`, label,
  models: [{ value: `nassaj_local_${label}/m`, label: 'm', contextWindow: 65536, minContextWindow: 28096, eligibility: 'ok' }],
});
const answer = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });

afterEach(() => {
  fetchMock.mockReset();
  cleanup();
});

describe('useLocalOverlay', () => {
  it('reads the overlay route of the body it is given, and nothing while disabled', async () => {
    fetchMock.mockResolvedValue(answer([row('codexbox')]));
    const { result, rerender } = renderHook(({ enabled }) => useLocalOverlay('codex', enabled), {
      initialProps: { enabled: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current?.map((server) => server.label)).toEqual(['codexbox']));
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/codex/local-overlay');
  });

  it('never returns the servers read for another body', async () => {
    fetchMock.mockImplementation(async (url: string) => (
      url.includes('/claude/') ? answer([row('claudebox')]) : new Promise(() => {})));
    const { result, rerender } = renderHook(({ body }) => useLocalOverlay(body, true), {
      initialProps: { body: 'claude' as 'claude' | 'codex' },
    });
    await waitFor(() => expect(result.current?.[0]?.label).toBe('claudebox'));
    rerender({ body: 'codex' });
    expect(result.current).toBeNull();
  });

  it('degrades a failed read to no local block', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useLocalOverlay('claude', true));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});

describe('parseLocalOverlay', () => {
  it('drops a row whose model lacks the body floor', () => {
    const bad = { ...row('x'), models: [{ value: 'nassaj_local_x/m', label: 'm', eligibility: 'ok' }] };
    expect(parseLocalOverlay({ success: true, data: [row('ok'), bad] }).map((server) => server.label)).toEqual(['ok']);
  });
});

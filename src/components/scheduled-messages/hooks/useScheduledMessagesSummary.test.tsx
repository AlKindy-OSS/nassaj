import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '../../../utils/api';
import { announceScheduledMessagesChanged } from '../scheduledMessagesEvents';

import { useScheduledMessagesSummary } from './useScheduledMessagesSummary';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
const fetchMock = vi.mocked(authenticatedFetch);

function summary(pending: number): Response {
  return new Response(JSON.stringify({ counts: { pending, running: 2, failed: 1 } }), { status: 200 });
}

describe('useScheduledMessagesSummary', () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(cleanup);

  it('fetches metadata only when the canary is enabled', async () => {
    fetchMock.mockResolvedValue(summary(3));
    const { result } = renderHook(() => useScheduledMessagesSummary(true));
    await waitFor(() => expect(result.current.total).toBe(6));
    expect(fetchMock).toHaveBeenCalledWith('/api/scheduled-messages/summary', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call the server when disabled', () => {
    renderHook(() => useScheduledMessagesSummary(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes after local invalidation and foreground visibility', async () => {
    fetchMock.mockResolvedValue(summary(1));
    const { result } = renderHook(() => useScheduledMessagesSummary(true));
    await waitFor(() => expect(result.current.total).toBe(4));
    await act(async () => { announceScheduledMessagesChanged(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '../../../utils/api';
import { useScheduledMessages } from './useScheduledMessages';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));

const fetchMock = vi.mocked(authenticatedFetch);

function response(messages: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ messages }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useScheduledMessages session isolation', () => {
  beforeEach(() => fetchMock.mockReset());

  it('ignores a previous session response that arrives after navigation', async () => {
    let releaseOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { releaseOld = resolve; });
    fetchMock.mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('sessionId=old-session')) return oldResponse;
      return response(path.includes('status=pending') ? [{
        id: 'new-message', sessionId: 'new-session', content: 'new content', options: {},
        scheduledFor: '2026-09-04T09:00:00.000Z', status: 'pending', attempts: 0,
        maxAttempts: 3, lastErrorCode: null, sentAt: null, createdAt: '', updatedAt: '',
      }] : []);
    });

    const { result, rerender } = renderHook(
      ({ sessionId }) => useScheduledMessages(sessionId),
      { initialProps: { sessionId: 'old-session' } },
    );
    rerender({ sessionId: 'new-session' });

    await waitFor(() => expect(result.current.messages.map((item) => item.id)).toEqual(['new-message']));
    await act(async () => {
      releaseOld(response([{
        id: 'old-message', sessionId: 'old-session', content: 'old private content',
        options: {}, scheduledFor: '2026-09-04T08:00:00.000Z', status: 'pending',
        attempts: 0, maxAttempts: 3, lastErrorCode: null, sentAt: null,
        createdAt: '', updatedAt: '',
      }]));
      await oldResponse;
    });

    expect(result.current.messages.map((item) => item.id)).toEqual(['new-message']);
  });

  it('marks mutation failures separately from list-loading failures', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('?sessionId=')) return response([]);
      return new Response(JSON.stringify({ error: 'request_failed' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { result } = renderHook(() => useScheduledMessages('session-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.cancel('message-1').catch(() => undefined);
    });

    expect(result.current.errorKind).toBe('action');
  });
});

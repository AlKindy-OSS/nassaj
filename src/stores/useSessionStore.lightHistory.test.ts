import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../utils/api', () => ({ authenticatedFetch }));

import { useSessionStore, type NormalizedMessage } from './useSessionStore';

const row = (id: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp: '2026-09-04T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: 'ready',
  ...extra,
});

describe('light history client contract', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  it('requests the explicit light payload and preserves its opaque revision', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [row('m1')], total: 12, hasMore: true,
        historySchema: 1, payloadMode: 'light', revision: 'rev-a',
      }),
    });
    const { result } = renderHook(() => useSessionStore());
    const response = await result.current.requestHistorySnapshot('s1', {
      limit: 20, offset: 0, payload: 'light',
    });
    expect(authenticatedFetch.mock.calls[0][0]).toContain('limit=20&offset=0&payload=light');
    expect(response.ok && response.snapshot).toMatchObject({ payloadMode: 'light', revision: 'rev-a' });
  });

  it('treats an unmarked old-server response as full', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [row('legacy')], total: 1, hasMore: false }),
    });
    const { result } = renderHook(() => useSessionStore());
    const response = await result.current.requestHistorySnapshot('s1', { payload: 'light' });
    expect(response.ok && response.snapshot.payloadMode).toBe('full');
  });

  it('surfaces the revision mismatch code without mutating the slot', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'HISTORY_REVISION_CHANGED' }),
    });
    const { result } = renderHook(() => useSessionStore());
    const response = await result.current.requestHistorySnapshot('s1', {
      payload: 'full', revision: 'rev-old',
    });
    expect(response).toEqual({ ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null });
    expect(result.current.getSessionSlot('s1')).toBeUndefined();
  });

  it('reads the production nested AppError code for bounded revision recovery', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: { code: 'HISTORY_REVISION_CHANGED' } }),
    });
    const { result } = renderHook(() => useSessionStore());
    const response = await result.current.requestHistorySnapshot('s1', {
      payload: 'full', revision: 'rev-old',
    });
    expect(response).toEqual({ ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null });
  });

  it('falls back once to the legacy full request when rollout capability is stale', async () => {
    authenticatedFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: { code: 'LIGHT_HISTORY_DISABLED' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [row('full')], total: 1, hasMore: false }),
      });
    const { result } = renderHook(() => useSessionStore());
    const response = await result.current.requestHistorySnapshot('s1', {
      payload: 'light', fallbackOnLightDisabled: true,
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(authenticatedFetch.mock.calls[0][0]).toContain('payload=light');
    expect(authenticatedFetch.mock.calls[1][0]).not.toContain('payload=');
    expect(response.ok && response.snapshot.payloadMode).toBe('full');
  });

  it('does not loop when the bounded rollout fallback also fails', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: { code: 'LIGHT_HISTORY_DISABLED' } }),
    });
    const { result } = renderHook(() => useSessionStore());
    const response = await result.current.requestHistorySnapshot('s1', {
      payload: 'light', fallbackOnLightDisabled: true,
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(response).toEqual({ ok: false, status: 409, code: 'LIGHT_HISTORY_DISABLED', retryAfterMs: null });
  });

  it('enrichment replaces equal-id server rows but retains optimistic rows', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.applyHistorySnapshot('s1', {
        messages: [row('m1', { deferredPayload: { fields: ['toolInput'] } })],
        total: 1, hasMore: false, nextCursor: null, tokenUsage: null,
        responseTurnDurationTotalMs: null, historySchema: 1,
        payloadMode: 'light', revision: 'rev-a',
      });
      result.current.appendRealtime('s1', row('local_1', { role: 'user', content: 'pending' }));
      result.current.applyHistoryEnrichment('s1', {
        messages: [row('m1', { toolInput: { path: 'README.md' } })],
        total: 1, hasMore: false, nextCursor: null, tokenUsage: null,
        responseTurnDurationTotalMs: null, historySchema: 1,
        payloadMode: 'full', revision: 'rev-a',
      });
    });
    expect(result.current.getMessages('s1').map((message) => message.id)).toEqual(['m1', 'local_1']);
    expect(result.current.getMessages('s1')[0].toolInput).toEqual({ path: 'README.md' });
  });

  it('light window expansion preserves already enriched rows at the same revision', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.applyHistorySnapshot('s1', {
        messages: [row('m1', { toolInput: { path: 'README.md' } })],
        total: 2, hasMore: true, nextCursor: null, tokenUsage: null,
        responseTurnDurationTotalMs: null, historySchema: 1,
        payloadMode: 'full', revision: 'rev-a',
      });
      result.current.applyLightHistoryExpansion('s1', {
        messages: [
          row('m1', { deferredPayload: { fields: ['toolInput'] } }),
          row('m2', { deferredPayload: { fields: ['images'] } }),
        ],
        total: 2, hasMore: false, nextCursor: null, tokenUsage: null,
        responseTurnDurationTotalMs: null, historySchema: 1,
        payloadMode: 'light', revision: 'rev-a',
      });
    });
    expect(result.current.getMessages('s1')).toHaveLength(2);
    expect(result.current.getMessages('s1')[0].toolInput).toEqual({ path: 'README.md' });
    expect(result.current.getMessages('s1')[0].deferredPayload).toBeUndefined();
    expect(result.current.getMessages('s1')[1].deferredPayload?.fields).toEqual(['images']);
  });
});

/**
 * ADR-214 / T-2066: المخزن المشترك لإنفاق Anthropic API.
 *
 * المُثبَت: طلب واحد مهما تعدّد المركّبون، 404 ⇒ none (الشارة مخفية)، رمزا 502
 * يُميَّزان، حمولة ناقصة ⇒ خطأ لا صفر، الدورة ~15 دقيقة ولا جلب والصفحة مخفية،
 * وتبديل المستخدم يُسقط بيانات السابق.
 *
 * RUNNER: vitest (jsdom).
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/api', () => ({
  api: { providers: { anthropicApiSpend: vi.fn() } },
}));

import { api } from '../../../utils/api';

import {
  API_SPEND_REFRESH_MS,
  refreshAnthropicApiSpend,
  useAnthropicApiSpend,
} from './useAnthropicApiSpend';

const mockApi = api.providers.anthropicApiSpend as ReturnType<typeof vi.fn>;

const PAYLOAD = {
  spendCents: 1234,
  currency: 'USD',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-10-21T08:00:00.000Z',
  observedAt: '2026-10-21T08:00:00.000Z',
  hasData: true,
  excludesPriorityTier: true,
};

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockApi.mockResolvedValue(respond(200, PAYLOAD));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useAnthropicApiSpend', () => {
  it('one request regardless of how many components mount', async () => {
    const a = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    const b = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(a.result.current).toEqual({ status: 'success', data: PAYLOAD });
    expect(b.result.current.status).toBe('success');
  });

  it('does not request when disabled', async () => {
    const { result } = renderHook(() => useAnthropicApiSpend(false, 'u1'));
    await flush();
    expect(mockApi).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('404 NO_SPEND_SOURCE ⇒ none (badge hidden)', async () => {
    mockApi.mockResolvedValue(respond(404, { code: 'NO_SPEND_SOURCE' }));
    const { result } = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(result.current.status).toBe('none');
  });

  it('502 API_SPEND_AUTH and API_SPEND_UNAVAILABLE are distinguished', async () => {
    mockApi.mockResolvedValue(respond(502, { code: 'API_SPEND_AUTH' }));
    const first = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(first.result.current).toEqual({ status: 'error', code: 'API_SPEND_AUTH' });
    first.unmount();

    mockApi.mockResolvedValue(respond(502, { code: 'API_SPEND_UNAVAILABLE' }));
    const second = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(second.result.current).toEqual({ status: 'error', code: 'API_SPEND_UNAVAILABLE' });
  });

  it('malformed payload is an error, never a fabricated $0', async () => {
    mockApi.mockResolvedValue(respond(200, { ...PAYLOAD, spendCents: null }));
    const { result } = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(result.current).toEqual({ status: 'error', code: 'API_SPEND_UNAVAILABLE' });
  });

  it('negative sum (org credits/refunds) is accepted, not an error', async () => {
    mockApi.mockResolvedValue(respond(200, { ...PAYLOAD, spendCents: -320 }));
    const { result } = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(result.current).toEqual({ status: 'success', data: { ...PAYLOAD, spendCents: -320 } });
  });

  it('network failure ⇒ unavailable', async () => {
    mockApi.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(result.current).toEqual({ status: 'error', code: 'API_SPEND_UNAVAILABLE' });
  });

  it('refetches every ~15 min while visible, skips while hidden', async () => {
    renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    expect(mockApi).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(API_SPEND_REFRESH_MS); });
    expect(mockApi).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { vi.advanceTimersByTime(API_SPEND_REFRESH_MS); });
    expect(mockApi).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it('refreshAnthropicApiSpend triggers an immediate fetch (after key save)', async () => {
    renderHook(() => useAnthropicApiSpend(true, 'u1'));
    await flush();
    refreshAnthropicApiSpend();
    await flush();
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  it('switching user drops the previous user spend', async () => {
    const { result, rerender } = renderHook(({ uid }) => useAnthropicApiSpend(true, uid), {
      initialProps: { uid: 'u1' },
    });
    await flush();
    expect(result.current.status).toBe('success');
    mockApi.mockReturnValue(new Promise(() => {}));
    rerender({ uid: 'u2' });
    expect(result.current.status).not.toBe('success');
  });
});

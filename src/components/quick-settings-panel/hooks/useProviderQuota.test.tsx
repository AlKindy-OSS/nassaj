/**
 * حالات السباق والتعافي لنوافذ حصة المزوّد.
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PendingCall = {
  provider: string;
  options: { signal?: AbortSignal; model?: string };
  resolve: (response: unknown) => void;
};

const calls: PendingCall[] = [];

vi.mock('../../../utils/api', () => ({
  api: {
    providers: {
      providerQuota: (
        provider: string,
        options: { signal?: AbortSignal; model?: string } = {},
      ) =>
        new Promise((resolve) => {
          calls.push({ provider, options, resolve });
        }),
    },
  },
}));

import { PROVIDER_QUOTA_RETRY_MS, useProviderQuota } from './useProviderQuota';

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const CODEX_BODY = {
  provider: 'codex',
  plan: 'plus',
  windows: [
    {
      key: 'primary',
      usedPercent: 12,
      resetsAt: '2026-08-02T06:00:00.000Z',
      windowSeconds: 18_000,
    },
    {
      key: 'secondary',
      usedPercent: 34,
      resetsAt: '2026-08-08T00:00:00.000Z',
      windowSeconds: 604_800,
    },
  ],
};

async function settle(call: PendingCall, value: unknown) {
  await act(async () => {
    call.resolve(value);
    await Promise.resolve();
  });
}

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
});

describe('useProviderQuota', () => {
  it.each([
    { label: 'positive', credits: { balance: 125.5, unlimited: false } },
    { label: 'zero', credits: { balance: 0, unlimited: false } },
    { label: 'unlimited', credits: { balance: 0, unlimited: true } },
  ])('preserves $label credits without quota windows', async ({ credits }) => {
    const { result } = renderHook(() => useProviderQuota('codex', null, true));
    await settle(calls[0], response(200, { ...CODEX_BODY, windows: [], extraUsageCredits: credits }));

    expect(result.current.status).toBe('success');
    expect(result.current.windows).toEqual([]);
    if (result.current.status !== 'success') throw new Error('Expected quota success');
    expect(result.current.data.extraUsageCredits).toEqual(credits);
  });

  it.each([
    { label: 'missing', credits: undefined },
    { label: 'null', credits: null },
    { label: 'negative balance', credits: { balance: -1, unlimited: false } },
    { label: 'negative unlimited balance', credits: { balance: -1, unlimited: true } },
    { label: 'non-finite balance', credits: { balance: Infinity, unlimited: false } },
    { label: 'NaN balance', credits: { balance: NaN, unlimited: false } },
    { label: 'string balance', credits: { balance: '25', unlimited: false } },
    { label: 'missing balance', credits: { unlimited: true } },
    { label: 'missing unlimited', credits: { balance: 25 } },
    { label: 'non-boolean unlimited', credits: { balance: 25, unlimited: 'false' } },
  ])('omits $label credits without inventing a zero balance', async ({ credits }) => {
    const { result } = renderHook(() => useProviderQuota('codex', null, true));
    const body = { ...CODEX_BODY, windows: [], ...(credits !== undefined ? { extraUsageCredits: credits } : {}) };
    await settle(calls[0], response(200, body));

    expect(result.current.status).toBe('success');
    expect(result.current.windows).toEqual([]);
    if (result.current.status !== 'success') throw new Error('Expected quota success');
    expect(result.current.data).not.toHaveProperty('extraUsageCredits');
  });

  it('يبقى idle صراحةً حين يكون الجلب معطّلاً', () => {
    const { result } = renderHook(() => useProviderQuota('codex', 'gpt-5', false));

    expect(result.current.status).toBe('idle');
    expect(result.current.windows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('Codex success يعرض نافذتي primary وsecondary', async () => {
    const { result } = renderHook(() => useProviderQuota('codex', 'gpt-5', true));
    expect(result.current.status).toBe('loading');

    await settle(calls[0], response(200, CODEX_BODY));

    expect(result.current.status).toBe('success');
    expect(result.current.windows.map((window) => window.key)).toEqual(['primary', 'secondary']);
  });

  it('Codex المباشر لا يرسل نموذج Claude البائت', () => {
    renderHook(() => useProviderQuota('codex', 'claude-opus-5', true));

    expect(calls[0].provider).toBe('codex');
    expect(calls[0].options.model).toBeUndefined();
  });

  it('GLM المباشر لا يرسل نموذج Claude البائت', () => {
    renderHook(() => useProviderQuota('glm', 'claude-opus-5', true));

    expect(calls[0].provider).toBe('glm');
    expect(calls[0].options.model).toBeUndefined();
  });

  it.each(['claude', 'opencode'])('%s الحامل يبقي النموذج ليحسم الخادم المورّد', (provider) => {
    renderHook(() => useProviderQuota(provider, 'glm-5.2', true));

    expect(calls[0].options.model).toBe('glm-5.2');
  });

  it('يتجاهل حمولة تناقض المزوّد المباشر المطلوب', async () => {
    const { result } = renderHook(() => useProviderQuota('codex', 'claude-opus-5', true));

    await settle(calls[0], response(200, { ...CODEX_BODY, provider: 'anthropic' }));

    expect(result.current.status).toBe('error');
    expect(result.current.windows).toEqual([]);
    expect(result.current.plan).toBeNull();
  });

  it('يعامل حكم anthropic غير المتوقع لمزوّد مباشر كخطأ قابل لإعادة المحاولة', async () => {
    const { result } = renderHook(() => useProviderQuota('codex', 'claude-opus-5', true));

    await settle(calls[0], response(404, { code: 'PROVIDER_QUOTA_ANTHROPIC' }));
    expect(result.current.status).toBe('error');

    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_QUOTA_RETRY_MS);
    });
    expect(calls).toHaveLength(2);
  });

  it('تبديل الطلب يصفر نوافذ السابق ويربط النتيجة بالمفتاح الحالي', async () => {
    const { result, rerender } = renderHook(
      ({ provider, model }) => useProviderQuota(provider, model, true),
      { initialProps: { provider: 'codex', model: 'gpt-5' } },
    );
    await settle(calls[0], response(200, CODEX_BODY));
    expect(result.current.windows).toHaveLength(2);

    rerender({ provider: 'glm', model: 'glm-5.2' });

    expect(result.current.status).toBe('loading');
    expect(result.current.windows, 'لا تظهر نوافذ Codex على GLM').toHaveLength(0);
    expect(calls[0].options.signal?.aborted, 'يُلغى مالك الطلب السابق').toBe(true);
  });

  it('تبديل النموذج وحده يصفر نوافذ النموذج السابق فوراً', async () => {
    const { result, rerender } = renderHook(
      ({ model }) => useProviderQuota('claude', model, true),
      { initialProps: { model: 'gpt-5' } },
    );
    await settle(calls[0], response(200, CODEX_BODY));
    expect(result.current.windows).toHaveLength(2);

    rerender({ model: 'gpt-5-mini' });

    expect(result.current.status).toBe('loading');
    expect(result.current.windows).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.model).toBe('gpt-5-mini');
    expect(calls[0].options.signal?.aborted).toBe(true);
  });

  it('success بنوافذ منتهية يبقى success لكن لا يعرض نافذة بائتة', async () => {
    const { result } = renderHook(() => useProviderQuota('codex', 'gpt-5', true));
    await settle(
      calls[0],
      response(200, {
        ...CODEX_BODY,
        windows: CODEX_BODY.windows.map((window) => ({
          ...window,
          resetsAt: '2026-07-31T23:59:59.000Z',
        })),
      }),
    );

    expect(result.current.status).toBe('success');
    expect(result.current.windows).toEqual([]);
  });

  it('none يعيد المحاولة بعد TTL مثل الخطأ العابر', async () => {
    const { result } = renderHook(() => useProviderQuota('codex', null, true));
    await settle(calls[0], response(404, { code: 'PROVIDER_QUOTA_UNAVAILABLE' }));
    expect(result.current.status).toBe('none');

    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_QUOTA_RETRY_MS);
    });

    expect(calls).toHaveLength(2);
    expect(result.current.status).toBe('loading');
  });

  it('failure ثم retry بعد TTL واحد ثم success بلا polling متسارع', async () => {
    const { result } = renderHook(() => useProviderQuota('codex', null, true));
    await settle(calls[0], response(503, {}));
    expect(result.current.status).toBe('error');

    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_QUOTA_RETRY_MS - 1);
    });
    expect(calls, 'لا إعادة قبل انتهاء TTL').toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls, 'مؤقّت واحد ينتج إعادة واحدة').toHaveLength(2);
    expect(result.current.status).toBe('loading');

    await settle(calls[1], response(200, CODEX_BODY));
    expect(result.current.status).toBe('success');
    expect(result.current.windows).toHaveLength(2);
  });

  it('ينظف مؤقّت retry عند unmount', async () => {
    const { unmount } = renderHook(() => useProviderQuota('codex', null, true));
    await settle(calls[0], response(503, {}));

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_QUOTA_RETRY_MS);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal?.aborted).toBe(true);
  });

  it('ينظف مؤقّت retry عند تبديل provider أو model', async () => {
    const { rerender } = renderHook(
      ({ provider, model }) => useProviderQuota(provider, model, true),
      { initialProps: { provider: 'claude', model: 'gpt-5' } },
    );
    await settle(calls[0], response(503, {}));

    rerender({ provider: 'claude', model: 'gpt-5-mini' });
    expect(calls).toHaveLength(2);

    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_QUOTA_RETRY_MS);
    });

    expect(calls, 'لا يبقى مؤقّت النموذج السابق بعد التبديل').toHaveLength(2);
  });

  it('refetch اليدوي يستبدل مؤقّت retry ولا يترك إعادة قديمة', async () => {
    const { result } = renderHook(() => useProviderQuota('codex', null, true));
    await settle(calls[0], response(503, {}));

    await act(async () => {
      void result.current.refetch();
    });
    expect(calls).toHaveLength(2);

    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_QUOTA_RETRY_MS);
    });

    expect(calls, 'لا يعمل مؤقّت الخطأ القديم بعد refetch').toHaveLength(2);
  });
});

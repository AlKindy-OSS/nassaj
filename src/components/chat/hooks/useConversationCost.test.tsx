/**
 * useConversationCost.test.tsx — الشارة تقرأ رقماً أو تعترف بجهله، ولا شيء ثالث.
 *
 * المخاطر المُثبَّتة هنا ثلاثة، وكلها تنتهي برقم كاذب على الشاشة لا بخلل تجميلي:
 *  1. فشل الطلب (شبكة، أو 404 قبل نشر المسار الخادمي) يجب أن يُقرأ «غير متاحة»
 *     لا `$0.00` — الصفر هنا ادّعاء بأن المحادثة لم تكلّف شيئاً.
 *  2. تبديل المحادثة يجب أن يُصفّر فوراً؛ وإلا قُرئت كلفة محادثة على رأس أخرى.
 *  3. ردّ متأخّر لمحادثة غادرناها لا يجوز أن يكتب فوق الحالية.
 *
 * وسياسة الجلب نفسها مُثبَّتة: طلب عند فتح المحادثة، وطلب عند **هبوط** البثّ،
 * ولا استطلاع دوري — أي تراجع عن ذلك يحوّل شارة رأس إلى ضجيج شبكي دائم.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import { useConversationCost } from './useConversationCost';

const COST = {
  sessionId: 'sess-1',
  provider: 'claude',
  available: true,
  metered: false,
  totalUsd: 12.34,
  complete: true,
  unpricedModels: [],
  subagentRequests: 0,
  pricesAsOf: '2026-07-28',
  perModel: [],
};

const respondWith = (body: unknown, ok = true) => {
  authenticatedFetch.mockResolvedValue({ ok, json: async () => body });
};

beforeEach(() => {
  authenticatedFetch.mockReset();
});

afterEach(() => {
  // `globals: false` يعني ألّا تنظيف تلقائياً من testing-library.
  cleanup();
  vi.restoreAllMocks();
});

describe('الجلب', () => {
  it('يطلب كلفة المحادثة مرّة عند الفتح على المسار المتفَّق عليه', async () => {
    respondWith({ success: true, cost: COST });

    const { result } = renderHook(() => useConversationCost('sess-1'));

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.cost).toEqual(COST);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/costs/session/sess-1');
  });

  it('مُعرِّف الجلسة يُرمَّز في المسار', async () => {
    respondWith({ success: true, cost: COST });

    renderHook(() => useConversationCost('a/b?c'));

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/costs/session/a%2Fb%3Fc');
  });

  it('بلا محادثة مفتوحة لا طلب أصلاً', async () => {
    renderHook(() => useConversationCost(null));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('هبوط البثّ (true ← false) يُعيد الجلب مرّة واحدة، وثباته لا يُعيده', async () => {
    respondWith({ success: true, cost: COST });

    const { result, rerender } = renderHook(
      ({ isLoading }: { isLoading: boolean }) => useConversationCost('sess-1', { isLoading }),
      { initialProps: { isLoading: false } },
    );

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    // صعود البثّ: الردّ لم يكتمل بعد، فلا شيء جديد ليُقرأ.
    rerender({ isLoading: true });
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));

    // هبوطه: التوكنز استقرّت في السجل — أوان القراءة.
    rerender({ isLoading: false });
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));

    // إعادة تصيير بلا تغيّر لا تُطلق شيئاً.
    rerender({ isLoading: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });
});

describe('الفشل يُقال ولا يُلفَّق صفراً', () => {
  it('ردّ غير ناجح يُترجَم خطأً بلا كلفة', async () => {
    respondWith({ error: 'not found' }, false);

    const { result } = renderHook(() => useConversationCost('sess-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.cost).toBeNull();
  });

  it('success:false ليس نجاحاً بكلفة صفر', async () => {
    respondWith({ success: false });

    const { result } = renderHook(() => useConversationCost('sess-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.cost).toBeNull();
  });

  it('انقطاع الشبكة لا يُسقط المكوّن', async () => {
    authenticatedFetch.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useConversationCost('sess-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.cost).toBeNull();
  });
});

describe('عزل المحادثات', () => {
  it('تبديل المحادثة يُصفّر الكلفة فوراً قبل وصول الردّ الجديد', async () => {
    respondWith({ success: true, cost: COST });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useConversationCost(sessionId),
      { initialProps: { sessionId: 'sess-1' } },
    );

    await waitFor(() => expect(result.current.cost).toEqual(COST));

    // ردّ لا يُحسم: نقيس الحالة في الفجوة بين التبديل ووصول الكلفة الجديدة.
    authenticatedFetch.mockReturnValue(new Promise(() => {}));
    rerender({ sessionId: 'sess-2' });

    expect(result.current.cost).toBeNull();
  });

  it('ردّ متأخّر لمحادثة غادرناها يُهمَل', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    authenticatedFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useConversationCost(sessionId),
      { initialProps: { sessionId: 'sess-1' } },
    );

    const secondCost = { ...COST, sessionId: 'sess-2', totalUsd: 99 };
    respondWith({ success: true, cost: secondCost });
    rerender({ sessionId: 'sess-2' });

    await waitFor(() => expect(result.current.cost).toEqual(secondCost));

    // الردّ الأول يصل الآن — بعد فوات أوانه.
    releaseFirst?.({ ok: true, json: async () => ({ success: true, cost: COST }) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.current.cost).toEqual(secondCost);
  });
});

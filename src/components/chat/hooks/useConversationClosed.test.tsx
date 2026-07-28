/**
 * useConversationClosed.test.tsx — التبديل المتفائل لا يكذب على المستخدم.
 *
 * التفاؤل مقبول هنا لأن الإغلاق فعل تنظيمي رخيص التراجع، لكنه يصير كذباً إن
 * بقي الزرّ مقلوباً بعد فشل الطلب. فالمُثبَّت: القلب فوراً، ثم **التراجع
 * والإعلان** عند أي فشل.
 *
 * والفخّ الثاني — وهو ما يُسقط أغلب التنفيذات — أن الأب يعيد تمرير `closed`
 * القديمة (صفّ الشريط الجانبي لم يُحدَّث بعد) فيدوس على تبديل نفّذه المستخدم
 * قبل لحظة. القاعدة: يُتبنّى المُدخَل حين يتغيّر فعلاً، أو حين تتبدّل المحادثة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import { useConversationClosed } from './useConversationClosed';

const ok = (body: unknown = { success: true }) => ({ ok: true, json: async () => body });

beforeEach(() => {
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValue(ok());
});

afterEach(() => {
  // `globals: false` يعني ألّا تنظيف تلقائياً من testing-library.
  cleanup();
  vi.restoreAllMocks();
});

describe('التبديل', () => {
  it('الإغلاق POST والفتح DELETE على نفس المسار', async () => {
    const { result, rerender } = renderHook(
      ({ initialClosed }: { initialClosed: boolean }) =>
        useConversationClosed('sess-1', { initialClosed }),
      { initialProps: { initialClosed: false } },
    );

    await act(async () => result.current.toggle());
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/sessions/sess-1/close', {
      method: 'POST',
    });

    // الأب لحق بالحالة الخادمية.
    rerender({ initialClosed: true });

    await act(async () => result.current.toggle());
    expect(authenticatedFetch).toHaveBeenLastCalledWith('/api/sessions/sess-1/close', {
      method: 'DELETE',
    });
  });

  it('الزرّ ينقلب قبل حسم الشبكة', async () => {
    authenticatedFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useConversationClosed('sess-1'));

    act(() => result.current.toggle());

    expect(result.current.closed).toBe(true);
    expect(result.current.pending).toBe(true);
  });

  it('طلب طائر يمنع تبديلاً ثانياً معاكساً', async () => {
    authenticatedFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useConversationClosed('sess-1'));

    act(() => result.current.toggle());
    act(() => result.current.toggle());

    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(result.current.closed).toBe(true);
  });

  it('بلا محادثة لا طلب', async () => {
    const { result } = renderHook(() => useConversationClosed(null));
    await act(async () => result.current.toggle());
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});

describe('التراجع عند الفشل', () => {
  it('ردّ غير ناجح يُعيد الحالة ويرفع علم الفشل', async () => {
    authenticatedFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

    const { result } = renderHook(() => useConversationClosed('sess-1'));

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.closed).toBe(false);
    expect(result.current.failed).toBe(true);
  });

  it('success:false على حالة 200 فشلٌ أيضاً', async () => {
    authenticatedFetch.mockResolvedValue(ok({ success: false }));

    const { result } = renderHook(() => useConversationClosed('sess-1'));

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.closed).toBe(false));
    expect(result.current.failed).toBe(true);
  });

  it('انقطاع الشبكة يتراجع كذلك', async () => {
    authenticatedFetch.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useConversationClosed('sess-1'));

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.closed).toBe(false);
    expect(result.current.failed).toBe(true);
  });

  it('جسم غير قابل للتحليل على ردّ ناجح لا يُبطل النجاح', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('empty body');
      },
    });

    const { result } = renderHook(() => useConversationClosed('sess-1'));

    await act(async () => result.current.toggle());

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.closed).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('نداء التغيّر يُبلّغ الحالة المرئية: القلب ثم التراجع', async () => {
    authenticatedFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const onChange = vi.fn();

    const { result } = renderHook(() => useConversationClosed('sess-1', { onChange }));

    await act(async () => result.current.toggle());

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe('مزامنة المُدخَل من الأب', () => {
  it('إعادة تمرير قيمة قديمة لم تتغيّر لا تدوس على تبديل متفائل', async () => {
    authenticatedFetch.mockReturnValue(new Promise(() => {}));

    const { result, rerender } = renderHook(
      ({ initialClosed }: { initialClosed: boolean }) =>
        useConversationClosed('sess-1', { initialClosed }),
      { initialProps: { initialClosed: false } },
    );

    act(() => result.current.toggle());
    expect(result.current.closed).toBe(true);

    // الأب يعيد التصيير بحمولة شريط جانبي لم تُحدَّث بعد.
    rerender({ initialClosed: false });

    expect(result.current.closed).toBe(true);
  });

  it('تغيّر المُدخَل فعلاً يُتبنّى (تحديث من مصدر آخر)', async () => {
    const { result, rerender } = renderHook(
      ({ initialClosed }: { initialClosed: boolean }) =>
        useConversationClosed('sess-1', { initialClosed }),
      { initialProps: { initialClosed: false } },
    );

    rerender({ initialClosed: true });

    expect(result.current.closed).toBe(true);
  });

  it('تبدُّل المحادثة يعيد الضبط ويمسح أثر الفشل', async () => {
    authenticatedFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useConversationClosed(sessionId, { initialClosed: false }),
      { initialProps: { sessionId: 'sess-1' } },
    );

    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.failed).toBe(true));

    rerender({ sessionId: 'sess-2' });

    expect(result.current.closed).toBe(false);
    expect(result.current.failed).toBe(false);
  });
});

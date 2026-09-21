/**
 * useSessionActiveModel.test.ts — T-1028 / B-249
 *
 * يُغطّي أربع سيناريوهات:
 * (أ) انحدار B-249 المباشر: العرض يتبع ردّ الخادم لا الحالة العامة عند اختلافهما.
 * (ب) التحديث التفاؤلي ثم المصالحة (setDisplayModel).
 * (ج) غياب sessionId → قيمة المنتقي العام، لا جلب.
 * (د) 404 لا ينتج قيمة مختلقة → يعرض fallbackModel.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/useSessionActiveModel.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSessionActiveModel } from './useSessionActiveModel';

// ─── Mock ────────────────────────────────────────────────────────────────────

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

// استيراد النسخة المُغلَّفة بعد التغليف
import { authenticatedFetch } from '../../../utils/api';
const mockFetch = authenticatedFetch as ReturnType<typeof vi.fn>;

// بناء استجابة ناجحة
function okResponse(model: string) {
  return Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        success: true,
        data: {
          provider: 'claude',
          sessionId: 'session-001',
          model,
          source: 'session-override' as const,
          supported: true,
          changed: true,
        },
      }),
  });
}

// بناء استجابة 404
function notFoundResponse() {
  return Promise.resolve({
    ok: false,
    status: 404,
    json: () => Promise.resolve({ success: false, error: { code: 'SESSION_NOT_FOUND' } }),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ─── (ج) بلا sessionId ───────────────────────────────────────────────────────

describe('(ج) بلا sessionId — يعرض fallbackModel بلا جلب', () => {
  it('يعيد fallbackModel مباشرة ولا يُنادي authenticatedFetch', () => {
    const { result } = renderHook(() =>
      useSessionActiveModel('claude', null, 'claude-sonnet-4-5'),
    );

    expect(result.current.displayModel).toBe('claude-sonnet-4-5');
    expect(result.current.isLoading).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('يتتبّع fallbackModel في الوقت الفعلي حين sessionId null', async () => {
    const { result, rerender } = renderHook(
      ({ fallback }: { fallback: string }) =>
        useSessionActiveModel('claude', null, fallback),
      { initialProps: { fallback: 'claude-sonnet-4-5' } },
    );

    expect(result.current.displayModel).toBe('claude-sonnet-4-5');

    rerender({ fallback: 'claude-opus-4-8' });
    expect(result.current.displayModel).toBe('claude-opus-4-8');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── (أ) انحدار B-249 ────────────────────────────────────────────────────────

describe('(أ) انحدار B-249 — العرض من الخادم لا من الحالة العامة', () => {
  it('يعرض النموذج المُعاد من الخادم حتى حين يختلف عن fallbackModel', async () => {
    // الخادم يعرف أن الجلسة بُدِّلت إلى claude-opus-4-8
    mockFetch.mockReturnValue(okResponse('claude-opus-4-8'));

    const { result } = renderHook(() =>
      useSessionActiveModel('claude', 'session-001', 'claude-sonnet-4-5'),
    );

    // أثناء الجلب
    expect(result.current.isLoading).toBe(true);

    // بعد الجلب: يجب أن يعرض ما قاله الخادم لا fallbackModel
    await waitFor(() => {
      expect(result.current.displayModel).toBe('claude-opus-4-8');
      expect(result.current.isLoading).toBe(false);
    });

    // تحقّق أن المسار الصحيح نودي
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/providers/claude/sessions/session-001/active-model',
      expect.objectContaining({}),
    );
  });

  it('لا يتغيّر displayModel حين يتغيّر fallbackModel بعد جلب ناجح', async () => {
    mockFetch.mockReturnValue(okResponse('claude-opus-4-8'));

    const { result, rerender } = renderHook(
      ({ fallback }: { fallback: string }) =>
        useSessionActiveModel('claude', 'session-001', fallback),
      { initialProps: { fallback: 'claude-sonnet-4-5' } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.displayModel).toBe('claude-opus-4-8');

    // تغيير المنتقي العام — يجب ألا يُعيد كتابة displayModel
    rerender({ fallback: 'claude-haiku-3-5' });
    // لا إعادة جلب (sessionId/provider لم يتغيّرا) → displayModel يبقى من الخادم
    expect(result.current.displayModel).toBe('claude-opus-4-8');
    // لم يُنادَ fetch مرة ثانية
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── (ب) التحديث التفاؤلي والمصالحة ──────────────────────────────────────────

describe('(ب) التحديث التفاؤلي ثم المصالحة', () => {
  it('setDisplayModel يضبط القيمة فوراً (تحديث تفاؤلي)', async () => {
    mockFetch.mockReturnValue(okResponse('claude-sonnet-4-5'));

    const { result } = renderHook(() =>
      useSessionActiveModel('claude', 'session-001', 'claude-sonnet-4-5'),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.displayModel).toBe('claude-sonnet-4-5');

    // تحديث تفاؤلي فوري
    act(() => {
      result.current.setDisplayModel('claude-opus-4-8');
    });
    expect(result.current.displayModel).toBe('claude-opus-4-8');
  });

  it('setDisplayModel مرة ثانية (مصالحة مع ردّ الخادم) يضبط القيمة المؤكَّدة', async () => {
    mockFetch.mockReturnValue(okResponse('claude-sonnet-4-5'));

    const { result } = renderHook(() =>
      useSessionActiveModel('claude', 'session-001', 'claude-sonnet-4-5'),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // تفاؤلي
    act(() => { result.current.setDisplayModel('claude-haiku-3-5'); });
    expect(result.current.displayModel).toBe('claude-haiku-3-5');

    // مصالحة: الخادم يؤكّد نفس القيمة (أو قيمة مختلفة)
    act(() => { result.current.setDisplayModel('claude-haiku-3-5'); });
    expect(result.current.displayModel).toBe('claude-haiku-3-5');
  });

  it('setDisplayModel للتراجع يعيد القيمة السابقة عند فشل POST', async () => {
    mockFetch.mockReturnValue(okResponse('claude-opus-4-8'));

    const { result } = renderHook(() =>
      useSessionActiveModel('claude', 'session-001', 'claude-sonnet-4-5'),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.displayModel).toBe('claude-opus-4-8');

    const previousModel = result.current.displayModel;

    // محاكاة: تحديث تفاؤلي ثم POST يفشل → تراجع
    act(() => { result.current.setDisplayModel('claude-haiku-3-5'); });
    expect(result.current.displayModel).toBe('claude-haiku-3-5');

    act(() => { result.current.setDisplayModel(previousModel); });
    expect(result.current.displayModel).toBe('claude-opus-4-8');
  });
});

// ─── (د) 404 لا ينتج قيمة مختلقة ────────────────────────────────────────────

describe('(د) 404 SESSION_NOT_FOUND — يعرض fallbackModel لا قيمة مختلقة', () => {
  it('عند 404: يعرض fallbackModel ولا يختلق قيمة أخرى', async () => {
    mockFetch.mockReturnValue(notFoundResponse());

    const { result } = renderHook(() =>
      useSessionActiveModel('claude', 'session-404', 'claude-sonnet-4-5'),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // يجب أن يعرض fallback لا أي شيء آخر
    expect(result.current.displayModel).toBe('claude-sonnet-4-5');
  });

  it('عند خطأ شبكة: يعرض fallbackModel ولا يُسقط المبدّل صامتاً', async () => {
    const networkError = new Error('Failed to fetch');
    mockFetch.mockReturnValue(Promise.reject(networkError));

    const { result } = renderHook(() =>
      useSessionActiveModel('claude', 'session-001', 'claude-sonnet-4-5'),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.displayModel).toBe('claude-sonnet-4-5');
  });
});

// ─── إعادة الجلب عند تغيّر sessionId ────────────────────────────────────────

describe('إعادة الجلب عند تغيّر الجلسة', () => {
  it('يُعيد الجلب حين يتغيّر sessionId ويعرض الرقيمة الجديدة من الخادم', async () => {
    mockFetch
      .mockReturnValueOnce(okResponse('claude-opus-4-8'))
      .mockReturnValueOnce(okResponse('claude-haiku-3-5'));

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useSessionActiveModel('claude', sessionId, 'claude-sonnet-4-5'),
      { initialProps: { sessionId: 'session-A' } },
    );

    await waitFor(() => expect(result.current.displayModel).toBe('claude-opus-4-8'));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // تبديل الجلسة → جلبة جديدة
    rerender({ sessionId: 'session-B' });

    await waitFor(() => expect(result.current.displayModel).toBe('claude-haiku-3-5'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

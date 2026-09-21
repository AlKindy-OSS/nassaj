/**
 * useFavoriteModels.test.ts — T-1039 / شروط qa-critic ١–٣
 *
 * يغطّي:
 * (أ) تجميع الـdebounce: تبديلات متتالية سريعة → PUT واحدة فقط.
 * (ب) التفريغ عند هدم الصفحة: pagehide يُطلق fetch keepalive بالترويسة الصحيحة.
 * (ج) سباق GET مقابل التفضيل المتفائل: نجمة قبل عودة GET لا تُمحى بقيمة الخادم.
 * (د) ترشيح حمولة GET مشوَّهة: القيم غير النصية تُرشَّح صامتة.
 *
 * Runner: vitest (jsdom)
 * تشغيل: NODE_ENV=test npx vitest run src/hooks/useFavoriteModels.test.ts
 *
 * ملاحظة bيئية (فخّ موثَّق): NODE_ENV=production الموروث يُسقط هذه الاختبارات
 * بخطأ «act() is not supported in production builds» — الإصلاح بإضافة NODE_ENV=test.
 */

import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (مُرفَّعة قبل أي import للوحدات الأخرى بواسطة vitest) ────────────

const mockGet = vi.fn();
const mockPut = vi.fn();

vi.mock('../utils/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

// ─── استيراد الهوك بعد تسجيل الـmock ────────────────────────────────────────

import { useFavoriteModels } from './useFavoriteModels';

// ─── مساعدات ─────────────────────────────────────────────────────────────────

/**
 * تفريغ طابور microtask الـPromise بدون تحريك fake timers.
 * vitest يُزيف setTimeout/setInterval/Date لا طابور الـPromise،
 * لذا تعمل هذه الدالة حتى مع vi.useFakeTimers().
 * 5 تكرارات تكفي لسلسلة GET: resolve → then → json() → then body → finally.
 */
async function flushPromises() {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
}

/** بناء استجابة GET ناجحة بقائمة favoriteModels مُعطاة. */
function makeGetResp(favoriteModels: unknown[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    json: async () => ({ preferences: { favoriteModels } }),
  } as Response);
}

// ─── إعداد / تنظيف ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  // تزوير globalThis.fetch للمسار الـkeepalive (لا يمر عبر api.put).
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  // تزوير localStorage.getItem لإعادة توكن اختبار ثابت.
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) =>
    key === 'auth-token' ? 'test-bearer-token' : null,
  );
  mockGet.mockReturnValue(makeGetResp([]));
  mockPut.mockResolvedValue({ ok: true } as Response);
});

afterEach(() => {
  // unmount قبل استعادة الـtimers لتجنّب clearTimeout(fakeId) في سياق real.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ─── الاختبارات ──────────────────────────────────────────────────────────────

describe('useFavoriteModels', () => {
  // ── (أ) تجميع الـdebounce ────────────────────────────────────────────────

  describe('(أ) الـdebounce يجمع تبديلات متتالية في PUT واحدة', () => {
    it('ثلاث نجمات متتالية → PUT واحدة تحمل القائمة الكاملة', async () => {
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises(); // انتظر انتهاء GET الأولي

      mockPut.mockClear();

      // ثلاثة تبديلات داخل act واحدة ليجمعها React في دفعة.
      act(() => {
        result.current.handleToggleFavorite('provider:model-a');
        result.current.handleToggleFavorite('provider:model-b');
        result.current.handleToggleFavorite('provider:model-c');
      });

      // الـdebounce لم ينطلق بعد.
      expect(mockPut).not.toHaveBeenCalled();

      // تقديم الساعة لتجاوز نافذة 300ms.
      act(() => {
        vi.runAllTimers();
      });

      expect(mockPut).toHaveBeenCalledTimes(1);
      expect(mockPut).toHaveBeenCalledWith('/settings/ui-preferences', {
        favoriteModels: ['provider:model-a', 'provider:model-b', 'provider:model-c'],
      });
    });

    it('تبديل سريع آخر قبل انطلاق المؤقّت يُعيد ضبط الـdebounce', async () => {
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();
      mockPut.mockClear();

      act(() => {
        result.current.handleToggleFavorite('provider:model-x');
      });
      // تقديم 200ms (أقل من 300ms) — المؤقّت لم ينطلق بعد.
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(mockPut).not.toHaveBeenCalled();

      // تبديل ثانٍ يُعيد ضبط الـdebounce لـ 300ms من الآن.
      act(() => {
        result.current.handleToggleFavorite('provider:model-y');
      });
      // تقديم 200ms أخرى (إجمالي 400ms من الأول) — لكن المؤقّت الثاني لم ينطلق بعد.
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(mockPut).not.toHaveBeenCalled();

      // تقديم 100ms إضافية → المؤقّت الثاني ينطلق الآن.
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(mockPut).toHaveBeenCalledTimes(1);
      expect(mockPut).toHaveBeenCalledWith('/settings/ui-preferences', {
        favoriteModels: ['provider:model-x', 'provider:model-y'],
      });
    });
  });

  // ── (ب) التفريغ عند هدم الصفحة ──────────────────────────────────────────

  describe('(ب) التفريغ الفوري عند hدم الصفحة (keepalive fetch)', () => {
    it('pagehide يُطلق fetch keepalive مع الترويسة الصحيحة إن كان مؤقّت معلّقاً', async () => {
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();

      // نجمة → يبدأ مؤقّت 300ms (لم ينطلق بعد بفضل fake timers).
      act(() => {
        result.current.handleToggleFavorite('provider:model-x');
      });

      // إطلاق pagehide فوراً — المؤقّت ما زال معلّقاً.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      const fetchMock = vi.mocked(globalThis.fetch);
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { keepalive?: boolean }];
      expect(url).toBe('/api/settings/ui-preferences');
      expect(init.method).toBe('PUT');
      expect(init.keepalive).toBe(true);
      expect(JSON.parse(init.body as string)).toEqual({
        favoriteModels: ['provider:model-x'],
      });
      // Bearer token في الترويسة — لا sendBeacon لأنه لا يدعم رؤوس مخصصة.
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer test-bearer-token',
      );
    });

    it('pagehide بلا مؤقّت معلّق لا يُطلق fetch', async () => {
      renderHook(() => useFavoriteModels());
      await flushPromises();
      // لا تبديل → لا مؤقّت → flushImmediately تعود فوراً.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    });

    it('pagehide يُلغي المؤقّت بحيث لا تُطلق PUT المؤجّلة لاحقاً', async () => {
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();
      mockPut.mockClear();

      act(() => {
        result.current.handleToggleFavorite('provider:model-z');
      });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      // المؤقّت أُلغي → تقديم كل الساعة لا يُطلق PUT.
      act(() => {
        vi.runAllTimers();
      });
      expect(mockPut).not.toHaveBeenCalled();
    });
  });

  // ── (ج) سباق GET مقابل التفضيل المتفائل ─────────────────────────────────

  describe('(ج) الـGET لا يمحو التفضيل المتفائل (hasUserToggledRef)', () => {
    it('نجمة قبل عودة GET تبقى ولا تُستبدَل بقيمة الخادم', async () => {
      // تأخير الـGET حتى نتحكم في التسلسل.
      let resolveGet!: (v: Response) => void;
      mockGet.mockReturnValue(
        new Promise<Response>((res) => {
          resolveGet = res;
        }),
      );

      const { result } = renderHook(() => useFavoriteModels());
      // GET في الطيران — الحالة لا تزال فارغة وisLoading=true.

      // نجمة متفائلة قبل عودة GET.
      act(() => {
        result.current.handleToggleFavorite('provider:optimistic');
      });
      expect(result.current.favorites).toContain('provider:optimistic');

      // الآن يعود GET بقائمة مختلفة من الخادم.
      await act(async () => {
        resolveGet({
          ok: true,
          json: async () => ({
            preferences: { favoriteModels: ['provider:server-only'] },
          }),
        } as Response);
        // تفريغ سلسلة الـPromise المُحرَّكة للتوّ.
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });

      // التفضيل المتفائل يجب أن يبقى؛ قيمة الخادم لا تُبنّى.
      expect(result.current.favorites).toContain('provider:optimistic');
      expect(result.current.favorites).not.toContain('provider:server-only');
    });

    it('إن لم يتفاعل المستخدم، يُبنّى GET عادةً', async () => {
      mockGet.mockReturnValue(
        makeGetResp(['provider:from-server']),
      );
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();

      // لا تبديل → hasUserToggledRef=false → GET يُطبَّق.
      expect(result.current.favorites).toEqual(['provider:from-server']);
    });
  });

  // ── (د) ترشيح حمولة GET المشوَّهة ───────────────────────────────────────

  describe('(د) ترشيح القيم غير النصية في حمولة GET', () => {
    it('مزيج من الأنواع → فقط النصوص تبقى', async () => {
      mockGet.mockReturnValue(
        makeGetResp([42, true, null, { key: 'obj' }, undefined, 'provider:valid']),
      );
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();

      expect(result.current.favorites).toEqual(['provider:valid']);
    });

    it('favoriteModels ليست مصفوفة → تُتجاهَل كلياً والحالة تبقى فارغة', async () => {
      mockGet.mockReturnValue(
        Promise.resolve({
          ok: true,
          json: async () => ({ preferences: { favoriteModels: 'not-an-array' } }),
        } as Response),
      );
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();

      expect(result.current.favorites).toEqual([]);
    });

    it('GET يعيد ok=false → الحالة تبقى فارغة وlاisLoading=false', async () => {
      mockGet.mockReturnValue(Promise.resolve({ ok: false } as Response));
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();

      expect(result.current.favorites).toEqual([]);
      expect(result.current.isLoading).toBe(false);
    });

    it('حمولة GET كلها أرقام → لا نجمة تظهر', async () => {
      mockGet.mockReturnValue(makeGetResp([1, 2, 3, 99]));
      const { result } = renderHook(() => useFavoriteModels());
      await flushPromises();

      expect(result.current.favorites).toEqual([]);
    });
  });
});

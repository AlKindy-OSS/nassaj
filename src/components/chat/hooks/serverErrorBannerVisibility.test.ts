/**
 * T-1294 — شريط خطأ الخادم يُقاس بستّ ثوانٍ **يراها المستخدم**.
 *
 * العلّة: المؤقّت كان يبدأ لحظة وصول الخطأ (`setTimeout(..., 6000)` في
 * `handleServerError`). وأكثر ما تفشل الجولة والمستخدم في تبويب آخر — وهو نفس
 * السبب الذي من أجله يُعلَن الفشل بمؤشّر العنوان وبالصوت — فينقضي المؤقّت وهو
 * غائب، ويعود إلى شاشة نظيفة لا أثر فيها لِما فشل ولا سببه، فيعيد الإرسال أو
 * يظنّ أن شيئاً لم يقع.
 *
 * الاختبار يقود الخُطّاف الإنتاجي نفسه (`useServerErrorBanner`) بسياسة
 * `pageActivity` الحقيقية ومستمعيها الحقيقيين — لا نسخةً منه.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { SERVER_ERROR_VISIBLE_MS, useServerErrorBanner } from './useServerErrorBanner';

/** التبويب في الخلفية: مخفيّ وبلا تركيز. */
function hidePage(): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'hidden',
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
}

/** عودة المستخدم: الصفحة مرئية وذات تركيز، ثم الحدث الذي يُعلن ذلك. */
function returnToPage(): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('شريط خطأ الخادم', () => {
  it('صفحة مخفيّة: الرسالة تبقى بعد انقضاء المدّة كاملةً', () => {
    hidePage();
    const { result } = renderHook(() => useServerErrorBanner());

    act(() => { result.current.showServerError('تعذّر تشغيل المزوّد'); });
    act(() => { vi.advanceTimersByTime(SERVER_ERROR_VISIBLE_MS * 3); });

    assert.equal(
      result.current.serverError,
      'تعذّر تشغيل المزوّد',
      'زال الشريط والمستخدم غائب ⇒ يعود إلى شاشة لا تقول شيئاً عمّا فشل',
    );
  });

  it('العدّ يبدأ عند عودة المستخدم ثم يزول', () => {
    hidePage();
    const { result } = renderHook(() => useServerErrorBanner());

    act(() => { result.current.showServerError('تعذّر تشغيل المزوّد'); });
    act(() => { vi.advanceTimersByTime(SERVER_ERROR_VISIBLE_MS * 3); });
    returnToPage();

    // لحظة العودة: ما يزال ظاهراً، والعدّ ابتدأ الآن.
    assert.equal(result.current.serverError, 'تعذّر تشغيل المزوّد');
    act(() => { vi.advanceTimersByTime(SERVER_ERROR_VISIBLE_MS - 100); });
    assert.equal(result.current.serverError, 'تعذّر تشغيل المزوّد', 'زال قبل تمام المدّة');

    act(() => { vi.advanceTimersByTime(200); });
    assert.equal(result.current.serverError, null, 'بقي إلى الأبد بعد أن رآه المستخدم');
  });

  it('صفحة أمام المستخدم: السلوك القائم كما هو (يزول بعد المدّة)', () => {
    const { result } = renderHook(() => useServerErrorBanner());

    act(() => { result.current.showServerError('تعذّر تشغيل المزوّد'); });
    assert.equal(result.current.serverError, 'تعذّر تشغيل المزوّد');

    act(() => { vi.advanceTimersByTime(SERVER_ERROR_VISIBLE_MS + 100); });
    assert.equal(result.current.serverError, null);
  });

  it('خطأ ثانٍ يُجدّد النافذة كاملةً', () => {
    const { result } = renderHook(() => useServerErrorBanner());

    act(() => { result.current.showServerError('الأول'); });
    act(() => { vi.advanceTimersByTime(SERVER_ERROR_VISIBLE_MS - 500); });
    act(() => { result.current.showServerError('الثاني'); });
    act(() => { vi.advanceTimersByTime(SERVER_ERROR_VISIBLE_MS - 500); });

    assert.equal(result.current.serverError, 'الثاني', 'ابتلع مؤقّتُ الأول نافذةَ الثاني');
  });

  it('تفكيك المكوّن لا يترك مؤقّتاً ولا مستمعاً معلّقاً', () => {
    hidePage();
    const { result, unmount } = renderHook(() => useServerErrorBanner());

    act(() => { result.current.showServerError('تعذّر تشغيل المزوّد'); });
    unmount();

    // لا مؤقّت يكتب في مكوّن مفكَّك، ولا مستمع يبقى على `document`.
    returnToPage();
    act(() => { vi.advanceTimersByTime(SERVER_ERROR_VISIBLE_MS * 2); });
    assert.equal(vi.getTimerCount(), 0);
  });
});

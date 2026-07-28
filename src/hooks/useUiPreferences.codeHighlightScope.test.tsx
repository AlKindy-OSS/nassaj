/**
 * useUiPreferences.codeHighlightScope.test.tsx
 *
 * `codeHighlightScope` هو المفتاح **الثاني** غير المنطقي في هذا المخزن. المسار
 * القديم كان يمرّر كل مفتاح عبر `parseBoolean` ما لم يكن `tabsDisplayMode`
 * حرفياً — فأي مفتاح نصّي جديد كان يتحوّل صامتاً إلى `false` عند الهجرة من
 * المفاتيح القديمة، ثم يُكتب كذلك إلى حساب المستخدم. هذه الاختبارات تُثبّت أنّه
 * يُقرأ ويُكتب ويُهاجَر بوصفه تعداداً نصّياً.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  UI_PREFERENCES_STORAGE_KEY,
  __resetUiPreferencesStoreForTests,
  useUiPreferences,
} from './useUiPreferences';

// المخزن صار مشتركاً على مستوى الوحدة (B-273): يُقرأ التخزين مرّة واحدة لكل
// تبويب، فالاختبار الذي يزرع قيمة في localStorage يجب أن يُسقط المخزن أولاً.
beforeEach(() => {
  window.localStorage.clear();
  __resetUiPreferencesStoreForTests();
});
afterEach(() => {
  window.localStorage.clear();
  __resetUiPreferencesStoreForTests();
});

describe('useUiPreferences — codeHighlightScope', () => {
  it('defaults to the statically bundled scope', () => {
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.preferences.codeHighlightScope).toBe('core');
  });

  it('round-trips a written scope through localStorage', () => {
    const { result } = renderHook(() => useUiPreferences());

    act(() => result.current.setPreference('codeHighlightScope', 'full'));

    expect(result.current.preferences.codeHighlightScope).toBe('full');
    const stored = JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) ?? '{}');
    expect(stored.codeHighlightScope).toBe('full');
  });

  it('rehydrates a stored scope on mount', () => {
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ codeHighlightScope: 'extended' }),
    );
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.preferences.codeHighlightScope).toBe('extended');
  });

  it('rejects an invalid value instead of coercing it to false', () => {
    const { result } = renderHook(() => useUiPreferences());

    act(() => result.current.setPreference('codeHighlightScope', 'everything'));

    expect(result.current.preferences.codeHighlightScope).toBe('core');
  });

  it('survives the legacy migration path (no unified key stored)', () => {
    // مستخدم قديم: مفاتيح منفصلة بلا `uiPreferences`. المسار القديم كان سيمرّ
    // بالمفتاح الجديد عبر parseBoolean ويُنتج `false`.
    window.localStorage.setItem('showThinking', 'false');
    const { result } = renderHook(() => useUiPreferences());

    expect(result.current.preferences.showThinking).toBe(false);
    expect(result.current.preferences.codeHighlightScope).toBe('core');
  });

  it('accepts a scope arriving from the account payload', () => {
    const { result } = renderHook(() => useUiPreferences());

    act(() => result.current.setPreferences({ codeHighlightScope: 'extended' }));

    expect(result.current.preferences.codeHighlightScope).toBe('extended');
  });
});

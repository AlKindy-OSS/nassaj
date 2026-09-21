/**
 * اختبارات `selectedProviderStore` — المتجر الانعكاسي للمزوّد العام.
 *
 * الغرض المُثبَت هنا:
 *  1. `useSelectedProvider` يعيد اللقطة الحالية ويعيد التصيير عند تغيّرها.
 *  2. القيمة نفسها لا تُنبّه المشتركين (‏`Object.is` يمنع re-render بلا داعٍ).
 *  3. القيمة الفارغة تسقط على `'claude'` (نفس احتياط `getProviderCapabilities`).
 *  4. حدث `storage` من تبويب آخر يُحدّث اللقطة، وحدث لمفتاح آخر يُتجاهل.
 *  5. المتجر **لا يكتب** localStorage — انعكاسي صِرف؛ الكتابة تبقى في
 *     `useChatProviderState`. لو كتبَ لكان مصدراً ثانياً للحقيقة وأنشأ حلقة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, it } from 'vitest';

import {
  setSelectedProvider,
  setSelectedEngineProvider,
  useSelectedProvider,
  useSelectedEngineProvider,
  __resetSelectedProviderStore,
} from './selectedProviderStore';

// `globals: false` في vite.config.js ⇒ التنظيف يدوي.
afterEach(cleanup);

beforeEach(() => {
  __resetSelectedProviderStore();
  window.localStorage.clear();
});

describe('selectedProviderStore', () => {
  it('يعيد claude افتراضياً ثم يعكس القيمة المحدَّثة', () => {
    const { result } = renderHook(() => useSelectedProvider());
    assert.equal(result.current, 'claude');

    act(() => setSelectedProvider('kimi'));
    assert.equal(result.current, 'kimi');
  });

  it('لا يُعيد التصيير حين تُضبَط القيمة نفسها', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSelectedProvider();
    });

    act(() => setSelectedProvider('codex'));
    const afterChange = renders;
    assert.equal(result.current, 'codex');

    act(() => setSelectedProvider('codex'));
    assert.equal(renders, afterChange);
  });

  it('القيمة الفارغة تسقط على claude', () => {
    const { result } = renderHook(() => useSelectedProvider());
    act(() => setSelectedProvider('glm'));
    assert.equal(result.current, 'glm');

    act(() => setSelectedProvider(''));
    assert.equal(result.current, 'claude');
  });

  it('لا يكتب localStorage (انعكاسي صِرف)', () => {
    act(() => setSelectedProvider('codex'));
    assert.equal(window.localStorage.getItem('selected-provider'), null);
  });

  it('حدث storage من تبويب آخر يُحدّث اللقطة، والمفتاح الآخر يُتجاهل', () => {
    const { result } = renderHook(() => useSelectedProvider());

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'selected-provider', newValue: 'deepseek' }),
      );
    });
    assert.equal(result.current, 'deepseek');

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'selected-model', newValue: 'gpt-5' }),
      );
    });
    assert.equal(result.current, 'deepseek');
  });

  it('حذف المفتاح في تبويب آخر يعيد القيمة إلى claude', () => {
    act(() => setSelectedProvider('kimi'));
    const { result } = renderHook(() => useSelectedProvider());
    assert.equal(result.current, 'kimi');

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'selected-provider', newValue: null }),
      );
    });
    assert.equal(result.current, 'claude');
  });
});

// ── محور المحرّك (‏ADR-037) ────────────────────────────────────────────────
//
// جسم `claude` على نقطة z.ai يُفوتَر على z.ai. هذا المحور هو ما يجعل الهيدر
// يعرض حصّة المورّد الحقيقي بدل نوافذ اشتراك Anthropic (بلاغ المالك 2026-07-30).
describe('selectedProviderStore — محور المحرّك', () => {
  it('الافتراض null (المسار الرسمي) ثم يعكس المحرّك المضبوط', () => {
    const { result } = renderHook(() => useSelectedEngineProvider());
    assert.equal(result.current, null);

    act(() => setSelectedEngineProvider('glm'));
    assert.equal(result.current, 'glm');

    act(() => setSelectedEngineProvider(null));
    assert.equal(result.current, null);
  });

  it('الفراغ يُعامل null لا نصّاً فارغاً (وإلا صار مزوّداً مجهولاً)', () => {
    const { result } = renderHook(() => useSelectedEngineProvider());
    act(() => setSelectedEngineProvider('   '));
    assert.equal(result.current, null);
  });

  it('المحوران مستقلّان: تغيير المحرّك لا يمسّ الجسم والعكس', () => {
    const { result } = renderHook(() => ({
      body: useSelectedProvider(),
      engine: useSelectedEngineProvider(),
    }));

    act(() => setSelectedProvider('claude'));
    act(() => setSelectedEngineProvider('glm'));
    assert.equal(result.current.body, 'claude');
    assert.equal(result.current.engine, 'glm');

    act(() => setSelectedEngineProvider(null));
    assert.equal(result.current.body, 'claude');
    assert.equal(result.current.engine, null);
  });

  it('نفس المحرّك مرّتين لا يُعيد التصيير', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useSelectedEngineProvider();
    });
    act(() => setSelectedEngineProvider('kimi'));
    const after = renders;
    act(() => setSelectedEngineProvider('kimi'));
    assert.equal(renders, after);
  });
});

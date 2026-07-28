/**
 * B-273 — رجفة شريط الرأس: عاصفة كتابة `uiPreferences`.
 *
 * القياس الميداني الذي وُلد منه هذا الملف: ضغطة واحدة على زرّ عرض التبويبات
 * أنتجت 1510 كتابة للمفتاح و1849 تحوّل DOM في 5.5 ثانية، لأن كل مستهلك كان
 * نسخةً كاتبة تبثّ حالتها، ولأن مسار `storage` بين التبويبات كان بلا حارس.
 *
 * الاختبارات تثبّت الطبقتين: كتابة واحدة لكل تغيير مهما كثر المستهلكون،
 * وصدى قديم لا يُحرِّك الحالة ولا يُنتج كتابة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import {
  UI_PREFERENCES_STORAGE_KEY,
  __resetUiPreferencesStoreForTests,
  useUiPreferences,
} from './useUiPreferences';
import { PREFERENCE_APPLY_EVENT } from '../preferences/preferencesSync';

const nativeSetItem = Storage.prototype.setItem;

let writes: string[] = [];

/** كتابات المفتاح وحده — نتجاهل ما تكتبه وحدات أخرى. */
const writeCount = () => writes.length;

function Consumer({
  id,
  onReady,
}: {
  id: string;
  onReady?: (setMode: (mode: string) => void) => void;
}) {
  const { preferences, setPreference } = useUiPreferences();
  onReady?.((mode: string) => setPreference('tabsDisplayMode', mode));
  return <span data-testid={id}>{preferences.tabsDisplayMode}</span>;
}

/** يُركّب `count` مستهلكاً للخطّاف ويُعيد دالة تغيير الوضع من أوّلهم. */
function renderConsumers(count: number) {
  let setMode: (mode: string) => void = () => {};
  render(
    <>
      {Array.from({ length: count }, (_, index) => (
        <Consumer
          key={index}
          id={`consumer-${index}`}
          onReady={index === 0 ? (fn) => { setMode = fn; } : undefined}
        />
      ))}
    </>,
  );
  return { setMode: (mode: string) => setMode(mode) };
}

const storedVersion = (): number => {
  const raw = localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
  return raw ? (JSON.parse(raw).__v as number) : 0;
};

const storageEvent = (value: Record<string, unknown>) =>
  new StorageEvent('storage', {
    key: UI_PREFERENCES_STORAGE_KEY,
    newValue: JSON.stringify(value),
  });

describe('useUiPreferences — مخزن واحد وحارس صدى (B-273)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetUiPreferencesStoreForTests();
    writes = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === UI_PREFERENCES_STORAGE_KEY) {
        writes.push(value);
      }
      return nativeSetItem.call(this, key, value);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    __resetUiPreferencesStoreForTests();
  });

  it('يكتب مرّة واحدة لكل تغيير مهما بلغ عدد المستهلكين', () => {
    const { setMode } = renderConsumers(6);
    writes = []; // نتجاهل كتابة التطبيع عند التركيب

    act(() => { setMode('compact'); });

    expect(writeCount()).toBe(1);
    for (let index = 0; index < 6; index += 1) {
      expect(screen.getByTestId(`consumer-${index}`).textContent).toBe('compact');
    }
  });

  it('يبقى عدد الكتابات مساوياً لعدد التغييرات في ضغطات متتابعة سريعة', () => {
    const { setMode } = renderConsumers(6);
    writes = [];

    act(() => { setMode('compact'); });
    act(() => { setMode('minimal'); });
    act(() => { setMode('hidden'); });
    act(() => { setMode('full'); });

    expect(writeCount()).toBe(4);
    expect(screen.getByTestId('consumer-5').textContent).toBe('full');
  });

  it('يُهمل صدى تبويب آخر بإصدار أقدم فلا حالة تتغيّر ولا كتابة', () => {
    const { setMode } = renderConsumers(6);
    act(() => { setMode('hidden'); });
    const versionAfterWrite = storedVersion();
    writes = [];

    act(() => {
      window.dispatchEvent(storageEvent({ tabsDisplayMode: 'full', __v: versionAfterWrite - 1 }));
    });

    expect(screen.getByTestId('consumer-0').textContent).toBe('hidden');
    expect(writeCount()).toBe(0);
  });

  it('يتبنّى قيمة تبويب آخر أحدث بلا إعادة كتابة (لا ارتداد)', () => {
    const { setMode } = renderConsumers(6);
    act(() => { setMode('compact'); });
    const version = storedVersion();
    writes = [];

    act(() => {
      window.dispatchEvent(storageEvent({ tabsDisplayMode: 'minimal', __v: version + 1 }));
    });

    expect(screen.getByTestId('consumer-3').textContent).toBe('minimal');
    expect(writeCount()).toBe(0);
  });

  it('يطبّق قيمة الحساب ولو كان وسمها أقدم، ويثبّتها بكتابة واحدة', () => {
    const { setMode } = renderConsumers(2);
    act(() => { setMode('hidden'); });
    writes = [];

    const accountValue = JSON.stringify({ tabsDisplayMode: 'compact', __v: 1 });
    act(() => {
      nativeSetItem.call(localStorage, UI_PREFERENCES_STORAGE_KEY, accountValue);
      window.dispatchEvent(
        new CustomEvent(PREFERENCE_APPLY_EVENT, {
          detail: { storageKey: UI_PREFERENCES_STORAGE_KEY, rawValue: accountValue },
        }),
      );
    });

    expect(screen.getByTestId('consumer-1').textContent).toBe('compact');
    expect(writeCount()).toBe(1); // تطبيع الوسم كي تتبنّاه بقية التبويبات
  });

  it('يقرأ قيمة قديمة بلا وسم إصدار ويطبّعها بكتابة واحدة عند التركيب', () => {
    nativeSetItem.call(
      localStorage,
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ tabsDisplayMode: 'minimal', showThinking: false }),
    );
    writes = [];

    renderConsumers(6);

    expect(screen.getByTestId('consumer-0').textContent).toBe('minimal');
    expect(writeCount()).toBe(1);
    expect(storedVersion()).toBeGreaterThan(0);
  });

  it('يحافظ على تلازم tabsIconOnly مع الوضع عبر كل المستهلكين', () => {
    const { setMode } = renderConsumers(3);

    act(() => { setMode('compact'); });
    expect(JSON.parse(writes[writes.length - 1]).tabsIconOnly).toBe(true);

    act(() => { setMode('full'); });
    expect(JSON.parse(writes[writes.length - 1]).tabsIconOnly).toBe(false);
  });
});

/**
 * useUiPreferences.enterBehavior.test.tsx — ترحيل نيّة مفتاح Enter (‏T-1319).
 *
 * fixtures اصطناعية تمثّل أشكال التخزين التي يدعمها العقد: صفّ حديث مضموم،
 * صفّ كامل، وصفّ قديم تنقصه مفاتيح أضيفت لاحقاً. لا تتضمن بيانات مستخدمين أو
 * معرّفات مأخوذة من قاعدة تشغيل.
 *
 * RUNNER: vitest — jsdom.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  UI_PREFERENCES_STORAGE_KEY,
  __resetUiPreferencesStoreForTests,
  useUiPreferences,
} from './useUiPreferences';

/** Representative, synthetic preference blocks. */
const SYNTHETIC_ROWS: Record<number, Record<string, unknown>> = {
  1: { autoExpandTools: false, showRawParameters: false, showThinking: true, hideToolCalls: true, autoScrollToBottom: true, sendByCtrlEnter: true, sidebarVisible: true, tabsDisplayMode: 'compact', tabsIconOnly: true, showSidebarSearch: true, codeHighlightScope: 'core' },
  2: { autoExpandTools: false, showRawParameters: false, showThinking: true, hideToolCalls: true, autoScrollToBottom: true, sendByCtrlEnter: true, sidebarVisible: true, tabsDisplayMode: 'full', tabsIconOnly: false, showSidebarSearch: true, codeHighlightScope: 'core' },
  3: { autoExpandTools: false, showRawParameters: false, showThinking: true, hideToolCalls: true, autoScrollToBottom: true, sendByCtrlEnter: false, sidebarVisible: true, tabsIconOnly: false },
  5: { autoExpandTools: false, showRawParameters: false, showThinking: false, hideToolCalls: true, autoScrollToBottom: true, sendByCtrlEnter: false, sidebarVisible: true, tabsDisplayMode: 'full', tabsIconOnly: false },
  7: { autoExpandTools: true, showRawParameters: false, showThinking: true, hideToolCalls: false, autoScrollToBottom: true, sendByCtrlEnter: false, sidebarVisible: true, tabsDisplayMode: 'full', tabsIconOnly: false, showSidebarSearch: true, codeHighlightScope: 'core' },
};

const EXPECTED: Record<number, 'auto' | 'send' | 'newline'> = {
  1: 'newline',
  2: 'newline',
  3: 'auto',
  5: 'auto',
  7: 'auto',
};

/** مفاتيح حزمة العميل **القديمة** — لا `enterBehavior` فيها. */
const LEGACY_PREFERENCE_KEYS = [
  'autoExpandTools',
  'showRawParameters',
  'showThinking',
  'hideToolCalls',
  'autoScrollToBottom',
  'sendByCtrlEnter',
  'sidebarVisible',
  'tabsDisplayMode',
  'tabsIconOnly',
  'showSidebarSearch',
  'codeHighlightScope',
];

const readStored = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) ?? '{}');

const seed = (value: Record<string, unknown>) => {
  window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(value));
};

beforeEach(() => {
  window.localStorage.clear();
  __resetUiPreferencesStoreForTests();
});
afterEach(() => {
  window.localStorage.clear();
  __resetUiPreferencesStoreForTests();
});

describe('ترحيل أشكال التخزين المدعومة إلى enterBehavior', () => {
  for (const userId of Object.keys(SYNTHETIC_ROWS).map(Number)) {
    it(`case ${userId} (sendByCtrlEnter=${SYNTHETIC_ROWS[userId].sendByCtrlEnter}) → '${EXPECTED[userId]}'`, () => {
      seed(SYNTHETIC_ROWS[userId]);
      const { result } = renderHook(() => useUiPreferences());

      expect(result.current.preferences.enterBehavior).toBe(EXPECTED[userId]);
      // والمرآة تبقى مطابقة للنيّة بعد الترحيل، فلا تنجرف الكتلة.
      expect(result.current.preferences.sendByCtrlEnter).toBe(EXPECTED[userId] === 'newline');
      // ولا يُمَسّ شيء آخر في الصفّ — المفتاح القديم `hideToolCalls` يُرحَّل
      // وحده إلى `showToolCalls` بعكس الدلالة، وبقية الحقول كما هي.
      expect(result.current.preferences.showThinking).toBe(SYNTHETIC_ROWS[userId].showThinking);
      expect(result.current.preferences.showToolCalls).toBe(!SYNTHETIC_ROWS[userId].hideToolCalls);
    });
  }

  /* ثابتة `tabsIconOnly`/`tabsDisplayMode` القائمة لا تنكسر بإضافة المفتاح
   * الجديد — الحالة الأولى تمثّل الصفّ المضموم. */
  it('ثابتة التبويبات تبقى سليمة على الصفّ المضموم', () => {
    seed(SYNTHETIC_ROWS[1]);
    const { result } = renderHook(() => useUiPreferences());

    expect(result.current.preferences.tabsDisplayMode).toBe('compact');
    expect(result.current.preferences.tabsIconOnly).toBe(true);
  });

  it('حساب فارغ تماماً يبدأ على auto (‏Enter حسب الجهاز)', () => {
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.preferences.enterBehavior).toBe('auto');
    expect(result.current.preferences.sendByCtrlEnter).toBe(false);
  });

  /* مستخدم أقدم من الكتلة الموحّدة أصلاً: مفاتيح مفردة في localStorage. */
  it('المسار القديم (مفاتيح مفردة) يشتقّ النيّة من المفتاح المفرد', () => {
    window.localStorage.setItem('sendByCtrlEnter', 'true');
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.preferences.enterBehavior).toBe('newline');
  });
});

describe('المرآة تُكتب مع كل تغيير للنيّة', () => {
  const MIRROR: Array<['auto' | 'send' | 'newline', boolean]> = [
    ['newline', true],
    ['send', false],
    ['auto', false],
  ];

  for (const [behavior, mirror] of MIRROR) {
    it(`‏${behavior} ⇒ sendByCtrlEnter=${mirror} في التخزين`, () => {
      const { result } = renderHook(() => useUiPreferences());

      act(() => result.current.setPreference('enterBehavior', behavior));

      expect(result.current.preferences.enterBehavior).toBe(behavior);
      expect(result.current.preferences.sendByCtrlEnter).toBe(mirror);
      expect(readStored().enterBehavior).toBe(behavior);
      expect(readStored().sendByCtrlEnter).toBe(mirror);
    });
  }

  it('كتابة المرآة مباشرةً لا تكسر الثابتة (مسار مستهلك خارجي)', () => {
    const { result } = renderHook(() => useUiPreferences());

    act(() => result.current.setPreference('enterBehavior', 'send'));
    act(() => result.current.setPreference('sendByCtrlEnter', true));

    expect(result.current.preferences.enterBehavior).toBe('newline');
  });

  it('قيمة غير صالحة لا تُقسر إلى false بل تبقى على الحالية', () => {
    const { result } = renderHook(() => useUiPreferences());

    act(() => result.current.setPreference('enterBehavior', 'always'));

    expect(result.current.preferences.enterBehavior).toBe('auto');
  });
});

describe('الرحلة الثلاثية: جديد ← قديم ← جديد', () => {
  /**
   * يحاكي حزمة العميل القديمة: تختزل الكتلة على مفاتيحها هي وحدها (فيسقط
   * `enterBehavior`)، ثم تكتب الحالة كاملةً فوق الحساب. وهو ما يفعله فعلاً أي
   * تبويب يشغّل حزمةً سبقت هذه الميزة — والـService Worker يجعل ذلك واقعاً.
   */
  const throughLegacyClient = (block: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of LEGACY_PREFERENCE_KEYS) {
      out[key] = block[key];
    }
    return out;
  };

  const roundTrip = (behavior: 'auto' | 'send' | 'newline') => {
    // 1) عميل جديد يكتب النيّة.
    const first = renderHook(() => useUiPreferences());
    act(() => first.result.current.setPreference('enterBehavior', behavior));
    const written = readStored();

    // 2) عميل قديم يقرأ ويكتب الكتلة كاملةً بلا المفتاح الجديد.
    const legacyBlock = throughLegacyClient(written);
    expect('enterBehavior' in legacyBlock).toBe(false);
    seed(legacyBlock);

    // 3) عميل جديد يُقلع من جديد على ما تركه القديم.
    __resetUiPreferencesStoreForTests();
    const second = renderHook(() => useUiPreferences());
    return second.result.current.preferences;
  };

  it("‏'newline' تعبر الرحلة سالمة", () => {
    expect(roundTrip('newline').enterBehavior).toBe('newline');
  });

  it("‏'auto' تعبر الرحلة سالمة", () => {
    expect(roundTrip('auto').enterBehavior).toBe('auto');
  });

  /* خانة الفقد المقبولة والموثَّقة: `send` و`auto` تُنتجان نفس المرآة
   * (`false`)، فالحمولة العائدة من العميل القديم لا تحمل ما يفرّق بينهما.
   * وعلى سطح المكتب `auto ≡ send` فلا فرق مرئي؛ والضرر محصور في مستخدم لمسٍ
   * اختار «إرسال» صراحةً، وانحدارُه إلى الافتراض الآمن. تُثبَّت ولا تُعالَج. */
  it("‏'send' تنحدر إلى 'auto' — فقدٌ مقبول موثَّق", () => {
    expect(roundTrip('send').enterBehavior).toBe('auto');
  });

  /* والنقطة التي تجعل بقاء المرآة إلزامياً: لو حُذف `sendByCtrlEnter` لما وجد
   * العميل القديم أيّ إشارة، فسقط على الافتراض «‏Enter يُرسل» وكتبه فوق
   * الحساب — أي محو نيّة `'newline'` صامتاً على كل الأجهزة. */
  it('العميل القديم يجد إشارةً صحيحة في المرآة لا فراغاً', () => {
    const { result } = renderHook(() => useUiPreferences());
    act(() => result.current.setPreference('enterBehavior', 'newline'));

    const legacyBlock = throughLegacyClient(readStored());
    expect(legacyBlock.sendByCtrlEnter).toBe(true);
  });
});

describe('حمولة الحساب/التبويب الآخر (set_many)', () => {
  it('حمولة حديثة تحمل النيّة صراحةً فتقودها', () => {
    const { result } = renderHook(() => useUiPreferences());

    act(() => result.current.setPreferences({ enterBehavior: 'send', sendByCtrlEnter: true }));

    // النيّة الصريحة هي الحاكم، والمرآة تُصحَّح خلفها.
    expect(result.current.preferences.enterBehavior).toBe('send');
    expect(result.current.preferences.sendByCtrlEnter).toBe(false);
  });

  it('حمولة قديمة (مرآة وحدها) تُشتقّ منها النيّة', () => {
    const { result } = renderHook(() => useUiPreferences());

    act(() => result.current.setPreferences({ sendByCtrlEnter: true }));
    expect(result.current.preferences.enterBehavior).toBe('newline');

    act(() => result.current.setPreferences({ sendByCtrlEnter: false }));
    expect(result.current.preferences.enterBehavior).toBe('auto');
  });
});

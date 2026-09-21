import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENTER_BEHAVIORS,
  FINE_POINTER_QUERY,
  decideEnterAction,
  enterBehaviorFromLegacy,
  enterBehaviorToLegacy,
  parseEnterBehavior,
  resolveEnterSends,
  type EnterAction,
  type EnterBehavior,
} from './enter-behavior';

/*
 * ‏T-1319 — سلوك مفتاح Enter.
 *
 * الدالّة نقيّة بلا DOM، فتُختبَر جدولياً على كل تقاطع بلا تركيب أي مكوّن.
 */

const fine = { hasFinePointer: true }; // كمبيوتر، أو لوحيّ موصولٌ بلوحة مفاتيح
const coarse = { hasFinePointer: false }; // جوال/لوحيّ بإصبع وحده

describe('resolveEnterSends — المصفوفة الكاملة', () => {
  /* الجدول المطلوب حرفياً: (auto|send|newline) × (fine|coarse). */
  const MATRIX: Array<[EnterBehavior, boolean, boolean]> = [
    // [النيّة، fine → يُرسل؟، coarse → يُرسل؟]
    ['auto', true, false],
    ['send', true, true],
    ['newline', false, false],
  ];

  for (const [stored, onFine, onCoarse] of MATRIX) {
    it(`‏${stored}: fine=${onFine} / coarse=${onCoarse}`, () => {
      assert.equal(resolveEnterSends(stored, fine), onFine);
      assert.equal(resolveEnterSends(stored, coarse), onCoarse);
    });
  }

  /* جوهر الميزة: الافتراض وحده يتبع الجهاز. */
  it('auto وحدها تختلف بين البيئتين', () => {
    assert.notEqual(resolveEnterSends('auto', fine), resolveEnterSends('auto', coarse));
    assert.equal(resolveEnterSends('send', fine), resolveEnterSends('send', coarse));
    assert.equal(resolveEnterSends('newline', fine), resolveEnterSends('newline', coarse));
  });

  /* البرهان الذي أسقط البوليان: لولا القيمة الثالثة لما استطاع مستخدم اللمس
   * استعادة الإرسال بـEnter أبداً. */
  it('مستخدم اللمس يملك استعادة الإرسال صراحةً', () => {
    assert.equal(resolveEnterSends('send', coarse), true);
  });

  it('الاستعلام يقيس وجود مؤشّر دقيق لا نوع الأوّلي', () => {
    assert.equal(FINE_POINTER_QUERY, '(any-pointer: fine)');
  });
});

describe('decideEnterAction — المصفوفة الكاملة (نيّة × بيئة × ضغطة)', () => {
  const chord = (extra: Partial<Parameters<typeof decideEnterAction>[0]> = {}) => ({
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...extra,
  });

  const PRESSES = {
    Enter: chord(),
    'Shift+Enter': chord({ shiftKey: true }),
    'Ctrl+Enter': chord({ ctrlKey: true }),
    'Alt+Enter': chord({ altKey: true }),
  } as const;

  /**
   * كل خانة مصرَّح بها نصّاً. `Enter` وحدها تتبع النيّة والبيئة؛ والثلاث
   * الأخرى ثابتة عبر الصفّ كلّه — وهذا هو المقصود:
   *   • Ctrl+Enter مخرج طوارئ يعمل في كل حال.
   *   • Shift+Enter سطرٌ جديد في كل حال.
   *   • Alt+Enter سطرٌ جديد في كل حال (قرارٌ مقصود يصحّح سهواً قائماً كان
   *     يجعله يُرسل كلّما كانت Enter المجرّدة تُرسل).
   */
  const MATRIX: Array<[EnterBehavior, 'fine' | 'coarse', Record<keyof typeof PRESSES, EnterAction>]> = [
    ['auto', 'fine', { Enter: 'send', 'Shift+Enter': 'newline', 'Ctrl+Enter': 'send', 'Alt+Enter': 'newline' }],
    ['auto', 'coarse', { Enter: 'newline', 'Shift+Enter': 'newline', 'Ctrl+Enter': 'send', 'Alt+Enter': 'newline' }],
    ['send', 'fine', { Enter: 'send', 'Shift+Enter': 'newline', 'Ctrl+Enter': 'send', 'Alt+Enter': 'newline' }],
    ['send', 'coarse', { Enter: 'send', 'Shift+Enter': 'newline', 'Ctrl+Enter': 'send', 'Alt+Enter': 'newline' }],
    ['newline', 'fine', { Enter: 'newline', 'Shift+Enter': 'newline', 'Ctrl+Enter': 'send', 'Alt+Enter': 'newline' }],
    ['newline', 'coarse', { Enter: 'newline', 'Shift+Enter': 'newline', 'Ctrl+Enter': 'send', 'Alt+Enter': 'newline' }],
  ];

  for (const [stored, envName, expected] of MATRIX) {
    const env = envName === 'fine' ? fine : coarse;
    const enterSends = resolveEnterSends(stored, env);

    for (const press of Object.keys(PRESSES) as Array<keyof typeof PRESSES>) {
      it(`‏${stored} × ${envName} × ${press} → ${expected[press]}`, () => {
        assert.equal(decideEnterAction(PRESSES[press], enterSends), expected[press]);
      });
    }
  }

  /* ‏Cmd+Enter على macOS مسارٌ مكافئ لـCtrl+Enter، وShift يُلغي الإرسال معهما
   * (سلوك قائم لم يُمَسّ: الفرع يشترط `!shiftKey`). */
  it('Cmd+Enter يُرسل، وShift معه يُلغي الإرسال', () => {
    assert.equal(decideEnterAction(chord({ metaKey: true }), false), 'send');
    assert.equal(decideEnterAction(chord({ metaKey: true, shiftKey: true }), true), 'newline');
    assert.equal(decideEnterAction(chord({ ctrlKey: true, shiftKey: true }), true), 'newline');
  });

  /* تركيب IME يسبق كل شيء: الضغطة تُنهي التركيب ولا تُرسل — حتى مع Ctrl. */
  it('تركيب IME لا يُرسل مهما كان المُعدِّل', () => {
    assert.equal(decideEnterAction(chord({ isComposing: true }), true), 'newline');
    assert.equal(decideEnterAction(chord({ isComposing: true, ctrlKey: true }), true), 'newline');
  });

  /* توثيق التغيير في `Alt`: قبل T-1319 كان `Alt+Enter` مساوياً لـEnter
   * المجرّدة تماماً (الشرط لم يفحص `altKey` أصلاً) فكان يُرسل. */
  it('Alt+Enter لم يعد مساوياً لـEnter المجرّدة', () => {
    assert.equal(decideEnterAction(chord(), true), 'send');
    assert.equal(decideEnterAction(chord({ altKey: true }), true), 'newline');
  });
});

describe('parseEnterBehavior', () => {
  it('يقبل قيم الـenum وحدها', () => {
    for (const value of ENTER_BEHAVIORS) {
      assert.equal(parseEnterBehavior(value, 'auto'), value);
    }
  });

  /* حمولةٌ من عميلٍ آخر قد تحمل أي شيء؛ لا تُقسر إلى `false` كما كان يفعل
   * المُختزِل البوليانيّ القديم. */
  it('يردّ ما ليس من الـenum إلى البديل', () => {
    for (const bad of [true, false, null, undefined, 0, 'SEND', {}, []]) {
      assert.equal(parseEnterBehavior(bad, 'newline'), 'newline');
    }
  });
});

describe('جسر المرآة القديمة sendByCtrlEnter', () => {
  /* الجدول المحسوم: 'auto' → false قصداً كي يبقى العميل القديم على سلوكه. */
  it('المرآة للأمام: newline→true، send→false، auto→false', () => {
    assert.equal(enterBehaviorToLegacy('newline'), true);
    assert.equal(enterBehaviorToLegacy('send'), false);
    assert.equal(enterBehaviorToLegacy('auto'), false);
  });

  it('الاشتقاق العكسي: true→newline، false→auto', () => {
    assert.equal(enterBehaviorFromLegacy(true), 'newline');
    assert.equal(enterBehaviorFromLegacy(false), 'auto');
  });

  /* لا انحدار على العميل القديم: من لم يغيّر شيئاً (auto) يبقى Enter عنده
   * مُرسِلاً كما هو اليوم. ولو كانت auto→true لتوقّف الإرسال بـEnter على كل
   * أسطح المكتب التي تشغّل حزمة قديمة. */
  it('auto لا تُوقف الإرسال على العميل القديم', () => {
    assert.equal(enterBehaviorToLegacy('auto'), false, 'العميل القديم: false = Enter يُرسل');
  });

  /* خانة الفقد المقبولة الموثَّقة: send وauto تُنتجان نفس المرآة، فرحلة
   * (جديد ← قديم ← جديد) تُعيد send إلى auto. لا تُعالَج — تُثبَّت. */
  it('يوثّق فقد send→auto في الرحلة عبر عميل قديم', () => {
    assert.equal(enterBehaviorToLegacy('send'), enterBehaviorToLegacy('auto'));
    assert.equal(enterBehaviorFromLegacy(enterBehaviorToLegacy('send')), 'auto');
    // والقيمة الصريحة الأخرى تعبر الرحلة سالمة.
    assert.equal(enterBehaviorFromLegacy(enterBehaviorToLegacy('newline')), 'newline');
  });

  /* استقرار: تطبيق الاشتقاق على مرآةٍ مشتقّة لا يزحزح شيئاً بعد الخانة أعلاه. */
  it('الجسر مستقرّ عند إعادة التطبيق', () => {
    for (const behavior of ENTER_BEHAVIORS) {
      const once = enterBehaviorFromLegacy(enterBehaviorToLegacy(behavior));
      const twice = enterBehaviorFromLegacy(enterBehaviorToLegacy(once));
      assert.equal(twice, once);
    }
  });
});

/**
 * B-442 — أيّ لغةٍ تبدأ بها الواجهة حين لا يكون في التخزين تفضيلٌ صالح.
 *
 * العطل الذي يحرسه هذا الملف لم يكن في مكوّنٍ ولا في حزمة ترجمة — كان في أن
 * `getSavedLanguage` أجابت عن سؤالٍ واحد بجوابين: تفضيلٌ **ميّت** (لغة أُسقطت من
 * `languages.js`) يقع على العربية بحجّة أن التطبيق عربيٌّ أوّلاً، بينما **غيابُ**
 * التفضيل يقع على الإنجليزية. فالدعوى «عربيٌّ أوّلاً» كانت تصدق على من سبق أن
 * اختار وحده — لا على أول زيارة، ولا على متصفّحٍ ثانٍ، ولا بعد مسح التخزين. وهذا
 * ما رآه المالك في 2026-08-05: لوحة إعداداتٍ إنجليزية بالكامل و`ar` أغنى حزمة
 * على القرص.
 *
 * ولذلك تُختبر الحالات الأربع معاً لا الحالة المكسورة وحدها: القيمة الافتراضية
 * وحدها لا تكشف الانفصام، وإنما اتّفاقُ الحالات الثلاث «لا شيء صالح مخزَّن» على
 * جوابٍ واحد هو ما انكسر.
 *
 * ويُعاد ضبط الوحدة (`resetModules`) قبل كل حالة لأن `config.js` يقرأ التخزين
 * **عند الاستيراد** مرّةً واحدة: بلا ذلك تُقاس الحالة الأولى أربع مرات.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { FALLBACK_UI_LANGUAGE } from './languages.js';

/** يبني `localStorage` وهمياً يعيد ما نريد — أو يرمي، وهي حالةٌ واقعية. */
const stubStorage = (getItem: () => string | null) => {
  vi.stubGlobal('localStorage', {
    getItem,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
};

const startLanguage = async () => {
  const mod = await import('./config.js');
  return mod.default.language;
};

describe('B-442 — لغة البدء حين لا تفضيلَ صالحاً', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('العربية هي الأساس المعلن للواجهة', () => {
    expect(FALLBACK_UI_LANGUAGE).toBe('ar');
  });

  it('زائرٌ بلا تفضيلٍ مخزَّن يبدأ على العربية لا الإنجليزية', async () => {
    stubStorage(() => null);
    await expect(startLanguage()).resolves.toBe(FALLBACK_UI_LANGUAGE);
  });

  it('تفضيلٌ للغةٍ لم تعد قابلة للاختيار يقع على العربية', async () => {
    stubStorage(() => 'kl-GL');
    await expect(startLanguage()).resolves.toBe(FALLBACK_UI_LANGUAGE);
  });

  it('تخزينٌ يرمي (وضعٌ خاص أو تخزينٌ محجوب) يقع على العربية', async () => {
    stubStorage(() => {
      throw new Error('storage is blocked');
    });
    await expect(startLanguage()).resolves.toBe(FALLBACK_UI_LANGUAGE);
  });

  it('تفضيلٌ صالحٌ مخزَّن يُحترم ولا يُسحق بالأساس', async () => {
    stubStorage(() => 'en');
    await expect(startLanguage()).resolves.toBe('en');
  });
});

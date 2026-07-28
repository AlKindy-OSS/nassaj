/**
 * B-RTL-STREAM — اهتزاز اتجاه الحاوية أثناء البثّ.
 *
 * القياس على 4,796 رسالة عربية حقيقية: 14.4% منها تنقلب حاويتها وسط البثّ
 * (متوسط 1.95 انقلاب، أقصاها 16)، و6.9% تنقلب بعد أن يكون ربع النصّ أمام عين
 * القارئ. السبب: `content` ينمو ~10 مرات/ثانية فيُعاد حساب اتجاه الحاوية على
 * نصّ ناقص — والكتلة الأخيرة (قيد الكتابة) تصوّت وهي نصف جملة.
 *
 * العلاج المعتمد = D + B فقط (قيست أثمانه):
 *   D — الكتلة الأخيرة لا تصوّت ما دام هناك كتلة مكتملة واحدة على الأقل.
 *   B — لا حسم قبل 40 حرفاً قوياً؛ قبلها `null` ⇒ لا سِمة ⇒ وراثة المستند.
 * الهستيريزيس (C) مرفوضة عمداً: ثمنها 2.79% وتنقل الانقلاب إلى لحظة الإنهاء.
 *
 * القيد الحاكم: هذا كله مشروط بـ`streaming: true`. الرسالة المكتملة تُحسب
 * بالقاعدة القديمة حرفياً — وإلا فقدت الرسائل القصيرة اتجاهها.
 *
 * Run: NODE_ENV=test npx vitest run src/utils/textDirection.streaming.test.ts
 */

import { describe, it, expect } from 'vitest';

import { resolveContainerDirection, countStrong } from './textDirection';

/** مجموع الحروف القوية بالاتجاهين — لتوثيق العتبة بالأرقام لا بالتخمين. */
const strongTotal = (s: string) => countStrong(s, 'rtl') + countStrong(s, 'ltr');

// فقرة عربية مكتملة (أول كتلة) — تتجاوز عتبة الـ40 وحدها.
const ARABIC_BLOCK =
  'أعدت قراءة سجلّ الجلسة كاملاً ثم قارنته بمخرَج الأداة قبل أي تعديل على الكود.';

// فقرتان إنجليزيتان: الثانية هي التي «تنمو» أثناء البثّ.
const ENGLISH_BLOCK = 'The upstream runbook says the port stays bound until the drain ends.';
const ENGLISH_TAIL = 'A third paragraph that is still being written right now';

describe('resolveContainerDirection — D: الكتلة الأخيرة قيد النمو لا تصوّت', () => {
  const source = `${ARABIC_BLOCK}\n\n${ENGLISH_BLOCK}\n\n${ENGLISH_TAIL}`;

  it('الرسالة المكتملة تُحسب بكل كتلها (سلوك غير مُمَسّ)', () => {
    // 1 rtl مقابل 2 ltr ⇒ ltr. هذا هو الحكم النهائي الصحيح للرسالة المكتملة.
    expect(resolveContainerDirection(source)).toBe('ltr');
  });

  it('أثناء البثّ تُسقَط الكتلة الأخيرة من التصويت فلا تقلب الحاوية قبل اكتمالها', () => {
    // بإسقاط الذيل: 1 rtl مقابل 1 ltr ⇒ تعادل ⇒ اتجاه أول كتلة مصوِّتة = rtl.
    expect(resolveContainerDirection(source, { streaming: true })).toBe('rtl');
  });

  it('كتلة واحدة فقط ⇒ تصوّت رغم أنها تنمو (وإلا فقدت الرسالة اتجاهها كلياً)', () => {
    expect(strongTotal(ARABIC_BLOCK)).toBeGreaterThanOrEqual(40);
    expect(resolveContainerDirection(ARABIC_BLOCK, { streaming: true })).toBe('rtl');
  });

  it('لا انقلاب واحد بينما تنمو الكتلة الأخيرة حرفاً حرفاً', () => {
    const settled = `${ARABIC_BLOCK}\n\n`;
    const seen: (string | null)[] = [];
    for (let i = 0; i <= ENGLISH_TAIL.length; i += 1) {
      seen.push(resolveContainerDirection(settled + ENGLISH_TAIL.slice(0, i), { streaming: true }));
    }
    const flips = seen.filter((d, i) => i > 0 && d !== seen[i - 1]).length;
    expect(new Set(seen)).toEqual(new Set(['rtl']));
    expect(flips).toBe(0);
  });
});

describe('resolveContainerDirection — B: عتبة 40 حرفاً قوياً قبل الحسم', () => {
  it('بداية البثّ القصيرة لا تُحسم ⇒ null ⇒ وراثة المستند بلا سِمة', () => {
    const early = 'أعدت قراءة سجلّ';
    expect(strongTotal(early)).toBeLessThan(40);
    expect(resolveContainerDirection(early, { streaming: true })).toBeNull();
  });

  it('مقطع لاتيني قصير في مستهلّ رسالة عربية لا يحسم الاتجاه للاتينية', () => {
    // الحالة المؤذية المقيسة: الردّ يفتح بمعرّف/أمر لاتيني ثم يستدير عربياً.
    const early = 'safe-restart.sh';
    expect(resolveContainerDirection(early)).toBe('ltr'); // الحكم القديم
    expect(resolveContainerDirection(early, { streaming: true })).toBeNull();
  });

  it('بعد تجاوز العتبة يُحسم الاتجاه ولا يعود null', () => {
    expect(strongTotal(ARABIC_BLOCK)).toBeGreaterThanOrEqual(40);
    expect(resolveContainerDirection(ARABIC_BLOCK, { streaming: true })).toBe('rtl');
  });

  it('العتبة لا تمسّ الرسائل المكتملة القصيرة إطلاقاً', () => {
    expect(resolveContainerDirection('تمّ.')).toBe('rtl');
    expect(resolveContainerDirection('Done.')).toBe('ltr');
    expect(resolveContainerDirection('تمّ.', { streaming: false })).toBe('rtl');
  });

  it('الدالة تبقى نقيّة: نفس المدخل ⇒ نفس المخرَج مهما تكرّر النداء', () => {
    const partial = `${ARABIC_BLOCK}\n\nThe upstream run`;
    const first = resolveContainerDirection(partial, { streaming: true });
    for (let i = 0; i < 5; i += 1) {
      expect(resolveContainerDirection(partial, { streaming: true })).toBe(first);
    }
  });
});

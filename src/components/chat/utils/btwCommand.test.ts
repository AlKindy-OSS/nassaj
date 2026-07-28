/**
 * T-849 — كاشف أمر «/btw» (منطق التوجيه الخالص).
 *
 * يثبت البوابة الفاصلة: أي إدخال «/btw <سؤال>» يُصنَّف أمر قناة جانبية (فيُعترَض
 * ويُوجَّه إلى btw-query) لا رسالة عادية؛ وما عداه (نص عادي، «/btwx»، «/btw»
 * وحدها بلا سؤال) يسقط للمسار العادي بلا تغيير.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/utils/btwCommand.test.ts
 */

import { describe, it, expect } from 'vitest';

import { isBtwCommand, parseBtwQuestion, BTW_PREFIX } from './btwCommand';

describe('btwCommand — كشف أمر /btw', () => {
  it('البادئة هي «/btw » بمسافة لاحقة', () => {
    expect(BTW_PREFIX).toBe('/btw ');
  });

  it('«/btw <سؤال>» أمر btw صالح ويستخرج السؤال منظّفاً', () => {
    expect(isBtwCommand('/btw لماذا السماء زرقاء؟')).toBe(true);
    expect(parseBtwQuestion('/btw لماذا السماء زرقاء؟')).toBe('لماذا السماء زرقاء؟');
  });

  it('يتجاهل الفراغ البادئ ويقلّم الفراغ المحيط بالسؤال', () => {
    expect(isBtwCommand('   /btw   ما هذا؟   ')).toBe(true);
    expect(parseBtwQuestion('   /btw   ما هذا؟   ')).toBe('ما هذا؟');
  });

  it('غير حسّاس لحالة أحرف كلمة الأمر', () => {
    expect(isBtwCommand('/BTW hello')).toBe(true);
    expect(parseBtwQuestion('/BtW hello')).toBe('hello');
  });

  it('«/btw» وحدها أو ببلا سؤال ليست أمراً (تسقط للمسار العادي)', () => {
    expect(isBtwCommand('/btw')).toBe(false);
    expect(isBtwCommand('/btw ')).toBe(false);
    expect(isBtwCommand('/btw    ')).toBe(false);
    expect(parseBtwQuestion('/btw ')).toBe('');
  });

  it('«/btwx» ليست أمر btw (لا مسافة بعد الأمر)', () => {
    expect(isBtwCommand('/btwx hello')).toBe(false);
    expect(parseBtwQuestion('/btwفكرة')).toBe('');
  });

  it('النص العادي والأوامر الأخرى ليست أمر btw', () => {
    expect(isBtwCommand('مرحباً، كيف حالك؟')).toBe(false);
    expect(isBtwCommand('اشرح لي الكود')).toBe(false);
    expect(isBtwCommand('/help')).toBe(false);
    expect(isBtwCommand('/review 123')).toBe(false);
    // «btw» بلا سلاش ليست أمراً — فلا تُعترَض
    expect(isBtwCommand('btw what time is it')).toBe(false);
  });

  it('مدخلات غير نصية تسقط بأمان', () => {
    // @ts-expect-error اختبار المتانة ضد قيم غير نصية
    expect(isBtwCommand(null)).toBe(false);
    // @ts-expect-error اختبار المتانة ضد قيم غير نصية
    expect(parseBtwQuestion(undefined)).toBe('');
  });
});

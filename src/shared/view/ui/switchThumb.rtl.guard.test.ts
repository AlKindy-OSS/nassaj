/**
 * B-373 — مقبض المفتاح (switch thumb) يجب أن يُزاح بمتغيّرَي ltr/rtl، لا بقيمة
 * مطلقة.
 *
 * `transform: translateX()` لا ينعكس مع `dir`: الموجب يحرّك يميناً في الاتجاهين.
 * وجسم المفتاح `inline-flex`, فالمقبض يبدأ من الحافة الداخلية اليسرى في LTR ومن
 * **اليمنى** في RTL. إزاحة موجبة ثابتة تعني إذن: صحيحة في LTR، وقاذفة للمقبض
 * خارج المسار في RTL — وهو ما ظهر في مفتاح «الوضع الداكن» على الجوال: قرص أبيض
 * معلّق خارج الحبّة.
 *
 * ولا يكفي أن تُضاف `rtl:` فوق صنف غير مشروط: كلاهما يكتب `--tw-translate-x`
 * نفسه بنفس الوزن (متغيّرات tailwindcss-rtl تُصاغ بـ`:where()` عديمة الوزن)،
 * فيتحدّد الفائز بترتيب الملف المولَّد لا بالقصد. لذا يُمنع هنا **وجود أي صنف
 * إزاحة أفقية غير مشروط** في هذه الملفات، لا أن تُختبَر النتيجة.
 *
 * jsdom لا يُصرّف Tailwind ولا يحسب تخطيطاً، فالحارس على الصياغة في المصدر —
 * وهي العقد الذي يكتبه المكوّن فعلاً.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/shared/view/ui/switchThumb.rtl.guard.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../..');

/** كل مكوّن يرسم مقبض مفتاح بإزاحة أفقية. */
const SWITCH_FILES = [
  'shared/view/ui/DarkModeToggle.tsx',
  'components/settings/view/SettingsToggle.tsx',
  'components/settings/view/tabs/CommandBoardSettingsTab.tsx',
];

/** صنف إزاحة أفقية غير مسبوق بـltr:/rtl: — ما عدا التوسيط المتماثل -translate-x-1/2. */
const UNCONDITIONAL_TRANSLATE_X = /(?<![\w:-])-?translate-x-(?!1\/2)[\w./[\]%-]+/g;

describe('B-373 — إزاحة مقبض المفتاح مشروطة بالاتجاه', () => {
  it.each(SWITCH_FILES)('%s لا يحمل إزاحة أفقية غير مشروطة', (relative) => {
    const source = readFileSync(resolve(SRC, relative), 'utf8');

    // التعليقات تشرح العلّة وتذكر الأصناف نصّاً، فتُطرح قبل الفحص.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code.match(UNCONDITIONAL_TRANSLATE_X) ?? []).toEqual([]);
  });

  it('DarkModeToggle يشحن الطرفين لكل حالة', () => {
    const source = readFileSync(resolve(SRC, 'shared/view/ui/DarkModeToggle.tsx'), 'utf8');

    for (const token of [
      'ltr:translate-x-[22px]',
      'rtl:-translate-x-[22px]',
      'ltr:translate-x-[2px]',
      'rtl:-translate-x-[2px]',
    ]) {
      expect(source).toContain(token);
    }
  });
});

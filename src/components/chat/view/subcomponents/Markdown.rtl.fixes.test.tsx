/**
 * B-RTL-MD — ثلاثة أعطال مقيسة في مُصيِّر الماركداون.
 *
 * ١. رياضيات الدولار المفرد كانت مفعَّلة: `remark-math` يبتلع `$` في النثر
 *    العربي فتُمحى المبالغ («التكلفة $5 ثم $10 شهرياً» تُرسَم مشوّهة).
 *    وحين تُرسَم صيغة فعلية داخل فقرة `dir="rtl"` كانت تنعكس (`a + b − c =`
 *    تصير `= c − b + a`) لأن محارف العمليات محايدة bidi فتتبع اتجاه الفقرة.
 *    (ورقة `katex.min.css` نفسها محمَّلة على مستوى التطبيق في `src/main.jsx`
 *    منذ 1.16.2 — لم تكن ناقصة قط، ولا تُستورَد في `Markdown.tsx`.)
 * ٢. `<li>` كان يحمل `dir` مخالفاً لقائمته فتقفز نقطته للحافة المقابلة —
 *    7 رسائل (1.9%) و10 عناصر في 360 رسالة حقيقية.
 * ٣. محاذاة أعمدة GFM (`|---:|`) كانت تُسقَط صامتة: `blockComponent` يبني
 *    العنصر بـ`className`/`dir` فقط ويُهمل `align` القادم من hast.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.rtl.fixes.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

import { Markdown } from './Markdown';

/**
 * قواعد `.katex` من ورقة الأنماط الفعلية، مُحمَّلة بمسار نسبيّ إلى هذا الملف
 * (لا إلى `process.cwd()`) ومُستخرَجة بمحلّل CSS حقيقي لا بـregex على النصّ.
 *
 * الحقن في jsdom ضرورة: vitest يُبطل استيراد أي ملف CSS (معالجة CSS مطفأة،
 * حتى مع `?raw`/`?inline`)، وحقنُ الورقة كاملةً يفشل لأن محلّل jsdom يسقط
 * أمام `@tailwind`. المُؤكَّد بعد الحقن هو الأثر: اتجاه عنصر `.katex` المحسوب
 * على شجرة KaTeX الحقيقية — لا وجود سطر في ملف.
 */
const katexStyleRules = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(resolve(here, '../../../../index.css'), 'utf8');
  const rules: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selectors.some((selector) => /(^|\s|>|~|\+)\.katex(-display)?$/.test(selector))) {
      rules.push(rule.toString());
    }
  });
  return rules.join('\n');
})();

// محاكاة جزئية: `Markdown` يجرّ سلسلة تصل إلى `src/i18n/config.js` التي تستدعي
// `initReactI18next`، فإسقاط التصديرات الأصلية يُسقط الحزمة كلها قبل أول اختبار.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
  }),
}));

// `CodeBlock` يستدعي `useAuth` وهي ترمي خارج `AuthProvider`.
vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

afterEach(cleanup);

describe('Markdown — رياضيات الدولار لا تبتلع المبالغ في النثر العربي', () => {
  it('«التكلفة $5 ثم $10 شهرياً» تُرسَم حرفياً بلا حذف ولا عقدة math', () => {
    const line = 'التكلفة $5 ثم $10 شهرياً';
    const { container } = render(<Markdown>{line}</Markdown>);

    expect(container.textContent).toBe(line);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('math')).toBeNull();
    // `annotation` بصمة شجرة KaTeX (MathML)؛ غيابها يُثبت أن لا عقدة رياضيات أُنتجت.
    expect(container.querySelector('annotation')).toBeNull();
  });

  it('سطر بمبلغ واحد ونصّ إنجليزي يبقى كما هو', () => {
    const line = 'The plan costs $19 per seat.';
    const { container } = render(<Markdown>{line}</Markdown>);
    expect(container.textContent).toBe(line);
  });

  it('صيغة `$$…$$` داخل رسالة عربية تُعزَل LTR بقاعدة الورقة الفعلية', () => {
    // بلا قاعدة الاتجاه ينعكس `a + b − c` داخل `dir=rtl` فيصير `c − b + a`.
    const style = document.createElement('style');
    style.textContent = katexStyleRules;
    document.head.appendChild(style);

    try {
      const { container } = render(
        <Markdown>
          {'الصيغة النهائية لحساب التكلفة الشهرية بعد الخصم المتفق عليه:\n\n$$a + b - c$$'}
        </Markdown>
      );

      // الحاوية عربية فعلاً ⇒ الصيغة تقع في سياق rtl لا في سياق محايد.
      expect(container.firstElementChild!.getAttribute('dir')).toBe('rtl');

      const katex = container.querySelector('.katex');
      expect(katex).not.toBeNull();

      // الأثر لا النصّ: القاعدة تنطبق على العنصر الذي يُخرجه KaTeX فعلاً.
      const computed = getComputedStyle(katex!);
      expect(computed.direction).toBe('ltr');
      expect(computed.unicodeBidi).toBe('isolate');
    } finally {
      style.remove();
    }
  });
});

describe('Markdown — علامة عنصر القائمة تتبع القائمة لا نصّه', () => {
  const arabicListWithEnglishItem = [
    'راجعت البنود التالية قبل الإغلاق، وكلّها موثّقة في سجلّ الجلسة:',
    '',
    '- تحقّقت من مسار الإقلاع كاملاً على العقدة المحلية أولاً',
    '- أعدت تشغيل الاختبارات المتأثرة ثم قرأت المخرَج بنفسي',
    '- The upstream runbook keeps the port bound until the drain ends',
  ].join('\n');

  it('العنصر الإنجليزي الخالص يأخذ اتجاهه على غلاف داخلي لا على <li>', () => {
    const { container } = render(<Markdown>{arabicListWithEnglishItem}</Markdown>);
    const items = Array.from(container.querySelectorAll('li'));
    expect(items).toHaveLength(3);

    const english = items.find((li) => (li.textContent ?? '').startsWith('The upstream'))!;
    expect(english).toBeTruthy();

    // العطل: `dir` على الوسم نفسه ⇒ النقطة تقفز للحافة المقابلة لقائمتها.
    expect(english.getAttribute('dir')).toBeNull();
    // العلاج: نفس الاتجاه، لكن على غلاف داخلي يحيط النصّ وحده.
    const wrapper = english.querySelector('[dir="ltr"]');
    expect(wrapper).not.toBeNull();
    expect((wrapper!.textContent ?? '').startsWith('The upstream')).toBe(true);
  });

  it('لا عنصر قائمة يحمل dir إطلاقاً، والعناصر العربية بلا غلاف زائد', () => {
    const { container } = render(<Markdown>{arabicListWithEnglishItem}</Markdown>);
    expect(container.querySelectorAll('li[dir]')).toHaveLength(0);

    const arabic = Array.from(container.querySelectorAll('li')).find((li) =>
      (li.textContent ?? '').startsWith('تحقّقت')
    )!;
    // الكتلة الموافقة للحاوية ترث بلا سِمة وبلا عنصر إضافي — المسار الشائع لا يتغيّر.
    expect(arabic.querySelector('[dir]')).toBeNull();
  });
});

describe('Markdown — محاذاة أعمدة GFM تصل إلى الخلايا', () => {
  const table = [
    '| البند | القيمة |',
    '| :--- | ---: |',
    '| زمن الاستجابة | 120 |',
    '',
  ].join('\n');

  it('`|---:|` تُنتج محاذاة فعلية على th وtd لا تُسقَط صامتة', () => {
    const { container } = render(<Markdown>{table}</Markdown>);
    const headers = Array.from(container.querySelectorAll('th'));
    const cells = Array.from(container.querySelectorAll('td'));
    expect(headers).toHaveLength(2);
    expect(cells).toHaveLength(2);

    const aligned = (el: Element) => el.getAttribute('align') ?? (el as HTMLElement).style.textAlign;
    expect(aligned(headers[0])).toBe('left');
    expect(aligned(headers[1])).toBe('right');
    expect(aligned(cells[0])).toBe('left');
    expect(aligned(cells[1])).toBe('right');
  });
});

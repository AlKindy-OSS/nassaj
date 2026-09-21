/**
 * B-RTL-BIDI — انحدار اتجاهية فقاعة المحادثة.
 *
 * الشكوى: «RTL ماني عارف اقرأ الكلام» — نص عربي مختلط بمعرّفات لاتينية يظهر
 * مبعثر الترتيب داخل عناصر القوائم والفقرات، وعلامات الترقيم (1./2./3.) على
 * الجهة الخاطئة، بينما الفقرات التي تبدأ بحرف عربي تبدو سليمة.
 *
 * السبب الذي يحرسه هذا الملف: كان كل مكوّن كتلة في المُصيِّر يحمل `dir="auto"`،
 * وهي خوارزمية «أول حرف قوي». كل عنصر قائمة في الرسالة الحقيقية أدناه يبدأ
 * بمعرّف لاتيني داخل `<code>` (`ZITADEL_PORT`، `ALTER ROLE…`، `LOGINV2_REQUIRED`)
 * فيُحسب اتجاهه LTR رغم أن محتواه عربي. والحاوية نفسها كانت تُحسب LTR لأن
 * خوارزمية `dir=auto` تتخطّى كل فرع يحمل `dir` خاصاً به — وأبناؤها جميعاً
 * كانوا كذلك — فلا تجد أي حرف قوي وتسقط إلى الافتراضي LTR.
 *
 * الاختبار يحاكي خوارزمية الاتجاهية في HTML حرفياً (أول حرف قوي مع تخطّي
 * الفروع التي تحمل `dir`) بدل الاكتفاء بفحص السِمات، لأن jsdom لا يحسب bidi.
 * صحّة المحاكاة مُتحقَّقة ميدانياً: قياس Chromium الحقيقي على نفس هذه الرسالة
 * قبل الإصلاح أعطى `direction: ltr` على العناصر الثلاثة وعلى الحاوية — وهو ما
 * تُخرجه هذه المحاكاة بالضبط.
 *
 * النصوص fixtures حقيقية مستخرَجة من ملفات جلسات فعلية (JSONL) لا مصطنعة.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.bidi.regression.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import arabicMessage from './__fixtures__/bidi-arabic-technical-message.md?raw';
import englishMessage from './__fixtures__/bidi-english-technical-message.md?raw';
import mixedArabicMessage from './__fixtures__/bidi-mixed-arabic-with-english-paragraph.md?raw';
import mixedEnglishMessage from './__fixtures__/bidi-mixed-english-with-arabic-paragraph.md?raw';
import { Markdown } from './Markdown';

// vitest يرفع vi.mock فوق الاستيرادات، فترتيبها هنا لا يؤثّر على المحاكاة.
//
// المحاكاة جزئية عمداً: `Markdown` صار يجرّ `ExecReviewDialog` ومنه سلسلة تصل إلى
// `src/i18n/config.js` التي تستدعي `initReactI18next`. محاكاة كاملة تُسقط ذلك
// التصدير فتنهار الحزمة كلها قبل أول اختبار — نُبقي الأصل ونستبدل `useTranslation`.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
  }),
}));

// `CodeBlock` صار يستدعي `useAuth` (زرّ التنفيذ الحر)، وهي ترمي خارج
// `AuthProvider`. المستخدم `null` ⇒ ليس مالكاً ⇒ لا زرّ ولا نداء شبكة.
vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

// ── محاكاة خوارزمية الاتجاهية في HTML ────────────────────────────────────────
const RTL_STRONG = /[֐-׿؀-޿ࢠ-ࣿיִ-﷿ﹰ-ﻼ]/;
const LTR_STRONG = /[A-Za-zÀ-ʯͰ-ϿЀ-ӿ]/;

/** أول حرف قوي في العنصر، مع تخطّي كل فرع يحمل `dir` خاصاً به — كما يفعل المتصفح. */
function firstStrong(el: Element): 'rtl' | 'ltr' | null {
  const walk = (node: Node): 'rtl' | 'ltr' | null => {
    if (node.nodeType === 3) {
      for (const ch of node.nodeValue ?? '') {
        if (RTL_STRONG.test(ch)) return 'rtl';
        if (LTR_STRONG.test(ch)) return 'ltr';
      }
      return null;
    }
    if (node.nodeType !== 1) return null;
    for (const child of Array.from(node.childNodes)) {
      if (
        child.nodeType === 1 &&
        ((child as Element).hasAttribute('dir') ||
          ['BDI', 'SCRIPT', 'STYLE', 'TEXTAREA'].includes((child as Element).tagName))
      ) {
        continue; // الفروع التي تُعلن اتجاهها تُتخطّى في الفحص
      }
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(el);
}

/** الاتجاه الفعّال لعنصر: أقرب سلف (أو هو) يحمل `dir`، مع حلّ `auto`. */
function effectiveDirection(el: Element, documentDir: 'rtl' | 'ltr'): 'rtl' | 'ltr' {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const dir = cur.getAttribute('dir');
    if (dir === 'rtl' || dir === 'ltr') return dir;
    if (dir === 'auto') return firstStrong(cur) ?? 'ltr'; // الافتراضي عند العدم
  }
  return documentDir;
}

const BLOCKS = 'div, p, li, ol, ul, h1, h2, h3, h4, blockquote, table, th, td';

/** حاوية الرسالة — تُلتقط بالبنية لا بالصنف، ليبقى الاختبار قادراً على كشف
 *  الانحدار على النسخة المعطوبة (التي لا تحمل `.nassaj-md`) لا أن يفشل قبله. */
const rootOf = (container: HTMLElement) =>
  (container.querySelector('.nassaj-md') ?? container.firstElementChild) as HTMLElement;

afterEach(cleanup);

describe('Markdown — اتجاه أساس واحد للرسالة (bidi)', () => {
  it('يعطي كل كتلة في رسالة عربية تقنية اتجاه rtl، والحاوية أيضاً', () => {
    const { container } = render(
      <Markdown className="prose prose-sm max-w-none">{arabicMessage}</Markdown>
    );
    const root = rootOf(container);
    expect(root).not.toBeNull();

    // الحاوية: اتجاه صريح محسوب من نثر الرسالة لا من أول حرف قوي.
    expect(effectiveDirection(root, 'rtl')).toBe('rtl');

    // كل كتلة تحت الحاوية ترث نفس الاتجاه — لا جزر متضاربة.
    const offenders = Array.from(root.querySelectorAll(BLOCKS))
      .filter((el) => effectiveDirection(el, 'rtl') !== 'rtl')
      .map((el) => `${el.tagName.toLowerCase()}: ${(el.textContent ?? '').trim().slice(0, 40)}`);
    expect(offenders).toEqual([]);
  });

  it('عناصر القائمة الثلاثة التي تبدأ بمعرّف لاتيني تبقى rtl (الانحدار الأصلي)', () => {
    const { container } = render(<Markdown>{arabicMessage}</Markdown>);
    const items = Array.from(container.querySelectorAll('ol > li'));
    expect(items).toHaveLength(3);
    // كل عنصر يبدأ فعلاً بمعرّف لاتيني — وهو ما كان يقلب الاتجاه.
    expect(items.map((li) => (li.textContent ?? '').trim().slice(0, 12))).toEqual([
      'ZITADEL_PORT',
      'ALTER ROLE z',
      'LOGINV2_REQU',
    ]);
    expect(items.map((li) => effectiveDirection(li, 'rtl'))).toEqual(['rtl', 'rtl', 'rtl']);

    // القائمة نفسها ترث rtl ⇒ علامات الترقيم على الجهة الصحيحة.
    expect(effectiveDirection(container.querySelector('ol')!, 'rtl')).toBe('rtl');
  });

  it('لا كتلة تحمل dir="auto" ولا unicode-bidi: plaintext', () => {
    const { container } = render(<Markdown>{arabicMessage}</Markdown>);
    const root = rootOf(container);
    expect(root.classList.contains('nassaj-md')).toBe(true);
    expect(root.querySelectorAll('[dir="auto"]')).toHaveLength(0);
    expect(root.getAttribute('dir')).toBe('rtl');
    const plaintext = Array.from(root.querySelectorAll<HTMLElement>('[style]')).filter((el) =>
      /plaintext/.test(el.getAttribute('style') ?? '')
    );
    expect(plaintext).toHaveLength(0);
  });

  it('الكود السطري معزول ومثبَّت LTR فلا يجرّ المحايدات حوله', () => {
    const { container } = render(<Markdown>{arabicMessage}</Markdown>);
    const codes = Array.from(container.querySelectorAll('code'));
    expect(codes.length).toBeGreaterThan(5);
    expect(codes.every((c) => c.getAttribute('dir') === 'ltr')).toBe(true);
  });

  it('رسالة إنجليزية حقيقية تُحسب ltr كاملةً', () => {
    const { container } = render(<Markdown>{englishMessage}</Markdown>);
    const root = rootOf(container);
    expect(effectiveDirection(root, 'rtl')).toBe('ltr');
    const offenders = Array.from(root.querySelectorAll(BLOCKS)).filter(
      (el) => effectiveDirection(el, 'rtl') !== 'ltr'
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * المستوى الثاني — رسالة مختلطة الفقرات.
 *
 * أغلبية الحروف على مستوى الرسالة منحازة بنيوياً للاتينية (‏5.2 حرف/كلمة مقابل
 * 4.2)، فقياسٌ على نصّ حقيقي أعطى: فقرتان عربيتان قصيرتان (19 كلمة، 85 حرفاً
 * قوياً) مقابل فقرة إنجليزية واحدة (22 كلمة، 127 حرفاً) ⇒ الرسالة كلها ltr،
 * فتتبعثر **كل** فقراتها العربية دفعةً واحدة — أسوأ من العطل الأصلي.
 *
 * العلاج: الحاوية بتصويت الكتل (كتلة = صوت)، والكتلة تخالف الحاوية فقط إذا
 * كانت أحادية اللغة تماماً.
 *
 * الـfixtures مركّبة من فقرات منقولة حرفياً من جلسات JSONL فعلية.
 */
describe('Markdown — فقرة بلغة مخالفة وسط الرسالة', () => {
  const blockOf = (root: HTMLElement, startsWith: string) =>
    Array.from(root.querySelectorAll(BLOCKS)).find((el) =>
      (el.textContent ?? '').trim().startsWith(startsWith)
    ) as HTMLElement;

  it('عربية + فقرة إنجليزية خالصة ⇒ الحاوية rtl والفقرة الإنجليزية جزيرة ltr', () => {
    const { container } = render(<Markdown>{mixedArabicMessage}</Markdown>);
    const root = rootOf(container);

    // الحاوية لا تنقلب رغم أن الفقرة الإنجليزية أطول من العربيتين مجتمعتين.
    expect(effectiveDirection(root, 'rtl')).toBe('rtl');

    const english = blockOf(root, 'The upstream runbook');
    expect(english.getAttribute('dir')).toBe('ltr'); // سِمة صريحة = جزيرة
    expect(effectiveDirection(english, 'rtl')).toBe('ltr');

    // وباقي الفقرات العربية لا تتأثر إطلاقاً.
    expect(effectiveDirection(blockOf(root, 'أي أن'), 'rtl')).toBe('rtl');
    expect(effectiveDirection(blockOf(root, 'وأخبرني'), 'rtl')).toBe('rtl');
  });

  it('إنجليزية + فقرة عربية خالصة ⇒ الحاوية ltr والفقرة العربية جزيرة rtl', () => {
    const { container } = render(<Markdown>{mixedEnglishMessage}</Markdown>);
    const root = rootOf(container);

    expect(effectiveDirection(root, 'rtl')).toBe('ltr');

    const arabic = blockOf(root, 'وأخبرني');
    expect(arabic.getAttribute('dir')).toBe('rtl');
    expect(effectiveDirection(arabic, 'rtl')).toBe('rtl');

    expect(effectiveDirection(blockOf(root, 'Frontend analysis'), 'rtl')).toBe('ltr');
  });

  it('العنوان المختلط القصير لا ينقلب (T-975 — Login V1 أم V2؟)', () => {
    const { container } = render(<Markdown>{mixedArabicMessage}</Markdown>);
    const root = rootOf(container);
    const heading = blockOf(root, 'T-975');

    // 7 حروف لاتينية مقابل 2 عربية ⇒ أغلبيته لاتينية، لكنه مختلط فيرث الحاوية.
    expect(heading.tagName).toBe('H3');
    expect(heading.getAttribute('dir')).toBeNull();
    expect(effectiveDirection(heading, 'rtl')).toBe('rtl');
  });

  it('موضع الترقيم: نقطة الفقرة الإنجليزية داخل سياق ltr لا سياق الحاوية rtl', () => {
    const { container } = render(<Markdown>{mixedArabicMessage}</Markdown>);
    const root = rootOf(container);
    const english = blockOf(root, 'The upstream runbook');

    // آخر عقدة نصّية في الفقرة — وهي التي تنتهي بالنقطة الختامية.
    const walker = document.createTreeWalker(english, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    let n: Node | null;
    while ((n = walker.nextNode())) if ((n.nodeValue ?? '').trim()) last = n as Text;
    expect((last?.nodeValue ?? '').trimEnd().endsWith('.')).toBe(true);

    // اتجاه الفقرة الحاضنة للنقطة هو ما يحدّد طرفها. ltr ⇒ النقطة عند نهاية
    // النصّ اللاتيني. لو ورثت rtl (تصويت بلا جزر) لانقلبت للطرف المقابل.
    // البرهان البكسلي في المتصفح مذكور في تقرير المهمة؛ jsdom لا يحسب bidi.
    expect(effectiveDirection(last!.parentElement!, 'rtl')).toBe('ltr');
    expect(effectiveDirection(root, 'rtl')).toBe('rtl');
  });
});

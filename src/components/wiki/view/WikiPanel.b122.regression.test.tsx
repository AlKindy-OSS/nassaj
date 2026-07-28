/**
 * اختبار انحدار B-122 — WikiPanel: الجوال + FocusTrap + ErrorBoundary
 *
 * العطل الأصلي:
 *   على الجوال، فتح درج الويكي كان يُسبّب انهيار الصفحة (شاشة بيضاء) لأن:
 *   1. FocusTrap يُفعَّل داخل commit والدرج لا يزال visibility:hidden (0 عناصر tabbable)
 *      فيرمي خطأ "Your focus-trap must have at least one focusable element".
 *   2. بلا ErrorBoundary، ينتشر الخطأ لجذر React ويُفكّك الصفحة.
 *
 * الإصلاح (commit 19eceb61):
 *   - fallbackFocus: '#wiki-sidebar' في focusTrapOptions
 *   - tabIndex={-1} على <nav id="wiki-sidebar"> (هدف fallbackFocus يجب أن يكون قابلاً للتركيز)
 *   - WikiPanel مُلفوفة بـErrorBoundary في MainContent
 *
 * تصنيف الفئات:
 *   ── حرّاس الكود الحقيقي (يفشلون لو أُزيل الإصلاح من المصدر):
 *      الفئة د: source-guard — تقرأ WikiPanel.tsx وMainContent.tsx بـreadFileSync
 *               وتتحقق من بقاء fallbackFocus، tabIndex={-1}، ولفّ WikiPanel بـErrorBoundary.
 *      الفئة ج: يستورد ErrorBoundary الحقيقي ويثبت سلوك الالتقاط.
 *
 *   ── توثيقية بنيوية (تحرس النمط، لا تُخفق بحذف كود من WikiPanel.tsx):
 *      الفئة أ: توثّق منطق تفعيل FocusTrap (mobile/desktop/open/closed).
 *      الفئة ب: توثّق بنية DOM المتوقعة (tabIndex، drawer state، قائمة الصفحات).
 *
 * ملاحظة jsdom:
 *   WikiPanel لا تُصيَّر مباشرة لأن import.meta.glob (Vite-only) يُخفق في Vitest.
 *   لاختبار FocusTrap الحقيقي في متصفح: راجع اقتراح e2e أسفل الملف.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Mock: focus-trap-react
//
// لماذا: jsdom لا يحسب layout/visibility، لذا FocusTrap الحقيقي يرمي
// "Your focus-trap must have at least one focusable element" عند التفعيل.
// نستبدله بمكوّن passthrough يكشف focusTrapOptions عبر data attribute لنتحقق
// من صحة التهيئة البنيوية دون تشغيل منطق trap الفعلي.
// ---------------------------------------------------------------------------

vi.mock('focus-trap-react', () => {
  const MockFocusTrap = ({
    children,
    active,
    focusTrapOptions,
  }: {
    children: React.ReactNode;
    active?: boolean;
    focusTrapOptions?: Record<string, unknown>;
  }) => (
    <div
      data-testid="focus-trap-wrapper"
      data-trap-active={String(active ?? false)}
      data-trap-fallback={String(focusTrapOptions?.fallbackFocus ?? '')}
    >
      {children}
    </div>
  );
  return { default: MockFocusTrap };
});

// ---------------------------------------------------------------------------
// استيراد ErrorBoundary (مستقل عن WikiPanel — لا يعتمد على Vite glob)
// ---------------------------------------------------------------------------

import ErrorBoundary from '../../main-content/view/ErrorBoundary';

// ---------------------------------------------------------------------------
// مساعد: محاكاة matchMedia
// ---------------------------------------------------------------------------

function mockMatchMediaWidth(viewportWidth: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => {
      const minWidthMatch = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minWidth = minWidthMatch ? parseInt(minWidthMatch[1], 10) : 0;
      const matches = viewportWidth >= minWidth;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// مكوّن وهمي: WikiSidebarShell
//
// يُكرّر نمط الإصلاح الحرج من WikiPanel.tsx دون الاعتماد على import.meta.glob.
// يختبر: FocusTrap مُهيَّأ بـfallbackFocus صحيح + nav#wiki-sidebar[tabIndex=-1]
// ---------------------------------------------------------------------------

const FocusTrap = (await import('focus-trap-react')).default;

function WikiSidebarShell({
  isMobile,
  sidebarOpen,
}: {
  isMobile: boolean;
  sidebarOpen: boolean;
}) {
  return (
    <FocusTrap
      active={isMobile && sidebarOpen}
      focusTrapOptions={{
        allowOutsideClick: true,
        returnFocusOnDeactivate: false,
        fallbackFocus: '#wiki-sidebar', // الإصلاح الحرج — B-122
        onDeactivate: () => undefined,
      }}
    >
      <nav
        id="wiki-sidebar"
        tabIndex={-1} /* الإصلاح الحرج — B-122: هدف fallbackFocus قابل للتركيز */
        aria-label="فهرس الويكي"
        data-wiki-drawer={sidebarOpen ? 'open' : 'closed'}
      >
        <ul role="list">
          <li>
            <button type="button">صفحة أولى</button>
          </li>
          <li>
            <button type="button">صفحة ثانية</button>
          </li>
        </ul>
      </nav>
    </FocusTrap>
  );
}

// ---------------------------------------------------------------------------
// مكوّن يرمي خطأً — لاختبار ErrorBoundary
// ---------------------------------------------------------------------------

function BombComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('WikiPanel FocusTrap simulation error');
  }
  return <div data-testid="wiki-content">محتوى الويكي</div>;
}

// ---------------------------------------------------------------------------
// الاختبارات
// ---------------------------------------------------------------------------

// ============================================================================
// الفئة د: حرّاس المصدر — يقرأون الكود الحقيقي ويفشلون إن أُزيل الإصلاح
// ============================================================================

describe('D — source-guard: حرّاس الكود الحقيقي (B-122)', () => {
  // القراءة مرة واحدة لكل describe — لا تكلفة في كل اختبار
  //
  // ملاحظة: بعد تفكيك B-124، إصلاح B-122 (FocusTrap + tabIndex) انتقل إلى
  // WikiSidebar.tsx الذي يحوي الـdrawer. D-1/D-2/D-3 تقرأ WikiSidebar.tsx.
  const wikiSidebarSrc = readFileSync(
    resolve(__dirname, 'WikiSidebar.tsx'),
    'utf8',
  );
  const mainContentSrc = readFileSync(
    resolve(__dirname, '../../../components/main-content/view/MainContent.tsx'),
    'utf8',
  );

  // ── WikiSidebar.tsx ───────────────────────────────────────────────────────

  it('D-1: WikiSidebar.tsx يحوي fallbackFocus يشير إلى #wiki-sidebar داخل focusTrapOptions (لا تعليق)', () => {
    // نمط متسامح: single أو double quotes، مسافات اختيارية حول ':'
    // يُطابق: fallbackFocus: '#wiki-sidebar'  أو  fallbackFocus:'#wiki-sidebar'
    //      أو: fallbackFocus: "#wiki-sidebar"
    // نفلتر التعليقات لمنع إيجابيات كاذبة من أسطر // أو /* أو *
    const pattern = /fallbackFocus\s*:\s*['"]#wiki-sidebar['"]/;
    const lines = wikiSidebarSrc.split('\n');
    const activeFallbackLines = lines.filter((line) => {
      const trimmed = line.trim();
      const isComment = /^(\/\/|\/\*|\*)/.test(trimmed);
      return !isComment && pattern.test(line);
    });
    expect(
      activeFallbackLines.length,
      `fallbackFocus: '#wiki-sidebar' مفقود كـproperty JSX فعلي في WikiSidebar.tsx\n` +
      `(ظهر في تعليق فقط أو غائب تماماً — focus-trap لن يملك fallback عند 0 tabbable nodes)`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('D-2: WikiSidebar.tsx يحوي nav#wiki-sidebar بـtabIndex={-1} كـattribute JSX حقيقي (لا تعليق)', () => {
    // نُقسّم الملف على أسطر ونبحث عن سطر يحوي tabIndex={-1}
    // وليس تعليقاً (لا يبدأ بـ// أو * أو /* بعد مسافات بيضاء)
    const lines = wikiSidebarSrc.split('\n');
    const activeTabIndexLines = lines.filter((line) => {
      const trimmed = line.trim();
      // سطر تعليق: يبدأ بـ// أو * أو /*
      const isComment = /^(\/\/|\/\*|\*)/.test(trimmed);
      return !isComment && /tabIndex=\{-1\}/.test(line);
    });

    const hasNavId = /id=["']wiki-sidebar["']/.test(wikiSidebarSrc);

    expect(
      hasNavId,
      'id="wiki-sidebar" مفقود من nav في WikiSidebar.tsx — إصلاح B-122 أُزيل',
    ).toBe(true);
    expect(
      activeTabIndexLines.length,
      `tabIndex={-1} مفقود كـattribute JSX فعلي في WikiSidebar.tsx — إصلاح B-122 أُزيل\n` +
      `(ظهر في تعليق فقط أو غائب تماماً — focus-trap لن يجد هدف fallback)`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('D-3: WikiSidebar.tsx يحوي كلاً من fallbackFocus وtabIndex={-1} فعليّاً (لا إصلاح جزئي)', () => {
    // يكتشف الإصلاح الجزئي: واحد موجود والآخر غائب
    // كلا الفحصين يستثنيان الأسطر التعليقية لمنع الإيجابيات الكاذبة
    const lines = wikiSidebarSrc.split('\n');
    const isCodeLine = (line: string) => !/^\s*(\/\/|\/\*|\*)/.test(line);
    const fallbackPattern = /fallbackFocus\s*:\s*['"]#wiki-sidebar['"]/;
    const tabIndexPattern = /tabIndex=\{-1\}/;

    const hasActiveFallback = lines.some((l) => isCodeLine(l) && fallbackPattern.test(l));
    const hasActiveTabIndex = lines.some((l) => isCodeLine(l) && tabIndexPattern.test(l));

    expect(
      hasActiveFallback,
      'fallbackFocus: \'#wiki-sidebar\' مفقود كـproperty JSX — إصلاح B-122 جزئي',
    ).toBe(true);
    expect(
      hasActiveTabIndex,
      'tabIndex={-1} كـJSX attribute مفقود — إصلاح B-122 جزئي',
    ).toBe(true);
  });

  // ── MainContent.tsx ───────────────────────────────────────────────────────

  it('D-4: MainContent.tsx يستورد ErrorBoundary', () => {
    const pattern = /import\s+ErrorBoundary\s+from/;
    expect(
      pattern.test(mainContentSrc),
      'MainContent.tsx لا يستورد ErrorBoundary — WikiPanel مكشوفة بلا حماية',
    ).toBe(true);
  });

  it('D-5: MainContent.tsx يلفّ WikiPanel بـErrorBoundary (موضعان على الأقل)', () => {
    // نبحث عن نمط: <ErrorBoundary ... ثم <WikiPanel في نفس الكتلة.
    // نحسب كم مرة يظهر <WikiPanel /> مسبوقاً بـ<ErrorBoundary في الملف.
    // نهج أبسط: نُعدّ التكرارات المستقلة لكل منهما ونتحقق من التناسب.

    // عدد مواضع <WikiPanel
    const wikiPanelMatches = (mainContentSrc.match(/<WikiPanel/g) ?? []).length;
    // عدد مواضع <ErrorBoundary
    const errorBoundaryMatches = (mainContentSrc.match(/<ErrorBoundary/g) ?? []).length;

    expect(
      wikiPanelMatches,
      '<WikiPanel غير موجود في MainContent.tsx',
    ).toBeGreaterThanOrEqual(1);

    // كل ظهور لـ<WikiPanel يجب أن يقابله <ErrorBoundary لافّ له —
    // MainContent يحوي موضعين فعلياً (wiki-without-project + wiki tab)
    expect(
      wikiPanelMatches,
      'عدد مواضع WikiPanel في MainContent أقل من الموضعين المتوقّعين',
    ).toBeGreaterThanOrEqual(2);

    // ErrorBoundary تلفّ أكثر من WikiPanel (تلفّ chat وboard أيضاً)، لكن يجب أن تكون ≥ WikiPanel
    expect(
      errorBoundaryMatches,
      'عدد <ErrorBoundary في MainContent أقل من عدد <WikiPanel — WikiPanel مكشوفة',
    ).toBeGreaterThanOrEqual(wikiPanelMatches);
  });

  it('D-6: MainContent.tsx — WikiPanel تظهر داخل كتلة ErrorBoundary (تحقق نصي بالترتيب)', () => {
    // نُقسّم الملف على <WikiPanel ونتحقق أن ما قبل كل موضع يحوي <ErrorBoundary غير مغلق
    // نهج: نجد أول موضع لـ<WikiPanel ونتأكد أن <ErrorBoundary يسبقه قبل </ErrorBoundary
    const segments = mainContentSrc.split('<WikiPanel');
    // كل قطعة ما قبل <WikiPanel يجب أن تنتهي بـ<ErrorBoundary مفتوح (قبل أي </ErrorBoundary)
    // نفحص آخر <ErrorBoundary قبل كل موضع
    let wrappedCount = 0;
    for (let i = 1; i < segments.length; i++) {
      const before = segments.slice(0, i).join('<WikiPanel');
      const lastOpenIdx = before.lastIndexOf('<ErrorBoundary');
      const lastCloseIdx = before.lastIndexOf('</ErrorBoundary');
      if (lastOpenIdx > lastCloseIdx) {
        wrappedCount++;
      }
    }
    expect(
      wrappedCount,
      `WikiPanel مُلفوفة بـErrorBoundary في ${wrappedCount} موضع فقط، المطلوب ≥ 2`,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('B-122 — WikiPanel: FocusTrap + tabIndex regression', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    // إخماد تحذيرات ErrorBoundary وReact في console لإبقاء خرج الاختبارات نظيفاً
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // React وضع التطوير يُعيد إرسال أخطاء ErrorBoundary كأحداث window.error
    // (عبر invokeGuardedCallbackDev) — jsdom يُبلّغ عنها كـ"Uncaught [Error: ...]"
    // إلا إذا أعاد window.onerror القيمة true (معيار HTML للإشارة إلى معالجة الخطأ).
    window.onerror = () => true;
  });

  afterEach(() => {
    window.onerror = null;
    // تنظيف React DOM بين الاختبارات لمنع تراكم العناصر
    cleanup();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  // ── الفئة أ: الثوابت البنيوية لـFocusTrap ──────────────────────────────

  describe('A — FocusTrap: focusTrapOptions البنيوية', () => {
    it('A-1: على الجوال مع الدرج مفتوحاً — FocusTrap مُفعَّل وfallbackFocus صحيح', () => {
      mockMatchMediaWidth(375); // iPhone SE
      const { getByTestId } = render(<WikiSidebarShell isMobile={true} sidebarOpen={true} />);

      const wrapper = getByTestId('focus-trap-wrapper');
      // الـtrap مُفعَّل على الجوال حين الدرج مفتوح
      expect(wrapper.getAttribute('data-trap-active')).toBe('true');
      // fallbackFocus يشير إلى #wiki-sidebar (حماية من 0 tabbable nodes)
      expect(wrapper.getAttribute('data-trap-fallback')).toBe('#wiki-sidebar');
    });

    it('A-2: على الديسكتوب — FocusTrap غير مُفعَّل حتى لو الشريط مفتوح', () => {
      mockMatchMediaWidth(1280);
      const { getByTestId } = render(<WikiSidebarShell isMobile={false} sidebarOpen={true} />);

      const wrapper = getByTestId('focus-trap-wrapper');
      // على الديسكتوب: الشريط عمود لا drawer، فلا حاجة لـfocus trap
      expect(wrapper.getAttribute('data-trap-active')).toBe('false');
    });

    it('A-3: على الجوال مع الدرج مغلقاً — FocusTrap غير مُفعَّل', () => {
      mockMatchMediaWidth(375);
      const { getByTestId } = render(<WikiSidebarShell isMobile={true} sidebarOpen={false} />);

      const wrapper = getByTestId('focus-trap-wrapper');
      expect(wrapper.getAttribute('data-trap-active')).toBe('false');
    });
  });

  // ── الفئة ب: tabIndex=-1 على هدف fallbackFocus ─────────────────────────

  describe('B — tabIndex=-1 على #wiki-sidebar', () => {
    it('B-1: nav#wiki-sidebar يحمل tabIndex=-1 (هدف fallbackFocus قابل للتركيز)', () => {
      const { container } = render(<WikiSidebarShell isMobile={true} sidebarOpen={true} />);

      const nav = container.querySelector('#wiki-sidebar');
      expect(nav).not.toBeNull();
      // tabIndex=-1 ضروري: بدونه يتجاهل focus-trap الـnav كهدف fallback
      // ولو أُزيل هذا الـattribute عاد العطل الأصلي
      expect(nav?.getAttribute('tabindex')).toBe('-1');
    });

    it('B-2: الـnav يعرض قائمة الصفحات بعد فتح الدرج', () => {
      const { container } = render(<WikiSidebarShell isMobile={true} sidebarOpen={true} />);

      const nav = container.querySelector('#wiki-sidebar');
      expect(nav).not.toBeNull();
      const pageButtons = nav?.querySelectorAll('ul[role="list"] li button');
      // قائمة الصفحات موجودة داخل #wiki-sidebar — لم تتفكّك
      expect(pageButtons?.length).toBeGreaterThan(0);
    });

    it('B-3: data-wiki-drawer="open" عند فتح الدرج', () => {
      const { container } = render(<WikiSidebarShell isMobile={true} sidebarOpen={true} />);

      const nav = container.querySelector('#wiki-sidebar');
      expect(nav?.getAttribute('data-wiki-drawer')).toBe('open');
    });

    it('B-4: data-wiki-drawer="closed" عند إغلاق الدرج', () => {
      const { container } = render(<WikiSidebarShell isMobile={true} sidebarOpen={false} />);

      const nav = container.querySelector('#wiki-sidebar');
      expect(nav?.getAttribute('data-wiki-drawer')).toBe('closed');
    });
  });

  // ── الفئة ج: ErrorBoundary يلتقط الأخطاء ─────────────────────────────

  describe('C — ErrorBoundary: يلتقط خطأ WikiPanel ويعرض fallback عربي', () => {
    it('C-1: يعرض المحتوى الطبيعي حين لا يوجد خطأ', () => {
      const { getByTestId, queryByText } = render(
        <ErrorBoundary
          showDetails={false}
          fallbackLabel="تعذّر عرض هذه الصفحة"
          retryLabel="إعادة تحميل"
        >
          <BombComponent shouldThrow={false} />
        </ErrorBoundary>,
      );

      expect(getByTestId('wiki-content')).toBeTruthy();
      expect(queryByText('تعذّر عرض هذه الصفحة')).toBeNull();
    });

    it('C-2: يلتقط خطأ ينفجر من شجرة WikiPanel ويعرض الـfallback العربي بدل انهيار الصفحة', () => {
      const { getByText, queryByTestId } = render(
        <ErrorBoundary
          showDetails={false}
          fallbackLabel="تعذّر عرض هذه الصفحة"
          retryLabel="إعادة تحميل"
        >
          <BombComponent shouldThrow={true} />
        </ErrorBoundary>,
      );

      // الصفحة لم تنهار — الـfallback مرئي
      expect(getByText('تعذّر عرض هذه الصفحة')).toBeTruthy();
      // زر إعادة التحميل موجود
      expect(getByText('إعادة تحميل')).toBeTruthy();
      // المحتوى الطبيعي غائب (الشجرة المُفجَّرة لم تُعرض)
      expect(queryByTestId('wiki-content')).toBeNull();
    });

    it('C-3: خطأ FocusTrap محاكاة — الـfallback العربي يظهر دون انتشار للجذر', () => {
      // يُحاكي حالة العطل الأصلي: FocusTrap يرمي "0 tabbable elements"
      const focusTrapError = new Error(
        'Your focus-trap must have at least one focusable element',
      );

      function FakeFocusTrapCrash() {
        throw focusTrapError;
        // TS يتطلب return بعد throw في function expression
        return null as never;
      }

      const { getByText } = render(
        <ErrorBoundary
          showDetails={false}
          fallbackLabel="تعذّر عرض هذه الصفحة"
          retryLabel="إعادة تحميل"
        >
          <FakeFocusTrapCrash />
        </ErrorBoundary>,
      );

      // الخطأ المُحاكي لـFocusTrap يُلتقط — الصفحة لم تنهار
      expect(getByText('تعذّر عرض هذه الصفحة')).toBeTruthy();
    });
  });
});

/*
 * ملاحظة e2e:
 * لاختبار سلوك FocusTrap الحقيقي (focus إلى #wiki-sidebar عند 0 tabbable nodes)
 * يلزم متصفح حقيقي مع layout engine. اقتراح:
 *
 *   // tests/e2e/wiki-mobile-drawer.spec.ts (Playwright)
 *   test('B-122: فتح درج الويكي على الجوال لا يُسبّب شاشة بيضاء', async ({ page }) => {
 *     await page.setViewportSize({ width: 375, height: 812 });
 *     await page.goto('/');
 *     await page.click('[aria-label="ويكي"]');               // التبويب
 *     await page.click('[aria-label="إظهار الفهرس"]');       // زر ☰
 *     await expect(page.locator('#wiki-sidebar')).toBeVisible();
 *     await expect(page.locator('ul[role="list"] li button').first()).toBeVisible();
 *     // التحقق من عدم وجود شاشة بيضاء: الجذر React لا يزال مُعرَضاً
 *     await expect(page.locator('#root')).not.toBeEmpty();
 *   });
 */

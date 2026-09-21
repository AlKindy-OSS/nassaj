/**
 * البند 8: اختبار سلوك حالة الشريط الجانبي بناءً على matchMedia.
 *
 * يختبر منطق useIsDesktop hook الذي يُحدِّد قيمة sidebarOpen الابتدائية:
 *  - مفتوح افتراضياً على شاشات ≥768px
 *  - مغلق افتراضياً على شاشات <768px
 *  - يتفاعل مع تغيّر matchMedia (تدوير الجهاز، تغيير حجم النافذة)
 *
 * لا يعتمد على React — يختبر المنطق مباشرة عبر matchMedia mock في jsdom.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as WikiPanelModule from './WikiPanel';
import { getInitialSidebarState } from './WikiPanel';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// مساعد: محاكاة matchMedia بعرض محدد
// ---------------------------------------------------------------------------

function mockMatchMedia(viewportWidth: number) {
  const listeners = new Map<string, Set<(e: { matches: boolean }) => void>>();

  const impl = (query: string) => {
    // نحلّل "(min-width: 768px)" فقط
    const minWidthMatch = /\(min-width:\s*(\d+)px\)/.exec(query);
    const minWidth = minWidthMatch ? parseInt(minWidthMatch[1], 10) : 0;
    const matches = viewportWidth >= minWidth;

    const mq = {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (type: string, handler: (e: { matches: boolean }) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
      },
      removeEventListener: (type: string, handler: (e: { matches: boolean }) => void) => {
        listeners.get(type)?.delete(handler);
      },
      dispatchEvent: vi.fn(),
    };

    return mq;
  };

  impl._fireChange = (query: string, newWidth: number) => {
    const minWidthMatch = /\(min-width:\s*(\d+)px\)/.exec(query);
    const minWidth = minWidthMatch ? parseInt(minWidthMatch[1], 10) : 0;
    const matches = newWidth >= minWidth;
    listeners.get('change')?.forEach((fn) => fn({ matches }));
  };

  return impl;
}

// ---------------------------------------------------------------------------
// الاختبارات
// ---------------------------------------------------------------------------

describe('sidebarOpen initial state (matchMedia logic)', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it('مفتوح افتراضياً على شاشة عرضها 1280px (ديسكتوب)', () => {
    const mq = mockMatchMedia(1280);
    expect(getInitialSidebarState(mq)).toBe(true);
  });

  it('مفتوح افتراضياً على شاشة عرضها 768px (الحد الأدنى للديسكتوب)', () => {
    const mq = mockMatchMedia(768);
    expect(getInitialSidebarState(mq)).toBe(true);
  });

  it('مغلق افتراضياً على شاشة عرضها 767px (أقصى عرض جوال)', () => {
    const mq = mockMatchMedia(767);
    expect(getInitialSidebarState(mq)).toBe(false);
  });

  it('مغلق افتراضياً على شاشة عرضها 375px (iPhone SE)', () => {
    const mq = mockMatchMedia(375);
    expect(getInitialSidebarState(mq)).toBe(false);
  });

  it('يتفاعل مع تغيّر matchMedia — من جوال إلى ديسكتوب', () => {
    const mq = mockMatchMedia(375);
    const currentState = getInitialSidebarState(mq);
    expect(currentState).toBe(false);

    // محاكاة حدث change عند توسيع النافذة
    const mqObj = mq('(min-width: 768px)') as ReturnType<typeof mq>;
    let capturedState = currentState;

    mqObj.addEventListener('change', (e: { matches: boolean }) => {
      capturedState = e.matches;
    });

    mq._fireChange('(min-width: 768px)', 1024);
    expect(capturedState).toBe(true);
  });

  it('يتفاعل مع تغيّر matchMedia — من ديسكتوب إلى جوال (تدوير لوحي)', () => {
    const mq = mockMatchMedia(1024);
    const currentState = getInitialSidebarState(mq);
    expect(currentState).toBe(true);

    const mqObj = mq('(min-width: 768px)') as ReturnType<typeof mq>;
    let capturedState = currentState;

    mqObj.addEventListener('change', (e: { matches: boolean }) => {
      capturedState = e.matches;
    });

    // تدوير اللوحي: العرض أصبح 600px
    mq._fireChange('(min-width: 768px)', 600);
    expect(capturedState).toBe(false);
  });

  it('لا يتجاوز حد الـ768px في الاتجاهين — 769px ديسكتوب', () => {
    const mqDesktop = mockMatchMedia(769);
    const mqMobile = mockMatchMedia(767);
    expect(getInitialSidebarState(mqDesktop)).toBe(true);
    expect(getInitialSidebarState(mqMobile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// العرض وحده يقرّر — لا الصفحة المفتوحة
// ---------------------------------------------------------------------------

/**
 * كان `shouldSidebarBeOpen(isHome, isDesktop)` يُغلق الفهرس على الرئيسية لأن
 * الرئيسية كانت تسرد العناوين نفسها التي يسردها الفهرس. ذاك علاج للعَرَض: القارئ
 * يعيد فتح الفهرس — فهو عمود تنقّل، وهذه وظيفته — فيعود الازدواج ومعه فراغ لأن
 * التخطيط فقد العرض الذي صُمِّم عليه. الرئيسية لم تعد تسرد عناوين صفحات، فلم يبقَ
 * ما يُخفى. الاختبار يمنع عودة الحيلة بالكود لا بالعُرف.
 */
describe('لا حيلة لإغلاق الفهرس على الرئيسية', () => {
  it('لم تعد `shouldSidebarBeOpen` مُصدَّرة من WikiPanel', () => {
    expect('shouldSidebarBeOpen' in WikiPanelModule).toBe(false);
  });

  it('لا ذكر لها ولا لمنطق العبور بين الرئيسية والمقال في المصدر', () => {
    const source = readFileSync(resolve(__dirname, './WikiPanel.tsx'), 'utf8');
    expect(source).not.toContain('shouldSidebarBeOpen');
    expect(source).not.toContain('crossedHome');
    // الحالة الابتدائية = العرض وحده.
    expect(source).toContain('useState<boolean>(getInitialSidebarState)');
  });

  it('الحالة الابتدائية على ≥768px مفتوحة بصرف النظر عن الصفحة النشطة', () => {
    // الدالة لا تستقبل الصفحة أصلاً — وهذا هو الثابت: توقيعها هو الضمانة.
    expect(getInitialSidebarState.length).toBe(1);
    expect(getInitialSidebarState(mockMatchMedia(1440))).toBe(true);
    expect(getInitialSidebarState(mockMatchMedia(768))).toBe(true);
  });
});

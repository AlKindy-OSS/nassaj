/**
 * T-1868: العنوان والوصف كانا يضعان `/tmp` نصّاً حرفياً وسط جملة عربية بلا
 * تمييز اتجاه — فينعكس ترتيب قراءته. هذا الحارس يثبّت أن `/tmp` مفصولٌ فعلاً
 * بـ`<bdi dir="ltr">`، والنصّ العربي حولها كما هو.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const translations: Record<string, string> = {
  'tmpfsCap.title': 'سقف الذاكرة المشتركة ({{path}})',
  'tmpfsCap.description': '{{path}} على هذا الجهاز في الذاكرة. مِقدارٌ بلا سقف يترك بناءً واحداً يحجز غيغابايتات لساعات.',
};
// qa round (T-1868 MEDIUM 2): محاكاة اللغات السبع (de/it/ja/ko/ru/tr/zh-CN) التي
// كانت تحمل النصّ الإنجليزي القديم بلا `{{path}}` — النصّ الحرفي `/tmp` يظهر
// مرّةً واحدة فقط، لا مكرَّراً بـ`<bdi>` إضافية.
const noTokenTranslations: Record<string, string> = {
  'tmpfsCap.title': 'Shared memory cap (/tmp)',
  'tmpfsCap.description': '/tmp lives in RAM on this host. An uncapped mount lets a build hold gigabytes for hours.',
};

let activeTranslations = translations;
function fakeT(key: string, options?: Record<string, unknown>): string {
  const template = activeTranslations[key] ?? (options?.defaultValue as string) ?? key;
  if (!options) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options[name] ?? ''));
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fakeT }) }));

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(() => new Promise(() => { /* stays pending: loading state only */ })),
}));

import TmpfsCapSection from './TmpfsCapSection';

afterEach(() => { cleanup(); activeTranslations = translations; });

describe('TmpfsCapSection — عزل bidi لمسار /tmp', () => {
  it('يعزل /tmp بـ<bdi dir="ltr"> داخل العنوان، لا علامة اتجاه خفيّة في الترجمة', () => {
    render(<TmpfsCapSectionWithTranslations />);
    const heading = screen.getByRole('heading', { name: /سقف الذاكرة المشتركة/ });
    const bdi = heading.querySelector('bdi');
    expect(bdi).toBeTruthy();
    expect(bdi!.getAttribute('dir')).toBe('ltr');
    expect(bdi!.textContent).toBe('/tmp');
    expect(heading.textContent).toBe('سقف الذاكرة المشتركة (/tmp)');
  });

  it('يعزل /tmp بـ<bdi dir="ltr"> داخل الوصف كذلك', () => {
    render(<TmpfsCapSectionWithTranslations />);
    // النصّ مقسَّم الآن على أكثر من عقدة شقيقة (span/bdi/span) — أقرب فقرةٍ
    // أب هي التي تحوي الاثنين معاً، لا العنصر الأعمق وحده الذي يطابق الجزء.
    const description = screen.getByText(/على هذا الجهاز في الذاكرة/).closest('p')!;
    const bdi = description.querySelector('bdi');
    expect(bdi).toBeTruthy();
    expect(bdi!.getAttribute('dir')).toBe('ltr');
    expect(bdi!.textContent).toBe('/tmp');
  });
});

function TmpfsCapSectionWithTranslations() {
  return <TmpfsCapSection />;
}

describe('TmpfsCapSection — تسامح دالّة عزل bidi مع ترجمةٍ بلا توكن (qa round)', () => {
  it('لغةٌ بلا `{{path}}` (النصّ الإنجليزي القديم) تُعرض مرّةً واحدة، بلا `<bdi>` مكرَّرة', () => {
    activeTranslations = noTokenTranslations;
    render(<TmpfsCapSectionWithTranslations />);
    const heading = screen.getByRole('heading', { name: /Shared memory cap/ });
    // لا `<bdi>` إطلاقاً: لا شيء يستحقّ العزل حين لا توكن في الترجمة نفسها.
    expect(heading.querySelector('bdi')).toBeNull();
    expect(heading.textContent).toBe('Shared memory cap (/tmp)');
    // العدّ الحاسم: `/tmp` مرّةً واحدة لا مرّتين (الثغرة الأصلية).
    expect(heading.textContent!.match(/\/tmp/g)).toHaveLength(1);
  });
});

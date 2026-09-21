/**
 * QuickSettingsEnterBehaviorRow — منتقي سلوك Enter (‏T-1319).
 *
 * يثبّت ثلاثة أشياء يسهل انكسارها صامتةً:
 *   1. الخيارات الثلاثة معروضة بأسمائها ونتيجتِها (لا بالآلية).
 *   2. نتيجة `'auto'` **مصرَّح بها على الجهاز الحاضر** — وإلّا اختار المستخدم
 *      «حسب الجهاز» ولم يعرف ماذا اختار.
 *   3. المنتقي مُشغَّل بلوحة المفاتيح كاملاً (‏WCAG 2.1.1): `roving tabindex`
 *      وحده كان يترك الخيارات غير الفعّالة خارج متناول لوحة المفاتيح.
 *
 * RUNNER: vitest — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // لا مفاتيح في `src/i18n/locales` (مملوكة لجلسة أخرى): النصّ يأتي من
    // `defaultValue`، وهو تحديداً ما نريد اختباره.
    t: (_key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? _key),
    i18n: { language: 'ar' },
  }),
}));

const QuickSettingsEnterBehaviorRow = (await import('./QuickSettingsEnterBehaviorRow')).default;

// لا تنظيف تلقائياً في هذا الإعداد (لا `setupFiles` لـ testing-library).
afterEach(cleanup);

describe('QuickSettingsEnterBehaviorRow', () => {
  it('يعرض الخيارات الثلاثة مسمّاةً بالنتيجة', () => {
    render(
      <QuickSettingsEnterBehaviorRow value="auto" onChange={() => {}} autoSends />,
    );

    const radios = screen.getAllByRole('radio');
    expect(radios.map((node) => node.textContent)).toEqual(['حسب الجهاز', 'إرسال', 'سطر جديد']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
  });

  it('يصرّح نتيجة auto على هذا الجهاز', () => {
    const { rerender } = render(
      <QuickSettingsEnterBehaviorRow value="auto" onChange={() => {}} autoSends />,
    );
    expect(screen.getByText('على هذا الجهاز: يُرسل الرسالة')).toBeTruthy();

    rerender(
      <QuickSettingsEnterBehaviorRow value="auto" onChange={() => {}} autoSends={false} />,
    );
    expect(screen.getByText('على هذا الجهاز: سطر جديد')).toBeTruthy();
  });

  it('لا يصرّح نتيجة الجهاز على قيمة صريحة (لا معنى لها)', () => {
    render(
      <QuickSettingsEnterBehaviorRow value="send" onChange={() => {}} autoSends={false} />,
    );
    expect(screen.queryByText(/على هذا الجهاز/)).toBeNull();
  });

  it('يبلّغ عن القيمة المختارة بالنقر', () => {
    const onChange = vi.fn();
    render(
      <QuickSettingsEnterBehaviorRow value="auto" onChange={onChange} autoSends />,
    );

    fireEvent.click(screen.getByText('سطر جديد'));
    expect(onChange).toHaveBeenCalledWith('newline');
  });

  /* WCAG 2.1.1: الأسهم تنقل بين الخيارات. جُرِّبت هنا لأن هذا المنتقي هو أول
   * مستهلك يعتمد عليها فعلياً في مساحة ضيّقة لا فأرةَ فيها بالضرورة. */
  it('الأسهم تغيّر القيمة (لا تُترك للفأرة وحدها)', () => {
    const onChange = vi.fn();
    render(
      <QuickSettingsEnterBehaviorRow value="auto" onChange={onChange} autoSends />,
    );

    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('send');

    onChange.mockClear();
    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('newline');
  });

  it('المجموعة تحمل لصيقةً لقارئ الشاشة', () => {
    render(
      <QuickSettingsEnterBehaviorRow value="auto" onChange={() => {}} autoSends />,
    );
    expect(screen.getByRole('radiogroup').getAttribute('aria-label')).toBe('مفتاح Enter');
  });
});

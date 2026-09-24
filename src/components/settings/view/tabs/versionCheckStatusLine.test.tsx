import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import settingsAr from '../../../../i18n/locales/ar/settings.json';

import { VersionCheckStatusLine } from './AboutTab';

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: 'ar',
  resources: { ar: { settings: settingsAr } },
  interpolation: { escapeValue: false },
});

afterEach(cleanup);

type Props = Parameters<typeof VersionCheckStatusLine>[0];

function draw(overrides: Partial<Props> = {}) {
  const props: Props = {
    status: 'ok',
    httpStatus: 200,
    lastCheckedAt: Date.UTC(2026, 8, 24, 4, 0),
    updateAvailable: false,
    onRetry: () => {},
    ...overrides,
  };
  return render(
    <I18nextProvider i18n={i18n}>
      <VersionCheckStatusLine {...props} />
    </I18nextProvider>,
  );
}

describe('VersionCheckStatusLine', () => {
  it('يعرض نجاح الفحص كمنطقة حالة مهذبة مع زمنه', () => {
    draw();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('أحدث نسخة');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('يميّز وجود تحديث عن فشل الفحص', () => {
    draw({ updateAvailable: true });
    expect(screen.getByRole('status').textContent).toContain('آخر فحص');
    expect(screen.getByRole('status').textContent).not.toContain('تعذّر');
  });

  it('يعرض الخطأ ورمز HTTP وزر إعادة المحاولة القابل للوحة المفاتيح', () => {
    const onRetry = vi.fn();
    draw({ status: 'error', httpStatus: 503, onRetry });
    expect(screen.getByRole('status').textContent).toContain('503');
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('يعرض عطل الشبكة بلا اختلاق رمز HTTP', () => {
    draw({ status: 'error', httpStatus: null });
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('تعذّر فحص التحديثات');
    expect(text).not.toContain('HTTP');
  });

  it('يميّز عدم توفر إصدار عن الخطأ', () => {
    draw({ status: 'unavailable', httpStatus: 404 });
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('لا يتوفر إصدار');
    expect(text).not.toContain('تعذّر');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['idle', 'checking'] as const)('لا يدّعي نتيجة أثناء %s', (status) => {
    const { container } = draw({ status, lastCheckedAt: null });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

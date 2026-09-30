import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import arCommon from '../../../i18n/locales/ar/common.json';
import enCommon from '../../../i18n/locales/en/common.json';
import { UpdateCompletionBanner } from './UpdateCompletionBanner';

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { ar: { common: arCommon }, en: { common: enCommon } },
  lng: 'ar',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

afterEach(() => cleanup());

function renderBanner(onDismiss: () => void, lang: 'ar' | 'en' = 'ar') {
  i18n.changeLanguage(lang);
  return render(
    <I18nextProvider i18n={i18n}>
      <UpdateCompletionBanner targetVersion="2.3.0.12" onDismiss={onDismiss} />
    </I18nextProvider>,
  );
}

describe('UpdateCompletionBanner', () => {
  it('shows the target version in the Arabic success message', () => {
    renderBanner(vi.fn());
    expect(screen.getByText(/2\.3\.0\.12/)).not.toBeNull();
  });

  it('shows the target version in the English success message', () => {
    renderBanner(vi.fn(), 'en');
    expect(screen.getByText(/2\.3\.0\.12/)).not.toBeNull();
  });

  it('announces itself as a status region for assistive tech', () => {
    renderBanner(vi.fn());
    expect(screen.getByRole('status')).not.toBeNull();
  });

  it('calls onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    renderBanner(onDismiss);
    fireEvent.click(screen.getByRole('button'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

/**
 * Shared harness for the ADR-200 S9 UI tests: a REAL i18next instance (ar, with
 * en as fallback, exactly the production chain) so the assertions read the
 * copy the user reads and plural categories resolve through `Intl.PluralRules`,
 * plus a tiny fetch router that records every non-GET request.
 *
 * Not a test file (no `.test.`): vitest does not collect it.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { Mock } from 'vitest';

import settingsAr from '../../../../../i18n/locales/ar/settings.json';
import settingsEn from '../../../../../i18n/locales/en/settings.json';

export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: 'ar',
  fallbackLng: 'en',
  resources: { ar: { settings: settingsAr }, en: { settings: settingsEn } },
  interpolation: { escapeValue: false },
});

export function renderAr(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

/** Text of a key in the Arabic bundle with `{{x}}` filled, bidi isolates stripped by `plain`. */
export function ar(key: string, vars: Record<string, unknown> = {}): string {
  return String(i18n.t(key, { ns: 'settings', lng: 'ar', ...vars }));
}

/** FSI/PDI isolates are invisible; assertions compare the visible text. */
export const plain = (text: string | null | undefined): string =>
  (text ?? '').replace(/[⁨⁩]/g, '');

export type Recorded = { url: string; method: string; body: Record<string, unknown> };

export type Reply = { status?: number; body: unknown };

export type Route = (url: string, method: string, body: Record<string, unknown>) => Reply | undefined;

/** Installs `routes` on the mocked `authenticatedFetch`; unmatched requests answer 404. */
export function installFetch(fetchMock: Mock, routes: Route[]): Recorded[] {
  const writes: Recorded[] = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method !== 'GET') writes.push({ url, method, body });
    const reply = routes.map((route) => route(url, method, body)).find(Boolean);
    const status = reply?.status ?? (reply ? 200 : 404);
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(reply?.body ?? {}),
    });
  });
  return writes;
}

/** An `AppError` body the way `server/index.js` serialises it. */
export const appError = (status: number, code: string, message = code, details: Record<string, unknown> = {}): Reply => ({
  status,
  body: { success: false, error: { ...details, code, message, details } },
});

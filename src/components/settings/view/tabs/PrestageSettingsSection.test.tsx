/**
 * PrestageSettingsSection — T-2030: owner-only render, PUT payload, inline
 * bounds validation, env lock/override states, and server error display.
 *
 * RUNNER: vitest (jsdom). `NODE_ENV=test` is mandatory in this repo.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../i18n/locales/ar/settings.json';

type Dict = Record<string, unknown>;
function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Dict | undefined)?.[part], arSettings);
  return typeof value === 'string' ? value : undefined;
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Dict) => (lookup(key) ?? key)
      .replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (opts?.[name] === undefined ? whole : String(opts[name]))),
    i18n: { language: 'ar', resolvedLanguage: 'ar' },
  }),
}));

let role = 'owner';
vi.mock('../../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 1, username: 'u', role } }),
}));

const fetchMock = vi.fn();
vi.mock('../../../../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import PrestageSettingsSection from './PrestageSettingsSection';

type ViewOverrides = {
  settings?: { prestageEnabled: boolean; prestageQuarantineHours: number };
  effective?: { prestageEnabled: boolean; policy: string; prestageQuarantineHours: number };
  lockedByEnv?: boolean;
  overriddenByEnv?: { prestageEnabled: boolean; prestageQuarantineHours: boolean };
};
function viewBody(overrides: ViewOverrides = {}) {
  return {
    settings: { prestageEnabled: true, prestageQuarantineHours: 0 },
    effective: { prestageEnabled: true, policy: 'immediate', prestageQuarantineHours: 0 },
    lockedByEnv: false,
    overriddenByEnv: { prestageEnabled: false, prestageQuarantineHours: false },
    defaults: { prestageEnabled: true, prestageQuarantineHours: 0 },
    limits: { minQuarantineHours: 0, maxQuarantineHours: 168 },
    ...overrides,
  };
}
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function renderLoaded(overrides?: ViewOverrides) {
  fetchMock.mockResolvedValueOnce(reply(200, viewBody(overrides)));
  render(<PrestageSettingsSection />);
  await screen.findByRole('switch', { name: 'تحضير التحديثات مسبقاً' });
}
const hoursInput = () => screen.getByLabelText('الانتظار قبل التحضير (ساعات)') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'حفظ' });

beforeEach(() => { role = 'owner'; fetchMock.mockReset(); });
afterEach(cleanup);

describe('PrestageSettingsSection', () => {
  it('renders nothing and fetches nothing for a non-owner', () => {
    role = 'admin';
    const { container } = render(<PrestageSettingsSection />);
    expect(container.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the owner the toggle (on by default), help line, and hours hint', async () => {
    await renderLoaded();
    expect(fetchMock).toHaveBeenCalledWith('/api/system/update/prestage/settings');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('يجهّز الإصدار الجديد في الخلفية فيصبح التحديث أسرع')).toBeTruthy();
    expect(screen.getByText('0 = فوراً')).toBeTruthy();
    expect(hoursInput().value).toBe('0');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('PUTs exactly {prestageEnabled, prestageQuarantineHours} after toggling and editing hours', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(hoursInput(), { target: { value: '12' } });
    fetchMock.mockResolvedValueOnce(reply(200, viewBody({
      settings: { prestageEnabled: false, prestageQuarantineHours: 12 },
      effective: { prestageEnabled: false, policy: 'off', prestageQuarantineHours: 12 },
    })));
    fireEvent.click(saveButton());
    await screen.findByText('حُفظ الإعداد.');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/system/update/prestage/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ prestageEnabled: false, prestageQuarantineHours: 12 });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it.each(['169', '-1', '2.5', ''])('rejects hours %j inline and blocks save', async value => {
    await renderLoaded();
    fireEvent.change(hoursInput(), { target: { value } });
    expect(screen.getByRole('alert').textContent).toContain('أدخل عدداً صحيحاً من 0 إلى 168.');
    expect(hoursInput().getAttribute('aria-invalid')).toBe('true');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('accepts the bounds 0 and 168', async () => {
    await renderLoaded({ settings: { prestageEnabled: true, prestageQuarantineHours: 5 } });
    for (const value of ['0', '168']) {
      fireEvent.change(hoursInput(), { target: { value } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('lockedByEnv disables every control and shows the server-lock note', async () => {
    await renderLoaded({
      lockedByEnv: true,
      effective: { prestageEnabled: false, policy: 'off', prestageQuarantineHours: 0 },
    });
    expect(screen.getByText('موقوف من إعدادات الخادم')).toBeTruthy();
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(hoursInput().disabled).toBe(true);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('overriddenByEnv disables only the named field, shows its effective value, and keeps the stored value on save', async () => {
    await renderLoaded({
      settings: { prestageEnabled: true, prestageQuarantineHours: 0 },
      effective: { prestageEnabled: true, policy: 'quarantine', prestageQuarantineHours: 24 },
      overriddenByEnv: { prestageEnabled: false, prestageQuarantineHours: true },
    });
    expect(screen.getByText('محدد من إعدادات الخادم')).toBeTruthy();
    expect(hoursInput().disabled).toBe(true);
    expect(hoursInput().value).toBe('24');
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('switch'));
    fetchMock.mockResolvedValueOnce(reply(200, viewBody()));
    fireEvent.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ prestageEnabled: false, prestageQuarantineHours: 0 });
  });

  it.each([
    [400, { code: 'prestage_quarantine_hours_invalid' }, 'مدة الانتظار يجب أن تكون عدداً صحيحاً من 0 إلى 168 ساعة.'],
    [400, { code: 'prestage_enabled_invalid' }, 'قيمة التحضير المسبق غير صالحة. أعد تحميل الصفحة ثم احفظ مجدداً.'],
    [400, { code: 'prestage_settings_invalid' }, 'رفض الخادم الإعداد لأنه غير مكتمل. أعد تحميل الصفحة ثم احفظ مجدداً.'],
    [429, { code: 'rate_limited' }, 'محاولات حفظ كثيرة. انتظر دقيقة ثم أعد المحاولة.'],
    [403, {}, 'هذا الإعداد للمالك وحده.'],
    [500, { code: 'prestage_settings_unavailable' }, 'تعذّر حفظ الإعداد. بقيت تعديلاتك ويمكنك إعادة الحفظ.'],
  ])('shows the Arabic message for HTTP %i %j and keeps the draft', async (status, body, message) => {
    await renderLoaded();
    fireEvent.change(hoursInput(), { target: { value: '3' } });
    fetchMock.mockResolvedValueOnce(reply(status, body));
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(hoursInput().value).toBe('3');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a retryable load error for a malformed or failed read', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { settings: {} }));
    render(<PrestageSettingsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر تحميل إعداد تحضير التحديثات.');
    fetchMock.mockResolvedValueOnce(reply(200, viewBody()));
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByRole('switch');
  });
});
